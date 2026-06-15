/**
 * Cross-session notification formatting.
 *
 * Pure functions that take a "raw" event (filtered to a non-current
 * session) plus a session label and produce a WeChat-ready text message.
 *
 * The output is plain text — no markdown, no images. It stays within the
 * 4000-char WeChat chunk limit (a single notification is far below it)
 * and uses emoji + indentation for visual structure, matching the
 * existing `formatQuestionForWeChat` / `formatPermissionCard` style.
 *
 * Each format function returns a self-contained message that the user can
 * act on without further context: a `/session switch <n>` hint with the
 * session's position in the most recent `/session list` output would be
 * ideal, but the bridge doesn't know that index at notification time
 * (the list is request-scoped and could be stale). Instead we name the
 * session by title (or id fallback) and let the user run `/session
 * list` or `/session switch` themselves with the title as a hint.
 *
 * Why a label cache and not just the session id: the user has no
 * mental model for `ses_abc123…` but a strong mental model for
 * "fix-auth-bug" or "/Users/me/repos/api". The bridge looks up
 * titles via `client.getSession(id)` (cached in SessionNotifier).
 */

import type { QuestionPrompt } from "../types/question.js";
import type { PermissionRequest } from "../types/permission.js";
import type { SessionStatus } from "../types/events.js";

/**
 * Render-friendly view of a "pending interaction" in another session.
 *
 * Built by the SessionNotifier from the raw SSE payload + its session
 * label cache, then passed to the format function. Keeping this as a
 * separate type means the formatters don't need to know about the
 * underlying SSE event variants — they just render one of 4 well-known
 * shapes.
 */
export type OtherSessionNotice =
  | {
      kind: "question";
      sessionLabel: string;
      question: QuestionPrompt;
    }
  | {
      kind: "permission";
      sessionLabel: string;
      permission: PermissionRequest;
    }
  | {
      kind: "error";
      sessionLabel: string;
      errorMessage: string;
    }
  | {
      kind: "completion";
      sessionLabel: string;
    };

/** Max title/cwd segment length to keep notifications compact. */
const MAX_LABEL_LEN = 60;
/** Max question/error text length in the one-liner. */
const MAX_BODY_LEN = 120;

/**
 * Format an `OtherSessionNotice` as a single WeChat message.
 *
 * Output shapes (one-line summary + optional detail block, matching
 * the question card and permission card style):
 *
 *   📨 Session "fix-auth-bug" 等待你的输入
 *      Q: 用 OAuth 还是 JWT?
 *      /session switch <title 或 id> 切换查看
 *
 *   🔐 Session "deploy-prod" 等待权限: bash
 *      /session switch <title 或 id> 处理
 *
 *   ❌ Session "migrate-db" 出错
 *      rate limit exceeded
 *      /session switch <title 或 id> 查看
 *
 *   ✅ Session "fix-auth-bug" 已完成
 */
export function formatOtherSessionNotification(notice: OtherSessionNotice): string {
  const label = truncateLabel(notice.sessionLabel);
  const switchHint = `   /session switch ${quoteForHint(label)} 查看`;

  switch (notice.kind) {
    case "question": {
      const firstQ = notice.question.question || "(empty question)";
      const truncatedQ = truncate(firstQ, MAX_BODY_LEN);
      return `📨 Session "${label}" 等待你的输入\n   Q: ${truncatedQ}\n${switchHint}`;
    }
    case "permission": {
      const tool = notice.permission.permission;
      const patterns = notice.permission.patterns;
      const detail = patterns.length > 0 ? truncate(patterns.join(", "), MAX_BODY_LEN) : tool;
      return `🔐 Session "${label}" 等待权限: ${tool}\n   ${detail}\n${switchHint}`;
    }
    case "error": {
      const detail = notice.errorMessage ? truncate(notice.errorMessage, MAX_BODY_LEN) : "(unknown error)";
      return `❌ Session "${label}" 出错\n   ${detail}\n${switchHint}`;
    }
    case "completion": {
      return `✅ Session "${label}" 已完成`;
    }
  }
}

/**
 * Extract a human-readable hint of an error from the `session.error`
 * event payload. The event's `error` field is `unknown` (the opencode
 * server emits a discriminated union with various error shapes), so
 * this function defensively coerces whatever the server sent.
 */
export function extractSessionErrorMessage(error: unknown): string {
  if (error == null) return "Unknown error";
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const e = error as { message?: unknown; name?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof e.name === "string" && e.name) parts.push(e.name);
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.code === "string" || typeof e.code === "number") parts.push(String(e.code));
    if (parts.length > 0) return parts.join(": ");
    // Object with no recognizable fields (e.g. `{}`, `{ foo: 1 }`) —
    // fall back to "Unknown error" rather than the unhelpful
    // "[object Object]" that `String({})` produces. The caller's
    // formatter truncates long messages; the limit is a no-op here
    // since the fallback is short.
  }
  return "Unknown error";
}

/**
 * Render the `/notify status` body — multi-line text shown when the
 * user queries their current notification settings.
 */
export function formatNotifyStatus(
  enabled: boolean,
  types: { question: boolean; permission: boolean; error: boolean; completion: boolean },
): string {
  const lines: string[] = ["🔔 Notify:"];
  lines.push(`   Status: ${enabled ? "✅ On" : "❌ Off"}`);
  lines.push("   Types:");
  lines.push(`     • question   ${types.question ? "✅" : "❌"}`);
  lines.push(`     • permission ${types.permission ? "✅" : "❌"}`);
  lines.push(`     • error      ${types.error ? "✅" : "❌"}`);
  lines.push(`     • completion ${types.completion ? "✅" : "❌"}`);
  lines.push("");
  lines.push("   /notify on|off                总开关");
  lines.push("   /notify types <type> on|off   切换单个事件");
  lines.push("   /notify status                查看状态");
  return lines.join("\n");
}

// ─── Helpers ───

/** Truncate a session label (title or cwd) to a compact one-liner. */
function truncateLabel(label: string): string {
  // Title can contain quotes that would break the surrounding `"…"`.
  // Strip them and any control chars so the line is always well-formed.
  const cleaned = label.replace(/["\\\n\r\t]/g, " ").trim();
  if (cleaned.length === 0) return "(untitled)";
  return truncate(cleaned, MAX_LABEL_LEN);
}

/**
 * Quote a label for embedding in the `/session switch <arg>` hint.
 *
 * The `/session switch` command accepts a numeric index OR the full
 * session id (it doesn't accept titles — see `parseSessionCommand`).
 * So the hint uses the id when the label looks like one, otherwise
 * we emit the label verbatim and rely on the user running
 * `/session list` first to discover the index. We always quote the
 * label to handle spaces / CJK characters safely.
 */
function quoteForHint(label: string): string {
  if (/^ses_[A-Za-z0-9]+$/.test(label)) return label;
  return `"${label}"`;
}

/** Truncate `s` to `max` characters, appending `…` if shortened. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

/**
 * Re-export `SessionStatus` for callers that want to do their own
 * status-string extraction without depending on `src/types/events.js`
 * directly. The notifier uses this only for typing.
 */
export type { SessionStatus };
