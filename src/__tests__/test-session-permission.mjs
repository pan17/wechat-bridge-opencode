/**
 * Unit tests for SessionManager's permission state machine.
 *
 * Exercises the 16 acceptance cases from
 * `.omo/plans/permission-tool-design.md` §10.2.
 *
 * Strategy: mock the OpenCodeServerClient module (vitest vi.mock),
 * create a real SessionManager, then directly drive its internal
 * state and call the public + private methods.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
const { clientMock } = vi.hoisted(() => {
  return {
    clientMock: {
      // Existing question methods (unchanged from question test)
      replyToQuestion: vi.fn().mockResolvedValue({ ok: true }),
      rejectQuestion: vi.fn().mockResolvedValue({ ok: true }),
      listQuestions: vi.fn().mockResolvedValue([]),
      // New permission methods
      replyToPermission: vi.fn().mockResolvedValue({ ok: true }),
      rejectPendingPermission: vi.fn().mockResolvedValue({ ok: true }),
      listPendingPermissions: vi.fn().mockResolvedValue([]),
      getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
      getAuthHeader: vi.fn().mockReturnValue(null),
    },
  };
});

vi.mock("../../dist/src/server/client.js", () => ({
  OpenCodeServerClient: class {
    constructor() {
      return clientMock;
    }
  },
}));

import { SessionManager } from "../../dist/src/server/session.js";

beforeEach(() => {
  clientMock.replyToQuestion.mockClear();
  clientMock.rejectQuestion.mockClear();
  clientMock.listQuestions.mockClear();
  clientMock.replyToPermission.mockClear();
  clientMock.rejectPendingPermission.mockClear();
  clientMock.listPendingPermissions.mockClear();
  clientMock.replyToQuestion.mockResolvedValue({ ok: true });
  clientMock.rejectQuestion.mockResolvedValue({ ok: true });
  clientMock.listQuestions.mockResolvedValue([]);
  clientMock.replyToPermission.mockResolvedValue({ ok: true });
  clientMock.rejectPendingPermission.mockResolvedValue({ ok: true });
  clientMock.listPendingPermissions.mockResolvedValue([]);
});

// ─── Helpers ───

/** Build a SessionManager with all callbacks wired to vi.fn(). */
function makeManager(extraOpts = {}) {
  return new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {},
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: undefined,
    onPermissionAsked: vi.fn().mockResolvedValue(undefined),
    onPermissionTimedOut: vi.fn().mockResolvedValue(undefined),
    ...extraOpts,
  });
}

/** Build a permission.asked event for testing. */
function permissionAsked(overrides = {}) {
  return {
    type: "permission.asked",
    properties: {
      id: overrides.id ?? "per_abc",
      sessionID: overrides.sessionID ?? "ses_test",
      permission: overrides.permission ?? "bash",
      patterns: overrides.patterns ?? ["cat /etc/hosts"],
      metadata: overrides.metadata ?? {},
      always: overrides.always ?? [],
    },
  };
}

/** Build a permission.replied event. */
function permissionRepliedSse(requestID, reply = "once") {
  return {
    type: "permission.replied",
    properties: { sessionID: "ses_test", requestID, reply },
  };
}

// ─── Tests ───

