# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.5] - 2026-06-01

### Fixed
- OpenCode 1.15+ 中 MCP server 格式变更导致 ACP 会话创建失败的问题（`command` 从字符串变为数组，`environment` 替代 `env`）

## [0.3.4] - 2026-06-01

### Added
- ACP configOptions fallback for OpenCode 1.15+（从 `configOptions` 提取 mode/model 信息）
- 切换工作区/会话前检查目录是否存在，不存在时提示用户删除或创建

### Changed
- `/workspace list` 标题从 `Directories` 改为 `Workspaces`
- 移除了 prompt/flush timeout（5 分钟 prompt 超时和 30 秒 flush 超时）

### Fixed
- `/stop` 后切换工作区报 `ENOENT` 的问题（spawn 失败的错误现在会正确抛出）
- `/stop` 后工作区切换失败不会回滚用户状态的问题
- 工作区/会话切换失败时微信端无错误提示的问题（添加 try-catch 和错误消息）

## [0.3.3] - 2026-05-26

### Fixed
- AI 回复被意外拆成多条消息的问题（`onDelayedFlush` 的 trailing chunk 用 `\n` 强制换行拼接，改为直接拼接）
- 延长 trailing poll 窗口（从固定 3s 改为自适应最长 12s、1.6s 静默退出），进一步减少延迟到达内容导致的拆分
- `/reasoning` 命令适配 OpenCode 新版配置项（`thought_level` 重命名为 `effort`，`/session new` 和 `/restart` 现在正确继承推理级别）
- `/reasoning list` / `switch` / `status` 同时支持旧版 model ID 后缀和新版 `effort` 配置项

## [0.3.2] - 2026-05-07

### Fixed
- `/reasoning list` 现在正确显示当前模型的可用推理级别（此前错误假设 thought_level 是独立的 ACP SessionConfigOption，实际上 OpenCode 将推理级别编码为 model ID 的后缀，如 `provider/model/low`）
- `/reasoning switch <level>` 现在正确切换到对应模型变体（使用 `unstable_setSessionModel` 而非 `setSessionConfigOption`）
- `/reasoning status` 改为从当前 model ID 实时读取推理级别（不再依赖可能过期的本地缓存）

## [0.3.1] - 2026-04-28

### Fixed
- 修复 Agent 启用子代理后第二条回复无法转发到微信的问题（因 `prompt` 返回 `end_turn` 后新到达的 `agent_message_chunk` 无人调用 `flush()` 导致永久丢失）
- 新增延迟自动 flush 机制（debounce 2 秒），确保 Agent 在后台任务完成后产生的回复也能正常转发

## [0.3.0] - 2026-04-22

### Fixed
- `send-wechat` 工具改为取数组第一个用户（修复多用户环境下取错用户导致 "User session not found" 错误）
- `/help` 命令现在正确显示 OpenCode 原生指令（此前 `nativeCommands` 参数被忽略）

## [0.2.9] - 2026-04-19

### Changed
- `--idle-timeout` 默认值从 1440 分钟改为 0（默认禁用空闲超时）

## [0.2.8] - 2026-04-19

### Added
- `/version` — 查看 OpenCode 当前版本和最新版本
- `/restart` — 重启 Agent 进程（保留当前 mode/model/reasoning 状态）
- `/upgrade` — 更新 OpenCode 后自动重启 Agent

### Fixed
- 修复 `/version` 命令在 Windows 上的版本检测问题

## [0.2.7] - 2026-04-19

### Added
- `/stop` — 通过 ACP `session/cancel` 通知停止正在运行的 Agent（效果等同于 OpenCode 终端按 ESC 键）

### Fixed
- `/session new`（`/s new`）现在会保留并恢复用户之前选择的 Agent 模式和模型（此前切换后会重置为默认）

## [0.2.6] - 2026-04-08

### Removed
- `--max-sessions` CLI 参数（会话并发数限制功能移除）

### Changed
- 思考与工具显示功能默认关闭（`showThoughts` / `showTools` 默认为 `false`）
- `/thinking on` 命令暂时禁用，回复"功能已暂时关闭，未来版本可能重新启用"
- `/help` 命令说明全部中文化

## [0.2.5] - 2026-04-08

### Fixed
- 修复工具调用名称被累积到最后才返回，导致微信端显示顺序错乱的问题（改为实时发送）

## [0.2.4] - 2026-04-08

### Fixed
- 修复 agent 回复 chunk 延迟到达导致最终回复丢失的问题（轮询逻辑从"有内容才等"改为"至少等一次"，最长等待 3 秒）

