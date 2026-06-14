/**
 * Unit tests for the permission formatter and parser.
 *
 * Exercises the ~22 acceptance cases from
 * `.omo/plans/permission-tool-design.md` §10.1 — format cases and
 * parse cases (single, multi Pn=, multi Pn-, positional fallback,
 * bare keywords, multi-select rejection, edge cases).
 *
 * Run via `npm test` (requires `npm run build` first to produce dist/).
 */
import { describe, test, expect } from "vitest";
import {
  formatPermissionCard,
  formatPermissionSummary,
  parsePermissionReply,
} from "../../dist/src/adapter/permission-format.js";

// ─── Reusable fixtures ───

function makeRequest(overrides = {}) {
  return {
    id: overrides.id ?? "per_abc123",
    sessionID: overrides.sessionID ?? "ses_xyz",
    permission: overrides.permission ?? "bash",
    patterns: overrides.patterns ?? ["cat /etc/hosts", "ls /tmp"],
    metadata: overrides.metadata ?? { command: "cat /etc/hosts && ls /tmp" },
    always: overrides.always ?? ["/etc/hosts", "/tmp"],
  };
}

function makePending(req) {
  return { requestID: req.id, request: req, contextToken: "ctx_1", askedAt: 1700000000000 };
}

// ─── format: 7 cases ───

describe("formatPermissionCard — single permission", () => {
  test("renders ≤10 patterns inline", () => {
    const req = makeRequest({ patterns: ["a.txt", "b.txt", "c.txt"] });
    const card = formatPermissionCard(req);
    expect(card).toContain("🔒 Permission requested");
    expect(card).toContain("Tool: bash");
    expect(card).toContain("Resources:");
    expect(card).toContain("  • a.txt");
    expect(card).toContain("  • b.txt");
    expect(card).toContain("  • c.txt");
    expect(card).not.toContain("more…");
  });

  test("renders >10 patterns with truncation hint", () => {
    const manyPatterns = Array.from({ length: 15 }, (_, i) => `p${i}.txt`);
    const req = makeRequest({ patterns: manyPatterns });
    const card = formatPermissionCard(req);
    expect(card).toContain("  • p0.txt");
    expect(card).toContain("  • p9.txt");
    expect(card).toContain("• (and 5 more…)");
    expect(card).not.toContain("  • p10.txt");
  });

  test("includes 3-choice positional hint (1/2/3)", () => {
    const card = formatPermissionCard(makeRequest());
    expect(card).toContain("Choose one reply:");
    expect(card).toContain("1. once   — allow this call only");
    expect(card).toContain("2. always — allow this scope permanently");
    expect(card).toContain("3. reject — deny this call");
  });

  test("includes /rp and /ap once hints", () => {
    const card = formatPermissionCard(makeRequest());
    expect(card).toContain("/rp to reject");
    expect(card).toContain("/ap once to auto-allow");
  });

  test("includes 30-min timeout hint", () => {
    const card = formatPermissionCard(makeRequest());
    expect(card).toMatch(/30 minutes before auto-reject/);
  });

  test("omits Details section when metadata is empty", () => {
    const req = makeRequest({ metadata: {} });
    const card = formatPermissionCard(req);
    expect(card).not.toContain("Details:");
  });

  test("renders metadata scalars in Details section, skips nested objects", () => {
    const req = makeRequest({
      metadata: {
        command: "rm -rf /",
        exitCode: 0,
        isDryRun: false,
        nested: { skip: true },
        list: [1, 2, 3],
      },
    });
    const card = formatPermissionCard(req);
    expect(card).toContain("Details:");
    expect(card).toContain("command: rm -rf /");
    expect(card).toContain("exitCode: 0");
    expect(card).toContain("isDryRun: false");
    expect(card).not.toContain("nested:");
    expect(card).not.toContain("list:");
  });
});

