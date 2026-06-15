/**
 * Shared types for wechat-opencode.
 *
 * Replaces ACP-specific types with OpenCode Server message format.
 */

/** A single part of a message sent to/received from the agent. */
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

/** Response from POST /session/:id/message. */
export interface MessageResponse {
  info?: {
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
    };
  };
  parts: MessageResponsePart[];
}

export type MessageResponsePart = TextPart | ToolUsePart | ToolResultPart;

export interface ToolUsePart {
  type: "tool_use";
  name: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool_result";
  name: string;
  result: string;
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
