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
      autoPermissionMode: state.autoPermissionMode,
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
  if (userState.autoPermissionMode !== undefined) payload.autoPermissionMode = userState.autoPermissionMode;
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

describe("persistence round-trip — autoPermissionMode", () => {
  test("regression: /ap once survives bridge restart", () => {
    // Simulate: user just set /ap once, handler wrote userState to disk
    const state = {
      users: [{ userId: "u", sessionId: "s", cwd: "C:/x" }],
      autoPermissionMode: "once",
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");

    // Simulate: bridge restart, loadUserState runs
    const loaded = loadUserState(stateFile);
    expect(loaded?.autoPermissionMode).toBe("once");

    // Simulate: bridge's startup check (bridge.ts:361-362)
    //   if (this.userState?.autoPermissionMode !== undefined)
    //     this.sessionManager.setAutoPermissionMode(...)
    expect(loaded?.autoPermissionMode).toBeDefined();
  });

  test("regression: /ap always survives bridge restart", () => {
    const state = {
      users: [{ userId: "u", sessionId: "s", cwd: "C:/x" }],
      autoPermissionMode: "always",
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
    const loaded = loadUserState(stateFile);
    expect(loaded?.autoPermissionMode).toBe("always");
  });

  test("regression: /ap off survives bridge restart", () => {
    const state = {
      users: [{ userId: "u", sessionId: "s", cwd: "C:/x" }],
      autoPermissionMode: "off",
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
    const loaded = loadUserState(stateFile);
    expect(loaded?.autoPermissionMode).toBe("off");
  });

  test("undefined autoPermissionMode is omitted on save (backward compat)", () => {
    // Old state files (pre-permission-tool) have no autoPermissionMode key
    const state = {
      users: [{ userId: "u", sessionId: "s", cwd: "C:/x" }],
      showThoughts: true,
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf-8");
    const loaded = loadUserState(stateFile);
    expect(loaded?.autoPermissionMode).toBeUndefined();

    // User types /ap once → handler saves; existing showThoughts must NOT be wiped
    loaded.autoPermissionMode = "once";
    saveUserState(stateFile, loaded);

    const raw = fs.readFileSync(stateFile, "utf-8");
    const reparsed = JSON.parse(raw);
    expect(reparsed.autoPermissionMode).toBe("once");
    expect(reparsed.showThoughts).toBe(true);
  });

  test("user switches modes — only the latest value persists", () => {
    writeInitial();
    const loaded = loadUserState(stateFile);

    loaded.autoPermissionMode = "once";
    saveUserState(stateFile, loaded);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).autoPermissionMode).toBe("once");

    loaded.autoPermissionMode = "always";
    saveUserState(stateFile, loaded);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).autoPermissionMode).toBe("always");

    loaded.autoPermissionMode = "off";
    saveUserState(stateFile, loaded);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf-8")).autoPermissionMode).toBe("off");
  });
});

// ─── Source-level regression: wechatMsgCount reset ordering ───
//
// Bug: the WeChat 10-msg gateway counter was reset at line 748 of
// `bridge.ts`, AFTER the permission/question early returns at lines
// 696-733. When the user typed `1` or `/ap once` to a pending
// permission card, the early return skipped the reset — the counter
// carried over to the agent's next reply, triggering a "10 messages
// already" warning mid-turn. The fix moves the reset ABOVE the early
// returns (any incoming user message resets the counter).
//
// This test reads `dist/src/bridge.js` (the compiled artifact) and
// asserts the reset line number is lower than the first `return;`
// inside the permission-pending branch. We anchor on `handlePermissionReply`
// (unique to handleMessage, never appears in the shutdown handler) to
// avoid false-positive `return;` matches in other methods.
describe("regression: wechatMsgCount reset runs before permission/question early returns", () => {
  test("bridge.ts: counter reset is positioned before hasPendingPermission check", () => {
    const fs2 = require("node:fs");
    const path2 = require("node:path");
    // dist/src/bridge.js is the compiled output; same line numbers as bridge.ts
    const bridgeJs = path2.join(__dirname, "..", "..", "dist", "src", "bridge.js");
    const src = fs2.readFileSync(bridgeJs, "utf-8");
    const lines = src.split("\n");

    // Find the line in `handleMessage` that calls `handlePermissionReply`.
    // This is unique to handleMessage (the shutdown handler uses
    // `rejectPendingPermission` directly, not handlePermissionReply).
    const handlePermissionReplyCall = lines.findIndex((l) =>
      l.includes("this.handlePermissionReply"),
    );
    expect(handlePermissionReplyCall).toBeGreaterThan(-1);

    // The permission-pending `if` lives in the same method, a few lines
    // above the call. Walk backwards to find it.
    let permissionCheckLine = -1;
    for (let i = handlePermissionReplyCall; i >= 0; i--) {
      if (lines[i].includes("hasPendingPermission") && lines[i].includes("if")) {
        permissionCheckLine = i;
        break;
      }
    }
    expect(permissionCheckLine).toBeGreaterThan(-1);

    // The first `return;` after the permission-pending `if` is the
    // early return we're protecting against.
    let permissionReturnLine = -1;
    for (let i = permissionCheckLine; i < lines.length; i++) {
      if (/^\s*return;\s*$/.test(lines[i])) {
        permissionReturnLine = i;
        break;
      }
    }
    expect(permissionReturnLine).toBeGreaterThan(-1);

    // The first `this.wechatMsgCount = 0` line is the reset. It must
    // appear BEFORE the permission-pending early return — otherwise
    // the counter would not reset for permission replies.
    const resetLine = lines.findIndex((l) => l.includes("this.wechatMsgCount = 0"));
    expect(resetLine).toBeGreaterThan(-1);
    expect(resetLine).toBeLessThan(permissionReturnLine);
  });
});