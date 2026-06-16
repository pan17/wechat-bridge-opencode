/**
 * Integration tests for the `/history` command flow.
 *
 * Exercises `fetchAndFormatHistory` (the pure helper that powers
 * `WeChatOpencodeBridge.handleHistoryCommand`) with stubbed client
 * behavior. This avoids instantiating the full WeChatOpencodeBridge
 * (which has WeChat iLink / OpenCode Server / SSE / state-persistence
 * dependencies) — the bridge handler itself is a thin wrapper around
 * this helper, so testing the helper end-to-end is the highest-value
 * test we can run without those dependencies.
 *
 * Cases covered:
 *   1. Over-fetch + last-N text-bearing selection. Mocked server returns
 *      6 raw messages with two tool-only turns interleaved; user asks
 *      for 3. Verify fetch was called with 3×3 = 9 (the multiplier),
 *      the LAST 3 text-bearing messages were picked, and they were
 *      re-ordered to chronological (oldest at top, newest at bottom).
 *   2. Header count matches the user's request. When the over-fetched
 *      window has fewer than N text-bearing messages (the common case
 *      for tool-heavy ultraworker sessions), the header carries a
 *      `…· 实际显示 X 条` hint so the user understands why they see
 *      fewer lines than they typed.
 *   3. Every turn is tool-only → "本次范围内全部是工具/推理轮" notice
 *      instead of an empty header.
 *   4. FETCH_MAX cap: when `count × FETCH_MULTIPLIER` exceeds the cap
 *      (60), the fetch limit is clamped so we don't pull a huge payload.
 *   5. /history 2 → parser passes count=2 and the helper over-fetches
 *      to 6.
 *   6. Empty response → "暂无消息" warning.
 *   7. Null sessionId → "当前没有活动会话" warning; fetch NOT called.
 *   8. Client throws → error propagates.
 *   9. Title fetcher throws → header omits 会话「…」; command still
 *      succeeds.
 *   10. Legacy nested `info.model = { providerID, modelID }` shape is
 *      still accepted (back-compat for any caller that hasn't migrated
 *      to flat fields).
 *
 * Server response shape assumption (verified against
 * `packages/opencode/src/session/message-v2.ts:436-478` and
 * `packages/core/src/v1/session.ts:455-487`):
 *   - The server returns messages OLDEST-FIRST (it does its own
 *     `items.reverse()` after the `desc(time_created)` SQL query).
 *   - Assistant messages carry FLAT `info.modelID` + `info.providerID`,
 *     NOT the nested `info.model = { providerID, modelID }` shape that
 *     the bridge's older `MessageInfo` type declared.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";
import { fetchAndFormatHistory, parseHistoryCommand } from "../../dist/src/adapter/workspace-cmd.js";

const CWD = "/Users/test/project";
const TITLE = "Test session: bash parity check";

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

/** Find lines that start with a 👤 (U+1F464) or 🤖 (U+1F916) — the role headers. */
function headerLines(out) {
  return out.split("\n").filter((l) => /^[\u{1F464}\u{1F916}]/u.test(l));
}

