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
import type { MessagePart, MediaContent, ContextUsage, SessionMode, ModelRef } from "../types.js";
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

  // ─── Event-driven turn accumulation (Phase 1 MVP) ───
  private useEventStream: boolean;
  private eventPipeline: EventPipeline | null = null;
  /** Currently-accumulating assistant turn. Null when no turn is active. */
  private currentTurn: AccumulatedTurn | null = null;
  /** Messages queued while a turn is busy with background tasks. */
  private pendingAssistant: QueueItem | null = null;
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
        try {
          await this.sendPromptAsync(item);
          // The reply will arrive via the event pipeline. continue to next item.
          // If a previous turn is still active, the new item is held in
          // `pendingAssistant` and dispatched when the prior turn finalizes.
          if (this.currentTurn) {
            this.pendingAssistant = item;
            this.log(`Turn busy; queued prompt for contextToken=${item.contextToken.slice(0, 8)}…`);
            return;
          }
          // start the turn tracking
          this.beginTurn(item);
          return;
        } catch (err) {
          // prompt_async may be unsupported on some server versions — fall back to sync
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
    this.log(`[event] Sending async prompt (mode=${this.currentMode ?? "default"}, model=${this.currentModelId ?? "default"})...`);
    await this.client.sendMessageAsync(this.sessionId!, item.parts, {
      agent: this.currentMode,
      model: modelRef,
      directory: this.cwd,
    });
  }

  /** Legacy synchronous prompt (single AssistantMessage response). */
  private async sendPromptSync(item: QueueItem): Promise<void> {
    this.sendTyping(item.contextToken).catch(() => {});

    const modelRef = this.currentModelId ? parseModelId(this.currentModelId) : undefined;
    this.log(`Sending prompt to agent (sync, mode=${this.currentMode ?? "default"}, model=${this.currentModelId ?? "default"})...`);

    try {
      const response = await this.client.sendMessage(
        this.sessionId!,
        item.parts,
        { agent: this.currentMode, model: modelRef, directory: this.cwd },
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
    this.eventPipeline = new EventPipeline({
      url,
      directory,
      log: this.log,
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
      // Now that we know the assistant's message ID, flush any text parts
      // that were buffered while waiting. User-input parts (different
      // messageID) are dropped inside maybeSendTextPart.
      this.flushPendingTextParts(turn);
    } else if (info.role === "user") {
      // Critical: a `message.updated role=user` event is the SERVER's echo
      // of the user message that triggered this turn (delivered via SSE
      // after `prompt_async` returns). It can also be RE-DELIVERED if the
      // SSE stream reconnects and replays history with Last-Event-ID. We
      // must NOT treat it as a new user message / interrupt.
      //
      // Strategy:
      //   - First user message echo after beginTurn: capture its ID as
      //     `turn.userMessageId`.
      //   - Subsequent echoes with the same ID: ignore.
      //   - A user message with a DIFFERENT ID: this is a real new user
      //     message sent while the previous turn was still running.
      //     Interrupt the current turn.
      if (turn.userMessageId === null) {
        turn.userMessageId = info.id;
        this.log(`[event] captured trigger userMessageId=${info.id.slice(0, 8)}…`);
      } else if (turn.userMessageId === info.id) {
        this.log(`[event] ignored re-delivered user message ${info.id.slice(0, 8)}…`);
      } else {
        this.log(`[turn] interrupted by new user message ${info.id.slice(0, 8)}… (was tracking ${turn.userMessageId.slice(0, 8)}…)`);
        this.finalizeTurn("interrupted");
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

    // If a prompt was queued while the prior turn was busy, dispatch it now.
    if (this.pendingAssistant) {
      const pending = this.pendingAssistant;
      this.pendingAssistant = null;
      // Use a microtask to break the call stack
      queueMicrotask(() => {
        this.enqueue(pending.parts, pending.contextToken, pending.hint).catch((err) => {
          this.log(`Failed to dispatch pending prompt: ${String(err)}`);
        });
      });
    }
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
   * Priority:
   *   1. The contextToken of the most recently enqueued message
   *      (`pendingAssistant`) — if the user sent a new message while the
   *      prior turn was busy.
   *   2. The most recent contextToken from any enqueue() call
   *      (`lastEnqueuedContextToken`) — used when no new enqueue happened
   *      and the agent is producing a follow-up response (sub-agent case).
   *   3. Empty string — the reply will be skipped.
   */
  private currentContextToken(): string {
    return this.pendingAssistant?.contextToken ?? this.lastEnqueuedContextToken ?? "";
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
    this.pendingAssistant = null;
    // Finalize any in-flight turn as interrupted
    if (this.currentTurn) {
      this.finalizeTurn("interrupted");
    }
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

  /**
   * Fetch native OpenCode slash commands from the server.
   * Returns an empty array if the server is unreachable or returns an error.
   * Each entry's `description` is the first line, stripped of internal source
   * tags like "(builtin)" / "(user - Skill)".
   */
  async getAvailableCommands(): Promise<Array<{ name: string; description: string }>> {
    try {
      const cmds = await this.client.listCommands();
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
}
