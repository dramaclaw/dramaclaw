// Videos a render's browser plays well. A render seeks each video to every frame, and a browser decodes from the key
// frame before the one asked: footage from cameras, phones and stock sites has one every 1 to 4 s, so each frame costs
// the decoding of up to a few hundred. And some footage the browser does not decode at all: ProRes in any browser,
// HEVC on a machine without a chip for it. Before rendering, such a video gets a copy the browser plays, with a key
// frame every quarter second, all but lossless (with its alpha, when it has one), made once and kept in the project's
// cache; the render's pages are served the copy, and the sound is still mixed from the original.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { colorTagsOf, encoders, h264ColorTags, hardwareEncoder, hardwareOptions, onTheChip } from './encoders.mjs';
import { kindOf, readFilmFile, srcHref } from './film-doc.mjs';
import { ffmpeg, fileOf, hash, outDir } from './shared.mjs';

/** A key frame further apart than this is slow to seek to frame by frame. */
const SLOW_GOP_S = 0.5;
/** The copy's key frames: four a second. */
const COPY_GOP_S = 0.25;
/** A longer video is left as it is: copying it all could take longer than the render it would speed up. */
const MAX_SECONDS = 10 * 60;
/** Bigger than this is left as it is (H.264 stops at 4096 on a side in most decoders). */
const MAX_SIDE = 4096;
/** Changing how copies are made makes new ones. */
const VERSION = 2;

/** @param {string} file @returns {Promise<string>} */
const probe = (file, args) => new Promise((done, fail) => {
  execFile('ffprobe', ['-v', 'error', ...args, file], { maxBuffer: 16 << 20, windowsHide: true }, (error, stdout) => (error ? fail(error) : done(String(stdout))));
});

/**
 * What a copy of `file` would be made from: its first video stream, when it is one worth copying (8-bit 4:2:0, no
 * alpha, not too big or long, key frames far apart). Null when it is better left alone.
 * @param {string} file
 */
