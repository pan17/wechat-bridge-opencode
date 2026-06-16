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
 * `getAgentStatus` is now REST-driven (see
 * `.omo/plans/agent-status-api-design.md` rationale): it calls
 * `GET /session/status` and returns the server's snapshot for the
 * current session. The previous SSE-cached `lastAgentStatus` is now
 * only used as a fallback when the API call fails, and as the source
 * for `isSessionBusy` (which must stay reactive for turn
 * finalization). The tests below cover both paths.
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
  test("returns the current session's status from the API snapshot", async () => {
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_current: { type: "busy" },
      ses_other: { type: "busy" }, // must be ignored
    });
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "busy" });
  });

  test("returns the full retry payload (attempt / message / next) from the API", async () => {
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_current: {
        type: "retry",
        attempt: 5,
        message: "rate-limited",
        next: 1000,
      },
    });
    await expect(m.getAgentStatus()).resolves.toEqual({
      type: "retry",
      attempt: 5,
      message: "rate-limited",
      next: 1000,
    });
  });

  test("defaults to { type: 'idle' } when the current session is not in the status map", async () => {
    // Server omits idle sessions from the response (entry deleted when
    // set to idle, see OpenCode SessionStatus.set). The bridge must
    // treat a missing entry as `idle` so /status shows ⚪ Agent: Idle
    // instead of (unknown).
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_other: { type: "busy" }, // different session — must be ignored
    });
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "idle" });
  });

  test("returns null when no sessionId is set yet (bridge has not created/resumed a session)", async () => {
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
    m.sessionId = null;
    // No API call should be made — the function short-circuits on missing sessionId.
    await expect(m.getAgentStatus()).resolves.toBeNull();
    expect(clientMock.getAllSessionStatuses).not.toHaveBeenCalled();
  });

  test("falls back to the SSE cache (lastAgentStatus) when the API call fails", async () => {
    // Regression: the bug we're fixing is "switch to a working session
    // shows Idle". But what if the API is unreachable? We still want
    // *something* to render — better the SSE cache (which is at most
    // a turn stale) than throwing the whole /status command.
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "busy" } },
    });
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(m.getAgentStatus()).resolves.toEqual({ type: "busy" });
  });

  test("falls back to default { type: 'idle' } when API fails AND no SSE event has arrived", async () => {
    // Bridge has just started; no SSE events yet; API is down.
    // The default SSE cache is `{ type: 'idle' }`, so the fallback
    // returns that — still better than throwing.
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("network down"));

    await expect(m.getAgentStatus()).resolves.toEqual({ type: "idle" });
  });
});

// ─── Status reset on session / workspace switch ───
//
// Regression: after `dispatch a task on session A` (which makes A
// `busy` via a `session.status: busy` SSE event), the user does
// `/s switch 1` to a different session B. Two state pieces must be
// reset so the NEW session starts with a clean slate:
//
//   1. `isSessionBusy` (boolean) — must drop to `false` immediately on
//      switch, otherwise the post-delta debounce in
//      `armFinalizeDebounce` would skip finalization for B's first
//      turn (the busy=true carries A's flag forward).
//
//   2. `lastAgentStatus` (SSE cache) — must reset to default. Its two
//      consumers are:
//        a. `isSessionBusy` derivation (covered by #1)
//        b. `getAgentStatus()` FALLBACK when the API call fails. If A
//           was `busy` and we switched to B but the API is down, the
//           fallback must NOT return A's `busy` for B. Reset to the
//           default `{ type: "idle" }`.
//
// `getAgentStatus()`'s PRIMARY path is the API snapshot, which is
// intrinsically per-session — switching the bridge's sessionId
// automatically re-queries with the new id. So the API path needs no
// local reset; only the fallback path does.

describe("SessionManager — status reset on switch", () => {
  test("switchSession resets isSessionBusy to false (SSE-driven finalization guard)", async () => {
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
    expect(m.isAgentBusy()).toBe(true);

    await m.switchSession("ses_b", "/b");
    // The boolean is what gates turn-finalize — must drop on switch.
    expect(m.isAgentBusy()).toBe(false);
  });

  test("switchSession resets lastAgentStatus (used as API-failure fallback)", async () => {
    // If A was `busy` and we switch to B but the API is down, the
    // fallback path (lastAgentStatus) must return B's default — not
    // A's stale `busy`. Verifying the reset:
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
      properties: { sessionID: "ses_a", status: { type: "retry", attempt: 1 } },
    });
    // Simulate the API being down — getAgentStatus() will fall back
    // to lastAgentStatus. Before switch, fallback returns retry.
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("network down"));
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "retry", attempt: 1 });

    await m.switchSession("ses_b", "/b");
    // After switch, the fallback must return the default (not A's retry).
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "idle" });
  });

  test("switchWorkspace also resets isSessionBusy and lastAgentStatus", async () => {
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
    expect(m.isAgentBusy()).toBe(true);

    // Existing-session-id path: skip the findRecentSessionInCwd lookup
    await m.switchWorkspace("/b", "ses_b");
    expect(m.isAgentBusy()).toBe(false);

    // Fallback also returns default (not A's busy).
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("network down"));
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "idle" });
  });

  test("after switch, getAgentStatus() reflects the NEW session via the API (the primary path)", async () => {
    // The PRIMARY path is the API, which is intrinsically per-session.
    // Switching the bridge's sessionId makes the next /status call
    // query for the new id — no local reset needed. This test proves
    // it: A was busy, we switch to B, the API now says B is busy,
    // /status shows B's busy (not A's leaked state).
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

    // API returns B as busy — this is what /status should display.
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_b: { type: "busy" },
    });
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "busy" });
  });

  test("after switch, a fresh session.status SSE event updates isSessionBusy (SSE path)", async () => {
    // The SSE path that gates turn finalization must still work after
    // a switch. Once the new session emits its first `session.status`
    // event, the bridge's reactive state picks it up.
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    const m = makeManager("ses_a");
    await m.switchSession("ses_b", "/b");
    expect(m.isAgentBusy()).toBe(false);

    // New session emits its first status event — populated
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_b", status: { type: "retry", attempt: 2 } },
    });
    expect(m.isAgentBusy()).toBe(false); // retry sets busy=false (terminal state)
    // And the fallback path picks it up too:
    clientMock.getAllSessionStatuses.mockRejectedValue(new Error("network down"));
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "retry", attempt: 2 });
  });
});
