/**
 * Unit tests for `apiPost` retry behavior in `src/weixin/api.ts`.
 *
 * Covers the spec requirements:
 *   - Test 1: retries on transient network errors (UND_ERR_CONNECT_TIMEOUT)
 *   - Test 2: does NOT retry on HTTP 4xx
 *   - Test 3: does NOT retry on AbortError (returns `{ ret: 0, msgs: [] }` sentinel)
 *   - Test 4: re-throws with the last error after exhausting all retries
 *   - Plus: `isRetryableNetworkError` walks the cause chain correctly
 *
 * The retry tests drive the public `sendMessage` / `getConfig` exports
 * and mock `globalThis.fetch` so no real network call is attempted.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi, afterEach } from "vitest";

import {
  sendMessage,
  getConfig,
  isRetryableNetworkError,
} from "../../dist/src/weixin/api.js";

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

// ─── isRetryableNetworkError classifier ───

describe("isRetryableNetworkError (cause-chain classifier)", () => {
  test("top-level cause with UND_ERR_CONNECT_TIMEOUT → true", () => {
    expect(
      isRetryableNetworkError({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    ).toBe(true);
  });

  test("nested cause with ECONNRESET → true", () => {
    expect(
      isRetryableNetworkError({ cause: { cause: { code: "ECONNRESET" } } }),
    ).toBe(true);
  });

  test("unknown code → false", () => {
    expect(isRetryableNetworkError({ code: "SOME_OTHER" })).toBe(false);
  });

  test("null → false", () => {
    expect(isRetryableNetworkError(null)).toBe(false);
  });

  test("undefined → false", () => {
    expect(isRetryableNetworkError(undefined)).toBe(false);
  });

  test("plain Error('HTTP 500: ...') with no cause → false", () => {
    expect(isRetryableNetworkError(new Error("HTTP 500: ..."))).toBe(false);
  });

  test("Error with name 'AbortError' → false", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isRetryableNetworkError(err)).toBe(false);
  });

  test("deeply nested ECONNREFUSED (3 levels) → true", () => {
    expect(
      isRetryableNetworkError({
        cause: { cause: { cause: { code: "ECONNREFUSED" } } },
      }),
    ).toBe(true);
  });

  test("cycle in cause chain does not infinite-loop → false", () => {
    const a = {};
    const b = {};
    a.cause = b;
    b.cause = a;
    // No matching code anywhere; the seen-set must bail out.
    expect(isRetryableNetworkError(a)).toBe(false);
  });
});

// ─── apiPost retry behavior (driven through sendMessage / getConfig) ───

describe("apiPost retry behavior", () => {
  test("retries on UND_ERR_CONNECT_TIMEOUT and eventually succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw makeNetworkErr("UND_ERR_CONNECT_TIMEOUT");
        return okJson({ ret: 0 });
      }),
    );

    // sendMessage returns void; if it resolves, retry-then-success worked.
    await expect(
      sendMessage({
        baseUrl: "https://ilinkai.weixin.qq.com",
        body: { msg: { to_user_id: "u1" } },
        retries: 2,
      }),
    ).resolves.toBeUndefined();
    // retries=2 → 3 total attempts (initial + 2 retries).
    expect(calls).toBe(3);
  });

  test("does NOT retry on HTTP 4xx — throws immediately", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }),
    );

    await expect(
      sendMessage({
        baseUrl: "https://ilinkai.weixin.qq.com",
        body: { msg: { to_user_id: "u1" } },
        // High retries value so a regression (retrying on 4xx) would
        // be obvious in the call count.
        retries: 5,
      }),
    ).rejects.toThrow(/HTTP 400/);
    // Exactly ONE call — no retry on 4xx.
    expect(calls).toBe(1);
  });

  test("does NOT retry on AbortError — returns long-poll sentinel", async () => {
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

    // Drive through `getConfig` (not `sendMessage`) because
    // `sendMessage` discards the apiPost return value; getConfig
    // returns the typed response and lets us assert the sentinel.
    const result = await getConfig({
      baseUrl: "https://ilinkai.weixin.qq.com",
      ilinkUserId: "u1",
    });
    expect(result).toEqual({ ret: 0, msgs: [] });
    // AbortError short-circuits the retry loop → exactly one call.
    expect(calls).toBe(1);
  });

  test("re-throws with the last error after exhausting all retries", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        throw makeNetworkErr("UND_ERR_CONNECT_TIMEOUT");
      }),
    );

    await expect(
      sendMessage({
        baseUrl: "https://ilinkai.weixin.qq.com",
        body: { msg: { to_user_id: "u1" } },
        retries: 2,
      }),
    ).rejects.toThrow();
    // retries=2 → exactly 3 total attempts (1 initial + 2 retries).
    expect(calls).toBe(3);
  });

  test("the re-thrown error preserves the cause chain (classifier can still walk it)", async () => {
    // Regression guard: the cause-unwrapping rethrow MUST attach
    // `.cause = originalCause` so downstream log inspection /
    // future classifiers can still see the underlying errno. A naive
    // `throw new Error('fetch failed: ECONNRESET')` that drops the
    // cause would lose this.
    //
    // We don't assert the human-readable message contains "ECONNRESET"
    // because the pre-retry behavior intentionally stringifies the
    // cause with `String(cause)` (yields "[object Object]") — that
    // matches the original code path. The important contract is that
    // the `.cause` property still carries the original cause object.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw makeNetworkErr("ECONNRESET");
      }),
    );

    let captured;
    try {
      await sendMessage({
        baseUrl: "https://ilinkai.weixin.qq.com",
        body: { msg: { to_user_id: "u1" } },
        retries: 0,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(isRetryableNetworkError(captured)).toBe(true);
    // The original fetch-failed TypeError had `.cause = { code: 'ECONNRESET' }`.
    // After unwrap, `.cause` must still be that object.
    expect(captured.cause).toBeDefined();
    expect(captured.cause.code).toBe("ECONNRESET");
  });

  test("non-retryable error (no .cause.code match) does not retry", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        // Plain Error with no cause at all — not a transient network error.
        throw new Error("unexpected fetch mode");
      }),
    );

    await expect(
      sendMessage({
        baseUrl: "https://ilinkai.weixin.qq.com",
        body: { msg: { to_user_id: "u1" } },
        retries: 3,
      }),
    ).rejects.toThrow(/unexpected fetch mode/);
    // Exactly ONE call — non-retryable errors fail fast.
    expect(calls).toBe(1);
  });
});
