# AGENTS.md — wechat-opencode

> Bridge WeChat direct messages to OpenCode Server via HTTP API.

## Project Overview

- **Package**: `wechat-bridge-opencode` v0.3.10 — ESM-only (`"type": "module"`)
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
```

**No test framework or linter is configured.** This is a lean project with only `tsc` for builds.

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
src/server/
  client.ts                     — OpenCode Server HTTP client (fetch wrapper)
  session.ts                    — Simplified SessionManager (no subprocess, just HTTP)
src/adapter/
  inbound.ts                    — WeChat message → MessagePart[] (text, image, file)
  outbound.ts                   — Server reply → WeChat text (formatting, splitting)
  workspace-cmd.ts              — Parse /workspace, /session, /agent, /model, /reasoning, /help commands
src/weixin/
  auth.ts                       — WeChat iLink login (QR code, token persistence)
  monitor.ts                    — Long-poll for new messages
  send.ts                       — Send text/image/file/video to WeChat
  api.ts                        — WeChat iLink API (typing indicator, config)
  media.ts                      — CDN download + AES decryption
  types.ts                      — WeChat iLink types (MessageType, UploadMediaType, etc.)
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
3. **New CLI option**: Add to `parseArgs()` in `bin/wechat-opencode.ts`, update `usage()`, pass through to config

## Constraints

- **Direct messages only** — group chats are intentionally ignored
- **Permission requests are auto-approved** — handled server-side by OpenCode
- **Single-user** — one WeChat user, one OpenCode session at a time
- **Runtime state** stored in `~/.wechat-opencode/` (auth tokens, daemon PID, logs, user states)

## WeChat Commands

### Workspace (/workspace or /ws)
| Command | Description |
|---------|-------------|
| `/workspace list` | List all workspaces sorted by recent activity, numbered |
| `/workspace status` | Show current workspace directory |
| `/workspace switch <path>` | Switch to directory by path |
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
| `/reasoning list` | List actual reasoning levels for the current model (from model variants) |
| `/reasoning switch <level>` | Switch reasoning level |
| `/reasoning status` | Show current reasoning level |

### Status (/status)
| Command | Description |
|---------|-------------|
| `/status` | Show current session (with title), workspace, agent, model, reasoning, context usage. Agent/model/reasoning fetched from server; defaults from config when no history |

### Stop (/stop)
| Command | Description |
|---------|-------------|
| `/stop` | Cancel the running agent |
| `/restart` | New session (clear context) |

### Thinking (/thought)
| Command | Description |
|---------|-------------|
| `/thought on` | Enable thinking & tool display |
| `/thought off` | Disable thinking & tool display |
| `/thought status` | Show current thinking & tool display settings |

### Help
| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |

## References

- **OpenCode** — https://github.com/anomalyco/opencode
  The AI agent this project bridges to. Source for OpenCode Server HTTP API.
- **OpenCode Server Docs** — https://opencode.ai/docs/server/
  Official documentation for the OpenCode Server REST API and SSE event stream.
- **OpenCode SDK** — https://opencode.ai/docs/sdk/
  TypeScript SDK for interacting with OpenCode Server (`@opencode-ai/sdk`).
- **OpenClaw Weixin** — https://github.com/Tencent/openclaw-weixin
  Official WeChat iLink API reference implementation. Authoritative source for image/file/video sending patterns, CDN upload flows, and AES-ECB encryption details.
