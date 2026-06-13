/**
 * scripts/verify-display-commands.mjs
 *
 * Comprehensive end-to-end verification harness for the
 * /thought-display + /tool-display feature (display-commands plan, Task 7).
 *
 * Runs all 7 acceptance categories from the plan (lines 889-912) against
 * the COMPILED dist/ artifacts. Zero npm deps — only `node:` built-ins.
 *
 * Categories:
 *   1. parsers            — 14 cases (7 per parser; mirrors test-parsers.mjs)
 *   2. pureFunctions      — 6 cases (reasoningSummary 3, formatThoughtHeader 2, formatDuration 5)
 *   3. persistence        — 4 cases (round-trip, undefined-field omission,
 *                                    legacy compat, old-shape single-user file)
 *   4. commandIndependence — 1 case (setShowFlags partial update is safe)
 *   5. thoughtRemoval     — 2 cases (parseThoughtDisplayCommand("/thought on") === null;
 *                                    bridgeCommands array does NOT contain "thinking")
 *   6. helpUpdates        — 3 cases (formatHelp contains new sections,
 *                                    formatHelp does NOT contain old "── 思考 ──",
 *                                    formatHelpWithNativeCommands contains new sections)
 *
 * Exit 0 on full pass, 1 on any failure. Prints `PASS: <n>/<n>` summary.
 *
 * Run: `node scripts/verify-display-commands.mjs` (after `npm run build`).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseThoughtDisplayCommand,
  parseToolDisplayCommand,
  formatHelp,
  formatHelpWithNativeCommands,
} from "../dist/src/adapter/workspace-cmd.js";
import {
  reasoningSummary,
  formatThoughtHeader,
  formatDuration,
} from "../dist/src/adapter/thinking-format.js";
import { SessionManager } from "../dist/src/server/session.js";

let passed = 0;
let failed = 0;
const pendingPromises = [];

function test(name, fn) {
  // AWAIT async tests so their assertions actually run. Without this,
  // `fn()` returns a Promise that the surrounding try/catch can't
  // catch, and the test is marked PASS before any assertion executes.
  // The Promise is tracked in `pendingPromises` so the bottom of the
  // script can `await Promise.all(...)` before printing the summary
  // and calling `process.exit`.
  const result = fn();
  if (result && typeof result.then === "function") {
    const p = result.then(
      () => {
        passed++;
        console.log(`  PASS  ${name}`);
      },
      (err) => {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 3).join(" / ") : "";
        console.log(`  FAIL  ${name}`);
        console.log(`        ${message}`);
        if (stack) console.log(`        ${stack}`);
      },
    );
    pendingPromises.push(p);
  } else {
    try {
      result;
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 3).join(" / ") : "";
      console.log(`  FAIL  ${name}`);
      console.log(`        ${message}`);
      if (stack) console.log(`        ${stack}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Category 1: Parser unit checks (Task 2's 14 cases)
// ────────────────────────────────────────────────────────────────────────
console.log("parsers (14 cases)");

const thoughtCases = [
  { input: "/thought-display on",      expected: { kind: "on" },     label: "on" },
  { input: "/thought-display off",     expected: { kind: "off" },    label: "off" },
  { input: "/thought-display status",  expected: { kind: "status" }, label: "status" },
  { input: "/thought-display enable",  expected: { kind: "on" },     label: "enable alias" },
  { input: "/thought-display disable", expected: { kind: "off" },    label: "disable alias" },
  { input: "/thought-display foo",     expected: null,               label: "unknown subcommand" },
  { input: "/thought on",              expected: null,               label: "legacy /thought rejected" },
];

const toolCases = [
  { input: "/tool-display on",     expected: { kind: "on" },     label: "on" },
  { input: "/tool-display off",    expected: { kind: "off" },    label: "off" },
  { input: "/tool-display status", expected: { kind: "status" }, label: "status" },
  { input: "/tool-display enable", expected: { kind: "on" },     label: "enable alias" },
  { input: "/tool-display disable", expected: { kind: "off" },   label: "disable alias" },
  { input: "/tool-display foo",    expected: null,               label: "unknown subcommand" },
  { input: "/tool-display /thought on", expected: null,          label: "extra arg rejected" },
];

function runParserCase(parserName, parser, c) {
  test(`${parserName}("${c.input}") → ${c.label}`, () => {
    const actual = parser(c.input);
    assert.deepEqual(actual, c.expected);
  });
}

for (const c of thoughtCases) runParserCase("parseThoughtDisplayCommand", parseThoughtDisplayCommand, c);
for (const c of toolCases)    runParserCase("parseToolDisplayCommand",    parseToolDisplayCommand,    c);

// ────────────────────────────────────────────────────────────────────────
// Category 2: Pure-function checks (Task 1's 6 cases — combined into 6
// logical assertions across reasoningSummary, formatThoughtHeader, formatDuration)
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("pureFunctions (6 cases)");

test("reasoningSummary extracts title from **Title**\\n\\nbody pattern", () => {
  const r = reasoningSummary("**Inspecting PR workflow**\n\nLooking at the diff...");
  assert.equal(r.title, "Inspecting PR workflow");
  assert.equal(r.body, "Looking at the diff...");
  assert.equal(r.summary, "Inspecting PR workflow", "summary mirrors the **Title** header");
});

test("reasoningSummary returns null title when no marker; summary falls back to first line", () => {
  const r = reasoningSummary("Just thinking out loud here.");
  assert.equal(r.title, null);
  assert.equal(r.body, "Just thinking out loud here.");
  assert.equal(r.summary, "Just thinking out loud here.",
    "no-title fallback: summary must use the first line of the body");
});

test("reasoningSummary strips [REDACTED] placeholders", () => {
  const r = reasoningSummary("**My plan**\n\n[REDACTED] some secret [REDACTED] more text");
  assert.equal(r.title, "My plan");
  assert.equal(r.body, "some secret  more text");
  assert.ok(!r.body.includes("[REDACTED]"), "body must not contain [REDACTED]");
  assert.equal(r.summary, "My plan");
});

test("formatThoughtHeader includes summary and duration", () => {
  assert.equal(
    formatThoughtHeader(2300, "Inspecting PR workflow"),
    "🧠 Thought · Inspecting PR workflow · 2.3s",
  );
});

test("formatThoughtHeader omits summary segment when summary is empty", () => {
  assert.equal(formatThoughtHeader(450, ""), "🧠 Thought · 450ms");
});

test("formatThoughtHeader with first-line fallback summary (no **Title** marker)", () => {
  assert.equal(
    formatThoughtHeader(187, "Just thinking out loud here."),
    "🧠 Thought · Just thinking out loud here. · 187ms",
  );
});

test("formatDuration handles sub-second and multi-second boundaries", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(2345), "2.3s");
  assert.equal(formatDuration(12700), "12.7s");
});

// ────────────────────────────────────────────────────────────────────────
// Category 3: Persistence round-trip + legacy compat (Task 4's 3+ cases)
//
// We replicate the load/save logic from bridge.ts:380-439 in a tiny harness
// (do NOT instantiate WeChatOpencodeBridge — too heavy). The shape and
// omission semantics are 1:1 with the production code.
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("persistence (4 cases)");

// Mirror of bridge.ts loadUserState() — read top-level showThoughts/showTools
// from the v1.1.2 multi-user shape OR the v1.1.1 single-user shape.
function loadUserState(stateFile) {
  const raw = fs.readFileSync(stateFile, "utf-8");
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
  if ("sessionId" in state || "cwd" in state) {
    return {
      userId: "",
      sessionId: state.sessionId ?? "",
      cwd: state.cwd,
      showThoughts: state.showThoughts,
      showTools: state.showTools,
    };
  }
  return null;
}

// Mirror of bridge.ts saveUserState() — omit undefined fields.
function saveUserState(stateFile, userState) {
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
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf-8");
}

test("round-trip preserves both top-level display flags", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-verify-persist-"));
  const stateFile = path.join(tmpDir, ".wechat-bridge-state.json");
  try {
    const initial = {
      users: [{ userId: "u1", sessionId: "sess-1", cwd: "C:/work/proj" }],
      showThoughts: true,
      showTools: false,
    };
    fs.writeFileSync(stateFile, JSON.stringify(initial, null, 2), "utf-8");

    const loaded = loadUserState(stateFile);
    assert.equal(loaded.userId, "u1");
    assert.equal(loaded.sessionId, "sess-1");
    assert.equal(loaded.cwd, "C:/work/proj");
    assert.equal(loaded.showThoughts, true,  "load: showThoughts must be true");
    assert.equal(loaded.showTools, false,    "load: showTools must be false");

    // Mutate and save
    loaded.showThoughts = false;
    loaded.showTools = true;
    saveUserState(stateFile, loaded);

    const reloaded = loadUserState(stateFile);
    assert.equal(reloaded.showThoughts, false, "round-trip: showThoughts flipped to false");
    assert.equal(reloaded.showTools, true,    "round-trip: showTools flipped to true");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("undefined fields are omitted on save (no clobbering)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-verify-omit-"));
  const stateFile = path.join(tmpDir, ".wechat-bridge-state.json");
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      users: [{ userId: "u1", sessionId: "sess-1", cwd: "C:/work/proj" }],
      showThoughts: true,
      showTools: true,
    }), "utf-8");

    const loaded = loadUserState(stateFile);
    loaded.showThoughts = undefined;
    loaded.showTools = true;
    saveUserState(stateFile, loaded);

    const raw = fs.readFileSync(stateFile, "utf-8");
    assert.ok(!raw.includes('"showThoughts"'), "undefined showThoughts must be omitted from JSON");
    assert.ok(raw.includes('"showTools"'),     "defined showTools must be in JSON");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("legacy v1.1.1 state (no showThoughts/showTools) loads with undefined flags", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-verify-legacy-"));
  const stateFile = path.join(tmpDir, ".wechat-bridge-state.json");
  try {
    // v1.1.1 shape: top-level sessionId/cwd, NO showThoughts/showTools
    fs.writeFileSync(stateFile, JSON.stringify({
      sessionId: "sess-old",
      cwd: "C:/old/proj",
    }), "utf-8");

    const loaded = loadUserState(stateFile);
    assert.ok(loaded, "legacy state must load");
    assert.equal(loaded.sessionId, "sess-old");
    assert.equal(loaded.cwd, "C:/old/proj");
    assert.equal(loaded.showThoughts, undefined, "legacy: showThoughts must be undefined");
    assert.equal(loaded.showTools, undefined,    "legacy: showTools must be undefined");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("legacy multi-user v1.1.1 state (no showThoughts/showTools) loads with undefined flags", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbo-verify-legacy-multi-"));
  const stateFile = path.join(tmpDir, ".wechat-bridge-state.json");
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      users: [{ userId: "u-old", sessionId: "sess-old", cwd: "C:/old/proj" }],
    }), "utf-8");

    const loaded = loadUserState(stateFile);
    assert.ok(loaded, "legacy multi-user state must load");
    assert.equal(loaded.userId, "u-old");
    assert.equal(loaded.sessionId, "sess-old");
    assert.equal(loaded.cwd, "C:/old/proj");
    assert.equal(loaded.showThoughts, undefined);
    assert.equal(loaded.showTools, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Category 4: Command independence — setShowFlags partial-update safety
// (instantiate SessionManager; setShowFlags/getShowFlagsForTurn are private
// at the TS level but accessible at runtime via bracket notation, mirroring
// the approach in scripts/test-display-flags.mjs).
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("commandIndependence (1 case)");

function makeSm() {
  return new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async () => {},
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
}

test("setShowFlags({ showThoughts: true }) does NOT clobber showTools", () => {
  const sm = makeSm();
  // Set both flags
  sm["setShowFlags"]({ showThoughts: true, showTools: true });
  assert.deepEqual(sm["getShowFlags"](), { showThoughts: true, showTools: true });

  // Partial update: only flip showThoughts. showTools must remain unchanged.
  sm["setShowFlags"]({ showThoughts: false });
  const after = sm["getShowFlags"]();
  assert.equal(after.showThoughts, false, "showThoughts must flip to false");
  assert.equal(after.showTools, true,    "showTools must remain unchanged after partial update");

  // And the snapshot accessor must agree (no turn active, so it returns live flags)
  const snapshotView = sm["getShowFlagsForTurn"]();
  assert.deepEqual(snapshotView, { showThoughts: false, showTools: true });

  // Symmetric case: only flip showTools, showThoughts must remain.
  sm["setShowFlags"]({ showThoughts: true, showTools: false }); // reset
  sm["setShowFlags"]({ showTools: true });
  const after2 = sm["getShowFlags"]();
  assert.equal(after2.showThoughts, true, "showThoughts must remain after partial showTools update");
  assert.equal(after2.showTools, true,    "showTools must flip to true");
});

// ────────────────────────────────────────────────────────────────────────
// Category 4b: handleReasoningPart behavior — the on-mode path must send
// ONLY the single one-line summary header, NEVER the full reasoning body
// (the user's bug report: body was being echoed to WeChat).
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("reasoningPartDisplay (4 cases)");

function makeTurnForReasoningTest(overrides) {
  return {
    sessionId: "test-session",
    userMessageId: "um-1",
    assistantMessageId: "am-1",
    parts: new Map(),
    textBuffer: "",
    finalText: "",
    toolCalls: new Map(),
    hasBackgroundTasks: false,
    contextToken: "ctx-test",
    hint: null,
    status: "accumulating",
    startedAt: Date.now() - 5000,
    lastEventAt: Date.now(),
    sentTextPartIds: new Set(),
    pendingTextParts: [],
    pendingReasoningParts: [],
    showThoughtsSnapshot: true,
    showToolsSnapshot: false,
    reasoningCharCount: 0,
    reasoningStartMs: Date.now() - 2000,
    reasoningEndMs: Date.now() - 100,
    sentReasoningPartIds: new Set(),
    toolCallIdsInLastSummary: new Set(),
    reasoningPartTimestamps: new Map(),
    ...overrides,
  };
}

test("handleReasoningPart in showThoughts=on mode sends the summary line IMMEDIATELY (pass-through, no buffer)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true });

  const turn = makeTurnForReasoningTest();
  // Set per-part streaming timestamps to simulate "1.9s of thinking"
  // (the previous code used the cumulative turn-level timestamps;
  // per-part requires an explicit entry for the part ID).
  const tNow = Date.now();
  turn.reasoningPartTimestamps.set("rp-1", { startMs: tNow - 2000, endMs: tNow - 100 });
  const part = {
    id: "rp-1",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "reasoning",
    text: "**Inspecting PR workflow**\n\nThis is a long body that the user must NEVER see in WeChat. The bridge should only send the single-line summary, not the full reasoning text.",
  };

  sm["handleReasoningPart"](turn, part);

  // onReply is fire-and-forget (Promise returned); flush microtasks.
  await Promise.resolve();
  await Promise.resolve();

  // Pass-through: the summary is sent IMMEDIATELY. The body never
  // appears in WeChat. The summary uses · separators (no colon) and
  // includes the duration.
  assert.equal(replyCalls.length, 1,
    `expected 1 onReply call (the summary line); got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "🧠 Thought · Inspecting PR workflow · 1.9s",
    "the onReply call must be the summary line with · separators (no colon)");

  // And the part must be marked as sent (dedup works).
  assert.ok(turn.sentReasoningPartIds.has("rp-1"), "part must be added to sentReasoningPartIds after sending");
});

test("handleReasoningPart uses first-line summary when no **Title** marker (showThoughts=on)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true });

  const turn = makeTurnForReasoningTest();
  // Set per-part streaming timestamps to simulate "1.9s of thinking"
  // (the previous code used the cumulative turn-level timestamps;
  // per-part requires an explicit entry for the part ID).
  const tNow = Date.now();
  turn.reasoningPartTimestamps.set("rp-2", { startMs: tNow - 2000, endMs: tNow - 100 });
  const part = {
    id: "rp-2",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "reasoning",
    text: "Just thinking out loud here.\n\nAnd here is a long body that should not appear in WeChat at all — only the first-line summary gets sent.",
  };

  sm["handleReasoningPart"](turn, part);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replyCalls.length, 1, `expected 1 onReply call; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "🧠 Thought · Just thinking out loud here. · 1.9s",
    "without **Title**, the first line of the body becomes the summary");
});

test("handleReasoningPart in showThoughts=off mode does NOT call onReply", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false });

  const turn = makeTurnForReasoningTest();
  const part = {
    id: "rp-3",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "reasoning",
    text: "**Off-mode reasoning**\n\nThis text should NEVER be sent to WeChat — off-mode means off.",
  };

  sm["handleReasoningPart"](turn, part);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replyCalls.length, 0,
    `off-mode: expected 0 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(!turn.sentReasoningPartIds.has("rp-3"),
    "off-mode: part must NOT be marked as sent (it was never sent)");
});

test("handleReasoningPart drops parts with empty text (no header emitted in either mode)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true });

  const turn = makeTurnForReasoningTest();
  const part = {
    id: "rp-4",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "reasoning",
    text: "   \n  \n  ", // whitespace-only
  };

  sm["handleReasoningPart"](turn, part);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replyCalls.length, 0, "empty reasoning text must NOT produce a header");
});

// ────────────────────────────────────────────────────────────────────────
// Category 4c: Tool summary ordering (pass-through) — the 🔧 Tools: …
// summary is emitted at the FIRST non-tool event that arrives after a
// tool (post-tool reasoning part or the first text part), so the summary
// lands in WeChat at the chronological boundary where the model switched
// from "tools" to "more output". The bridge does NOT buffer reasoning
// or text; events are forwarded in arrival order.
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("toolSummaryOrdering (4 cases)");

/** Build a turn with two completed tools already in toolCalls. */
function makeTurnWithTools(overrides = {}) {
  return makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["call-1", { callID: "call-1", toolName: "bash",       status: "completed", title: "Check git status", output: "M src", isSubAgent: false }],
      ["call-2", { callID: "call-2", toolName: "lsp_status", status: "error",     title: undefined,        output: undefined,    isSubAgent: false }],
    ]),
    ...overrides,
  });
}

