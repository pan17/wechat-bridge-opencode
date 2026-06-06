/**
 * Configuration types and defaults for wechat-opencode.
 */

import path from "node:path";
import os from "node:os";

export interface AgentCommandConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentPreset extends AgentCommandConfig {
  label: string;
  description?: string;
}

export interface ResolvedAgentConfig extends AgentCommandConfig {
  id?: string;
  label?: string;
  source: "preset" | "raw";
}

export const BUILT_IN_AGENTS: Record<string, AgentPreset> = {
  opencode: {
    label: "OpenCode",
    command: "npx",
    args: ["opencode-ai", "acp"],
    description: "OpenCode",
  },
};

export interface ServerConfig {
  /** URL of the opencode serve instance. */
  url: string;
  /** Command to spawn opencode serve as a sidecar (empty = external). */
  command?: string;
  args?: string[];
}

export interface WeChatOpencodeConfig {
  wechat: {
    baseUrl: string;
    cdnBaseUrl: string;
    botType: string;
  };
  /** OpenCode Server connection config. */
  server: ServerConfig;
  agent: {
    /** @deprecated No longer used — OpenCode Server replaces subprocess spawning. */
    preset?: string;
    /** @deprecated */
    command: string;
    /** @deprecated */
    args: string[];
    cwd: string;
    /** @deprecated */
    env?: Record<string, string>;
    showThoughts: boolean;
    showTools: boolean;
  };
  /** @deprecated Agent presets are no longer used. */
  agents: Record<string, AgentPreset>;
  /** @deprecated Session idle timeout is managed by the server. */
  session: {
    idleTimeoutMs: number;
  };
  daemon: {
    enabled: boolean;
    logFile: string;
    pidFile: string;
  };
  storage: {
    dir: string;
  };
}

export function defaultStorageDir(): string {
  return path.join(os.homedir(), ".wechat-bridge-opencode");
}

export function defaultTempDir(storageDir: string): string {
  return path.join(storageDir, "tempfile");
}

export function defaultConfig(): WeChatOpencodeConfig {
  const storageDir = defaultStorageDir();
  return {
    wechat: {
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      botType: "3",
    },
    server: {
      url: "http://localhost:4096",
      command: "npx",
      args: ["opencode-ai", "serve", "--port", "4096"],
    },
    agent: {
      preset: undefined,
      command: "",
      args: [],
      cwd: process.cwd(),
      showThoughts: false,
      showTools: false,
    },
    agents: { ...BUILT_IN_AGENTS },
    session: {
      idleTimeoutMs: 0, // disabled by default
    },
    daemon: {
      enabled: false,
      logFile: path.join(storageDir, "wechat-opencode.log"),
      pidFile: path.join(storageDir, "daemon.pid"),
    },
    storage: {
      dir: storageDir,
    },
  };
}

/**
 * Parse agent string like "claude code" or "npx tsx ./agent.ts"
 * into { command, args }.
 */
export function parseAgentCommand(agentStr: string): { command: string; args: string[] } {
  const parts = agentStr.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) {
    throw new Error("Agent command cannot be empty");
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

export function resolveAgentSelection(
  agentSelection: string,
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): ResolvedAgentConfig {
  const preset = registry[agentSelection];
  if (preset) {
    return {
      id: agentSelection,
      label: preset.label,
      command: preset.command,
      args: [...preset.args],
      env: preset.env ? { ...preset.env } : undefined,
      source: "preset",
    };
  }

  const parsed = parseAgentCommand(agentSelection);
  return {
    command: parsed.command,
    args: parsed.args,
    source: "raw",
  };
}

export function listBuiltInAgents(
  registry: Record<string, AgentPreset> = BUILT_IN_AGENTS,
): Array<{ id: string; preset: AgentPreset }> {
  return Object.entries(registry)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, preset]) => ({ id, preset }));
}