describe("formatPermissionCard — multi permission", () => {
  test("renders Permission N/M label and P{n}= syntax", () => {
    const req = makeRequest({ permission: "edit", patterns: ["src/foo.ts"] });
    const card = formatPermissionCard(req, 1, 2);
    expect(card).toContain("🔒 Permission 1/2");
    // Multi-pending card must show BOTH the cascade shortcut and the
    // per-permission grammar, so users know they can type either
    // "1" (apply to all) or "P1=once P2=reject" (per-permission).
    expect(card).toContain("2 permissions pending");
    expect(card).toContain("1 | 2 | 3");
    expect(card).toContain("P1=once P2=reject");
  });

  test("multi-pending card: second permission shows P2 hint", () => {
    const req = makeRequest({ permission: "bash", patterns: ["hostname"] });
    const card = formatPermissionCard(req, 2, 2);
    expect(card).toContain("🔒 Permission 2/2");
    // nextIndex(2) = 3, so the example uses P2=once P3=reject …
    // but the P{n}= grammar cycles at 9 → so it stays numeric
    // when n < 9. The example just shows the pattern, doesn't
    // require a specific P3.
    expect(card).toContain("P2=once");
  });
});

describe("formatPermissionSummary", () => {
  test("returns null for empty pending list", () => {
    expect(formatPermissionSummary([])).toBeNull();
  });

  test("renders single pending summary line", () => {
    const req = makeRequest({ id: "per_abc123def456" });
    const pending = [makePending(req)];
    const summary = formatPermissionSummary(pending);
    expect(summary).toContain("⏳ Permission pending (1");
    expect(summary).toContain("id=per_abc123de…");
  });

  test("renders multi pending with plural label", () => {
    const reqs = [makeRequest({ id: "per_aaa" }), makeRequest({ id: "per_bbb" })];
    const summary = formatPermissionSummary(reqs.map(makePending));
    expect(summary).toContain("⏳ Permissions pending (2");
  });
});

// ─── parse: 7 cases for single permission ───

describe("parsePermissionReply — single permission", () => {
  const singlePending = [makePending(makeRequest())];

  test("positional 1 → once", () => {
    expect(parsePermissionReply("1", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "once" },
    ]);
  });

  test("positional 2 → always", () => {
    expect(parsePermissionReply("2", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "always" },
    ]);
  });

  test("positional 3 → reject", () => {
    expect(parsePermissionReply("3", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "reject" },
    ]);
  });

  test("bare keyword 'once' → once", () => {
    expect(parsePermissionReply("once", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "once" },
    ]);
  });

  test("bare keyword 'REJECT' (case-insensitive) → reject", () => {
    expect(parsePermissionReply("REJECT", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "reject" },
    ]);
  });

  test("P1=always → always", () => {
    expect(parsePermissionReply("P1=always", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "always" },
    ]);
  });

  test("mobile whitespace 'P1 = always' (around `=`) → always", () => {
    // Mirrors question-format.ts tolerance: space around the `=` is
    // OK; space between P and digit is NOT (matches Qn format's
    // `\bQ\d+\s*[=\-]` regex).
    expect(parsePermissionReply("P1 = always", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "always" },
    ]);
    expect(parsePermissionReply("P1 =always", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "always" },
    ]);
    expect(parsePermissionReply("P1= always", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "always" },
    ]);
  });

  test("empty input → no decision, warning", () => {
    const result = parsePermissionReply("", singlePending);
    expect(result.decisions).toEqual([]);
    expect(result.warnings).toContain("empty input");
  });

  test("'reject because it's dangerous' → reject + message", () => {
    const result = parsePermissionReply("reject because it's dangerous", singlePending);
    expect(result.decisions).toEqual([
      { requestID: "per_abc123", reply: "reject", message: "because it's dangerous" },
    ]);
  });
});

// ─── parse: 5 cases for multi permission ───

