/**
 * Shared types for wechat-opencode.
 *
 * Replaces ACP-specific types with OpenCode Server message format.
 */

import type { MessageInfo, Part } from "./types/events.js";

/**
 * A single part of an OUTBOUND message — what the bridge sends TO the
 * OpenCode Server via `POST /session/:id/message`. The server accepts a
 * flat text-only payload for prompts; the richer `Part` union from
 * `./types/events.js` is the shape the server RETURNS in
 * `GET /session/:id/message`, which is modeled separately as
 * `MessageResponse.parts` below.
 */
export type MessagePart = TextPart;

export interface TextPart {
  type: "text";
  text: string;
}

/** Reference to an LLM model provider/model. */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** Media content from agent (images, file resources). */
export interface MediaContent {
  type: "image" | "resource";
  // For image
  data?: string; // base64
  mimeType?: string;
  // For resource
  uri?: string;
  blob?: string; // base64
  resourceMimeType?: string;
  // For file
  fileName?: string;
}

/**
 * Response from `GET /session/:id/message` (and the per-message entries
 * in the array returned by that endpoint). Mirrors the real OpenCode
 * Server payload shape:
 *   { info: MessageInfo, parts: Part[] }
 *
 * `MessageInfo` carries message-level metadata (id, role, parentID,
 * created/completed timestamps, agent, model, variant, tokens, cost,
 * error). `Part` is the discriminated union of all part types
 * (text | tool | file | reasoning | step-start | step-finish | snapshot)
 * from `./types/events.js`. The server returns these newest-first; the
 * bridge reverses them for chronological display.
 */
export interface MessageResponse {
  info: MessageInfo;
  parts: Part[];
}

/** Project info from the server. */
export interface ServerProjectInfo {
  id: string;
  worktree: string;
  vcsDir?: string;
  vcs?: string;
  time?: {
    created: number;
    updated: number;
    initialized?: number;
  };
}

/** Session info from the server. */
export interface ServerSessionInfo {
  id: string;
  slug: string;
  title?: string;
  directory: string;
  projectID: string;
  version: string;
  createdAt?: string;
  updatedAt?: string;
  time?: {
    created: number;
    updated: number;
  };
  /**
   * Parent session id. Present when this session was spawned by an
   * agent's `task` tool (sub-agent / child session). The bridge uses
   * this to disambiguate root sessions from sub-agents in cross-session
   * notifications. Optional because older opencode server versions may
   * not return it, and V1 / V2 endpoints have slightly different
   * field coverage — both V1 and V2 are confirmed to return it for
   * sub-agents.
   */
  parentID?: string;
  /**
   * Agent name (e.g. `"build"`, `"designer"`, `"Sisyphus - ultraworker"`).
   * Optional for the same reason as `parentID`. Surfaces the agent role
   * in notifications so the user can tell *which* agent is asking
   * without having to switch to the session first.
   */
  agent?: string;
}

/** Available agent mode. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
  /** Agent-configured default model (from `agent.<name>.model`). */
  model?: { providerID: string; modelID: string };
  /** Agent-configured default reasoning variant (from `agent.<name>.variant`). */
  variant?: string;
}

/** Context usage info. */
export interface ContextUsage {
  totalTokens: number;
  contextSize: number;
}

/** Display flags for thoughts/tools. */
export interface ShowFlags {
  showThoughts: boolean;
  showTools: boolean;
}

/**
 * MCP server status from `GET /mcp`. Discriminated union — only the variant
 * matching `status` is valid. `failed` and `needs_client_registration`
 * carry an `error` string explaining what went wrong; the other variants
 * have no extra fields.
 *
 * See https://opencode.ai/docs/server/ (LSP, Formatters & MCP section).
 */
export type McpServerStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string };

/** Response from `GET /mcp`: a name → status map. */
export type McpStatusMap = Record<string, McpServerStatus>;
