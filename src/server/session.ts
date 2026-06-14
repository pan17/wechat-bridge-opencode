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
import {
  formatDuration,
  formatThoughtHeader,
  reasoningSummary,
} from "../adapter/thinking-format.js";

/**
 * Hard cap on the full `🔧 Tools:` summary sent to WeChat. Each per-tool
 * line is bounded separately (title truncated to 80 chars), but a turn
 * with many tools could still produce a wall of text. This is a
 * defense-in-depth cap to keep the WeChat 10-message budget healthy.
 */
const MAX_TOOL_SUMMARY_LEN = 1500;
import type { MessagePart, MediaContent, ContextUsage, SessionMode, ModelRef, McpStatusMap } from "../types.js";
import type {
  AccumulatedTurn,
  MessagePartDeltaEvent,
  MessagePartUpdatedEvent,
  MessageUpdatedEvent,
  OpenCodeEvent,
  Part,
  QuestionAskedEvent,
  QuestionRepliedSseEvent,
  QuestionRejectedSseEvent,
  ReasoningPart,
  SessionErrorEvent,
  SessionStatusEvent,
  TextPart,
  ToolPart,
  TrackedTool,
} from "../types/events.js";
import type {
  PendingQuestion,
  QuestionPrompt,
  QuestionRequest,
} from "../types/question.js";

/** Idle debounce: wait this long after the last delta before considering the turn final. */
const TURN_FINALIZE_DEBOUNCE_MS = 500;
/** Hard ceiling: if no event for this long, force-finalize the turn. */
const TURN_STUCK_TIMEOUT_MS = 5 * 60_000;
/**
 * Soft timeout for unanswered `question.asked` events. After this many ms
 * with no user reply, SessionManager auto-rejects the question (POST
 * /question/:id/reject) and notifies the bridge so the user sees a
 * "timed out" message. The agent's Deferred is woken with a
 * `QuestionRejectedError: "The user dismissed this question"`.
 *
 * 30 minutes is a heuristic covering "user stepped away for lunch" while
 * still preventing the agent from blocking forever. See
 * `.omo/plans/question-tool-design.md` §14 Q1.
 */
