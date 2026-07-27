// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskState, StreamHealth } from "./types";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";

export interface StreamClientOptions {
  streamPath: string;
  onEvent: (task: TaskState, source: "live" | "snapshot") => void;
  onDelete: (taskKey: string) => void;
  onHealth: (h: StreamHealth) => void;
  /** Fires when FSM enters `connected` after a reconnect — provider uses this to rehydrate via GET /tasks. */
  onReconnected?: () => void;
  /** Called when FSM enters `polling` — provider should start GET /tasks fallback. */
  onPollingStart?: () => void;
  onPollingStop?: () => void;
  /**
   * Probe the browser session after repeated EventSource failures.
   * `false` is terminal auth loss; `true` is a live session; `null` means the
   * probe itself was inconclusive (network/5xx) and reconnecting should continue.
   */
  checkSession?: () => Promise<boolean | null>;
  /**
   * Called once when the client gives up reconnecting because it has never
   * successfully connected and has exhausted the initial-failure budget — a
   * strong signal that the server-side credential was rejected outright.
   * Provider uses this to route through the ky /tasks poller so the global
   * 401 handler can trigger logout. Stream is closed at this point.
   */
  onUnrecoverable?: () => void;
  /** For testing. */
  backoffMs?: number[];
  watchdogMs?: number;
  pollingRetryMs?: number;
  snapshotQueryParam?: boolean;
  maxInitialFailures?: number;
}

const DEFAULT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
const DEFAULT_WATCHDOG_MS = 30_000;
const FAILED_CYCLES_BEFORE_POLLING = 3;
const DEFAULT_POLLING_RETRY_MS = 15_000;
// If we have NEVER successfully connected and we've failed this many times,
// stop hammering the SSE endpoint. EventSource cannot observe HTTP status,
// so we can't tell a 401 from a network error; the polling path will route
// through ky and let the global 401 handler trigger logout.
const DEFAULT_MAX_INITIAL_FAILURES = 8;

export interface StreamClient {
  start(): void;
  close(): void;
}

