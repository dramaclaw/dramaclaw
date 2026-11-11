// Browsers kept for many renders: Studio's editing-project export draws page after page with the same ones, instead
// of starting a browser for each page. A render borrows some (take) and gives them back (give); each page opens its
// own tab in them and closes it after.
import { launch } from './host.mjs';

/**
 * Pages a browser draws before it is closed and a new one started. A browser's memory measured flat over 20 pages
 * (a new tab each), so this only bounds whatever a page might leave behind in it.
 */
export const PAGES_PER_BROWSER = 24;

export class BrowserPool {
  /** @type {import('playwright-core').Browser[]} */
  #idle = [];
  /** @type {Map<import('playwright-core').Browser, number>} pages each browser has drawn */
  #drawn = new Map();
  #closed = false;
  /** @param {{ start?: () => Promise<import('playwright-core').Browser> }} [opts] how a browser is started (tests) */
  constructor({ start = () => launch() } = {}) {
    this.start = start;
  }

  /** How many browsers are open: lent and idle. */
  get size() { return this.#drawn.size; }

  /**
   * `n` browsers: idle ones first (one that died while idle is dropped), the rest started now, at once.
   * @param {number} n @returns {Promise<import('playwright-core').Browser[]>}
   */
  async take(n) {
    if (this.#closed) throw new Error('cancelled');
    /** @type {import('playwright-core').Browser[]} */
    const out = [];
    while (out.length < n && this.#idle.length) {
      const b = /** @type {import('playwright-core').Browser} */ (this.#idle.pop());
      if (b.isConnected()) out.push(b);
      else this.#drawn.delete(b);
    }
    const started = await Promise.allSettled(Array.from({ length: n - out.length }, () => this.start()));
    for (const s of started) if (s.status === 'fulfilled') { this.#drawn.set(s.value, 0); out.push(s.value); }
    const failed = started.find((s) => s.status === 'rejected');
    if (failed || this.#closed) {
      await this.give(out);
      throw failed ? /** @type {PromiseRejectedResult} */ (failed).reason : new Error('cancelled');
    }
    return out;
  }

  /**
   * Browsers back, a page drawn with each. One that crashed, one the render could not finish with (`retire`: it may
   * hang), and one that has drawn PAGES_PER_BROWSER pages are closed; a new one starts when next asked for.
   * @param {import('playwright-core').Browser[]} browsers @param {{ retire?: boolean }} [opts]
   */
  async give(browsers, { retire = false } = {}) {
    await Promise.allSettled(browsers.map(async (b) => {
      const drawn = (this.#drawn.get(b) ?? 0) + 1;
      if (this.#closed || retire || !b.isConnected() || drawn >= PAGES_PER_BROWSER) {
        this.#drawn.delete(b);
        await b.close();
        return;
      }
      this.#drawn.set(b, drawn);
      this.#idle.push(b);
    }));
  }

  /** Every browser closed, lent or not; take fails from now on. */
  async close() {
    this.#closed = true;
    const all = [...this.#drawn.keys()];
    this.#drawn.clear();
    this.#idle = [];
    await Promise.allSettled(all.map((b) => b.close()));
  }
}

/**
 * What a browser that crashed, or a tab that stopped answering, says: drawn again in new browsers, it may work. Also a
 * page or a file the browser could not load from Studio for want of the system's network buffers (Windows: a moment's
 * shortage, not the page's fault). And a film whose video frames its browser never showed (host.mjs VideoNotShown).
 */
const BROWSER_FAILED = /browser drawing the page closed|target (page, context or browser has been )?closed|target crashed|page crashed|browser has been closed|browser (has )?disconnected|did not finish within|did not come within|net::ERR_NO_BUFFER_SPACE|video is shown another way from now on/i;

/**
 * Whether a render that failed is worth drawing again in new browsers: its browser crashed or stopped answering. A
 * page's own error (a frame that throws, a file that is missing) or a loop in its code would fail again.
 * @param {unknown} e
 */
export const browserFailed = (e) => e instanceof Error && BROWSER_FAILED.test(e.message) && !/still running code/.test(e.message);
