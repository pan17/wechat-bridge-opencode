# `/compact` WeChat Command — Design

> **TL;DR**: Bridge OpenCode Server's native context compaction to WeChat via `/compact` (alias `/summarize`). Force-triggers `POST /session/:id/summarize` using the current session's model. Rejected while the agent is mid-turn; allowed during pending question/permission states. Total scope: 4 source files + 2 README files + 1 test addition + 1 AGENTS.md update.

---

## 1. Context

### 1.1 User Request

> "需要研究一下，在微信端增加/compact指令" — User wants the WeChat bridge to surface OpenCode Server's context compaction feature as a slash command.

### 1.2 Background

`wechat-opencode` is a WeChat-direct-message → OpenCode-Server bridge. WeChat has no `/` autocomplete, so command UX is "type the exact command" + clear inline help. The bridge has 16+ existing slash commands (`/help`, `/stop`, `/workspace`, …) that intercept before forwarding to the agent.

The user is mid-conversation with a long context, sees the agent slow down or refuse long answers, and wants Claude Code's `/compact` experience in WeChat. Currently the only "context clear" path is `/session new` — a destructive nuke that loses the entire transcript. OpenCode Server exposes a non-destructive `POST /session/:id/summarize` endpoint that replaces active context with a rolling summary while keeping full history durable server-side; the TUI's `/compact` slash command is a thin wrapper over this endpoint.

### 1.3 Key Decisions (with rationale)

| Decision | Choice | Alternatives Considered | Why |
|---|---|---|---|
| Trigger mode | **Manual `/compact` only** | (a) Auto on context threshold; (b) Hybrid | User confirmed manual. Auto adds threshold tuning + state + UX surprises; defer until asked. |
| Model selection | **Current session's `currentModelId`** | (a) Workspace default; (b) User-specified `provider/model` arg | Zero surprise. Compact uses same model the user is talking to. Workspace default changes when `/workspace switch` runs; user-spec adds grammar complexity. |
| `auto` field in payload | **Omit (force-trigger)** | Pass `auto: true` and let server decide | The user explicitly typed `/compact` — always honor it. `auto: true` can silently no-op when context is small, which is confusing. |
| Reject during mid-turn | **Yes — `/stop` first** | Allow during mid-turn | Compaction races the SSE-driven `totalTokens` bookkeeping on the session manager side. Cleaner UX: clear single rule "no compaction while busy". |
| Allow during question pending | **Yes** | Reject like `/stop` | Compaction doesn't touch the question slot. The user can free context, then answer. |
| Allow during permission pending | **Yes** | Reject | Same reasoning — permissions are server-side `ask` tool calls; compaction doesn't disturb them. |
| Persistence | **None** | Persist "last compacted at" timestamp | Compaction is stateless and idempotent from the bridge's perspective. No need. |
| Command aliases | **`/compact` + `/summarize`** | Only `/compact` | OpenCode's TUI accepts both, so we do too. The internal API is literally `/summarize`; honoring the upstream alias reduces surprise. |
| Reject `/compaction` (trailing `ion`) | **Yes** | Accept as alias | Different command in OpenCode's vocabulary; we don't want to silently hijack it. Reject at parser so it falls through to the agent as a slash command. |
| Reject `/compact <args>` | **Yes** | Accept and ignore | Same reason as display-commands: bare-command grammar keeps the parser surface clean. Trailing args become a user-typed message forwarded to the agent. |

### 1.4 What this design does NOT do

- **No auto-compaction**: out of scope per user decision. Add later as a separate `/auto-compact [off|once|always|status]` command if asked (mirrors `/auto-permission`).
- **No per-model override syntax**: no `/compact <provider/model>`. If asked, add later.
- **No pruning of old tool outputs**: that's the server's `compaction.prune` config (`opencode.json`). Bridge does not shadow this.
- **No new SSE event handling**: the existing `message.updated` token flow is sufficient — `totalTokens` will be updated naturally by the next `info.tokens.total` event after compaction. `/status` already shows it.

---

## 2. API Surface (OpenCode Server)

Source: `packages/web/src/content/docs/server.mdx` lines 161-164; `packages/sdk/js/src/gen/sdk.gen.ts` line 591; `packages/opencode/test/acp/service-session.test.ts` lines 1084-1101.

```
POST /session/:id/summarize
Content-Type: application/json
Body: { "providerID": "anthropic", "modelID": "claude-sonnet-4-5" }
Returns: boolean   // typically true on success; false if the server's
                  // pre-compact check rejected the request (rare; we
                  // still surface the false to the user as a warning)
```

TUI source: `packages/tui/src/routes/session/index.tsx` line 572 — `sdk.client.session.summarize({ sessionID, modelID, providerID })`.

V2 spec (`specs/v2/api.html` lines 852-864) plans to rename this to `POST /api/session/:sessionID/compact` and add a sibling `GET /api/session/:sessionID/context`. We are NOT on V2 yet, so the bridge uses the shipped `summarize` path.

The compaction engine itself (`packages/core/src/session/compaction.ts`) uses an LLM call with prompt `packages/opencode/src/agent/prompt/compaction.txt` ("You are an anchored context summarization assistant for coding sessions") to generate a structured Markdown summary (goal, progress, decisions, next steps, relevant files), then replaces the active model-visible context with a rolling summary + token-bounded recent context. Old messages stay in durable storage.

---

## 3. Implementation

### 3.1 Files Touched

