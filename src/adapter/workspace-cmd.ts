/**
 * Parse workspace and session commands from WeChat messages.
 *
 * Workspace commands (/workspace or /ws):
 *   list                          — List all workspaces
 *   add /path [name]              — Add a workspace
 *   switch <name|id>              — Switch to a workspace
 *   remove <name|id>              — Remove a workspace
 *   status                        — Show current workspace
 *
 * Session commands (/session or /s):
 *   new [name]                    — Create a new session
 *   switch <name|id>              — Switch to an existing session
 *   remove <name|id>              — Remove a session
 *   list                          — List all sessions
 *   status                        — Show current session info
 */

import type { McpServerStatus, VcsInfo } from "../types.js";
import type { MessageResponse } from "../types.js";
import type { SessionStatus, TextPart as EventTextPart } from "../types/events.js";
import type { NotifySettings } from "../config.js";

export interface WorkspaceCommand {
  kind: "list" | "add" | "switch" | "remove" | "status";
  path?: string;
  name?: string;
}

export interface SessionCommand {
  kind: "new" | "switch" | "remove" | "list" | "status";
  name?: string;
  cwdFilter?: string;  // When set, filter sessions by this cwd
}

export interface AgentCommand {
  kind: "list" | "switch" | "status";
  name?: string;
}

export interface ModelCommand {
  kind: "list" | "switch" | "status";
  name?: string;
  provider?: string;
}

export interface ReasoningCommand {
  kind: "list" | "switch" | "status";
  name?: string;
}

export interface StatusCommand {
  kind: "status";
}

export interface ThoughtDisplayCommand {
  kind: "status" | "on" | "off";
}

export interface ToolDisplayCommand {
  kind: "status" | "on" | "off";
}

export interface StopCommand {
  kind: "stop";
}

/**
 * `/compact` (alias `/summarize`) — trigger OpenCode Server's context
 * compaction for the current session via `POST /session/:id/summarize`.
 * Mirrors the TUI's `/compact` slash command and Claude Code's `/compact`.
 * The command is force-triggered: we always send the request even if the
 * session's current context is well below the server's auto-compact
 * threshold, because the user explicitly asked for it. See
 * `.omo/plans/compact-command-design.md` for rationale.
 */
export interface CompactCommand {
  kind: "compact";
}

export interface VersionCommand {
  kind: "version";
}

export interface RestartCommand {
  kind: "restart";
}

/**
 * `/reject-question` (alias `/rq`) — explicitly dismiss a pending question
 * from the LLM. Only meaningful when `pendingQuestion` is non-null on the
 * SessionManager (otherwise no-op). See `.omo/plans/question-tool-design.md`
 * §10.3 and §14 Q2.
 */
export interface RejectQuestionCommand {
  kind: "reject-question";
}

/**
 * `/reject-permission` (alias `/rp`) — explicitly dismiss a pending
 * permission card (replies `reject` for every pending request). Only
 * meaningful when `pendingPermissions` is non-empty on the
 * SessionManager (otherwise no-op). See
 * `.omo/plans/permission-tool-design.md` §8.2.
 */
export interface RejectPermissionCommand {
  kind: "reject-permission";
}

/**
 * `/auto-permission` (alias `/ap`) — toggle the auto-accept mode for
 * OpenCode permission requests. Three modes:
 *   - `off`   — show a WeChat card on every permission request (default)
 *   - `once`  — auto-reply `"once"` without showing a card
 *   - `always` — auto-reply `"always"` (server stores an in-memory rule)
 *
 * Without subcommand or with `status`, reports the current mode. The
 * setting persists across bridge restarts in
 * `.wechat-bridge-state.json`.
 */
export interface AutoPermissionCommand {
  kind: "auto-permission";
  mode: "off" | "once" | "always" | "status";
}

/**
 * `/notify` (alias `/n`) — configure the cross-session notification
 * feature. When enabled, the bridge forwards events from OTHER (non-
 * current) sessions on the OpenCode Server to WeChat, so the user
 * knows when a long-running background session needs attention or has
 * finished. Mirrors OpenCode Desktop's notification UX.
 *
 * Three subcommands:
 *   - `/notify on|off`                  — master switch
 *   - `/notify status`                  — show current settings
 *   - `/notify types <type> on|off`     — per-event-type toggle
 *
 * `<type>` is one of `question` | `permission` | `error` | `completion`.
 * The setting persists across bridge restarts in
 * `.wechat-bridge-state.json`.
 */
export interface NotifyCommand {
  kind: "notify";
  mode: "on" | "off" | "status";
  type?: "question" | "permission" | "error" | "completion";
}

/**
 * `/history` (alias `/hist`) — show the most recent N messages from the
 * current session, in chronological order. The bridge has no native
 * chat history view in WeChat (a turn's text streams in via SSE and is
 * never re-summarized on disk), so this command gives the user a
 * one-shot "what did we just talk about" view, useful after switching
 * sessions or returning to the bot after a long absence.
 *
 * Optional trailing positive integer N: default 5, clamped 1-20 at
 * render time. The parser itself rejects 0, negatives, and >20 as
 * ambiguous — the user explicitly asked for "exactly N", and a typo
 * ("9999") would otherwise silently clamp to 20 and look like a bug.
 */
export interface HistoryCommand {
  kind: "history";
  /** Always defined after parsing; default 5, range 1-20. */
  count: number;
}

export function parseWorkspaceCommand(text: string): WorkspaceCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:workspace|ws)\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };

    case "status":
    case "current":
      return { kind: "status" };

    case "add": {
      const pathArg = args[1];
      if (!pathArg) return null;
      return { kind: "add", path: pathArg, name: args.slice(2).join(" ") || undefined };
    }

    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }

    case "remove":
    case "rm":
    case "delete":
    case "del": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "remove", name: target };
    }

    default:
      return null;
  }
}

