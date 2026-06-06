/**
 * Simplified session manager (single-user, HTTP-based).
 *
 * Replaces the old ACP-based SessionManager (src/acp/session.ts).
 * No subprocess management, no ACP connection — just HTTP calls
 * to opencode serve + local state tracking.
 */

import { OpenCodeServerClient } from "./client.js";
import type { MessagePart, MediaContent, ContextUsage, SessionMode, ModelRef } from "../types.js";

// ─── Helpers ───

/**
 * Parse a model ID string like "anthropic/claude-sonnet-4-5" into a ModelRef.
 * Falls back to reasonable defaults.
 */
function parseModelId(modelId: string): ModelRef {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    return {
      providerID: modelId.slice(0, slash),
      modelID: modelId.slice(slash + 1),
    };
  }
  return { providerID: "anthropic", modelID: modelId };
}

// ─── Types ───

export interface SessionManagerOpts {
  serverUrl: string;
  /** Default working directory (cwd). */
  cwd: string;
  log: (msg: string) => void;
  onReply: (contextToken: string, text: string) => Promise<void>;
  onMediaReply: (contextToken: string, blocks: MediaContent[]) => Promise<void>;
  sendTyping: (contextToken: string) => Promise<void>;
  onSessionReady?: (sessionId: string) => void;
}

interface QueueItem {
  parts: MessagePart[];
  contextToken: string;
  hint?: string;
}

// ─── SessionManager ───

export class SessionManager {
  private client: OpenCodeServerClient;
  private cwd: string;
  private log: (msg: string) => void;

  /** Single session ID — no Map needed. */
  private sessionId: string | null = null;

  // Queue
  private queue: QueueItem[] = [];
  private processing = false;

  // Callbacks
  private onReply: (contextToken: string, text: string) => Promise<void>;
  private onMediaReply: (contextToken: string, blocks: MediaContent[]) => Promise<void>;
  private sendTyping: (contextToken: string) => Promise<void>;
  private onSessionReady?: (sessionId: string) => void;

  // Agent state (persisted across sessions for restore)
  private currentMode?: string;
  private currentModelId?: string;
  private currentReasoning?: string;

  // Display flags
  private showThoughts = false;
  private showTools = false;

  // Context usage
  private totalTokens = 0;
  private contextWindowSize = 0;

