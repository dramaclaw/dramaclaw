// @ts-check
/**
 * A project's media and pages, as the media pane shows them and changes them. Imports are streamed to disk whatever
 * their size; files picked on this computer are copied (cloned, where the disk can: no time, no room) or linked, a
 * link in assets/ to where they are kept (a NAS, another disk: src/media-links.mjs).
 *
 * Paths in and out are relative to the project folder, with forward slashes. Nothing outside the folder, and nothing
 * in Studio's own `.film/`, can be written through here, by its name or through a link in the folder; outside it, only
 * what the person linked can be read.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FILM_FILE, clipKind } from '../../src/film-doc.mjs';
import { addLinkedPlaces, readableLink } from '../../src/media-links.mjs';
import { readProjectFilm, writeProjectFilm } from './film.mjs';
import { TOOL_DIR } from './projects.mjs';
import { moveToTrash } from './trash.mjs';
import { linkKind, rewriteLinks } from './page-links.mjs';
import { ffmpeg } from '../../src/shared.mjs';

export const ASSETS = 'assets';
/** Folders that hold tools and builds, not a film's pages. */
/* folders that hold no pages of the film (a dot folder is a tool's, and never looked in; skills/ holds the project's
   skills, src/skills.mjs) */
const SKIP = new Set(['node_modules', 'dist', 'build', 'lib', 'vendor', 'skills', ASSETS]);

export class FileError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * The absolute path of a project-relative one, refused when it leaves the folder or reaches into `.film/`: as written,
 * and as it is on disk (a folder in a downloaded project can be a link to anywhere). `read`: a link in assets/ to a
 * place the person linked is followed too (it is read, never written).
 * @param {string} root @param {string} rel @param {{ read?: boolean }} [how]
 */
export function inside(root, rel, how = {}) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new FileError('which file?');
  const clean = normalize(rel.split('/').join(sep));
  const abs = join(root, clean);
  const back = relative(root, abs);
  const parts = back.split(sep);
  /* on Windows a `:` in a name is a stream of it (`.film::$INDEX_ALLOCATION` is the folder itself) */
  const streams = process.platform === 'win32' && parts.some((p) => p.includes(':'));
  if (!back || parts[0] === '..' || isToolDir(parts[0]) || streams || /^[a-zA-Z]:/.test(clean) || clean.startsWith(sep)
    || !(onDiskInside(root, abs) || (how.read === true && readableLink(root, abs)))) {
    throw new FileError(`${rel} is not a path inside the project`);
  }
  return abs;
}

/** {@link inside} to read: a linked file is followed to where it is kept. */
export const readable = (/** @type {string} */ root, /** @type {string} */ rel) => inside(root, rel, { read: true });

/** {@link readable}, or null where it would refuse: for paths a film names (a clip's src), not a person. */
export function inProject(/** @type {string} */ root, /** @type {string} */ rel) {
  try { return readable(root, rel); } catch { return null; }
}

/**
 * {@link inside} for an entry itself, to move or remove it: a link in assets/ is the link, wherever it leads, or if
 * it leads nowhere (a NAS that is off); its folder must be in the project.
 * @param {string} root @param {string} rel
 */
function entryInside(root, rel) {
  const cut = typeof rel === 'string' ? rel.lastIndexOf('/') : -1;
  if (cut > 0 && rel.startsWith(`${ASSETS}/`)) {
    const abs = join(inside(root, rel.slice(0, cut)), rel.slice(cut + 1));
    if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() && !rel.slice(cut + 1).startsWith('.')) return abs;
  }
  return inside(root, rel);
}

/**
 * Whether a name is Studio's own folder however it is spelt: case ignored (APFS, NTFS), the trailing dots and spaces
 * Windows drops, a stream of it, and its short 8.3 name on Windows (`FILM~1`).
 */
function isToolDir(/** @type {string | undefined} */ name) {
  const plain = String(name ?? '').split(':')[0].replace(/[. ]+$/, '').toLowerCase();
  return plain === TOOL_DIR.toLowerCase() || (process.platform === 'win32' && /^film~\d+$/.test(plain));
}

