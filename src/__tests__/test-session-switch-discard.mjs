/**
 * Unit tests for the in-flight-turn discard behavior on session/workspace switch.
 *
 * Background (regression): when the user runs `/session switch N` or
 * `/workspace switch <path>` while a turn from the OLD session is still
 * streaming, the OLD turn's deferred finalize timers (500ms debounce,
 * 5min stuck timeout) could fire AFTER the switch and flush the OLD
 * session's buffered text / reasoning / tool summary to WeChat — even
 * though the user had explicitly moved on. This file locks the fix:
 * switching must discard the in-flight turn WITHOUT calling `onReply`,
 * cancel typing, and clear pending echoes.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    getSessionMessages: vi.fn(),
    listSessionsV2: vi.fn(),
    listAgents: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    getConfig: vi.fn().mockResolvedValue({}),
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    getAuthHeader: vi.fn().mockReturnValue(null),
  },
}));

vi.mock("../../dist/src/server/client.js", () => ({
  OpenCodeServerClient: class {
    constructor() {
      return clientMock;
    }
  },
}));

import { SessionManager } from "../../dist/src/server/session.js";

beforeEach(() => {
  clientMock.createSession.mockReset();
  clientMock.getSession.mockReset();
  clientMock.getSessionMessages.mockReset();
  clientMock.listSessionsV2.mockReset();
  clientMock.listAgents.mockReset();
  clientMock.listProviders.mockReset();
  clientMock.getConfig.mockReset();

  clientMock.listSessionsV2.mockResolvedValue([]);
  clientMock.listAgents.mockResolvedValue([]);
  clientMock.listProviders.mockResolvedValue([]);
  clientMock.getConfig.mockResolvedValue({});
  clientMock.getSessionMessages.mockResolvedValue([]);
  clientMock.createSession.mockResolvedValue({ id: "ses_new_from_switch", title: "" });
  clientMock.getSession.mockResolvedValue({ id: "ses_existing", title: "" });
});

// ─── Helpers ───

function makeManager() {
  return new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/old/workspace",
    log: () => {},
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
  });
}

/**
 * Build a manager with a simulated in-flight turn for the OLD session.
 * The turn has buffered text/reasoning that has NOT been flushed yet
 * (i.e. `currentPartType === "text"` with `currentText` set, but the
 * partID is NOT in `sentTextPartIds`).
 *
 * This is the exact state that, without the fix, would be forwarded to
 * WeChat by the deferred finalize timers after the switch.
 */
function makeManagerWithInflightTurn() {
  const m = makeManager();
  // Pretend a user prompt was sent to session A and the agent started
  // streaming text partway through.
  m.currentTurn = {
    sessionId: "ses_old",
    userMessageId: "msg_user_old",
    assistantMessageId: "msg_asst_old",
    parts: new Map(),
    textBuffer: "",
    finalText: "",
    toolCalls: new Map(),
    hasBackgroundTasks: false,
    contextToken: "ctx_wechat_user",
    hint: null,
    status: "accumulating",
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    sentTextPartIds: new Set(),
    pendingTextParts: [],
    pendingReasoningParts: [],
    showThoughtsSnapshot: true,
    showToolsSnapshot: true,
    reasoningCharCount: 0,
    reasoningStartMs: null,
    reasoningEndMs: null,
    sentReasoningPartIds: new Set(),
    reasoningPartTimestamps: new Map(),
    // The smoking gun: a text part is being accumulated but not yet sent
    // (waiting for the next type change or turn end).
    currentPartType: "text",
    currentPartID: "part_text_unsent",
    currentReasoningText: "",
    currentReasoningStartMs: null,
    currentReasoningEndMs: null,
    currentText: "Half-streamed text from OLD session — should NOT be forwarded",
    currentToolKey: null,
  };
  // Pending echo for a second prompt that was sent but whose SSE echo
  // hasn't landed yet. Belongs to the OLD session — must be dropped.
  m.pendingEchoes = ["ctx_pending_old_prompt"];
  return m;
}

// ─── Tests: switchWorkspace discards in-flight turn ───

