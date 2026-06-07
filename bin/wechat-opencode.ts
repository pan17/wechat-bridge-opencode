#!/usr/bin/env node

/**
 * wechat-opencode CLI entry point.
 *
 * Spawns opencode serve as a sidecar, then starts the WeChat bridge.
 *
 * Usage:
 *   wbo                          (default: auto-starts opencode serve sidecar)
 *   wbo --server-url <url>       (use external opencode serve; do not auto-start)
 *   wbo --cwd /path/to/project
 *   wbo --login
 *   wbo --daemon
 *   wbo stop
 *   wbo status
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import { WeChatOpencodeBridge } from "../src/bridge.js";
import { defaultConfig } from "../src/config.js";
import type { WeChatOpencodeConfig } from "../src/config.js";

function usage(): void {
  console.log(`
wbo — Bridge WeChat to OpenCode (OpenCode Server)

Usage:
  wbo [options]
  wbo stop                          Stop a running daemon
  wbo status                        Check daemon status

Options:
  --cwd <dir>         Working directory for agent (default: current dir)
  --server-url <url>  Use external opencode serve at <url> (skip auto-start)
  --login             Force re-login (new QR code)
  --daemon            Run in background after login
  --config <file>     Config file path (JSON)
  --idle-timeout <m>  Session idle timeout in minutes (default: 1440)
  -v, --verbose       Verbose logging
  -h, --help          Show this help
`);
}

function parseArgs(argv: string[]): {
  command?: string;
  cwd?: string;
  serverUrl?: string;
  forceLogin: boolean;
  daemon: boolean;
  configFile?: string;
  idleTimeout?: number;
  verbose: boolean;
  help: boolean;
} {
  const result = {
    forceLogin: false,
    daemon: false,
    verbose: false,
    help: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  // Check for subcommand
  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--server-url":
        result.serverUrl = args[++i];
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--daemon":
        result.daemon = true;
        break;
      case "--config":
        result.configFile = args[++i];
        break;
      case "--idle-timeout":
        result.idleTimeout = parseInt(args[++i], 10);
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<WeChatOpencodeConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Partial<WeChatOpencodeConfig>;
}

// ─── Daemon management ───

function handleStop(config: WeChatOpencodeConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("No daemon running (no PID file found)");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidFile);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      fs.unlinkSync(pidFile);
      console.log(`Daemon not running (stale PID ${pid}), cleaned up`);
    } else {
      console.error(`Failed to stop daemon: ${String(err)}`);
    }
  }
}

function handleStatus(config: WeChatOpencodeConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("Not running");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // test if process exists
    console.log(`Running (PID ${pid})`);
  } catch {
    console.log(`Not running (stale PID ${pid})`);
    fs.unlinkSync(pidFile);
  }
}

function daemonize(config: WeChatOpencodeConfig): void {
  const logFile = config.daemon.logFile;
  const pidFile = config.daemon.pidFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  const args = process.argv.slice(1).filter((a) => a !== "--daemon");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, WECHAT_OPENCODE_DAEMON: "1" },
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf-8");
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  process.exit(0);
}

// ─── Sidecar management ───

let serverProcess: ChildProcess | null = null;

/**
 * Wait for the server's TCP port to actually be free. After a process tree
 * kill, the OS may briefly keep the listening socket in TIME_WAIT before
 * releasing it; polling the health endpoint (which will refuse connections
 * while the port is free, and succeed while it's occupied) is a reliable
 * way to know the new server can bind.
 */
async function waitForPortFree(serverUrl: string, timeoutMs: number, log: (msg: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(500) });
      if (!res.ok) {
        // Port responded with non-2xx (e.g. another service moved in) — not our
        // server anymore, treat as free.
        log("Port no longer serves the opencode server");
        return;
      }
      // Port still serving the opencode server — wait and retry.
    } catch {
      // Connection refused / timeout — port is free.
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`Warning: port did not become free within ${timeoutMs}ms; starting new server anyway`);
}

/**
 * Kill the entire process tree rooted at `pid`.
 *
 * On Windows, `ChildProcess.kill()` calls `TerminateProcess()`, which only
 * kills the parent (npx) and leaves children (opencode-ai.exe) orphaned and
 * still listening on the port. The fix is `taskkill /F /T` which terminates
 * the parent AND all descendants.
 *
 * On Unix, we rely on the parent having been spawned with `detached: true`
 * so it has its own process group; killing `-pid` sends the signal to every
 * process in the group.
 */
