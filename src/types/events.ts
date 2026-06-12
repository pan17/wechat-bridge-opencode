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
}
