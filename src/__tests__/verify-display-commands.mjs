/**
 * src/__tests__/verify-display-commands.mjs
 *
 * Comprehensive end-to-end verification harness for the
 * /thought-display + /tool-display feature (display-commands plan, Task 7).
 *
 * Runs all 10 acceptance categories from the plan against
 * the COMPILED dist/ artifacts. Driven by vitest; run via `npm test`
 * after `npm run build`.
 *
 * Categories:
 *   1. parsers               — 14 cases (7 per parser; mirrors test-parsers.mjs)
 *   2. pureFunctions         — 6 cases (reasoningSummary, formatThoughtHeader, formatDuration)
 *   3. persistence           — 4 cases (round-trip, undefined-field omission, legacy compat, old-shape)
 *   4. commandIndependence   — 1 case (setShowFlags partial update is safe)
 *   5. reasoningPartDisplay  — 4 cases
 *   6. toolSummaryOrdering   — 4 cases
 *   7. chronologicalOrder    — 2 cases
 *   8. toolTitleDisplay      — 5 cases
 *   9. thoughtRemoval        — 2 cases (legacy /thought rejected; bridgeCommands omits "thinking")
 *   10. helpUpdates          — 3 cases
 */

import { test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  parseThoughtDisplayCommand,
  parseToolDisplayCommand,
  formatHelp,
  formatHelpWithNativeCommands,
} from "../../dist/src/adapter/workspace-cmd.js";
import {
  reasoningSummary,
  formatThoughtHeader,
  formatDuration,
} from "../../dist/src/adapter/thinking-format.js";
import { SessionManager } from "../../dist/src/server/session.js";

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
    expect(actual).toEqual(c.expected);
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
  expect(r.title).toBe("Inspecting PR workflow");
  expect(r.body).toBe("Looking at the diff...");
  expect(r.summary).toBe("Inspecting PR workflow");
});

test("reasoningSummary returns null title when no marker; summary falls back to first line", () => {
  const r = reasoningSummary("Just thinking out loud here.");
  expect(r.title).toBe(null);
  expect(r.body).toBe("Just thinking out loud here.");
  expect(r.summary).toBe("Just thinking out loud here.");
});

test("reasoningSummary strips [REDACTED] placeholders", () => {
  const r = reasoningSummary("**My plan**\n\n[REDACTED] some secret [REDACTED] more text");
  expect(r.title).toBe("My plan");
  expect(r.body).toBe("some secret  more text");
  expect(r.body.includes("[REDACTED]")).toBeFalsy();
  expect(r.summary).toBe("My plan");
});

test("formatThoughtHeader includes summary and duration", () => {
  expect(formatThoughtHeader(2300, "Inspecting PR workflow")).toBe("🧠 Thought · Inspecting PR workflow · 2.3s");
});

test("formatThoughtHeader omits summary segment when summary is empty", () => {
  expect(formatThoughtHeader(450, "")).toBe("🧠 Thought · 450ms");
});

test("formatThoughtHeader with first-line fallback summary (no **Title** marker)", () => {
  expect(formatThoughtHeader(187, "Just thinking out loud here.")).toBe("🧠 Thought · Just thinking out loud here. · 187ms");
});

