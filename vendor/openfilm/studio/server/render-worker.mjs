// @ts-check
/**
 * Films rendered in a process of their own (exports.mjs `render` and `drawer`): its browsers and encoders are this
 * process's, so whatever breaks in them (a browser's pipe, a crash, memory running out) ends its renders and says why,
 * and Studio keeps serving.
 *
 * Told `{ args, opts }` once: one render, then it exits; says `progress`, then `done` (render's result) or `failed`;
 * `cancel` stops it. A render whose browser crashed or stopped answering is drawn once more in a new one.
 *
 * Started with `--pool` (an editing project's pages): told `{ type: 'render', id, args, opts }` for each render, at
 * any time, `{ type: 'cancel', id }` to stop one and `{ type: 'close' }` when no more come; says `progress`, `done`
 * and `failed` with the render's id. Its renders share one BrowserPool, so a browser is started once for many pages;
 * a render whose browser crashed or stopped answering is drawn once more in new browsers.
 */
import { render } from '../../src/render.mjs';
import { BrowserPool, browserFailed } from '../../src/browser-pool.mjs';

/* Studio gone (it stopped, or was ended): nothing will take this render, and its browsers and encoders end with it */
process.on('disconnect', () => process.exit(1));

/** @param {unknown} message */
const say = (message) => new Promise((done) => { process.send?.(message, () => done(undefined)); });

if (process.argv.includes('--pool')) {
  const pool = new BrowserPool();
  /** @type {Map<string, { abort: AbortController, drawn: Promise<void> }>} */
  const running = new Map();
  /** @param {string} id @param {string[]} args @param {Record<string, unknown>} opts @param {AbortSignal} signal */
  const draw = async (id, args, opts, signal) => {
    try {
      for (let tries = 1; ; tries++) {
        try {
          const result = await render(args, {
            ...opts, signal, browsers: pool,
            onProgress: (/** @type {number} */ done, /** @type {number} */ total) => { process.send?.({ type: 'progress', id, done, total }); },
          });
          await say({ type: 'done', id, result });
          return;
        } catch (e) {
          if (tries > 1 || signal.aborted || !browserFailed(e)) throw e;
          process.stderr.write(`openfilm: ${e instanceof Error ? e.message.split('\n')[0] : e}: drawn again in new browsers\n`);
        }
      }
    } catch (e) {
      await say({ type: 'failed', id, error: e instanceof Error ? e.message : String(e) });
    }
  };
  process.on('message', async (/** @type {{ type?: string, id: string, args: string[], opts: Record<string, unknown> }} */ m) => {
    if (m?.type === 'render') {
      const job = { abort: new AbortController(), drawn: Promise.resolve() };
      running.set(m.id, job);
      job.drawn = draw(m.id, m.args, m.opts, job.abort.signal).finally(() => running.delete(m.id));
    } else if (m?.type === 'cancel') {
      running.get(m.id)?.abort.abort();
    } else if (m?.type === 'close') {
      /* what is still drawing stops (its encoders and parts go with it), then every browser closes */
      for (const job of running.values()) job.abort.abort();
      await Promise.race([Promise.allSettled([...running.values()].map((j) => j.drawn)), new Promise((r) => setTimeout(r, 4000))]);
      await pool.close();
      process.exit(0);
    }
  });
} else {
  process.once('message', async (/** @type {{ args: string[], opts: Record<string, unknown> }} */ { args, opts }) => {
    const abort = new AbortController();
    process.on('message', (/** @type {{ type?: string }} */ m) => { if (m?.type === 'cancel') abort.abort(); });
    try {
      let result;
      for (let tries = 1; ; tries++) {
        try {
          result = await render(args, {
            ...opts, signal: abort.signal,
            onProgress: (/** @type {number} */ done, /** @type {number} */ total) => { process.send?.({ type: 'progress', done, total }); },
          });
          break;
        } catch (e) {
          if (tries > 1 || abort.signal.aborted || !browserFailed(e)) throw e;
          process.stderr.write(`openfilm: ${e instanceof Error ? e.message.split('\n')[0] : e}: drawn again in a new browser\n`);
        }
      }
      await say({ type: 'done', result });
      process.exit(0);
    } catch (e) {
      await say({ type: 'failed', error: e instanceof Error ? e.message : String(e) });
      process.exit(1);
    }
  });
}
