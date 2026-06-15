/**
 * Unit tests for SessionManager.getOtherRunningSessionCount and
 * SessionManager.getAgentStatus.
 *
 * Strategy: mock the OpenCodeServerClient module (vitest vi.mock),
 * create a real SessionManager, drive `listSessionsV2` and
 * `getAllSessionStatuses` returns through the shared mock object, and
 * verify the count behavior across the spec'd matrix:
 *
 *   - filters out the current session
 *   - filters out sub-agent / child sessions (those with parentID)
 *   - counts only entries whose status.type === "busy"
 *   - returns 0 on network failure (no throw)
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    listSessionsV2: vi.fn(),
    getAllSessionStatuses: vi.fn(),
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
  clientMock.listSessionsV2.mockReset();
  clientMock.getAllSessionStatuses.mockReset();
  // Default to an empty server. Individual tests override.
  clientMock.listSessionsV2.mockResolvedValue([]);
  clientMock.getAllSessionStatuses.mockResolvedValue({});
});

// ─── Helpers ───

function makeManager(sessionId) {
  const m = new SessionManager({
    serverUrl: "http://localhost:4096",
    cwd: "/test/cwd",
    log: () => {},
    onReply: vi.fn().mockResolvedValue(undefined),
    onMediaReply: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    cancelTyping: vi.fn().mockResolvedValue(undefined),
    onSessionReady: vi.fn(),
  });
  m.sessionId = sessionId;
  return m;
}

/**
 * Build a server-side root session entry. The shape mirrors what
 * `client.listSessionsV2` returns (the bridge filters to roots only
 * via `roots=true` on the server side).
 */
function root(id) {
  return { id, title: id, updatedAt: 0, directory: "/test", parentID: undefined };
}

// ─── Tests ───

describe("SessionManager.getOtherRunningSessionCount", () => {
  test("counts only busy OTHER root sessions (excludes current + idle)", async () => {
    const m = makeManager("ses_current");

    // The server's listSessionsV2 already filters with `roots=true`, so
    // sub-agent / child sessions (those with parentID) are NOT present
    // in the returned list. The bridge code trusts this filter and does
    // its own job purely on root IDs vs status. So the mock returns
    // 4 root sessions: this one (ses_current) + 3 others.
    clientMock.listSessionsV2.mockResolvedValue([
      root("ses_current"),
      root("ses_a"),
      root("ses_b"),
      root("ses_idle"),
    ]);

    clientMock.getAllSessionStatuses.mockResolvedValue({
      // Current session is busy — must NOT be counted (we report "other").
      ses_current: { type: "busy" },
      // Two other busy root sessions — should be counted.
      ses_a: { type: "busy" },
      ses_b: { type: "busy" },
      // Idle root session — present in roots, but status.type=idle so
      // it does NOT count.
      ses_idle: { type: "idle" },
    });

    const count = await m.getOtherRunningSessionCount();
    // Expected: ses_a + ses_b = 2. ses_current is filtered (it's us),
    // ses_idle is filtered (status.type !== "busy").
    expect(count).toBe(2);
  });

  test("returns 0 when no other sessions are running", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_current")]);
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_current: { type: "busy" },
    });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("returns 0 when status map is empty", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_a")]);
    clientMock.getAllSessionStatuses.mockResolvedValue({});

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("returns 0 on network failure (no throw)", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockRejectedValue(new Error("ECONNREFUSED"));

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("returns 0 when getAllSessionStatuses throws (no throw)", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_a")]);
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("500"));

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("current session is excluded even when busy and even if no other roots exist", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_current")]);
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_current: { type: "busy" },
    });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("retry status on a root session is NOT counted (only busy)", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_retry")]);
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_retry: { type: "retry", attempt: 2 },
    });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });
});

describe("SessionManager.getAgentStatus", () => {
  test("defaults to { type: 'idle' } before any SSE event arrives", () => {
    const m = makeManager("ses_current");
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
  });

  test("returns the latest payload after handleSessionStatus runs", () => {
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: {
        sessionID: "ses_current",
        status: { type: "retry", attempt: 5, message: "rate-limited", next: 1000 },
      },
    });
    expect(m.getAgentStatus()).toEqual({
      type: "retry",
      attempt: 5,
      message: "rate-limited",
      next: 1000,
    });
  });

  test("subsequent handleSessionStatus calls overwrite the cached payload", () => {
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "busy" } },
    });
    expect(m.getAgentStatus()).toEqual({ type: "busy" });

    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "idle" } },
    });
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
  });
});

// ─── Status reset on session / workspace switch ───
//
// Regression: after `dispatch a task on session A` (which makes A
// `busy` via a `session.status: busy` SSE event), the user does
// `/s switch 1` to a different session B. Without the fix, A's
// `lastAgentStatus` (and `isSessionBusy`) leaked into B's display —
// `/status` would show "🟢 Agent: Running" for B even though B has no
// activity. The fix: `discardInFlightTurn` (called by both
// `switchSession` and `switchWorkspace`) now resets both fields to
// the default in BOTH the with-turn and no-turn branches, so the
// new session starts with a clean status. The next
// `session.status` SSE event for the new session populates them
// again.

describe("SessionManager — status reset on switch", () => {
  test("switchSession resets lastAgentStatus and isSessionBusy to defaults", async () => {
    // Mock getSession to return a valid session so switchSession proceeds
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    const m = makeManager("ses_a");
    // Simulate: session A was busy (SSE event arrived)
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    });
    expect(m.getAgentStatus()).toEqual({ type: "busy" });
    expect(m.isAgentBusy()).toBe(true);

    // User switches to session B
    await m.switchSession("ses_b", "/b");
    // Status display for the NEW session should be the safe default
    // until its first SSE event arrives — NOT the stale "busy" from A.
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
    expect(m.isAgentBusy()).toBe(false);
  });

  test("switchSession resets even when there was NO active turn (defensive)", async () => {
    // The `discardInFlightTurn` early-return path (no currentTurn)
    // must also reset status, otherwise sessions that went busy
    // via an out-of-band SSE event (no bridge-initiated turn) would
    // leak their busy state into the next session.
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    const m = makeManager("ses_a");
    // Simulate a session.status: busy event with NO local turn
    // (e.g. a sub-agent's busy event was forwarded to the notifier
    // but somehow set isSessionBusy — or some race condition we
    // haven't seen but want to be defensive against).
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "retry", attempt: 1 } },
    });
    expect(m.isAgentBusy()).toBe(false); // retry path already sets isSessionBusy=false
    // But lastAgentStatus is still "retry" — must be cleared on switch
    expect(m.getAgentStatus().type).toBe("retry");

    await m.switchSession("ses_b", "/b");
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
  });

  test("switchWorkspace also resets status to defaults", async () => {
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    clientMock.listServerSessions = vi.fn().mockResolvedValue([]);
    const m = makeManager("ses_a");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    });
    expect(m.getAgentStatus()).toEqual({ type: "busy" });

    // Existing-session-id path: skip the findRecentSessionInCwd lookup
    await m.switchWorkspace("/b", "ses_b");
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
    expect(m.isAgentBusy()).toBe(false);
  });

  test("after switch, a fresh session.status event for the new session populates the display", async () => {
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    const m = makeManager("ses_a");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    });
    await m.switchSession("ses_b", "/b");
    // Reset to defaults
    expect(m.getAgentStatus()).toEqual({ type: "idle" });
    // New session emits its first status event — populated
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_b", status: { type: "retry", attempt: 2 } },
    });
    expect(m.getAgentStatus()).toEqual({ type: "retry", attempt: 2 });
  });
});
