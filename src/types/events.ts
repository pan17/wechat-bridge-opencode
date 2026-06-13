/**
 * OpenCode Server SSE event types.
 *
 * These types mirror the payloads emitted on `/global/event` (and `/event`).
 * The /global/event stream wraps each event in a `GlobalEvent` envelope:
 *   { directory, project, workspace, payload: <one of OpenCodeEvent below> }
 *
 * We consume only the events needed for chat-style interaction:
 *   - message.part.delta      — streaming text from assistant
 *   - message.part.updated    — full part snapshot (text finalize, tool state)
 *   - message.updated         — new message (user/assistant) created
 *   - message.removed         — message removed (cleanup)
 *   - session.status          — busy/idle/retry transitions
 *   - session.idle            — session became idle (alt signal for some servers)
 *   - session.error           — server-side error
 *
 * Reference: opencode server /event payload shape.
 */

export type SessionStatusType = "idle" | "busy" | "retry";

export interface SessionStatus {
  type: SessionStatusType;
  attempt?: number;
  message?: string;
  next?: number;
}

/** A part of an assistant/user message. We model only the variants we use. */
export type PartType = "text" | "tool" | "file" | "reasoning" | "step-start" | "step-finish" | "snapshot";

export interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
  type: PartType;
}

export interface TextPart extends PartBase {
  type: "text";
  text: string;
  synthetic?: boolean;
}

export interface ToolPart extends PartBase {
  type: "tool";
  tool: string;
  callID: string;
  state: {
    status: "pending" | "running" | "completed" | "error";
    input?: unknown;
    output?: string;
    error?: string;
    title?: string;
  };
}

export interface FilePart extends PartBase {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
}

export interface ReasoningPart extends PartBase {
  type: "reasoning";
  text: string;
}

export interface StepPart extends PartBase {
  type: "step-start" | "step-finish" | "snapshot";
}

export type Part = TextPart | ToolPart | FilePart | ReasoningPart | StepPart;

/** A message info (user or assistant). */
export interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  parentID?: string;
  /** ISO timestamp or epoch ms depending on server. */
  time?: { created?: number; completed?: number };
  agent?: string;
  model?: { providerID: string; modelID: string };
  /**
   * Reasoning / effort variant key (e.g. "low", "medium", "high", or a provider-
   * specific opaque key such as "1"). One-shot per message in OpenCode Server;
   * the bridge must include it on every prompt to keep the model in the
   * desired variant — see https://github.com/anomalyco/opencode/issues/24299.
   */
  variant?: string;
  /** For assistant: total tokens used. */
  tokens?: { input?: number; output?: number; total?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  /** For assistant: cost. */
  cost?: number;
  /** For assistant: error string if any. */
  error?: { message?: string; code?: string };
}

// ─── Individual Event Payloads ───

export interface MessagePartDeltaEvent {
  type: "message.part.delta";
  properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    /** The field being deltaed. For text parts, this is "text". */
    field: string;
    delta: string;
  };
}

export interface MessagePartUpdatedEvent {
  type: "message.part.updated";
  properties: {
    sessionID: string;
    part: Part;
    time?: number;
  };
}

export interface MessageUpdatedEvent {
  type: "message.updated";
  properties: {
    sessionID: string;
    info: MessageInfo;
  };
}

export interface MessageRemovedEvent {
  type: "message.removed";
  properties: {
    sessionID: string;
    messageID: string;
  };
}

export interface SessionStatusEvent {
  type: "session.status";
  properties: {
    sessionID: string;
    status: SessionStatus;
  };
}

export interface SessionIdleEvent {
  type: "session.idle";
  properties: {
    sessionID: string;
  };
}

export interface SessionErrorEvent {
  type: "session.error";
  properties: {
    sessionID?: string;
    error?: unknown;
  };
}

/** The full union we handle. Other event types are ignored. */
export type OpenCodeEvent =
  | MessagePartDeltaEvent
  | MessagePartUpdatedEvent
  | MessageUpdatedEvent
  | MessageRemovedEvent
  | SessionStatusEvent
  | SessionIdleEvent
  | SessionErrorEvent;

/** Outer envelope from /global/event. /event emits the inner payload directly. */
export interface GlobalEvent {
  directory: string;
  project?: string;
  workspace?: string;
  /** Some servers nest the actual event under .payload, some under .event. */
  payload?: OpenCodeEvent;
  event?: OpenCodeEvent;
}

