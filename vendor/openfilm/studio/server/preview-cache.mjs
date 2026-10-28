// @ts-check
/**
 * Preview renders: stretches of a film the preview cannot draw as fast as it plays (a page heavy with 3D, many videos
 * at once), rendered in the background into a video the preview plays in their place while the film plays. The editor
 * says which stretches played late (the frames the screen got late, see bridge.js `played`); each one is rendered by
 * the film's own renderer (src/render.mjs, in a process of its own at low priority, one page), at the preview's size
 * and the film's frame rate, its picture only, into the project's cache. Paused, scrubbed or edited, the preview draws
 * the film itself; exports always do.
 *
 * A render is named by everything its picture depends on: film.html, every file of the project but its sounds, the
 * stretch, the rate and the size. Any change makes another name, so a stale render is never played; renders asked for
 * under names no longer current are let go.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { setPriority } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STAGE, FILM_FILE, readFilmFile } from '../../src/film-doc.mjs';
import { writeAtomic } from './atomic.mjs';
import { TOOL_DIR } from './projects.mjs';

/** Changing how renders are made names them anew. */
const VERSION = 1;
/** Files whose change cannot change the picture. */
const SOUNDS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.aif', '.aiff', '.aifc', '.vtt', '.srt']);
/** Most files of a project read for its fingerprint (a folder of thousands of frames is taken as a whole beyond that). */
const MOST_FILES = 20_000;

/** Where a project's preview renders are kept. @param {string} root */
export const previewDir = (root) => join(root, TOOL_DIR, 'cache', 'preview');

/** A render's name is 20 hex digits: anything else asked for is not one. @param {string} key */
export const isPreviewKey = (key) => /^[0-9a-f]{20}$/.test(key);

/**
 * What the project's files are now, as far as a picture can tell: every file but its sounds and film.html, by path,
 * size and time changed (dot folders, the tools' own, left out).
 * @param {string} root
 */
export function projectPrint(root) {
  const hash = createHash('sha1');
  let seen = 0;
  /** @param {string} dir @param {string} rel */
  const walk = (dir, rel) => {
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      if (d.name.startsWith('.') || seen > MOST_FILES) continue;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { walk(join(dir, d.name), path); continue; }
      if (path === FILM_FILE || SOUNDS.has(extname(d.name).toLowerCase())) continue;
      seen += 1;
      try { const s = statSync(join(dir, d.name)); hash.update(`${path}\0${s.size}\0${Math.round(s.mtimeMs)}\n`); } catch { /* gone meanwhile */ }
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

/**
 * The name of a render of film seconds [a, b) at `fps` and `height` (its short side), for the project as it is now.
 * @param {string} root @param {number} a @param {number} b @param {number} fps @param {number} height @param {string} [print]
 */
export function previewKey(root, a, b, fps, height, print = projectPrint(root)) {
  let film = '';
  try { film = readFileSync(join(root, FILM_FILE), 'utf8'); } catch { /* none: nothing renders */ }
  return createHash('sha1').update(`${VERSION}\0${film}\0${print}\0${a}\0${b}\0${fps}\0${height}`).digest('hex').slice(0, 20);
}

/**
 * The stretches of the project known to play late, as the editor last said them (film seconds [a, b)), kept with its
 * renders so another session of the editor plays them from their renders at once, not late first.
 * @param {string} root @returns {[number, number][]}
 */
export function knownLate(root) {
  try {
    const { ranges } = JSON.parse(readFileSync(join(previewDir(root), LATE_FILE), 'utf8'));
    return Array.isArray(ranges) ? ranges.filter((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[1] > r[0]) : [];
  } catch { return []; }
}
const LATE_FILE = 'late.json';

/** @typedef {{ state: 'waiting' | 'making' | 'ready' | 'failed', ratio?: number }} PreviewState */
/** @typedef {PreviewState & { a: number, b: number, key: string }} PreviewRange */

/**
 * The render asked for, by its file, and what became of it.
 * @type {Map<string, PreviewState & { root: string, a: number, b: number, fps: number, height: number, abort?: AbortController }>}
 */
const jobs = new Map();
let running = false;

/**
 * Renders of `ranges` (film seconds, each put on the film's frame grid) for the project at `root`, at `fps` and
 * `height`: each one's name and state, a render asked for when there is none yet. Renders of this project asked for
 * earlier under other names (the film changed since) are let go.
 * @param {string} root @param {[number, number][]} ranges @param {number} fps @param {number} height
 * @param {(root: string, a: number, b: number, fps: number, height: number, out: string, signal: AbortSignal, progress: (ratio: number) => void) => Promise<void>} [make]
 * @returns {PreviewRange[]}
 */
export function ensurePreviews(root, ranges, fps, height, make = renderApart) {
  const print = projectPrint(root);
  const dir = previewDir(root);
  /* what is known to play late, for the next session (not kept: found again as it plays) */
  if (JSON.stringify(knownLate(root)) !== JSON.stringify(ranges)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* writeAtomic says so */ }
    void writeAtomic(join(dir, LATE_FILE), `${JSON.stringify({ ranges })}\n`).catch(() => {});
  }
  /** @type {PreviewRange[]} */
  const states = [];
  const current = new Set();
  for (const [from, to] of ranges) {
    const a = Math.floor(from * fps + 1e-6) / fps;
    const b = Math.ceil(to * fps - 1e-6) / fps;
    if (!(b > a)) continue;
    const key = previewKey(root, a, b, fps, height, print);
    const out = join(dir, `${key}.mp4`);
    current.add(out);
    if (existsSync(out)) { states.push({ a, b, key, state: 'ready' }); continue; }
    let job = jobs.get(out);
    if (!job) {
      job = { root, a, b, fps, height, state: 'waiting' };
      jobs.set(out, job);
    }
    states.push({ a, b, key, state: job.state, ...(job.state === 'making' ? { ratio: job.ratio ?? 0 } : {}) });
  }
  /* the film changed: what was asked of it before is no longer wanted */
  for (const [out, job] of jobs) {
    if (job.root !== root || current.has(out)) continue;
    job.abort?.abort();
    jobs.delete(out);
  }
  void drain(make);
  return states;
}

/** Make the renders waiting, one at a time. @param {Parameters<typeof ensurePreviews>[4] & {}} make */
async function drain(make) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = [...jobs.entries()].find(([, job]) => job.state === 'waiting');
      if (!next) return;
      const [out, job] = next;
      job.state = 'making';
      job.ratio = 0;
      job.abort = new AbortController();
      mkdirSync(previewDir(job.root), { recursive: true });
      const part = `${out}.part.mp4`;
      try {
        await make(job.root, job.a, job.b, job.fps, job.height, part, job.abort.signal, (ratio) => { job.ratio = ratio; });
        if (job.abort.signal.aborted) throw new Error('cancelled');
        renameSync(part, out);
        jobs.delete(out);
      } catch {
        rmSync(part, { force: true });
        /* let go (the film changed): forgotten; failed: said, and not tried again under this name */
        if (jobs.get(out) === job) job.state = 'failed';
      }
    }
  } finally { running = false; }
}

