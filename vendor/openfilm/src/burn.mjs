/* The film with its subtitles burned in: a page drawn around the film, the subtitles over it (Studio's export and
   render --subtitles). */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_FILE, readFilmFile } from './film-doc.mjs';
import { open } from './shared.mjs';
import { filmSubtitleShown } from '../studio/server/film-subtitle.mjs';

const tidy = (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
export const even = (/** @type {number} */ n) => Math.max(2, Math.round(n / 2) * 2);

/** A frame written `W:H` ("16:9", "2.39:1"), from 1:4 to 4:1: its width ÷ height, or null. @param {unknown} frame */
export function frameRatio(frame) {
  const m = typeof frame === 'string' ? /^(\d{1,4}(?:\.\d{1,3})?):(\d{1,4}(?:\.\d{1,3})?)$/.exec(frame) : null;
  if (!m) return null;
  const ratio = Number(m[1]) / Number(m[2]);
  return Number.isFinite(ratio) && ratio >= 1 / 4 && ratio <= 4 ? ratio : null;
}

/**
 * The film (`stage`) fitted into a delivery frame: the frame's size (its long side follows the film's), its exact
 * shape (`ratio`: the frame's own, not its even-rounded pixels'), and the film's scale inside it (`contain`: whole,
 * with bars; `cover`: filling it, the overflow cut).
 * @param {{ w: number, h: number, ratio?: number }} stage @param {string} frame @param {'contain' | 'cover'} fill
 */
export function frameBox(stage, frame, fill) {
  const ratio = frame === 'native' ? null : frameRatio(frame);
  /* native: the stage's own shape (a frame drawn as a page, with subtitles over it, keeps the frame's exact one) */
  if (ratio == null) return { w: even(stage.w), h: even(stage.h), ratio: stage.ratio ?? stage.w / Math.max(1, stage.h), scale: 1 };
  const box = stage.w / ratio >= stage.h ? { w: stage.w, h: stage.w / ratio } : { w: stage.h * ratio, h: stage.h };
  const w = even(box.w), h = even(box.h);
  return { w, h, ratio, scale: fill === 'cover' ? Math.max(w / stage.w, h / stage.h) : Math.min(w / stage.w, h / stage.h) };
}

/**
 * The film inside its delivery frame with its subtitles drawn over it: a web page (SPEC.md: `window.film`) in the
 * project's .film showing the film (film.html's timeline, or the project's page) fitted into the frame, with bars or
 * cropped as asked, and over the whole frame each moment's subtitle line as the editor draws it (film-subtitle.mjs
 * `filmSubtitleFrameHtml`). It is rendered like the film itself, and its sound is the film's. `box` is the frame in the
 * film's pixels; `remove()` when done.
 * @param {string} root @param {{ w: number, h: number }} stage @param {string} frame @param {'contain' | 'cover'} fill
 * @param {Cue[]} cues @param {SubtitleStyle} style @param {boolean} [transparent] nothing behind the film (an alpha export)
 */
export async function burnFilm(root, stage, frame, fill, cues, style, transparent = false) {
  const box = frameBox(stage, frame, fill);
  const dir = join(root, '.film', 'cache', 'export', `burn-${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  try {
    await copyFile(fileURLToPath(new URL('../studio/server/film-subtitle.mjs', import.meta.url)), join(dir, 'film-subtitle.mjs'));
  const entry = existsSync(join(root, FILM_FILE)) ? `/${FILM_FILE}` : '/index.html';
  const x = (box.w - stage.w * box.scale) / 2, y = (box.h - stage.h * box.scale) / 2;
  const json = (/** @type {unknown} */ v) => JSON.stringify(v).replace(/</g, '\\u003c');
  await writeFile(join(dir, 'index.html'), `<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${box.w}px;height:${box.h}px;overflow:hidden;background:${transparent ? 'transparent' : '#000'}}
#film{position:absolute;left:${x}px;top:${y}px;width:${stage.w}px;height:${stage.h}px;border:0;transform:scale(${box.scale});transform-origin:0 0}
#subs{position:absolute;left:0;top:0;width:${box.w}px;height:${box.h}px}
</style></head><body><div id="subs"></div><script type="module">
import { filmSubtitleFrameHtml } from './film-subtitle.mjs';
const cues = ${json(cues)};
const style = ${json({ ...style, on: true })};
const size = { w: ${box.w}, h: ${box.h} };
const subs = document.getElementById('subs');
const el = document.createElement('iframe');
el.id = 'film';
let inner = null;
const loaded = new Promise((ok) => el.addEventListener('load', ok, { once: true }));
el.src = ${json(entry)};
document.body.prepend(el);
const ready = loaded.then(async () => {
  const win = el.contentWindow;
  const t0 = performance.now();
  while (!(win.film && typeof win.film.frame === 'function')) {
    if (performance.now() - t0 > 10000) throw new Error('the film did not set window.film');
    await new Promise((r) => setTimeout(r, 20));
  }
  await (typeof win.film.ready === 'function' ? win.film.ready() : win.film.ready);
  ${transparent ? "const clear = win.document.createElement('style'); clear.textContent = 'html, body { background: transparent !important; }'; win.document.head.append(clear);" : ''}
  inner = win;
});
window.film = {
  get duration() { return inner ? inner.film.duration : 0.001; },
  width: size.w, height: size.h,
  ready,
  async frame(t) {
    inner.filmHost?.time?.(t);
    await inner.film.frame(t);
    inner.filmHost?.settle?.(t);
    subs.innerHTML = filmSubtitleFrameHtml(cues, style, size, t * 1000);
    await document.fonts?.ready;
  },
};
window.__filmCuts = () => inner?.__filmCuts?.() ?? null;
window.__filmSounds = () => inner?.__filmSounds?.() ?? [];
</script></body></html>
`);
  } catch (e) {
    await tidy(dir);
    throw e;
  }
  return { dir, box, remove: () => tidy(dir) };
}

/** The film's stage, from film.html (or, for a single page, from the page). @param {string} root */
export async function stageOf(root) {
  const file = join(root, FILM_FILE);
  if (existsSync(file)) {
    const { doc } = readFilmFile(readFileSync(file, 'utf8'));
    if (doc) return doc.stage;
  }
  const probe = await open(root);
  try { return { w: probe.film.meta.width, h: probe.film.meta.height }; } finally { await probe.close(); }
}

/**
 * The film with its subtitles burned in, when the ask wants them and the film has some (else null): what to render
 * instead of the project (see burnFilm). `captions(root)`: the film's cues and the person's style (captions.mjs).
 * @param {string} root @param {{ burnSubtitles?: boolean, frame?: string, fill?: 'contain' | 'cover' }} ask
 * @param {(root: string) => Promise<{ cues: Cue[], style: SubtitleStyle }>} captions @param {boolean} [transparent]
 */
export async function burned(root, ask, captions, transparent = false) {
  if (!ask.burnSubtitles) return null;
  /* the cues as stored: the page picks the shown language itself (filmSubtitleFrameHtml), and picking it twice
     puts a bilingual line's translation under it twice */
  const { cues, style } = await captions(root);
  if (!filmSubtitleShown(cues, style).some((c) => c.durMs > 0 && c.text.trim())) return null;
  return burnFilm(root, await stageOf(root), ask.frame ?? 'native', ask.fill ?? 'contain', cues, style, transparent);
}
