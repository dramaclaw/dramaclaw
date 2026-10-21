// @ts-check
/**
 * A project's version history: a git repository of its own in `.film/history`. It never touches a `.git` the folder
 * may have (the person's or the agent's own repository): every call names this one explicitly.
 *
 * What a version holds is the film: film.html and every file it uses, as closure.mjs reads them from it (each clip's
 * file, what its pages load, subtitles beside its media, Studio's settings and markers of it). Restoring a version
 * brings all of that back exactly, footage included. Files the film does not use (renders, frames, logs, other takes)
 * are not in history, and history never writes, moves or deletes them. Media is kept by its content outside git, as
 * clones where the disk can (history-store.mjs), so keeping a version of a large project takes moments and no space.
 *
 * It is git, as a person knows it from GitHub: commits on branches, uncommitted changes, switching, merging. Every
 * commit is the person's — made when they commit, with their message — and nothing here commits on its own: going back
 * to a version puts its files in the folder as uncommitted changes, switching branches leaves the changes on the
 * branch they were made on (a parked version, put back on coming back) or brings them along. What a commit changed is
 * told in the film's terms (scenes and sounds added, removed, edited: `summary`), not as files; smaller steps are the
 * editor's undo, not commits.
 *
 * Every action takes an optional `onProgress` (history-store.mjs Progress) to say how far it is; a history an earlier
 * Studio made is brought up to date on first use (history-migrate.mjs).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FILM_FILE, kindOf, readFilmFile } from '../../src/film-doc.mjs';
import { clipFile, filmClosure, folderView, projectFiles } from './closure.mjs';
import { FORMAT, formatOf, markFormat, migrateHistory } from './history-migrate.mjs';
import {
  HistoryError, gitRun, keepFiles, openRepo, readBlobs, readVersion, sameAs, writeFiles, writeTree,
} from './history-store.mjs';
import { TOOL_DIR } from './projects.mjs';
import { moveToTrash } from './trash.mjs';

export { HistoryError };

const run = promisify(execFile);

/** @typedef {import('./history-store.mjs').Progress} Progress */
/** @typedef {{ onProgress?: Progress }} Options */

const historyDir = (/** @type {string} */ root) => join(root, TOOL_DIR, 'history');

/**
 * git, run on the project's history only, on the folder where the project is now: both named on every call, never
 * taken from the history's settings (its `core.worktree` is where the folder was when the history was made, and a
 * project moved or renamed since would have every call fail). Its hooks are never run (history-store.mjs gitRun).
 */
async function git(/** @type {string} */ root, /** @type {string[]} */ args) {
  const gitDir = historyDir(root);
  if (!ownHistory(gitDir)) throw new HistoryError('this project\'s version history was not made by Studio, so Studio does not use it', 409);
  await followMove(root, gitDir);
  return gitRun(root, gitDir, args);
}

/**
 * The settings a history Studio made has: the ones `git init` and `ready` write. A folder from elsewhere (a film
 * downloaded or cloned) can bring a `.film/history` of its own, whose settings would have git run its commands (an
 * fsmonitor, a filter, an include of other settings…). git is never run on such a history; `ready` puts it aside.
 */
const OWN_SETTINGS = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.worktree',
  'core.ignorecase', 'core.precomposeunicode', 'core.symlinks', 'core.autocrlf', 'commit.gpgsign', 'extensions.objectformat', 'extensions.refstorage']);

