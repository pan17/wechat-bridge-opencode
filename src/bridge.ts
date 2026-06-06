/**
 * WeChatOpencodeBridge — the main orchestrator.
 *
 * Single-user architecture: no Map<string, ...> patterns.
 * Communicates with OpenCode Server via HTTP (not ACP subprocess).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType, UploadMediaType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./server/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { MediaContent } from "./types.js";
import {
  parseWorkspaceCommand,
  parseSessionCommand,
  parseAgentCommand,
  parseModelCommand,
  parseReasoningCommand,
  parseStatusCommand,
  parseThinkingCommand,
  parseStopCommand,
  parseRestartCommand,
  parseHelpCommand,
  formatHelpWithNativeCommands,
  formatStatus,
} from "./adapter/workspace-cmd.js";
import type { WeChatOpencodeConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const TOOL_API_PORT = 18792;
const TOOL_API_HOST = "127.0.0.1";

/** A message cached when WeChat 10-msg limit is reached, flushed on /next. */
type PendingMessage =
  | { kind: "text"; text: string; contextToken: string }
  | { kind: "media"; block: MediaContent; contextToken: string }
  | { kind: "tool_text"; text: string; contextToken: string }
  | { kind: "tool_file"; filePath: string; fileName: string; mimeType?: string; contextToken: string };

interface UserState {
  userId: string;
  sessionId: string;
  cwd: string;
}

export class WeChatOpencodeBridge {
  private config: WeChatOpencodeConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  private userState: UserState | null = null;
  private currentContextToken: string | null = null;
  private typingTicket: { ticket: string; expiresAt: number } | null = null;
  private toolApiServer: http.Server | null = null;

  // Single-user state (no Map<string, ...>)
  private wechatMsgCount = 0;
  private pendingOutbound: PendingMessage[] = [];
  private static readonly MSG_LIMIT_WARN = 7;
  private static readonly MSG_LIMIT_MAX = 10;
  private log: (msg: string) => void;

