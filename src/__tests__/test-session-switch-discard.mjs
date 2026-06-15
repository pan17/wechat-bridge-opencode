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
    toolCallIdsInLastSummary: new Set(),
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