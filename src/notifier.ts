/**
 * SessionNotifier — bridges SSE events from NON-current sessions to
 * WeChat notifications, mirroring OpenCode Desktop's notification UX.
 *
 * Background (see `.omo/plans/notify-others-design.md` once written):
 *   - The OpenCode Server's `/global/event` SSE stream carries events
 *     for ALL sessions on the server, not just the current one. The
 *     `SessionManager.handleEvent` filter normally drops everything
 *     whose `sessionID` doesn't match `this.sessionId` (line 1411-1418).
 *   - This class is the consumer of those dropped events. The
 *     `SessionManager` was extended to invoke its `onOtherSessionEvent`
 *     callback for non-matching events instead of silently returning.
 *   - For each such event the notifier decides:
 *       1. Is the user opted-in (master switch + per-type toggle)?
 *       2. Have we sent a similar notice for this session + event
 *          type in the last 30s? (Dedup — guards against SSE
 *          reconnects and server-side re-broadcasts.)
 *       3. If both pass, format the event and call back into the
 *          bridge's outbound path (`sendReply`-style callback).
 *
 * The class is intentionally *stateless across events* (other than
 * the settings + dedup map + label cache) so a misbehaving event
 * can't corrupt the next event's handling. Errors are caught at every
 * boundary and logged — they never propagate back to the
 * `SessionManager`, which would otherwise take down the SSE pipeline.
 *
 * The label cache is best-effort and unbounded in size; in practice
 * the opencode server typically hosts <50 sessions total, so the
 * memory footprint is negligible. When the cache misses (the user
 * created a session after we started watching), the notifier falls
 * back to a short prefix of the session id (e.g. "ses_abc12345…")
 * while it kicks off an async title lookup. The next event for that
 * session will then show the real title.
 */

import type {
  NotifySettings,
  NotifyEventType,
} from "./config.js";
import { DEFAULT_NOTIFY_SETTINGS } from "./config.js";
import type { OpenCodeEvent } from "./types/events.js";
import type { QuestionPrompt } from "./types/question.js";
import type { PermissionRequest } from "./types/permission.js";
import {
  formatOtherSessionNotification,
  extractSessionErrorMessage,
  type OtherSessionNotice,
} from "./adapter/notify-format.js";

/**
 * Server-side session info needed to render notifications. The shape
 * matches what `OpenCodeServerClient.getSession()` returns for V1
 * sessions — only the fields we actually use are declared here so
 * the notifier can be unit-tested with partial mock objects.
 *
 * `directory` is the session's working directory (workspace path).
 * `parentID` is set for sub-agent / child sessions spawned by the
 * `task` tool. `agent` is the agent name (e.g. "build", "designer").
 * All three are optional because older opencode server versions may
 * not return them, and mocks in unit tests may omit them. When
 * absent, the notifier passes `undefined` to the formatter, which
 * then omits the corresponding line / marker from the rendered
 * notification.
 */
export interface SessionLabelInfo {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
  readonly parentID?: string;
  readonly agent?: string;
}

/**
 * Minimal client surface the notifier needs to look up session info.
 *
 * `getSession` may throw (the real `OpenCodeServerClient.getSession`
 * throws on 404 / network error). The notifier catches + logs errors
 * inside `resolveSessionInfo` and falls back to a short id prefix for
 * the title — so a broken lookup never propagates to the SSE pipeline.
 */
export interface NotifierClient {
  getSession(id: string): Promise<SessionLabelInfo>;
}

/**
 * Callback to push a notification to WeChat. Matches the signature
 * shape of the existing `sendReply` in the bridge. The notifier never
 * blocks on the promise — fire-and-forget, with the bridge's own
 * outbound queue handling back-pressure and the 10-msg limit.
 */
export type NotifySender = (text: string) => Promise<void> | void;

/** Logger signature — same shape as everywhere else in the project. */
export type NotifyLog = (msg: string) => void;

/**
 * Suppress window (ms) for the same `sessionId + event type` pair.
 * Matches the question/permission tool's "soft" feel without
 * spamming on SSE reconnects.
 */
const DEDUPE_WINDOW_MS = 30_000;

/**
 * How long a cached label is considered fresh. The label cache
 * pre-fetches on first sight of a session id; we then re-validate
 * periodically so a user renaming a session in the TUI sees the
 * new title within this window.
 */
