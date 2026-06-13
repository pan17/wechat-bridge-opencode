/**
 * Parser unit tests for /thought-display and /tool-display commands.
 *
 * Exercises all 14 acceptance cases from .omo/plans/display-commands.md (Task 2):
 *  - 7 cases per parser (on, off, status, enable alias, disable alias, unknown subcommand, no legacy alias)
 *
 * Run with `bun scripts/test-parsers.mjs` or `node scripts/test-parsers.mjs`
 * (after `npm run build` to produce dist/).
 *
 * Exit 0 on full pass, 1 on any failure. Prints `PASS: 14/14` on success.
 */

import assert from "node:assert/strict";
import { parseThoughtDisplayCommand, parseToolDisplayCommand } from "../dist/src/adapter/workspace-cmd.js";

const thoughtCases = [
  { input: "/thought-display on",     expected: { kind: "on" },     label: "on" },
  { input: "/thought-display off",    expected: { kind: "off" },    label: "off" },
  { input: "/thought-display status", expected: { kind: "status" }, label: "status" },
  { input: "/thought-display enable", expected: { kind: "on" },     label: "enable alias" },
  { input: "/thought-display disable", expected: { kind: "off" },   label: "disable alias" },
  { input: "/thought-display foo",    expected: null,              label: "unknown subcommand" },
  { input: "/thought on",             expected: null,              label: "legacy /thought rejected" },
];

const toolCases = [
  { input: "/tool-display on",     expected: { kind: "on" },     label: "on" },
  { input: "/tool-display off",    expected: { kind: "off" },    label: "off" },
  { input: "/tool-display status", expected: { kind: "status" }, label: "status" },
  { input: "/tool-display enable", expected: { kind: "on" },     label: "enable alias" },
  { input: "/tool-display disable", expected: { kind: "off" },   label: "disable alias" },
  { input: "/tool-display foo",    expected: null,              label: "unknown subcommand" },
  { input: "/tool-display /thought on", expected: null,          label: "extra arg rejected" },
];

let passed = 0;
let failed = 0;
const failures = [];

function runCase(parserName, parser, c) {
  try {
    const actual = parser(c.input);
    assert.deepEqual(actual, c.expected);
    console.log(`  PASS  ${parserName}("${c.input}")  [${c.label}]`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${parserName}("${c.input}")  [${c.label}]`);
    console.log(`        expected: ${JSON.stringify(c.expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures.push({ parser: parserName, input: c.input, label: c.label, err: String(err) });
    failed++;
  }
}

console.log("parseThoughtDisplayCommand:");
for (const c of thoughtCases) {
  runCase("parseThoughtDisplayCommand", parseThoughtDisplayCommand, c);
}

console.log("");
console.log("parseToolDisplayCommand:");
for (const c of toolCases) {
  runCase("parseToolDisplayCommand", parseToolDisplayCommand, c);
}

const total = passed + failed;
console.log("");
if (failed === 0) {
  console.log(`PASS: ${total}/${total}`);
  process.exit(0);
} else {
  console.log(`FAIL: ${passed}/${total} passed, ${failed} failed`);
  process.exit(1);
}
