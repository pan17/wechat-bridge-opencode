/**
 * Unit tests for `waitForServerReady` and `buildServerAuthHeader` exported
 * from `bin/wechat-opencode.ts`.
 *
 * Covers the spec:
 *   - T1: returns when /config returns 200 on the first probe
 *   - T2: returns when /config returns 200 on the Nth probe (transient 5xx)
 *   - T3: does NOT throw on 401 — returns early after logging
 *   - T4: exits after `timeoutMs` even if /config never returns 200
 *   - T5: sends the correct auth header (Bearer / Basic / none)
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import {
  waitForServerReady,
  buildServerAuthHeader,
} from "../../dist/bin/wechat-opencode.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Helpers ───

const SERVER_URL = "http://localhost:4096";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status) {
  return new Response(null, { status });
}

/** Build a mock fetch that replies based on URL path. */
function makeMockFetch(responder) {
  return vi.fn(async (url, init) => {
    const u = new URL(url);
    return responder(u, init);
  });
}

// ─── waitForServerReady ───

describe("waitForServerReady", () => {
  test("T1: returns on first /config 200", async () => {
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return jsonResponse(200, { model: "anthropic/claude" });
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForServerReady(SERVER_URL, undefined, 5_000, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Server is ready");
    // /global/health + /config — both hit once.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("T2: returns on Nth /config 200 after transient 5xx", async () => {
    const log = vi.fn();
    let configCalls = 0;
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") {
        configCalls++;
        // First two /config calls return 503, third returns 200.
        if (configCalls < 3) return emptyResponse(503);
        return jsonResponse(200, { model: "anthropic/claude" });
      }
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForServerReady(SERVER_URL, undefined, 10_000, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Server is ready");
    // /global/health (once) + /config (3 times).
    expect(configCalls).toBe(3);
  });

  test("T3: returns early on /config 401 (config error, not a race)", async () => {
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return emptyResponse(401);
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    await expect(
      waitForServerReady(SERVER_URL, "Bearer xxx", 5_000, log),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    // Resolves quickly (well under the 5s budget) — does NOT poll
    // the full timeout window for a config error.
    expect(elapsed).toBeLessThan(2_000);
    // Logged the explicit auth-mismatch message.
    const logged = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toMatch(/401/);
    expect(logged).toMatch(/auth mismatch or forbidden/);
  });

  test("T3b: returns early on /config 403 (same path as 401)", async () => {
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return emptyResponse(403);
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    await expect(
      waitForServerReady(SERVER_URL, undefined, 5_000, log),
    ).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2_000);
    const logged = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toMatch(/403/);
  });

  test("T4: exits after timeoutMs even if /config never returns 200", async () => {
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return emptyResponse(503);
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = Date.now();
    await expect(
      waitForServerReady(SERVER_URL, undefined, 250, log),
    ).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    // Resolves close to the timeout (with 1s poll cadence and 250ms
    // budget, the inner sleep is skipped at the deadline check — so
    // the function returns on the next iteration boundary).
    expect(elapsed).toBeLessThan(2_000);
    const logged = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toMatch(/Warning: server may not be ready yet/);
  });

  test("T4b: survives connection refused on /global/health (server not yet listening)", async () => {
    const log = vi.fn();
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount > 3) return jsonResponse(200, { ok: true });
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForServerReady(SERVER_URL, undefined, 5_000, log),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("Server is ready");
  });

  test("T5a: sends Authorization: Bearer <token> when authHeader provided", async () => {
    const log = vi.fn();
    let capturedInit;
    const fetchMock = makeMockFetch((u, init) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") {
        capturedInit = init;
        return jsonResponse(200, {});
      }
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await waitForServerReady(SERVER_URL, "Bearer xxx", 5_000, log);
    expect(capturedInit).toBeDefined();
    expect(capturedInit.headers).toBeDefined();
    expect(capturedInit.headers["Authorization"]).toBe("Bearer xxx");
  });

  test("T5b: sends Authorization: Basic <b64> when Basic authHeader provided", async () => {
    const log = vi.fn();
    let capturedInit;
    const fetchMock = makeMockFetch((u, init) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") {
        capturedInit = init;
        return jsonResponse(200, {});
      }
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const basic = `Basic ${btoa("user:pass")}`;
    await waitForServerReady(SERVER_URL, basic, 5_000, log);
    expect(capturedInit.headers["Authorization"]).toBe(basic);
  });

  test("T5c: omits Authorization header when authHeader is undefined", async () => {
    const log = vi.fn();
    let capturedInit;
    const fetchMock = makeMockFetch((u, init) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") {
        capturedInit = init;
        return jsonResponse(200, {});
      }
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await waitForServerReady(SERVER_URL, undefined, 5_000, log);
    expect(capturedInit).toBeDefined();
    // No Authorization header added by the probe when the server has
    // no auth configured.
    const auth = capturedInit.headers?.["Authorization"] ?? capturedInit.headers?.["authorization"];
    expect(auth).toBeUndefined();
  });
});

// ─── buildServerAuthHeader ───

describe("buildServerAuthHeader", () => {
  test("returns Bearer <token> when token is set", () => {
    expect(buildServerAuthHeader({ token: "abc" })).toBe("Bearer abc");
  });

  test("Bearer takes precedence over Basic when both are set", () => {
    expect(
      buildServerAuthHeader({
        token: "abc",
        username: "u",
        password: "p",
      }),
    ).toBe("Bearer abc");
  });

  test("returns Basic <b64> when only username+password are set", () => {
    const out = buildServerAuthHeader({ username: "user", password: "pass" });
    expect(out).toBe(`Basic ${btoa("user:pass")}`);
  });

  test("returns undefined when only username is set (half-configured Basic)", () => {
    expect(buildServerAuthHeader({ username: "u" })).toBeUndefined();
  });

  test("returns undefined when only password is set (half-configured Basic)", () => {
    expect(buildServerAuthHeader({ password: "p" })).toBeUndefined();
  });

  test("returns undefined when no auth fields are set", () => {
    expect(buildServerAuthHeader({})).toBeUndefined();
  });
});
