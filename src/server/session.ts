/**
 * Simplified session manager (single-user, HTTP-based).
 *
 * Replaces the old ACP-based SessionManager (src/acp/session.ts).
 * No subprocess management, no ACP connection — just HTTP calls
 * to opencode serve + local state tracking.
 *
 * Event-driven agent interaction:
 *   - Chat messages use `sendMessageAsync` (POST /session/:id/prompt_async)
 *   - The actual agent output streams in via the SSE /global/event pipeline
 *   - This SessionManager accumulates events into "turns" and finalizes them
 *     when the session goes idle, supporting multiple assistant turns per user
 *     message (e.g. when the agent dispatches background sub-agents and replies
 *     a second time after they complete).
 *   - Slash commands and short probes that need a single deterministic
 *     response still use the synchronous `sendMessage` (POST /session/:id/message).
 */

import { OpenCodeServerClient } from "./client.js";
import { EventPipeline } from "./event-pipeline.js";
import type { MessagePart, MediaContent, ContextUsage, SessionMode, ModelRef, McpStatusMap } from "../types.js";
import type {
  AccumulatedTurn,
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  MessageUpdatedEvent,
  OpenCodeEvent,
  Part,
  SessionErrorEvent,
  SessionStatusEvent,
  TrackedTool,
} from "../types/events.js";

/** Idle debounce: wait this long after the last delta before considering the turn final. */
const TURN_FINALIZE_DEBOUNCE_MS = 500;
/** Hard ceiling: if no event for this long, force-finalize the turn. */
const TURN_STUCK_TIMEOUT_MS = 5 * 60_000;

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

/**
 * Trim an OpenCode command description to a short, single-line form suitable
 * for the /help output. Strips internal source tags like `(builtin)` /
 * `(user - Skill)` and truncates with an ellipsis past 60 characters.
 */