describe("SessionManager.switchWorkspace — discard in-flight turn", () => {
  test("sets currentTurn to null and drops pendingEchoes", async () => {
    const m = makeManagerWithInflightTurn();
    expect(m.currentTurn).not.toBeNull(); // sanity check the setup
    expect(m.pendingEchoes.length).toBe(1);

    await m.switchWorkspace("/new/workspace", undefined);

    expect(m.currentTurn).toBeNull();
    expect(m.pendingEchoes).toEqual([]);
  });

  test("does NOT call onReply with the OLD session's buffered text", async () => {
    const m = makeManagerWithInflightTurn();

    await m.switchWorkspace("/new/workspace", undefined);

    const replies = m.onReply.mock.calls.map((call) => call[1]);
    // The OLD session's half-streamed text must never reach WeChat after
    // the user has switched away.
    expect(replies).not.toContain("Half-streamed text from OLD session — should NOT be forwarded");
  });

  test("cancels typing indicator for the discarded turn's contextToken", async () => {
    const m = makeManagerWithInflightTurn();

    await m.switchWorkspace("/new/workspace", undefined);

    expect(m.cancelTyping).toHaveBeenCalledWith("ctx_wechat_user");
  });

  test("discarding unsent reasoning also does not leak 🧠 Thought lines", async () => {
    const m = makeManagerWithInflightTurn();
    // Replace the buffered text with buffered reasoning.
    m.currentTurn.currentPartType = "reasoning";
    m.currentTurn.currentPartID = "part_reasoning_unsent";
    m.currentTurn.currentReasoningText = "**Secret plan** I was about to stream to the user.";

    await m.switchWorkspace("/new/workspace", undefined);

    const replies = m.onReply.mock.calls.map((call) => call[1]);
    const thoughtLines = replies.filter((r) => r.includes("Thought"));
    expect(thoughtLines).toEqual([]);
  });
});

// ─── Tests: switchSession discards in-flight turn ───

describe("SessionManager.switchSession — discard in-flight turn", () => {
  test("sets currentTurn to null and drops pendingEchoes", async () => {
    const m = makeManagerWithInflightTurn();
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });

    await m.switchSession("ses_target", "/some/workspace");

    expect(m.currentTurn).toBeNull();
    expect(m.pendingEchoes).toEqual([]);
  });

  test("does NOT call onReply with the OLD session's buffered text", async () => {
    const m = makeManagerWithInflightTurn();
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });

    await m.switchSession("ses_target", "/some/workspace");

    const replies = m.onReply.mock.calls.map((call) => call[1]);
    expect(replies).not.toContain("Half-streamed text from OLD session — should NOT be forwarded");
  });

  test("cancels typing indicator for the discarded turn's contextToken", async () => {
    const m = makeManagerWithInflightTurn();
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });

    await m.switchSession("ses_target", "/some/workspace");

    expect(m.cancelTyping).toHaveBeenCalledWith("ctx_wechat_user");
  });

  test("clears stale agent/model/reasoning so the next prompt uses new-session defaults", async () => {
    // Regression: without the clear, switching to a session whose
    // workspace defines a different agent would carry the OLD agent
    // name forward and fail with `Agent not found`.
    const m = makeManagerWithInflightTurn();
    m.currentMode = "build";
    m.currentModelId = "anthropic/claude-opus-4-7";
    m.currentReasoning = "high";
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });

    await m.switchSession("ses_target", "/some/workspace");

    expect(m.currentMode).toBeUndefined();
    expect(m.currentModelId).toBeUndefined();
    expect(m.currentReasoning).toBeUndefined();
  });
});

// ─── Tests: timer-safe — finalize debounce doesn't fire stale content ───

