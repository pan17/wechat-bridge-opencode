/**
 * Permission formatting and parsing for WeChat cards.
 *
 * Two public functions:
 *   - formatPermissionCard(request, index?, total?)
 *     Render a permission request as a WeChat-friendly plain-text card.
 *   - parsePermissionReply(input, pending)
 *     Parse the user's reply into one or more `PermissionDecision`s.
 *
 * Design rationale (`.omo/plans/permission-tool-design.md` §6):
 *
 *   Permission semantics differ from question semantics in two important
 *   ways, so the parser DELIBERATELY diverges from
 *   `parseQuestionReply`'s logic:
 *
 *   1. **Single-choice, not multi-select.** The user picks ONE of
 *      `once` / `always` / `reject` per request — never multiple
 *      options for the same permission. So `P1=1, 3` (which the question
 *      tool happily interprets as a numberList) is INVALID here and
 *      produces a warning.
 *
 *   2. **Bare keywords are valid.** Typing just `once` / `always` /
 *      `reject` (no `P1=` prefix) is unambiguous when exactly one
 *      permission is pending, and it matches the natural language used
 *      in the card. Multi-pending case still requires `Pn=` syntax.
 *
 *   Card format mirrors `formatQuestionForWeChat`'s structure (emoji +
 *   indentation) but with a fixed 3-choice footer instead of variable
 *   options. WeChat 2000-char limit is guarded by truncating the
 *   patterns list at 10 entries with `(and N more…)`.
 */

import type { PendingPermission, PermissionDecision, PermissionReply } from "../types/permission.js";

/** Maximum patterns rendered inline; the rest get a "(and N more…)" hint. */
const MAX_PATTERNS_RENDERED = 10;
/** Maximum length (chars) of a freeform rejection message. */
const MAX_MESSAGE_LEN = 500;
/** Soft cap on the full card size; we leave headroom under WeChat's 2000-char limit. */
const MAX_CARD_LEN = 1800;

// ─── Public: format ───

/**
 * Render a single permission as a WeChat-friendly plain-text card.
 *
 * @param request  The `PermissionRequest` to render.
 * @param index    1-based position when multiple permissions are
 *                 pending (e.g. parallel tool calls). Omit for single.
 * @param total    Total count when multiple are pending. Must be set
 *                 iff `index` is set.
 */
export function formatPermissionCard(
  request: import("../types/permission.js").PermissionRequest,
  index?: number,
  total?: number,
): string {
  const lines: string[] = [];
  const header = index !== undefined && total !== undefined
    ? `🔒 Permission ${index}/${total}`
    : `🔒 Permission requested`;
  lines.push(header);
  lines.push("");

  // Tool name (the opencode permission rule key, e.g. "bash", "edit").
  lines.push(`Tool: ${request.permission}`);
  lines.push("");

  // Resources — first 10 patterns inline, "(and N more…)" if more.
  const totalPatterns = request.patterns.length;
  const shown = request.patterns.slice(0, MAX_PATTERNS_RENDERED);
  if (shown.length > 0) {
    lines.push("Resources:");
    for (const p of shown) {
      lines.push(`  • ${p}`);
    }
    if (totalPatterns > MAX_PATTERNS_RENDERED) {
      lines.push(`  • (and ${totalPatterns - MAX_PATTERNS_RENDERED} more…)`);
    }
  } else {
    lines.push("Resources: (none specified)");
  }
  lines.push("");

  // Metadata — render common keys inline. Keep it terse; full metadata
  // dump would balloon the card.
  const meta = renderMetadata(request.metadata);
  if (meta) {
    lines.push("Details:");
    for (const line of meta) lines.push(`  ${line}`);
    lines.push("");
  }

  // The 3-choice hint.
  lines.push("Choose one reply:");
  lines.push("  1. once   — allow this call only");
  lines.push("  2. always — allow this scope permanently (until server restart)");
  lines.push("  3. reject — deny this call");
  lines.push("");

  // Reply syntax — differs by pending-count so the card tells the
  // user EXACTLY what to type. Single-pending uses bare positional;
  // multi-pending shows both the cascade shortcut (1/2/3 → all) and
  // the per-permission grammar (Pn=…). Without this distinction,
  // users naturally type "1" and get rejected when 2+ are pending.
  if (index !== undefined && total !== undefined && total > 1) {
    lines.push(`💡 ${total} permissions pending. Send:`);
    lines.push(`  • 1 | 2 | 3    — apply to ALL ${total} permissions`);
    lines.push(`  • P${index}=once P${nextIndex(index)}=reject …  — set per-permission`);
  } else {
    lines.push("Reply with: 1 | 2 | 3");
  }
  lines.push("Or send: /rp to reject, /ap once to auto-allow");
  lines.push("");
  lines.push("(you have 30 minutes before auto-reject)");

  let card = lines.join("\n");
  if (card.length > MAX_CARD_LEN) {
    // Defense-in-depth cap. Should never trigger now that patterns are
    // truncated at 10; if it does, trim the metadata section.
    card = card.slice(0, MAX_CARD_LEN - 1) + "…";
  }
  return card;
}