/**
 * Whether `abs` is inside `root` on disk: the nearest part of it that exists, its links followed, is the project
 * folder or under it, and not in `.film/`. A link that leads nowhere is not followed either (a write would go where
 * it points).
 */
function onDiskInside(/** @type {string} */ root, /** @type {string} */ abs) {
  let home;
  /* a folder not made yet has no links in it */
  try { home = realpathSync.native(root); } catch { return true; }
  let at = abs;
  for (;;) {
    let real;
    try { real = realpathSync.native(at); } catch {
      let there = null;
      try { there = lstatSync(at, { throwIfNoEntry: false }); } catch { /* a file on the way (ENOTDIR): not there */ }
      if (there) {
        /* made just now (an import beside this one makes its folder), or a link that leads nowhere: look once more */
        try { real = realpathSync.native(at); } catch { return false; }
      } else {
        const up = dirname(at);
        if (up === at) return false;
        at = up;
        continue;
      }
    }
    const back = relative(home, real);
    if (!back) return true;
    const first = back.split(sep)[0];
    return first !== '..' && !isAbsolute(back) && !isToolDir(first);
  }
}

const posix = (/** @type {string} */ p) => p.split(sep).join('/');

/**
 * A file or folder name as a person typed it, less only what file systems refuse: `/ \ : * ? " < > |` and control
 * characters (a run of them, with the spaces around it, becomes one space). Spaces, `&` and every script stay. Trimmed,
 * no leading dots (a hidden file the pane never lists), at most 120 characters with the extension kept. The one rule
 * for imports, renames, moves and new folders alike; the media pane cleans names the same way (safeName).
 * @param {string} name
 */