describe("SessionManager — discard clears finalize timers", () => {
  test("after discard, advancing time past 500ms does NOT flush OLD content", async () => {
    // Use fake timers so we can deterministically advance past the
    // 500ms finalize debounce that `handleSessionIdle` would have armed.
    vi.useFakeTimers();
    try {
      const m = makeManagerWithInflightTurn();
      // Manually arm the finalize debounce via the same internal method
      // that `handleSessionIdle` / `handleSessionStatus` would call. We
      // access it through TypeScript's compile-time-only `private`
      // (still reachable at runtime via the prototype).
      const internal = /** @type {any} */ (m);
      internal.armFinalizeDebounce();

      // Sanity: the timer is armed.
      expect(internal.finalizeTimer).not.toBeNull();

      // Switch — discard should clear the timer.
      await m.switchWorkspace("/new/workspace", undefined);
      expect(internal.finalizeTimer).toBeNull();

      // Advance time past the debounce. If the timer were still armed,
      // `finalizeTurn` would run, see currentTurn null, and no-op; but the
      // more subtle risk is that the OLD turn's `currentText` somehow
      // leaked into a later turn's forwarding path. Belt-and-suspenders:
      // assert no onReply was ever made with the OLD text.
      vi.advanceTimersByTime(1000);
      const replies = m.onReply.mock.calls.map((call) => call[1]);
      expect(replies).not.toContain("Half-streamed text from OLD session — should NOT be forwarded");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Tests: switchSession resets totalTokens (no stale context count leak) ───
//
// Regression: switching sessions used to leave `totalTokens` populated from
// the PREVIOUS session. `/status` would then render the OLD session's
// cumulative context size for the NEW session (with the NEW session's
// context window as denominator) — e.g. "69.5k / 512k" after switching
// from a 1M-context session that had 69.5k of context. The fix resets
// `totalTokens = 0` before `syncStateFromServer` repopulates it from the
// target session's last assistant message.

describe("SessionManager.switchSession — totalTokens reset on switch", () => {
  test("clears stale totalTokens so OLD session's count does not leak", async () => {
    const m = makeManager();
    // Simulate the OLD session having a populated token count.
    const internal = /** @type {any} */ (m);
    internal.totalTokens = 69500;
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });
    // Target session has NO messages — syncStateFromServer can't repopulate.
    clientMock.getSessionMessages.mockResolvedValue([]);

    await m.switchSession("ses_target", "/some/workspace");

    expect(internal.totalTokens).toBe(0);
  });

  test("repopulates totalTokens from the NEW session's last assistant message", async () => {
    const m = makeManager();
    const internal = /** @type {any} */ (m);
    internal.totalTokens = 999999; // OLD session's huge count
    clientMock.getSession.mockResolvedValue({ id: "ses_target", title: "Target" });
    clientMock.getSessionMessages.mockResolvedValueOnce([
      {
        info: {
          role: "assistant",
          mode: "build",
          modelID: "claude-sonnet-4-5",
          providerID: "anthropic",
          variant: "high",
          tokens: { input: 500, output: 200, total: 12345 },
        },
        parts: [],
      },
    ]);

    await m.switchSession("ses_target", "/some/workspace");

    // After the switch, totalTokens must reflect the NEW session's
    // last assistant message — NOT the stale 999999 from the OLD session.
    expect(internal.totalTokens).toBe(12345);
  });

  test("leaves totalTokens at 0 when target session's last message has no tokens", async () => {
    // Edge case: brand-new session that has been created on the server but
    // never had a prompt sent. Last "message" may exist but carry no token
    // info yet. /status must show 0 / <model-size> rather than leaking the
    // OLD session's count.
    const m = makeManager();
    const internal = /** @type {any} */ (m);
    internal.totalTokens = 42000;
    clientMock.getSession.mockResolvedValue({ id: "ses_empty", title: "Empty" });
    clientMock.getSessionMessages.mockResolvedValueOnce([
      { info: { role: "assistant", mode: "build" }, parts: [] }, // no tokens field
    ]);

    await m.switchSession("ses_empty", "/some/workspace");

    expect(internal.totalTokens).toBe(0);
  });
});

// ─── Tests: switchWorkspace resets totalTokens on BOTH branches ───
//
// `switchWorkspace` is called by the bridge with `existingSessionId=undefined`
// (see bridge.ts:1438,1467). In that path, it auto-resumes the most recent
// session in the target cwd (calling `syncStateFromServer`) or creates a new
// session. Both branches must reset `totalTokens` so /status after
// `/workspace switch` doesn't leak the previous workspace's count.

describe("SessionManager.switchWorkspace — totalTokens reset on workspace switch", () => {
  test("auto-resume path: clears OLD count, repopulates from resumed session", async () => {
    const m = makeManager();
    const internal = /** @type {any} */ (m);
    internal.totalTokens = 50000;
    internal.sessionId = "ses_old_workspace";
    internal.cwd = "/old/workspace";
    // findRecentSessionInCwd → listServerSessions → listSessionsV2 → finds
    // a recent session in the TARGET cwd.
    clientMock.listSessionsV2.mockResolvedValue([
      {
        id: "ses_resumed",
        title: "Resumed",
        directory: "/new/workspace",
        updatedAt: Date.now(),
      },
    ]);
    // getSession() is called to verify the resumed session still exists.
    clientMock.getSession.mockResolvedValue({ id: "ses_resumed", title: "Resumed" });
    // syncStateFromServer pulls the last message's tokens.total.
    clientMock.getSessionMessages.mockResolvedValueOnce([
      {
        info: {
          role: "assistant",
          mode: "build",
          modelID: "claude-sonnet-4-5",
          providerID: "anthropic",
          tokens: { input: 100, output: 50, total: 7777 },
        },
        parts: [],
      },
    ]);

    await m.switchWorkspace("/new/workspace");

    expect(internal.totalTokens).toBe(7777);
    expect(m.getSessionId()).toBe("ses_resumed");
  });

  test("new-session path: clears OLD count, leaves totalTokens at 0", async () => {
    // No recent session in target workspace → createNewSession branch.
    const m = makeManager();
    const internal = /** @type {any} */ (m);
    internal.totalTokens = 88000;
    internal.sessionId = "ses_old_workspace";
    // listServerSessions finds nothing in the target cwd → resume fails,
    // switchWorkspace falls through to createNewSession branch.
    clientMock.listSessionsV2.mockResolvedValue([]);

    await m.switchWorkspace("/brand-new/workspace");

    expect(internal.totalTokens).toBe(0);
    // sessionId should have changed to a freshly-created one (NOT the old).
    expect(m.getSessionId()).not.toBe("ses_old_workspace");
    expect(m.getSessionId()).toBeTruthy();
  });
});