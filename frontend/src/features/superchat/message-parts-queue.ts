type Body = { scope: unknown; turn_id: string; event: { type: string; parts: unknown[]; snapshot_revision?: number } };

/** Thrown by `send` when the server will never accept this turn's snapshot (HTTP 413). */
export class SnapshotRejectedError extends Error {}

// One latest snapshot per turn; serialize requests to avoid terminal-state rollback.
export function createMessagePartsQueue(send: (body: Body) => Promise<void>) {
  const pending = new Map<string, Body>();
  // Turns the server refused permanently; the last stored version stays authoritative.
  const rejected = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let revision = Date.now() * 1000;
  const deliver = async (key: string, body: Body): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await send(body); return true; }
      catch (error) {
        if (error instanceof SnapshotRejectedError) {
          rejected.add(key);
          pending.delete(key);
          console.error("Chat history snapshot rejected; keeping the last saved version", error);
          return true;
        }
        if (attempt === 2) console.error("Chat history could not be saved", error);
        else await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    return false;
  };
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) return running;
    running = (async () => {
      // Map iteration also visits entries enqueued while a request is retrying, so a newer
      // snapshot (e.g. the terminal one) is attempted in this run instead of being stranded.
      const failed = new Map<string, Body>();
      for (const [key, body] of pending) {
        pending.delete(key);
        if (await deliver(key, body)) failed.delete(key); // A newer version superseded the failure.
        else failed.set(key, body);
      }
      // Bounded retries: keep failures for the next flush unless a newer version is queued.
      for (const [key, body] of failed) if (!pending.has(key)) pending.set(key, body);
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    enqueue(key: string, body: Body) {
      if (rejected.has(key)) return;
      revision = Math.max(revision + 1, Date.now() * 1000);
      pending.set(key, { ...body, event: { ...body.event, snapshot_revision: revision } });
      if (!timer) timer = setTimeout(() => { void flush(); }, 500);
    },
    flush,
  };
}