/** Whether the history in `gitDir` has Studio's settings only (and takes none from elsewhere). None yet counts. */
function ownHistory(/** @type {string} */ gitDir) {
  if (existsSync(join(gitDir, 'commondir'))) return false;
  let text;
  try { text = readFileSync(join(gitDir, 'config'), 'utf8'); } catch { return true; }
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    const header = /^\[([A-Za-z0-9.-]+)\]\s*(.*)$/.exec(line);
    if (header) { section = header[1].toLowerCase(); line = header[2]; }
    else if (line.startsWith('[')) return false;
    if (!line || /^[#;]/.test(line)) continue;
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/.exec(line)?.[1];
    if (!key || line.endsWith('\\') || !OWN_SETTINGS.has(`${section}.${key.toLowerCase()}`)) return false;
  }
  return true;
}

/**
 * The history's own record of its folder (`core.worktree`) put right when the project was moved or renamed since (by
 * this Studio or an earlier one), so git run on it any other way (a person's `git --git-dir`) finds the folder too.
 */
async function followMove(/** @type {string} */ root, /** @type {string} */ gitDir) {
  let text = '';
  try { text = readFileSync(join(gitDir, 'config'), 'utf8'); } catch { return; }
  const value = /^\s*worktree\s*=\s*(.*?)\s*$/m.exec(text)?.[1];
  if (value == null) return;
  /* as git writes it: quoted when it has to be, with \" and \\ escaped */
  const said = value.replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1');
  if (said !== root) await gitRun(root, gitDir, ['config', 'core.worktree', root]);
}

/**
 * The history repository, made on first use (without the person's git templates: nothing in it but git's own), or
 * brought up to date when an earlier Studio made it. Returns it, open.
 * @param {string} root @param {Progress} [progress]
 */
async function ready(root, progress) {
  if (!existsSync(root)) throw new HistoryError('the project\'s folder is not there', 404, 'none');
  const gitDir = historyDir(root);
  if (existsSync(gitDir) && !ownHistory(gitDir)) await rename(gitDir, `${gitDir}-from-elsewhere-${Date.now()}`);
  if (!existsSync(join(gitDir, 'HEAD'))) {
    await mkdir(join(gitDir, 'info'), { recursive: true });
    await git(root, ['init', '--quiet', '--template=', '--initial-branch=main', '--object-format=sha1']);
    await git(root, ['config', 'core.autocrlf', 'false']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    /* git is never shown the folder (history-store.mjs); should a person run it there, it sees nothing */
    await writeFile(join(gitDir, 'info', 'exclude'), '*\n');
    await markFormat(gitDir);
  } else {
    await followMove(root, gitDir);
    if (formatOf(gitDir) < FORMAT) await migrateHistory(root, gitDir, progress);
  }
  return openRepo(root, gitDir);
}

/** Tidy the history now and then, after the answer (git decides when it is worth it; it never blocks anything). */
function maintain(/** @type {string} */ root) {
  void git(root, ['gc', '--auto', '--quiet']).catch(() => {});
}

/** A progress callback that speaks at most ten times a second, and always at the end of a phase. */
function throttled(/** @type {Progress | undefined} */ fn) {
  if (!fn) return undefined;
  let last = 0;
  /** @type {Progress} */
  return (p) => {
    const now = Date.now();
    if (p.done < p.total && now - last < 100) return;
    last = now;
    fn(p);
  };
}

/* ── one thing at a time ─────────────────────────────────────────────────── */

/** @type {Map<string, Promise<void>>} what waits per project */
const queues = new Map();

/**
 * Run `job` once whatever the project is doing in its history is done: two at once would write the same files, and a
 * read in the middle of a switch sees half of it.
 * @template T @param {string} root @param {() => Promise<T>} job @returns {Promise<T>}
 */
function queued(root, job) {
  const next = (queues.get(root) ?? Promise.resolve()).then(job);
  const settled = next.then(() => {}, () => {});
  queues.set(root, settled);
  settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}

/* ── what is there ───────────────────────────────────────────────────────── */

const headOf = async (/** @type {string} */ root) => (await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || null;

/** The branch checked out (a new history's first branch has no commit yet). */
const currentBranch = async (/** @type {string} */ root) => (await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim();

/** @typedef {{ path: string, change: 'added' | 'modified' | 'deleted' }} Change */

/**
 * What the film in the folder holds that the version `head` does not: its files added, changed, or gone (from the
 * folder, or no longer used by the film). Also the film's files now (the closure: path → size).
 * @param {import('./history-store.mjs').Repo} repo @param {string | null} head @param {Progress} [progress]
 * @returns {Promise<{ changes: Change[], closure: Map<string, number> }>}
 */
async function changesNow(repo, head, progress) {
  const closure = await filmClosure(folderView(repo.root));
  const was = head ? await readVersion(repo, head) : new Map();
  /** @type {Change[]} */
  const changes = [];
  const paths = [...new Set([...closure.keys(), ...was.keys()])].sort();
  let done = 0;
  for (const path of paths) {
    const entry = was.get(path);
    if (closure.has(path) && entry) {
      if (!(await sameAs(repo, path, entry))) changes.push({ path, change: 'modified' });
    } else changes.push({ path, change: entry ? 'deleted' : 'added' });
    progress?.({ phase: 'scan', done: ++done, total: paths.length });
  }
  await repo.hashes.save();
  return { changes, closure };
}

/** film.html as it is at `rev` ('' when there is none); `null`: as it is in the folder now. */
async function filmAt(/** @type {string} */ root, /** @type {string | null} */ rev) {
  if (rev == null) return readFile(join(root, FILM_FILE), 'utf8').catch(() => '');
  return git(root, ['show', `${rev}:${FILM_FILE}`]).catch(() => '');
}

/** The clips of a film.html text by id: what each is (a picture or a sound), its file, and all it says, to compare. */
function clipsOf(/** @type {string} */ text) {
  /** @type {Map<string, { sound: boolean, file: string, said: string }>} */
  const clips = new Map();
  const doc = text.trim() ? readFilmFile(text).doc : null;
  for (const track of doc?.tracks ?? []) {
    for (const clip of track.clips) {
      const src = String(clip.src);
      clips.set(clip.id, { sound: kindOf(clip) === 'sound', file: clipFile(src) ?? src, said: JSON.stringify(clip) });
    }
  }
  return { clips, stage: doc ? `${doc.stage.w}x${doc.stage.h}` : '' };
}

/**
 * @typedef {{ added: number, removed: number, edited: number }} Counts
 * @typedef {{ scenes: Counts, sounds: Counts, stage: boolean, other: boolean }} Summary
 *   what changed, as the film tells it: its scenes (the clips with a picture) and its sounds, each added, removed or
 *   edited (moved, trimmed, restyled, or its file changed); `stage`: the picture's size; `other`: files no clip names
 *   changed (a page's shared code, a font): the picture may look different though no clip did
 */

/**
 * What changed from `from` (a commit; null: nothing, the start) to `to` (a commit; null: the folder now), `paths` being
 * the files that changed between them.
 * @param {string} root @param {string | null} from @param {string | null} to @param {string[]} paths @returns {Promise<Summary>}
 */
async function summarize(root, from, to, paths) {
  const before = clipsOf(from ? await filmAt(root, from) : '');
  const after = clipsOf(await filmAt(root, to));
  const changed = new Set(paths);
  const counts = () => ({ added: 0, removed: 0, edited: 0 });
  /** @type {Summary} */
  const summary = { scenes: counts(), sounds: counts(), stage: Boolean(from) && before.stage !== after.stage, other: false };
  const files = new Set();
  for (const [id, clip] of after.clips) {
    files.add(clip.file);
    const was = before.clips.get(id);
    const tally = clip.sound ? summary.sounds : summary.scenes;
    if (!was) tally.added += 1;
    else if (was.said !== clip.said || changed.has(clip.file)) tally.edited += 1;
  }
  for (const [id, clip] of before.clips) {
    if (!after.clips.has(id)) (clip.sound ? summary.sounds : summary.scenes).removed += 1;
  }
  summary.other = paths.some((path) => path !== FILM_FILE && !files.has(path));
  return summary;
}

/** @type {Map<string, Summary>} what each commit changed (a commit never changes, nor does what it changed) */
const summaries = new Map();

/** What `commit` changed from its first parent. */
async function commitSummary(/** @type {string} */ root, /** @type {string} */ commit, /** @type {string | undefined} */ parent) {
  const key = `${root}\0${commit}`;
  const known = summaries.get(key);
  if (known) return known;
  const paths = (await git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit])).split('\0').filter(Boolean);
  const summary = await summarize(root, parent ?? null, commit, paths);
  summaries.set(key, summary);
  if (summaries.size > 5000) summaries.delete(summaries.keys().next().value ?? '');
  return summary;
}

/* a branch's uncommitted changes, left on it when another was switched to: a version of its own under this ref */
const parkedRef = (/** @type {string} */ branch) => `refs/openfilm/parked/${branch}`;

/** The branches whose changes are parked. */
async function parkedBranches(/** @type {string} */ root) {
  const list = await git(root, ['for-each-ref', '--format=%(refname)', 'refs/openfilm/parked']).catch(() => '');
  return new Set(list.split('\n').map((s) => s.slice('refs/openfilm/parked/'.length)).filter(Boolean));
}

/**
 * @typedef {{ name: string, commit: string, at: number, message: string, current: boolean, parked: boolean }} Branch
 * @typedef {{ held: number, heldBytes: number, ignored: number }} Files
 *   the film's files now (in history once committed), and how many other files the folder has (never in history)
 * @typedef {{ branch: string, head: string | null, branches: Branch[], changes: { count: number, summary: Summary } | null, files: Files }} Status
 */

/**
 * Where the history is: the branch checked out, every branch (the most recently committed first), the uncommitted
 * changes (null: none), and what the film holds against what the folder has. A project never committed has no branch
 * to list yet, and all it holds is uncommitted.
 * @param {string} root @param {Options} [o] @returns {Promise<Status>}
 */
export function status(root, { onProgress } = {}) {
  return queued(root, async () => {
    const repo = await ready(root, throttled(onProgress));
    const branch = await currentBranch(root) || 'main';
    const head = await headOf(root);
    const parked = await parkedBranches(root);
    const refs = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%1f%(objectname)%1f%(committerdate:unix)%1f%(contents:subject)', 'refs/heads']);
    const branches = refs.split('\n').filter(Boolean).map((line) => {
      const [name, commit, at, message] = line.split('\x1f');
      return { name, commit, at: Number(at) * 1000, message: shownMessage(message), current: name === branch, parked: parked.has(name) };
    });
    const { changes: paths, closure } = await changesNow(repo, head);
    const changes = paths.length ? { count: paths.length, summary: await summarize(root, head, null, paths.map((p) => p.path)) } : null;
    const all = await projectFiles(root, { sizes: false });
    const files = {
      held: closure.size,
      heldBytes: [...closure.values()].reduce((n, s) => n + s, 0),
      ignored: [...all.keys()].filter((p) => !closure.has(p)).length,
    };
    return { branch, head, branches, changes, files };
  });
}

/**
 * The film's files now, and the folder's other files (which history leaves alone), each with its size, by path.
 * @param {string} root @returns {Promise<{ held: { path: string, size: number }[], ignored: { path: string, size: number }[] }>}
 */
export function historyFiles(root) {
  return queued(root, async () => {
    if (!existsSync(root)) throw new HistoryError('the project\'s folder is not there', 404, 'none');
    const closure = await filmClosure(folderView(root));
    const all = await projectFiles(root);
    const list = (/** @type {Iterable<[string, number]>} */ m) => [...m].map(([path, size]) => ({ path, size })).sort((a, b) => a.path.localeCompare(b.path));
    return { held: list(closure), ignored: list([...all].filter(([p]) => !closure.has(p))) };
  });
}

/**
 * A commit's message as it is shown: a commit Studio's earlier editions made says what it was in their words
 * (`studio: named "Final"`), shown as the name the person gave it.
 */
function shownMessage(/** @type {string} */ subject) {
  const named = /^studio: named "(.*)"$/.exec(subject);
  return named ? named[1] : subject;
}

/* a tag's name is anything a person typed in an earlier edition (a named version); stored encoded */
const decodeName = (/** @type {string} */ tag) => (tag.startsWith('v-') ? Buffer.from(tag.slice(2), 'base64url').toString('utf8') : tag);

/**
 * @typedef {{ commit: string, parents: string[], at: number, message: string, body: string, tags: string[], summary: Summary }} Commit
 */

/**
 * The commits of `ref` (a branch; the one checked out by default), newest first, each with what it changed.
 * @param {string} root @param {{ ref?: string, limit?: number } & Options} [options] @returns {Promise<Commit[]>}
 */
export function log(root, { ref = 'HEAD', limit = 100, onProgress } = {}) {
  return queued(root, async () => {
    const gitDir = historyDir(root);
    if (!existsSync(join(gitDir, 'HEAD')) || !ownHistory(gitDir)) return [];
    await ready(root, throttled(onProgress));
    if (!(await headOf(root))) return [];
    /** @type {Map<string, string[]>} */
    const tags = new Map();
    const refs = await git(root, ['for-each-ref', '--format=%(objectname)%1f%(*objectname)%1f%(refname:strip=2)', 'refs/tags']);
    for (const line of refs.split('\n')) {
      const [tag, peeled, name] = line.split('\x1f');
      const sha = peeled || tag;
      if (sha && name) tags.set(sha, [...(tags.get(sha) ?? []), decodeName(name)]);
    }
    const out = await git(root, ['log', `--max-count=${limit}`, '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e', ref, '--']);
    const commits = [];
    for (const record of out.split('\x1e')) {
      const [commit, parents, at, subject, body] = record.replace(/^\n/, '').split('\x1f');
      if (!commit) continue;
      const parentList = parents ? parents.split(' ').filter(Boolean) : [];
      commits.push({
        commit, parents: parentList, at: Number(at) * 1000, message: shownMessage(subject ?? ''), body: (body ?? '').trim(),
        tags: tags.get(commit) ?? [], summary: await commitSummary(root, commit, parentList[0]),
      });
    }
    return commits;
  });
}

/* ── changing it: only ever when the person asks ─────────────────────────── */

/** A commit or branch the person named, as git knows it: its full id, or a 404. */
async function resolveCommit(/** @type {string} */ root, /** @type {string} */ rev) {
  if (!/^[0-9a-f]{7,64}$/.test(String(rev))) throw new HistoryError('which commit?', 400, 'none');
  const full = (await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).catch(() => '')).trim();
  if (!full) throw new HistoryError('no such commit', 404, 'none');
  return full;
}

const needClean = async (/** @type {import('./history-store.mjs').Repo} */ repo, /** @type {string | null} */ head) => {
  if ((await changesNow(repo, head)).changes.length) throw new HistoryError('there are uncommitted changes: commit or discard them first', 409, 'dirty');
};

/** The film's files in the folder now, kept as a tree (`head`: the version they are compared with). */
async function keepFolder(/** @type {import('./history-store.mjs').Repo} */ repo, /** @type {string | null} */ head, /** @type {Progress | undefined} */ progress) {
  const closure = await filmClosure(folderView(repo.root));
  const version = await keepFiles(repo, closure.keys(), head ? await readVersion(repo, head) : null, progress);
  return writeTree(repo, version);
}

/**
 * Commit the uncommitted changes with the person's message (its first line is the summary). The first commit of a
 * project takes all the film holds. Returns the commit.
 * @param {string} root @param {string} message @param {Options} [o]
 */
export function commitChanges(root, message, { onProgress } = {}) {
  return queued(root, async () => {
    const text = String(message ?? '').trim().slice(0, 5000);
    if (!text) throw new HistoryError('a commit needs a message', 400, 'message');
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const head = await headOf(root);
    const branchRef = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || 'refs/heads/main';
    const tree = await keepFolder(repo, head, progress);
    if (head && tree === (await git(root, ['rev-parse', `${head}^{tree}`])).trim()) throw new HistoryError('nothing to commit', 409, 'nothing');
    const commit = (await git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', text])).trim();
    await git(root, ['update-ref', '-m', `commit: ${text.split('\n')[0]}`, branchRef, commit, head ?? '']);
    maintain(root);
    return commit;
  });
}

/**
 * Put the film back as the last commit holds it: its files written where they differ. A file the film takes that the
 * commit does not have (made since, beside a page) goes to the trash, as a delete in Studio does, so a discard can be
 * taken back from there; files the film does not use are left as they are.
 * @param {string} root @param {Options} [o]
 */
export function discardChanges(root, { onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const head = await headOf(root);
    if (!head) throw new HistoryError('nothing is committed yet, so there is nothing to go back to', 409, 'nothing');
    await writeFiles(repo, await readVersion(repo, head), { progress });
    for (const { path, change } of (await changesNow(repo, head)).changes) {
      if (change === 'added' && existsSync(join(root, path))) await moveToTrash(join(root, path));
    }
  });
}

/**
 * Put the film as `commit` holds it, as uncommitted changes on the branch checked out: nothing is committed, the
 * person commits them (or discards them, which comes back to where it was). Asked with uncommitted changes, it says so
 * ('dirty'): they would be lost. Returns the commit, and the media it holds that could not be found (none, unless
 * the history's store lost some).
 * @param {string} root @param {string} commit @param {Options} [o]
 */
export function restoreCommit(root, commit, { onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const full = await resolveCommit(root, commit);
    await needClean(repo, await headOf(root));
    const { missing } = await writeFiles(repo, await readVersion(repo, full), { progress });
    return { commit: full, missing };
  });
}