export async function slowSeeking(file) {
  let info;
  try {
    info = JSON.parse(await probe(file, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt,avg_frame_rate:format=duration', '-of', 'json']));
  } catch { return null; }
  const stream = info.streams?.[0];
  const seconds = Number(info.format?.duration);
  if (!stream || !['yuv420p', 'yuvj420p'].includes(stream.pix_fmt)) return null;
  if (!(seconds > 0) || seconds > MAX_SECONDS || stream.width > MAX_SIDE || stream.height > MAX_SIDE) return null;
  const [n, d] = String(stream.avg_frame_rate).split('/').map(Number);
  const fps = n > 0 && d > 0 ? n / d : 30;
  /* the key frames among the packets of its first 20 s (read, not decoded) */
  let keys = 0, span = 0;
  try {
    const lines = (await probe(file, ['-select_streams', 'v:0', '-read_intervals', '%+20', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0'])).trim().split('\n');
    let first = null, last = null;
    for (const line of lines) {
      const [pts, flags] = line.split(',');
      const t = Number(pts);
      if (!Number.isFinite(t)) continue;
      first ??= t;
      last = t;
      if (flags?.startsWith('K')) keys++;
    }
    span = first == null || last == null ? 0 : last - first;
  } catch { return null; }
  if (keys === 0 || span <= 0) return null;
  return span / keys > SLOW_GOP_S ? { fps, seconds, w: Number(stream.width), h: Number(stream.height) } : null;
}

/** Every Chromium decodes these by itself, with its own decoders, on any machine: no need to ask it. */
const decodedAnywhere = (/** @type {{ codec_name?: string, pix_fmt?: string }} */ s) =>
  (s.codec_name === 'h264' && ['yuv420p', 'yuvj420p'].includes(String(s.pix_fmt))) || ['vp8', 'vp9', 'av1'].includes(String(s.codec_name));

/**
 * What a render needs of a video: a copy because its browser does not decode it here (`unplayable`: ProRes in any
 * browser, HEVC without a chip for it, 10-bit H.264…, asked of the browser itself with `plays`; `alpha` when its
 * picture has one to keep), or because it seeks slowly (`slow`, slowSeeking, only when `slow` is asked for); null for
 * neither.
 * @param {string} file @param {{ plays?: (file: string) => Promise<boolean>, slow?: boolean }} [options]
 * @returns {Promise<{ why: 'unplayable' | 'slow', fps: number, w: number, h: number, alpha: boolean } | null>}
 */
export async function copyNeed(file, { plays, slow = true } = {}) {
  let info;
  try {
    info = JSON.parse(await probe(file, ['-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,pix_fmt,avg_frame_rate:stream_tags=alpha_mode', '-of', 'json']));
  } catch { return null; }
  const stream = info.streams?.[0];
  if (!stream || stream.width > MAX_SIDE || stream.height > MAX_SIDE) return null;
  if (plays && !decodedAnywhere(stream) && !(await plays(file))) {
    const [n, d] = String(stream.avg_frame_rate).split('/').map(Number);
    const alpha = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(String(stream.pix_fmt)) || stream.tags?.alpha_mode === '1';
    return { why: 'unplayable', fps: n > 0 && d > 0 ? n / d : 30, w: Number(stream.width), h: Number(stream.height), alpha };
  }
  const slowly = slow ? await slowSeeking(file) : null;
  return slowly ? { why: 'slow', fps: slowly.fps, w: slowly.w, h: slowly.h, alpha: false } : null;
}

/** Where `file`'s copy is kept in `root`'s cache, by the file's version: the path without its extension. */
const copyBase = (/** @type {string} */ file, /** @type {string} */ root, /** @type {import('node:fs').Stats} */ stat) =>
  join(root, '.film', 'cache', 'seek', hash(Buffer.from(`${VERSION}\0${file}\0${stat.size}\0${stat.mtimeMs}`)));

/** @type {Map<string, { copy: string | null, at: number }>} what madeCopy found, by file and version */
const found = new Map();
/**
 * The copy of `file` already made in `root`'s cache (seekableCopies), or null; nothing is made. Asked on every request
 * a playing video makes, so a copy found is remembered, and one not found is looked for again a moment later.
 * @param {string} file @param {string} root
 */
export function madeCopy(file, root) {
  let stat;
  try { stat = statSync(file); } catch { return null; }
  const key = `${root}\0${file}\0${stat.size}\0${stat.mtimeMs}`;
  const hit = found.get(key);
  if (hit && (hit.copy ? existsSync(hit.copy) : Date.now() - hit.at < 2000)) return hit.copy;
  const base = copyBase(file, root, stat);
  const copy = [`${base}.mp4`, `${base}.webm`].find((f) => existsSync(f)) ?? null;
  found.set(key, { copy, at: Date.now() });
  return copy;
}

/**
 * The files of a film's video clips: film.html at `film` (a path in `root`, as a URL says it), as a render, a look or
 * a still of it plays them.
 * @param {string} root @param {string} film
 */
export function filmVideos(root, film) {
  let doc;
  try { doc = readFilmFile(readFileSync(join(root, decodeURI(film)), 'utf8')).doc; } catch { return []; }
  const files = new Set();
  for (const track of doc?.tracks ?? []) {
    for (const clip of track.clips) {
      if (kindOf(clip) !== 'video') continue;
      try { files.add(fileOf(root, film, srcHref(clip.src))); } catch { /* a source out of the folder: not served either */ }
    }
  }
  return [...files];
}

/**
 * In a page: whether the browser shows the first frame of the video at `url`. One it does not decode (ProRes; HEVC
 * without a chip for it) fails at once, or never shows a frame.
 * @param {string} url
 */
const firstFrame = (url) => new Promise((done) => {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  const end = (/** @type {boolean} */ shown) => { clearTimeout(timer); video.removeAttribute('src'); video.load(); done(shown); };
  const timer = setTimeout(() => end(false), 10_000);
  video.addEventListener('loadeddata', () => end(true), { once: true });
  video.addEventListener('error', () => end(false), { once: true });
  video.src = url;
});

/**
 * The copies `browser` needs of `files` to show them (seekableCopies, kept in `root`'s cache), each file asked of the
 * browser itself through a page that loads it from the site at `origin`, which serves `root`. `slow`: slow-seeking
 * ones too. A map from a file to its copy; it never fails: a video that can't be copied stays as it is.
 * @param {import('playwright-core').Browser} browser @param {string} origin @param {string} root @param {string[]} files
 * @param {{ signal?: AbortSignal, slow?: boolean }} [options]
 */
export async function browserCopies(browser, origin, root, files, { signal, slow = false } = {}) {
  if (!files.length) return new Map();
  /** @type {Promise<import('playwright-core').Page> | null} */
  let tester = null;
  const plays = async (/** @type {string} */ file) => {
    tester ??= browser.newPage();
    const url = `${origin.replace(/\/$/, '')}/${relative(root, file).split(sep).map(encodeURIComponent).join('/')}`;
    return (await tester).evaluate(firstFrame, url).catch(() => false);
  };
  try {
    return await seekableCopies(files, root, { signal, plays, slow });
  } catch {
    return new Map();
  } finally {
    if (tester) await (await tester).close().catch(() => {});
  }
}

/**
 * The copy of each of `files` that needs one (copyNeed), made in `root`'s cache (or found there from before): a map
 * from a file to its copy. A file that is fine as it is, or whose copy fails, is not in it. `plays`: whether the
 * render's browser decodes a file; `slow`: whether slow-seeking ones get a copy too (a render of more than a moment).
 * @param {string[]} files @param {string} root
 * @param {{ signal?: AbortSignal, plays?: (file: string) => Promise<boolean>, slow?: boolean }} [options]
 */
export async function seekableCopies(files, root, { signal, plays, slow = true } = {}) {
  const copies = new Map();
  outDir(root, 'seek');
  /* two at a time: on the processor each one keeps several cores busy; on the graphics chip it leaves them free */
  const queue = [...new Set(files)];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (signal?.aborted) return;
      let stat;
      try { stat = statSync(file); } catch { continue; }
      const base = copyBase(file, root, stat);
      /* madeCopy finds it from now on, without waiting out a miss it remembers */
      const known = (/** @type {string} */ copy) => { copies.set(file, copy); found.set(`${root}\0${file}\0${stat.size}\0${stat.mtimeMs}`, { copy, at: Date.now() }); };
      const made = [`${base}.mp4`, `${base}.webm`].find((f) => existsSync(f));
      if (made) { known(made); continue; }
      const need = await copyNeed(file, { plays, slow });
      if (!need) continue;
      /* with an alpha to keep: VP9, which every Chromium decodes with its alpha; else H.264 */
      const out = `${base}${need.alpha ? '.webm' : '.mp4'}`;
      const gop = Math.max(1, Math.round(need.fps * COPY_GOP_S));
      const part = `${out}.part${extname(out)}`;
      /* all but lossless: about 19 Mbps at 1080p and 30 fps; the chip's encoder keeps the source's color tags only
         when told them */
      const bits = Math.min(120e6, Math.max(4e6, ((need.w * need.h) || 1920 * 1080) * need.fps * 0.3));
      /* decoded and written on the graphics chip when it can (encoders.mjs), else on the processor */
      const make = async (/** @type {string | null} */ encoder, /** @type {string[]} */ decoding) => {
        /* the same frames at the same times (passthrough: no frame is added or dropped), the picture only */
        const run = ffmpeg([...decoding, '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough',
          ...(need.alpha ? ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '18', '-row-mt', '1', '-deadline', 'realtime', '-cpu-used', '8',
            '-g', String(gop), '-keyint_min', String(gop), '-auto-alt-ref', '0']
            : encoder ? ['-pix_fmt', 'nv12', ...hardwareOptions(encoder, bits, { gop }), ...h264ColorTags(await colorTagsOf(file))]
              : ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '16', '-g', String(gop), '-keyint_min', String(gop), '-pix_fmt', 'yuv420p']), part]);
        const stop = () => run.proc.kill('SIGKILL');
        signal?.addEventListener('abort', stop, { once: true });
        try { await run.done; } finally { signal?.removeEventListener('abort', stop); }
      };
      try {
        await onTheChip(need.alpha ? null : await hardwareEncoder('h264', await encoders()), make, signal);
        renameSync(part, out);
        known(out);
      } catch {
        rmSync(part, { force: true });
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return copies;
}
