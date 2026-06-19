/**
 * Unit tests for /thought-display, /tool-display, and /compact command parsers,
 * plus the agent-status / other-running-sessions extensions to `formatStatus`.
 *
 * Exercises all 14 acceptance cases from .omo/plans/display-commands.md (Task 2):
 *  - 7 cases per parser (on, off, status, enable alias, disable alias,
 *    unknown subcommand, no legacy alias / extra arg).
 *
 * Also exercises 7 cases for parseCompactCommand:
 *  - /compact bare, /summarize alias, mixed case, surrounding whitespace,
 *    and rejection of /compaction (different word), /compact foo (extra args),
 *    and /foo (not a slash command at all).
 *
 * The formatStatus block covers the two new optional fields added in
 * the /status-agent-sessions feature:
 *  - `agentStatus` (busy/idle/retry/null/undefined → 5 cases)
 *  - `otherBusySessions` (0, 5, null, undefined → 4 cases)
 *  - one full integration case rendering both lines together
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect } from "vitest";
import {
  parseThoughtDisplayCommand,
  parseToolDisplayCommand,
  parseCompactCommand,
  parseHistoryCommand,
  parseSilentCommand,
  formatStatus,
} from "../../dist/src/adapter/workspace-cmd.js";

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
  { input: "/tool-display on",              expected: { kind: "on" },     label: "on" },
  { input: "/tool-display off",             expected: { kind: "off" },    label: "off" },
  { input: "/tool-display status",          expected: { kind: "status" }, label: "status" },
  { input: "/tool-display enable",          expected: { kind: "on" },     label: "enable alias" },
  { input: "/tool-display disable",         expected: { kind: "off" },    label: "disable alias" },
  { input: "/tool-display foo",             expected: null,               label: "unknown subcommand" },
  { input: "/tool-display /thought on",     expected: null,               label: "extra arg rejected" },
];

const compactCases = [
  { input: "/compact",         expected: { kind: "compact" }, label: "/compact bare" },
  { input: "/summarize",       expected: { kind: "compact" }, label: "/summarize alias" },
  { input: "/COMPACT",         expected: { kind: "compact" }, label: "case-insensitive upper" },
  { input: "  /compact  ",     expected: { kind: "compact" }, label: "surrounding whitespace" },
  { input: "/Compact\n",       expected: { kind: "compact" }, label: "trailing newline" },
  { input: "/compaction",      expected: null,               label: "different word /compaction rejected" },
  { input: "/compact now",     expected: null,               label: "extra args rejected" },
  { input: "compact this",    expected: null,               label: "non-slash rejected" },
];

// 11 cases for parseHistoryCommand:
//   - bare /history → default count 5
//   - case-insensitive /HIST
//   - /history 10 → explicit count
//   - /hist 3 → short alias
//   - /hist 20 → boundary (max)
//   - rejections: 0, abc, -1, 999, 21, /historys
// The parser enforces a strict N (1-20) — no silent clamp — so a typo
// like "9999" rejects rather than returning 20 silently. The bridge
// handler treats `count` as already-validated; this unit test locks in
// the contract.
const historyCases = [
  { input: "/history",     expected: { kind: "history", count: 5 },  label: "bare /history → default 5" },
  { input: "/HIST",        expected: { kind: "history", count: 5 },  label: "case-insensitive /HIST" },
  { input: "/history 10",  expected: { kind: "history", count: 10 }, label: "explicit count 10" },
  { input: "/hist 3",      expected: { kind: "history", count: 3 },  label: "short alias + count" },
  { input: "/hist 20",     expected: { kind: "history", count: 20 }, label: "max boundary 20" },
  { input: "/history 0",   expected: null,                             label: "zero rejected" },
  { input: "/history abc", expected: null,                             label: "non-numeric rejected" },
  { input: "/history -1",  expected: null,                             label: "negative rejected" },
  { input: "/history 999", expected: null,                             label: "out-of-range 999 rejected (no silent clamp)" },
  { input: "/history 21",  expected: null,                             label: "out-of-range 21 rejected" },
  { input: "/historys",    expected: null,                             label: "different word /historys rejected" },
];

describe("parseThoughtDisplayCommand", () => {
  for (const c of thoughtCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseThoughtDisplayCommand(c.input)).toEqual(c.expected);
    });
  }
});

describe("parseToolDisplayCommand", () => {
  for (const c of toolCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseToolDisplayCommand(c.input)).toEqual(c.expected);
    });
  }
});

describe("parseCompactCommand", () => {
  for (const c of compactCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseCompactCommand(c.input)).toEqual(c.expected);
    });
  }
});

describe("parseHistoryCommand", () => {
  for (const c of historyCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseHistoryCommand(c.input)).toEqual(c.expected);
    });
  }
});

// 16 cases for parseSilentCommand (`/silent` / `/sl` — 沉浸模式):
//   - bare command defaults to status (most common entry point: "what's
//     my silent mode?") for BOTH the long form and the alias
//   - on / off / status subcommands for BOTH the long form and the alias
//   - case-insensitivity
//   - surrounding whitespace tolerated
//   - trailing newline tolerated
//   - strict rejection: invalid subcommand, extra args, numeric arg,
//     different word, empty input
//
// Like the other display parsers, parseSilentCommand returns `null` on
// any unrecognized input so the dispatcher can fall through to the
// regular "unknown slash command" hint.
const silentCases = [
  { input: "/silent",         expected: { kind: "status" }, label: "bare /silent → status" },
  { input: "/sl",             expected: { kind: "status" }, label: "bare /sl alias → status" },
  { input: "/silent on",      expected: { kind: "on" },     label: "/silent on" },
  { input: "/silent off",     expected: { kind: "off" },    label: "/silent off" },
  { input: "/silent status",  expected: { kind: "status" }, label: "/silent status" },
  { input: "/sl on",          expected: { kind: "on" },     label: "/sl on (alias)" },
  { input: "/sl off",         expected: { kind: "off" },    label: "/sl off (alias)" },
  { input: "/sl status",      expected: { kind: "status" }, label: "/sl status (alias)" },
  { input: "/SILENT ON",      expected: { kind: "on" },     label: "case-insensitive /SILENT ON" },
  { input: "/silent  on",     expected: { kind: "on" },     label: "extra spaces around subcommand" },
  { input: "/silent foo",     expected: null,               label: "invalid subcommand → null" },
  { input: "/silent on extra", expected: null,              label: "extra args rejected → null" },
  { input: "/silent 5",       expected: null,               label: "numeric arg rejected → null" },
  { input: "/not-silent",     expected: null,               label: "different word /not-silent rejected" },
  { input: "",                expected: null,               label: "empty string → null" },
  { input: "/silent\n",       expected: { kind: "status" }, label: "trailing newline tolerated" },
];

describe("parseSilentCommand", () => {
  for (const c of silentCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseSilentCommand(c.input)).toEqual(c.expected);
    });
  }
});

// ─── formatStatus — agent status & other running sessions ───────────────
//
// Minimal base opts for formatStatus; only the two new optional fields
// vary across cases. Defaults avoid forcing the test to repeat the full
// opt shape — the rendered output is asserted by substring, not full
// snapshot, so context noise is acceptable.

const baseStatusOpts = {
  session: { id: "ses_test", cwd: "/test", title: "Test" },
  workspace: "/test",
  agent: "build",
  model: "anthropic/claude-sonnet-4-5",
  reasoning: "medium",
  contextUsage: null,
};

describe("formatStatus with agent status", () => {
  test('agentStatus: { type: "busy" } → "🟢 Agent: Running"', () => {
    const out = formatStatus({ ...baseStatusOpts, agentStatus: { type: "busy" } });
    expect(out).toContain("🟢 Agent: Running");
  });

  test('agentStatus: { type: "idle" } → "⚪ Agent: Idle"', () => {
    const out = formatStatus({ ...baseStatusOpts, agentStatus: { type: "idle" } });
    expect(out).toContain("⚪ Agent: Idle");
  });

  test('agentStatus: { type: "retry", attempt: 3 } → "🟡 Agent: Retrying (attempt 3)"', () => {
    const out = formatStatus({
      ...baseStatusOpts,
      agentStatus: { type: "retry", attempt: 3 },
    });
    expect(out).toContain("🟡 Agent: Retrying (attempt 3)");
  });

  test('agentStatus: { type: "retry" } (no attempt) → "🟡 Agent: Retrying (attempt 1)" (default)', () => {
    const out = formatStatus({
      ...baseStatusOpts,
      agentStatus: { type: "retry" },
    });
    expect(out).toContain("🟡 Agent: Retrying (attempt 1)");
  });

  test('agentStatus: null → "⚪ Agent: (unknown)"', () => {
    const out = formatStatus({ ...baseStatusOpts, agentStatus: null });
    expect(out).toContain("⚪ Agent: (unknown)");
  });

  test("agentStatus: undefined (omitted) → \"⚪ Agent: (unknown)\"", () => {
    const out = formatStatus({ ...baseStatusOpts });
    expect(out).toContain("⚪ Agent: (unknown)");
  });

  test("otherBusySessions: 0 → still renders \"📈 Other running sessions: 0\"", () => {
    const out = formatStatus({ ...baseStatusOpts, otherBusySessions: 0 });
    expect(out).toContain("📈 Other running sessions: 0");
  });

  test("otherBusySessions: 5 → renders \"📈 Other running sessions: 5\"", () => {
    const out = formatStatus({ ...baseStatusOpts, otherBusySessions: 5 });
    expect(out).toContain("📈 Other running sessions: 5");
  });

  test("otherBusySessions: null → \"📈 Other running sessions: (unknown)\"", () => {
    const out = formatStatus({ ...baseStatusOpts, otherBusySessions: null });
    expect(out).toContain("📈 Other running sessions: (unknown)");
  });

  test("otherBusySessions: undefined (omitted) → \"📈 Other running sessions: (unknown)\"", () => {
    const out = formatStatus({ ...baseStatusOpts });
    expect(out).toContain("📈 Other running sessions: (unknown)");
  });

  test("integration: full /status render with busy + 3 other sessions + context", () => {
    const out = formatStatus({
      ...baseStatusOpts,
      agentStatus: { type: "busy" },
      otherBusySessions: 3,
      contextUsage: { used: 50000, size: 200000 },
    });
    // New lines must appear in the right vertical neighborhood — between
    // Reasoning and the MCP section, and before the Context block. Just
    // assert both lines exist; ordering is exercised by snapshot below.
    expect(out).toContain("🟢 Agent: Running");
    expect(out).toContain("📈 Other running sessions: 3");
    // formatNumber abbreviates ≥1000 to "<k>k" form (e.g. 50000 → "50.0k").
    expect(out).toContain("🔥 Context: 50.0k / 200.0k (25%)");

    // Ordering: Agent status + Other running sessions lines must appear
    // AFTER "Reasoning" but BEFORE "Context". Use indexOf to lock it in.
    const idxReasoning = out.indexOf("🧠 Reasoning:");
    const idxAgent = out.indexOf("🟢 Agent: Running");
    const idxOther = out.indexOf("📈 Other running sessions: 3");
    const idxContext = out.indexOf("🔥 Context:");
    expect(idxReasoning).toBeGreaterThanOrEqual(0);
    expect(idxAgent).toBeGreaterThan(idxReasoning);
    expect(idxOther).toBeGreaterThan(idxAgent);
    expect(idxContext).toBeGreaterThan(idxOther);
  });
});