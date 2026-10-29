// @ts-check
/**
 * Pexels with the person's own key (free): photos found on the web. REST API (https://www.pexels.com/api/documentation/),
 * key as the `Authorization` header. A search answers with each photo's sizes on Pexels' servers; the large one
 * (`src.large2x`, about 1880 px wide) is downloaded here. Pexels asks that its photographers be credited: each picture
 * says who took it and its page.
 */
import { call, clamp, foundPictures, landing, needed, number, serviceUrl, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Pexels';
/** what it finds (Pexels has photos only) */
const MODELS = { 'image-search': [{ id: 'photos', name: 'Photos' }] };

/** @type {Provider} */
export default {
  id: 'pexels',
  name: NAME,
  env: 'PEXELS_API_KEY',
  keysUrl: 'https://www.pexels.com/api/',
  /* free: its API page is where its limits are */
  billingUrl: 'https://www.pexels.com/api/',
  verbs: ['image-search'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb !== 'image-search') throw new Error(`${NAME} does not do ${verb}.`);
    const prompt = needed(args, 'prompt');
    landing('image', args.out, 'jpg');
    /* a few more than asked, so one that cannot be downloaded has a stand-in */
    const query = new URLSearchParams({ query: prompt, per_page: String(clamp(Math.round(number(args.n) ?? 1) + 2, 1, 80)) });
    const base = serviceUrl('PEXELS', 'https://api.pexels.com');
    const body = /** @type {any} */ (await (await call(NAME, `${base}/v1/search?${query}`, { headers: { authorization: ctx.key } }, ctx)).json());
    const hits = (Array.isArray(body?.photos) ? body.photos : []).flatMap((/** @type {any} */ p) => {
      const url = text(p?.src?.large2x) || text(p?.src?.original);
      return url ? [{ url, page: text(p.url), credit: `Photo by ${text(p.photographer) || 'unknown'} on Pexels` }] : [];
    });
    return foundPictures({ service: NAME, provider: 'pexels', args, hits, notes: [] }, ctx);
  },
};
