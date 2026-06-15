# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed
- Cat-girl feature: removed `--cat-girl` CLI flag, the bundled `presets/cat-girl.md` agent, and the `installCatGirlAgent()` helper. The flag now produces an "Unknown option" error. Users who previously installed the agent via this flag will need to manage it themselves (the file is no longer shipped).

## [1.3.3] - 2026-06-15

### Fixed
- **Bridge crashed with `TypeError: fetch failed` on WeChat API timeouts** (e.g. `ilinkai.weixin.qq.com:443` connect timeout). Root cause: `enqueueOutbound`'s cleanup chain `next.finally(() => { ... })` returns a new promise that inherits `next`'s rejection. The original `next` was caught and logged by `session.ts` ("onReply error for …"), but the sibling `finally` promise had no `.catch` and became an unhandled rejection — under Node ≥15's default policy this kills the process. Fix: attach `.catch(() => { })` to the finally chain so the cleanup runs but the rejection is suppressed; the original `next` is still returned to the caller and the caller's `.catch` (in `session.ts`) keeps working.
- **Defense-in-depth: process-level `unhandledRejection` / `uncaughtException` handlers** in the CLI entry point. Any future unhandled rejection or uncaught exception is logged to stderr with a stack trace and the bridge keeps running, instead of crashing the long-lived bridge process. Specific known cases (e.g. WeChat API timeouts) are also fixed at the source so they don't fire — this is a safety net for regressions.

## [1.3.2] - 2026-06-15

### Fixed
- **`/workspace switch` reported a generic session error after switching.** Two related bugs: `handleSessionError` was calling `String()` on object-shaped server errors, hiding the real message behind `"[object Object]"`; and `switchWorkspace` left `currentMode` / `currentModelId` / `currentReasoning` populated from the previous workspace, causing the next prompt to fail with `session.error: Agent not found: "<old-agent>"` when the new workspace didn't define the same agent/model. The real error is now surfaced to the bridge log and WeChat, and stale state is cleared on workspace switch.
- **`/workspace switch` always created a brand-new session**, even when the target workspace already had a previous conversation. The new session had no context, model, or agent from that workspace. Now resumes the most recent root session in the target workspace, falling back to creating a new one if none exists. Users who want a fresh session in the target workspace can still use `/session new` afterwards.

## [1.3.1] - 2026-06-14

### Added
- `--cat-girl` CLI flag: one-time install of the bundled cat-girl agent (`猫娘咪咪`) to `~/.config/opencode/agents/` on first run; omit on subsequent runs
- `presets/cat-girl.md` — bundled cat-girl agent shipped with the package

### Removed
- `--idle-timeout` CLI flag and all related dead code (was deprecated and non-functional — session idle is managed by OpenCode Server)

### Changed
- README restructured: merged install/usage sections, reorganized feature list, added cat-girl documentation (zh + en)
- **Default for `/thought-display` and `/tool-display` flipped from OFF to ON.** First-time installs now see 🧠 Thought summaries and 🔧 Tool summaries in WeChat without having to discover and toggle the commands. Users who already toggled either flag keep their saved choice (`~/.wechat-bridge-state.json`); users who never toggled inherit the new defaults on next bridge start. AGENTS.md / README.md / README.en.md / `/help` output all reflect the new default.
- Deprecated `config.agent.showThoughts` / `config.agent.showTools` defaults flipped to `true` for consistency (these fields are no longer consulted at runtime — only the `/thought-display` / `/tool-display` state path drives display).

## [1.3.0] - 2026-06-14

### Added
- **Permission tool: full WeChat interaction.** New cards for OpenCode `permission.asked` events with `once` / `always` / `reject` choices. Mirrors the question tool's design pattern (`src/types/permission.ts`, `src/server/client.ts` `listPendingPermissions` / `replyToPermission` / `rejectPendingPermission`, `src/server/session.ts` permission state machine, `src/adapter/permission-format.ts` format/parse, `src/bridge.ts` integration).
- **`/auto-permission` command** (alias `/ap`): toggle auto-accept mode (`off` / `once` / `always`); status visible in `/status`. Tri-state persisted to `~/.wechat-bridge-state.json` and restored on bridge restart.
- **`/reject-permission` command** (alias `/rp`): dismiss all pending permission cards.
- **30-minute soft timeout** for unanswered permission cards (auto-reject).
- **Multi-permission support:** multiple concurrent `permission.asked` events tracked per requestID; server cascade `reject` clears siblings automatically. v2: bare `1`/`2`/`3` and keywords cascade to ALL pending; `P{n}=…` for per-permission control.
- `src/types/permission.ts`, `src/adapter/permission-format.ts` — Permission tool types and card formatter/parser

