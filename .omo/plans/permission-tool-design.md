# Permission Tool Design

> Bridge OpenCode Server's `permission.asked` events to WeChat as interactive cards, with a tri-state auto-accept toggle (`off` / `once` / `always`).

**Status:** Design v2 (post-Momus review, pre-implementation)
**Author:** Sisyphus / wechat-opencode maintainer
**Clones:** Question tool design pattern (see `src/adapter/question-format.ts`, `src/server/session.ts` question state machine)
**Replaces:** Stale "auto-approved" claim that lived in AGENTS.md:145 / README.md / README.en.md:203

---

## 1. Goals & Non-Goals

### Goals

1. **WeChat interactive permission cards.** When the agent needs user permission for a tool, the user sees a formatted card on WeChat with three choices: `once`, `always`, `reject`.
2. **Tri-state auto-accept toggle.** A persisted toggle (`off` / `once` / `always`) lets the user skip the card for trusted workflows. `once` auto-allows per call; `always` server-side stores an allow rule in `InstanceState.approved` (in-memory; see Non-Goal 3).
3. **Status visibility.** `/status` and `/auto-permission status` both report the current mode.
4. **Race-safe state.** Multiple concurrent permission requests can be pending; each is keyed by `requestID`. The bridge relies on the server's built-in cascade: when the user replies `reject` to one, the server automatically rejects all siblings of the same `sessionID` via the `permission.replied` SSE echo (the bridge then clears them via `handlePermissionRepliedSse` — no client-side iteration needed).
5. **Leak recovery.** On bridge restart, any orphaned pending permissions on the server are auto-rejected via `POST /permission/:id/reply { reply: "reject" }` so they don't block the next session.
6. **30-minute soft timeout.** Pending cards auto-reject after 30 min if the user doesn't respond, matching the question tool's behavior.

### Non-Goals

1. **Not a full OpenCode permission ruleset editor.** We don't expose ruleset CRUD over WeChat — that's `opencode.json` territory.
2. **No per-tool or per-pattern toggles.** The toggle is a single global mode, not a per-`(permission, pattern)` matrix. Simpler UX.
3. **No shadow persistence of "always" rules.** The OpenCode permission service stores `always` rules in `InstanceState.approved` (in-memory only, `packages/opencode/src/permission/index.ts:34-77`). When `opencode serve` restarts, all approved rules are lost. The bridge does **not** persist them to disk — that would be a different ruleset (project config, agent memory) and is out of scope. Documented in §11 user-facing text so the operator is not surprised.

---

## 2. Architecture (Layered Clone of Question Tool)

| Layer | Question reference | Permission mirror |
|---|---|---|
| Types | `src/types/question.ts` | `src/types/permission.ts` (new) |
| SSE events | `QuestionAskedEvent` in `src/types/events.ts` | `PermissionAskedEvent`, `PermissionRepliedSseEvent` in `src/types/events.ts` |
| HTTP client | `listQuestions()`, `replyToQuestion()`, `rejectQuestion()` in `src/server/client.ts` | `listPendingPermissions()`, `replyToPermission()`, `rejectPendingPermission()` in `src/server/client.ts` |
| Session state | `pendingQuestion` (single slot), `questionTimeoutHandle` in `src/server/session.ts` | `pendingPermissions: Map<requestID, PendingPermission>`, `permissionTimeoutHandles: Map<requestID, Timer>` (Map because multiple concurrent permission requests are possible — parallel tool calls) |
| Session API | `hasPendingQuestion()`, `answerPendingQuestion()`, `rejectPendingQuestion()`, `listLeakedQuestions()` | `hasPendingPermission(requestID?)`, `getPendingPermission(requestID)`, `listPendingPermissions()`, `answerPendingPermission()`, `rejectPendingPermission()`, `listLeakedPermissions()` |
| Callbacks | `onQuestionAsked`, `onQuestionTimedOut` | `onPermissionAsked`, `onPermissionTimedOut` |
| Format/parse | `src/adapter/question-format.ts` | `src/adapter/permission-format.ts` (new) — **diverges from question-format for keyword handling** (see §6) |
| Bridge wiring | `src/bridge.ts` question block (lines 289-305, 320-372, 601-622, 786-864) | Analogous permission block + auto-mode switch |
| Commands | `/reject-question`, `/rq` in `src/adapter/workspace-cmd.ts` | `/reject-permission`, `/rp`, `/auto-permission`, `/ap` (new) |
| Help text | `/reject-question` row in `formatHelp()` | Permission rows + auto-mode rows |
| Tests | `test-question-format.mjs` (28 cases), `test-session-question.mjs` (13 cases) | `test-permission-format.mjs`, `test-session-permission.mjs` |

---

## 3. Type Definitions

### 3a. `src/types/permission.ts` (new file)