describe("SessionManager permission state machine", () => {
  test("handlePermissionAsked (off mode): fills pending, fires callback", async () => {
    const onAsked = vi.fn().mockResolvedValue(undefined);
    const m = makeManager({
      onPermissionAsked: onAsked,
    });
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    const event = permissionAsked();
    m["handlePermissionAsked"](event);
    expect(m.hasPendingPermission("per_abc")).toBe(true);
    expect(m.getPendingPermission("per_abc")).not.toBeNull();
    expect(onAsked).toHaveBeenCalledWith("ctx_user1", event.properties, "per_abc");
  });

  test("handlePermissionAsked (auto=once): auto-replies without setting pending", async () => {
    const onAsked = vi.fn().mockResolvedValue(undefined);
    const m = makeManager({ onPermissionAsked: onAsked });
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m.setAutoPermissionMode("once");
    m["handlePermissionAsked"](permissionAsked());
    // Wait for the auto-reply promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(clientMock.replyToPermission).toHaveBeenCalledWith(
      "per_abc", "once", undefined, "/test/cwd",
    );
    expect(m.hasPendingPermission()).toBe(false);
    expect(onAsked).not.toHaveBeenCalled();
  });

  test("handlePermissionAsked (auto=always): auto-replies with 'always'", async () => {
    const onAsked = vi.fn().mockResolvedValue(undefined);
    const m = makeManager({ onPermissionAsked: onAsked });
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m.setAutoPermissionMode("always");
    m["handlePermissionAsked"](permissionAsked());
    await new Promise((r) => setTimeout(r, 10));
    expect(clientMock.replyToPermission).toHaveBeenCalledWith(
      "per_abc", "always", undefined, "/test/cwd",
    );
    expect(m.hasPendingPermission()).toBe(false);
    expect(onAsked).not.toHaveBeenCalled();
  });

  test("handlePermissionAsked (auto but server throws): no pending, no callback", async () => {
    clientMock.replyToPermission.mockRejectedValueOnce(new Error("404 not found"));
    const onAsked = vi.fn();
    const m = makeManager({ onPermissionAsked: onAsked });
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m.setAutoPermissionMode("once");
    m["handlePermissionAsked"](permissionAsked());
    await new Promise((r) => setTimeout(r, 10));
    expect(m.hasPendingPermission()).toBe(false);
    expect(onAsked).not.toHaveBeenCalled();
  });

  test("handlePermissionAsked: no contextToken → auto-rejects so agent doesn't block", async () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = null;
    m["handlePermissionAsked"](permissionAsked());
    await new Promise((r) => setTimeout(r, 10));
    expect(clientMock.rejectPendingPermission).toHaveBeenCalledWith(
      "per_abc", undefined, "/test/cwd",
    );
    expect(m.hasPendingPermission()).toBe(false);
  });

  test("handlePermissionAsked: concurrent permissions (different requestIDs) coexist", () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    m["handlePermissionAsked"](permissionAsked({ id: "per_bbb" }));
    expect(m.hasPendingPermission("per_aaa")).toBe(true);
    expect(m.hasPendingPermission("per_bbb")).toBe(true);
    expect(m.listPendingPermissions().length).toBe(2);
  });

  test("answerPendingPermission: normal path → POSTs + clears slot", async () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    await m.answerPendingPermission("per_aaa", "once");
    expect(clientMock.replyToPermission).toHaveBeenCalledWith(
      "per_aaa", "once", undefined, "/test/cwd",
    );
    expect(m.hasPendingPermission("per_aaa")).toBe(false);
  });

  test("answerPendingPermission: client throws → slot cleared in finally, error rethrown", async () => {
    clientMock.replyToPermission.mockRejectedValueOnce(new Error("HTTP 500"));
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    await expect(m.answerPendingPermission("per_aaa", "once")).rejects.toThrow("HTTP 500");
    expect(m.hasPendingPermission("per_aaa")).toBe(false);
  });

  test("rejectPendingPermission: normal path → clears slot first, then HTTP", async () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    await m.rejectPendingPermission("per_aaa");
    expect(m.hasPendingPermission("per_aaa")).toBe(false);
    expect(clientMock.rejectPendingPermission).toHaveBeenCalledWith(
      "per_aaa", undefined, "/test/cwd",
    );
  });

  test("rejectPendingPermission: no pending → no-op", async () => {
    const m = makeManager();
    await m.rejectPendingPermission("per_unknown");
    expect(clientMock.rejectPendingPermission).not.toHaveBeenCalled();
  });

  test("handlePermissionRepliedSse: clears matching ID", () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    m["handlePermissionAsked"](permissionAsked({ id: "per_bbb" }));
    m["handlePermissionRepliedSse"](permissionRepliedSse("per_aaa"));
    expect(m.hasPendingPermission("per_aaa")).toBe(false);
    expect(m.hasPendingPermission("per_bbb")).toBe(true);
  });

  test("handlePermissionRepliedSse: unknown requestID → no-op", () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
    // Should not throw, should not affect existing slot
    m["handlePermissionRepliedSse"](permissionRepliedSse("per_unknown_id"));
    expect(m.hasPendingPermission("per_aaa")).toBe(true);
  });

  test("soft timeout (30 min) → fires onPermissionTimedOut + rejects", async () => {
    vi.useFakeTimers();
    try {
      const onTimedOut = vi.fn().mockResolvedValue(undefined);
      const m = makeManager({ onPermissionTimedOut: onTimedOut });
      m.sessionId = "ses_test";
      m.lastEnqueuedContextToken = "ctx_user1";
      m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
      vi.advanceTimersByTime(30 * 60_000 + 100);
      // Allow microtasks (callback + HTTP) to flush
      await vi.runAllTimersAsync();
      expect(onTimedOut).toHaveBeenCalledWith("ctx_user1", "per_aaa");
      expect(clientMock.rejectPendingPermission).toHaveBeenCalledWith(
        "per_aaa", undefined, "/test/cwd",
      );
      expect(m.hasPendingPermission("per_aaa")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("soft timeout: early reply → timer cleared, no later auto-reject", async () => {
    vi.useFakeTimers();
    try {
      const onTimedOut = vi.fn().mockResolvedValue(undefined);
      const m = makeManager({ onPermissionTimedOut: onTimedOut });
      m.sessionId = "ses_test";
      m.lastEnqueuedContextToken = "ctx_user1";
      m["handlePermissionAsked"](permissionAsked({ id: "per_aaa" }));
      // Advance 5 minutes and reply
      vi.advanceTimersByTime(5 * 60_000);
      await m.answerPendingPermission("per_aaa", "once");
      // Now advance past 30 minutes — timer should NOT fire
      vi.advanceTimersByTime(30 * 60_000);
      await vi.runAllTimersAsync();
      expect(onTimedOut).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("setAutoPermissionMode / getAutoPermissionMode: round-trip", () => {
    const m = makeManager();
    expect(m.getAutoPermissionMode()).toBe("off"); // default
    m.setAutoPermissionMode("once");
    expect(m.getAutoPermissionMode()).toBe("once");
    m.setAutoPermissionMode("always");
    expect(m.getAutoPermissionMode()).toBe("always");
    m.setAutoPermissionMode("off");
    expect(m.getAutoPermissionMode()).toBe("off");
  });

  test("listLeakedPermissions: filters by sessionID + excludes local IDs", async () => {
    clientMock.listPendingPermissions.mockResolvedValueOnce([
      permissionAsked({ id: "per_local" }).properties,
      permissionAsked({ id: "per_other_session", sessionID: "ses_other" }).properties,
      permissionAsked({ id: "per_orphan" }).properties,
    ]);
    const m = makeManager();
    m.sessionId = "ses_test";
    m.lastEnqueuedContextToken = "ctx_user1";
    m["handlePermissionAsked"](permissionAsked({ id: "per_local" }));
    const leaked = await m.listLeakedPermissions();
    expect(leaked.length).toBe(1);
    expect(leaked[0]?.id).toBe("per_orphan");
  });

  test("rejectOrphanPermission: POSTs reject without touching local slot", async () => {
    const m = makeManager();
    m.sessionId = "ses_test";
    await m.rejectOrphanPermission("per_orphan_id");
    expect(clientMock.rejectPendingPermission).toHaveBeenCalledWith(
      "per_orphan_id", undefined, undefined,
    );
  });
});
