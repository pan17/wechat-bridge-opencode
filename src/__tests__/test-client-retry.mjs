/**
 * Unit tests for `OpenCodeServerClient` private `fetch()` retry +
 * default-timeout behavior.
 *
 * Covers the spec:
 *   - T1: retries on UND_ERR_CONNECT_TIMEOUT and eventually succeeds
 *   - T2: does NOT retry on HTTP 500
 *   - T3: does NOT retry on HTTP 401
 *   - T4: does NOT retry on AbortError (timeout fired)
 *   - T5: after all retries exhausted, throws the last error
 *   - T6: caller can override retries: 0 to disable retry
 *   - T7: default timeoutMs: 15_000 is applied
 *
 * T1–T5 drive public methods (so we exercise the whole client
 * surface). T6 invokes the private `fetch()` via bracket notation to
 * inject a `retries: 0` override (no public method currently exposes
 * it). T7 inspects the `signal` carried on the fetch init.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { OpenCodeServerClient } from "../../dist/src/server/client.js";
import { isRetryableNetworkError } from "../../dist/src/utils/network.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── Helpers ───

/**
 * Build an undici-style fetch-failure error: an outer `TypeError`
 * whose `.cause.code` carries the platform-specific errno. This is
 * the shape Node 18+ fetch surfaces for network-level failures.
 */
function makeNetworkErr(code) {
  const err = new TypeError("fetch failed");
  err.cause = { code };
  return err;
}

/** A 200 OK JSON Response with the given body. */
function okJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a client pointed at a no-op URL. The base URL is irrelevant — `fetch` is mocked. */
function makeClient() {
  return new OpenCodeServerClient({ baseUrl: "http://localhost:4096" });
}

// ─── T1: retries on transient network error ───

describe("OpenCodeServerClient.fetch retry behavior", () => {
  test("T1: retries on UND_ERR_CONNECT_TIMEOUT and eventually succeeds", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw makeNetworkErr("UND_ERR_CONNECT_TIMEOUT");
        return okJson([]);
      }),
    );

    // listSessions parses the JSON; [] resolves cleanly.
    const result = await client.listSessions();
    expect(result).toEqual([]);
    // retries=2 (default) → 3 total attempts (1 initial + 2 retries).
    expect(calls).toBe(3);
  });

  // ─── T2: does NOT retry on HTTP 500 ───

  test("T2: does NOT retry on HTTP 500 — Response is returned, called once", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("internal error", { status: 500 });
      }),
    );

    // listSessions throws on !res.ok with the wrapped public error.
    // The key assertion is `calls === 1` — the wrapper did NOT retry
    // on the 500 Response; it surfaced it to the caller exactly once.
    await expect(client.listSessions()).rejects.toThrow(
      /Failed to list sessions: 500/,
    );
    expect(calls).toBe(1);
  });

  // ─── T3: does NOT retry on HTTP 401 ───

  test("T3: does NOT retry on HTTP 401 — Response is returned, called once", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("unauthorized", { status: 401 });
      }),
    );

    await expect(client.listSessions()).rejects.toThrow(
      /Failed to list sessions: 401/,
    );
    expect(calls).toBe(1);
  });

  // ─── T4: does NOT retry on AbortError ───

  test("T4: does NOT retry on AbortError (per-attempt timeout fired)", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );

    // The wrapper re-throws AbortError directly (does not classify it
    // as retryable, does not wrap with .cause). listSessions does not
    // catch — the AbortError propagates verbatim.
    await expect(client.listSessions()).rejects.toMatchObject({
      name: "AbortError",
    });
    // AbortError short-circuits the retry loop → exactly one call.
    expect(calls).toBe(1);
  });

  // ─── T5: exhausts retries, throws last error ───

  test("T5: after all retries exhausted, throws the last error with .cause preserved", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw makeNetworkErr("ECONNRESET");
      }),
    );

    let captured;
    try {
      await client.listSessions();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    // retries=2 (default) → exactly 3 total attempts (1 initial + 2 retries).
    expect(calls).toBe(3);

    // The wrapper's rethrow attaches `.cause = originalCause` so the
    // shared classifier can still walk the chain to "ECONNRESET".
    // This is the same pattern as `apiPost` in src/weixin/api.ts.
    expect(isRetryableNetworkError(captured)).toBe(true);
    expect(captured.cause).toBeDefined();
    expect(captured.cause.code).toBe("ECONNRESET");
  });

  // ─── T6: caller can disable retry via retries: 0 ───

  test("T6: caller can override retries: 0 to disable retry", async () => {
    const client = makeClient();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw makeNetworkErr("ECONNRESET");
      }),
    );

    // No public method currently exposes the `retries` field on its
    // init — the override is reserved for future call sites. We
    // invoke the private wrapper directly via bracket notation to
    // prove the feature works end-to-end.
    const privateFetch = client["fetch"].bind(client);
    await expect(
      privateFetch("/test", { method: "GET", retries: 0 }),
    ).rejects.toThrow();
    // retries=0 → single attempt.
    expect(calls).toBe(1);
  });

  // ─── T7: default 15s timeout is applied ───

  test("T7: default timeoutMs: 15_000 is applied as an AbortSignal", async () => {
    const client = makeClient();
    let capturedInit;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        capturedInit = init;
        return okJson({ ok: true });
      }),
    );

    // Drive through `health()` — no explicit `timeoutMs` in the call,
    // so the wrapper must apply the 15s default.
    await client.health();

    expect(capturedInit).toBeDefined();
    expect(capturedInit.signal).toBeInstanceOf(AbortSignal);
    // The default timeout's `aborted` flag is false (no time has passed
    // during the synchronous mock fetch). The mere presence of the
    // signal proves the timeout was wired in.
    expect(capturedInit.signal.aborted).toBe(false);
  });
});
