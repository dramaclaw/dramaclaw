// @ts-check
/**
 * Proxies: light copies of heavy footage for the preview to play. Footage
 * past 1080p, or in a form slow to decode (ProRes, HEVC, 10-bit…), from a NAS most of all, stutters when played and
 * scrubbed; its proxy is an H.264 copy `height` px on its short side, its picture only, with the same frames at the
 * same times (passthrough: none added or dropped) and a key frame every half second, so a scrub lands at once. Made in
 * the background, one at a time, kept in the project's cache: decoded and written on the graphics chip when it can
 * (src/encoders.mjs), so the processor stays free; by x264 otherwise.
 *
 * Footage the editor's browser does not decode at all (HEVC on a computer without a chip for it, ProRes…) shows
 * nothing until its proxy is made: the editor says which (it asks its browser, playType), and theirs are made first,
 * whether proxies are on or not; off, only the proxies that are lighter footage are left out.
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
import { decodedAnywhere } from '../../src/seekable.mjs';
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

/* the codec strings (RFC 6381) of what a browser may decode, by the profile names ffprobe gives: H.264's profile_idc,
   HEVC's profile and compatibility flag, ProRes's four-letter code */
const AVC_PROFILES = /** @type {Record<string, number>} */ ({ Baseline: 66, 'Constrained Baseline': 66, Main: 77, Extended: 88, High: 100, 'High 10': 110, 'High 10 Intra': 110, 'High 4:2:2': 122, 'High 4:2:2 Intra': 122, 'High 4:4:4 Predictive': 244, 'High 4:4:4 Intra': 244, 'CAVLC 4:4:4': 44 });
const HEVC_PROFILES = /** @type {Record<string, string>} */ ({ Main: '1.6', 'Main 10': '2.4', 'Main Still Picture': '3.8', Rext: '4.10' });
const PRORES = /** @type {Record<string, string>} */ ({ Proxy: 'apco', LT: 'apcs', Standard: 'apcn', HQ: 'apch', 4444: 'ap4h', XQ: 'ap4x' });

/**
 * What the editor's browser is asked (canPlayType) to tell whether it decodes footage: its type with its picture's
 * codec string. Null for footage every browser decodes (seekable.mjs decodedAnywhere); '' for a codec none does
 * (MPEG-2, DNxHD…), which no browser says it plays.
 * @param {{ codec?: string, pixfmt?: string, profile?: string, level?: number }} facts
 */
export function playType(facts) {
  if (!facts.codec || decodedAnywhere({ codec_name: facts.codec, pix_fmt: facts.pixfmt })) return null;
  const hex = (/** @type {number} */ n) => n.toString(16).padStart(2, '0').toUpperCase();
  const level = Number(facts.level) > 0 ? Number(facts.level) : 0;
  if (facts.codec === 'hevc') return `video/mp4; codecs="hvc1.${HEVC_PROFILES[String(facts.profile)] ?? '1.6'}.L${level || 93}.B0"`;
  if (facts.codec === 'h264') return `video/mp4; codecs="avc1.${hex(AVC_PROFILES[String(facts.profile)] ?? 100)}00${hex(level || 40)}"`;
  if (facts.codec === 'prores') return `video/quicktime; codecs="${PRORES[String(facts.profile)] ?? 'apcn'}"`;
  return '';
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

/**
 * `needed`: the editor's browser does not decode the footage, which shows nothing without it. `reason`: why it failed.
 * @typedef {{ state: 'waiting' | 'making' | 'ready' | 'failed', ratio?: number, needed?: true, reason?: string }} ProxyState
 */

/** Proxies asked for and not made yet, and what became of each (by its file). @type {Map<string, ProxyState & { make?: (signal: AbortSignal) => Promise<void>, stop?: AbortController }>} */
const jobs = new Map();
let running = false;
/** The footage the editor's browser does not decode (by its file): played from its proxy whether proxies are on or not. */
const undecoded = new Set();
/** Whether the proxies that only lighten footage are made: proxies are on. */
let lighten = true;

/** The proxy to make next: one needed first, then (proxies on) any. */
function nextJob() {
  const waiting = [...jobs.entries()].filter(([, job]) => job.state === 'waiting');
  return waiting.find(([, job]) => job.needed) ?? (lighten ? waiting[0] : undefined);
}

/** Why a proxy failed, in a line: ffmpeg's last words but its closing "Conversion failed!". */
function reasonOf(/** @type {unknown} */ error) {
  const lines = String(/** @type {{ message?: unknown }} */ (error)?.message ?? error).split('\n').map((l) => l.trim()).filter((l) => l && !/^conversion failed!?$/i.test(l));
  return (lines.at(-1) ?? 'ffmpeg failed').slice(0, 300);
}

/** Make the proxies waiting, one at a time. One stopped (stopLightening) waits its turn again. */
async function drain() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = nextJob();
      if (!next) return;
      const [out, job] = next;
      job.state = 'making';
      job.ratio = 0;
      const stop = new AbortController();
      job.stop = stop;
      try { await job.make?.(stop.signal); job.state = 'ready'; } catch (e) {
        if (stop.signal.aborted) { job.state = 'waiting'; delete job.ratio; delete job.stop; continue; }
        job.state = 'failed';
        job.reason = reasonOf(e);
      }
      delete job.make;
      delete job.stop;
      if (job.state === 'ready') jobs.delete(out);
    }
  } finally { running = false; }
}

