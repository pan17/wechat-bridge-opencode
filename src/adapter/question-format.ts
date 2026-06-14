/**
 * Question formatting and parsing.
 *
 * Two public functions:
 *   - formatQuestionForWeChat(questions) — render prompts for WeChat display
 *   - parseQuestionReply(text, questions) — parse user reply into Answer[][]
 *
 * Parsing strategy (per `.omo/plans/question-tool-design.md` §7):
 *   Step 0 (format detection, priority order):
 *     1. Qn-format    — input contains "Q\d+\s*[=\-]"; each Qn routed to a question
 *     2. dash-format  — questions.length > 1 AND input contains "---"; positional
 *     3. single       — questions.length === 1; whole input = that question's answer
 *     4. fallback     — multi-question, no Qn/---: first segment = Q1, rest = defaults
 *
 *   Per-segment parsing (Step 2):
 *     - Split by `,` / `;` / `、` / whitespace
 *     - All tokens are pure digits → numberList → option labels
 *     - Otherwise → customText → [trimmed]
 *     - Out-of-range numbers → silent drop
 *
 *   Qn-marker semantics (key design decision):
 *     - "=" marker: parse content normally (numberList or customText)
 *     - "-" marker: content is ALWAYS customText (even "1, 3" is treated as
 *       a single custom string, not multi-select). This solves the
 *       `Q2-3` ambiguity where pure-digit content could be either option
 *       3 or custom "3".
 *
 * Whitespace tolerance: "Q1 = 1", "Q1 =1", "Q1= 1", "Q1 - 这题" all work.
 * Mobile keyboards often auto-insert spaces around operators.
 */

import type { QuestionPrompt } from "../types/question.js";

/** Maximum length (chars) of a single Answer element. Excess is truncated. */
const MAX_ANSWER_ELEMENT_LEN = 500;

/** Result of parseQuestionReply. */
export interface ParseResult {
  /**
   * Per-question answers. `answers.length === questions.length`. Each inner
   * array contains the selected option labels (or a single custom string).
   */
  answers: string[][];
  /**
   * True if every question got a non-empty answer (either explicit or
   * via default). False if any question is empty.
   */
  allAnswered: boolean;
  /**
   * Non-fatal diagnostics. Logged for the operator; never throw.
   * Examples: out-of-range numbers, unrecognized Qn segments, extra segments.
   */
  warnings: string[];
}

// ─── Public: format ───

/**
 * Render a question (or set of questions) as a WeChat-friendly plain-text
 * message. The output stays within the 4000-char WeChat chunk limit and
 * uses emoji + indentation for visual structure.
 */
export function formatQuestionForWeChat(
  questions: ReadonlyArray<QuestionPrompt>,
): string {
  if (questions.length === 0) return "";
  if (questions.length === 1) return formatSingle(questions[0]!);
  return formatMulti(questions);
}

// ─── Public: parse ───

/**
 * Parse a WeChat user reply into per-question answers. See file-header
 * JSDoc for the 4-strategy detection logic.
 */
export function parseQuestionReply(
  input: string,
  questions: ReadonlyArray<QuestionPrompt>,
): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      answers: questions.map((q) => defaultAnswerFor(q)),
      allAnswered: false,
      warnings: ["empty input"],
    };
  }

  // Step 0: format detection
  if (QN_PATTERN.test(trimmed)) {
    return parseQnFormat(trimmed, questions);
  }
  if (questions.length > 1 && /---/.test(trimmed)) {
    return parseDashFormat(trimmed, questions);
  }
  if (questions.length === 1) {
    return {
      answers: [parseSegment(trimmed, questions[0]!)],
      allAnswered: true,
      warnings: [],
    };
  }
  // Fallback: multi-question, no Qn- or ---. Use first segment as Q1, rest default.
  return {
    answers: [
      parseSegment(trimmed, questions[0]!),
      ...questions.slice(1).map((q) => defaultAnswerFor(q)),
    ],
    allAnswered: false,
    warnings: [
      'multi-question reply without "Q{n}=" prefix; only Q1 captured, rest defaulted',
    ],
  };
}

// ─── Internal: format helpers ───

function formatSingle(q: QuestionPrompt): string {
  const lines: string[] = [];
  lines.push(`❓ [${q.header}]`);
  lines.push(q.question);
  lines.push("");
  appendOptions(lines, q);
  lines.push("");
  lines.push(buildHint(q));
  return lines.join("\n");
}

