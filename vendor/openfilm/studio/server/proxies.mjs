// @ts-check
/**
 * Proxies: light copies of heavy footage for the preview to play. Footage
 * past 1080p, or in a form slow to decode (ProRes, HEVC, 10-bit…), from a NAS most of all, stutters when played and
 * scrubbed; its proxy is an H.264 copy `height` px on its short side, its picture only, with the same frames at the
 * same times (passthrough: none added or dropped) and a key frame every half second, so a scrub lands at once. Made in
 * the background, one at a time, kept in the project's cache: decoded and written on the graphics chip when it can
 * (src/encoders.mjs), so the processor stays free; by x264 otherwise.
 *
 * Only the preview plays them (pages.mjs swaps a file for its proxy): the film's sound is mixed from the original, and
 * an export or a render reads the originals. Nothing in film.html changes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clipKind } from '../../src/film-doc.mjs';
import { colorTagsOf, encoders, h264ColorTags, hardwareEncoder, hardwareOptions, onTheChip } from '../../src/encoders.mjs';
import { probe } from './derived.mjs';
import { readable } from './files.mjs';
import { TOOL_DIR } from './projects.mjs';

/** Changing how proxies are made makes new ones. */
const VERSION = 1;
/** Decoded at full speed by every browser, 8-bit: light enough as it is, up to 1080p. */
const LIGHT_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const LIGHT_PIXFMTS = new Set(['yuv420p', 'yuvj420p']);
/** A key frame every half second. */
const GOP_S = 0.5;

/**
 * Whether footage is heavy to play: past 1080p (its long side over 1920 or its short over 1080), or not 8-bit H.264,
 * VP8/9 or AV1 4:2:0.
 * @param {{ width?: number, height?: number, codec?: string, pixfmt?: string }} facts
 */
export function heavy(facts) {
  const w = Number(facts.width), h = Number(facts.height);
  if (!(w > 0 && h > 0) || !facts.codec) return false;
  return Math.max(w, h) > 1920 || Math.min(w, h) > 1080 || !LIGHT_CODECS.has(facts.codec) || !LIGHT_PIXFMTS.has(String(facts.pixfmt));
}

/** The proxy's size: `height` px on the short side (never larger than the footage), even, the shape kept. */
export function proxySize(/** @type {number} */ w, /** @type {number} */ h, /** @type {number} */ height) {
  const k = Math.min(1, height / Math.min(w, h));
  const even = (/** @type {number} */ n) => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(w * k), h: even(h * k) };
}

/**
 * Where `rel`'s proxy at `height` is kept: named by the file itself (so it stays its proxy when the file is renamed or
 * moved) and its version (so a changed file gets a new one).
 */
function proxyFile(/** @type {string} */ root, /** @type {string} */ rel, /** @type {number} */ height) {
  const abs = readable(root, rel);
  const info = statSync(abs);
  const name = createHash('sha1').update(`${VERSION}\0${info.dev}:${info.ino}\0${info.size}\0${Math.round(info.mtimeMs)}\0${height}`).digest('hex').slice(0, 20);
  return { abs, out: join(root, TOOL_DIR, 'cache', 'proxies', `${name}.mp4`) };
}

/** The proxy of `rel` at `height`, when it is made; else null. */
export function readyProxy(/** @type {string} */ root, /** @type {string} */ rel, /** @type {number} */ height) {
  try { const { out } = proxyFile(root, rel, height); return existsSync(out) ? out : null; } catch { return null; }
}

/** @typedef {{ state: 'waiting' | 'making' | 'ready' | 'failed', ratio?: number }} ProxyState */

/** Proxies asked for and not made yet, and what became of each (by its file). @type {Map<string, ProxyState & { make?: () => Promise<void> }>} */
const jobs = new Map();
let running = false;

/** Make the proxies waiting, one at a time. */
async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = [...jobs.entries()].find(([, job]) => job.state === 'waiting');
      if (!next) return;
      const [out, job] = next;
      job.state = 'making';
      job.ratio = 0;
      try { await job.make?.(); job.state = 'ready'; } catch { job.state = 'failed'; }
      delete job.make;
      if (job.state === 'ready') jobs.delete(out);
    }
  } finally { running = false; }
}

