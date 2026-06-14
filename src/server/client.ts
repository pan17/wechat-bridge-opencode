/**
 * OpenCode Server HTTP client.
 *
 * Thin wrapper around fetch() to call the opencode serve REST API.
 * See https://opencode.ai/docs/server/ for API reference.
 */

import type { MessagePart, MessageResponse, ServerSessionInfo, ServerProjectInfo, ModelRef, McpStatusMap } from "../types.js";
import type { QuestionRequest } from "../types/question.js";

export interface OpenCodeServerClientOpts {
  baseUrl: string;
  log?: (msg: string) => void;
  /**
   * Optional HTTP auth for the opencode server. Either Basic
   * (`username` + `password`) or Bearer (`token`); when both are set the
   * Bearer token wins. Sensitive values — never logged.
   */
  auth?: {
    username?: string;
    password?: string;
    token?: string;
  };
}

/**
 * Compute the `Authorization` header value for the opencode server.
 * Returns `null` when no credentials are configured.
 *
 * Precedence: Bearer token > Basic auth. Basic auth requires BOTH
 * `username` and `password` — if only one is provided the server is
 * treated as unauthenticated rather than sending a malformed header.
 *
 * The returned string is treated as a secret: it is captured in the
 * client instance and never passed to the logger.
 */
function buildAuthHeader(
  auth: { username?: string; password?: string; token?: string } | undefined,
): string | null {
  if (!auth) return null;
  if (auth.token) return `Bearer ${auth.token}`;
  if (auth.username && auth.password) {
    // btoa() is globally available in Node 20+; we avoid Buffer here to
    // keep the function pure (no Node imports in this module's top-level
    // scope beyond what TypeScript needs).
    return `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
  }
  return null;
}

export class OpenCodeServerClient {
  private baseUrl: string;
  private log: (msg: string) => void;
  /** Pre-computed `Authorization` header value, or null when unauthenticated. */
  private authHeader: string | null;

  constructor(opts: OpenCodeServerClientOpts) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.log = opts.log ?? (() => {});
    this.authHeader = buildAuthHeader(opts.auth);
  }

  /** Base URL of the opencode server (used by the SSE event pipeline). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Pre-computed `Authorization` header value, or null when unauthenticated.
   * Exposed so the SSE event pipeline (which lives in a separate file and
   * can't be funneled through `fetch()`) can inject the same header on its
   * long-lived `/global/event` connection without re-deriving it.
   */
  getAuthHeader(): string | null {
    return this.authHeader;
  }

  // ─── Health ───

  async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await this.fetch("/global/health", { method: "GET" });
      if (!res.ok) return { ok: false };
      const data = await res.json() as { version?: string };
      return { ok: true, version: data.version };
    } catch {
      return { ok: false };
    }
  }

  // ─── Config ───

  async getConfig(directory?: string): Promise<{ model?: string; agent?: string }> {
    try {
      const res = await this.fetch(this.withDirectory("/config", directory), { method: "GET" });
      if (!res.ok) return {};
      return res.json() as Promise<{ model?: string }>;
    } catch {
      return {};
    }
  }

  // ─── MCP ───

  /**
   * Fetch MCP server status from `GET /mcp`. Returns a name → status map
   * (e.g. `{ github: { status: "connected" }, fetch: { status: "failed", error: "..." } }`),
   * or an empty object if the server doesn't support the endpoint or the
   * request fails.
   *
   * Pass `directory` to scope the response to a project — without it the
   * server returns the global MCP config and workspace-level entries
   * (from `opencode.json` at the project root) are missing.
   *
   * Used by /status to surface MCPs that haven't finished loading
   * (especially npx-downloaded ones) so the user knows whether they're
   * available to the agent.
   */
  async getMcpStatus(directory?: string): Promise<McpStatusMap> {
    try {
      const res = await this.fetch(this.withDirectory("/mcp", directory), { method: "GET" });
      if (!res.ok) return {};
      return res.json() as Promise<McpStatusMap>;
    } catch {
      return {};
    }
  }

  // ─── Sessions V2 (cross-workspace) ───

  async listSessionsV2(limit?: number): Promise<Array<{
    id: string;
    title?: string;
    directory?: string;
    updatedAt?: number;
    parentID?: string;
  }>> {
    /**
     * Follow the server's `cursor.next` token until the response is exhausted,
     * so we collect root sessions regardless of where they fall in the
     * server's chronological ordering. Without pagination, the first page is
     * dominated by recent subagent/sub-sessions and older root sessions get
     * dropped before the parentID filter runs.
     *
     * Safety cap: at most `maxPages` requests to prevent runaway loops if
     * the server returns a cyclic cursor.
     */
    const pageSize = limit ?? 200;
    const maxPages = 50;
    const all: Array<{
      id: string;
      title?: string;
      location?: { directory?: string };
      time?: { updated?: number };
      parentID?: string;
    }> = [];

    try {
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams();
        params.set("roots", "true");
        params.set("limit", String(pageSize));
        if (cursor) params.set("cursor", cursor);
        const res = await this.fetch(`/api/session?${params.toString()}`, { method: "GET" });
        if (!res.ok) break;
        const body = await res.json() as {
          data?: Array<{
            id: string;
            title?: string;
            location?: { directory?: string };
            time?: { updated?: number };
            parentID?: string;
          }>;
          cursor?: { next?: string | null };
        };
        const data = body.data ?? [];
        all.push(...data);
        const next = body.cursor?.next;
        if (!next) break;
        cursor = next;
      }
    } catch {
      return [];
    }

    return all.map((s) => ({
      id: s.id,
      title: s.title,
      directory: s.location?.directory,
      updatedAt: s.time?.updated,
      parentID: s.parentID,
    }));
  }

  // ─── Projects ───

  async listProjects(): Promise<ServerProjectInfo[]> {
    try {
      const res = await this.fetch("/project", { method: "GET" });
      if (!res.ok) return [];
      return res.json() as Promise<ServerProjectInfo[]>;
    } catch {
      return [];
    }
  }

  // ─── Sessions ───

  async createSession(title?: string, parentID?: string, directory?: string): Promise<ServerSessionInfo> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    if (parentID) body.parentID = parentID;

    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;

    const res = await this.fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to create session: ${res.status} ${text}`);
    }
    return res.json() as Promise<ServerSessionInfo>;
  }

  async getSession(id: string): Promise<ServerSessionInfo> {
    const res = await this.fetch(`/session/${encodeURIComponent(id)}`, { method: "GET" });
    if (!res.ok) throw new Error(`Failed to get session: ${res.status}`);
    return res.json() as Promise<ServerSessionInfo>;
  }

  async listSessions(): Promise<ServerSessionInfo[]> {
    const res = await this.fetch("/session", { method: "GET" });
    if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
    return res.json() as Promise<ServerSessionInfo[]>;
  }

  async deleteSession(id: string): Promise<void> {
    const res = await this.fetch(`/session/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) this.log(`Warning: failed to delete session ${id}: ${res.status}`);
  }

  // ─── Messages ───

  /**
   * Send a message synchronously and wait for the complete response.
   * Blocks until the agent finishes (including tool calls).
   */
  async sendMessage(
    sessionId: string,
    parts: MessagePart[],
    opts?: { agent?: string; model?: ModelRef; directory?: string; variant?: string },
  ): Promise<MessageResponse> {
    const body: Record<string, unknown> = { parts };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;
    // OpenCode Server: `variant` is a top-level optional string on the prompt
    // body (mirrors PromptInput.variant in @opencode/server). It's one-shot —
    // omitting it on the next message causes the server to revert to default.
    if (opts?.variant) body.variant = opts.variant;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts?.directory) headers["x-opencode-directory"] = opts.directory;

    const res = await this.fetch(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // No timeout — agent may take a while for complex tasks
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Agent prompt failed: ${res.status} ${text}`);
    }

    return res.json() as Promise<MessageResponse>;
  }

  /**
   * Send a message asynchronously (returns immediately).
   * Response comes via the SSE /global/event stream.
   *
   * The HTTP response itself only confirms the request was accepted; the
   * actual agent output streams in via the event pipeline.
   */
  async sendMessageAsync(
    sessionId: string,
    parts: MessagePart[],
    opts?: { agent?: string; model?: ModelRef; directory?: string; variant?: string },
  ): Promise<{ accepted: boolean; status: number }> {
    const body: Record<string, unknown> = { parts };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;
    // See sendMessage() for why variant goes on every prompt.
    if (opts?.variant) body.variant = opts.variant;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts?.directory) headers["x-opencode-directory"] = opts.directory;

    const res = await this.fetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Async prompt failed: ${res.status} ${text}`);
    }
    return { accepted: true, status: res.status };
  }

  async getSessionMessages(sessionId: string, limit?: number): Promise<MessageResponse[]> {
    const params = limit ? `?limit=${limit}` : "";
    const res = await this.fetch(`/session/${encodeURIComponent(sessionId)}/message${params}`, {
      method: "GET",
    });
    if (!res.ok) throw new Error(`Failed to get messages: ${res.status}`);
    return res.json() as Promise<MessageResponse[]>;
  }

  // ─── Control ───

  async abortSession(sessionId: string): Promise<void> {
    const res = await this.fetch(`/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
    if (!res.ok) this.log(`Warning: abort failed for session ${sessionId}: ${res.status}`);
  }

  // ─── Agents ───

  async listAgents(directory?: string): Promise<
    Array<{
      id: string;
      name: string;
      mode: string;
      description?: string;
      builtIn: boolean;
      /**
       * Agent-configured default model. Comes from each agent's
       * `opencode.json` `agent.<name>.model` (parsed by OpenCode into
       * `{ providerID, modelID }`). The bridge uses this when `/agent
       * switch` runs to keep model state in sync with the agent.
       */
      model?: { providerID: string; modelID: string };
      /**
       * Agent-configured default reasoning variant. From
       * `agent.<name>.variant`. Not in the public SDK type, but OpenCode's
       * `/agent` endpoint returns it (see opencode/src/agent/agent.ts).
       */
      variant?: string;
    }>
  > {
    try {
      const res = await this.fetch(this.withDirectory("/agent", directory), { method: "GET" });
      if (!res.ok) return [];
      const raw = await res.json() as Array<{
        id?: string;
        name: string;
        mode?: string;
        description?: string;
        builtIn?: boolean;
        model?: { providerID: string; modelID: string };
        variant?: string;
      }>;
      // Server returns agents with `name` as the switchable value and `mode`
      // of "primary" / "subagent" / "all" (the last being OpenCode's default
      // when an agent's markdown file omits `mode:`). We default to "all" to
      // match the server's behavior so the downstream filter treats
      // unspecified-mode custom agents as user-switchable.
      return raw.map((a) => ({
        id: a.id || a.name,
        name: a.name,
        mode: a.mode ?? "all",
        description: a.description,
        builtIn: a.builtIn ?? false,
        model: a.model,
        variant: a.variant,
      }));
    } catch {
      return [];
    }
  }

  // ─── Slash commands ───

  /**
   * List native OpenCode slash commands (e.g. /init, /undo, /share, /compact).
   * Each entry has a `name` (without the leading `/`) and a `description`.
   */
  async listCommands(directory?: string): Promise<Array<{ name: string; description?: string }>> {
    try {
      const res = await this.fetch(this.withDirectory("/command", directory), { method: "GET" });
      if (!res.ok) return [];
      const body = await res.json() as Array<{ name: string; description?: string; source?: string; template?: string }>;
      return body.map((c) => ({ name: c.name, description: c.description }));
    } catch {
      return [];
    }
  }

  // ─── Config / Providers ───

  async listProviders(directory?: string): Promise<Array<{ id: string; name: string; models?: Array<{ id: string; name: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> }>> {
    try {
      const res = await this.fetch(this.withDirectory("/config/providers", directory), { method: "GET" });
      if (!res.ok) return [];
      const body = await res.json() as {
        providers?: Array<{
          id: string; name: string;
          models?: Record<string, { id?: string; name?: string; capabilities?: { reasoning?: boolean }; variants?: Record<string, { reasoningEffort?: string }>; limit?: { context?: number } }> | Array<{ id: string; name: string; capabilities?: { reasoning?: boolean }; variants?: Record<string, { reasoningEffort?: string }>; limit?: { context?: number } }>;
        }>;
      };
      const providers = body.providers ?? [];
      return providers.map((p) => {
        let models: Array<{ id: string; name: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> = [];
        if (Array.isArray(p.models)) {
          models = p.models.map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: m.capabilities?.reasoning,
            variants: m.variants,
            contextSize: m.limit?.context,
          }));
        } else if (p.models && typeof p.models === "object") {
          // Models come as a dict { modelId: { id, name, capabilities, variants, limit, ... } }
          models = Object.values(p.models).map((m) => ({
            id: m.id ?? "",
            name: m.name ?? m.id ?? "",
            reasoning: m.capabilities?.reasoning,
            variants: m.variants,
            contextSize: m.limit?.context,
          }));
        }
        return { id: p.id, name: p.name, models };
      });
    } catch {
      return [];
    }
  }

  // ─── Questions ───

  /**
   * List all pending question requests across all sessions.
   * Used at bridge startup to discover questions left pending from a
   * previous bridge instance — they will never be answered (the user
   * already moved on, or the bridge crashed mid-question), so we reject
   * them proactively via {@link rejectQuestion}.
   *
   * Network/parse errors are swallowed: an empty array is the safe default
   * (caller proceeds without cleanup). Pass `directory` to scope the
   * request to a specific workspace; without it, the server returns the
   * global question list and the caller is responsible for filtering by
   * `sessionID`.
   */
  async listQuestions(directory?: string): Promise<QuestionRequest[]> {
    try {
      const res = await this.fetch(this.withDirectory("/question", directory), { method: "GET" });
      if (!res.ok) return [];
      return res.json() as Promise<QuestionRequest[]>;
    } catch {
      return [];
    }
  }

  /**
   * Reply to a pending question with the user's answers.
   *
   * `answers.length` MUST equal the number of questions in the original
   * request (the server validates this). Each inner array contains the
   * selected option labels (or a single custom text string for `Q{n}-`
   * marker answers). Order of inner arrays matches the order of questions
   * in the `question.asked` event.
   *
   * Throws on non-2xx (including 400 if the requestID is unknown / already
   * answered) — caller should catch and surface a user-visible message.
   */
  async replyToQuestion(
    requestID: string,
    answers: ReadonlyArray<ReadonlyArray<string>>,
    directory?: string,
  ): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetch(
      `/question/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", headers, body: JSON.stringify({ answers }) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Question reply failed: ${res.status} ${text}`);
    }
    return { ok: true };
  }

  /**
   * Reject a pending question (user dismissed it).
   *
   * The server will wake the agent's `Deferred.await()` with a
   * `QuestionRejectedError: "The user dismissed this question"`. The
   * agent typically continues with a fallback or reports the dismiss.
   *
   * Throws on non-2xx (e.g. 400 if the requestID is unknown). Safe to
   * call when no question is pending on the server side — the error is
   * propagated to the caller for logging.
   */
  async rejectQuestion(
    requestID: string,
    directory?: string,
  ): Promise<{ ok: boolean }> {
    const headers: Record<string, string> = {};
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetch(
      `/question/${encodeURIComponent(requestID)}/reject`,
      { method: "POST", headers },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Question reject failed: ${res.status} ${text}`);
    }
    return { ok: true };
  }

  // ─── Internal ───

  /**
   * Append `?directory=<path>` to a path when `directory` is set. The
   * OpenCode server scopes many read endpoints (mcp, agent, config,
   * command, providers) by this query parameter; without it the server
   * returns the global config and the workspace-level entries (e.g. an
   * `opencode.json` at the project root that defines MCPs or custom
   * agents) are silently dropped — which is why the agent, which runs
   * with a directory-scoped session, can see tools that `/agent list`
   * and `/status` cannot.
   *
   * The path is `encodeURIComponent`'d so Windows backslashes, colons,
   * and spaces survive transit.
   */
  private withDirectory(path: string, directory?: string): string {
    if (!directory) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}directory=${encodeURIComponent(directory)}`;
  }

  /**
   * Internal fetch wrapper.
   *
   * Per-method timeout policy:
   *   - Pass `timeoutMs` in `init` to apply an AbortSignal timeout for this call.
   *   - By default NO timeout is applied. sendMessage() and the SSE event
   *     pipeline need unbounded time; short probes (health/list) should pass
   *     an explicit `timeoutMs`.
   *
   * Auth: when an `Authorization` header was pre-computed from constructor
   * options, it is injected on every request. Caller-supplied `headers`
   * win, so a per-request override (e.g. for a different auth scheme) is
   * possible — the client default is the floor, not the ceiling.
   */
  private async fetch(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    this.log(`[server] ${init.method ?? "GET"} ${url}`);

    const { timeoutMs, ...rest } = init;
    const finalInit: RequestInit = { ...rest };
    if (timeoutMs !== undefined && timeoutMs > 0) {
      finalInit.signal = AbortSignal.timeout(timeoutMs);
    }
    if (this.authHeader) {
      const existing = (finalInit.headers ?? {}) as Record<string, string>;
      // Caller-provided Authorization always wins over the client's default.
      if (!existing["Authorization"] && !existing["authorization"]) {
        finalInit.headers = { ...existing, Authorization: this.authHeader };
      } else {
        finalInit.headers = existing;
      }
    }

    return fetch(url, finalInit);
  }
}