function shortenCommandDescription(desc: string | undefined): string {
  if (!desc) return "";
  const cleaned = desc.replace(/^\((?:builtin|user - Skill|opencode - Skill|skill|mcp|command)\)\s*/, "");
  const firstLine = cleaned.split("\n", 1)[0] ?? "";
  if (firstLine.length > 60) return firstLine.slice(0, 57) + "…";
  return firstLine;
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
  /** Cancel a previously-set typing indicator for the given contextToken. */
  cancelTyping?: (contextToken: string) => Promise<void>;
  onSessionReady?: (sessionId: string) => void;
  /**
   * If false, the SessionManager will NOT start the SSE event pipeline and
   * will fall back to the legacy synchronous `sendMessage` flow. Default: true.
   */
  useEventStream?: boolean;
  /**
   * Optional HTTP auth for the opencode server. Forwarded verbatim to the
   * underlying client. Sensitive values — never logged here.
   */
  auth?: {
    username?: string;
    password?: string;
    token?: string;
  };
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
  private cancelTyping?: (contextToken: string) => Promise<void>;
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

  // MCP status (TTL-cached for /status; invalidated by `force: true`, TTL
  // expiry, or workspace switch — the `cwd` key makes the latter implicit).
  private mcpStatusCache: { cwd: string; value: McpStatusMap; expiresAt: number } | null = null;

  // ─── Event-driven turn accumulation (Phase 1 MVP) ───
  private useEventStream: boolean;
  private eventPipeline: EventPipeline | null = null;
  /** Currently-accumulating assistant turn. Null when no turn is active. */
  private currentTurn: AccumulatedTurn | null = null;
  /**
   * FIFO queue of contextTokens for prompts that have been sent via
   * `prompt_async` but whose SSE echo hasn't been processed yet.
   *
   * When `handleMessageUpdated` sees a user-message echo with an ID
   * different from the current turn's `userMessageId`, it shifts one
   * entry off this queue and uses that contextToken to `beginTurn` for
   * the existing user message on the server (NO re-send — the server
   * already created the user message when it accepted the prompt).
   *
   * Why a FIFO queue (not a single slot): when the user sends multiple
   * messages in quick succession, all of them are sent immediately and
   * their echoes arrive in the same order. The first echo must use the
   * contextToken of the first sent prompt, the second echo the second
   * contextToken, etc. A single slot would lose this ordering and route
   * replies to the wrong WeChat user.
   */
  private pendingEchoes: string[] = [];
  /** Set true when the server reports session.status=busy. */
  private isSessionBusy = false;
  /** Timer for the post-delta debounce before finalizing a turn. */
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hard timeout timer in case events stop arriving entirely. */
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Most recent contextToken from an enqueue() call. Used as the fallback
   * contextToken for "implicit" turns created by ensureTurnForEvent — i.e.
   * additional assistant responses that arrive via SSE after a turn has
   * already finalized (most commonly: the second response triggered by a
   * background sub-agent completion). Without this fallback, those replies
   * would be silently dropped because the implicit turn has no contextToken.
   */
  private lastEnqueuedContextToken: string | null = null;

  constructor(opts: SessionManagerOpts) {
    this.client = new OpenCodeServerClient({
      baseUrl: opts.serverUrl,
      log: opts.log,
      auth: opts.auth,
    });
    this.cwd = opts.cwd;
    this.log = opts.log;
    this.onReply = opts.onReply;
    this.onMediaReply = opts.onMediaReply;
    this.sendTyping = opts.sendTyping;
    this.cancelTyping = opts.cancelTyping;
    this.onSessionReady = opts.onSessionReady;
    this.useEventStream = opts.useEventStream !== false;
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
    // The new workspace may define its own agents / providers in
    // opencode.json; refresh so /agent list and /model list reflect them
    // instead of whatever was cached from the previous cwd. createNewSession
    // does the same — we just forgot to do it here, so the agent list
    // appeared to be global-only after `/workspace switch`.
    this.refreshAgents().catch(() => {});
    this.refreshProviders().catch(() => {});
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
    // Same reasoning as switchWorkspace: the new session lives in a
    // different workspace than the one whose agents/providers are cached.
    this.refreshAgents().catch(() => {});
    this.refreshProviders().catch(() => {});
  }

  /**
   * Create a completely new session (resets context).
   *
   * Agent / model / reasoning are deliberately NOT reset — they live on the
   * SessionManager instance, not the server session, so the next prompt on
   * the new session will carry them in the body. This means `/session new`
   * behaves like "fresh context, same configuration". Callers that need to
   * see what was inherited can read `getActiveMode` / `getCurrentModel` /
   * `getCurrentReasoning` before/after the call.
   */
  async createNewSession(cwd: string): Promise<string> {
    this.log(`Creating new session (cwd: ${cwd})`);
    const info = await this.client.createSession(undefined, undefined, cwd);
    this.sessionId = info.id;
    this.cwd = cwd;
    // Fresh context: the previous session's token count no longer applies.
    this.totalTokens = 0;
    this.log(
      `Inherited state for new session ${info.id}: ` +
        `agent=${this.currentMode ?? "(default)"} ` +
        `model=${this.currentModelId ?? "(default)"} ` +
        `reasoning=${this.currentReasoning ?? "(default)"}`,
    );
    this.onSessionReady?.(info.id);
    // Fetch defaults from server for the new session
    this.refreshAgents().catch(() => {});
    this.refreshProviders().catch(() => {});
    return info.id;
  }

  // ─── Message processing (event-driven, Phase 1 MVP) ───

  /**
   * Enqueue a message for the agent.
   *
   * Two paths:
   *   1. Event-stream path (default): fire-and-forget via `prompt_async`,
   *      response accumulated from the SSE pipeline, finalized on session idle.
   *   2. Legacy sync path: only used if `useEventStream` is false, or if the
   *      server doesn't support `prompt_async` (falls back automatically).
   */
  async enqueue(parts: MessagePart[], contextToken: string, hint?: string): Promise<void> {
    await this.ensureSession();
    // Remember the most recent contextToken so implicit turns (created by
    // ensureTurnForEvent for sub-agent follow-up replies) can route their
    // response back to the right WeChat user.
    this.lastEnqueuedContextToken = contextToken;
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

      if (this.useEventStream) {
        // Send the prompt immediately — the server queues messages in
        // order and the agent processes them sequentially, so holding
        // the prompt on our side would only delay the user without any
        // benefit. The previous design did hold it (in `pendingAssistant`)
        // and then re-dispatched it from `finalizeTurn`, which caused
        // duplicate `prompt_async` calls: the server already created
        // the user message when it accepted the prompt, but the bridge
        // would re-enqueue the same parts and POST again.
        //
        // Two prep steps before the await:
        //   - If a turn is active: remember the contextToken in
        //     `pendingEchoes` so the echo (which will arrive shortly)
        //     can `beginTurn` for the existing user message on the
        //     server — using the right contextToken for the WeChat
        //     reply, and crucially WITHOUT re-sending.
        //   - If no turn is active: `beginTurn` NOW, so the echo is
        //     captured as the current turn's `userMessageId` instead
        //     of triggering the implicit-turn fallback in
        //     `ensureTurnForEvent`.
        if (this.currentTurn) {
          this.pendingEchoes.push(item.contextToken);
          this.log(`Turn busy; sent prompt for contextToken=${item.contextToken.slice(0, 8)}…`);
        } else {
          this.beginTurn(item);
        }
        try {
          await this.sendPromptAsync(item);
        } catch (err) {
          // The HTTP call failed. Roll back the bookkeeping we just
          // did — no echo will come for this prompt. Falling back to
          // the synchronous send path next: that path doesn't use
          // `pendingEchoes` or `currentTurn` for delivery, so we can
          // leave the (now-stale) turn in place; it'll be replaced the
          // next time we successfully send.
          const top = this.pendingEchoes[this.pendingEchoes.length - 1];
          if (top === item.contextToken) this.pendingEchoes.pop();
          this.log(`sendMessageAsync failed (${String(err)}), falling back to synchronous sendMessage`);
          await this.sendPromptSync(item);
          continue;
        }
      } else {
        await this.sendPromptSync(item);
      }
    }
  }

  /** Fire-and-forget prompt via /session/:id/prompt_async. Response via SSE. */
  private async sendPromptAsync(item: QueueItem): Promise<void> {
    const modelRef = this.currentModelId ? parseModelId(this.currentModelId) : undefined;
    this.log(`[event] Sending async prompt (mode=${this.currentMode ?? "default"}, model=${this.currentModelId ?? "default"}, variant=${this.currentReasoning ?? "default"})...`);
    await this.client.sendMessageAsync(this.sessionId!, item.parts, {
      agent: this.currentMode,
      model: modelRef,
      directory: this.cwd,
      // OpenCode Server treats `variant` as one-shot per message. Sending it
      // on every prompt keeps the model in the requested reasoning level —
      // omitting it reverts the next response to the default variant.
      variant: this.currentReasoning,
    });
  }

  /** Legacy synchronous prompt (single AssistantMessage response). */
  private async sendPromptSync(item: QueueItem): Promise<void> {
    this.sendTyping(item.contextToken).catch(() => {});

    const modelRef = this.currentModelId ? parseModelId(this.currentModelId) : undefined;
    this.log(`Sending prompt to agent (sync, mode=${this.currentMode ?? "default"}, model=${this.currentModelId ?? "default"}, variant=${this.currentReasoning ?? "default"})...`);

    try {
      const response = await this.client.sendMessage(
        this.sessionId!,
        item.parts,
        {
          agent: this.currentMode,
          model: modelRef,
          directory: this.cwd,
          // See sendPromptAsync() for why we always pass variant when set.
          variant: this.currentReasoning,
        },
      );

      if (response.info?.tokens?.total) {
        this.totalTokens = response.info.tokens.total;
        this.log(`Usage: totalTokens=${this.totalTokens}`);
      }

      const msgInfo = response as unknown as { info?: { mode?: string; modelID?: string; providerID?: string; variant?: string } };
      if (msgInfo.info?.mode) this.currentMode = msgInfo.info.mode;
      if (msgInfo.info?.modelID && msgInfo.info?.providerID) {
        this.currentModelId = `${msgInfo.info.providerID}/${msgInfo.info.modelID}`;
        const mod = this.availableModels.find((m) => m.modelId === this.currentModelId);
        if (mod?.contextSize) this.contextWindowSize = mod.contextSize;
      }
      if (msgInfo.info?.variant) this.currentReasoning = msgInfo.info.variant;

      let replyText = "";
      const mediaBlocks: MediaContent[] = [];
      for (const part of response.parts) {
        if (part.type === "text") {
          replyText += part.text;
        } else if (part.type === "tool_use") {
          this.log(`[tool] ${part.name}`);
        }
      }
      if (item.hint && replyText.trim()) {
        replyText += `\n\n${item.hint}`;
      }
      if (replyText.trim()) {
        await this.onReply(item.contextToken, replyText);
      }
      if (mediaBlocks.length > 0) {
        await this.onMediaReply(item.contextToken, mediaBlocks);
      }
      this.log(`Agent done (sync), reply ${replyText.length} chars`);
    } catch (err) {
      this.log(`Agent error (sync): ${String(err)}`);
      try {
        await this.onReply(item.contextToken, `⚠️ Agent error: ${String(err)}`);
      } catch {
        // best effort
      }
    }
  }

  /**
   * Start the SSE event pipeline.
   * Called by the bridge after a session exists.
   */
  async startEventPipeline(directory?: string): Promise<void> {
    if (this.eventPipeline) return;
    const url = `${this.client.getBaseUrl()}/global/event`;
    this.log(`[event] starting pipeline: ${url}`);
    // Reuse the client's pre-computed `Authorization` header so the SSE
    // stream authenticates identically to the JSON API. Without this, the
    // pipeline's fetch() lives outside the client and would 401 against
    // any server that requires auth (e.g. OpenCode desktop with
    // OPENCODE_SERVER_PASSWORD set).
    const authHeader = this.client.getAuthHeader();
    this.eventPipeline = new EventPipeline({
      url,
      directory,
      log: this.log,
      authHeader,
      onEvent: (event) => this.handleEvent(event),
      onStatusChange: (status) => {
        this.log(`[event] pipeline status: ${status}`);
      },
      onError: (err) => {
        this.log(`[event] pipeline error: ${err.message}`);
      },
    });
    this.eventPipeline.start();
  }

  /**
   * Stop the SSE event pipeline. Idempotent.
   */
  async stopEventPipeline(): Promise<void> {
    if (!this.eventPipeline) return;
    this.log(`[event] stopping pipeline`);
    await this.eventPipeline.stop();
    this.eventPipeline = null;
    this.clearFinalizeTimers();
  }

  // ─── Event handler dispatch ───

  private handleEvent(event: OpenCodeEvent): void {
    if (this.sessionId && "properties" in event && event.properties && "sessionID" in event.properties) {
      const sid = (event.properties as { sessionID?: string }).sessionID;
      if (sid && sid !== this.sessionId) {
        // Event for a different session — ignore.
        return;
      }
    }
    switch (event.type) {
      case "message.part.delta":
        this.handlePartDelta(event as MessagePartDeltaEvent);
        break;
      case "message.part.updated":
        this.handlePartUpdated(event as MessagePartUpdatedEvent);
        break;
      case "message.updated":
        this.handleMessageUpdated(event as MessageUpdatedEvent);
        break;
      case "message.removed":
        // For now just log; we may need to clean up part snapshots
        this.log(`[event] message.removed: ${event.properties.messageID.slice(0, 8)}…`);
        break;
      case "session.status":
        this.handleSessionStatus(event as SessionStatusEvent);
        break;
      case "session.idle":
        this.handleSessionIdle(event.properties.sessionID);
        break;
      case "session.error":
        this.handleSessionError(event as SessionErrorEvent);
        break;
      default:
        // Unknown event — ignore.
        break;
    }
  }

  // ─── Turn lifecycle ───

  private beginTurn(item: QueueItem): void {
    this.currentTurn = {
      sessionId: this.sessionId!,
      userMessageId: null,
      assistantMessageId: null,
      parts: new Map(),
      textBuffer: "",
      finalText: "",
      toolCalls: new Map(),
      hasBackgroundTasks: false,
      contextToken: item.contextToken,
      hint: item.hint ?? null,
      status: "accumulating",
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      sentTextPartIds: new Set(),
      pendingTextParts: [],
    };
    this.log(`[turn] start contextToken=${item.contextToken.slice(0, 8)}…`);
    this.scheduleStuckTimeout();
    this.sendTyping(item.contextToken).catch(() => {});
  }

  private handlePartDelta(event: MessagePartDeltaEvent): void {
    const turn = this.ensureTurnForEvent();
    if (!turn) return;
    turn.lastEventAt = Date.now();

    if (event.properties.field !== "text") {
      // Non-text deltas (e.g. reasoning deltas) — ignored in MVP.
      return;
    }

    // Identify which part this delta belongs to. If we don't yet have the
    // part, create a stub TextPart.
    let part = turn.parts.get(event.properties.partID);
    if (!part || part.type !== "text") {
      part = {
        id: event.properties.partID,
        sessionID: event.properties.sessionID,
        messageID: event.properties.messageID,
        type: "text",
        text: "",
      } as Part;
      turn.parts.set(event.properties.partID, part);
    }
    (part as { text: string }).text += event.properties.delta;
    turn.textBuffer += event.properties.delta;

    if (turn.assistantMessageId === null) {
      turn.assistantMessageId = event.properties.messageID;
    }

    this.log(`[event] delta partID=${event.properties.partID.slice(0, 8)}… +${event.properties.delta.length}ch`);
    this.armFinalizeDebounce();
  }

  private handlePartUpdated(event: MessagePartUpdatedEvent): void {
    const turn = this.ensureTurnForEvent();
    if (!turn) return;
    turn.lastEventAt = Date.now();

    const part = event.properties.part;
    turn.parts.set(part.id, part);

    if (part.type === "text") {
      // Authoritative final text — replace any delta-derived buffer for this part.
      turn.finalText = part.text;
      // NOTE: We must NOT set `turn.assistantMessageId` from `part.messageID`
      // here. The OpenCode server replays the user's INPUT parts back through
      // the event stream after `prompt_async`, and those user-input parts
      // share the same `type: "text"`. Setting `assistantMessageId` from the
      // first text part would point it at the user message, and then we'd
      // either echo the user input to WeChat (if we send text parts
      // unconditionally) or skip the assistant's actual text parts (if we
      // filter by `part.messageID === assistantMessageId`).
      //
      // `assistantMessageId` is set exclusively in `handleMessageUpdated`
      // when an `info.role === "assistant"` event arrives. Until that
      // happens, the part is buffered; once the assistant message is
      // known, buffered parts that match are flushed.
      this.maybeSendTextPart(turn, part);
    } else if (part.type === "tool") {
      this.trackTool(turn, part);
    } else if (part.type === "file") {
      // Could be sent via onMediaReply in Phase 2.
      this.log(`[event] file part: ${part.filename ?? part.url}`);
    }

    this.log(`[event] part.updated type=${part.type} partID=${part.id.slice(0, 8)}…`);
    this.armFinalizeDebounce();
  }

  /**
   * Send a finalized text part to WeChat as a separate message.
   *
   * The OpenCode server replays the user's INPUT parts back through the
   * event stream after `prompt_async`. Those user-input text parts share
   * the same `type: "text"` as the assistant's reply parts, but they
   * belong to a different `messageID`. We must therefore gate every
   * `maybeSendTextPart` call on `part.messageID === turn.assistantMessageId`
   * — otherwise the bridge would echo the user's prompt and the bridge-
   * injected "[系统提示: ...]" back to WeChat.
   *
   * Because the assistant's `message.updated` event and its first text
   * `part.updated` event can arrive in either order, parts that arrive
   * before `assistantMessageId` is known are buffered in
   * `turn.pendingTextParts` and flushed once the assistant's message ID
   * becomes available.
   */
  private maybeSendTextPart(turn: AccumulatedTurn, part: Part): void {
    if (part.type !== "text") return;
    if (turn.sentTextPartIds.has(part.id)) return;
    if (!part.text.trim()) return;

    // If we don't yet know the assistant's message ID, buffer the part
    // and wait for `handleMessageUpdated` to set it (or for the turn to
    // finalize, which flushes any remaining buffered parts).
    if (turn.assistantMessageId === null) {
      turn.pendingTextParts.push(part);
      this.log(`[text-part] buffering part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}…) until assistantMessageId is known`);
      return;
    }

    // Drop user-input parts (or any part from a different message).
    if (part.messageID !== turn.assistantMessageId) {
      this.log(`[text-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${turn.assistantMessageId.slice(0, 8)}…)`);
      return;
    }

    if (!turn.contextToken) {
      this.log(`[text-part] no contextToken for part ${part.id.slice(0, 8)}…; dropping`);
      return;
    }

    turn.sentTextPartIds.add(part.id);
    this.log(`[text-part] sending part ${part.id.slice(0, 8)}… (${part.text.length}ch)`);
    this.onReply(turn.contextToken, part.text).catch((err) => {
      this.log(`onReply error for text part: ${String(err)}`);
    });
  }

  /**
   * Flush any text parts that were buffered before the assistant's
   * message ID was known. Called from `handleMessageUpdated` when
   * `info.role === "assistant"` arrives, and from `finalizeTurn` as
   * a last-chance flush.
   */
  private flushPendingTextParts(turn: AccumulatedTurn): void {
    if (turn.pendingTextParts.length === 0) return;
    const pending = turn.pendingTextParts;
    turn.pendingTextParts = [];
    for (const part of pending) {
      this.maybeSendTextPart(turn, part);
    }
  }

  private handleMessageUpdated(event: MessageUpdatedEvent): void {
    const turn = this.currentTurn;
    if (!turn) {
      // We may be receiving events before beginTurn was called (race).
      // The first message.updated we see after a prompt is the assistant
      // message; start the turn implicitly if we have a pending prompt.
      return;
    }
    turn.lastEventAt = Date.now();
    const info = event.properties.info;
    if (info.role === "assistant") {
      turn.assistantMessageId = info.id;
      // Track tokens
      if (info.tokens?.total) {
        this.totalTokens = info.tokens.total;
      }
      // Sync mode/model from message info
      if (info.agent) this.currentMode = info.agent;
      if (info.model?.providerID && info.model?.modelID) {
        this.currentModelId = `${info.model.providerID}/${info.model.modelID}`;
        const mod = this.availableModels.find((m) => m.modelId === this.currentModelId);
        if (mod?.contextSize) this.contextWindowSize = mod.contextSize;
      }
      // Sync reasoning variant back from server. The server's Assistant
      // message carries the variant that was actually applied (so even if
      // our local currentReasoning got stale, /status now reflects ground
      // truth). Guard against undefined so a missing field doesn't wipe a
      // value the user set locally but hasn't sent yet.
      if (info.variant) {
        this.currentReasoning = info.variant;
      }
      // Now that we know the assistant's message ID, flush any text parts
      // that were buffered while waiting. User-input parts (different
      // messageID) are dropped inside maybeSendTextPart.
      this.flushPendingTextParts(turn);
    } else if (info.role === "user") {
      // A `message.updated role=user` event is normally the SERVER's
      // echo of a user message that was just created by our
      // `prompt_async` call (delivered via SSE after the HTTP request
      // returned). It can also be re-delivered if the SSE stream
      // reconnects and replays history with Last-Event-ID.
      //
      // Three cases:
      //   - `turn.userMessageId === null`: first echo for this turn
      //     (initial capture, or the echo of a prompt we just sent and
      //     `beginTurn`-ed for). Capture it.
      //   - Same ID as the current turn's userMessageId: re-delivery
      //     (SSE replay). Ignore.
      //   - DIFFERENT ID: this is the echo of a SECOND prompt we sent
      //     while the previous turn was still running. The server
      //     already created that user message — we just need to start
      //     tracking it. Shift the matching contextToken off
      //     `pendingEchoes` (FIFO) so the new turn uses the right
      //     WeChat context, and `beginTurn` WITHOUT re-sending.
      if (turn.userMessageId === null) {
        turn.userMessageId = info.id;
        this.log(`[event] captured trigger userMessageId=${info.id.slice(0, 8)}…`);
      } else if (turn.userMessageId === info.id) {
        this.log(`[event] ignored re-delivered user message ${info.id.slice(0, 8)}…`);
      } else {
        this.log(`[turn] new user message ${info.id.slice(0, 8)}… (was tracking ${turn.userMessageId.slice(0, 8)}…)`);
        const pendingCtx = this.pendingEchoes.shift();
        this.finalizeTurn("interrupted");
        if (pendingCtx !== undefined) {
          // Our own echo of a prompt we already sent via `prompt_async`.
          // The user message is already on the server — beginTurn wires
          // the current turn up to it without re-sending. The FIFO
          // queue ensures this contextToken matches the prompt that
          // produced this echo (in send-order, which the server echoes
          // back in the same order).
          this.beginTurn({
            parts: [],
            contextToken: pendingCtx,
            hint: undefined,
          });
          if (this.currentTurn) {
            this.currentTurn.userMessageId = info.id;
          }
        } else {
          // `pendingEchoes` is empty: this is an unexpected user-message
          // event we can't account for (e.g. an echo from a prompt sent
          // before the current bridge instance, or a server-side quirk).
          // Don't finalize-replace — just log and let the bridge keep
          // the freshly-finalized state. The next WeChat message from
          // the user will start a new turn normally.
          this.log(`[turn] no pending echo for new user message; turn finalized without replacement`);
        }
      }
    }
  }

  private handleSessionStatus(event: SessionStatusEvent): void {
    this.log(`[event] session.status sessionID=${event.properties.sessionID.slice(0, 8)}… status=${event.properties.status.type}`);
    if (event.properties.status.type === "busy") {
      this.isSessionBusy = true;
    } else if (event.properties.status.type === "idle" || event.properties.status.type === "retry") {
      this.isSessionBusy = false;
      this.armFinalizeDebounce();
    }
  }

  private handleSessionIdle(sessionId: string): void {
    this.log(`[event] session.idle ${sessionId.slice(0, 8)}…`);
    this.isSessionBusy = false;
    this.armFinalizeDebounce();
  }

  private handleSessionError(event: SessionErrorEvent): void {
    const msg = event.properties.error ? String(event.properties.error) : "unknown";
    this.log(`[event] session.error: ${msg}`);
    if (this.currentTurn) {
      this.finalizeTurn("error", `⚠️ Session error: ${msg}`);
    }
  }

  // ─── Tool tracking ───

  private trackTool(turn: AccumulatedTurn, part: Part): void {
    if (part.type !== "tool") return;
    const isSubAgent = part.tool === "task" || part.tool === "subtask";
    const tracked: TrackedTool = {
      callID: part.callID,
      toolName: part.tool,
      status: part.state.status,
      title: part.state.title,
      output: part.state.output,
      isSubAgent,
    };
    turn.toolCalls.set(part.callID, tracked);
    if (isSubAgent && part.state.status !== "error") {
      turn.hasBackgroundTasks = true;
    }
    this.log(`[tool] ${part.tool} status=${part.state.status} callID=${part.callID.slice(0, 8)}…${isSubAgent ? " (sub-agent)" : ""}`);
  }

  // ─── Turn finalization ───

  /** Schedule (or reschedule) the post-delta debounce to finalize the turn. */
  private armFinalizeDebounce(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
    }
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      // Only finalize if the session isn't busy with background tasks.
      if (this.currentTurn && !this.isSessionBusy) {
        this.finalizeTurn("finalized");
      } else if (this.currentTurn) {
        this.log(`[turn] still busy (background tasks); waiting`);
      }
    }, TURN_FINALIZE_DEBOUNCE_MS);
  }

  /** Hard timeout: if no event for too long, force-finalize. */
  private scheduleStuckTimeout(): void {
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = null;
      if (this.currentTurn) {
        this.log(`[turn] stuck timeout (no events for ${TURN_STUCK_TIMEOUT_MS}ms); force-finalizing`);
        this.finalizeTurn("finalized");
      }
    }, TURN_STUCK_TIMEOUT_MS);
  }

  private clearFinalizeTimers(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    if (this.stuckTimer) {
      clearTimeout(this.stuckTimer);
      this.stuckTimer = null;
    }
  }

  /**
   * Finalize the current turn and dispatch the reply to WeChat.
   * Called on session idle (debounced) or on user interrupt / session error.
   *
   * Per-text-part sending happens in `maybeSendTextPart` (called from
   * `handlePartUpdated`) — by the time we get here, each text part has
   * already been delivered to WeChat as its own message. So this method
   * only handles:
   *   - Canceling the typing indicator
   *   - Sending the tool summary (if showTools is on)
   *   - Sending the hint (only if no text was sent at all)
   *   - Sending overrideText (only if no text was sent at all)
   *   - Fallback: sending textBuffer content if no part updates arrived
   *     but the delta stream had text
   */
  private finalizeTurn(reason: "finalized" | "interrupted" | "error", overrideText?: string): void {
    const turn = this.currentTurn;
    if (!turn) return;
    if (turn.status !== "accumulating") return; // already finalized

    turn.status = reason;
    this.clearFinalizeTimers();

    // Drop any text parts still buffered — if we got this far without the
    // assistant's message ID being known, those buffered parts are very
    // likely the user's own input parts that we correctly held back. Any
    // real assistant parts should have been sent via flushPendingTextParts
    // when the `message.updated role=assistant` event arrived.
    if (turn.pendingTextParts.length > 0) {
      this.log(`[turn] dropping ${turn.pendingTextParts.length} buffered text part(s) at finalize (likely user-input echoes)`);
      turn.pendingTextParts = [];
    }

    const contextToken = turn.contextToken ?? "";
    const anyTextSent = turn.sentTextPartIds.size > 0;

    this.log(`[turn] finalize reason=${reason} sentTextParts=${turn.sentTextPartIds.size} tools=${turn.toolCalls.size} bgTasks=${turn.hasBackgroundTasks} assistantMsg=${turn.assistantMessageId?.slice(0, 8) ?? "-"}`);

    // Always cancel typing when the turn finalizes — even if we have no text
    // to send (otherwise the typing indicator would stay on in WeChat).
    if (contextToken) {
      this.cancelTyping?.(contextToken).catch(() => {});
    }

    // Send tool summary as a SEPARATE message when /thinking on.
    if (this.showTools && turn.toolCalls.size > 0 && contextToken) {
      const summary = this.buildToolSummary(turn);
      if (summary) {
        this.onReply(contextToken, summary).catch((err) => {
          this.log(`onReply error for tool summary: ${String(err)}`);
        });
      }
    }

    // If NO text parts were sent (e.g. agent did only tool calls, or the
    // session errored with no text), we still want to deliver *something*
    // to the user. Priority:
    //   1. overrideText (session error message)
    //   2. turn.hint (if any)
    //   3. textBuffer fallback (deltas arrived but no part.updated)
    if (!anyTextSent && contextToken) {
      let fallback = overrideText ?? turn.hint ?? "";
      if (!fallback.trim() && turn.textBuffer.trim()) {
        fallback = turn.textBuffer;
      }
      if (fallback.trim()) {
        this.onReply(contextToken, fallback).catch((err) => {
          this.log(`onReply error for fallback reply: ${String(err)}`);
        });
      } else {
        this.log(`[turn] no text to send (reason=${reason})`);
      }
    }

    this.currentTurn = null;

    // Note: we no longer re-dispatch queued prompts from here. Prompts
    // are now sent immediately in `processQueue` and the corresponding
    // SSE echo handles turn transitions. Any in-flight `pendingEchoes`
    // entries belong to user messages the server has already created;
    // they don't need to be re-sent.
  }

  /**
   * Build a human-readable summary of tool calls during this turn.
   * Only called when showTools is enabled.
   */
  private buildToolSummary(turn: AccumulatedTurn): string {
    const lines: string[] = ["🔧 Tools:"];
    for (const tc of turn.toolCalls.values()) {
      const subAgentTag = tc.isSubAgent ? " (sub-agent)" : "";
      const statusEmoji = tc.status === "completed" ? "✅" : tc.status === "error" ? "❌" : "⏳";
      const title = tc.title ? ` ${tc.title}` : "";
      lines.push(`  ${statusEmoji} ${tc.toolName}${title}${subAgentTag}`);
    }
    return lines.join("\n");
  }

  /** Helper: ensure a turn exists for the current session, creating a stub if needed. */
  private ensureTurnForEvent(): AccumulatedTurn | null {
    if (this.currentTurn) return this.currentTurn;
    // No turn started yet — events arriving before beginTurn, OR (more
    // commonly) events arriving after the prior turn has already finalized
    // but the agent is producing a follow-up response (e.g. after a
    // background sub-agent completes). The agent's first message.updated
    // (assistant role) will populate the implicit turn via handleMessageUpdated.
    // For deltas arriving first, we create a stub.
    if (!this.sessionId) return null;
    const fallbackContext = this.currentContextToken();
    if (!fallbackContext) {
      // No pending prompt and no remembered context — log and skip.
      // This is rare; usually lastEnqueuedContextToken is set.
      this.log(`[event] no contextToken for implicit turn; dropping event`);
      return null;
    }
    this.beginTurn({
      parts: [],
      contextToken: fallbackContext,
      hint: undefined,
    });
    this.log(`[turn] implicit start (sub-agent follow-up?) contextToken=${fallbackContext.slice(0, 8)}…`);
    // beginTurn always sets this.currentTurn; non-null assertion is safe here.
    return this.currentTurn!;
  }

  /**
   * Best-effort contextToken for an implicit turn started by a server event
   * (e.g. a delta that arrives after the prior turn finalized, in response
   * to a background sub-agent completion).
   *
   * With the new "send immediately" design, every enqueued prompt is sent
   * right away in `processQueue` (no per-bridge hold), so the most recent
   * `enqueue()` call is the right reference point for any implicit turn.
   * If it's empty, the reply is skipped.
   */
  private currentContextToken(): string {
    return this.lastEnqueuedContextToken ?? "";
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
    // Drop any in-flight echoes. Their user messages may still arrive
    // on the SSE stream (the server has already created them) but the
    // user is about to send something new — discarding the queue keeps
    // those echoes from being mis-attributed to a later turn.
    this.pendingEchoes = [];
    // Finalize any in-flight turn as interrupted
    if (this.currentTurn) {
      this.finalizeTurn("interrupted");
    }
  }

  // ─── Agent mode ───

  /**
   * Built-in OpenCode utility agents that the server returns from `/agent`
   * with `mode: "primary"` and `builtIn: false`, so the regular
   * `mode === "primary" && !builtIn` filter doesn't catch them. They are
   * internal helpers (context compaction, session summarization, title
   * generation) that the user should never see in `/agent list` or
   * accidentally switch to. If OpenCode adds more, append them here.
   */
  private static readonly HIDDEN_AGENT_NAMES: ReadonlySet<string> = new Set([
    "compaction",
    "summary",
    "title",
  ]);

  /** Fetch available agents from the server and cache them. */
  async refreshAgents(): Promise<void> {
    try {
      // Scope to the current workspace so custom agents defined in the
      // project's opencode.json are included — without `directory` the
      // server returns the global agent list only and workspace-only
      // agents (which the agent itself can see) would be missing here.
      const agents = await this.client.listAgents(this.cwd);
      // User-switchable agents are anything that is NOT mode: "subagent".
      // OpenCode has three modes: "primary" (Tab-switchable only), "subagent"
      // (invoked via @-mention or by other agents — never directly), and
      // "all" (both — this is also the DEFAULT when a custom agent's markdown
      // file omits `mode:`, so all user-defined custom agents land here).
      // We want to show both "primary" and "all" in `/agent list` and hide
      // only "subagent" entries. Also drop OpenCode's built-in utility
      // agents (compaction/summary/title) which slip through because the
      // server reports them as primary+non-builtIn even though they're internal.
      this.availableModes = agents
        .filter(
          (a) =>
            a.mode !== "subagent" &&
            !a.builtIn &&
            !SessionManager.HIDDEN_AGENT_NAMES.has(a.name),
        )
        .map((a) => ({
          id: a.name, // Server uses agent name as the switchable value
          name: a.name,
          description: a.description,
          // Carry the agent's own default model/variant so /agent switch can
          // sync bridge state. If the server didn't return them (older
          // OpenCode), they're undefined and switchAgent keeps the user's
          // previous choice — see switchAgent() for the policy.
          model: a.model,
          variant: a.variant,
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

  /**
   * Switch to a different primary agent.
   *
   * Syncs local model / reasoning state with the agent's per-agent config:
   *   - Agent has `model` → adopt it as `currentModelId`.
   *   - Agent has `variant` → adopt it as `currentReasoning` (when valid).
   *   - Agent lacks either → keep whatever the user previously selected.
   *
   * The "adopt on present, keep on absent" policy matches the user mental
   * model: "switching agent picks up that agent's defaults, but doesn't
   * trample on choices I made for myself when the agent has no opinion".
   */
  async switchAgent(modeId: string): Promise<{ modeId: string; note?: string }> {
    this.log(`Switching agent mode to: ${modeId}`);
    const agent = this.availableModes.find((m) => m.id === modeId);

    // If we don't know this agent (cache cold or stale), still set currentMode
    // so prompts carry the new agent — we'll learn the per-agent config next
    // time refreshAgents() lands.
    if (!agent) {
      this.currentMode = modeId;
      return { modeId };
    }

    this.currentMode = modeId;
    const changes: string[] = [];

    // Model
    if (agent.model) {
      const newModelId = `${agent.model.providerID}/${agent.model.modelID}`;
      if (newModelId !== this.currentModelId) {
        const previousModel = this.currentModelId ?? "(default)";
        this.currentModelId = newModelId;
        // Update context window size from the new model
        const cached = this.availableModels.find((m) => m.modelId === newModelId);
        if (cached?.contextSize) this.contextWindowSize = cached.contextSize;
        changes.push(`Model: ${previousModel} → ${newModelId}`);
      }
    }

    // Variant. We need the new model's variants table to validate the value.
    // Re-resolve after the model change above so we look at the right model.
    if (agent.variant !== undefined) {
      const newModel = this.availableModels.find((m) => m.modelId === this.currentModelId);
      const variants = newModel?.variants;
      const variantIsValid = variants
        ? Object.keys(variants).some((k) => k === agent.variant)
        : true; // unknown model → trust the agent's config
      if (!variantIsValid) {
        // Agent declared a variant the new model doesn't expose. Treat as
        // "agent has no opinion" — keep user's current reasoning.
        this.log(`Agent "${modeId}" variant "${agent.variant}" not on ${this.currentModelId}; keeping user's choice`);
      } else if (agent.variant !== this.currentReasoning) {
        const previousReasoning = this.currentReasoning ?? "(default)";
        this.currentReasoning = agent.variant;
        changes.push(`Reasoning: ${previousReasoning} → ${agent.variant}`);
      }
    }

    // Reasoning may need a second-pass reconciliation when we changed the
    // model (the old variant might not exist on the new model's variants).
    // Reuse the same logic setModel() uses so /status can't get out of sync.
    const newLevels = this.getReasoningLevels();
    if (newLevels.length === 0) {
      if (this.currentReasoning !== undefined) {
        this.log(`Clearing reasoning: ${this.currentModelId ?? "(no model)"} exposes no variants`);
        this.currentReasoning = undefined;
      }
    } else if (!newLevels.some((lv) => lv.value === this.currentReasoning)) {
      this.log(`Reasoning "${this.currentReasoning}" not available; snapping to "${newLevels[0].value}"`);
      this.currentReasoning = newLevels[0].value;
    }

    return { modeId, ...(changes.length > 0 ? { note: changes.join("; ") } : {}) };
  }

  // ─── Model ───

  /** Fetch providers and their models from the server, cache for listing. */
  async refreshProviders(): Promise<void> {
    try {
      // Scope to the current workspace so project-level provider config
      // (e.g. custom endpoints in the workspace's opencode.json) is honored.
      const providers = await this.client.listProviders(this.cwd);
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

  async setModel(modelId: string): Promise<{ modelId: string; note?: string }> {
    this.log(`Switching model to: ${modelId}`);
    this.currentModelId = modelId;
    // Update context window size from model info
    const model = this.availableModels.find((m) => m.modelId === modelId);
    if (model?.contextSize) {
      this.contextWindowSize = model.contextSize;
    }

    // Reasoning levels are model-scoped: the previous variant may not be
    // valid for the new model. Reconcile before the next prompt goes out
    // so we don't ship a `variant` the server can't honour, and so /status
    // reflects what will actually be sent.
    const previous = this.currentReasoning;
    const newLevels = this.getReasoningLevels();
    let note: string | undefined;
    if (newLevels.length === 0) {
      // New model exposes no reasoning variants (either `reasoning: false`
      // or no `variants` table). Clear so the outgoing prompt omits
      // `variant` entirely and the server picks its default.
      if (previous !== undefined) {
        this.log(`Clearing reasoning: ${modelId} exposes no variants (was "${previous}")`);
        note = `Reasoning cleared (was "${previous}"); ${modelId} exposes no reasoning levels`;
      }
      this.currentReasoning = undefined;
    } else if (!newLevels.some((lv) => lv.value === previous)) {
      // Current variant isn't valid for the new model — snap to the first
      // available level so /reasoning list shows a usable value.
      const next = newLevels[0].value;
      this.log(`Resetting reasoning: "${previous}" not available on ${modelId}, using "${next}"`);
      this.currentReasoning = next;
      note = previous !== undefined
        ? `Reasoning reset from "${previous}" to "${next}" (first level on ${modelId})`
        : `Reasoning set to "${next}"`;
    }
    return { modelId, ...(note !== undefined ? { note } : {}) };
  }

  // ─── Reasoning ───

  /**
   * Resolve a human-friendly display name for a variant value.
   *
   * OpenCode models can expose variants with arbitrary keys. The key alone is
   * often opaque — e.g. a provider may expose reasoning levels as "1", "2",
   * "3" while the inner `reasoningEffort` field is the meaningful name
   * ("low"/"medium"/"high"). Prefer `reasoningEffort` when present, and fall
   * back to a capitalized variant key otherwise.
   */
  private resolveReasoningName(
    value: string,
    currentModel:
      | { variants?: Record<string, { reasoningEffort?: string }> }
      | null
      | undefined,
  ): string {
    const variant = currentModel?.variants?.[value];
    const effort = variant?.reasoningEffort;
    if (effort) {
      // Capitalize first letter for display (low → Low).
      return effort.charAt(0).toUpperCase() + effort.slice(1);
    }
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  /** Resolve the current model's variant record (or undefined if no model). */
  private getCurrentReasoningModel():
    | {
        reasoning?: boolean;
        variants?: Record<string, { reasoningEffort?: string }>;
      }
    | undefined {
    if (!this.currentModelId) return undefined;
    return this.availableModels.find((m) => m.modelId === this.currentModelId);
  }

  getCurrentReasoning(): string | undefined {
    return this.currentReasoning;
  }

  /**
   * Human-friendly display name for the current reasoning level, resolved
   * through the model's `reasoningEffort`. Falls back to the raw value.
   */
  getCurrentReasoningDisplay(): string {
    if (!this.currentReasoning) return "(not set)";
    return this.resolveReasoningName(this.currentReasoning, this.getCurrentReasoningModel());
  }

  getReasoningLevels(): Array<{ value: string; name: string; current: boolean }> {
    // Use the current model's variants to determine available reasoning levels
    const currentModel = this.getCurrentReasoningModel();

    if (!currentModel) return [];
    if (currentModel.reasoning === false) return [];

    const variants = currentModel.variants ?? {};
    const levels = Object.keys(variants).filter((k) => variants[k]?.reasoningEffort);

    return levels.map((v) => ({
      value: v,
      name: this.resolveReasoningName(v, currentModel),
      current: v === this.currentReasoning,
    }));
  }

  async setReasoning(level: string): Promise<void> {
    this.log(`Setting reasoning level to: ${level}`);
    const normalized = level.toLowerCase();

    // "default" is a sentinel meaning "let the server pick" — clear the
    // local value so the outgoing prompt omits `variant` entirely.
    // OpenCode Server treats literal "default" as a no-op variant, so we
    // must not pass it through.
    if (normalized === "default") {
      if (this.currentReasoning !== undefined) {
        this.log(`Reasoning reset to server default (was "${this.currentReasoning}")`);
      }
      this.currentReasoning = undefined;
      return;
    }

    // Validate against the current model's known variants. Accept either the
    // raw variant key or a matching reasoningEffort name (case-insensitive)
    // so users can type "low" / "high" instead of an opaque "1" / "2".
    const currentModel = this.getCurrentReasoningModel();
    const variants = currentModel?.variants;
    if (variants) {
      const known = Object.keys(variants).filter((k) => variants[k]?.reasoningEffort);
      const matchedByValue = known.find((k) => k.toLowerCase() === normalized);
      const matchedByEffort = known.find(
        (k) => variants[k]?.reasoningEffort?.toLowerCase() === normalized,
      );
      if (!matchedByValue && !matchedByEffort) {
        const available = known
          .map((k) => `${k} (${variants[k]?.reasoningEffort ?? ""})`)
          .join(", ");
        throw new Error(
          `Unknown reasoning level "${level}" for ${this.currentModelId ?? "current model"}. Available: ${available}`,
        );
      }
      this.currentReasoning = matchedByValue ?? level;
    } else {
      // No variants cached yet (e.g. before refreshProviders). Store verbatim
      // and let the next sync re-validate.
      this.currentReasoning = level;
    }
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

  /**
   * Fetch native OpenCode slash commands from the server.
   * Returns an empty array if the server is unreachable or returns an error.
   * Each entry's `description` is the first line, stripped of internal source
   * tags like "(builtin)" / "(user - Skill)".
   */
  async getAvailableCommands(): Promise<Array<{ name: string; description: string }>> {
    try {
      // Scope to the current workspace so project-defined slash commands
      // (from .opencode/command/ in the workspace) are included.
      const cmds = await this.client.listCommands(this.cwd);
      return cmds
        .filter((c) => c.name)
        .map((c) => ({ name: c.name, description: shortenCommandDescription(c.description) }));
    } catch (err) {
      this.log(`Failed to fetch commands: ${String(err)}`);
      return [];
    }
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
      // No messages yet — fall back to server config defaults. Scope to the
      // current workspace so the workspace's `model:` override in
      // opencode.json wins over the global default; without `directory` the
      // server returns the global config and the user sees a model they
      // didn't ask for in /status.
      const config = await this.client.getConfig(this.cwd);
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

  /**
   * List root (user-facing) sessions across all workspaces, most recent first.
   *
   * Subagent/sub-sessions — those spawned by the agent's `task` tool — are
   * filtered out because they have a `parentID` pointing to the primary
   * session that spawned them. They are internal to the agent workflow and
   * not user-interactable. To inspect a specific session by ID, use
   * `switchSession` directly.
   */
  async listServerSessions(): Promise<Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: number }>> {
    const sessions = await this.client.listSessionsV2(50);
    return sessions
      .filter((s) => !s.parentID)
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

  /**
   * Return the running server's version string (from /global/health), or null
   * if the server is unreachable or does not report a version. Used by the
   * `/version` and `/upgrade` commands.
   */
  async getServerVersion(): Promise<string | null> {
    try {
      const h = await this.client.health();
      return h.ok && h.version ? h.version : null;
    } catch {
      return null;
    }
  }

  // ─── MCP status (with short TTL cache) ───

  /**
   * Cached MCP server status for `/status`. Caches for 10s to avoid
   * hammering the server when a user spams /status; the network call is
   * cheap but the server may have to probe npx-downloaded MCPs on each
   * request, which can be slow. Pass `force: true` to bypass the cache
   * (e.g. right after a workspace switch where MCPs may reload).
   *
   * Cache is keyed by `this.cwd` so workspace switches naturally invalidate
   * stale entries — no need for an explicit invalidation hook.
   */
  async getMcpStatus(opts: { force?: boolean } = {}): Promise<McpStatusMap> {
    const TTL_MS = 10_000;
    const now = Date.now();
    if (
      !opts.force &&
      this.mcpStatusCache &&
      this.mcpStatusCache.cwd === this.cwd &&
      this.mcpStatusCache.expiresAt > now
    ) {
      return this.mcpStatusCache.value;
    }
    const value = await this.client.getMcpStatus(this.cwd);
    this.mcpStatusCache = { cwd: this.cwd, value, expiresAt: now + TTL_MS };
    return value;
  }
}
