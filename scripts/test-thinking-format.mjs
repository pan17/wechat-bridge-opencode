/**
 * QA assertions for src/adapter/thinking-format.ts.
 *
 * Run after `npm run build`:
 *   node scripts/test-thinking-format.mjs
 *   bun  scripts/test-thinking-format.mjs   (if bun is available)
 *
 * Exits 0 on full pass, 1 on any failure. Uses only the built-in
 * `node:assert/strict` module — no external test framework.
 */
import assert from "node:assert/strict";
import { reasoningSummary, formatThoughtHeader, formatDuration } from "../dist/src/adapter/thinking-format.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    failed++;
    const message = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${message}`);
  }
}

console.log("thinking-format tests\n");

// QA Scenario 1: reasoningSummary extracts title from **Title**\n\nbody
test("reasoningSummary extracts title from **Title**\\n\\nbody pattern", () => {
  const r = reasoningSummary("**Inspecting PR workflow**\n\nLooking at the diff...");
  assert.equal(r.title, "Inspecting PR workflow");
  assert.equal(r.body, "Looking at the diff...");
  assert.equal(r.summary, "Inspecting PR workflow", "summary mirrors the **Title** header");
});

// QA Scenario 2: reasoningSummary returns null title when no marker; summary falls back to first line
test("reasoningSummary returns null title when no marker; summary falls back to first line", () => {
  const r = reasoningSummary("Just thinking out loud here.");
  assert.equal(r.title, null);
  assert.equal(r.body, "Just thinking out loud here.");
  assert.equal(r.summary, "Just thinking out loud here.");
});

// QA Scenario 3: reasoningSummary strips [REDACTED] placeholders
test("reasoningSummary strips [REDACTED] placeholders", () => {
  const r = reasoningSummary("**My plan**\n\n[REDACTED] some secret [REDACTED] more text");
  assert.equal(r.title, "My plan");
  assert.equal(r.body, "some secret  more text");
  assert.ok(!r.body.includes("[REDACTED]"), "body must not contain [REDACTED]");
  assert.equal(r.summary, "My plan");
});

// QA Scenario 3b: reasoningSummary uses first line as summary when no **Title** marker
test("reasoningSummary first-line fallback summary (no **Title** marker)", () => {
  const r = reasoningSummary("Just walking through the reasoning here.\n\nSecond line that is ignored.\nThird line too.");
  assert.equal(r.title, null);
  assert.equal(r.summary, "Just walking through the reasoning here.",
    "summary must use the first non-empty line when no **Title** marker is present");
});

// QA Scenario 3c: reasoningSummary truncates long first-line summaries to MAX_SUMMARY_LEN
test("reasoningSummary truncates first-line summary past 50 chars with ellipsis", () => {
  const longLine = "A".repeat(80);
  const r = reasoningSummary(longLine);
  assert.equal(r.title, null);
  assert.equal(r.summary.length, 51, "summary is 50 chars + 1 ellipsis char");
  assert.ok(r.summary.endsWith("…"), "summary ends with ellipsis");
  assert.equal(r.summary.slice(0, 50), "A".repeat(50));
});

// QA Scenario 4: formatThoughtHeader includes summary and duration
test("formatThoughtHeader includes summary and duration", () => {
  assert.equal(
    formatThoughtHeader(2300, "Inspecting PR workflow"),
    "🧠 Thought · Inspecting PR workflow · 2.3s",
  );
});

// QA Scenario 5: formatThoughtHeader omits summary segment when summary is empty
test("formatThoughtHeader omits summary segment when summary is empty", () => {
  assert.equal(formatThoughtHeader(450, ""), "🧠 Thought · 450ms");
});

// QA Scenario 5b: formatThoughtHeader with a first-line fallback summary (no **Title**)
test("formatThoughtHeader with first-line fallback summary", () => {
  assert.equal(
    formatThoughtHeader(187, "Just thinking out loud here."),
    "🧠 Thought · Just thinking out loud here. · 187ms",
  );
});

// QA Scenario 6: formatDuration handles sub-second and multi-second (5 boundaries)
test("formatDuration handles sub-second and multi-second", () => {
  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(2345), "2.3s");
  assert.equal(formatDuration(12700), "12.7s");
});

const total = passed + failed;
console.log(`\nPASS: ${passed}/${total}`);
process.exit(failed === 0 ? 0 : 1);