/** A proxy that only lightens footage, being made while a needed one waits (or proxies are off), is stopped: it is made
    again later. */
function stopLightening() {
  const making = [...jobs.values()].find((job) => job.state === 'making');
  if (making && !making.needed && (!lighten || [...jobs.values()].some((job) => job.needed && job.state === 'waiting'))) making.stop?.abort();
}

/** Whether the editor's browser does not decode the project's video `rel` (said to ensureProxies). */
export function undecodable(/** @type {string} */ root, /** @type {string} */ rel) {
  try { return undecoded.has(readable(root, rel)); } catch { return false; }
}

/**
 * What the editor asks its browser of the project's videos `rels` that not every browser decodes (playType): each
 * one's type, picture size and frame rate.
 * @param {string} root @param {string[]} rels
 * @returns {Promise<Record<string, { type: string, width: number, height: number, fps: number }>>}
 */
export async function playChecks(root, rels) {
  /** @type {Record<string, { type: string, width: number, height: number, fps: number }>} */
  const checks = {};
  for (const rel of rels) {
    if (clipKind(rel) !== 'video') continue;
    let facts;
    try { facts = await probe(root, rel); } catch { continue; }
    const type = playType(facts);
    if (type != null) checks[rel] = { type, width: Number(facts.width) || 0, height: Number(facts.height) || 0, fps: Number(facts.fps) > 0 ? Number(facts.fps) : 30 };
  }
  return checks;
}

/**
 * What the preview needs for the project's videos `rels` at `height`: a proxy made for each heavy one while proxies are
 * `on`, and for each the editor's browser does not decode (`undecoded`, remembered for the rest of this launch) on or
 * off, those first (asked for when not made yet). Returns the state of each; the others are left out.
 * @param {string} root @param {string[]} rels @param {number} height
 * @param {{ on?: boolean, undecoded?: string[] }} [options]
 * @returns {Promise<Record<string, ProxyState>>}
 */
