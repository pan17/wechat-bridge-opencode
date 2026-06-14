/**
 * Unit tests for SessionManager's question state machine.
 *
 * The 12 acceptance cases from `.omo/plans/question-tool-design.md` §12.2.
 *
 * Strategy: mock the OpenCodeServerClient module (vitest vi.mock), create
 * a real SessionManager, then directly drive its internal state and
 * call the public + private methods. Because this is a .mjs file (no
 * TypeScript runtime), we can access `pendingQuestion` and call
 * `handleQuestionAsked` etc. without `as any` casts.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
//
// IMPORTANT: vitest's `vi.mock` calls are HOISTED to the top of the
// file, before any `import` statements. This means any variables they
// reference must be defined via `vi.hoisted`, otherwise the mock
// factory runs before the const is initialized and gets `undefined`.
//
// We use `vi.hoisted` to create the shared mock object + vi.fn()s
// before the (hoisted) vi.mock call, then export the references via
// a top-level const for use in tests.
const { clientMock } = vi.hoisted(() => {
  // Inside vi.hoisted, vitest's `vi` global is in scope. We use it
  // to create the shared mock object's methods BEFORE the (also
  // hoisted) vi.mock factory runs — the factory closes over this
  // clientMock and returns it on every OpenCodeServerClient construction.
  return {
    clientMock: {
      replyToQuestion: vi.fn().mockResolvedValue({ ok: true }),
      rejectQuestion: vi.fn().mockResolvedValue({ ok: true }),
      listQuestions: vi.fn().mockResolvedValue([]),
      getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
      getAuthHeader: vi.fn().mockReturnValue(null),
    },
  };
});

vi.mock("../../dist/src/server/client.js", () => ({
  // Vitest requires a `class` (not arrow function or `function` keyword)
  // for `new`-constructible mocks. The class constructor returns the
  // shared clientMock object, which JavaScript uses as the new instance
  // (per the `new` operator's "if constructor returns an object, that
  // becomes `this`" rule). All methods are looked up on the returned
  // object, so the mock has the same shape as the real client.
  OpenCodeServerClient: class {
    constructor() {
      return clientMock;
    }
  },
}));

// Import AFTER mock so the import is bound to the mocked module
import { SessionManager } from "../../dist/src/server/session.js";

beforeEach(() => {
  // Reset call history between tests
  clientMock.replyToQuestion.mockClear();
  clientMock.rejectQuestion.mockClear();
  clientMock.listQuestions.mockClear();
  clientMock.replyToQuestion.mockResolvedValue({ ok: true });
  clientMock.rejectQuestion.mockResolvedValue({ ok: true });
  clientMock.listQuestions.mockResolvedValue([]);
});

// ─── Helpers ───

/** Build a SessionManager with all callbacks wired to vi.fn(). */
function makeManager() {
  return new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {}, // silent
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: vi.fn(),
    onQuestionAsked: vi.fn().mockResolvedValue(undefined),
    onQuestionTimedOut: vi.fn().mockResolvedValue(undefined),
  });
}

const SAMPLE_REQUEST = {
  id: "que_test_123",
  sessionID: "ses_test",
  questions: [{
    question: "Pick one",
    header: "H",
    options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
  }],
};

const SAMPLE_REPLIED = { sessionID: "ses_test", requestID: "que_test_123", answers: [["A"]] };
const SAMPLE_REJECTED = { sessionID: "ses_test", requestID: "que_test_123" };

// ─── 12 cases ───