```ts
// User's reply to a permission card
export type PermissionReply = "once" | "always" | "reject";

// Auto-accept mode (persisted in bridge state.json)
export type AutoPermissionMode = "off" | "once" | "always";
export const DEFAULT_AUTO_PERMISSION_MODE: AutoPermissionMode = "off";

// Mirrors OpenCode V1 PermissionRequest (packages/core/src/v1/permission.ts:28-39)
export interface PermissionRequest {
  readonly id: string;                  // "per_xxxx"
  readonly sessionID: string;
  readonly permission: string;          // "bash", "edit", "read", "grep", "webfetch", …
  readonly patterns: ReadonlyArray<string>;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly always: ReadonlyArray<string>;  // patterns the agent says cover this call
  readonly tool?: { readonly messageID: string; readonly callID: string };
}

// SSE permission.replied payload (server emits this after each reply, including cascaded rejects)
export interface PermissionRepliedSseProps {
  readonly sessionID: string;
  readonly requestID: string;
  readonly reply: PermissionReply;
}

// Bridge runtime state (mirrors PendingQuestion)
export interface PendingPermission {
  readonly requestID: string;
  readonly request: PermissionRequest;
  readonly contextToken: string;
  readonly askedAt: number;
}

// Result of parsePermissionReply (see §6)
export interface PermissionDecision {
  readonly requestID: string;
  readonly reply: PermissionReply;
  readonly message?: string;  // only present when reply === "reject"
}
export interface PermissionParseResult {
  readonly decisions: ReadonlyArray<PermissionDecision>;
  readonly warnings: ReadonlyArray<string>;
}
```

### 3b. `src/types/events.ts` — additions

```ts
import type {
  PermissionRequest,
  PermissionRepliedSseProps,
} from "./permission.js";

export interface PermissionAskedEvent {
  type: "permission.asked";
  properties: PermissionRequest;
}

export interface PermissionRepliedSseEvent {
  type: "permission.replied";
  properties: PermissionRepliedSseProps;
}

// NOTE: There is no `permission.rejected` server event. Rejections (user-initiated
// or auto-cascade) surface as `permission.replied` with reply="reject".
```

Extend `OpenCodeEvent` union with the two new entries.

---

## 4. HTTP Client (`src/server/client.ts`)

Three new methods, mirroring the question ones:

```ts
async listPendingPermissions(directory?: string): Promise<PermissionRequest[]> {
  try {
    const res = await this.fetch(this.withDirectory("/permission", directory), { method: "GET" });
    if (!res.ok) return [];
    return res.json() as Promise<PermissionRequest[]>;
  } catch {
    return [];
  }
}

/**
 * Send a permission decision to the server.
 *
 * IMPORTANT: `message` is only meaningful when `reply === "reject"` — the opencode
 * server only uses it to build `CorrectedError` feedback (see
 * packages/opencode/src/permission/index.ts:132-138). For `once` and `always` it
 * is silently dropped on the wire; this method omits it from the body in those
 * cases to keep the payload honest.
 */
async replyToPermission(
  requestID: string,
  reply: PermissionReply,
  message: string | undefined,
  directory?: string,
): Promise<{ ok: boolean }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (directory) headers["x-opencode-directory"] = directory;
  const body: Record<string, unknown> = { reply };
  if (reply === "reject" && message) body.message = message;
  const res = await this.fetch(
    `/permission/${encodeURIComponent(requestID)}/reply`,
    { method: "POST", headers, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Permission reply failed: ${res.status} ${text}`);
  }
  return { ok: true };
}

// Convenience wrapper: same endpoint, reply="reject"
async rejectPendingPermission(
  requestID: string,
  message?: string,
  directory?: string,
): Promise<{ ok: boolean }> {
  return this.replyToPermission(requestID, "reject", message, directory);
}
```

**Endpoint contract** (verified against `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts:11-37`):

```
POST /permission/{requestID}/reply
Body: { "reply": "once"|"always"|"reject", "message?": string }   // message only for reject
Success: 200 { boolean }
Errors: 400 (bad request), 404 (PermissionNotFoundError — request already resolved)
```

---

## 5. SessionManager State Machine (`src/server/session.ts`)

### 5.1 New state fields

```ts
private pendingPermissions: Map<string, PendingPermission> = new Map();
private permissionTimeoutHandles: Map<string, ReturnType<typeof setTimeout>> = new Map();
private autoPermissionMode: AutoPermissionMode = "off";
private onPermissionAsked?: (contextToken: string, request: PermissionRequest, requestID: string) => Promise<void>;
private onPermissionTimedOut?: (contextToken: string, requestID: string) => Promise<void>;
```

The Map (vs question's single slot) supports multiple concurrent permission requests from parallel tool calls.

### 5.2 New callback options (added to `SessionManagerOpts`)

```ts
onPermissionAsked?: (
  contextToken: string,
  request: PermissionRequest,
  requestID: string,
) => Promise<void>;
onPermissionTimedOut?: (contextToken: string, requestID: string) => Promise<void>;
```

### 5.3 New methods

```ts
// Public API
hasPendingPermission(requestID?: string): boolean {
  return requestID ? this.pendingPermissions.has(requestID) : this.pendingPermissions.size > 0;
}
getPendingPermission(requestID: string): PendingPermission | null { /* ... */ }
listPendingPermissions(): PendingPermission[] { return [...this.pendingPermissions.values()]; }

/**
 * Send a decision for a pending permission and clear the local slot.
 * `message` is only forwarded to the server when `reply === "reject"`.
 */
async answerPendingPermission(
  requestID: string,
  reply: PermissionReply,
  message?: string,
): Promise<void> {
  const pending = this.pendingPermissions.get(requestID);
  if (!pending) return;
  try {
    await this.client.replyToPermission(requestID, reply, message, this.cwd);
  } finally {
    this.clearPendingPermission(requestID);
  }
}