/** A branch name a person typed, as git takes it (spaces become dashes), or a 400. */
async function branchName(/** @type {string} */ root, /** @type {string} */ name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, '-');
  if (!clean || clean.length > 100) throw new HistoryError('a branch needs a name', 400, 'name');
  const ok = await git(root, ['check-ref-format', '--branch', clean]).then(() => true, () => false);
  if (!ok || clean.startsWith('-')) throw new HistoryError(`"${clean}" cannot be a branch name`, 400, 'name');
  return clean;
}

const branchExists = async (/** @type {string} */ root, /** @type {string} */ name) => Boolean(await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).catch(() => ''));

/** The paths whose files differ between two versions. */
function differing(/** @type {import('./history-store.mjs').Version} */ a, /** @type {import('./history-store.mjs').Version} */ b) {
  const out = new Set();
  for (const [path, e] of a) if (b.get(path)?.oid !== e.oid) out.add(path);
  for (const path of b.keys()) if (!a.has(path)) out.add(path);
  return out;
}

/**
 * Leave the film's uncommitted changes on `branch`: the folder's film kept as a version of its own (`parkedRef`),
 * put back when the branch is checked out again. An older one left there and not put back stays in its history.
 */
async function park(/** @type {import('./history-store.mjs').Repo} */ repo, /** @type {string} */ branch, /** @type {string} */ head, /** @type {Progress | undefined} */ progress) {
  const tree = await keepFolder(repo, head, progress);
  const older = (await git(repo.root, ['rev-parse', '--verify', '--quiet', parkedRef(branch)]).catch(() => '')).trim();
  const commit = (await git(repo.root, ['commit-tree', tree, '-p', head, ...(older ? ['-p', older] : []), '-m', `parked: ${branch}`])).trim();
  await git(repo.root, ['update-ref', parkedRef(branch), commit]);
}