  // Available modes/models (cached for /agent list, /model list)
  private availableModes: SessionMode[] = [];
  private availableModels: Array<{ modelId: string; name: string; description?: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> = [];

  constructor(opts: SessionManagerOpts) {
    this.client = new OpenCodeServerClient({
      baseUrl: opts.serverUrl,
      log: opts.log,
    });
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.onReply = opts.onReply;
    this.onMediaReply = opts.onMediaReply;
    this.sendTyping = opts.sendTyping;
    this.onSessionReady = opts.onSessionReady;
  }

  /** Current session ID, or null if not yet created. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // ─── Session lifecycle ───

  /**
   * Ensure a session exists (create one if needed).
   * Returns the session ID.
   */
  async ensureSession(cwd?: string): Promise<string> {
    if (this.sessionId) {
      // Session exists (e.g. restored from saved state) — sync agent/model from server
      this.syncStateFromServer(this.sessionId).catch(() => {});
      return this.sessionId;
    }
    const dir = cwd ?? this.cwd;
    this.log(`Creating server session (cwd: ${dir})...`);
    const info = await this.client.createSession(undefined, undefined, dir);
    this.sessionId = info.id;
    this.log(`Server session created: ${info.id}`);
    this.onSessionReady?.(info.id);

    // Fetch available agents and providers in background
    this.refreshAgents().catch(() => {});
    this.refreshProviders().catch(() => {});

    return info.id;
  }

  /**
   * Switch to a different session (workspace switch).
   * Creates a new session if no existingSessionId provided.
   */
  async switchWorkspace(cwd: string, existingSessionId?: string): Promise<void> {
    if (existingSessionId) {
      this.log(`Loading session ${existingSessionId} for workspace switch (cwd: ${cwd})`);
      // Verify the session exists and is usable
      try {
        await this.client.getSession(existingSessionId);
        this.sessionId = existingSessionId;
      } catch {
        this.log(`Session ${existingSessionId} not found, creating new one`);
        const info = await this.client.createSession(undefined, undefined, cwd);
        this.sessionId = info.id;
      }
    } else {
      this.log(`Creating new session for workspace switch (cwd: ${cwd})`);
      const info = await this.client.createSession(undefined, undefined, cwd);
      this.sessionId = info.id;
    }
    this.cwd = cwd;
    this.onSessionReady?.(this.sessionId);
  }

  /**
   * Switch to a specific session by ID.
   */
  async switchSession(sessionId: string, cwd: string): Promise<void> {
    this.log(`Loading session ${sessionId} (cwd: ${cwd})`);
    // Verify session exists
    try {
      await this.client.getSession(sessionId);
    } catch {
      throw new Error(`Session ${sessionId} not found on server`);
    }
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.onSessionReady?.(sessionId);
    // Sync agent/model from the session's last message
    await this.syncStateFromServer(sessionId);
  }

  /**
   * Create a completely new session (resets context).
   */
  async createNewSession(cwd: string): Promise<string> {
    this.log(`Creating new session (cwd: ${cwd})`);
    const info = await this.client.createSession(undefined, undefined, cwd);
    this.sessionId = info.id;
    this.cwd = cwd;
    this.onSessionReady?.(info.id);
    // Fetch defaults from server for the new session
    this.refreshAgents().catch(() => {});
    this.refreshProviders().catch(() => {});
    return info.id;
  }

  // ─── Message processing ───

  /**
   * Enqueue a message for the agent.
   * Manages sequential processing (one prompt at a time).
   */
  async enqueue(parts: MessagePart[], contextToken: string, hint?: string): Promise<void> {
    await this.ensureSession();
    this.queue.push({ parts, contextToken, hint });
    if (!this.processing) {
      this.processing = true;
      this.processQueue().finally(() => {
        this.processing = false;
      });
    }
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;

      // Typing indicator
      this.sendTyping(item.contextToken).catch(() => {});

      // Build model ref
      const modelRef = this.currentModelId ? parseModelId(this.currentModelId) : undefined;

      this.log(`Sending prompt to agent (mode=${this.currentMode ?? "default"}, model=${this.currentModelId ?? "default"})...`);

      try {
        const response = await this.client.sendMessage(
          this.sessionId!,
          item.parts,
          {
            agent: this.currentMode,
            model: modelRef,
            directory: this.cwd,
          },
        );

        // Track tokens (total is cumulative session tokens from server)
        if (response.info?.tokens?.total) {
          this.totalTokens = response.info.tokens.total;
          this.log(`Usage: totalTokens=${this.totalTokens}`);
        }

        // Sync agent/model/reasoning from server response (each assistant message records what was used)
        const msgInfo = response as unknown as { info?: { mode?: string; modelID?: string; providerID?: string; variant?: string } };
        if (msgInfo.info?.mode) this.currentMode = msgInfo.info.mode;
        if (msgInfo.info?.modelID && msgInfo.info?.providerID) {
          this.currentModelId = `${msgInfo.info.providerID}/${msgInfo.info.modelID}`;
          const mod = this.availableModels.find((m) => m.modelId === this.currentModelId);
          if (mod?.contextSize) this.contextWindowSize = mod.contextSize;
        }
        if (msgInfo.info?.variant) this.currentReasoning = msgInfo.info.variant;

        // Extract text from response
        let replyText = "";
        const mediaBlocks: MediaContent[] = [];

        for (const part of response.parts) {
          if (part.type === "text") {
            replyText += part.text;
          } else if (part.type === "tool_use") {
            // Tool calls are handled server-side — just log them
            this.log(`[tool] ${part.name}`);
          }
          // TODO: handle image/file resource parts for WeChat delivery
        }

        // Append hint if present
        if (item.hint && replyText.trim()) {
          replyText += `\n\n${item.hint}`;
        }

        // Send reply to WeChat
        if (replyText.trim()) {
          await this.onReply(item.contextToken, replyText);
        }

        // Send any media blocks
        if (mediaBlocks.length > 0) {
          await this.onMediaReply(item.contextToken, mediaBlocks);
        }

        this.log(`Agent done, reply ${replyText.length} chars`);
      } catch (err) {
        this.log(`Agent error: ${String(err)}`);
        try {
          await this.onReply(item.contextToken, `⚠️ Agent error: ${String(err)}`);
        } catch {
          // best effort
        }
      }
    }
  }

