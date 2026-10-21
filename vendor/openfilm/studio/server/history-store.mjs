// @ts-check
/**
 * How the version history (history.mjs) keeps files. git keeps the versions: each is a commit whose tree holds the
 * film's files (closure.mjs). Code, pages and data are blobs in it as usual; a video, a sound, a picture or anything
 * over BIG is kept by its content outside git, in `.film/history/media/<sha256>`, and the tree holds a pointer to it
 * (POINTER: three short lines). git never compresses or packs footage, and a file kept twice is stored once.
 *
 * A media file is put in the store as a clone of the person's file (APFS, Btrfs, XFS: no space taken, and later
 * changes to either never reach the other), else as a copy; it comes back the same way. Nothing in the folder is
 * written unless it differs from what a version holds, and what differs is known without reading: a file's hash is
 * kept with its size, time and inode (`.film/cache/history-files.json`) and read again only when one of them changed.
 *
 * git runs on the history only, never on the folder as its work tree: every read and write of the folder's files is
 * here, so nothing outside a version's files is ever looked at or touched. Set NODE_DEBUG=openfilm-history to see
 * every git command and how long it took.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { debuglog, promisify } from 'node:util';
import { replaceFile, tempPath, writeAtomic } from './atomic.mjs';
import { isMediaFile } from './closure.mjs';
import { TOOL_DIR } from './projects.mjs';

const run = promisify(execFile);
const debug = debuglog('openfilm-history');

/** Larger than this, any file is kept by its content outside git. */
export const BIG = 1 << 20;

/**
 * A history action that cannot be done, and why: `code` is what the editor tells the person in its own words
 * ('dirty': there are uncommitted changes; 'nothing': nothing to commit; 'conflict': a merge or a carried change
 * collides; 'unmerged': a branch has commits no other has; 'exists', 'name', 'current', 'none').
 */
export class HistoryError extends Error {
  /** @param {string} message @param {number} status @param {string} [code] */
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * What an action is doing, for the person to see while it runs: `phase` ('scan': reading the film's files, 'store':
 * keeping media, 'write': putting files in the folder, 'migrate': bringing an older history up to date), and how far.
 * @typedef {(p: { phase: 'scan' | 'store' | 'write' | 'migrate', done: number, total: number }) => void} Progress
 */

/* ── git ─────────────────────────────────────────────────────────────────── */

/**
 * The settings every call runs with: no hooks (a hook is a program in the folder, and a folder can come from anywhere);
 * anything over a megabyte stored whole, never delta-compressed (there is little of it: media is kept outside git).
 */
const SETTINGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.longpaths=true', '-c', 'core.bigFileThreshold=1m',
  '-c', 'core.looseCompression=1', '-c', 'pack.compression=6', '-c', 'gc.autoDetach=true'];

const gitEnv = (/** @type {string} */ root, /** @type {string} */ gitDir, /** @type {Record<string, string>} */ extra = {}) => ({
  ...process.env,
  GIT_DIR: gitDir,
  GIT_WORK_TREE: root,
  GIT_AUTHOR_NAME: 'OpenFilm Studio', GIT_AUTHOR_EMAIL: 'studio@openfilm.local',
  GIT_COMMITTER_NAME: 'OpenFilm Studio', GIT_COMMITTER_EMAIL: 'studio@openfilm.local',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  ...extra,
});

/**
 * git on the history in `gitDir`, the project folder `root` named as its work tree (no command here reads it).
 * `input`: what it reads on its standard input; `env`: more of its environment (a scratch index).
 * @param {string} root @param {string} gitDir @param {string[]} args
 * @param {{ input?: string | Buffer, env?: Record<string, string> }} [o]
 */