/**
 * Reject a pending permission and clear the local slot.
 * Race-safe: slot cleared BEFORE the HTTP call so concurrent `handlePermissionRepliedSse`
 * callbacks find an empty slot (no-op).
 */
async rejectPendingPermission(requestID: string, message?: string): Promise<void> {
  if (!this.pendingPermissions.has(requestID)) return;
  this.clearPendingPermission(requestID);
  try {
    await this.client.replyToPermission(requestID, "reject", message, this.cwd);
  } catch (err) {
    this.log(`[permission] reject HTTP failed (non-fatal): ${String(err)}`);
  }
}

async listLeakedPermissions(directory?: string): Promise<PermissionRequest[]> {
  if (!this.sessionId) return [];
  try {
    const all = await this.client.listPendingPermissions(directory);
    const localIds = new Set(this.pendingPermissions.keys());
    return all.filter((q) => q.sessionID === this.sessionId && !localIds.has(q.id));
  } catch {
    return [];
  }
}

setAutoPermissionMode(mode: AutoPermissionMode): void { this.autoPermissionMode = mode; }
getAutoPermissionMode(): AutoPermissionMode { return this.autoPermissionMode; }

// Internal
private setPendingPermission(req: PermissionRequest, contextToken: string): void { /* ... */ }
private clearPendingPermission(requestID: string): void { /* ... */ }
private armPermissionTimeout(requestID: string, contextToken: string): void { /* 30 min */ }
private clearPermissionTimeout(requestID: string): void { /* ... */ }

private handlePermissionAsked(event: PermissionAskedEvent): void { /* see §5.5 */ }
private handlePermissionRepliedSse(event: PermissionRepliedSseEvent): void { /* see §5.6 */ }
```

### 5.4 Event handler dispatch — add cases

In `handleEvent()` switch (existing structure at session.ts:791):

```ts
case "permission.asked":
  this.handlePermissionAsked(event as PermissionAskedEvent);
  break;
case "permission.replied":
  this.handlePermissionRepliedSse(event as PermissionRepliedSseEvent);
  break;
// No "permission.rejected" case — server surfaces all rejections as permission.replied
```

The existing `handleEvent` already filters by `sessionID` (lines 791-798) — permission events for other sessions are dropped silently. No new filtering needed.

### 5.5 `handlePermissionAsked` flow

```ts
private handlePermissionAsked(event: PermissionAskedEvent): void {
  const req = event.properties;

  // Auto-mode shortcut: skip the WeChat card
  if (this.autoPermissionMode !== "off") {
    const reply: PermissionReply = this.autoPermissionMode === "once" ? "once" : "always";
    this.client.replyToPermission(req.id, reply, undefined, this.cwd)
      .then(() => {
        this.log(`[permission auto=${this.autoPermissionMode}] auto-replied id=${req.id.slice(0, 12)}… permission=${req.permission}`);
        // server emits permission.replied SSE for this request AND any siblings it cascades;
        // handlePermissionRepliedSse clears those slots. Nothing more to do here.
      })
      .catch((err) => {
        // Server already resolved (404) or network blip. Don't set pending — the
        // request is effectively gone. Sending a card and waiting for user reply
        // would just produce another 404 on their answer.
        this.log(`[permission auto] reply failed (likely already resolved), id=${req.id.slice(0, 12)}…: ${String(err)}`);
      });
    return;
  }

  // Manual flow: queue pending, notify bridge, arm timeout
  const contextToken = this.lastEnqueuedContextToken;
  if (!contextToken) {
    // No context → auto-reject so agent doesn't block
    this.client.replyToPermission(req.id, "reject", undefined, this.cwd).catch(() => {});
    return;
  }
  this.setPendingPermission(req, contextToken);
  this.onPermissionAsked?.(contextToken, req, req.id).catch((err) => {
    this.log(`[permission] onPermissionAsked callback error: ${String(err)}`);
  });
}
```

Note: in the auto-mode catch, we **do not** fall through to manual card flow. The request is gone on the server; setting `pending` would have the user's reply 404 again.

### 5.6 `handlePermissionRepliedSse`

```ts
private handlePermissionRepliedSse(event: PermissionRepliedSseEvent): void {
  this.clearPendingPermission(event.properties.requestID);
}
```

Clears the local slot for the resolved request. If the server cascaded a `reject` to siblings of the same sessionID, those siblings also get a `permission.replied` SSE event with `reply: "reject"` from `packages/opencode/src/permission/index.ts:140-149`, and they're cleared here too. **No client-side iteration needed.**

### 5.7 Constants

```ts
const PERMISSION_TIMEOUT_MS = 30 * 60_000;  // 30 min, matches question tool
```

### 5.8 `stopEventPipeline` cleanup

```ts
async stopEventPipeline(): Promise<void> {
  // ... existing code ...
  // New: clear all permission timeouts (callers like bridge.stop() handle the
  // HTTP-level reject for pending entries separately — see bridge.ts §7.4)
  for (const handle of this.permissionTimeoutHandles.values()) clearTimeout(handle);
  this.permissionTimeoutHandles.clear();
  // Do NOT clear pendingPermissions here — bridge.stop() reads them to send
  // the rejection HTTP calls (mirrors question tool's bridge.ts:366-372 pattern).
}
```

---

## 6. WeChat Card Format & Reply Parser (`src/adapter/permission-format.ts`, new file)

### 6.1 Card template (single pending permission)

```
🔒 Permission requested