export function cleanName(name) {
  const clean = String(name ?? '').replace(/\s*[/\\:*?"<>|\u0000-\u001f\u007f]+\s*/g, ' ').trim().replace(/^[.\s]+/, '');
  if (clean.length <= 120) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 13 ? clean.slice(dot) : '';
  return `${clean.slice(0, 120 - ext.length).trimEnd()}${ext}`;
}

/**
 * A path as a person asked for it, before its name is cleaned: refused when it leaves the project or reaches into
 * `.film/`. The name is checked up to a `:`, which cleaning takes out (on Windows it would name a stream of a file).
 * @param {string} root @param {string} rel
 */
function askedInside(root, rel) {
  const cut = typeof rel === 'string' ? rel.lastIndexOf('/') : -1;
  inside(root, typeof rel === 'string' ? `${rel.slice(0, cut + 1)}${rel.slice(cut + 1).split(':')[0]}` : rel);
}

/** A project-relative path with its last part cleaned (cleanName); the folders before it are where it goes, as they are. */
function cleanLast(/** @type {string} */ rel) {
  const cut = typeof rel === 'string' ? rel.lastIndexOf('/') : -1;
  const name = cleanName(cut >= 0 ? rel.slice(cut + 1) : rel);
  if (!name) throw new FileError('a name, please');
  return `${cut >= 0 ? rel.slice(0, cut + 1) : ''}${name}`;
}

/** What a file is to the media pane: a picture, a video, a sound, a page, or something else. */
export function kindOf(/** @type {string} */ name) {
  const kind = clipKind(name);
  return kind === 'still' ? 'image' : kind === 'sound' ? 'audio' : kind ?? 'other';
}

/**
 * The project's media (everything under assets/, any depth) and its web pages (.html outside assets/, three folders
 * deep at most, film.html not among them), with sizes and times. `folders` lists every folder under assets/, empty ones included; `made` the ones
 * a person made (they keep a `.gitkeep`, so an empty one is shown and kept in history).
 * @param {string} root
 */
export async function listFiles(root) {
  /** @type {string[]} */
  const made = [];
  /** `added`: when it came into the project (a link: when it was made), for listing the newest last
   * @type {{ path: string, kind: string, size: number, mtime: number, added: number }[]} */
  const files = [];
  /** @type {string[]} */
  const folders = [];
  /** @type {{ path: string, size: number, mtime: number }[]} */
  const pages = [];
  /** @type {Record<string, { to: string, missing?: true }>} */
  const links = {};

  async function walk(/** @type {string} */ dir, /** @type {number} */ depth, /** @type {boolean} */ media) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (media && entry.name === KEEP && entry.isFile()) made.push(posix(relative(root, dir)));
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      const rel = posix(relative(root, abs));
      /* a link the person made to media kept elsewhere: followed to a place they linked; one that leads nowhere (a
         NAS that is off), or out of the project to a place they never linked (a project from elsewhere), is missing */
      if (media && entry.isSymbolicLink()) {
        const to = await readlink(abs).catch(() => '');
        const info = readableLink(root, abs) ? await stat(abs).catch(() => null) : null;
        links[rel] = { to: isAbsolute(to) ? to : join(dir, to), ...(info ? {} : { missing: true }) };
        if (info?.isDirectory()) { folders.push(rel); if (depth < 8) await walk(abs, depth + 1, true); continue; }
        const own = await lstat(abs).catch(() => null);
        const at = info ?? own;
        /* `added`: when the link was made, not when what it leads to last changed */
        if (at) files.push({ path: rel, kind: kindOf(entry.name), size: info ? info.size : 0, mtime: Math.round(at.mtimeMs), added: Math.round((own ?? at).mtimeMs) });
        continue;
      }
      if (entry.isDirectory()) {
        if (media) { folders.push(rel); if (depth < 8) await walk(abs, depth + 1, true); }
        else if (!SKIP.has(entry.name) && depth < 3) await walk(abs, depth + 1, false);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      if (media) files.push({ path: rel, kind: kindOf(entry.name), size: info.size, mtime: Math.round(info.mtimeMs), added: Math.round(info.mtimeMs) });
      /* the film is not one of its pages */
      else if (/\.html?$/i.test(entry.name) && rel !== FILM_FILE) pages.push({ path: rel, size: info.size, mtime: Math.round(info.mtimeMs) });
    }
  }
  await walk(join(root, ASSETS), 0, true);
  await walk(root, 0, false);
  const sort = (/** @type {{ path: string }} */ a, /** @type {{ path: string }} */ b) => a.path.localeCompare(b.path, undefined, { numeric: true });
  return { files: files.sort(sort), folders: folders.sort(), made: made.sort(), pages: pages.sort(sort), links };
}

/** The file that marks a folder a person made: it keeps an empty folder in the listing and in history. */
const KEEP = '.gitkeep';

/** A file's SHA-256, read as a stream (footage can be any size). */
async function digestOf(/** @type {string} */ abs) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/* a temporary file's name of its own: a message with two files imports them at once, often in the same millisecond */
let imports = 0;

/** @type {Map<string, Promise<void>>} imports waiting to choose a name in the same physical directory */
const importQueues = new Map();

/** @template T @param {string} dir @param {() => Promise<T>} job @returns {Promise<T>} */
function queuedImport(dir, job) {
  const key = realpathSync.native(dir);
  const next = (importQueues.get(key) ?? Promise.resolve()).then(job);
  const settled = next.then(() => {}, () => {});
  importQueues.set(key, settled);
  settled.then(() => { if (importQueues.get(key) === settled) importQueues.delete(key); });
  return next;
}

/**
 * Write a file from a stream (an import from the person's computer). The bytes go to a temporary file first: a
 * cancelled import leaves nothing behind. The same file imported again (its name and its bytes) is the one already
 * there, not a copy of it; another file by that name gets the next free one. Returns the path it landed at, and
 * whether that is a file already there (`reused`: nothing was written).
 * @param {string} root @param {string} rel @param {NodeJS.ReadableStream} body
 * @returns {Promise<{ path: string, reused: boolean }>}
 */
export async function importFile(root, rel, body) {
  askedInside(root, rel);
  const asked = cleanLast(rel);
  const dir = dirname(inside(root, asked));
  await mkdir(dir, { recursive: true });
  imports = (imports + 1) % 1000;
  const tmp = join(dir, `.${process.pid}.${Date.now()}${String(imports).padStart(3, '0')}.importing`);
  try {
    const out = createWriteStream(tmp, { flags: 'wx' });
    const hash = createHash('sha256');
    await pipeline(body, new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk); } }), out);
    if (!out.bytesWritten) throw new FileError('the file is empty');
    const digest = hash.digest('hex');
    /* Stream uploads in parallel, but choose and publish their names one at a time. */
    return await queuedImport(dir, async () => {
      /* `name.ext`, then `name 2.ext`, `name 3.ext`… beside it. A file is the same one only by its name exactly as
         spelt (on a disk that ignores case, `Pic.png` would find `pic.png`) */
      const ext = extname(asked);
      const spelt = new Set(await readdir(dir));
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? asked : `${asked.slice(0, asked.length - ext.length)} ${n}${ext}`;
        const abs = inside(root, candidate);
        const there = await stat(abs).catch(() => null);
        if (!there) { await rename(tmp, abs); return { path: candidate, reused: false }; }
        if (there.isFile() && there.size === out.bytesWritten && spelt.has(basename(abs)) && await digestOf(abs) === digest) {
          await rm(tmp, { force: true });
          return { path: candidate, reused: true };
        }
      }
    });
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Make a folder under assets/ (a person's folder shows even while empty). */
export async function makeFolder(/** @type {string} */ root, /** @type {string} */ asked) {
  askedInside(root, asked);
  const rel = cleanLast(asked);
  const abs = inside(root, rel);
  if (existsSync(abs)) throw new FileError(`${rel} is already there`, 409);
  await mkdir(abs, { recursive: true });
  await writeFile(join(abs, KEEP), '');
  return rel;
}

/* ── links between the project's own files, kept when one moves (page-links.mjs) ── */

/** The project's pages, stylesheets and scripts (its own: no dot folder, no node_modules), as paths from the root. */
async function linkedFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const out = [];
  const walk = async (/** @type {string} */ dir) => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (out.length < 5000) await walk(rel); } else if (entry.isFile() && linkKind(entry.name)) out.push(rel);
    }
  };
  await walk('');
  return out;
}