/** 1-based next index for the Pn=… grammar hint, wrapping at 9. */
function nextIndex(i: number): number {
  return i >= 9 ? 1 : i + 1;
}

/**
 * Render a brief, single-line summary for /status (or similar). Used by
 * the bridge's `formatStatus` extension to show how many permissions
 * are pending without dumping the full card.
 */
export function formatPermissionSummary(
  pending: ReadonlyArray<{ readonly requestID: string; readonly request: import("../types/permission.js").PermissionRequest; readonly askedAt: number }>,
): string | null {
  if (pending.length === 0) return null;
  const elapsed = (req: { askedAt: number }) => Math.max(0, Math.floor((Date.now() - req.askedAt) / 1000));
  const oldest = pending.reduce((a, b) => (a.askedAt < b.askedAt ? a : b));
  const label = pending.length === 1 ? "Permission" : "Permissions";
  return `⏳ ${label} pending (${pending.length}, ${elapsed(oldest)}s elapsed, id=${oldest.requestID.slice(0, 12)}…)`;
}

// ─── Public: parse ───

/**
 * Parse the user's reply text into one `PermissionDecision` per pending
 * permission. See file header for the divergence from
 * `parseQuestionReply`.
 *
 * Single-pending input grammar:
 *   `1` / `2` / `3`           → positional (once / always / reject)
 *   `once` / `always` / `reject` (case-insensitive) → that decision
 *   `once because I said so`  → keyword + trailing text becomes a
 *                               rejection MESSAGE (treats the keyword
 *                               as a typed prefix, not a strict match)
 *   `P1-text`                 → reject with `message="text"`
 *   `P1=once`                 → explicit per-permission reply
 *   `1, 3`                    → INVALID (multi-select), warning
 *
 * Multi-pending input grammar:
 *   `P1=once P2=reject`       → two decisions, one per pending
 *   `P1=once P2-自定义文字`   → once + reject-with-message
 *   `P9=once`                 → out-of-range, warning
 *
 * Output:
 *   - `decisions`: one per successfully parsed permission.
 *   - `warnings`: non-fatal diagnostics (out-of-range, multi-select,
 *     unrecognized segments, empty input). The caller should surface
 *     warnings via the bridge log AND show a re-prompt to the user
 *     if `decisions.length === 0`.
 */