/** A number as render's range takes it: plain digits, no exponent. @param {number} n */
const num = (n) => String(Number(n.toFixed(3)));

/**
 * One stretch rendered by src/render.mjs in a process of its own (render-worker.mjs), at low priority so the editor
 * and the person's other apps come first, with one page; its picture only.
 * @type {Parameters<typeof ensurePreviews>[4] & {}}
 */
function renderApart(root, a, b, fps, height, out, signal, progress) {
  return new Promise((done, fail) => {
    if (signal.aborted) { fail(new Error('cancelled')); return; }
    const child = fork(fileURLToPath(new URL('./render-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    try { if (child.pid) setPriority(child.pid, 10); } catch { /* left as it is */ }
    const cancel = () => {
      if (child.connected) child.send({ type: 'cancel' });
      setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }, 5000).unref();
    };
    signal.addEventListener('abort', cancel, { once: true });
    let settled = false;
    /** @param {() => void} end */
    const settle = (end) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); end(); };
    child.on('message', (/** @type {any} */ m) => {
      if (m?.type === 'progress') progress(m.total > 0 ? Math.min(0.99, m.done / m.total) : 0);
      else if (m?.type === 'done') settle(() => done(undefined));
      else if (m?.type === 'failed') settle(() => fail(new Error(m.error)));
    });
    child.on('error', (e) => settle(() => fail(e)));
    child.on('exit', (code) => settle(() => fail(new Error(`the renderer stopped (exit ${code})`))));
    const stage = filmStage(root);
    const scale = height / Math.max(1, Math.min(stage.w, stage.h));
    child.send({ args: [root, `${num(a)}-${num(b)}`], opts: { fps, scale: Math.min(1, scale), workers: 1, silent: true, out } });
  });
}

/** The film's stage, as film.html says it. @param {string} root */
function filmStage(root) {
  try { return readFilmFile(readFileSync(join(root, FILM_FILE), 'utf8')).doc?.stage ?? DEFAULT_STAGE; } catch { return DEFAULT_STAGE; }
}
