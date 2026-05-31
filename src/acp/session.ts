/**
 * Per-user ACP session manager.
 *
 * New architecture: ONE agent process per user, MULTIPLE ACP sessions within it.
 * Session/workspace switching uses ACP protocol methods (newSession/loadSession)
 * instead of kill+respawn.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { WeChatAcpClient, type MediaContent } from "./client.js";
import { spawnAgent, killAgent, getMcpServers, type AgentCapabilities } from "./agent-manager.js";

/**
 * OpenCode encodes reasoning level as a suffix in the model ID.
 * Known suffixes: /low, /medium, /high, /max
 */
const REASONING_SUFFIXES = ["low", "medium", "high", "max"] as const;

function splitModelId(modelId: string): { base: string; level?: string } {
  for (const suffix of REASONING_SUFFIXES) {
    if (modelId.endsWith(`/${suffix}`)) {
      return { base: modelId.slice(0, -suffix.length - 1), level: suffix };
    }
  }
  return { base: modelId, level: undefined };
}

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
  hint?: string;  // Optional hint to append to the reply (e.g., "unrecognized slash command")
}

export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  capabilities: AgentCapabilities;
  activeSessionId: string;
  sessions: Map<string, { cwd: string; title?: string }>;
  currentMode?: string;
  currentModelId?: string;
  /** Real available modes from ACP response (e.g., build, plan) */
  availableModes?: acp.SessionMode[];
  /** Real available models from ACP response */
  availableModels?: acp.ModelInfo[];
  /** Available config options from ACP response (thought_level, etc.) */
  configOptions?: acp.SessionConfigOption[];
  /** Current thought level value (tracked manually when setReasoning is called) */
  currentThoughtLevel?: string;
  /** Cached thought_level config option ID (survives configOptions replacement from newSession) */
  thoughtLevelConfigId?: string;
  /** Last queried models (used when user does /model list <provider>) */
  lastQueriedModels?: Map<string, acp.ModelInfo[]>;
  /** Track which provider was last queried for index-based switching */
  lastQueriedProvider?: string;
  /** Cumulative total tokens from all prompt turns */
  totalTokens?: number;
  /** Current context window size from usage_update */
  contextWindowSize?: number;
  queue: PendingMessage[];
  processing: boolean;
  /** Set when user sends /stop — suppresses all further output to WeChat */
  cancelled: boolean;
  lastActivity: number;
  createdAt: number;
  ready: boolean;
}

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentEnv?: Record<string, string>;
  idleTimeoutMs: number;
  showThoughts: boolean;
  showTools: boolean;
  log: (msg: string) => void;
  onReply: (userId: string, contextToken: string, text: string) => Promise<void>;
  onMediaReply: (userId: string, contextToken: string, blocks: MediaContent[]) => Promise<void>;
  sendTyping: (userId: string, contextToken: string) => Promise<void>;
  /** Resolve cwd for a given userId */
  resolveCwd: (userId: string) => string;
  /** Get existing OpenCode session ID to resume (optional) */
  getExistingSessionId?: (userId: string) => string | undefined;
  /** Called after agent starts with the actual session ID */
  onSessionReady?: (userId: string, sessionId: string) => void;
  /** Called when usage_update is received from agent */
  onUsageUpdate?: (userId: string, usage: { size: number; used: number }) => void;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private pendingSessions = new Map<string, Promise<UserSession>>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SessionManagerOpts;
  private aborted = false;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  /** Returns resolved promise if cancelled, otherwise calls fn. */
  private ifCancelled(session: UserSession, fn: () => Promise<void>): Promise<void> {
    if (session.cancelled) return Promise.resolve();
    return fn();
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 2 * 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    for (const session of this.sessions.values()) {
      killAgent(session.process);
    }
    this.sessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    let session = this.sessions.get(userId);

    if (!session) {
      ({ session } = await this.getOrCreateSession(userId, message.contextToken));
    }

    session.contextToken = message.contextToken;
    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${userId}] queue processing error: ${String(err)}`);
      });
    }
  }

  /**
   * Get existing session or create a new one with deduplication.
   * Returns { session, isNew } so callers know if the agent was just spawned.
   * All entry points (enqueue, createNewSession, etc.) should use this.
   */
  private async getOrCreateSession(userId: string, contextToken: string, skipResume?: boolean): Promise<{ session: UserSession; isNew: boolean }> {
    // Fast path: already exists
    const existing = this.sessions.get(userId);
    if (existing) return { session: existing, isNew: false };

    // Pending lock: wait for in-flight creation
    const pending = this.pendingSessions.get(userId);
    if (pending) {
      const session = await pending;
      return { session, isNew: false };
    }

    // Create and track
    const sessionPromise = this.createInitialSession(userId, contextToken, skipResume);
    this.pendingSessions.set(userId, sessionPromise);

    try {
      const session = await sessionPromise;
      this.sessions.set(userId, session);
      return { session, isNew: true };
    } finally {
      this.pendingSessions.delete(userId);
    }
  }

  /**
   * Update session state from ACP loadSession/newSession response.
   */
  private applyLoadSessionState(
    session: UserSession,
    result: {
      modes?: { availableModes: acp.SessionMode[]; currentModeId: string } | null;
      models?: { availableModels: acp.ModelInfo[]; currentModelId: string } | null;
      configOptions?: acp.SessionConfigOption[] | null;
    },
  ): void {
    if (result.modes) {
      session.availableModes = result.modes.availableModes;
      session.currentMode = result.modes.currentModeId;
    }
    if (result.models) {
      session.availableModels = result.models.availableModels;
      session.currentModelId = result.models.currentModelId;
    }
    if (result.configOptions) {
      session.configOptions = result.configOptions;
    }
  }

  /**
   * Switch workspace: loads the most recent session for the given cwd,
   * or creates a new one if none exists.
   * NO kill/respawn of the agent process.
   */
  async switchWorkspace(userId: string, contextToken: string, cwd: string, existingSessionId?: string): Promise<void> {
    const { session } = await this.getOrCreateSession(userId, contextToken);

    if (existingSessionId) {
      // Load existing session for this cwd
      this.opts.log(`[${userId}] Loading session ${existingSessionId} for workspace switch (cwd: ${cwd})`);
      session.client.setReplaying(true);
      try {
        const loadResult = await session.connection.loadSession({
          sessionId: existingSessionId,
          cwd,
          mcpServers: await getMcpServers(cwd),
        });
        session.activeSessionId = existingSessionId;
        this.applyLoadSessionState(session, loadResult);
        if (!session.sessions.has(existingSessionId)) {
          session.sessions.set(existingSessionId, { cwd });
        }
      } finally {
        session.client.setReplaying(false);
      }
    } else {
      // No existing session — create new one
      this.opts.log(`[${userId}] Creating new session for workspace switch (cwd: ${cwd})`);
      const result = await session.connection.newSession({
        cwd,
        mcpServers: [],
      });
      session.activeSessionId = result.sessionId;
      this.applyLoadSessionState(session, result);
      session.sessions.set(result.sessionId, { cwd });
    }

    session.contextToken = contextToken;
    session.lastActivity = Date.now();
    this.opts.onSessionReady?.(userId, session.activeSessionId);
  }

  /**
   * Switch to an existing ACP session, replaying its conversation history.
   */
  async switchSession(userId: string, contextToken: string, sessionId: string, cwd: string): Promise<void> {
    const { session } = await this.getOrCreateSession(userId, contextToken);

    this.opts.log(`[${userId}] Loading session ${sessionId} (cwd: ${cwd})`);

    // Suppress replayed content
    session.client.setReplaying(true);
    try {
      const loadResult = await session.connection.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });
      session.activeSessionId = sessionId;
      this.applyLoadSessionState(session, loadResult);
      if (!session.sessions.has(sessionId)) {
        session.sessions.set(sessionId, { cwd });
      }
    } finally {
      session.client.setReplaying(false);
    }

    session.contextToken = contextToken;
    session.lastActivity = Date.now();

    this.opts.onSessionReady?.(userId, sessionId);
  }

  /**
   * Create a new ACP session, returns the new session ID.
   */
  async createNewSession(userId: string, contextToken: string, cwd: string): Promise<string> {
    const { session, isNew } = await this.getOrCreateSession(userId, contextToken, true);

    // If agent was just spawned, it already has a fresh initial session — no need to create another
    if (isNew) {
      this.opts.log(`[${userId}] Agent freshly spawned, using initial session (cwd: ${cwd})`);
      session.contextToken = contextToken;
      session.lastActivity = Date.now();
      this.opts.onSessionReady?.(userId, session.activeSessionId);
      return session.activeSessionId;
    }

    this.opts.log(`[${userId}] Creating new ACP session (cwd: ${cwd})`);

    const result = await session.connection.newSession({
      cwd,
      mcpServers: [],
    });

    // NOTE: We do NOT call applyLoadSessionState here because it would overwrite
    // currentMode and currentModelId with the agent's DEFAULT values (before our
    // setSessionMode/unstable_setSessionModel calls take effect). ACP calls are
    // async, so the newSession response reflects the initial state, not the state
    // after we switch mode/model.
    session.sessions.set(result.sessionId, { cwd });
    session.activeSessionId = result.sessionId;

    // Preserve availableModes/availableModels/configOptions from the response
    if (result.modes) {
      session.availableModes = result.modes.availableModes;
    }
    if (result.models) {
      session.availableModels = result.models.availableModels;
    }
    if (result.configOptions) {
      session.configOptions = result.configOptions;
    }

    // Restore previously selected agent mode and model (must be AFTER session state is updated)
    if (session.currentMode) {
      this.opts.log(`[${userId}] Restoring agent mode: ${session.currentMode}`);
      await session.connection.setSessionMode({
        sessionId: result.sessionId,
        modeId: session.currentMode,
      });
    }
    if (session.currentModelId) {
      this.opts.log(`[${userId}] Restoring model: ${session.currentModelId}`);
      await session.connection.unstable_setSessionModel({
        sessionId: result.sessionId,
        modelId: session.currentModelId,
      });
    }

    // Restore reasoning level (thought_level config option, if available)
    if (session.currentThoughtLevel && session.thoughtLevelConfigId) {
      this.opts.log(`[${userId}] Restoring reasoning: ${session.currentThoughtLevel} (configId=${session.thoughtLevelConfigId})`);
      try {
        const rResult = await session.connection.setSessionConfigOption({
          sessionId: result.sessionId,
          configId: session.thoughtLevelConfigId,
          type: "select",
          value: session.currentThoughtLevel,
        });
        if (rResult.configOptions) {
          session.configOptions = rResult.configOptions;
        }
        this.opts.log(`[${userId}] Reasoning restored successfully`);
      } catch (err) {
        this.opts.log(`[${userId}] Failed to restore reasoning: ${String(err)}`);
      }
    }

    session.contextToken = contextToken;
    session.lastActivity = Date.now();

    // Notify bridge of the new session ID so state file stays in sync
    this.opts.onSessionReady?.(userId, result.sessionId);

    return result.sessionId;
  }

  /**
   * List sessions for the current agent.
   */
  async listAgentSessions(userId: string, cwd?: string): Promise<acp.ListSessionsResponse> {
    const session = this.sessions.get(userId);
    if (!session) {
      return { sessions: [] };
    }

    if (!session.capabilities.sessionCapabilities?.list) {
      this.opts.log(`[${userId}] Agent does not support listSessions`);
      return { sessions: [] };
    }

    return session.connection.listSessions({ cwd });
  }

  /**
   * Close an ACP session.
   */
  async closeSession(userId: string, sessionId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    if (!session.capabilities.sessionCapabilities?.close) {
      this.opts.log(`[${userId}] Agent does not support closeSession`);
      return;
    }

    this.opts.log(`[${userId}] Closing session ${sessionId}`);

    await session.connection.unstable_closeSession({ sessionId });
    session.sessions.delete(sessionId);

    // If we closed the active session, switch to another or create a new one
    if (session.activeSessionId === sessionId) {
      const remaining = Array.from(session.sessions.keys());
      if (remaining.length > 0) {
        session.activeSessionId = remaining[0];
      } else {
        // Create a new session
        const cwd = this.opts.resolveCwd(userId);
        const result = await session.connection.newSession({ cwd, mcpServers: [] });
        session.activeSessionId = result.sessionId;
        session.sessions.set(result.sessionId, { cwd });
      }
    }
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId);
  }

  /**
   * Get available slash commands advertised by the agent.
   */
  getAvailableCommands(userId: string): acp.AvailableCommand[] {
    const session = this.sessions.get(userId);
    if (!session) return [];
    return session.client.getAvailableCommands();
  }

  getUserBySessionId(acpSessionId: string): { userId: string; contextToken: string } | null {
    for (const [userId, session] of this.sessions) {
      if (session.activeSessionId === acpSessionId) {
        return { userId, contextToken: session.contextToken };
      }
    }
    return null;
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Switch the agent mode (agent) using ACP protocol.
   */
  async switchAgent(userId: string, mode: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    this.opts.log(`[${userId}] Switching agent mode to: ${mode}`);

    await session.connection.setSessionMode({
      sessionId: session.activeSessionId,
      modeId: mode,
    });

    session.currentMode = mode;
    session.lastActivity = Date.now();
  }

  /**
   * Switch the model using ACP protocol.
   */
  async setModel(userId: string, modelId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    this.opts.log(`[${userId}] Switching model to: ${modelId}`);

    await session.connection.unstable_setSessionModel({
      sessionId: session.activeSessionId,
      modelId: modelId,
    });

    session.currentModelId = modelId;
    session.lastActivity = Date.now();
  }

  /**
   * Switch the reasoning level.
   * Tries: thought_level config option → model ID suffix approach.
   */
  async setReasoning(userId: string, level: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) throw new Error("No active session");

    // Approach 1: thought_level config option (new OpenCode)
    const thoughtOpt = session.configOptions?.find(
      (o) => o.category === "thought_level" || o.id === "thought_level" || o.id === "effort",
    );
    if (thoughtOpt?.type === "select") {
      // Verify the level is valid
      const exists = thoughtOpt.options.some((item: any) => {
        if ("value" in item) return item.value === level;
        return item.options?.some((o: any) => o.value === level);
      });
      if (!exists) {
        throw new Error(`Reasoning level "${level}" not available`);
      }

      // Cache the config option ID for restoration across session/new
      session.thoughtLevelConfigId = thoughtOpt.id;

      const result = await session.connection.setSessionConfigOption({
        sessionId: session.activeSessionId,
        configId: thoughtOpt.id,
        type: "select",
        value: level,
      });
      if (result.configOptions) {
        session.configOptions = result.configOptions;
      }
      session.currentThoughtLevel = level;
      session.lastActivity = Date.now();
      return;
    }

    // Approach 2: model ID suffix (legacy OpenCode)
    const modelOpt = session.configOptions?.find(
      (o) => o.id === "model" || o.category === "model",
    );
    if (!modelOpt || modelOpt.type !== "select") {
      throw new Error("Cannot access model configuration");
    }

    const currentModelId = session.currentModelId ?? modelOpt.currentValue;
    const { base: currentBase } = splitModelId(currentModelId);
    const targetModelId = `${currentBase}/${level}`;

    // Verify target model exists among options (including nested groups)
    const exists = modelOpt.options.some((item) => {
      if ("value" in item) return item.value === targetModelId;
      return item.options.some((o) => o.value === targetModelId);
    });
    if (!exists) {
      throw new Error(`Reasoning level "${level}" not available for current model`);
    }

    await session.connection.unstable_setSessionModel({
      sessionId: session.activeSessionId,
      modelId: targetModelId,
    });

    session.currentModelId = targetModelId;
    session.currentThoughtLevel = level;
    session.lastActivity = Date.now();
  }

  /**
   * Get the currently active agent mode for a user.
   */
  getActiveMode(userId: string): string | undefined {
    return this.sessions.get(userId)?.currentMode;
  }

  /**
   * Get all available agent modes for a user (real ACP data).
   */
  getAvailableModes(userId: string): acp.SessionMode[] | undefined {
    return this.sessions.get(userId)?.availableModes;
  }

  /**
   * Get current reasoning/thought level.
   * Tries: local tracking → model ID suffix → thought_level config option.
   */
  getCurrentReasoning(userId: string): string | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;

    // Approach 1: model ID suffix (legacy OpenCode)
    if (session.currentModelId) {
      const { level } = splitModelId(session.currentModelId);
      if (level) return level;
    }

    // Approach 2: thought_level config option (new OpenCode)
    const thoughtOpt = session.configOptions?.find(
      (o) => o.category === "thought_level" || o.id === "thought_level" || o.id === "effort",
    );
    if (thoughtOpt?.type === "select") {
      return thoughtOpt.currentValue;
    }

    return undefined;
  }

  /**
   * Get available reasoning levels.
   * Tries: model ID suffix approach → thought_level config option approach.
   */
  getReasoningLevels(userId: string): Array<{ value: string; name: string; current: boolean }> {
    const session = this.sessions.get(userId);
    if (!session) return [];

    // Approach 1: model ID suffixes (legacy OpenCode)
    const modelOpt = session.configOptions?.find(
      (o) => o.id === "model" || o.category === "model",
    );
    if (modelOpt?.type === "select") {
      const currentModelId = session.currentModelId ?? modelOpt.currentValue;
      const { base: currentBase, level: currentLevel } = splitModelId(currentModelId);

      const levels: Array<{ value: string; name: string; current: boolean }> = [];
      const seen = new Set<string>();

      for (const item of modelOpt.options) {
        const items = "value" in item ? [item] : item.options;
        for (const opt of items) {
          const { base, level } = splitModelId(opt.value);
          if (base === currentBase && level && !seen.has(level)) {
            seen.add(level);
            levels.push({ value: level, name: opt.name, current: level === currentLevel });
          }
        }
      }

      if (levels.length > 0) {
        const order: Record<string, number> = { low: 0, medium: 1, high: 2, max: 3 };
        levels.sort((a, b) => (order[a.value] ?? 99) - (order[b.value] ?? 99));
        return levels;
      }
    }

    // Approach 2: thought_level config option (new OpenCode)
    const thoughtOpt = session.configOptions?.find(
      (o) => o.category === "thought_level" || o.id === "thought_level" || o.id === "effort",
    );
    if (thoughtOpt?.type === "select") {
      const current = thoughtOpt.currentValue;
      const levels: Array<{ value: string; name: string; current: boolean }> = [];
      for (const item of thoughtOpt.options) {
        const items = "value" in item ? [item] : item.options;
        for (const opt of items) {
          levels.push({ value: opt.value, name: opt.name, current: opt.value === current });
        }
      }
      return levels;
    }

    return [];
  }

  /**
   * Cache last queried models for a provider.
   */
  cacheModelListForProvider(userId: string, provider: string, models: acp.ModelInfo[]): void {
    const session = this.sessions.get(userId);
    if (!session) return;
    if (!session.lastQueriedModels) session.lastQueriedModels = new Map();
    session.lastQueriedModels.set(provider, models);
    session.lastQueriedProvider = provider;
  }

  /**
   * Get last queried models for a provider.
   */
  getCachedModelsForProvider(userId: string, provider: string): acp.ModelInfo[] | undefined {
    return this.sessions.get(userId)?.lastQueriedModels?.get(provider);
  }

  /**
   * Get the provider that was last queried.
   */
  getLastQueriedProvider(userId: string): string | undefined {
    return this.sessions.get(userId)?.lastQueriedProvider;
  }

  /**
   * Get all last queried models in order of last queried provider.
   */
  getCachedModelsForLastQueried(userId: string): acp.ModelInfo[] | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    if (!session.lastQueriedProvider) return undefined;
    return session.lastQueriedModels?.get(session.lastQueriedProvider);
  }

  /**
   * Get the currently active model for a user.
   */
  getCurrentModel(userId: string): string | undefined {
    return this.sessions.get(userId)?.currentModelId;
  }

  /**
   * Get all available models for a user (real ACP data).
   */
  getAvailableModels(userId: string): acp.ModelInfo[] | undefined {
    return this.sessions.get(userId)?.availableModels;
  }

  /**
   * Get config options for a user (real ACP data).
   */
  getConfigOptions(userId: string): acp.SessionConfigOption[] | undefined {
    return this.sessions.get(userId)?.configOptions;
  }

  /**
   * Get context window usage for a user.
   * Returns totalTokens (cumulative across all turns) and context window size.
   */
  getContextUsage(userId: string): { totalTokens: number; contextSize: number } | null {
    const session = this.sessions.get(userId);
    if (!session) return null;
    const totalTokens = session.totalTokens;
    if (!totalTokens && totalTokens !== 0) return null;
    const contextSize = session.contextWindowSize ?? 0;
    return { totalTokens, contextSize };
  }

  /**
   * Update showThoughts and showTools flags at runtime.
   */
  setShowFlags(userId: string, flags: { showThoughts?: boolean; showTools?: boolean }): void {
    const session = this.sessions.get(userId);
    if (session) {
      session.client.setShowFlags(flags);
    }
  }

  /**
   * Cancel the ongoing prompt and forcefully stop all output.
   * Sends ACP cancel, then force-kills agent process after a short grace period.
   * Also sets cancelled flag to suppress any in-flight messages.
   */
  async cancelPrompt(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      this.opts.log(`[${userId}] No session to cancel`);
      return;
    }

    session.cancelled = true;
    this.opts.log(`[${userId}] Cancelling prompt for session ${session.activeSessionId}`);

    try {
      await session.connection.cancel({ sessionId: session.activeSessionId });
    } catch {
      // Cancel may fail if connection is hung
    }

    setTimeout(() => {
      if (session.processing) {
        this.opts.log(`[${userId}] Force-killing agent after cancel`);
        killAgent(session.process);
        this.sessions.delete(userId);
      }
    }, 5_000).unref();
  }

  /**
   * Restart the agent process for a user, preserving mode/model/cwd state.
   * Steps:
   * 1. Cancel any ongoing prompt
   * 2. Save current state (mode, model, reasoning, cwd)
   * 3. Kill old agent process
   * 4. Spawn new agent
   * 5. Restore mode/model/reasoning
   */
  async restartAgent(userId: string, contextToken: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      this.opts.log(`[${userId}] No session to restart`);
      return;
    }

    // Save current state
    const savedMode = session.currentMode;
    const savedModel = session.currentModelId;
    const savedReasoning = session.currentThoughtLevel;
    const cwd = this.opts.resolveCwd(userId);
    const existingSessionId = this.opts.getExistingSessionId?.(userId);

    this.opts.log(`[${userId}] Restarting agent (mode=${savedMode}, model=${savedModel}, cwd=${cwd})`);

    // Cancel any ongoing prompt
    try {
      await session.connection.cancel({ sessionId: session.activeSessionId });
    } catch {
      // Ignore cancel errors
    }

    // Kill old process
    killAgent(session.process);

    // Small delay to ensure process cleanup
    await new Promise((r) => setTimeout(r, 500));

    // Create new client and agent
    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onMediaFlush: (blocks) => this.opts.onMediaReply(userId, contextToken, blocks),
      onDelayedFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onUsageUpdate: (usage) => {
        const s = this.sessions.get(userId);
        if (s) s.contextWindowSize = usage.size;
      },
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
      showTools: this.opts.showTools,
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      existingSessionId,
    });

    // Update session with new process/connection
    session.process = agentInfo.process;
    session.connection = agentInfo.connection;
    session.activeSessionId = agentInfo.sessionId;
    session.capabilities = agentInfo.capabilities;
    session.availableModes = agentInfo.availableModes;
    session.availableModels = agentInfo.availableModels;
    session.configOptions = agentInfo.configOptions;

    // Set up process exit handler
    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.sessions.delete(userId);
      }
    });

    // Notify bridge of the new session ID
    this.opts.onSessionReady?.(userId, agentInfo.sessionId);

    // Restore saved state
    if (savedMode) {
      this.opts.log(`[${userId}] Restoring agent mode: ${savedMode}`);
      await session.connection.setSessionMode({ sessionId: agentInfo.sessionId, modeId: savedMode });
      session.currentMode = savedMode;
    }
    if (savedModel) {
      this.opts.log(`[${userId}] Restoring model: ${savedModel}`);
      await session.connection.unstable_setSessionModel({ sessionId: agentInfo.sessionId, modelId: savedModel });
      session.currentModelId = savedModel;
    }
    if (savedReasoning && session.thoughtLevelConfigId) {
      this.opts.log(`[${userId}] Restoring reasoning: ${savedReasoning}`);
      try {
        await session.connection.setSessionConfigOption({
          sessionId: agentInfo.sessionId,
          configId: session.thoughtLevelConfigId,
          type: "select",
          value: savedReasoning,
        });
        session.currentThoughtLevel = savedReasoning;
      } catch (err) {
        this.opts.log(`[${userId}] Failed to restore reasoning: ${String(err)}`);
      }
    }

    session.lastActivity = Date.now();
    this.opts.log(`[${userId}] Agent restarted successfully`);
  }

  /**
   * Get current show flags for a user.
   */
  getShowFlags(userId: string): { showThoughts: boolean; showTools: boolean } | null {
    const session = this.sessions.get(userId);
    if (!session) return null;
    return session.client.getShowFlags();
  }

  private async createInitialSession(userId: string, contextToken: string, skipResume?: boolean): Promise<UserSession> {
    const cwd = this.opts.resolveCwd(userId);
    const existingSessionId = skipResume ? undefined : this.opts.getExistingSessionId?.(userId);

    this.opts.log(
      `Creating initial session for ${userId} (cwd: ${cwd}${existingSessionId ? `, resume: ${existingSessionId}` : ""})`,
    );

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onMediaFlush: (blocks) => this.opts.onMediaReply(userId, contextToken, blocks),
      onDelayedFlush: (text) => this.opts.onReply(userId, contextToken, text),
      onUsageUpdate: (usage) => {
        const session = this.sessions.get(userId);
        if (session) session.contextWindowSize = usage.size;
      },
      onConfigOptionsUpdate: (configOptions) => {
        const session = this.sessions.get(userId);
        if (session) {
          session.configOptions = configOptions;
        }
      },
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
      showTools: this.opts.showTools,
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      existingSessionId,
    });

    // Set up process exit handler
    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.sessions.delete(userId);
      }
    });

    // Notify bridge of the actual session ID
    this.opts.onSessionReady?.(userId, agentInfo.sessionId);

    return {
      userId,
      contextToken,
      client,
      process: agentInfo.process,
      connection: agentInfo.connection,
      capabilities: agentInfo.capabilities,
      activeSessionId: agentInfo.sessionId,
      sessions: new Map([[agentInfo.sessionId, { cwd }]]),
      queue: [],
      processing: false,
      cancelled: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: true,
      // Store real ACP session state data
      currentMode: agentInfo.currentModeId,
      currentModelId: agentInfo.currentModelId,
      availableModes: agentInfo.availableModes,
      availableModels: agentInfo.availableModels,
      configOptions: agentInfo.configOptions ?? client.getLatestConfigOptions() ?? undefined,
    };
  }

  /** Warm-up delay for freshly spawned agents before first prompt. */
  private static readonly AGENT_WARMUP_MS = 2000;
  /** Maximum time to wait for a single prompt before rejecting. */
  private static readonly PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
  /** Maximum time to wait for client.flush() before rejecting. */
  private static readonly FLUSH_TIMEOUT_MS = 30_000;

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        // Reset cancelled flag at the start of each message processing
        session.cancelled = false;

        // If agent was just spawned, give it a moment to fully initialize
        if (Date.now() - session.createdAt < SessionManager.AGENT_WARMUP_MS) {
          const delay = SessionManager.AGENT_WARMUP_MS - (Date.now() - session.createdAt);
          this.opts.log(`[${session.userId}] Agent freshly spawned, waiting ${delay}ms before first prompt...`);
          await new Promise((r) => setTimeout(r, delay));
        }

        session.client.updateCallbacks({
          sendTyping: () => this.ifCancelled(session, () => this.opts.sendTyping(session.userId, pending.contextToken)),
          onThoughtFlush: (text) => this.ifCancelled(session, () => this.opts.onReply(session.userId, pending.contextToken, text)),
          onMediaFlush: (blocks) => this.ifCancelled(session, () => this.opts.onMediaReply(session.userId, pending.contextToken, blocks)),
          onDelayedFlush: (text) => this.ifCancelled(session, () => this.opts.onReply(session.userId, pending.contextToken, text)),
        });

        await session.client.flush();

        try {
          this.opts.sendTyping(session.userId, pending.contextToken).catch(() => {});

          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          let promptTimeout: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            session.connection.prompt({
              sessionId: session.activeSessionId,
              prompt: pending.prompt,
            }),
            new Promise<never>((_, reject) => {
              promptTimeout = setTimeout(() => {
                // Send ACP cancel when timeout fires
                session.connection.cancel({ sessionId: session.activeSessionId }).catch(() => {});
                reject(new Error(`Prompt timed out after ${SessionManager.PROMPT_TIMEOUT_MS / 60000}min`));
              }, SessionManager.PROMPT_TIMEOUT_MS);
            }),
          ]);
          if (promptTimeout) clearTimeout(promptTimeout);

          // Capture usage from prompt response
          if (result.usage) {
            session.totalTokens = result.usage.totalTokens;
            session.lastActivity = Date.now();
            this.opts.log(`[${session.userId}] Usage: totalTokens=${result.usage.totalTokens}`);
          }

          let flushTimeout: ReturnType<typeof setTimeout> | undefined;
          let replyText = await Promise.race([
            session.client.flush(),
            new Promise<string>((_, reject) => {
              flushTimeout = setTimeout(() => {
                // Send ACP cancel when flush timeout fires
                session.connection.cancel({ sessionId: session.activeSessionId }).catch(() => {});
                reject(new Error("Flush timed out after 30s"));
              }, SessionManager.FLUSH_TIMEOUT_MS);
            }),
          ]);
          if (flushTimeout) clearTimeout(flushTimeout);

          // Poll for trailing chunks that arrive after end_turn.
          // Continue until no new content arrives for 1.5s (silence threshold).
          let silenceCount = 0;
          for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 400));
            const trailing = await Promise.race([
              session.client.flush(),
              new Promise<string>((_, reject) =>
                setTimeout(
                  () => reject(new Error("Flush timed out after 30s")),
                  SessionManager.FLUSH_TIMEOUT_MS,
                ),
              ),
            ]);
            if (trailing.trim()) {
              replyText = replyText ? `${replyText}${trailing}` : trailing;
              silenceCount = 0;
            } else {
              silenceCount++;
            }
            if (silenceCount >= 4) break;
          }
          session.client.resetToolCallFlag();

          if (result.stopReason === "cancelled") {
            replyText += "\n[cancelled]";
          } else if (result.stopReason === "refusal") {
            replyText += "\n[agent refused to continue]";
          }

          this.opts.log(`[${session.userId}] Agent done (${result.stopReason}), reply ${replyText.length} chars`);

          // Append hint if present
          if (pending.hint && replyText.trim()) {
            replyText += `\n\n${pending.hint}`;
          }

          if (replyText.trim() && !session.cancelled) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          if (session.process.killed || session.process.exitCode !== null) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            this.sessions.delete(session.userId);
            return;
          }

          if (!session.cancelled) {
            try {
              await this.opts.onReply(
                session.userId,
                pending.contextToken,
                `⚠️ Agent error: ${String(err)}`,
              );
            } catch {
              // best effort
            }
          }
        }
      }
    } finally {
      session.processing = false;
    }
  }

  private cleanupIdleSessions(): void {
    if (this.opts.idleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > this.opts.idleTimeoutMs && !session.processing) {
        this.opts.log(`Session for ${userId} idle for ${Math.round((now - session.lastActivity) / 60_000)}min, removing`);
        killAgent(session.process);
        this.sessions.delete(userId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, session] of this.sessions) {
      if (!session.processing && (!oldest || session.lastActivity < oldest.lastActivity)) {
        oldest = { userId, lastActivity: session.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Evicting oldest idle session: ${oldest.userId}`);
      const session = this.sessions.get(oldest.userId);
      if (session) killAgent(session.process);
      this.sessions.delete(oldest.userId);
    }
  }
}