export function parsePermissionReply(
  input: string,
  pending: ReadonlyArray<PendingPermission>,
): { decisions: PermissionDecision[]; warnings: string[] } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { decisions: [], warnings: ["empty input"] };
  }
  if (pending.length === 0) {
    return { decisions: [], warnings: ["no pending permissions"] };
  }

  const decisions: PermissionDecision[] = [];
  const warnings: string[] = [];

  // Step 1: try P{n}= / P{n}- per-permission segments first.
  // The regex matches P<digits><separator><content> where the content
  // runs up to the next P<n>=/P<n>- or end of input. Mirrors
  // question-format.ts's QN_SEGMENT_RE pattern.
  const PN_SEGMENT_RE = /P(\d+)\s*([=\-])\s*([\s\S]*?)(?=P\d+\s*[=\-]|$)/gi;
  let pnMatch: RegExpExecArray | null;
  let matchedPnIndices: Set<number> = new Set();

  while ((pnMatch = PN_SEGMENT_RE.exec(trimmed)) !== null) {
    const n = parseInt(pnMatch[1]!, 10);
    const marker = pnMatch[2] as "=" | "-";
    const rest = (pnMatch[3] ?? "").trim();

    if (n < 1 || n > pending.length) {
      warnings.push(`P${n} out of range (have ${pending.length} permission(s))`);
      continue;
    }
    const idx = n - 1;
    const target = pending[idx]!;
    // Mark the index as syntactically seen, even if it produces a
    // warning instead of a decision. This prevents the "specify
    // which permission" fallback from firing when the user DID try
    // to use P{n}= syntax (they just got the value wrong).
    matchedPnIndices.add(idx);

    if (marker === "-") {
      // Dash marker: always treat as a custom rejection message.
      if (!rest) {
        warnings.push(`P${n} dash with empty content; skipping`);
        continue;
      }
      const newDecision: PermissionDecision = {
        requestID: target.requestID,
        reply: "reject",
        message: truncate(rest, MAX_MESSAGE_LEN),
      };
      // Duplicate P{n}- → second wins (replace existing entry).
      const existingIdx = decisions.findIndex((d) => d.requestID === newDecision.requestID);
      if (existingIdx >= 0) {
        decisions[existingIdx] = newDecision;
      } else {
        decisions.push(newDecision);
      }
      matchedPnIndices.add(idx);
    } else {
      // "=" marker: parse content as a permission decision.
      if (rest === "") {
        warnings.push(`P${n} empty content; using default`);
        continue;
      }
      // Multi-select attempt inside a P{n}= value (e.g. "P1=1, 3") —
      // permissions are single-choice, so this is invalid. Emit the
      // specific multi-select warning (distinct from "unrecognized"
      // so the operator can tell what's wrong).
      if (/[,;、]/.test(rest)) {
        warnings.push(`P${n} multi-select not supported for permission; reply with a single 1/2/3 or P1=once|always|reject`);
        continue;
      }
      const parsed = parsePermissionValue(rest);
      if (!parsed) {
        warnings.push(`P${n} unrecognized value "${rest}"`);
        continue;
      }
      const newDecision: PermissionDecision = {
        requestID: target.requestID,
        reply: parsed.reply,
        ...(parsed.message ? { message: parsed.message } : {}),
      };
      // Duplicate P{n}= → second wins (replace existing entry).
      const existingIdx = decisions.findIndex((d) => d.requestID === newDecision.requestID);
      if (existingIdx >= 0) {
        decisions[existingIdx] = newDecision;
      } else {
        decisions.push(newDecision);
      }
      matchedPnIndices.add(idx);
    }
  }

  // Step 2: if no P{n}= segments matched at all, fall back to
  // positional / bare-keyword parsing. Three cases:
  //   - pending.length === 1 → parse as single permission
  //   - pending.length > 1  AND input is positional/keyword without
  //     any P{n}= prefix → CASCADE the same decision to ALL pending
  //     permissions. This matches the natural UX: the card says
  //     "Reply with 1 | 2 | 3" and the user reasonably expects
  //     "1" to apply to both cards when 2 are pending.
  //   - input is "1, 3" or "once reject" type → already handled in
  //     step 1 (multi-select warning); fall through to no decision.
  if (matchedPnIndices.size === 0) {
    if (pending.length === 1) {
      const decision = parseSinglePermissionInput(trimmed);
      if (decision.kind === "ok") {
        decisions.push({
          requestID: pending[0]!.requestID,
          reply: decision.reply,
          ...(decision.message ? { message: decision.message } : {}),
        });
      } else if (decision.kind === "warning") {
        warnings.push(decision.message);
      }
    } else {
      // Multi-pending cascade: try to parse the input as a single
      // permission decision, then apply it to ALL pending
      // permissions. This handles "1", "2", "3", "once", "always",
      // "reject", and "reject because X" gracefully.
      const cascade = parseSinglePermissionInput(trimmed);
      if (cascade.kind === "ok") {
        for (const p of pending) {
          decisions.push({
            requestID: p.requestID,
            reply: cascade.reply,
            ...(cascade.message ? { message: cascade.message } : {}),
          });
        }
      } else {
        // Couldn't parse as any decision → just emit the warning.
        warnings.push(cascade.message);
      }
    }
  }

  return { decisions, warnings };
}

// ─── Internal: format helpers ───

/**
 * Render `metadata` as a small set of lines. Only include keys that
 * are short scalars (string / number / boolean) — skip nested objects
 * and arrays to avoid bloating the card.
 */
function renderMetadata(metadata: Readonly<Record<string, unknown>>): string[] | null {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return null;
  const lines: string[] = [];
  for (const [k, v] of entries) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      // Cap each value at 100 chars to keep the card readable.
      const valStr = String(v);
      lines.push(`${k}: ${valStr.length > 100 ? valStr.slice(0, 97) + "…" : valStr}`);
    }
  }
  return lines.length > 0 ? lines : null;
}

