/**
 * Unit tests for SessionManager.handleEvent's forwarding of non-current-
 * session events to the `onOtherSessionEvent` callback.
 *
 * The bridge wires the `SessionNotifier.handleEvent` method to this
 * callback so the cross-session notification feature can observe
 * events that the main `handleEvent` switch would otherwise drop.
 *
 * What we verify here:
 *   - Events for the current session → NOT forwarded (handled by the
 *     normal switch)
 *   - Events for a different session → forwarded to the callback
 *   - The callback is NOT called when no `onOtherSessionEvent` was
 *     passed to the constructor (defensive — works with old callers)
 *   - The callback receives the raw `OpenCodeEvent` (no wrapping)
 *   - A throwing callback doesn't crash the SSE pipeline (the
 *     SessionManager's own try/catch wraps the invocation)
 *   - A callback returning a rejected promise doesn't crash the SSE
 *     pipeline (errors are caught and logged)
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
    getAuthHeader: vi.fn().mockReturnValue(null),
    // Stubbed so handleEvent's question/permission handlers don't
    // throw when the test forces an event to flow through the
    // current-session path (used to verify the callback is NOT
    // invoked for current-session events).
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

function makeManager({ onOtherSessionEvent, currentSessionId = "ses_current" } = {}) {
  const log = vi.fn();
  const m = new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log,
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
    onOtherSessionEvent,
  });
  m.sessionId = currentSessionId;
  return { m, log };
}

// ─── Tests ───

describe("SessionManager.handleEvent — onOtherSessionEvent forwarding", () => {
  test("event for the CURRENT session is NOT forwarded to the callback", () => {
    const onOther = vi.fn();
    const { m } = makeManager({ onOtherSessionEvent: onOther });
    // Build a question.asked for the current session
    const event = {
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_current",
        questions: [{ question: "x", header: "h", options: [] }],
      },
    };
    m["handleEvent"](event);
    expect(onOther).not.toHaveBeenCalled();
  });

  test("event for an OTHER session IS forwarded to the callback with the raw event", () => {
    const onOther = vi.fn();
    const { m } = makeManager({ onOtherSessionEvent: onOther });
    const event = {
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: "ses_other",
        questions: [{ question: "x", header: "h", options: [] }],
      },
    };
    m["handleEvent"](event);
    expect(onOther).toHaveBeenCalledTimes(1);
    expect(onOther).toHaveBeenCalledWith(event);
  });

  test("event with no sessionID is NOT forwarded", () => {
    const onOther = vi.fn();
    const { m } = makeManager({ onOtherSessionEvent: onOther });
    // Some event types (e.g. server-wide installation.updated) have
    // no sessionID — the SessionManager's filter checks
    // `sid && sid !== sessionId`, so a missing sid means "this
    // filter doesn't apply" and the event falls through to the
    // normal switch. We need a defensive case where the event
    // actually HAS a sessionID and it differs.
    // Build a malformed event with explicit undefined sessionID —
    // this should not be forwarded (sid is falsy).
    const event = {
      type: "question.asked",
      properties: {
        id: "que_1",
        sessionID: undefined,
        questions: [{ question: "x", header: "h", options: [] }],
      },
    };
    m["handleEvent"](event);
    expect(onOther).not.toHaveBeenCalled();
  });

  test("all 4 supported event types forward correctly", () => {
    const onOther = vi.fn();
    const { m } = makeManager({ onOtherSessionEvent: onOther });
    const events = [
      {
        type: "question.asked",
        properties: { id: "q1", sessionID: "ses_other", questions: [{ question: "x", header: "h", options: [] }] },
      },
      {
        type: "permission.asked",
        properties: { id: "p1", sessionID: "ses_other", permission: "bash", patterns: [], metadata: {}, always: [] },
      },
      {
        type: "session.status",
        properties: { sessionID: "ses_other", status: { type: "busy" } },
      },
      {
        type: "session.error",
        properties: { sessionID: "ses_other", error: { message: "boom" } },
      },
    ];
    for (const e of events) {
      m["handleEvent"](e);
    }
    expect(onOther).toHaveBeenCalledTimes(events.length);
    events.forEach((e, i) => {
      expect(onOther.mock.calls[i][0]).toBe(e);
    });
  });

  test("text-delta events for other sessions ARE forwarded (raw firehose)", () => {
    // The SessionManager forwards ALL non-current events to the
    // callback — it's the notifier's job to filter to the 4
    // supported categories. Verifies the bridge between
    // SessionManager and SessionNotifier is a clean pass-through.
    const onOther = vi.fn();
    const { m } = makeManager({ onOtherSessionEvent: onOther });
    const event = {
      type: "message.part.delta",
      properties: { sessionID: "ses_other", messageID: "msg_1", partID: "p_1", field: "text", delta: "hi" },
    };
    m["handleEvent"](event);
    expect(onOther).toHaveBeenCalledTimes(1);
    expect(onOther).toHaveBeenCalledWith(event);
  });

  test("callback throwing synchronously does NOT crash the pipeline", () => {
    const onOther = vi.fn(() => { throw new Error("callback bug"); });
    const { m, log } = makeManager({ onOtherSessionEvent: onOther });
    const event = {
      type: "question.asked",
      properties: { id: "q1", sessionID: "ses_other", questions: [{ question: "x", header: "h", options: [] }] },
    };
    // Should not throw
    expect(() => m["handleEvent"](event)).not.toThrow();
    expect(onOther).toHaveBeenCalledTimes(1);
    // Error is logged (not propagated)
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("onOtherSessionEvent"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("callback bug");
  });

  test("callback returning rejected promise does NOT crash the pipeline", () => {
    const onOther = vi.fn(() => Promise.reject(new Error("async callback bug")));
    const { m, log } = makeManager({ onOtherSessionEvent: onOther });
    const event = {
      type: "permission.asked",
      properties: { id: "p1", sessionID: "ses_other", permission: "bash", patterns: [], metadata: {}, always: [] },
    };
    // Should not throw synchronously
    expect(() => m["handleEvent"](event)).not.toThrow();
    expect(onOther).toHaveBeenCalledTimes(1);
    // The async error is caught and logged eventually
    // (we don't await here — the handler is fire-and-forget)
    return new Promise((r) => setTimeout(r, 5)).then(() => {
      const errorLog = log.mock.calls
        .map((c) => c[0])
        .find((s) => typeof s === "string" && s.includes("onOtherSessionEvent"));
      expect(errorLog).toBeDefined();
      expect(errorLog).toContain("async callback bug");
    });
  });

  test("callback not provided: event silently dropped (backwards compatible)", () => {
    // Default makeManager() doesn't pass onOtherSessionEvent, so
    // it's undefined inside SessionManager. An event for another
    // session should be silently dropped — no crash, no callback.
    const { m } = makeManager();
    const event = {
      type: "question.asked",
      properties: { id: "q1", sessionID: "ses_other", questions: [{ question: "x", header: "h", options: [] }] },
    };
    expect(() => m["handleEvent"](event)).not.toThrow();
    // Nothing to assert about onOther — it was never set
  });
});