export async function gitRun(root, gitDir, args, { input, env } = {}) {
  const started = performance.now();
  try {
    const call = run('git', [`--git-dir=${gitDir}`, `--work-tree=${root}`, ...SETTINGS, ...args], {
      cwd: root, maxBuffer: 256 << 20, windowsHide: true, env: gitEnv(root, gitDir, env),
    });
    if (input != null) call.child.stdin?.end(input);
    const { stdout } = await call;
    debug('git %s: %dms', args.slice(0, 3).join(' '), Math.round(performance.now() - started));
    return stdout;
  } catch (e) {
    const error = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (e);
    debug('git %s failed after %dms: %s', args.slice(0, 3).join(' '), Math.round(performance.now() - started), String(error.stderr || error.message).trim());
    if (error.code === 'ENOENT') throw new HistoryError('version history needs git, which is not installed on this computer', 501);
    throw new HistoryError(String(error.stderr || error.message).trim(), 500);
  }
}

/**
 * Many blobs read at once (one git for all), by id. Not for media: it holds them all in memory.
 * @param {Repo} repo @param {string[]} oids @returns {Promise<Map<string, Buffer>>}
 */
export function readBlobs(repo, oids) {
  /** @type {Map<string, Buffer>} */
  const out = new Map();
  const wanted = [...new Set(oids)];
  if (!wanted.length) return Promise.resolve(out);
  const started = performance.now();
  return new Promise((done, fail) => {
    const proc = spawn('git', [`--git-dir=${repo.gitDir}`, ...SETTINGS, 'cat-file', '--batch'], {
      cwd: repo.root, env: gitEnv(repo.root, repo.gitDir), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    /** @type {Buffer[]} */
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', () => {});
    proc.on('error', (e) => fail(/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? new HistoryError('version history needs git, which is not installed on this computer', 501) : e));
    proc.on('close', () => {
      const all = Buffer.concat(chunks);
      let at = 0;
      while (at < all.length) {
        const eol = all.indexOf(10, at);
        if (eol < 0) break;
        const [oid, type, size] = all.subarray(at, eol).toString().split(' ');
        at = eol + 1;
        if (type === 'missing' || size == null) continue;
        const n = Number(size);
        out.set(oid, all.subarray(at, at + n));
        at += n + 1;
      }
      debug('git cat-file --batch (%d): %dms', wanted.length, Math.round(performance.now() - started));
      done(out);
    });
    proc.stdin.end(`${wanted.join('\n')}\n`);
  });
}

/* ── a project's history, open ───────────────────────────────────────────── */

/**
 * @typedef {{ root: string, gitDir: string, algo: 'sha1' | 'sha256', hashes: Hashes,
 *   git: (args: string[], o?: { input?: string | Buffer, env?: Record<string, string> }) => Promise<string> }} Repo
 */

/** The history in `gitDir` for the folder `root`, to read and write. */
export function openRepo(/** @type {string} */ root, /** @type {string} */ gitDir) {
  let algo = /** @type {'sha1' | 'sha256'} */ ('sha1');
  try { if (/objectformat\s*=\s*sha256/i.test(readFileSync(join(gitDir, 'config'), 'utf8'))) algo = 'sha256'; } catch { /* none yet */ }
  /** @type {Repo} */
  const repo = {
    root, gitDir, algo, hashes: hashesOf(root, algo),
    git: (args, o) => gitRun(root, gitDir, args, o),
  };
  return repo;
}

/* ── what each file's content is, remembered ─────────────────────────────── */

/** A file's content as git names it: the id of a blob of those bytes. */
const blobId = (/** @type {'sha1' | 'sha256'} */ algo, /** @type {Buffer} */ bytes) =>
  createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** A hash of a file, read in pieces; `head` goes first (git's blob header). */
function hashFile(/** @type {string} */ path, /** @type {string} */ algo, /** @type {string} */ head = '') {
  return new Promise((done, fail) => {
    const hash = createHash(algo).update(head);
    createReadStream(path, { highWaterMark: 1 << 20 }).on('data', (d) => hash.update(d)).on('error', fail).on('end', () => done(hash.digest('hex')));
  });
}
const sha256File = (/** @type {string} */ path) => hashFile(path, 'sha256');

/**
 * The folder's files' content ids, kept with the size, time and inode they were read at: a file is read again only when
 * one of those changed. One per project, saved to `.film/cache/history-files.json` after each action.
 * @typedef {{ stat(rel: string): Promise<import('node:fs').BigIntStats | null>, sha256(rel: string, st?: import('node:fs').BigIntStats): Promise<string>,
 *   blob(rel: string, st?: import('node:fs').BigIntStats): Promise<string>, know(rel: string, st: import('node:fs').BigIntStats, ids: { sha256?: string, blob?: string }): void,
 *   withSha256(sha: string): string[], save(): Promise<void> }} Hashes
 */

/** @type {Map<string, Hashes>} */
const allHashes = new Map();

/** @returns {Hashes} */
function hashesOf(/** @type {string} */ root, /** @type {'sha1' | 'sha256'} */ algo) {
  const id = `${root}\0${algo}`;
  const known = allHashes.get(id);
  if (known) return known;
  const file = join(root, TOOL_DIR, 'cache', 'history-files.json');
  /** @type {Map<string, { key: string, sha256?: string, blob?: string }>} */
  let map = new Map();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.v === 1 && raw.algo === algo && raw.files && typeof raw.files === 'object') {
      for (const [rel, v] of Object.entries(raw.files)) if (Array.isArray(v) && typeof v[0] === 'string') map.set(rel, { key: v[0], sha256: v[1] || undefined, blob: v[2] || undefined });
    }
  } catch { map = new Map(); }
  let dirty = false;
  const keyOf = (/** @type {import('node:fs').BigIntStats} */ st) => `${st.size}:${st.mtimeNs}:${st.ino}`;
  const entry = (/** @type {string} */ rel, /** @type {import('node:fs').BigIntStats} */ st) => {
    const key = keyOf(st);
    let e = map.get(rel);
    if (!e || e.key !== key) { e = { key }; map.set(rel, e); dirty = true; }
    return e;
  };
  const statOf = async (/** @type {string} */ rel) => {
    const st = await stat(join(root, rel), { bigint: true }).catch(() => null);
    return st?.isFile() ? st : null;
  };
  /** @type {Hashes} */
  const hashes = {
    stat: statOf,
    async sha256(rel, st) {
      const info = st ?? await statOf(rel);
      if (!info) throw new HistoryError(`${rel} is not there`, 404);
      const e = entry(rel, info);
      if (!e.sha256) { e.sha256 = /** @type {string} */ (await sha256File(join(root, rel))); dirty = true; }
      return e.sha256;
    },
    async blob(rel, st) {
      const info = st ?? await statOf(rel);
      if (!info) throw new HistoryError(`${rel} is not there`, 404);
      const e = entry(rel, info);
      if (!e.blob) { e.blob = /** @type {string} */ (await hashFile(join(root, rel), algo, `blob ${info.size}\0`)); dirty = true; }
      return e.blob;
    },
    know(rel, st, ids) {
      const e = entry(rel, st);
      if (ids.sha256) e.sha256 = ids.sha256;
      if (ids.blob) e.blob = ids.blob;
      dirty = true;
    },
    withSha256(sha) {
      return [...map].filter(([, e]) => e.sha256 === sha).map(([rel]) => rel);
    },
    async save() {
      if (!dirty) return;
      dirty = false;
      /** @type {Record<string, [string, string, string]>} */
      const files = {};
      for (const [rel, e] of map) files[rel] = [e.key, e.sha256 ?? '', e.blob ?? ''];
      await mkdir(dirname(file), { recursive: true });
      await writeAtomic(file, JSON.stringify({ v: 1, algo, files })).catch(() => { dirty = true; });
    },
  };
  allHashes.set(id, hashes);
  return hashes;
}

/* ── versions: a tree of the film's files ────────────────────────────────── */

/**
 * One file of a version: its blob in git (`oid`, `mode`; `size`, the blob's, when read from a tree), and for media,
 * what the pointer blob says.
 * @typedef {{ oid: string, mode: string, size?: number, media?: { sha256: string, size: number } }} Entry
 * @typedef {Map<string, Entry>} Version
 */

/** What stands in a tree for a media file kept outside git. */
export const pointerText = (/** @type {string} */ sha256, /** @type {number} */ size) => `openfilm-media 1\nsha256 ${sha256}\nsize ${size}\n`;
const POINTER = /^openfilm-media 1\nsha256 ([0-9a-f]{64})\nsize (\d+)\n$/;
export const pointerId = (/** @type {Repo} */ repo, /** @type {string} */ sha256, /** @type {number} */ size) => blobId(repo.algo, Buffer.from(pointerText(sha256, size)));

/** Where the store keeps a media file. */
export const mediaPath = (/** @type {string} */ gitDir, /** @type {string} */ sha256) => join(gitDir, 'media', sha256);

/** Whether a file of this path and size is kept outside git. */
export const isMedia = (/** @type {string} */ rel, /** @type {number} */ size) => size > BIG || isMediaFile(rel);

/** @type {Map<string, Version>} versions by tree (a tree never changes) */
const versions = new Map();

/**
 * The files a commit (or tree) holds. A version made before media was kept outside git holds it as blobs, and is
 * read as it is.
 * @param {Repo} repo @param {string} rev @returns {Promise<Version>}
 */
export async function readVersion(repo, rev) {
  const tree = (await repo.git(['rev-parse', `${rev}^{tree}`])).trim();
  const key = `${repo.gitDir}\0${tree}`;
  const known = versions.get(key);
  if (known) return known;
  /** @type {Version} */
  const version = new Map();
  const out = await repo.git(['ls-tree', '-r', '-z', '-l', '--full-tree', tree]);
  const small = [];
  for (const line of out.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid, size] = line.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    const path = line.slice(tab + 1);
    const n = Number(size);
    version.set(path, { oid, mode, size: n });
    if (n > 60 && n < 140) small.push(oid);
  }
  /* which of the small blobs are pointers */
  const blobs = await readBlobs(repo, small);
  for (const entry of version.values()) {
    const text = blobs.get(entry.oid);
    const m = text && POINTER.exec(text.toString());
    if (m) entry.media = { sha256: m[1], size: Number(m[2]) };
  }
  versions.set(key, version);
  if (versions.size > 200) versions.delete(versions.keys().next().value ?? '');
  return version;
}

