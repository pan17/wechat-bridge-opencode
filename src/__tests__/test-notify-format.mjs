/**
 * Unit tests for the cross-session notification feature:
 *   - `parseNotifyCommand` in `src/adapter/workspace-cmd.ts`
 *   - `formatNotifyStatus` in `src/adapter/notify-format.ts`
 *   - `formatOtherSessionNotification` (the 4 notification kinds)
 *   - `extractSessionErrorMessage` (defensive error string extraction)
 *   - `formatStatus` integration with the new `notifySettings` opt
 *
 * All tests use vitest. Run via `npm test` (requires `npm run build`
 * first to produce dist/). Uses plain JavaScript (no TS syntax in .mjs
 * files — that would error at parse time).
 */
import { describe, test, expect } from "vitest";
import {
  parseNotifyCommand,
  formatStatus,
} from "../../dist/src/adapter/workspace-cmd.js";
import {
  formatNotifyStatus,
  formatOtherSessionNotification,
  extractSessionErrorMessage,
} from "../../dist/src/adapter/notify-format.js";

// ─── parseNotifyCommand ───

const notifyCommandCases = [
  // Bare commands → status
  { input: "/notify",         expected: { kind: "notify", mode: "status" }, label: "bare /notify" },
  { input: "/n",              expected: { kind: "notify", mode: "status" }, label: "bare /n alias" },
  { input: "  /notify  ",     expected: { kind: "notify", mode: "status" }, label: "surrounding whitespace" },
  { input: "/NOTIFY",         expected: { kind: "notify", mode: "status" }, label: "case-insensitive" },

  // Master switch
  { input: "/notify on",      expected: { kind: "notify", mode: "on" },     label: "master on" },
  { input: "/notify off",     expected: { kind: "notify", mode: "off" },    label: "master off" },
  { input: "/notify status",  expected: { kind: "notify", mode: "status" }, label: "explicit status" },
  { input: "/n on",           expected: { kind: "notify", mode: "on" },     label: "alias master on" },

  // Per-type toggle
  { input: "/notify types question on",    expected: { kind: "notify", mode: "on",  type: "question"    }, label: "question on" },
  { input: "/notify types permission off", expected: { kind: "notify", mode: "off", type: "permission" }, label: "permission off" },
  { input: "/notify types error on",       expected: { kind: "notify", mode: "on",  type: "error"       }, label: "error on" },
  { input: "/notify types completion off", expected: { kind: "notify", mode: "off", type: "completion" }, label: "completion off" },
  { input: "/n types question off",        expected: { kind: "notify", mode: "off", type: "question"    }, label: "alias per-type" },

  // Rejections (not a notify command → return null)
  { input: "/notify foo",                expected: null, label: "unknown master subcommand" },
  { input: "/notify types foo on",       expected: null, label: "unknown event type" },
  { input: "/notify types question",     expected: null, label: "missing on/off after type" },
  { input: "/notify types",              expected: null, label: "bare types subcommand" },
  { input: "/notification",              expected: null, label: "different word rejected" },
  { input: "/notifyx",                   expected: null, label: "prefix matches nothing" },
];

describe("parseNotifyCommand", () => {
  for (const c of notifyCommandCases) {
    test(`${c.label}: ${JSON.stringify(c.input)} → ${JSON.stringify(c.expected)}`, () => {
      expect(parseNotifyCommand(c.input)).toEqual(c.expected);
    });
  }
});

// ─── formatNotifyStatus ───

describe("formatNotifyStatus", () => {
  test("renders master On with all types enabled", () => {
    const out = formatNotifyStatus(true, {
      question: true, permission: true, error: true, completion: true,
    });
    expect(out).toContain("🔔 Notify:");
    expect(out).toContain("Status: ✅ On");
    expect(out).toContain("question   ✅");
    expect(out).toContain("permission ✅");
    expect(out).toContain("error      ✅");
    expect(out).toContain("completion ✅");
  });

  test("renders master Off", () => {
    const out = formatNotifyStatus(false, {
      question: true, permission: false, error: false, completion: true,
    });
    expect(out).toContain("Status: ❌ Off");
  });

  test("renders per-type off (master on, mixed types)", () => {
    const out = formatNotifyStatus(true, {
      question: true, permission: false, error: false, completion: true,
    });
    expect(out).toContain("question   ✅");
    expect(out).toContain("permission ❌");
    expect(out).toContain("error      ❌");
    expect(out).toContain("completion ✅");
  });

  test("includes usage hint", () => {
    const out = formatNotifyStatus(true, {
      question: true, permission: true, error: true, completion: true,
    });
    expect(out).toContain("/notify on|off");
    expect(out).toContain("/notify types <type> on|off");
  });
});

// ─── formatOtherSessionNotification (4 kinds) ───

