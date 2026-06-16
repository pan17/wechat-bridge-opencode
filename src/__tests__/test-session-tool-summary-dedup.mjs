/**
 * Regression tests for tool-summary dedup across turn boundaries.
 *
 * Bug history: a long-running tool like `bash ping -n 120 127.0.0.1`
 * would emit the same `⏳ bash ping …` line to WeChat multiple times.
 *
 * Root cause: the dedup was a per-turn Set (`toolCallIdsInLastSummary`)
 * on `AccumulatedTurn`. When the 500ms finalize debounce fired during
 * the tool's execution, the turn was finalized and `currentTurn` was
 * set to null. The next `message.part.updated` for the same tool created
 * a NEW implicit turn via `ensureTurnForEvent`, which started with an
 * empty Set — so the same `callID` was treated as "new" and re-emitted.
 *
 * Fix: dedup is now session-level via `SessionManager.toolLastSentStatus`
 * (Map of `callID → lastSentStatus`). The Map survives implicit-turn
 * creation, and the dedup compares the CURRENT `status` against the
 * LAST-SENT `status` (not just membership), so status transitions
 * (running → completed) still emit a fresh `✅` line.
 *
 * What we verify here:
 *   - Same callID, same status, after premature finalize + implicit turn
 *     → flush is a NO-OP (the bug fix).
 *   - Same callID, status changes running → completed within one turn
 *     → second flush DOES emit (✅).
 *   - Same callID, status changes across turn boundary
 *     → second flush DOES emit (✅).
 *   - Two distinct callIDs (parallel tools) → both emit independently.
 *   - `discardInFlightTurn` clears the Map (session switch isolation).
 *
 * Test pattern: we use `maybeSendTextPart(turn, textPart)` to trigger
 * BOTH the tool-summary flush AND the text send in one call, which is
 * the natural boundary where tool summaries appear in production.
 * `flushNowForTest()` is used at end-of-turn to drain remaining text.
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

function makeManager({ sessionId = "ses_test", showTools = true } = {}) {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
    cancelTyping: async () => {},
    onSessionReady: undefined,
  });
  sm.sessionId = sessionId;
  // The implicit-turn creator in ensureTurnForEvent needs a fallback
  // contextToken. In production this is set by `enqueue()`; tests
  // bypass enqueue, so set it explicitly.
  sm["lastEnqueuedContextToken"] = "ctx-test";
  sm["setShowFlags"]({ showThoughts: false, showTools });
  return { sm, replyCalls };
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
    showThoughtsSnapshot: false,
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

function textPart(id, text) {
  return {
    id: id ?? `text-${Math.random().toString(36).slice(2)}`,
    sessionID: "ses_test",
    messageID: "am-1",
    type: "text",
    text,
  };
}

async function flushMicrotasks(n = 5) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const toolSummariesOf = (calls) => calls.filter((m) => m.startsWith("🔧 Tools:"));

// ─── Tests ───

describe("tool-summary dedup across turn boundaries (long-running tool regression)", () => {
  test("BUG REGRESSION: same callID after premature finalize + implicit turn does NOT re-emit '⏳'", async () => {
    // Reproduces the original bug: long-running bash tool triggers
    // turn finalization mid-execution, then a fresh tool event arrives
    // and creates an implicit turn via ensureTurnForEvent.
    const { sm, replyCalls } = makeManager();

    // ── Turn A ──
    let turn = makeTurnFixture();
    sm.currentTurn = turn;

    // 1. Tool starts running. trackTool adds it; no flush yet.
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    expect(turn.toolCalls.size).toBe(1);

    // 2. Text boundary → maybeFlushToolSummary fires → "⏳ bash" sent.
    sm["maybeSendTextPart"](turn, textPart("t1", "first response"));
    await flushMicrotasks();
    expect(replyCalls.length).toBe(2);
    expect(replyCalls[0]).toContain("⏳ bash");
    expect(replyCalls[1]).toBe("first response");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("running");

    // 3. Turn A finalizes (the bug path: 500ms debounce fires while the
    //    tool is still running, OR session.status=idle arrives).
    sm["flushNowForTest"]();
    expect(sm.currentTurn).toBeNull();

    // 4. Tool is STILL running server-side. Another tool event arrives
    //    for the same callID with status still "running". This creates
    //    an IMPLICIT turn via ensureTurnForEvent.
    sendPartUpdated(sm, null, toolPart("c1", "running"));
    await flushMicrotasks();
    turn = sm.currentTurn;
    expect(turn).not.toBeNull();
    // Implicit turns have assistantMessageId=null (set by handleMessageUpdated
    // in production). For the test, fake it so maybeSendTextPart sends
    // directly instead of buffering.
    turn.assistantMessageId = "am-1";
    expect(turn.toolCalls.size).toBe(1);
    expect(turn.toolCalls.get("c1").status).toBe("running");

    // 5. Text boundary in turn B → maybeFlushToolSummary runs again.
    //    EXPECTED: NO new "⏳ bash" line — same status, dedup hit.
    sm["maybeSendTextPart"](turn, textPart("t2", "during long run"));
    await flushMicrotasks();

    // Order: [⏳-A, "first response", "during long run"]
    // CRITICAL: only ONE tool summary was sent for c1's running state,
    // even though two turns observed it.
    expect(replyCalls.length).toBe(3);
    expect(replyCalls[0]).toContain("⏳ bash");
    expect(replyCalls[1]).toBe("first response");
    expect(replyCalls[2]).toBe("during long run");
    expect(toolSummariesOf(replyCalls).length).toBe(1);
  });

  test("status transition running → completed WITHIN one turn DOES emit a fresh '✅' line", async () => {
    // The dedup compares status, not just callID. A status change from
    // "running" to "completed" must trigger a new flush.
    const { sm, replyCalls } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // 1. Tool starts running + text boundary → "⏳ bash" + text emitted.
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    sm["maybeSendTextPart"](turn, textPart("t1", "started"));
    await flushMicrotasks();
    expect(replyCalls.length).toBe(2);
    expect(replyCalls[0]).toContain("⏳ bash");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("running");

    // 2. Tool completes (status change to "completed").
    sendPartUpdated(sm, turn, toolPart("c1", "completed"));
    // 3. Next text boundary → flush. status differs from lastSent →
    //    "✅ bash" is emitted.
    sm["maybeSendTextPart"](turn, textPart("t2", "done"));
    await flushMicrotasks();

    // Order: [⏳-A, "started", ✅-A, "done"]
    expect(replyCalls.length).toBe(4);
    expect(replyCalls[0]).toContain("⏳ bash");
    expect(replyCalls[1]).toBe("started");
    expect(replyCalls[2]).toContain("✅ bash");
    expect(replyCalls[3]).toBe("done");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("completed");
  });

  test("status transition running → completed ACROSS turn boundary DOES emit a fresh '✅' line", async () => {
    // Realistic scenario: ⏳ in turn A, tool completes after turn A
    // finalizes, completion event arrives in turn B (implicit),
    // ✅ emitted in turn B.
    const { sm, replyCalls } = makeManager();

    // ── Turn A ──
    let turn = makeTurnFixture();
    sm.currentTurn = turn;
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    sm["maybeSendTextPart"](turn, textPart("t1", "started"));
    await flushMicrotasks();
    expect(toolSummariesOf(replyCalls).length).toBe(1);
    expect(toolSummariesOf(replyCalls)[0]).toContain("⏳ bash");

    // Turn A finalizes while tool is running.
    sm["flushNowForTest"]();
    expect(sm.currentTurn).toBeNull();

    // ── Turn B (implicit) ──
    // Tool completion event arrives → ensureTurnForEvent creates turn B.
    sendPartUpdated(sm, null, toolPart("c1", "completed"));
    await flushMicrotasks();
    turn = sm.currentTurn;
    expect(turn).not.toBeNull();
    // Implicit turns have assistantMessageId=null. Fake it for the test
    // so maybeSendTextPart sends directly instead of buffering.
    turn.assistantMessageId = "am-1";

    // Text boundary in turn B → flush. status="completed" ≠ lastSent="running"
    // → DIFFERENT → "✅ bash" emitted.
    sm["maybeSendTextPart"](turn, textPart("t2", "all done"));
    await flushMicrotasks();

    expect(toolSummariesOf(replyCalls).length).toBe(2);
    expect(toolSummariesOf(replyCalls)[0]).toContain("⏳ bash");
    expect(toolSummariesOf(replyCalls)[1]).toContain("✅ bash");
    expect(replyCalls[replyCalls.length - 1]).toBe("all done");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("completed");
  });

  test("parallel tools with distinct callIDs each emit one ⏳ + one ✅, no cross-contamination", async () => {
    const { sm, replyCalls } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Two parallel tools start at the same time.
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    sendPartUpdated(sm, turn, toolPart("c2", "running"));
    // Single text boundary → both NEW tools → both ⏳ in ONE summary line.
    sm["maybeSendTextPart"](turn, textPart("t1", "two tools started"));
    await flushMicrotasks();

    expect(toolSummariesOf(replyCalls).length).toBe(1);
    const firstSummary = toolSummariesOf(replyCalls)[0];
    // First summary covers both tools.
    expect(firstSummary.split("\n").filter((l) => l.includes("bash")).length).toBe(2);

    // c1 completes first.
    sendPartUpdated(sm, turn, toolPart("c1", "completed"));
    sm["maybeSendTextPart"](turn, textPart("t2", "c1 done"));
    await flushMicrotasks();

    // c2 completes.
    sendPartUpdated(sm, turn, toolPart("c2", "completed"));
    sm["maybeSendTextPart"](turn, textPart("t3", "c2 done"));
    await flushMicrotasks();

    // 3 tool summaries total: combined start, c1-complete, c2-complete.
    const summaries = toolSummariesOf(replyCalls);
    expect(summaries.length).toBe(3);
    // Second summary covers only c1 (c2 still running, status unchanged).
    expect(summaries[1]).toContain("c1");
    expect(summaries[1]).not.toContain("c2");
    // Third summary covers only c2.
    expect(summaries[2]).toContain("c2");
    expect(summaries[2]).not.toContain("c1");
  });

  test("discardInFlightTurn (session switch) clears the dedup Map so the new session starts fresh", async () => {
    const { sm, replyCalls } = makeManager({ sessionId: "ses_A" });

    // Populate the dedup map with a tool from session A.
    let turn = makeTurnFixture({ sessionId: "ses_A" });
    sm.currentTurn = turn;
    sendPartUpdated(sm, turn, toolPart("c1", "running"));
    sm["maybeSendTextPart"](turn, textPart("t1", "session A"));
    await flushMicrotasks();
    expect(sm["toolLastSentStatus"].size).toBe(1);
    expect(sm["toolLastSentStatus"].get("c1")).toBe("running");

    // Switch sessions — discardInFlightTurn runs.
    sm.sessionId = "ses_B";
    sm["discardInFlightTurn"]();
    expect(sm.currentTurn).toBeNull();
    // The old session's callIDs MUST be cleared so the new session's
    // tool events don't inherit "already sent" state.
    expect(sm["toolLastSentStatus"].size).toBe(0);

    // New session — same callID "c1" but a DIFFERENT server-side call.
    // With dedup cleared, it must be treated as new.
    const newTurn = makeTurnFixture({ sessionId: "ses_B" });
    sm.currentTurn = newTurn;
    sendPartUpdated(sm, newTurn, toolPart("c1", "running"));
    sm["maybeSendTextPart"](newTurn, textPart("t2", "session B"));
    await flushMicrotasks();

    // We expect 2 ⏳-summary lines in total (one per session), NOT 1.
    const summaries = toolSummariesOf(replyCalls);
    expect(summaries.length).toBe(2);
    expect(summaries[0]).toContain("⏳ bash");
    expect(summaries[1]).toContain("⏳ bash");
  });

  test("fast tool with status=completed at first observation skips ⏳ and emits only ✅", async () => {
    // Design intent: don't spam "⏳ … ✅ …" for fast tools where the
    // pending/running event is never observed at a non-tool boundary.
    const { sm, replyCalls } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Tool arrives ALREADY completed (e.g. model batches pending+running
    // +completed before the next non-tool part arrives).
    sendPartUpdated(sm, turn, toolPart("c1", "completed"));
    sm["maybeSendTextPart"](turn, textPart("t1", "done"));
    await flushMicrotasks();

    const summaries = toolSummariesOf(replyCalls);
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toContain("✅ bash");
    expect(summaries[0]).not.toContain("⏳");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("completed");
  });

  test("many repeated 'running' updates between flushes produce only ONE ⏳ line", async () => {
    // The original bug surface: many duplicate `message.part.updated`
    // for the same callID+status before the turn finalizes. The Map's
    // same-status dedup must collapse them.
    const { sm, replyCalls } = makeManager();

    const turn = makeTurnFixture();
    sm.currentTurn = turn;

    // Five "running" updates arrive in rapid succession (simulating
    // server-side SSE retries / status reflections).
    for (let i = 0; i < 5; i++) {
      sendPartUpdated(sm, turn, toolPart("c1", "running"));
    }
    sm["maybeSendTextPart"](turn, textPart("t1", "k"));
    await flushMicrotasks();

    // Exactly ONE tool summary, not five.
    expect(toolSummariesOf(replyCalls).length).toBe(1);
    expect(toolSummariesOf(replyCalls)[0]).toContain("⏳ bash");
  });
});