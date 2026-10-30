// @ts-check
/**
 * A history made by an earlier Studio, brought up to date once, the first time it is used. Those kept everything in
 * the folder but video and files over 20 MB, each commit with `git add --all`: renders, frames, logs and other takes
 * went in, and footage did not. Each of its versions is made again holding the film's files only (closure.mjs), with
 * the same message, author and time; media in it moves to the store (history-store.mjs); the changes left on a branch
 * (stashes) become parked versions. On the branch checked out, a "History cleanup" commit then adds what the film uses
 * that history never had (its videos), as they are in the folder now.
 *
 * It is made beside the old one (`.film/history-next`), borrowing its objects, then packed on its own and checked
 * before it takes its place. The old history goes to the Trash, so nothing is lost if something went wrong; the
 * person's files are never written. A version's film.html, pages and code come back exactly as they were; so does its
 * media where the old history had it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tempPath, replaceFile } from './atomic.mjs';
import { filmClosure, folderView } from './closure.mjs';
import {
  HistoryError, gitRun, isMedia, keepFiles, keepMedia, openRepo, pointerId, pointerText, readVersion, versionView, writeTree,
} from './history-store.mjs';
import { TOOL_DIR } from './projects.mjs';
import { moveToTrash } from './trash.mjs';

/** The format of a history Studio made: 2 keeps the film's files only, media outside git. */
export const FORMAT = 2;
const MARKER = 'openfilm.json';
export const CLEANUP_MESSAGE = 'History cleanup: the film\'s files only, its media kept from now on';

/** The format of the history in `gitDir`: 1 for one an earlier Studio made (no marker), else what its marker says. */
export function formatOf(/** @type {string} */ gitDir) {
  if (!existsSync(join(gitDir, MARKER))) return 1;
  return FORMAT;
}

export const markFormat = (/** @type {string} */ gitDir) => writeFile(join(gitDir, MARKER), `${JSON.stringify({ format: FORMAT })}\n`);

/** A blob of the old history written to the store (streamed: it may be large), named by its sha256. */
function extract(/** @type {import('./history-store.mjs').Repo} */ old, /** @type {string} */ storeDir, /** @type {string} */ oid) {
  return new Promise((done, fail) => {
    const tmp = tempPath(join(storeDir, oid));
    const hash = createHash('sha256');
    const out = createWriteStream(tmp);
    const proc = spawn('git', [`--git-dir=${old.gitDir}`, 'cat-file', 'blob', oid], { cwd: old.root, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
    proc.stdout.on('data', (d) => hash.update(d));
    proc.stdout.pipe(out);
    proc.on('error', fail);
    out.on('error', fail);
    out.on('finish', async () => {
      try {
        const sha = hash.digest('hex');
        const target = join(storeDir, sha);
        if (existsSync(target)) await rm(tmp, { force: true });
        else { await chmod(tmp, 0o444); await replaceFile(tmp, target); }
        done(sha);
      } catch (e) { fail(e); }
    });
  });
}

/** A commit object written again with a new tree and parents: the same author, committer, time and message. */
function rewriteCommit(/** @type {string} */ raw, /** @type {string} */ tree, /** @type {string[]} */ parents) {
  const split = raw.indexOf('\n\n');
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split);
  const kept = [];
  let skipping = false;
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) { if (!skipping) kept.push(line); continue; }
    skipping = false;
    if (line.startsWith('tree ') || line.startsWith('parent ')) continue;
    /* a signature no longer matches what it signed */
    if (line.startsWith('gpgsig') || line.startsWith('mergetag ')) { skipping = true; continue; }
    kept.push(line);
  }
  return [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), ...kept].join('\n') + body;
}

/**
 * Bring the history in `gitDir` (an earlier Studio's) up to date; see the header. `progress` hears how far it is.
 * @param {string} root @param {string} gitDir @param {import('./history-store.mjs').Progress} [progress]
 */