test("maybeSendTextPart flushes tool summary BEFORE the first text part (showTools=on, pass-through)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnWithTools();
  const textPart = {
    id: "tp-1",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "text",
    text: "几个工具测试通过 ✅\n\n| 工具 | 结果 |\n| ... | ... |\n\nWeChat 通信正常 👍",
  };

  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();
  await Promise.resolve();

  // Expect EXACTLY 2 calls in this order: tool summary first, then text.
  assert.equal(replyCalls.length, 2, `expected 2 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"),
    `call #0 must be the tool summary, got: ${replyCalls[0]}`);
  assert.ok(replyCalls[0].includes("bash") && replyCalls[0].includes("lsp_status"),
    `tool summary must list both tools; got: ${replyCalls[0]}`);
  assert.equal(replyCalls[1], textPart.text,
    `call #1 must be the text reply (in full); got: ${replyCalls[1].slice(0, 60)}…`);

  // After flushing, all tracked callIDs must be in the "summarized" set
  // so a subsequent flush for the same tools is a no-op.
  assert.equal(turn.toolCallIdsInLastSummary.size, 2,
    "both tracked callIDs must be in toolCallIdsInLastSummary after the flush");
  assert.ok(turn.toolCallIdsInLastSummary.has("call-1"));
  assert.ok(turn.toolCallIdsInLastSummary.has("call-2"));
});

