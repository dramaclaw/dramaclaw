// @ts-check
/**
 * A project's version history: a git repository of its own in `.film/history`. It never touches a `.git` the folder
 * may have (the person's or the agent's own repository): every call names this one explicitly.
 *
 * A version holds the project: film.html and every file it uses (closure.mjs), and every other file of the folder
 * that is not a video, a sound or a picture the film does not use, nor larger than UNUSED_MAX (versionFiles). So the
 * pages, their code, data and fonts, Studio's settings and markers of the film, and the agent's notes and scripts are
 * all kept, however a page names them; renders, frames and other takes are not, and history never writes, moves or
 * deletes them. Media is kept by its content outside git, as clones where the disk can (history-store.mjs), so keeping
 * a version of a large project takes moments and no space.
 *
 * It is git as VS Code's Source Control shows it: the folder's changes against the version checked out, committed
 * as a version (with the person's message, or on its own while they work when they asked for that:
 * auto-versions.mjs), and every version drawn as a graph. Checking one out makes the folder hold its files, as git
 * does, and makes no version of its own; with changes it is refused unless they are discarded. A commit on a version
 * checked out on its own goes on main from there; main's later versions stay, on a line of their own. What a version
 * changed is also told in the film's terms (scenes and sounds added, removed, edited: `summary`), which decides
 * whether one is saved on its own.
 *
 * Each version is a commit. Its message is the person's (or what kind of version it is) and a trailer saying its
 * kind: `Openfilm-Version: named` and so on (Kind). Histories of earlier editions had branches, names as tags and
 * changes parked on branches: their versions are listed too, and any of them can be checked out.
 *
 * Every action takes an optional `onProgress` (history-store.mjs Progress) to say how far it is; a history an earlier
 * Studio made is brought up to date on first use (history-migrate.mjs).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_FILE, kindOf, readFilmFile } from '../../src/film-doc.mjs';
import { STUDIO_STATE, clipFile, filmClosure, folderView, isMediaFile, projectFiles } from './closure.mjs';
import { FORMAT, formatOf, markFormat, migrateHistory, upgradeHistory } from './history-migrate.mjs';
import {
  HistoryError, gitRun, keepFiles, openRepo, readVersion, sameAs, writeFiles, writeTree,
} from './history-store.mjs';
import { TOOL_DIR } from './projects.mjs';
import { moveToTrash } from './trash.mjs';
import { readDeletedVersions, writeDeletedVersions } from './history-deleted.mjs';

export { HistoryError };

/** @typedef {import('./history-store.mjs').Progress} Progress */
/** @typedef {{ onProgress?: Progress }} Options */

const historyDir = (/** @type {string} */ root) => join(root, TOOL_DIR, 'history');

/**
 * git, run on the project's history only, on the folder where the project is now: both named on every call, never
 * taken from the history's settings (its `core.worktree` is where the folder was when the history was made, and a
 * project moved or renamed since would have every call fail). Its hooks are never run (history-store.mjs gitRun).
 */