export function parseSessionCommand(text: string): SessionCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:session|s)\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "new":
    case "create":
      return { kind: "new", name: args.slice(1).join(" ") || undefined };

    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }

    case "remove":
    case "rm":
    case "delete":
    case "del": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "remove", name: target };
    }

    case "list":
    case "ls": {
      // /s list                  → no filter (shows all, newest first)
      // /s list current          → filter by current workspace
      // /s list --cwd            → filter by current workspace
      // /s list /path/to/cwd     → filter by specific cwd
      const hasCwdFlag = args.includes("--cwd");
      let cwdFilter: string | undefined;
      if (hasCwdFlag) {
        cwdFilter = "__current__";
      } else if (args.length > 1) {
        const filterValue = args.slice(1).join(" ");
        if (filterValue === "current") {
          cwdFilter = "__current__";
        } else if (filterValue) {
          cwdFilter = filterValue;
        }
      }
      return { kind: "list", cwdFilter };
    }

    case "status":
    case "current":
    case "info":
      return { kind: "status" };

    default:
      return null;
  }
}

export function parseAgentCommand(text: string): AgentCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/(?:agent|a)\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseModelCommand(text: string): ModelCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/model\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls": {
      const provider = args.slice(1).join(" ").trim() || undefined;
      return { kind: "list", provider };
    }
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseReasoningCommand(text: string): ReasoningCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/reasoning\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "list":
    case "ls":
      return { kind: "list" };
    case "switch":
    case "sw":
    case "use": {
      const target = args.slice(1).join(" ");
      if (!target) return null;
      return { kind: "switch", name: target };
    }
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseStatusCommand(text: string): StatusCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/status") {
    return { kind: "status" };
  }
  return null;
}

export function parseThoughtDisplayCommand(text: string): ThoughtDisplayCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/thought-display\s+(on|off|status|enable|disable)\s*$/i);
  if (!match) return null;

  const subcommand = match[1].toLowerCase();

  switch (subcommand) {
    case "on":
    case "enable":
      return { kind: "on" };
    case "off":
    case "disable":
      return { kind: "off" };
    case "status":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseToolDisplayCommand(text: string): ToolDisplayCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/tool-display\s+(on|off|status|enable|disable)\s*$/i);
  if (!match) return null;

  const subcommand = match[1].toLowerCase();

  switch (subcommand) {
    case "on":
    case "enable":
      return { kind: "on" };
    case "off":
    case "disable":
      return { kind: "off" };
    case "status":
      return { kind: "status" };
    default:
      return null;
  }
}

export function parseStopCommand(text: string): StopCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/stop") {
    return { kind: "stop" };
  }
  return null;
}

/**
 * Parse `/compact` (or alias `/summarize`) — manually trigger context
 * compaction for the current OpenCode session. Only matches the bare
 * command; trailing args are rejected so the parser doesn't swallow
 * `/compact foo` or `/summarize now` (those are user-typed messages,
 * not this command). `/compaction` (with the trailing `ion`) is also
 * rejected — that's a different OpenCode native command, if it ever
 * appears, and we don't want to silently hijack it.
 */
export function parseCompactCommand(text: string): CompactCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/compact" || trimmed === "/summarize") {
    return { kind: "compact" };
  }
  return null;
}

export function parseVersionCommand(text: string): VersionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/version") {
    return { kind: "version" };
  }
  return null;
}

export function parseRestartCommand(text: string): RestartCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/restart") {
    return { kind: "restart" };
  }
  return null;
}

/**
 * Parse `/reject-question` (or short alias `/rq`) to dismiss a pending
 * question. Only matches the bare command — no extra args allowed. The
 * dispatcher (bridge.handleQuestionReply) treats this as a priority
 * command: if a question is pending, it rejects first, then optionally
 * resumes the normal flow (currently: just sends a confirmation message).
 */
export function parseRejectQuestionCommand(text: string): RejectQuestionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-question" || trimmed === "/rq") {
    return { kind: "reject-question" };
  }
  return null;
}

/**
 * Parse `/reject-permission` (or short alias `/rp`) to dismiss a
 * pending permission card. Only matches the bare command — no extra
 * args allowed. The dispatcher (bridge.handlePermissionReply) treats
 * this as a priority command: if permissions are pending, it rejects
 * all of them, then sends a confirmation message.
 */
export function parseRejectPermissionCommand(text: string): RejectPermissionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/reject-permission" || trimmed === "/rp") {
    return { kind: "reject-permission" };
  }
  return null;
}

/**
 * Parse `/auto-permission` (or short alias `/ap`) to query or change
 * the auto-accept mode. Three subcommands:
 *
 *   `/auto-permission`           → status (default mode)
 *   `/auto-permission off`       → turn off (back to WeChat cards)
 *   `/auto-permission once`      → auto-allow per call only
 *   `/auto-permission always`    → auto-allow + persist server-side rules
 *   `/auto-permission status`    → show current mode
 *
 * Returns null for unrecognized subcommands (so the dispatcher can
 * fall through to a regular slash-command hint).
 */
export function parseAutoPermissionCommand(text: string): AutoPermissionCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "/auto-permission" || trimmed === "/ap") {
    return { kind: "auto-permission", mode: "status" };
  }
  const m = trimmed.match(/^\/(?:auto-permission|ap)\s+(off|once|always|status)\s*$/);
  if (!m) return null;
  return { kind: "auto-permission", mode: m[1] as "off" | "once" | "always" | "status" };
}

/**
 * Parse `/notify` (or short alias `/n`) to configure cross-session
 * notifications. Three sub-shapes:
 *
 *   `/notify`                → { kind: "notify", mode: "status" }  (default: show current settings)
 *   `/notify on|off|status`  → { kind: "notify", mode: … }
 *   `/notify types <type> on|off`  → { kind: "notify", mode: "on"|"off", type: … }
 *
 * `<type>` is one of `question` | `permission` | `error` | `completion`.
 * The bare `/notify` defaults to `status` so users get a readout of
 * their current configuration without having to type the subcommand.
 * Returns null for unrecognized input so the dispatcher can fall
 * through to the regular "unknown slash command" hint.
 */
