/**
 * Shared network-error utilities.
 *
 * Centralises the transient-network-error classifier used by every
 * HTTP call in the bridge. Lives in `utils/` so the WeChat iLink
 * client (`src/weixin/api.ts`) and the OpenCode Server client
 * (`src/server/client.ts`) share the exact same retry policy — no
 * drift, no duplicated cause-chain walker.
 */

/**
 * Transient-network-error codes we retry on. The classifier walks the
 * cause chain looking for any of these — undici-style names
 * (`UND_ERR_*`) and Node `errno`-style codes both appear depending on
 * the platform / Node version. Sourced from undici's `errors` module
 * and Node's `libuv` error table.
 */
export const RETRYABLE_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  // undici (Node fetch's default backend in Node 18+)
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // Node libuv errno-style codes
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/**
 * Walk the cause chain looking for any `code` matching a known transient
 * network-failure code. Returns false for `AbortError` (the per-attempt
 * timeout sentinel — the call is too slow to recover from), for plain
 * non-Error values, and for any error without a recognised code in its
 * chain.
 */
export function isRetryableNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const obj = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (obj.name === "AbortError") return false;
    if (typeof obj.code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(obj.code)) {
      return true;
    }
    current = obj.cause;
  }
  return false;
}
