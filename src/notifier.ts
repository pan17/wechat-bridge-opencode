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
 */
export interface SessionLabelInfo {
  readonly id: string;
  readonly title?: string;
}

/**
 * Minimal client surface the notifier needs to look up session titles.
 *
 * `getSession` may throw (the real `OpenCodeServerClient.getSession`
 * throws on 404 / network error). The notifier catches + logs errors
 * inside `fetchLabel` and falls back to a short id prefix — so a
 * broken lookup never propagates to the SSE pipeline.
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
  expiresAt: number;
}

/** Per-id dedup record — most recent send time. */
interface DedupeEntry {
  at: number;
}

export class SessionNotifier {
  private settings: NotifySettings = { ...DEFAULT_NOTIFY_SETTINGS, types: { ...DEFAULT_NOTIFY_SETTINGS.types } };
  private currentSessionId: string | null = null;
  private readonly labelCache: Map<string, LabelCacheEntry> = new Map();
  private readonly pendingLabelLookups: Set<string> = new Set();
  private readonly dedupe: Map<string, DedupeEntry> = new Map();
  /** Track sessions that were recently busy so we only fire `completion` on real busy→idle transitions. */
  private readonly recentlyBusy: Set<string> = new Set();
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
   */
  setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
    // When the user switches sessions, prune the "recently busy"
    // set down to only sessions OTHER than the new current one.
    if (sessionId !== null) {
      this.recentlyBusy.delete(sessionId);
    }
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

      const classified = this.classify(event, sid);
      if (!classified) return;

      if (!this.settings.enabled) return;
      if (!this.settings.types[classified.kind]) return;
      if (this.isDuplicate(sid, classified.kind)) return;

      const label = await this.resolveLabel(sid);
      const notice: OtherSessionNotice = { ...classified.payload, sessionLabel: label } as OtherSessionNotice;
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
   * the type explicitly.
   */
  private classify(
    event: OpenCodeEvent,
    sid: string,
  ):
    | { kind: "question"; payload: { kind: "question"; question: QuestionPrompt } }
    | { kind: "permission"; payload: { kind: "permission"; permission: PermissionRequest } }
    | { kind: "error"; payload: { kind: "error"; errorMessage: string } }
    | { kind: "completion"; payload: { kind: "completion" } }
    | null {
    switch (event.type) {
      case "question.asked": {
        const questions = event.properties.questions as ReadonlyArray<QuestionPrompt>;
        const firstQ = questions[0];
        if (!firstQ) return null; // empty questions array — ignore
        return { kind: "question", payload: { kind: "question", question: firstQ } };
      }
      case "permission.asked": {
        const req = event.properties as PermissionRequest;
        if (!req || !req.permission) return null;
        return { kind: "permission", payload: { kind: "permission", permission: req } };
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
   * Look up a session's display label (title preferred, cwd fallback,
   * id prefix as last resort). Cache hits are O(1); misses trigger a
   * single async fetch (deduplicated so concurrent misses for the
   * same id share one network call).
   */
  private async resolveLabel(sid: string): Promise<string> {
    const cached = this.labelCache.get(sid);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.title;
    }

    if (!this.pendingLabelLookups.has(sid)) {
      this.pendingLabelLookups.add(sid);
      this.fetchLabel(sid).catch((err) => {
        this.log(`[notify] label fetch failed for ${sid.slice(0, 12)}…: ${String(err)}`);
      }).finally(() => {
        this.pendingLabelLookups.delete(sid);
      });
    }

    // Synchronous fallback: return a short id prefix so the user
    // still sees something meaningful while the title fetch is in
    // flight. The next event for this session will get the real
    // title from the cache.
    return this.shortIdFallback(sid);
  }

  private async fetchLabel(sid: string): Promise<void> {
    let info: SessionLabelInfo | undefined;
    try {
      info = await this.client.getSession(sid);
    } catch (err) {
      // 404 (session deleted) or network blip — leave the cache alone
      // so the fallback shortId keeps being used. A subsequent event
      // for the same sid will retry the lookup. Logged at the
      // call-site (`resolveLabel`) too, so we keep the log line here
      // terse to avoid double-logging.
      this.log(`[notify] label fetch for ${sid.slice(0, 12)}… failed: ${String(err)}`);
      return;
    }
    const title = (info && info.title) || this.shortIdFallback(sid);
    this.labelCache.set(sid, { title, expiresAt: Date.now() + LABEL_TTL_MS });
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
    this.pendingLabelLookups.clear();
    this.dedupe.clear();
    this.recentlyBusy.clear();
  }

  /** Exposed for tests only. The pruned dedupe map after a synthetic event. */
  __pruneDedupeForTests(): void {
    this.pruneDedupe();
  }
}