Tool: {permission}
Resources:
  • {pattern_1}
  • {pattern_2}
  • (and N more…)

Choose one reply:
  1. once   — allow this call only
  2. always — allow this scope permanently (until server restart)
  3. reject — deny this call

Reply with: 1 | 2 | 3
Or send: /rp to reject, /ap once to auto-allow

(you have 30 minutes before auto-reject)
```

For multiple pending permissions (rare — parallel tool calls), append "Permission N/M" label and use `P{n}=…` syntax.

### 6.2 Card template — WeChat char limit guard

If the formatted card exceeds 1800 chars (leave 200-char margin under WeChat's 2000-char limit), truncate the patterns list with `(and N more…)` and emit a follow-up message: `(full patterns available via /status permission)`. Pattern count: capped display 10, then truncated.

### 6.3 User reply grammar (v2 — multi-pending cascade added after dogfood)

| Input | Single-pending | Multi-pending | Notes |
|---|---|---|---|
| `1` | `once` | **Cascade `once` to ALL** | Natural UX: the card says "Reply with 1 \| 2 \| 3" and the user reasonably expects that to apply to all pending permissions |
| `2` | `always` | **Cascade `always` to ALL** | Same as above |
| `3` | `reject` | **Cascade `reject` to ALL** | Same as above |
| `once` / `always` / `reject` | That decision | **Cascade to ALL** | Bare keywords recognized in BOTH cases (was originally single-only; revised after dogfood) |
| `P1=once` | `once` for P1 | `once` for P1 | Explicit per-permission, works in both cases |
| `P1=once P2=reject` | n/a | Per-permission mix | Order doesn't matter |
| `P1-once with note` | n/a | `reject` + `message: "once with note"` for P1 | Dash form always means "send a custom-text rejection" (mirrors question tool's `Q1-text`) |
| `reject because X` (no P prefix) | `reject` + `message` for the one | `reject` + `message` for ALL | Keyword + trailing text becomes a custom rejection message |
| `P1=1, 3` | **Invalid** | **Invalid** | Multi-select not supported; reject with warning |
| `1 2` (space-separated) | n/a | Unrecognized | Can't tell if it's "1 then 2" (cascade twice?) or garbage |
| Mobile whitespace | `P1 = once`, `P1 =once`, `P1= once` | Same | Space around `=` only (NOT between P and digit — matches question tool) |
| Empty input | Warning + skip | Warning + skip | Caller re-prompts |
| `/rp`, `/reject-permission` | Intercepted at §7.7 priority | Same | Does NOT enter the parser |
| `/ap …`, `/auto-permission …` | Intercepted at §7.7 priority | Same | Does NOT enter the parser |

**Position 1-3 mapping is fixed:** 1=once, 2=always, 3=reject. Stated explicitly in the card so users don't need to memorize it.

**Multi-pending cascade rationale (v2):** The original design restricted bare keywords to single-pending only, on the theory that multi-pending needs disambiguation. Dogfood showed this created a confusing UX: the card said "Reply with 1 | 2 | 3" but the parser rejected "1" when 2+ permissions were pending. The natural mental model is "the card tells me to type 1, so 1 should work" — the user shouldn't have to remember the multi-pending case requires `P{n}=` syntax. The v2 fix: bare positional AND bare keyword BOTH cascade to all pending; `P{n}=…` is the explicit per-permission override.

### 6.4 Parser — `parsePermissionReply(input, pending)`

This parser **intentionally diverges** from `parseQuestionReply` because permission semantics are different (single-choice, not multi-select; bare keywords make sense).

```ts
export function parsePermissionReply(
  input: string,
  pending: ReadonlyArray<PendingPermission>,
): PermissionParseResult {
  // Implementation summary (full code in permission-format.ts):
  // 1. Trim input. If empty → { decisions: [], warnings: ["empty input"] }.
  // 2. Split on whitespace into segments; for each segment:
  //    a. Match /^P(\d+)\s*=\s*(.+)$/i → permission-indexed explicit reply.
  //       - Parse the RHS as either: a number (→ positional map), a keyword
  //         (once|always|reject), or freeform text (→ custom rejection message).
  //    b. Match /^P(\d+)\s*-\s*(.+)$/i → permission-indexed custom rejection.
  //    c. If pending.length === 1 and segment is exactly "1"|"2"|"3" → positional.
  //    d. If pending.length === 1 and segment is exactly "once"|"always"|"reject"
  //       (case-insensitive) → that decision.
  //    e. If pending.length === 1 and segment matches /^(once|always|reject)\s+(.+)$/i
  //       → keyword decision, remainder stored for warning ("extra text ignored").
  //    f. If pending.length === 1 and segment contains a comma (e.g., "1, 3") →
  //       multi-select warning, ignore segment.
  // 3. Return { decisions, warnings }.
}
```

**Truncation:** The `message` field (only set when `reply === "reject"` and input has freeform text) is truncated to **500 chars** in `parsePermissionReply`, matching `MAX_ANSWER_ELEMENT_LEN` in `src/adapter/question-format.ts:35`.

### 6.5 Card formatting — `formatPermissionCard(request, index?, total?)`

Mirrors `formatQuestionForWeChat` (363 lines, src/adapter/question-format.ts). Outputs a single string ≤ 1800 chars (truncates patterns list at 10 with `(and N more…)`).

---

## 7. Bridge Wiring (`src/bridge.ts`)

### 7.1 Constructor — wire callbacks

When `SessionManager` is constructed (alongside existing question callbacks at bridge.ts:289-305):

```ts
onPermissionAsked: async (contextToken, request, requestID) => {
  const card = formatPermissionCard(request);
  await this.sendReply(contextToken, card);
  this.log(`[permission] card sent: id=${requestID.slice(0, 12)}… permission=${request.permission} patterns=${request.patterns.length}`);
},
onPermissionTimedOut: async (contextToken, requestID) => {
  await this.sendReply(
    contextToken,
    "⏱ Permission timed out after 30 minutes. The tool call was rejected. (Use /next to reset counter.)",
  );
},
```

### 7.2 Startup cleanup — leaked permissions

After leaked-question cleanup (bridge.ts:320-335), add leaked-permission cleanup:

```ts
try {
  const leaked = await this.sessionManager.listLeakedPermissions(this.config.agent.cwd);
  for (const req of leaked) {
    try {
      await this.client.replyToPermission(req.id, "reject", undefined, this.config.agent.cwd);
      this.log(`[permission-startup] rejected leaked permission id=${req.id.slice(0, 12)}…`);
    } catch { /* best-effort */ }
  }
  if (leaked.length > 0) {
    this.log(`[permission-startup] rejected ${leaked.length} leaked permission(s)`);
  }
} catch (err) {
  this.log(`[permission-startup] leaked-permission check failed (non-fatal): ${String(err)}`);
}
```

### 7.3 Auto-mode restoration

On bridge startup, after loading user state, restore `autoPermissionMode`:

```ts
const saved = this.loadUserState();
const mode: AutoPermissionMode = saved.autoPermissionMode ?? DEFAULT_AUTO_PERMISSION_MODE;
this.sessionManager.setAutoPermissionMode(mode);
this.log(`[permission] auto-mode restored: ${mode}`);
```

### 7.4 Shutdown cleanup — reject all pending permissions

After question cleanup (bridge.ts:362-372), add:

```ts
if (this.sessionManager?.hasPendingPermission()) {
  const pending = this.sessionManager.listPendingPermissions();
  this.log(`[permission-shutdown] rejecting ${pending.length} pending permission(s)`);
  for (const p of pending) {
    try {
      await this.sessionManager.rejectPendingPermission(p.requestID);
    } catch { /* best-effort during shutdown */ }
  }
}
```

Then call `this.sessionManager.stopEventPipeline()` (which clears timeouts per §5.8).

### 7.5 Inbound routing — `handleMessage()`

**REPLACE** the existing question check at bridge.ts:607 with a unified check:

```ts
// Order: permission check BEFORE question check (rationale: §7.6)
if (this.sessionManager?.hasPendingPermission()) {
  const text = this.extractTextFromMessage(msg);
  if (text === null) {
    this.sendReply(contextToken, "⚠️ 当前正在等待 permission 回复...").catch(() => {});
    return;
  }
  this.handlePermissionReply(contextToken, text).catch((err: unknown) => {
    this.log(`handlePermissionReply error: ${String(err)}`);
  });
  return;
}
if (this.sessionManager?.hasPendingQuestion()) {
  // existing question check (bridge.ts:607-622)
  ...
}
```

Both checks must short-circuit before the regular message routing begins. Do NOT add a third branch.

### 7.6 Ordering: permission BEFORE question

**Decision:** Permission check first.

**Reasoning:**
- Permission cards have higher urgency (an agent is blocked on a tool call).
- If a permission is pending, it's almost certainly the most recent thing the user saw.
- The user can still `/rp` (alias of `/reject-permission`) to dismiss the permission and free the slot.
- Known UX cost: if a question card is pending AND a permission card lands later (because question was answered first then a follow-up permission came), the user's subsequent question-style input (e.g., `Q1=1`) will be routed to permission parser → warning → re-prompt. The next message will route correctly. This is acceptable; documented in §11 user-facing text.

### 7.7 `handlePermissionReply`

Mirrors `handleQuestionReply` (bridge.ts:786-864):

```ts
private async handlePermissionReply(contextToken: string, text: string): Promise<void> {
  const pending = this.sessionManager?.listPendingPermissions() ?? [];
  if (pending.length === 0) return;

  const trimmed = text.trim();

  // Priority commands (override any parse) — order matters
  if (parseRejectPermissionCommand(trimmed)) {
    for (const p of pending) {
      await this.sessionManager!.rejectPendingPermission(p.requestID);
    }
    await this.sendReply(contextToken, "❌ Permission rejected.");
    return;
  }
  // /stop, /next, /restart are NOT priority for permission — they make less sense
  // when the agent is blocked on a tool call. The user can reply 3 / reject / /rp.
  // /stop still works via the regular command dispatcher when no permission is pending.

  // Informational commands: run without rejecting
  if (parseHelpCommand(trimmed)) { this.sendHelpReply(contextToken).catch(() => {}); return; }
  const stCmd = parseStatusCommand(trimmed);
  if (stCmd) { this.handleStatusCommand(contextToken, stCmd).catch(() => {}); return; }
  const apCmd = parseAutoPermissionCommand(trimmed);
  if (apCmd) { this.handleAutoPermissionCommand(contextToken, apCmd).catch(() => {}); return; }

  // Default: parse as permission reply
  const parsed = parsePermissionReply(trimmed, pending);
  for (const w of parsed.warnings) this.log(`[permission] parse warning: ${w}`);

  if (parsed.decisions.length === 0) {
    await this.sendReply(contextToken,
      `⚠️ Unrecognized reply. Send 1 (once), 2 (always), 3 (reject), or /rp. Pending: ${pending.length} permission(s).`);
    return;
  }

  for (const decision of parsed.decisions) {
    try {
      await this.sessionManager!.answerPendingPermission(
        decision.requestID,
        decision.reply,
        decision.message,
      );
    } catch (err) {
      // Server already resolved (404) — race with auto-cascade or another client.
      this.log(`[permission] reply failed (likely already resolved): ${String(err)}`);
      await this.sendReply(contextToken,
        "⏱ Permission 已过期（可能已被自动处理）。请重发消息。");
    }
  }
  await this.sendReply(contextToken, `✅ Permission handled: ${parsed.decisions.map(d => d.reply).join(", ")}.`);
}
```

---

## 8. Commands (`src/adapter/workspace-cmd.ts`)

### 8.1 `/auto-permission` parser

```ts
export type AutoPermissionCommand =
  | { kind: "auto-permission"; mode: "off" | "once" | "always" | "status" };

