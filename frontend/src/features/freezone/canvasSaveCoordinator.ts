// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Save scheduling for one loaded canvas, isolated from the React hook.
 *
 * `useCanvasSync` used to schedule saves out of a shared bag of refs living on
 * the hook. That bag is the problem: `FreezoneShell` is mounted without a key,
 * so switching canvases re-runs the hydrate effect against the *same* refs. A
 * save scheduled for canvas A would wake up holding refs that now describe
 * canvas B, and there was no way to tell from inside the scheduler which canvas
 * any given piece of state belonged to.
 *
 * A session fixes that by construction: everything that can go stale across a
 * canvas load lives on a session object, and a canvas load creates a new one.
 * The old session is disposed, its queued work is dropped, and its in-flight
 * request — which we deliberately do *not* cancel, the server should still
 * commit it — can no longer write to anything the new canvas reads.
 *
 * The invariants the session guarantees:
 *
 *  1. At most one save request in flight per session.
 *  2. N edits during one request collapse into a single follow-up request,
 *     which reads the store at *send* time so it carries the newest content.
 *  3. Sessions never share a promise. A save for the canvas you just switched
 *     to is never satisfied by a save belonging to the canvas you left.
 *  4. A caller waiting on `requestSave()` is released only once a request that
 *     covers *its* content version has actually landed.
 *  5. Disposal releases every waiter (as "not persisted") rather than hanging.
 *  6. `hasUnsavedContentBeyond` lets the caller avoid dropping the local draft
 *     while newer content is still queued.
 */

export interface CanvasSaveSession {
  /** `${project}:${canvasId}` — which canvas this session saves. */
  readonly canvasKey: string;
  /**
   * The canvas-load counter this session was created under. `useCanvasSync`
   * stamps outgoing requests with it and refuses to apply a response whose
   * stamp no longer matches, which is what keeps a late reply from canvas A
   * out of canvas B's revision/status.
   */
  readonly generation: number;
  isDisposed(): boolean;
  /** True while a request is on the wire or a follow-up is queued. */
  isSaving(): boolean;
  /** Monotonic counter of save requests made against this session. */
  contentVersion(): number;
  /** The highest content version known to have reached the server. */
  savedVersion(): number;
  /**
   * Whether content newer than `version` is still waiting to be sent. Callers
   * use this to decide whether dropping the local draft is safe: a draft is the
   * only copy of edits that have not been persisted yet.
   */
  hasUnsavedContentBeyond(version: number): boolean;
  /**
   * Ask for the current store content to be persisted. Resolves true once a
   * request covering this call's content has landed, false if that content was
   * never persisted (conflict, error, the decision gate declined, or the
   * session was disposed first).
   */
  requestSave(): Promise<boolean>;
  /**
   * Retire this session. Queued work is dropped and waiters are released;
   * anything already on the wire is left alone to finish server-side.
   */
  dispose(): void;
}

export interface CanvasSaveSessionOptions {
  canvasKey: string;
  generation: number;
  /**
   * Put the canvas on the wire. Called only by the pump, never concurrently
   * with itself, and always immediately before the request goes out — so it
   * must read the live stores rather than close over a snapshot. Resolves true
   * when the content was persisted.
   */
  runSave: (version: number, session: CanvasSaveSession) => Promise<boolean>;
}

interface Waiter {
  version: number;
  resolve: (persisted: boolean) => void;
}

export function createCanvasSaveSession(
  options: CanvasSaveSessionOptions,
): CanvasSaveSession {
  let contentVersion = 0;
  let savedVersion = 0;
  // The single queued follow-up, as a content version rather than a promise.
  // Holding a version instead of a promise is what makes coalescing free: a
  // second edit during a request just overwrites it.
  let pendingVersion: number | null = null;
  let pumping = false;
  let disposed = false;
  const waiters: Waiter[] = [];

  /** Release every waiter at or below `upTo`. */
  const settle = (upTo: number, persisted: boolean): void => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].version <= upTo) {
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(persisted);
      }
    }
  };

  const session: CanvasSaveSession = {
    canvasKey: options.canvasKey,
    generation: options.generation,
    isDisposed: () => disposed,
    isSaving: () => pumping,
    contentVersion: () => contentVersion,
    savedVersion: () => savedVersion,
    hasUnsavedContentBeyond: (version: number) =>
      pendingVersion !== null || contentVersion > version,
    requestSave: () => {
      if (disposed) return Promise.resolve(false);
      const version = (contentVersion += 1);
      // Latest wins: an earlier queued version is simply superseded, because
      // the request that eventually goes out re-reads the store anyway and
      // will therefore carry that earlier content too.
      pendingVersion = version;
      const landed = new Promise<boolean>((resolve) => {
        waiters.push({ version, resolve });
      });
      startPump();
      return landed;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      pendingVersion = null;
      // Nothing queued will ever run now. Waiters must learn that rather than
      // hang — `flush()` on the way out of a canvas depends on it.
      settle(Number.POSITIVE_INFINITY, false);
    },
  };

  async function pump(): Promise<void> {
    while (!disposed && pendingVersion !== null) {
      const version = pendingVersion;
      pendingVersion = null;

      let persisted = false;
      try {
        persisted = await options.runSave(version, session);
      } catch {
        // `runSave` reports its own failures through the hook's error handling;
        // a rejection here only means "not persisted".
        persisted = false;
      }

      if (disposed) return;

      if (persisted) {
        savedVersion = Math.max(savedVersion, version);
        settle(savedVersion, true);
        continue;
      }

      // The request did not stick — a conflict, a hard error, or the decision
      // gate declining to send. Draining the queue would re-send immediately
      // into the same wall (the hook stops autosaving once status is
      // conflict/error, so every retry would decline again, spinning). Stop the
      // pump instead; the next genuine edit calls `requestSave` and restarts
      // it. Everything still waiting is told its content did not land.
      pendingVersion = null;
      settle(Number.POSITIVE_INFINITY, false);
      return;
    }
  }

  function startPump(): void {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        await pump();
      } finally {
        pumping = false;
        // Re-check before parking. `settle()` only *resolves* the waiters — their
        // `.then` callbacks run in a later microtask, after the loop has already
        // seen an empty queue and returned. So a caller that saves again the
        // moment its save lands (`await requestSave(); …; requestSave()`) enqueues
        // while `pumping` is still true, and its `startPump()` bails out. Without
        // this re-check that work would sit in `pendingVersion` forever and its
        // promise would never settle.
        if (!disposed && pendingVersion !== null) {
          startPump();
        }
      }
    })();
  }

  return session;
}
