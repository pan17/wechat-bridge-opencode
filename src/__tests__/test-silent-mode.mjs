// src/__tests__/test-silent-mode.mjs
//
// Verifies silent / immersive mode behavior at the SessionManager layer:
//
//   1. Default + getter / setter on the SessionManager.
//      - `getImmersiveMode()` defaults to `false` on a fresh manager.
//      - `setImmersiveMode(true|false)` mutates the live flag.
//      - `setImmersiveMode(undefined)` is a no-op (does not clear the
//        current value) — mirrors the partial-update safety of
//        `setShowFlags`.
//
//   2. `beginTurn` snapshot semantics.
//      - The live `immersiveMode` is snapshotted into
//        `currentTurn.immersiveSnapshot` at turn-start.
//      - Mid-turn `setImmersiveMode` does NOT mutate the in-flight
//        snapshot (matches the showThoughts / showTools contract).
//      - `immersiveLastText` starts as `""` so the immersive fallback
//        path in `finalizeTurn` has a clean slate.
//
//   3. `flushCurrentPart` — reasoning gate.
//      - When `immersiveSnapshot === true` and a reasoning part is being
//        flushed, `onReply` is NOT called and `sentReasoningPartIds`
//        does not get the partID.
//      - When `immersiveSnapshot === false` (sanity), `onReply` IS
//        called for the same setup.
//
//   4. `flushCurrentPart` — text gate (the "last text only" rule).
//      - With immersive mode on, multiple text parts are silently
//        accumulated into `turn.immersiveLastText`; the LAST part wins
//        (overwrite, not concatenation).
//      - `onReply` is NOT called for any of the individual text parts.
//      - `sentTextPartIds` stays empty (so `anyTextSent === false` at
//        finalize-time).
//      - At finalize, `finalizeTurn("finalized")` calls `onReply` exactly
//        once with the last text part.
//
//   5. `flushCurrentPart` — text non-immersive (sanity).
//      - When immersive is off, text parts flush normally: `onReply`
//        called once, `sentTextPartIds` gets the partID, and
//        `immersiveLastText` stays at its initial `""`.
//
//   6. `maybeFlushToolSummary` gate.
//      - With `immersiveSnapshot === true` and a populated `toolCalls`
//        map, the gate at `session.ts:3211` short-circuits before any
//        `onReply` call. Mirror sanity check that with
//        `immersiveSnapshot === false` the same setup DOES emit.
//
//   7. `finalizeTurn` fallback — immersive.
//      - When no text part was sent during the turn and the user is in
//        immersive mode, `finalizeTurn` should deliver the deferred
//        `immersiveLastText` as a single fallback reply.
//
//   8. `finalizeTurn` fallback — error path still works in immersive.
//      - When `finalizeTurn("error", "something broke")` is invoked
//        with an `overrideText`, the override takes priority over
//        `immersiveLastText` — so a session error still surfaces even
//        when the user has immersive mode on.
//
// Imports compiled SessionManager from `dist/src/server/session.js`
// (rootDir is "." in tsconfig, so emits under `dist/src/...`).
//
// Runtime-only test — `private` is TS-only, so accessing fields via
// bracket notation works at runtime. We use bracket notation to avoid
// sprinkling "as any" casts in the test.

import { describe, test, expect } from "vitest";
import { SessionManager } from "../../dist/src/server/session.js";

function makeSm() {
  // SessionManager ctor wires an OpenCodeServerClient but never makes a
  // network call until ensureSession/etc. We never invoke those here.
  return new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async () => {},
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
}

