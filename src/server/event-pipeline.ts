/**
 * SSE Event Pipeline — persistent connection to /global/event.
 *
 * Mirrors openchamber's event-pipeline pattern in a Node-friendly form:
 *   - Uses native fetch ReadableStream (Node 20+)
 *   - Manual SSE line parser with buffer (handles UTF-8 multi-byte chunks)
 *   - Exponential backoff reconnect (1s → 30s cap)
 *   - Last-Event-ID resumption
 *   - Single start/stop lifecycle tied to the bridge
 *
 * Design notes:
 *   - The pipeline does NOT interpret events. It just parses SSE frames and
 *     dispatches OpenCodeEvent objects to the onEvent callback. Higher-level
 *     state machine (turn accumulator) lives in SessionManager.
 *   - Status changes are reported via onStatusChange. The bridge can use this
 *     to display a "reconnecting" indicator (Phase 3).
 *   - No coalescing here. We deliver each event as soon as it's parsed.
 *     Coalescing would hurt responsiveness for chat; downstream consumers
 *     (turn accumulator) can debounce if needed.
 */

import type {
  EventPipelineOpts,
  EventPipelineStatus,
  GlobalEvent,
  OpenCodeEvent,
} from "../types/events.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;

export class EventPipeline {
  private url: string;
  private directory: string | undefined;
  private authHeader: string | null;
  private log: (msg: string) => void;
  private onEvent: (event: OpenCodeEvent) => void;
  private onStatusChange?: (status: EventPipelineStatus) => void;
  private onError?: (err: Error) => void;

  private status: EventPipelineStatus = "idle";
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private lastEventId: string | null = null;
  private stopped = false;

  constructor(opts: EventPipelineOpts) {
    this.url = opts.url;
    this.directory = opts.directory;
    this.authHeader = opts.authHeader ?? null;
    this.log = opts.log ?? (() => {});
    this.onEvent = opts.onEvent;
    this.onStatusChange = opts.onStatusChange;
    this.onError = opts.onError;
  }

  /** Start the pipeline. Returns immediately; the connection is async. */
  start(): void {
    if (this.stopped) return;
    if (this.status === "connecting" || this.status === "connected") return;
    this.connect();
  }

  /** Stop the pipeline and do not reconnect. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.setStatus("stopped");
  }

  getStatus(): EventPipelineStatus {
    return this.status;
  }

  // ─── Internals ───

  private setStatus(s: EventPipelineStatus): void {
    if (this.status === s) return;
    this.status = s;
    try {
      this.onStatusChange?.(s);
    } catch (err) {
      this.log(`[event-pipeline] onStatusChange threw: ${String(err)}`);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.retryCount === 0 ? "connecting" : "reconnecting");
    this.abortController = new AbortController();

    // Per-attempt connection timeout (independent of the request itself)
    const connectTimeout = setTimeout(() => {
      this.log(`[event-pipeline] connect timeout after ${CONNECT_TIMEOUT_MS}ms, aborting`);
      this.abortController?.abort(new Error("connect timeout"));
    }, CONNECT_TIMEOUT_MS);

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.lastEventId) {
      headers["Last-Event-ID"] = this.lastEventId;
    }
    if (this.directory) {
      headers["x-opencode-directory"] = this.directory;
    }
    // Inject server auth on the SSE stream. The pipeline's fetch() lives
    // outside OpenCodeServerClient so it can't piggy-back on the client's
    // auth-injection path — we accept a pre-built `Authorization` value
    // at construction time. Logged as `[event-pipeline] GET <url>` (URL
    // only) to keep secrets out of the log.
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    try {
      this.log(`[event-pipeline] GET ${this.url}`);
      const res = await fetch(this.url, {
        method: "GET",
        headers,
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`Event stream HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        throw new Error("Event stream returned no body");
      }

      clearTimeout(connectTimeout);
      this.retryCount = 0;
      this.setStatus("connected");
      this.log(`[event-pipeline] connected`);

      await this.consumeStream(res.body);
    } catch (err) {
      clearTimeout(connectTimeout);
      const error = err instanceof Error ? err : new Error(String(err));
      // AbortError on stop() is expected; do not log loudly
      if (error.name === "AbortError" && this.stopped) return;
      this.log(`[event-pipeline] connection error: ${error.message}`);
      try {
        this.onError?.(error);
      } catch (cbErr) {
        this.log(`[event-pipeline] onError threw: ${String(cbErr)}`);
      }
    } finally {
      this.abortController = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Consume the SSE response body line by line.
   *
   * SSE wire format:
   *   field: value\n
   *   field: value\n
   *   \n
   *
   * Fields we care about: `id:`, `event:`, `data:`. Other fields (`:`, retry) ignored.
   * Multi-line `data:` is joined with \n. Multiple SSE events are separated by blank lines.
   */
  private async consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    // SSE frame accumulator
    let eventId: string | null = null;
    let eventName: string | null = null;
    let dataLines: string[] = [];

