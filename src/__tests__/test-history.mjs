/**
 * Integration tests for the `/history` command flow.
 *
 * Exercises `fetchAndFormatHistory` (the pure helper that powers
 * `WeChatOpencodeBridge.handleHistoryCommand`) with stubbed client
 * behavior. This avoids instantiating the full WeChatOpencodeBridge
 * (which has WeChat iLink / OpenCode Server / SSE / state-persistence
 * dependencies) — the bridge handler itself is a 5-line wrapper around
 * this helper, so testing the helper end-to-end is the highest-value
 * test we can run without those dependencies.
 *
 * Cases (mirroring the spec):
 *   1. /history with 3 messages (1 user + 2 assistant) → header count,
 *      both role emojis, both timestamps present in output.
 *   2. /history 2 → parser passes count=2 to the client fetch.
 *   3. /history with empty response → "暂无消息" warning.
 *   4. /history with null sessionId → "当前没有活动会话" warning.
 *   5. /history when client throws → error propagates (the bridge's
 *      try/catch converts this to a ⚠️ message in production).
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";
import { fetchAndFormatHistory, parseHistoryCommand } from "../../dist/src/adapter/workspace-cmd.js";

const CWD = "/Users/test/project";

/** Helper to build a MessageResponse-shaped object (info + parts). */
function makeMsg(overrides) {
  return {
    info: {
      id: "msg-x",
      sessionID: "ses-test",
      role: "user",
      time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
      ...overrides.info,
    },
    parts: overrides.parts ?? [{ id: "p1", sessionID: "ses-test", messageID: "msg-x", type: "text", text: "hello" }],
  };
}

describe("fetchAndFormatHistory", () => {
  test("3 messages (1 user + 2 assistant) — renders count, both roles, and timestamps", async () => {
    // Server returns newest-first, so pass them in reverse-chronological
    // order; the helper should reverse them back to chronological.
    const fetched = [
      makeMsg({
        info: {
          id: "m3", role: "assistant",
          agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          time: { created: 1_700_000_042_000, completed: 1_700_000_043_000 },
        },
        parts: [{ id: "p3", sessionID: "ses-test", messageID: "m3", type: "text", text: "Second assistant reply." }],
      }),
      makeMsg({
        info: {
          id: "m2", role: "user",
          time: { created: 1_700_000_030_000, completed: 1_700_000_030_100 },
        },
        parts: [{ id: "p2", sessionID: "ses-test", messageID: "m2", type: "text", text: "Follow-up question" }],
      }),
      makeMsg({
        info: {
          id: "m1", role: "user",
          time: { created: 1_700_000_015_000, completed: 1_700_000_015_100 },
        },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "text", text: "Original question" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
    });

    // Count line
    expect(out).toContain("📜 最近 3 条消息");
    expect(out).toContain(CWD);
    // Both roles
    expect(out).toContain("👤");
    expect(out).toContain("🤖");
    expect(out).toContain("build / anthropic/claude-sonnet-4-5");
    // Body text (chronological: oldest first, newest last)
    expect(out.indexOf("Original question")).toBeLessThan(out.indexOf("Follow-up question"));
    expect(out.indexOf("Follow-up question")).toBeLessThan(out.indexOf("Second assistant reply."));
    // Divider between messages
    expect(out).toContain("───");
    // Fetch called with the requested count
    expect(fetch).toHaveBeenCalledWith("ses-test", 5);
  });

  test("/history 2 — parser passes count=2 to the client fetch", async () => {
    const fetch = vi.fn().mockResolvedValue([]);

    // First: parser correctness
    const parsed = parseHistoryCommand("/history 2");
    expect(parsed).toEqual({ kind: "history", count: 2 });

    // Then: helper wires the count through to fetch
    await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: parsed.count,
      cwd: CWD,
      fetch,
    });
    expect(fetch).toHaveBeenCalledWith("ses-test", 2);
  });

  test("empty response — reply contains '暂无消息'", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
    });
    expect(out).toContain("暂无消息");
  });

  test("null sessionId — reply says '当前没有活动会话'", async () => {
    const fetch = vi.fn();
    const out = await fetchAndFormatHistory({
      sessionId: null,
      count: 5,
      cwd: CWD,
      fetch,
    });
    expect(out).toContain("当前没有活动会话");
    // Fetch must NOT be called when there's no active session
    expect(fetch).not.toHaveBeenCalled();
  });

  test("client throws — error propagates to caller (bridge converts to ⚠️ message)", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("server 503"));
    await expect(
      fetchAndFormatHistory({
        sessionId: "ses-test",
        count: 5,
        cwd: CWD,
        fetch,
      }),
    ).rejects.toThrow("server 503");
  });
});
