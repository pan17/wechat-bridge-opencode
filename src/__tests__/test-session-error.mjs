/**
 * Unit tests for SessionManager.handleSessionError error stringification.
 *
 * Regression test for the bug where `String(event.properties.error)` on an
 * object error produced "[object Object]", hiding the real error from
 * users (e.g. the `/workspace switch` session.error case).
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ─── Mock the OpenCodeServerClient module ───
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
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
  clientMock.getBaseUrl.mockClear();
  clientMock.getAuthHeader.mockClear();
});

// ─── Helpers ───

/** Build a SessionManager with a capturing log function. */
function makeManager() {
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
  });
  m.sessionId = "ses_test";
  return { m, log };
}

/** Build a session.error event. */
function sessionError(err) {
  return {
    type: "session.error",
    properties: {
      sessionID: "ses_test",
      error: err,
    },
  };
}

// ─── Tests ───

describe("SessionManager.handleSessionError", () => {
  test("object error with .message: extracts message, not [object Object]", () => {
    const { m, log } = makeManager();
    m["handleSessionError"](
      sessionError({ message: "Session not found", code: 404 }),
    );
    // Find the log call that includes the error string
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("Session not found");
    expect(errorLog).not.toContain("[object Object]");
  });

  test("object error without .message: falls back to JSON.stringify", () => {
    const { m, log } = makeManager();
    m["handleSessionError"](
      sessionError({ code: 500, detail: "internal" }),
    );
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).not.toContain("[object Object]");
    expect(errorLog).toContain("code");
    expect(errorLog).toContain("500");
  });

  test("string error: passes through unchanged", () => {
    const { m, log } = makeManager();
    m["handleSessionError"](sessionError("Plain string error"));
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("Plain string error");
  });

  test("null error: logs 'unknown'", () => {
    const { m, log } = makeManager();
    m["handleSessionError"](sessionError(null));
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("unknown");
  });

  test("undefined error: logs 'unknown'", () => {
    const { m, log } = makeManager();
    m["handleSessionError"](sessionError(undefined));
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain("unknown");
  });

  test("object error with empty-string .message: uses empty message, not [object Object]", () => {
    // Edge case: when .message is empty string, ?? won't fall through (only
    // null/undefined trigger ??). The empty string is still preferred over
    // "[object Object]". This documents the current behavior.
    const { m, log } = makeManager();
    m["handleSessionError"](sessionError({ message: "" }));
    const errorLog = log.mock.calls
      .map((c) => c[0])
      .find((s) => typeof s === "string" && s.includes("session.error"));
    expect(errorLog).toBeDefined();
    expect(errorLog).not.toContain("[object Object]");
  });
});
