/**
 * Spawn and manage ACP agent subprocesses.
 */

import { spawn, exec, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";

/**
 * Resolve the global opencode config path.
 * Priority: OPENCODE_CONFIG env > ~/.config/opencode/opencode.json
 */
function resolveOpencodeConfig(): string | undefined {
  if (process.env.OPENCODE_CONFIG) return process.env.OPENCODE_CONFIG;
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      // not found
    }
  }
  return undefined;
}

export interface AgentCapabilities {
  loadSession: boolean;
  sessionCapabilities?: {
    list?: {};
    close?: {};
  };
}

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: AgentCapabilities;
  /** Available session modes (e.g., "build", "plan") from initial session creation */
  availableModes?: acp.SessionMode[];
  /** Current active mode ID */
  currentModeId?: string;
  /** Available models from initial session creation */
  availableModels?: acp.ModelInfo[];
  /** Current active model ID */
  currentModelId?: string;
  /** Initial configuration options (thought_level, etc.) */
  configOptions?: acp.SessionConfigOption[];
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  log: (msg: string) => void;
  /** Existing OpenCode session ID to resume */
  existingSessionId?: string;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log, existingSessionId } = params;

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  // Resolve opencode config path to ensure global config (with plugins) is loaded
  const opencodeConfig = resolveOpencodeConfig();
  const rawEnv = { ...process.env, ...env };
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  if (opencodeConfig && !mergedEnv.OPENCODE_CONFIG) {
    mergedEnv.OPENCODE_CONFIG = opencodeConfig;
  }
  if (opencodeConfig && !mergedEnv.OPENCODE_CONFIG) {
    mergedEnv.OPENCODE_CONFIG = opencodeConfig;
  }

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: mergedEnv,
    shell: useShell,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  if (!proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error("Failed to get agent process stdio");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize
  log("Initializing ACP connection...");
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: {
      name: packageJson.name,
      title: packageJson.name,
      version: packageJson.version,
    },
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
  });
  log(`ACP initialized (protocol v${initResult.protocolVersion})`);

  // Extract capabilities
  const caps: AgentCapabilities = {
    loadSession: initResult.agentCapabilities?.loadSession ?? false,
    sessionCapabilities: initResult.agentCapabilities?.sessionCapabilities,
  };

  if (caps.loadSession !== true) {
    throw new Error("OpenCode does not support loadSession capability. Please upgrade to a version that supports ACP session loading.");
  }

  // Create or resume session — capture full response metadata
  let availableModes: acp.SessionMode[] | undefined;
  let currentModeId: string | undefined;
  let availableModels: acp.ModelInfo[] | undefined;
  let sessionModelId: string | undefined;
  let configOptions: acp.SessionConfigOption[] | undefined;
  let finalSessionId: string;

  if (existingSessionId) {
    log(`Resuming ACP session: ${existingSessionId}`);
    try {
      const resumeResult = await connection.unstable_resumeSession({
        sessionId: existingSessionId,
        cwd,
        mcpServers: [],
      });
      finalSessionId = existingSessionId;
      log(`ACP session resumed: ${finalSessionId}`);

      if (resumeResult.modes) {
        availableModes = resumeResult.modes.availableModes;
        currentModeId = resumeResult.modes.currentModeId;
      }
      if (resumeResult.models) {
        availableModels = resumeResult.models.availableModels;
        sessionModelId = resumeResult.models.currentModelId;
      }
      if (resumeResult.configOptions) {
        configOptions = resumeResult.configOptions;
      }
    } catch (err) {
      log(`Failed to resume session ${existingSessionId}: ${String(err)}, creating new one`);
      const newResult = await connection.newSession({
        cwd,
        mcpServers: [],
      });
      finalSessionId = newResult.sessionId;
      log(`ACP session created (fallback): ${finalSessionId}`);

      if (newResult.modes) {
        availableModes = newResult.modes.availableModes;
        currentModeId = newResult.modes.currentModeId;
      }
      if (newResult.models) {
        availableModels = newResult.models.availableModels;
        sessionModelId = newResult.models.currentModelId;
      }
      if (newResult.configOptions) {
        configOptions = newResult.configOptions;
      }
    }
  } else {
    log("Creating ACP session...");
    const newResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    finalSessionId = newResult.sessionId;
    log(`ACP session created: ${finalSessionId}`);

    if (newResult.modes) {
      availableModes = newResult.modes.availableModes;
      currentModeId = newResult.modes.currentModeId;
    }
    if (newResult.models) {
      availableModels = newResult.models.availableModels;
      sessionModelId = newResult.models.currentModelId;
    }
    if (newResult.configOptions) {
      configOptions = newResult.configOptions;
    }
  }

  return {
    process: proc,
    connection,
    sessionId: finalSessionId,
    capabilities: caps,
    availableModes,
    currentModeId,
    availableModels,
    currentModelId: sessionModelId,
    configOptions,
  };
}