function formatMulti(questions: ReadonlyArray<QuestionPrompt>): string {
  const total = questions.length;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const q = questions[i]!;
    lines.push(`❓ Question ${i + 1}/${total} [${q.header}]`);
    lines.push(q.question);
    lines.push("");
    appendOptions(lines, q);
    if (i < total - 1) lines.push("");
  }
  lines.push("");
  lines.push(buildMultiHint(questions));
  return lines.join("\n");
}

function appendOptions(lines: string[], q: QuestionPrompt): void {
  for (let i = 0; i < q.options.length; i++) {
    const opt = q.options[i]!;
    const line = opt.description
      ? `${i + 1}. ${opt.label} — ${opt.description}`
      : `${i + 1}. ${opt.label}`;
    lines.push(`  ${line}`);
  }
  if (q.multiple === true) {
    lines.push("  (multi-select; reply with comma-separated numbers)");
  }
}

function buildHint(q: QuestionPrompt): string {
  const base =
    q.custom === false
      ? '💡 Reply with the option number (e.g. "1"), or numbers (e.g. "1, 3" for multi-select).'
      : '💡 Reply with the option number (e.g. "1"), numbers (e.g. "1, 3" for multi-select), or type your own answer.';
  return base + '\n   To skip: send `/rq` (alias `/reject-question`) to dismiss.';
}

function buildMultiHint(questions: ReadonlyArray<QuestionPrompt>): string {
  const allAllowCustom = questions.every((q) => q.custom !== false);
  const lines: string[] = [
    '💡 Reply with "Q{n}={value}" for choices / "Q{n}-{value}" for custom (space-separated; order doesn\'t matter):',
  ];
  // Pick examples that match the actual question count
  if (questions.length === 2) {
    lines.push('   • Single-select: "Q1=1 Q2=2"');
    lines.push('   • Multi-select:  "Q1=1, 3 Q2=2"');
    if (allAllowCustom) {
      lines.push('   • Custom:        "Q2-这题我有自己想法"  (the dash forces free-form text)');
    }
  } else {
    if (allAllowCustom) {
      lines.push('   • Mixed:         "Q1=1 Q2-这题我有自己想法 Q3=3"');
    } else {
      lines.push('   • Mixed:         "Q1=1 Q3=3"  (skip Q2 which doesn\'t allow custom)');
    }
    lines.push("   • Skip (use default): just don't include that Qn-");
  }
  lines.push(
    '   Mobile-friendly: spaces around the marker are ignored — "Q1 = 1", "Q1 =1" and "Q1= 1" all work.',
  );
  if (allAllowCustom) {
    lines.push('   Tip: use "-" whenever the content might look like a number, to keep it as text.');
  }
  lines.push("");
  lines.push("   To dismiss: send `/rq` (alias `/reject-question`) to skip all questions.");
  lines.push("");
  lines.push('   Short form (positional, must be in order): "1 --- 2 --- 3"');
  return lines.join("\n");
}

// ─── Internal: parse helpers ───

/** Matches the Qn-marker pattern anywhere in the string (for Step 0 detection). */
const QN_PATTERN = /\bQ\d+\s*[=\-]/;

/** Matches one Qn segment: "Q\d+\s*[=\-]\s*rest" — the rest is the answer content. */
const QN_SEGMENT_RE = /^Q(\d+)\s*([=\-])\s*(.*)$/;

/** Splits a segment into tokens. Treats digit-only tokens as numbers; anything else is text. */
const SEGMENT_TOKEN_RE = /[,;、\s]+/;