/** Where a file that was at `path` is after `from` moved to `to` (a file, or a folder and what is in it). */
const movedTo = (/** @type {string} */ from, /** @type {string} */ to) => (/** @type {string} */ path) => (
  path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path
);

/**
 * What moving `from` to `to` cannot keep true: the paths its pages and scripts make while they run (page-links.mjs),
 * by file. Nothing moves.
 * @param {string} root @param {string} from @param {string} to
 */
export async function moveCheck(root, from, to) {
  const src = posix(from);
  const where = movedTo(src, posix(to));
  /** @type {{ file: string, unseen: string[] }[]} */
  const out = [];
  for (const file of await linkedFiles(root)) {
    if (file !== src && !file.startsWith(`${src}/`)) continue;
    const kind = linkKind(file);
    if (!kind) continue;
    const text = await readFile(inside(root, file), 'utf8').catch(() => '');
    const { unseen } = rewriteLinks(text, kind, posix(dirname(file)), posix(dirname(where(file))), where);
    if (unseen.length) out.push({ file, unseen });
  }
  return out;
}

/**
 * After `from` moved to `to`: every page, stylesheet and script of the project written again so its links reach the
 * same files (those that moved, and what they link to). Returns how many files changed.
 * @param {string} root @param {string} from @param {string} to
 */
