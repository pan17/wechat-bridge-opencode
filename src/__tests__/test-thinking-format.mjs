/**
 * Unit tests for src/adapter/thinking-format.ts.
 *
 * Exercises the QA scenarios from the display-commands plan, Task 1:
 *   - reasoningSummary extracts `**Title**\n\nbody` correctly
 *   - reasoningSummary falls back to first-line summary when no marker
 *   - reasoningSummary strips `[REDACTED]` placeholders
 *   - reasoningSummary truncates first-line summaries past MAX_SUMMARY_LEN
 *   - formatThoughtHeader includes summary + duration
 *   - formatThoughtHeader omits summary segment when summary is empty
 *   - formatDuration handles sub-second / multi-second boundaries
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect } from "vitest";
import { reasoningSummary, formatThoughtHeader, formatDuration } from "../../dist/src/adapter/thinking-format.js";

describe("reasoningSummary", () => {
  test("extracts title from **Title**\\n\\nbody pattern", () => {
    const r = reasoningSummary("**Inspecting PR workflow**\n\nLooking at the diff...");
    expect(r.title).toBe("Inspecting PR workflow");
    expect(r.body).toBe("Looking at the diff...");
    expect(r.summary).toBe("Inspecting PR workflow");
  });

  test("returns null title when no marker; summary falls back to first line", () => {
    const r = reasoningSummary("Just thinking out loud here.");
    expect(r.title).toBeNull();
    expect(r.body).toBe("Just thinking out loud here.");
    expect(r.summary).toBe("Just thinking out loud here.");
  });

  test("strips [REDACTED] placeholders", () => {
    const r = reasoningSummary("**My plan**\n\n[REDACTED] some secret [REDACTED] more text");
    expect(r.title).toBe("My plan");
    expect(r.body).toBe("some secret  more text");
    expect(r.body).not.toContain("[REDACTED]");
    expect(r.summary).toBe("My plan");
  });

  test("first-line fallback summary when no **Title** marker", () => {
    const r = reasoningSummary(
      "Just walking through the reasoning here.\n\nSecond line that is ignored.\nThird line too."
    );
    expect(r.title).toBeNull();
    expect(r.summary).toBe("Just walking through the reasoning here.");
  });

  test("truncates first-line summary past 50 chars with ellipsis", () => {
    const longLine = "A".repeat(80);
    const r = reasoningSummary(longLine);
    expect(r.title).toBeNull();
    // 50 chars of 'A' + 1 ellipsis char ('…').
    expect(r.summary.length).toBe(51);
    expect(r.summary.endsWith("…")).toBe(true);
    expect(r.summary.slice(0, 50)).toBe("A".repeat(50));
  });
});

describe("formatThoughtHeader", () => {
  test("includes summary and duration", () => {
    expect(formatThoughtHeader(2300, "Inspecting PR workflow")).toBe(
      "🧠 Thought · Inspecting PR workflow · 2.3s"
    );
  });

  test("omits summary segment when summary is empty", () => {
    expect(formatThoughtHeader(450, "")).toBe("🧠 Thought · 450ms");
  });

  test("works with a first-line fallback summary (no **Title**)", () => {
    expect(formatThoughtHeader(187, "Just thinking out loud here.")).toBe(
      "🧠 Thought · Just thinking out loud here. · 187ms"
    );
  });
});

describe("formatDuration", () => {
  test("handles sub-second and multi-second boundaries", () => {
    expect(formatDuration(450)).toBe("450ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(2345)).toBe("2.3s");
    expect(formatDuration(12700)).toBe("12.7s");
  });
});