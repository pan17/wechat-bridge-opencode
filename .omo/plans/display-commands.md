# Display Commands: thought-display + tool-display

## TL;DR

> **Quick Summary**: Split the existing coupled `/thought` command into two independent commands (`/thought-display` and `/tool-display`) with separate state, and actually wire up `showThoughts` so the model's reasoning content is sent to WeChat (with a 🧠 summary header) when enabled, or only logged when disabled.
>
> **Deliverables**:
> - Two new `/thought-display` and `/tool-display` commands with `on/off/status` subcommands
> - Removal of the old `/thought` command (no alias)
> - Persistence of `showThoughts` and `showTools` flags in `UserState` (top-level)
> - Functional `showThoughts`: accumulate reasoning deltas, send formatted reasoning to WeChat when on, log summary only when off
> - Updated `/help`, `AGENTS.md`, `README.md`, `README.en.md`
> - Verification script that exercises both commands end-to-end
>
> **Estimated Effort**: Short (3–5h implementation, including verification)
> **Parallel Execution**: YES — 4 waves, 3-4 tasks per wave
> **Critical Path**: Task 1 (pure functions) → Task 6 (event hookup) → Task 4 (command handlers) → F1-F4

---

## Context

### Original Request

User reported `/thought` was "not implemented" — after investigation, the parser, handler, and config exist but the `showThoughts` flag is a no-op: SSE `reasoning` parts are silently dropped at `session.ts:581-584` and `handlePartUpdated` has no `reasoning` branch. User wants:
- Two independent commands instead of the current coupled `/thought` (which sets `showThoughts` and `showTools` together at `bridge.ts:1274, 1280`)
- Thinking content to actually appear in WeChat when enabled
- Off-mode behavior: log only, no WeChat send

### Interview Summary

**Key Decisions**:
- New commands: `/thought-display` and `/tool-display` (no `/thought` alias)
- Subcommands: `on` / `off` / `status` (mirror existing `/reasoning` style)
- Persistence: 2 independent optional fields in `UserState` (top-level, alongside `users[]`)
- Defaults: both `false`
- Mid-turn toggle: **snapshot at `beginTurn`** — turn-internal behavior is fixed
- Off-mode: log only, do not send to WeChat
- On-mode: stream `🧠 Thought: {title} · {duration}` header + full reasoning body (or just header if no body)
- Multiple reasoning parts in one turn: SUM duration + char count
- `/status`: NOT modified (display flags visible only via their own status commands)
- `/help`: two separate sections (one per command)
- `formatForWeChat` applied to reasoning body via the same `sendReply` path as text
- Dead `config.agent.show*` fields: leave alone, mark `@deprecated` in JSDoc
- Dedup: new `sentReasoningPartIds: Set<string>` on `AccumulatedTurn`
- `messageID === turn.assistantMessageId` filter inside `handleReasoningPart` (mirror text-part logic)

**Research Findings**:
- OpenCode Server has NO per-request flag for thinking/tool display — all client-side
- TUI uses `reasoningSummary()` regex `^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)` to extract a title from `**Title**\n\nbody`
- TUI strips `[REDACTED]` placeholder (OpenRouter) before display
- `setShowFlags` at `session.ts:1398-1404` already handles partial updates safely (`!== undefined` guard)
- `sendReply` at `bridge.ts:1671-1673` automatically applies `formatForWeChat` (markdown stripping)

### Metis Review

**60 findings addressed** (`.omo/drafts/display-commands.md` records the full set):
- **Applied (MINOR)**: `messageID` filter, `sentReasoningPartIds` dedup, snapshot at `beginTurn`, sum multiple reasoning parts, skip log if `charCount === 0`, leave `config.agent.show*` deprecated, both help sections updated, formatForWeChat via sendReply
- **Asked (CRITICAL)**: mid-turn snapshot semantics (chose snapshot), `/status` not modified (chose no)
- **Excluded (scope creep)**: per-reasoning expand/collapse (impossible in WeChat), sub-agent reasoning (existing session filter drops it), CHANGELOG/version bump (separate concern), translation of reasoning level to model suffix (existing TODO at `session.ts:1392`)

---

## Work Objectives

### Core Objective

Split `/thought` into two independent commands (`/thought-display`, `/tool-display`) and make `showThoughts` actually work — streaming the model's reasoning content to WeChat with a summary header when enabled, or logging it silently when disabled.

### Concrete Deliverables

1. `src/adapter/thinking-format.ts` — new file with `reasoningSummary()`, `formatThoughtHeader()`, `formatDuration()` pure functions + unit assertions
2. `src/adapter/workspace-cmd.ts` — replace `parseThinkingCommand` with `parseThoughtDisplayCommand` + `parseToolDisplayCommand`; update both help functions
3. `src/server/session.ts` — extend `AccumulatedTurn` with reasoning fields; rewrite `handlePartDelta` to accumulate reasoning; add `handlePartUpdated` reasoning branch; add `handleReasoningPart` method; extend `finalizeTurn` to log off-mode summary
4. `src/bridge.ts` — extend `UserState` with `showThoughts?` and `showTools?`; update `loadUserState`/`saveUserState`; replace `handleThinkingCommand` with two handlers; update dispatch order and `detectUnknownSlashCommand`; pass `setShowFlags` from persisted state
5. `scripts/verify-display-commands.mjs` — end-to-end verification (persistence round-trip, command independence, legacy state compat, `/thought` removal)
6. `AGENTS.md`, `README.md`, `README.en.md` — document the two new commands and remove `/thought`

### Definition of Done