// ─── Event Pipeline Lifecycle Types ───

export type EventPipelineStatus = "idle" | "connecting" | "connected" | "reconnecting" | "stopped";

export interface EventPipelineOpts {
  /** Full URL to the SSE endpoint (e.g. http://localhost:4096/global/event). */
  url: string;
  /** Directory header for per-directory filtering (optional). */
  directory?: string;
  log?: (msg: string) => void;
  /** Called for every parsed event. Must be non-throwing. */
  onEvent: (event: OpenCodeEvent) => void;
  onStatusChange?: (status: EventPipelineStatus) => void;
  onError?: (err: Error) => void;
  /**
   * Pre-computed `Authorization` header value (e.g. `Basic …` or `Bearer …`).
   * Mirrors the value `OpenCodeServerClient` would inject on its requests,
   * so the SSE stream and the JSON API stay authenticated consistently.
   * `undefined`/empty sends no `Authorization` header.
   */
  authHeader?: string | null;
}

// ─── Turn Accumulator Types ───

export type TurnStatus = "idle" | "accumulating" | "finalized" | "interrupted" | "error";

export interface TrackedTool {
  callID: string;
  toolName: string;
  status: "pending" | "running" | "completed" | "error";
  title?: string;
  /**
   * Tool input from the LLM SDK (part.state.input). Captured so the
   * WeChat tool summary can derive a human-readable fallback title
   * (for example glob with a TypeScript glob pattern) when the LLM
   * does not populate state.title. Not all model/tool combinations
   * set the title field on every tool part, so we keep the raw input
   * as a safety net.
   */
  input?: unknown;
  output?: string;
  /** True if this is a sub-agent dispatch (task tool). */
  isSubAgent: boolean;
}

