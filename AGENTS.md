# AGENTS.md — wechat-opencode

> Bridge WeChat direct messages to OpenCode Server via HTTP API.

## Project Overview

- **Package**: `wechat-bridge-opencode` v1.3.9 — ESM-only (`"type": "module"`)
- **Runtime**: Node.js 20+
- **Language**: TypeScript, compiled to JS via `tsc`
- **Package manager**: npm (use `package-lock.json`)
- **Repository**: https://github.com/pan17/wechat-opencode

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode: tsc --watch
npm start            # Run compiled CLI: node dist/bin/wechat-opencode.js
npm run prepack      # Runs build before npm publish
npm test             # Run vitest unit tests (568 tests across 28 files)
npm run test:watch   # Vitest in watch mode
```

**Tests:** Vitest 4.1.8 unit tests live in `src/__tests__/` (568 tests across 28 files). No linter is configured.

### Running the CLI locally

```bash
npm run build
node dist/bin/wechat-opencode.js --help
node dist/bin/wechat-opencode.js          # auto-starts opencode serve
node dist/bin/wechat-opencode.js --server-url http://localhost:4096  # uses external server
```

## Architecture

```
bin/wechat-opencode.ts          — CLI entry (arg parsing, daemon, sidecar server, QR rendering)
src/index.ts                    — Public API exports
src/bridge.ts                   — Main orchestrator (WeChat poll ↔ OpenCode Server HTTP)
src/config.ts                   — Config types, defaults, server connection config
src/types.ts                    — Shared types (MessagePart, ModelRef, MediaContent)
src/vendor.d.ts                 — Type declarations for untyped npm packages
src/types/
  events.ts                     — SSE event types (message.*, session.*, question.*, permission.*)
  question.ts                   — Question tool types (QuestionPrompt, PendingQuestion, …)
  permission.ts                 — Permission tool types (PermissionRequest, PendingPermission, AutoPermissionMode, …)
src/server/
  client.ts                     — OpenCode Server HTTP client (fetch wrapper)
  session.ts                    — Simplified SessionManager (no subprocess, just HTTP)
  event-pipeline.ts             — Persistent /global/event SSE connection with reconnect
src/__tests__/                  — Vitest unit tests (28 files, 568 tests)
src/adapter/
  inbound.ts                    — WeChat message → MessagePart[] (text, image, file)
  outbound.ts                   — Server reply → WeChat text (formatting, splitting)
  workspace-cmd.ts              — Parse /workspace, /session, /agent, /model, /reasoning, /help, /reject-question, /reject-permission, /auto-permission commands
  question-format.ts            — Format & parse question replies (Q{n}={value} / Q{n}-{value} grammar)
  permission-format.ts          — Format & parse permission replies (1/2/3 / P{n}={once|always|reject} grammar)
  thinking-format.ts            — Reasoning summary + tool summary formatting
src/weixin/
  auth.ts                       — WeChat iLink login (QR code, token persistence)
  monitor.ts                    — Long-poll for new messages
  send.ts                       — Send text/image/file/video to WeChat
  api.ts                        — WeChat iLink API (typing indicator, config)
  media.ts                      — CDN download + AES decryption
  types.ts                      — WeChat iLink types (MessageType, UploadMediaType, etc.)
src/utils/
  network.ts                    — Shared transient-network-error classifier + retry helpers