async function relinkAfterMove(root, from, to) {
  const where = movedTo(from, to);
  const back = (/** @type {string} */ path) => (path === to ? from : path.startsWith(`${to}/`) ? from + path.slice(to.length) : path);
  let changed = 0;
  for (const file of await linkedFiles(root)) {
    const kind = linkKind(file);
    if (!kind) continue;
    const was = back(file);
    const abs = inside(root, file);
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text == null) continue;
    const next = rewriteLinks(text, kind, posix(dirname(was)), posix(dirname(file)), where);
    if (next.changed) { await writeFile(abs, next.text); changed++; }
  }
  return changed;
}

/**
 * Rename or move a file or a folder, never over another, and point film.html's clips at the new place in the same
 * step: a renamed picture stays on the timeline. Pages, stylesheets and scripts that link to what moved, or that moved
 * themselves, are written again so their links still reach their files (relinkAfterMove). The new name is cleaned
 * (cleanName).
 * @param {string} root @param {string} from @param {string} asked
 */
export async function moveFile(root, from, asked) {
  const src = entryInside(root, from);
  askedInside(root, asked);
  const to = cleanLast(asked);
  const dst = inside(root, to);
  const link = lstatSync(src, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  if (!link && !existsSync(src)) throw new FileError(`${from} is not there`, 404);
  /* a file's ending says what it is: a picture renamed .mp3 would be taken for a sound (and fail as one). Another
     ending of the same kind (.jpeg → .jpg) is fine */
  const fromName = posix(from).split('/').pop() ?? '', toName = to.split('/').pop() ?? '';
  if ((link || (await stat(src)).isFile()) && kindOf(fromName) !== kindOf(toName)) {
    throw new FileError(`${fromName} can't be renamed ${toName}: the ending says what a file is (a picture, a video, a sound or a page), and this one would change it. Keep an ending of the same kind`);
  }
  if (existsSync(dst) && !sameEntry(src, dst)) throw new FileError(`${to} is already there`, 409);
  if (dst.startsWith(src + sep)) throw new FileError('a folder cannot go inside itself');
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
  const moved = await repoint(root, posix(relative(root, src)), posix(relative(root, dst)));
  const pages = await relinkAfterMove(root, posix(relative(root, src)), posix(relative(root, dst)));
  return { path: posix(relative(root, dst)), clips: moved, pages };
}

/** Whether two paths are one file on disk: a name changed only in case, on a disk that ignores case, is not "taken". */
function sameEntry(/** @type {string} */ a, /** @type {string} */ b) {
  const x = statSync(a, { throwIfNoEntry: false }), y = statSync(b, { throwIfNoEntry: false });
  return Boolean(x && y && x.dev === y.dev && x.ino === y.ino);
}

/** Point every clip whose src is `from` (or inside the folder `from`) at `to`. Returns how many moved. */
async function repoint(/** @type {string} */ root, /** @type {string} */ from, /** @type {string} */ to) {
  const film = await readProjectFilm(root);
  if (!film.value) return 0;
  let moved = 0;
  for (const track of film.value.tracks) {
    for (const clip of track.clips) {
      if (clip.src === from) { clip.src = to; moved++; }
      else if (clip.src.startsWith(`${from}/`)) { clip.src = to + clip.src.slice(from.length); moved++; }
    }
  }
  if (moved) await writeProjectFilm(root, film.value, film.text);
  return moved;
}

/**
 * A video's sound as a file of its own beside it (an editor's "extract audio"): its first sound stream as it is, in
 * an .m4a when it is AAC or an .mp3 when it is MP3 (nothing re-encoded, nothing lost), else as a WAV. Its transcript
 * (the WebVTT beside the video) goes with it. Returns the new file's path.
 * @param {string} root @param {string} rel
 */
export async function extractAudio(root, rel) {
  const abs = inside(root, rel);
  if (clipKind(rel) !== 'video' || !existsSync(abs)) throw new FileError(`${rel} is not a video here`, 404);
  const codec = await new Promise((done) => execFile('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', abs],
    { windowsHide: true }, (e, out) => done(e ? '' : String(out).trim())));
  if (!codec) throw new FileError(`${basename(rel)} has no sound`, 422);
  const [ext, how] = codec === 'aac' ? ['m4a', ['-c:a', 'copy']] : codec === 'mp3' ? ['mp3', ['-c:a', 'copy']] : ['wav', ['-c:a', 'pcm_s16le']];
  const stem = basename(abs, extname(abs));
  let out = join(dirname(abs), `${stem}.${ext}`);
  for (let n = 2; existsSync(out); n++) out = join(dirname(abs), `${stem}-${n}.${ext}`);
  /* ffmpeg writes through a link that leads nowhere, and copyFile reads through one: each file checked as itself */
  const own = (/** @type {string} */ file) => inside(root, posix(relative(root, file)));
  await ffmpeg(['-i', abs, '-map', '0:a:0', '-vn', ...how, own(out)], { timeoutMs: 10 * 60_000, what: 'extracting the sound' }).done;
  const words = join(dirname(abs), `${stem}.vtt`);
  const theirs = join(dirname(out), `${basename(out, extname(out))}.vtt`);
  if (existsSync(words) && theirs !== words && !existsSync(theirs)) await copyFile(own(words), own(theirs));
  return posix(relative(root, out));
}

