/**
 * Unit tests for the "send-failure warning" path in SessionManager.
 *
 * Bug history: when `apiPost` exhausted its retries, the
 * `onReply(...).catch(...)` blocks in `session.ts` ONLY logged the
 * error. The user had no signal that their agent's reply had been
 * silently dropped — they would stare at a quiet chat and assume the
 * agent was still thinking.
 *
 * Fix: each catch site invokes `notifySendFailure(contextToken, label)`
 * which forwards to the bridge's `onSendWarning` callback. The bridge
 * sends a short, user-visible `⚠️ 上一条<label>发送失败…` notice.
 *
 * What we verify here:
 *   - When `onReply` throws (simulating retry exhaustion), `onSendWarning`
 *     is invoked with the correct contextToken and a message containing
 *     `⚠️` and the correct label (文本回复 / 推理摘要 / 工具摘要).
 *   - The flushCurrentPart catch fires when a DIFFERENT part type
 *     arrives after the accumulated text/reasoning.
 *   - The maybeFlushToolSummary catch fires at a non-tool boundary.
 *   - The maybeSendTextPart catch fires when called directly (used by
 *     the legacy / buffer-flush paths).
 *   - When `onReply` succeeds, `onSendWarning` is NOT called.
 *   - When the warning itself throws, the failure is contained (logged,
 *     no crash) — same `notifySendFailure` inner try/catch.
 *   - When `onSendWarning` is not wired (undefined), the catch path is
 *     a safe no-op (backward compat with SessionManager instances
 *     constructed without the new callback).
 *   - When contextToken is empty, notifySendFailure is a silent no-op
 *     (does NOT call onSendWarning with a phantom token).
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    getAuthHeader: vi.fn().mockReturnValue(null),
    rejectQuestion: vi.fn().mockResolvedValue(undefined),
    replyToQuestion: vi.fn().mockResolvedValue(undefined),
    replyToPermission: vi.fn().mockResolvedValue(undefined),
    rejectPendingPermission: vi.fn().mockResolvedValue(undefined),
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
  clientMock.getBaseUrl.mockClear();
  clientMock.getAuthHeader.mockClear();
});

// ─── Helpers ───

/**
 * Build a SessionManager with a failing `onReply` (simulates retry
 * exhaustion at the apiPost layer) and a capturing `onSendWarning`.
 *
 * @param replyError If provided, onReply rejects with this value.
 *   Pass `null` explicitly to make onReply resolve successfully
 *   (the destructuring default fires on `undefined`, so a missing
 *   key would still produce a failing onReply).
 */
function makeManager({ replyError = new Error("HTTP gateway 502") } = {}) {
  const log = vi.fn();
  const warnings = [];
  const sm = new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log,
    onReply: replyError === null
      ? vi.fn().mockResolvedValue(undefined)
      : vi.fn().mockRejectedValue(replyError),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
    onSendWarning: vi.fn(async (contextToken, text) => {
      warnings.push({ contextToken, text });
    }),
  });
  sm.sessionId = "ses_test";
  sm["lastEnqueuedContextToken"] = "ctx-test";
  return { sm, log, warnings };
}

function makeTurnFixture(overrides = {}) {
  return {
    sessionId: "ses_test",
    userMessageId: "um-1",
    assistantMessageId: "am-1",
    parts: new Map(),
    textBuffer: "",
    finalText: "",
    toolCalls: new Map(),
    hasBackgroundTasks: false,
    contextToken: "ctx-test",
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
    currentPartType: null,
    currentPartID: null,
    currentReasoningText: "",
    currentReasoningStartMs: null,
    currentReasoningEndMs: null,
    currentText: "",
    currentToolKey: null,
    ...overrides,
  };
}

/** Drive a `message.part.updated` event through the full SSE pipeline. */
function sendPartUpdated(sm, turn, part) {
  sm["handleEvent"]({
    type: "message.part.updated",
    properties: {
      sessionID: turn?.sessionId ?? sm.sessionId,
      messageID: part.messageID ?? turn?.assistantMessageId ?? "am-1",
      part,
    },
  });
}

function textPart(id, text) {
  return {
    id: id ?? `text-${Math.random().toString(36).slice(2)}`,
    sessionID: "ses_test",
    messageID: "am-1",
    type: "text",
    text,
  };
}

function reasoningPart(id, text) {
  return {
    id: id ?? `reasoning-${Math.random().toString(36).slice(2)}`,
    sessionID: "ses_test",
    messageID: "am-1",
    type: "reasoning",
    text,
  };
}