```

### Key flows
1. **CLI** starts `opencode serve` as sidecar → creates `WeChatOpencodeBridge`
2. **Bridge** handles QR login → creates `SessionManager` (HTTP client) → begins WeChat long-poll
3. **SessionManager** communicates with OpenCode Server via HTTP REST API (POST /session, POST /session/:id/message)
4. **Adapters** convert WeChat messages ↔ server message parts

### Session management
- **Single-user**: no Map-based routing, no per-user subprocess
- Agent process is managed by `opencode serve` — bridge only sends HTTP requests
- Session ID is persisted in `~/.wechat-opencode/.wechat-bridge-state.json`
- Mode/model/reasoning are passed as per-request parameters, not ACP RPC calls
- ACL, permission handling, tool execution are all server-side

## Code Style

### Imports
- **Always use `.js` extension** in relative imports (ESM requirement):
  ```ts
  import { WeChatOpencodeBridge } from "./bridge.js";
  ```
- **Node built-ins** use `node:` prefix:
  ```ts
  import fs from "node:fs";
  import path from "node:path";
  ```
- Group order: Node built-ins → npm packages → relative imports
- Prefer **named exports** over default exports (only `qrcode-terminal` uses default)

### TypeScript
- **Strict mode** enabled (`"strict": true` in tsconfig)
- **Target**: ES2022, **Module**: NodeNext, **ModuleResolution**: NodeNext
- Use `interface` for object shapes/config types, `type` for unions and derived types
- **No `as any`**, `@ts-ignore`, or `@ts-expect-error`
- Declaration files: `declaration: true`, `declarationMap: true`

### Naming
- **Classes**: `PascalCase` — `WeChatOpencodeBridge`, `SessionManager`
- **Interfaces**: `PascalCase` — `WeChatOpencodeConfig`, `SessionMode`
- **Functions/methods**: `camelCase` — `handleMessage`, `sendReply`
- **Constants**: `UPPER_SNAKE_CASE` — `TEXT_CHUNK_LIMIT`, `MSG_LIMIT_MAX`
- **Private fields**: `camelCase` with `private` modifier — `private config`, `private abortController`

### Error Handling
- Use `try/catch` with `String(err)` for safe error stringification
- **Best-effort catches**: Non-critical operations (typing indicators, state saves) use empty catches:
  ```ts
  } catch {
    // Typing is best-effort
  }
  ```
- **Throw** `Error` with descriptive messages for invalid input:
  ```ts
  throw new Error("Session not found on server");
  ```
- CLI errors use `console.error` + `process.exit(1)`

### Formatting
- **Indentation**: 2 spaces (tabs in some files — follow the file you're editing)
- **Semicolons**: Present (explicit `;` at statement ends)
- **String quotes**: Double quotes `"..."`
- **Template literals** for string interpolation

### Logging
- Accept optional `log: (msg: string) => void` parameter for testability
- Default logger prefixes with `[wechat-opencode]`
- Runtime logs include ISO timestamp: `[HH:MM:SS] message`

## Adding Features

1. **New message type**: Update `MessageType` enum in `src/weixin/types.ts`, add handling in `src/adapter/inbound.ts`
2. **New Server API call**: Add method to `src/server/client.ts`, use in `src/server/session.ts` or `src/bridge.ts`
   - **Authoritative reference**: [OpenCode Server API docs (zh-cn)](https://opencode.ai/docs/zh-cn/server/) — this is the source of truth for endpoint shape, query params, and response types. The bridge's local `OpenCodeServerClient` only wraps a subset; when in doubt, defer to the doc, not the existing client methods.
   - **Test the endpoint BEFORE coding**: the SDK-generated `types.gen.ts` and the actual server response can drift (e.g. `/vcs` returns `default_branch` but the SDK type only declares `branch`). Before writing the bridge code:
     1. Confirm the opencode server is reachable (it usually is — `Get-Process -Name opencode` on Windows, or just hit `/global/health`).
     2. `curl` the endpoint with the target `?directory=` to capture the real response shape.
     3. Note any extra fields, null-handling, and HTTP status (some endpoints return 200 with `null` rather than 404).
     4. Only then write the client method, types, formatter, handler, and test — grounded in observed data, not assumptions.
3. **New CLI option**: Add to `parseArgs()` in `bin/wechat-opencode.ts`, update `usage()`, pass through to config
4. **New question tool support**: Add event type to `src/types/events.ts` + handler in `src/server/session.ts` switch; mirror in `src/types/events.ts`; add HTTP methods to `src/server/client.ts`; format/parse in `src/adapter/question-format.ts`; wire bridge callbacks in `src/bridge.ts`. See `.omo/plans/question-tool-design.md` for the canonical pattern.
5. **New permission tool support**: Mirror the question pattern with the following differences — (a) the agent's `permission.asked` payload lives in `src/types/permission.ts` (mirrors OpenCode V1 schema); (b) HTTP method is `POST /permission/:id/reply` with `reply: "once"|"always"|"reject"`; (c) format/parse uses positional 1/2/3 + bare keywords + `P{n}=…` grammar; (d) bridge must auto-reject when `lastEnqueuedContextToken` is null (so the agent doesn't block); (e) add the `/auto-permission [off|once|always|status]` command (alias `/ap`) and `/reject-permission` (alias `/rp`); (f) auto-mode toggles must persist to `~/.wechat-bridge-opencode/.wechat-bridge-state.json`. See `.omo/plans/permission-tool-design.md` for the canonical pattern.

## Constraints

- **Direct messages only** — group chats are intentionally ignored
- **Single-user** — one WeChat user, one OpenCode session at a time
- **Runtime state** stored in `~/.wechat-opencode/` (auth tokens, daemon PID, logs, user states)

## WeChat Commands

### Help (/help)
| Command | Description |
|---------|-------------|
| `/help` (`/h`, `/?`) | Show all available commands |

### Status (/status)
| Command | Description |
|---------|-------------|
| `/status` | Show current session (with title), workspace, **branch** (current git branch + default branch, via OpenCode Server `GET /vcs?directory=...`; renders `(not a git repo)` when the workspace isn't git-backed), agent, model, reasoning, context usage, **agent status** (busy/idle/retry driven by the SSE `session.status` event), **count of other running root sessions** on the OpenCode Server (server-wide, excludes current session and sub-agent sessions), and **MCP server status** (with failure reasons). Agent/Model/Reasoning/MCP/Branch are fetched from the OpenCode Server via HTTP API (scoped to the current workspace via the `?directory=` query param; auto-refreshed on workspace switch). For an empty session, Model falls back to the workspace's `model:` field from the server config |

### Workspace (/workspace or /ws)
| Command | Description |
|---------|-------------|
| `/workspace list` | List all workspaces sorted by recent activity, numbered |
| `/workspace status` | Show current workspace directory |
| `/workspace switch <path>` | Switch to directory by path; resumes the most recent session in that workspace (creates a new one if none exists) |
| `/workspace add /path` | Add directory (creates if not exists) |

### Session (/session or /s)
| Command | Description |
|---------|-------------|
| `/session list` | List 20 most recent sessions with cwd |
| `/session list current` | List 20 most recent sessions in current workspace |
| `/session switch <n>` | Switch to session by index (auto-switches workspace) |
| `/session new` | Restart session (clear context) |
| `/session status` | Show current session info |

### Agent (/agent or /a)
| Command | Description |
|---------|-------------|
| `/agent list` | List available primary (non-built-in) agent modes with index |
| `/agent switch <name\|n>` | Switch agent mode by name or index |
| `/agent status` | Show current agent mode |

### Model (/model)
| Command | Description |
|---------|-------------|
| `/model list` | List model providers with counts |
| `/model list <provider>` | List all models under a specific provider |
| `/model switch <provider/model>` | Switch model (e.g. anthropic/claude-sonnet-4-5) |
| `/model status` | Show current model |

### Reasoning (/reasoning)
| Command | Description |
|---------|-------------|
| `/reasoning list` | List reasoning levels for the current model (from model variants), plus a synthetic `Default` entry at position 0 that mirrors the OpenCode TUI — selecting it (or `/reasoning switch default`) sets `currentReasoning` to `undefined` so the next prompt omits `variant` and the server applies its model default |
| `/reasoning switch <level>` | Switch reasoning level |
| `/reasoning status` | Show current reasoning level |

### Stop (/stop)
| Command | Description |
|---------|-------------|
| `/stop` | Cancel the running agent |
| `/restart` | Restart OpenCode Server (external server mode: recover previous session only) |

### Context (/compact)
| Command | Description |
|---------|-------------|
| `/compact` (`/summarize`) | Force-trigger OpenCode Server's context compaction for the current session via `POST /session/:id/summarize`. Uses the session's current model. Rejected while the agent is mid-turn (`/stop` first); allowed while a question or permission is pending. See `.omo/plans/compact-command-design.md` for rationale. |

### History (/history)
| Command | Description |
|---------|-------------|
| `/history` (`/hist`) | Show the most recent N text-bearing messages from the current session in chronological order (oldest at top, newest at bottom). Optional trailing positive integer N (default 5, range 1-20; 0/negative/>20 are rejected with no silent clamp). Read-only — works while the agent is busy. Display: text parts only — turns with zero text parts (pure tool-call / reasoning / file turns, common with the Sisyphus ultraworker style) are filtered out entirely so the chat log stays a chat log; user messages marked 👤 + timestamp, assistant messages marked 🤖 + timestamp + agent/model; each text body is forwarded in full (the bridge does NOT truncate to 500 chars — long messages are split into multiple WeChat sends by the outbound queue, which honours the 4000-char per-message cap). Header carries the session title (when available, fetched best-effort via `GET /session/:id`) and cwd; appends `(实际显示 X 条)` when the over-fetched window doesn't have N text turns. Over-fetches by 3× (capped at 60) and picks the LAST N text-bearing messages so the header count always matches the request. Fetches via `GET /session/:id/message?limit=N`; the server returns OLDEST-FIRST (its `MessageV2.page` does its own `items.reverse()`), so the bridge does NOT reverse again. |

### Thought Display (/thought-display)
| Command | Description |
|---------|-------------|
| `/thought-display on` (default) | Show model reasoning in WeChat as a single `🧠 Thought · {summary} · {duration}` line per reasoning block (no body — only the summary) |
| `/thought-display off` | Hide reasoning from WeChat (only logged to bridge log) |
| `/thought-display status` | Show current thought display state |

Settings persist independently across bridge restarts (~/.wechat-bridge-opencode/.wechat-bridge-state.json).

### Tool Display (/tool-display)
| Command | Description |
|---------|-------------|
| `/tool-display on` (default) | Show tool summary at end of turn (emoji + tool name + opencode-generated title; e.g. `✅ webfetch https://httpbin.org/get`, `✅ bash exit 0`) |
| `/tool-display off` | Hide tool summary |
| `/tool-display status` | Show current tool display state |

