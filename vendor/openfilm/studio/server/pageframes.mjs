// @ts-check
/**
 * Pictures of web pages: a page's frame at a moment, small (the timeline's thumbnails of a page clip, and a page's
 * poster in the media pane). A video's frames come from ffmpeg (derived.mjs); a page has no file to cut from, so it is
 * drawn the way an export draws it: in the headless browser, one frame. One browser for Studio, started on the first
 * request and closed after a minute without any; a few pages kept open (opening one is the slow part); one frame at a
 * time, so thumbnails never compete with the person's own preview for long. Cached in .film/cache by the page file's
 * version, the moment and the width.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FilmPage, launch } from '../../src/host.mjs';
import { FILM_FILE, clipKind } from '../../src/film-doc.mjs';
import { browserCopies, filmVideos, madeCopy } from '../../src/seekable.mjs';
import { TOOL_DIR } from './projects.mjs';
import { writeAtomic } from './atomic.mjs';
import { inProject } from './files.mjs';

const KEEP_PAGES = 4;
/** Where a poster is looked for, as shares of the page's length. */
const POSTER_AT = [0.5, 0.4, 0.62, 0.3];
/** A page without a duration has no end: its poster is looked for in its first seconds, as long as a dropped still. */
const NO_END_SPAN = 4;
/** The width a poster is drawn at: a page asked about is opened at it too, so the two share one open page. */
const POSTER_W = 480;
const IDLE_MS = 60_000;
/* a thumbnail's frame that takes longer is given up (the queue of frames must not wait on one page for ever) */
const FRAME_MS = 15_000;
/* a whole job (the page opened, its frames drawn) that takes longer closes the browser: whatever it waits on, the
   queue goes on (the editor's requests wait on these pictures, and a browser has few connections to Studio) */
const JOB_MS = 45_000;
const FAILED_KEPT_MS = 30_000;
/** @type {Map<string, { error: unknown, at: number }>} frames that could not be drawn, by project and cache key */
const failures = new Map();
/** @type {Map<string, { error: unknown, at: number }>} pages that could not be opened, by pageFor's key: every frame of
 * one fails at once for a while, rather than each waiting out the same page again */
const unopened = new Map();
/** @type {Map<string, Promise<Buffer>>} frames being drawn, by project and cache key: asked again meanwhile, drawn once */
const drawing = new Map();

/** @type {Promise<import('playwright-core').Browser> | null} */
let browser = null;
/** @type {Map<string, Promise<FilmPage>>} url → open page, most recently used last */
const open = new Map();
let queue = Promise.resolve();
/** @type {NodeJS.Timeout | null} */
let idle = null;

export class PageFrameError extends Error {}

/** The whole film, as the timeline page plays it (served on the film origin beside the project's files). */
export const FILM_PAGE = FILM_FILE;

/**
 * The page `rel` of the folder served at `base` (its film-origin URL), drawn at `ms`, `width` px wide, as JPEG.
 * `ms` past the page's end draws its last frame; `ms` < 0 draws the middle (its poster). `overrides`: a page clip's
 * (SPEC §1), drawn with it, so its pictures on the timeline show what was changed in it. `size`: a page clip's, the
 * CSS pixels a page without a size of its own is laid out at (SPEC §1), as the film lays it out; without one it is
 * 1920 × 1080, as a page opened on its own.
 * @param {string} root @param {string} base @param {string} rel @param {number} ms @param {number} width
 * @param {object[] | null} [overrides] @param {{ w: number, h: number } | null} [size]
 */