| File | Change |
|---|---|
| `src/server/client.ts` | `+34` — `compactSession(sessionId, providerID, modelID)` wraps `POST /session/:id/summarize` with 2-minute timeout, throws on non-2xx. |
| `src/server/session.ts` | `+36` — public `isAgentBusy()` getter on `SessionManager` (renamed to avoid clash with the existing private `isSessionBusy` field); `compactSession(providerID, modelID)` thin wrapper that validates `sessionId` and delegates to `client.compactSession`. |
| `src/adapter/workspace-cmd.ts` | `+38` — `CompactCommand` interface, `parseCompactCommand(text)` (matches `/compact` or `/summarize` bare; rejects `/compaction`, `/compact <args>`, case-insensitive, whitespace-tolerant), inserts "── Context ──" section into both `formatHelp()` and `formatHelpWithNativeCommands()`. |
| `src/bridge.ts` | `+126` — imports `parseCompactCommand`; adds to main `handleMessage` dispatch chain (after `/stop`, before `/next`); adds `handleCompactCommand()` private method with full validation (busy → reject, no session → reject, no model → reject, malformed `provider/model` → reject, capture before-context-usage, call API, report result with before-tokens); adds `"compact"` + `"summarize"` to the `bridgeCommands` allow-list (so `detectUnknownSlashCommand` doesn't fire the "forwarding to agent" hint); registers as informational command in `handlePermissionReply` and `handleQuestionReply`. |
| `src/__tests__/test-parsers.mjs` | `+28` — 8 new test cases for `parseCompactCommand` (bare, alias, case, whitespace, newline, `/compaction` rejected, extra args rejected, non-slash rejected). |
| `AGENTS.md` | `+5` — adds "Context (/compact)" section to the WeChat Commands table. |
| `README.md` (zh) | +3 / +5 — bumps the "16+ commands" claim to "17+", adds the same section under "微信命令". |
| `README.en.md` | +3 / +5 — bumps "10+ commands" to "15+", adds the same section under "WeChat commands". |
| `.omo/plans/compact-command-design.md` | New — this file. |

### 3.2 Handler Logic

```ts
private async handleCompactCommand(contextToken, _cmd): Promise<void> {
  if (!this.sessionManager) return;
  if (this.sessionManager.isAgentBusy())  { sendReply("⚠️ Agent 正在运行，请先 /stop 再 /compact"); return; }
  const sessionId = this.sessionManager.getSessionId();
  if (!sessionId)                          { sendReply("⚠️ 当前没有活动会话，无法 compact"); return; }
  const currentModel = this.sessionManager.getCurrentModel();
  if (!currentModel)                       { sendReply("⚠️ 无法确定当前 model，请先 /model switch 设置后重试"); return; }
  const { providerID, modelID } = parseModelId(currentModel);
  const beforeUsage = this.sessionManager.getContextUsage();
  const beforeTokens = beforeUsage?.totalTokens ?? 0;
  const beforeSize = beforeUsage?.contextSize ?? 0;
  sendReply("🗜️ 开始压缩会话上下文...");
  try {
    const ok = await this.sessionManager.compactSession(providerID, modelID);
    if (!ok) { sendReply("⚠️ Server 返回 false — compact 未生效 ..."); return; }
    sendReply(`✅ Compact 完成\n  before: ${beforeTokens} / ${beforeSize}\n  发送 /status 查看压缩后的用量`);
  } catch (err) { sendReply(`⚠️ Compact failed: ${err}`); }
}
```

`parseModelId` is the existing helper at `src/server/session.ts:100-109` (already used by `sendPromptSync`/`sendPromptAsync`).

### 3.3 Dispatch Order

`/compact` sits **after** `/stop` and **before** `/next` in `handleMessage` so the parser order is:

```
/help → /workspace → /session → /agent → /model → /reasoning → /status
  → /thought-display → /tool-display → /stop → /compact → /next → /restart
  → /version → unknown-slash-detector → enqueue-to-agent
```

`/compact` is NOT a priority command in `handleQuestionReply` or `handlePermissionReply` (priority commands like `/stop` reject the pending slot first). It is registered as an **informational** command in both — the user can run it without disturbing the pending slot.

---

## 4. Verification

| Layer | Result |
|---|---|
| `npm run build` (tsc strict) | ✅ 0 errors |
| `npm test` (vitest) | ✅ **248 / 248 passed** (was 240, added 8 `parseCompactCommand` cases) |
| `lsp_diagnostics` on all 6 changed source files | ✅ 0 errors |
| `git status` | 8 modified + 1 new file (`compact-command-design.md`) |

End-to-end manual smoke (out-of-band, not gated by CI):
1. Start a real session, send ~10 turns to grow `totalTokens`
2. Send `/status` — confirm `🔥 Context: <N> / <window>` visible
3. Send `/compact` — expect `🗜️ 开始压缩...` then `✅ Compact 完成` with before-token line
4. Send `/status` — confirm `totalTokens` decreased
5. Continue conversation — confirm agent still has memory of earlier context (via the rolling summary)
6. Reject case: send `/compact` mid-agent-response — expect `⚠️ Agent 正在运行，请先 /stop 再 /compact`
7. Allow-during-question case: trigger an LLM question via a tool call, send `/compact` — expect compaction proceeds; question slot still pending

---

## 5. Future Work (deferred)

- **Auto-compact** at context threshold (e.g. 80%): mirror `/auto-permission` with a new `/auto-compact [off|once|always|status]` command. Persistence: top-level `userState.autoCompactMode`. Hook point: `session.ts:2093-2094` where `this.totalTokens = info.tokens.total` runs.
- **Per-model override**: `/compact <provider/model>` for when the user explicitly wants a cheaper model doing the summary. Defer until the simple form shows up as a friction point in user feedback.
- **V2 API migration**: when OpenCode Server ships `POST /api/session/:sessionID/compact`, switch `client.compactSession` to the new path. The handler surface is unchanged.
- **Compaction metrics**: surface before/after character count and tool-output count in the success message (currently we only show `totalTokens`). Useful for users tuning `compaction.prune` in `opencode.json`.
