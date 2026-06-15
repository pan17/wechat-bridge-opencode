/**
 * Unit tests for /thought-display, /tool-display, and /compact command parsers.
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
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect } from "vitest";
import { parseThoughtDisplayCommand, parseToolDisplayCommand, parseCompactCommand } from "../../dist/src/adapter/workspace-cmd.js";

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