export async function pageFrame(root, base, rel, ms, width, overrides = null, size = null) {
  const w = Math.max(32, Math.min(960, Math.round(width / 2) * 2 || 160));
  /* `rel` is the request's: a page of the project only, never one reached by `../` or a link out of the folder */
  const page = inProject(root, rel);
  const info = page ? await stat(page).catch(() => null) : null;
  if (!info?.isFile()) throw new PageFrameError(`${rel} is not there`);
  /* `black`: how frames are drawn (frames drawn on white before are not reused) */
  const tweaks = overrides?.some((o) => o && typeof o === 'object' && 'at' in o) ? JSON.stringify(overrides) : '';
  const laid = size ? `${Math.round(size.w)}x${Math.round(size.h)}` : '';
  const key = createHash('sha256').update(`black\0${rel}\0${Math.round(ms)}\0${w}${tweaks ? `\0${tweaks}` : ''}${laid ? `\0${laid}` : ''}`).digest('hex').slice(0, 24);
  const dir = join(root, TOOL_DIR, 'cache', 'pageframes');
  const file = join(dir, `${key}.jpg`);
  /* a frame is good while every file the page loaded to draw it is as it was then: the page, and its styles, code,
     fonts, pictures (a page's look changes with a stylesheet it shares as much as with itself) */
  const known = await readFile(join(dir, `${key}.json`), 'utf8').then((t) => /** @type {string[]} */ (JSON.parse(t).files), () => null);
  const files = known?.includes(rel) ? known : [rel];
  const version = await stampOf(root, files);
  if (known && version === await readFile(join(dir, `${key}.stamp`), 'utf8').catch(() => '')) {
    const cached = await readFile(file).catch(() => null);
    if (cached) return cached;
  }
  /* two projects can hold the same file at the same version (a copied folder): what failed in one is not the other's */
  const id = `${root}\0${key}\0${version}`;
  /* a page that failed is not tried again for a while (the same files, the same frame): one broken page must not
     hold every thumbnail behind it again on each request */
  const failed = failures.get(id);
  if (failed && Date.now() - failed.at < FAILED_KEPT_MS) throw failed.error;
  const pending = drawing.get(id);
  if (pending) return pending;
  const made = (async () => {
    /* the film's footage this browser does not decode (ProRes; HEVC without a chip for it) gets a copy it plays first,
       served in its place (pages.mjs): drawn without one, the film shows nothing where it is */
    if (rel === FILM_PAGE) await filmCopies(root, base, info);
    /* a page drawn with tweaks is one of its own: the page kept open for another clip of the same file has none */
    const drawn = tweaks ? `${version}:${createHash('sha256').update(tweaks).digest('hex').slice(0, 12)}` : version;
    const { jpeg, duration, loaded } = await draw(pageUrl(base, rel), ms, w, drawn, base, tweaks ? overrides : null, laid ? size : null).catch((e) => {
      failures.set(id, { error: e, at: Date.now() });
      if (failures.size > 500) failures.delete(failures.keys().next().value ?? '');
      throw e;
    });
    /* the project's folder went while the frame was drawn (deleted, moved): nothing is written where it was */
    if (!existsSync(root)) return jpeg;
    const deps = [...new Set([rel, ...loaded])].filter((f) => existsSync(join(root, f)));
    await mkdir(dir, { recursive: true });
    await writeAtomic(file, jpeg);
    await writeAtomic(join(dir, `${key}.json`), JSON.stringify({ files: deps }));
    await writeAtomic(join(dir, `${key}.stamp`), await stampOf(root, deps));
    if (rel === FILM_PAGE) {
      /* the whole film's length, learnt on the way: the projects list shows it (projects.mjs filmDuration) */
      if (Number.isFinite(duration)) await writeAtomic(join(root, TOOL_DIR, 'cache', FILM_DURATION), JSON.stringify({ film: `${info.mtimeMs}:${info.size}`, duration }));
      /* the film's poster, kept as its last whatever film.html becomes (filmPoster) */
      if (ms < 0 && w === POSTER_W) await writeAtomic(join(root, TOOL_DIR, 'cache', FILM_POSTER), jpeg);
    }
    return jpeg;
  })();
  drawing.set(id, made);
  made.then(() => drawing.delete(id), () => drawing.delete(id));
  return made;
}

/**
 * What `files` (project relative) are now: each one's change time and size, as one text (a file gone reads so); a
 * video with a copy played in its place (seekable.mjs) says so, so a frame drawn before the copy was made is not kept.
 */