test("formatDuration handles sub-second and multi-second boundaries", () => {
  expect(formatDuration(450)).toBe("450ms");
  expect(formatDuration(999)).toBe("999ms");
  expect(formatDuration(1000)).toBe("1.0s");
  expect(formatDuration(2345)).toBe("2.3s");
  expect(formatDuration(12700)).toBe("12.7s");
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
    expect(loaded.userId).toBe("u1");
    expect(loaded.sessionId).toBe("sess-1");
    expect(loaded.cwd).toBe("C:/work/proj");
    expect(loaded.showThoughts).toBe(true);
    expect(loaded.showTools).toBe(false);

    // Mutate and save
    loaded.showThoughts = false;
    loaded.showTools = true;
    saveUserState(stateFile, loaded);

    const reloaded = loadUserState(stateFile);
    expect(reloaded.showThoughts).toBe(false);
    expect(reloaded.showTools).toBe(true);
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
    expect(raw.includes('"showThoughts"')).toBeFalsy();
    expect(raw.includes('"showTools"')).toBeTruthy();
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
    expect(loaded).toBeTruthy();
    expect(loaded.sessionId).toBe("sess-old");
    expect(loaded.cwd).toBe("C:/old/proj");
    expect(loaded.showThoughts).toBe(undefined);
    expect(loaded.showTools).toBe(undefined);
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
    expect(loaded).toBeTruthy();
    expect(loaded.userId).toBe("u-old");
    expect(loaded.sessionId).toBe("sess-old");
    expect(loaded.cwd).toBe("C:/old/proj");
    expect(loaded.showThoughts).toBe(undefined);
    expect(loaded.showTools).toBe(undefined);
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
  expect(sm["getShowFlags"]()).toEqual({ showThoughts: true, showTools: true });

  // Partial update: only flip showThoughts. showTools must remain unchanged.
  sm["setShowFlags"]({ showThoughts: false });
  const after = sm["getShowFlags"]();
  expect(after.showThoughts).toBe(false);
  expect(after.showTools).toBe(true);

  // And the snapshot accessor must agree (no turn active, so it returns live flags)
  const snapshotView = sm["getShowFlagsForTurn"]();
  expect(snapshotView).toEqual({ showThoughts: false, showTools: true });

  // Symmetric case: only flip showTools, showThoughts must remain.
  sm["setShowFlags"]({ showThoughts: true, showTools: false }); // reset
  sm["setShowFlags"]({ showTools: true });
  const after2 = sm["getShowFlags"]();
  expect(after2.showThoughts).toBe(true);
  expect(after2.showTools).toBe(true);
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
  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("🧠 Thought · Inspecting PR workflow · 1.9s");

  // And the part must be marked as sent (dedup works).
  expect(turn.sentReasoningPartIds.has("rp-1")).toBeTruthy();
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

  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("🧠 Thought · Just thinking out loud here. · 1.9s");
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

  expect(replyCalls.length).toBe(0);
  expect(turn.sentReasoningPartIds.has("rp-3")).toBeFalsy();
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

  expect(replyCalls.length).toBe(0);
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
  expect(replyCalls.length).toBe(2);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[0].includes("bash") && replyCalls[0].includes("lsp_status")).toBeTruthy();
  expect(replyCalls[1]).toBe(textPart.text);

  // After flushing, all tracked callIDs must be in the "summarized" set
  // so a subsequent flush for the same tools is a no-op.
  expect(turn.toolCallIdsInLastSummary.size).toBe(2);
  expect(turn.toolCallIdsInLastSummary.has("call-1")).toBeTruthy();
  expect(turn.toolCallIdsInLastSummary.has("call-2")).toBeTruthy();
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
  expect(replyCalls.length).toBe(4);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1]).toBe("First text chunk.");
  expect(replyCalls[2]).toBe("Second text chunk.");
  expect(replyCalls[3]).toBe("Third text chunk.");
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
  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("Just the text.");
  expect(turn.toolCallIdsInLastSummary.size).toBe(0);
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

  expect(replyCalls.length).toBe(0);
  expect(turn.toolCallIdsInLastSummary.size).toBe(0);
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
  expect(replyCalls.length).toBe(2);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(turn.toolCallIdsInLastSummary.size).toBe(2);
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

  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(turn.toolCallIdsInLastSummary.size).toBe(2);
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
    sm["flushNowForTest"]();

  // Expected WeChat order: [R1, T-summary, R2, text]
  expect(replyCalls.length).toBe(4);

  expect(replyCalls[0].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[0].includes("The user is just testing")).toBeTruthy();

  expect(replyCalls[1].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1].includes("bash") && replyCalls[1].includes("lsp_status") &&
            replyCalls[1].includes("cron_list") && replyCalls[1].includes("glob")).toBeTruthy();

  expect(replyCalls[2].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[2].includes("The user just wants to test")).toBeTruthy();

  expect(replyCalls[3]).toBe("几个工具测试通过 ✅\n\n| 工具 | 结果 |\n| ... | ... |");
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
    sm["flushNowForTest"]();

  // Expected WeChat order: [R1, T-summary, R2, "OK"]
  expect(replyCalls.length).toBe(4);

  expect(replyCalls[0].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[0].includes("The user wants me to reply")).toBeTruthy();

  expect(replyCalls[1].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1].includes("bash")).toBeTruthy();

  expect(replyCalls[2].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[2].includes("First bash command executed")).toBeTruthy();

  expect(replyCalls[3]).toBe("OK");
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
    sm["flushNowForTest"]();

  // Expected WeChat order: [R1, 🔧(T1), TEXT-1, R2, 🔧(T2), TEXT-2]
  // Each separate tool gets its own summary line.
  expect(replyCalls.length).toBe(6);

  expect(replyCalls[0].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[1].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1].includes("bash")).toBeTruthy();
  expect(replyCalls[1].includes("glob")).toBeFalsy();
  expect(replyCalls[2]).toBe("TEXT-1");

  expect(replyCalls[3].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[4].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[4].includes("glob")).toBeTruthy();
  expect(replyCalls[4].includes("bash")).toBeFalsy();
  expect(replyCalls[5]).toBe("TEXT-2");

  // Both tool callIDs must be in the "summarized" set so a re-flush
  // is a no-op.
  expect(turn.toolCallIdsInLastSummary.size).toBe(2);
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
    sm["flushNowForTest"]();

  // Expect: [R1=900ms, 🔧(bash), R2=1.2s] — 3 messages.
  expect(replyCalls.length).toBe(3);

  // R1: ~900ms (per-part duration, not cumulative)
  expect(replyCalls[0].includes("· 900ms") || replyCalls[0].includes("· 901ms") || replyCalls[0].includes("· 899ms")).toBeTruthy();
  expect(replyCalls[0].includes("21.6s")).toBeFalsy();

  // Tool summary
  expect(replyCalls[1].includes("bash")).toBeTruthy();

  // R2: ~1.2s (per-part duration, NOT 21.6s)
  expect(replyCalls[2].includes("· 1.2s") || replyCalls[2].includes("· 1.1s") || replyCalls[2].includes("· 1.3s")).toBeTruthy();
  expect(replyCalls[2].includes("21.6s")).toBeFalsy();
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
    sm["flushNowForTest"]();

  // Expected: [R1, 🔧(T1,T2,T3), R2, TEXT] — 4 messages.
  expect(replyCalls.length).toBe(4);

  expect(replyCalls[0].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[1].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1].includes("bash") && replyCalls[1].includes("glob") && replyCalls[1].includes("cron")).toBeTruthy();
  expect(replyCalls[2].startsWith("🧠 Thought ·")).toBeTruthy();
  expect(replyCalls[3]).toBe("TEXT");
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
  expect(toolLine && toolLine.includes("https://httpbin.org/get")).toBeTruthy();
  expect(toolLine).toBe("  ✅ webfetch https://httpbin.org/get");
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
  expect(toolLine).toBe("  ⏳ webfetch");
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
  expect(toolLine).toBe("  ✅ bash exit 0");
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
  expect(toolLine.length).toBe(89);
  expect(toolLine.endsWith("…")).toBeTruthy();
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
  expect(toolLine).toBe("  ✅ task Explore PR #1234 (sub-agent)");
});

