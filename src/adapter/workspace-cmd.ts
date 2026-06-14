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

import type { McpServerStatus } from "../types.js";

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

  // Agent
  lines.push(`  🤖 Agent: ${opts.agent}`);

  // Model
  lines.push(`  📱 Model: ${opts.model}`);

  // Reasoning
  lines.push(`  🧠 Reasoning: ${opts.reasoning}`);

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
    "── 系统 ──",
    "  /version                 查询 Bridge、OpenCode Server 与 npm 上最新版本",
    "",
    "── 思考显示 ──",
    "  /thought-display on     开启思考内容显示",
    "  /thought-display off    关闭思考内容显示",
    "  /thought-display status 查看当前显示设置",
    "",
    "── 工具显示 ──",
    "  /tool-display on        开启工具调用摘要",
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
    "── 系统 ──",
    "  /version                 查询 Bridge、OpenCode Server 与 npm 上最新版本",
    "",
    "── 思考显示 ──",
    "  /thought-display on     开启思考内容显示",
    "  /thought-display off    关闭思考内容显示",
    "  /thought-display status 查看当前显示设置",
    "",
    "── 工具显示 ──",
    "  /tool-display on        开启工具调用摘要",
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