export async function ensureProxies(root, rels, height, { on = true, undecoded: told = [] } = {}) {
  lighten = on;
  /** @type {Record<string, ProxyState>} */
  const states = {};
  for (const rel of rels) {
    if (clipKind(rel) !== 'video') continue;
    let facts;
    try { facts = await probe(root, rel); } catch { continue; }
    if (!(Number(facts.width) > 0 && Number(facts.height) > 0)) continue;
    let file;
    try { file = proxyFile(root, rel, height); } catch { continue; }
    const { abs, out } = file;
    if (told.includes(rel)) undecoded.add(abs);
    const needed = undecoded.has(abs);
    if (!needed && !(on && heavy(facts))) continue;
    const mark = needed ? { needed: /** @type {const} */ (true) } : {};
    if (existsSync(out)) { states[rel] = { state: 'ready', ...mark }; continue; }
    /* asked for once; one that failed (footage ffmpeg cannot read) is said, not tried again and again */
    let job = jobs.get(out);
    if (!job) {
      const size = proxySize(Number(facts.width), Number(facts.height), height);
      const fps = Number(facts.fps) > 0 ? Number(facts.fps) : 30;
      const seconds = Number(facts.duration) > 0 ? Number(facts.duration) : 0;
      /** @type {ProxyState & { make?: (signal: AbortSignal) => Promise<void> }} */
      const fresh = { state: 'waiting' };
      fresh.make = (signal) => proxy(abs, out, size, fps, seconds, (ratio) => { fresh.ratio = ratio; }, signal);
      jobs.set(out, fresh);
      job = fresh;
    }
    if (needed) job.needed = true;
    states[rel] = { state: job.state, ...mark, ...(job.state === 'making' ? { ratio: job.ratio ?? 0 } : {}), ...(job.reason ? { reason: job.reason } : {}) };
  }
  stopLightening();
  void drain();
  return states;
}

/**
 * Make one proxy, decoded and written on the graphics chip when it can, else (or when it fails) by x264. Stopped by
 * `signal`.
 * @param {string} abs @param {string} out @param {{ w: number, h: number }} size @param {number} fps @param {number} seconds
 * @param {(ratio: number) => void} progress @param {AbortSignal} signal
 */
async function proxy(abs, out, size, fps, seconds, progress, signal) {
  const chip = await hardwareEncoder('h264', await encoders());
  await onTheChip(chip, (encoder, decoding) => make(abs, out, size, fps, seconds, progress, encoder, decoding, signal), signal);
}

/**
 * Make one proxy: through a hidden name, renamed once whole. ffmpeg turns a turned video upright (as it is shown),
 * which is the size asked for. `encoder`: the graphics chip's (about x264's quality at crf 23), with the source's
 * color tags, which it keeps only when told them; null for x264. `decoding`: the input options that decode on the chip.
 * @param {string} abs @param {string} out @param {{ w: number, h: number }} size @param {number} fps @param {number} seconds
 * @param {(ratio: number) => void} progress @param {string | null} encoder @param {string[]} decoding
 * @param {AbortSignal} signal
 */
async function make(abs, out, size, fps, seconds, progress, encoder, decoding, signal) {
  mkdirSync(join(out, '..'), { recursive: true });
  const part = `${out}.part.mp4`;
  const gop = Math.max(1, Math.round(fps * GOP_S));
  const codec = encoder
    ? ['-pix_fmt', 'nv12', ...hardwareOptions(encoder, Math.max(2e6, size.w * size.h * fps * 0.1), { gop }), ...h264ColorTags(await colorTagsOf(abs))]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', String(gop), '-keyint_min', String(gop), '-pix_fmt', 'yuv420p'];
  return new Promise((done, fail) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...decoding, '-i', abs,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-vf', `scale=${size.w}:${size.h}`, ...codec,
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', part], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      const at = /out_time_us=(\d+)/.exec(String(d).split('\n').reverse().join('\n'));
      if (at && seconds > 0) progress(Math.min(0.99, Number(at[1]) / 1e6 / seconds));
    });
    /* the part is removed once ffmpeg has let go of it: a stopped one (its signal) is still writing it when the error
       comes, and Windows refuses to delete a file a process holds open */
    const drop = () => { try { rmSync(part, { force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the next run writes over it */ } };
    let stopped = /** @type {Error | null} */ (null);
    proc.on('error', (e) => {
      if (proc.pid === undefined) { drop(); fail(e); return; }
      stopped = e;
    });
    proc.on('close', (code) => {
      if (!stopped && code === 0 && existsSync(part)) { renameSync(part, out); done(undefined); return; }
      drop();
      fail(stopped ?? new Error(err.trim() || `ffmpeg exit ${code}`));
    });
  });
}