export async function migrateHistory(root, gitDir, progress) {
  const old = openRepo(root, gitDir);
  const refLines = (await old.git(['for-each-ref', '--format=%(objectname)%1f%(*objectname)%1f%(refname)', 'refs/heads', 'refs/tags'])).split('\n').filter(Boolean);
  const stashList = await old.git(['stash', 'list', '--format=%H%x1f%gs']).catch(() => '');
  /** @type {{ sha: string, branch: string }[]} */
  const stashes = [];
  for (const line of stashList.split('\n')) {
    const [sha, subject] = line.split('\x1f');
    const branch = /: openfilm:(.+)$/.exec(subject ?? '')?.[1];
    if (sha && branch && !stashes.some((s) => s.branch === branch)) stashes.push({ sha, branch });
  }
  if (!refLines.length) { await markFormat(gitDir); return; }

  const next = join(dirname(gitDir), 'history-next');
  /* a try that stopped half way: Studio's own scratch, made again */
  await rm(next, { recursive: true, force: true });
  await mkdir(join(next, 'info'), { recursive: true });
  const git = (/** @type {string[]} */ args, /** @type {{ input?: string | Buffer, env?: Record<string, string> }} */ o = {}) => gitRun(root, next, args, o);
  await git(['init', '--quiet', '--template=', '--initial-branch=main', `--object-format=${old.algo}`]);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(next, 'info', 'exclude'), '*\n');
  await mkdir(join(next, 'objects', 'info'), { recursive: true });
  await writeFile(join(next, 'objects', 'info', 'alternates'), `${join(gitDir, 'objects')}\n`);
  const neu = openRepo(root, next);
  const storeDir = join(next, 'media');
  await mkdir(storeDir, { recursive: true });

  /** @type {Map<string, string>} old blob → sha256 of it, in the store */
  const extracted = new Map();
  /** @type {Set<string>} pointer blobs written */
  const pointers = new Set();

  /**
   * The same bytes, where the folder still has them at that path: cloned from there (no space taken) rather than
   * read out of git. Returns their sha256, or null.
   */
  const fromFolder = async (/** @type {string} */ path, /** @type {import('./history-store.mjs').Entry} */ e) => {
    const st = await neu.hashes.stat(path);
    if (!st || Number(st.size) !== e.size || await neu.hashes.blob(path, st) !== e.oid) return null;
    const sha256 = await neu.hashes.sha256(path, st);
    await keepMedia(neu, path, { sha256, size: Number(st.size) });
    return sha256;
  };

  /** A version of the old history as one of the new: the film's files only, media in the store. */
  const convert = async (/** @type {import('./history-store.mjs').Version} */ version) => {
    const closure = await filmClosure(versionView(old, version));
    /** @type {import('./history-store.mjs').Version} */
    const out = new Map();
    /** @type {string[]} */
    const fresh = [];
    for (const path of [...closure.keys()].sort()) {
      const e = version.get(path);
      if (!e) continue;
      if (e.media || !isMedia(path, e.size ?? 0)) { out.set(path, e); continue; }
      let sha = extracted.get(e.oid);
      if (!sha) { sha = await fromFolder(path, e) ?? /** @type {string} */ (await extract(old, storeDir, e.oid)); extracted.set(e.oid, sha); }
      const size = e.size ?? 0;
      const text = pointerText(sha, size);
      const file = join(next, `openfilm-ptr-${sha}`);
      if (!pointers.has(text)) { await writeFile(file, text); fresh.push(file); pointers.add(text); }
      out.set(path, { oid: pointerId(neu, sha, size), mode: e.mode, media: { sha256: sha, size }, size });
    }
    if (fresh.length) {
      await git(['hash-object', '-w', '--no-filters', '--stdin-paths'], { input: `${fresh.join('\n')}\n` });
      for (const file of fresh) await rm(file, { force: true });
    }
    return writeTree(neu, out);
  };

  /* every version, parents first */
  const tips = refLines.map((l) => { const [obj, peeled] = l.split('\x1f'); return peeled || obj; });
  const parkedFrom = [];
  for (const { sha } of stashes) {
    const parent = (await old.git(['rev-parse', '--verify', '--quiet', `${sha}^1`]).catch(() => '')).trim();
    if (parent) parkedFrom.push(parent);
  }
  const commits = (await old.git(['rev-list', '--topo-order', '--reverse', ...new Set([...tips, ...parkedFrom])])).split('\n').filter(Boolean);
  /** @type {Map<string, string>} old commit → new */
  const mapped = new Map();
  let done = 0;
  const total = commits.length + stashes.length + 1;
  for (const commit of commits) {
    const tree = await convert(await readVersion(old, commit));
    const raw = await old.git(['cat-file', 'commit', commit]);
    const header = raw.split('\n\n')[0];
    const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => mapped.get(m[1])).filter((p) => p != null);
    const made = (await git(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: rewriteCommit(raw, tree, /** @type {string[]} */ (parents)) })).trim();
    mapped.set(commit, made);
    progress?.({ phase: 'migrate', done: ++done, total });
  }

  /* branches and tags (a named version of an earlier edition) where they were; the branch checked out stays so */
  for (const line of refLines) {
    const [obj, peeled, ref] = line.split('\x1f');
    const to = mapped.get(peeled || obj);
    if (to) await git(['update-ref', ref, to]);
  }
  const headRef = (await old.git(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (headRef) await git(['symbolic-ref', 'HEAD', headRef]);

  /* the changes left on a branch: what the stash holds (its tracked files, then its untracked ones), as a parked version */
  for (const { sha, branch } of stashes) {
    const tracked = await readVersion(old, sha);
    const untracked = await readVersion(old, `${sha}^3`).catch(() => new Map());
    const tree = await convert(new Map([...tracked, ...untracked]));
    const parent = mapped.get((await old.git(['rev-parse', `${sha}^1`])).trim());
    const made = (await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `parked: ${branch}`])).trim();
    await git(['update-ref', `refs/openfilm/parked/${branch}`, made]);
    progress?.({ phase: 'migrate', done: ++done, total });
  }

  /* the branch checked out: what its film uses that history never had (video, mostly), from the folder as it is */
  const tip = (await old.git(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (tip && headRef && mapped.has(tip)) {
    const version = await readVersion(old, tip);
    const closure = await filmClosure(versionView(old, version, folderView(root)));
    const missing = [...closure.keys()].filter((path) => !version.has(path));
    if (missing.length) {
      const base = await readVersion(neu, /** @type {string} */ (mapped.get(tip)));
      const added = await keepFiles(neu, missing, null);
      const tree = await writeTree(neu, new Map([...base, ...added]));
      const made = (await git(['commit-tree', tree, '-p', /** @type {string} */ (mapped.get(tip)), '-m', CLEANUP_MESSAGE])).trim();
      await git(['update-ref', headRef, made]);
    }
  }
  progress?.({ phase: 'migrate', done: ++done, total });

  /* the pictures of the commits, under their new names (the old stay: they are a cache) */
  const posters = join(root, TOOL_DIR, 'cache', 'commits');
  const shots = new Set(await readdir(posters).catch(() => []));
  for (const [from, to] of mapped) {
    if (shots.has(`${from}.jpg`) && !shots.has(`${to}.jpg`)) await copyFile(join(posters, `${from}.jpg`), join(posters, `${to}.jpg`)).catch(() => {});
  }

  /* on its own: every object it needs packed into it, then checked whole */
  await git(['repack', '-a', '-d', '-q']);
  await rm(join(next, 'objects', 'info', 'alternates'), { force: true });
  try {
    await git(['fsck', '--connectivity-only', '--no-progress', '--no-dangling']);
  } catch (e) {
    await rm(next, { recursive: true, force: true });
    throw new HistoryError(`the history could not be brought up to date (${/** @type {Error} */ (e).message}); it is left as it was`, 500);
  }
  await markFormat(next);
  const aside = `${gitDir}-before-cleanup-${Date.now()}`;
  await rename(gitDir, aside);
  await rename(next, gitDir);
  /* the old history: to the Trash, where it can be taken back; left beside the new one if that cannot be done */
  await moveToTrash(aside).catch(() => {});
}
