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

export interface ThinkingCommand {
  kind: "status" | "on" | "off";
  target?: "thoughts" | "tools";
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
      // /s list                  → no filter
      // /s list --cwd            → filter by current workspace
      // /s list /path/to/cwd     → filter by specific cwd
      // /s list N                → filter by workspace at index N (resolved by bridge)
      const hasCwdFlag = args.includes("--cwd");
      let cwdFilter: string | undefined;
      if (hasCwdFlag) {
        cwdFilter = "__current__";
      } else if (args.length > 1) {
        // Take everything after "list" as the filter value
        const filterValue = args.slice(1).join(" ");
        if (filterValue) cwdFilter = filterValue;
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
  const match = trimmed.match(/^\/agent\s+(.+)$/i);
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

export function parseThinkingCommand(text: string): ThinkingCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/thinking\s+(.+)$/i);
  if (!match) return null;

  const args = match[1].trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case "on":
    case "enable":
      return { kind: "on", target: args[1]?.toLowerCase() as "thoughts" | "tools" | undefined };
    case "off":
    case "disable":
      return { kind: "off", target: args[1]?.toLowerCase() as "thoughts" | "tools" | undefined };
    case "status":
    case "current":
      return { kind: "status" };
    default:
      return null;
  }
}

export function formatWorkspaceList(
  workspaces: Array<{ id: string; name: string; cwd: string }>,
  activeId: string | null,
): string {
  if (workspaces.length === 0) return "No workspaces configured.";

  const lines = ["📂 Workspaces:"];
  for (const ws of workspaces) {
    const prefix = ws.id === activeId ? "▶ " : "  ";
    lines.push(`${prefix}${ws.name} (${ws.id})`);
    lines.push(`   ${ws.cwd}`);
  }
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
 */
export function formatHelp(): string {
  return [
    "📖 可用命令：",
    "",
    "── 工作区 ──",
    "  /workspace list          列出所有工作区",
    "  /workspace add /path [name]  添加工作区",
    "  /workspace switch <n|path> 切换到指定工作区（自动加载最近会话）",
    "  /workspace remove <name> 删除工作区",
    "  /workspace status        显示当前工作区",
    "  （简写: /ws ...）",
    "",
    "── 会话 ──",
    "  /session new [name]      创建新会话",
    "  /session switch <n|slug> 切换到指定会话",
    "  /session remove <name>   删除会话",
    "  /session list            列出所有会话",
    "  /session list --cwd      列出当前工作区内的会话",
    "  /session list <path|n>   按工作区路径或索引列出会话",
    "  /session status          显示当前会话",
    "  （简写: /s ...）",
    "",
    "── Agent / Model / Reasoning ──",
    "  /agent list              列出可用的 Agent 模式（Build、Plan 等）",
    "  /agent switch <id>       切换 Agent 模式",
    "  /agent status            显示当前 Agent 模式",
    "  （简写: /a ...）",
    "",
    "  /model list              列出可用的模型",
    "  /model switch <provider/model>  切换模型",
    "  /model status            显示当前模型",
    "",
    "  /reasoning list          列出推理级别",
    "  /reasoning switch <level>  切换推理级别",
    "  /reasoning status        显示当前推理级别",
    "",
    "── 状态 ──",
    "  /status                  显示当前会话、工作区、Agent、模型、上下文使用量",
    "",
    "── 思考 ──",
    "  /thinking on             开启思考与工具显示（暂时禁用）",
    "  /thinking off            关闭思考与工具显示",
    "  /thinking status         查看当前思考与工具显示设置",
    "",
    "── 帮助 ──",
    "  /help                    显示本帮助信息",
  ].join("\n");
}

/**
 * Format help message including OpenCode native slash commands from available_commands_update.
 */
export function formatHelpWithNativeCommands(nativeCommands: Array<{ name: string; description: string }>): string {
  const lines = [
    "📖 可用命令：",
    "",
    "── Bridge 命令 ──",
    "  /workspace list          列出所有工作区",
    "  /workspace add /path [name]  添加工作区",
    "  /workspace switch <n|path> 切换到指定工作区",
    "  /workspace status        显示当前工作区",
    "  （简写: /ws ...）",
    "",
    "  /session new             创建新会话",
    "  /session switch <n|slug> 切换到指定会话",
    "  /session list            列出所有会话",
    "  /session list --cwd      列出当前工作区内的会话",
    "  /session list <path|n>   按工作区路径或索引列出会话",
    "  /session status          显示当前会话",
    "  （简写: /s ...）",
    "",
    "── Agent / Model / Reasoning ──",
    "  /agent list              列出可用的 Agent 模式（Build、Plan 等）",
    "  /agent switch <id>       切换 Agent 模式",
    "  /agent status            显示当前 Agent 模式",
    "  （简写: /a ...）",
    "",
    "  /model list              列出可用的模型",
    "  /model switch <provider/model>  切换模型",
    "  /model status            显示当前模型",
    "",
    "  /reasoning list          列出推理级别",
    "  /reasoning switch <level>  切换推理级别",
    "  /reasoning status        显示当前推理级别",
    "",
    "── 状态 ──",
    "  /status                  显示当前会话、工作区、Agent、模型、上下文使用量",
    "",
    "── 思考 ──",
    "  /thinking on             开启思考与工具显示（暂时禁用）",
    "  /thinking off            关闭思考与工具显示",
    "  /thinking status         查看当前思考与工具显示设置",
    "",
    "  /help                    显示本帮助信息",
  ];

  if (nativeCommands.length > 0) {
    lines.push("");
    lines.push("── OpenCode Agent 命令 ──");
    for (const cmd of nativeCommands) {
      lines.push(`  /${cmd.name}`);
    }
  }

  return lines.join("\n");
}
