/**
 * WeChatOpencodeBridge — the main orchestrator.
 *
 * Single-user architecture: no Map<string, ...> patterns.
 * Communicates with OpenCode Server via HTTP (not ACP subprocess).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, sendMediaMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType, UploadMediaType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./server/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import { formatQuestionForWeChat, parseQuestionReply } from "./adapter/question-format.js";
import type { MediaContent } from "./types.js";
import type { QuestionPrompt } from "./types/question.js";
import {
  parseWorkspaceCommand,
  parseSessionCommand,
  parseAgentCommand,
  parseModelCommand,
  parseReasoningCommand,
  parseStatusCommand,
  parseThoughtDisplayCommand,
  parseToolDisplayCommand,
  parseStopCommand,
  parseRestartCommand,
  parseRejectQuestionCommand,
  parseVersionCommand,
  parseUpgradeCommand,
  parseHelpCommand,
  formatHelpWithNativeCommands,
  formatStatus,
  formatWorkspaceList,
} from "./adapter/workspace-cmd.js";
import type { WeChatOpencodeConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;
const TOOL_API_PORT = 18792;
const TOOL_API_HOST = "127.0.0.1";

/**
 * Read the bridge's own version from the nearest package.json. The compiled
 * output lives at `dist/src/bridge.js` (package.json is two levels up), but
 * when running TypeScript sources directly (e.g. via tsx) it lives at
 * `src/bridge.ts` (package.json is one level up). We try both candidates.
 */
