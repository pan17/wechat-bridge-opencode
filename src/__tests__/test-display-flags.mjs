// src/__tests__/test-display-flags.mjs
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

describe("setShowFlags partial update", () => {
  test("defaults are showThoughts=true, showTools=true (WeChat users see summaries by default)", () => {
    // Regression: prior defaults were {false, false}. Flipped to {true, true}
    // so first-time installs see 🧠 Thought and 🔧 Tools lines without
    // having to discover and toggle `/thought-display on` /
    // `/tool-display on`. Users who explicitly turned either flag off
    // get their choice back from `~/.wechat-bridge-state.json`; users
    // who never toggled inherit the new defaults.
    const sm = makeSm();
    expect(sm.getShowFlags()).toEqual({ showThoughts: true, showTools: true });
  });

  test("is partial-update safe (does not clobber omitted flags)", () => {
    const sm = makeSm();
    expect(sm.getShowFlags()).toEqual({ showThoughts: true, showTools: true });

    sm.setShowFlags({ showThoughts: false, showTools: false });
    expect(sm.getShowFlags()).toEqual({ showThoughts: false, showTools: false });

    sm.setShowFlags({ showThoughts: true, showTools: true });
    expect(sm.getShowFlags()).toEqual({ showThoughts: true, showTools: true });

    sm.setShowFlags({ showThoughts: false });
    expect(sm.getShowFlags()).toEqual({ showThoughts: false, showTools: true });

    sm.setShowFlags({ showTools: false });
    expect(sm.getShowFlags()).toEqual({ showThoughts: false, showTools: false });

    sm.setShowFlags({ showThoughts: true });
    sm.setShowFlags({});
    expect(sm.getShowFlags()).toEqual({ showThoughts: true, showTools: false });
  });
});

describe("getShowFlagsForTurn", () => {
  test("returns live flags when no turn active", () => {
    const sm = makeSm();
    sm.setShowFlags({ showThoughts: true, showTools: false });
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: true, showTools: false });
    sm.setShowFlags({ showTools: true });
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: true, showTools: true });
  });

  test("returns snapshot during turn, live after turn ends", () => {
    const sm = makeSm();
    sm.setShowFlags({ showThoughts: true, showTools: false });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-D" });

    // Inside the turn, accessor sees snapshot.
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: true, showTools: false });

    // Flip live flags — snapshot stays.
    sm.setShowFlags({ showThoughts: false, showTools: true });
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: true, showTools: false });

    // Simulate turn end (clear currentTurn).
    sm["currentTurn"] = null;
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: false, showTools: true });
  });
});

describe("beginTurn snapshot semantics", () => {
  test("snapshots current showThoughts/showTools into the turn", () => {
    const sm = makeSm();
    sm.setShowFlags({ showThoughts: false, showTools: true });

    // beginTurn is private but accessible at runtime via bracket notation.
    sm["beginTurn"]({ parts: [], contextToken: "ctx-A" });

    const turn = sm["currentTurn"];
    expect(turn).toBeTruthy();
    expect(turn?.showThoughtsSnapshot).toBe(false);
    expect(turn?.showToolsSnapshot).toBe(true);
  });

  test("mid-turn setShowFlags does NOT mutate the in-flight snapshot", () => {
    const sm = makeSm();
    sm.setShowFlags({ showThoughts: false, showTools: true });
    sm["beginTurn"]({ parts: [], contextToken: "ctx-C" });

    // User flips the flag mid-turn. Snapshot must remain stable.
    sm.setShowFlags({ showThoughts: true });

    const turn = sm["currentTurn"];
    expect(turn?.showThoughtsSnapshot).toBe(false);
    expect(turn?.showToolsSnapshot).toBe(true);

    // And getShowFlagsForTurn (the accessor Task 6 will use) must still see
    // the snapshot, NOT the live flag.
    expect(sm.getShowFlagsForTurn()).toEqual({ showThoughts: false, showTools: true });
  });
});

describe("AccumulatedTurn initialization", () => {
  test("new fields are initialized to clean state", () => {
    const sm = makeSm();
    sm["beginTurn"]({ parts: [], contextToken: "ctx-B" });
    const turn = sm["currentTurn"];

    expect(turn?.reasoningCharCount).toBe(0);
    expect(turn?.reasoningStartMs).toBeNull();
    expect(turn?.reasoningEndMs).toBeNull();
    expect(turn?.sentReasoningPartIds).toBeInstanceOf(Set);
    expect(turn?.sentReasoningPartIds.size).toBe(0);
  });
});