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
import { spawnAgent, killAgent, type AgentCapabilities } from "./agent-manager.js";

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
            mcpServers: [],
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
   * Switch the reasoning level (thought_level) using ACP protocol.
   */
  async setReasoning(userId: string, level: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      return;
    }

    // Find the thought_level config option to get its id
    const thoughtLevelOpt = session.configOptions?.find(
      (o) => o.category === "thought_level",
    );

    if (thoughtLevelOpt) {
      // Use the actual config option id
      await session.connection.setSessionConfigOption({
        sessionId: session.activeSessionId,
        configId: thoughtLevelOpt.id,
        type: "select",
        value: level,
      });
      // Track locally so status works even if ACP doesn't echo back
      session.currentThoughtLevel = level;
    } else {
      // Fallback: try without config discovery
      await session.connection.setSessionConfigOption({
        sessionId: session.activeSessionId,
        configId: level,
        type: "select",
        value: level,
      });
      session.currentThoughtLevel = level;
    }

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
   */
  getCurrentReasoning(userId: string): string | undefined {
    const session = this.sessions.get(userId);
    if (!session) return undefined;
    const localTracking = session.currentThoughtLevel;
    if (localTracking) return localTracking;
    const thoughtLevelOpt = session.configOptions?.find(
      (o) => o.category === "thought_level",
    );
    return thoughtLevelOpt?.type === "select" ? thoughtLevelOpt.currentValue : undefined;
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
   * Cancel the ongoing prompt turn for a user using ACP session/cancel.
   * This sends a notification to the agent to stop as soon as possible.
   */
  async cancelPrompt(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) {
      this.opts.log(`[${userId}] No session to cancel`);
      return;
    }

    this.opts.log(`[${userId}] Cancelling prompt for session ${session.activeSessionId}`);
    await session.connection.cancel({ sessionId: session.activeSessionId });
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
    if (savedReasoning) {
      this.opts.log(`[${userId}] Restoring reasoning: ${savedReasoning}`);
      try {
        await session.connection.setSessionConfigOption({
          sessionId: agentInfo.sessionId,
          configId: savedReasoning,
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
      lastActivity: Date.now(),
      createdAt: Date.now(),
      ready: true,
      // Store real ACP session state data
      currentMode: agentInfo.currentModeId,
      currentModelId: agentInfo.currentModelId,
      availableModes: agentInfo.availableModes,
      availableModels: agentInfo.availableModels,
      configOptions: agentInfo.configOptions,
    };
  }

  /** Warm-up delay for freshly spawned agents before first prompt. */
  private static readonly AGENT_WARMUP_MS = 2000;

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        // If agent was just spawned, give it a moment to fully initialize
        if (Date.now() - session.createdAt < SessionManager.AGENT_WARMUP_MS) {
          const delay = SessionManager.AGENT_WARMUP_MS - (Date.now() - session.createdAt);
          this.opts.log(`[${session.userId}] Agent freshly spawned, waiting ${delay}ms before first prompt...`);
          await new Promise((r) => setTimeout(r, delay));
        }

        session.client.updateCallbacks({
          sendTyping: () => this.opts.sendTyping(session.userId, pending.contextToken),
          onThoughtFlush: (text) => this.opts.onReply(session.userId, pending.contextToken, text),
          onMediaFlush: (blocks) => this.opts.onMediaReply(session.userId, pending.contextToken, blocks),
          onDelayedFlush: (text) => this.opts.onReply(session.userId, pending.contextToken, text),
        });

        await session.client.flush();

        try {
          this.opts.sendTyping(session.userId, pending.contextToken).catch(() => {});

          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          const result = await session.connection.prompt({
            sessionId: session.activeSessionId,
            prompt: pending.prompt,
          });

          // Capture usage from prompt response
          if (result.usage) {
            session.totalTokens = result.usage.totalTokens;
            session.lastActivity = Date.now();
            this.opts.log(`[${session.userId}] Usage: totalTokens=${result.usage.totalTokens}`);
          }

          let replyText = await session.client.flush();

          // Poll for trailing chunks that arrive after end_turn.
          // Always wait at least once, then continue if more chunks arrive.
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const trailing = await session.client.flush();
            if (trailing.trim()) {
              replyText = replyText ? `${replyText}\n${trailing}` : trailing;
            }
            if (!session.client.hasTrailingContent()) break;
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

          if (replyText.trim()) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          if (session.process.killed || session.process.exitCode !== null) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            this.sessions.delete(session.userId);
            return;
          }

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