describe("SessionManager question state machine", () => {
  // 1
  test("handleQuestionAsked: normal path fills pendingQuestion + calls onQuestionAsked", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    expect(m.hasPendingQuestion()).toBe(true);
    expect(m.getPendingQuestion()?.requestID).toBe("que_test_123");
    expect(m.onQuestionAsked).toHaveBeenCalledOnce();
    const [ctx, questions, id] = m.onQuestionAsked.mock.calls[0];
    expect(ctx).toBe("ctx-1");
    expect(questions).toEqual(SAMPLE_REQUEST.questions);
    expect(id).toBe("que_test_123");
  });

  // 2
  test("handleQuestionAsked: no contextToken → auto-reject, no callback", () => {
    const m = makeManager();
    // lastEnqueuedContextToken is null
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    expect(m.hasPendingQuestion()).toBe(false);
    expect(m.onQuestionAsked).not.toHaveBeenCalled();
    // Give the microtask queue a chance to flush the .catch() on the mock
    return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
      expect(clientMock.rejectQuestion).toHaveBeenCalledWith("que_test_123", "/test/cwd");
    });
  });

  // 3
  test("handleQuestionAsked: previous unanswered → log warning + drop", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    // Second asked with different id while first is still pending
    m.handleQuestionAsked({
      type: "question.asked",
      properties: { ...SAMPLE_REQUEST, id: "que_test_456" },
    });
    // First one still pending
    expect(m.getPendingQuestion()?.requestID).toBe("que_test_123");
    // onQuestionAsked only called once (for the first)
    expect(m.onQuestionAsked).toHaveBeenCalledOnce();
  });

  // 4
  test("answerPendingQuestion: calls client.replyToQuestion + clears slot", async () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    await m.answerPendingQuestion([["A"]]);
    expect(clientMock.replyToQuestion).toHaveBeenCalledWith(
      "que_test_123",
      [["A"]],
      "/test/cwd",
    );
    expect(m.hasPendingQuestion()).toBe(false);
  });

  // 5
  test("answerPendingQuestion: client throws → slot still cleared, error rethrown", async () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    clientMock.replyToQuestion.mockRejectedValueOnce(new Error("404 not found"));
    await expect(m.answerPendingQuestion([["A"]])).rejects.toThrow("404 not found");
    expect(m.hasPendingQuestion()).toBe(false);
  });

  // 6
  test("rejectPendingQuestion: calls client.rejectQuestion + clears slot", async () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    await m.rejectPendingQuestion();
    expect(clientMock.rejectQuestion).toHaveBeenCalledWith("que_test_123", "/test/cwd");
    expect(m.hasPendingQuestion()).toBe(false);
  });

  // 7
  test("rejectPendingQuestion: no pending → no-op (no HTTP call)", async () => {
    const m = makeManager();
    await m.rejectPendingQuestion();
    expect(clientMock.rejectQuestion).not.toHaveBeenCalled();
  });

  // 8
  test("handleQuestionRepliedSse: clears slot (race-safe)", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    m.handleQuestionRepliedSse({ type: "question.replied", properties: SAMPLE_REPLIED });
    expect(m.hasPendingQuestion()).toBe(false);
  });

  // 9
  test("handleQuestionRejectedSse: clears slot (race-safe)", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    m.handleQuestionRejectedSse({ type: "question.rejected", properties: SAMPLE_REJECTED });
    expect(m.hasPendingQuestion()).toBe(false);
  });

  // 9b
  test("clearPendingQuestion: ignores mismatched requestID (race-safe)", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    // Simulate a stale SSE echo for an OLD question id
    m.handleQuestionRepliedSse({
      type: "question.replied",
      properties: { ...SAMPLE_REPLIED, requestID: "que_old_diff" },
    });
    // Local question should still be pending
    expect(m.hasPendingQuestion()).toBe(true);
    expect(m.getPendingQuestion()?.requestID).toBe("que_test_123");
  });

  // 10
  test("soft timeout: 30 min expiry triggers rejectPendingQuestion (override for test)", async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager();
      m.lastEnqueuedContextToken = "ctx-1";
      m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
      expect(m.hasPendingQuestion()).toBe(true);
      // Advance to just past 30 minutes
      vi.advanceTimersByTime(30 * 60_000 + 100);
      // Allow microtasks/Promise resolution to flush
      await vi.runAllTimersAsync();
      expect(m.hasPendingQuestion()).toBe(false);
      expect(clientMock.rejectQuestion).toHaveBeenCalled();
      expect(m.onQuestionTimedOut).toHaveBeenCalledWith("ctx-1");
    } finally {
      vi.useRealTimers();
    }
  });

  // 11
  test("soft timeout: user replies early → timer cleared (not fired)", async () => {
    vi.useFakeTimers();
    try {
      const m = makeManager();
      m.lastEnqueuedContextToken = "ctx-1";
      m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
      // User replies after 5 minutes (well before timeout)
      vi.advanceTimersByTime(5 * 60_000);
      await m.answerPendingQuestion([["A"]]);
      expect(m.hasPendingQuestion()).toBe(false);
      // Advance past 30 min — timer should not have fired
      vi.advanceTimersByTime(30 * 60_000);
      await vi.runAllTimersAsync();
      // onQuestionTimedOut should NOT have been called
      expect(m.onQuestionTimedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // 12
  test("hasPendingQuestion / getPendingQuestion are read-only (no side effects)", () => {
    const m = makeManager();
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    // Call many times — should not change state
    m.hasPendingQuestion();
    m.hasPendingQuestion();
    const p1 = m.getPendingQuestion();
    const p2 = m.getPendingQuestion();
    expect(p1).toBe(p2); // same object reference
    expect(m.hasPendingQuestion()).toBe(true);
  });

  // Bonus: listLeakedQuestions filtering
  test("listLeakedQuestions: filters by sessionID and excludes local requestID", async () => {
    const m = makeManager();
    // Set sessionId via the ensureSession side door (we don't actually want
    // to call the server, so we just set the private field)
    m.sessionId = "ses_my";
    m.lastEnqueuedContextToken = "ctx-1";
    m.handleQuestionAsked({ type: "question.asked", properties: SAMPLE_REQUEST });
    // Server has 3 questions: ours (same id), ours (different id), other session
    clientMock.listQuestions.mockResolvedValueOnce([
      { id: "que_test_123", sessionID: "ses_my", questions: [] },         // local → exclude
      { id: "que_other_999", sessionID: "ses_my", questions: [] },       // leaked → include
      { id: "que_x_123", sessionID: "ses_other", questions: [] },        // other session → exclude
    ]);
    const leaked = await m.listLeakedQuestions();
    expect(leaked).toHaveLength(1);
    expect(leaked[0].id).toBe("que_other_999");
  });
});