    const flushFrame = (): void => {
      if (dataLines.length === 0 && eventName === null && eventId === null) {
        return;
      }
      const data = dataLines.join("\n");
      dataLines = [];
      if (eventId) {
        this.lastEventId = eventId;
        eventId = null;
      }
      if (!data) {
        eventName = null;
        return;
      }
      try {
        const json = JSON.parse(data) as GlobalEvent | OpenCodeEvent;
        const payload = this.unwrapPayload(json);
        if (payload) {
          try {
            this.onEvent(payload);
          } catch (cbErr) {
            this.log(`[event-pipeline] onEvent threw: ${String(cbErr)}`);
          }
        }
      } catch (parseErr) {
        this.log(`[event-pipeline] JSON parse error: ${String(parseErr)} data=${data.slice(0, 200)}`);
      }
      eventName = null;
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete lines (those ending in \n). Keep partial line in buffer.
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          let line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          // Strip trailing \r (SSE spec)
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line === "") {
            // Blank line: end of frame
            flushFrame();
          } else if (line.startsWith(":")) {
            // Comment / heartbeat — ignore
            continue;
          } else {
            const colon = line.indexOf(":");
            let field: string;
            let valuePart: string;
            if (colon === -1) {
              field = line;
              valuePart = "";
            } else {
              field = line.slice(0, colon);
              valuePart = line.slice(colon + 1);
              if (valuePart.startsWith(" ")) valuePart = valuePart.slice(1);
            }
            switch (field) {
              case "id":
                eventId = valuePart;
                break;
              case "event":
                eventName = valuePart;
                break;
              case "data":
                dataLines.push(valuePart);
                break;
              case "retry":
                // Server-suggested reconnect delay. We use our own backoff.
                break;
              default:
                // Other fields ignored.
                break;
            }
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === "AbortError" && this.stopped) return;
      throw error;
    } finally {
      // Drain any trailing buffered data
      const tail = buffer + decoder.decode();
      if (tail) {
        // Treat leftover data as a final frame
        let line = tail;
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line && !line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const valuePart = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "data") {
            dataLines.push(valuePart);
          }
        }
      }
      flushFrame();
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Unwrap a GlobalEvent envelope to its inner OpenCodeEvent payload.
   * Some servers wrap under .payload, some under .event; some emit the
   * payload directly without an envelope. Handle all three.
   */
  private unwrapPayload(json: GlobalEvent | OpenCodeEvent): OpenCodeEvent | null {
    if (!json || typeof json !== "object") return null;
    const obj = json as unknown as Record<string, unknown>;
    if (obj.payload && typeof obj.payload === "object") {
      return obj.payload as OpenCodeEvent;
    }
    if (obj.event && typeof obj.event === "object") {
      return obj.event as OpenCodeEvent;
    }
    // Bare payload (no envelope)
    if (typeof obj.type === "string") {
      return json as OpenCodeEvent;
    }
    return null;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.retryCount += 1;
    const delay = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** Math.min(this.retryCount - 1, 5));
    this.setStatus("reconnecting");
    this.log(`[event-pipeline] reconnecting in ${delay}ms (attempt ${this.retryCount})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