- [ ] `npm run build` → 0 errors
- [ ] `node scripts/verify-display-commands.mjs` → all assertions PASS
- [ ] `node scripts/test-thinking-format.mjs` → all assertions PASS
- [ ] `/thought-display on` and `/tool-display on` are independent (toggling one doesn't affect the other)
- [ ] State persists across bridge restarts
- [ ] Old state files (no `showThoughts`/`showTools`) load without crash, defaults `false`
- [ ] `/thought on` produces the "unknown slash command" hint
- [ ] `/help` shows both new commands, does NOT show `/thought` as a bridge command
- [ ] `AGENTS.md` and `README*.md` are consistent with the new command surface

### Must Have

- `showThoughts=off` does NOT send reasoning to WeChat (only to bridge log)
- `showThoughts=on` DOES send reasoning to WeChat with `🧠 Thought: {title} · {duration}` header
- Reasoning body is filtered by `messageID === turn.assistantMessageId` (no user-side echo)
- Reasoning parts are deduplicated by `partID` (no double-send on SSE replay)
- `/thought` is removed (parser, handler, dispatch, detection list, help, docs)
- `UserState` round-trips through `loadUserState`/`saveUserState` with both new fields
- `config.agent.showThoughts`/`config.agent.showTools` are marked `@deprecated` in JSDoc but left in the schema (not removed)

### Must NOT Have (Guardrails)

- Do NOT modify `buildToolSummary` body at `session.ts:973-982` (existing tool summary is sacred)
- Do NOT change the relative ordering of existing parsers in `handleMessage` (slot new ones at the same position as old `parseThinkingCommand`)
- Do NOT try to surface sub-agent reasoning (the session filter at `session.ts:515-521` drops it intentionally)
- Do NOT add display flags to `/status` output
- Do NOT remove `config.agent.showThoughts`/`config.agent.showTools` from the config interface (mark deprecated instead)
- Do NOT translate reasoning level to model suffix (existing TODO at `session.ts:1392` is out of scope)
- Do NOT add per-reasoning expand/collapse UI (impossible in WeChat)
- Do NOT truncate reasoning body (TUI's "all or nothing" pattern: either full text or just the header)

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed. No exceptions.
> Acceptance criteria requiring "user manually tests/confirms" are FORBIDDEN.

### Test Decision

- **Infrastructure exists**: NO (per AGENTS.md)
- **Automated tests**: **None** (no framework), but pure functions get `bun` assertions in a standalone script
- **Framework**: `bun` for pure-function assertions, `node` for end-to-end verification script
- **If TDD**: N/A — no test framework

### QA Policy

Every implementation task MUST include agent-executed QA scenarios (see TODO template below). Evidence saved to `.omo/evidence/display-commands/task-{N}-{scenario-slug}.{ext}`.

- **Pure functions**: Use `bun` assertions in `scripts/test-thinking-format.mjs`
- **End-to-end command flow**: Use a custom verification script `scripts/verify-display-commands.mjs` that calls bridge internals (parser, handler logic) directly
- **Build verification**: `npm run build` must complete with exit code 0
- **File/grep verification**: Use `grep` to assert removed patterns and present patterns

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — pure functions + parser surface):
├── Task 1: thinking-format.ts (NEW pure functions + bun assertions)
├── Task 2: workspace-cmd.ts (replace parsers + update both help functions)
└── Task 3: AGENTS.md + README docs (write — no code dependencies)

Wave 2 (After Wave 1 — state + handlers, MAX PARALLEL):
├── Task 4: bridge.ts — UserState + load/save + dispatch + 2 new handlers + detectUnknownSlashCommand
└── Task 5: session.ts — AccumulatedTurn extensions + beginTurn snapshot + setShowFlags wiring

Wave 3 (After Wave 2 — core feature wiring + verification):
├── Task 6: session.ts — handlePartDelta reasoning accumulator + handlePartUpdated reasoning branch + handleReasoningPart method + finalizeTurn off-mode log
└── Task 7: scripts/verify-display-commands.mjs (end-to-end verification harness)

Wave FINAL (After ALL tasks — 4 parallel reviews, then user okay):
├── Task F1: Plan compliance audit (oracle)
├── Task F2: Code quality review (unspecified-high)
├── Task F3: Real manual QA (unspecified-high + build/run)
└── Task F4: Scope fidelity check (deep)
→ Present results → Get explicit user okay

Critical Path: Task 1 → Task 6 → Task 4 → F1-F4
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 3 (Wave 1)
```

### Dependency Matrix

- **Task 1**: None (can start immediately)
- **Task 2**: None (can start immediately)
- **Task 3**: None (can start immediately, but ideally after Task 2 for accuracy)
- **Task 4**: Blocks 6 (handler needs to exist before event hookup references its state), depends on 2 (parsers must exist)
- **Task 5**: Blocks 6 (turn state must exist), depends on 1 (uses formatThoughtHeader)
- **Task 6**: depends on 1, 5 (uses format functions + extended turn state)
- **Task 7**: depends on 4, 6 (exercises both command surface and event flow)
- **F1-F4**: depends on 1-7

### Agent Dispatch Summary

- **Wave 1 (3)**: T1 → `quick`, T2 → `quick`, T3 → `writing`
- **Wave 2 (2)**: T4 → `unspecified-high`, T5 → `unspecified-high`
- **Wave 3 (2)**: T6 → `deep`, T7 → `quick`
- **FINAL (4)**: F1 → `oracle`, F2 → `unspecified-high`, F3 → `unspecified-high`, F4 → `deep`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> **A task WITHOUT QA Scenarios is INCOMPLETE. No exceptions.**
> **FORMAT**: Task labels MUST use bare numbers: `1.`, `2.`, `3.`
> Final Verification Wave labels MUST use `F1.`, `F2.`, etc.

- [x] 1. Create thinking-format.ts pure functions + bun assertions

  **What to do**:
  - Create `src/adapter/thinking-format.ts` with three exported pure functions:
    - `reasoningSummary(text: string): { title: string | null; body: string }` — strips `[REDACTED]` placeholders, trims, then runs the TUI regex `^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)` to extract a title. Returns `{ title: null, body: cleaned }` if no match.
    - `formatThoughtHeader(durationMs: number, title: string | null): string` — returns `🧠 Thought: ${title} · ${duration}` if title, else `🧠 Thought · ${duration}`. Duration via `formatDuration`.
    - `formatDuration(ms: number): string` — `< 1000` → `${ms}ms`; else `${(ms / 1000).toFixed(1)}s` (e.g., `2.3s`, `0.4s`, `12.7s`).
  - Add module-level JSDoc explaining the TUI reference and the `**Title**\n\nbody` pattern.
  - Add 1-line `@example` block for each function in JSDoc.
  - All functions must be deterministic and side-effect-free (no I/O, no Date.now, no random).

  **Must NOT do**:
  - No imports from project modules — this file must remain a pure utility.
  - No use of `as any` or `@ts-ignore`.
  - No streaming / chunking logic (caller's responsibility).
  - No locale formatting (English-only "ms" / "s" suffixes).

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: small pure-function file, well-specified regex and format
  - **Skills**: `[]`
    - No skill overlap — file is independent of any domain skill

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: 5, 6 (consumers of these functions)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `src/adapter/outbound.ts:9-30` — same pattern: pure export, no I/O, double quotes, template literals
  - **API/Type References** (contracts to implement against):
    - `src/types/events.ts:65-68` — `ReasoningPart` interface (only has `text: string`)
  - **Test References** (testing patterns to follow):
    - N/A — no test framework; use bun assertions
  - **External References** (libraries and frameworks):
    - opencode tui `packages/tui/src/context/thinking.ts:12-17` — exact regex source for `reasoningSummary` (treat as reference, not direct copy — strip `[REDACTED]` first)

  **Acceptance Criteria**:

  > AGENT-EXECUTABLE VERIFICATION ONLY — No human action permitted.

  - [ ] File exists: `src/adapter/thinking-format.ts`
  - [ ] `npx tsc --noEmit` on the file → 0 errors
  - [ ] `bun scripts/test-thinking-format.mjs` → all assertions PASS (script to be created in Task 1 — see QA below)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: reasoningSummary extracts title from **Title**\\n\\nbody pattern
    Tool: bun
    Preconditions: scripts/test-thinking-format.mjs exists and imports the module
    Steps:
      1. Call reasoningSummary("**Inspecting PR workflow**\n\nLooking at the diff...")
      2. Assert returned.title === "Inspecting PR workflow"
      3. Assert returned.body === "Looking at the diff..."
    Expected Result: title and body correctly split
    Failure Indicators: title is null, or body still contains the **...** marker
    Evidence: .omo/evidence/display-commands/task-1-reasoning-summary-title.txt

  Scenario: reasoningSummary returns null title when no marker
    Tool: bun
    Preconditions: same script
    Steps:
      1. Call reasoningSummary("Just thinking out loud here.")
      2. Assert returned.title === null
      3. Assert returned.body === "Just thinking out loud here."
    Expected Result: null title, body is full text
    Evidence: .omo/evidence/display-commands/task-1-reasoning-summary-no-title.txt

  Scenario: reasoningSummary strips [REDACTED] placeholders
    Tool: bun
    Preconditions: same script
    Steps:
      1. Call reasoningSummary("**My plan**\n\n[REDACTED] some secret [REDACTED] more text")
      2. Assert returned.title === "My plan"
      3. Assert returned.body === "some secret  more text" (no [REDACTED] substrings)
    Expected Result: all [REDACTED] substrings removed
    Evidence: .omo/evidence/display-commands/task-1-reasoning-summary-redacted.txt

  Scenario: formatThoughtHeader includes title and duration
    Tool: bun
    Preconditions: same script
    Steps:
      1. Call formatThoughtHeader(2300, "Inspecting PR workflow")
      2. Assert returned === "🧠 Thought: Inspecting PR workflow · 2.3s"
    Expected Result: exact string match
    Evidence: .omo/evidence/display-commands/task-1-format-header-with-title.txt

  Scenario: formatThoughtHeader omits colon when no title
    Tool: bun
    Preconditions: same script
    Steps:
      1. Call formatThoughtHeader(450, null)
      2. Assert returned === "🧠 Thought · 450ms"
    Expected Result: exact string match
    Evidence: .omo/evidence/display-commands/task-1-format-header-no-title.txt

  Scenario: formatDuration handles sub-second and multi-second
    Tool: bun
    Preconditions: same script
    Steps:
      1. Assert formatDuration(450) === "450ms"
      2. Assert formatDuration(999) === "999ms"
      3. Assert formatDuration(1000) === "1.0s"
      4. Assert formatDuration(2345) === "2.3s"
      5. Assert formatDuration(12700) === "12.7s"
    Expected Result: all five assertions pass
    Evidence: .omo/evidence/display-commands/task-1-format-duration.txt
  ```

  **Evidence to Capture**:
  - [ ] `bun scripts/test-thinking-format.mjs > .omo/evidence/display-commands/task-1-bun-test-output.txt 2>&1` (full test output)

  **Commit**: YES (groups with Wave 1)
  - Message: `feat(display-commands): add thinking-format pure functions`
  - Files: `src/adapter/thinking-format.ts`, `scripts/test-thinking-format.mjs`
  - Pre-commit: `bun scripts/test-thinking-format.mjs` must pass

