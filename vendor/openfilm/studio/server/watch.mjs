// @ts-check
/**
 * What changes in a project folder while someone watches it: film.html (`film`, with its new revision) or any other
 * file (`files`: a page, a picture, a sound). A write of someone else's is merged with the person's edits first
 * (person-edits.mjs), so the pages hear of the film and the files as they end up. One watcher per open project, shared
 * by every page showing it, closed when the last one leaves. Studio's own folders and the usual build and dependency
 * folders are not watched.
 */
import { readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { readProjectFilm, settleProjectFilm } from './film.mjs';
import { settleFiles } from './person-edits.mjs';
import { FILM_FILE } from '../../src/film-doc.mjs';
import { projectMissing } from './project-presence.mjs';

/* a dot folder is a tool's (Studio's own .film, .git…), and what builds and packages make is not the film */
const IGNORED = /^(\.[^/\\]+|node_modules|dist|build)([/\\]|$)/;
/** How long changes are gathered before one event: an agent writes a file in several chunks, and often several files. */
const SETTLE_MS = 120;
/** How long missing project files are rechecked before their pages are told (the project gone, or its film.html). */
const GONE_RECHECK_MS = 400;
/** A deleted root is not reliably reported by every file system's watcher. */
const PRESENCE_MS = 1000;

/* Studio's own half-written files (a file written whole through a random-named sibling, atomic.mjs; an import
   streaming in, files.mjs): only the result is a change */
const WRITING = /(^|[/\\])([^/\\]+\.[0-9a-f-]{8,}\.tmp|\.\d+\.\d+\.importing)$/;

/**
 * `files`: `paths` are the files that changed (folder relative), or none when the system could not say.
 * `ask` / `asked`: a question about spending for the person, and that it was answered; `notice`: something the person
 * is told, such as a provider with no balance left (get.mjs).
 * `history`: the version history changed (history.mjs); `moved`: its action changed the folder's files (a version
 * restored), so Studio's own state of the film is read again. `history-progress`: how far an action is, `op` which
 * ('save', 'restore'…).
 * `project`: the project renamed, as it is now.
 * @typedef {{ type: 'film', rev: string } | { type: 'files', paths?: string[] } | { type: 'history', moved?: boolean } | { type: 'export', job: object }
 *   | { type: 'history-progress', op: string, phase: string, done: number, total: number } | { type: 'project', project: object }
 *   | { type: 'ask', ask: object } | { type: 'asked', id: string } | { type: 'notice', notice: object }
 *   | { type: 'film-missing' } | { type: 'gone' }} FolderEvent   `gone`: the project was deleted, or its folder is
 *   missing. `film-missing`: its folder is there but film.html is not (being written again, or lost): the project stays
 *   open, and its pages hear of the film (`film`) once it is back
 */

/**
 * Watch `root`; `send` gets each change once it settles. Returns `close`.
 * @param {string} root @param {(event: FolderEvent) => void} send
 */
export function watchFolder(root, send) {
  /** @type {Set<'film' | 'files'>} */
  const pending = new Set();
  /** @type {Set<string> | null} null: some change could not say which file */
  let paths = new Set();
  let timer = /** @type {NodeJS.Timeout | null} */ (null);
  let lastRev = '';
  let closed = false;
  let checking = false;
  let gone = false;
  /* film.html missing from a folder still there, and said so */
  let filmMissing = false;
  readProjectFilm(root).then((f) => { lastRev = f.rev; }, () => {});

  const flush = async () => {
    timer = null;
    if (closed || gone || checking) return;
    checking = true;
    try {
      /* A missing film is not an empty one. Recheck after a short grace period: editors can replace files while
         saving, and a rename in Studio moves the subscription to its new folder, closing this watcher. */
      let missing = projectMissing(root);
      if (missing) {
        await new Promise((done) => setTimeout(done, GONE_RECHECK_MS));
        if (closed) return;
        missing = projectMissing(root);
        if (missing === 'folder') { gone = true; pending.clear(); send({ type: 'gone' }); return; }
      }
      /* Only the folder going ends the project. film.html alone can be missing for minutes while an agent writes it
         again (a tool that deletes the file, then adds it whole): its pages are told, and the film once it is back,
         even with the same text as before */
      if (missing === 'film') {
        pending.delete('film');
        if (!filmMissing) { filmMissing = true; lastRev = ''; send({ type: 'film-missing' }); }
      } else if (filmMissing) { filmMissing = false; pending.add('film'); }
      const kinds = [...pending];
      const changed = paths;
      pending.clear();
      paths = new Set();
      if (kinds.includes('film')) {
        const { rev } = await settleProjectFilm(root, { stable: true }).catch(() => ({ rev: '' }));
        /* the same text written again (an editor's save, Studio's own write echoed back) is no change */
        if (closed) return;
        /* deleted during the read: wait for presence to settle instead of publishing an empty film */
        if (projectMissing(root)) { pending.add('film'); return; }
        if (rev && rev !== lastRev) { lastRev = rev; send({ type: 'film', rev }); }
      }
      if (kinds.includes('files')) {
        await settleFiles(root, changed ? [...changed] : null);
        if (closed) return;
        send(changed ? { type: 'files', paths: [...changed] } : { type: 'files' });
      }
    } finally {
      checking = false;
      if (!closed && !gone && pending.size) schedule();
    }
  };
  const schedule = () => { if (!timer && !checking && !closed && !gone) timer = setTimeout(flush, SETTLE_MS); };

  const close = watchTree(root, (name) => {
    if (closed || gone) return;
    if (!name) { pending.add('files'); pending.add('film'); paths = null; }
    else {
      const rel = name;
      if (IGNORED.test(rel) || WRITING.test(rel)) return;
      if (rel === FILM_FILE) pending.add('film');
      else { pending.add('files'); paths?.add(rel); }
    }
    schedule();
  });
  /* the folder gone, or film.html gone or back since last said */
  const presence = setInterval(() => {
    if (closed || gone) return;
    const missing = projectMissing(root);
    if (missing === 'folder' || (missing === 'film') !== filmMissing) schedule();
  }, PRESENCE_MS);
  presence.unref();
  return () => { closed = true; clearInterval(presence); if (timer) clearTimeout(timer); close(); };
}

/**
 * Every change under `root`, as a folder-relative name (null: something changed, the system could not say what).
 * macOS and Windows watch a tree natively. Elsewhere Node's recursive watch follows each file's inode, so a file
 * replaced by a rename (film.html written by a rename, most editors' saves) goes unseen after the first time: there each
 * folder is watched on its own, which names whatever lands in it, and a new folder is taken in as it appears.
 * @param {string} root @param {(name: string | null) => void} onChange @param {boolean} [native] @returns {() => void} close
 */
export function watchTree(root, onChange, native = process.platform === 'darwin' || process.platform === 'win32') {
  if (native) {
    /* a folder that is not there (any more) is not watched: nothing comes of it */
    let watcher;
    try { watcher = watch(root, { recursive: true }, (_event, name) => onChange(name ? String(name).split('\\').join('/') : null)); }
    catch { return () => {}; }
    watcher.on('error', () => onChange(null));
    return () => watcher.close();
  }
  /** @type {Map<string, import('node:fs').FSWatcher>} folder-relative folder ('' for the root) → its watcher */
  const folders = new Map();
  const add = (/** @type {string} */ rel) => {
    if (folders.has(rel) || (rel && IGNORED.test(rel))) return;
    let watcher;
    try {
      watcher = watch(rel ? join(root, rel) : root, (_event, name) => {
        if (!name) { onChange(null); return; }
        const path = rel ? `${rel}/${name}` : String(name);
        onChange(path);
        /* a folder that just appeared (or moved in) is watched too, with what is already in it */
        try { if (readdirSync(join(root, path))) { add(path); addBelow(path); } } catch { /* a file, or gone */ }
      });
    } catch { return; }
    watcher.on('error', () => { watcher.close(); folders.delete(rel); onChange(null); });
    folders.set(rel, watcher);
  };
  const addBelow = (/** @type {string} */ rel) => {
    let entries;
    try { entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory()) { const sub = rel ? `${rel}/${e.name}` : e.name; add(sub); addBelow(sub); }
  };
  add('');
  addBelow('');
  return () => { for (const w of folders.values()) w.close(); folders.clear(); };
}

/**
 * Every project someone is watching, and who: `subscribe` starts the folder's watcher with its first listener and stops
 * it with its last. `onChange` hears every change of a watched folder itself (not what `emit` tells).
 * @param {{ onChange?: (root: string, e: FolderEvent) => void }} [o]
 */
export function createWatchers({ onChange } = {}) {
  /** @typedef {{ root: string, listener: (e: FolderEvent) => void }} Subscription */
  /** @type {Map<string, { close: () => void, listeners: Set<Subscription> }>} */
  const byRoot = new Map();
  /** @param {string} root @param {Set<Subscription>} listeners */
  const start = (root, listeners) => ({ listeners, close: watchFolder(root, (e) => { onChange?.(root, e); for (const { listener } of listeners) listener(e); }) });
  return {
    /** @param {string} root @param {(e: FolderEvent) => void} listener */
    subscribe(root, listener) {
      let entry = byRoot.get(root);
      if (!entry) {
        entry = start(root, new Set());
        byRoot.set(root, entry);
      }
      const subscription = { root, listener };
      entry.listeners.add(subscription);
      return () => {
        const current = byRoot.get(subscription.root);
        if (!current) return;
        current.listeners.delete(subscription);
        if (!current.listeners.size) { current.close(); byRoot.delete(subscription.root); }
      };
    },
    /** A renamed folder: keep its pages subscribed, but watch and read the new path. */
    move(/** @type {string} */ from, /** @type {string} */ to) {
      if (from === to) return;
      const entry = byRoot.get(from);
      if (!entry) return;
      entry.close();
      byRoot.delete(from);
      const target = byRoot.get(to);
      target?.close();
      for (const subscription of target?.listeners ?? []) entry.listeners.add(subscription);
      for (const subscription of entry.listeners) subscription.root = to;
      byRoot.set(to, start(to, entry.listeners));
    },
    /** The projects someone is watching now. */
    roots: () => [...byRoot.keys()],
    /** Tell everyone watching `root` something the folder itself does not say (a new version in its history). */
    emit(/** @type {string} */ root, /** @type {FolderEvent} */ event) { for (const { listener } of byRoot.get(root)?.listeners ?? []) listener(event); },
    closeAll() { for (const entry of byRoot.values()) entry.close(); byRoot.clear(); },
  };
}