const LABEL_TTL_MS = 5 * 60_000;

/** Per-id cache entry for session labels. */
interface LabelCacheEntry {
  title: string;
  /** Working directory (workspace path). Absent when unknown. */
  directory?: string;
  /** Parent session id (set for sub-agent / child sessions spawned by a `task` tool). */
  parentID?: string;
  /** Agent name (e.g. "build", "designer", "Sisyphus - ultraworker"). */
  agent?: string;
  expiresAt: number;
}

/** Per-id dedup record — most recent send time. */
interface DedupeEntry {
  at: number;
}

/**
 * A "needs attention" payload stashed per session. When a non-current
 * session receives a `question.asked` or `permission.asked` event, the
 * notifier stores the payload here so that a subsequent
 * `/session switch <n>` to that session can re-render the question /
 * permission card (the user explicitly wants to interact with the
 * session they switched to). Cleared on `*.replied` / `*.rejected`
 * echoes and on session idle (completion).
 */
interface StoredPending {
  kind: "question" | "permission";
  requestID: string;
  question?: QuestionPrompt;
  permission?: PermissionRequest;
  receivedAt: number;
}

export class SessionNotifier {
  private settings: NotifySettings = { ...DEFAULT_NOTIFY_SETTINGS, types: { ...DEFAULT_NOTIFY_SETTINGS.types } };
  private currentSessionId: string | null = null;
  private readonly labelCache: Map<string, LabelCacheEntry> = new Map();
  /**
   * In-flight label fetches keyed by session id. Multiple concurrent
   * cache misses for the same sid share a single `getSession` call
   * by joining on the same Promise (the Promise resolves when the
   * fetch settles and the entry is auto-removed).
   */
  private readonly inflightLabelLookups: Map<string, Promise<void>> = new Map();
  private readonly dedupe: Map<string, DedupeEntry> = new Map();
  /** Track sessions that were recently busy so we only fire `completion` on real busy→idle transitions. */
  private readonly recentlyBusy: Set<string> = new Set();
  /** Latest un-answered question / permission payload per session, for switch-time re-render. */
  private readonly pendingBySession: Map<string, StoredPending> = new Map();
  private readonly client: NotifierClient;
  private readonly send: NotifySender;
  private readonly log: NotifyLog;

  constructor(opts: { client: NotifierClient; send: NotifySender; log?: NotifyLog }) {
    this.client = opts.client;
    this.send = opts.send;
    this.log = opts.log ?? (() => {});
  }

  // ─── Configuration ───

  /** Replace the full settings object. Used at startup from persisted state. */
  applySettings(settings: NotifySettings): void {
    this.settings = {
      enabled: settings.enabled,
      types: { ...settings.types },
    };
    this.log(`[notify] settings applied: enabled=${settings.enabled} types=${JSON.stringify(settings.types)}`);
  }

  /** Toggle the master switch. Returns the new value for the caller to persist. */
  setEnabled(enabled: boolean): boolean {
    this.settings.enabled = enabled;
    this.log(`[notify] master switch → ${enabled}`);
    return enabled;
  }

  /** Toggle a single event type. Returns the new value for the caller to persist. */
  setTypeEnabled(type: NotifyEventType, enabled: boolean): boolean {
    this.settings.types[type] = enabled;
    this.log(`[notify] type ${type} → ${enabled}`);
    return enabled;
  }

  /** Current settings — for `/notify status` rendering. Returns a deep clone. */
  getSettings(): NotifySettings {
    return {
      enabled: this.settings.enabled,
      types: { ...this.settings.types },
    };
  }

  // ─── Session lifecycle (called by the bridge) ───