/**
 * Put back the changes left on `branch`, if any, over the version `tip` now in the folder. False when they collide
 * (the branch changed the same files since, or `carried` changes did): they stay parked.
 * @param {import('./history-store.mjs').Repo} repo @param {string} branch @param {string} tip @param {Set<string>} carried @param {Progress} [progress]
 */
async function unpark(repo, branch, tip, carried, progress) {
  const parked = (await git(repo.root, ['rev-parse', '--verify', '--quiet', parkedRef(branch)]).catch(() => '')).trim();
  if (!parked) return true;
  const base = (await git(repo.root, ['rev-parse', `${parked}^1`])).trim();
  const left = await readVersion(repo, parked);
  const changed = differing(await readVersion(repo, base), left);
  const moved = base === tip ? new Set() : differing(await readVersion(repo, base), await readVersion(repo, tip));
  if ([...changed].some((p) => moved.has(p) || carried.has(p))) return false;
  await writeFiles(repo, left, { paths: changed, progress });
  await git(repo.root, ['update-ref', '-d', parkedRef(branch)]);
  return true;
}

/**
 * Check out `target` (a branch, or `create` one first, from `from`: a commit; the one checked out by default). The
 * uncommitted changes are left on the branch they were made on (`carry` 'leave', put back when it is checked out again)
 * or brought along ('bring': refused with 'conflict' when they collide with what the other branch holds). Changes left
 * on `target` before come back. Returns whether they did (false: they collide and stay parked).
 * @param {string} root @param {{ target: string, create?: boolean, from?: string, carry?: 'leave' | 'bring' } & Options} o
 */
