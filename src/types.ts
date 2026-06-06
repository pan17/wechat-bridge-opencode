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
}

/** Available agent mode. */
export interface SessionMode {
  id: string;
  name: string;
  description?: string;
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