  // ─── Cancel ───

  async cancelPrompt(): Promise<void> {
    if (this.sessionId) {
      this.log(`Cancelling prompt for session ${this.sessionId}`);
      try {
        await this.client.abortSession(this.sessionId);
      } catch {
        // best effort
      }
    }
    // Clear queue
    this.queue = [];
  }

  // ─── Agent mode ───

  /** Fetch available agents from the server and cache them. */
  async refreshAgents(): Promise<void> {
    try {
      const agents = await this.client.listAgents();
      // Show only primary non-built-in agents (subagents and system agents are internal)
      this.availableModes = agents
        .filter((a) => a.mode === "primary" && !a.builtIn)
        .map((a) => ({
          id: a.name, // Server uses agent name as the switchable value
          name: a.name,
          description: a.description,
        }));
      // Set default agent if none set
      if (!this.currentMode && this.availableModes.length > 0) {
        this.currentMode = this.availableModes[0].id;
      }
      this.log(`Fetched ${this.availableModes.length} primary agents (default: ${this.currentMode})`);
    } catch (err) {
      this.log(`Failed to fetch agents: ${String(err)}`);
    }
  }

  getActiveMode(): string | undefined {
    return this.currentMode;
  }

  getAvailableModes(): SessionMode[] {
    return this.availableModes;
  }

  async switchAgent(modeId: string): Promise<void> {
    this.log(`Switching agent mode to: ${modeId}`);
    this.currentMode = modeId;
  }

  // ─── Model ───

