/**
 * Unit tests for the question formatter and parser.
 *
 * Exercises all 28 acceptance cases from `.omo/plans/question-tool-design.md`
 * §12.1 — format cases and parse cases (single, multi Qn=, multi Qn-,
 * dash fallback, downgrade, range errors, ambiguity resolution).
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect } from "vitest";
import { formatQuestionForWeChat, parseQuestionReply } from "../../dist/src/adapter/question-format.js";

/** Reusable 3-option question fixture. */
const SINGLE_3_OPT = [
  {
    question: "Which auth method?",
    header: "Auth method",
    options: [
      { label: "OAuth2", description: "Use GitHub OAuth flow" },
      { label: "API Key", description: "Use a static API key" },
      { label: "Skip auth", description: "No authentication" },
    ],
  },
];

/** Two-question fixture. */
const MULTI_2_QUESTIONS = [
  {
    question: "Which auth method?",
    header: "Auth method",
    options: [
      { label: "OAuth2", description: "Use GitHub OAuth flow" },
      { label: "API Key", description: "Use a static API key" },
      { label: "Skip auth", description: "No authentication" },
    ],
  },
  {
    question: "Enable caching?",
    header: "Cache",
    options: [
      { label: "Yes", description: "Cache responses for 1 hour" },
      { label: "No", description: "No caching" },
    ],
  },
];

// ─── format: 5 cases ───

describe("formatQuestionForWeChat — single question", () => {
  test("default (multiple=false, custom=true) shows custom hint", () => {
    const out = formatQuestionForWeChat(SINGLE_3_OPT);
    expect(out).toContain("[Auth method]");
    expect(out).toContain("Which auth method?");
    expect(out).toContain("1. OAuth2 — Use GitHub OAuth flow");
    expect(out).toContain("2. API Key — Use a static API key");
    expect(out).toContain("3. Skip auth — No authentication");
    expect(out).toContain("or type your own answer");
  });

  test("single question includes /rq dismiss hint", () => {
    const out = formatQuestionForWeChat(SINGLE_3_OPT);
    expect(out).toContain("/rq");
    expect(out).toContain("/reject-question");
    expect(out).toMatch(/To skip.*\/rq/);
  });

  test("multiple=true shows multi-select hint", () => {
    const q = [{ ...SINGLE_3_OPT[0], multiple: true }];
    const out = formatQuestionForWeChat(q);
    expect(out).toContain("multi-select");
    expect(out).toContain("comma-separated numbers");
  });

  test("custom=false omits custom-answer hint", () => {
    const q = [{ ...SINGLE_3_OPT[0], custom: false }];
    const out = formatQuestionForWeChat(q);
    expect(out).not.toContain("or type your own answer");
  });

  test("empty description still renders option line cleanly", () => {
    const q = [{
      question: "Pick one",
      header: "Pick",
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
    }];
    const out = formatQuestionForWeChat(q);
    expect(out).toContain("1. A");
    expect(out).toContain("2. B");
    expect(out).not.toContain("— ");
  });
});

describe("formatQuestionForWeChat — multi question", () => {
  test("2 questions show 'Question N/2' and Qn= hint", () => {
    const out = formatQuestionForWeChat(MULTI_2_QUESTIONS);
    expect(out).toContain("Question 1/2");
    expect(out).toContain("Question 2/2");
    expect(out).toContain("Q1=1 Q2=2");
    expect(out).toContain("Q2-这题我有自己想法");
    expect(out).toContain("Mobile-friendly");
  });

  test("multi question includes /rq dismiss hint", () => {
    const out = formatQuestionForWeChat(MULTI_2_QUESTIONS);
    expect(out).toContain("/rq");
    expect(out).toContain("/reject-question");
    expect(out).toMatch(/To dismiss.*\/rq/);
  });
});

// ─── parse: single question — 7 cases ───