describe("formatOtherSessionNotification", () => {
  test("question: includes session label, question text, switch hint", () => {
    const out = formatOtherSessionNotification({
      kind: "question",
      sessionLabel: "fix-auth-bug",
      question: {
        question: "用 OAuth 还是 JWT?",
        header: "Auth method",
        options: [{ label: "OAuth", description: "" }, { label: "JWT", description: "" }],
      },
    });
    expect(out).toContain("📨");
    expect(out).toContain('"fix-auth-bug"');
    expect(out).toContain("用 OAuth 还是 JWT?");
    expect(out).toContain("/session switch");
  });

  test("permission: includes tool name and patterns", () => {
    const out = formatOtherSessionNotification({
      kind: "permission",
      sessionLabel: "deploy-prod",
      permission: {
        id: "per_test",
        sessionID: "ses_other",
        permission: "bash",
        patterns: ["npm run deploy"],
        metadata: {},
        always: [],
      },
    });
    expect(out).toContain("🔐");
    expect(out).toContain('"deploy-prod"');
    expect(out).toContain("bash");
    expect(out).toContain("npm run deploy");
  });

  test("error: includes error message", () => {
    const out = formatOtherSessionNotification({
      kind: "error",
      sessionLabel: "migrate-db",
      errorMessage: "rate limit exceeded",
    });
    expect(out).toContain("❌");
    expect(out).toContain('"migrate-db"');
    expect(out).toContain("rate limit exceeded");
  });

  test("completion: concise, no body needed", () => {
    const out = formatOtherSessionNotification({
      kind: "completion",
      sessionLabel: "fix-auth-bug",
    });
    expect(out).toContain("✅");
    expect(out).toContain('"fix-auth-bug"');
    expect(out).toContain("已完成");
  });

  test("long label is truncated with ellipsis", () => {
    const longLabel = "a".repeat(100);
    const out = formatOtherSessionNotification({
      kind: "completion",
      sessionLabel: longLabel,
    });
    // MAX_LABEL_LEN is 60, so the label is truncated to 59 + "…"
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(200);
  });

  test("quotes are stripped from label to keep output well-formed", () => {
    const out = formatOtherSessionNotification({
      kind: "completion",
      sessionLabel: 'session "with quotes"',
    });
    // Should not have three or more consecutive quotes (broken nesting)
    expect(out).not.toMatch(/""""/);
  });

  test("empty label becomes (untitled) placeholder", () => {
    const out = formatOtherSessionNotification({
      kind: "completion",
      sessionLabel: "",
    });
    expect(out).toContain('"(untitled)"');
  });

  test("long body is truncated to keep notification compact", () => {
    const longQ = "Q".repeat(500);
    const out = formatOtherSessionNotification({
      kind: "question",
      sessionLabel: "x",
      question: { question: longQ, header: "h", options: [] },
    });
    // MAX_BODY_LEN is 120 → 119 chars + "…"
    expect(out).toContain("…");
  });
});

// ─── extractSessionErrorMessage ───

describe("extractSessionErrorMessage", () => {
  test("string error returned as-is", () => {
    expect(extractSessionErrorMessage("plain error")).toBe("plain error");
  });

  test("null/undefined returns 'Unknown error'", () => {
    expect(extractSessionErrorMessage(null)).toBe("Unknown error");
    expect(extractSessionErrorMessage(undefined)).toBe("Unknown error");
  });

  test("object with message field", () => {
    expect(extractSessionErrorMessage({ message: "bad request" })).toBe("bad request");
  });

  test("object with name + message + code", () => {
    expect(
      extractSessionErrorMessage({ name: "ProviderAuthError", message: "401", code: "AUTH" }),
    ).toBe("ProviderAuthError: 401: AUTH");
  });

  test("object with only name", () => {
    expect(extractSessionErrorMessage({ name: "FooError" })).toBe("FooError");
  });

  test("object with only code (number)", () => {
    expect(extractSessionErrorMessage({ code: 500 })).toBe("500");
  });

  test("object with no recognizable fields → fallback to String()", () => {
    // Objects with unusual shapes still produce SOMETHING
    const out = extractSessionErrorMessage({ foo: 1 });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  test("empty object → 'Unknown error' (no fields to extract)", () => {
    expect(extractSessionErrorMessage({})).toBe("Unknown error");
  });
});

// ─── formatStatus — notifySettings integration ───

describe("formatStatus with notifySettings", () => {
  const baseOpts = {
    session: { id: "ses_test", cwd: "/test", title: "Test" },
    workspace: "/test",
    agent: "build",
    model: "anthropic/claude-sonnet-4-5",
    reasoning: "medium",
    contextUsage: null,
  };

  test("enabled + all types on → '🔔 Notify: ✅ On (q ✅ p ✅ e ✅ c ✅)'", () => {
    const out = formatStatus({
      ...baseOpts,
      notifySettings: { enabled: true, types: { question: true, permission: true, error: true, completion: true } },
    });
    expect(out).toContain("🔔 Notify: ✅ On (q ✅ p ✅ e ✅ c ✅)");
  });

  test("enabled + mixed types", () => {
    const out = formatStatus({
      ...baseOpts,
      notifySettings: { enabled: true, types: { question: true, permission: false, error: false, completion: true } },
    });
    expect(out).toContain("🔔 Notify: ✅ On (q ✅ p ❌ e ❌ c ✅)");
  });

  test("disabled → '🔔 Notify: ❌ Off'", () => {
    const out = formatStatus({
      ...baseOpts,
      notifySettings: { enabled: false, types: { question: true, permission: true, error: true, completion: true } },
    });
    expect(out).toContain("🔔 Notify: ❌ Off");
    expect(out).toContain("/notify on to enable");
  });

  test("null notifySettings → no notify line (backwards compat)", () => {
    const out = formatStatus({ ...baseOpts, notifySettings: null });
    expect(out).not.toContain("🔔 Notify");
  });

  test("undefined notifySettings → no notify line (backwards compat)", () => {
    const out = formatStatus({ ...baseOpts });
    expect(out).not.toContain("🔔 Notify");
  });
});