export function parseNotifyCommand(text: string): NotifyCommand | null {
  const trimmed = text.trim().toLowerCase();
  // Bare command → status (most common entry point: "what's my notify config?")
  if (trimmed === "/notify" || trimmed === "/n") {
    return { kind: "notify", mode: "status" };
  }
  // /notify on|off|status
  const m1 = trimmed.match(/^\/(?:notify|n)\s+(on|off|status)\s*$/);
  if (m1) {
    return { kind: "notify", mode: m1[1] as "on" | "off" | "status" };
  }
  // /notify types <type> on|off
  const m2 = trimmed.match(
    /^\/(?:notify|n)\s+types\s+(question|permission|error|completion)\s+(on|off)\s*$/,
  );
  if (m2) {
    return {
      kind: "notify",
      mode: m2[2] as "on" | "off",
      type: m2[1] as "question" | "permission" | "error" | "completion",
    };
  }
  return null;
}

/** Inclusive lower bound for `/history N` count. */
const HISTORY_COUNT_MIN = 1;
/** Inclusive upper bound for `/history N` count. */
const HISTORY_COUNT_MAX = 20;
/** Default count when `/history` is invoked without a number. */
const HISTORY_COUNT_DEFAULT = 5;

/**
 * Parse `/history` (or short alias `/hist`) to fetch the most recent N
 * messages from the current session. Accepts a single optional trailing
 * positive integer; anything else (non-numeric, zero, negative, >20,
 * extra trailing args) is rejected so the dispatcher can fall through
 * to the "unknown slash command" hint or forward the input to the agent
 * — we don't want `/history 9999` to silently clamp to 20, or
 * `/history abc` to match the bare default. Case-insensitive.
 */
export function parseHistoryCommand(text: string): HistoryCommand | null {
  const trimmed = text.trim();
  // Bare `/history` (or `/hist`) → default count.
  if (/^\/(?:history|hist)\s*$/i.test(trimmed)) {
    return { kind: "history", count: HISTORY_COUNT_DEFAULT };
  }
  // `/history N` (or `/hist N`) — N must be an integer in [1, 20].
  const m = trimmed.match(/^\/(?:history|hist)\s+(\d+)\s*$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < HISTORY_COUNT_MIN || n > HISTORY_COUNT_MAX) {
    // 0, negative, or >20 — reject explicitly per the strict-N contract.
    return null;
  }
  return { kind: "history", count: n };
}

export function formatWorkspaceList(
  workspaces: Array<{ cwd: string }>,
  activeCwd: string | null,
  /**
   * Maximum number of entries to render. When the input has more entries,
   * the extras are dropped and an explicit truncation hint is appended so
   * the user knows they can still reach the rest with `/workspace switch
   * <path>`. Default is `Infinity` (no cap) so existing callers that don't
   * care about WeChat's display budget keep their behavior.
   */
  maxCount: number = Infinity,
): string {
  if (workspaces.length === 0) return "No workspaces configured.";

  const truncated = workspaces.length > maxCount;
  const shown = truncated ? workspaces.slice(0, maxCount) : workspaces;

  const lines = ["📂 Workspaces:"];
  for (let i = 0; i < shown.length; i++) {
    const ws = shown[i];
    const marker = ws.cwd === activeCwd ? " ◀" : "";
    lines.push(`  ${i + 1}. ${ws.cwd}${marker}`);
  }
  lines.push("");
  if (truncated) {
    lines.push(`（仅显示最近 ${maxCount} 个，共 ${workspaces.length} 个）`);
    lines.push("");
  }
  lines.push("💡 使用 /workspace switch <路径> 或编号 切换工作区");
  lines.push("   路径未列出？直接 /workspace switch <完整路径> 也能切换");
  return lines.join("\n");
}

export function formatWorkspaceStatus(name: string, id: string, cwd: string): string {
  return `📂 Current workspace:\n  ${name} (${id})\n  ${cwd}`;
}

export function formatSessionList(
  sessions: Array<{ id: string; name: string; workspaceId: string; workspaceName?: string }>,
  activeId: string | null,
  workspaces: Array<{ id: string; name: string }> = [],
): string {
  if (sessions.length === 0) return "No sessions.";

  // Group sessions by workspace
  const wsMap = new Map<string, { name: string; sessions: Array<{ id: string; name: string; workspaceId: string; workspaceName?: string }> }>();
  for (const s of sessions) {
    const wsName = s.workspaceName || s.workspaceId;
    if (!wsMap.has(s.workspaceId)) {
      const ws = workspaces.find((w) => w.id === s.workspaceId);
      wsMap.set(s.workspaceId, { name: ws?.name ?? wsName, sessions: [] });
    }
    wsMap.get(s.workspaceId)!.sessions.push(s);
  }

  const lines: string[] = [];
  for (const [wsId, group] of wsMap) {
    lines.push(`📂 ${group.name} (${wsId}):`);
    for (const s of group.sessions) {
      const prefix = s.id === activeId ? "  ▶ " : "    ";
      lines.push(`${prefix}${s.name} (${s.id})`);
    }
  }
  return lines.join("\n");
}

