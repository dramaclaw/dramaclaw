type Body = { scope: unknown; turn_id: string; event: { type: string; parts: unknown[]; snapshot_revision?: number } };

// One latest snapshot per turn; serialize requests to avoid terminal-state rollback.
export function createMessagePartsQueue(send: (body: Body) => Promise<void>) {
  const pending = new Map<string, Body>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let revision = Date.now() * 1000;
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) return running;
    running = (async () => {
      for (const [key, body] of pending) {
        pending.delete(key);
        let delivered = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await send(body); delivered = true; break; }
          catch (error) {
            if (attempt === 2) console.error("Chat history could not be saved", error);
            else await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        if (!delivered) {
          if (!pending.has(key)) pending.set(key, body);
          break; // Bounded retries; retain for the next flush.
        }
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    enqueue(key: string, body: Body) {
      revision = Math.max(revision + 1, Date.now() * 1000);
      pending.set(key, { ...body, event: { ...body.event, snapshot_revision: revision } });
      if (!timer) timer = setTimeout(() => { void flush(); }, 500);
    },
    flush,
  };
}
