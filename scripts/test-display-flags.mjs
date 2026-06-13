// scripts/test-display-flags.mjs
//
// Verifies Task 5 snapshot semantics for SessionManager:
//   1. setShowFlags is partial-update safe (omitting one flag does not clobber the other).
//   2. beginTurn snapshots the current showThoughts/showTools into currentTurn
//      via showThoughtsSnapshot / showToolsSnapshot.
//   3. mid-turn setShowFlags does NOT mutate the in-flight snapshot.
//   4. getShowFlagsForTurn returns the snapshot during a turn, else the live flags.
//   5. The 6 new AccumulatedTurn fields are initialized to clean values
//      (false/false/0/null/null/empty Set).
//
// Imports compiled SessionManager from dist/src/server/session.js (rootDir is "."
// in tsconfig, so emits under dist/src/...).
//
// Runtime-only test — `private` is TS-only, so accessing fields via bracket
// notation works at runtime. We use bracket notation to avoid sprinkling
// "as any" casts in the test.

import { SessionManager } from "../dist/src/server/session.js";
import assert from "node:assert/strict";

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

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${label}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}

// ─── Test 1: setShowFlags partial update ────────────────────────────────
check("setShowFlags is partial-update safe (does not clobber omitted flags)", () => {
  const sm = makeSm();
  assert.deepEqual(sm.getShowFlags(), { showThoughts: false, showTools: false },
    "defaults are both false");

  sm.setShowFlags({ showThoughts: true, showTools: true });
  assert.deepEqual(sm.getShowFlags(), { showThoughts: true, showTools: true });

  sm.setShowFlags({ showThoughts: false });
  assert.deepEqual(sm.getShowFlags(), { showThoughts: false, showTools: true },
    "partial update {showThoughts:false} must NOT clobber showTools");

  sm.setShowFlags({ showTools: false });
  assert.deepEqual(sm.getShowFlags(), { showThoughts: false, showTools: false },
    "partial update {showTools:false} must NOT clobber showThoughts");

  sm.setShowFlags({ showThoughts: true });
  sm.setShowFlags({});
  assert.deepEqual(sm.getShowFlags(), { showThoughts: true, showTools: false },
    "empty flags object must be a no-op");
});

// ─── Test 2: getShowFlagsForTurn falls back to live flags outside a turn ─
check("getShowFlagsForTurn returns live flags when no turn active", () => {
  const sm = makeSm();
  sm.setShowFlags({ showThoughts: true, showTools: false });
  assert.deepEqual(sm.getShowFlagsForTurn(), { showThoughts: true, showTools: false });
  sm.setShowFlags({ showTools: true });
  assert.deepEqual(sm.getShowFlagsForTurn(), { showThoughts: true, showTools: true });
});

// ─── Test 3: beginTurn snapshots current flags ─────────────────────────
check("beginTurn snapshots current showThoughts/showTools into the turn", () => {
  const sm = makeSm();
  sm.setShowFlags({ showThoughts: false, showTools: true });

  // beginTurn is private but accessible at runtime via bracket notation.
  sm["beginTurn"]({ parts: [], contextToken: "ctx-A" });

  const turn = sm["currentTurn"];
  assert.ok(turn, "currentTurn must be set after beginTurn");
  assert.equal(turn.showThoughtsSnapshot, false,
    "snapshot must capture live showThoughts=false");
  assert.equal(turn.showToolsSnapshot, true,
    "snapshot must capture live showTools=true");
});

// ─── Test 4: 6 new fields initialized to clean state ───────────────────
check("new AccumulatedTurn fields initialized to clean state", () => {
  const sm = makeSm();
  sm["beginTurn"]({ parts: [], contextToken: "ctx-B" });
  const turn = sm["currentTurn"];

  assert.equal(turn.reasoningCharCount, 0,
    "reasoningCharCount must start at 0");
  assert.equal(turn.reasoningStartMs, null,
    "reasoningStartMs must start at null");
  assert.equal(turn.reasoningEndMs, null,
    "reasoningEndMs must start at null");
  assert.ok(turn.sentReasoningPartIds instanceof Set,
    "sentReasoningPartIds must be a Set");
  assert.equal(turn.sentReasoningPartIds.size, 0,
    "sentReasoningPartIds must start empty");
});

// ─── Test 5: mid-turn setShowFlags does NOT mutate snapshot ────────────
check("mid-turn setShowFlags does NOT mutate the in-flight snapshot", () => {
  const sm = makeSm();
  sm.setShowFlags({ showThoughts: false, showTools: true });
  sm["beginTurn"]({ parts: [], contextToken: "ctx-C" });

  // User flips the flag mid-turn. Snapshot must remain stable.
  sm.setShowFlags({ showThoughts: true });

  const turn = sm["currentTurn"];
  assert.equal(turn.showThoughtsSnapshot, false,
    "mid-turn flip must NOT mutate showThoughtsSnapshot");
  assert.equal(turn.showToolsSnapshot, true,
    "showToolsSnapshot must remain unaffected");

  // And getShowFlagsForTurn (the accessor Task 6 will use) must still see
  // the snapshot, NOT the live flag.
  assert.deepEqual(sm.getShowFlagsForTurn(),
    { showThoughts: false, showTools: true },
    "getShowFlagsForTurn must return snapshot during turn");
});

// ─── Test 6: getShowFlagsForTurn returns snapshot during turn ──────────
check("getShowFlagsForTurn returns snapshot during turn, live after turn ends", () => {
  const sm = makeSm();
  sm.setShowFlags({ showThoughts: true, showTools: false });
  sm["beginTurn"]({ parts: [], contextToken: "ctx-D" });

  // Inside the turn, accessor sees snapshot.
  assert.deepEqual(sm.getShowFlagsForTurn(),
    { showThoughts: true, showTools: false });

  // Flip live flags — snapshot stays.
  sm.setShowFlags({ showThoughts: false, showTools: true });
  assert.deepEqual(sm.getShowFlagsForTurn(),
    { showThoughts: true, showTools: false },
    "snapshot must still win after mid-turn flip");

  // Simulate turn end (clear currentTurn).
  sm["currentTurn"] = null;
  assert.deepEqual(sm.getShowFlagsForTurn(),
    { showThoughts: false, showTools: true },
    "after turn ends, accessor falls back to live flags");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