function makeSmWithCapturedReply() {
  const calls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { calls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  return { sm, calls };
}

// ─── Group 1: Default + getter / setter ──────────────────────────────

describe("immersiveMode — default + getter/setter", () => {
  test("defaults to false on a fresh SessionManager", () => {
    const sm = makeSm();
    expect(sm.getImmersiveMode()).toBe(false);
  });

  test("setImmersiveMode(true) → getImmersiveMode() returns true", () => {
    const sm = makeSm();
    sm.setImmersiveMode(true);
    expect(sm.getImmersiveMode()).toBe(true);
  });

  test("setImmersiveMode(false) → getImmersiveMode() returns false", () => {
    const sm = makeSm();
    sm.setImmersiveMode(true);
    sm.setImmersiveMode(false);
    expect(sm.getImmersiveMode()).toBe(false);
  });

  test("setImmersiveMode(undefined) is a no-op (does not clear the current value)", () => {
    const sm = makeSm();
    sm.setImmersiveMode(true);
    sm.setImmersiveMode(undefined);
    expect(sm.getImmersiveMode()).toBe(true);

    sm.setImmersiveMode(false);
    sm.setImmersiveMode(undefined);
    expect(sm.getImmersiveMode()).toBe(false);
  });
});

// ─── Group 2: beginTurn snapshot semantics ───────────────────────────

describe("immersiveMode — beginTurn snapshot", () => {
  test("beginTurn snapshots immersiveMode=true into immersiveSnapshot", () => {
    const sm = makeSm();
    sm.setImmersiveMode(true);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-A" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();
    expect(turn?.immersiveSnapshot).toBe(true);
    expect(turn?.immersiveLastText).toBe("");
  });

  test("beginTurn snapshots immersiveMode=false into immersiveSnapshot", () => {
    const sm = makeSm();
    sm.setImmersiveMode(false);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-B" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();
    expect(turn?.immersiveSnapshot).toBe(false);
  });

  test("mid-turn setImmersiveMode does NOT mutate the in-flight snapshot", () => {
    const sm = makeSm();
    sm.setImmersiveMode(true);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-C" });
    const turn = sm["currentTurn"];
    expect(turn?.immersiveSnapshot).toBe(true);

    // User toggles immersive off mid-turn.
    sm.setImmersiveMode(false);

    // Snapshot must remain stable for the lifetime of this turn.
    expect(turn?.immersiveSnapshot).toBe(true);

    // Toggle back on — snapshot still stable.
    sm.setImmersiveMode(true);
    expect(turn?.immersiveSnapshot).toBe(true);

    // Live flag reflects the mid-turn mutation.
    expect(sm.getImmersiveMode()).toBe(true);
  });

  test("immersiveLastText is initialized to empty string", () => {
    const sm = makeSm();
    sm["beginTurn"]({ parts: [], contextToken: "ctx-D" });
    const turn = sm["currentTurn"];
    expect(turn?.immersiveLastText).toBe("");
  });
});

// ─── Group 3: flushCurrentPart — reasoning gate ──────────────────────

describe("immersiveMode — flushCurrentPart reasoning gate", () => {
  test("immersive=true suppresses reasoning: onReply NOT called, sentReasoningPartIds stays empty", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(true);
    sm.setShowFlags({ showThoughts: true, showTools: true });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-R1" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    // Simulate a reasoning part arriving — populate the type-change-flushing
    // state, then trigger the flush. With immersiveSnapshot === true,
    // the gate `if (turn.immersiveSnapshot) break;` short-circuits BEFORE
    // onReply is called.
    turn.currentPartType = "reasoning";
    turn.currentPartID = "r-1";
    turn.currentReasoningText = "thinking about the answer";
    turn.currentReasoningStartMs = Date.now() - 100;
    turn.currentReasoningEndMs = Date.now();

    sm["flushCurrentPart"](turn);

    expect(calls).toEqual([]);
    expect(turn.sentReasoningPartIds.has("r-1")).toBe(false);
    expect(turn.sentReasoningPartIds.size).toBe(0);
  });

  test("immersive=false (sanity): same setup DOES call onReply and adds partID to dedup", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(false);
    sm.setShowFlags({ showThoughts: true, showTools: true });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-R2" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    turn.currentPartType = "reasoning";
    turn.currentPartID = "r-2";
    turn.currentReasoningText = "thinking about the answer";
    turn.currentReasoningStartMs = Date.now() - 100;
    turn.currentReasoningEndMs = Date.now();

    sm["flushCurrentPart"](turn);

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^🧠 Thought/);
    expect(turn.sentReasoningPartIds.has("r-2")).toBe(true);
    expect(turn.sentReasoningPartIds.size).toBe(1);
  });
});

// ─── Group 4: flushCurrentPart — text gate (last-text-only) ─────────

describe("immersiveMode — flushCurrentPart text gate (last text wins)", () => {
  test("3 successive text parts in immersive mode → immersiveLastText holds the LAST, onReply NEVER called for the parts", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(true);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-T1" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();
    expect(turn.sentTextPartIds.size).toBe(0);

    // Part 1
    turn.currentPartType = "text";
    turn.currentPartID = "p1";
    turn.currentText = "part1";
    sm["flushCurrentPart"](turn);
    expect(calls).toEqual([]);
    expect(turn.immersiveLastText).toBe("part1");
    expect(turn.sentTextPartIds.size).toBe(0);

    // Part 2 — type-change flush. Note: `flushCurrentPart` calls
    // `resetCurrentPart` in `finally`, so the second call must
    // re-populate currentPartType / currentPartID / currentText.
    turn.currentPartType = "text";
    turn.currentPartID = "p2";
    turn.currentText = "part2";
    sm["flushCurrentPart"](turn);
    expect(calls).toEqual([]);
    expect(turn.immersiveLastText).toBe("part2"); // overwritten, NOT concatenated
    expect(turn.sentTextPartIds.size).toBe(0);

    // Part 3 — the LAST one wins.
    turn.currentPartType = "text";
    turn.currentPartID = "p3";
    turn.currentText = "part3";
    sm["flushCurrentPart"](turn);
    expect(calls).toEqual([]);
    expect(turn.immersiveLastText).toBe("part3");
    expect(turn.sentTextPartIds.size).toBe(0);

    // Now finalize. The fallback path should fire once with "part3".
    // Pre-flush type was null (reset by the last flush), so the
    // `preFlushCurrentType !== "text"` branch fires maybeFlushToolSummary,
    // which is a no-op because immersiveSnapshot && toolCalls.size === 0.
    sm["finalizeTurn"]("finalized");
    expect(calls).toEqual(["part3"]);
  });
});

