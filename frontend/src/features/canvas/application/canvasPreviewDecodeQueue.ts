// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

type Result = (decoded: boolean) => void;
type Job = { src: string; listeners: Set<Result>; active: boolean };

/** In-flight deduplication only. Decoded pixels are left to the browser cache. */
export function createPreviewDecodeQueue(createImage = () => new Image(), concurrency = 4) {
  const limit = Math.max(1, Math.floor(concurrency) || 1);
  const jobs = new Map<string, Job>();
  let active = 0;
  const pump = () => {
    for (const job of jobs.values()) {
      if (active >= limit) break;
      if (job.active) continue;
      job.active = true; active++;
      let image: HTMLImageElement | undefined;
      let ended = false;
      let decoding = false;
      const finish = (ok: boolean) => {
        if (ended) return;
        ended = true;
        clearTimeout(timeout);
        if (image) { image.onload = null; image.onerror = null; }
        jobs.delete(job.src); active--;
        const callbacks = [...job.listeners]; job.listeners.clear();
        try { for (const callback of callbacks) callback(ok); }
        finally { pump(); }
      };
      // A hung browser request must not occupy a worker forever. Cancellation
      // prevents commits; it does not claim to interrupt native image decoding.
      const timeout = setTimeout(() => finish(false), 30000);
      const decode = () => {
        if (decoding || ended) return;
        decoding = true;
        if (!image?.naturalWidth) { finish(false); return; }
        if (typeof image.decode === 'function') {
          try { void image.decode().then(() => finish(true), () => finish(false)); }
          catch { finish(false); }
        } else finish(true);
      };
      try {
        image = createImage();
        image.decoding = 'async';
        image.onload = decode;
        image.onerror = () => finish(false);
        image.src = job.src;
        if (image.complete && image.naturalWidth) decode();
      } catch { finish(false); }
    }
  };
  return {
    request(src: string, listener: Result): () => void {
      let job = jobs.get(src);
      if (!job) { job = { src, listeners: new Set(), active: false }; jobs.set(src, job); }
      job.listeners.add(listener);
      pump();
      return () => {
        job.listeners.delete(listener);
        if (!job.active && !job.listeners.size && jobs.get(src) === job) jobs.delete(src);
      };
    },
  };
}

export const canvasPreviewDecodeQueue = createPreviewDecodeQueue();