Settings persist independently across bridge restarts (~/.wechat-bridge-opencode/.wechat-bridge-state.json).

### Silent Mode (/silent)
| Command | Description |
|---------|-------------|
| `/silent on` (default off) | Enable silent mode (沉浸模式) — hide reasoning, tool summaries, and incremental text parts during a turn; only send the final text reply at turn completion. Questions and permission requests are unaffected. |
| `/silent off` | Disable silent mode — resume real-time display of reasoning/tool/incremental text |
| `/silent status` | Show current silent mode state |
| `/sl` (alias) | Short alias for `/silent` |

Settings persist independently across bridge restarts (~/.wechat-bridge-opencode/.wechat-bridge-state.json).

### System
| Command | Description |
|---------|-------------|
| `/version` | Show Bridge, OpenCode Server, and the latest version published to npm; hints `/restart` (sidecar mode) when a newer server version is available. External-server mode cannot update via the bridge |

### Message Limit (/next)
| Command | Description |
|---------|-------------|
| `/next` | WeChat limits bots to 10 consecutive messages; user reply required to continue. Send `/next` to reset the counter without forwarding to the agent |

### Question (/reject-question)
| Command | Description |
|---------|-------------|
| `/reject-question` (alias `/rq`) | Dismiss a pending LLM `question` request. The agent receives `QuestionRejectedError` and proceeds without an answer. No-op if no question is pending. |