// ─── Group 5: flushCurrentPart — text non-immersive (sanity) ─────────

describe("immersiveMode — flushCurrentPart text non-immersive (sanity)", () => {
  test("immersive=false: text part flushes normally, onReply called once, dedup set updated", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(false);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-T2" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    turn.currentPartType = "text";
    turn.currentPartID = "p-hello";
    turn.currentText = "hello";
    sm["flushCurrentPart"](turn);

    expect(calls).toEqual(["hello"]);
    expect(turn.sentTextPartIds.has("p-hello")).toBe(true);
    expect(turn.sentTextPartIds.size).toBe(1);
    expect(turn.immersiveLastText).toBe(""); // not populated when not immersive
  });
});

// ─── Group 6: maybeFlushToolSummary gate ──────────────────────────────

describe("immersiveMode — maybeFlushToolSummary gate", () => {
  // Helper to populate `turn.toolCalls` with a single tracked tool, the
  // way `trackTool` would. We bypass the full SSE pipeline here because
  // we're testing only the gate — populating the Map directly is enough
  // to exercise the early-return conditions.
  function seedToolCall(turn) {
    turn.toolCalls.set("c1", {
      callID: "c1",
      toolName: "bash",
      status: "running",
      title: "ls -la",
      input: {},
      output: undefined,
      isSubAgent: false,
    });
  }

  test("immersive=true suppresses tool summary: onReply NOT called even with tools tracked", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(true);
    sm.setShowFlags({ showThoughts: true, showTools: true });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-Tool1" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    seedToolCall(turn);
    expect(turn.toolCalls.size).toBe(1);

    sm["maybeFlushToolSummary"](turn);

    // Gate at session.ts:3211 short-circuits — no WeChat message.
    expect(calls).toEqual([]);
    // Session-level dedup Map is also untouched.
    expect(sm["toolLastSentStatus"].size).toBe(0);
  });

  test("immersive=false (sanity): same setup DOES call onReply with the tool summary line", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(false);
    sm.setShowFlags({ showThoughts: true, showTools: true });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-Tool2" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    seedToolCall(turn);

    sm["maybeFlushToolSummary"](turn);

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/^🔧 Tools:/);
    expect(calls[0]).toContain("⏳ bash");
    expect(sm["toolLastSentStatus"].get("c1")).toBe("running");
  });
});

// ─── Group 7: finalizeTurn fallback — immersive ──────────────────────

describe("immersiveMode — finalizeTurn fallback delivers immersiveLastText", () => {
  test("immersive=true with deferred text → finalizeTurn delivers immersiveLastText once", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(true);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-F1" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    // Simulate that during the turn, a text part was flushed (so
    // sentTextPartIds stays empty AND immersiveLastText was set), but no
    // onReply call fired. Mimic the state after `flushCurrentPart`'s
    // text case ran in immersive mode.
    turn.immersiveLastText = "final answer";
    // sentTextPartIds and textBuffer are already empty from beginTurn,
    // so anyTextSent === false and the fallback path is the only place
    // the user sees a reply.

    sm["finalizeTurn"]("finalized");

    expect(calls).toEqual(["final answer"]);
  });
});

// ─── Group 8: finalizeTurn fallback — error path overrides immersive ─

describe("immersiveMode — finalizeTurn error path still works in immersive", () => {
  test("immersive=true with empty immersiveLastText + overrideText → overrideText wins", () => {
    const { sm, calls } = makeSmWithCapturedReply();
    sm.setImmersiveMode(true);
    sm["beginTurn"]({ parts: [], contextToken: "ctx-F2" });
    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();

    // No text part arrived during the turn — immersiveLastText is empty.
    expect(turn.immersiveLastText).toBe("");
    expect(turn.textBuffer).toBe("");

    // Session errored out with an override message.
    sm["finalizeTurn"]("error", "something broke");

    // The overrideText must take priority over the (empty) immersive
    // fallback so the user always sees a clear error message.
    expect(calls).toEqual(["something broke"]);
  });
});