## [0.2.3] - 2026-04-07

### Fixed
- 新用户首次发消息时 `.wechat-bridge-state.json` 未创建，导致 `send-wechat` 工具报错 "No active WeChat session found"

## [0.2.2] - 2026-04-07

### Fixed
- `/session new` 后 `send-wechat` 发送文件失败的问题（state 文件中的 sessionId 过期导致 404）
- 同一用户被重复创建多个 agent 进程的竞态条件（并发消息到达时的 TOCTOU 问题）
- `/session new` 不应 resume 旧会话，而是全新开始
- 刚 spawn 的 agent 被额外创建一个冗余 ACP session
- 首次对话回复丢失（agent 刚启动时回复 chunks 异步到达时序问题）
- 首次对话 agent 未完全初始化就发送 prompt 导致 0 tokens 响应

## [0.2.1] - 2026-04-07

### Added
- `/thinking on|off|status` — 运行时切换思考过程和工具调用显示（替代 `--show-thoughts` 参数）
- 工具调用显示功能（`showTools`），开启后在回复中显示 Agent 使用的工具列表

### Changed
- 思考过程和工具调用显示默认开启（此前 `--show-thoughts` 默认关闭）
- 微信命令按功能分类显示（Bridge Commands / Agent Commands）

### Removed
- `--show-thoughts` CLI 参数（已合并到 `/thinking` 命令）
- Agent 发送的 diff 内容不再转发到微信

## [0.2.0] - 2026-04-06

### Added
- `/status` — 一键查看当前会话、工作区、Agent、Model、推理级别和上下文使用情况（含进度条）
- 通过 ACP `usage_update` 和 `PromptResponse.usage` 实时追踪上下文窗口大小和累计总 token 数

## [0.1.9] - 2026-04-03

### Added
- `/agent list` `/agent switch` `/agent status` — 通过 ACP 协议动态切换 Agent 模式（Build/Plan 等），支持序号和名称切换
- `/model list` `/model switch` `/model status` — 通过 ACP 协议动态切换模型，支持 list providers → list models 两级浏览，支持序号和完整名称切换
- `/reasoning list` `/reasoning switch` `/reasoning status` — 通过 ACP 协议动态切换推理级别

### Changed
- `/help` 动态显示 OpenCode Agent 当前可用的 slash commands（来自 `available_commands_update`）

### Fixed
- 未知 slash command（如 `/new`、`/compact` 等 OpenCode TUI 指令）不再静默透传，改为立即回复提示"⚠️ 指令 "/xxx" 不是 Bridge 内置指令，已转交 Agent 处理。"并继续转发至 Agent

## [0.1.7] - 2026-04-02

### Added
- `/session list --cwd` 和 `/session list <path|n>` 支持按工作区过滤会话
- GitHub Actions 自动 npm 发布流程（`release.yml`）
- `CHANGELOG.md` 维护发布日志

### Changed
- `/workspace switch` 和 `/workspace add` 自动加载目标工作区最近会话，而非创建新会话
- 会话/工作区切换从 kill+respawn 改为 ACP 协议调用（`session/new` / `session/load`），切换速度提升一个数量级
- 会话列表和切换使用 SQLite 作为权威数据源，过滤掉子 agent 会话（`parent_id IS NULL`）
- 切换消息时序优化：先显示 `🔄 Switching to`，切换完成后显示 `✅ Ready on`
- 更新 README 安装/使用说明，分离安装和使用两个章节
- 更新 AGENTS.md 同步最新架构和命令列表

### Fixed
- Agent 进程未启动时执行切换命令报错的问题

## [0.1.6]

- Fix session switch timing — send "Switching to" before the switch, "Ready on" after
- Filter sub-agent sessions from session list (`parent_id IS NULL`)
- Update AGENTS.md and README documentation

## [0.1.5]

- Optimize session and workspace management

## [0.1.2]

- Add `--show-thoughts` flag to forward agent thinking to WeChat (off by default)
- Stream thought messages in real-time at thought→tool and thought→message transitions
- Log all agent thought chunks to terminal for debugging

## 0.1.1

- Set default idle timeout to 1440 minutes (24 hours); use `--idle-timeout 0` for unlimited
- Send typing indicator immediately when prompt is received
- Cancel typing indicator after reply is delivered
- Add GitHub Actions CI workflow

## 0.1.0

- Initial release
- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in agent presets: copilot, claude, gemini, qwen, codex, opencode
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats ignored
- Background daemon mode with `--daemon`
- Config file support with `--config`
- Session idle timeout and max concurrent user limits
