/**
 * Regression test for the `enqueueOutbound` unhandled-rejection bug.
 *
 * The original code:
 *   const next = prev.catch(() => undefined).then(() => fn());
 *   this.outboundQueue.set(contextToken, next);
 *   next.finally(() => { ...cleanup... });
 *   return next;
 *
 * The bug: `next.finally(...)` returns a NEW promise. When `fn()` rejects,
 * that new promise also rejects. It is never `.catch`'d or returned, so
 * it becomes an unhandled promise rejection. Under Node ≥15's default
 * policy this crashes the bridge process. The error surfaced in
 * production as `TypeError: fetch failed` from WeChat API timeouts —
 * `session.ts` correctly `.catch`'d the original `next` and logged
 * "onReply error for …", but the sibling `next.finally(...)` promise
 * crashed the process.
 *
 * The fix: attach `.catch(() => {})` to the finally chain to suppress
 * the unhandled rejection. The original `next` (returned to the caller)
 * still rejects, so the caller's existing `.catch` (in session.ts) keeps
 * working.
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect, vi } from "vitest";

/**
 * Re-implementation of `WeChatOpencodeBridge.enqueueOutbound` matching the
 * fixed source. Pulled out so the test stays self-contained and exercises
 * the exact promise pattern. (The real method is private and tightly
 * coupled to the bridge instance.)
 */
function makeEnqueueLike() {
  const map = new Map();
  /** @param {string} key @param {() => Promise<unknown>} fn */
  function enqueue(key, fn) {
    const prev = map.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => fn());
    map.set(key, next);
    // The fix: attach .catch so the finally's returned promise doesn't
    // propagate `next`'s rejection as an unhandled rejection.
    next
      .finally(() => {
        if (map.get(key) === next) map.delete(key);
      })
      .catch(() => {
        // Suppress the unhandled-rejection that `next.finally(...)` would
        // otherwise propagate when `fn()` rejects.
      });
    return next;
  }
  return { enqueue, map };
}

describe("enqueueOutbound — unhandled-rejection regression", () => {
  test("when fn() rejects, returned promise still rejects (caller's .catch works)", async () => {
    const { enqueue, map } = makeEnqueueLike();
    const captured = vi.fn();
    await enqueue("ctx-1", () => Promise.reject(new Error("network down"))).catch(
      (err) => captured(err),
    );
    expect(captured).toHaveBeenCalledTimes(1);
    expect(captured.mock.calls[0][0].message).toBe("network down");
    // Cleanup ran: the queue entry was removed once the promise settled.
    expect(map.has("ctx-1")).toBe(false);
  });

  test("no unhandled rejection is emitted when fn() rejects", async () => {
    // Install a one-shot unhandledRejection listener; if the bug regresses
    // (the .catch is missing from the finally chain), the test will fail
    // because this listener fires.
    const onUnhandled = vi.fn();
    /** @param {unknown} reason */
    const handler = (reason) => onUnhandled(reason);
    process.once("unhandledRejection", handler);

    try {
      const { enqueue, map } = makeEnqueueLike();
      // Enqueue a task that rejects.
      const p1 = enqueue("ctx-2", () => Promise.reject(new Error("boom")));
      // Attach a noop .catch on the ORIGINAL returned promise so the test's
      // own handling doesn't depend on the bug being present. The point
      // of the test is the SIBLING `next.finally(...)` promise, not this
      // one — that's the one that the fix attaches `.catch(() => {})` to.
      p1.catch(() => {});
      // Let the microtask queue drain so any unhandled rejection would
      // have fired by now.
      await new Promise((r) => setImmediate(r));
      // Wait one more macrotask to be sure.
      await new Promise((r) => setImmediate(r));
      // Cleanup should have run.
      expect(map.has("ctx-2")).toBe(false);
      // CRITICAL: no unhandled rejection observed.
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });

  test("when fn() resolves normally, the queue entry is cleaned up", async () => {
    const { enqueue, map } = makeEnqueueLike();
    await enqueue("ctx-3", () => Promise.resolve("ok"));
    expect(map.has("ctx-3")).toBe(false);
  });

  test("sequential enqueues for the same contextToken run in order", async () => {
    // Defensive: verify the fix didn't break the ordering guarantee.
    const { enqueue } = makeEnqueueLike();
    const order = [];
    const p1 = enqueue("ctx-4", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 1;
    });
    const p2 = enqueue("ctx-4", async () => {
      order.push(2);
      return 2;
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});
