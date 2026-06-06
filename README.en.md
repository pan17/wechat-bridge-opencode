# WeChat OpenCode

[中文](README.md) | [English](README.en.md)

Bridge WeChat direct messages to OpenCode Server (HTTP API), with full bidirectional support for text, images, files, audio, and video.

<img src="./resources/发送.jpg" alt="Send" width="49%" /> <img src="./resources/接收.jpg" alt="Receive" width="49%" />

## Features

- **Text** — Send/receive messages between WeChat and OpenCode
- **Images** — Send/receive images with WeChat CDN support
- **Files** — Send/receive files of any type
- **Audio/Video** — Full audio and video message support
- **QR Login** — Terminal QR code rendering for WeChat login
- **OpenCode Server** — HTTP API based, no ACP subprocess required
- **Daemon Mode** — Run in background with `--daemon`
- **send-wechat Tool** — Agents can send text, files, and images back to WeChat

## Install

### Method 1: One-click run (Recommended)
No installation required, `npx` will download and run automatically:
```bash
npx wechat-bridge-opencode
```

### Method 2: Global install
```bash
npm install -g wechat-bridge-opencode
```
After installation, use the shorthand command:
```bash
wbo
```

## Usage
```bash
cd /path/to/your/project
wbo
# or use npx directly:
# npx wechat-bridge-opencode
```

First run will:
1. Auto-start `opencode serve` (HTTP Server)
2. Show QR code in terminal
3. Scan QR with WeChat
4. Save login token to `~/.wechat-bridge-opencode`
5. Start polling WeChat DMs

## Options

| Flag | Description |
|------|-------------|
| `--cwd <dir>` | Working directory |
| `--server-url <url>` | OpenCode Server URL (default: http://localhost:4096) |
| `--no-server` | Don't auto-start opencode serve (use external Server) |
| `--login` | Force re-login |
| `--daemon` | Run in background |
| `--config <file>` | JSON config file |
| `--idle-timeout <min>` | Session idle timeout (default: 0 = unlimited) |

## WeChat Commands

### Workspace (`/workspace` or `/ws`)

| Command | Description |
|---------|-------------|
| `/workspace list` | List all workspaces sorted by recent activity, numbered |
| `/workspace status` | Show current workspace |
| `/workspace switch <path>` | Switch to directory by path |
| `/workspace add <path>` | Add and switch to directory |

### Session (`/session` or `/s`)

| Command | Description |
|---------|-------------|
| `/session list` | List 20 most recent sessions with cwd |
| `/session list current` | List 20 most recent sessions in current workspace |
| `/session switch <n>` | Switch to session by index (auto-switches workspace) |
| `/session new` | New session (clear context) |
| `/session status` | Show current session info |

### Agent (`/agent` or `/a`)

| Command | Description |
|---------|-------------|
| `/agent list` | List available primary (non-built-in) agent modes with index |
| `/agent switch <name\|n>` | Switch mode by name or index |
| `/agent status` | Show current agent mode |

### Model (`/model`)

| Command | Description |
|---------|-------------|
| `/model list` | List model providers with counts |
| `/model list <provider>` | List all models under a specific provider |
| `/model switch <provider/model>` | Switch model (e.g. anthropic/claude-sonnet-4-5) |
| `/model status` | Show current model |

### Reasoning (`/reasoning`)

| Command | Description |
|---------|-------------|
| `/reasoning list` | List actual reasoning levels for the current model (from model variants) |
| `/reasoning switch <level>` | Switch reasoning level |
| `/reasoning status` | Show current reasoning level |

### Status (`/status`)

| Command | Description |
|---------|-------------|
| `/status` | Show current session (with title), workspace, agent, model, reasoning, context usage. Agent/model/reasoning fetched from server; defaults from config when no history |

### Stop (`/stop`)

| Command | Description |
|---------|-------------|
| `/stop` | Stop the running agent |
| `/restart` | New session (clear context) |

### Thinking (`/thought`)

| Command | Description |
|---------|-------------|
| `/thought on` | Enable thinking & tool display |
| `/thought off` | Disable thinking & tool display |
| `/thought status` | Show current thinking & tool display settings |

### Message Limit (`/next`)

| Command | Description |
|---------|-------------|
| `/next` | WeChat limits bots to 10 consecutive messages; user reply required to continue. Send `/next` to reset the counter without forwarding to the agent |

## Requirements

- Node.js 20+
- WeChat iLink bot API access
- [OpenCode](https://github.com/anomalyco/opencode) (requires `opencode serve` support)
- Bridge auto-starts `opencode serve`; use `--no-server` for external instances

## Storage

Runtime data stored in `~/.wechat-bridge-opencode`:
- Login token
- Auth tokens
- Temp files (downloaded media)
- Daemon PID / log
- Bridge state (`.wechat-bridge-state.json`)

## Notes

- Direct messages only (group chats ignored)
- Permission requests are auto-approved
- `send-wechat` tool auto-installed to `~/.config/opencode/tools/send-wechat.ts`

## Acknowledgment

This project is based on [wechat-acp](https://github.com/formulahendry/wechat-acp) by [formulahendry](https://github.com/formulahendry). Thanks for the original work!

## License

MIT