export function createStreamClient(opts: StreamClientOptions): StreamClient {
  let es: EventSource | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let polling = false;
  let closed = false;
  let wasDisconnected = false;
  let everConnected = false;
  let unrecoverableFired = false;
  let regionSwitchHandler: (() => void) | null = null;
  let sessionExpiredHandler: (() => void) | null = null;
  let sessionCheckInFlight = false;

  const backoffs = opts.backoffMs ?? DEFAULT_BACKOFF;
  const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const pollingRetryMs = opts.pollingRetryMs ?? DEFAULT_POLLING_RETRY_MS;
  const useSnapshotParam = opts.snapshotQueryParam ?? false;
  const maxInitialFailures = opts.maxInitialFailures ?? DEFAULT_MAX_INITIAL_FAILURES;

  // When the provider passes snapshotQueryParam=true, the server is told NOT to
  // replay tasks on connect — so every incoming event is live. Only arm the
  // snapshot-suppression window when the server is actually sending a snapshot
  // (initial connect w/o the param, or reconnect where server replays state).
  let pendingSnapshotWindow = !useSnapshotParam;

  function resetWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      if (closed) return;
      handleFailure("watchdog timeout");
    }, watchdogMs);
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    reconnectTimer = null;
    watchdogTimer = null;
    snapshotTimer = null;
  }

  function stopForSessionLoss() {
    if (closed) return;
    closed = true;
    clearTimers();
    if (es) {
      es.close();
      es = null;
    }
    if (polling) {
      polling = false;
      opts.onPollingStop?.();
    }
    opts.onHealth("failed");
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = polling
      ? pollingRetryMs
      : backoffs[Math.min(reconnectAttempt - 1, backoffs.length - 1)];
    reconnectTimer = setTimeout(() => {
      if (closed) return;
      open();
    }, delay);
  }

  function checkSessionThenReconnect() {
    if (!opts.checkSession || sessionCheckInFlight) {
      scheduleReconnect();
      return;
    }
    sessionCheckInFlight = true;
    void opts
      .checkSession()
      .then((active) => {
        if (closed) return;
        if (active === false) {
          stopForSessionLoss();
          return;
        }
        scheduleReconnect();
      })
      .catch(() => {
        scheduleReconnect();
      })
      .finally(() => {
        sessionCheckInFlight = false;
      });
  }

  function handleStreamHealthy() {
    reconnectAttempt = 0;
    everConnected = true;
    if (polling) {
      polling = false;
      opts.onPollingStop?.();
    }
    opts.onHealth("connected");
    if (wasDisconnected) {
      wasDisconnected = false;
      opts.onReconnected?.();
      // On reconnect, server may replay state regardless of the original param,
      // so briefly treat new events as snapshot until first heartbeat OR 500ms.
      pendingSnapshotWindow = true;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = setTimeout(() => {
        pendingSnapshotWindow = false;
        snapshotTimer = null;
      }, 500);
    }
    resetWatchdog();
  }

  function open() {
    if (closed) return;
    // Never leak a prior connection: any path that re-enters open() (stale
    // reconnect timer, double handleFailure) must close the existing ES first.
    if (es) {
      es.close();
      es = null;
    }
    opts.onHealth(
      reconnectAttempt === 0 && !polling ? "connecting" : polling ? "polling" : "reconnecting",
    );
    // Cookie-backed auth: the `st_session` HttpOnly cookie travels on the
    // EventSource connection when `withCredentials: true`. Same-origin
    // requests would send cookies without the flag, but the dev Vite proxy
    // makes this technically cross-port, so be explicit.
    const params = new URLSearchParams();
    if (useSnapshotParam) params.set("snapshot", "false");
    const qs = params.toString();
    const url = qs ? `${opts.streamPath}?${qs}` : opts.streamPath;
    es = new EventSource(url, { withCredentials: true });
    es.addEventListener("task_updated", (e) => {
      try {
        const task = JSON.parse((e as MessageEvent).data) as TaskState;
        opts.onEvent(task, pendingSnapshotWindow ? "snapshot" : "live");
      } catch (err) {
        console.error("[stream-client] task_updated parse failed", err);
      }
      handleStreamHealthy();
    });
    es.addEventListener("deleted", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { task_key: string };
        opts.onDelete(payload.task_key);
      } catch (err) {
        console.error("[stream-client] deleted parse failed", err);
      }
      handleStreamHealthy();
    });
    es.addEventListener("heartbeat", () => {
      pendingSnapshotWindow = false;
      handleStreamHealthy();
    });
    es.onerror = () => {
      handleFailure("eventsource error");
    };
    resetWatchdog();
  }

  function handleFailure(_reason: string) {
    if (closed) return;
    // Disarm both timers before scheduling a new reconnect. Otherwise an
    // onerror failure plus the still-armed watchdog each call handleFailure and
    // each schedule a reconnect, opening (and leaking) two EventSources.
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (es) {
      es.close();
      es = null;
    }
    wasDisconnected = true;
    reconnectAttempt += 1;

    // Cold-start failure budget: if we have never once connected and we've
    // tried enough times, the credential is almost certainly invalid. Stop
    // EventSource reconnects, switch to polling once (so ky can observe 401
    // and route through the global logout handler), and emit `failed`.
    if (!everConnected && reconnectAttempt >= maxInitialFailures && !unrecoverableFired) {
      unrecoverableFired = true;
      if (!polling) {
        polling = true;
        opts.onPollingStart?.();
      }
      opts.onHealth("failed");
      opts.onUnrecoverable?.();
      return;
    }

    // pendingSnapshotWindow is re-armed in handleStreamHealthy() on the next
    // successful connect, with a timer we can cancel on close(). Don't set it here.
    if (reconnectAttempt >= FAILED_CYCLES_BEFORE_POLLING && !polling) {
      polling = true;
      opts.onHealth("polling");
      opts.onPollingStart?.();
    } else {
      opts.onHealth("reconnecting");
    }
    if (reconnectAttempt >= FAILED_CYCLES_BEFORE_POLLING && opts.checkSession) {
      checkSessionThenReconnect();
      return;
    }
    scheduleReconnect();
  }

  return {
    start() {
      if (es || closed) return;
      // Region-switch teardown: the orchestrator dispatches a window
      // "region-switch" event just before the hard reload. EventSource isn't
      // covered by the regionAbortController (it's an SSE connection, not a
      // fetch), so close it explicitly here; otherwise it would linger and
      // 401 against the new region cookie between abort and reload.
      if (typeof window !== "undefined" && !regionSwitchHandler) {
        regionSwitchHandler = () => {
          if (es) {
            es.close();
            es = null;
          }
        };
        window.addEventListener("region-switch", regionSwitchHandler);
      }
      if (typeof window !== "undefined" && !sessionExpiredHandler) {
        sessionExpiredHandler = stopForSessionLoss;
        window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpiredHandler);
      }
      open();
    },
    close() {
      closed = true;
      clearTimers();
      if (es) {
        es.close();
        es = null;
      }
      if (typeof window !== "undefined" && regionSwitchHandler) {
        window.removeEventListener("region-switch", regionSwitchHandler);
        regionSwitchHandler = null;
      }
      if (typeof window !== "undefined" && sessionExpiredHandler) {
        window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpiredHandler);
        sessionExpiredHandler = null;
      }
    },
  };
}