async function git(/** @type {string} */ root, /** @type {string[]} */ args, /** @type {{ input?: string | Buffer }} */ o = {}) {
  const gitDir = historyDir(root);
  if (!ownHistory(gitDir)) throw new HistoryError('this project\'s version history was not made by Studio, so Studio does not use it', 409);
  /* a history being made has no settings of its own to put right yet */
  if (existsSync(join(gitDir, 'HEAD'))) await followMove(root, gitDir);
  return gitRun(root, gitDir, args, o);
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
  /* git takes a folder for a history only with these in it, empty as they are until the first version: a copy or a
     sync that leaves out empty folders would have every call fail ("not in a git directory") */
  if (existsSync(join(gitDir, 'HEAD'))) {
    for (const dir of ['objects', join('refs', 'heads'), join('refs', 'tags')]) await mkdir(join(gitDir, dir), { recursive: true });
  }
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
    const format = formatOf(gitDir);
    if (format < 2) await migrateHistory(root, gitDir, versionFiles, progress);
    else if (format < FORMAT) await upgradeHistory(root, gitDir, versionFiles);
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

/** Larger than this, a file the film does not use is not kept (a disk image, an archive, a project of another app). */
export const UNUSED_MAX = 50 << 20;

/* what is never the project's own, wherever it is: a tool's dot folder or file, what builds and packages make */
const NOT_KEPT = /(^|\/)(\.[^/]*|node_modules|dist|build)(\/|$)/;

/**
 * The files a version of the folder at `root` holds: path → size. The film's (filmClosure), and the folder's others
 * but videos, sounds and pictures, files over UNUSED_MAX, and what NOT_KEPT says. None without a film.html.
 * @param {string} root @returns {Promise<Map<string, number>>}
 */
export async function versionFiles(root) {
  const held = await filmClosure(folderView(root));
  if (!held.size) return held;
  for (const [path, size] of await projectFiles(root)) {
    if (!held.has(path) && !isMediaFile(path) && size <= UNUSED_MAX && !NOT_KEPT.test(path)) held.set(path, size);
  }
  return held;
}

/** @typedef {{ path: string, change: 'added' | 'modified' | 'deleted' }} Change */

/**
 * What the film in the folder holds that the version `head` does not: its files added, changed, or gone (from the
 * folder, or no longer used by the film). Also the film's files now (the closure: path → size).
 * @param {import('./history-store.mjs').Repo} repo @param {string | null} head @param {Progress} [progress]
 * @returns {Promise<{ changes: Change[], closure: Map<string, number> }>}
 */
async function changesNow(repo, head, progress) {
  const closure = await versionFiles(repo.root);
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
 *   changed that a page may draw with (its shared code, a font, a picture): the picture may look different though no
 *   clip did. Notes, scripts and Studio's markers change nothing of the picture.
 */

/* what a page may draw with */
const PICTURE = /\.(html?|css|[cm]?js|json|svg|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|mp4|mov|m4v|webm|mp3|m4a|wav|aac|ogg|opus|flac)$/i;

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
  summary.other = paths.some((path) => path !== FILM_FILE && !files.has(path) && PICTURE.test(path) && !path.startsWith(`${TOOL_DIR}/`));
  return summary;
}

/** Whether `summary` changes the film: a scene or a sound, the picture's size, or a file its pages draw with. */
const filmChanged = (/** @type {Summary} */ summary) => summary.stage || summary.other
  || [summary.scenes, summary.sounds].some((c) => c.added || c.removed || c.edited);

/**
 * @typedef {{ head: string | null, branch: string | null, changes: { count: number, summary: Summary, files: Change[] } | null, filmMissing?: boolean }} Status
 *   `branch`: the branch checked out (null: a version checked out on its own, as git's detached HEAD)
 */

/** How many changed files a status lists (the count says how many there are). */
const LISTED = 500;

/**
 * Where the history is: the version checked out (null: none yet), and what the folder holds that it does not: the
 * files added, modified and deleted, and what that does to the film (null: nothing). A project never saved holds all
 * it has as changes. `filmMissing`: the folder has no film.html, so all the version holds counts as deleted, and
 * restoreFilm is how it comes back.
 * @param {string} root @param {Options} [o] @returns {Promise<Status>}
 */
export function status(root, { onProgress } = {}) {
  return queued(root, async () => {
    const repo = await ready(root, throttled(onProgress));
    const head = await headOf(root);
    const { changes: files } = await changesNow(repo, head);
    const changes = files.length
      ? { count: files.length, summary: await summarize(root, head, null, files.map((p) => p.path)), files: files.slice(0, LISTED) }
      : null;
    return { head, branch: head ? (await currentBranch(root)) || null : 'main', changes, ...(filmIsMissing(root) ? { filmMissing: true } : {}) };
  });
}

/** Whether the folder at `root` has no film.html (a version then holds none of its files: versionFiles). */
const filmIsMissing = (/** @type {string} */ root) => !statSync(join(root, FILM_FILE), { throwIfNoEntry: false })?.isFile();

/**
 * What a version is, as its trailer says: `named` (saved by the person with a message), `saved` (by the person,
 * without one), `auto` (on its own while they worked), `agent` (on its own before an agent's turn), `upgrade` (what an
 * earlier history did not keep, added when it was brought up to date), `parked` (changes an earlier edition left on a
 * branch); `before-restore` and `restore` from an edition that saved a version to restore one. A commit with no trailer
 * is the person's, named by its message.
 * @typedef {'named' | 'saved' | 'auto' | 'agent' | 'before-restore' | 'restore' | 'upgrade' | 'parked'} Kind
 */
const KINDS = new Set(['named', 'saved', 'auto', 'agent', 'before-restore', 'restore', 'upgrade', 'parked']);

/** The subject a version of `kind` gets when the person gave it no message (what plain git shows of it). */
const SUBJECT = { saved: 'Saved version', auto: 'Auto-saved', agent: 'Before agent\'s turn', upgrade: 'Kept all the project\'s files' };

/** A version's message: its subject, then the trailer saying its kind. */
const messageOf = (/** @type {Kind} */ kind, /** @type {string} */ text) =>
  `${text || SUBJECT[/** @type {keyof typeof SUBJECT} */ (kind)] || kind}\n\nOpenfilm-Version: ${kind}\n`;

/* a name an earlier edition gave a version: a tag on it, `v-<the name, base64url>[.<the version's first hex>]` */
const decodeName = (/** @type {string} */ tag) => (tag.startsWith('v-') ? Buffer.from(tag.slice(2).split('.')[0], 'base64url').toString('utf8') : tag);

/**
 * @typedef {{ commit: string, parents: string[], at: number, kind: Kind, name: string, restored: string | null }} Version
 *   `name`: the person's message ('' when there is none: it is told by its kind); `restored`: the version a
 *   `restore` of an earlier edition brought back
 */

/* where the versions are: every branch, what HEAD is on, the line a commit on a checked-out version moved aside
   (`kept`), and what an earlier edition parked */
const ALL_VERSIONS = ['HEAD', '--branches', '--glob=refs/openfilm/kept/*', '--glob=refs/openfilm/parked/*'];

/**
 * The versions of the project, newest first, `limit` of them (more: there are older ones), each with its parents, so
 * they draw as a graph.
 * @param {string} root @param {{ limit?: number, deleted?: boolean, includeDeletedCount?: boolean } & Options} [options] @returns {Promise<{ versions: Version[], more: boolean, deletedCount?: number }>}
 */
export function log(root, { limit = 50, deleted = false, includeDeletedCount = false, onProgress } = {}) {
  return queued(root, async () => {
    const gitDir = historyDir(root);
    if (!existsSync(join(gitDir, 'HEAD')) || !ownHistory(gitDir)) return { versions: [], more: false, ...(includeDeletedCount ? { deletedCount: 0 } : {}) };
    await ready(root, throttled(onProgress));
    const head = await headOf(root);
    if (!head) return { versions: [], more: false, ...(includeDeletedCount ? { deletedCount: 0 } : {}) };
    const removed = await readDeletedVersions(gitDir);
    removed.delete(head);
    const extra = includeDeletedCount ? { deletedCount: removed.size } : {};
    if (deleted && !removed.size) return { versions: [], more: false, ...extra };
    /** @type {Map<string, string>} */
    const names = new Map();
    const refs = await git(root, ['for-each-ref', '--sort=creatordate', '--format=%(objectname)%1f%(*objectname)%1f%(refname:strip=2)', 'refs/tags']);
    for (const line of refs.split('\n')) {
      const [tag, peeled, name] = line.split('\x1f');
      const sha = peeled || tag;
      if (sha && name) names.set(sha, decodeName(name));
    }
    const format = '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e';
    const out = deleted
      ? await git(root, ['log', '--no-walk=sorted', format, '--stdin', '--'], { input: [...removed.keys()].join('\n') + '\n' })
      : await git(root, ['log', '--date-order', `--max-count=${limit + removed.size + 1}`, format, ...ALL_VERSIONS, '--']);
    /** @type {Version[]} */
    const versions = [];
    for (const record of out.split('\x1e')) {
      const [commit, parents = '', at, subject = '', body = ''] = record.replace(/^\n/, '').split('\x1f');
      if (!commit) continue;
      if (!deleted && removed.has(commit)) continue;
      if (deleted && !removed.has(commit)) continue;
      const said = /^Openfilm-Version: (\S+)$/m.exec(body)?.[1] ?? '';
      const parked = /^parked: (.*)$/.exec(subject);
      const kind = /** @type {Kind} */ (KINDS.has(said) ? said : parked ? 'parked' : 'named');
      const own = kind === 'named' ? shownMessage(subject) : kind === 'parked' ? (parked?.[1] ?? '') : '';
      versions.push({
        commit, parents: parents.split(' ').filter(Boolean), at: Number(at) * 1000, kind, name: names.get(commit) ?? own,
        restored: /^Openfilm-Restored: ([0-9a-f]+)$/m.exec(body)?.[1] ?? null,
      });
    }
    /** @param {string} id @returns {string[]} */
    const nearest = (id) => {
      const pending = [id], seen = new Set();
      /** @type {string[]} */
      const found = [];
      while (pending.length) {
        const next = pending.pop();
        if (!next || seen.has(next)) continue;
        seen.add(next);
        const entry = removed.get(next);
        if (entry) pending.push(...[...entry.parents].reverse()); else found.push(next);
      }
      return found;
    };
    const visible = deleted ? versions : versions.map((version) => ({ ...version, parents: [...new Set(version.parents.flatMap((parent) => nearest(parent)))] }));
    return { versions: visible.slice(0, limit), more: visible.length > limit, ...extra };
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

/**
 * The files a version changed from the one before it (its first parent; none: all it holds is added), as git's
 * status letters say them.
 * @param {string} root @param {string} commit @returns {Promise<Change[]>}
 */
export function versionFilesChanged(root, commit) {
  return queued(root, async () => {
    await ready(root);
    const full = await resolveCommit(root, commit);
    const out = await git(root, ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', full]);
    const parts = out.split('\0').filter(Boolean);
    /** @type {Change[]} */
    const files = [];
    const CHANGE = /** @type {Record<string, Change['change']>} */ ({ A: 'added', M: 'modified', D: 'deleted', T: 'modified' });
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ path: parts[i + 1], change: CHANGE[parts[i][0]] ?? 'modified' });
    return files;
  });
}

/* ── changing it ─────────────────────────────────────────────────────────── */

/** A version the person named, as git knows it: its full id, or a 404. */
async function resolveCommit(/** @type {string} */ root, /** @type {string} */ rev) {
  if (!/^[0-9a-f]{7,64}$/.test(String(rev))) throw new HistoryError('which version?', 400, 'none');
  const full = (await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).catch(() => '')).trim();
  if (!full) throw new HistoryError('no such version', 404, 'none');
  if ((await readDeletedVersions(historyDir(root))).has(full) && full !== await headOf(root)) throw new HistoryError('this version was deleted; recover it first', 409, 'deleted');
  return full;
}

/** Resolve a bounded selection in one Git call, before changing any records.
 * @param {string} root @param {unknown} commits @returns {Promise<Map<string, string[]>>}
 */
async function selectedCommits(root, commits) {
  if (!Array.isArray(commits) || !commits.length || commits.length > 1000 || !commits.every((id) => typeof id === 'string' && /^[0-9a-f]{7,64}$/.test(id))) throw new HistoryError('select 1 to 1000 versions', 400, 'selection');
  const ids = [...new Set(/** @type {string[]} */ (commits))];
  const out = await git(root, ['log', '--no-walk=unsorted', '--format=%H%x1f%P', '--stdin', '--'], { input: ids.join('\n') + '\n' }).catch(() => { throw new HistoryError('no such version', 404, 'none'); });
  const found = new Map(out.trim().split('\n').filter(Boolean).map((line) => { const [id, parents = ''] = line.split('\x1f'); return [id, parents.split(' ').filter(Boolean)]; }));
  if (ids.some((id) => ![...found.keys()].some((full) => full.startsWith(id)))) throw new HistoryError('no such version', 404, 'none');
  return found;
}

/** Move selected records out of the active history. Snapshots stay recoverable; no working file or Git ref moves.
 * @param {string} root @param {unknown} commits
 */
export function deleteVersions(root, commits) {
  return queued(root, async () => {
    await ready(root);
    const found = await selectedCommits(root, commits);
    if (found.has(await headOf(root) ?? '')) throw new HistoryError('the version currently in use cannot be deleted', 409, 'current');
    const removed = await readDeletedVersions(historyDir(root));
    for (const [id, parents] of found) if (!removed.has(id)) removed.set(id, { at: Date.now(), parents });
    await writeDeletedVersions(historyDir(root), removed);
    return { commits: [...found.keys()] };
  });
}

/** Recover deleted records, without checking them out or changing any files.
 * @param {string} root @param {unknown} commits
 */
export function recoverVersions(root, commits) {
  return queued(root, async () => {
    await ready(root);
    const found = await selectedCommits(root, commits);
    const removed = await readDeletedVersions(historyDir(root));
    for (const id of found.keys()) removed.delete(id);
    await writeDeletedVersions(historyDir(root), removed);
    return { commits: [...found.keys()] };
  });
}

/** The files a version holds, as they are in the folder now, kept as a tree (`head`: the version they are compared with). */
async function keepFolder(/** @type {import('./history-store.mjs').Repo} */ repo, /** @type {string | null} */ head, /** @type {Progress | undefined} */ progress) {
  const files = await versionFiles(repo.root);
  const version = await keepFiles(repo, files.keys(), head ? await readVersion(repo, head) : null, progress);
  return writeTree(repo, version);
}

const treeOf = async (/** @type {string} */ root, /** @type {string} */ commit) => (await git(root, ['rev-parse', `${commit}^{tree}`])).trim();
const isAncestor = (/** @type {string} */ root, /** @type {string} */ a, /** @type {string} */ b) => git(root, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);

/**
 * Commit the folder as a version. On a branch, it goes on it. On a version checked out on its own (detached), it goes
 * on main from there, as the newest; main's versions after that one stay in the history, on a line of their own
 * (`refs/openfilm/kept/<its tip>`), and main is checked out again. Null when the folder holds the version checked out.
 * Not queued: the caller is.
 * @param {import('./history-store.mjs').Repo} repo @param {Kind} kind @param {string} text @param {Progress} [progress]
 */
async function commitFolder(repo, kind, text, progress) {
  const root = repo.root;
  const head = await headOf(root);
  const tree = await keepFolder(repo, head, progress);
  if (head && tree === await treeOf(root, head)) return null;
  const commit = (await git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: messageOf(kind, text) })).trim();
  const branch = (await git(root, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (branch || !head) {
    await git(root, ['update-ref', '-m', `${kind}: ${text || kind}`, branch || 'refs/heads/main', commit, head ?? '']);
  } else {
    const main = (await git(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']).catch(() => '')).trim();
    if (main && !(await isAncestor(root, main, commit))) await git(root, ['update-ref', `refs/openfilm/kept/${main}`, main]);
    await git(root, ['update-ref', '-m', `${kind}: ${text || kind}`, 'refs/heads/main', commit]);
    await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  maintain(root);
  return commit;
}

/**
 * Commit the folder as a version. By the person: `message` is theirs (none: 'saved'); with nothing changed it is
 * refused ('nothing'). On its own (`kind` 'auto' or 'agent'): null unless the film changed (filmChanged). Returns the
 * version. Without film.html there is none to save (it would hold nothing: versionFiles): refused ('missing-film'), and
 * on its own, null.
 * @param {string} root @param {{ message?: string, kind?: 'auto' | 'agent' } & Options} [o] @returns {Promise<string | null>}
 */
export function saveVersion(root, { message = '', kind, onProgress } = {}) {
  return queued(root, async () => {
    if (filmIsMissing(root)) {
      if (kind) return null;
      throw new HistoryError('film.html is missing, so there is nothing to save: restore it first', 409, 'missing-film');
    }
    const text = String(message ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const repo = await ready(root, throttled(onProgress));
    /* on its own, only when the film changed: notes, logs and scripts an agent writes, or markers, are kept with the
       next version, not one of their own */
    if (kind) {
      const head = await headOf(root);
      const { changes } = await changesNow(repo, head);
      if (!changes.length || !filmChanged(await summarize(root, head, null, changes.map((c) => c.path)))) return null;
    }
    const saved = await commitFolder(repo, kind ?? (text ? 'named' : 'saved'), kind ? '' : text, throttled(onProgress));
    if (!saved && !kind) throw new HistoryError('nothing changed since the version checked out', 409, 'nothing');
    return saved;
  });
}

/**
 * Put the folder back as `head` holds it, `changes` (changesNow) being what differs: its files written where they
 * differ, and a file the version does not have (made since) to the trash, as a delete in Studio does. Files the
 * versions leave out are not touched.
 * @param {import('./history-store.mjs').Repo} repo @param {import('./history-store.mjs').Version} version
 * @param {Change[]} changes @param {Progress} [progress]
 */
async function putBack(repo, version, changes, progress) {
  const { missing } = await writeFiles(repo, version, { progress });
  for (const { path, change } of changes) {
    if (change === 'added' && !version.has(path) && existsSync(join(repo.root, path))) await moveToTrash(join(repo.root, path));
  }
  /* Studio's state of the film (markers, settings, subtitle style) the version did not have: it had none */
  for (const path of STUDIO_STATE) if (!version.has(path) && existsSync(join(repo.root, path))) await moveToTrash(join(repo.root, path));
  return missing;
}

/**
 * Discard the changes: the folder as the version checked out holds it. Returns the media it holds that could not be
 * found.
 * @param {string} root @param {Options} [o]
 */
export function discardChanges(root, { onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const head = await headOf(root);
    if (!head) throw new HistoryError('nothing is committed yet, so there is nothing to go back to', 409, 'nothing');
    const { changes } = await changesNow(repo, head);
    return { missing: await putBack(repo, await readVersion(repo, head), changes, progress) };
  });
}

/**
 * Check out `commit`, as git does: the folder holds its files (those of the version checked out that it does not
 * have go to the trash) and it is where the next commit goes. No version is made. The branch whose tip it is is
 * checked out; any other version, on its own (detached). With changes, refused ('dirty') unless `discard`: they would
 * be lost. Returns the version, and the media it holds that could not be found.
 * @param {string} root @param {string} commit @param {{ discard?: boolean } & Options} [o]
 */
export function checkoutVersion(root, commit, { discard = false, onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const full = await resolveCommit(root, commit);
    const head = await headOf(root);
    const { changes } = await changesNow(repo, head);
    if (changes.length && !discard) throw new HistoryError('there are changes: commit or discard them first', 409, 'dirty');
    const version = await readVersion(repo, full);
    const missing = await putBack(repo, version, changes, progress);
    if (head) {
      for (const path of (await readVersion(repo, head)).keys()) {
        if (!version.has(path) && existsSync(join(root, path))) await moveToTrash(join(root, path));
      }
    }
    const tips = (await git(root, ['for-each-ref', `--points-at=${full}`, '--format=%(refname)', 'refs/heads'])).split('\n').filter(Boolean);
    const branch = tips.includes('refs/heads/main') ? 'refs/heads/main' : tips[0];
    if (branch) await git(root, ['symbolic-ref', 'HEAD', branch]);
    else await git(root, ['update-ref', '--no-deref', 'HEAD', full]);
    return { commit: full, missing };
  });
}

/**
 * film.html missing: put back only film.html, as version `commit` has it. Every other file stays as it is (none written
 * over, none to the trash: an agent's other work is kept), and the version checked out does not change. Refused when
 * film.html is there again ('dirty': restoring the version is then the way) or the version has none ('no-film').
 * @param {string} root @param {string} commit @param {Options} [o]
 */
export function restoreFilm(root, commit, { onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const full = await resolveCommit(root, commit);
    if (!filmIsMissing(root)) throw new HistoryError('film.html is there: restore the whole version instead', 409, 'dirty');
    const version = await readVersion(repo, full);
    if (!version.has(FILM_FILE)) throw new HistoryError('that version has no film.html', 409, 'no-film');
    await writeFiles(repo, version, { paths: [FILM_FILE], progress });
    return { commit: full };
  });
}

/** Where the texts of merges are kept aside, one ref each: no list of versions reads them (ALL_VERSIONS). */
export const MERGES_REFS = 'refs/openfilm/merges/';
/** How many are kept per project: the oldest go (and their texts, once git tidies the history). */
export const MERGES_KEPT = 50;

/**
 * Keep `files` (a name and its text or bytes each) aside in the history, out of every list of versions: a commit of its own
 * with `message`, under MERGES_REFS by the time it was made, the last MERGES_KEPT kept. What a merge of the person's
 * edits over an agent's write read and wrote (person-edits.mjs), so a merge can always be undone by hand:
 * `git --git-dir .film/history for-each-ref refs/openfilm/merges`, then `git show <ref>:agent.html`. It waits for no
 * history action (git writes objects and refs of its own safely beside one); a history not made yet is made first,
 * in turn, as opening the project's versions would.
 * @param {string} root @param {Record<string, string | Buffer>} files @param {string} message
 */
export async function keepAside(root, files, message) {
  if (!existsSync(join(historyDir(root), 'HEAD'))) await queued(root, () => ready(root));
  const entries = [];
  for (const [name, text] of Object.entries(files)) {
    const blob = (await git(root, ['hash-object', '-w', '--stdin'], { input: text })).trim();
    entries.push(`100644 blob ${blob}\t${name}\n`);
  }
  const tree = (await git(root, ['mktree'], { input: entries.join('') })).trim();
  const commit = (await git(root, ['commit-tree', tree, '-m', message.slice(0, 2000)])).trim();
  await git(root, ['update-ref', `${MERGES_REFS}${String(Date.now()).padStart(15, '0')}-${commit.slice(0, 8)}`, commit, '']);
  const refs = (await git(root, ['for-each-ref', '--sort=refname', '--format=%(refname)', MERGES_REFS])).split('\n').filter(Boolean);
  for (const ref of refs.slice(0, Math.max(0, refs.length - MERGES_KEPT))) await git(root, ['update-ref', '-d', ref]);
  return commit;
}

/**
 * Put `commit`'s files in the folder `into` (a new project's): a copy of that version, to try another way from it.
 * Media comes from the store as clones where the disk can. Returns the media that could not be found.
 * @param {string} root @param {string} commit @param {string} into @param {Options} [o]
 */
export function copyVersion(root, commit, into, { onProgress } = {}) {
  return queued(root, async () => {
    const progress = throttled(onProgress);
    const repo = await ready(root, progress);
    const version = await readVersion(repo, await resolveCommit(root, commit));
    const { missing } = await writeFiles(openRepo(into, repo.gitDir), version, { progress });
    return { missing };
  });
}