The bridge surfaces OpenCode's `question` tool to WeChat (`question.asked` / `replied` / `rejected` events). Reply grammar: `Q{n}={value}` to pick, `Q{n}-{text}` to force a custom answer, or positional `1 --- 2 --- 3` for ordered single-answers. Multi-question, multi-select, and dash-marker custom text are supported; mobile whitespace around `=` is tolerated. 30-minute soft timeout auto-rejects unanswered questions. Full grammar and edge cases in `.omo/plans/question-tool-design.md`.

### Permission (/reject-permission, /auto-permission)
| Command | Description |
|---------|-------------|
| `/reject-permission` (alias `/rp`) | Dismiss all pending permission cards. No-op if none pending. |
| `/auto-permission` (alias `/ap`) | Auto-accept mode: `off` (default — show card), `once` (auto-`once`), `always` (auto-`always`). Subcommand `status` queries current mode. Persists across restarts. |

The bridge surfaces OpenCode's `permission.asked` events to WeChat as a card with `once` / `always` / `reject` choices. Reply grammar: `1`/`2`/`3` (positional), `once`/`always`/`reject` (keywords), or `P{n}={value}` for per-permission control when 2+ are pending. 30-minute soft timeout auto-rejects. Full grammar, card format, and v2 cascade semantics in `.omo/plans/permission-tool-design.md`.

> Server-side `always` rules live in `InstanceState.approved` (in-memory only). They are lost on `opencode serve` restart; the bridge does NOT shadow-store them.
### Cross-session notifications (/notify)

| Command | Description |
|---------|-------------|
| `/notify` (alias `/n`) | Manage cross-session notifications |
| `/notify on\|off` | Master switch (default: on) |
| `/notify status` | Show current configuration |
| `/notify types <type> on\|off` | Toggle a single event type: question / permission / error / completion |

SSE events for non-current sessions are forwarded to WeChat as notifications (title + working directory + sub-agent marker). Switching to a session with a pending question/permission re-renders the card. See `src/notifier.ts` / `src/adapter/notify-format.ts` / `src/server/session.ts:1460-1485` (event filter).

