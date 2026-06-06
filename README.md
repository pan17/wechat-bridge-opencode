# WeChat OpenCode

[中文](README.md) | [English](README.en.md)

将微信私聊消息桥接到 OpenCode Server（HTTP API），支持文本、图片、文件、音视频的双向传输。

<img src="./resources/发送.jpg" alt="发送" width="49%" /> <img src="./resources/接收.jpg" alt="接收" width="49%" />

## 功能

- **文本消息** — 微信与 OpenCode 之间的双向文本传输
- **图片传输** — 支持发送/接收图片，支持微信 CDN 下载
- **文件传输** — 支持任意类型文件收发
- **音视频传输** — 完整的音频和视频消息支持
- **二维码登录** — 终端渲染二维码，扫码登录微信
- **OpenCode Server** — 基于 HTTP API，不再需要 ACP 子进程
- **后台模式** — 使用 `--daemon` 参数后台运行
- **send-wechat 工具** — Agent 可直接发送文字、文件、图片到微信

## 安装

### 方式一：一键运行（推荐）
无需安装，`npx` 会自动下载并运行：
```bash
npx wechat-bridge-opencode
```

### 方式二：全局安装
```bash
npm install -g wechat-bridge-opencode
```
安装完成后，可使用简写命令：
```bash
wbo
```

## 使用
```bash
cd /path/to/your/project
wbo
# 或直接使用 npx：
# npx wechat-bridge-opencode
```

首次运行会：
1. 自动启动 `opencode serve`（HTTP Server）
2. 终端显示二维码
3. 扫码登录微信
4. 保存登录令牌到 `~/.wechat-bridge-opencode`
5. 开始轮询微信私信

## 选项

| 参数 | 说明 |
|------|------|
| `--cwd <目录>` | 工作目录 |
| `--server-url <url>` | OpenCode Server 地址（默认 http://localhost:4096） |
| `--no-server` | 不自动启动 opencode serve（使用外部 Server） |
| `--login` | 强制重新登录 |
| `--daemon` | 后台运行 |
| `--config <文件>` | JSON 配置文件 |
| `--idle-timeout <分钟>` | 会话空闲超时（默认 0 = 无限） |

## 微信命令

### 工作区（`/workspace` 或 `/ws`）

| 命令 | 说明 |
|------|------|
| `/workspace status` | 显示当前工作区 |
| `/workspace switch <路径>` | 切换到指定目录 |
| `/workspace add <路径>` | 添加并切换到目录 |

### 会话（`/session` 或 `/s`）

| 命令 | 说明 |
|------|------|
| `/session list` | 列出服务器上的会话 |
| `/session switch <n>` | 切换到指定会话 |
| `/session new` | 新会话（清除上下文） |
| `/session status` | 显示当前会话 |

### Agent（`/agent` 或 `/a`）

| 命令 | 说明 |
|------|------|
| `/agent list` | 列出可用 Agent 模式，带序号和当前标记 |
| `/agent switch <名称\|n>` | 按名称或序号切换 Agent 模式 |
| `/agent status` | 显示当前 Agent 模式 |

### Model（`/model`）

| 命令 | 说明 |
|------|------|
| `/model list` | 列出模型提供商及其数量 |
| `/model switch <provider/model>` | 切换模型（如 anthropic/claude-sonnet-4-5） |
| `/model status` | 显示当前模型 |

### Reasoning（`/reasoning`）

| 命令 | 说明 |
|------|------|
| `/reasoning list` | 列出可用推理级别 |
| `/reasoning switch <level>` | 切换推理级别 |
| `/reasoning status` | 显示当前推理级别 |

### 状态（`/status`）

| 命令 | 说明 |
|------|------|
| `/status` | 显示当前会话、工作区、Agent、模型、推理级别和上下文使用情况 |

### 停止（`/stop`）

| 命令 | 说明 |
|------|------|
| `/stop` | 停止正在运行的 Agent |
| `/restart` | 新会话（清除上下文） |

### 思考（`/thinking`）

| 命令 | 说明 |
|------|------|
| `/thinking off` | 关闭思考与工具显示 |
| `/thinking off tools` | 仅关闭工具显示 |
| `/thinking status` | 查看当前显示设置 |

### 消息计数（`/next`）

| 命令 | 说明 |
|------|------|
| `/next` | 微信限制连续发送 10 条消息，超出后需用户回复才能继续。发送 `/next` 重置计数，不转发给 Agent |

## 环境要求

- Node.js 20+
- 微信 iLink 机器人 API 访问权限
- [OpenCode](https://github.com/anomalyco/opencode)（需支持 `opencode serve` 命令）
- Bridge 会自动启动 `opencode serve`，也可通过 `--no-server` 使用外部实例

## 数据存储

运行时数据存储在 `~/.wechat-bridge-opencode`：
- 登录令牌
- 认证令牌
- 临时文件（下载的媒体）
- 守护进程 PID / 日志
- 桥接状态（`.wechat-bridge-state.json`）

## 注意事项

- 仅支持私信（群聊会被忽略）
- 权限请求自动批准
- `send-wechat` 工具自动安装到 `~/.config/opencode/tools/send-wechat.ts`

## 致谢

本项目基于 [wechat-acp](https://github.com/formulahendry/wechat-acp)（作者 [formulahendry](https://github.com/formulahendry)）二次开发，感谢原作者的贡献！

## 许可证

MIT