  /**
   * Tell the notifier which session is the "current" one. The
   * notifier uses this to:
   *   1. Skip notifications for the current session (it's already
   *      being handled by the normal `SessionManager.handleEvent`
   *      path — no need to duplicate).
   *   2. Track busy→idle transitions of OTHER sessions correctly:
   *      if we never see a session go busy, we won't fire a
   *      "completion" notification when it goes idle (avoids
   *      noise for sessions that were already idle at startup).
   *
   * Note: we do NOT proactively clear `pendingBySession` for the
   * now-current session. The bridge's `maybeReSurfacePending` reads
   * that entry RIGHT AFTER calling this method, so deleting it here
   * would prevent the switch-time re-render. Entries are cleared
   * by:
   *   - `consumePendingForSession` (explicit consume on switch)
   *   - `question.replied` / `question.rejected` / `permission.replied`
   *     SSE echoes (server confirmed answered)
   *   - `session.status` going `idle` (turn abandoned)
   */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    // When the user switches sessions, prune the "recently busy"
    // set down to only sessions OTHER than the new current one.
    if (sessionId !== null) {
      this.recentlyBusy.delete(sessionId);
    }
  }

  /**
   * Pop the latest un-answered question / permission payload for a
   * session, so the caller (the bridge's `/session switch` handler)
   * can re-render the card and let the SessionManager's existing
   * answer flow take over. Returns `null` when there's nothing
   * pending or the stored entry has already been answered.
   *
   * Consume semantics: the entry is removed even if the caller
   * decides not to render — that prevents a stale card from
   * re-surfacing on a later switch back. The server-side state is
   * unchanged; the caller decides whether to actually adopt the
   * pending request locally.
   */
  consumePendingForSession(sid: string): StoredPending | null {
    const entry = this.pendingBySession.get(sid);
    if (!entry) return null;
    this.pendingBySession.delete(sid);
    return entry;
  }

  // ─── Event dispatch (called by SessionManager for non-current events) ───

  /**
   * Top-level entry point invoked by `SessionManager.onOtherSessionEvent`.
   *
   * The notifier classifies the event into one of 4 categories
   * (question / permission / error / completion), applies the
   * settings + dedupe filters, formats the WeChat text, and pushes
   * it to the outbound queue.
   *
   * Any error here is caught + logged — a bug in the notifier
   * must NEVER take down the SSE pipeline.
   */
  async handleEvent(event: OpenCodeEvent): Promise<void> {
    try {
      const sid = this.extractSessionId(event);
      if (!sid || sid === this.currentSessionId) {
        return; // Either no sessionId (shouldn't happen for our types) or the current session
      }

      // Update "recently busy" tracking for `busy` events BEFORE
      // classify runs, so that a subsequent `idle` event in the
      // same loop can see the up-to-date set. We intentionally do
      // NOT touch the set on `idle` here — `classify` reads the
      // set to decide whether to fire a completion notification,
      // and bookkeeping is done there. (Moving bookkeeping into
      // `classify` would couple the classification decision to the
      // side effect, which is harder to reason about.)
      if (event.type === "session.status") {
        const status = (event.properties as { status: { type: string } }).status;
        if (status.type === "busy") this.recentlyBusy.add(sid);
      }

      // Clear any stored pending for this session on reply / reject
      // echoes so a later switch back doesn't re-show a stale card.
      // We do this BEFORE classify so completion-driven clear (session
      // went idle) and reply-driven clear (user answered) both work.
      if (event.type === "question.replied" || event.type === "question.rejected") {
        this.pendingBySession.delete(sid);
      } else if (event.type === "permission.replied") {
        this.pendingBySession.delete(sid);
      } else if (event.type === "session.status") {
        const status = (event.properties as { status: { type: string } }).status;
        // Session is now idle — any pending question / permission is
        // no longer actionable (either answered on a different client,
        // timed out on the server, or the turn was abandoned).
        if (status.type === "idle") this.pendingBySession.delete(sid);
      }

      const classified = this.classify(event, sid);
      if (!classified) return;

      // Stash the latest question / permission payload so a subsequent
      // /session switch to this sid can re-render the card. We store
      // even when settings disable the kind (master off or per-type
      // off) — the user might still want to see the question when
      // they explicitly switch to that session.
      if (classified.kind === "question" && classified.requestID) {
        this.pendingBySession.set(sid, {
          kind: "question",
          requestID: classified.requestID,
          question: classified.payload.question,
          receivedAt: Date.now(),
        });
      } else if (classified.kind === "permission" && classified.requestID) {
        this.pendingBySession.set(sid, {
          kind: "permission",
          requestID: classified.requestID,
          permission: classified.payload.permission,
          receivedAt: Date.now(),
        });
      }

      if (!this.settings.enabled) return;
      if (!this.settings.types[classified.kind]) return;
      if (this.isDuplicate(sid, classified.kind)) return;

      const info = await this.resolveSessionInfo(sid);
      const notice: OtherSessionNotice = {
        ...classified.payload,
        sessionLabel: info.title,
        sessionDirectory: info.directory,
        sessionAgent: info.agent,
        sessionParentID: info.parentID,
      } as OtherSessionNotice;
      const text = formatOtherSessionNotification(notice);
      this.markSent(sid, classified.kind);
      // Fire-and-forget — the bridge's outbound queue handles
      // WeChat's 10-msg / 4000-char limits and serialization.
      // We do NOT await: holding up the SSE event loop on a
      // network call to WeChat would back-pressure the server.
      await this.send(text);
    } catch (err) {
      this.log(`[notify] handleEvent error: ${String(err)}`);
    }
  }

  // ─── Internals ───

  /**
   * Extract the `sessionID` from an event's `properties`. All our
   * target event types carry it at `properties.sessionID` (the
   * `message.part.updated` shape puts it at `properties.part.sessionID`,
   * but we never care about text parts from other sessions).
   */
  private extractSessionId(event: OpenCodeEvent): string | null {
    const props = (event as { properties?: { sessionID?: string | null } }).properties;
    if (!props) return null;
    const sid = props.sessionID;
    return typeof sid === "string" && sid.length > 0 ? sid : null;
  }

  /**
   * Classify an event into one of the 4 notification kinds, returning
   * the payload the formatter needs. Returns `null` for events we
   * don't care about (most of them — text deltas, message updates,
   * etc. — would be too noisy from a non-current session).
   *
   * Returns a discriminated union preserving the exact shape of each
   * `OtherSessionNotice` variant minus the `sessionLabel` field
   * (added by the caller after label resolution). The `Omit<>` built-
   * in doesn't preserve the union's per-variant shape, so we declare
   * the type explicitly. `requestID` is included for question /
   * permission so the caller can stash it in `pendingBySession` for
   * the switch-time re-render path.
   */
  private classify(
    event: OpenCodeEvent,
    sid: string,
  ):
    | { kind: "question"; requestID: string; payload: { kind: "question"; question: QuestionPrompt } }
    | { kind: "permission"; requestID: string; payload: { kind: "permission"; permission: PermissionRequest } }
    | { kind: "error"; payload: { kind: "error"; errorMessage: string } }
    | { kind: "completion"; payload: { kind: "completion" } }
    | null {
    switch (event.type) {
      case "question.asked": {
        const questions = event.properties.questions as ReadonlyArray<QuestionPrompt>;
        const firstQ = questions[0];
        if (!firstQ) return null; // empty questions array — ignore
        return {
          kind: "question",
          requestID: event.properties.id,
          payload: { kind: "question", question: firstQ },
        };
      }
      case "permission.asked": {
        const req = event.properties as PermissionRequest;
        if (!req || !req.permission) return null;
        return {
          kind: "permission",
          requestID: req.id,
          payload: { kind: "permission", permission: req },
        };
      }
      case "session.error": {
        // session.error properties.sessionID is OPTIONAL per the
        // opencode schema (server may not have a session for a
        // global error). We only notify when we DO have an sid.
        if (!sid) return null;
        const message = extractSessionErrorMessage(event.properties.error);
        return { kind: "error", payload: { kind: "error", errorMessage: message } };
      }
      case "session.status": {
        // Completion = busy→idle transition. We track busy state
        // in `recentlyBusy` to avoid firing a "completion" for a
        // session that was already idle at startup (the server
        // sometimes emits its first status right after we attach).
        const status = event.properties.status;
        if (status.type !== "idle") return null;
        if (!this.recentlyBusy.has(sid)) return null;
        // Consume the bookkeeping atomically with the decision —
        // if we just decided to fire a completion, the next idle
        // event (without an intervening busy) must NOT fire another.
        this.recentlyBusy.delete(sid);
        return { kind: "completion", payload: { kind: "completion" } };
      }
      default:
        return null;
    }
  }

  /**
   * Look up a session's display info (title + working directory +
   * parent / agent for sub-agent distinction).
   *
   * Cache hit: O(1) synchronous return.
   * Cache miss: actually AWAIT the `getSession` HTTP call so the
   * returned info is the real one (title, directory, parentID,
   * agent). Concurrent misses for the same sid share a single fetch
   * via `inflightLabelLookups`. If the fetch fails, falls back to
   * the short-id prefix for the title and omits the other fields.
   *
   * The old behavior returned the fallback synchronously and let the
   * fetch resolve in the background, so the FIRST notification for a
   * new session was always rendered with `ses_abc12345…` + no
   * `📂` line + no `🤖` marker. Subsequent events looked fine because
   * the cache was warm. The user-visible bug was: "the first
   * notification for a new session is missing the path and shows a
   * short id". Awaiting the fetch here fixes that.
   */
  private async resolveSessionInfo(sid: string): Promise<{
    title: string;
    directory?: string;
    parentID?: string;
    agent?: string;
  }> {
    const cached = this.labelCache.get(sid);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        title: cached.title,
        directory: cached.directory,
        parentID: cached.parentID,
        agent: cached.agent,
      };
    }

    // Cache miss — kick off (or join) the fetch and await it so the
    // returned info reflects the real server-side data. Concurrent
    // misses for the same sid share the in-flight promise.
    let inflight = this.inflightLabelLookups.get(sid);
    if (!inflight) {
      inflight = (async () => {
        try {
          const info = await this.client.getSession(sid);
          const title = (info && info.title) || this.shortIdFallback(sid);
          this.labelCache.set(sid, {
            title,
            directory: info?.directory,
            parentID: info?.parentID,
            agent: info?.agent,
            expiresAt: Date.now() + LABEL_TTL_MS,
          });
        } catch (err) {
          this.log(`[notify] session info fetch for ${sid.slice(0, 12)}… failed: ${String(err)}`);
        }
      })();
      this.inflightLabelLookups.set(sid, inflight);
      // Always clean up the inflight map so a subsequent hit misses
      // the cache (TTL hasn't been written) and can retry the fetch.
      inflight.finally(() => {
        this.inflightLabelLookups.delete(sid);
      });
    }
    await inflight;

    // After the fetch, re-check the cache. A successful fetch writes
    // to the cache; a failed fetch leaves it untouched and we fall
    // back to the short id + undefined fields.
    const updated = this.labelCache.get(sid);
    if (updated) {
      return {
        title: updated.title,
        directory: updated.directory,
        parentID: updated.parentID,
        agent: updated.agent,
      };
    }
    return {
      title: this.shortIdFallback(sid),
      directory: undefined,
      parentID: undefined,
      agent: undefined,
    };
  }

  private shortIdFallback(sid: string): string {
    if (sid.length <= 16) return sid;
    return sid.slice(0, 12) + "…";
  }

  /**
   * Returns true if we sent a notification for the same `sessionId
   * + event type` pair within the last `DEDUPE_WINDOW_MS`.
   *
   * The map is bounded implicitly by the dedup window — entries
   * older than 30s are still kept (we check `at` against the window
   * in `isDuplicate`), but a periodic sweep clears the map to
   * avoid unbounded growth if the user runs the bridge for days.
   * `pruneDedupe` is called at the end of `handleEvent` so the
   * pruning cost is amortized.
   */
  private isDuplicate(sid: string, kind: NotifyEventType): boolean {
    const key = `${sid}::${kind}`;
    const entry = this.dedupe.get(key);
    if (!entry) return false;
    return Date.now() - entry.at < DEDUPE_WINDOW_MS;
  }

  private markSent(sid: string, kind: NotifyEventType): void {
    const key = `${sid}::${kind}`;
    this.dedupe.set(key, { at: Date.now() });
  }

  /**
   * Drop dedupe entries older than the window. Cheap O(n) sweep —
   * the map stays bounded because the SSE event volume is bounded
   * (the server only emits one event per state transition, not
   * per delta).
   */
  private pruneDedupe(): void {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS;
    for (const [key, entry] of this.dedupe) {
      if (entry.at < cutoff) this.dedupe.delete(key);
    }
  }

  // ─── Test seams ───

  /** Exposed for tests only. Clears all caches. */
  __resetForTests(): void {
    this.labelCache.clear();
    this.inflightLabelLookups.clear();
    this.dedupe.clear();
    this.recentlyBusy.clear();
  }

  /** Exposed for tests only. The pruned dedupe map after a synthetic event. */
  __pruneDedupeForTests(): void {
    this.pruneDedupe();
  }
}
