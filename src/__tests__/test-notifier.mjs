/**
 * Unit tests for the SessionNotifier behavior:
 *   - settings application + getSettings round-trip
 *   - master switch + per-type toggles gate notifications
 *   - dedupe suppresses the same session+event-type within 30s
 *   - current-session events are ignored (the SessionManager's
 *     normal handleEvent path handles them)
 *   - events with no sessionID are ignored
 *   - label cache: hit returns cached; miss triggers a fetch; fetch
 *     failure falls back to the shortId prefix and does NOT throw
 *   - busy→idle transition fires `completion` only when the session
 *     was previously seen as busy (avoids spurious completions for
 *     sessions that were already idle at startup)
 *   - unhandled event types (text deltas, message updates, etc.) are
 *     silently ignored
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

import { SessionNotifier } from "../../dist/src/notifier.js";
import { DEFAULT_NOTIFY_SETTINGS } from "../../dist/src/config.js";

// ─── Test fixtures ───

function makeNotifier(opts = {}) {
  const client = {
    getSession: vi.fn().mockResolvedValue({
      id: "ses_x",
      title: "Test Session",
      directory: "/test/cwd",
    }),
  };
  const send = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const n = new SessionNotifier({
    client,
    send,
    log,
    ...opts,
  });
  n.setCurrentSessionId("ses_current");
  return { n, client, send, log };
}

const sampleQuestion = {
  question: "Use OAuth or JWT?",
  header: "Auth",
  options: [{ label: "OAuth", description: "" }, { label: "JWT", description: "" }],
};
const samplePermission = {
  id: "per_test",
  sessionID: "ses_other",
  permission: "bash",
  patterns: ["npm test"],
  metadata: {},
  always: [],
};

// ─── Settings ───

describe("SessionNotifier — settings", () => {
  test("default settings are all-on", () => {
    const { n } = makeNotifier();
    const s = n.getSettings();
    expect(s.enabled).toBe(true);
    expect(s.types.question).toBe(true);
    expect(s.types.permission).toBe(true);
    expect(s.types.error).toBe(true);
    expect(s.types.completion).toBe(true);
    // matches DEFAULT_NOTIFY_SETTINGS
    expect(s).toEqual(DEFAULT_NOTIFY_SETTINGS);
  });

  test("applySettings replaces all settings", () => {
    const { n } = makeNotifier();
    n.applySettings({
      enabled: false,
      types: { question: false, permission: true, error: false, completion: true },
    });
    const s = n.getSettings();
    expect(s.enabled).toBe(false);
    expect(s.types.question).toBe(false);
    expect(s.types.permission).toBe(true);
  });

  test("setEnabled toggles master switch", () => {
    const { n } = makeNotifier();
    expect(n.setEnabled(false)).toBe(false);
    expect(n.getSettings().enabled).toBe(false);
    expect(n.setEnabled(true)).toBe(true);
    expect(n.getSettings().enabled).toBe(true);
  });

  test("setTypeEnabled toggles individual type", () => {
    const { n } = makeNotifier();
    expect(n.setTypeEnabled("question", false)).toBe(false);
    expect(n.getSettings().types.question).toBe(false);
    expect(n.getSettings().types.permission).toBe(true); // other types untouched
  });

  test("getSettings returns a deep clone (caller cannot mutate internal state)", () => {
    const { n } = makeNotifier();
    const s = n.getSettings();
    s.enabled = false;
    s.types.question = false;
    expect(n.getSettings().enabled).toBe(true);
    expect(n.getSettings().types.question).toBe(true);
  });
});

// ─── Event filtering ───

describe("SessionNotifier — event filtering", () => {
  test("current-session events are dropped (no send)", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_current", questions: [sampleQuestion] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("events with no sessionID are dropped", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      // no properties.sessionID — server-wide event, no target session
      properties: { id: "que_1", questions: [sampleQuestion] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("unhandled event types (e.g. text delta) are dropped", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "message.part.delta",
      properties: { sessionID: "ses_other", messageID: "msg_1", partID: "part_1", field: "text", delta: "hi" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("master switch off suppresses all notifications", async () => {
    const { n, send } = makeNotifier();
    n.setEnabled(false);
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("per-type off suppresses just that type", async () => {
    const { n, send } = makeNotifier();
    n.setTypeEnabled("question", false);
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    expect(send).not.toHaveBeenCalled();

    // permission still works
    await n.handleEvent({
      type: "permission.asked",
      properties: samplePermission,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("🔐");
  });
});

// ─── Dedupe ───

describe("SessionNotifier — dedupe", () => {
  test("same session+event within 30s window is suppressed", async () => {
    const { n, send } = makeNotifier();
    const event = {
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    };
    await n.handleEvent(event);
    await n.handleEvent(event); // duplicate
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("different sessions with same event type are NOT deduped", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other_a", questions: [sampleQuestion] },
    });
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_2", sessionID: "ses_other_b", questions: [sampleQuestion] },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("different event types for same session are NOT deduped", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    await n.handleEvent({
      type: "permission.asked",
      properties: samplePermission,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// ─── Completion (busy→idle) tracking ───

describe("SessionNotifier — completion (busy→idle)", () => {
  test("fires when session goes from busy to idle", async () => {
    const { n, send } = makeNotifier();
    // First: mark busy
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    expect(send).not.toHaveBeenCalled();
    // Then: go idle
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("✅");
  });

  test("idle without prior busy does NOT fire (avoids startup noise)", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("busy alone does NOT fire", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("completion type toggle off suppresses completion notifications", async () => {
    const { n, send } = makeNotifier();
    n.setTypeEnabled("completion", false);
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "busy" } },
    });
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    });
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── Error events ───

describe("SessionNotifier — error events", () => {
  test("error with sessionID fires", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "session.error",
      properties: { sessionID: "ses_other", error: { message: "rate limit" } },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("❌");
    expect(send.mock.calls[0][0]).toContain("rate limit");
  });

  test("error without sessionID is dropped", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "session.error",
      properties: { error: { message: "global error" } },
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("error with string error is rendered", async () => {
    const { n, send } = makeNotifier();
    await n.handleEvent({
      type: "session.error",
      properties: { sessionID: "ses_other", error: "plain string error" },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain("plain string error");
  });
});

// ─── Label cache ───

describe("SessionNotifier — label cache", () => {
  test("first event fetches label; subsequent events use cache (no second fetch)", async () => {
    const { n, client, send } = makeNotifier();
    // Override the default mock to control timing
    client.getSession.mockResolvedValue({
      id: "ses_other",
      title: "My Session",
      directory: "/repo",
    });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    // Allow the label fetch promise to resolve
    await new Promise((r) => setTimeout(r, 5));
    expect(client.getSession).toHaveBeenCalledTimes(1);

    // Second event with DIFFERENT event type → not deduped → still
    // uses the same cached label
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_2" },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(client.getSession).toHaveBeenCalledTimes(1);
  });

  test("label fetch failure does NOT throw and falls back to shortId", async () => {
    const { n, client, send } = makeNotifier();
    client.getSession.mockRejectedValue(new Error("404 Not Found"));

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Notification was still sent
    expect(send).toHaveBeenCalledTimes(1);
    // And it contains the shortId fallback. `ses_other` is 9 chars
    // (< 16) so the fallback returns the full id verbatim.
    expect(send.mock.calls[0][0]).toContain("ses_other");
    // But NOT a 📂 line (no directory on the fallback path)
    expect(send.mock.calls[0][0]).not.toContain("📂");
  });

  test("first event AWAITS the fetch — the rendered notification uses the real title + directory", async () => {
    // Regression test for the bug where the first notification for a
    // new session was rendered with the short-id fallback (no
    // directory, no agent, no parentID) because resolveSessionInfo
    // returned synchronously before the HTTP fetch resolved. The fix
    // was to actually await the fetch — the first event pays the
    // round-trip cost, every subsequent event hits the cache.
    const { n, client, send } = makeNotifier();
    let resolveFetch;
    client.getSession.mockImplementation(() => new Promise((r) => { resolveFetch = r; }));

    const handler = n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    // Notification has NOT been sent yet — handleEvent is awaiting the fetch
    expect(send).not.toHaveBeenCalled();
    // Now resolve the fetch with real data
    resolveFetch({ id: "ses_other", title: "Real Title", directory: "/real" });
    await handler;
    // After resolution, the notification uses the REAL title + directory
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toContain('"Real Title"');
    expect(send.mock.calls[0][0]).toContain("/real");
    expect(send.mock.calls[0][0]).not.toContain("ses_other");
  });

  test("cached title + directory both flow through to the rendered notification", async () => {
    const { n, client, send } = makeNotifier();
    client.getSession.mockResolvedValue({
      id: "ses_other",
      title: "fix-auth",
      directory: "F:\\opencodeproject\\api",
    });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    // Allow fetch to resolve
    await new Promise((r) => setTimeout(r, 10));

    // First notification was sent with fallback (sync return)
    expect(send).toHaveBeenCalledTimes(1);
    // Second event for the same session — cache is now warm — will
    // use the real title + directory inline (no async wait).
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_2" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    const text = send.mock.calls[1][0];
    expect(text).toContain('"fix-auth"');
    expect(text).toContain("F:\\opencodeproject\\api");
    expect(text).toContain("📂");
  });

  test("server returning no directory renders without 📂 line", async () => {
    const { n, client, send } = makeNotifier();
    // Server response missing `directory` (older opencode or partial mock)
    client.getSession.mockResolvedValue({ id: "ses_other", title: "no-dir" });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Trigger a second event so the cache (with title only) is consulted
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_2" },
    });
    const text = send.mock.calls[1][0];
    expect(text).toContain('"no-dir"');
    expect(text).not.toContain("📂");
  });
});

// ─── setCurrentSessionId ───

describe("SessionNotifier — setCurrentSessionId", () => {
  test("switching the current session re-enables notifications for the old one", async () => {
    const { n, send } = makeNotifier();
    // ses_other is "other" while current = ses_current
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    expect(send).toHaveBeenCalledTimes(1);

    // Switch current to ses_other
    n.setCurrentSessionId("ses_other");
    // An event for the NEW current session should be ignored
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_2", sessionID: "ses_other", questions: [sampleQuestion] },
    });
    expect(send).toHaveBeenCalledTimes(1); // still just the first one

    // And events for the OLD current session are now "other" → notified
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_3", sessionID: "ses_current", questions: [sampleQuestion] },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// ─── Concurrency safety ───

describe("SessionNotifier — concurrent label fetches for the same sid are deduped", () => {
  test("two simultaneous events for the same new session trigger only one fetch", async () => {
    const { n, client, send } = makeNotifier();
    let fetchCount = 0;
    client.getSession.mockImplementation(async () => {
      fetchCount++;
      // Slight delay to allow concurrent calls to queue up
      await new Promise((r) => setTimeout(r, 5));
      return { id: "ses_new", title: "New", directory: "/new" };
    });

    // Fire two events back-to-back (both miss the cache)
    const p1 = n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_new", questions: [sampleQuestion] },
    });
    const p2 = n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_1", sessionID: "ses_new" },
    });
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 10));
    // Only one fetch happened (deduped via pendingLabelLookups set)
    expect(fetchCount).toBe(1);
    // Both notifications were sent
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// ─── Resilient error handling ───

describe("SessionNotifier — does not throw on bad input", () => {
  test("send throwing does not crash the notifier (logged via outer try/catch)", async () => {
    const { n } = makeNotifier({ send: vi.fn().mockImplementation(() => { throw new Error("send failed"); }) });
    // The handleEvent itself should not throw even though send does
    // (the outer try/catch in handleEvent catches it)
    await expect(
      n.handleEvent({
        type: "question.asked",
        properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
      }),
    ).resolves.toBeUndefined();
  });

  test("client.getSession throwing does not crash handleEvent", async () => {
    const { n, client } = makeNotifier();
    client.getSession.mockImplementation(() => { throw new Error("sync throw"); });
    await expect(
      n.handleEvent({
        type: "question.asked",
        properties: { id: "que_1", sessionID: "ses_other", questions: [sampleQuestion] },
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── Sub-agent / parentID propagation ───

describe("SessionNotifier — sub-agent fields", () => {
  test("parentID + agent from server flow into the rendered notice", async () => {
    const { n, client, send } = makeNotifier();
    client.getSession.mockResolvedValue({
      id: "ses_sub",
      title: "Build game UI components",
      directory: "F:\\opencodeproject\\doudizhu",
      parentID: "ses_root",
      agent: "designer",
    });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_sub", questions: [sampleQuestion] },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Second event so the cache (with all fields) is consulted
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_1", sessionID: "ses_sub" },
    });
    const text = send.mock.calls[1][0];
    expect(text).toContain('"Build game UI components"');
    expect(text).toContain("🤖 designer");
    expect(text).toContain("F:\\opencodeproject\\doudizhu");
  });

  test("root session (no parentID) does NOT get a 🤖 marker", async () => {
    const { n, client, send } = makeNotifier();
    client.getSession.mockResolvedValue({
      id: "ses_root",
      title: "fix-auth-bug",
      directory: "/repo",
    });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_root", questions: [sampleQuestion] },
    });
    await new Promise((r) => setTimeout(r, 5));
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_1", sessionID: "ses_root" },
    });
    const text = send.mock.calls[1][0];
    expect(text).toContain('"fix-auth-bug"');
    expect(text).not.toContain("🤖");
  });

  test("sub-agent with no agent name falls back to 'sub-agent'", async () => {
    const { n, client, send } = makeNotifier();
    client.getSession.mockResolvedValue({
      id: "ses_sub",
      title: "Anonymous sub",
      parentID: "ses_root",
    });

    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_sub", questions: [sampleQuestion] },
    });
    await new Promise((r) => setTimeout(r, 5));
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_1", sessionID: "ses_sub" },
    });
    const text = send.mock.calls[1][0];
    expect(text).toContain("🤖 sub-agent");
  });
});

// ─── pendingBySession storage for switch-time re-render ───

describe("SessionNotifier — pendingBySession (switch-time re-render)", () => {
  test("question.asked stores payload keyed by sessionID", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_abc", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    const pending = n.consumePendingForSession("ses_pending");
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("question");
    expect(pending?.requestID).toBe("que_abc");
    expect(pending?.question?.question).toBe(sampleQuestion.question);
  });

  test("permission.asked stores payload keyed by sessionID", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_xyz", sessionID: "ses_pending" },
    });
    const pending = n.consumePendingForSession("ses_pending");
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("permission");
    expect(pending?.requestID).toBe("per_xyz");
  });

  test("consumePendingForSession returns null when nothing pending", () => {
    const { n } = makeNotifier();
    expect(n.consumePendingForSession("ses_unknown")).toBeNull();
  });

  test("consume is destructive — second call returns null", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    expect(n.consumePendingForSession("ses_pending")).not.toBeNull();
    expect(n.consumePendingForSession("ses_pending")).toBeNull();
  });

  test("question.replied clears the stored payload", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    expect(n.consumePendingForSession("ses_pending")).not.toBeNull();
    // Simulate a question arriving again, then being replied to
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    await n.handleEvent({
      type: "question.replied",
      properties: { sessionID: "ses_pending", requestID: "que_1", answers: [["OAuth"]] },
    });
    expect(n.consumePendingForSession("ses_pending")).toBeNull();
  });

  test("question.rejected clears the stored payload", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    await n.handleEvent({
      type: "question.rejected",
      properties: { sessionID: "ses_pending", requestID: "que_1" },
    });
    expect(n.consumePendingForSession("ses_pending")).toBeNull();
  });

  test("permission.replied clears the stored payload", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "permission.asked",
      properties: { ...samplePermission, id: "per_1", sessionID: "ses_pending" },
    });
    await n.handleEvent({
      type: "permission.replied",
      properties: { sessionID: "ses_pending", requestID: "per_1", reply: "once" },
    });
    expect(n.consumePendingForSession("ses_pending")).toBeNull();
  });

  test("session going idle clears the stored payload (turn abandoned)", async () => {
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    // Mark the session as busy first (so the idle event is meaningful)
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_pending", status: { type: "busy" } },
    });
    await n.handleEvent({
      type: "session.status",
      properties: { sessionID: "ses_pending", status: { type: "idle" } },
    });
    expect(n.consumePendingForSession("ses_pending")).toBeNull();
  });

  test("setCurrentSessionId does NOT clear the entry — the bridge's maybeReSurfacePending is the only consumer", async () => {
    // Regression test for the bug where setCurrentSessionId
    // proactively deleted the entry from pendingBySession, which
    // prevented the bridge's switch-time re-render path from
    // finding it. The fix was to remove the proactive delete —
    // entries are now only cleared by:
    //   1. consumePendingForSession (explicit consume on switch)
    //   2. *.replied / *.rejected SSE echoes
    //   3. session.status = idle
    const { n } = makeNotifier();
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_now_current", questions: [sampleQuestion] },
    });
    // Simulate: a second event for the same session, then user switches to it
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_2", sessionID: "ses_now_current", questions: [sampleQuestion] },
    });
    n.setCurrentSessionId("ses_now_current");
    // Entry is STILL there — maybeReSurfacePending will consume it
    expect(n.consumePendingForSession("ses_now_current")).not.toBeNull();
  });

  test("question payload is stored even when notify kind is disabled (switch re-render still works)", async () => {
    const { n } = makeNotifier();
    n.setTypeEnabled("question", false);
    await n.handleEvent({
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    });
    // No notification was sent, but the payload is still stashed
    const pending = n.consumePendingForSession("ses_pending");
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("question");
  });

  test("storing payload does not affect dedupe (events are still deduped on send)", async () => {
    const { n, send } = makeNotifier();
    const event = {
      type: "question.asked",
      properties: { id: "que_1", sessionID: "ses_pending", questions: [sampleQuestion] },
    };
    await n.handleEvent(event);
    await n.handleEvent(event); // duplicate
    // First call sent a notification; second was deduped
    expect(send).toHaveBeenCalledTimes(1);
    // But consumePendingForSession works regardless (storage is
    // independent of the send path)
    const pending = n.consumePendingForSession("ses_pending");
    expect(pending).not.toBeNull();
  });
});