test("maybeSendTextPart does NOT re-emit tool summary on subsequent text parts", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnWithTools();
  const part1 = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "First text chunk." };
  const part2 = { id: "tp-2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "Second text chunk." };
  const part3 = { id: "tp-3", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "Third text chunk." };

  sm["maybeSendTextPart"](turn, part1);
  sm["maybeSendTextPart"](turn, part2);
  sm["maybeSendTextPart"](turn, part3);
  await Promise.resolve();
  await Promise.resolve();

  // Expect 4 calls total: 1 tool summary + 3 text parts (in order).
  assert.equal(replyCalls.length, 4, `expected 4 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"), "first call must be the tool summary");
  assert.equal(replyCalls[1], "First text chunk.");
  assert.equal(replyCalls[2], "Second text chunk.");
  assert.equal(replyCalls[3], "Third text chunk.");
});

test("maybeSendTextPart does NOT emit tool summary when showTools=off (snapshot)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  // Live flag is on, but the snapshot we'll set on the turn is off.
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnWithTools({ showToolsSnapshot: false });
  const part = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "Just the text." };

  sm["maybeSendTextPart"](turn, part);
  await Promise.resolve();
  await Promise.resolve();

  // Only the text should be sent — the snapshot was off at turn start.
  assert.equal(replyCalls.length, 1, `expected 1 onReply call; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "Just the text.");
  assert.equal(turn.toolCallIdsInLastSummary.size, 0,
    "toolCallIdsInLastSummary must stay empty when snapshot is off (no flush attempt)");
});

test("maybeFlushToolSummary is a no-op when there are no tools to summarize", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  // Turn has NO tools. maybeFlushToolSummary must be a no-op.
  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["maybeFlushToolSummary"](turn);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replyCalls.length, 0, "no tools → no tool summary message");
  assert.equal(turn.toolCallIdsInLastSummary.size, 0,
    "no tools → toolCallIdsInLastSummary must stay empty");
});

test("handleReasoningPart flushes tool summary BEFORE the reasoning line (post-tool reasoning)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  // Turn has a tool already. The reasoning part arrives after it, so
  // the tool summary must be emitted just before the reasoning line.
  const turn = makeTurnWithTools();
  const part = {
    id: "rp-after-tool",
    sessionID: turn.sessionId,
    messageID: turn.assistantMessageId,
    type: "reasoning",
    text: "First bash command executed. Now I need to reply with OK.",
  };

  sm["handleReasoningPart"](turn, part);
  await Promise.resolve();
  await Promise.resolve();

  // Expect 2 calls: tool summary first, then reasoning line.
  assert.equal(replyCalls.length, 2, `expected 2 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"),
    `call #0 must be the tool summary, got: ${replyCalls[0]}`);
  assert.ok(replyCalls[1].startsWith("🧠 Thought ·"),
    `call #1 must be the reasoning summary, got: ${replyCalls[1]}`);
  assert.equal(turn.toolCallIdsInLastSummary.size, 2,
    "both tracked callIDs must be in toolCallIdsInLastSummary after the flush");
});

