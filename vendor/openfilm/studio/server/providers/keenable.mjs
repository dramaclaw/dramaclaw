// @ts-check
/**
 * Keenable: web search, and web pages read by Keenable, with no key or with the person's own. REST API
 * (https://docs.keenable.ai/api-reference). With no key it answers on its public endpoints (`/public`), 1,000 requests
 * an hour from each address; a key, in `X-API-Key`, lifts that. Either way the app names itself in `X-Keenable-Title`.
 * Each query is one `/v1/search`; each page one `/v1/fetch`, as Markdown. Running out of credits answers 402
 * (common.mjs `outOfBalance`).
 */
import { billedBy, call, serviceUrl, text } from './common.mjs';
import { HITS, fetched, hitOf, queriesOf, searched, urlsOf } from './web.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Keenable';
const MODELS = { 'web-search': [{ id: 'web', name: 'Web Search' }] };

/** @type {Provider} */
export default {
  id: 'keenable',
  name: NAME,
  env: 'KEENABLE_API_KEY',
  keysUrl: 'https://app.keenable.ai/console',
  billingUrl: 'https://app.keenable.ai/console',
  verbs: ['web-search', 'web-fetch'],
  models: MODELS,
  keyless: true,
  async run(verb, args, ctx) {
    const base = serviceUrl('KEENABLE', 'https://api.keenable.ai');
    /* the keyed endpoint, or with no key its public one */
    const at = (/** @type {string} */ path) => `${base}${path}${ctx.key ? '' : '/public'}`;
    const headers = { 'x-keenable-title': 'Dramaclaw', ...(ctx.key ? { 'x-api-key': ctx.key } : {}) };
    const cost = ctx.key ? { cost: billedBy(NAME) } : {};

    if (verb === 'web-search') {
      const { queries, ignored } = queriesOf(args);
      const rows = await Promise.all(queries.map(async (query) => {
        const body = /** @type {any} */ (await (await call(NAME, at('/v1/search'), {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: HITS }),
        }, ctx)).json());
        const results = Array.isArray(body?.results) ? body.results : [];
        /* the page's text is in `snippet`; Keenable leaves `description` empty */
        return { query, hits: results.map((/** @type {any} */ r) => hitOf({ title: r?.title, url: r?.url, excerpt: r?.snippet })) };
      }));
      return { ...searched('keenable', rows, ignored), ...cost };
    }
    if (verb === 'web-fetch') {
      const { urls, ignored } = urlsOf(args);
      /* one request a page, in the order asked */
      const read = await Promise.all(urls.map(async (url) => {
        try {
          const body = /** @type {any} */ (await (await call(NAME, `${at('/v1/fetch')}?${new URLSearchParams({ url })}`, { headers }, ctx)).json());
          const page = { url, title: text(body?.title), text: text(body?.content) };
          return page.text ? { url, page, why: '' } : { url, page: null, why: 'Keenable read no text from it.' };
        } catch (e) {
          if (ctx.signal.aborted || /** @type {{ code?: string }} */ (e)?.code === 'balance') throw e;
          return { url, page: null, why: /** @type {Error} */ (e).message };
        }
      }));
      const pages = read.flatMap((r) => r.page ? [r.page] : []);
      const failed = read.flatMap((r) => r.page ? [] : [{ url: r.url, why: r.why }]);
      return { ...fetched('keenable', pages, failed, ignored), ...cost };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