export function checkout(root, { target, create = false, from, carry = 'leave', onProgress }) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const head = await headOf(root);
    if (!head) throw new HistoryError('commit once before making branches', 409, 'nothing');
    const name = await branchName(root, target);
    const here = await currentBranch(root);
    if (create && await branchExists(root, name)) throw new HistoryError(`a branch "${name}" exists already`, 409, 'exists');
    if (!create && !(await branchExists(root, name))) throw new HistoryError(`no branch "${name}"`, 404, 'none');
    if (!create && name === here) return true;
    const to = create ? (from ? await resolveCommit(root, from) : head) : (await git(root, ['rev-parse', `refs/heads/${name}`])).trim();
    const checkOut = async () => {
      if (create) await git(root, ['update-ref', '-m', `branch: from ${to}`, `refs/heads/${name}`, to, '']);
      await git(root, ['symbolic-ref', '-m', `checkout: to ${name}`, 'HEAD', `refs/heads/${name}`]);
    };
    /* a new branch where the folder is: the changes simply go with it, nothing to leave or bring */
    if (create && to === head) { await checkOut(); return true; }
    const { changes } = await changesNow(repo, head, progress);
    const dirty = new Set(changes.map((c) => c.path));
    const goal = await readVersion(repo, to);
    if (carry === 'bring' && dirty.size) {
      /* what the other branch holds differently from here, where the person changed it too: refused, nothing moved */
      const differ = differing(await readVersion(repo, head), goal);
      for (const path of dirty) {
        if (differ.has(path) && !(await sameAs(repo, path, goal.get(path)))) throw new HistoryError('the uncommitted changes collide with what that branch holds', 409, 'conflict');
      }
      await writeFiles(repo, goal, { paths: [...differ].filter((p) => !dirty.has(p)), progress });
      await checkOut();
      return unpark(repo, name, to, dirty, progress);
    }
    if (dirty.size && here) await park(repo, here, head, progress);
    await writeFiles(repo, goal, { progress });
    await checkOut();
    return unpark(repo, name, to, new Set(), progress);
  });
}

