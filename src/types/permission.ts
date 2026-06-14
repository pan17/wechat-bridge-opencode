/**
 * Types for OpenCode's `permission` tool integration.
 *
 * The `permission` tool in OpenCode is what gates an agent's tool calls
 * against the user's permission ruleset. When a tool's rule is `"ask"`
 * (the default for sensitive tools), the agent's call is blocked on a
 * `Deferred` until the user replies `once`, `always`, or `reject`. The
 * server emits `permission.asked` so the bridge can surface the request
 * to WeChat; after the bridge POSTs the decision, the server emits
 * `permission.replied` (with `reply: "reject"` for cascaded siblings).
 *
 * These types mirror opencode's V1 schema:
 *   - PermissionRequest  ← packages/core/src/v1/permission.ts:28-39
 *   - PermissionReply    ← packages/core/src/v1/permission.ts:42
 *     ("once" | "always" | "reject")
 *
 * See `.omo/plans/permission-tool-design.md` §3 for the design rationale
 * and the divergence from the question tool's parser (single-choice vs
 * multi-select, bare keywords, etc.).
 */

/** User's reply to a pending permission request. */
export type PermissionReply = "once" | "always" | "reject";

/**
 * Auto-accept mode for permission requests. The bridge tracks this
 * client-side and persists it in `.wechat-bridge-state.json`.
 *
 * - `off`   — show a WeChat card on every `permission.asked` (default)
 * - `once`  — auto-reply `"once"` without showing a card
 * - `always` — auto-reply `"always"` (server stores an in-memory rule)
 *
 * NOTE: `always` rules are stored server-side in `InstanceState.approved`
 * (in-memory only, see `packages/opencode/src/permission/index.ts:34-77`).
 * They are lost when `opencode serve` restarts; the bridge does NOT
 * shadow-store them.
 */
export type AutoPermissionMode = "off" | "once" | "always";

/** Default `autoPermissionMode` when no preference is persisted. */
export const DEFAULT_AUTO_PERMISSION_MODE: AutoPermissionMode = "off";

/**
 * Server-emitted `permission.asked` SSE payload. Mirrors opencode's
 * `PermissionV1.Request` (packages/core/src/v1/permission.ts:28-39).
 *
 * - `id` is the request ID (opencode uses a "per"-prefixed string).
 * - `permission` is the tool name (e.g. "bash", "edit", "read",
 *   "webfetch", "grep", "write").
 * - `patterns` are the specific resources the agent wants to access
 *   for THIS call (e.g. `["/etc/hosts"]`).
 * - `always` is the agent's claimed minimal set of patterns that would
 *   cover this request under an "always allow" rule — used by the server
 *   to populate `InstanceState.approved` on `reply === "always"`.
 * - `tool` is optional; only present when the permission source is a
 *   tool call part of the agent's message.
 */
export interface PermissionRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly permission: string;
  readonly patterns: ReadonlyArray<string>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly always: ReadonlyArray<string>;
  readonly tool?: { readonly messageID: string; readonly callID: string };
}

/**
 * Server-emitted `permission.replied` SSE payload. Emitted after EVERY
 * resolution (user reply, auto-cascade reject, timeout reject). The
 * bridge's `handlePermissionRepliedSse` clears the local slot keyed by
 * `requestID` — race-safe.
 *
 * There is NO `permission.rejected` server event; rejections surface as
 * `permission.replied` with `reply: "reject"`.
 */
export interface PermissionRepliedSseProps {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: PermissionReply;
}

/**
 * Internal state held on SessionManager for a permission awaiting the
 * WeChat user's answer. Mirrors `PendingQuestion` but uses a Map key
 * (multiple parallel permission requests are possible from concurrent
 * tool calls — the question tool's single-slot model doesn't fit).
 *
 * `contextToken` routes the formatted card to the right WeChat chat;
 * `askedAt` is used by the 30-minute soft timeout.
 */
export interface PendingPermission {
  readonly requestID: string;
  readonly request: PermissionRequest;
  readonly contextToken: string;
  readonly askedAt: number;
}

/**
 * Result of `parsePermissionReply` — one decision per `requestID`.
 * `message` is only set when `reply === "reject"` and the user provided
 * freeform text via the `P{n}-text` syntax (or implicit text fallback).
 */
export interface PermissionDecision {
  readonly requestID: string;
  readonly reply: PermissionReply;
  readonly message?: string;
}

/**
 * Aggregate parse result. The parser may return multiple decisions in
 * one user message (e.g. `P1=once P2=reject`) — same pattern as
 * `parseQuestionReply`'s multi-question handling.
 */
export interface PermissionParseResult {
  readonly decisions: ReadonlyArray<PermissionDecision>;
  /**
   * Non-fatal diagnostics (out-of-range indices, multi-select attempts,
   * unrecognized segments). Logged for the operator; never throw.
   */
  readonly warnings: ReadonlyArray<string>;
}