// ────────────────────────────────────────────────────────────────────────
// Category 5: /thought removal — parser rejects legacy /thought, and
// bridgeCommands array (read from src/bridge.ts as TEXT — do NOT instantiate
// the bridge) does NOT contain "thinking".
// ────────────────────────────────────────────────────────────────────────
console.log("");
console.log("thoughtRemoval (2 cases)");

test("parseThoughtDisplayCommand('/thought on') returns null", () => {
  expect(parseThoughtDisplayCommand("/thought on")).toBe(null);
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
  expect(arrMatch).toBeTruthy();
  const arrBody = arrMatch[1];
  // Parse the quoted string entries.
  const entries = Array.from(arrBody.matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  expect(entries.includes("thought-display")).toBeTruthy();
  expect(entries.includes("thinking")).toBeFalsy();
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
  expect(help.includes("── 思考显示 ──")).toBeTruthy();
});

test("formatHelp contains '── 工具显示 ──' section header", () => {
  const help = formatHelp();
  expect(help.includes("── 工具显示 ──")).toBeTruthy();
});

test("formatHelp does NOT contain legacy '── 思考 ──' (exact match, no suffix)", () => {
  const help = formatHelp();
  // The legacy section header was exactly "── 思考 ──" with no "显示" suffix.
  expect(help.includes("── 思考 ──")).toBeFalsy();
});

// Bonus: formatHelpWithNativeCommands must also reflect the update so the
// runtime `/help` reply (which calls formatHelpWithNativeCommands, not
// formatHelp) also shows the new sections.
test("formatHelpWithNativeCommands contains both new sections", () => {
  const help = formatHelpWithNativeCommands([]);
  expect(help.includes("── 思考显示 ──")).toBeTruthy();
  expect(help.includes("── 工具显示 ──")).toBeTruthy();
  expect(help.includes("── 思考 ──")).toBeFalsy();
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
    sm["flushNowForTest"]();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  expect(summaryCall).toBeTruthy();
  expect(summaryCall.includes("**/*.ts")).toBeTruthy();
  expect(summaryCall.includes("glob")).toBeTruthy();
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
    sm["flushNowForTest"]();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  expect(summaryCall).toBeTruthy();
  // The derived title should contain the start of the command and the ellipsis marker.
  expect(summaryCall.includes("echo xxx")).toBeTruthy();
  expect(summaryCall.includes("…")).toBeTruthy();
  // And it must NOT include the full 80-char x run (that would mean we forgot to truncate).
  expect(summaryCall.includes("x".repeat(80))).toBeFalsy();
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
    sm["flushNowForTest"]();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  expect(summaryCall).toBeTruthy();
  expect(summaryCall.includes("https://example.com/docs")).toBeTruthy();
  expect(summaryCall.includes("⏳")).toBeTruthy();
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
    sm["flushNowForTest"]();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  expect(summaryCall).toBeTruthy();
  expect(summaryCall.includes("Finding TypeScript files")).toBeTruthy();
  // The raw pattern should NOT appear in the summary if the title was used.
  expect(summaryCall.includes("**/*.ts")).toBeFalsy();
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
    sm["flushNowForTest"]();

  const summaryCall = replyCalls.find((m) => m.startsWith("🔧 Tools:"));
  expect(summaryCall).toBeTruthy();
  // Should still render the line — just the tool name + status emoji, no title slot.
  expect(summaryCall.includes("mystery")).toBeTruthy();
  expect(summaryCall.includes("✅")).toBeTruthy();
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

  // Nothing should have been sent yet — the part is buffered.
  // (We do NOT call flushNowForTest here: that would run finalizeTurn
  // which drops the buffered part as a "user-input echo" before the
  // assistant message ID is even known.)
  expect(replyCalls.length).toBe(0);
  expect(turn.pendingReasoningParts.length).toBe(1);

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
    sm["flushNowForTest"]();

  // Now the reasoning summary should have been sent.
  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0].startsWith("🧠 Thought · ")).toBeTruthy();
  expect(turn.pendingReasoningParts.length).toBe(0);
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

  // (We do NOT call flushNowForTest here — that would run
  // finalizeTurn which drops the buffered part before the assistant
  // message ID is even known.)
  expect(turn.pendingReasoningParts.length).toBe(1);

  // Assistant message arrives with a DIFFERENT messageID.
  sm["handleMessageUpdated"]({
    type: "message.updated",
    properties: {
      sessionID: turn.sessionId,
      info: { id: "am-1", role: "assistant" },
    },
  });

  for (let i = 0; i < 5; i++) await Promise.resolve();
    sm["flushNowForTest"]();

  // The buffered part's messageID ("user-echo") does NOT match the
  // assistant's ("am-1"), so it must be dropped, not sent.
  expect(replyCalls.length).toBe(0);
  expect(turn.pendingReasoningParts.length).toBe(0);
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
  expect(turn.pendingTextParts.length).toBe(1);

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
    sm["flushNowForTest"]();

  // The text "OK" was sent. The webfetch tool summary was NOT sent
  // (it stays in toolCalls, waiting for the next non-tool boundary).
  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("OK");
  expect(turn.toolCallIdsInLastSummary.size).toBe(0);
  // The tool is still tracked, awaiting flush at the next non-tool boundary.
  expect(turn.toolCalls.size).toBe(1);
  expect(turn.toolCalls.has("w1")).toBeTruthy();
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
    sm["flushNowForTest"]();

  // Exactly 2 lines: the tool summary, then the text. NO thought line.
  expect(replyCalls.length).toBe(2);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1]).toBe("Done.");
  // Belt-and-suspenders: no `🧠 Thought` anywhere in the output.
  for (const line of replyCalls) {
    expect(line.includes("🧠 Thought")).toBeFalsy();
  }
  // Off-mode metric sanity: no reasoning char count since no parts arrived.
  expect(turn.reasoningCharCount).toBe(0);
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
    sm["flushNowForTest"]();

  // Only the text part is sent. Empty reasoning is silently dropped.
  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("hello");
  // No `🧠 Thought` line at all (empty reasoning must not produce a header).
  for (const line of replyCalls) {
    expect(line.includes("🧠 Thought")).toBeFalsy();
  }
  // The empty part must NOT be added to sentReasoningPartIds (so a
  // later non-empty part with the same id would still be sent).
  expect(turn.sentReasoningPartIds.has("rp-empty")).toBeFalsy();
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
    sm["flushNowForTest"]();

  expect(replyCalls.length).toBe(1);
  expect(replyCalls[0]).toBe("ok");
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
    sm["flushNowForTest"]();

  // Exactly one thought line despite 3 deliveries.
  const thoughtLines = replyCalls.filter((m) => m.startsWith("🧠 Thought · "));
  expect(thoughtLines.length).toBe(1);
  expect(thoughtLines[0].includes("Same part delivered twice")).toBeTruthy();
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
    sm["flushNowForTest"]();

  // Tool summary + text, no thought line.
  expect(replyCalls.length).toBe(2);
  expect(replyCalls[0].startsWith("🔧 Tools:")).toBeTruthy();
  expect(replyCalls[1]).toBe("All done.");
});

// ────────────────────────────────────────────────────────────────────────
// vitest handles test discovery, async awaiting, pass/fail reporting,
// and process exit. Nothing to do at the bottom of this file.
// ────────────────────────────────────────────────────────────────────────