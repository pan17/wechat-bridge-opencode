/**
 * Unit tests for SessionManager.switchWorkspace.
 *
 * Covers:
 *   - Resume: when `/workspace switch <path>` is called and a recent root
 *     session exists in that workspace, the bridge should resume it
 *     (preserving context, model, agent) instead of creating a new session.
 *   - New session: when no recent session exists, a new one is created and
 *     stale `currentMode` / `currentModelId` / `currentReasoning` from the
 *     previous workspace are cleared so the next prompt doesn't carry
 *     values that the new workspace doesn't recognize (regression for
 *     `session.error: Agent not found: "<old-agent>"`).
 *   - Existing session id: explicit `existingSessionId` is still honored.
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

  // Default: no sessions on the server, empty agents/providers, no model
  // override. Tests that exercise the resume path override listSessionsV2
  // and getSessionMessages directly.
  clientMock.listSessionsV2.mockResolvedValue([]);
  clientMock.listAgents.mockResolvedValue([]);
  clientMock.listProviders.mockResolvedValue([]);
  clientMock.getConfig.mockResolvedValue({});
  clientMock.getSessionMessages.mockResolvedValue([]);
  clientMock.createSession.mockResolvedValue({
    id: "ses_new_from_switch",
    title: "",
  });
  // getSession defaults to "session exists" — tests that exercise the
  // "session deleted between list and use" path override this.
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

/** Mark a session as existing on the server for getSession() lookups. */
function sessionExists(id) {
  clientMock.getSession.mockImplementation(async (sid) => {
    if (sid === id) return { id: sid, title: "" };
    throw new Error(`not found: ${sid}`);
  });
}

// ─── Tests: no prior state, create new ───

describe("SessionManager.switchWorkspace — create new (no prior session in cwd)", () => {
  test("creates a new session and clears stale state", async () => {
    const m = makeManager();
    m.currentMode = "some-stale-agent";
    m.currentModelId = "opencode-go/claude-opus-4-7";
    m.currentReasoning = "high";

    await m.switchWorkspace("/new/workspace", undefined);

    expect(clientMock.createSession).toHaveBeenCalledWith(
      undefined, undefined, "/new/workspace",
    );
    expect(m.sessionId).toBe("ses_new_from_switch");
    expect(m.cwd).toBe("/new/workspace");
    // The fix: stale state from the old workspace is cleared so the next
    // prompt doesn't fail with "Agent not found: some-stale-agent".
    expect(m.currentMode).toBeUndefined();
    expect(m.currentModelId).toBeUndefined();
    expect(m.currentReasoning).toBeUndefined();
  });

  test("with no stale state: stays undefined, no spurious defaults", async () => {
    const m = makeManager();
    await m.switchWorkspace("/new/workspace", undefined);
    expect(m.sessionId).toBe("ses_new_from_switch");
    expect(m.currentMode).toBeUndefined();
    expect(m.currentModelId).toBeUndefined();
    expect(m.currentReasoning).toBeUndefined();
  });
});

// ─── Tests: resume most recent session ───