test("finalizeTurn flushes tool summary as fallback when there are tools but NO non-tool event followed", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
    cancelTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnWithTools();
  sm["currentTurn"] = turn;

  // Simulate the end-of-turn finalize with no text or reasoning part
  // ever having been sent (the model's response was tools-only, or an
  // error short-circuited before any non-tool event arrived).
  sm["finalizeTurn"]("finalized");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(replyCalls.length, 1, `expected 1 onReply call; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"),
    `finalizeTurn fallback must emit the tool summary; got: ${replyCalls[0]}`);
  assert.equal(turn.toolCallIdsInLastSummary.size, 2,
    "all tracked callIDs must be in toolCallIdsInLastSummary after fallback flush");
});

// ────────────────────────────────────────────────────────────────────────
// Category 4d: End-to-end chronological order — pass-through means the
// WeChat output mirrors the model's arrival order. The tool summary is
// inserted at the FIRST non-tool event that follows a tool (the natural
// boundary). Two scenarios are tested: the 4-tool / 2-reasoning case
// and the user's "OK" case (1 reasoning, 1 tool, 1 reasoning, 1 text).
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("chronologicalOrder (2 cases)");

/** Drive a stream of part.updated events through the public pipeline. */
function driveStream(sm, turn, parts) {
  for (const part of parts) {
    sm["handleEvent"]({
      type: "message.part.updated",
      properties: { sessionID: turn.sessionId, part },
    });
  }
}

test("user scenario A: R → T*4 → R → Text produces [R, tools, R, text] in WeChat", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "rp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "The user is just testing WeChat functionality and wants me to execute a few tools without doing any specific operations." },
    { id: "tool-bash", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "c1", state: { status: "completed", title: "Check git status" } },
    { id: "tool-lsp", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "lsp_status", callID: "c2", state: { status: "error" } },
    { id: "tool-cron", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "cron_list", callID: "c3", state: { status: "completed", title: "List cron jobs" } },
    { id: "tool-glob", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "glob", callID: "c4", state: { status: "completed", title: "Search files" } },
    { id: "rp-2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "The user just wants to test the WeChat functionality. I executed a few read-only tools successfully." },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "几个工具测试通过 ✅\n\n| 工具 | 结果 |\n| ... | ... |" },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Expected WeChat order: [R1, T-summary, R2, text]
  assert.equal(replyCalls.length, 4,
    `expected 4 onReply calls in order [R1, tools, R2, text]; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);

  assert.ok(replyCalls[0].startsWith("🧠 Thought ·"),
    `replyCalls[0] must be the first reasoning summary; got: ${replyCalls[0]}`);
  assert.ok(replyCalls[0].includes("The user is just testing"),
    `first reasoning must summarize the first part; got: ${replyCalls[0]}`);

  assert.ok(replyCalls[1].startsWith("🔧 Tools:"),
    `replyCalls[1] must be the tool summary; got: ${replyCalls[1]}`);
  assert.ok(replyCalls[1].includes("bash") && replyCalls[1].includes("lsp_status") &&
            replyCalls[1].includes("cron_list") && replyCalls[1].includes("glob"),
    `tool summary must list all 4 tools; got: ${replyCalls[1]}`);

  assert.ok(replyCalls[2].startsWith("🧠 Thought ·"),
    `replyCalls[2] must be the second reasoning summary; got: ${replyCalls[2]}`);
  assert.ok(replyCalls[2].includes("The user just wants to test"),
    `second reasoning must summarize the second part; got: ${replyCalls[2]}`);

  assert.equal(replyCalls[3], "几个工具测试通过 ✅\n\n| 工具 | 结果 |\n| ... | ... |",
    `replyCalls[3] must be the final text reply; got: ${replyCalls[3]}`);
});

test("user scenario B: R → T → R → Text 'OK' produces [R, tools, R, 'OK'] in WeChat", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "rp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "The user wants me to reply \"OK\" after each individual command." },
    { id: "tool-bash", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "c1", state: { status: "completed", title: "Test bash 1 - uptime" } },
    { id: "rp-2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "First bash command executed. Now I need to reply \"OK\"." },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "OK" },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Expected WeChat order: [R1, T-summary, R2, "OK"]
  assert.equal(replyCalls.length, 4,
    `expected 4 onReply calls in order [R1, tools, R2, "OK"]; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);

  assert.ok(replyCalls[0].startsWith("🧠 Thought ·"),
    `replyCalls[0] must be the first reasoning summary; got: ${replyCalls[0]}`);
  assert.ok(replyCalls[0].includes("The user wants me to reply"),
    `first reasoning must summarize the first part; got: ${replyCalls[0]}`);

  assert.ok(replyCalls[1].startsWith("🔧 Tools:"),
    `replyCalls[1] must be the tool summary; got: ${replyCalls[1]}`);
  assert.ok(replyCalls[1].includes("bash"),
    `tool summary must list bash; got: ${replyCalls[1]}`);

  assert.ok(replyCalls[2].startsWith("🧠 Thought ·"),
    `replyCalls[2] must be the second reasoning summary; got: ${replyCalls[2]}`);
  assert.ok(replyCalls[2].includes("First bash command executed"),
    `second reasoning must summarize the second part; got: ${replyCalls[2]}`);

  assert.equal(replyCalls[3], "OK",
    `replyCalls[3] must be the final text reply; got: ${replyCalls[3]}`);
});

test("user scenario C: R → T → Text → R → T → Text produces [R, T, Text, R, T, Text] — separate tools get individual summaries", async () => {
  // Per user-stated rule: "如果t是分开的就单独发，如果t是连续的就一起发"
  // (separate tools get individual summaries, consecutive tools get combined).
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "r1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "**R1** First reasoning." },
    { id: "t1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "c1", state: { status: "completed", title: "T1" } },
    { id: "tx1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "TEXT-1" },
    { id: "r2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "**R2** Second reasoning." },
    { id: "t2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "glob", callID: "c2", state: { status: "completed", title: "T2" } },
    { id: "tx2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "TEXT-2" },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Expected WeChat order: [R1, 🔧(T1), TEXT-1, R2, 🔧(T2), TEXT-2]
  // Each separate tool gets its own summary line.
  assert.equal(replyCalls.length, 6,
    `expected 6 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);

  assert.ok(replyCalls[0].startsWith("🧠 Thought ·"), `call #0 must be R1; got: ${replyCalls[0]}`);
  assert.ok(replyCalls[1].startsWith("🔧 Tools:"), `call #1 must be T1 summary; got: ${replyCalls[1]}`);
  assert.ok(replyCalls[1].includes("bash"), "T1 summary must list bash");
  assert.ok(!replyCalls[1].includes("glob"), "T1 summary must NOT list glob (T2 not yet tracked in batch)");
  assert.equal(replyCalls[2], "TEXT-1", `call #2 must be TEXT-1; got: ${replyCalls[2]}`);

  assert.ok(replyCalls[3].startsWith("🧠 Thought ·"), `call #3 must be R2; got: ${replyCalls[3]}`);
  assert.ok(replyCalls[4].startsWith("🔧 Tools:"), `call #4 must be T2 summary; got: ${replyCalls[4]}`);
  assert.ok(replyCalls[4].includes("glob"), "T2 summary must list glob");
  assert.ok(!replyCalls[4].includes("bash"), "T2 summary must NOT list bash (already in earlier summary)");
  assert.equal(replyCalls[5], "TEXT-2", `call #5 must be TEXT-2; got: ${replyCalls[5]}`);

  // Both tool callIDs must be in the "summarized" set so a re-flush
  // is a no-op.
  assert.equal(turn.toolCallIdsInLastSummary.size, 2,
    "both T1 and T2 must be marked as already summarized");
});