const BRIDGE_VERSION: string = (() => {
  const require_ = createRequire(import.meta.url);
  const candidates = ["../../package.json", "../package.json"];
  for (const c of candidates) {
    try {
      const pkg = require_(c) as { name?: string; version?: string };
      if (pkg?.name === "wechat-bridge-opencode" && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "unknown";
})();

/**
 * Spawn a child process and collect stdout/stderr to completion (or timeout).
 * Used by the `/version` and `/upgrade` commands to invoke the OpenCode CLI.
 */
function spawnAndCollect(
  cmd: string,
  args: string[],
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === "win32";
    log(`[cli] spawn: ${cmd} ${args.join(" ")} (shell=${useShell})`);
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
        env: { ...process.env },
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      log(`[cli] timeout after ${timeoutMs}ms, killing`);
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(" ")}`));
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Build the `<cmd> <args>` pair for invoking `opencode upgrade` from a
 * server-spawn configuration.
 *
 * Heuristic: when the server command is `npx`, treat the first non-flag
 * arg as the package name (skipping any leading flags like `-y`). For
 * any other command, assume the binary itself accepts `upgrade` as a
 * subcommand directly.
 *
 * Examples:
 *   npx opencode-ai serve --port 4096  →  npx opencode-ai upgrade
 *   opencode serve --port 4096         →  opencode upgrade
 *   npx -y opencode-ai@0.5.0 serve …   →  npx opencode-ai@0.5.0 upgrade
 */
function buildUpgradeCommand(
  serverCommand: string,
  serverArgs: string[],
): { cmd: string; args: string[] } {
  if (serverCommand === "npx" && serverArgs.length > 0) {
    const pkgIdx = serverArgs.findIndex((a) => !a.startsWith("-"));
    if (pkgIdx !== -1) {
      return { cmd: serverCommand, args: [serverArgs[pkgIdx]!, "upgrade"] };
    }
  }
  return { cmd: serverCommand, args: ["upgrade"] };
}

/**
 * Resolve the npm package name used to install OpenCode, derived from the
 * server-spawn configuration. Used by `/version` to query the npm registry
 * for the latest available version.
 *
 * Defaults to `opencode-ai` for the typical npx or direct-binary install.
 * For npx invocations, returns the first non-flag arg with any `@version`
 * pin stripped. Handles both `opencode-ai@1.0.0` and scoped `@scope/pkg@1.0.0`.
 */
function resolveOpencodePackageName(
  serverCommand: string,
  serverArgs: string[],
): string {
  if (serverCommand === "npx" && serverArgs.length > 0) {
    const pkgIdx = serverArgs.findIndex((a) => !a.startsWith("-"));
    if (pkgIdx !== -1) {
      const arg = serverArgs[pkgIdx]!;
      // For scoped packages ("@scope/pkg"), the first "@" is at index 0 and
      // is part of the name; the version separator is the SECOND "@".
      // For unscoped packages, the first "@" is the version separator.
      const atIdx = arg.startsWith("@") ? arg.indexOf("@", 1) : arg.indexOf("@");
      if (atIdx > 0) return arg.slice(0, atIdx);
      return arg;
    }
  }
  return "opencode-ai";
}

/**
 * Compare two semver-ish strings and return true if `latest` is strictly
 * newer than `current`. Both arguments may have a `v` prefix; pre-release
 * tags (e.g. `-rc.1`) are ignored — we only compare `major.minor.patch`.
 * Returns false on parse failure.
 */
function isNewerSemver(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = v.replace(/^v/, "").split(/[-+]/)[0]?.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const l = parse(latest);
  const c = parse(current);
  if (!l || !c) return false;
  if (l[0] !== c[0]) return l[0] > c[0];
  if (l[1] !== c[1]) return l[1] > c[1];
  return l[2] > c[2];
}

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
  showThoughts?: boolean;
  showTools?: boolean;
}

export class WeChatOpencodeBridge {
  private config: WeChatOpencodeConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private tokenData: TokenData | null = null;
  private userState: UserState | null = null;
  /**
   * Cwd filter from the most recent `/session list`. `undefined` means the
   * last list was unfiltered (or no list has run); a string means the
   * next `/session switch <n>` should look up against that filtered list,
   * so the number the user sees in the list matches the number they type.
   * Reset on every `/session list` call.
   */
  private lastSessionListFilter: string | undefined = undefined;
  private currentContextToken: string | null = null;
  private typingTicket: { ticket: string; expiresAt: number } | null = null;
  private toolApiServer: http.Server | null = null;

  // Single-user state (no Map<string, ...>)
  private wechatMsgCount = 0;
  private pendingOutbound: PendingMessage[] = [];
  // Per-contextToken outbound FIFO queue. SessionManager fires multiple
  // `onReply` calls back-to-back (tool summary + thought line / text part)
  // without awaiting each other; without serialization the shorter payload
  // can race ahead of the longer one and reverse the chronological order
  // on WeChat. This chain ensures the WeChat server receives messages in
  // the same order the bridge dispatches them.
  private outboundQueue = new Map<string, Promise<unknown>>();
  private static readonly MSG_LIMIT_WARN = 7;
  private static readonly MSG_LIMIT_MAX = 10;
  private log: (msg: string) => void;
  private restartServer?: () => Promise<void>;

  constructor(
    config: WeChatOpencodeConfig,
    log?: (msg: string) => void,
    /**
     * Optional callback invoked by the `/restart` command. When provided, the
     * bridge will tear down its SSE event pipeline + cancel in-flight work,
     * then call this to restart the opencode serve subprocess, then re-attach
     * to the previous session (or create a new one if it's gone) and resume
     * the SSE pipeline.
     *
     * The callback is responsible for killing the old server and starting a
     * new one, and it MUST NOT return until the new server is reachable
     * (e.g. `/global/health` returns 200). The bridge will fail subsequent
     * session re-attach if the server is not actually up.
     *
     * When not provided (e.g. with `--server-url` to use an external
     * server), `/restart` falls back to re-attaching to the previous
     * session on the existing server.
     */
    restartServer?: () => Promise<void>,
  ) {
    this.config = config;
    this.log = log ?? ((msg: string) => console.log(`[wechat-opencode] ${msg}`));
    this.restartServer = restartServer;
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

    // Reset stale user state when the saved cwd no longer matches the
    // directory the bridge was started from. Without this, /status reports
    // the old cwd while the SessionManager and the actual opencode server
    // session use config.agent.cwd — so the agent runs in a different
    // directory than what the user sees. The user's last sessionId is
    // dropped too: it's tied to the old cwd and may not exist on the
    // server (or may belong to a different workspace's worktree).
    if (this.userState && this.userState.cwd !== this.config.agent.cwd) {
      this.log(
        `Discarding stale user state: saved cwd=${this.userState.cwd} ` +
          `does not match start cwd=${this.config.agent.cwd}`,
      );
      this.userState = null;
      // Persist the cleared state so subsequent reads stay consistent.
      try {
        const stateFile = path.join(this.config.storage.dir, ".wechat-bridge-state.json");
        fs.writeFileSync(stateFile, JSON.stringify({}, null, 2), "utf-8");
      } catch {
        // Best effort
      }
    }

    // 3. Create SessionManager (HTTP-based, no subprocess)
    this.sessionManager = new SessionManager({
      serverUrl: this.config.server.url,
      cwd: this.config.agent.cwd,
      log: this.log,
      onReply: (contextToken, text) => this.sendReply(contextToken, text),
      onMediaReply: (contextToken, blocks) => this.sendMediaReply(contextToken, blocks),
      sendTyping: (contextToken) => this.sendTypingIndicator(contextToken),
      cancelTyping: (contextToken) => this.cancelTypingIndicator(contextToken),
      onSessionReady: (sessionId) => {
        if (!this.userState) {
          this.setUserState(sessionId, this.config.agent.cwd);
        } else if (this.userState.sessionId !== sessionId) {
          this.setUserState(sessionId, this.userState.cwd);
        }
      },
      // Forward server auth verbatim. The values are sensitive — neither
      // the bridge nor the SessionManager logs them. The client only
      // computes the final `Authorization` header value at construction.
      auth: {
        username: this.config.server.username,
        password: this.config.server.password,
        token: this.config.server.token,
      },
      // Question lifecycle hooks. The sessionManager invokes these when
      // a `question.asked` SSE event lands (or when the 30-min soft
      // timeout fires). We render the question to WeChat and notify the
      // user on timeout, then let the sessionManager manage the actual
      // HTTP reply/reject.
      onQuestionAsked: async (contextToken, questions, requestID) => {
        const formatted = formatQuestionForWeChat(questions);
        await this.sendReply(contextToken, formatted);
        this.log(`[question] formatted for WeChat: id=${requestID.slice(0, 12)}…, ${questions.length} question(s)`);
      },
      onQuestionTimedOut: async (contextToken) => {
        await this.sendReply(
          contextToken,
          "⏱ Question timed out after 30 minutes. Proceeding without answer. (Use /next to reset counter.)",
        );
      },
    });

    // Restore persisted display flags (only if defined to avoid clobbering
    // server-side defaults). setShowFlags is partial-update safe: passing
    // `undefined` for a field leaves it untouched.
    if (this.userState && (this.userState.showThoughts !== undefined || this.userState.showTools !== undefined)) {
      this.sessionManager.setShowFlags({
        showThoughts: this.userState.showThoughts,
        showTools: this.userState.showTools,
      });
    }

    // 4. Tool API server
    this.startToolApiServer();

    // 4.5 Clean up any leaked questions from a previous bridge instance.
    // If the bridge crashed or restarted while a question was pending,
    // the server's `/question` endpoint will still list it; we reject
    // them proactively so the server's pending Map doesn't grow. This
    // is a best-effort cleanup — failures are logged but non-fatal.
    try {
      const leaked = await this.sessionManager.listLeakedQuestions(this.config.agent.cwd);
      for (const req of leaked) {
        this.log(`[question-startup] rejecting leaked question id=${req.id.slice(0, 12)}…`);
      }
      if (leaked.length > 0) {
        this.log(`[question-startup] rejected ${leaked.length} leaked question(s)`);
      }
    } catch (err) {
      this.log(`[question-startup] leaked-question check failed (non-fatal): ${String(err)}`);
    }

    // 5. Start the SSE event pipeline so we don't miss any agent events
    //    (session.status, message.part.delta, sub-agent completions, etc.).
    //    The pipeline is always-on and filters by sessionId internally.
    await this.sessionManager.startEventPipeline(this.config.agent.cwd);

    // 6. Monitor loop
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
    // Stop the SSE event pipeline before tearing down the session manager.
    if (this.sessionManager) {
      await this.sessionManager.stopEventPipeline();
    }
    // If a question was still pending when the user quit, reject it so the
    // server's `Deferred.await()` doesn't block forever. Best-effort:
    // network/parse errors are swallowed because the bridge is shutting
    // down anyway. The server's instance dispose finalizer would
    // eventually clean up stragglers, but we don't want to wait.
    if (this.sessionManager?.hasPendingQuestion()) {
      try {
        await this.sessionManager.rejectPendingQuestion();
      } catch {
        // best effort during shutdown
      }
    }
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
        | {
            sessionId?: string;
            cwd: string;
            showThoughts?: boolean;
            showTools?: boolean;
          }
        | {
            users?: Array<{ userId: string; sessionId?: string; cwd: string }>;
            showThoughts?: boolean;
            showTools?: boolean;
          };
      if ("users" in state && state.users && state.users.length > 0) {
        const u = state.users[0];
        this.userState = {
          userId: u.userId ?? "",
          sessionId: u.sessionId ?? "",
          cwd: u.cwd,
          showThoughts: state.showThoughts,
          showTools: state.showTools,
        };
      } else if ("sessionId" in state || "cwd" in state) {
        this.userState = {
          userId: "",
          sessionId: (state as { sessionId?: string }).sessionId ?? "",
          cwd: (state as { cwd: string }).cwd,
          showThoughts: state.showThoughts,
          showTools: state.showTools,
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
      const payload: Record<string, unknown> = {
        users: [
          {
            userId: this.userState.userId,
            sessionId: this.userState.sessionId,
            cwd: this.userState.cwd,
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      if (this.userState.showThoughts !== undefined) payload.showThoughts = this.userState.showThoughts;
      if (this.userState.showTools !== undefined) payload.showTools = this.userState.showTools;
      fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2));
    } catch {
      // Best effort
    }
  }

  private setUserState(sessionId: string, cwd: string): void {
    const userId = this.userState?.userId ?? "";
    // Preserve display flags (`showThoughts` / `showTools`) across workspace
    // and session switches — without this spread, /workspace switch or
    // /session switch would silently reset the user's display settings.
    this.userState = this.userState
      ? { ...this.userState, sessionId, cwd }
      : { userId, sessionId, cwd };
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

    // If a question is pending, the next user message is (almost always)
    // the answer. Route to handleQuestionReply which checks for priority
    // commands (/stop, /next, /restart, /reject-question) before
    // parsing the text as an answer. This early-return is essential —
    // we must NOT let the answer text accidentally trigger slash-command
    // parsing and lose the answer.
    if (this.sessionManager?.hasPendingQuestion()) {
      const text = this.extractTextFromMessage(msg);
      if (text === null) {
        // Non-text message (image/file/voice) while waiting for an
        // answer. Tell the user we need text and bail.
        this.sendReply(
          contextToken,
          "⚠️ 当前正在等待 question 答案，请用文本回复（数字或自定义文字，例如 `Q1=1` 或 `Q1-我的想法`）。",
        ).catch(() => {});
        return;
      }
      this.handleQuestionReply(contextToken, text).catch((err: unknown) => {
        this.log(`handleQuestionReply error: ${String(err)}`);
      });
      return;
    }

    // Track context token for send-wechat tool replies
    this.currentContextToken = contextToken;

    // Ensure user state — always set userId, loadUserState may have set it to ""
    if (!this.userState) {
      this.userState = { userId, sessionId: "", cwd: this.config.agent.cwd };
    } else {
      this.userState.userId = userId;
    }
    this.saveUserState();

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

      const tdCmd = parseThoughtDisplayCommand(textContent);
      if (tdCmd) {
        this.handleThoughtDisplayCommand(contextToken, tdCmd).catch((err) => {
          this.log(`Thought-display command error: ${String(err)}`);
        });
        return;
      }

      const tldCmd = parseToolDisplayCommand(textContent);
      if (tldCmd) {
        this.handleToolDisplayCommand(contextToken, tldCmd).catch((err) => {
          this.log(`Tool-display command error: ${String(err)}`);
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

      const vCmd = parseVersionCommand(textContent);
      if (vCmd) {
        this.handleVersionCommand(contextToken, vCmd).catch((err) => {
          this.log(`Version command error: ${String(err)}`);
        });
        return;
      }

      const upCmd = parseUpgradeCommand(textContent);
      if (upCmd) {
        this.handleUpgradeCommand(contextToken, upCmd).catch((err) => {
          this.log(`Upgrade command error: ${String(err)}`);
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

  /**
   * Handle the user's reply while a question is pending. Called from
   * `handleMessage` as an early-return when `sessionManager.hasPendingQuestion()`.
   *
   * Priority commands first (reject the question, then run the command):
   *   /reject-question (alias /rq) — explicit dismiss
   *   /stop                          — reject + abort the agent
   *   /next                          — reject + flush pending WeChat cache
   *   /restart                       — reject + restart the server
   *
   * Informational commands (run without rejecting; the question stays
   * pending so the user can still answer it after reading /status or
   * /help):
   *   /help, /status
   *
   * Anything else is parsed as a question answer using the Qn= / Qn-
   * grammar from `parseQuestionReply`. Slash commands we don't recognize
   * (e.g. /workspace, /agent) will fail to parse as an answer and we'll
   * tell the user to either answer normally or use /reject-question.
   */
  private async handleQuestionReply(contextToken: string, text: string): Promise<void> {
    const pending = this.sessionManager?.getPendingQuestion();
    if (!pending) return; // defensive — race could have cleared it

    const trimmed = text.trim();

    // ── Priority commands: reject first, then dispatch ──
    if (parseRejectQuestionCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      await this.sendReply(contextToken, "❌ Question dismissed.");
      return;
    }
    if (parseStopCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      this.handleStopCommand(contextToken, parseStopCommand(trimmed)!).catch((err: unknown) => {
        this.log(`Stop command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    if (/^\/next\b/.test(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      this.flushPending(contextToken).catch((err: unknown) => {
        this.log(`/next (during pending question) error: ${String(err)}`);
      });
      return;
    }
    if (parseRestartCommand(trimmed)) {
      await this.sessionManager!.rejectPendingQuestion();
      this.handleRestartCommand(contextToken, parseRestartCommand(trimmed)!).catch((err: unknown) => {
        this.log(`Restart command (during pending question) error: ${String(err)}`);
      });
      return;
    }

    // ── Informational commands: run without rejecting ──
    if (parseHelpCommand(trimmed)) {
      this.sendHelpReply(contextToken).catch((err: unknown) => {
        this.log(`Help command (during pending question) error: ${String(err)}`);
      });
      return;
    }
    const stCmd = parseStatusCommand(trimmed);
    if (stCmd) {
      this.handleStatusCommand(contextToken, stCmd).catch((err: unknown) => {
        this.log(`Status command (during pending question) error: ${String(err)}`);
      });
      return;
    }

    // ── Default: parse as question answer ──
    const parseResult = parseQuestionReply(trimmed, pending.questions);
    // Log warnings (out-of-range numbers, unrecognized segments, etc.)
    for (const w of parseResult.warnings) {
      this.log(`[question] parse warning: ${w}`);
    }
    // Some valid question has no answer (e.g. all numbers out of range)
    const anyEmpty = parseResult.answers.some((a) => a.length === 0);
    if (anyEmpty) {
      await this.sendReply(
        contextToken,
        "⚠️ No valid answer detected. Please reply with option numbers (e.g. \"1\") or type your own answer. Use /reject-question to dismiss.",
      );
      return;
    }
    // Show typing indicator while the agent resumes
    this.sendTypingIndicator(contextToken).catch((err: unknown) => {
      this.log(`sendTyping (during question reply) error: ${String(err)}`);
    });
    try {
      await this.sessionManager!.answerPendingQuestion(parseResult.answers);
    } catch (err) {
      // Server returned 4xx — most likely the question was already
      // answered (race) or rejected (timeout fired while user was typing)
      this.log(`[question] answer HTTP failed: ${String(err)}`);
      await this.sendReply(
        contextToken,
        "⏱ Question 已过期（可能已被其他端回答或超时）。请重发消息。",
      );
    }
  }

  // ─── Directory commands (/workspace or /ws) ───

  /**
   * Build the sorted workspace list used by `/workspace list` and the
   * index-based `/workspace switch <n>`. Always includes the current
   * workspace. Order matches the displayed numbering.
   */
  private async getSortedWorkspaces(
    currentCwd: string,
  ): Promise<Array<{ cwd: string }>> {
    if (!this.sessionManager) return [{ cwd: currentCwd }];
    // Fetch projects (they have time.updated for recency sorting)
    const projects = await this.sessionManager.listServerProjects();
    // Deduplicate by worktree, keep the most recent updatedAt
    const wsMap = new Map<string, number>();
    for (const p of projects) {
      const existing = wsMap.get(p.worktree) ?? 0;
      if (p.updatedAt > existing) wsMap.set(p.worktree, p.updatedAt);
    }
    // Always include current workspace
    if (!wsMap.has(currentCwd)) {
      wsMap.set(currentCwd, 0);
    }
    // Sort by recency descending, then by path for ties
    return [...wsMap.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([cwd]) => ({ cwd }));
  }

  private async handleDirectoryCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseWorkspaceCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "list": {
        const currentCwd = this.userState?.cwd ?? this.config.agent.cwd;
        const workspaces = await this.getSortedWorkspaces(currentCwd);
        await this.sendReply(contextToken, formatWorkspaceList(workspaces, currentCwd));
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
        const currentCwd = this.userState?.cwd ?? this.config.agent.cwd;
        const target = cmd!.name;

        // Resolve numeric index against the same sorted list that /workspace
        // list shows, so `/workspace switch 5` matches the 5th entry.
        const idx = parseInt(target, 10);
        let targetDir: string;
        if (/^\d+$/.test(target) && !isNaN(idx)) {
          const workspaces = await this.getSortedWorkspaces(currentCwd);
          if (idx < 1 || idx > workspaces.length) {
            await this.sendReply(
              contextToken,
              `❌ Index out of range: ${idx} (1..${workspaces.length})`,
            );
            return;
          }
          targetDir = workspaces[idx - 1]!.cwd;
        } else {
          targetDir = target;
        }

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
          const allSessions = await this.sessionManager.listServerSessions();
          // Apply cwd filter if specified
          let sessions = allSessions;
          if (cmd!.cwdFilter) {
            const filterCwd = cmd!.cwdFilter === "__current__"
              ? (this.userState?.cwd ?? this.config.agent.cwd)
              : cmd!.cwdFilter;
            sessions = allSessions.filter((s) => s.cwd === filterCwd);
          }
          // Stash the resolved filter so the next /session switch <n> uses
          // the same index space the user just saw. Set to the *resolved*
          // cwd (or undefined for unfiltered) so the switch handler doesn't
          // need to re-resolve "__current__".
          this.lastSessionListFilter = cmd!.cwdFilter
            ? cmd!.cwdFilter === "__current__"
              ? (this.userState?.cwd ?? this.config.agent.cwd)
              : cmd!.cwdFilter
            : undefined;
          const lines: string[] = [cmd!.cwdFilter ? `💬 Sessions in current workspace:` : "💬 Recent Sessions:"];
          const count = Math.min(sessions.length, 20);
          for (let i = 0; i < count; i++) {
            const s = sessions[i];
            const cwdSuffix = s.cwd ? `  📂 ${s.cwd}` : "";
            lines.push(`  ${i + 1}. ${s.title ?? "(untitled)"}${cwdSuffix}`);
          }
          if (count === 0) {
            lines.push("  (no sessions)");
          }
          lines.push("");
          lines.push("💡 使用 /session switch <编号> 切换会话");
          await this.sendReply(contextToken, lines.join("\n"));
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Failed to list sessions: ${String(err)}`);
        }
        break;
      }

      case "switch": {
        const idx = parseInt(cmd!.name!, 10);
        try {
          const allSessions = await this.sessionManager.listServerSessions();
          // Apply the same filter as the most recent /session list so the
          // number the user sees matches the number they type. Without this,
          // /session list current followed by /session switch 1 silently
          // hits session 1 of the *unfiltered* list (which can live in a
          // different workspace) instead of session 1 of the filtered list
          // the user just looked at.
          const sessions = this.lastSessionListFilter
            ? allSessions.filter((s) => s.cwd === this.lastSessionListFilter)
            : allSessions;
          if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
            const target = sessions[idx - 1];
            const newCwd = target.cwd ?? this.userState?.cwd ?? this.config.agent.cwd;
            await this.sendReply(contextToken, `🔄 Switching to "${target.title ?? "(untitled)"}"`);
            await this.sessionManager.switchSession(target.sessionId, newCwd);
            this.setUserState(target.sessionId, newCwd);
            await this.sendReply(contextToken, `✅ Ready on ${newCwd}`);
          } else {
            const hint = this.lastSessionListFilter
              ? ` (filter: ${this.lastSessionListFilter})`
              : "";
            await this.sendReply(
              contextToken,
              `Session "${cmd!.name}" not found in ${sessions.length} sessions${hint}. Use /session list to refresh.`,
            );
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
          // Show what carried over so the user can confirm inheritance at a
          // glance. /status will reflect the same values; this message just
          // makes the transition explicit.
          const agent = this.sessionManager.getActiveMode() ?? "(default)";
          const model = this.sessionManager.getCurrentModel() ?? "(default)";
          const reasoning = this.sessionManager.getCurrentReasoningDisplay();
          await this.sendReply(
            contextToken,
            [
              "✅ Session restarted. Context cleared.",
              `🤖 Agent: ${agent}`,
              `📱 Model: ${model}`,
              `🧠 Reasoning: ${reasoning}`,
            ].join("\n"),
          );
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
            // Show each agent's per-agent model/variant so users can see at
            // a glance which model and reasoning level switching to it
            // will adopt. Empty fields render as "(default)".
            const modelPart = m.model ? `${m.model.providerID}/${m.model.modelID}` : "(default)";
            const variantPart = m.variant ?? "(default)";
            lines.push(`  ${i + 1}. ${m.name}${marker} — ${modelPart} / ${variantPart}`);
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
          const result = await this.sessionManager.switchAgent(targetMode);
          // switchAgent may also adopt the agent's per-agent model/variant.
          // Surface that so the user knows what just happened to /status.
          const lines = [`✅ Agent switched to ${result.modeId}`];
          if (result.note) lines.push(`ℹ️ ${result.note}`);
          await this.sendReply(contextToken, lines.join("\n"));
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

        // If a provider filter is given, show models under that provider
        if (cmd!.provider) {
          const filter = cmd!.provider.toLowerCase();
          const filtered = allModels.filter((m) => m.modelId.toLowerCase().startsWith(`${filter}/`));
          const lines = [`📱 Models — ${cmd!.provider}:`];
          if (filtered.length === 0) {
            lines.push("  (no models found)");
          } else {
            for (const m of filtered) {
              const modelName = m.modelId.split("/").slice(1).join("/") || m.name;
              const marker = m.modelId === currentModelId ? " ◀" : "";
              lines.push(`  ${modelName}${marker}`);
            }
          }
          lines.push("");
          lines.push("💡 使用 /model switch <provider/model> 切换模型");
          await this.sendReply(contextToken, lines.join("\n"));
          break;
        }

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
          lines.push("💡 使用 /model list <provider> 查看模型列表");
          lines.push("   使用 /model switch <provider/model> 切换模型");
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
          const result = await this.sessionManager.setModel(input);
          // setModel may have cleared or reset the reasoning variant because
          // the previous one isn't valid on the new model. Surface that to
          // the user so they know what just happened to /status.
          const lines = [`✅ Model switched to ${result.modelId}`];
          if (result.note) lines.push(`ℹ️ ${result.note}`);
          await this.sendReply(contextToken, lines.join("\n"));
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
          const raw = this.sessionManager.getCurrentReasoning();
          if (!raw) {
            // Either the user picked "default" or setReasoning cleared the
            // value because the requested level isn't valid. Either way,
            // the next prompt will go out without a `variant` field.
            const requested = cmd!.name!.toLowerCase();
            if (requested === "default") {
              await this.sendReply(contextToken, `✅ Reasoning reset to server default (no variant will be sent)`);
            } else {
              await this.sendReply(contextToken, `✅ Reasoning cleared (will use server default)`);
            }
          } else {
            const display = this.sessionManager.getCurrentReasoningDisplay();
            const confirm = raw.toLowerCase() !== display.toLowerCase()
              ? `✅ Reasoning set to ${display} (${raw})`
              : `✅ Reasoning set to ${display}`;
            await this.sendReply(contextToken, confirm);
          }
        } catch (err) {
          await this.sendReply(contextToken, `⚠️ Switch failed: ${String(err)}`);
        }
        break;
      }

      case "status": {
        const display = this.sessionManager.getCurrentReasoningDisplay();
        const raw = this.sessionManager.getCurrentReasoning();
        // When the displayed name differs from the raw key (e.g. numeric key
        // "1" → "Low"), append the raw value so the user knows the variant id.
        const line = raw && raw.toLowerCase() !== display.toLowerCase()
          ? `🧠 Reasoning: ${display} (${raw})`
          : `🧠 Reasoning: ${display}`;
        await this.sendReply(contextToken, line);
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

    // Lazy-refresh agents/models if caches are empty
    if (this.sessionManager.getAvailableModes().length === 0) {
      try { await this.sessionManager.refreshAgents(); } catch { /* ignore */ }
    }
    if (this.sessionManager.getAvailableModels().length === 0) {
      try { await this.sessionManager.refreshProviders(); } catch { /* ignore */ }
    }

    const currentMode = this.sessionManager.getActiveMode();
    const currentModel = this.sessionManager.getCurrentModel() ?? "(not set)";
    let currentReasoning = this.sessionManager.getCurrentReasoningDisplay();
    if (currentReasoning === "(not set)") {
      // Default to the first reasoning level of the current model
      const levels = this.sessionManager.getReasoningLevels();
      if (levels.length > 0) {
        currentReasoning = levels[0].name;
      }
    }
    const contextUsage = this.sessionManager.getContextUsage();
    const sessionId = this.sessionManager.getSessionId();

    const sessionTitle = sessionId ? await this.sessionManager.getSessionTitle(sessionId).catch(() => undefined) : undefined;
    const sessionInfo = sessionId ? { id: sessionId, cwd, title: sessionTitle } : null;

    // Fetch MCP status. Failures are swallowed (the network call goes to
    // the local opencode server) and the section is omitted in that case.
    let mcpStatus: Record<string, import("./types.js").McpServerStatus> | null = null;
    try {
      mcpStatus = await this.sessionManager.getMcpStatus();
    } catch {
      // Server doesn't expose /mcp, or call failed — just skip the section.
    }

    let statusText = formatStatus({
      session: sessionInfo,
      workspace: cwd,
      agent: currentMode ?? "(not set)",
      model: currentModel,
      reasoning: currentReasoning,
      contextUsage: contextUsage ? { used: contextUsage.totalTokens, size: contextUsage.contextSize } : null,
      mcpStatus,
    });

    // Append a "⏳ Question pending" line if a question is waiting. We
    // mutate the returned string here (rather than inside formatStatus)
    // to keep the formatter a pure function. Showing elapsed seconds
    // helps the user decide whether to /reject-question and let the
    // agent proceed.
    if (this.sessionManager?.hasPendingQuestion()) {
      const pending = this.sessionManager.getPendingQuestion();
      if (pending) {
        const elapsedSec = Math.max(0, Math.floor((Date.now() - pending.askedAt) / 1000));
        const qLabel = `Q${pending.questions.length} question${pending.questions.length > 1 ? "s" : ""}`;
        const idShort = pending.requestID.slice(0, 12);
        statusText += `\n⏳ Question pending (${qLabel}, ${elapsedSec}s elapsed, id=${idShort}…)`;
      }
    }

    await this.sendReply(contextToken, statusText);
  }

  // ─── Thought display command (/thought-display) ───

  private async handleThoughtDisplayCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseThoughtDisplayCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const flags = this.sessionManager.getShowFlags();
        await this.sendReply(
          contextToken,
          flags.showThoughts ? "🧠 Thought display: ✅ On" : "🧠 Thought display: ❌ Off",
        );
        break;
      }

      case "on": {
        // Only mutate showThoughts; pass undefined for showTools so it isn't clobbered.
        this.sessionManager.setShowFlags({ showThoughts: true, showTools: undefined });
        if (this.userState) this.userState.showThoughts = true;
        this.saveUserState();
        await this.sendReply(contextToken, "✅ Thought display on");
        break;
      }

      case "off": {
        this.sessionManager.setShowFlags({ showThoughts: false, showTools: undefined });
        if (this.userState) this.userState.showThoughts = false;
        this.saveUserState();
        await this.sendReply(contextToken, "❌ Thought display off");
        break;
      }
    }
  }

  // ─── Tool display command (/tool-display) ───

  private async handleToolDisplayCommand(
    contextToken: string,
    cmd: ReturnType<typeof parseToolDisplayCommand>,
  ): Promise<void> {
    if (!this.sessionManager) return;

    switch (cmd!.kind) {
      case "status": {
        const flags = this.sessionManager.getShowFlags();
        await this.sendReply(
          contextToken,
          flags.showTools ? "🔧 Tool display: ✅ On" : "🔧 Tool display: ❌ Off",
        );
        break;
      }

      case "on": {
        // Only mutate showTools; pass undefined for showThoughts so it isn't clobbered.
        this.sessionManager.setShowFlags({ showThoughts: undefined, showTools: true });
        if (this.userState) this.userState.showTools = true;
        this.saveUserState();
        await this.sendReply(contextToken, "✅ Tool display on");
        break;
      }

      case "off": {
        this.sessionManager.setShowFlags({ showThoughts: undefined, showTools: false });
        if (this.userState) this.userState.showTools = false;
        this.saveUserState();
        await this.sendReply(contextToken, "❌ Tool display off");
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

    const cwd = this.userState?.cwd ?? this.config.agent.cwd;
    // Capture BEFORE any destructive operation — once we cancel/stop/restart
    // the original sessionId is still valid (server storage persists it),
    // and we want to re-attach to it.
    const previousSessionId = this.userState?.sessionId ?? this.sessionManager.getSessionId();

    // External-server mode (--server-url was used) — we don't own the
    // server process, so we can only re-attach to the existing session.
    if (!this.restartServer) {
      await this.sendReply(contextToken, "⚠️ 当前为外部 server 模式，无法重启 server；尝试恢复之前的会话");
      await this.restoreOrCreateSession(previousSessionId, cwd);
      return;
    }

    // We own the server — do a full restart: kill server, spawn new one,
    // wait for ready, then restore the previous session and resume SSE.
    await this.sendReply(contextToken, "🔄 重启 OpenCode Server...");
    try {
      // 1. Cancel any in-flight prompt (best-effort — server may be unresponsive soon)
      await this.sessionManager.cancelPrompt().catch((err) => {
        this.log(`Cancel prompt during restart (ignored): ${String(err)}`);
      });

      // 2. Tear down the SSE event pipeline (the old SSE connection is dead)
      await this.sessionManager.stopEventPipeline();

      // 3. Restart the server (CLI does stop + start + wait-for-health)
      const t0 = Date.now();
      await this.restartServer!();
      this.log(`Server restart took ${Date.now() - t0}ms`);

      // 4. Restore the previous session on the fresh server
      const restoredId = await this.restoreOrCreateSession(previousSessionId, cwd);

      // 5. Re-establish the SSE pipeline against the new server
      await this.sessionManager.startEventPipeline(cwd);

      const tag = restoredId === previousSessionId ? "已恢复" : "旧会话不存在，已创建新会话";
      await this.sendReply(contextToken, `✅ Server 已重启，会话${tag}\n  ${restoredId}`);
    } catch (err) {
      this.log(`Restart error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ 重启失败: ${String(err)}`);
    }
  }

  /**
   * Try to re-attach to `previousSessionId` on the current server. If the
   * session no longer exists (e.g. server data dir was wiped between
   * restarts), create a fresh one. Updates `userState.sessionId` and
   * reports back the resulting session id.
   */
  private async restoreOrCreateSession(
    previousSessionId: string | null,
    cwd: string,
  ): Promise<string> {
    if (!this.sessionManager) throw new Error("No session manager");

    let sessionId: string;
    if (previousSessionId) {
      try {
        await this.sessionManager.switchSession(previousSessionId, cwd);
        sessionId = previousSessionId;
        this.log(`Restored session ${previousSessionId}`);
      } catch (err) {
        this.log(`Previous session ${previousSessionId} not found, creating new: ${String(err)}`);
        sessionId = await this.sessionManager.createNewSession(cwd);
      }
    } else {
      sessionId = await this.sessionManager.createNewSession(cwd);
    }

    if (this.userState) this.userState.sessionId = sessionId;
    return sessionId;
  }

  // ─── Version command (/version) ───

  private async handleVersionCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseVersionCommand>,
  ): Promise<void> {
    const lines: string[] = ["📦 Versions:"];

    // Bridge version (always available — read from package.json at module load)
    lines.push(`  🌉 Bridge: v${BRIDGE_VERSION}`);

    // OpenCode Server version (from /global/health — doesn't require a session)
    const serverVersion = this.sessionManager
      ? await this.sessionManager.getServerVersion()
      : null;
    if (serverVersion) {
      lines.push(`  🖥️  Server: v${serverVersion}`);
    } else {
      lines.push(`  🖥️  Server: (unreachable at ${this.config.server.url})`);
    }

    // Latest version from the npm registry (best-effort — never fail the
    // command if the registry is unreachable).
    const pkgName = resolveOpencodePackageName(
      this.config.server.command ?? "npx",
      this.config.server.args ?? [],
    );
    const latestVersion = await this.getLatestNpmVersion(pkgName);
    if (latestVersion) {
      const upgradeHint =
        serverVersion && isNewerSemver(latestVersion, serverVersion)
          ? "  ⬆️ 有新版本可用 `/upgrade`"
          : "";
      lines.push(`  📡 Latest: v${latestVersion}  (${pkgName})${upgradeHint}`);
    } else {
      lines.push(`  📡 Latest: (unable to query npm registry)`);
    }

    await this.sendReply(contextToken, lines.join("\n"));
  }

  /**
   * Fetch the `version` field from `https://registry.npmjs.org/<pkg>/latest`.
   * Returns null on any failure (network, timeout, 404, malformed JSON) so
   * the `/version` command stays usable offline.
   */
  private async getLatestNpmVersion(pkgName: string): Promise<string | null> {
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        this.log(`npm registry ${res.status} for ${pkgName}`);
        return null;
      }
      const data = (await res.json()) as { version?: string };
      return typeof data.version === "string" ? data.version : null;
    } catch (err) {
      this.log(`npm registry fetch failed: ${String(err)}`);
      return null;
    }
  }

  // ─── Upgrade command (/upgrade) ───

  private async handleUpgradeCommand(
    contextToken: string,
    _cmd: ReturnType<typeof parseUpgradeCommand>,
  ): Promise<void> {
    // External-server mode: we don't own the server process, so we can't
    // upgrade it in-place. Tell the user to upgrade on the server host.
    if (!this.restartServer) {
      await this.sendReply(
        contextToken,
        "⚠️ 当前为外部 server 模式，无法通过桥接升级 OpenCode；请在运行 server 的机器上执行 `opencode upgrade` 后重启 server",
      );
      return;
    }
    if (!this.sessionManager) return;

    // Capture the running version BEFORE we start, so we can report the delta.
    const oldVersion = await this.sessionManager.getServerVersion().catch(() => null);
    const cmd = this.config.server.command ?? "npx";
    const args = this.config.server.args ?? [];
    const { cmd: upCmd, args: upArgs } = buildUpgradeCommand(cmd, args);

    await this.sendReply(
      contextToken,
      `🔄 开始升级 OpenCode${oldVersion ? `（当前 v${oldVersion}）` : ""}...\n  ${upCmd} ${upArgs.join(" ")}`,
    );

    // Run the upgrade command with a 2-minute timeout. If it times out
    // (likely because it tried to prompt interactively — e.g. the opencode
    // binary's auto-detected install method is "unknown"), we still proceed
    // to restart the server: for npx-style launches npx will fetch the
    // latest package on next invocation, so a restart is itself an upgrade.
    let upgradeNote = "";
    try {
      const { code, stdout, stderr } = await spawnAndCollect(upCmd, upArgs, 120_000, this.log);
      const combined = stdout + (stderr ? `\n${stderr}` : "");
      if (code === 0) {
        this.log(`OpenCode upgrade completed (code=0)`);
        const tail = combined.split("\n").filter(Boolean).slice(-3).join("\n");
        if (tail) upgradeNote = `\n  ${tail}`;
      } else {
        this.log(`OpenCode upgrade exited with code=${code}; proceeding to restart anyway`);
        upgradeNote = `\n  （升级命令退出码 ${code}，将重启 server 加载最新版本）`;
      }
    } catch (err) {
      this.log(`OpenCode upgrade error/timeout: ${String(err)}; proceeding to restart anyway`);
      const firstLine = String(err).split("\n")[0] ?? String(err);
      upgradeNote = `\n  （升级命令异常/超时：${firstLine}，将重启 server 加载最新版本）`;
    }

    // Restart the server (same flow as /restart).
    await this.sendReply(contextToken, `🔄 重启 OpenCode Server...${upgradeNote}`);
    const cwd = this.userState?.cwd ?? this.config.agent.cwd;
    const previousSessionId = this.userState?.sessionId ?? this.sessionManager.getSessionId();

    try {
      // 1. Cancel any in-flight prompt (best-effort — server may be unresponsive soon)
      await this.sessionManager.cancelPrompt().catch((err) => {
        this.log(`Cancel prompt during upgrade (ignored): ${String(err)}`);
      });

      // 2. Tear down the SSE event pipeline (the old SSE connection is dead)
      await this.sessionManager.stopEventPipeline();

      // 3. Restart the server (CLI does stop + start + wait-for-health)
      const t0 = Date.now();
      await this.restartServer();
      this.log(`Server restart took ${Date.now() - t0}ms`);

      // 4. Restore the previous session on the fresh server
      const restoredId = await this.restoreOrCreateSession(previousSessionId, cwd);

      // 5. Re-establish the SSE pipeline against the new server
      await this.sessionManager.startEventPipeline(cwd);

      // 6. Verify the new version is now active
      const newVersion = await this.sessionManager.getServerVersion().catch(() => null);
      const versionInfo = newVersion
        ? oldVersion
          ? `v${oldVersion} → v${newVersion}`
          : `v${newVersion}`
        : "（无法读取新版本）";
      const tag = restoredId === previousSessionId ? "已恢复" : "旧会话不存在，已创建新会话";
      await this.sendReply(
        contextToken,
        `✅ 升级完成 (${versionInfo})\nServer 已重启，会话${tag}\n  ${restoredId}`,
      );
    } catch (err) {
      this.log(`Upgrade restart error: ${String(err)}`);
      await this.sendReply(contextToken, `⚠️ 重启失败: ${String(err)}`);
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
      "reasoning", "help", "h", "?", "status",
      "thought-display",
      "tool-display",
      "stop", "restart", "next", "version", "upgrade",
    ];
    if (bridgeCommands.includes(cmdName)) return null;

    return `⚠️ Command "/${match[1]}" is not a bridge command, forwarding to agent.`;
  }

  private async sendHelpReply(contextToken: string): Promise<void> {
    const nativeCommands = (await this.sessionManager?.getAvailableCommands()) ?? [];
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

  private sendReply(contextToken: string, text: string): Promise<void> {
    return this.enqueueOutbound(contextToken, () => this.sendReplyImpl(contextToken, text));
  }

  private async sendReplyImpl(contextToken: string, text: string): Promise<void> {
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

  private sendMediaReply(contextToken: string, blocks: MediaContent[]): Promise<void> {
    return this.enqueueOutbound(contextToken, () => this.sendMediaReplyImpl(contextToken, blocks));
  }

  private async sendMediaReplyImpl(contextToken: string, blocks: MediaContent[]): Promise<void> {
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

  /**
   * Run `fn` strictly after every previously enqueued operation for the same
   * `contextToken`. Without this guard the SessionManager's back-to-back
   * `onReply` calls (tool summary + thought line, or text part + tool
   * summary) race each other: each `await sendTextMessage(...)` returns in
   * arbitrary order depending on network timing, and the WeChat display
   * ends up showing the SHORT payload before the LONG one — e.g. R2 (56ch)
   * arriving before the bash-1 tool summary (30ch), or the 2ch "ok" text
   * arriving before the 44ch webfetch tool summary.
   *
   * The chain swallows rejected predecessors so a failed send doesn't
   * poison subsequent sends for the same contextToken. `next.finally`
   * removes the entry from the map once this task settles AND no newer
   * task has taken its slot — keeps the map bounded for contextTokens
   * that have stopped sending.
   */
  private enqueueOutbound<T>(contextToken: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.outboundQueue.get(contextToken) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn());
    this.outboundQueue.set(contextToken, next);
    next.finally(() => {
      if (this.outboundQueue.get(contextToken) === next) {
        this.outboundQueue.delete(contextToken);
      }
    });
    return next;
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