  constructor(config: WeChatOpencodeConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-opencode] ${msg}`));
  }

  // ─── Lifecycle ───

  async start(opts?: { forceLogin?: boolean; renderQrUrl?: (url: string) => void }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    const authDir = path.join(this.config.storage.dir, "auth");
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(tempDir, { recursive: true });
    this.log(`Auth directory: ${authDir}`);
    this.log(`Temp directory: ${tempDir}`);

    // 1. Login
    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
    }
    if (!this.tokenData) {
      this.tokenData = await login({
        baseUrl: this.config.wechat.baseUrl,
        botType: this.config.wechat.botType,
        storageDir: this.config.storage.dir,
        log: this.log,
        renderQrUrl,
      });
    } else {
      this.log(`Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`);
      this.log("Use --login to force re-login");
    }

    // 2. Load saved user state
    this.loadUserState();

    // 3. Create SessionManager (HTTP-based, no subprocess)
    this.sessionManager = new SessionManager({
      serverUrl: this.config.server.url,
      cwd: this.config.agent.cwd,
      log: this.log,
      onReply: (contextToken, text) => this.sendReply(contextToken, text),
      onMediaReply: (contextToken, blocks) => this.sendMediaReply(contextToken, blocks),
      sendTyping: (contextToken) => this.sendTypingIndicator(contextToken),
      onSessionReady: (sessionId) => {
        if (!this.userState) {
          this.setUserState(sessionId, this.config.agent.cwd);
        } else if (this.userState.sessionId !== sessionId) {
          this.setUserState(sessionId, this.userState.cwd);
        }
      },
    });

    // 4. Tool API server
    this.startToolApiServer();

    // 5. Monitor loop
    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg) => this.handleMessage(msg),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    this.sessionManager = null;
    if (this.toolApiServer) {
      await new Promise<void>((resolve) => this.toolApiServer!.close(() => resolve()));
      this.toolApiServer = null;
    }
    this.log("Bridge stopped");
  }

  // ─── User state (single-user) ───

  private loadUserState(): void {
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      const raw = fs.readFileSync(stateFile, "utf-8");
      const state = JSON.parse(raw) as
        | { sessionId?: string; cwd: string }
        | { users?: Array<{ userId: string; sessionId?: string; cwd: string }> };
      if ("users" in state && state.users && state.users.length > 0) {
        const u = state.users[0];
        this.userState = { userId: u.userId ?? "", sessionId: u.sessionId ?? "", cwd: u.cwd };
      } else if ("sessionId" in state || "cwd" in state) {
        this.userState = {
          userId: "",
          sessionId: (state as { sessionId?: string }).sessionId ?? "",
          cwd: (state as { cwd: string }).cwd,
        };
      }
    } catch {
      // No saved state
    }
  }

  private saveUserState(): void {
    if (!this.userState) return;
    try {
      const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          { sessionId: this.userState.sessionId, cwd: this.userState.cwd, updatedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
    } catch {
      // Best effort
    }
  }

  private setUserState(sessionId: string, cwd: string): void {
    const userId = this.userState?.userId ?? "";
    this.userState = { userId, sessionId, cwd };
    this.saveUserState();
  }

  // ─── Tool API (send-wechat endpoint) ───

  private startToolApiServer(): void {
    this.toolApiServer = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/send-wechat") {
        res.writeHead(404);
        res.end();
        return;
      }

      let body = "";
      for await (const chunk of req) body += chunk;

      try {
        const { filePath, mimeType, text } = JSON.parse(body) as {
          sessionId?: string; userId?: string; filePath?: string; mimeType?: string; text?: string;
        };

        if (!text && !filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Either text or filePath is required" }));
          return;
        }

        const targetUserId = this.userState?.userId ?? "";
        const contextToken = this.currentContextToken ?? "";
        const results: string[] = [];

        // Send text
        if (text) {
          const segments = splitText(text, TEXT_CHUNK_LIMIT);
          for (const segment of segments) {
            if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
              this.log(`[tool-api] WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching remaining text segments`);
              const remaining = segments.slice(segments.indexOf(segment));
              const cached: PendingMessage[] = remaining.map((s) => ({ kind: "tool_text", text: s, contextToken }));
              this.pendingOutbound = [...this.pendingOutbound, ...cached];
              break;
            }
            this.wechatMsgCount++;
            let payload = segment;
            if (this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN) {
              payload += `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条），发送 /next 可重置`;
            }
            await sendTextMessage(targetUserId, payload, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
            });
          }
          results.push("text");
          this.log(`[tool-api] Sent text (${text.length} chars, sent=${this.wechatMsgCount})`);
        }

        // Send file
        if (filePath) {
          if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
            this.log(`[tool-api] WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching file`);
            const fName = path.basename(filePath);
            this.pendingOutbound.push({ kind: "tool_file", filePath, fileName: fName, mimeType, contextToken });
          } else {
            this.wechatMsgCount++;
            const fileBuffer = await fs.promises.readFile(filePath);
            const fileName = path.basename(filePath);
            const detectedMimeType = mimeType ?? this.guessMimeType(fileName);
            await sendMediaMessage(targetUserId, this.mimeToMediaType(detectedMimeType), fileBuffer, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
              cdnBaseUrl: this.config.wechat.cdnBaseUrl,
              mimeType: detectedMimeType,
              fileName,
            });
            results.push("file");
            this.log(`[tool-api] Sent file ${fileName} (sent=${this.wechatMsgCount})`);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sent: results }));
      } catch (err) {
        this.log(`[tool-api] Error: ${String(err)}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });

    this.toolApiServer.listen(TOOL_API_PORT, TOOL_API_HOST, () => {
      this.log(`Tool API server listening on ${TOOL_API_HOST}:${TOOL_API_PORT}`);
    });
    this.toolApiServer.on("error", (err) => {
      this.log(`Tool API server error: ${String(err)}`);
    });
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      bmp: "image/bmp", ico: "image/x-icon",
      mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
      mkv: "video/x-matroska", webm: "video/webm", flv: "video/x-flv",
      wmv: "video/x-ms-wmv", m4v: "video/mp4", "3gp": "video/3gpp",
      mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac",
      ogg: "audio/ogg", flac: "audio/flac", wma: "audio/x-ms-wma",
      m4a: "audio/mp4", amr: "audio/amr", opus: "audio/opus",
      pdf: "application/pdf", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ppt: "application/vnd.ms-powerpoint",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      txt: "text/plain", md: "text/markdown", json: "application/json",
      js: "text/javascript", ts: "text/typescript", py: "text/x-python",
      java: "text/x-java", go: "text/x-go", rs: "text/x-rust",
      c: "text/x-c", cpp: "text/x-c++", h: "text/x-c",
      cs: "text/x-csharp", php: "text/x-php", rb: "text/x-ruby",
      swift: "text/x-swift", kt: "text/x-kotlin", scala: "text/x-scala",
      html: "text/html", css: "text/css", xml: "text/xml",
      yaml: "text/yaml", yml: "text/yaml", toml: "text/toml",
      ini: "text/plain", cfg: "text/plain", conf: "text/plain",
      log: "text/plain", csv: "text/csv",
      zip: "application/zip", rar: "application/vnd.rar",
      "7z": "application/x-7z-compressed", tar: "application/x-tar",
      gz: "application/gzip", bz2: "application/x-bzip2",
    };
    return map[ext] ?? "application/octet-stream";
  }

  private mimeToMediaType(mime: string): 1 | 2 | 3 | 4 {
    if (mime.startsWith("image/")) return UploadMediaType.IMAGE;
    if (mime.startsWith("video/")) return UploadMediaType.VIDEO;
    return UploadMediaType.FILE;
  }

  // ─── Message handling ───

  private handleMessage(msg: WeixinMessage): void {
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    // Track context token for send-wechat tool replies
    this.currentContextToken = contextToken;

    // Ensure user state — always set userId, loadUserState may have set it to ""
    if (!this.userState) {
      this.userState = { userId, sessionId: "", cwd: this.config.agent.cwd };
    } else {
      this.userState.userId = userId;
    }

    // User reply resets the WeChat 10-message gateway limit
    this.wechatMsgCount = 0;

    // Auto-flush pending cache on any user message
    if (this.pendingOutbound.length > 0 && !/^\/next\b/.test(this.extractTextFromMessage(msg)?.trim() ?? "")) {
      this.flushPending(contextToken).catch((err) => {
        this.log(`auto-flush error: ${String(err)}`);
      });
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    const textContent = this.extractTextFromMessage(msg);
    if (textContent) {
      if (parseHelpCommand(textContent)) {
        this.sendHelpReply(contextToken).catch(() => {});
        return;
      }

      const wsCmd = parseWorkspaceCommand(textContent);
      if (wsCmd) {
        this.handleDirectoryCommand(contextToken, wsCmd).catch((err) => {
          this.log(`Directory command error: ${String(err)}`);
        });
        return;
      }

      const sCmd = parseSessionCommand(textContent);
      if (sCmd) {
        this.handleSessionCommand(contextToken, sCmd).catch((err) => {
          this.log(`Session command error: ${String(err)}`);
        });
        return;
      }

      const aCmd = parseAgentCommand(textContent);
      if (aCmd) {
        this.handleAgentCommand(contextToken, aCmd).catch((err) => {
          this.log(`Agent command error: ${String(err)}`);
        });
        return;
      }

      const mCmd = parseModelCommand(textContent);
      if (mCmd) {
        this.handleModelCommand(contextToken, mCmd).catch((err) => {
          this.log(`Model command error: ${String(err)}`);
        });
        return;
      }

      const rCmd = parseReasoningCommand(textContent);
      if (rCmd) {
        this.handleReasoningCommand(contextToken, rCmd).catch((err) => {
          this.log(`Reasoning command error: ${String(err)}`);
        });
        return;
      }

      const stCmd = parseStatusCommand(textContent);
      if (stCmd) {
        this.handleStatusCommand(contextToken, stCmd).catch((err) => {
          this.log(`Status command error: ${String(err)}`);
        });
        return;
      }

      const thCmd = parseThinkingCommand(textContent);
      if (thCmd) {
        this.handleThinkingCommand(contextToken, thCmd).catch((err) => {
          this.log(`Thinking command error: ${String(err)}`);
        });
        return;
      }

      const stopCmd = parseStopCommand(textContent);
      if (stopCmd) {
        this.handleStopCommand(contextToken, stopCmd).catch((err) => {
          this.log(`Stop command error: ${String(err)}`);
        });
        return;
      }

      // /next — flush cached messages, do NOT forward to agent
      if (/^\/next\b/.test(textContent.trim())) {
        this.flushPending(contextToken).catch((err) => {
          this.log(`/next error: ${String(err)}`);
        });
        return;
      }

      const restartCmd = parseRestartCommand(textContent);
      if (restartCmd) {
        this.handleRestartCommand(contextToken, restartCmd).catch((err) => {
          this.log(`Restart command error: ${String(err)}`);
        });
        return;
      }

      // Unrecognized slash commands — send hint, then forward to agent
      const slashHint = this.detectUnknownSlashCommand(textContent);
      if (slashHint) {
        this.sendReply(contextToken, slashHint).catch(() => {});
        this.enqueueMessage(msg, contextToken).catch((err) => {
          this.log(`Failed to enqueue message: ${String(err)}`);
        });
        return;
      }
    }

    this.enqueueMessage(msg, contextToken).catch((err) => {
      this.log(`Failed to enqueue message: ${String(err)}`);
    });
  }

  // ─── Directory commands (/workspace or /ws) ───

  private async handleDirectoryCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseWorkspaceCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const currentCwd = this.userState?.cwd ?? this.config.agent.cwd;
        const sessions = await this.sessionManager.listServerSessions();
        // Derive unique workspaces from session titles (or just show current)
        await this.sendReply(contextToken, `📂 Current workspace:\n  ${currentCwd}\n\n💡 Use /workspace switch <path> to change`);
        break;
      }

      case "status": {
        const cwd = this.userState?.cwd ?? this.config.agent.cwd;
        await this.sendReply(contextToken, `📂 ${cwd}`);
        break;
      }

      case "switch": {
        if (!cmd!.name) {
          await this.sendReply(contextToken, "Usage: /workspace switch <path>");
          return;
        }
        const targetDir = cmd!.name;
        const state = this.userState;
        if (state && state.cwd === targetDir) {
          await this.sendReply(contextToken, `Already on ${targetDir}`);
          return;
        }
        if (!fs.existsSync(targetDir)) {
          await this.sendReply(contextToken, `❌ Directory does not exist: ${targetDir}`);
          return;
        }
        await this.sendReply(contextToken, `🔄 Switching to\n  ${targetDir}`);
        try {
          await this.sessionManager.switchWorkspace(targetDir, undefined);
          this.setUserState(this.sessionManager.getSessionId() ?? "", targetDir);
          await this.sendReply(contextToken, `✅ Ready on\n  ${targetDir}`);
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "add": {
        const targetPath = cmd!.path!;
        const state = this.userState;
        if (state && state.cwd === targetPath) {
          await this.sendReply(contextToken, `Already on ${targetPath}`);
          return;
        }
        try {
          fs.mkdirSync(targetPath, { recursive: true });
        } catch (err) {
          await this.sendReply(contextToken, `Failed to create directory: ${String(err)}`);
          return;
        }
        await this.sendReply(contextToken, `🔄 Switching to\n  ${targetPath}`);
        try {
          await this.sessionManager.switchWorkspace(targetPath, undefined);
          this.setUserState(this.sessionManager.getSessionId() ?? "", targetPath);
          await this.sendReply(contextToken, `✅ Ready on\n  ${targetPath}`);
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "remove": {
        await this.sendReply(contextToken, "Use /workspace switch to change directories.");
        break;
      }
    }
  }

  // ─── Session commands (/session or /s) ───

  private async handleSessionCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseSessionCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        try {
          const sessions = await this.sessionManager.listServerSessions();
          const lines: string[] = ["💬 Recent Sessions:"];
          for (let i = 0; i < Math.min(sessions.length, 10); i++) {
            const s = sessions[i];
            lines.push(`  ${i + 1}. ${s.title ?? "(untitled)"}`);
          }
          await this.sendReply(contextToken, lines.join("\n"));
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Failed to list sessions: ${String(err)}`);
        }
        break;
      }

      case "switch": {
        const idx = parseInt(cmd!.name!, 10);
        try {
          const sessions = await this.sessionManager.listServerSessions();
          if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
            const target = sessions[idx - 1];
            const cwd = this.userState?.cwd ?? this.config.agent.cwd;
            await this.sendReply(contextToken, `🔄 Switching to "${target.title ?? "(untitled)"}"`);
            await this.sessionManager.switchSession(target.sessionId, cwd);
            this.setUserState(target.sessionId, cwd);
            await this.sendReply(contextToken, `✅ Ready`);
          } else {
            await this.sendReply(contextToken, `Session "${cmd!.name}" not found. Use /session list to see available sessions.`);
          }
        } catch (err) {
          await this.sendReply(contextToken, `❌ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const sid = this.sessionManager.getSessionId();
        if (sid) {
          await this.sendReply(contextToken, `💬 Session: ${sid}`);
        } else {
          const cwd = this.userState?.cwd ?? this.config.agent.cwd;
          await this.sendReply(contextToken, `📂 ${cwd}`);
        }
        break;
      }

      case "new": {
        const cwd = this.userState?.cwd ?? this.config.agent.cwd;
        try {
          await this.sessionManager.createNewSession(cwd);
          await this.sendReply(contextToken, "✅ Session restarted. Context cleared.");
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Failed: ${String(err)}`);
        }
        break;
      }

      case "remove": {
        await this.sendReply(contextToken, "Sessions are managed by OpenCode.");
        break;
      }
    }
  }

  // ─── Agent commands (/agent or /a) ───

  private async handleAgentCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseAgentCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        // Ensure agents are fetched (they load on session creation, but may still be in-flight)
        if (this.sessionManager.getAvailableModes().length === 0) {
          // Try refreshing once
          try {
            await this.sessionManager.refreshAgents();
          } catch { /* ignore */ }
        }
        const currentMode = this.sessionManager.getActiveMode();
        const availableModes = this.sessionManager.getAvailableModes();
        const lines = ["🤖 Agent (mode):"];
        if (availableModes.length > 0) {
          for (let i = 0; i < availableModes.length; i++) {
            const m = availableModes[i];
            const marker = m.id === currentMode ? " ✅" : "";
            lines.push(`  ${i + 1}. ${m.name}${marker}`);
          }
        } else {
          lines.push("  (no available modes)");
        }
        lines.push("");
        lines.push("💡 Use /agent switch <name|n> to switch");
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        const input = cmd!.name!.trim();
        const availableModes = this.sessionManager.getAvailableModes();
        const index = parseInt(input, 10);
        let targetMode: string;

        if (!isNaN(index) && index >= 1 && index <= availableModes.length) {
          targetMode = availableModes[index - 1].id;
        } else {
          const match = availableModes.find(
            (m) => m.name.toLowerCase() === input.toLowerCase() || m.id.toLowerCase() === input.toLowerCase(),
          );
          if (!match) {
            await this.sendReply(contextToken, `⚠️ "${input}" not found`);
            return;
          }
          targetMode = match.id;
        }

        try {
          await this.sessionManager.switchAgent(targetMode);
          await this.sendReply(contextToken, `✅ Agent switched to ${targetMode}`);
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const mode = this.sessionManager.getActiveMode();
        await this.sendReply(contextToken, `🤖 Current Agent: ${mode ?? "(not set)"}`);
        break;
      }
    }
  }

  // ─── Model commands (/model) ───

  private async handleModelCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseModelCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        // Ensure models are fetched
        if (this.sessionManager.getAvailableModels().length === 0) {
          try {
            await this.sessionManager.refreshProviders();
          } catch { /* ignore */ }
        }
        const currentModelId = this.sessionManager.getCurrentModel();
        const allModels = this.sessionManager.getAvailableModels();
        const lines = ["📱 Models:"];

        // Group by provider
        const byProvider = new Map<string, Array<{ modelId: string; name: string }>>();
        for (const m of allModels) {
          const provider = m.modelId.split("/")[0];
          if (!byProvider.has(provider)) byProvider.set(provider, []);
          byProvider.get(provider)!.push(m);
        }

        if (byProvider.size === 0) {
          lines.push(`  Current: ${currentModelId ?? "(not set)"}`);
        } else {
          for (const [provider, models] of byProvider) {
            const marker = currentModelId?.startsWith(`${provider}/`) ? " ✅" : "";
            lines.push(`  ${provider} (${models.length})${marker}`);
          }
          lines.push("");
          lines.push("💡 Use /model list <provider> to list models");
          lines.push("   Use /model switch <provider/model> to switch");
        }
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        const input = cmd!.name!.trim();
        if (!input.includes("/")) {
          await this.sendReply(contextToken, `⚠️ Use full model name (provider/model), e.g. anthropic/claude-sonnet-4-5`);
          return;
        }
        try {
          await this.sessionManager.setModel(input);
          await this.sendReply(contextToken, `✅ Model switched to ${input}`);
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const model = this.sessionManager.getCurrentModel();
        await this.sendReply(contextToken, `📱 Current Model: ${model ?? "(not set)"}`);
        break;
      }
    }
  }

  // ─── Reasoning commands (/reasoning) ───

  private async handleReasoningCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseReasoningCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const levels = this.sessionManager.getReasoningLevels();
        const lines = ["🧠 Reasoning levels:"];
        if (levels.length > 0) {
          for (const lv of levels) {
            const marker = lv.current ? " ✅" : "";
            lines.push(`  ${lv.value}${marker} — ${lv.name}`);
          }
        } else {
          lines.push("  (not available)");
        }
        lines.push("");
        lines.push("💡 Use /reasoning switch <level>");
        await this.sendReply(contextToken, lines.join("\n"));
        break;
      }

      case "switch": {
        try {
          await this.sessionManager.setReasoning(cmd!.name!.toLowerCase());
          await this.sendReply(contextToken, `✅ Reasoning set to ${cmd!.name}`);
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const level = this.sessionManager.getCurrentReasoning();
        await this.sendReply(contextToken, `🧠 Reasoning: ${level ?? "(not set)"}`);
        break;
      }
    }
  }

  // ─── Status command (/status) ───

  private async handleStatusCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseStatusCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    const cwd = this.userState?.cwd ?? this.config.agent.cwd;
    const currentMode = this.sessionManager.getActiveMode();
    const currentModel = this.sessionManager.getCurrentModel() ?? "(not set)";
    const currentReasoning = this.sessionManager.getCurrentReasoning() ?? "(not set)";
    const contextUsage = this.sessionManager.getContextUsage();
    const sessionId = this.sessionManager.getSessionId();

    const sessionInfo = sessionId ? { id: sessionId, cwd } : null;

    const statusText = formatStatus({
      session: sessionInfo,
      workspace: cwd,
      agent: currentMode ?? "(not set)",
      model: currentModel,
      reasoning: currentReasoning,
      contextUsage: contextUsage ? { used: contextUsage.totalTokens, size: contextUsage.contextSize } : null,
    });

    await this.sendReply(contextToken, statusText);
  }

  // ─── Thinking command (/thinking) ───

  private async handleThinkingCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseThinkingCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const flags = this.sessionManager.getShowFlags();
        const thoughtStatus = flags.showThoughts ? "✅ On" : "❌ Off";
        const toolStatus = flags.showTools ? "✅ On" : "❌ Off";
        await this.sendReply(contextToken, `🧠 Thinking & Tools:\n  💭 Thinking: ${thoughtStatus}\n  🔧 Tools: ${toolStatus}`);
        break;
      }

      case "on": {
        await this.sendReply(contextToken, "⏸️ Feature temporarily disabled.");
        break;
      }

      case "off": {
        if (cmd!.target === "tools") {
          this.sessionManager.setShowFlags({ showTools: false });
          await this.sendReply(contextToken, "❌ Tool display off");
        } else if (cmd!.target === "thoughts") {
          this.sessionManager.setShowFlags({ showThoughts: false });
          await this.sendReply(contextToken, "❌ Thinking display off");
        } else {
          this.sessionManager.setShowFlags({ showThoughts: false, showTools: false });
          await this.sendReply(contextToken, "❌ Thinking & tool display off");
        }
        break;
      }
    }
  }

  // ─── Stop command (/stop) ───

  private async handleStopCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseStopCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    try {
      await this.sessionManager.cancelPrompt();
      await this.sendReply(contextToken, "🛑 Stop signal sent");
    } catch (err) {
      this.log(`Cancel error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ Stop failed: ${String(err)}`);
    }
  }

  // ─── Restart command (/restart) ───

  private async handleRestartCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseRestartCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    await this.sendReply(contextToken, "🔄 Restarting session...");
    try {
      const cwd = this.userState?.cwd ?? this.config.agent.cwd;
      await this.sessionManager.createNewSession(cwd);
      await this.sendReply(contextToken, "✅ Session restarted");
    } catch (err) {
      this.log(`Restart error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ Restart failed: ${String(err)}`);
    }
  }

  // ─── Helpers ───

  private detectUnknownSlashCommand(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const match = trimmed.match(/^\/(\w+)/);
    if (!match) return null;

    const cmdName = match[1].toLowerCase();
    const bridgeCommands = [
      "workspace", "ws", "session", "s", "agent", "a", "model",
      "reasoning", "help", "h", "?", "status", "thinking", "stop",
      "restart", "next",
    ];
    if (bridgeCommands.includes(cmdName)) return null;

    return `⚠️ Command "/${match[1]}" is not a bridge command, forwarding to agent.`;
  }

  private async sendHelpReply(contextToken: string): Promise<void> {
    const nativeCommands = this.sessionManager?.getAvailableCommands() ?? [];
    const helpText = formatHelpWithNativeCommands(nativeCommands);
    await this.sendReply(contextToken, helpText);
  }

  private extractTextFromMessage(msg: WeixinMessage): string | null {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) return item.text_item.text;
    }
    return null;
  }

  private async enqueueMessage(msg: WeixinMessage, contextToken: string): Promise<void> {
    const tempDir = path.join(this.config.storage.dir, "tempfile");
    const parts = await weixinMessageToPrompt(msg, this.config.wechat.cdnBaseUrl, this.log, tempDir);
    await this.sessionManager!.enqueue(parts, contextToken);
  }

  private async flushPending(contextToken: string): Promise<void> {
    if (this.pendingOutbound.length === 0) {
      await this.sendReply(contextToken, "✅ No cached messages");
      return;
    }

    this.wechatMsgCount = 0;
    this.log(`/next: flushing ${this.pendingOutbound.length} cached messages`);

    const remaining: PendingMessage[] = [];
    let sent = 0;

    for (const msg of this.pendingOutbound) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        remaining.push(msg);
        continue;
      }
      this.wechatMsgCount++;

      try {
        const text = msg.kind === "text" || msg.kind === "tool_text" ? msg.text : "";
        const payload =
          text && this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN
            ? text + `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条），发送 /next 可重置`
            : text;

        switch (msg.kind) {
          case "text":
          case "tool_text":
            await sendTextMessage(this.userState?.userId ?? "", payload || msg.text, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
            });
            break;
          case "media":
            if (msg.block.type === "image" && msg.block.data) {
              await sendMediaMessage(this.userState?.userId ?? "", UploadMediaType.IMAGE, Buffer.from(msg.block.data, "base64"), {
                baseUrl: this.tokenData!.baseUrl,
                token: this.tokenData!.token,
                contextToken,
                cdnBaseUrl: this.config.wechat.cdnBaseUrl,
                mimeType: msg.block.mimeType ?? "image/jpeg",
              });
            } else if (msg.block.type === "resource" && msg.block.blob) {
              const buf = Buffer.from(msg.block.blob, "base64");
              const mime = msg.block.resourceMimeType ?? "application/octet-stream";
              const mediaType = this.mimeToMediaType(mime);
              const fileName = msg.block.uri ? msg.block.uri.split("/").pop() : "file";
              await sendMediaMessage(this.userState?.userId ?? "", mediaType, buf, {
                baseUrl: this.tokenData!.baseUrl,
                token: this.tokenData!.token,
                contextToken,
                cdnBaseUrl: this.config.wechat.cdnBaseUrl,
                mimeType: mime,
                fileName,
              });
            }
            break;
          case "tool_file": {
            const buf = await fs.promises.readFile(msg.filePath);
            const mime = msg.mimeType ?? this.guessMimeType(msg.fileName);
            await sendMediaMessage(this.userState?.userId ?? "", this.mimeToMediaType(mime), buf, {
              baseUrl: this.tokenData!.baseUrl,
              token: this.tokenData!.token,
              contextToken,
              cdnBaseUrl: this.config.wechat.cdnBaseUrl,
              mimeType: mime,
              fileName: msg.filePath.split(/[\\/]/).pop(),
            });
            break;
          }
        }
        sent++;
      } catch (err) {
        this.log(`/next send error: ${String(err)}`);
      }
    }

    if (remaining.length > 0) {
      this.pendingOutbound = remaining;
      await this.sendReply(contextToken, `✅ Sent ${sent}, ${remaining.length} cached, /next to continue`);
    } else {
      this.pendingOutbound = [];
      await this.sendReply(contextToken, `✅ All ${sent} cached messages sent`);
    }
  }

  private async sendReply(contextToken: string, text: string): Promise<void> {
    const formatted = formatForWeChat(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);

    for (const segment of segments) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        this.log(`WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching remaining segments`);
        const remaining = segments.slice(segments.indexOf(segment));
        const cached: PendingMessage[] = remaining.map((s) => ({ kind: "text", text: s, contextToken }));
        this.pendingOutbound = [...this.pendingOutbound, ...cached];
        break;
      }

      this.wechatMsgCount++;
      let payload = segment;
      if (this.wechatMsgCount > WeChatOpencodeBridge.MSG_LIMIT_WARN) {
        payload += `\n\n⚠️ 微信限制连续发送消息数量10条（已发 ${this.wechatMsgCount} 条），发送 /next 可重置`;
      }

      await sendTextMessage(this.userState?.userId ?? "", payload, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
      this.log(`Sent text (${payload.length} chars, sent=${this.wechatMsgCount})`);
    }

    this.cancelTypingIndicator(contextToken).catch(() => {});
  }

  private async sendMediaReply(contextToken: string, blocks: MediaContent[]): Promise<void> {
    for (const block of blocks) {
      if (this.wechatMsgCount >= WeChatOpencodeBridge.MSG_LIMIT_MAX) {
        this.log(`WeChat 10-msg limit reached (sent=${this.wechatMsgCount}), caching media`);
        const remaining = blocks.slice(blocks.indexOf(block));
        const cached: PendingMessage[] = remaining.map((b) => ({ kind: "media", block: b, contextToken }));
        this.pendingOutbound = [...this.pendingOutbound, ...cached];
        break;
      }

      this.wechatMsgCount++;
      const targetUserId = this.userState?.userId ?? "";

      if (block.type === "image" && block.data) {
        await sendMediaMessage(targetUserId, UploadMediaType.IMAGE, Buffer.from(block.data, "base64"), {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: block.mimeType ?? "image/jpeg",
        });
        this.log(`Sent image (sent=${this.wechatMsgCount})`);
      } else if (block.type === "resource" && block.blob) {
        const buf = Buffer.from(block.blob, "base64");
        const mime = block.resourceMimeType ?? "application/octet-stream";
        const mt = this.mimeToMediaType(mime);
        const fileName = block.uri ? block.uri.split("/").pop() : "file";
        await sendMediaMessage(targetUserId, mt, buf, {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken,
          cdnBaseUrl: this.config.wechat.cdnBaseUrl,
          mimeType: mime,
          fileName,
        });
        const typeLabel = mt === UploadMediaType.IMAGE ? "image" : mt === UploadMediaType.VIDEO ? "video" : "file";
        this.log(`Sent ${typeLabel} (sent=${this.wechatMsgCount})`);
      }
    }
    this.cancelTypingIndicator(contextToken).catch(() => {});
  }

  // ─── Typing indicator ───

  private async cancelTypingIndicator(contextToken: string): Promise<void> {
    const ticket = await this.getTypingTicket(contextToken);
    if (!ticket) return;
    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: { ilink_user_id: this.userState?.userId ?? "", typing_ticket: ticket, status: TypingStatus.CANCEL },
    });
  }

  private async sendTypingIndicator(contextToken: string): Promise<void> {
    try {
      const ticket = await this.getTypingTicket(contextToken);
      if (!ticket) return;
      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: { ilink_user_id: this.userState?.userId ?? "", typing_ticket: ticket, status: TypingStatus.TYPING },
      });
    } catch {
      // best-effort
    }
  }

  private async getTypingTicket(contextToken: string): Promise<string | null> {
    if (this.typingTicket && this.typingTicket.expiresAt > Date.now()) return this.typingTicket.ticket;
    try {
      const resp = await getConfig({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        ilinkUserId: this.userState?.userId ?? "",
        contextToken,
      });
      if (resp.typing_ticket) {
        this.typingTicket = { ticket: resp.typing_ticket, expiresAt: Date.now() + 24 * 60 * 60_000 };
        return resp.typing_ticket;
      }
    } catch {
      // Not critical
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) return item.voice_item?.text ? `[voice] ${item.voice_item.text.substring(0, 30)}` : "[voice]";
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }
}