/**
 * A frame of a video made a still beside it, full size, as PNG: `<name>-frame-<seconds>s.png` (`-2`… when taken), the
 * frame at `ms` of the file's own time. What the timeline's "Freeze frame" puts on the film.
 * @param {string} root @param {string} rel @param {number} ms
 */
export async function freezeFrame(root, rel, ms) {
  const abs = inside(root, rel);
  if (clipKind(rel) !== 'video' || !existsSync(abs)) throw new FileError(`${rel} is not a video here`, 404);
  if (!(Number.isFinite(ms) && ms >= 0)) throw new FileError('which moment? ms from 0', 400);
  const stem = basename(abs, extname(abs));
  const secs = String(Math.round(ms) / 1000).replace('.', '_');
  let out = join(dirname(abs), `${stem}-frame-${secs}s.png`);
  for (let n = 2; existsSync(out); n++) out = join(dirname(abs), `${stem}-frame-${secs}s-${n}.png`);
  const own = inside(root, posix(relative(root, out)));
  /* seeking before the input lands on the frame itself (ffmpeg decodes from the keyframe before it) */
  await ffmpeg(['-ss', String(ms / 1000), '-i', abs, '-frames:v', '1', '-an', '-update', '1', own], { timeoutMs: 60_000, what: 'taking the frame' }).done;
  if (!existsSync(own)) throw new FileError(`${basename(rel)} has no frame at ${Math.round(ms) / 1000} s`, 422);
  return posix(relative(root, out));
}

/**
 * Move a file or folder to the system's trash (see trash.mjs). A link is only taken away: what it leads to stays where
 * it is kept, untouched.
 */
export async function trashFile(/** @type {string} */ root, /** @type {string} */ rel) {
  const abs = entryInside(root, rel);
  if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) { await unlink(abs); return; }
  if (!existsSync(abs)) throw new FileError(`${rel} is not there`, 404);
  await moveToTrash(abs);
}

/* ── media kept elsewhere: copied in (cloned where the disk can) or linked (src/media-links.mjs) ── */

