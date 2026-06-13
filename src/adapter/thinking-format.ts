/**
 * Pure formatting helpers for displaying agent `ReasoningPart` content in WeChat.
 *
 * The `reasoningSummary` function extracts an optional bold-marker title from a
 * reasoning block using the same pattern that the opencode TUI uses to render
 * thinking steps, then strips any `[REDACTED]` placeholders left by providers
 * (e.g. OpenRouter) that mask sensitive content in their output.
 *
 * Pattern: `**Title**\n\nbody` — a title wrapped in `**…**`, followed by a
 * blank line and the body text. If the title marker is absent, the entire
 * cleaned text is returned as the body.
 *
 * Reference: opencode tui `packages/tui/src/context/thinking.ts:12-17`.
 *
 * This module has zero side effects: no I/O, no `Date.now()`, no randomness,
 * and no project-module imports. It is a leaf utility safe to call from any
 * context.
 */

const REDACTED_PLACEHOLDER = "[REDACTED]";
const TITLE_REGEX = /^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/;
/** Max length of the first-line fallback summary when no `**Title**` marker is present. */
const MAX_SUMMARY_LEN = 50;

/**
 * Split a reasoning block into its title (if present), a one-line summary
 * (always populated), and the remaining body.
 *
 * Strips `[REDACTED]` placeholders (case-sensitive literal substring) first,
 * then runs the TUI title regex. When a title is found, it doubles as the
 * `summary`; otherwise the summary is the first non-empty line of the body,
 * truncated to {@link MAX_SUMMARY_LEN} characters with an ellipsis.
 *
 * The body is what the model actually reasoned about; the summary is the
 * short label we send to WeChat (`🧠 Thought · <summary> · <duration>`).
 *
 * @param text - Raw reasoning text from a `ReasoningPart`.
 * @returns `{ title, body, summary }` where:
 *   - `title` is the bold-marker header (or `null` when absent);
 *   - `body` is the cleaned text after the title (or the full cleaned text
 *     when no title is present);
 *   - `summary` is always a non-empty short string (used as the middle
 *     segment of the one-line `🧠 Thought · {summary} · {duration}` header).
 * @example
 * reasoningSummary("**My plan**\n\nstep 1")
 * // { title: "My plan", body: "step 1", summary: "My plan" }
 * reasoningSummary("Just thinking out loud here.")
 * // { title: null, body: "Just thinking out loud here.", summary: "Just thinking out loud here." }
 */
export function reasoningSummary(text: string): { title: string | null; body: string; summary: string } {
  const cleaned = text.split(REDACTED_PLACEHOLDER).join("");
  const match = TITLE_REGEX.exec(cleaned);
  if (match) {
    return {
      title: match[1],
      body: cleaned.slice(match[0].length).trim(),
      summary: match[1],
    };
  }
  // No `**Title**` marker — use the first non-empty line as the summary.
  // The first line of a model reasoning stream is usually a short
  // "what am I doing" sentence; even when it isn't, 50 chars is enough
  // to be useful and short enough to fit WeChat.
  const firstLine = cleaned.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const summary = firstLine.length > MAX_SUMMARY_LEN
    ? firstLine.slice(0, MAX_SUMMARY_LEN) + "…"
    : firstLine;
  return { title: null, body: cleaned, summary };
}

/**
 * Format a duration in milliseconds as a short human-readable string.
 *
 * Sub-second values are rendered as whole milliseconds (`"450ms"`); values
 * of 1000 ms or more are rendered with one decimal place of seconds
 * (`"1.0s"`, `"2.3s"`). English-only suffixes; no locale awareness.
 *
 * @param ms - Duration in milliseconds (non-negative integer).
 * @returns Duration string with `ms` or `s` suffix.
 * @example
 * formatDuration(450)   // "450ms"
 * formatDuration(2345)  // "2.3s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build the one-line display string sent to WeChat for a thought block.
 *
 * With a non-empty summary, the line reads
 * `🧠 Thought · <summary> · <duration>`. With an empty summary (rare;
 * only when the reasoning part is genuinely empty after cleaning), the
 * middle segment is dropped so the output is `🧠 Thought · <duration>`.
 *
 * The body of the reasoning is NEVER included here — the user sees only
 * the summary + duration header, never the full text. Sending the full
 * body would flood the WeChat 10-message limit on long-thinking models
 * and would defeat the purpose of "show me a thought" (a label, not a
 * transcript).
 *
 * @param durationMs - Thought duration in milliseconds.
 * @param summary - Short summary string from {@link reasoningSummary}
 *   (always non-empty for non-blank reasoning text).
 * @returns Single-line display string with brain emoji prefix.
 * @example
 * formatThoughtHeader(2300, "Inspecting PR workflow") // "🧠 Thought · Inspecting PR workflow · 2.3s"
 * formatThoughtHeader(450, "")                          // "🧠 Thought · 450ms"
 */
export function formatThoughtHeader(durationMs: number, summary: string): string {
  const duration = formatDuration(durationMs);
  if (summary) {
    return `🧠 Thought · ${summary} · ${duration}`;
  }
  return `🧠 Thought · ${duration}`;
}