/** A tree of `version`, written through a scratch index (the history's own index is never used). */
export async function writeTree(/** @type {Repo} */ repo, /** @type {Version} */ version) {
  const index = join(repo.gitDir, `openfilm-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const lines = [...version].map(([path, e]) => `${e.mode} ${e.oid}\t${path}`).join('\n');
    await repo.git(['update-index', '--add', '--index-info'], { input: `${lines}\n`, env: { GIT_INDEX_FILE: index } });
    return (await repo.git(['write-tree'], { env: { GIT_INDEX_FILE: index } })).trim();
  } finally {
    await rm(index, { force: true });
  }
}

/* ── the folder, against a version ───────────────────────────────────────── */

/** Whether the folder's file at `rel` is what `entry` holds. */
export async function sameAs(/** @type {Repo} */ repo, /** @type {string} */ rel, /** @type {Entry | undefined} */ entry) {
  if (!entry) return false;
  const st = await repo.hashes.stat(rel);
  if (!st) return false;
  if (entry.media) return Number(st.size) === entry.media.size && await repo.hashes.sha256(rel, st) === entry.media.sha256;
  if (entry.size != null && entry.size !== Number(st.size)) return false;
  return await repo.hashes.blob(rel, st) === entry.oid;
}

/**
 * The folder's file at `rel` as a version would hold it (null: not there). The same as `was` (what a version held)
 * when its content is, whatever the rule says today, so an unchanged file never looks changed.
 * @param {Repo} repo @param {string} rel @param {Entry} [was] @returns {Promise<Entry | null>}
 */
export async function entryNow(repo, rel, was) {
  const st = await repo.hashes.stat(rel);
  if (!st) return null;
  if (was && await sameAs(repo, rel, was)) return was;
  const mode = Number(st.mode) & 0o111 ? '100755' : '100644';
  const size = Number(st.size);
  if (isMedia(rel, size)) {
    const sha256 = await repo.hashes.sha256(rel, st);
    return { oid: pointerId(repo, sha256, size), mode, media: { sha256, size } };
  }
  return { oid: await repo.hashes.blob(rel, st), mode, size };
}

/**
 * Copy `from` to `to` as a clone where the disk can (no space taken, and a later change to either never reaches the
 * other), else as a plain copy. On macOS through `cp -c` (clonefile): Node's own clone flag copies there.
 */
export async function cloneFile(/** @type {string} */ from, /** @type {string} */ to) {
  if (process.platform === 'darwin') {
    const ok = await run('/bin/cp', ['-c', from, to], { windowsHide: true }).then(() => true, () => false);
    if (ok) return;
    await rm(to, { force: true });
  }
  await copyFile(from, to, constants.COPYFILE_FICLONE);
}

/** A media file of the folder put in the store, unless it is there: a clone where the disk can, else a copy. */
export async function keepMedia(/** @type {Repo} */ repo, /** @type {string} */ rel, /** @type {{ sha256: string, size: number }} */ media) {
  const target = mediaPath(repo.gitDir, media.sha256);
  if (existsSync(target)) return;
  await mkdir(dirname(target), { recursive: true });
  const before = await repo.hashes.stat(rel);
  const tmp = tempPath(target);
  try {
    await cloneFile(join(repo.root, rel), tmp);
    /* what was hashed is what was copied when the file did not change meanwhile; otherwise the copy is read */
    const after = await repo.hashes.stat(rel);
    const same = before && after && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ino === after.ino;
    const sha = same ? media.sha256 : await sha256File(tmp);
    if (sha !== media.sha256) throw new HistoryError(`${rel} changed while it was being kept: try again`, 409, 'changed');
    await chmod(tmp, 0o444);
    await replaceFile(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * The film's files as they are in the folder, as a version: `files` (the closure, closure.mjs) each read as `head`
 * holds it or anew, the blobs written into git and the media into the store. Files gone meanwhile are left out.
 * @param {Repo} repo @param {Iterable<string>} files @param {Version | null} head @param {Progress} [progress]
 * @returns {Promise<Version>}
 */
export async function keepFiles(repo, files, head, progress) {
  /** @type {Version} */
  const version = new Map();
  const list = [...files].filter((rel) => !/[\n\r]/.test(rel)).sort();
  let done = 0;
  for (const rel of list) {
    const entry = await entryNow(repo, rel, head?.get(rel));
    if (entry) version.set(rel, entry);
    progress?.({ phase: 'scan', done: ++done, total: list.length });
  }
  const fresh = [...version].filter(([rel, e]) => head?.get(rel)?.oid !== e.oid);
  /* media: into the store; its pointer and every other new blob, into git */
  const media = fresh.filter(([, e]) => e.media);
  done = 0;
  for (const [rel, e] of media) {
    await keepMedia(repo, rel, /** @type {{ sha256: string, size: number }} */ (e.media));
    progress?.({ phase: 'store', done: ++done, total: media.length });
  }
  const tmpDir = join(repo.gitDir, 'openfilm-tmp');
  const paths = [];
  /** @type {string[]} */
  const expected = [];
  if (media.length) await mkdir(tmpDir, { recursive: true });
  try {
    for (const [rel, e] of fresh) {
      if (e.media) {
        const file = join(tmpDir, `${e.oid}.ptr`);
        await writeFile(file, pointerText(e.media.sha256, e.media.size));
        paths.push(file);
      } else paths.push(rel);
      expected.push(e.oid);
    }
    if (paths.length) {
      const oids = (await repo.git(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: `${paths.join('\n')}\n` })).trim().split('\n');
      /* a file written between its hash and now: what git kept is what the version holds */
      oids.forEach((oid, i) => { if (oid !== expected[i]) fresh[i][1].oid = oid; });
    }
  } finally {
    if (media.length) await rm(tmpDir, { recursive: true, force: true });
  }
  await repo.hashes.save();
  return version;
}

/**
 * Put `version`'s files in the folder, those of `paths` only (all by default), each only when it differs: blobs
 * from git, media cloned from the store (or from a file of the folder with the same content, when the store lost it).
 * Nothing else is touched, and nothing is deleted. Returns the paths written, and the media that could not be found.
 * @param {Repo} repo @param {Version} version @param {{ paths?: Iterable<string>, progress?: Progress }} [o]
 */
export async function writeFiles(repo, version, { paths, progress } = {}) {
  const wanted = [...(paths ?? version.keys())].filter((rel) => version.has(rel));
  /** @type {string[]} */
  const differ = [];
  let done = 0;
  for (const rel of wanted) {
    if (!(await sameAs(repo, rel, version.get(rel)))) differ.push(rel);
    progress?.({ phase: 'scan', done: ++done, total: wanted.length });
  }
  const blobs = await readBlobs(repo, differ.filter((rel) => !version.get(rel)?.media).map((rel) => /** @type {Entry} */ (version.get(rel)).oid));
  /** @type {string[]} */
  const written = [], missing = [];
  done = 0;
  for (const rel of differ) {
    const entry = /** @type {Entry} */ (version.get(rel));
    const target = join(repo.root, rel);
    await mkdir(dirname(target), { recursive: true });
    const mode = entry.mode === '100755' ? 0o755 : 0o644;
    if (entry.media) {
      const sources = [mediaPath(repo.gitDir, entry.media.sha256), ...repo.hashes.withSha256(entry.media.sha256).filter((r) => r !== rel).map((r) => join(repo.root, r))];
      const from = sources.find((p) => existsSync(p));
      if (!from) { missing.push(rel); continue; }
      const tmp = tempPath(target);
      try {
        await cloneFile(from, tmp);
        await chmod(tmp, mode);
        await replaceFile(tmp, target);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      const st = await repo.hashes.stat(rel);
      if (st) repo.hashes.know(rel, st, { sha256: entry.media.sha256 });
    } else {
      const bytes = blobs.get(entry.oid);
      if (!bytes) { missing.push(rel); continue; }
      await writeAtomic(target, bytes, { mode });
      const st = await repo.hashes.stat(rel);
      if (st) repo.hashes.know(rel, st, { blob: entry.oid });
    }
    written.push(rel);
    progress?.({ phase: 'write', done: ++done, total: differ.length });
  }
  await repo.hashes.save();
  return { written, missing };
}

/** @type {Map<string, string>} the text of blobs read for the closure, by id (a blob never changes) */
const texts = new Map();

/**
 * A version as the closure reads it (closure.mjs View): its files, their sizes, the text of its code. The first text
 * asked for reads all of the version's code at once (one git), and `under`, when given, answers for what the version
 * does not hold (the folder, for files history never had).
 * @param {Repo} repo @param {Version} version @param {import('./closure.mjs').View} [under]
 * @returns {import('./closure.mjs').View}
 */
export function versionView(repo, version, under) {
  /** @type {Map<string, string[]> | null} */
  let dirs = null;
  let loaded = false;
  const sizeOf = (/** @type {Entry} */ e) => e.media?.size ?? e.size ?? 0;
  return {
    async size(path) {
      const e = version.get(path);
      if (e) return sizeOf(e);
      return under ? under.size(path) : null;
    },
    async list(dir) {
      if (!dirs) {
        dirs = new Map();
        for (const path of version.keys()) {
          const slash = path.lastIndexOf('/');
          const d = slash < 0 ? '' : path.slice(0, slash);
          dirs.set(d, [...(dirs.get(d) ?? []), path.slice(slash + 1)]);
        }
      }
      const own = dirs.get(dir) ?? null;
      const other = under ? await under.list(dir) : null;
      if (!own) return other;
      return other ? [...new Set([...own, ...other])] : own;
    },
    async text(path) {
      const e = version.get(path);
      if (!e) return under ? under.text(path) : null;
      if (e.media) return null;
      if (!loaded) {
        loaded = true;
        const code = [...version].filter(([p, x]) => !x.media && (x.size ?? 0) <= 4 << 20 && /\.(html?|svg|css|[cm]?js|json)$/i.test(p) && !texts.has(x.oid)).map(([, x]) => x.oid);
        for (const [oid, bytes] of await readBlobs(repo, code)) texts.set(oid, bytes.toString('utf8'));
      }
      if (texts.size > 20000) texts.clear();
      if (!texts.has(e.oid)) {
        const bytes = (await readBlobs(repo, [e.oid])).get(e.oid);
        if (!bytes) return null;
        texts.set(e.oid, bytes.toString('utf8'));
      }
      return texts.get(e.oid) ?? null;
    },
  };
}
