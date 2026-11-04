// @ts-check
/**
 * Brave Search with the person's own key: web search. REST API (https://api-dashboard.search.brave.com/app/documentation),
 * key in `X-Subscription-Token`. Each query is one request for its web results, without highlighting. Brave has no way
 * to read a page, so web pages are read here, from this machine, with no service (web.mjs `readPage`).
 */
import { billedBy, call, serviceUrl, text } from './common.mjs';
import { HITS, fetched, hitOf, queriesOf, readPage, searched, urlsOf } from './web.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Brave Search';
const MODELS = { 'web-search': [{ id: 'web', name: 'Web Search' }] };
/** the longest query it takes */
const MAX_QUERY = 600;

/** @type {Provider} */
export default {
  id: 'brave',
  name: NAME,
  env: 'BRAVE_API_KEY',
  keysUrl: 'https://api-dashboard.search.brave.com/app/keys',
  billingUrl: 'https://api-dashboard.search.brave.com/',
  verbs: ['web-search', 'web-fetch'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb === 'web-search') {
      const { queries, ignored } = queriesOf(args);
      const base = serviceUrl('BRAVE', 'https://api.search.brave.com');
      const rows = await Promise.all(queries.map(async (query) => {
        const q = new URLSearchParams({ q: query.slice(0, MAX_QUERY), count: String(HITS), result_filter: 'web', text_decorations: 'false' });
        const body = /** @type {any} */ (await (await call(NAME, `${base}/res/v1/web/search?${q}`, {
          headers: { accept: 'application/json', 'x-subscription-token': ctx.key },
        }, ctx)).json());
        const results = Array.isArray(body?.web?.results) ? body.web.results : [];
        return { query, hits: results.map((/** @type {any} */ r) => hitOf({ title: r?.title, url: r?.url, excerpt: text(r?.description), publishedAt: r?.page_age })) };
      }));
      return { ...searched('brave', rows, ignored), cost: billedBy(NAME) };
    }
    if (verb === 'web-fetch') {
      const { urls, ignored } = urlsOf(args);
      /* in the order asked */
      const read = await Promise.all(urls.map(async (url) => {
        try { return { url, page: await readPage(url, ctx), why: '' }; } catch (e) {
          if (ctx.signal.aborted) throw e;
          return { url, page: null, why: /** @type {Error} */ (e).message };
        }
      }));
      const pages = read.flatMap((r) => r.page ? [r.page] : []);
      const failed = read.flatMap((r) => r.page ? [] : [{ url: r.url, why: r.why }]);
      return fetched('local', pages, failed, ignored);
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