export function formatStatus(opts: {
  session: { title?: string; id: string; cwd: string } | null;
  workspace: string;
  agent: string;
  model: string;
  reasoning: string;
  contextUsage: { used: number; size: number } | null;
  /**
   * MCP server status map (name → status). Omit (or pass `null`) to skip
   * the MCP section entirely — useful when the call hasn't been made yet
   * or the server doesn't expose the endpoint. Sorted by status (problems
   * first) then alphabetically for stable output.
   */
  mcpStatus?: Record<string, McpServerStatus> | null;
  /**
   * Current session's agent status (driven by SSE `session.status` events).
   *   - `undefined`/`null` → no SSE event has arrived yet (or server is
   *     unreachable) → render `⚪ Agent: (unknown)`.
   *   - `{ type: "busy" }` → `🟢 Agent: Running`.
   *   - `{ type: "idle" }` → `⚪ Agent: Idle`.
   *   - `{ type: "retry", attempt?: N }` → `🟡 Agent: Retrying (attempt N)`
   *     (defaults to attempt 1 when `attempt` is missing).
   */
  agentStatus?: SessionStatus | null;
  /**
   * Number of OTHER root sessions on the OpenCode Server that are
   * currently `busy` (excludes the current session and any sub-agent /
   * child sessions). Surfaced as the `📈 Other running sessions: N`
   * line. Omit (or pass `null`) to render `📈 Other running sessions:
   * (unknown)` — the safe placeholder when the call hasn't been made
   * or failed. A finite non-negative number always renders (including
   * `0`), per user-facing design.
   */
  otherBusySessions?: number | null;
  /**
   * Cross-session notification settings. Surfaced as a single compact
   * line — `🔔 Notify: ✅ On (q ✅ p ✅ e ✅ c ✅)` — so the user can
   * see at a glance whether other-session events are being pushed and
   * which categories are active. Pass `undefined` to omit the line
   * (rendered when the bridge hasn't loaded settings yet, e.g. when
   * the notifier is null). See `src/config.ts#NotifySettings` and
   * `src/notifier.ts` for the feature.
   */
  notifySettings?: NotifySettings | null;
  /**
   * VCS (git) info for the current workspace, fetched via
   * `GET /vcs?directory=<workspace>` on the OpenCode Server. Rendered
   * as a single `🌿 Branch: <branch> (default: <defaultBranch>)` line
   * right after the workspace line. Render rules:
   *   - `undefined` → omit the line (network/parse failure)
   *   - `{ branch: null, defaultBranch: null }` → render
   *     `🌿 Branch: (not a git repo)` (server returned 200 with nulls)
   *   - `{ branch: "<b>", defaultBranch: "<d>" }` →
   *     `🌿 Branch: <b> (default: <d>)` — omit the `(default: …)`
   *     suffix when `defaultBranch` is null OR equal to `branch`
   *     (no useful info in the redundancy).
   */
  vcs?: VcsInfo | null;
}): string {
  const lines: string[] = ["📊 Status:"];

  // Session
  if (opts.session) {
    lines.push(`  💬 Session: ${opts.session.title ?? "(untitled)"}`);
    lines.push(`     ID: ${opts.session.id}`);
  } else {
    lines.push(`  💬 Session: (none)`);
  }

  // Workspace
  lines.push(`  📂 Workspace: ${opts.workspace}`);

  // Branch (git). Placed right after Workspace so the operator sees the
  // workspace path + branch together — they're conceptually the same
  // "where am I working?" unit. Three-state contract:
  //   - `undefined` → omit the line entirely (network failure / not
  //     fetched; we can't say anything meaningful).
  //   - `null`      → server returned 200 with nulls (non-git dir) →
  //     render `🌿 Branch: (not a git repo)` so the user knows we asked.
  //   - object      → render branch (and default, when it differs).
  // Equal branch/default is collapsed so we don't print redundant info
  // like "Branch: main (default: main)".
  if (opts.vcs !== undefined) {
    if (opts.vcs === null || opts.vcs.branch === null) {
      lines.push("  🌿 Branch: (not a git repo)");
    } else {
      const b = opts.vcs.branch;
      const d = opts.vcs.defaultBranch;
      if (d && d !== b) {
        lines.push(`  🌿 Branch: ${b} (default: ${d})`);
      } else {
        lines.push(`  🌿 Branch: ${b}`);
      }
    }
  }

  // Agent
  lines.push(`  🤖 Agent: ${opts.agent}`);

  // Model
  lines.push(`  📱 Model: ${opts.model}`);

  // Reasoning
  lines.push(`  🧠 Reasoning: ${opts.reasoning}`);

  // Agent status (SSE-driven busy / idle / retry). Render BEFORE the MCP
  // section so the operator sees whether THIS session is mid-turn right
  // after the agent/model/reasoning triple.
  if (opts.agentStatus) {
    switch (opts.agentStatus.type) {
      case "busy":
        lines.push("  🟢 Agent: Running");
        break;
      case "idle":
        lines.push("  ⚪ Agent: Idle");
        break;
      case "retry":
        lines.push(`  🟡 Agent: Retrying (attempt ${opts.agentStatus.attempt ?? 1})`);
        break;
    }
  } else {
    lines.push("  ⚪ Agent: (unknown)");
  }

  // Count of other busy root sessions on the OpenCode Server.
  if (typeof opts.otherBusySessions === "number" && Number.isFinite(opts.otherBusySessions) && opts.otherBusySessions >= 0) {
    lines.push(`  📈 Other running sessions: ${opts.otherBusySessions}`);
  } else {
    lines.push("  📈 Other running sessions: (unknown)");
  }

  // Cross-session notification config (compact, one line). Letter codes
  // match the `/notify types <type>` grammar: q=question, p=permission,
  // e=error, c=completion. When disabled at the master level we omit
  // the per-type glyphs entirely so the user sees the master state
  // first and isn't misled by a "q ✅" that doesn't actually fire.
  if (opts.notifySettings) {
    const ns = opts.notifySettings;
    if (ns.enabled) {
      const t = ns.types;
      lines.push(
        `  🔔 Notify: ✅ On (q ${t.question ? "✅" : "❌"} p ${t.permission ? "✅" : "❌"} e ${t.error ? "✅" : "❌"} c ${t.completion ? "✅" : "❌"})`,
      );
    } else {
      lines.push("  🔔 Notify: ❌ Off   (use /notify on to enable)");
    }
  }

  // MCP servers (show all so the user can see what's loaded, with failures
  // surfaced prominently). Disabled servers are skipped — they're off by
  // configuration and not actionable.
  if (opts.mcpStatus) {
    const entries = Object.entries(opts.mcpStatus)
      .filter(([, s]) => s.status !== "disabled")
      .sort(([aName, aStatus], [bName, bStatus]) => {
        // Problems (failed/needs_auth/needs_client_registration) first so
        // the user notices them at a glance; otherwise alphabetical.
        const aBad = isProblemStatus(aStatus) ? 0 : 1;
        const bBad = isProblemStatus(bStatus) ? 0 : 1;
        return aBad - bBad || aName.localeCompare(bName);
      });
    if (entries.length === 0) {
      lines.push("  🧩 MCP: (none enabled)");
    } else {
      lines.push(`  🧩 MCP (${entries.length}):`);
      for (const [name, status] of entries) {
        lines.push(`     ${formatMcpLine(name, status)}`);
      }
    }
  }

  // Context usage
  if (opts.contextUsage && opts.contextUsage.size > 0) {
    const pct = Math.min(Math.round((opts.contextUsage.used / opts.contextUsage.size) * 100), 100);
    const bar = formatProgressBar(pct);
    lines.push(`  🔥 Context: ${formatNumber(opts.contextUsage.used)} / ${formatNumber(opts.contextUsage.size)} (${pct}%)`);
    lines.push(`     ${bar}`);
  } else if (opts.contextUsage) {
    // Have totalTokens but no context window size yet
    lines.push(`  🔥 Total Tokens: ${formatNumber(opts.contextUsage.used)}`);
  } else {
    lines.push(`  🔥 Context: (not available)`);
  }

  return lines.join("\n");
}

