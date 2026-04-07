/**
 * ACP Client implementation for WeChat.
 *
 * Implements the acp.Client interface: handles session updates (accumulates
 * text chunks), auto-allows all permission requests, and provides filesystem
 * access for the agent.
 */

import fs from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

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

export interface WeChatAcpClientOpts {
  sendTyping: () => Promise<void>;
  onThoughtFlush: (text: string) => Promise<void>;
  onMediaFlush: (blocks: MediaContent[]) => Promise<void>;
  onCommandsUpdate?: (commands: acp.AvailableCommand[]) => void;
  onUsageUpdate?: (usage: { size: number; used: number }) => void;
  onToolCall?: (text: string) => Promise<void>;
  log: (msg: string) => void;
  showThoughts: boolean;
  showTools: boolean;
}

export class WeChatAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private toolCallText: string[] = [];
  private mediaBlocks: MediaContent[] = [];
  private opts: WeChatAcpClientOpts;
  private lastTypingAt = 0;
  private replaying = false;
  private availableCommands: acp.AvailableCommand[] = [];
  private currentUsage: acp.UsageUpdate | null = null;
  private cumulativeUsage: acp.Usage | null = null;
  private hadToolCall = false;
  private static readonly TYPING_INTERVAL_MS = 5_000;

  constructor(opts: WeChatAcpClientOpts) {
    this.opts = opts;
  }

  /**
   * Update runtime flags for showing thoughts and tool calls.
   */
  setShowFlags(flags: { showThoughts?: boolean; showTools?: boolean }): void {
    if (flags.showThoughts !== undefined) this.opts.showThoughts = flags.showThoughts;
    if (flags.showTools !== undefined) this.opts.showTools = flags.showTools;
  }

  /**
   * Get current show flags.
   */
  getShowFlags(): { showThoughts: boolean; showTools: boolean } {
    return { showThoughts: this.opts.showThoughts, showTools: this.opts.showTools };
  }

  /** Check if any tool call was received during this prompt cycle. */
  hasToolCall(): boolean {
    return this.hadToolCall;
  }

  /** Reset tool call flag after a prompt cycle completes. */
  resetToolCallFlag(): void {
    this.hadToolCall = false;
  }

  updateCallbacks(callbacks: {
    sendTyping: () => Promise<void>;
    onThoughtFlush: (text: string) => Promise<void>;
    onMediaFlush: (blocks: MediaContent[]) => Promise<void>;
    showThoughts?: boolean;
    showTools?: boolean;
  }): void {
    this.opts = {
      ...this.opts,
      sendTyping: callbacks.sendTyping,
      onThoughtFlush: callbacks.onThoughtFlush,
      onMediaFlush: callbacks.onMediaFlush,
    };
    if (callbacks.showThoughts !== undefined) this.opts.showThoughts = callbacks.showThoughts;
    if (callbacks.showTools !== undefined) this.opts.showTools = callbacks.showTools;
  }

  setReplaying(value: boolean): void {
    this.replaying = value;
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // Auto-allow: find first "allow" option
    const allowOpt = params.options.find(
      (o) => o.kind === "allow_once" || o.kind === "allow_always",
    );
    const optionId = allowOpt?.optionId ?? params.options[0]?.optionId ?? "allow";

    this.opts.log(`[permission] auto-allowed: ${params.toolCall?.title ?? "unknown"} → ${optionId}`);

    return {
      outcome: {
        outcome: "selected",
        optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const update = params.update;

    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (this.replaying) return; // Ignore replayed content during session/load
        await this.maybeFlushThoughts();
        if (update.content.type === "text") {
          this.chunks.push(update.content.text);
        } else if (update.content.type === "image") {
          // Image content - send immediately via media callback
          const imageBlock: MediaContent = {
            type: "image",
            data: update.content.data,
            mimeType: update.content.mimeType,
          };
          await this.flushMedia([imageBlock]);
        } else if (update.content.type === "resource") {
          // Resource content - could be text or binary
          const resource = update.content.resource;
          // Check if it's a BlobResourceContents (has blob field)
          if ("blob" in resource && resource.blob != null) {
            // Binary resource
            const resourceBlock: MediaContent = {
              type: "resource",
              uri: resource.uri,
              blob: resource.blob,
              resourceMimeType: resource.mimeType ?? undefined,
            };
            await this.flushMedia([resourceBlock]);
          }
          // Text resources are handled via text chunks in tool_call_update
        }
        // Throttle typing indicators
        await this.maybeSendTyping();
        break;

      case "tool_call":
        this.hadToolCall = true;
        await this.maybeFlushThoughts();
        if (this.opts.showTools) {
          // Send tool name immediately instead of accumulating to the end
          try {
            await this.opts.onThoughtFlush(`🔧 ${update.title}`);
          } catch {
            // best effort
          }
        }
        this.opts.log(`[tool] ${update.title} (${update.status})`);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (update.content.type === "text") {
          const text = update.content.text;
          this.opts.log(`[thought] ${text.length > 80 ? text.substring(0, 80) + "..." : text}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(text);
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (update.status === "completed" && update.content) {
          for (const c of update.content) {
            if (c.type === "content") {
              // Tool result content block - could be text, image, or resource
              const content = (c as { content: acp.ContentBlock }).content;
              if (content.type === "image") {
                const imageBlock: MediaContent = {
                  type: "image",
                  data: content.data,
                  mimeType: content.mimeType,
                };
                await this.flushMedia([imageBlock]);
              } else if (content.type === "resource") {
                const resource = content.resource;
                // Check if it's a BlobResourceContents (has blob field)
                if ("blob" in resource && resource.blob != null) {
                  const resourceBlock: MediaContent = {
                    type: "resource",
                    uri: resource.uri,
                    blob: resource.blob,
                    resourceMimeType: resource.mimeType ?? undefined,
                  };
                  await this.flushMedia([resourceBlock]);
                }
              }
              // Text content is accumulated to chunks as normal
            }
          }
        }
        if (update.status) {
          this.opts.log(`[tool] ${update.toolCallId} → ${update.status}`);
        }
        break;

      case "plan":
        // Log plan entries
        if (update.entries) {
          const items = update.entries
            .map((e: acp.PlanEntry, i: number) => `  ${i + 1}. [${e.status}] ${e.content}`)
            .join("\n");
          this.opts.log(`[plan]\n${items}`);
        }
        break;

      case "session_info_update":
        // Log it, no action needed
        this.opts.log(`[session_info_update]`);
        break;

      case "config_option_update":
        // Log it, no action needed
        this.opts.log(`[config_option_update]`);
        break;

      case "available_commands_update": {
        const cmdsUpdate = update as acp.AvailableCommandsUpdate & { sessionUpdate: "available_commands_update" };
        this.availableCommands = cmdsUpdate.availableCommands ?? [];
        this.opts.log(`[available_commands_update] ${this.availableCommands.length} commands: ${this.availableCommands.map(c => `/${c.name}`).join(", ")}`);
        this.opts.onCommandsUpdate?.(this.availableCommands);
        break;
      }

      case "usage_update": {
        const usageUpdate = update as acp.UsageUpdate & { sessionUpdate: "usage_update" };
        this.currentUsage = usageUpdate;
        this.opts.log(`[usage_update] context: ${usageUpdate.used}/${usageUpdate.size}`);
        if (usageUpdate.cost) {
          this.opts.log(`[usage_update] cost: ${usageUpdate.cost.amount} ${usageUpdate.cost.currency}`);
        }
        this.opts.onUsageUpdate?.({ size: usageUpdate.size, used: usageUpdate.used });
        break;
      }
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    try {
      const content = await fs.promises.readFile(params.path, "utf-8");
      return { content };
    } catch (err) {
      throw new Error(`Failed to read file ${params.path}: ${String(err)}`);
    }
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    try {
      await fs.promises.writeFile(params.path, params.content, "utf-8");
      return {};
    } catch (err) {
      throw new Error(`Failed to write file ${params.path}: ${String(err)}`);
    }
  }

  /** Get accumulated text and reset the buffer. Also flushes any remaining thoughts. */
  async flush(): Promise<string> {
    await this.maybeFlushThoughts();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;

    // Also flush any accumulated media blocks
    if (this.mediaBlocks.length > 0) {
      await this.flushMedia(this.mediaBlocks);
      this.mediaBlocks = [];
    }

    return text;
  }

  /** Check if there's any buffered content waiting to be flushed. */
  hasTrailingContent(): boolean {
    return this.chunks.length > 0 || this.thoughtChunks.length > 0 || this.toolCallText.length > 0;
  }

  /** Get the latest available commands from the agent. */
  getAvailableCommands(): acp.AvailableCommand[] {
    return this.availableCommands;
  }

  /** Get the latest context window usage. */
  getUsage(): { contextUsed: number; contextSize: number } | null {
    if (!this.currentUsage) return null;
    return {
      contextUsed: this.currentUsage.used,
      contextSize: this.currentUsage.size,
    };
  }

  /** Flush media blocks via callback and reset. */
  private async flushMedia(blocks: MediaContent[]): Promise<void> {
    if (blocks.length === 0) return;
    try {
      await this.opts.onMediaFlush(blocks);
    } catch {
      // best effort
    }
  }

  private async maybeFlushThoughts(): Promise<void> {
    if (this.thoughtChunks.length === 0) return;
    const thoughtText = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (thoughtText.trim()) {
      try {
        await this.opts.onThoughtFlush(`💭 [Thinking]\n${thoughtText}`);
      } catch {
        // best effort
      }
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < WeChatAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    try {
      await this.opts.sendTyping();
    } catch {
      // typing is best-effort
    }
  }
}
