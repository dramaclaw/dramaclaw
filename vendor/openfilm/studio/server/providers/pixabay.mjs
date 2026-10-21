// @ts-check
/**
 * Pixabay with the person's own key (free): photos and illustrations found on the web. REST API
 * (https://pixabay.com/api/docs/), key as the `key` parameter. A search answers with each picture's sizes on Pixabay's
 * servers; the largest one a key gets (`largeImageURL`, up to 1280 px) is downloaded here, as Pixabay asks (its
 * addresses are not for linking to). Each picture says who made it and its page, the credit Pixabay asks for.
 */
import { call, clamp, foundPictures, landing, needed, number, serviceUrl, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Pixabay';
/** what it finds, as its `image_type` */
const MODELS = {
  'image-search': [{ id: 'photo', name: 'Photos' }, { id: 'illustration', name: 'Illustrations' }, { id: 'all', name: 'Photos and illustrations' }],
};
/** the longest search it takes */
const MAX_QUERY = 100;

/** @type {Provider} */
export default {
  id: 'pixabay',
  name: NAME,
  env: 'PIXABAY_API_KEY',
  /* the key is shown on its API page once signed in */
  keysUrl: 'https://pixabay.com/api/docs/',
  billingUrl: 'https://pixabay.com/api/docs/',
  verbs: ['image-search'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb !== 'image-search') throw new Error(`${NAME} does not do ${verb}.`);
    const prompt = needed(args, 'prompt');
    landing('image', args.out, 'jpg');
    const said = prompt.length > MAX_QUERY ? [`Pixabay searches ${MAX_QUERY} characters at most: the prompt was cut there`] : [];
    const type = MODELS['image-search'].find((m) => m.id === ctx.model)?.id ?? 'photo';
    const query = new URLSearchParams({
      key: ctx.key, q: prompt.slice(0, MAX_QUERY), image_type: type, safesearch: 'true',
      /* a few more than asked, so one that cannot be downloaded has a stand-in */
      per_page: String(clamp(Math.round(number(args.n) ?? 1) + 2, 3, 200)),
    });
    const base = serviceUrl('PIXABAY', 'https://pixabay.com');
    /* a key it does not take is a 400, said like any refused key */
    const res = await call(NAME, `${base}/api/?${query}`, {}, ctx).catch((e) => {
      throw /Invalid or missing API key/i.test(e.message) ? new Error(`${NAME} did not accept your key. Check it in Studio: Settings (the OpenFilm logo at the top left) → Providers.`) : e;
    });
    const body = /** @type {any} */ (await res.json());
    const hits = (Array.isArray(body?.hits) ? body.hits : []).flatMap((/** @type {any} */ h) => {
      const url = text(h?.largeImageURL) || text(h?.webformatURL);
      return url ? [{ url, page: text(h.pageURL), credit: `Image by ${text(h.user) || 'unknown'} on Pixabay` }] : [];
    });
    return foundPictures({ service: NAME, provider: 'pixabay', args, hits, notes: said }, ctx);
  },
};
