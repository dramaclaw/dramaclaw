// @ts-check
/**
 * Where OpenFilm keeps the person's work on this computer: the projects library (one folder per project, the folders
 * Studio's Projects list shows) and the exports folder. The library has a default and may be moved in Studio's
 * Settings → General: Studio's `prefs.json` (`projectsFolder`), read by Studio and by the `openfilm` command alike, so
 * a project fetched from the command line lands where Studio's go. A Studio with a home of its own (OPENFILM_HOME, as
 * `pnpm dev` and the desktop app's dev and preview builds have) shares the person's library when OPENFILM_SHARED_HOME
 * names the home that keeps it (~/.openfilm). OPENFILM_LIBRARY sets the default (a build, or a Studio kept apart);
 * what the person chose comes first. Exports go to the folder picked when exporting (the export dialog keeps the last
 * one), else to the exports default.
 *
 * Reads no Studio module, so the command can use it.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Studio's own home (its settings and keys, not the person's work): OPENFILM_HOME, else ~/.openfilm. */
export const studioHomeDir = () => process.env.OPENFILM_HOME || join(homedir(), '.openfilm');

/**
 * The Studio home whose prefs.json holds what every OpenFilm on this computer shares (where the library is, the skills
 * turned off): OPENFILM_SHARED_HOME, else Studio's own.
 */
export const sharedHome = () => process.env.OPENFILM_SHARED_HOME || studioHomeDir();

/** One value of the shared prefs.json (`home`: the home that holds it), or undefined. @param {string} key */
export function sharedPref(key, home = sharedHome()) {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'prefs.json'), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep one value in the shared prefs.json. The file is shared with every OpenFilm on this computer, older or newer:
 * what this one does not know of it is written back as it was. @param {string} key @param {unknown} value
 */
export function setSharedPref(key, value, home = sharedHome()) {
  const at = join(home, 'prefs.json');
  let kept = {};
  try { const raw = JSON.parse(readFileSync(at, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) kept = raw; } catch { /* none yet */ }
  mkdirSync(home, { recursive: true });
  writeFileSync(`${at}.${process.pid}.tmp`, `${JSON.stringify({ ...kept, [key]: value }, null, 2)}\n`);
  renameSync(`${at}.${process.pid}.tmp`, at);
}

/** Where new projects go unless the person chose: OPENFILM_LIBRARY, else ~/Movies/OpenFilm/Projects on macOS, ~/Videos/OpenFilm/Projects elsewhere. */
export const libraryDefault = () => process.env.OPENFILM_LIBRARY
  || join(homedir(), process.platform === 'darwin' ? 'Movies' : 'Videos', 'OpenFilm', 'Projects');

/**
 * Where exports go unless a folder is picked when exporting: OPENFILM_EXPORTS, else `exports` in OPENFILM_HOME when
 * that is set (a Studio kept apart, for work on OpenFilm itself, leaves nothing in the person's own folder), else the
 * Desktop.
 */
export const exportsDefault = () => process.env.OPENFILM_EXPORTS
  || (process.env.OPENFILM_HOME ? join(process.env.OPENFILM_HOME, 'exports') : '')
  || join(homedir(), 'Desktop');

/**
 * Where what the person saved goes (clips and files kept to use again in any project, studio/server/saved.mjs): beside
 * the projects' default folder, `Saved` (~/Movies/OpenFilm/Saved on macOS), else OPENFILM_SAVED. Not moved with the
 * projects folder: what was saved stays where it was found.
 */
export const savedRoot = () => process.env.OPENFILM_SAVED || join(dirname(libraryDefault()), 'Saved');

/** The folders the person can choose, by their key in prefs.json. */
export const LOCATION_KEYS = /** @type {const} */ ({ projects: 'projectsFolder' });

/** A folder the person chose, as kept in prefs.json: an absolute path, or null (none chosen, or not one). */
export function chosenFolder(/** @type {'projectsFolder'} */ key) {
  const value = sharedPref(key);
  return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
}

/**
 * Keep a folder the person chose (null: back to the default) in the shared prefs.json.
 * @param {'projectsFolder'} key @param {string | null} value
 */
export function chooseFolder(key, value) {
  setSharedPref(key, value);
}

export const libraryRoot = () => chosenFolder('projectsFolder') ?? libraryDefault();

/**
 * The projects in a library, by full path: its folders that hold a film (film.html, or Studio's `.film/id` for one
 * that lost it), not hidden ones. Nothing deeper: a project is a folder of the library.
 */
export function libraryProjects(root = libraryRoot()) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && (existsSync(join(root, d.name, 'film.html')) || existsSync(join(root, d.name, '.film', 'id'))))
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

/** Where exports go when no folder is picked. */
export const exportsRoot = () => exportsDefault();

/** The free space, in bytes, on the disk a folder is on (the folder, or the nearest one above it that is there), or null. */
export function freeSpace(/** @type {string} */ folder) {
  let at = resolve(folder);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    const s = statfsSync(at);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Each folder the person can choose, for Settings: where it is now, its default, whether it was chosen, the free
 * space on its disk, and how many projects are in it (Settings asks whether they move with it).
 */
export function locations() {
  const one = (/** @type {string} */ path, /** @type {string} */ fallback, /** @type {boolean} */ chosen) => ({ path, default: fallback, chosen, free: freeSpace(path), count: libraryProjects(path).length });
  return {
    projects: one(libraryRoot(), libraryDefault(), chosenFolder('projectsFolder') !== null),
  };
}

/**
 * A folder offered for new projects, as it will be kept: absolute, not a disk's root, not inside Studio's own
 * home; made if it is not there yet. Throws a sentence the person can read.
 * @param {unknown} value @returns {string}
 */
export function usableFolder(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose a folder by its full path.');
  const path = resolve(value);
  if (dirname(path) === path) throw new Error('Choose a folder on that disk, not the disk itself.');
  for (const home of new Set([resolve(studioHomeDir()), resolve(sharedHome())])) {
    if (path === home || path.startsWith(home + sep)) throw new Error('OpenFilm keeps its own settings there: choose another folder.');
  }
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
  } catch {
    throw new Error('That folder cannot be written to: choose another one.');
  }
  return path;
}