// ─── Internal: parse helpers ───

type SinglePermissionParseResult =
  | { kind: "ok"; reply: PermissionReply; message?: string }
  | { kind: "warning"; message: string };

/**
 * Parse a single-permission reply (positional / keyword / keyword +
 * trailing text / multi-select warning). Only called when exactly one
 * permission is pending.
 */
function parseSinglePermissionInput(trimmed: string): SinglePermissionParseResult {
  // Multi-select attempt (e.g. "1, 3") → invalid for permission.
  if (/[,;、]/.test(trimmed)) {
    return { kind: "warning", message: "multi-select not supported for permission; reply with a single 1/2/3 or P1=once|always|reject" };
  }

  // Positional 1/2/3 → once/always/reject.
  if (trimmed === "1") return { kind: "ok", reply: "once" };
  if (trimmed === "2") return { kind: "ok", reply: "always" };
  if (trimmed === "3") return { kind: "ok", reply: "reject" };

  const lower = trimmed.toLowerCase();

  // Bare keyword → that decision.
  if (lower === "once") return { kind: "ok", reply: "once" };
  if (lower === "always") return { kind: "ok", reply: "always" };
  if (lower === "reject") return { kind: "ok", reply: "reject" };

  // Keyword + trailing text (e.g. "once because I said so",
  // "reject it's a bad idea") → keyword decision; the trailing text
  // becomes a message ONLY when the keyword is "reject" (the only
  // reply type where the server uses `message`). Otherwise it's a
  // warning and we drop the trailing text (server would ignore it
  // anyway for once/always).
  // Use case-insensitive match for the keyword but capture the
  // ORIGINAL-case remainder so the user's text survives unchanged.
  const keywordMatch = trimmed.match(/^(once|always|reject)\s+(.+)$/i);
  if (keywordMatch) {
    const keyword = keywordMatch[1]!.toLowerCase() as PermissionReply;
    const remainder = keywordMatch[2]!;
    if (keyword === "reject") {
      return { kind: "ok", reply: "reject", message: truncate(remainder, MAX_MESSAGE_LEN) };
    }
    // For once/always, the server ignores the message; drop it but
    // still accept the decision (no warning — the user might just be
    // adding context that's harmless to lose).
    return { kind: "ok", reply: keyword };
  }

  return { kind: "warning", message: `unrecognized input "${trimmed}"` };
}

/**
 * Parse the right-hand-side of a `P{n}=value` segment. Returns:
 *   - `{ reply: "once"|"always"|"reject" }` for valid values
 *   - `{ reply: "reject", message: "..." }` for keyword+text
 *   - `null` for unrecognizable values (caller decides the warning)
 *
 * IMPORTANT: the remainder text for `reject <text>` is matched
 * case-INSENSITIVELY for the keyword detection but the captured
 * remainder preserves the ORIGINAL case (so user-supplied text like
 * "reject because I Said So" comes through unchanged to the server
 * as `message="because I Said So"`).
 *
 * The caller (`parsePermissionReply`) handles multi-select detection
 * BEFORE calling this function, so this function does not check for
 * commas/semicolons internally.
 */
function parsePermissionValue(rest: string): { reply: PermissionReply; message?: string } | null {
  const trimmed = rest.trim();
  if (!trimmed) return null;

  // Positional number.
  if (trimmed === "1") return { reply: "once" };
  if (trimmed === "2") return { reply: "always" };
  if (trimmed === "3") return { reply: "reject" };

  const lower = trimmed.toLowerCase();

  // Bare keyword.
  if (lower === "once") return { reply: "once" };
  if (lower === "always") return { reply: "always" };
  if (lower === "reject") return { reply: "reject" };

  // Keyword + trailing text. Use case-insensitive match for the
  // keyword but capture the ORIGINAL-case remainder so the user's
  // capitalization survives into the server message.
  const keywordMatch = trimmed.match(/^(once|always|reject)\s+(.+)$/i);
  if (keywordMatch) {
    const keyword = keywordMatch[1]!.toLowerCase() as PermissionReply;
    const remainder = keywordMatch[2]!;
    if (keyword === "reject") {
      return { reply: "reject", message: truncate(remainder, MAX_MESSAGE_LEN) };
    }
    return { reply: keyword };
  }

  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
