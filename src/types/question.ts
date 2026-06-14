/**
 * Types for OpenCode's `question` tool integration.
 *
 * These types mirror the schemas in opencode's `packages/opencode/src/question/`
 * (see `index.ts` and `schema.ts`). They are kept as pure data interfaces —
 * no class identity checks, no runtime overhead — so the bridge can construct
 * them from SSE payloads and HTTP responses without an effect/Schema decoder.
 *
 * Source of truth (as of opencode 1.x):
 *   - QuestionOption  ← Schema.Struct({ label, description })
 *   - QuestionPrompt  ← Question.Prompt (no `custom` field on Prompt;
 *                                     `Info` adds `custom?: boolean`)
 *   - QuestionRequest ← Question.Request { id, sessionID, questions, tool? }
 *
 * See also: `.omo/plans/question-tool-design.md` §5.
 */

/** One selectable option for a question. */
export interface QuestionOption {
  readonly label: string;        // 1-5 词，简短显示文本
  readonly description: string;  // 选项说明
}

/**
 * One question as sent by the LLM via the `question` tool.
 *
 * `multiple` defaults to false; `custom` defaults to true (per opencode's
 * `Question.Info` schema). We don't enforce the defaults at the type level —
 * the formatter and parser handle them in code.
 */
export interface QuestionPrompt {
  readonly question: string;
  readonly header: string;                   // ≤ 30 字符
  readonly options: ReadonlyArray<QuestionOption>;
  readonly multiple?: boolean;              // 默认 false
  readonly custom?: boolean;                // 默认 true
}

/** Reference to the `question` tool part that triggered this request. */
export interface QuestionToolRef {
  readonly messageID: string;
  readonly callID: string;
}

/**
 * Server-emitted `question.asked` SSE payload.
 *
 * `id` is the request ID (opencode uses a "que"-prefixed string).
 * `sessionID` matches the current OpenCode session.
 */
export interface QuestionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly questions: ReadonlyArray<QuestionPrompt>;
  readonly tool?: QuestionToolRef;
}

/** Server-emitted `question.replied` SSE payload. */
export interface QuestionRepliedEvent {
  readonly sessionID: string;
  readonly requestID: string;
  readonly answers: ReadonlyArray<ReadonlyArray<string>>;
}

/** Server-emitted `question.rejected` SSE payload. */
export interface QuestionRejectedEvent {
  readonly sessionID: string;
  readonly requestID: string;
}

/**
 * Internal state held on SessionManager for a question awaiting the
 * WeChat user's answer. Differs from QuestionRequest in that it also
 * tracks the WeChat contextToken (to route the formatted question to
 * the right chat) and the wall-clock time the question was asked
 * (used by the 30-minute soft-timeout).
 */
export interface PendingQuestion {
  readonly requestID: string;
  readonly questions: ReadonlyArray<QuestionPrompt>;
  readonly contextToken: string;
  readonly askedAt: number;
  readonly tool?: QuestionToolRef;
}