describe("parseQuestionReply — single question", () => {
  const [q] = SINGLE_3_OPT;

  test('"1" → option 1', () => {
    const r = parseQuestionReply("1", [q]);
    expect(r.answers).toEqual([["OAuth2"]]);
    expect(r.allAnswered).toBe(true);
  });

  test('"1, 3" multi-select', () => {
    const r = parseQuestionReply("1, 3", [q]);
    expect(r.answers).toEqual([["OAuth2", "Skip auth"]]);
  });

  test('"1;3" semicolon separator', () => {
    const r = parseQuestionReply("1;3", [q]);
    expect(r.answers).toEqual([["OAuth2", "Skip auth"]]);
  });

  test('"OAuth2 with refresh" custom', () => {
    const r = parseQuestionReply("OAuth2 with refresh", [q]);
    expect(r.answers).toEqual([["OAuth2 with refresh"]]);
  });

  test('"Q1=1" Qn= in single question', () => {
    const r = parseQuestionReply("Q1=1", [q]);
    expect(r.answers).toEqual([["OAuth2"]]);
  });

  test('"99" out of range → custom fallback', () => {
    const r = parseQuestionReply("99", [q]);
    // "99" is not a valid option (only 1-3 are), so the parser falls
    // back to treating the whole segment as a custom answer.
    expect(r.answers).toEqual([["99"]]);
    expect(r.allAnswered).toBe(true);
  });

  test('"1, custom text" mixed digit+text → custom', () => {
    const r = parseQuestionReply("1, custom text", [q]);
    expect(r.answers).toEqual([["1, custom text"]]);
  });
});

// ─── parse: multi question with Qn= (primary) — 7 cases ───

describe("parseQuestionReply — multi question Qn= format", () => {
  const [q1, q2] = MULTI_2_QUESTIONS;

  test('"Q1=1 Q2=2" two singles', () => {
    const r = parseQuestionReply("Q1=1 Q2=2", [q1, q2]);
    // q2 options are [Yes, No]; Q2=2 → "No"
    expect(r.answers).toEqual([["OAuth2"], ["No"]]);
    expect(r.warnings).toEqual([]);
  });

  test('"Q1=1, 3 Q2=2" multi-select first, single second', () => {
    const r = parseQuestionReply("Q1=1, 3 Q2=2", [q1, q2]);
    expect(r.answers).toEqual([["OAuth2", "Skip auth"], ["No"]]);
  });

  test('"Q1=1 Q2-这题我有自己想法" mixed Qn= and Qn-', () => {
    const THREE_Q = [...MULTI_2_QUESTIONS, {
      question: "Extra?",
      header: "Extra",
      options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }, { label: "Z", description: "z" }],
    }];
    const [a, b, c] = THREE_Q;
    const r = parseQuestionReply("Q1=1 Q2-这题我有自己想法 Q3=3", [a, b, c]);
    expect(r.answers).toEqual([["OAuth2"], ["这题我有自己想法"], ["Z"]]);
  });

  test('"Q1 = 1, 3   Q2 - 这题我有自己想法" mobile whitespace', () => {
    const THREE_Q = [...MULTI_2_QUESTIONS, {
      question: "Extra?",
      header: "Extra",
      options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }, { label: "Z", description: "z" }],
    }];
    // Q3 is not mentioned → defaults to first option "X"
    const r = parseQuestionReply("Q1 = 1, 3   Q2 - 这题我有自己想法", THREE_Q);
    expect(r.answers).toEqual([
      ["OAuth2", "Skip auth"],
      ["这题我有自己想法"],
      ["X"],
    ]);
  });

  test('"Q2=1" skip Q1 → Q1 default', () => {
    const r = parseQuestionReply("Q2=1", [q1, q2]);
    expect(r.answers).toEqual([["OAuth2"], ["Yes"]]); // Q1 defaults to first option
  });

  test('"Q1=1 Q3=3" skip middle → middle default', () => {
    const THREE_Q = [...MULTI_2_QUESTIONS, {
      question: "Extra?",
      header: "Extra",
      options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }, { label: "Z", description: "z" }],
    }];
    const [a, b, c] = THREE_Q;
    const r = parseQuestionReply("Q1=1 Q3=3", [a, b, c]);
    expect(r.answers).toEqual([["OAuth2"], ["Yes"], ["Z"]]); // Q2 defaults to first option of q2
  });

  test('"Q1=1 Q2=2 Q1=3" duplicate Q1 → second wins', () => {
    const r = parseQuestionReply("Q1=1 Q2=2 Q1=3", [q1, q2]);
    expect(r.answers).toEqual([["Skip auth"], ["No"]]);
  });
});

