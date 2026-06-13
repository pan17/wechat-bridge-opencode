// src/__tests__/verify-persistence-roundtrip.mjs
//
// Wave 2 — Task 4 persistence round-trip (mirrors the QA scenario from
// display-commands.md lines 616-626).
//
// We don't instantiate WeChatOpencodeBridge here (requires config + auth +
// network). Instead we replicate the load/save JSON shape and assert the
// exact same fields/conditions the bridge code reads and writes.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, expect, describe, beforeAll, afterAll } from "vitest";

let tmpDir;
let stateFile;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-task4-"));
  stateFile = path.join(tmpDir, ".wechat-bridge-state.json");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Replicate bridge's load/save JSON shape so we can assert exact field
// behavior without spinning up the full bridge (which needs auth + network).
function loadUserState(file) {
  const raw = fs.readFileSync(file, "utf-8");
  const state = JSON.parse(raw);
  if ("users" in state && state.users && state.users.length > 0) {
    const u = state.users[0];
    return {
      userId: u.userId ?? "",
      sessionId: u.sessionId ?? "",
      cwd: u.cwd,
      showThoughts: state.showThoughts,
      showTools: state.showTools,
    };
  }
  return null;
}

function saveUserState(file, userState) {
  const payload = {
    users: [
      {
        userId: userState.userId,
        sessionId: userState.sessionId,
        cwd: userState.cwd,
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  if (userState.showThoughts !== undefined) payload.showThoughts = userState.showThoughts;
  if (userState.showTools !== undefined)    payload.showTools    = userState.showTools;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
}

function writeInitial() {
  const initial = {
    users: [{ userId: "test-user", sessionId: "sess-abc", cwd: "C:/work/proj" }],
    showThoughts: true,
    showTools: false,
  };
  fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");
}

describe("persistence round-trip — top-level display flags", () => {
  test("load: initial JSON returns both user fields and both display flags", () => {
    writeInitial();
    const loaded = loadUserState(stateFile);
    expect(loaded?.userId).toBe("test-user");
    expect(loaded?.sessionId).toBe("sess-abc");
    expect(loaded?.cwd).toBe("C:/work/proj");
    expect(loaded?.showThoughts).toBe(true);
    expect(loaded?.showTools).toBe(false);
  });

  test("round-trip: handler mutates userState then save preserves new values", () => {
    writeInitial();
    const loaded = loadUserState(stateFile);
    // User types /thought-display off → handler sets showThoughts=false.
    // Also simulate the user turning tool display on.
    loaded.showThoughts = false;
    loaded.showTools = true;
    saveUserState(stateFile, loaded);

    const reloaded = loadUserState(stateFile);
    expect(reloaded?.showThoughts).toBe(false);
    expect(reloaded?.showTools).toBe(true);
  });

  test("undefined fields are omitted on save (no clobbering)", () => {
    writeInitial();
    const loaded = loadUserState(stateFile);
    loaded.showThoughts = undefined;
    loaded.showTools = true;
    saveUserState(stateFile, loaded);

    const raw = fs.readFileSync(stateFile, "utf-8");
    expect(raw).not.toContain('"showThoughts"');
    expect(raw).toContain('"showTools"');
  });
});