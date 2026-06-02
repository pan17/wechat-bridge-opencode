/**
 * OpenCode custom tool: send text and files to WeChat.
 *
 * Place this file at:
 *   - Global:  ~/.config/opencode/tools/send-wechat.ts
 *   - Project: .opencode/tools/send-wechat.ts
 *
 * Tool name: send-wechat
 * Reads userId/sessionId from .wechat-bridge-state.json automatically.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const API_URL = "http://127.0.0.1:18792/send-wechat";

function loadState(): { lastUserId?: string; lastSessionId?: string } {
  try {
    const stateFile = path.join(os.homedir(), ".wechat-bridge-opencode", ".wechat-bridge-state.json");
    if (!fs.existsSync(stateFile)) return {};

    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    if (raw.users && Array.isArray(raw.users) && raw.users.length > 0) {
      const lastUser = raw.users[0];
      return {
        lastUserId: lastUser.userId,
        lastSessionId: lastUser.sessionId,
      };
    }

    if (raw.lastUserId) {
      return { lastUserId: raw.lastUserId, lastSessionId: raw.lastSessionId };
    }
  } catch {
    // Ignore unreadable state files.
  }
  return {};
}

export default tool({
  description: "Send a text message or file to the last active WeChat user through the wechat-opencode bridge.",
  args: {
    text: tool.schema.string().optional().describe("Text message to send to the WeChat contact"),
    filePath: tool.schema.string().optional().describe("Absolute path to the file to send"),
  },
  async execute(args) {
    if (!args.text && !args.filePath) {
      return "Error: Either text or filePath must be provided";
    }

    let absolutePath: string | undefined;
    if (args.filePath) {
      absolutePath = path.resolve(args.filePath);
      try {
        if (!fs.existsSync(absolutePath)) {
          return `Error: File not found: ${absolutePath}`;
        }
        if (!fs.statSync(absolutePath).isFile()) {
          return `Error: Not a file: ${absolutePath}`;
        }
      } catch (err) {
        return `Error accessing file: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const state = loadState();
    if (!state.lastUserId && !state.lastSessionId) {
      return "Error: No active WeChat session found. Has anyone messaged you recently? The bridge must be running and have received at least one message.";
    }

    try {
      const body: Record<string, unknown> = {
        userId: state.lastUserId,
        sessionId: state.lastSessionId,
      };
      if (args.text) body.text = args.text;
      if (absolutePath) body.filePath = absolutePath;

      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await response.json();
      if (!response.ok) {
        return `Error: ${result.error || `HTTP ${response.status}`}`;
      }

      const userId = state.lastUserId ?? "unknown";
      const sent = Array.isArray(result.sent) ? result.sent : [];
      if (sent.length === 0) {
        return `Successfully sent to WeChat user ${userId}!`;
      }

      const items = sent
        .map((item: string) => (item === "text" ? "text message" : item))
        .join(" and ");
      return `Successfully sent ${items} to WeChat user ${userId}!`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED")) {
        return "Error: Cannot connect to wechat-opencode bridge at 127.0.0.1:18792. Is the bridge running?";
      }
      return `Error: ${msg}`;
    }
  },
});