/** Rename a branch (its parked changes go with it). */
export function renameBranch(/** @type {string} */ root, /** @type {string} */ from, /** @type {string} */ to) {
  return queued(root, async () => {
    await ready(root);
    const old = await branchName(root, from);
    const name = await branchName(root, to);
    if (!(await branchExists(root, old))) throw new HistoryError(`no branch "${old}"`, 404, 'none');
    if (old === name) return name;
    if (await branchExists(root, name)) throw new HistoryError(`a branch "${name}" exists already`, 409, 'exists');
    await git(root, ['branch', '-m', old, name]);
    const parked = (await git(root, ['rev-parse', '--verify', '--quiet', parkedRef(old)]).catch(() => '')).trim();
    if (parked) {
      await git(root, ['update-ref', parkedRef(name), parked]);
      await git(root, ['update-ref', '-d', parkedRef(old)]);
    }
    return name;
  });
}

/**
 * Delete a branch (not the one checked out). One with commits on no other branch is refused ('unmerged', with how
 * many) unless `force`: those commits would be gone. Its parked changes go too.
 * @param {string} root @param {string} name @param {{ force?: boolean }} [o]
 */
export function deleteBranch(root, name, { force = false } = {}) {
  return queued(root, async () => {
    await ready(root);
    const branch = await branchName(root, name);
    if (!(await branchExists(root, branch))) throw new HistoryError(`no branch "${branch}"`, 404, 'none');
    if (branch === await currentBranch(root)) throw new HistoryError('the branch checked out cannot be deleted', 409, 'current');
    if (!force) {
      /* its commits no other branch has (`--exclude` takes a name as `--branches` sees it, without refs/heads/) */
      const only = Number((await git(root, ['rev-list', '--count', branch, '--not', `--exclude=${branch}`, '--branches'])).trim());
      if (only > 0) throw Object.assign(new HistoryError(`"${branch}" has ${only} commit(s) on no other branch`, 409, 'unmerged'), { commits: only });
    }
    await git(root, ['branch', '-D', branch]);
    await git(root, ['update-ref', '-d', parkedRef(branch)]).catch(() => {});
  });
}