export interface AccumulatedTurn {
  sessionId: string;
  /** The user message ID that started this turn. */
  userMessageId: string | null;
  /** Current/last assistant message ID seen in this turn. */
  assistantMessageId: string | null;
  /** Per-partID snapshot of all parts observed during this turn. */
  parts: Map<string, Part>;
  /** Streaming text from `message.part.delta` (pre-finalization). */
  textBuffer: string;
  /** Final text from `message.part.updated` (post-finalization). */
  finalText: string;
  /** Per-tool tracking. */
  toolCalls: Map<string, TrackedTool>;
  /** True if any sub-agent (`task` tool) was dispatched during this turn. */
  hasBackgroundTasks: boolean;
  /** WeChat contextToken to send replies to. */
  contextToken: string | null;
  /** Optional hint appended to the final reply. */
  hint: string | null;
  /** Turn status. */
  status: TurnStatus;
  /** When the turn started (epoch ms). */
  startedAt: number;
  /** When the turn last received any event. */
  lastEventAt: number;
  /** Text-part IDs that have already been sent to WeChat (avoid duplicates). */
  sentTextPartIds: Set<string>;
  /**
   * Text parts that arrived BEFORE `assistantMessageId` was known (typically
   * the user's own input parts being replayed by the server). Once the
   * assistant message ID is known, parts whose `messageID` matches are
   * flushed to WeChat; user-input parts (different messageID) are dropped.
   */
  pendingTextParts: Part[];
  /**
   * Reasoning parts that arrived BEFORE `assistantMessageId` was known.
   * Mirrors the text-part buffer: a reasoning part whose `messageID` we
   * can't yet verify against the assistant's ID gets buffered here, and
   * is flushed in `flushPendingReasoningParts` once the ID is known. This
   * prevents the FIRST reasoning part of a turn from being silently dropped
   * when the OpenCode server streams `message.part.updated` for reasoning
   * before emitting `message.updated` for the assistant message itself.
   * Parts whose `messageID` doesn't match the assistant's are dropped at
   * flush time, just like text parts.
   */
  pendingReasoningParts: Part[];
  /**
   * Display flag snapshot — captured at `beginTurn` from the SessionManager's
   * current `showThoughts` / `showTools`. Mid-turn toggles via `setShowFlags`
   * do NOT update this snapshot; the in-flight turn keeps whatever flags
   * were active when it started. Task 6 reads these via `getShowFlagsForTurn`
   * to decide whether to send reasoning/tool summaries to WeChat.
   */
  showThoughtsSnapshot: boolean;
  showToolsSnapshot: boolean;
  /**
   * Total characters of reasoning text accumulated across all reasoning
   * parts in this turn. Used for the "off-mode" log line emitted by
   * `finalizeTurn` when `showThoughtsSnapshot` is false but reasoning was
   * still produced (so the user can see how much thinking happened).
   * Each `handleReasoningPart` invocation adds the new part's text length
   * to `reasoningCharCount` (after the dedup check via `sentReasoningPartIds`).
   */
  reasoningCharCount: number;
  /**
   * Epoch-ms timestamp of the FIRST reasoning part observed in this turn.
   * `null` if no reasoning part has been seen yet. Used together with
   * `reasoningEndMs` to compute the reasoning duration for the off-mode
   * log line and (when reasoning is shown) the `formatThoughtHeader` call.
   * Set by `handleReasoningPart` once, on the first reasoning part that
   * survives the `sentReasoningPartIds` dedup check.
   */
  reasoningStartMs: number | null;
  /**
   * Epoch-ms timestamp of the LAST reasoning part observed in this turn.
   * `null` if no reasoning part has been seen yet. Updated on each new
   * reasoning part so the duration reflects the full reasoning span.
   * Together with `reasoningStartMs` it yields the reasoning duration for
   * the off-mode log line and (when reasoning is shown) for the header.
   */
  reasoningEndMs: number | null;
  /**
   * Reasoning partIDs that have already been forwarded to WeChat
   * during this turn. SSE event replay can re-deliver the same
   * reasoning part (e.g. on reconnect or duplicate delivery); this
   * set prevents the same reasoning from being sent twice within a
   * single turn. Also gates `reasoningCharCount` and
   * `reasoningStartMs`/`reasoningEndMs` updates: only first-seen
   * reasoning parts contribute to those metrics.
   */
  sentReasoningPartIds: Set<string>;
  /**
   * Per-reasoning-part streaming timestamps. Keyed by `part.id`.
   *
   * - `startMs` is the wall-clock time when the FIRST `message.part.delta`
   *   for that reasoning part arrived (set by
   *   `accumulateReasoningDelta`).
   * - `endMs` is updated to every subsequent delta's timestamp, so
   *   it reflects the time the LAST delta for that part arrived
   *   (i.e. just before `message.part.updated` with the full text).
   *
   * Used by `handleReasoningPart` to compute the per-part duration
   * for the WeChat `🧠 Thought · {summary} · {duration}` line. The
   * per-part span is what the user expects — the previous
   * implementation used `turn.reasoningEndMs - reasoningStartMs`
   * which is the CUMULATIVE time across all reasoning parts in the
   * turn (including the tool calls interleaved between them), and
   * was reported as a bug: a second reasoning that actually took
   * 1.2s showed as 21.6s because that's the wall-clock from the
   * first reasoning start to the second reasoning end (which
   * includes the 20s bash call in between).
   *
   * The turn-level cumulative metrics (`reasoningStartMs` /
   * `reasoningEndMs`) are still maintained for the off-mode log
   * line in `finalizeTurn`, which reports the total thinking time
   * for the operator.
   */
  reasoningPartTimestamps: Map<string, { startMs: number; endMs: number }>;
  /**
   * Set of tool `callID`s that have already been included in a
   * `🔧 Tools: …` summary emitted to WeChat during this turn.
   *
   * Used to support the "consecutive tools get combined, separate
   * tools get individual summaries" rule (user-stated): when
   * `maybeFlushToolSummary` runs, it emits a summary line containing
   * ONLY the tools whose `callID` is NOT in this set. The set is
   * updated to include those `callID`s after the summary is sent.
   *
   * Trace for `R, T1, Text, R, T2, Text`:
   *   - T1 tracked (set empty)
   *   - Text1 → flush: new tools = {T1}, summary = "T1", set += {T1}
   *   - T2 tracked (set = {T1})
   *   - Text2 → flush: new tools = {T2}, summary = "T2", set += {T1,T2}
   *   - Output: R1, "🔧 Tools: T1", Text1, R2, "🔧 Tools: T2", Text2
   *
   * Trace for `R, T1, T2, T3, R, Text` (consecutive):
   *   - T1, T2, T3 tracked (set empty)
   *   - R → flush: new tools = {T1,T2,T3}, summary combined, set += all
   *   - Text → flush: new tools = {} (all in set), no-op
   *   - Output: R1, "🔧 Tools: T1,T2,T3", R2, Text
   */
  toolCallIdsInLastSummary: Set<string>;
}