- [x] 2. Replace parsers + update help in workspace-cmd.ts

  **What to do**:
  - In `src/adapter/workspace-cmd.ts`:
    - Remove the `ThinkingCommand` interface (lines 53-55).
    - Remove the `parseThinkingCommand()` function (lines 270-291).
    - Add a new `ThoughtDisplayCommand` interface with `kind: "status" | "on" | "off"` (mirrors removed `ThinkingCommand` but renamed).
    - Add a new `ToolDisplayCommand` interface with `kind: "status" | "on" | "off"`.
    - Add `parseThoughtDisplayCommand(text: string): ThoughtDisplayCommand | null` — matches `^\/thought-display\s+(on|off|status)\s*$` (case-insensitive). Accepts `enable`/`disable` as aliases for `on`/`off` (mirror existing patterns).
    - Add `parseToolDisplayCommand(text: string): ToolDisplayCommand | null` — matches `^\/tool-display\s+(on|off|status)\s*$` (case-insensitive). Accepts `enable`/`disable` as aliases.
    - Update `formatHelp()` (lines 503-560) — replace the "── 思考 ──" section with TWO sections: "── 思考显示 ──" and "── 工具显示 ──", each documenting the new command.
    - Update `formatHelpWithNativeCommands()` (lines 565-639) — same replacement.
  - New section format in help:
    ```
    ── 思考显示 ──
    /thought-display on     开启思考内容显示
    /thought-display off    关闭思考内容显示
    /thought-display status 查看当前显示设置

    ── 工具显示 ──
    /tool-display on        开启工具调用摘要
    /tool-display off       关闭工具调用摘要
    /tool-display status    查看当前显示设置
    ```
  - Ensure the two new sections appear in BOTH help functions, in the same relative order as before the old "── 思考 ──" section.

  **Must NOT do**:
  - Do NOT keep `parseThinkingCommand` or `ThinkingCommand` as deprecated (full removal).
  - Do NOT add a `/thought` alias — it's removed.
  - Do NOT change the format of any other command's help text.
  - Do NOT add new top-level command interfaces that overlap with existing ones.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: well-localized refactor with explicit regex patterns
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: 4 (bridge handler dispatch needs the new parsers)
  - **Blocked By**: None (can start immediately)

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `src/adapter/workspace-cmd.ts:235-260` — `parseReasoningCommand` is the closest sibling pattern (regex + switch on subcommand)
    - `src/adapter/workspace-cmd.ts:53-55` — `ThinkingCommand` interface (to be removed)
    - `src/adapter/workspace-cmd.ts:270-291` — `parseThinkingCommand` (to be removed)
  - **API/Type References** (contracts to implement against):
    - N/A — these are parser-only types, no external API
  - **Test References**:
    - N/A — tested via Task 7 end-to-end
  - **External References**: N/A

  **Acceptance Criteria**:
  - [ ] `grep -n "parseThinkingCommand\|ThinkingCommand" src/adapter/workspace-cmd.ts` → 0 matches
  - [ ] `grep -n "parseThoughtDisplayCommand\|parseToolDisplayCommand" src/adapter/workspace-cmd.ts` → 4+ matches (interface + function + at least 2 references from tests/imports)
  - [ ] `npx tsc --noEmit` → 0 errors
  - [ ] Parser unit checks (in `scripts/test-thinking-format.mjs` OR a new `scripts/test-parsers.mjs`):
    - `parseThoughtDisplayCommand("/thought-display on")` returns `{ kind: "on" }`
    - `parseThoughtDisplayCommand("/thought-display off")` returns `{ kind: "off" }`
    - `parseThoughtDisplayCommand("/thought-display status")` returns `{ kind: "status" }`
    - `parseThoughtDisplayCommand("/thought-display enable")` returns `{ kind: "on" }` (alias)
    - `parseThoughtDisplayCommand("/thought-display disable")` returns `{ kind: "off" }` (alias)
    - `parseThoughtDisplayCommand("/thought-display foo")` returns `null`
    - `parseThoughtDisplayCommand("/thought on")` returns `null` (no alias)
    - `parseToolDisplayCommand(...)` — same 7 checks above
    - `parseToolDisplayCommand("/tool-display on")` returns `{ kind: "on" }`
    - `parseToolDisplayCommand("/tool-display enable")` returns `{ kind: "on" }` (alias)
    - `parseToolDisplayCommand("/tool-display foo")` returns `null`
  - [ ] `grep -n "── 思考 ──" src/adapter/workspace-cmd.ts` → 0 matches
  - [ ] `grep -n "── 思考显示 ──\|── 工具显示 ──" src/adapter/workspace-cmd.ts` → 2+ matches each (one in each help function)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: New parsers accept on/off/status with enable/disable aliases
    Tool: bun
    Preconditions: scripts/test-parsers.mjs imports both new parsers
    Steps:
      1. Run scripts/test-parsers.mjs which asserts all 7 cases for each parser
      2. Assert exit code 0 and output contains "PASS: 14/14"
    Expected Result: all parser cases pass
    Failure Indicators: any case returns the wrong kind, or null for valid input
    Evidence: .omo/evidence/display-commands/task-2-parsers.txt

  Scenario: /thought (legacy) is NOT a valid bridge command
    Tool: bun
    Preconditions: same script
    Steps:
      1. Call parseThoughtDisplayCommand("/thought on") and assert null
      2. Call parseToolDisplayCommand("/tool-display thought on") and assert null (extra arg rejected)
    Expected Result: both return null (no alias for the old /thought)
    Evidence: .omo/evidence/display-commands/task-2-legacy-rejected.txt

  Scenario: Both help functions are updated
    Tool: grep
    Preconditions: none
    Steps:
      1. grep -c "── 思考显示 ──" src/adapter/workspace-cmd.ts → assert >= 2
      2. grep -c "── 工具显示 ──" src/adapter/workspace-cmd.ts → assert >= 2
      3. grep -c "── 思考 ──" src/adapter/workspace-cmd.ts → assert 0 (exact, no display suffix)
    Expected Result: both new sections present in both help functions; old section gone
    Evidence: .omo/evidence/display-commands/task-2-help-sections.txt
  ```

  **Evidence to Capture**:
  - [ ] `bun scripts/test-parsers.mjs > .omo/evidence/display-commands/task-2-parsers.txt 2>&1`
  - [ ] grep output for help section check

  **Commit**: YES (groups with Wave 1)
  - Message: `feat(display-commands): add thought-display and tool-display parsers + update help`
  - Files: `src/adapter/workspace-cmd.ts`, `scripts/test-parsers.mjs`
  - Pre-commit: `bun scripts/test-parsers.mjs` must pass

- [x] 3. Update AGENTS.md + README.md + README.en.md

  **What to do**:
  - In `AGENTS.md`:
    - Find the section `### Thinking (/thought)` and remove it entirely.
    - Add TWO new sections in the same location: `### Thought Display (/thought-display)` and `### Tool Display (/tool-display)`.
    - Each section has a markdown table mirroring the existing `/reasoning` table style (Command | Description columns).
  - In `README.md` (Chinese):
    - Find the section `### 思考（/thought）` and remove it entirely.
    - Add TWO new sections in the same location: `### 思考显示（/thought-display）` and `### 工具显示（/tool-display）`.
    - Mirror the same table style as the existing `/reasoning` section.
  - In `README.en.md` (English):
    - Verify the file exists. If it does NOT exist, create it as a stub (English translation of the new command sections, mirror Chinese README structure).
    - If it exists, find the `### Thinking (/thought)` section and replace with two new sections.
  - Documented behavior (must match the actual implementation):
    - `/thought-display on`: enable showing model reasoning to WeChat with `🧠 Thought: {title} · {duration}` header + full reasoning body
    - `/thought-display off`: disable (only log to bridge log, not to WeChat)
    - `/thought-display status`: show current on/off state
    - `/tool-display on`: enable showing tool summary at end of turn (existing `buildToolSummary` behavior — emoji + tool name + title + sub-agent tag, no parameters/result bodies)
    - `/tool-display off`: disable tool summary
    - `/tool-display status`: show current on/off state
  - Add a single sentence noting that both settings are independent and persist across bridge restarts (in `~/.wechat-opencode/.wechat-bridge-state.json`).

  **Must NOT do**:
  - Do NOT document the old `/thought` command anywhere.
  - Do NOT change the format of other command tables.
  - Do NOT add screenshots or emojis to README (existing style is plain text tables).
  - Do NOT bump package.json version (out of scope).

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: documentation-only task, requires matching existing style
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: None
  - **Blocked By**: None (can start immediately; ideally after Task 2 for accuracy)

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `AGENTS.md` lines containing `### Reasoning (/reasoning)` and `### Session (/session)` — match the table style
    - `README.md` lines containing `### Reasoning（/reasoning）` — match the table style
  - **API/Type References**: N/A
  - **Test References**: N/A
  - **External References**: N/A

  **Acceptance Criteria**:
  - [ ] `grep -n "### Thinking (/thought)\|### 思考（/thought）" AGENTS.md README.md README.en.md 2>/dev/null` → 0 matches (all 3 files)
  - [ ] `grep -n "### Thought Display\|### Tool Display" AGENTS.md` → 2 matches
  - [ ] `grep -n "### 思考显示\|### 工具显示" README.md` → 2 matches
  - [ ] If `README.en.md` exists: `grep -n "### Thought Display\|### Tool Display" README.en.md` → 2 matches
  - [ ] Each new section has a markdown table with 2 columns (Command | Description) and 3 rows (on / off / status)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Old /thought command is fully removed from all docs
    Tool: grep
    Preconditions: AGENTS.md, README.md, README.en.md all updated
    Steps:
      1. grep -rn "/thought\b" AGENTS.md README.md README.en.md 2>/dev/null
      2. Assert: only matches are "/thought-display" (not standalone "/thought")
      3. grep -c "/thought-display" AGENTS.md → >= 3 (table rows)
      4. grep -c "/tool-display" AGENTS.md → >= 3
    Expected Result: no standalone /thought references; new commands fully documented
    Evidence: .omo/evidence/display-commands/task-3-docs-removed.txt

  Scenario: New command tables match existing style
    Tool: grep
    Preconditions: same
    Steps:
      1. grep -A 4 "### Thought Display" AGENTS.md | head -6
      2. Assert output contains a markdown table header row "| Command | Description |"
      3. Assert output contains 3 table body rows (on, off, status)
    Expected Result: same table format as other commands
    Evidence: .omo/evidence/display-commands/task-3-table-style.txt
  ```

  **Evidence to Capture**:
  - [ ] grep outputs saved to `.omo/evidence/display-commands/task-3-*.txt`

  **Commit**: YES (groups with Wave 1)
  - Message: `docs(display-commands): document thought-display and tool-display`
  - Files: `AGENTS.md`, `README.md`, `README.en.md` (if exists/created)
  - Pre-commit: `grep` checks (no build needed)

- [x] 4. Wire UserState + handlers + dispatch in bridge.ts

  **What to do**:
  - In `src/bridge.ts`:
    - Extend the `UserState` interface (lines 192-196) with two optional fields:
      ```ts
      interface UserState {
        userId: string;
        sessionId: string;
        cwd: string;
        showThoughts?: boolean;  // NEW
        showTools?: boolean;     // NEW
      }
      ```
    - Update `loadUserState()` (lines 367-387) to ALSO read the top-level `showThoughts` and `showTools` fields from the JSON (parallel to how it reads `users[]`). If absent, leave `userState.showThoughts` / `userState.showTools` as `undefined`.
    - Update `saveUserState()` (lines 389-413) to write the top-level `showThoughts` and `showTools` fields when they are defined.
    - In the SessionManager initialization path (look for `new SessionManager(...)`), after the constructor, call `this.sessionManager.setShowFlags({ showThoughts: ..., showTools: ... })` from the loaded `userState` (only call with defined values to avoid clobbering).
    - In `handleMessage()` (lines 592-691), REPLACE the `parseThinkingCommand` block (lines 645-651) with TWO new blocks: one for `parseThoughtDisplayCommand` and one for `parseToolDisplayCommand`. Both must be inserted at the same position (between `parseStatusCommand` and `parseStopCommand`).
    - REMOVE the `handleThinkingCommand` method (lines 1258-1285).
    - ADD two new methods: `handleThoughtDisplayCommand(contextToken, cmd)` and `handleToolDisplayCommand(contextToken, cmd)`. Each:
      - Calls `this.sessionManager.setShowFlags(...)` to update ONLY its own field (pass the other as `undefined` to avoid clobbering).
      - For `on`/`off`: persist immediately by calling `saveUserState()` (or a new helper that updates `userState` and saves).
      - For `status`: call `this.sessionManager.getShowFlags()` and reply with the current state for that field only.
    - Update `detectUnknownSlashCommand` (line ~1554) — REMOVE `"thinking"` from the hardcoded list, ADD `"thought-display"` and `"tool-display"`.
  - Status reply format:
    - On: `✅ Thought display on` / `✅ Tool display on`
    - Off: `❌ Thought display off` / `❌ Tool display off`
    - Status: `🧠 Thought display: ✅ On` / `🔧 Tool display: ✅ On` (or with ❌ Off)

  **Must NOT do**:
  - Do NOT change the relative ordering of OTHER parsers in `handleMessage` (only slot new ones at the same position).
  - Do NOT modify `handleStatusCommand` (the `/status` command) — display flags are NOT in `/status`.
  - Do NOT remove `setShowFlags` or `getShowFlags` from `session.ts` — they stay.
  - Do NOT clobber the OTHER field when calling `setShowFlags` — always pass `undefined` for the unchanged one.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: touches many parts of bridge.ts; careful ordering and persistence semantics required
  - **Skills**: `["git-master"]` (for the persistence round-trip in commit verification)
    - `git-master`: needed to verify atomic commits later

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 5)
  - **Parallel Group**: Wave 2 (with Task 5)
  - **Blocks**: 6, 7 (consumers of new handlers + persistence)
  - **Blocked By**: Task 2 (parsers must exist)

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `src/bridge.ts:367-413` — `loadUserState`/`saveUserState` structure (extend, don't rewrite)
    - `src/bridge.ts:1202-1254` — `handleStatusCommand` for the handler shape (but DON'T add display flags to /status)
    - `src/bridge.ts:592-691` — `handleMessage` dispatch (insert at the SAME position as old `parseThinkingCommand`)
    - `src/bridge.ts:1545-1561` — `detectUnknownSlashCommand` list
  - **API/Type References** (contracts to implement against):
    - `src/server/session.ts:1398-1404` — `setShowFlags` signature (only updates fields `!== undefined`)
  - **Test References**: N/A
  - **External References**: N/A

  **Acceptance Criteria**:
  - [ ] `grep -n "parseThinkingCommand\|handleThinkingCommand" src/bridge.ts` → 0 matches
  - [ ] `grep -n "parseThoughtDisplayCommand\|parseToolDisplayCommand" src/bridge.ts` → 4+ matches
  - [ ] `grep -n "handleThoughtDisplayCommand\|handleToolDisplayCommand" src/bridge.ts` → 4+ matches
  - [ ] `grep -n '"thinking"' src/bridge.ts` → 0 matches
  - [ ] `grep -n '"thought-display"\|"tool-display"' src/bridge.ts` → 2 matches
  - [ ] `npx tsc --noEmit` → 0 errors
  - [ ] `UserState` interface includes `showThoughts?` and `showTools?`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: /thought command is fully removed from bridge dispatch
    Tool: grep
    Preconditions: Wave 1 parsers are present
    Steps:
      1. grep -n "ThinkingCommand\|parseThinkingCommand\|handleThinkingCommand" src/bridge.ts
      2. Assert: zero output
      3. grep -n "/thought\b" src/bridge.ts → assert: only matches are /thought-display
    Expected Result: clean removal, no dangling references
    Evidence: .omo/evidence/display-commands/task-4-thought-removed.txt

  Scenario: New parsers are dispatched in handleMessage
    Tool: grep
    Preconditions: same
    Steps:
      1. grep -n "parseThoughtDisplayCommand\|parseToolDisplayCommand" src/bridge.ts
      2. Assert: at least one match in the handleMessage function body (around line 645-651)
    Expected Result: new parsers wired into the dispatch chain at the correct position
    Evidence: .omo/evidence/display-commands/task-4-dispatch-wired.txt

  Scenario: detectUnknownSlashCommand list is updated
    Tool: grep
    Preconditions: same
    Steps:
      1. grep -n "detectUnknownSlashCommand" src/bridge.ts → get the function body
      2. Assert: array contains "thought-display" and "tool-display" but not "thinking"
    Expected Result: command list reflects new surface
    Evidence: .omo/evidence/display-commands/task-4-detection-list.txt

  Scenario: UserState persistence round-trips
    Tool: scripts/verify-display-commands.mjs (Task 7 verifies this; also do an early check)
    Preconditions: a small Node script that calls loadUserState/saveUserState on a fixture JSON
    Steps:
      1. Write a JSON file: { users: [...], showThoughts: true, showTools: false }
      2. Run the bridge's loadUserState (via a test harness)
      3. Assert userState.showThoughts === true and userState.showTools === false
      4. Modify userState.showThoughts = false, call saveUserState
      5. Re-read the JSON file, assert showThoughts === false and showTools === false
    Expected Result: round-trip preserves both fields
    Evidence: .omo/evidence/display-commands/task-4-persistence-roundtrip.txt
  ```

  **Evidence to Capture**:
  - [ ] All grep outputs to `.omo/evidence/display-commands/task-4-*.txt`
  - [ ] Persistence round-trip output to `task-4-persistence-roundtrip.txt`

  **Commit**: YES (groups with Wave 2)
  - Message: `feat(display-commands): wire UserState persistence and command handlers`
  - Files: `src/bridge.ts`
  - Pre-commit: `npx tsc --noEmit` must pass

