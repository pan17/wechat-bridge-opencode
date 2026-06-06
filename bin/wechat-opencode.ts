#!/usr/bin/env node

/**
 * wechat-opencode CLI entry point.
 *
 * Spawns opencode serve as a sidecar, then starts the WeChat bridge.
 *
 * Usage:
 *   wbo                          (default: uses opencode serve)
 *   wbo --cwd /path/to/project
 *   wbo --server-url http://localhost:4096  (external server)
 *   wbo --no-server                         (external, don't spawn)
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
  --server-url <url>  OpenCode Server URL (default: http://localhost:4096)
  --no-server         Don't start opencode serve (use external server)
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
  noServer: boolean;
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
    noServer: false,
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
      case "--no-server":
        result.noServer = true;
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

function stopServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
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

  // Start opencode serve sidecar (unless --no-server)
  if (!args.noServer) {
    await startServer(config);
  }

  // Create and start bridge
  const bridge = new WeChatOpencodeBridge(config, (msg) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
  });

  const shutdown = async () => {
    await bridge.stop();
    stopServer();
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