describe("fetchAndFormatHistory", () => {
  test("over-fetches by 3×, picks the LAST N text-bearing messages, displays in chronological order", async () => {
    // 6 raw messages, oldest-first. m2 and m4 are tool-only and must
    // be skipped; the other 4 are text-bearing. User asked for 3, so
    // the picked set is the most recent 3 text-bearing turns: walking
    // backwards from idx 5 → m6 (text, picked), m5 (text, picked),
    // m4 (tool, skip), m3 (text, picked = 3/3) → done. picked =
    // [m6, m5, m3] → reversed for display = [m3, m5, m6].
    // m1 ("oldest text") sits outside the 3 most recent text turns
    // and is dropped, even though it carries text. fetch should be
    // called with 3 × 3 = 9 (FETCH_MULTIPLIER).
    const fetched = [
      makeMsg({
        info: { id: "m1", role: "user", time: { created: 1_700_000_010_000, completed: 1_700_000_010_100 } },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "text", text: "oldest text" }],
      }),
      makeMsg({
        info: {
          id: "m2", role: "assistant",
          agent: "ultraworker", providerID: "anthropic", modelID: "claude-sonnet-4-5",
          time: { created: 1_700_000_020_000, completed: 1_700_000_021_000 },
        },
        parts: [
          { id: "p2a", sessionID: "ses-test", messageID: "m2", type: "tool", tool: "webfetch" },
          { id: "p2b", sessionID: "ses-test", messageID: "m2", type: "reasoning", text: "thinking…" },
        ],
      }),
      makeMsg({
        info: { id: "m3", role: "user", time: { created: 1_700_000_022_000, completed: 1_700_000_022_100 } },
        parts: [{ id: "p3", sessionID: "ses-test", messageID: "m3", type: "text", text: "middle text" }],
      }),
      makeMsg({
        info: {
          id: "m4", role: "assistant",
          agent: "ultraworker", providerID: "anthropic", modelID: "claude-sonnet-4-5",
          time: { created: 1_700_000_023_000, completed: 1_700_000_024_000 },
        },
        parts: [
          { id: "p4a", sessionID: "ses-test", messageID: "m4", type: "tool", tool: "webfetch" },
        ],
      }),
      makeMsg({
        info: {
          id: "m5", role: "user", time: { created: 1_700_000_025_000, completed: 1_700_000_025_100 },
        },
        parts: [{ id: "p5", sessionID: "ses-test", messageID: "m5", type: "text", text: "third text" }],
      }),
      makeMsg({
        info: {
          id: "m6", role: "assistant",
          agent: "ultraworker", providerID: "anthropic", modelID: "claude-sonnet-4-5",
          time: { created: 1_700_000_026_000, completed: 1_700_000_027_000 },
        },
        parts: [{ id: "p6", sessionID: "ses-test", messageID: "m6", type: "text", text: "newest text" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);
    const getSessionTitle = vi.fn().mockResolvedValue(TITLE);

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 3,
      cwd: CWD,
      fetch,
      getSessionTitle,
    });

    // Over-fetch: 3 × 3 = 9.
    expect(fetch).toHaveBeenCalledWith("ses-test", 9);
    expect(getSessionTitle).toHaveBeenCalledWith("ses-test");

    // Header shows the requested N (3) with no hint because the picked
    // count exactly satisfies the request.
    expect(out).toContain("📜 最近 3 条消息 (会话「Test session: bash parity check」· 工作区: /Users/test/project):");
    // No "(空消息)" markers, no tool-turn content surfaced.
    expect(out).not.toContain("(空消息)");
    expect(out).not.toContain("thinking");
    expect(out).not.toContain("webfetch");

    // Three header lines (👤 / 🤖), in chronological order — oldest
    // text first, newest last. The expected rendered set is m3, m5, m6
    // (see the trace in the docstring).
    const headers = headerLines(out);
    expect(headers.length).toBe(3);
    expect(out.indexOf("middle text")).toBeLessThan(out.indexOf("third text"));
    expect(out.indexOf("third text")).toBeLessThan(out.indexOf("newest text"));
    // m1 ("oldest text") sits outside the 3 most recent text-bearing
    // turns and is dropped — proves the pick is the LAST N, not the
    // FIRST N.
    expect(out).not.toContain("oldest text");
  });

  test("header shows requested N with hint when over-fetched window has fewer text messages than N", async () => {
    // count=5, mock returns 4 messages where 1 is tool-only. Picked = 3
    // (less than 5). Header must show `最近 5 条 · 实际显示 3 条` so
    // the user understands why they see fewer lines than they typed.
    const fetched = [
      makeMsg({
        info: { id: "m1", role: "user", time: { created: 1_700_000_010_000, completed: 1_700_000_010_100 } },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "text", text: "first" }],
      }),
      makeMsg({
        info: {
          id: "m2", role: "assistant", agent: "build",
          providerID: "anthropic", modelID: "claude-sonnet-4-5",
          time: { created: 1_700_000_011_000, completed: 1_700_000_012_000 },
        },
        parts: [{ id: "p2a", sessionID: "ses-test", messageID: "m2", type: "tool", tool: "bash" }],
      }),
      makeMsg({
        info: { id: "m3", role: "user", time: { created: 1_700_000_013_000, completed: 1_700_000_013_100 } },
        parts: [{ id: "p3", sessionID: "ses-test", messageID: "m3", type: "text", text: "second" }],
      }),
      makeMsg({
        info: {
          id: "m4", role: "assistant", agent: "build",
          providerID: "anthropic", modelID: "claude-sonnet-4-5",
          time: { created: 1_700_000_014_000, completed: 1_700_000_015_000 },
        },
        parts: [{ id: "p4", sessionID: "ses-test", messageID: "m4", type: "text", text: "third" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
    });

    // Header: requested=5, actual=3 → hint label.
    expect(out).toContain("📜 最近 5 条消息 (实际显示 3 条)");
    // Tool-only turn skipped (m2 is bash-only).
    expect(out).not.toContain("tool:bash");
    expect(out).not.toContain("(空消息)");
    // All 3 text messages present, in chronological order.
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("third"));
    // Exactly 3 rendered headers.
    expect(headerLines(out).length).toBe(3);
    // Over-fetched by 3× (5 × 3 = 15).
    expect(fetch).toHaveBeenCalledWith("ses-test", 15);
  });

  test("every turn is tool-only → 'all-empty' notice instead of header", async () => {
    const fetched = [
      makeMsg({
        info: { id: "m1", role: "assistant", agent: "ultraworker", providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 } },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "tool", tool: "bash" }],
      }),
      makeMsg({
        info: { id: "m2", role: "assistant", agent: "ultraworker", providerID: "anthropic", modelID: "claude-sonnet-4-5", time: { created: 1_700_000_012_000, completed: 1_700_000_013_000 } },
        parts: [{ id: "p2", sessionID: "ses-test", messageID: "m2", type: "tool", tool: "bash" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
    });

    expect(out).toContain("全部是工具/推理轮");
    expect(out).not.toContain("(空消息)");
    // The notice header still shows the requested count.
    expect(out).toContain("📜 最近 5 条消息");
  });

  test("FETCH_MAX cap clamps the over-fetch when count × multiplier exceeds it", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 100,  // 100 × 3 = 300, must be clamped to FETCH_MAX (60)
      cwd: CWD,
      fetch,
    });
    expect(fetch).toHaveBeenCalledWith("ses-test", 60);
  });

  test("/history 2 — parser returns count=2 and the helper over-fetches to 6", async () => {
    const fetch = vi.fn().mockResolvedValue([]);

    // First: parser correctness.
    const parsed = parseHistoryCommand("/history 2");
    expect(parsed).toEqual({ kind: "history", count: 2 });

    // Then: helper wires the count through to fetch with multiplier.
    await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: parsed.count,
      cwd: CWD,
      fetch,
    });
    expect(fetch).toHaveBeenCalledWith("ses-test", 6);
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

  test("null sessionId — reply says '当前没有活动会话' and fetch is NOT called", async () => {
    const fetch = vi.fn();
    const out = await fetchAndFormatHistory({
      sessionId: null,
      count: 5,
      cwd: CWD,
      fetch,
    });
    expect(out).toContain("当前没有活动会话");
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

  test("title fetcher throws — header omits 会话「…」 but command still succeeds", async () => {
    const fetched = [
      makeMsg({
        info: { id: "m1", role: "user", time: { created: 1_700_000_010_000, completed: 1_700_000_010_100 } },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "text", text: "hi" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);
    const getSessionTitle = vi.fn().mockRejectedValue(new Error("404 session not found"));

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
      getSessionTitle,
    });

    // Message still rendered (with hint because actual=1 < requested=5).
    expect(out).toContain("📜 最近 5 条消息 (实际显示 1 条)");
    expect(out).toContain("hi");
    // But skipped the 会话「…」 piece (no orphaned brackets).
    expect(out).not.toContain("会话「");
    expect(out).not.toContain("」· 工作区");
    // Cwd still present.
    expect(out).toContain(CWD);
  });

  test("legacy nested `info.model` shape is still accepted (back-compat for any caller)", async () => {
    // Some upstream code paths (legacy SessionManager snapshots) still
    // produce the nested `info.model = { providerID, modelID }` shape.
    // The formatter must keep reading it instead of falling back to
    // `(model unknown)`.
    const fetched = [
      makeMsg({
        info: {
          id: "m1", role: "assistant", agent: "build",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
          time: { created: 1_700_000_010_000, completed: 1_700_000_011_000 },
        },
        parts: [{ id: "p1", sessionID: "ses-test", messageID: "m1", type: "text", text: "legacy-model reply" }],
      }),
    ];
    const fetch = vi.fn().mockResolvedValue(fetched);

    const out = await fetchAndFormatHistory({
      sessionId: "ses-test",
      count: 5,
      cwd: CWD,
      fetch,
    });

    expect(out).toContain("build / anthropic/claude-sonnet-4-5");
    expect(out).not.toContain("(model unknown)");
  });
});