async function stampOf(/** @type {string} */ root, /** @type {string[]} */ files) {
  const parts = await Promise.all(files.map((f) => stat(join(root, f)).then(
    (s) => `${f}:${s.mtimeMs}:${s.size}${clipKind(f) === 'video' && madeCopy(join(root, f), root) ? ':copy' : ''}`, () => `${f}:-`)));
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 24);
}

/** @type {Map<string, string>} the version of each project's film.html whose footage got its copies */
const copied = new Map();
/**
 * The copies the film's footage needs to be drawn by this browser (seekable.mjs), made once for each version of
 * film.html (`info`); a footage file changed since gets its own when it is drawn next with a changed film.html.
 * @param {string} root @param {string} base @param {import('node:fs').Stats} info
 */
async function filmCopies(root, base, info) {
  const version = `${info.mtimeMs}:${info.size}`;
  if (copied.get(root) === version) return;
  browser ??= launch().catch((e) => { browser = null; throw e; });
  const b = await browser.catch(() => null);
  if (!b) return;
  await browserCopies(b, base, root, filmVideos(root, FILM_FILE));
  copied.set(root, version);
}

/** The film's last poster, in `.film/cache/`: what its card shows at once while the poster of a changed film is drawn. */
const FILM_POSTER = 'film-poster.jpg';
/** How long a card waits for the film's current poster before it is given the last one: one drawn already is read
 * from the cache in far less, and drawing one takes seconds. */
const STALE_AFTER_MS = 300;
/** How long a card waits for a film's first poster (none drawn before) before it is told to ask again: the card's
 * request holds one of the few connections a browser opens to Studio, and the editor's own requests wait behind it. */
const FIRST_WAIT_MS = 2_000;
/** How long after a project opens its first poster is drawn: after the editor's own first thumbnails. */
const WARM_MS = 10_000;
/** @type {Map<string, NodeJS.Timeout>} projects whose first poster is about to be drawn */
const warming = new Map();

/**
 * The film's poster (pageFrame of the whole film at -1: its fullest moment around the middle), for the project's card
 * in the projects list. Drawing it takes seconds (the whole film opens, every page in it, one frame at a time behind
 * the open project's own thumbnails), and any change to film.html makes a new one, so a card waiting for it showed
 * nothing. The current poster comes when it is drawn already; else the last one comes at once while the current one
 * is drawn for next time; a film never drawn is waited for a moment (FIRST_WAIT_MS), then null: it is still being
 * drawn, ask again.
 * @param {string} root @param {string} base @returns {Promise<Buffer | null>}
 */
export async function filmPoster(root, base) {
  const fresh = pageFrame(root, base, FILM_PAGE, -1, POSTER_W);
  /* drawn for next time, whoever waits for it: a film that can't be drawn now (a page's library offline) still shows
     its last picture */
  fresh.catch(() => {});
  const soon = await within(fresh.catch(() => null), STALE_AFTER_MS);
  if (soon) return soon;
  const last = await readFile(join(root, TOOL_DIR, 'cache', FILM_POSTER)).catch(() => null);
  if (last) return last;
  return within(fresh, FIRST_WAIT_MS - STALE_AFTER_MS);
}

