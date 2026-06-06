/**
 * OpenCode Server HTTP client.
 *
 * Thin wrapper around fetch() to call the opencode serve REST API.
 * See https://opencode.ai/docs/server/ for API reference.
 */

import type { MessagePart, MessageResponse, ServerSessionInfo, ModelRef } from "../types.js";

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
   * Response comes via SSE /event stream.
   */
  async sendMessageAsync(
    sessionId: string,
    parts: MessagePart[],
    opts?: { agent?: string; model?: ModelRef },
  ): Promise<void> {
    const body: Record<string, unknown> = { parts };
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.model) body.model = opts.model;

    const res = await this.fetch(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Async prompt failed: ${res.status} ${text}`);
    }
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

  async listAgents(): Promise<Array<{ id: string; name: string; mode: string; description?: string }>> {
    try {
      const res = await this.fetch("/agent", { method: "GET" });
      if (!res.ok) return [];
      const raw = await res.json() as Array<{ id?: string; name: string; mode?: string; description?: string }>;
      // Server returns agents with `name` as the switchable value and `mode` for primary/subagent
      return raw.map((a) => ({
        id: a.id || a.name,
        name: a.name,
        mode: a.mode ?? "primary",
        description: a.description,
      }));
    } catch {
      return [];
    }
  }

  // ─── Config / Providers ───

  async listProviders(): Promise<Array<{ id: string; name: string; models?: Array<{ id: string; name: string }> }>> {
    try {
      const res = await this.fetch("/config/providers", { method: "GET" });
      if (!res.ok) return [];
      const body = await res.json() as {
        providers?: Array<{
          id: string; name: string;
          models?: Record<string, { id?: string; name?: string }> | Array<{ id: string; name: string }>;
        }>;
      };
      const providers = body.providers ?? [];
      return providers.map((p) => {
        let models: Array<{ id: string; name: string }> = [];
        if (Array.isArray(p.models)) {
          models = p.models;
        } else if (p.models && typeof p.models === "object") {
          // Models come as a dict { modelId: { id, name, ... } }
          models = Object.values(p.models).map((m) => ({
            id: m.id ?? "",
            name: m.name ?? m.id ?? "",
          }));
        }
        return { id: p.id, name: p.name, models };
      });
    } catch {
      return [];
    }
  }

  // ─── Internal ───

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    this.log(`[server] ${init.method ?? "GET"} ${url}`);
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(120_000), // 2min default timeout
    });
    return response;
  }
}