describe("SessionManager.switchWorkspace — resume most recent session in cwd", () => {
  test("resumes the most recent root session in the target workspace", async () => {
    // Server has two sessions in /target/workspace and one in /other/.
    // The bridge should pick the most-recently-updated one in /target/.
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_other", directory: "/other/workspace", updatedAt: 5000, parentID: null },
      { id: "ses_target_old", directory: "/target/workspace", updatedAt: 3000, parentID: null },
      { id: "ses_target_new", directory: "/target/workspace", updatedAt: 9000, parentID: null },
    ]);
    sessionExists("ses_target_new");

    const m = makeManager();
    await m.switchWorkspace("/target/workspace", undefined);

    // Resumed, not created
    expect(m.sessionId).toBe("ses_target_new");
    expect(m.cwd).toBe("/target/workspace");
    expect(clientMock.createSession).not.toHaveBeenCalled();
    // getSession was called to verify the resumed session
    expect(clientMock.getSession).toHaveBeenCalledWith("ses_target_new");
  });

  test("resumed session: state is synced from the session's last message, NOT cleared", async () => {
    // The resumed session's last message carries its own agent/model/variant.
    // syncStateFromServer should overwrite the stale values, so we do NOT
    // want them to be cleared before sync runs.
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_target", directory: "/target/workspace", updatedAt: 9000, parentID: null },
    ]);
    sessionExists("ses_target");
    clientMock.getSessionMessages.mockResolvedValue([
      {
        info: {
          role: "assistant",
          mode: "build",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          variant: "low",
        },
      },
    ]);

    const m = makeManager();
    // Stale values from the OLD workspace
    m.currentMode = "some-stale-agent";
    m.currentModelId = "opencode-go/claude-opus-4-7";
    m.currentReasoning = "high";

    await m.switchWorkspace("/target/workspace", undefined);

    // After resume, state reflects the resumed session, not the stale values.
    expect(m.currentMode).toBe("build");
    expect(m.currentModelId).toBe("anthropic/claude-sonnet-4-5");
    expect(m.currentReasoning).toBe("low");
  });

  test("falls back to create new when the resumed session disappears between list and use", async () => {
    // listSessionsV2 returns ses_stale, but by the time we call getSession
    // the server no longer has it. We should fall through to createSession.
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_stale", directory: "/target/workspace", updatedAt: 9000, parentID: null },
    ]);
    clientMock.getSession.mockImplementation(async (sid) => {
      throw new Error(`not found: ${sid}`);
    });

    const m = makeManager();
    await m.switchWorkspace("/target/workspace", undefined);

    expect(clientMock.createSession).toHaveBeenCalledWith(
      undefined, undefined, "/target/workspace",
    );
    expect(m.sessionId).toBe("ses_new_from_switch");
  });

  test("falls back to create new when no sessions exist in the target workspace", async () => {
    // Server has sessions, but none for the target cwd
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_other", directory: "/other/workspace", updatedAt: 9000, parentID: null },
    ]);

    const m = makeManager();
    m.currentMode = "some-stale-agent";

    await m.switchWorkspace("/target/workspace", undefined);

    // No recent match → create new + clear stale state
    expect(clientMock.createSession).toHaveBeenCalled();
    expect(m.sessionId).toBe("ses_new_from_switch");
    expect(m.currentMode).toBeUndefined();
  });

  test("falls back to create new when listSessionsV2 fails", async () => {
    clientMock.listSessionsV2.mockRejectedValue(new Error("server down"));

    const m = makeManager();
    await m.switchWorkspace("/target/workspace", undefined);

    // Robust against list failure: still ends up with a usable session
    expect(clientMock.createSession).toHaveBeenCalled();
    expect(m.sessionId).toBe("ses_new_from_switch");
  });

  test("sub-sessions (parentID set) are not considered for resume", async () => {
    // Sub-sessions (parentID set) are internal to the agent and should be
    // ignored. listServerSessions filters them out before matching cwd.
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_sub", directory: "/target/workspace", updatedAt: 9000, parentID: "ses_root" },
    ]);

    const m = makeManager();
    await m.switchWorkspace("/target/workspace", undefined);

    // Sub-session is ignored → create new
    expect(clientMock.createSession).toHaveBeenCalled();
    expect(m.sessionId).toBe("ses_new_from_switch");
  });
});

// ─── Tests: explicit existingSessionId ───

describe("SessionManager.switchWorkspace — explicit existingSessionId", () => {
  test("uses the provided session id when it exists", async () => {
    sessionExists("ses_explicit");
    const m = makeManager();
    await m.switchWorkspace("/new/workspace", "ses_explicit");

    expect(m.sessionId).toBe("ses_explicit");
    expect(m.cwd).toBe("/new/workspace");
    expect(clientMock.createSession).not.toHaveBeenCalled();
  });

  test("falls back to create new when the provided session id is unknown", async () => {
    clientMock.getSession.mockImplementation(async (sid) => {
      throw new Error(`not found: ${sid}`);
    });
    const m = makeManager();
    await m.switchWorkspace("/new/workspace", "ses_missing");

    expect(clientMock.createSession).toHaveBeenCalled();
    expect(m.sessionId).toBe("ses_new_from_switch");
  });

  test("explicit existingSessionId takes priority over resume lookup", async () => {
    // Both a resumable session and an explicit id exist — the explicit one wins.
    clientMock.listSessionsV2.mockResolvedValue([
      { id: "ses_resumable", directory: "/new/workspace", updatedAt: 9000, parentID: null },
    ]);
    sessionExists("ses_explicit");
    const m = makeManager();
    await m.switchWorkspace("/new/workspace", "ses_explicit");

    expect(m.sessionId).toBe("ses_explicit");
  });
});