  /** Fetch providers and their models from the server, cache for listing. */
  async refreshProviders(): Promise<void> {
    try {
      const providers = await this.client.listProviders();
      const models: Array<{ modelId: string; name: string; description?: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> = [];
      for (const p of providers) {
        for (const m of p.models ?? []) {
          // Some model IDs already include provider prefix (e.g. "opencode-go/minimax-m3")
          const modelId = m.id.includes("/") ? m.id : `${p.id}/${m.id}`;
          models.push({ modelId, name: m.name ?? m.id, reasoning: m.reasoning, variants: m.variants, contextSize: m.contextSize });
        }
      }
      this.availableModels = models;
      // Set default model from server config, or first available
      if (!this.currentModelId) {
        try {
          const config = await this.client.getConfig();
          if (config.model && models.some((m) => m.modelId === config.model)) {
            this.currentModelId = config.model;
          } else if (models.length > 0) {
            this.currentModelId = models[0].modelId;
          }
        } catch {
          if (models.length > 0) {
            this.currentModelId = models[0].modelId;
          }
        }
      }
      // Update context window size from model info
      if (this.currentModelId) {
        const m = this.availableModels.find((mod) => mod.modelId === this.currentModelId);
        if (m?.contextSize) this.contextWindowSize = m.contextSize;
      }
      this.log(`Fetched ${this.availableModels.length} models across ${providers.length} providers (default: ${this.currentModelId})`);
    } catch (err) {
      this.log(`Failed to fetch providers: ${String(err)}`);
    }
  }

  getCurrentModel(): string | undefined {
    return this.currentModelId;
  }

  getAvailableModels(): Array<{ modelId: string; name: string; description?: string; reasoning?: boolean; variants?: Record<string, { reasoningEffort?: string }>; contextSize?: number }> {
    return this.availableModels;
  }

  async setModel(modelId: string): Promise<void> {
    this.log(`Switching model to: ${modelId}`);
    this.currentModelId = modelId;
    // Update context window size from model info
    const model = this.availableModels.find((m) => m.modelId === modelId);
    if (model?.contextSize) {
      this.contextWindowSize = model.contextSize;
    }
  }

  // ─── Reasoning ───

  getCurrentReasoning(): string | undefined {
    return this.currentReasoning;
  }

    getReasoningLevels(): Array<{ value: string; name: string; current: boolean }> {
        // Use the current model's variants to determine available reasoning levels
        const currentModel = this.currentModelId
            ? this.availableModels.find((m) => m.modelId === this.currentModelId)
            : null;

        if (!currentModel) return [];
        if (currentModel.reasoning === false) return [];

        const levels = currentModel.variants
            ? Object.keys(currentModel.variants).filter((k) => currentModel.variants![k]?.reasoningEffort)
            : [];

        return levels.map((v) => ({
            value: v,
            name: v.charAt(0).toUpperCase() + v.slice(1),
            current: v === this.currentReasoning,
        }));
    }

  async setReasoning(level: string): Promise<void> {
    this.log(`Setting reasoning level to: ${level}`);
    this.currentReasoning = level;
    // TODO: translate reasoning level to model suffix or config option
    // as appropriate for the server API
  }

  // ─── Display flags ───

  setShowFlags(flags: { showThoughts?: boolean; showTools?: boolean }): void {
    if (flags.showThoughts !== undefined) this.showThoughts = flags.showThoughts;
    if (flags.showTools !== undefined) this.showTools = flags.showTools;
  }

  getShowFlags(): { showThoughts: boolean; showTools: boolean } {
    return { showThoughts: this.showThoughts, showTools: this.showTools };
  }

  // ─── Status / context ───

  getContextUsage(): ContextUsage | null {
    if (!this.totalTokens && this.totalTokens !== 0) return null;
    return { totalTokens: this.totalTokens, contextSize: this.contextWindowSize };
  }

  getAvailableCommands(): Array<{ name: string; description: string }> {
    // OpenCode Server handles slash commands server-side
    // Return empty for now — bridge commands are handled by workspace-cmd.ts
    return [];
  }

  /** Sync local agent/model/reasoning state from the server's last message metadata. */
  async syncStateFromServer(sessionId: string): Promise<void> {
    try {
      const messages = await this.client.getSessionMessages(sessionId, 1);
      if (messages.length > 0) {
        const lastMsg = messages[0] as unknown as { info?: { mode?: string; modelID?: string; providerID?: string; variant?: string; role?: string } };
        if (lastMsg.info?.role === "assistant" || lastMsg.info?.mode) {
          if (lastMsg.info.mode) this.currentMode = lastMsg.info.mode;
          if (lastMsg.info.modelID && lastMsg.info.providerID) {
            this.currentModelId = `${lastMsg.info.providerID}/${lastMsg.info.modelID}`;
          }
          if (lastMsg.info.variant) this.currentReasoning = lastMsg.info.variant;
          return;
        }
      }
      // No messages yet — fall back to server config defaults
      const config = await this.client.getConfig();
      if (config.model && !this.currentModelId) {
        this.currentModelId = config.model;
        const mod = this.availableModels.find((m) => m.modelId === this.currentModelId);
        if (mod?.contextSize) this.contextWindowSize = mod.contextSize;
      }
    } catch {
      // Ignore — refreshAgents/refreshProviders will set defaults on first call
    }
  }

  /** Get session title from the server by ID. */
  async getSessionTitle(sessionId: string): Promise<string | undefined> {
    try {
      const info = await this.client.getSession(sessionId);
      return info.title;
    } catch {
      return undefined;
    }
  }

  /** List all projects on the server (used as workspace registry). */
  async listServerProjects(): Promise<Array<{ id: string; worktree: string; updatedAt: number }>> {
    const projects = await this.client.listProjects();
    return projects.map((p) => ({
      id: p.id,
      worktree: p.worktree,
      updatedAt: p.time?.updated ?? 0,
    }));
  }

  /** List all sessions across all workspaces, most recent first. */
  async listServerSessions(): Promise<Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: number }>> {
    const sessions = await this.client.listSessionsV2(50);
    return sessions
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((s) => ({
        sessionId: s.id,
        title: s.title,
        cwd: s.directory,
        updatedAt: s.updatedAt,
      }));
  }

  /** Health check: verify server is reachable. */
  async checkHealth(): Promise<boolean> {
    const h = await this.client.health();
    return h.ok;
  }
}
