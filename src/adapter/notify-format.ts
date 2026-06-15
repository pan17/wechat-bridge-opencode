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
 * act on without further context: a direct `/session switch <n>` hint with
 * the session's position in the most recent `/session list` output would
 * be ideal, but the bridge doesn't know that index at notification time
 * (the list is request-scoped and could be stale). Instead we name the
 * session by title (or id fallback) AND show its working directory, and
 * tell the user to run `/session list` to find the index for switching.
 *
 * Why a label cache and not just the session id: the user has no
 * mental model for `ses_abc123…` but a strong mental model for
 * "fix-auth-bug" or "/Users/me/repos/api". The bridge looks up
 * titles (and the working directory) via `client.getSession(id)`
 * (cached in SessionNotifier).
 *
 * Why include the working directory: when multiple sessions are alive
 * the title alone can be ambiguous (e.g. two sessions both titled
 * "fix-auth-bug" in different repos). Showing the path disambiguates
 * and lets the user confidently decide which session to switch to.
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
 *
 * `sessionDirectory` is optional — the notifier may not have completed
 * the title/directory fetch yet, or the opencode server may not return
 * a directory for the session. When absent, the path line is omitted
 * from the rendered output (no placeholder noise).
 *
 * `sessionAgent` + `sessionParentID` disambiguate sub-agent sessions
 * from root sessions. When `sessionParentID` is set, the notification
 * gets a `🤖 <agent>` marker in the title line so the user knows
 * they're being paged by a `task`-tool subagent (vs the root agent of
 * the named session). Both are optional — older opencode server
 * versions or unit-test mocks may omit them.
 */
export type OtherSessionNotice =
  | {
      kind: "question";
      sessionLabel: string;
      sessionDirectory?: string;
      sessionAgent?: string;
      sessionParentID?: string;
      question: QuestionPrompt;
    }
  | {
      kind: "permission";
      sessionLabel: string;
      sessionDirectory?: string;
      sessionAgent?: string;
      sessionParentID?: string;
      permission: PermissionRequest;
    }
  | {
      kind: "error";
      sessionLabel: string;
      sessionDirectory?: string;
      sessionAgent?: string;
      sessionParentID?: string;
      errorMessage: string;
    }
  | {
      kind: "completion";
      sessionLabel: string;
      sessionDirectory?: string;
      sessionAgent?: string;
      sessionParentID?: string;
    };

/** Max title length to keep notifications compact. */
const MAX_LABEL_LEN = 60;
/** Max question/error text length in the one-liner. */
const MAX_BODY_LEN = 120;
/** Max working-directory length. Paths can be long; cap to keep one line readable. */
const MAX_DIR_LEN = 80;

/**
 * Format an `OtherSessionNotice` as a single WeChat message.
 *
 * Output shapes (title + working dir + action, matching the question
 * card and permission card style). The `📂 ...` directory line is
 * omitted when `sessionDirectory` is absent (no `📂 (unknown)` noise).
 *
 *   📨 Session "fix-auth-bug"
 *      📂 F:\opencodeproject\api
 *      等待你的输入
 *      Q: 用 OAuth 还是 JWT?
 *      /session list 看看其他会话
 *
 *   🔐 Session "deploy-prod"
 *      📂 F:\opencodeproject\infra
 *      等待权限: bash
 *      npm run deploy
 *      /session list 看看其他会话
 *
 *   ❌ Session "migrate-db"
 *      📂 F:\opencodeproject\db
 *      rate limit exceeded
 *      /session list 看看其他会话
 *
 *   ✅ Session "fix-auth-bug"
 *      📂 F:\opencodeproject\api
 *      已完成
 */
export function formatOtherSessionNotification(notice: OtherSessionNotice): string {
  const label = truncateLabel(notice.sessionLabel);
  const dirLine = formatDirectoryLine(notice.sessionDirectory);
  const subAgentMarker = formatSubAgentMarker(notice.sessionParentID, notice.sessionAgent);
  // /session switch only accepts a numeric index (not a title or id) —
  // pointing the user at /session list keeps the hint honest and
  // discoverable. See parseSessionCommand in src/adapter/workspace-cmd.ts.
  const switchHint = "   /session list 看看其他会话";

  switch (notice.kind) {
    case "question": {
      const firstQ = notice.question.question || "(empty question)";
      const truncatedQ = truncate(firstQ, MAX_BODY_LEN);
      return `📨 Session "${label}"${subAgentMarker}\n${dirLine}   等待你的输入\n   Q: ${truncatedQ}\n${switchHint}`;
    }
    case "permission": {
      const tool = notice.permission.permission;
      const patterns = notice.permission.patterns;
      const detail = patterns.length > 0 ? truncate(patterns.join(", "), MAX_BODY_LEN) : tool;
      return `🔐 Session "${label}"${subAgentMarker}\n${dirLine}   等待权限: ${tool}\n   ${detail}\n${switchHint}`;
    }
    case "error": {
      const detail = notice.errorMessage ? truncate(notice.errorMessage, MAX_BODY_LEN) : "(unknown error)";
      return `❌ Session "${label}"${subAgentMarker}\n${dirLine}   ${detail}\n${switchHint}`;
    }
    case "completion": {
      return `✅ Session "${label}"${subAgentMarker}\n${dirLine}   已完成`;
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

/** Truncate a session label (title or id fallback) to a compact one-liner. */
function truncateLabel(label: string): string {
  // Title can contain quotes that would break the surrounding `"…"`.
  // Strip them and any control chars so the line is always well-formed.
  const cleaned = label.replace(/["\\\n\r\t]/g, " ").trim();
  if (cleaned.length === 0) return "(untitled)";
  return truncate(cleaned, MAX_LABEL_LEN);
}

/**
 * Render the working-directory line (`   📂 /path`) or return `""`
 * when the directory is missing/empty. Trimmed and stripped of newlines
 * so it always renders on a single line.
 */
function formatDirectoryLine(directory: string | undefined): string {
  if (!directory) return "";
  const cleaned = directory.replace(/[\n\r\t]/g, " ").trim();
  if (cleaned.length === 0) return "";
  return `   📂 ${truncate(cleaned, MAX_DIR_LEN)}\n`;
}

/**
 * Render the sub-agent marker for the title line. Returns `""` for
 * root sessions, `" · 🤖 <agent>"` for sub-agent sessions that have
 * an agent name, and `" · 🤖 sub-agent"` for sub-agent sessions
 * whose agent name wasn't reported. The marker is intentionally
 * appended to the title line (not a separate `🤖 …` line) so the
 * 4 notification kinds stay compact and visually consistent.
 */
function formatSubAgentMarker(parentID: string | undefined, agent: string | undefined): string {
  if (!parentID) return "";
  const cleanedAgent = agent ? agent.replace(/[\n\r\t]/g, " ").trim() : "";
  const name = cleanedAgent || "sub-agent";
  // Keep the marker compact (cap agent name length) so a long custom
  // agent name doesn't blow up the title line. We re-use MAX_LABEL_LEN
  // as a sanity cap — agent names are typically short anyway.
  return ` · 🤖 ${truncate(name, MAX_LABEL_LEN)}`;
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
