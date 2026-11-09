// @ts-check
/**
 * The folders under the home folder, for the web editor's "Open folder…" (a browser cannot give a folder's path): one
 * folder's subfolders at a time, each marked when it holds a film.html. Nothing outside the home folder is shown, by
 * any path or link: a link to a folder outside it is left out, and a path that resolves outside it is refused.
 * Hidden folders are left out; a folder this account cannot read is refused, as the system refuses it.
 */
import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FILM_FILE } from '../../src/film-doc.mjs';

export class BrowseError extends Error {
  /** @param {string} message @param {number} status @param {string} code */
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** At most this many folders are listed (a folder with more says so: `more`). */
const MOST = 1000;

/** Whether `path` is `root` or inside it (both real paths). */
export function within(/** @type {string} */ root, /** @type {string} */ path) {
  const back = relative(root, path);
  return back === '' || (!back.startsWith('..') && !isAbsolute(back));
}

/** @param {unknown} e */
const denied = (e) => ['EACCES', 'EPERM'].includes(/** @type {NodeJS.ErrnoException} */ (e)?.code ?? '');

/**
 * One folder's subfolders. `path`: a folder under `root` (none: `root` itself). Answers the folder by its real path,
 * its parent (null at the root), whether it holds a film, and its folders, sorted by name.
 * @param {string | null | undefined} path @param {{ root?: string }} [options]
 */
export async function browseFolder(path, { root = homedir() } = {}) {
  const top = await realpath(root);
  const asked = path ? resolve(top, path) : top;
  /** @type {string} */
  let real;
  try { real = await realpath(asked); } catch (e) {
    if (denied(e)) throw new BrowseError('You do not have permission to open this folder.', 403, 'denied');
    throw new BrowseError('That folder does not exist.', 404, 'not-found');
  }
  if (!within(top, real)) throw new BrowseError('Only folders in your home folder are shown here.', 403, 'outside');
  if (!(await stat(real)).isDirectory()) throw new BrowseError('That is a file, not a folder.', 400, 'file');
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try { entries = await readdir(real, { withFileTypes: true }); } catch (e) {
    if (denied(e)) throw new BrowseError('You do not have permission to open this folder.', 403, 'denied');
    throw e;
  }
  /** @type {{ name: string, path: string, film: boolean }[]} */
  const folders = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const at = join(real, entry.name);
    if (entry.isSymbolicLink()) {
      /* a link is followed only to a folder inside the home folder */
      const target = await realpath(at).catch(() => null);
      if (!target || !within(top, target) || !(await stat(target).then((s) => s.isDirectory(), () => false))) continue;
    } else if (!entry.isDirectory()) continue;
    folders.push({ name: entry.name, path: at, film: existsSync(join(at, FILM_FILE)) });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    path: real,
    root: top,
    parent: real === top ? null : dirname(real),
    name: basename(real),
    film: existsSync(join(real, FILM_FILE)),
    folders: folders.slice(0, MOST),
    more: folders.length > MOST,
  };
}

/**
 * Where the person may want to start: the home folder, the projects library, and the usual folders of a home, those
 * that exist; then the folders of the projects opened lately. Only folders under `root`.
 * @param {{ root?: string, library: string, recent: string[] }} options
 */
export async function browsePlaces({ root = homedir(), library, recent }) {
  const top = await realpath(root);
  /** @type {{ id: string, path: string }[]} */
  const places = [{ id: 'home', path: top }];
  const add = async (/** @type {string} */ id, /** @type {string} */ path) => {
    const real = await realpath(path).catch(() => null);
    if (real && within(top, real) && !places.some((p) => p.path === real) && (await stat(real).then((s) => s.isDirectory(), () => false))) places.push({ id, path: real });
  };
  await add('library', library);
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Movies', 'Videos']) await add(name.toLowerCase(), join(top, name));
  /** @type {string[]} */
  const recentFolders = [];
  for (const project of recent) {
    const real = await realpath(dirname(project)).catch(() => null);
    if (real && within(top, real) && real !== top && !recentFolders.includes(real)) recentFolders.push(real);
    if (recentFolders.length === 4) break;
  }
  return { places, recent: recentFolders };
}