async function killProcessTree(pid: number, log: (msg: string) => void): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const tk = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        shell: true,
      });
      tk.on("exit", (code) => {
        log(`taskkill exited with code=${code}`);
        resolve();
      });
      tk.on("error", (err) => {
        log(`taskkill error: ${String(err)}`);
        resolve();
      });
    });
  } else {
    // SIGTERM the whole group, then SIGKILL after a grace period.
    try {
      process.kill(-pid, "SIGTERM");
    } catch (err) {
      log(`SIGTERM group failed: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group may already be gone — that's fine.
    }
  }
}

async function startServer(config: WeChatOpencodeConfig): Promise<void> {
  const cmd = config.server.command ?? "npx";
  const args = config.server.args ?? ["opencode-ai", "serve", "--port", "4096"];
  const useShell = process.platform === "win32";
  const log = (msg: string) => console.log(`[server] ${msg}`);

  log(`Starting: ${cmd} ${args.join(" ")} (shell=${useShell})`);

  serverProcess = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env },
    shell: useShell,
    // `detached: true` is required on Unix to put the child in its own
    // process group so we can kill the whole tree with
    // `process.kill(-pid, ...)` — otherwise the negative-PID kill would
    // also terminate the bridge itself (which shares the default group).
    //
    // On Windows we MUST NOT pass `detached: true`: combined with
    // `shell: true` it spawns the child in a new console window, which
    // is jarring UX. Tree-kill on Windows goes through `taskkill /F /T`
    // instead, which works for any process regardless of `detached`.
    detached: process.platform !== "win32",
  });

  serverProcess.stdout?.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      log(line);
    }
  });

  serverProcess.on("exit", (code, signal) => {
    log(`Exited: code=${code} signal=${signal}`);
    serverProcess = null;
  });

  serverProcess.on("error", (err) => {
    log(`Error: ${String(err)}`);
  });

  // Wait for server to be ready
  const serverUrl = config.server.url;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${serverUrl}/global/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        log("Server is ready");
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("Warning: server may not be ready yet, continuing...");
}

async function stopServer(config: WeChatOpencodeConfig): Promise<void> {
  const log = (msg: string) => console.log(`[server] ${msg}`);
  if (!serverProcess || serverProcess.killed) return;
  const proc = serverProcess;
  const pid = proc.pid;
  // Detach the local reference BEFORE the kill so the eventual `exit` event
  // (which arrives asynchronously) doesn't try to clear an already-null
  // variable or, worse, race with the kill.
  serverProcess = null;

  if (pid === undefined) {
    log("stopServer: serverProcess has no pid; skipping kill");
    return;
  }

  log(`Stopping server (pid=${pid})...`);
  await killProcessTree(pid, log);

  // Wait for the port to actually be released before returning. If we don't,
  // the new server's npx child will fail to bind and exit, but the polling
  // health check in startServer will be lied to by the still-listening old
  // opencode-ai.exe and return success immediately (15ms, as the bug
  // surfaced in production).
  await waitForPortFree(config.server.url, 5_000, log);
}

// ─── QR rendering ───

function renderQrInTerminal(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
    console.log(qr);
  });
}

// ─── Main ───

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    usage();
    process.exit(0);
  }

  const config = defaultConfig();

  // Load config file if specified
  if (args.configFile) {
    const fileConfig = loadConfigFile(args.configFile);
    Object.assign(config.wechat, fileConfig.wechat ?? {});
    Object.assign(config.server, fileConfig.server ?? {});
    Object.assign(config.agent, fileConfig.agent ?? {});
    Object.assign(config.daemon, fileConfig.daemon ?? {});
    Object.assign(config.storage, fileConfig.storage ?? {});
  }

  // CLI overrides
  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.serverUrl) config.server.url = args.serverUrl;
  if (args.idleTimeout !== undefined) {
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  config.daemon.enabled = args.daemon;

  // Handle subcommands
  if (args.command === "stop") {
    handleStop(config);
    return;
  }
  if (args.command === "status") {
    handleStatus(config);
    return;
  }

  // Handle daemon mode
  if (args.daemon && !process.env.WECHAT_OPENCODE_DAEMON) {
    daemonize(config);
    return;
  }

  // Start opencode serve sidecar unless an external server URL was given.
  if (!args.serverUrl) {
    await startServer(config);
  }

  // Create and start bridge
  const bridge = new WeChatOpencodeBridge(
    config,
    (msg) => {
      const ts = new Date().toISOString().substring(11, 19);
      console.log(`[${ts}] ${msg}`);
    },
    // `/restart` callback: stop the opencode serve sidecar, spawn a fresh one,
    // and wait for it to be healthy before returning. The bridge will create
    // a new session and re-attach the SSE pipeline after this resolves.
    // Only registered when WE own the server (i.e. external --server-url was
    // NOT used).
    args.serverUrl
      ? undefined
      : async () => {
          await stopServer(config);
          await startServer(config);
        },
  );

  const shutdown = async () => {
    await bridge.stop();
    await stopServer(config);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    await bridge.start({
      forceLogin: args.forceLogin,
      renderQrUrl: renderQrInTerminal,
    });
  } catch (err) {
    if ((err as Error).message === "aborted") {
      // Normal shutdown
    } else {
      console.error(`Fatal: ${String(err)}`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