// ─── parse: Qn- (force custom) — 3 cases ───

describe("parseQuestionReply — Qn- force custom", () => {
  const THREE_Q = [...MULTI_2_QUESTIONS, {
    question: "Extra?",
    header: "Extra",
    options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }, { label: "Z", description: "z" }],
  }];
  const [q1, q2, q3] = THREE_Q;

  test('"Q2-3" digit as custom (NOT option 3)', () => {
    // Multi-question context: Q2-3 means "Q2 with custom text '3'"
    // (the dash forces custom even though "3" is a valid option number).
    const r = parseQuestionReply("Q2-3", [q1, q2, q3]);
    expect(r.answers).toEqual([["OAuth2"], ["3"], ["X"]]);
  });

  test('"Q1-1, 3" entire string custom (NOT multi-select)', () => {
    const r = parseQuestionReply("Q1-1, 3", [q1]);
    expect(r.answers).toEqual([["1, 3"]]);
  });

  test('"Q1-这题我有自己想法" custom text', () => {
    const r = parseQuestionReply("Q1-这题我有自己想法", [q1]);
    expect(r.answers).toEqual([["这题我有自己想法"]]);
  });
});

// ─── parse: out-of-range and edge cases — 3 cases ───

describe("parseQuestionReply — edge cases", () => {
  const [q1, q2] = MULTI_2_QUESTIONS;

  test('"Q4=1" out of range → silent drop + warning', () => {
    const r = parseQuestionReply("Q4=1", [q1, q2]);
    expect(r.warnings.some((w) => w.includes("Q4"))).toBe(true);
    expect(r.answers).toEqual([["OAuth2"], ["Yes"]]); // both default
  });

  test('empty input → all defaults, warning, allAnswered=false', () => {
    const r = parseQuestionReply("  ", [q1, q2]);
    expect(r.answers).toEqual([["OAuth2"], ["Yes"]]);
    expect(r.warnings).toContain("empty input");
    expect(r.allAnswered).toBe(false);
  });

  test('"1" multi-question no prefix → downgrade (only Q1 captured)', () => {
    const r = parseQuestionReply("1", [q1, q2]);
    expect(r.answers).toEqual([["OAuth2"], ["Yes"]]); // Q2 defaults
    expect(r.warnings.some((w) => w.includes("multi-question"))).toBe(true);
  });
});

// ─── parse: dash fallback — 2 cases ───

describe("parseQuestionReply — dash format fallback", () => {
  const [q1, q2] = MULTI_2_QUESTIONS;

  test('"1 --- 2" positional single-select', () => {
    const r = parseQuestionReply("1 --- 2", [q1, q2]);
    expect(r.answers).toEqual([["OAuth2"], ["No"]]);
  });

  test('"1 --- OAuth2 --- 3" dash mixed with custom middle', () => {
    const THREE_Q = [...MULTI_2_QUESTIONS, {
      question: "Extra?",
      header: "Extra",
      options: [{ label: "X", description: "x" }, { label: "Y", description: "y" }, { label: "Z", description: "z" }],
    }];
    const [a, b, c] = THREE_Q;
    const r = parseQuestionReply("1 --- OAuth2 --- 3", [a, b, c]);
    expect(r.answers).toEqual([["OAuth2"], ["OAuth2"], ["Z"]]);
  });
});

// ─── length cap — 1 case ───

describe("parseQuestionReply — length protection", () => {
  test("500+ char custom answer is truncated to 500", () => {
    const longText = "a".repeat(800);
    const r = parseQuestionReply(longText, [{
      question: "Q?",
      header: "H",
      options: [{ label: "L1", description: "d" }],
    }]);
    expect(r.answers[0][0].length).toBe(500);
  });
});