function toolPart(callID, status, extras = {}) {
  return {
    id: `part-${callID}-${status}`,
    sessionID: "ses_test",
    messageID: "am-1",
    type: "tool",
    tool: "bash",
    callID,
    state: { status, title: `cmd-${callID}`, ...extras.state },
    ...extras,
  };
}

async function flushMicrotasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// ─── Tests ───

describe("SessionManager: onReply failure surfaces a ⚠️ warning", () => {
  test("text part: type-change flush → onReply throws → onSendWarning called with '⚠️ 上一条文本回复发送失败…' and correct contextToken", async () => {
    // The production path: handlePartUpdated buffers text into
    // turn.currentText; flushCurrentPart fires on the next type
    // change and dispatches onReply. The catch on the dispatch
    // routes to notifySendFailure("文本回复").
    const { sm, warnings } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // 1. Text part arrives → buffered into turn.currentText.
    sendPartUpdated(sm, turn, textPart("t1", "hello world"));
    // 2. A DIFFERENT part type arrives → flushCurrentPart runs the
    //    text case → onReply(turn.contextToken, turn.currentText).
    //    onReply rejects (simulating retry exhaustion) → catch fires.
    sendPartUpdated(sm, turn, reasoningPart("r1", "thinking"));
    await flushMicrotasks();

    expect(warnings.length).toBe(1);
    expect(warnings[0].contextToken).toBe("ctx-test");
    expect(warnings[0].text).toMatch(/⚠️ .*发送失败/);
    expect(warnings[0].text).toContain("文本回复");
  });

  test("maybeSendTextPart (legacy / buffer-flush path): onReply throws → '文本回复' warning", async () => {
    // The maybeSendTextPart catch site is a separate code path used
    // by flushPendingTextParts and similar entry points. Different
    // dispatch site, same label — both should fire.
    const { sm, warnings } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    sm["maybeSendTextPart"](turn, textPart("t1", "legacy path"));
    await flushMicrotasks();

    expect(warnings.length).toBe(1);
    expect(warnings[0].contextToken).toBe("ctx-test");
    expect(warnings[0].text).toContain("⚠️");
    expect(warnings[0].text).toContain("文本回复");
    expect(warnings[0].text).toMatch(/发送失败/);
  });

  test("reasoning summary: type-change flush → onReply throws → '推理摘要' warning", async () => {
    const { sm, warnings } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Reasoning first (populates turn.currentReasoningText), then a
    // text part triggers flushCurrentPart → reasoning case → onReply.
    sendPartUpdated(sm, turn, reasoningPart("r1", "deep thought"));
    sendPartUpdated(sm, turn, textPart("t1", "answer"));
    await flushMicrotasks();

    expect(warnings.length).toBe(1);
    expect(warnings[0].contextToken).toBe("ctx-test");
    expect(warnings[0].text).toContain("⚠️");
    expect(warnings[0].text).toContain("推理摘要");
    expect(warnings[0].text).toMatch(/发送失败/);
  });

  test("tool summary: tool part + non-tool boundary → onReply throws → '工具摘要' warning", async () => {
    const { sm, warnings } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // 1. Tool tracked.
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    // 2. Tool completes (running → completed status change).
    sendPartUpdated(sm, turn, toolPart("c1", "completed"));
    // 3. Non-tool boundary (text part) triggers maybeFlushToolSummary
    //    → onReply for the "🔧 Tools: …" line → catch fires with
    //    label "工具摘要".
    sendPartUpdated(sm, turn, textPart("t1", "all done"));
    await flushMicrotasks();

    expect(warnings.length).toBe(1);
    expect(warnings[0].contextToken).toBe("ctx-test");
    expect(warnings[0].text).toContain("⚠️");
    expect(warnings[0].text).toContain("工具摘要");
    expect(warnings[0].text).toMatch(/发送失败/);
  });

  test("onReply succeeds → onSendWarning is NOT called", async () => {
    // The catch path must NOT fire on success. Regression guard
    // against an over-eager notifySendFailure (e.g. calling it in
    // both .then and .catch).
    const { sm, warnings } = makeManager({ replyError: null });

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Two-part dispatch to trigger flushCurrentPart.
    sendPartUpdated(sm, turn, textPart("t1", "happy path"));
    sendPartUpdated(sm, turn, reasoningPart("r1", "x"));
    await flushMicrotasks();

    expect(warnings.length).toBe(0);
  });

  test("onSendWarning itself throws → contained (logged, no crash)", async () => {
    // If the warning dispatch itself fails (e.g. bridge wiring bug),
    // the SessionManager must NOT crash the SSE pipeline. The
    // notifySendFailure method has an inner try/catch that swallows
    // and just logs.
    const log = vi.fn();
    const sm = new SessionManager({
      serverUrl: "http://localhost:4096",
      cwd: "/test/cwd",
      log,
      onReply: vi.fn().mockRejectedValue(new Error("gateway 502")),
      onMediaReply: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      cancelTyping: vi.fn().mockResolvedValue(undefined),
      onSessionReady: undefined,
      onSendWarning: vi.fn().mockRejectedValue(new Error("warning also failed")),
    });
    sm.sessionId = "ses_test";
    sm["lastEnqueuedContextToken"] = "ctx-test";

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Drive via maybeSendTextPart — simplest path to the catch.
    sm["maybeSendTextPart"](turn, textPart("t1", "double failure scenario"));
    await flushMicrotasks();

    // The outer catch logged the onReply failure…
    const replyErrLogs = log.mock.calls
      .map((c) => c[0])
      .filter((s) => typeof s === "string" && s.includes("onReply error for text part"));
    expect(replyErrLogs.length).toBeGreaterThanOrEqual(1);

    // …and the inner catch in notifySendFailure logged the warning
    // failure too. We don't pin the exact phrasing (it's an
    // implementation detail), just assert something was logged
    // about a warning failure.
    const warningFailLogs = log.mock.calls
      .map((c) => c[0])
      .filter((s) => typeof s === "string" && s.includes("warning send also failed"));
    expect(warningFailLogs.length).toBeGreaterThanOrEqual(1);
  });

  test("onSendWarning not provided (undefined) → catch path is a safe no-op", async () => {
    // Pre-warning-path behavior: SessionManager must still work when
    // onSendWarning is omitted (backward compat for any code path
    // that constructs SessionManager without wiring the callback —
    // e.g. unit tests of unrelated features, or a future caller
    // that doesn't care about warnings).
    const log = vi.fn();
    const sm = new SessionManager({
      serverUrl: "http://localhost:4096",
      cwd: "/test/cwd",
      log,
      onReply: vi.fn().mockRejectedValue(new Error("gateway 502")),
      onMediaReply: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      cancelTyping: vi.fn().mockResolvedValue(undefined),
      onSessionReady: undefined,
      // onSendWarning intentionally omitted
    });
    sm.sessionId = "ses_test";
    sm["lastEnqueuedContextToken"] = "ctx-test";

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // No throw means notifySendFailure silently returned.
    expect(() => {
      sm["maybeSendTextPart"](turn, textPart("t1", "no callback wired"));
    }).not.toThrow();
    await flushMicrotasks();

    // The onReply error was still logged (preserve the pre-warning
    // diagnostic behavior — operators want to see WHY the send
    // failed even if no user-facing warning was dispatched).
    const replyErrLogs = log.mock.calls
      .map((c) => c[0])
      .filter((s) => typeof s === "string" && s.includes("onReply error for text part"));
    expect(replyErrLogs.length).toBeGreaterThanOrEqual(1);
  });

  test("empty contextToken → notifySendFailure is a silent no-op (does not call onSendWarning)", async () => {
    // Defensive guard: the production catch sites pass
    // `turn.contextToken ?? ""` to notifySendFailure. When contextToken
    // is empty (e.g. implicit turn before enqueue sets it), we must
    // NOT call onSendWarning with an empty token — that would route
    // to a phantom user.
    const warnings = [];
    const sm = new SessionManager({
      serverUrl: "http://localhost:4096",
      cwd: "/test/cwd",
      log: () => {},
      onReply: vi.fn().mockRejectedValue(new Error("gateway 502")),
      onMediaReply: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      cancelTyping: vi.fn().mockResolvedValue(undefined),
      onSessionReady: undefined,
      onSendWarning: vi.fn(async (contextToken, text) => {
        warnings.push({ contextToken, text });
      }),
    });
    sm.sessionId = "ses_test";
    // lastEnqueuedContextToken stays null.

    // Direct call: simulate the production catch site when contextToken
    // is empty (turn.contextToken ?? "").
    await sm["notifySendFailure"](undefined ?? "", "文本回复");

    expect(warnings.length).toBe(0);
  });
});