test("reasoning duration is per-part (NOT cumulative across tools between parts)", async () => {
  // Regression: a second reasoning part that actually took 1.2s used
  // to show as 21.6s because the duration was computed from the
  // first reasoning's startMs to the latest delta's endMs, which
  // spans any tool calls interleaved between reasoning parts. The
  // fix uses per-part streaming timestamps in
  // `turn.reasoningPartTimestamps`, so each reasoning line shows
  // its OWN thinking time.
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  // R1 (~900ms), tool (~20s in real time, but we don't simulate that
  // gap — we just need the per-part endMs to reflect each reasoning's
  // OWN duration, not span the tool call in between).
  sm["accumulateReasoningDelta"](turn,
    { id: "r1", sessionID: "s", messageID: turn.assistantMessageId, type: "reasoning", text: "" },
    "**R1** first think");
  // Simulate that R1 took 900ms (we set per-part startMs to 900ms ago)
  {
    const ts = turn.reasoningPartTimestamps.get("r1");
    ts.startMs = Date.now() - 900;
    ts.endMs = Date.now();
  }
  sm["handleEvent"]({
    type: "message.part.updated",
    properties: { sessionID: "s", part: { id: "r1", sessionID: "s", messageID: turn.assistantMessageId, type: "reasoning", text: "**R1** first think" } },
  });

  sm["handleEvent"]({
    type: "message.part.updated",
    properties: { sessionID: "s", part: { id: "t1", sessionID: "s", messageID: turn.assistantMessageId, type: "tool", tool: "bash", callID: "c1", state: { status: "completed", title: "long bash" } } },
  });

  // R2 (~1.2s) — even though the previous reasoning's endMs was 20s
  // ago in real time (when the bash finished), the per-part
  // startMs/endMs should reflect ONLY R2's own streaming window.
  sm["accumulateReasoningDelta"](turn,
    { id: "r2", sessionID: "s", messageID: turn.assistantMessageId, type: "reasoning", text: "" },
    "**R2** second think");
  {
    const ts = turn.reasoningPartTimestamps.get("r2");
    ts.startMs = Date.now() - 1200;
    ts.endMs = Date.now();
  }
  sm["handleEvent"]({
    type: "message.part.updated",
    properties: { sessionID: "s", part: { id: "r2", sessionID: "s", messageID: turn.assistantMessageId, type: "reasoning", text: "**R2** second think" } },
  });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Expect: [R1=900ms, 🔧(bash), R2=1.2s] — 3 messages.
  assert.equal(replyCalls.length, 3,
    `expected 3 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);

  // R1: ~900ms (per-part duration, not cumulative)
  assert.ok(replyCalls[0].includes("· 900ms") || replyCalls[0].includes("· 901ms") || replyCalls[0].includes("· 899ms"),
    `R1 must show ~900ms; got: ${replyCalls[0]}`);
  assert.ok(!replyCalls[0].includes("21.6s"),
    `R1 must NOT show the cumulative 21.6s; got: ${replyCalls[0]}`);

  // Tool summary
  assert.ok(replyCalls[1].includes("bash"),
    `tool summary must list bash; got: ${replyCalls[1]}`);

  // R2: ~1.2s (per-part duration, NOT 21.6s)
  assert.ok(replyCalls[2].includes("· 1.2s") || replyCalls[2].includes("· 1.1s") || replyCalls[2].includes("· 1.3s"),
    `R2 must show ~1.2s per-part; got: ${replyCalls[2]}`);
  assert.ok(!replyCalls[2].includes("21.6s"),
    `R2 must NOT show the cumulative 21.6s; got: ${replyCalls[2]}`);
});

test("consecutive tools get combined: R → T1, T2, T3 → R → Text produces [R, 🔧(T1,T2,T3), R, Text]", async () => {
  // Per user-stated rule: consecutive tools (no non-tool event between
  // them) get a single combined summary.
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "r1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "**R1**" },
    { id: "t1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "c1", state: { status: "completed" } },
    { id: "t2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "glob", callID: "c2", state: { status: "completed" } },
    { id: "t3", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "cron", callID: "c3", state: { status: "completed" } },
    { id: "r2", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "**R2**" },
    { id: "tx", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "TEXT" },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Expected: [R1, 🔧(T1,T2,T3), R2, TEXT] — 4 messages.
  assert.equal(replyCalls.length, 4,
    `expected 4 onReply calls; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);

  assert.ok(replyCalls[0].startsWith("🧠 Thought ·"), `call #0 must be R1; got: ${replyCalls[0]}`);
  assert.ok(replyCalls[1].startsWith("🔧 Tools:"), `call #1 must be the combined tool summary; got: ${replyCalls[1]}`);
  assert.ok(replyCalls[1].includes("bash") && replyCalls[1].includes("glob") && replyCalls[1].includes("cron"),
    "combined summary must list all 3 consecutive tools");
  assert.ok(replyCalls[2].startsWith("🧠 Thought ·"), `call #2 must be R2; got: ${replyCalls[2]}`);
  assert.equal(replyCalls[3], "TEXT", `call #3 must be TEXT; got: ${replyCalls[3]}`);
});

// ────────────────────────────────────────────────────────────────────────
// Category 4d: Tool title display — the user's reported gap was that
// tools with no info shown (e.g. `✅ webfetch` with no URL/title). The
// fix is simple: render `state.title` (the opencode-generated one-line
// summary the tool itself sets) after the tool name. The user explicitly
// asked for the title ONLY — no formatting of the model-supplied args.
//
// Format: `emoji name [title]` (optionally ` (sub-agent)` for task/subtask).
// When `state.title` is empty (the tool part arrived before the tool
// finished, or the tool didn't set a title) the line is rendered as
// just `emoji name` (option-B per user — show that the tool was called
// even if there's no info yet). Titles longer than 80 chars are
// truncated with an ellipsis.
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("toolTitleDisplay (5 cases)");

test("tool summary shows title when state.title is set (webfetch → URL)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["c1", {
        callID: "c1",
        toolName: "webfetch",
        status: "completed",
        title: "https://httpbin.org/get",
        isSubAgent: false,
      }],
    ]),
  });
  const textPart = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "ok" };
  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();

  const toolLine = replyCalls[0].split("\n").find((l) => l.includes("webfetch"));
  assert.ok(toolLine && toolLine.includes("https://httpbin.org/get"),
    `tool line must show the opencode-generated title; got: ${toolLine}`);
  assert.equal(toolLine, "  ✅ webfetch https://httpbin.org/get",
    `expected exact format '✅ webfetch <title>'; got: ${JSON.stringify(toolLine)}`);
});

test("tool summary shows just emoji + name when state.title is EMPTY (option B)", async () => {
  // The user explicitly chose option B: even with no title, show the
  // line so the user knows the tool was called. (Option A would have
  // skipped the line entirely — but a bare '🔧 Tools:' header with no
  // entries is confusing.)
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["c1", {
        callID: "c1",
        toolName: "webfetch",
        status: "running",        // running tools often have no title yet
        title: undefined,
        isSubAgent: false,
      }],
    ]),
  });
  const textPart = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "ok" };
  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();

  const toolLine = replyCalls[0].split("\n").find((l) => l.includes("webfetch"));
  assert.equal(toolLine, "  ⏳ webfetch",
    `no-title tools must show just '⏳ webfetch' (option B); got: ${JSON.stringify(toolLine)}`);
});