/** The first free name for `name` in `dir`: `name.ext`, then `name 2.ext`… (importFile's rule). */
function freeIn(/** @type {string} */ dir, /** @type {string} */ name) {
  const ext = extname(name);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name.slice(0, name.length - ext.length)} ${n}${ext}`;
    if (!lstatSync(join(dir, candidate), { throwIfNoEntry: false })) return candidate;
  }
}

/**
 * Bring files or folders from this computer into the project folder `into` (`assets` or under it): `copy` copies each
 * (a clone where the disk can make one: at once, and no more room taken until either is changed), `link` puts a link
 * to it there and remembers the place as one the person linked. A link to the same place already there is that one.
 * Returns where each landed. `anywhere`: into any folder of `root` ('' its top), not only assets/ (the Saved library,
 * saved.mjs, whose folder is all media).
 * @param {string} root @param {string} into @param {string[]} paths @param {'copy' | 'link'} mode
 * @param {{ anywhere?: boolean }} [o]
 */
export async function bringIn(root, into, paths, mode, { anywhere = false } = {}) {
  if (!anywhere && into !== ASSETS && !into.startsWith(`${ASSETS}/`)) throw new FileError('media goes in assets/');
  const dir = into ? inside(root, into) : root;
  await mkdir(dir, { recursive: true });
  /** @type {string[]} */
  const landed = [];
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new FileError('a full path, please');
    const from = realpathSync.native(path);
    const info = await stat(from);
    const name = cleanName(basename(from));
    if (!name || name.startsWith('.')) throw new FileError(`${basename(from)} can't be named here`);
    if (mode === 'link') {
      /* the person picked it: theirs to read, whichever link leads there */
      addLinkedPlaces([from]);
      const same = (await readdir(dir)).find((n) => {
        const at = join(dir, n);
        return lstatSync(at).isSymbolicLink() && (() => { try { return realpathSync.native(at) === from; } catch { return false; } })();
      });
      if (same) { landed.push(posix(relative(root, join(dir, same)))); continue; }
      const at = join(dir, freeIn(dir, name));
      await symlink(from, at, info.isDirectory() ? 'dir' : 'file');
      landed.push(posix(relative(root, at)));
      continue;
    }
    const at = join(dir, freeIn(dir, name));
    /* under a hidden name until it is all there: the pane never shows half a file */
    const part = join(dir, `.${basename(at)}.${process.pid}.importing`);
    try {
      if (info.isDirectory()) await cp(from, part, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (src) => !basename(src).startsWith('.') });
      else {
        await copyFile(from, part, constants.COPYFILE_FICLONE);
        /* dated now, as it came in (a copy on Windows keeps the original's date): the pane lists it after the rest */
        const now = new Date();
        await utimes(part, now, now);
      }
      await rename(part, at);
    } catch (e) {
      await rm(part, { recursive: true, force: true });
      throw e;
    }
    landed.push(posix(relative(root, at)));
  }
  return landed;
}

/**
 * Point a link at another place (a NAS that moved, a file renamed there): the person's pick, remembered as linked.
 * @param {string} root @param {string} rel @param {string} to
 */
export async function relink(root, rel, to) {
  const abs = entryInside(root, rel);
  if (!lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) throw new FileError(`${rel} is not a link`);
  if (typeof to !== 'string' || !isAbsolute(to)) throw new FileError('a full path, please');
  const from = realpathSync.native(to);
  const info = await stat(from);
  addLinkedPlaces([from]);
  const part = `${abs}.${process.pid}.linking`;
  await symlink(from, part, info.isDirectory() ? 'dir' : 'file');
  await rename(part, abs);
  return rel;
}

/**
 * Copy what a link leads to into the project in its place (an editor's "collect files"): the film then has its own
 * copy, to share or to keep when the NAS is gone. Cloned where the disk can. The original stays where it is.
 * @param {string} root @param {string} rel
 */
export async function collect(root, rel) {
  const abs = entryInside(root, rel);
  if (!lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink()) return rel;
  /* cp preserves links: copy the permitted target, not the link we are replacing. */
  const from = realpathSync.native(readable(root, rel));
  const info = await stat(from);
  const part = join(dirname(abs), `.${basename(abs)}.${process.pid}.collecting`);
  try {
    if (info.isDirectory()) await cp(from, part, { recursive: true, mode: constants.COPYFILE_FICLONE, filter: (src) => src === from || !basename(src).startsWith('.') });
    else await copyFile(from, part, constants.COPYFILE_FICLONE);
    await unlink(abs);
    await rename(part, abs);
  } catch (e) {
    await rm(part, { recursive: true, force: true });
    throw e;
  }
  return rel;
}