describe("parsePermissionReply — multi permission", () => {
  const reqA = makeRequest({ id: "per_aaa", permission: "read" });
  const reqB = makeRequest({ id: "per_bbb", permission: "write" });
  const multiPending = [makePending(reqA), makePending(reqB)];

  test("P1=once P2=reject → two decisions", () => {
    const result = parsePermissionReply("P1=once P2=reject", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "once" },
      { requestID: "per_bbb", reply: "reject" },
    ]);
  });

  test("'1 2' positional with multi-pending → warning, no decisions", () => {
    // Multi-token input like "1 2" is not a single decision and
    // contains a comma-equivalent separator (space) — parser can't
    // cascade it. Falls through to warning.
    const result = parsePermissionReply("1 2", multiPending);
    expect(result.decisions).toEqual([]);
    // The space-separated tokens aren't digits-only, so it falls
    // into parseSinglePermissionInput's "unrecognized" path.
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("multi-pending cascade: '1' applies once to ALL pending", () => {
    const result = parsePermissionReply("1", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "once" },
      { requestID: "per_bbb", reply: "once" },
    ]);
  });

  test("multi-pending cascade: '2' applies always to ALL pending", () => {
    const result = parsePermissionReply("2", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "always" },
      { requestID: "per_bbb", reply: "always" },
    ]);
  });

  test("multi-pending cascade: '3' applies reject to ALL pending", () => {
    const result = parsePermissionReply("3", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "reject" },
      { requestID: "per_bbb", reply: "reject" },
    ]);
  });

  test("multi-pending cascade: 'once' (bare keyword) → once for all", () => {
    const result = parsePermissionReply("once", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "once" },
      { requestID: "per_bbb", reply: "once" },
    ]);
  });

  test("multi-pending cascade: 'reject' (bare keyword) → reject for all", () => {
    const result = parsePermissionReply("reject", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "reject" },
      { requestID: "per_bbb", reply: "reject" },
    ]);
  });

  test("multi-pending cascade: 'reject because X' → reject+message for all", () => {
    const result = parsePermissionReply("reject because X", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "reject", message: "because X" },
      { requestID: "per_bbb", reply: "reject", message: "because X" },
    ]);
  });

  test("P9=once out of range → warning, no decision for that index", () => {
    const result = parsePermissionReply("P9=once", multiPending);
    expect(result.decisions).toEqual([]);
    expect(result.warnings[0]).toMatch(/P9 out of range/);
  });

  test("duplicate P1 → second wins", () => {
    const result = parsePermissionReply("P1=once P1=reject", multiPending);
    expect(result.decisions).toEqual([
      { requestID: "per_aaa", reply: "reject" },
    ]);
  });

  test("P1=1,3 multi-select inside P{}= → warning, no decision", () => {
    const result = parsePermissionReply("P1=1, 3", multiPending);
    expect(result.decisions).toEqual([]);
    expect(result.warnings).toContain("P1 multi-select not supported for permission; reply with a single 1/2/3 or P1=once|always|reject");
  });
});

// ─── parse: 3 cases for custom message ───

describe("parsePermissionReply — custom message (P{n}-text)", () => {
  const singlePending = [makePending(makeRequest())];

  test("P1-this is a custom rejection → reject + message", () => {
    expect(parsePermissionReply("P1-this is a custom rejection", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "reject", message: "this is a custom rejection" },
    ]);
  });

  test("P1=reject because I said so → reject + message", () => {
    expect(parsePermissionReply("P1=reject because I said so", singlePending).decisions).toEqual([
      { requestID: "per_abc123", reply: "reject", message: "because I said so" },
    ]);
  });

  test("800-char message is truncated to 500", () => {
    const long = "x".repeat(800);
    // Use dash marker (P1-text) for freeform message — the equals
    // marker requires a keyword prefix; pure-text under `=` is
    // unrecognized (use `-` for that).
    const result = parsePermissionReply(`P1-${long}`, singlePending);
    expect(result.decisions[0]?.reply).toBe("reject");
    expect(result.decisions[0]?.message?.length).toBe(500);
  });
});

// ─── edge cases ───

describe("parsePermissionReply — edge cases", () => {
  test("empty pending list → no-op warning", () => {
    const result = parsePermissionReply("1", []);
    expect(result.decisions).toEqual([]);
    expect(result.warnings).toContain("no pending permissions");
  });

  test("unknown positional 4 → warning", () => {
    const singlePending = [makePending(makeRequest())];
    const result = parsePermissionReply("4", singlePending);
    expect(result.decisions).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