test("tool summary shows distinct title for bash (e.g. 'exit 0')", async () => {
  // Common real-world case: bash's title is the exit code, not the
  // command. We render whatever the tool put in the title.
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["c1", {
        callID: "c1",
        toolName: "bash",
        status: "completed",
        title: "exit 0",
        isSubAgent: false,
      }],
    ]),
  });
  const textPart = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "ok" };
  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();

  const toolLine = replyCalls[0].split("\n").find((l) => l.includes("bash"));
  assert.equal(toolLine, "  ✅ bash exit 0",
    `bash must show the title; got: ${JSON.stringify(toolLine)}`);
});

test("tool summary truncates long titles to 80 chars with ellipsis", async () => {
  // opencode's `task` tool (sub-agent dispatch) can produce a long
  // report header as its title. 80 chars + '…' keeps the summary
  // readable when a sub-agent finishes mid-turn.
  const longTitle = "T".repeat(200);
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["c1", {
        callID: "c1",
        toolName: "bash",
        status: "completed",
        title: longTitle,
        isSubAgent: false,
      }],
    ]),
  });
  const textPart = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "ok" };
  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();

  const toolLine = replyCalls[0].split("\n").find((l) => l.includes("bash"));
  // '  ✅ bash ' is 9 chars, then 79 'T's, then '…' = 89 chars total.
  assert.equal(toolLine.length, 89,
    `truncated line must be 89 chars (9 prefix + 79 T + 1 ellipsis); got ${toolLine.length}: ${JSON.stringify(toolLine)}`);
  assert.ok(toolLine.endsWith("…"),
    `truncated line must end with ellipsis; got: ${JSON.stringify(toolLine)}`);
});