- [x] 5. Extend AccumulatedTurn + wire beginTurn snapshot in session.ts

  **What to do**:
  - In `src/server/session.ts`:
    - Find the `AccumulatedTurn` interface (referenced from `src/types/events.ts:220-255`; defined or extended in session.ts around line 240-260).
    - Add the following fields:
      ```ts
      // Display flag snapshot (set at beginTurn; ignores mid-turn toggles)
      showThoughtsSnapshot: boolean;
      showToolsSnapshot: boolean;
      // Reasoning accumulation (off-mode metrics)
      reasoningCharCount: number;
      reasoningStartMs: number | null;  // first reasoning part's timestamp
      reasoningEndMs: number | null;    // last reasoning part's timestamp
      // Dedup
      sentReasoningPartIds: Set<string>;
      ```
    - In `beginTurn()` (line ~540-575), set the snapshot fields from `this.showThoughts` / `this.showTools` and initialize the accumulation/dedup fields to 0 / null / new Set.
    - In `setShowFlags()` (lines 1398-1401): keep the existing implementation, but ALSO add a JSDoc note that mid-turn toggles do NOT affect the in-flight turn (snapshot semantics). The setter itself doesn't need to mutate `currentTurn` — that's by design.
    - Add a getter `getShowFlagsForTurn(): { showThoughts: boolean; showTools: boolean }` that returns the snapshot values from `currentTurn` if one is active, else falls back to `this.showThoughts` / `this.showTools`. This is what the event handlers in Task 6 will use.
    - In `loadUserState`-equivalent for SessionManager (or wherever the bridge passes `setShowFlags` after construction): confirm the call site uses the new fields (Task 4 already does this).

  **Must NOT do**:
  - Do NOT change `setShowFlags` to mutate `currentTurn` (that would break snapshot semantics).
  - Do NOT remove or rename existing `AccumulatedTurn` fields.
  - Do NOT introduce side effects in field setters.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: state extension + snapshot semantics + accessor pattern
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 4)
  - **Parallel Group**: Wave 2 (with Task 4)
  - **Blocks**: 6 (event handler in Task 6 uses these fields and the snapshot accessor)
  - **Blocked By**: Task 1 (uses `formatThoughtHeader` indirectly — but Task 6 is the actual consumer; Task 5 only adds the snapshot field)

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `src/server/session.ts:540-575` — `beginTurn` (where the snapshot gets initialized)
    - `src/server/session.ts:1398-1404` — existing `setShowFlags` (extend, don't break)
  - **API/Type References** (contracts to implement against):
    - `src/types/events.ts:220-255` — `AccumulatedTurn` interface (extend with new fields)
  - **Test References**: N/A
  - **External References**: N/A

  **Acceptance Criteria**:
  - [ ] `grep -n "showThoughtsSnapshot\|showToolsSnapshot" src/server/session.ts` → 4+ matches (declaration + beginTurn init + accessor reads × 2)
  - [ ] `grep -n "reasoningCharCount\|reasoningStartMs\|sentReasoningPartIds" src/server/session.ts` → 6+ matches
  - [ ] `npx tsc --noEmit` → 0 errors
  - [ ] Existing `setShowFlags` test (call with `{ showThoughts: true }` only) does NOT clobber `showTools`

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: beginTurn snapshots the current flags
    Tool: bun
    Preconditions: scripts/test-snapshot.mjs imports SessionManager (or a minimal test that exercises beginTurn)
    Steps:
      1. Create a SessionManager with showThoughts=false, showTools=true
      2. Call beginTurn({ parts: [], contextToken: "test" })
      3. Assert currentTurn.showThoughtsSnapshot === false
      4. Assert currentTurn.showToolsSnapshot === true
      5. Call setShowFlags({ showThoughts: true }) (simulate mid-turn toggle)
      6. Assert currentTurn.showThoughtsSnapshot === false (UNCHANGED — snapshot wins)
    Expected Result: snapshot semantics hold; mid-turn toggles do not affect in-flight turn
    Evidence: .omo/evidence/display-commands/task-5-snapshot-semantics.txt

  Scenario: getShowFlagsForTurn returns snapshot during a turn
    Tool: bun
    Preconditions: same
    Steps:
      1. After beginTurn, assert getShowFlagsForTurn() === { showThoughts: false, showTools: true }
      2. After setShowFlags({ showThoughts: true }), assert getShowFlagsForTurn() still === { showThoughts: false, showTools: true }
      3. After finalizeTurn (no currentTurn), assert getShowFlagsForTurn() === { showThoughts: true, showTools: true }
    Expected Result: snapshot is used during turn; underlying flags used outside turn
    Evidence: .omo/evidence/display-commands/task-5-accessor.txt
  ```

  **Evidence to Capture**:
  - [ ] Bun test outputs to `.omo/evidence/display-commands/task-5-*.txt`

  **Commit**: YES (groups with Wave 2)
  - Message: `feat(display-commands): add reasoning turn state and snapshot semantics`
  - Files: `src/server/session.ts`
  - Pre-commit: `npx tsc --noEmit` must pass

- [x] 6. Hook up showThoughts in SSE event flow + finalizeTurn off-mode log

  **What to do**:
  - In `src/server/session.ts`:
    - **Modify `handlePartDelta` (lines 576-608)**: REPLACE the early-return at lines 581-584 with logic that distinguishes text and reasoning fields:
      ```ts
      if (event.properties.field === "text") {
        // existing text-delta path
      } else if (event.properties.field === "reasoning") {
        // NEW: accumulate into turn.reasoningBuffer (or similar accumulator)
        // Track reasoningCharCount and reasoningStartMs/EndMs
      } else {
        return; // other fields (step-start, step-finish, etc.) still ignored
      }
      ```
      **Note**: The actual field name for reasoning deltas must be determined by inspecting the opencode server source OR by reading a real SSE stream. If the field is also `"text"` (just tagged by part type), then `handlePartDelta` doesn't need a separate branch — it can just look up the part by `partID` in `turn.parts` and route by `part.type === "reasoning"`. The Task 6 executor MUST validate the field name and document the choice in the code comment.
    - **Modify `handlePartUpdated` (lines 610-644)**: ADD a new branch for `part.type === "reasoning"`:
      ```ts
      } else if (part.type === "reasoning") {
        this.handleReasoningPart(turn, part);
      }
      ```
    - **Add `handleReasoningPart(turn, part)` method** with the following logic:
      1. If `turn.sentReasoningPartIds.has(part.id)`, return (dedup).
      2. If `part.messageID !== turn.assistantMessageId`, return (mirror text-part filter; log debug message).
      3. If `turn.contextToken` is null, return (no WeChat target).
      4. Get `flags = this.getShowFlagsForTurn()` (uses snapshot).
      5. If `flags.showThoughts === true`:
         - Run `reasoningSummary(part.text)` to get `{ title, body }`.
         - Compute `duration = (turn.startedAt && reasoningStartMs) ? (Date.now() - turn.startedAt) : 0`. (Use a simple "time since turn start" approximation if the event lacks a per-part timestamp.)
         - Send `formatThoughtHeader(duration, title)` via `this.onReply(turn.contextToken, header)`. If `body.trim()` is non-empty, also send `this.onReply(turn.contextToken, body)` as a separate message.
         - Mark `turn.sentReasoningPartIds.add(part.id)`.
      6. If `flags.showThoughts === false`:
         - Accumulate `turn.reasoningCharCount += part.text.length`.
         - If `turn.reasoningStartMs === null`, set it to `Date.now()`.
         - `turn.reasoningEndMs = Date.now()`.
         - DO NOT call `onReply`.
    - **Modify `finalizeTurn` (around lines 920-940)**: AFTER the tool summary block (line 938), ADD a log line for off-mode reasoning:
      ```ts
      if (!turn.snapshotShowThoughts && turn.reasoningCharCount > 0) {
        const duration = turn.reasoningEndMs && turn.reasoningStartMs
          ? turn.reasoningEndMs - turn.reasoningStartMs
          : 0;
        this.log(`🧠 Thought · ${formatDuration(duration)} · ${turn.reasoningCharCount} chars`);
      }
      ```
      (Adjust field name to match the actual snapshot field — likely `turn.showThoughtsSnapshot`.)
    - **On interrupted/error turns**: the log line must still fire if any reasoning was received. (Already handled by the `if (turn.reasoningCharCount > 0)` guard.)

  **Must NOT do**:
  - Do NOT modify `buildToolSummary` (sacred — see Must NOT Have).
  - Do NOT bypass `formatForWeChat` for the reasoning body (let it run via the same `sendReply` path).
  - Do NOT send reasoning content if `part.text` is empty or whitespace-only.
  - Do NOT send duplicate reasoning on SSE replay (use `sentReasoningPartIds`).
  - Do NOT echo user-side reasoning (use `part.messageID === turn.assistantMessageId` filter).

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: core feature wiring, multiple decision points (field name validation, dedup, filtering), interacts with async SSE stream
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 1, 5)
  - **Parallel Group**: Wave 3 (with Task 7, but Task 7 depends on this)
  - **Blocks**: 7 (verification needs the event flow to be in place)
  - **Blocked By**: Tasks 1, 5

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - `src/server/session.ts:576-608` — `handlePartDelta` (extend, don't rewrite)
    - `src/server/session.ts:610-644` — `handlePartUpdated` (add a branch, don't restructure)
    - `src/server/session.ts:663-708` — `maybeSendTextPart` (mirror the messageID + sentTextPartIds dedup pattern)
    - `src/server/session.ts:920-940` — `finalizeTurn` (add the log line after the tool summary block)
  - **API/Type References** (contracts to implement against):
    - `src/types/events.ts:30` — `PartType` union includes `"reasoning"`
    - `src/types/events.ts:65-68` — `ReasoningPart` (just `text: string`)
    - `src/types/events.ts:115-122` — `MessagePartUpdatedEvent` (the `time?: number` field for per-part timestamps)
  - **Test References**: N/A
  - **External References**:
    - opencode server source — must be inspected to determine the `field` name for reasoning deltas (read packages/opencode/src/.../session/prompt.ts or the SSE event emitter)

  **Acceptance Criteria**:
  - [ ] `npx tsc --noEmit` → 0 errors
  - [ ] `grep -n "handleReasoningPart" src/server/session.ts` → 3+ matches (declaration + call from handlePartUpdated + internal reference)
  - [ ] `grep -n "reasoningSummary\|formatThoughtHeader\|formatDuration" src/server/session.ts` → 6+ matches (3 functions × 2 imports/refs)
  - [ ] `grep -n "part.type === \"reasoning\"" src/server/session.ts` → 1+ matches
  - [ ] The new code does NOT touch `buildToolSummary` (verify with `git diff` after commit)
  - [ ] Off-mode log line appears in `this.log(...)` calls (verify by reading the diff)
  - [ ] `sentReasoningPartIds` is consulted before any `onReply` call related to reasoning

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: showThoughts=on sends reasoning to WeChat
    Tool: scripts/verify-display-commands.mjs (Task 7) — replays a synthetic SSE event sequence
    Preconditions: bridge started with showThoughts=true, showTools=false (snapshot)
    Steps:
      1. Inject a synthetic part.updated event: { type: "reasoning", id: "r1", messageID: "m1", text: "**My plan**\n\nThinking through this..." }
      2. Wait for processing
      3. Inspect captured onReply calls
      4. Assert: at least one call with text matching /^🧠 Thought: My plan · /
      5. Assert: at least one call with text === "Thinking through this..."
      6. Assert: sentReasoningPartIds contains "r1"
    Expected Result: reasoning streamed to WeChat with header + body
    Evidence: .omo/evidence/display-commands/task-6-on-mode.txt

  Scenario: showThoughts=off logs but does NOT send
    Tool: scripts/verify-display-commands.mjs
    Preconditions: bridge started with showThoughts=false (snapshot)
    Steps:
      1. Inject: { type: "reasoning", id: "r2", messageID: "m1", text: "secret thoughts" }
      2. Wait for processing
      3. Inspect captured onReply calls
      4. Assert: zero calls containing "secret thoughts" or "🧠"
      5. Wait for finalizeTurn
      6. Inspect the bridge log output
      7. Assert: log line matches /^🧠 Thought · \d+(\.\d)?s · \d+ chars$/
    Expected Result: no WeChat send, log line emitted
    Evidence: .omo/evidence/display-commands/task-6-off-mode.txt

  Scenario: User-message reasoning is filtered (messageID mismatch)
    Tool: scripts/verify-display-commands.mjs
    Preconditions: showThoughts=true
    Steps:
      1. Inject: { type: "reasoning", id: "r3", messageID: "user-msg-1", text: "user thinking?" }
      2. Assert: zero onReply calls containing "user thinking?"
    Expected Result: user-side reasoning NOT sent (defensive)
    Evidence: .omo/evidence/display-commands/task-6-messageid-filter.txt

  Scenario: Duplicate part.updated (SSE replay) is deduped
    Tool: scripts/verify-display-commands.mjs
    Preconditions: showThoughts=true
    Steps:
      1. Inject: { type: "reasoning", id: "r4", messageID: "m1", text: "first" }
      2. Inject: { type: "reasoning", id: "r4", messageID: "m1", text: "first" } (replay)
      3. Assert: onReply called exactly once with "first" (not twice)
    Expected Result: dedup works
    Evidence: .omo/evidence/display-commands/task-6-dedup.txt

  Scenario: showTools tool summary is NOT broken
    Tool: scripts/verify-display-commands.mjs
    Preconditions: showTools=true, showThoughts=false
    Steps:
      1. Inject a tool part: { type: "tool", id: "t1", messageID: "m1", name: "Read", state: "completed" }
      2. Wait for finalizeTurn
      3. Assert: at least one onReply call with text matching /^🔧 Tools:/
      4. Assert: format is unchanged from existing `buildToolSummary` (compare against a reference)
    Expected Result: tool summary still works
    Evidence: .omo/evidence/display-commands/task-6-tool-summary-intact.txt
  ```

  **Evidence to Capture**:
  - [ ] All scenarios to `.omo/evidence/display-commands/task-6-*.txt`
  - [ ] `git diff src/server/session.ts` captured to `task-6-session-diff.txt` for review

  **Commit**: YES (groups with Wave 3)
  - Message: `feat(display-commands): make showThoughts functional via SSE event filter`
  - Files: `src/server/session.ts`
  - Pre-commit: `npx tsc --noEmit` + `node scripts/verify-display-commands.mjs` must pass