const QUESTION_TIMEOUT_MS = 30 * 60_000;

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
  /**
   * Invoked when a `question.asked` event arrives and the question is
   * queued for the WeChat user. The bridge should format the question
   * (via `formatQuestionForWeChat`) and push it to WeChat. Must be
   * non-throwing — errors are caught and logged.
   *
   * Receives the WeChat contextToken (so the bridge can route to the
   * right chat), the questions array, and the opencode requestID (so
   * the bridge can reference it in `/status` or for debugging).
   */
  onQuestionAsked?: (
    contextToken: string,
    questions: ReadonlyArray<QuestionPrompt>,
    requestID: string,
  ) => Promise<void>;
  /**
   * Invoked when the soft-timeout fires (30 min with no user reply).
   * The bridge should send a user-visible "timed out" message to WeChat
   * before the auto-reject lands on the server. The contextToken is the
   * WeChat target.
   */
  onQuestionTimedOut?: (contextToken: string) => Promise<void>;
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

  // ─── Question slot (orthogonal to currentTurn) ───
  /**
   * Soft timeout handle for the currently-pending question. Cleared when
   * the user answers, the user rejects, the server-side `question.replied`
   * / `question.rejected` echo arrives, or the bridge shuts down.
   */
  private questionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /**
   * Currently-pending question waiting for the WeChat user's answer. Null
   * when no question is awaiting input. State is independent of
   * `currentTurn` — a question can be pending while the turn is also
   * accumulating (the agent is blocked on the question tool's Deferred).
   */
  private pendingQuestion: PendingQuestion | null = null;
  /** Callbacks set by the bridge; see SessionManagerOpts.onQuestion*. */
  private onQuestionAsked?: (
    contextToken: string,
    questions: ReadonlyArray<QuestionPrompt>,
    requestID: string,
  ) => Promise<void>;
  private onQuestionTimedOut?: (contextToken: string) => Promise<void>;

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
    this.onQuestionAsked = opts.onQuestionAsked;
    this.onQuestionTimedOut = opts.onQuestionTimedOut;
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
    this.clearQuestionTimeout();
  }

  // ─── Question slot API ───
  //
  // Independent of the turn state machine — a `question.asked` event
  // arrives while a turn is actively accumulating (the agent is blocked
  // on the question tool's Deferred.await). We don't finalize the turn;
  // we just record that we're waiting for the user's answer. When the
  // answer lands, the tool part is updated to `completed` and the turn
  // continues normally.

  /** True iff a question is currently waiting for the user's answer. */
  hasPendingQuestion(): boolean {
    return this.pendingQuestion !== null;
  }

  /** Read-only view of the current pending question, or null. */
  getPendingQuestion(): PendingQuestion | null {
    return this.pendingQuestion;
  }

  /**
   * Submit the user's answers to a pending question. POSTs to
   * `/question/:id/reply` with the answer array. Resolves once the HTTP
   * call returns (does NOT wait for the SSE `question.replied` echo —
   * that echo will redundantly call `clearPendingQuestion` which is
   * idempotent).
   *
   * Throws on HTTP failure; the bridge should catch and surface a
   * "question 已过期" message to the user.
   */
  async answerPendingQuestion(
    answers: ReadonlyArray<ReadonlyArray<string>>,
  ): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending) {
      this.log(`[question] answerPendingQuestion called with no pending question (no-op)`);
      return;
    }
    try {
      await this.client.replyToQuestion(pending.requestID, answers, this.cwd);
      this.log(`[question] answered id=${pending.requestID} (${answers.length} answer(s))`);
    } finally {
      this.clearPendingQuestion(pending.requestID, "replied");
    }
  }

  /**
   * Dismiss a pending question (user said /reject-question, /stop,
   * /next, /restart, or the 30-min soft timeout fired). POSTs to
   * `/question/:id/reject`. No-op if no question is pending.
   *
   * Returns once the HTTP call resolves. Errors are logged but NOT
   * rethrown — reject is best-effort (the user already moved on, and
   * the server's instance dispose finalizer will clean up stragglers).
   */
  async rejectPendingQuestion(): Promise<void> {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.log(`[question] rejecting id=${pending.requestID}`);
    this.clearPendingQuestion(pending.requestID, "rejected");
    try {
      await this.client.rejectQuestion(pending.requestID, this.cwd);
    } catch (err) {
      this.log(`[question] reject HTTP failed (non-fatal): ${String(err)}`);
    }
  }

  /**
   * At bridge startup, return questions the server has pending for OUR
   * session that we don't have a local slot for. These are the
   * "leaked" questions from a previous bridge instance — they will
   * never be answered (the user already moved on, or the bridge
   * crashed mid-question), so the bridge rejects them proactively.
   *
   * Returns an empty array on any error (network, parse, missing
   * session) so the startup path is non-blocking. Filtering:
   *   - Only questions belonging to OUR sessionID (don't touch others')
   *   - Exclude any requestID we still have a local slot for (race-safe)
   */
  async listLeakedQuestions(directory?: string): Promise<QuestionRequest[]> {
    if (!this.sessionId) return [];
    try {
      const all = await this.client.listQuestions(directory);
      const localId = this.pendingQuestion?.requestID;
      return all.filter((q) => {
        if (q.sessionID !== this.sessionId) return false;
        if (localId && q.id === localId) return false;
        return true;
      });
    } catch (err) {
      this.log(`[question-startup] listQuestions failed (non-fatal): ${String(err)}`);
      return [];
    }
  }

  // ─── Question slot internals ───

  private setPendingQuestion(req: QuestionRequest, contextToken: string): void {
    this.pendingQuestion = {
      requestID: req.id,
      questions: req.questions,
      contextToken,
      askedAt: Date.now(),
      tool: req.tool,
    };
    this.armQuestionTimeout();
  }

  /**
   * Clear the local pending slot. Idempotent: a no-op if the local slot
   * is null OR if the local requestID doesn't match (means the server
   * cleared a different question, possibly from a prior bridge instance
   * whose leaked-question cleanup we triggered). The second case is
   * important to avoid dropping the *current* local question when an
   * old SSE echo arrives.
   */
  private clearPendingQuestion(requestID: string, reason: "replied" | "rejected"): void {
    if (!this.pendingQuestion) return;
    if (this.pendingQuestion.requestID !== requestID) {
      this.log(
        `[question] clearPendingQuestion(${reason}) for id=${requestID.slice(0, 12)}… ` +
          `ignored — local is id=${this.pendingQuestion.requestID.slice(0, 12)}…`,
      );
      return;
    }
    this.log(`[question] slot cleared (${reason}) id=${requestID.slice(0, 12)}…`);
    this.pendingQuestion = null;
    this.clearQuestionTimeout();
  }

  private armQuestionTimeout(): void {
    this.clearQuestionTimeout();
    this.questionTimeoutHandle = setTimeout(() => {
      const pending = this.pendingQuestion;
      if (!pending) return;
      this.log(`[question] soft timeout (${QUESTION_TIMEOUT_MS}ms) — auto-rejecting id=${pending.requestID}`);
      this.onQuestionTimedOut?.(pending.contextToken).catch((err) => {
        this.log(`[question] onQuestionTimedOut callback error: ${String(err)}`);
      });
      this.rejectPendingQuestion().catch((err) => {
        this.log(`[question] auto-reject HTTP failed: ${String(err)}`);
      });
    }, QUESTION_TIMEOUT_MS);
  }

  private clearQuestionTimeout(): void {
    if (this.questionTimeoutHandle) {
      clearTimeout(this.questionTimeoutHandle);
      this.questionTimeoutHandle = null;
    }
  }

  // ─── Question SSE handlers ───

  private handleQuestionAsked(event: QuestionAskedEvent): void {
    const req = event.properties;
    if (this.pendingQuestion) {
      // Defensive: the previous question should have been cleared by
      // either the user's reply, the timeout, or the SSE echo. If we
      // somehow get a second `question.asked` for a different id
      // before clearing, drop the new one — the agent shouldn't be
      // asking two questions in parallel from the same session.
      this.log(
        `[question] dropping new asked id=${req.id.slice(0, 12)}… — ` +
          `previous unanswered id=${this.pendingQuestion.requestID.slice(0, 12)}…`,
      );
      return;
    }
    // We MUST have a contextToken to route the formatted question to
    // the right WeChat chat. If we don't (first message of a fresh
    // session is a question — rare), auto-reject so the agent doesn't
    // block forever waiting for a reply no one will see.
    const contextToken = this.lastEnqueuedContextToken;
    if (!contextToken) {
      this.log(`[question] no contextToken for asked id=${req.id.slice(0, 12)}…; auto-rejecting`);
      this.client.rejectQuestion(req.id, this.cwd).catch((err) => {
        this.log(`[question] auto-reject failed: ${String(err)}`);
      });
      return;
    }
    this.setPendingQuestion(req, contextToken);
    this.log(`[question] asked id=${req.id.slice(0, 12)}… (${req.questions.length} question(s))`);
    this.onQuestionAsked?.(contextToken, req.questions, req.id).catch((err) => {
      this.log(`[question] onQuestionAsked callback error: ${String(err)}`);
    });
  }

  private handleQuestionRepliedSse(event: QuestionRepliedSseEvent): void {
    this.clearPendingQuestion(event.properties.requestID, "replied");
  }

  private handleQuestionRejectedSse(event: QuestionRejectedSseEvent): void {
    this.clearPendingQuestion(event.properties.requestID, "rejected");
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
      case "question.asked":
        this.handleQuestionAsked(event as QuestionAskedEvent);
        break;
      case "question.replied":
        this.handleQuestionRepliedSse(event as QuestionRepliedSseEvent);
        break;
      case "question.rejected":
        this.handleQuestionRejectedSse(event as QuestionRejectedSseEvent);
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
      // Reasoning parts that arrived before assistantMessageId was known
      // (see `flushPendingReasoningParts`). Mirrors the text-part buffer:
      // both are flushed once the assistant's message ID is known, and
      // parts whose `messageID` doesn't match the assistant are dropped.
      pendingReasoningParts: [],
      // Snapshot the display flags at turn-start. Mid-turn toggles via
      // `setShowFlags` intentionally do NOT update `showThoughtsSnapshot` /
      // `showToolsSnapshot` — see the JSDoc on `setShowFlags` below for the
      // rationale. Consumers read these via `getShowFlagsForTurn`.
      showThoughtsSnapshot: this.showThoughts,
      showToolsSnapshot: this.showTools,
      // Reasoning accumulation starts empty. Task 6's `handleReasoningPart`
      // mutates `reasoningCharCount`, `reasoningStartMs`, `reasoningEndMs`,
      // and `sentReasoningPartIds` as reasoning parts arrive. The dedup set
      // is fresh per turn so a new turn never inherits stale partIDs.
      reasoningCharCount: 0,
      reasoningStartMs: null,
      reasoningEndMs: null,
      sentReasoningPartIds: new Set<string>(),
      // Type-change-based flushing state. See the JSDoc on
      // `AccumulatedTurn.currentPartType` for the rule. All six fields
      // reset to their "empty" defaults at turn-start; populated lazily
      // as the first part of each type arrives during the turn.
      currentPartType: null,
      currentPartID: null,
      currentReasoningText: "",
      currentReasoningStartMs: null,
      currentReasoningEndMs: null,
      currentText: "",
      currentToolKey: null,
      // Tool summary state. `toolCallIdsInLastSummary` is the set of
      // tool `callID`s already included in a previously-emitted
      // summary. Fresh per turn so a new turn never inherits
      // stale callIDs. See `maybeFlushToolSummary` for the
      // consecutive-vs-separate logic.
      toolCallIdsInLastSummary: new Set<string>(),
      // Per-reasoning-part streaming timestamps. Populated by
      // `accumulateReasoningDelta`, read by `handleReasoningPart`.
      reasoningPartTimestamps: new Map(),
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
      // Non-text deltas (e.g. step-start, step-finish, snapshot) — ignored.
      // NOTE: reasoning deltas ALSO use `field: "text"` (verified against the
      // opencode server's `processor.ts:411-417` — it emits `field: "text"`
      // for both text and reasoning parts because reasoning parts carry
      // their content in the `.text` field just like TextPart does). We
      // therefore route by part type (looked up in `turn.parts`) below,
      // NOT by the `field` string. If the part is unknown at this point
      // we fall back to treating it as a text part to preserve backward
      // compatibility — the first delta for a brand-new reasoning part
      // will still arrive before any `part.updated` event, and the
      // definitive re-delivery as a complete `part.updated` is handled
      // in `handleReasoningPart`.
      return;
    }

    // Route by part type. Both `text` and `reasoning` parts use
    // `field: "text"` in their delta events; the discriminator is the
    // `type` on the corresponding Part object.
    const knownPart: Part | undefined = turn.parts.get(event.properties.partID);
    if (knownPart && knownPart.type === "reasoning") {
      this.accumulateReasoningDelta(turn, knownPart, event.properties.delta);
      this.armFinalizeDebounce();
      return;
    }

    // Identify which part this delta belongs to. If we don't yet have the
    // part, create a stub TextPart.
    let part: Part = knownPart ?? ({
      id: event.properties.partID,
      sessionID: event.properties.sessionID,
      messageID: event.properties.messageID,
      type: "text",
      text: "",
    } as Part);
    if (part.type !== "text") {
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
    // Per-current-phase accumulation: append deltas to `currentText`
    // only when this delta is for the CURRENT text part. Out-of-order
    // deltas for a different text part (rare; only happens if the
    // model emits two text parts in a row without a non-text part
    // between) are silently skipped — the new part's text was already
    // initialised to the FULL text by `handlePartUpdated`, so we don't
    // need to re-append.
    if (turn.currentPartType === "text" && turn.currentPartID === event.properties.partID) {
      turn.currentText += event.properties.delta;
    }

    if (turn.assistantMessageId === null) {
      turn.assistantMessageId = event.properties.messageID;
    }

    this.log(`[event] delta partID=${event.properties.partID.slice(0, 8)}… +${event.properties.delta.length}ch`);
    this.armFinalizeDebounce();
  }

  /**
   * Accumulate a streaming reasoning delta into the turn's off-mode
   * metrics. Called from `handlePartDelta` once the target part has been
   * resolved as a `ReasoningPart` (either by a prior `part.updated` event
   * or by direct lookup). The reasoning content is NEVER forwarded to
   * WeChat from this path — only the per-turn metrics are updated.
   * Display of reasoning content is driven by the `part.updated` event
   * delivered to `handleReasoningPart`, which sees the full text in one
   * go and decides whether to send it (showThoughts on) or only log a
   * summary (off).
   *
   * Dedup note: `sentReasoningPartIds` is intentionally NOT consulted
   * here. The dedup set exists to prevent duplicate `onReply` calls
   * when the *same* reasoning part is re-delivered (e.g. on SSE
   * reconnect). Streaming deltas for the same partID belong to the
   * SAME part, so they should all contribute to the off-mode char
   * count. The first delta also sets `reasoningStartMs` (only if null)
   * and every delta updates `reasoningEndMs`.
   */
  private accumulateReasoningDelta(turn: AccumulatedTurn, part: Part, delta: string): void {
    if (!delta) return;
    const now = Date.now();
    (part as { text: string }).text += delta;
    turn.reasoningCharCount += delta.length;
    // Turn-level cumulative timestamps (for the off-mode log line).
    if (turn.reasoningStartMs === null) {
      turn.reasoningStartMs = now;
    }
    turn.reasoningEndMs = now;
    // Per-current-phase timestamps (for the on-mode WeChat header under
    // the type-change-flushing design). Mirror the per-part timestamps
    // below, but only mutate when this delta is for the CURRENT R phase
    // (i.e. `currentPartID === part.id`). Out-of-order deltas for a
    // different R part (which can happen if the model emits R1, R2, R3
    // in a row and deltas arrive interleaved across partIDs) are
    // silently skipped here — the `currentReasoningText` was already
    // initialised to the FULL text of the new R by `handlePartUpdated`,
    // so we don't need to append again.
    if (turn.currentPartType === "reasoning" && turn.currentPartID === part.id) {
      if (turn.currentReasoningStartMs === null) {
        turn.currentReasoningStartMs = now;
      }
      turn.currentReasoningEndMs = now;
    }
    // Per-part streaming timestamps (for the on-mode WeChat header).
    // `startMs` is set on the first delta for this part; `endMs` is
    // updated to every subsequent delta so the final value is the
    // timestamp of the last delta before the `message.part.updated`
    // event delivers the full text. This gives a per-part duration
    // that does NOT include the time spent on tool calls between
    // reasoning parts — which is what the user expects to see in
    // the WeChat `🧠 Thought · … · {duration}` line.
    const partTimestamps = turn.reasoningPartTimestamps.get(part.id);
    if (partTimestamps) {
      partTimestamps.endMs = now;
    } else {
      turn.reasoningPartTimestamps.set(part.id, { startMs: now, endMs: now });
    }
    this.log(`[event] reasoning-delta partID=${part.id.slice(0, 8)}… +${delta.length}ch`);
  }

  private handlePartUpdated(event: MessagePartUpdatedEvent): void {
    const turn = this.ensureTurnForEvent();
    if (!turn) return;
    turn.lastEventAt = Date.now();

    const part = event.properties.part;
    turn.parts.set(part.id, part);

    // ─── Type-change-based flushing ────────────────────────────────
    // If a different part type just arrived, the previously-accumulated
    // "current" part is done — build and send its WeChat message before
    // letting the new type take over as `current`. Same-type consecutive
    // parts (R1 → R2, text1 → text2) merge into the current state per
    // the user-spec ("merge to current") and do NOT trigger a flush.
    //
    // When `currentPartType` is `null` (start of turn, or right after a
    // flush), this is a no-op — the new type just becomes the new current.
    if (turn.currentPartType !== null && part.type !== turn.currentPartType) {
      this.flushCurrentPart(turn);
    }

    // The new part becomes the new current. Type-specific handlers
    // below ONLY update state (currentReasoningText / currentText /
    // toolCalls); they no longer send messages or flush tool summaries.
    // Sending is the sole job of `flushCurrentPart` (called above or by
    // `finalizeTurn` at the end of the turn).
    //
    // `currentPartType` only tracks the three WeChat-message-eligible
    // types (R / tool / text). Other part types — `file`, `step-start`,
    // `step-finish`, `snapshot` — don't produce WeChat messages on
    // their own and don't interrupt an accumulating current part.
    // If a non-message part arrives mid-R (e.g. step-start during
    // streaming), the current R continues accumulating; only when a
    // different MESSAGE type arrives do we flush. This keeps multi-step
    // streams clean.
    if (part.type === "reasoning" || part.type === "tool" || part.type === "text") {
      turn.currentPartType = part.type;
    } else {
      // Non-message part arrived — leave currentPartType unchanged so
      // the in-flight R/text keeps accumulating through it.
      turn.currentPartType = turn.currentPartType;
    }
    turn.currentPartID = part.id;

    // Safe-default initialization: the type-specific handler below may
    // early-return (empty text, dedup, buffer, no messageID, no
    // contextToken, etc.) without populating the type-specific state
    // fields. If we don't pre-set them, a later type-change flush will
    // crash (e.g. `turn.currentReasoningText.trim()` on undefined).
    // The handler will overwrite with the real values when it proceeds.
    if (part.type === "reasoning") {
      turn.currentReasoningText = "";
      turn.currentReasoningStartMs = null;
      turn.currentReasoningEndMs = null;
    } else if (part.type === "text") {
      turn.currentText = "";
    }

    if (part.type === "text") {
      // ─── Text part: buffer / dedup / state-update ─────────────────
      // NOTE: We must NOT set `turn.assistantMessageId` from `part.messageID`
      // here — the server replays user-input text parts (same `type: "text"`)
      // on `prompt_async`, and we mustn't mistake them for the assistant's
      // reply. `assistantMessageId` is set exclusively in
      // `handleMessageUpdated` on `info.role === "assistant"`. Until then,
      // text parts are buffered; once known, the buffer is replayed via
      // `flushPendingTextParts`.

      // Dedup: SSE replay can re-deliver the same text part; skip if
      // already flushed by a previous event.
      if (turn.sentTextPartIds.has(part.id)) return;
      // Buffer until we know the assistant's message ID.
      if (turn.assistantMessageId === null) {
        turn.pendingTextParts.push(part);
        this.log(`[text-part] buffering part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}…) until assistantMessageId is known`);
        return;
      }
      // Drop user-input parts (different messageID).
      if (part.messageID !== turn.assistantMessageId) {
        this.log(`[text-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${turn.assistantMessageId.slice(0, 8)}…)`);
        return;
      }
      if (!turn.contextToken) {
        this.log(`[text-part] no contextToken for part ${part.id.slice(0, 8)}…; dropping`);
        return;
      }
      // Update current state. Subsequent deltas for the same partID
      // will be appended by `handlePartDelta`. The text is sent at
      // the next type change (or at finalize) by `flushCurrentPart`.
      turn.currentText = (part as TextPart).text ?? "";
      // Mirror the legacy `finalText` field so the off-mode fallback
      // path in `finalizeTurn` still works.
      turn.finalText = (part as TextPart).text ?? "";
    } else if (part.type === "tool") {
      // Update the tool's tracked state (callID → TrackedTool). The
      // tool summary itself is emitted at the next type change (or at
      // finalize) by `flushCurrentPart` → `maybeFlushToolSummary`,
      // which naturally combines consecutive tools that share the
      // same current-phase.
      this.trackTool(turn, part);
      turn.currentToolKey = (part as ToolPart).callID;
    } else if (part.type === "file") {
      // Could be sent via onMediaReply in Phase 2.
      this.log(`[event] file part: ${part.filename ?? part.url}`);
    } else if (part.type === "reasoning") {
      // ─── Reasoning part: buffer / dedup / state-update ───────────
      // Dedup: same R part may be re-delivered on SSE replay; skip if
      // already sent.
      if (turn.sentReasoningPartIds.has(part.id)) {
        this.log(`[reasoning-part] dropping duplicate part ${part.id.slice(0, 8)}… (already sent)`);
        return;
      }
      // Empty/whitespace-only reasoning → skip (no header, no metrics).
      const partText = (part as ReasoningPart).text ?? "";
      if (!partText.trim()) return;
      // Buffer until we know the assistant's message ID.
      if (turn.assistantMessageId === null) {
        turn.pendingReasoningParts.push(part);
        this.log(`[reasoning-part] buffering part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}…) until assistantMessageId is known`);
        return;
      }
      // Drop user-input reasoning parts (different messageID).
      if (part.messageID !== turn.assistantMessageId) {
        this.log(`[reasoning-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${turn.assistantMessageId.slice(0, 8)}…)`);
        return;
      }
      if (!turn.contextToken) {
        this.log(`[reasoning-part] no contextToken for part ${part.id.slice(0, 8)}…; dropping`);
        return;
      }
      // Update current state. Subsequent deltas (via
      // `accumulateReasoningDelta`) will append to `currentReasoningText`
      // and update timestamps. The thought line is emitted at the next
      // type change (or at finalize) by `flushCurrentPart`.
      turn.currentReasoningText = partText;
      turn.currentReasoningStartMs = turn.reasoningPartTimestamps.get(part.id)?.startMs ?? null;
      turn.currentReasoningEndMs = turn.reasoningPartTimestamps.get(part.id)?.endMs ?? null;
    }

    this.log(`[event] part.updated type=${part.type} partID=${part.id.slice(0, 8)}…`);
    this.armFinalizeDebounce();
  }

  /**
   * Build and emit the WeChat message for the part currently being
   * accumulated on `turn`, then reset the current-state fields so the
   * next `handlePartUpdated` starts fresh for the new type.
   *
   * This is the SOLE place a WeChat message is dispatched under the
   * type-change-flushing design. The old "boundary flush" pattern
   * (where `dispatchReasoningPart` and `maybeSendTextPart` each called
   * `maybeFlushToolSummary` BEFORE sending) is gone — flushing now
   * happens at the START of a new type, not at the END of the old
   * one. The two patterns produce the same WeChat order in the common
   * case; the new one is robust to opencode's specific SSE ordering
   * (text-end can arrive AFTER tool-input-start, which used to flip
   * the order to "tool before text").
   *
   * Called from three places:
   *   1. `handlePartUpdated` when `part.type !== turn.currentPartType`
   *      (new part of a different type just arrived)
   *   2. `finalizeTurn` at the very end of the turn (so the LAST
   *      accumulated part of the turn still gets a WeChat line, even
   *      if the stream just ended on a non-flushing event)
   *   3. (Implicitly via `maybeFlushToolSummary` for the tool case —
   *      we call THAT instead of building a tool summary here, because
   *      tool summaries need to combine consecutive tools per
   *      `toolCallIdsInLastSummary` semantics.)
   */
  private flushCurrentPart(turn: AccumulatedTurn): void {
    if (!turn.currentPartType || !turn.currentPartID) {
      // Nothing to flush (start of turn, or already flushed).
      return;
    }
    if (!turn.contextToken) {
      this.log(`[flush] no contextToken for current part; dropping`);
      this.resetCurrentPart(turn);
      return;
    }

    const partID = turn.currentPartID;
    const partType = turn.currentPartType;

    try {
      switch (partType) {
        case "reasoning": {
          // Skip if this R has already been sent (e.g. via the legacy
          // path during incremental migration, or via dedup on SSE
          // replay). `sentReasoningPartIds` is the dedup set.
          if (turn.sentReasoningPartIds.has(partID)) break;
          if (!turn.currentReasoningText.trim()) break;

          const now = Date.now();
          const startMs = turn.currentReasoningStartMs ?? now;
          const endMs = turn.currentReasoningEndMs ?? now;
          const durationMs = Math.max(0, endMs - startMs);

          const { summary } = reasoningSummary(turn.currentReasoningText);
          const line = formatThoughtHeader(durationMs, summary);

          turn.sentReasoningPartIds.add(partID);
          this.log(
            `[reasoning-part] sending summary (${turn.currentReasoningText.length}ch, summary="${summary.length > 30 ? summary.slice(0, 30) + "…" : summary}", ${formatDuration(durationMs)})`
          );
          this.onReply(turn.contextToken, line).catch((err) => {
            this.log(`onReply error for reasoning summary: ${String(err)}`);
          });
          break;
        }
        case "tool": {
          // The tool case defers to the existing `maybeFlushToolSummary`
          // because tool summaries must combine consecutive tools that
          // share the same current-phase (user-stated rule:
          // consecutive = combined, separate = individual). The
          // current tool's callID is in `turn.toolCalls` (tracked by
          // `trackTool` in `handlePartUpdated`); the dedup set
          // `toolCallIdsInLastSummary` tracks which ones have already
          // been emitted. So we just call the existing flusher.
          this.maybeFlushToolSummary(turn);
          break;
        }
        case "text": {
          // Skip if this text has already been sent (dedup on SSE replay
          // or legacy path).
          if (turn.sentTextPartIds.has(partID)) break;
          if (!turn.currentText.trim()) break;

          turn.sentTextPartIds.add(partID);
          this.log(`[text-part] sending part ${partID.slice(0, 8)}… (${turn.currentText.length}ch)`);
          this.onReply(turn.contextToken, turn.currentText).catch((err) => {
            this.log(`onReply error for text part: ${String(err)}`);
          });
          break;
        }
      }
    } finally {
      // Always reset, even if the send threw — otherwise the next
      // `handlePartUpdated` would see a stale `currentPartType` and
      // think a flush is needed when there isn't.
      this.resetCurrentPart(turn);
    }
  }

  /**
   * Clear the type-change-flushing state. Called after every flush and
   * at the end of a turn. Idempotent — safe to call multiple times.
   */
  private resetCurrentPart(turn: AccumulatedTurn): void {
    turn.currentPartType = null;
    turn.currentPartID = null;
    turn.currentReasoningText = "";
    turn.currentReasoningStartMs = null;
    turn.currentReasoningEndMs = null;
    turn.currentText = "";
    turn.currentToolKey = null;
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
   *
   * Tool summary ordering: just before the FIRST assistant text part
   * actually reaches WeChat, we flush the `🔧 Tools: …` summary (if
   * `showToolsSnapshot` is on AND any tools were called AND it has not
   * been sent yet). This puts the tool summary BEFORE the final text
   * reply in WeChat, matching the chronological order of events — the
   * model called tools first, then wrote the final text. The guard on
   * `turn.toolSummarySent` ensures the summary is emitted exactly once
   * even if the turn has many text parts; if the turn has tools but no
   * text at all, `finalizeTurn` flushes the summary as a fallback.
   *
   * `skipToolFlush` is `true` when called from `flushPendingTextParts`
   * — the text part was buffered because `assistantMessageId` was not
   * yet known at arrival time, so tools that were tracked AFTER the
   * buffer would be flushed here, putting the tool summary in front of
   * a text part that, in the model's natural output order, came before
   * those tools. Skipping the flush preserves the original chronology:
   * the text part is sent, and any tools tracked after the buffer will
   * be flushed at the next natural non-tool boundary (the next
   * reasoning or text part that arrives live, not via buffer flush).
   */
  private maybeSendTextPart(turn: AccumulatedTurn, part: Part, skipToolFlush = false): void {
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

    // Pass-through: emit the tool summary right BEFORE the text part
    // if any tools have been called and the summary hasn't been
    // emitted yet. This puts the summary at the position where the
    // model switched from "tools" to "final text reply" — the
    // chronological boundary in the model's output stream.
    //
    // Skip the flush when replaying a buffered text part: the part
    // was buffered because `assistantMessageId` wasn't known yet, and
    // any tools tracked between the buffer and the flush would
    // otherwise be inserted in front of a text that, in the model's
    // natural output, came BEFORE them. Letting them stay tracked and
    // flushing at the next live non-tool boundary preserves the
    // original chronological order.
    if (!skipToolFlush) {
      this.maybeFlushToolSummary(turn);
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
   * `info.role === "assistant"` arrives, and from `finalizeTurn` as a
   * last-chance flush.
   *
   * Each buffered part is replayed with `skipToolFlush=true` so the
   * tool-summary flush does NOT run here — see the JSDoc on
   * `maybeSendTextPart` for the chronology-preservation rationale.
   */
  private flushPendingTextParts(turn: AccumulatedTurn): void {
    if (turn.pendingTextParts.length === 0) return;
    const pending = turn.pendingTextParts;
    turn.pendingTextParts = [];
    // Capture in a local so TS narrows the type to `string` (the caller
    // — `handleMessageUpdated` — has already null-checked, but TS can't
    // see that across the function boundary into this loop).
    const assistantMsgId = turn.assistantMessageId;
    if (!assistantMsgId) {
      // Defensive: if assistantMessageId was cleared between buffering
      // and flush (shouldn't happen, but guard anyway), drop everything.
      this.log(`[text-part] assistantMessageId became null between buffering and flush; dropping ${pending.length} part(s)`);
      return;
    }
    for (const part of pending) {
      // Drop user-input parts (different messageID).
      if (part.messageID !== assistantMsgId) {
        this.log(`[text-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${assistantMsgId.slice(0, 8)}…)`);
        continue;
      }
      // We set state DIRECTLY here rather than re-dispatching through
      // `handlePartUpdated`. The buffered part is OLDER in the model
      // stream than the current (e.g. text "OK" arrived first but was
      // buffered, then tool webfetch was tracked, then the messageID
      // arrived). If we re-dispatched, the type-change check in
      // `handlePartUpdated` would flush the current (the tool) before
      // the buffered text — putting the tool BEFORE the text in
      // WeChat output, which violates the natural-order rule (the
      // text came first in the stream).
      //
      // Instead, the buffered part BECOMES the new current. The
      // existing current (tool/reasoning/whatever is "later" in the
      // stream) is left in place — it'll be flushed at the next
      // non-{old-type} event. If the turn ends here with no next
      // event, the existing current simply stays in toolCalls /
      // tracking; the user will see it summarized in a later turn's
      // boundary flush, or not at all (acceptable for the buffering
      // race edge case — the next turn will re-emit it from the
      // server's own SSE stream anyway).
      turn.currentPartType = "text";
      turn.currentPartID = part.id;
      turn.currentText = (part as TextPart).text ?? "";
      turn.finalText = (part as TextPart).text ?? "";
    }
  }

  /**
   * Handle a finalized reasoning part delivered via `message.part.updated`.
   *
   * Mirrors the structure of `maybeSendTextPart` (dedup + assistantMessageId
   * filter + contextToken guard) but routes by the `showThoughtsSnapshot`
   * taken at turn-start:
   *
   *   - When `showThoughts === true`: send a single one-line
   *     `🧠 Thought · <summary> · <duration>` header via the existing
   *     `onReply` path. The reasoning body is NEVER forwarded to WeChat —
   *     only the summary line. Sending the full body would flood the
   *     WeChat 10-message-per-turn limit on long-thinking models, and
   *     the user expects a label, not a transcript.
   *   - When `showThoughts === false`: do NOT call `onReply`. The
   *     off-mode metrics (`reasoningCharCount`, `reasoningStartMs`,
   *     `reasoningEndMs`) are already being updated by
   *     `accumulateReasoningDelta` for the streaming deltas — this
   *     method just observes the part (and the final char count + end
   *     timestamp are normalized here so that a reasoning part with
   *     zero deltas still contributes its final `text.length` and a
   *     proper end time).
   *
   * Empty / whitespace-only reasoning parts are skipped entirely to
   * avoid emitting `🧠 Thought · …` headers with no body and to avoid
   * polluting off-mode metrics with empty reasoning.
   *
   * Dedup is via `sentReasoningPartIds` — SSE replay / reconnection
   * can re-deliver the same reasoning part; the set guarantees each
   * reasoning part is sent at most once per turn.
   *
   * Race with `assistantMessageId`: if the first reasoning part arrives
   * before `message.updated role=assistant`, we cannot verify its
   * `messageID` against the assistant's. We buffer it in
   * `pendingReasoningParts` and replay via `flushPendingReasoningParts`
   * when the ID becomes known — parts whose `messageID` does not match
   * the assistant's are dropped at flush time (user-input echoes).
   * This mirrors the text-part buffering strategy.
   */
  private handleReasoningPart(turn: AccumulatedTurn, part: Part): void {
    if (part.type !== "reasoning") return;
    if (turn.sentReasoningPartIds.has(part.id)) {
      this.log(`[reasoning-part] dropping duplicate part ${part.id.slice(0, 8)}… (already sent)`);
      return;
    }
    if (!part.text.trim()) {
      // Skip empty/whitespace-only reasoning entirely — no header, no
      // off-mode metric increment. This guards against providers that
      // emit a `reasoning` part with an empty `.text` (e.g. when reasoning
      // was disabled mid-stream or the model returned no thoughts).
      return;
    }

    // Buffer reasoning parts that arrived BEFORE the assistant message
    // ID was known. The OpenCode server sometimes streams
    // `message.part.updated` for the assistant's first reasoning part
    // BEFORE emitting `message.updated` with role=assistant, so we
    // can't filter on `part.messageID === turn.assistantMessageId` yet.
    // Mirrors the text-part buffer — once the ID is known, buffered
    // parts are flushed in arrival order; parts whose `messageID` does
    // not match the assistant's are dropped (user-input echoes).
    if (turn.assistantMessageId === null) {
      turn.pendingReasoningParts.push(part);
      this.log(`[reasoning-part] buffering part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}…) until assistantMessageId is known`);
      return;
    }

    if (part.messageID !== turn.assistantMessageId) {
      // Mirror the text-part filter: drop user-side reasoning parts
      // (different messageID) so we never echo them.
      this.log(`[reasoning-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${turn.assistantMessageId.slice(0, 8)}…)`);
      return;
    }
    if (!turn.contextToken) {
      this.log(`[reasoning-part] no contextToken for part ${part.id.slice(0, 8)}…; dropping`);
      return;
    }

    this.dispatchReasoningPart(turn, part);
  }

  /**
   * Flush reasoning parts that were buffered because they arrived before
   * `assistantMessageId` was known. Called from `handleMessageUpdated`
   * when the assistant message arrives, and from `finalizeTurn` as a
   * last-chance flush.
   *
   * Mirrors `flushPendingTextParts`: buffered parts are replayed in
   * arrival order; parts whose `messageID` does not match the
   * assistant's are dropped (user-input echoes).
   */
  private flushPendingReasoningParts(turn: AccumulatedTurn): void {
    if (turn.pendingReasoningParts.length === 0) return;
    const pending = turn.pendingReasoningParts;
    turn.pendingReasoningParts = [];
    // Capture in a local so TS narrows the type to `string`.
    const assistantMsgId = turn.assistantMessageId;
    if (!assistantMsgId) {
      this.log(`[reasoning-part] assistantMessageId became null between buffering and flush; dropping ${pending.length} part(s)`);
      return;
    }
    for (const part of pending) {
      // Drop user-input parts (different messageID).
      if (part.messageID !== assistantMsgId) {
        this.log(`[reasoning-part] dropping part ${part.id.slice(0, 8)}… (messageID=${part.messageID.slice(0, 8)}… ≠ assistant ${assistantMsgId.slice(0, 8)}…)`);
        continue;
      }
      // Drop empty/whitespace-only reasoning (matches the live
      // `handlePartUpdated` R-handler behavior).
      const partText = (part as ReasoningPart).text ?? "";
      if (!partText.trim()) continue;
      // Dedup: skip parts that were somehow already sent.
      if (turn.sentReasoningPartIds.has(part.id)) continue;
      // Set state DIRECTLY here rather than re-dispatching through
      // `handlePartUpdated`. Same rationale as `flushPendingTextParts`:
      // the buffered part is OLDER in the model stream than the
      // current, so flushing the current on replay would put the
      // current BEFORE the buffered part in WeChat output (wrong
      // order). The buffered part becomes the new current; the
      // existing current stays in place for the next non-{old-type}
      // event to flush it.
      turn.currentPartType = "reasoning";
      turn.currentPartID = part.id;
      turn.currentReasoningText = partText;
      turn.currentReasoningStartMs = turn.reasoningPartTimestamps.get(part.id)?.startMs ?? null;
      turn.currentReasoningEndMs = turn.reasoningPartTimestamps.get(part.id)?.endMs ?? null;
    }
  }

  /**
   * Core reasoning-part dispatch (called once we know the part belongs
   * to the assistant). Sends the summary line to WeChat immediately
   * with the tool summary flushed just before it.
   */
  private dispatchReasoningPart(turn: AccumulatedTurn, part: ReasoningPart): void {
    // Snapshot the display flag (Task 5 added the snapshot field so a
    // mid-turn /thought-display toggle does not flip the visibility of
    // in-flight reasoning).
    const flags = this.getShowFlagsForTurn();

    if (flags.showThoughts) {
      // Compute PER-PART duration from the per-part streaming
      // timestamps (populated by `accumulateReasoningDelta`). This
      // gives the user the time spent THINKING for THIS reasoning
      // part only — not the cumulative time across the turn (which
      // would include tool calls interleaved between reasoning
      // parts). For reasoning parts that arrived with no streaming
      // deltas (rare; the `.text` non-empty guard above ensures we
      // have SOME content), fall back to "now" so the duration
      // renders as 0 instead of NaN.
      const now = Date.now();
      const partTimestamps = turn.reasoningPartTimestamps.get(part.id);
      const startMs = partTimestamps?.startMs ?? now;
      const endMs = partTimestamps?.endMs ?? now;
      const durationMs = Math.max(0, endMs - startMs);

      // `summary` is always populated: it's the `**Title**` header
      // when the model emitted one, otherwise the first line of the
      // body (truncated to MAX_SUMMARY_LEN).
      const { summary } = reasoningSummary(part.text);
      const line = formatThoughtHeader(durationMs, summary);

      // Pass-through: send the reasoning summary immediately. If
      // tools have been called in this turn (and the tool summary
      // hasn't been sent yet), the summary is emitted just before
      // this reasoning line so the WeChat display shows the tool
      // summary at the chronological boundary where the model
      // switched from "tools" to "more reasoning".
      this.maybeFlushToolSummary(turn);

      this.log(`[reasoning-part] sending summary for part ${part.id.slice(0, 8)}… (${part.text.length}ch, summary="${summary.length > 30 ? summary.slice(0, 30) + "…" : summary}", ${formatDuration(durationMs)})`);
      // `turn.contextToken` is guaranteed non-null by the caller
      // (`handleReasoningPart` returns early if it's missing). Re-checked
      // here because TS doesn't narrow across the function boundary.
      if (!turn.contextToken) return;
      this.onReply(turn.contextToken, line).catch((err) => {
        this.log(`onReply error for reasoning summary: ${String(err)}`);
      });

      // Mark the part as sent AFTER dispatching the single message
      // so duplicate `part.updated` events skip cleanly. `onReply`
      // is already fire-and-forget (catch is above), so synchronous
      // add is safe.
      turn.sentReasoningPartIds.add(part.id);
    }
    // off-mode: nothing to do here — `accumulateReasoningDelta`
    // already updated `reasoningCharCount` / `reasoningStartMs` /
    // `reasoningEndMs` during streaming. The `finalizeTurn` off-mode
    // log line consumes those metrics.
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
      // Now that we know the assistant's message ID, flush any text and
      // reasoning parts that were buffered while waiting. User-input
      // parts (different messageID) are dropped inside maybeSendTextPart
      // / handleReasoningPart.
      this.flushPendingTextParts(turn);
      this.flushPendingReasoningParts(turn);
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
      input: part.state.input,
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

  /**
   * Synchronously finalize the current turn, ignoring the debounce timer.
   * Intended for tests that want to verify the end-of-turn output without
   * waiting 500ms for the natural debounce. The test in
   * `verify-display-commands.mjs` exercises the type-change-flushing
   * design end-to-end and needs the LAST accumulated part (e.g. the
   * final text when no further R/tool follows) to be emitted before the
   * assertions run.
   *
   * Production code should NOT call this — the debounce exists so the
   * server's `session.idle` event has a chance to fire and we can be
   * sure no more R/tool parts are about to arrive. Force-finalizing would
   * race against the opencode server's natural close of the message
   * stream.
   */
  flushNowForTest(): void {
    if (this.currentTurn && this.currentTurn.status === "accumulating") {
      this.finalizeTurn("finalized");
    }
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

    // Drop any text and reasoning parts still buffered — if we got this
    // far without the assistant's message ID being known, those buffered
    // parts are very likely the user's own input parts (or stray
    // reasoning echoes) that we correctly held back. Any real assistant
    // parts should have been sent via flushPendingTextParts /
    // flushPendingReasoningParts when the `message.updated role=assistant`
    // event arrived.
    if (turn.pendingTextParts.length > 0) {
      this.log(`[turn] dropping ${turn.pendingTextParts.length} buffered text part(s) at finalize (likely user-input echoes)`);
      turn.pendingTextParts = [];
    }
    if (turn.pendingReasoningParts.length > 0) {
      this.log(`[turn] dropping ${turn.pendingReasoningParts.length} buffered reasoning part(s) at finalize (likely user-input echoes)`);
      turn.pendingReasoningParts = [];
    }

    const contextToken = turn.contextToken ?? "";
    const anyTextSent = turn.sentTextPartIds.size > 0;

    this.log(`[turn] finalize reason=${reason} sentTextParts=${turn.sentTextPartIds.size} tools=${turn.toolCalls.size} bgTasks=${turn.hasBackgroundTasks} assistantMsg=${turn.assistantMessageId?.slice(0, 8) ?? "-"}`);

    // Always cancel typing when the turn finalizes — even if we have no text
    // to send (otherwise the typing indicator would stay on in WeChat).
    if (contextToken) {
      this.cancelTyping?.(contextToken).catch(() => {});
    }

    // Flush the LAST accumulated current part before any fallback. If
    // the turn ended on a non-flushing event (e.g. a tool call that
    // never got followed by R/text, or a step-finish), the final
    // current sits un-flushed otherwise.
    //
    // `flushCurrentPart` itself is a no-op if the current was already
    // flushed (e.g. by a previous type change), so this is safe to call
    // unconditionally. The reset clears the state so no further
    // references to `turn.currentPartType` survive past the turn.
    //
    // IMPORTANT: capture `currentPartType` BEFORE the flush — the flush
    // resets it to `null`, which would make the gate below misclassify
    // the turn as "ended on tool" and wrongly flush the tool summary.
    const preFlushCurrentType = turn.currentPartType;
    this.flushCurrentPart(turn);

    // Send tool summary as a SEPARATE message when /tool-display on.
    // Two paths can emit it:
    //   1. `flushCurrentPart` already flushed it when the type changed
    //      AWAY from tool (handled in the case-"tool" branch of
    //      `flushCurrentPart`, which delegates to `maybeFlushToolSummary`).
    //      The `toolCallIdsInLastSummary` set marks those callIDs as
    //      summarized so this re-flush is a no-op.
    //   2. The turn had tools but NO non-tool event followed
    //      (e.g. the model ended on a tool call, or an error
    //      short-circuited before any text part arrived). In
    //      that case the fallback path here is the only place the
    //      user ever sees the summary, so we still emit it.
    //
    // We use `turn.showToolsSnapshot` (not the live `this.showTools`)
    // for the same reason as the `maybeSendTextPart` flush above: a
    // mid-turn toggle must not flip the in-flight turn's display.
    //
    // The gate on `preFlushCurrentType` (captured above, BEFORE
    // `flushCurrentPart` reset the state) handles the buffering-race
    // edge case: a buffered text/reasoning part may have been replayed
    // AFTER a tool was tracked (text came first in the model stream,
    // tool came second, replay shifted current from "tool" to
    // "text"/"reasoning"). In that case the tool is "in flight" and
    // should be flushed at the next non-tool event — but the turn is
    // ending, so we leave the tool in `toolCalls` unsummarized. The
    // user simply won't see a summary for that tool in this turn
    // (acceptable — the next turn's stream will re-emit it from the
    // server's own SSE anyway, and the assistantMessageId-race
    // scenario is rare).
    if (preFlushCurrentType !== "text" && preFlushCurrentType !== "reasoning") {
      this.maybeFlushToolSummary(turn);
    }

    // Off-mode reasoning log: when `/thought-display off` was active at
    // turn-start, the user does NOT see reasoning in WeChat — but they
    // should still get a single summary line in the bridge log so the
    // operator / log reader knows thinking happened (and how much).
    //
    // `reasoningCharCount` is updated by `accumulateReasoningDelta` for
    // every reasoning delta that arrives during streaming; the gate
    // `> 0` ensures we never emit the `🧠 Thought · …` log line when
    // the model produced zero reasoning for this turn.
    //
    // The duration uses `reasoningEndMs - reasoningStartMs` when both
    // are available (the typical case), falling back to 0 when the
    // turn interrupted before any reasoning ended cleanly.
    if (!turn.showThoughtsSnapshot && turn.reasoningCharCount > 0) {
      const duration = turn.reasoningEndMs && turn.reasoningStartMs
        ? turn.reasoningEndMs - turn.reasoningStartMs
        : 0;
      this.log(`🧠 Thought · ${formatDuration(duration)} · ${turn.reasoningCharCount} chars`);
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
    return this.buildToolSummaryFromMap(turn.toolCalls);
  }

  /**
   * Build a tool summary from a specific Map of `TrackedTool`. Used by
   * `maybeFlushToolSummary` and `finalizeTurn` to render summaries
   * containing only the "new since last flush" subset of tools, so
   * consecutive tools get combined and separate tools get individual
   * summaries (user-stated rule).
  /**
   * Per-tool line truncation cap for the `state.title` portion of a tool
   * summary entry. opencode-generated titles are usually short ("exit 0",
   * "3 matches", "https://x") but some tools emit very long ones (a
   * sub-agent's full report header, for example) — 80 chars keeps a
   * single tool from dominating the line in WeChat.
   */
  private static readonly MAX_TOOL_TITLE_LEN = 80;

  /**
   * Build a tool summary from a specific Map of `TrackedTool`. Used by
   * `maybeFlushToolSummary` and `finalizeTurn` to render summaries
   * containing only the "new since last flush" subset of tools, so
   * consecutive tools get combined and separate tools get individual
   * summaries (user-stated rule).
   *
   * Each line is `emoji name [title]` (optionally ` (sub-agent)` for
   * `task`/`subtask` dispatches). The `title` is the opencode-generated
   * one-line summary the tool itself set on its output — for example
   * `webfetch` sets it to the URL it fetched, `bash` to the exit status.
   * When the title is empty (the tool part arrived before the tool
   * finished, or the tool didn't set a title) we synthesize a fallback
   * title from the tool's known input parameters (for example glob
   * with a TypeScript glob pattern, grep with the search term, or
   * webfetch with the URL) so the user at least sees what the tool
   * was invoked with. Titles longer than
   * {@link MAX_TOOL_TITLE_LEN} chars are truncated with an ellipsis.
   */
  private buildToolSummaryFromMap(tools: Map<string, TrackedTool>): string {
    const lines: string[] = ["🔧 Tools:"];
    const MAX_TITLE = SessionManager.MAX_TOOL_TITLE_LEN;
    const STATUS_EMOJI = {
      completed: "✅",
      error: "❌",
      running: "⏳",
      pending: "⏳",
    } as const;
    for (const tc of tools.values()) {
      const emoji = STATUS_EMOJI[tc.status] ?? "⏳";
      // LLM-supplied title takes priority; fall back to a derived title
      // synthesized from the tool's known input parameters when the
      // LLM SDK did not populate state.title (common for read-only
      // tools like glob/grep/webfetch with some models).
      const title = (tc.title?.trim() || this.deriveTitleFromInput(tc.toolName, tc.input) || "").trim();
      let line = `${emoji} ${tc.toolName}`;
      if (title) {
        const trimmed = title.length > MAX_TITLE
          ? title.slice(0, MAX_TITLE - 1) + "…"
          : title;
        line += ` ${trimmed}`;
      }
      if (tc.isSubAgent) {
        line += " (sub-agent)";
      }
      lines.push(`  ${line}`);
    }
    const summary = lines.join("\n");
    // Hard cap the entire summary to keep the WeChat 10-message budget
    // healthy when many tools are involved in one turn. Each tool line
    // is already bounded; this trims the WHOLE block as a safety net.
    if (summary.length > MAX_TOOL_SUMMARY_LEN) {
      return summary.slice(0, MAX_TOOL_SUMMARY_LEN - 1) + "…";
    }
    return summary;
  }

  /**
   * Derive a short, human-readable title from a tool's input parameters.
   * Returns `undefined` if the input is missing or the tool is unknown
   * (caller should treat the tool as title-less in that case).
   *
   * The derivation is per-tool, using whichever of the tool's known
   * input parameters the SDK exposes:
   *   - glob         → pattern (e.g. "**\/*.ts")
   *   - grep         → pattern
   *   - read         → filePath / path / file
   *   - write        → filePath
   *   - edit         → filePath
   *   - webfetch     → url
   *   - bash / shell → command (truncated)
   *   - task         → description / prompt
   *   - question     → question
   *   - default      → JSON.stringify(input) (truncated)
   */
  private deriveTitleFromInput(toolName: string, input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    const params = input as Record<string, unknown>;
    const pick = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        const v = params[k];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return undefined;
    };
    const truncate = (s: string, max = 60): string =>
      s.length <= max ? s : s.slice(0, max - 1) + "…";
    let raw: string | undefined;
    switch (toolName) {
      case "glob":
      case "grep":
        raw = pick("pattern");
        break;
      case "read":
      case "write":
      case "edit":
      case "patch":
        raw = pick("filePath", "path", "file");
        break;
      case "webfetch":
        raw = pick("url");
        break;
      case "bash":
      case "shell":
        raw = pick("command");
        break;
      case "task":
      case "subtask":
        raw = pick("description", "prompt");
        break;
      case "question":
        raw = pick("question");
        break;
      case "todowrite":
        raw = pick("content", "status");
        break;
      case "skill":
        raw = pick("name");
        break;
      default:
        raw = undefined;
    }
    if (raw) return truncate(raw);
    // Fallback: stringify whatever the input is, then truncate.
    try {
      const json = JSON.stringify(input);
      if (json && json !== "{}") return truncate(json, 60);
    } catch {
      // not serializable; give up
    }
    return undefined;
  }

  /**
   * Emit the per-turn `🔧 Tools: …` summary to WeChat if (and only if)
   * the snapshot flag is on, any tools have been called, the summary
   * hasn't been emitted yet, and a contextToken is available.
   *
   * Called from the two non-tool event sites that are the natural
   * "boundary" between the tools phase and the rest of the model
   * output:
   *
   *   - `handleReasoningPart` (in showThoughts=on mode)  →
   *     reasoning-after-tool appears in WeChat with the tool summary
   *     IMMEDIATELY before it, so the WeChat display preserves the
   *     chronological order:
   *       reasoning1 → tools → reasoning2 → text
   *     becomes
   *       R1, tool-summary, R2, text
   *
   *   - `maybeSendTextPart`  → the first text part is preceded by
   *     the tool summary, so the WeChat display reads:
   *       R1, tool-summary, R2, text
   *     in the common R → T → R → Text case, or:
   *       R1, T-summary, R2, text  (with R2 actually being the text)
   *     in the R → T → Text case where there's no post-tool reasoning.
   *
   * `finalizeTurn` also calls this as a fallback for turns that end
   * on a tool call (no reasoning or text follows).
   *
   * Pass-through semantics: this is a NO-OP unless ALL of the
   * following are true: tools have been called (`toolCalls.size > 0`),
   * the summary flag is on (`showToolsSnapshot`), and at least one
   * tool hasn't been included in a previous summary this turn
   * (otherwise the non-tool boundary was a no-op). Tools are tracked
   * silently; the summary is a single WeChat message emitted at the
   * boundary, covering only the tools that arrived since the last
   * flush.
   */
  private maybeFlushToolSummary(turn: AccumulatedTurn): void {
    if (turn.toolCalls.size === 0) return;
    if (!turn.showToolsSnapshot) return;
    if (!turn.contextToken) return;
    // Find tools that haven't been summarized yet.
    const newTools = new Map<string, TrackedTool>();
    for (const [callID, tracked] of turn.toolCalls) {
      if (!turn.toolCallIdsInLastSummary.has(callID)) {
        newTools.set(callID, tracked);
      }
    }
    if (newTools.size === 0) return;
    const toolSummary = this.buildToolSummaryFromMap(newTools);
    if (!toolSummary) return;
    for (const callID of newTools.keys()) {
      turn.toolCallIdsInLastSummary.add(callID);
    }
    this.log(`[tool-summary] flushing ${newTools.size} new tool(s) at non-tool boundary (total tracked: ${turn.toolCalls.size})`);
    this.onReply(turn.contextToken, toolSummary).catch((err) => {
      this.log(`onReply error for tool summary: ${String(err)}`);
    });
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

  /**
   * Update the SessionManager's display flags.
   *
   * **Snapshot semantics (intentional):** this method deliberately does NOT
   * propagate the new flag values into `currentTurn.showThoughtsSnapshot` /
   * `currentTurn.showToolsSnapshot`. The snapshot is captured once, at the
   * start of each turn (see `beginTurn`), and held stable for the lifetime
   * of that turn. This means:
   *
   *   1. If the user runs `/thought-display on` mid-turn, the reasoning
   *      for the in-flight turn is still hidden (the turn started with
   *      `showThoughts=false`). The next turn picks up the new flag.
   *   2. If the user runs `/thought-display off` mid-turn, reasoning
   *      already being streamed for this turn is still shown. The next
   *      turn hides it.
   *
   * This avoids confusing "flash" behavior where reasoning would appear
   * halfway through a turn and disappear on the next delta. Reasoning
   * visibility is a per-turn commitment, not a per-event one.
   *
   * Partial-update safe: only fields present in `flags` are mutated.
   * Calling `setShowFlags({ showThoughts: true })` leaves `showTools`
   * untouched.
   */
  setShowFlags(flags: { showThoughts?: boolean; showTools?: boolean }): void {
    if (flags.showThoughts !== undefined) this.showThoughts = flags.showThoughts;
    if (flags.showTools !== undefined) this.showTools = flags.showTools;
  }

  getShowFlags(): { showThoughts: boolean; showTools: boolean } {
    return { showThoughts: this.showThoughts, showTools: this.showTools };
  }

  /**
   * Resolve the display flags that should govern event-handling for the
   * **current** turn.
   *
   * Returns the snapshot captured at `beginTurn` if a turn is in flight
   * (`currentTurn !== null`), else falls back to the SessionManager's
   * live `showThoughts` / `showTools`. This is the accessor that Task 6's
   * `handleReasoningPart` and tool-summary code should use, so that
   * reasoning/tool visibility stays consistent within a turn regardless
   * of any mid-turn toggle.
   */
  getShowFlagsForTurn(): { showThoughts: boolean; showTools: boolean } {
    if (this.currentTurn !== null) {
      return {
        showThoughts: this.currentTurn.showThoughtsSnapshot,
        showTools: this.currentTurn.showToolsSnapshot,
      };
    }
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