/**
 * Merge the trees of `ours` and `theirs` from `base`, as `git merge` would, in a scratch index: what one side changed
 * is taken; where both changed one file, its text is merged line by line. What both changed in the same place (or a
 * media file both changed, or one changed and the other deleted) is a conflict, unless `prefer` says whose side wins.
 * Returns the tree.
 * @param {import('./history-store.mjs').Repo} repo @param {string} base @param {string} ours @param {string} theirs @param {'ours' | 'theirs'} [prefer]
 */
async function mergeTrees(repo, base, ours, theirs, prefer) {
  const index = join(repo.gitDir, `openfilm-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  const scratch = join(tmpdir(), `openfilm-merge-${randomBytes(6).toString('hex')}`);
  const conflict = () => new HistoryError('the two branches changed the same thing', 409, 'conflict');
  try {
    await repo.git(['read-tree', '-m', '-i', '--aggressive', base, ours, theirs], { env });
    const unmerged = await repo.git(['ls-files', '-u', '-z'], { env });
    /** @type {Map<string, Record<string, { mode: string, oid: string }>>} */
    const stages = new Map();
    for (const line of unmerged.split('\0')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const [mode, oid, stage] = line.slice(0, tab).split(' ');
      const path = line.slice(tab + 1);
      stages.set(path, { ...(stages.get(path) ?? {}), [stage]: { mode, oid } });
    }
    if (!stages.size) return (await repo.git(['write-tree'], { env })).trim();
    const [oursV, theirsV] = [await readVersion(repo, ours), await readVersion(repo, theirs)];
    const zero = '0'.repeat(repo.algo === 'sha256' ? 64 : 40);
    const lines = [];
    await mkdir(scratch, { recursive: true });
    for (const [path, s] of stages) {
      const [b, o, t] = [s['1'], s['2'], s['3']];
      const pick = prefer === 'ours' ? o : prefer === 'theirs' ? t : undefined;
      let result = /** @type {{ mode: string, oid: string } | null | undefined} */ (undefined);
      if (!o || !t || oursV.get(path)?.media || theirsV.get(path)?.media) {
        if (!prefer) throw conflict();
        result = pick ?? null;
      } else {
        const blobs = await readBlobs(repo, [o.oid, t.oid, ...(b ? [b.oid] : [])]);
        const files = ['ours', 'base', 'theirs'].map((n) => join(scratch, n));
        await writeFile(files[0], blobs.get(o.oid) ?? '');
        await writeFile(files[1], b ? blobs.get(b.oid) ?? '' : '');
        await writeFile(files[2], blobs.get(t.oid) ?? '');
        const merged = await run('git', ['merge-file', '-p', ...(prefer ? [`--${prefer}`] : []), ...files], { maxBuffer: 64 << 20, windowsHide: true })
          .then((r) => r.stdout, () => null);
        if (merged == null) {
          /* conflicts left (without `prefer`), or files it cannot merge (binary) */
          if (!prefer) throw conflict();
          result = pick ?? null;
        } else {
          const oid = (await repo.git(['hash-object', '-w', '--stdin'], { input: merged })).trim();
          result = { mode: o.mode, oid };
        }
      }
      lines.push(`0 ${zero}\t${path}`);
      if (result) lines.push(`${result.mode} ${result.oid}\t${path}`);
    }
    await repo.git(['update-index', '--index-info'], { input: `${lines.join('\n')}\n`, env });
    return (await repo.git(['write-tree'], { env })).trim();
  } finally {
    await rm(index, { force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Merge `branch` into the one checked out, with the person's message (a merge that only moves forward makes no commit
 * of its own). Where both changed the same thing it stops ('conflict'), unless `prefer` says whose wins there: 'ours'
 * (the branch checked out) or 'theirs'. Needs no uncommitted changes ('dirty'). Returns false when there was nothing to
 * merge.
 * @param {string} root @param {{ branch: string, message: string, prefer?: 'ours' | 'theirs' } & Options} o
 */
export function mergeBranch(root, { branch, message, prefer, onProgress }) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const name = await branchName(root, branch);
    if (!(await branchExists(root, name))) throw new HistoryError(`no branch "${name}"`, 404, 'none');
    if (name === await currentBranch(root)) throw new HistoryError('a branch is not merged into itself', 409, 'current');
    const head = /** @type {string} */ (await headOf(root));
    await needClean(repo, head);
    const branchRef = (await git(root, ['symbolic-ref', '--quiet', 'HEAD'])).trim();
    const theirs = (await git(root, ['rev-parse', `refs/heads/${name}`])).trim();
    const isAncestor = (/** @type {string} */ a, /** @type {string} */ b) => git(root, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
    if (await isAncestor(theirs, head)) return false;
    const text = String(message ?? '').trim() || `Merge ${name}`;
    let commit = theirs;
    if (!(await isAncestor(head, theirs))) {
      const base = (await git(root, ['merge-base', head, theirs]).catch(() => '')).trim();
      if (!base) throw new HistoryError(`"${name}" and this branch share no version`, 409, 'conflict');
      const tree = await mergeTrees(repo, base, head, theirs, prefer).catch((e) => {
        throw e instanceof HistoryError && e.code === 'conflict' ? new HistoryError(`"${name}" and this branch changed the same thing`, 409, 'conflict') : e;
      });
      commit = (await git(root, ['commit-tree', tree, '-p', head, '-p', theirs, '-m', text])).trim();
    }
    await git(root, ['update-ref', '-m', `merge ${name}`, branchRef, commit, head]);
    await writeFiles(repo, await readVersion(repo, commit), { progress });
    maintain(root);
    return true;
  });
}