function isProblemStatus(s: McpServerStatus): boolean {
  return (
    s.status === "failed" ||
    s.status === "needs_auth" ||
    s.status === "needs_client_registration"
  );
}

function formatMcpLine(name: string, status: McpServerStatus): string {
  switch (status.status) {
    case "connected":
      return `✅ ${name}`;
    case "failed":
      return `❌ ${name} — ${truncate(status.error, 80)}`;
    case "needs_auth":
      return `🔐 ${name} — needs auth`;
    case "needs_client_registration":
      return `🔐 ${name} — ${truncate(status.error, 80)}`;
    case "disabled":
      // Filtered out by the caller; unreachable.
      return `⏸ ${name}`;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * Format the `/history` reply for WeChat. The input is the LAST N
 * messages returned by `GET /session/:id/message?limit=N`, which the
 * OpenCode Server returns OLDEST-FIRST (see
 * `packages/opencode/src/session/message-v2.ts:471` — the server does
 * its own `items.reverse()` after the `desc(time_created)` SQL query).
 * We display them in the same order (oldest at top, newest at bottom),
 * which is what people expect when reading a chat log.
 *
 * "history = chat log" contract:
 *   - Only text parts are surfaced; tool, reasoning, file, step-* and
 *     snapshot parts are skipped.
 *   - Messages with ZERO text parts (e.g. an assistant turn that was
 *     100% tool calls / reasoning — common with the Sisyphus
 *     ultraworker style) are FILTERED OUT ENTIRELY. We no longer
 *     render `(空消息)` placeholders, since the chat-log view doesn't
 *     need to know those turns existed (the user can always peek at
 *     the full transcript via `/compact` or the OpenCode TUI).
 *   - The header count reflects the FILTERED count, so the user sees
 *     exactly how many chat messages are in the rendered output.
 *
 * Output shape (chronological: oldest at top, newest at bottom):
 *
 *   📜 最近 3 条消息 (会话「xxx」· 工作区: F:\foo):
 *
 *   👤 [10:23:15] 你:
 *   {first 500 chars of concatenated text parts}
 *
 *   ───
 *   🤖 [10:23:42] build / anthropic/claude-sonnet-4-5:
 *   {first 500 chars}
 *   ───
 *   ...
 *
 * Edge cases:
 *   - `sessionId` is null → returns a "no active session" warning.
 *   - `messages` is empty (no messages at all) → returns "no messages yet".
 *   - All messages are empty (every turn was tool-only) → returns a
 *     "no text-bearing messages" notice instead of an empty header.
 *   - Each message's text parts are concatenated (a single assistant
 *     turn can have multiple text parts when a tool interrupts);
 *     truncation per-message keeps the total reply under the 4000-char
 *     WeChat budget.
 */
export function formatHistoryForWeChat(opts: {
  sessionId: string | null;
  messages: Array<{
    info: {
      role: "user" | "assistant";
      time?: { created?: number; completed?: number };
      agent?: string;
      /** Legacy nested shape — accepted but flat fields take precedence. */
      model?: { providerID: string; modelID: string };
      /** Actual OpenCode Server shape (Assistant schema, packages/core/src/v1/session.ts:464-465). */
      modelID?: string;
      providerID?: string;
    };
    parts: Array<{ type: "text"; text: string }>;
  }>;
  /** Current workspace cwd — surfaced in the header so the user knows which session this is. */
  cwd: string;
  /** Optional session title — surfaced in the header. Omitted when empty. */
  title?: string;
  /** The count the user actually asked for (default 5, 1-20). */
  maxCount: number;
}): string {
  if (opts.sessionId === null) {
    return "⚠️ 当前没有活动会话";
  }
  if (opts.messages.length === 0) {
    return "📜 当前会话暂无消息。";
  }

  // Filter to messages that actually carry visible text. We deliberately
  // skip the header + divider for a fully-empty turn — see the "history =
  // chat log" contract above. The 500-char truncation is per-message so
  // a single huge message can't blow the WeChat 4000-char budget.
  const rendered: Array<{ meta: string; body: string }> = [];
  for (const m of opts.messages) {
    const text = m.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    if (text.length === 0) continue;
    const truncated = text.length > 500 ? text.slice(0, 499) + "…" : text;
    if (m.info.role === "assistant") {
      // Assistant line carries the agent + model so the user can tell
      // which model produced each reply (a single session can switch
      // models via /model switch mid-conversation).
      const meta = formatAssistantMeta(
        m.info.agent,
        m.info.model,
        m.info.modelID,
        m.info.providerID,
      );
      const time = formatTime(m.info.time?.completed ?? m.info.time?.created);
      rendered.push({ meta: `🤖 [${time}] ${meta}:`, body: truncated });
    } else {
      const time = formatTime(m.info.time?.created);
      rendered.push({ meta: `👤 [${time}] 你:`, body: truncated });
    }
  }

  if (rendered.length === 0) {
    // Defense-in-depth — fetchAndFormatHistory normally intercepts
    // the all-empty case before reaching here. If we DO get here, it's
    // because someone called formatHistoryForWeChat directly with a
    // pre-filtered empty list.
    return `📜 最近 ${opts.maxCount} 条消息 (工作区: ${opts.cwd}):\n\n(本次范围内全部是工具/推理轮，没有文本回复)`;
  }

  // Header — single-line, with session title (truncated) and cwd so the
  // user can tell at a glance which conversation they're reading. The
  // count is always the REQUESTED count (matches what the user typed
  // like `/history 5`) so the number lines up with the slash command.
  // When we couldn't satisfy the full request (e.g. over-fetched 30 raw
  // messages but only found 3 with text), append a parenthetical hint so
  // the user isn't confused by the shorter rendered list.
  const titlePart = opts.title && opts.title.trim().length > 0
    ? `会话「${truncate(opts.title.trim(), 40)}」· `
    : "";
  const countLabel = rendered.length < opts.maxCount
    ? `${opts.maxCount} 条消息 (实际显示 ${rendered.length} 条)`
    : `${opts.maxCount} 条消息`;
  const lines: string[] = [];
  lines.push(`📜 最近 ${countLabel} (${titlePart}工作区: ${opts.cwd}):`);
  lines.push("");

  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    lines.push(r.meta);
    // Preserve user-typed line breaks (we split on \n). Indent each
    // body line by 2 spaces for visual nesting under the header.
    for (const bodyLine of r.body.split("\n")) {
      lines.push(`  ${bodyLine}`);
    }
    if (i < rendered.length - 1) {
      lines.push("");
      lines.push("───");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatTime(epochMs: number | undefined): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return "--:--:--";
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  // Local-time HH:MM:SS — matches the format the user sees in their
  // WeChat client and the session UI.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Format the assistant meta line (`agent / provider/model`).
 *
 * Reads the model from FLAT fields (`info.modelID` + `info.providerID`) — the
 * actual shape returned by the OpenCode Server per the Assistant schema at
 * `packages/core/src/v1/session.ts:455-487`. The older nested
 * `info.model = { providerID, modelID }` shape is accepted as a fallback
 * for any caller that still hands us a session-manager-style object.
 */
function formatAssistantMeta(
  agent: string | undefined,
  infoModel: { providerID: string; modelID: string } | undefined,
  flatModelID: string | undefined,
  flatProviderID: string | undefined,
): string {
  const agentName = agent ?? "assistant";
  const providerID = flatProviderID ?? infoModel?.providerID;
  const modelID = flatModelID ?? infoModel?.modelID;
  const modelName = providerID && modelID
    ? `${providerID}/${modelID}`
    : "(model unknown)";
  return `${agentName} / ${modelName}`;
}

function formatProgressBar(pct: number): string {
  const total = 20;
  const filled = Math.round((pct / 100) * total);
  const empty = total - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function formatNumber(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Check if a message is a help command.
 */
export function parseHelpCommand(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  return trimmed === "/help" || trimmed === "/h" || trimmed === "/?";
}

/**
 * Format the help message listing all available commands.
 *
 * Section ordering: 状态 is intentionally placed first (right after the
 * title) so it's the most prominent entry — `/status` is the single
 * command users reach for most often when reconnecting mid-session.
 */
export function formatHelp(): string {
  return [
    "📖 可用命令：",
    "",
    "── 状态 ──",
    "  /status                  显示会话标题、工作区、Agent、模型、推理、上下文用量",
    "",
    "── 工作区 ──",
    "  /workspace list          列出所有工作区（按活跃度排序）",
    "  /workspace status        显示当前工作区",
    "  /workspace switch <路径>  切换到指定目录",
    "  /workspace add <路径>    添加并切换到目录",
    "  （简写: /ws ...）",
    "",
    "── 会话 ──",
    "  /session list            列出最近 20 个会话",
    "  /session list current    列出当前工作区的会话",
    "  /session switch <n>      切换到指定会话（自动切换工作区）",
    "  /session new             新会话（清除上下文）",
    "  /session status          显示当前会话",
    "  （简写: /s ...）",
    "",
    "── Agent ──",
    "  /agent list              列出可用 Agent（仅 primary 非内置）",
    "  /agent switch <name|n>   切换 Agent",
    "  /agent status            显示当前 Agent",
    "  （简写: /a ...）",
    "",
    "── Model ──",
    "  /model list              列出模型提供商",
    "  /model list <provider>   列出指定提供商下的模型",
    "  /model switch <provider/model>  切换模型",
    "  /model status            显示当前模型",
    "",
"── Reasoning ──",
    "  /reasoning list          列出当前模型的实际推理等级",
    "  /reasoning switch <level|default>  切换推理级别（`default` 清除，让 server 选默认）",
    "  /reasoning status        显示当前推理级别",
    "",
    "── 停止 ──",
    "  /stop                    停止正在运行的 Agent",
    "  /restart                 重启 OpenCode Server（外部 server 时仅新建会话）",
    "",
    "── Context ──",
    "  /compact                 压缩当前会话的上下文（用当前 model 调用 server summarize）",
    "  （简写: /summarize）",
    "",
    "── 历史 ──",
    "  /history                 显示当前会话最近 5 条消息（user/assistant，仅文本）",
    "  /history <N>             显示最近 N 条消息（N: 1-20）",
    "  （简写: /hist ...）",
    "",
    "── 系统 ──",
    "  /version                 查询 Bridge、OpenCode Server 与 npm 上最新版本",
    "",
    "── 思考显示 ──",
    "  /thought-display on     开启思考内容显示（默认）",
    "  /thought-display off    关闭思考内容显示",
    "  /thought-display status 查看当前显示设置",
    "",
    "── 工具显示 ──",
    "  /tool-display on        开启工具调用摘要（默认）",
    "  /tool-display off       关闭工具调用摘要",
    "  /tool-display status    查看当前显示设置",
    "",
    "── 消息计数 ──",
    "  /next                    重置微信连续发送消息计数（不转发给 Agent）",
    "",
    "── Question ──",
    "  /reject-question         显式拒绝当前等待中的 LLM 问题（仅在有 pending question 时有效）",
    "  （简写: /rq）",
    "",
    "── Permission ──",
    "  /reject-permission       显式拒绝当前等待中的工具权限请求（仅在有 pending permission 时有效）",
    "  （简写: /rp）",
    "  /auto-permission         切换权限自动接收模式: off | once | always | status",
    "  （简写: /ap）",
    "",
    "── 通知 ──",
    "  /notify                  推送其他正在运行的 OpenCode 会话事件到微信",
    "  /notify on|off           总开关（默认 on）",
    "  /notify status           查看当前配置",
    "  /notify types <type> on|off  切换单个事件 (question/permission/error/completion)",
    "  （简写: /n ...）",
    "",
    "  /help                    显示本帮助信息",
  ].join("\n");
}

/**
 * Format help message including OpenCode native slash commands from available_commands_update.
 *
 * Section ordering mirrors `formatHelp`: 状态 first so `/status` is the
 * most visible command for users reconnecting mid-session.
 */
export function formatHelpWithNativeCommands(nativeCommands: Array<{ name: string; description: string }>): string {
  const lines = [
    "📖 可用命令：",
    "",
    "── 状态 ──",
    "  /status                  显示会话标题、工作区、Agent、模型、推理、上下文用量",
    "",
    "── 工作区 ──",
    "  /workspace list          列出所有工作区（按活跃度排序）",
    "  /workspace status        显示当前工作区",
    "  /workspace switch <路径>  切换到指定目录",
    "  /workspace add <路径>    添加并切换到目录",
    "  （简写: /ws ...）",
    "",
    "── 会话 ──",
    "  /session list            列出最近 20 个会话",
    "  /session list current    列出当前工作区的会话",
    "  /session switch <n>      切换到指定会话（自动切换工作区）",
    "  /session new             新会话（清除上下文）",
    "  /session status          显示当前会话",
    "  （简写: /s ...）",
    "",
    "── Agent ──",
    "  /agent list              列出可用 Agent（仅 primary 非内置）",
    "  /agent switch <名称|n>   按名称或序号切换 Agent",
    "  /agent status            显示当前 Agent",
    "  （简写: /a ...）",
    "",
    "── Model ──",
    "  /model list              列出模型提供商",
    "  /model list <provider>   列出指定提供商下的所有模型",
    "  /model switch <provider/model>  切换模型（如 anthropic/claude-sonnet-4-5）",
    "  /model status            显示当前模型",
    "",
    "── Reasoning ──",
    "  /reasoning list          列出当前模型的实际推理等级",
    "  /reasoning switch <level|default>  切换推理级别（`default` 清除，让 server 选默认）",
    "  /reasoning status        显示当前推理级别",
    "",
    "── 停止 ──",
    "  /stop                    停止正在运行的 Agent",
    "  /restart                 重启 OpenCode Server（外部 server 时仅新建会话）",
    "",
    "── Context ──",
    "  /compact                 压缩当前会话的上下文（用当前 model 调用 server summarize）",
    "  （简写: /summarize）",
    "",
    "── 历史 ──",
    "  /history                 显示当前会话最近 5 条消息（user/assistant，仅文本）",
    "  /history <N>             显示最近 N 条消息（N: 1-20）",
    "  （简写: /hist ...）",
    "",
    "── 系统 ──",
    "  /version                 查询 Bridge、OpenCode Server 与 npm 上最新版本",
    "",
    "── 思考显示 ──",
    "  /thought-display on     开启思考内容显示（默认）",
    "  /thought-display off    关闭思考内容显示",
    "  /thought-display status 查看当前显示设置",
    "",
    "── 工具显示 ──",
    "  /tool-display on        开启工具调用摘要（默认）",
    "  /tool-display off       关闭工具调用摘要",
    "  /tool-display status    查看当前显示设置",
    "",
    "── 消息计数 ──",
    "  /next                    重置微信连续发送消息计数（不转发给 Agent）",
    "",
    "── Question ──",
    "  /reject-question         显式拒绝当前等待中的 LLM 问题（仅在有 pending question 时有效）",
    "  （简写: /rq）",
    "",
    "── Permission ──",
    "  /reject-permission       显式拒绝当前等待中的工具权限请求（仅在有 pending permission 时有效）",
    "  （简写: /rp）",
    "  /auto-permission         切换权限自动接收模式: off | once | always | status",
    "  （简写: /ap）",
    "",
    "── 通知 ──",
    "  /notify                  推送其他正在运行的 OpenCode 会话事件到微信",
    "  /notify on|off           总开关（默认 on）",
    "  /notify status           查看当前配置",
    "  /notify types <type> on|off  切换单个事件 (question/permission/error/completion)",
    "  （简写: /n ...）",
    "",
    "── 帮助 ──",
    "  /help                    显示本帮助信息",
  ];

  // Append OpenCode native commands if available
  if (nativeCommands.length > 0) {
    lines.push("", "── OpenCode 指令 ──");
    for (const cmd of nativeCommands) {
      const desc = cmd.description ? `  ${cmd.description}` : "";
      // WeChat private messages do NOT render Markdown bold (`**…**`) or any
      // other inline color/font formatting — those characters appear as
      // literal text. The conventional way to give a command name visual
      // emphasis in Chinese WeChat is full-width brackets 【…】, which look
      // like a header/button and render identically in every client.
      lines.push(`  【/${cmd.name}】${desc}`);
    }
  }

  return lines.join("\n");
}

/**
 /**
 * Over-fetch multiplier: ask the server for `count × FETCH_MULTIPLIER`
 * raw messages so that, after dropping tool-only turns, we usually end
 * up with the `count` text-bearing messages the user actually wanted to
 * see. Without this, a chatty ultraworker whose tool-only turns
 * outnumber text turns would surface e.g. `最近 5 条消息` in the header
 * but only render 2 lines — confusing for the user.
 *
 * Capped by FETCH_MAX so we don't pull arbitrarily large payloads when
 * the user asks for `/history 20` on a session full of tool turns.
 */
const FETCH_MULTIPLIER = 3;
const FETCH_MAX = 60;

/**
 * Fetch the most recent N text-bearing messages for the current session
 * and format them for WeChat. Centralizes the `/history` orchestration
 * so the bridge handler stays a thin wrapper and the function is
 * unit-testable with a stubbed client (no need to instantiate the full
 * WeChatOpencodeBridge).
 *
 * Behavior:
 *   - `sessionId === null`          → returns the "no active session" warning.
 *   - `fetch` returns an empty list → returns "no messages yet".
 *   - `fetch` throws                → propagates the error; the bridge
 *                                     wraps this in its own try/catch and
 *                                     converts to a user-facing ⚠️ message.
 *   - `fetch` returns M messages    → we OVER-FETCH by FETCH_MULTIPLIER,
 *                                     then walk the array in reverse to
 *                                     pick the LAST `count` messages that
 *                                     carry at least one text part
 *                                     (tool-only turns are skipped, the
 *                                     same way `/history` always has). The
 *                                     resulting slice is reversed back to
 *                                     chronological order (oldest at top,
 *                                     newest at bottom) and passed to the
 *                                     formatter. Server returns OLDEST-FIRST
 *                                     (see
 *                                     `packages/opencode/src/session/message-v2.ts:471`
 *                                     for the server-side reverse), so
 *                                     the LAST items in the raw array are
 *                                     the most recent.
 *   - `getSessionTitle` (optional)  → returned title is surfaced in the
 *                                     header. When the call fails or returns
 *                                     an empty string, the title is omitted
 *                                     (the header still includes the cwd).
 *   - Edge case: even with over-fetch, no text-bearing messages exist in
 *     the returned window → returns a "本次范围内全部是工具/推理轮" notice
 *     instead of an empty header.
 *
 * The `fetch` and `getSessionTitle` callbacks are the only seams tests
 * need: both map directly to `OpenCodeServerClient.getSessionMessages` /
 * `OpenCodeServerClient.getSession`.
 */
export async function fetchAndFormatHistory(opts: {
  sessionId: string | null;
  count: number;
  cwd: string;
  fetch: (sessionId: string, count: number) => Promise<MessageResponse[]>;
  /**
   * Optional session-title resolver. When omitted (tests), the formatted
   * output skips the 会话「…」 part of the header. When provided, the
   * returned string is rendered in the header (truncated to 40 chars).
   * Errors are swallowed by the caller (the bridge passes a guarded
   * closure) so a missing session on the server doesn't kill `/history`.
   */
  getSessionTitle?: (sessionId: string) => Promise<string | undefined>;
}): Promise<string> {
  if (opts.sessionId === null) {
    return formatHistoryForWeChat({
      sessionId: null,
      messages: [],
      cwd: opts.cwd,
      maxCount: opts.count,
    });
  }
  const fetchLimit = Math.min(opts.count * FETCH_MULTIPLIER, FETCH_MAX);
  const [raw, title] = await Promise.all([
    opts.fetch(opts.sessionId, fetchLimit),
    opts.getSessionTitle ? opts.getSessionTitle(opts.sessionId).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // Truly-empty session (server has no messages at all) — distinct from
  // "session has messages but they're all tool-only". Two different
  // notices, since the first one usually means a fresh session and the
  // second one means a tool-heavy agent run.
  if (raw.length === 0) {
    return "📜 当前会话暂无消息。";
  }
  // Walk OLDEST-FIRST array in reverse, picking the LAST `opts.count`
  // text-bearing messages (i.e. the most recent N that actually contain
  // text). A message "carries text" if any of its parts is a non-empty
  // text part — tool-only / reasoning-only / file-only turns are
  // skipped, matching the "history = chat log" contract.
  const picked: MessageResponse[] = [];
  for (let i = raw.length - 1; i >= 0 && picked.length < opts.count; i--) {
    const m = raw[i];
    const hasText = m.parts.some(
      (p) => p.type === "text" && typeof p.text === "string" && p.text.length > 0,
    );
    if (hasText) picked.push(m);
  }
  if (picked.length === 0) {
    // Edge case: server returned N raw messages but every one of them
    // was tool-only / reasoning-only. Surface this honestly instead of
    // an empty header.
    return `📜 最近 ${opts.count} 条消息 (工作区: ${opts.cwd}):\n\n(本次范围内全部是工具/推理轮，没有文本回复)`;
  }
  // Reverse back to chronological (oldest at top, newest at bottom) for
  // the formatter.
  picked.reverse();
  return formatHistoryForWeChat({
    sessionId: opts.sessionId,
    title,
    messages: picked.map((m) => ({
      info: m.info,
      parts: m.parts
        .filter((p): p is EventTextPart => p.type === "text")
        .map((p) => ({ type: "text" as const, text: p.text })),
    })),
    cwd: opts.cwd,
    maxCount: opts.count,
  });
}