- [x] 7. Create end-to-end verification script

  **What to do**:
  - Create `scripts/verify-display-commands.mjs` that exercises both commands end-to-end against the real bridge code. The script:
    1. Imports `parseThoughtDisplayCommand` and `parseToolDisplayCommand` from `dist/adapter/workspace-cmd.js` (build first).
    2. Imports `reasoningSummary`, `formatThoughtHeader`, `formatDuration` from `dist/adapter/thinking-format.js`.
    3. Runs the parser unit checks from Task 2 (14 cases).
    4. Runs the pure-function checks from Task 1 (6 cases).
    5. Tests persistence round-trip:
       - Write a fixture state file to a temp path with `{ users: [...], showThoughts: true, showTools: false }`
       - Use a minimal test harness (or a small extracted helper) to call the bridge's `loadUserState`/`saveUserState` against this file
       - Assert the round-trip preserves both fields
    6. Tests legacy state compat:
       - Write a v1.1.1-shaped state file (no `showThoughts`/`showTools`)
       - Assert `loadUserState` does not throw and the loaded `userState.showThoughts` / `userState.showTools` are `undefined`
    7. Tests command independence:
       - Call `setShowFlags({ showThoughts: true })` on a SessionManager
       - Assert `getShowFlags().showTools` is unchanged (whatever it was before — undefined or false)
    8. Tests `/thought` removal:
       - Assert `parseThoughtDisplayCommand("/thought on")` returns `null`
       - Assert the detection list in `bridge.ts` does not contain `"thinking"`
    9. Tests `/help` updates:
       - Spawn the bridge CLI with `--help` (or read `formatHelp()` output via a small test harness)
       - Assert output contains `── 思考显示 ──` and `── 工具显示 ──`
       - Assert output does NOT contain `── 思考 ──` (exact match, no display suffix)
    10. Exits with code 0 on success, code 1 on any assertion failure.
  - All assertions print to stdout in a `PASS: <n>/<n>` summary format.

  **Must NOT do**:
  - Do NOT modify any source file (this is a test script, not production code).
  - Do NOT depend on a running bridge process for unit checks (use the compiled `dist/` artifacts only).
  - Do NOT use `expect`/`assert` libraries — use `node:assert` (built-in) to keep the script zero-dep.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: a single file with structured assertions, well-specified test cases
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Tasks 4, 6 to compile and link)
  - **Parallel Group**: Wave 3 (with Task 6, but must run AFTER Task 6)
  - **Blocks**: F3 (final QA uses this script)
  - **Blocked By**: Tasks 4, 6

  **References** (CRITICAL):
  - **Pattern References** (existing code to follow):
    - Any existing scripts in `scripts/` directory (if any) — match the style
    - `package.json` `scripts` block — for build/run conventions
  - **API/Type References**: N/A
  - **Test References**:
    - Task 1's `scripts/test-thinking-format.mjs` (mirror style)
    - Task 2's `scripts/test-parsers.mjs` (mirror style)
  - **External References**:
    - `node:assert` — built-in assertion module (zero-dep)

  **Acceptance Criteria**:
  - [ ] File exists: `scripts/verify-display-commands.mjs`
  - [ ] `npm run build && node scripts/verify-display-commands.mjs` → exit 0
  - [ ] Output ends with `PASS: <N>/<N>` where N >= 25 (sum of all assertions)
  - [ ] No external npm dependencies (only `node:` built-ins)

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Verify script passes all assertions
    Tool: bash
    Preconditions: `npm run build` has run
    Steps:
      1. node scripts/verify-display-commands.mjs
      2. Assert exit code 0
      3. Capture stdout, assert it contains "PASS:" with a number
    Expected Result: all 25+ assertions pass
    Evidence: .omo/evidence/display-commands/task-7-verify-output.txt

  Scenario: Verify script fails on a deliberate regression
    Tool: bash
    Preconditions: same
    Steps:
      1. Temporarily comment out one of the assertions (e.g., the showTools independence check)
      2. Run the script
      3. Assert exit code is non-zero
      4. Restore the assertion
      5. Re-run, assert exit code 0
    Expected Result: the script actually catches regressions (not a no-op)
    Evidence: .omo/evidence/display-commands/task-7-regression-detected.txt
  ```

  **Evidence to Capture**:
  - [ ] Full script output to `.omo/evidence/display-commands/task-7-verify-output.txt`
  - [ ] Regression test output to `task-7-regression-detected.txt`

  **Commit**: YES (groups with Wave 3)
  - Message: `test(display-commands): add end-to-end verification script`
  - Files: `scripts/verify-display-commands.mjs`
  - Pre-commit: `npm run build && node scripts/verify-display-commands.mjs` must pass

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> **Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.**
> **Never mark F1-F4 as checked before getting user's okay.**

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, grep, run command). For each "Must NOT Have": search codebase for forbidden patterns — reject with file:line if found. Check evidence files exist in `.omo/evidence/display-commands/`. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run `npx tsc --noEmit` + `npm run build`. Review all changed files for: `as any` / `@ts-ignore`, empty catches, console.log in prod, commented-out code, unused imports, dead exports. Check AI slop: excessive comments, over-abstraction, generic names (data/result/item/temp).
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [x] F3. **Real Manual QA** — `unspecified-high` (no playwright; this is a CLI app)
  Run `node scripts/test-thinking-format.mjs` and `node scripts/verify-display-commands.mjs`. Capture all output. Verify: persistence round-trip, command independence, legacy state compat, `/thought` removal hint, both help sections updated, build passes, grep checks for removed patterns absent.
  Output: `Build [PASS/FAIL] | Pure-fn tests [N/N pass] | E2E verify [N/N pass] | Grep checks [N/N pass] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  For each task: read "What to do", read actual file diff (`git diff`). Verify 1:1 — everything in spec was built (no missing), nothing beyond spec was built (no creep). Check "Must NOT do" compliance. Detect cross-task contamination: Task N touching Task M's files. Flag unaccounted changes.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | Unaccounted [CLEAN/N files] | VERDICT`