export function killAgent(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill("SIGTERM");
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5_000).unref();
  }
}

/**
 * Get the currently installed OpenCode version by running `opencode -v`.
 */
export async function getInstalledVersion(_command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = "opencode -v";
    exec(cmd, { timeout: 10000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) {
        resolve(null);
        return;
      }
      const output = (stdout + stderr).trim();
      // Match version like "1.14.18"
      const match = output.match(/^(\d+\.\d+\.\d+[^\s]*)$/);
      resolve(match ? match[1] : null);
    });
  });
}

/**
 * Get the latest available OpenCode version from npm registry.
 */
export async function getLatestVersion(_command: string): Promise<{ installed: string | null; latest: string | null }> {
  return new Promise((resolve) => {
    // Query npm registry for the latest opencode-ai version
    const isWindows = process.platform === "win32";
    const proc = isWindows
      ? spawn("cmd.exe", ["/c", "npm.cmd", "view", "opencode-ai", "version", "--json"], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn("npm", ["view", "opencode-ai", "version", "--json"], { shell: true, stdio: ["pipe", "pipe", "pipe"] });

    let output = "";
    proc.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { output += chunk.toString(); });

    proc.on("close", () => {
      try {
        // npm view --json returns quoted string like "\"1.14.18\""
        const parsed = JSON.parse(output.trim());
        let latest = typeof parsed === "string" ? parsed : null;
        if (latest) latest = latest.replace(/"/g, "").trim();
        resolve({ installed: null, latest });
      } catch {
        // Fallback: try to find version in raw output and strip quotes
        const stripped = output.replace(/"/g, "").trim();
        const match = stripped.match(/(\d+\.\d+\.\d+[^\s]*)/);
        resolve({ installed: null, latest: match ? match[1] : null });
      }
    });
    proc.on("error", () => resolve({ installed: null, latest: null }));

    setTimeout(() => {
      proc.kill();
      resolve({ installed: null, latest: null });
    }, 15000);
  });
}

/**
 * Upgrade OpenCode by running `opencode upgrade`.
 * Returns the new version if successful.
 */
export async function upgradeOpenCode(command: string): Promise<{ success: boolean; newVersion?: string; installedBefore?: string; error?: string }> {
  return new Promise((resolve) => {
    // On Windows, use cmd.exe /c
    const isWindows = process.platform === "win32";
    const proc = isWindows
      ? spawn("cmd.exe", ["/c", command, "upgrade"], { stdio: ["pipe", "pipe", "pipe"] })
      : spawn(command, ["upgrade"], { shell: true, stdio: ["pipe", "pipe", "pipe"] });

    let output = "";
    proc.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    proc.stderr?.on("data", (chunk) => { output += chunk.toString(); });

    // Set a timeout - upgrade might wait for input if it prompts (3 minutes)
    const timeout = setTimeout(() => {
      proc.kill();
      // If it timed out but we got version info, still consider it a partial success
      const fromMatch = output.match(/From\s+(\S+)\s+→\s+(\S+)/);
      if (fromMatch) {
        resolve({ success: true, newVersion: fromMatch[2], installedBefore: fromMatch[1] });
      } else {
        resolve({ success: false, error: "升级超时（3分钟）: " + output.slice(0, 200) });
      }
    }, 180000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || output.includes("Upgrade complete") || output.includes("skipped")) {
        // Parse "From X → Y"
        const fromMatch = output.match(/From\s+(\S+)\s+→\s+(\S+)/);
        // Parse "skipped: X is already installed"
        const skippedMatch = output.match(/skipped:\s*(\S+)\s+is already installed/i);
        if (skippedMatch) {
          resolve({ success: true, newVersion: skippedMatch[1], installedBefore: skippedMatch[1] });
        } else if (fromMatch) {
          resolve({ success: true, newVersion: fromMatch[2], installedBefore: fromMatch[1] });
        } else {
          // Try to extract any version
          const match = output.match(/(\d+\.\d+\.\d+[^\s]*)/);
          resolve({ success: true, newVersion: match ? match[1] : undefined });
        }
      } else {
        resolve({ success: false, error: output.slice(0, 500) });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: String(err) });
    });
  });
}


