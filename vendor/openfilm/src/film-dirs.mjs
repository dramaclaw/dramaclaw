// @ts-check
/** Per-film output, persistent host state and disposable runtime directories. */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { HttpError } from '../studio/server/http.mjs';

export const TOOL_DIR = '.film';
export const hostDirs = () => process.env.OPENFILM_HOST_DIRS === '1';

/** @typedef {{ stateDir: string, runtimeDir: string }} HostDirs */
/** @type {Map<string, HostDirs>} */
const registered = new Map();

/** Resolve existing ancestors too, so a not-yet-created directory cannot hide under a symlink. @returns {string} */
function realPath(/** @type {string} */ path) {
  try { return realpathSync(path); } catch (e) {
    if (!['ENOENT', 'ENOTDIR'].includes(/** @type {NodeJS.ErrnoException} */ (e).code ?? '')) throw e;
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPath(parent), path.slice(parent.length));
  }
}

const within = (/** @type {string} */ path, /** @type {string} */ root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** @param {string} root @param {{ stateDir?: string, runtimeDir?: string }} dirs */
export function registerFilmDirs(root, { stateDir, runtimeDir }) {
  const key = resolve(root);
  const real = realPath(key);
  const outside = (/** @type {string} */ name, /** @type {string | undefined} */ path) => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new HttpError(400, `${name} must be an absolute path; stateDir and runtimeDir are required`);
    const absolute = resolve(path);
    if (within(absolute, key) || within(realPath(absolute), real)) throw new HttpError(400, `${name} must be outside the film root`);
    return absolute;
  };
  const dirs = { stateDir: outside('stateDir', stateDir), runtimeDir: outside('runtimeDir', runtimeDir) };
  /* Replace every spelling of the same root, including earlier symlink registrations. */
  const prior = registered.get(key) ?? registered.get(real);
  if (prior) for (const [alias, value] of registered) if (value === prior) registered.set(alias, dirs);
  registered.set(key, dirs);
  registered.set(real, dirs);
}

/** The registered film containing a file (the root itself never counts). */
export function registeredFilmRoot(/** @type {string} */ path) {
  const real = realPath(resolve(path));
  return [...registered.keys()].filter((root) => real !== root && within(real, root)).sort((a, b) => b.length - a.length)[0];
}

/** Clear process-local registrations to exercise Studio restart recovery. */
export function clearFilmDirsForTests() { registered.clear(); }

/** @param {string} root */
export function filmDirs(root) {
  const key = resolve(root);
  const dirs = hostDirs() ? registered.get(key) ?? registered.get(realPath(key)) : undefined;
  const tool = join(key, TOOL_DIR);
  if (dirs) return {
    history: join(dirs.stateDir, 'history'), commits: join(dirs.stateDir, 'commits'),
    media: join(tool, 'media'), cache: join(dirs.runtimeDir, 'cache'), removed: join(tool, 'removed'),
  };
  if (hostDirs() && !within(realPath(key), realPath(resolve(tmpdir())))) throw new HttpError(409, `film dirs not registered: ${root}`);
  return {
    history: join(tool, 'history'), commits: join(tool, 'cache', 'commits'),
    media: join(tool, 'history', 'media'), cache: join(tool, 'cache'), removed: null,
  };
}

/** @param {string} root @param {...string} sub */
export const cacheDir = (root, ...sub) => join(filmDirs(root).cache, ...sub);
export const historyDir = (/** @type {string} */ root) => filmDirs(root).history;
export const mediaDir = (/** @type {string} */ root) => filmDirs(root).media;