function parseQnFormat(input: string, questions: ReadonlyArray<QuestionPrompt>): ParseResult {
  const answers: (string[] | null)[] = questions.map(() => null);
  const warnings: string[] = [];

  // Tokenize the input by scanning for each "Q{n}" marker. We do NOT
  // split by whitespace first — that would break multi-select content
  // like "Q1=1, 3" (whitespace split would yield ["Q1=1,", "3"]).
  // Instead, a regex with a lookahead finds each segment and captures
  // everything up to the NEXT "Q{n}=" / "Q{n}-" (or end of input).
  // The non-greedy `[\s\S]*?` keeps each segment bounded.
  //
  // Side effect: the content of a Qn segment may legitimately contain
  // "Q" (e.g. "Q1=Question one" — the "Q" in "Question" is NOT a
  // digit-followed-by-marker so the lookahead correctly ignores it).
  const re = /Q(\d+)\s*([=\-])\s*([\s\S]*?)(?=Q\d+\s*[=\-]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input)) !== null) {
    const n = parseInt(match[1]!, 10);
    const marker = match[2] as "=" | "-";
    const rest = (match[3] ?? "").trim();

    if (n < 1 || n > questions.length) {
      warnings.push(`Q${n} out of range (have ${questions.length} questions)`);
      continue;
    }

    const idx = n - 1;
    const q = questions[idx]!;
    let parsed: string[];

    if (marker === "-") {
      // "-" marker: force custom (even pure digits stay as text)
      if (rest === "") {
        warnings.push(`Q${n} dash with empty content; using default`);
        parsed = defaultAnswerFor(q);
      } else {
        parsed = capAnswer([rest]);
      }
    } else {
      // "=" marker: parse normally (numberList or customText)
      if (rest === "") {
        warnings.push(`Q${n} empty content; using default`);
        parsed = defaultAnswerFor(q);
      } else {
        parsed = parseSegment(rest, q);
      }
    }

    // Second occurrence overrides the first.
    answers[idx] = parsed;
  }

  const finalAnswers = answers.map((a, i) => a ?? defaultAnswerFor(questions[i]!));
  const allAnswered = finalAnswers.every((a) => a.length > 0);
  return { answers: finalAnswers, allAnswered, warnings };
}

function parseDashFormat(input: string, questions: ReadonlyArray<QuestionPrompt>): ParseResult {
  const segments = input
    .split(/\s*---\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const answers: (string[] | null)[] = questions.map(() => null);
  const warnings: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (i < questions.length) {
      const q = questions[i]!;
      answers[i] = parseSegment(seg, q);
    } else {
      // Extra segment: merge into the last question's answer (append label).
      const lastIdx = questions.length - 1;
      const lastQ = questions[lastIdx]!;
      const lastAnswer = answers[lastIdx] ?? defaultAnswerFor(lastQ);
      const extra = parseSegment(seg, lastQ);
      for (const e of extra) {
        if (lastAnswer.length < 10) {
          lastAnswer.push(e);
        }
      }
      answers[lastIdx] = capAnswer(lastAnswer);
      warnings.push(`extra segment "${truncate(seg, 30)}" merged into Q${lastIdx + 1}`);
    }
  }

  const finalAnswers = answers.map((a, i) => a ?? defaultAnswerFor(questions[i]!));
  const allAnswered = finalAnswers.every((a) => a.length > 0);
  return { answers: finalAnswers, allAnswered, warnings };
}

/**
 * Parse one segment into an Answer (string[]).
 *
 * Rules:
 *   - If all whitespace-/comma-/semicolon-/顿号-separated tokens are pure
 *     digits, treat as numberList → resolve to option labels.
 *     - Out-of-range numbers are silently dropped.
 *   - Otherwise treat the whole segment (trimmed) as a single custom string.
 *   - Empty / all-out-of-range falls back to the question's default.
 */
function parseSegment(value: string, question: QuestionPrompt): string[] {
  const trimmed = value.trim();
  if (!trimmed) return defaultAnswerFor(question);

  const tokens = trimmed
    .split(SEGMENT_TOKEN_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return defaultAnswerFor(question);

  if (tokens.every((t) => /^\d+$/.test(t))) {
    // All-digit tokens → numberList
    const labels: string[] = [];
    let anyInRange = false;
    for (const t of tokens) {
      const n = parseInt(t, 10);
      if (n < 1 || n > question.options.length) {
        // silent drop (out of range)
        continue;
      }
      anyInRange = true;
      const opt = question.options[n - 1]!;
      labels.push(opt.label);
    }
    if (!anyInRange) {
      // All numbers were out of range; fall back to custom so the user's
      // text isn't silently lost (e.g. "99" → ["99"], not []).
      return capAnswer([trimmed]);
    }
    return capAnswer(labels);
  }

  // Mixed or pure text → customText
  return capAnswer([trimmed]);
}

/** The default answer for a question = the first option's label. */
function defaultAnswerFor(q: QuestionPrompt): string[] {
  if (q.options.length === 0) return [];
  return [q.options[0]!.label];
}

/** Truncate each element to MAX_ANSWER_ELEMENT_LEN chars. Preserves array structure. */
function capAnswer(answer: string[]): string[] {
  return answer.map((a) => truncate(a, MAX_ANSWER_ELEMENT_LEN));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
