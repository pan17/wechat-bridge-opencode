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
  /**
   * Drive the SSE event handler to populate `allSessionStatuses`.
   * Mirrors how a real bridge observes transitions on `/global/event`.
   */
  function pushStatus(m, sid, status) {
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: sid, status },
    });
  }

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

    // SSE-driven accumulation (no REST status call any more).
    pushStatus(m, "ses_current", { type: "busy" }); // current — filtered
    pushStatus(m, "ses_a", { type: "busy" });        // counted
    pushStatus(m, "ses_b", { type: "busy" });        // counted
    pushStatus(m, "ses_idle", { type: "idle" });     // idle — filtered

    const count = await m.getOtherRunningSessionCount();
    // Expected: ses_a + ses_b = 2. ses_current is filtered (it's us),
    // ses_idle is filtered (status.type !== "busy").
    expect(count).toBe(2);
  });

  test("returns 0 when no other sessions are running", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_current")]);
    pushStatus(m, "ses_current", { type: "busy" });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("returns 0 when allSessionStatuses is empty", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_a")]);
    // No SSE events have arrived yet — the bridge doesn't know about
    // ses_a even though it exists in the server-wide list.
    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("returns 0 on network failure (no throw)", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockRejectedValue(new Error("ECONNREFUSED"));
    pushStatus(m, "ses_a", { type: "busy" });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("current session is excluded even when busy and even if no other roots exist", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_current")]);
    pushStatus(m, "ses_current", { type: "busy" });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("retry status on a root session is NOT counted (only busy)", async () => {
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([root("ses_retry")]);
    pushStatus(m, "ses_retry", { type: "retry", attempt: 2 });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(0);
  });

  test("counts busy sessions from OTHER workspaces (the whole point of the redesign)", async () => {
    // The /status line 📈 Other running sessions: N is meant to surface
    // cross-workspace busy runs on the same opencode server instance.
    // listSessionsV2 returns server-wide (no ?directory=), and
    // allSessionStatuses accumulates across all workspaces via SSE.
    // Together they must include a busy root session in a workspace
    // the bridge has never set as cwd.
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([
      root("ses_current"),
      { ...root("ses_other_workspace"), directory: "/some/other/workspace" },
    ]);
    pushStatus(m, "ses_current", { type: "busy" });
    pushStatus(m, "ses_other_workspace", { type: "busy" });

    const count = await m.getOtherRunningSessionCount();
    expect(count).toBe(1);
    // Sanity: confirms the server-wide `listSessionsV2` was used
    // without directory forwarding — `clientMock.getAllSessionStatuses`
    // is no longer called by this function.
    expect(clientMock.getAllSessionStatuses).not.toHaveBeenCalled();
  });

  test("after switchSession, accumulated statuses from other sessions are preserved", async () => {
    // allSessionStatuses is server-wide; switching the bridge's
    // current session must not evict other sessions' statuses. We
    // assert on the map size directly rather than the count, because
    // the "current" filter changes meaning after the switch (ses_b
    // is now current and was never observed, so count math shifts).
    clientMock.getSession = vi.fn().mockResolvedValue({
      id: "ses_b",
      slug: "b",
      title: "B",
      directory: "/b",
      projectID: "p",
      version: "1",
    });
    const m = makeManager("ses_a");
    pushStatus(m, "ses_a", { type: "busy" });
    pushStatus(m, "ses_other", { type: "busy" });
    expect(m["allSessionStatuses"].size).toBe(2);

    await m.switchSession("ses_b", "/b");
    // The server-wide cache survived the switch — both entries are
    // still here. (This is the property under test; compare with
    // `lastAgentStatus` which is reset to default on switch.)
    expect(m["allSessionStatuses"].size).toBe(2);
    expect(m["allSessionStatuses"].get("ses_other")).toEqual({ type: "busy" });
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

  test("forwards this.cwd as the directory query arg to /session/status", async () => {
    // Regression: the OpenCode Server's WorkspaceRoutingMiddleware
    // routes /session/status to the workspace instance matching
    // ?directory=... Without it, the server returns an empty map and
    // the bridge treats every session as idle — even when it's busy.
    // The fix forwards `this.cwd` (set at SessionManager construction).
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockResolvedValue({});
    await m.getAgentStatus();
    expect(clientMock.getAllSessionStatuses).toHaveBeenCalledWith("/test/cwd");
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

  test("falls back to SSE cache when REST map omits the current session AND cache has busy", async () => {
    // Regression: bridge just observed `session.status = busy` for the
    // current session (cache populated), but the REST snapshot hasn't
    // resynced yet (or the server omits the entry). Prefer the cache
    // over the default `{ type: "idle" }` so /status doesn't flicker
    // to Idle in the narrow window between SSE event arrival and REST
    // snapshot propagation.
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "busy" } },
    });
    clientMock.getAllSessionStatuses.mockResolvedValue({
      ses_other: { type: "idle" }, // current session missing entirely
    });
    await expect(m.getAgentStatus()).resolves.toEqual({ type: "busy" });
  });

  test("falls back to SSE cache retry payload (attempt) when REST map omits the current session", async () => {
    // Same regression as above but for retry — the bridge must preserve
    // the full payload (attempt counter) so /status can render
    // `🟡 Agent: Retrying (attempt N)`, not just the bare `{ type }`.
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: {
        sessionID: "ses_current",
        status: { type: "retry", attempt: 3, message: "rate-limited" },
      },
    });
    clientMock.getAllSessionStatuses.mockResolvedValue({});
    await expect(m.getAgentStatus()).resolves.toEqual({
      type: "retry",
      attempt: 3,
      message: "rate-limited",
    });
  });

  test("defaults to { type: 'idle' } when REST map omits the current session AND no SSE event has arrived", async () => {
    // Bridge just started; no SSE events yet; server's map doesn't
    // include the current session (server omitted it). SSE cache is
    // still at the default `{ type: 'idle' }`, so the fallback also
    // returns that — same render as the pre-existing test above, but
    // now exercising the SSE-cache fallback path explicitly.
    const m = makeManager("ses_current");
    clientMock.getAllSessionStatuses.mockResolvedValue({});
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

// ─── allSessionStatuses sync via handleEvent (other-session events) ───
//
// Regression for: `/status` showed `Other running sessions: N` stuck at
// a stale count after a session finished. Root cause: `handleEvent`
// early-returned for ALL events whose `sessionID` did not match
// `this.sessionId`, so non-current `session.status` events never
// reached `handleSessionStatus` and `allSessionStatuses` was never
// updated to reflect busy→idle transitions on other sessions. Any
// stale `busy` entry in the map stayed there forever, and the count
// got stuck.
//
// Fix: `handleEvent` has a carve-out for `session.status` and
// `session.idle` events that lets them flow through to the dispatch
// switch; the handlers themselves gate the per-session side effects
// (isSessionBusy, lastAgentStatus, finalize debounce) on
// `sid === this.sessionId`. These tests drive the REAL production path
// (`m["handleEvent"](event)`), unlike the older tests above which
// call `m["handleSessionStatus"](...)` directly and thus bypass the
// fix.

describe("SessionManager.handleEvent — allSessionStatuses sync for other sessions", () => {
  test("non-current session.status: busy populates allSessionStatuses", () => {
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    expect(m["allSessionStatuses"].get("ses_other")).toEqual({ type: "busy" });
  });

  test("non-current session.status: idle overwrites the busy entry", () => {
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(m["allSessionStatuses"].get("ses_other")).toEqual({ type: "idle" });
  });

  test("non-current session.status: retry writes the full payload (attempt) to allSessionStatuses", () => {
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.status",
      properties: {
        sessionID: "ses_other",
        status: { type: "retry", attempt: 3, message: "rate-limited" },
      },
    });
    expect(m["allSessionStatuses"].get("ses_other")).toEqual({
      type: "retry",
      attempt: 3,
      message: "rate-limited",
    });
  });

  test("non-current session.status does NOT touch isSessionBusy", () => {
    // The other session going busy must not poison the current
    // session's turn-finalization gate.
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    expect(m.isAgentBusy()).toBe(false);
  });

  test("non-current session.status does NOT overwrite lastAgentStatus", () => {
    // The other session's status must not leak into the API-failure
    // fallback in getAgentStatus. Drive current busy first, then other
    // idle — the cache must still reflect the current session's state.
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "busy" } },
    });
    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(m["lastAgentStatus"]).toEqual({ type: "busy" });
  });

  test("non-current session.idle populates allSessionStatuses and does NOT touch isSessionBusy", () => {
    const m = makeManager("ses_current");
    m["handleEvent"]({
      type: "session.idle",
      properties: { sessionID: "ses_other" },
    });
    expect(m["allSessionStatuses"].get("ses_other")).toEqual({ type: "idle" });
    expect(m.isAgentBusy()).toBe(false);
  });

  test("current session.idle sets isSessionBusy=false (unchanged behavior)", () => {
    // Sanity check that the gate on the CURRENT path still works after
    // the carve-out — the carve-out for session.idle must not break
    // the original current-session side effect.
    const m = makeManager("ses_current");
    m["handleSessionStatus"]({
      type: "session.status",
      properties: { sessionID: "ses_current", status: { type: "busy" } },
    });
    expect(m.isAgentBusy()).toBe(true);
    m["handleEvent"]({
      type: "session.idle",
      properties: { sessionID: "ses_current" },
    });
    expect(m.isAgentBusy()).toBe(false);
  });

  test("getOtherRunningSessionCount reflects busy→idle on another session (end-to-end)", async () => {
    // End-to-end regression for the user-reported bug: drive the full
    // path the original fix targets. Other session goes busy, count
    // goes to 1; other session goes idle, count drops back to 0.
    // Before the fix, the second count was still 1 because
    // allSessionStatuses was frozen — exactly what the user saw in
    // the `/status` output.
    const m = makeManager("ses_current");
    clientMock.listSessionsV2.mockResolvedValue([
      root("ses_current"),
      root("ses_other"),
    ]);

    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    expect(await m.getOtherRunningSessionCount()).toBe(1);

    m["handleEvent"]({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(await m.getOtherRunningSessionCount()).toBe(0);
  });
});