export function parseAutoPermissionCommand(text: string): AutoPermissionCommand | null {
  const t = text.trim().toLowerCase();
  if (t === "/auto-permission" || t === "/ap") return { kind: "auto-permission", mode: "status" };
  const m = t.match(/^\/(?:auto-permission|ap)\s+(off|once|always|status)\s*$/);
  if (!m) return null;
  return { kind: "auto-permission", mode: m[1] as "off" | "once" | "always" | "status" };
}
```

Aliases: `/auto-permission` ↔ `/ap`. Subcommands: `off`, `once`, `always`, `status`.

### 8.2 `/reject-permission` parser (mirrors `/reject-question`)

```ts
export interface RejectPermissionCommand { kind: "reject-permission"; }
export function parseRejectPermissionCommand(text: string): RejectPermissionCommand | null {
  const t = text.trim().toLowerCase();
  if (t === "/reject-permission" || t === "/rp") return { kind: "reject-permission" };
  return null;
}
```

### 8.3 Bridge handler — `handleAutoPermissionCommand`

```ts
private async handleAutoPermissionCommand(contextToken: string, cmd: AutoPermissionCommand): Promise<void> {
  if (cmd.mode === "status") {
    await this.sendReply(contextToken,
      `🔒 Auto-permission mode: **${this.sessionManager!.getAutoPermissionMode()}**`);
    return;
  }
  this.sessionManager!.setAutoPermissionMode(cmd.mode);
  await this.saveUserStateSafe({ autoPermissionMode: cmd.mode });
  const desc = cmd.mode === "off"
    ? "shown as WeChat cards (current behavior)"
    : cmd.mode === "once"
    ? "auto-allowed (one-shot) — no card"
    : "auto-allowed permanently (server-side rules; lost on opencode restart)";
  await this.sendReply(contextToken, `🔒 Auto-permission set to **${cmd.mode}**. Future requests: ${desc}.`);
}
```

### 8.4 `/status` integration

`handleStatusCommand` adds a line for auto-permission mode, placed after the existing reasoning/model/agent/context lines, before the closing footer:

```
🔒 Auto-permission: off   (use /auto-permission [off|once|always|status] to change)
```

### 8.5 Help text (`formatHelp()` + `formatHelpWithNativeCommands()`)

Add a `── Permission ──` section:

```
── Permission ──
/reject-permission  (alias /rp)   Dismiss pending permission card(s)
/auto-permission    (alias /ap)   Toggle auto-accept: off | once | always | status
```

---

## 9. Persistence (`src/config.ts` + state.json)

### 9.1 State shape (extends `UserState`)

```ts
interface UserState {
  users: UserRecord[];
  updatedAt: string;
  showThoughts?: boolean;
  showTools?: boolean;
  autoPermissionMode?: AutoPermissionMode;   // new; default 'off' when absent
}
```

### 9.2 Read/write helpers

- Extend `loadUserState()` to default `autoPermissionMode` to `"off"` when absent.
- Extend `saveUserState()` to include `autoPermissionMode` when set.
- Add `saveUserStateSafe(partial)` that merges partial fields (used by `/auto-permission` command without rewriting the full state).
- **No migration needed** — existing state files lack the field → treated as `"off"`.

### 9.3 Persistence caveat

The bridge persists `autoPermissionMode` (a client-side preference), but does NOT persist "always" rules (server-side). Documented in §11.

---

## 10. Tests (`src/__tests__/`)

### 10.1 `test-permission-format.mjs` (~22 cases)

**`formatPermissionCard` — single permission (6 cases):**
1. Renders all patterns (≤10) → all visible.
2. Renders >10 patterns → truncated with `(and N more…)`.
3. Includes `1 / 2 / 3` positional hint.
4. Includes `/rp` reject hint.
5. Includes 30-min timeout hint.
6. Omits `tool` line when `request.tool` is undefined.

**`formatPermissionCard` — multiple permissions (1 case):**
7. Renders "Permission N/M" label and `Pn=` syntax when `pending.length > 1`.

**`parsePermissionReply` — single permission (7 cases):**
8. `"1"` → `once`.
9. `"2"` → `always`.
10. `"3"` → `reject`.
11. `"once"` (bare keyword) → `once`.
12. `"P1=always"` → `always`.
13. `"P1 = once"` (mobile whitespace) → `once`.
14. `""` (empty) → no decision, warning.

**`parsePermissionReply` — multi permission (5 cases + v2 cascade):**
15. `"P1=once P2=reject"` → two decisions, one per pending.
16. `"1 2"` positional with multi-pending → warning, no decisions.
17. `"P9=once"` (out-of-range index) → warning, no decision.
18. `"P1=once P1=reject"` (duplicate index) → second wins, warning.
19. `"P1=1, 3"` (multi-select) → warning "multi-select not supported", no decision.
20. **v2** `"1"` (multi-pending) → CASCADE: `once` for ALL pending.
21. **v2** `"2"` (multi-pending) → CASCADE: `always` for ALL pending.
22. **v2** `"3"` (multi-pending) → CASCADE: `reject` for ALL pending.
23. **v2** `"once"` (multi-pending bare keyword) → CASCADE: `once` for ALL.
24. **v2** `"reject because X"` (multi-pending keyword+text) → CASCADE: `reject` + `message: "because X"` for ALL.

**`parsePermissionReply` — custom message (3 cases):**
25. `"P1-this is a custom rejection"` → `reply: "reject"`, `message: "this is a custom rejection"`.
26. `"P1=reject because I said so"` → `reply: "reject"`, `message: "because I said so"`.
27. 800-char message → truncated to 500 chars.

### 10.2 `test-session-permission.mjs` (~15 cases)

1. `handlePermissionAsked: normal path (off mode)`: fills pendingPermissions, fires onPermissionAsked, arms 30-min timeout.
2. `handlePermissionAsked: auto=once`: calls client.replyToPermission(id, "once"), never sets pending.
3. `handlePermissionAsked: auto=always`: calls client.replyToPermission(id, "always"), never sets pending.
4. `handlePermissionAsked: auto=mode but server throws`: client reply rejected, NO pending set, NO card sent.
5. `handlePermissionAsked: no contextToken`: auto-rejects with `reply: "reject"`, no pending set.
6. `handlePermissionAsked: duplicate (already pending same ID)`: appends to map (multi-ID allowed), each with own timeout.
7. `answerPendingPermission: normal path`: clears slot + timeout, calls client with right body.
8. `answerPendingPermission: client throws`: timeout cleared in `finally`, error rethrown.
9. `rejectPendingPermission: normal path`: clears slot FIRST (race-safe), then HTTP reject.
10. `rejectPendingPermission: no pending`: no-op.
11. `handlePermissionRepliedSse: clears matching ID only`: doesn't touch other pending permissions.
12. `handlePermissionRepliedSse: unknown requestID`: no-op (race-safe).
13. `soft timeout 30 min → auto-reject`: uses fake timers, fires onPermissionTimedOut + calls client.replyToPermission(id, "reject").
14. `soft timeout early reply → timer cleared`: reply at 5 min, no timeout fires later.
15. `setAutoPermissionMode / getAutoPermissionMode`: round-trip + initial default = "off".
16. `listLeakedPermissions: filters correctly`: by sessionID + excludes local IDs.

---

## 11. Documentation Updates

### 11.1 `AGENTS.md`

- **Architecture listing** (lines 46-47): add `permission.ts` (PermissionRequest, PendingPermission, AutoPermissionMode) and `permission-format.ts` (format/parse permission cards).
- **Line 56-57**: add `parseRejectPermissionCommand`, `parseAutoPermissionCommand` to workspace-cmd.ts row; add `permission-format.ts` row.
- **Line 145** (Constraints section): REPLACE the bullet *"Permission requests are auto-approved — handled server-side by OpenCode"* with *"Permission requests surface to WeChat as cards with `once`/`always`/`reject` choices; `/auto-permission [off|once|always]` toggles auto-accept; 30-minute soft timeout."*
- **Line 79** ("ACL, permission handling, tool execution are all server-side"): leave as-is (still accurate; the bridge doesn't run its own ACL).
- **Line 140** ("Adding Features → New question tool support"): add permission tool as a second canonical pattern, listing all files that need changes + the new `/auto-permission` command.
- **New section after Question** (around line 250): user-facing docs.

### 11.2 `README.md` (Chinese)

- Add "工具权限审批" section in Features: "WeChat 弹权限卡片，支持 `once` / `always` / `reject` 三选一；`/auto-permission` 可切换自动接收模式；30 分钟软超时自动 reject"。
- Add new section "工具权限（/reject-permission, /auto-permission）" with the full grammar from §6.3.
- Search-and-replace any existing "auto-approved" claim with the new behavior description.

### 11.3 `README.en.md`

- **Line 203**: REPLACE "Permission requests are auto-approved" with the new behavior description (mirror §11.2 content in English).
- Same search-and-replace for any other "auto-approved" instances.

### 11.4 `CHANGELOG.md`

Add entry:
```
## v1.3.0
- **Permission tool: full WeChat interaction.** New cards for OpenCode `permission.asked` events with `once`/`always`/`reject` options.
- **`/auto-permission` command** (alias `/ap`): toggle auto-accept (`off` / `once` / `always`); status visible in `/status`.
- **`/reject-permission` command** (alias `/rp`): dismiss pending cards.
- **30-minute soft timeout** for unanswered permission cards (auto-reject).
- **Docs fix.** Removed outdated "permission requests are auto-approved" claims from current docs (the claim originated from v0.1.0's ACP-era behavior and never matched the current HTTP architecture).
```

---

## 12. Verification Plan

### 12.1 Automated

1. `npm run build` — no TypeScript errors.
2. `npm test` — all existing 141 tests + new ~37 tests pass (target ≥178 total).

### 12.2 Smoke tests (manual, end-to-end)

Set up: bridge with `--server-url http://localhost:4096`, `opencode.json` configures one tool (e.g., `bash`) with `permission: "ask"`.

| # | Action | Expected |
|---|---|---|
| 1 | Send WeChat message triggering bash tool | WeChat shows card with 1/2/3 options |
| 2 | Reply `1` (once) | Tool executes; agent continues |
| 3 | Send another triggering bash | Card appears again |
| 4 | Reply `2` (always) | Tool executes; server stores in `InstanceState.approved` (in-memory) |
| 5 | Restart `opencode serve` (without restarting bridge) | "Always" rule lost (in-memory); next bash triggers card again |
| 6 | Reply `3` (reject) | Tool blocked; agent sees `RejectedError` message; card cleared |
| 7 | Run `/auto-permission once` | Reply "🔒 Auto-permission set to once…" |
| 8 | Run `/status` | See "🔒 Auto-permission: once" line |
| 9 | Send a bash trigger | No card; tool executes |
| 10 | Run `/auto-permission off` | Card returns on next trigger |
| 11 | Run `/auto-perpermission status` (typo test) | Unrecognized; falls through to regular routing |
| 12 | Run `/auto-permission always` → send trigger (no card) → `/auto-permission once` → send trigger (still no card) | Latest mode wins; `once` applies; no card |
| 13 | Run `/auto-permission off` → send trigger (card appears) → don't reply for 31 min | 30-min timeout fires; auto-reject sent to server; user gets "⏱ Permission timed out…" |
| 14 | Run `/auto-permission off` → send trigger (card appears) → reply `/rp` | Card cleared; "❌ Permission rejected." |
| 15 | Send non-text message (image) while card pending | "⚠️ 当前正在等待 permission 回复..." warning |
| 16 | Existing question flow regression: trigger a question tool, reply `Q1=1` | Question flow still works |

### 12.3 Race-condition verification

| # | Scenario | Expected |
|---|---|---|
| R1 | Two parallel tools both need permission; reply `3` to first | Both rejected (server cascade); both cards cleared by `permission.replied` SSE |
| R2 | Reply `1` while server already cascaded `reject` | 404 on POST; user gets "⏱ Permission 已过期..." message |
| R3 | Bridge restart with 2 pending permissions on server | Startup log shows 2 leaked permissions rejected |
| R4 | Bridge shutdown with 1 pending permission | Log shows "rejecting 1 pending permission(s)"; HTTP call made; SSE cleaned up |

---

## 13. Risk & Edge Cases

| Risk | Mitigation |
|---|---|
| Multiple permissions in parallel race | Each keyed by `requestID` in a `Map`; each gets own timeout. Server's `reject` cascades to siblings of same sessionID automatically — no client-side iteration needed (`handlePermissionRepliedSse` handles the SSE echo). |
| Server already-resolved request (404 on POST) | `client.replyToPermission` throws; `handlePermissionReply` sends "⏱ Permission 已过期" message; local slot already cleared by prior SSE echo or by the error path's `finally`. |
| User types gibberish while card pending | Parser returns `decisions: []` with a warning; `handlePermissionReply` sends re-prompt. |
| Auto-mode flipped mid-card | If `/auto-permission once` is set while a card is pending, the card stays pending (only FUTURE `permission.asked` events auto-reply). Documented in `/auto-permission` reply text. |
| Crash mid-reply | `permissionTimeoutHandles` is cleared in `stopEventPipeline`; on restart, `listLeakedPermissions` cleans up server-side orphans with `reply: "reject"`. |
| WeChat message splitting | `/auto-permission` parser is exact-match on trimmed lowercase; multi-line sends are separate WeChat messages. No special handling. |
| `permission.replied` SSE arrives for unknown requestID | `clearPendingPermission` no-ops when key absent (race-safe). |
| WeChat 2000-char limit on long pattern lists | `formatPermissionCard` truncates patterns at 10 with `(and N more…)`; total card ≤1800 chars. |
| Bridge started in `once` mode, then switched to `always` mid-flow | New mode applies to future events only; existing pending cards are unchanged. |
| `always` rules lost on `opencode serve` restart | Bridge does NOT shadow-store; documented in §11 user-facing text + `/auto-permission always` response. |
| User types `Q1=1` while permission card is pending | Permission check runs first (§7.5); parser sees `Q1=1` → no match → warning + re-prompt. Next message routes correctly (assuming user answered permission first or it's auto-resolved). |
| Permission tool + question tool pending simultaneously | Permission card is shown (higher priority). User must clear permission first; question card returns next. |
| Auto-mode change to `always` while card already showing `once` reply pending | Bridge doesn't un-resolve — once replied stays once. The newly-set `always` mode affects the NEXT event only. |
