// @ts-check
/**
 * A film rendered in a process of its own (exports.mjs `renderApart`): its browsers and encoders are this process's,
 * so whatever breaks in them (a browser's pipe, a crash, memory running out) ends this render and says why, and Studio
 * keeps serving. Told `{ args, opts }` once; says `progress`, then `done` (render's result) or `failed`; `cancel`
 * stops it.
 */
import { render } from '../../src/render.mjs';

/* Studio gone (it stopped, or was ended): nothing will take this render, and its browsers and encoders end with it */
process.on('disconnect', () => process.exit(1));

process.once('message', async (/** @type {{ args: string[], opts: Record<string, unknown> }} */ { args, opts }) => {
  const abort = new AbortController();
  process.on('message', (/** @type {{ type?: string }} */ m) => { if (m?.type === 'cancel') abort.abort(); });
  /** @param {unknown} message */
  const say = (message) => new Promise((done) => { process.send?.(message, () => done(undefined)); });
  try {
    const result = await render(args, {
      ...opts, signal: abort.signal,
      onProgress: (/** @type {number} */ done, /** @type {number} */ total) => { process.send?.({ type: 'progress', done, total }); },
    });
    await say({ type: 'done', result });
    process.exit(0);
  } catch (e) {
    await say({ type: 'failed', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
});