### Changed
- **`handleMessage` ordering:** permission check runs BEFORE question check (higher urgency — agent blocked on tool call).
- **WeChat 10-msg counter:** now resets on any incoming user message, not just `/next` (fixes early warning during permission card replies).
- **Doc simplification:** AGENTS.md, README.md, README.en.md — question/permission sections collapsed from ~60 lines to ~5 lines each; full grammar in `.omo/plans/`.
- `.gitignore`: narrowed from `.omo/` to `.omo/run-continuation/` — tracks design plans, ignores transient session state.

### Fixed
- **`/ap` mode not persisted** — `loadUserState` / `saveUserState` both forgot the `autoPermissionMode` field; mode was in-memory only and lost on restart.
- **Stale docs claim "permission requests are auto-approved"** — originated from v0.1.0 ACP era, never matched current HTTP architecture.
- **Multi-pending UX bug:** bare `1`/`2`/`3` rejected when 2+ cards pending (fixed by cascading to all).

## [1.2.0] - 2026-06-14

### Added
- **Question 工具端到端支持**：OpenCode Agent 调用 `question` 工具时，Bridge 将问题原文转发到微信私聊，用户回复 `Q1=1`、`Q1-自定义文字` 或 `1 --- 2 --- 3` 格式回传答案。支持多题路由（顺序无关）、多选/单选/自定义混合、手机自动空格容忍、`/reject-question`（`/rq`）显式拒绝、30 分钟无应答软超时自动 reject（`.omo/plans/question-tool-design.md` 设计稿）
- **/thought-display** / **/tool-display** 微信命令：分别控制模型推理内容和工具调用摘要在微信侧的显示（`on` / `off` / `status`），设置跨重启持久化
- **推理摘要显示**：WeChat 端实时显示 `🧠 Thought · {摘要} · {duration}`（单行），支持流式推理分片计时、摘要提取
- **工具调用摘要显示**：每轮末尾显示 `✅ · {工具名} {标题}` 摘要，同类工具合并一行
- `src/adapter/thinking-format.ts`：推理摘要提取 + 工具摘要格式化
- `src/adapter/question-format.ts`：Question 展示/解析（Qn=/Qn- 双 marker 语法）
- `src/types/question.ts`：Question 工具类型定义（QuestionPrompt / PendingQuestion 等）
- `vitest.config.mjs` + `opencode.jsonc`：项目配置补充

### Changed
- **测试框架迁移**：从 `scripts/` 中的手动测试脚本迁移到 **Vitest 4.1.8**，`src/__tests__/` 现有 7 个测试文件共 141 个单元测试（`npm test`）
- **SessionManager 消息分发重构**：从旧有的"边界缓冲"模式改为 type-change-flushing 设计——Reasonging / Tool / Text 三种类型在切换时实时冲刷到 WeChat，同类型连续多段合并为一条消息；缓冲消息在处理时保持原始 stream 顺序
- `bridge.ts`：outbound 发送队列串联（`outboundQueue: Map<contextToken, Promise>`），防止并发发送乱序

### Fixed
- Question 工具事件未被处理：`session.ts.handleEvent` switch 缺 `question.asked/replied/rejected` 三个 case，导致 Agent 在 `Deferred.await()` 上永久挂起。添加 pendingQuestion 状态机 + 3 个 SSE handler + race-safe 清理

### Removed
- `test.md`：已废弃的手动测试文档（Vitest 替代）
- `scripts/` 中多个手动测试脚本（迁移至 Vitest）

### Fixed
- 外部 server 认证失效：SSE event pipeline 的 `/global/event` 长连接在 `event-pipeline.ts` 自己用裸 `fetch()`，绕过了 `OpenCodeServerClient.fetch()` 的 `Authorization` 头注入路径，导致 v1.1.0 在任何需要认证的 server（包括 OpenCode 桌面版）上持续 401 重连。EventPipeline 现在通过新加的 `getAuthHeader()` getter 复用 client 预计算的 `Authorization` 头

## [1.1.0] - 2026-06-12

### Added
- 外部 OpenCode Server 认证支持：通过 `--server-username` / `--server-password`（HTTP Basic）或 `--server-token`（Bearer）连接需要认证的 server。Bearer 优先于 Basic；Basic 要求 user/pass 同时设置否则启动报错。支持 `WECHAT_OPENCODE_SERVER_USERNAME` / `..._PASSWORD` / `..._TOKEN` 环境变量，优先级 CLI > env > 配置文件。适用于 OpenCode 桌面版 server（username=`opencode`，password=server token）

## [1.0.1] - 2026-06-10

### Fixed
- 用户在 Agent 处理中发送新微信消息时，同一 user message 被 `prompt_async` 重复发送多次（session 中出现 2-3 条重复消息，且 SSE 处理级联）。`processQueue` 改为立即发送并新增 `pendingEchoes` FIFO 队列记录 in-flight contextToken，SSE echo 到来时 shift 出来给新 turn 用，不再 re-enqueue

