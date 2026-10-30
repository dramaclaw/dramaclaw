// @ts-check
/**
 * Tavily with the person's own key: web search, and web pages read by Tavily (pages drawn by their scripts too). REST
 * API (https://docs.tavily.com/documentation/api-reference), key as a bearer token. Each query is one `/search`; the
 * pages are one `/extract`, as Markdown. Running out of credits answers 432 or 433 (common.mjs `outOfBalance`).
 */
import { billedBy, call, modelOf, serviceUrl, text } from './common.mjs';
import { HITS, fetched, hitOf, queriesOf, searched, urlsOf } from './web.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Tavily';
/** its search depths, the default first (advanced costs twice as much) */
const MODELS = { 'web-search': [{ id: 'basic', name: 'Search' }, { id: 'advanced', name: 'Advanced Search' }] };

/** A page's title from its Markdown: its first line when that is a heading, taken off the text. @param {string} markdown */
function titled(markdown) {
  const lines = markdown.trim().split('\n');
  const head = /^#{1,2}\s+(.+)$/.exec(lines[0] ?? '');
  return head ? { title: head[1].trim(), text: lines.slice(1).join('\n').trim() } : { title: '', text: markdown.trim() };
}

/** @type {Provider} */
export default {
  id: 'tavily',
  name: NAME,
  env: 'TAVILY_API_KEY',
  keysUrl: 'https://app.tavily.com/home',
  billingUrl: 'https://app.tavily.com/billing',
  verbs: ['web-search', 'web-fetch'],
  models: MODELS,
  async run(verb, args, ctx) {
    const base = serviceUrl('TAVILY', 'https://api.tavily.com');
    const post = async (/** @type {string} */ path, /** @type {unknown} */ body) => /** @type {any} */ (await (await call(NAME, `${base}${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }, ctx)).json());

    if (verb === 'web-search') {
      const { queries, ignored } = queriesOf(args);
      const depth = modelOf(MODELS, 'web-search', ctx);
      const rows = await Promise.all(queries.map(async (query) => {
        const body = await post('/search', { query, search_depth: depth, max_results: HITS, topic: 'general' });
        const results = Array.isArray(body?.results) ? body.results : [];
        return { query, hits: results.map((/** @type {any} */ r) => hitOf({ title: r?.title, url: r?.url, excerpt: r?.content, publishedAt: r?.published_date })) };
      }));
      return { ...searched('tavily', rows, ignored), cost: billedBy(NAME) };
    }
    if (verb === 'web-fetch') {
      const { urls, ignored } = urlsOf(args);
      const body = await post('/extract', { urls, format: 'markdown', extract_depth: 'basic' });
      /** @type {{ url: string, title: string, text: string }[]} */
      const pages = (Array.isArray(body?.results) ? body.results : []).flatMap((/** @type {any} */ r) => {
        const page = titled(text(r?.raw_content));
        return text(r?.url) && page.text ? [{ url: text(r.url), ...page }] : [];
      });
      /** @type {{ url: string, why: string }[]} */
      const failed = (Array.isArray(body?.failed_results) ? body.failed_results : [])
        .map((/** @type {any} */ f) => ({ url: text(f?.url), why: text(f?.error) || 'Tavily could not read it.' }));
      /* a page it answered for neither way (or with no text) failed too */
      const answered = new Set([...pages.map((p) => p.url), ...failed.map((f) => f.url)]);
      if (pages.length + failed.length < urls.length) {
        for (const url of urls) if (!answered.has(url)) failed.push({ url, why: 'Tavily read no text from it.' });
      }
      return { ...fetched('tavily', pages, failed, ignored), cost: billedBy(NAME) };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
