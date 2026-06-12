# OpenCode Server API 参考（zh-cn）

> 来源：https://opencode.ai/docs/zh-cn/server/
> 上游原文仓库：https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/zh-cn/server.mdx

本文件是 OpenCode Server HTTP API 的精简参考，便于 wechat-opencode bridge 离线查阅。
完整规范以 OpenAPI 3.1 形式发布在 `<server>/doc`。

## 启动

```bash
opencode serve [--port <number>] [--hostname <string>] [--cors <origin>]
```

| Flag | Default | 说明 |
|------|---------|------|
| `--port` | `4096` | 监听端口 |
| `--hostname` | `127.0.0.1` | 监听主机名 |
| `--mdns` | `false` | 启用 mDNS 发现 |
| `--mdns-domain` | `opencode.local` | mDNS 自定义域名 |
| `--cors` | `[]` | 额外允许的浏览器来源（可多次传） |

## 认证

```bash
OPENCODE_SERVER_PASSWORD=your-password opencode serve
```

- 用户名默认 `opencode`，可用 `OPENCODE_SERVER_USERNAME` 覆盖
- 适用于 `opencode serve` 和 `opencode web`
- desktop 版 server 用户名固定为 `opencode`，password = 服务端生成的 token

## 连接

- TUI 启动时随机分配端口和主机名
- 多个客户端可以连同一 server
- `/tui` 端点用于通过 server 驱动 TUI（IDE 插件用）

## 全局

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/global/health` | 健康状态 + version |
| `GET` | `/global/event` | 全局事件 SSE 流 |

## 项目

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/project` | 列出所有项目 |
| `GET` | `/project/current` | 当前项目 |

## 路径和 VCS

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/path` | 当前路径 |
| `GET` | `/vcs` | VCS 信息 |

## 实例

| Method | Path | 说明 |
|--------|------|------|
| `POST` | `/instance/dispose` | 销毁当前实例 |

## 配置

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/config` | 获取配置 |
| `PATCH` | `/config` | 更新配置 |
| `GET` | `/config/providers` | 列出提供商和默认模型 |

## 提供商

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/provider` | 列出所有提供商 |
| `GET` | `/provider/auth` | 获取提供商认证方式 |
| `POST` | `/provider/{id}/oauth/authorize` | OAuth 授权 |
| `POST` | `/provider/{id}/oauth/callback` | OAuth 回调 |

## 会话

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/session` | 列出会话 |
| `POST` | `/session` | 创建会话，body `{ parentID?, title? }` |
| `GET` | `/session/status` | 全部会话状态 |
| `GET` | `/session/:id` | 会话详情 |
| `DELETE` | `/session/:id` | 删除会话及数据 |
| `PATCH` | `/session/:id` | 更新 `title` |
| `GET` | `/session/:id/children` | 子会话 |
| `GET` | `/session/:id/todo` | 待办列表 |
| `POST` | `/session/:id/init` | 分析项目生成 `AGENTS.md` |
| `POST` | `/session/:id/fork` | 分叉会话 |
| `POST` | `/session/:id/abort` | 中止运行 |
| `POST` | `/session/:id/share` | 分享 |
| `DELETE` | `/session/:id/share` | 取消分享 |
| `GET` | `/session/:id/diff` | 会话内文件 diff |
| `POST` | `/session/:id/summarize` | 总结 |
| `POST` | `/session/:id/revert` | 回退消息 |
| `POST` | `/session/:id/unrevert` | 恢复已回退 |
| `POST` | `/session/:id/permissions/:permissionID` | 响应权限请求 |

## 消息

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/session/:id/message` | 列出消息，`?limit=` |
| `POST` | `/session/:id/message` | 发送消息并等待响应 |
| `GET` | `/session/:id/message/:messageID` | 消息详情 |
| `POST` | `/session/:id/prompt_async` | 异步发送消息（不等待，204） |
| `POST` | `/session/:id/command` | 执行 slash command |
| `POST` | `/session/:id/shell` | 运行 shell 命令 |

## 命令

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/command` | 列出所有命令 |

## 文件

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/find?pattern=<pat>` | 文本搜索 |
| `GET` | `/find/file?query=<q>` | 按名查找 |
| `GET` | `/find/symbol?query=<q>` | 查找符号 |
| `GET` | `/file?path=<path>` | 列文件和目录 |
| `GET` | `/file/content?path=<p>` | 读文件 |
| `GET` | `/file/status` | 已跟踪文件状态 |

## 工具（实验性）

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/experimental/tool/ids` | 列出工具 ID |
| `GET` | `/experimental/tool?provider=<p>&model=<m>` | 列出模型工具 + JSON Schema |

## LSP、Formatter、MCP

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/lsp` | LSP 状态 |
| `GET` | `/formatter` | Formatter 状态 |
| `GET` | `/mcp` | MCP 状态（`?directory=` 限定工作区） |
| `POST` | `/mcp` | 动态添加 MCP server |

## 代理

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/agent` | 列出所有代理（`?directory=` 限定工作区） |

## 日志

| Method | Path | 说明 |
|--------|------|------|
| `POST` | `/log` | 写日志条目，body `{ service, level, message, extra? }` |

## TUI

| Method | Path | 说明 |
|--------|------|------|
| `POST` | `/tui/append-prompt` | 追加提示词 |
| `POST` | `/tui/open-help` | 打开帮助 |
| `POST` | `/tui/open-sessions` | 会话选择器 |
| `POST` | `/tui/open-themes` | 主题选择器 |
| `POST` | `/tui/open-models` | 模型选择器 |
| `POST` | `/tui/submit-prompt` | 提交提示词 |
| `POST` | `/tui/clear-prompt` | 清除提示词 |
| `POST` | `/tui/execute-command` | 执行命令 |
| `POST` | `/tui/show-toast` | toast 消息 |
| `GET` | `/tui/control/next` | 等待下一个控制请求 |
| `POST` | `/tui/control/response` | 响应控制请求 |

## 认证（provider）

| Method | Path | 说明 |
|--------|------|------|
| `PUT` | `/auth/:id` | 设置 provider 凭据 |

## 事件

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/event` | SSE 事件流（首事件 `server.connected`） |

## 文档

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/doc` | OpenAPI 3.1 规范 HTML |

## 工作原理

- `opencode` 启动 TUI + server，TUI 作为 server 的客户端
- Server 暴露 OpenAPI 3.1 端点（同样用于生成 SDK）
- 这种架构让多个客户端连同一 server，也支持编程化交互
- 已有 TUI 跑着时，`opencode serve` 会启新 server（不接管现有）