## [1.0.0] - 2026-06-08

### Added
- `/status` 新增 MCP 段：列出当前工作区配置的 MCP servers 状态（✅ connected / ❌ failed 带 error 详情 / 🔐 needs_auth / 🔐 needs_client_registration），失败和需认证的优先排序，方便排查 npx 下载失败的 MCP
- `/workspace switch <n>` 支持 `/workspace list` 中的编号（之前只接受路径）
- `/version` 显示 Bridge、OpenCode Server、npm 上最新版本；`/upgrade` 升级 OpenCode 并自动重启 server
- `/help` 显示 OpenCode 原生 slash commands（来自 `/command` 端点）
- `/s list` 隐藏 subsessions，只显示根 session 并内联显示 cwd
- 推理级别（reasoning variant）端到端支持：显示、发送、切换时同步

### Changed
- **架构迁移**：从 ACP 子进程改为 OpenCode Server HTTP API（移除 `src/acp/`，新增 `src/server/` 和 `src/types/`、`src/types/events.ts`）。无 ACP 连接管理、无 subprocess 启停
- `--server-url` 语义调整：现在表示连接外部 `opencode serve`，并跳过自动启动 sidecar（移除 `--no-server`）
- `/restart` 现在真正重启 `opencode serve` 进程并恢复上一个 session（之前仅清空上下文）
- `/help` 中 OpenCode 命令改用全角括号显示

### Fixed
- 启动时若保存的 `userState.cwd` 与本次启动 cwd 不一致，丢弃过期的 userState（避免 `/status` 显示旧路径但 agent 实际跑在新目录）
- `/status` 和 `/agent list` 的读取调用（`/mcp`、`/agent`、`/config`、`/config/providers`、`/command`）现在传 `?directory=<cwd>`，确保返回工作区级配置而非全局。之前导致 `/status` 显示的 MCP/agent/model 与 agent 实际运行环境不一致
- `/workspace switch` / `/session switch` 切换后立即刷新 agents 和 providers 缓存（`/session new` 一直会刷，切换路径之前漏了）
- `syncStateFromServer` 里的 `getConfig()` 也按当前工作区限定（之前 fallback 用全局默认 model，覆盖了工作区的 `model:` 配置）
- `/session switch <n>` 现在沿用最近一次 `/session list` 的 cwd filter，确保 list 中看到的编号 = switch 中输入的编号（之前 list 用过滤列表、switch 用全集，导致切到错的 session）
- MCP 状态缓存按 cwd 做 key，工作区切换自动失效

## [0.3.10] - 2026-06-05

### Fixed
- Agent 使用 `read` 工具时,读到的图片被自动发送到微信的问题(工具结果为 agent
  内部上下文,不应透传)
- `/restart` 后 Agent 最近几条消息被重新发送到微信的问题(resumeSession 时未
  抑制重放内容)

## [0.3.9] - 2026-06-03

### Fixed
- 自动恢复机制死循环：`processQueue` 的 stale session recovery 缺少重试上限，当 OpenCode 服务持续失败时无限创建新 session 撑爆数据库。新增 `MAX_RECOVERY_ATTEMPTS=2` 限制，超过后停止并通知用户

## [0.3.8] - 2026-06-02

### Fixed
- 视频文件无法内联播放（`video_item` 缺少 `video_size`，`guessMimeType` 缺少视频扩展名映射）
- 音频文件被误识别为 VOICE 类型导致发送失败（`mimeToMediaType` 将 `audio/*` 改为 `FILE`）
- `guessMimeType` 大幅扩充：新增视频、音频、文档、代码、压缩包等扩展名支持

## [0.3.7] - 2026-06-02

### Added
- 消息缓存功能：超出微信 10 条连续发送限制时，自动缓存后续消息
- `/next` 指令：手动刷新缓存消息，不转发给 Agent
- 任意用户消息自动触发缓存刷新（计划 A：缓存优先）
- 图片/文件发送路径也加入计数限流，超出时缓存而非丢弃
- 各发送路径日志增加 `sent=N` 计数标记

### Fixed
- 修复并发工具调用导致消息计数竞争条件（先预留计数再发送）
- 修复缓存图片 flush 时因缺失 `mimeType` 被当作文件发送的问题

## [0.3.6] - 2026-06-02

### Added
- `send-wechat` 工具现在支持发送文本消息（新增 `text` 参数），Agent 可直接回复文字到微信
- `send-wechat` 工具返回 `sent` 数组标明已发送的内容类型

### Fixed
- session 恢复时 mode/model 无效不再导致整个操作崩溃（改为 try/catch 降级）
- stale session 导致 prompt 失败时自动创建新 session 重试
- 多用户场景下 state 文件只保留当前活跃用户，`send-wechat` 不再取错用户

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