---

## Commit Strategy

Atomic commits per wave (or per task if it stands alone):

- **Wave 1**: `feat(display-commands): add thought-display and tool-display parsers + thinking-format utilities` — `src/adapter/thinking-format.ts`, `src/adapter/workspace-cmd.ts`, `AGENTS.md`, `README.md`, `README.en.md`
- **Wave 2**: `feat(display-commands): wire up UserState persistence and command handlers` — `src/bridge.ts`, `src/server/session.ts`
- **Wave 3**: `feat(display-commands): make showThoughts functional via SSE event filter` — `src/server/session.ts`, `scripts/verify-display-commands.mjs`

---

## Success Criteria

### Verification Commands

```bash
# 1. Build must succeed
npm run build
# Expected: exit 0, no TS errors

# 2. Pure-function tests must pass
bun scripts/test-thinking-format.mjs
# Expected: all assertions pass, exit 0

# 3. End-to-end verification must pass
node scripts/verify-display-commands.mjs
# Expected: all assertions pass, exit 0

# 4. /thought command must be fully removed
grep -rn "parseThinkingCommand\|handleThinkingCommand" src/
# Expected: no output (empty)

# 5. /thought should be rejected
grep -n '"thinking"' src/bridge.ts
# Expected: no match

# 6. Both new commands must be present
grep -rn "parseThoughtDisplayCommand\|parseToolDisplayCommand" src/
# Expected: matches in workspace-cmd.ts and bridge.ts
```

### Final Checklist

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All 7 implementation tasks complete with QA evidence
- [ ] All 4 final review tasks (F1-F4) approved by user
- [ ] Build passes, all verification scripts pass
- [ ] `git log` shows 3 atomic commits
- [ ] `AGENTS.md`, `README.md`, `README.en.md` consistent