test("tool summary: sub-agent (task tool) gets ' (sub-agent)' suffix", async () => {
  // When the model dispatches a sub-agent, we want to flag that the
  // tool call isn't a leaf operation but a background worker.
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({
    showToolsSnapshot: true,
    toolCalls: new Map([
      ["c1", {
        callID: "c1",
        toolName: "task",
        status: "completed",
        title: "Explore PR #1234",
        isSubAgent: true,
      }],
    ]),
  });
  const textPart = { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text", text: "ok" };
  sm["maybeSendTextPart"](turn, textPart);
  await Promise.resolve();

  const toolLine = replyCalls[0].split("\n").find((l) => l.includes("task"));
  assert.equal(toolLine, "  ✅ task Explore PR #1234 (sub-agent)",
    `sub-agent line must append ' (sub-agent)' after the title; got: ${JSON.stringify(toolLine)}`);
});

// ────────────────────────────────────────────────────────────────────────
// Category 5: /thought removal — parser rejects legacy /thought, and
// bridgeCommands array (read from src/bridge.ts as TEXT — do NOT instantiate
// the bridge) does NOT contain "thinking".
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("thoughtRemoval (2 cases)");

test("parseThoughtDisplayCommand('/thought on') returns null", () => {
  assert.equal(parseThoughtDisplayCommand("/thought on"), null);
});

test("bridgeCommands array in src/bridge.ts does NOT contain 'thinking'", () => {
  // Read the source as text — we don't want to instantiate the heavy bridge.
  // Per the plan, the detection list (lines 1635-1641) must contain
  // "thought-display" (the NEW name) and must NOT contain "thinking" or
  // bare "thought" as the legacy shortcut.
  const bridgeSrc = fs.readFileSync(
    path.resolve(process.cwd(), "src/bridge.ts"),
    "utf-8",
  );
  // Locate the bridgeCommands array literal.
  const arrMatch = bridgeSrc.match(/bridgeCommands\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(arrMatch, "bridgeCommands array literal must be present in src/bridge.ts");
  const arrBody = arrMatch[1];
  // Parse the quoted string entries.
  const entries = Array.from(arrBody.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  assert.ok(entries.includes("thought-display"),
    `bridgeCommands must include 'thought-display'; got: ${JSON.stringify(entries)}`);
  assert.ok(!entries.includes("thinking"),
    `bridgeCommands must NOT include 'thinking'; got: ${JSON.stringify(entries)}`);
});

// ────────────────────────────────────────────────────────────────────────
// Category 6: /help updates — formatHelp / formatHelpWithNativeCommands
// must include the new sections and must NOT contain the legacy "── 思考 ──"
// header (no "显示" suffix).
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("helpUpdates (3 cases)");

test("formatHelp contains '── 思考显示 ──' section header", () => {
  const help = formatHelp();
  assert.ok(help.includes("── 思考显示 ──"),
    `formatHelp must contain '── 思考显示 ──'; got first 200 chars: ${help.slice(0, 200)}`);
});

test("formatHelp contains '── 工具显示 ──' section header", () => {
  const help = formatHelp();
  assert.ok(help.includes("── 工具显示 ──"),
    `formatHelp must contain '── 工具显示 ──'`);
});

test("formatHelp does NOT contain legacy '── 思考 ──' (exact match, no suffix)", () => {
  const help = formatHelp();
  // The legacy section header was exactly "── 思考 ──" with no "显示" suffix.
  assert.ok(!help.includes("── 思考 ──"),
    `formatHelp must NOT contain legacy '── 思考 ──'`);
});

// Bonus: formatHelpWithNativeCommands must also reflect the update so the
// runtime `/help` reply (which calls formatHelpWithNativeCommands, not
// formatHelp) also shows the new sections.
test("formatHelpWithNativeCommands contains both new sections", () => {
  const help = formatHelpWithNativeCommands([]);
  assert.ok(help.includes("── 思考显示 ──"),
    `formatHelpWithNativeCommands must contain '── 思考显示 ──'`);
  assert.ok(help.includes("── 工具显示 ──"),
    `formatHelpWithNativeCommands must contain '── 工具显示 ──'`);
  assert.ok(!help.includes("── 思考 ──"),
    `formatHelpWithNativeCommands must NOT contain legacy '── 思考 ──'`);
});

// ────────────────────────────────────────────────────────────────────────
// Tool title derivation from input
//
// The LLM SDK does not always populate `state.title` (some models skip
// it for read-only tools like `glob` / `grep` / `webfetch`). The bridge
// must synthesize a one-line title from the tool's known input
// parameters so the WeChat summary is still useful.
// ────────────────────────────────────────────────────────────────────────

test("tool title derived from glob input when state.title is missing", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  // Note: no `title` field — the LLM SDK did not populate it.
  driveStream(sm, turn, [
    { id: "tool-glob", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "glob", callID: "g1", state: { status: "completed", input: { pattern: "**/*.ts" } } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "Done." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  assert.ok(summaryCall, `expected a 🔧 Tools summary; got: ${JSON.stringify(replyCalls)}`);
  assert.ok(summaryCall.includes("**/*.ts"),
    `summary should include derived pattern; got: ${summaryCall}`);
  assert.ok(summaryCall.includes("glob"),
    `summary should include tool name; got: ${summaryCall}`);
});

test("tool title derived from bash input (command truncated to 60 chars)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  const longCommand = "echo " + "x".repeat(80);
  driveStream(sm, turn, [
    { id: "tool-bash", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "b1", state: { status: "completed", input: { command: longCommand } } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "OK" },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  assert.ok(summaryCall, `expected a 🔧 Tools summary; got: ${JSON.stringify(replyCalls)}`);
  // The derived title should contain the start of the command and the ellipsis marker.
  assert.ok(summaryCall.includes("echo xxx"),
    `summary should include the start of the long command; got: ${summaryCall}`);
  assert.ok(summaryCall.includes("…"),
    `summary should truncate long commands with ellipsis; got: ${summaryCall}`);
  // And it must NOT include the full 80-char x run (that would mean we forgot to truncate).
  assert.ok(!summaryCall.includes("x".repeat(80)),
    `summary must truncate the 80-char run; got: ${summaryCall}`);
});

test("tool title derived from webfetch url", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "tool-fetch", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "webfetch", callID: "w1", state: { status: "running", input: { url: "https://example.com/docs" } } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "Fetched." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  assert.ok(summaryCall, `expected a 🔧 Tools summary; got: ${JSON.stringify(replyCalls)}`);
  assert.ok(summaryCall.includes("https://example.com/docs"),
    `summary should include the url; got: ${summaryCall}`);
  assert.ok(summaryCall.includes("⏳"),
    `running tool should still be ⏳ in summary; got: ${summaryCall}`);
});

test("state.title (when present) takes priority over derived input title", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "tool-glob", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "glob", callID: "g1",
      state: { status: "completed", title: "Finding TypeScript files", input: { pattern: "**/*.ts" } } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "Done." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  assert.ok(summaryCall, `expected a 🔧 Tools summary; got: ${JSON.stringify(replyCalls)}`);
  assert.ok(summaryCall.includes("Finding TypeScript files"),
    `summary should use the LLM-supplied title; got: ${summaryCall}`);
  // The raw pattern should NOT appear in the summary if the title was used.
  assert.ok(!summaryCall.includes("**/*.ts"),
    `summary must NOT fall back to input when title is present; got: ${summaryCall}`);
});

test("tool summary still works when tool has neither title nor input (just tool name)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "tool-unknown", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "mystery", callID: "m1", state: { status: "completed" } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "Done." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  assert.ok(summaryCall, `expected a 🔧 Tools summary; got: ${JSON.stringify(replyCalls)}`);
  // Should still render the line — just the tool name + status emoji, no title slot.
  assert.ok(summaryCall.includes("mystery"),
    `summary should at least show the tool name; got: ${summaryCall}`);
  assert.ok(summaryCall.includes("✅"),
    `summary should show completion status; got: ${summaryCall}`);
});

// ────────────────────────────────────────────────────────────────────────
// Reasoning-part buffering (Bug 1) and buffered text-part positioning (Bug 2)
//
// The OpenCode server sometimes streams `message.part.updated` for the
// assistant's first reasoning or text part BEFORE emitting
// `message.updated role=assistant`. Without buffering, the part is
// dropped because `part.messageID` cannot yet be matched against
// `turn.assistantMessageId` (which is still null). With buffering, the
// part is held in `pendingReasoningParts` / `pendingTextParts` until
// the assistant message arrives, then flushed.
//
// For Bug 2 specifically: when a buffered text part is flushed, the
// tool-summary flush is SKIPPED — otherwise any tools tracked between
// the buffer and the flush would be inserted in front of a text part
// that, in the model's natural output order, came BEFORE them.
// ────────────────────────────────────────────────────────────────────────

test("reasoning part arriving before assistantMessageId is buffered and flushed once ID is known", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: false });

  // CRITICAL: assistantMessageId starts as null. The reasoning part
  // must be buffered, not dropped.
  const turn = makeTurnForReasoningTest({ assistantMessageId: null });
  sm["currentTurn"] = turn;

  // Simulate the server race: reasoning part arrives before the
  // message.updated event for the assistant.
  driveStream(sm, turn, [
    { id: "rp-1", sessionID: turn.sessionId, messageID: "am-not-yet-known", type: "reasoning",
      text: "**Planning the first step**\n\nThis is the body the user never sees in WeChat." },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();
  // Nothing should have been sent yet — the part is buffered.
  assert.equal(replyCalls.length, 0,
    `reasoning part must be buffered, not sent; got: ${JSON.stringify(replyCalls)}`);
  assert.equal(turn.pendingReasoningParts.length, 1,
    "the reasoning part must be sitting in pendingReasoningParts");

  // Patch the buffered part's messageID so it matches the now-known
  // ID. (In a real scenario the server would have re-delivered the
  // part with the correct ID; here we just mutate the buffered part
  // to simulate that post-ID state, BEFORE the flush runs.)
  turn.pendingReasoningParts[0].messageID = "am-1";

  // Now the assistant message arrives. The flush should replay the
  // buffered part with a matching messageID.
  sm["handleMessageUpdated"]({
    type: "message.updated",
    properties: {
      sessionID: turn.sessionId,
      info: { id: "am-1", role: "assistant" },
    },
  });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // Now the reasoning summary should have been sent.
  assert.equal(replyCalls.length, 1,
    `expected 1 onReply call after flush; got: ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🧠 Thought · "),
    `expected thought header; got: ${replyCalls[0]}`);
  assert.equal(turn.pendingReasoningParts.length, 0,
    "the buffered reasoning part must be drained after flush");
});

test("buffered reasoning part with non-matching messageID is dropped (user-input echo)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: false });

  const turn = makeTurnForReasoningTest({ assistantMessageId: null });
  sm["currentTurn"] = turn;

  // A user-side reasoning part with a messageID that will never match
  // the assistant's. Should be buffered, then dropped at flush time.
  driveStream(sm, turn, [
    { id: "rp-1", sessionID: turn.sessionId, messageID: "user-echo", type: "reasoning",
      text: "**User echo reasoning**\n\nShould never be sent to WeChat." },
  ]);

  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(turn.pendingReasoningParts.length, 1,
    "the reasoning part must be buffered");

  // Assistant message arrives with a DIFFERENT messageID.
  sm["handleMessageUpdated"]({
    type: "message.updated",
    properties: {
      sessionID: turn.sessionId,
      info: { id: "am-1", role: "assistant" },
    },
  });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // The buffered part's messageID ("user-echo") does NOT match the
  // assistant's ("am-1"), so it must be dropped, not sent.
  assert.equal(replyCalls.length, 0,
    `non-matching reasoning part must be dropped at flush; got: ${JSON.stringify(replyCalls)}`);
  assert.equal(turn.pendingReasoningParts.length, 0,
    "the buffered part must be drained even when dropped");
});

test("buffered text part does NOT flush tools tracked after the buffer (preserves natural order)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  // The natural output order in the model's stream is:
  //   text "OK" (then tool webfetch, then reasoning)
  // The events arrive as: text "OK" (buffered, assistantMessageId null)
  //   → tool webfetch tracked → assistant message arrives → text flushed.
  // The user wants the OUTPUT order to be: text "OK", then tool summary,
  // then reasoning — i.e. the text part should NOT be preceded by the
  // tool summary, because the text came BEFORE the tool in the model's
  // stream.
  const turn = makeTurnForReasoningTest({
    assistantMessageId: null,
    showToolsSnapshot: true,
  });
  sm["currentTurn"] = turn;

  // 1. Text "OK" arrives while assistantMessageId is null — buffered.
  driveStream(sm, turn, [
    { id: "tp-1", sessionID: turn.sessionId, messageID: "am-not-yet-known", type: "text", text: "OK" },
  ]);
  for (let i = 0; i < 3; i++) await Promise.resolve();
  assert.equal(turn.pendingTextParts.length, 1, "text part must be buffered");

  // 2. Tool webfetch is tracked AFTER the text part was buffered.
  driveStream(sm, turn, [
    { id: "tool-webfetch", sessionID: turn.sessionId, messageID: "am-1", type: "tool",
      tool: "webfetch", callID: "w1", state: { status: "completed", input: { url: "https://example.com" } } },
  ]);
  for (let i = 0; i < 3; i++) await Promise.resolve();

  // 3. Patch the buffered text part's messageID so it matches the
  //    now-known ID. (Real server would re-deliver with the correct
  //    ID; here we mutate to simulate that post-ID state, BEFORE the
  //    flush runs.)
  turn.pendingTextParts[0].messageID = "am-1";

  // Assistant message arrives — flushes the buffered text part.
  //    The tool summary must NOT be flushed ahead of the text part,
  //    because the text came first in the model's natural order.
  sm["handleMessageUpdated"]({
    type: "message.updated",
    properties: {
      sessionID: turn.sessionId,
      info: { id: "am-1", role: "assistant" },
    },
  });

  for (let i = 0; i < 5; i++) await Promise.resolve();

  // The text "OK" was sent. The webfetch tool summary was NOT sent
  // (it stays in toolCalls, waiting for the next non-tool boundary).
  assert.equal(replyCalls.length, 1,
    `expected 1 onReply (the text "OK"); got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "OK",
    `text part must be sent; got: ${replyCalls[0]}`);
  assert.equal(turn.toolCallIdsInLastSummary.size, 0,
    "no tool summary may be flushed ahead of the buffered text part");
  // The tool is still tracked, awaiting flush at the next non-tool boundary.
  assert.equal(turn.toolCalls.size, 1, "the webfetch tool is still tracked");
  assert.ok(turn.toolCalls.has("w1"), "webfetch is still in toolCalls");
});

// ────────────────────────────────────────────────────────────────────────
// No-reasoning scenarios (models that don't emit reasoning)
//
// Some models / providers never emit `reasoning` parts at all, and
// some emit reasoning parts with empty or whitespace-only text
// (e.g. when reasoning was disabled mid-stream). The bridge must:
//   1. Not emit any `🧠 Thought` line when there are zero reasoning
//      parts in the turn (showThoughts=on or off).
//   2. Skip empty / whitespace-only reasoning parts entirely (no
//      header, no off-mode metric increment).
//   3. Deduplicate reasoning parts by `part.id` so SSE replay /
//      reconnect does not send the same reasoning twice.
//   4. In off-mode, still flush the tool summary at the text part
//      (off-mode is only about reasoning, not about tool display).
// ────────────────────────────────────────────────────────────────────────

test("showThoughts=on with NO reasoning parts in the turn: zero 🧠 lines, only text + tools", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  // Model emits: T → Text — no reasoning at all.
  driveStream(sm, turn, [
    { id: "tool-bash", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "b1", state: { status: "completed", title: "echo hi" } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "Done." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  // Exactly 2 lines: the tool summary, then the text. NO thought line.
  assert.equal(replyCalls.length, 2,
    `expected 2 lines (tool summary + text); got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"),
    `first line must be tool summary; got: ${replyCalls[0]}`);
  assert.equal(replyCalls[1], "Done.",
    `second line must be the text; got: ${replyCalls[1]}`);
  // Belt-and-suspenders: no `🧠 Thought` anywhere in the output.
  for (const line of replyCalls) {
    assert.ok(!line.includes("🧠 Thought"),
      `output must not contain any thought line; got: ${line}`);
  }
  // Off-mode metric sanity: no reasoning char count since no parts arrived.
  assert.equal(turn.reasoningCharCount, 0,
    "no reasoning parts = no chars accumulated");
});

test("reasoning part with empty text is dropped (no header emitted in showThoughts=on)", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: false });

  const turn = makeTurnForReasoningTest();
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "rp-empty", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "" },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "hello" },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  // Only the text part is sent. Empty reasoning is silently dropped.
  assert.equal(replyCalls.length, 1,
    `expected 1 line (the text); got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "hello",
    `text must be sent; got: ${replyCalls[0]}`);
  // No `🧠 Thought` line at all (empty reasoning must not produce a header).
  for (const line of replyCalls) {
    assert.ok(!line.includes("🧠 Thought"),
      `empty reasoning must not produce a thought header; got: ${line}`);
  }
  // The empty part must NOT be added to sentReasoningPartIds (so a
  // later non-empty part with the same id would still be sent).
  assert.ok(!turn.sentReasoningPartIds.has("rp-empty"),
    "empty reasoning must not be added to sentReasoningPartIds");
});

test("reasoning part with whitespace-only text is dropped", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: false });

  const turn = makeTurnForReasoningTest();
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "rp-ws", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
      text: "   \n\t  \n  " },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "ok" },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(replyCalls.length, 1,
    `whitespace reasoning must be dropped; got: ${JSON.stringify(replyCalls)}`);
  assert.equal(replyCalls[0], "ok");
});

