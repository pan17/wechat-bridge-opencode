/**
 * OpenCode Server HTTP client.
 *
 * Thin wrapper around fetch() to call the opencode serve REST API.
 * See https://opencode.ai/docs/server/ for API reference.
 */

import type { MessagePart, MessageResponse, ServerSessionInfo, ServerProjectInfo, ModelRef } from "../types.js";

export interface OpenCodeServerClientOpts {
  baseUrl: string;
  log?: (msg: string) => void;
}

export class OpenCodeServerClient {
  private baseUrl: string;
  private log: (msg: string) => void;

  constructor(opts: OpenCodeServerClientOpts) {
    // Strip trailing slash
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.log = opts.log ?? (() => {});
  }

  /** Base URL of the opencode server (used by the SSE event pipeline). */
  getBaseUrl(): string {
    return this.baseUrl;
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

  async getConfig(): Promise<{ model?: string; agent?: string }> {
    try {
      const res = await this.fetch("/config", { method: "GET" });
      if (!res.ok) return {};
      return res.json() as Promise<{ model?: string }>;
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
    opts?: { agent?: string; model?: ModelRef; directory?: string },
  ): Promise<MessageResponse> {
    const body: Record<string, unknown> = { parts };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;

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
    opts?: { agent?: string; model?: ModelRef; directory?: string },
  ): Promise<{ accepted: boolean; status: number }> {
    const body: Record<string, unknown> = { parts };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;

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

  async listAgents(): Promise<Array<{ id: string; name: string; mode: string; description?: string; builtIn: boolean }>> {
    try {
      const res = await this.fetch("/agent", { method: "GET" });
      if (!res.ok) return [];
      const raw = await res.json() as Array<{ id?: string; name: string; mode?: string; description?: string; builtIn?: boolean }>;
      // Server returns agents with `name` as the switchable value and `mode` for primary/subagent
      return raw.map((a) => ({
        id: a.id || a.name,
        name: a.name,
        mode: a.mode ?? "primary",
        description: a.description,
        builtIn: a.builtIn ?? false,
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
  async listCommands(): Promise<Array<{ name: string; description?: string }>> {
    try {
      const res = await this.fetch("/command", { method: "GET" });
      if (!res.ok) return [];
      const body = await res.json() as Array<{ name: string; description?: string; source?: string; template?: string }>;
      return body.map((c) => ({ name: c.name, description: c.description }));
    } catch {
      return [];
    }
  }

  // ─── Config / Providers ───

  async listProviders(): Promise<Array<{ id: string; name: string; models?: Array<{ id: string; name: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> }>> {
    try {
      const res = await this.fetch("/config/providers", { method: "GET" });
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

  // ─── Internal ───

  /**
   * Internal fetch wrapper.
   *
   * Per-method timeout policy:
   *   - Pass `timeoutMs` in `init` to apply an AbortSignal timeout for this call.
   *   - By default NO timeout is applied. sendMessage() and the SSE event
   *     pipeline need unbounded time; short probes (health/list) should pass
   *     an explicit `timeoutMs`.
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

    return fetch(url, finalInit);
  }
}
