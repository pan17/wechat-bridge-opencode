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
  readStartupTimeoutMs,
} from "../../dist/bin/wechat-opencode.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS;
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

  // ─── Progress logging (npx-download hint) ───
  // These tests need a way to advance wall-clock time without actually
  // sleeping. The cleanest path is vi.useFakeTimers + vi.advanceTimersByTime
  // so the inner setTimeout(resolve, 1000) sleep inside the wait loop
  // resolves in microseconds rather than wall-clock seconds.
  test("T6: logs a progress message with npx hint after 20s of waiting", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return emptyResponse(503);
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    // 90s budget — long enough to fire at least 3 progress logs
    // (at 20s, 40s, 60s) before the deadline at 90s.
    const promise = waitForServerReady(SERVER_URL, undefined, 90_000, log);
    // Advance through the first progress log threshold.
    await vi.advanceTimersByTimeAsync(21_000);
    // Advance through the second and third thresholds.
    await vi.advanceTimersByTimeAsync(40_000);
    // Advance past the deadline.
    await vi.advanceTimersByTimeAsync(30_000);
    await promise;

    const calls = log.mock.calls.map((c) => c[0]).join("\n");
    // At least one progress log mentioning elapsed + remaining.
    expect(calls).toMatch(/Still waiting for server/);
    // The npx-download hint should be included in progress logs.
    expect(calls).toMatch(/npx/i);
    expect(calls).toMatch(/opencode-ai/);
    // Final warning still mentions the env var override path.
    expect(calls).toMatch(/Warning: server may not be ready yet/);
    expect(calls).toMatch(/WECHAT_OPENCODE_STARTUP_TIMEOUT_MS/);
  });

  test("T7: progress log does NOT fire if server comes up in <20s", async () => {
    // Real timers here — the function should resolve in <1s and never
    // hit the 20s progress-log threshold.
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return jsonResponse(200, { model: "anthropic/claude" });
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await waitForServerReady(SERVER_URL, undefined, 5_000, log);
    const calls = log.mock.calls.map((c) => c[0]).join("\n");
    // "Server is ready" fires, but no progress log.
    expect(calls).toMatch(/Server is ready/);
    expect(calls).not.toMatch(/Still waiting for server/);
  });

  test("T8: final warning message includes env var override hint", async () => {
    // Real timer with a tiny budget — server is broken, so we hit the
    // final warning quickly.
    const log = vi.fn();
    const fetchMock = makeMockFetch((u) => {
      if (u.pathname === "/global/health") return jsonResponse(200, { ok: true });
      if (u.pathname === "/config") return emptyResponse(503);
      return emptyResponse(404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await waitForServerReady(SERVER_URL, undefined, 250, log);
    const calls = log.mock.calls.map((c) => c[0]).join("\n");
    expect(calls).toMatch(/Warning: server may not be ready yet/);
    expect(calls).toMatch(/first-time npx download/);
    expect(calls).toMatch(/WECHAT_OPENCODE_STARTUP_TIMEOUT_MS=600000/);
  });
});

// ─── readStartupTimeoutMs ───

describe("readStartupTimeoutMs", () => {
  test("returns 180000 (3 min) when env var is unset", () => {
    delete process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS;
    expect(readStartupTimeoutMs()).toBe(180_000);
  });

  test("returns the env var value when set to a valid positive integer", () => {
    process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS = "300000";
    expect(readStartupTimeoutMs()).toBe(300_000);
  });

  test("returns 0 when env var is set to '0' (immediate-fail path)", () => {
    process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS = "0";
    expect(readStartupTimeoutMs()).toBe(0);
  });

  test("falls back to default and warns when env var is non-numeric", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS = "forever";
    expect(readStartupTimeoutMs()).toBe(180_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid WECHAT_OPENCODE_STARTUP_TIMEOUT_MS=forever/),
    );
  });

  test("falls back to default and warns when env var is negative", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.WECHAT_OPENCODE_STARTUP_TIMEOUT_MS = "-1";
    expect(readStartupTimeoutMs()).toBe(180_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Invalid WECHAT_OPENCODE_STARTUP_TIMEOUT_MS=-1/),
    );
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