/** What `promise` gives within `ms`, else null (it goes on). @template T @param {Promise<T>} promise @param {number} ms */
async function within(promise, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    return await Promise.race([promise, new Promise((/** @type {(value: null) => void} */ done) => { timer = setTimeout(() => done(null), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A project just opened: its film's first poster drawn a little later, so the projects list has it the first time it
 * shows the project (after that, filmPoster gives the last one at once). Nothing when it has one.
 * @param {string} root @param {string} base
 */
export function warmFilmPoster(root, base) {
  if (warming.has(root) || existsSync(join(root, TOOL_DIR, 'cache', FILM_POSTER))) return;
  warming.set(root, setTimeout(() => {
    warming.delete(root);
    if (!existsSync(join(root, TOOL_DIR, 'cache', FILM_POSTER))) pageFrame(root, base, FILM_PAGE, -1, POSTER_W).catch(() => {});
  }, WARM_MS).unref());
}

/** Where the whole film's length is kept, in `.film/cache/`: `{ film: '<film.html mtime>:<size>', duration }`. */
export const FILM_DURATION = 'film-duration.json';

/** The page `rel` of the folder served at `base`, on the film's origin. */
const pageUrl = (/** @type {string} */ base, /** @type {string} */ rel) => `${base.replace(/\/$/, '')}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** Close the browser, and draw no first posters (Studio is stopping). */
export async function closePageFrames() {
  for (const timer of warming.values()) clearTimeout(timer);
  warming.clear();
  await closeBrowser();
}

/** Close the browser (Studio is stopping, or nothing was drawn for a while). */
async function closeBrowser() {
  if (idle) clearTimeout(idle);
  const b = browser;
  browser = null;
  open.clear();
  if (b) await (await b).close().catch(() => {});
}

/**
 * Draw `url` at `ms`, `w` px wide. `loaded`: the project's files the page (and every page inside it) loaded, project
 * relative (`base`: where the project is served), so the frame is known stale when one of them changes.
 */
function draw(/** @type {string} */ url, /** @type {number} */ ms, /** @type {number} */ w, /** @type {string} */ version, /** @type {string} */ base, /** @type {object[] | null} */ overrides = null, /** @type {{ w: number, h: number } | null} */ size = null) {
  return withPage(url, w, version, size, async (page) => {
    const duration = lengthOf(page);
    const end = duration != null ? Math.max(0, duration - 1e-3) : Infinity;
    /* a poster: the fullest of a few moments around the middle (a page's middle is often a scene's first, faded-in
       frame); the larger JPEG is the one with more in it */
    const moments = ms < 0 ? POSTER_AT.map((f) => Math.min(end, (duration ?? NO_END_SPAN) * f)) : [Math.min(ms / 1000, end)];
    let jpeg = null;
    for (const t of moments) {
      await page.seek(Math.max(0, t), { timeoutMs: FRAME_MS });
      /* the clip's tweaks, as the film's timeline applies them after each frame (src/overrides.mjs) */
      if (overrides) {
        await page.page.evaluate(async (list) => {
          const { override } = await import(new URL('__film/overrides.mjs', location.href).href);
          override({ win: window, touched: new Map(), found: [] }, list);
        }, overrides);
      }
      const shot = await page.capture({ format: 'jpeg', quality: 70 });
      if (!jpeg || shot.length > jpeg.length) jpeg = shot;
    }
    return { jpeg: /** @type {Buffer} */ (jpeg), duration, loaded: await loadedFiles(page, base) };
  });
}

/** The project's files a page and the pages in it loaded (as resource timing lists them), project relative. */
async function loadedFiles(/** @type {FilmPage} */ page, /** @type {string} */ base) {
  const prefix = new URL(base.endsWith('/') ? base : `${base}/`);
  const urls = new Set();
  for (const frame of page.page.frames()) {
    urls.add(frame.url());
    const listed = await frame.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name)).catch(() => []);
    for (const u of listed) urls.add(u);
  }
  const out = [];
  for (const u of urls) {
    let at;
    try { at = new URL(u); } catch { continue; }
    if (at.origin !== prefix.origin || !at.pathname.startsWith(prefix.pathname)) continue;
    const rel = decodeURIComponent(at.pathname.slice(prefix.pathname.length));
    if (rel && !rel.startsWith('__film/') && !rel.startsWith('.')) out.push(rel);
  }
  return out;
}

/**
 * What a page says of itself, for the media pane: `{ duration (s), width, height }`, no duration when it has no end;
 * `reflows` when it sets no size of its own (then laid out at what it is given: its size here is 1920 × 1080).
 * Asked of the page kept open for its poster.
 * @param {string} root @param {string} base @param {string} rel
 */
export async function pageFacts(root, base, rel) {
  /* `rel` is the request's: a page of the project only, never one reached by `../` or a link out of the folder */
  const file = inProject(root, rel);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!info?.isFile()) throw new PageFrameError(`${rel} is not there`);
  return withPage(pageUrl(base, rel), POSTER_W, `${info.mtimeMs}:${info.size}`, null, async (page) => {
    const duration = lengthOf(page);
    return { ...(duration != null ? { duration } : {}), width: page.meta.width, height: page.meta.height, ...(page.meta.sized ? {} : { reflows: true }) };
  });
}

/** A page's own length in seconds; null when it has no end (no duration, or not a length). */
const lengthOf = (/** @type {FilmPage} */ page) => {
  const d = page.meta.duration;
  return d != null && Number.isFinite(d) && d > 0 ? d : null;
};

/**
 * `use` the page kept for `url` at `w` px and `version` (laid out at `size`, see pageFrame), one at a time. A page that
 * failed, or never finished a frame, is not kept: the next request opens it fresh.
 * @template T @param {string} url @param {number} w @param {string} version @param {{ w: number, h: number } | null} size
 * @param {(page: FilmPage) => Promise<T>} use
 * @returns {Promise<T>}
 */
function withPage(url, w, version, size, use) {
  const job = queue.then(async () => {
    if (idle) clearTimeout(idle);
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => { void closeBrowser(); fail(new Error(`drawing ${url.split('/').pop()} took over ${JOB_MS / 1000} s`)); }, JOB_MS);
    });
    const work = pageFor(url, w, version, size).then(use);
    /* given up on, it fails later (its browser closed): heard, so it cannot end the process */
    work.catch(() => {});
    try {
      return await Promise.race([work, late]);
    } catch (e) {
      forget(url, w, version, size);
      throw e;
    } finally {
      clearTimeout(timer);
      idle = setTimeout(() => void closeBrowser(), IDLE_MS);
      idle.unref();
    }
  });
  queue = job.then(() => {}, () => {});
  return job;
}

/** The key a page is kept by. @param {string} url @param {number} w @param {string} version @param {{ w: number, h: number } | null} size */
const keyOf = (url, w, version, size) => `${url}@${w}${size ? `:${size.w}x${size.h}` : ''}#${version}`;

/** Close the page kept for `url` at `w` px and `version`, if one is. */
function forget(/** @type {string} */ url, /** @type {number} */ w, /** @type {string} */ version, /** @type {{ w: number, h: number } | null} */ size) {
  const key = keyOf(url, w, version, size);
  const page = open.get(key);
  open.delete(key);
  void page?.then((p) => p.close(), () => {});
}

/**
 * An open page for `url` at about `w` px wide (laid out at `size` when it has no size of its own): kept open while its
 * file is the same `version`, the least recently used one closed past KEEP_PAGES.
 */
async function pageFor(/** @type {string} */ url, /** @type {number} */ w, /** @type {string} */ version, /** @type {{ w: number, h: number } | null} */ size) {
  const key = keyOf(url, w, version, size);
  const known = open.get(key);
  if (known) {
    open.delete(key);
    open.set(key, known);
    return known;
  }
  const refused = unopened.get(key);
  if (refused && Date.now() - refused.at < FAILED_KEPT_MS) throw refused.error;
  /* a browser that could not start (not downloaded yet on a first run) is tried again next time, not kept */
  browser ??= launch().catch((e) => { browser = null; throw e; });
  const origin = new URL(url).origin;
  /* a page is 1920 wide (or its clip's size) unless it says otherwise; the device scale makes the capture `w` px
     without a resize */
  /* on black, as the film shows a page with nothing below it (white, the browser's default, hid a white title) */
  const opening = (async () => FilmPage.open(await /** @type {Promise<import('playwright-core').Browser>} */ (browser), origin, url, { scale: w / (size?.w ?? 1920), ...(size ? { size } : {}), black: true, waitMs: 15_000, readyMs: FRAME_MS }))();
  open.set(key, opening);
  opening.catch((e) => {
    open.delete(key);
    unopened.set(key, { error: e, at: Date.now() });
    if (unopened.size > 100) unopened.delete(unopened.keys().next().value ?? '');
  });
  while (open.size > KEEP_PAGES) {
    const [oldest, page] = open.entries().next().value ?? [];
    if (!oldest) break;
    open.delete(oldest);
    void page?.then((p) => p.close(), () => {});
  }
  return opening;
}