/**
 * What the preview needs for the project's videos `rels` at `height`: a proxy made for each heavy one (asked for when
 * it is not made yet). Returns the state of each heavy one; light footage is left out.
 * @param {string} root @param {string[]} rels @param {number} height
 * @returns {Promise<Record<string, ProxyState>>}
 */
export async function ensureProxies(root, rels, height) {
  /** @type {Record<string, ProxyState>} */
  const states = {};
  for (const rel of rels) {
    if (clipKind(rel) !== 'video') continue;
    let facts;
    try { facts = await probe(root, rel); } catch { continue; }
    if (!heavy(facts)) continue;
    let file;
    try { file = proxyFile(root, rel, height); } catch { continue; }
    const { abs, out } = file;
    if (existsSync(out)) { states[rel] = { state: 'ready' }; continue; }
    /* asked for once; one that failed (footage ffmpeg cannot read) is said, not tried again and again */
    let job = jobs.get(out);
    if (!job) {
      const size = proxySize(Number(facts.width), Number(facts.height), height);
      const fps = Number(facts.fps) > 0 ? Number(facts.fps) : 30;
      const seconds = Number(facts.duration) > 0 ? Number(facts.duration) : 0;
      /** @type {ProxyState & { make?: () => Promise<void> }} */
      const fresh = { state: 'waiting' };
      fresh.make = () => proxy(abs, out, size, fps, seconds, (ratio) => { fresh.ratio = ratio; });
      jobs.set(out, fresh);
      job = fresh;
    }
    states[rel] = { state: job.state, ...(job.state === 'making' ? { ratio: job.ratio ?? 0 } : {}) };
  }
  void drain();
  return states;
}

/**
 * Make one proxy, decoded and written on the graphics chip when it can, else (or when it fails) by x264.
 * @param {string} abs @param {string} out @param {{ w: number, h: number }} size @param {number} fps @param {number} seconds
 * @param {(ratio: number) => void} progress
 */
async function proxy(abs, out, size, fps, seconds, progress) {
  const chip = await hardwareEncoder('h264', await encoders());
  await onTheChip(chip, (encoder, decoding) => make(abs, out, size, fps, seconds, progress, encoder, decoding));
}

/**
 * Make one proxy: through a hidden name, renamed once whole. ffmpeg turns a turned video upright (as it is shown),
 * which is the size asked for. `encoder`: the graphics chip's (about x264's quality at crf 23), with the source's
 * color tags, which it keeps only when told them; null for x264. `decoding`: the input options that decode on the chip.
 * @param {string} abs @param {string} out @param {{ w: number, h: number }} size @param {number} fps @param {number} seconds
 * @param {(ratio: number) => void} progress @param {string | null} encoder @param {string[]} decoding
 */
async function make(abs, out, size, fps, seconds, progress, encoder, decoding) {
  mkdirSync(join(out, '..'), { recursive: true });
  const part = `${out}.part.mp4`;
  const gop = Math.max(1, Math.round(fps * GOP_S));
  const codec = encoder
    ? ['-pix_fmt', 'nv12', ...hardwareOptions(encoder, Math.max(2e6, size.w * size.h * fps * 0.1), { gop }), ...h264ColorTags(await colorTagsOf(abs))]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', String(gop), '-keyint_min', String(gop), '-pix_fmt', 'yuv420p'];
  return new Promise((done, fail) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...decoding, '-i', abs,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-vf', `scale=${size.w}:${size.h}`, ...codec,
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      const at = /out_time_us=(\d+)/.exec(String(d).split('\n').reverse().join('\n'));
      if (at && seconds > 0) progress(Math.min(0.99, Number(at[1]) / 1e6 / seconds));
    });
    proc.on('error', (e) => { rmSync(part, { force: true }); fail(e); });
    proc.on('close', (code) => {
      if (code === 0 && existsSync(part)) { renameSync(part, out); done(undefined); return; }
      rmSync(part, { force: true });
      fail(new Error(err.trim() || `ffmpeg exit ${code}`));
    });
  });
}