test("duplicate reasoning part (same id, SSE replay) is sent only ONCE", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  sm["setShowFlags"]({ showThoughts: true, showTools: false });

  const turn = makeTurnForReasoningTest();
  sm["currentTurn"] = turn;

  const reasoningPart = {
    id: "rp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "reasoning",
    text: "**Same part delivered twice**\n\nBody.",
  };
  // SSE replay: same part delivered 3 times.
  driveStream(sm, turn, [reasoningPart, reasoningPart, reasoningPart]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  // Exactly one thought line despite 3 deliveries.
  const thoughtLines = replyCalls.filter((m) => m.startsWith("🧠 Thought · "));
  assert.equal(thoughtLines.length, 1,
    `reasoning must be sent exactly once; got ${thoughtLines.length}: ${JSON.stringify(thoughtLines)}`);
  assert.ok(thoughtLines[0].includes("Same part delivered twice"),
    `summary should come from the part's body; got: ${thoughtLines[0]}`);
});

test("showThoughts=off with no reasoning: tool summary still flushes at text boundary", async () => {
  const replyCalls = [];
  const sm = new SessionManager({
    serverUrl: "http://127.0.0.1:65535",
    cwd: process.cwd(),
    log: () => {},
    onReply: async (_ctx, text) => { replyCalls.push(text); },
    onMediaReply: async () => {},
    sendTyping: async () => {},
  });
  // showThoughts OFF, showTools ON. Verifies that off-mode for
  // reasoning does not bleed into tool-summary behavior.
  sm["setShowFlags"]({ showThoughts: false, showTools: true });

  const turn = makeTurnForReasoningTest({ showToolsSnapshot: true });
  sm["currentTurn"] = turn;

  driveStream(sm, turn, [
    { id: "tool-bash", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "tool",
      tool: "bash", callID: "b1", state: { status: "completed", title: "echo hi" } },
    { id: "tp-1", sessionID: turn.sessionId, messageID: turn.assistantMessageId, type: "text",
      text: "All done." },
  ]);

  for (let i = 0; i < 10; i++) await Promise.resolve();

  // Tool summary + text, no thought line.
  assert.equal(replyCalls.length, 2,
    `expected tool summary + text; got ${replyCalls.length}: ${JSON.stringify(replyCalls)}`);
  assert.ok(replyCalls[0].startsWith("🔧 Tools:"),
    `tool summary must be flushed at text boundary even in showThoughts=off; got: ${replyCalls[0]}`);
  assert.equal(replyCalls[1], "All done.");
});

// ────────────────────────────────────────────────────────────────────────
// Summary — wait for all async tests to settle before printing/exiting
// ────────────────────────────────────────────────────────────────────────
await Promise.all(pendingPromises);
const total = passed + failed;
console.log("");
if (failed === 0) {
  console.log(`PASS: ${passed}/${total}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${passed}/${total} passed, ${failed} failed`);
  process.exit(1);
}