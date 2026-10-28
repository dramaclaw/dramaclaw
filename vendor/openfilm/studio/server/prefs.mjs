// @ts-check
/**
 * Studio's own preferences, the same for every project (`prefs.json` in Studio's home): what the editor does on this
 * computer, not what a film is. A project's own settings are project-settings.mjs.
 *
 *   proxies       light copies of heavy footage for the preview (proxies.mjs): on, and how tall
 *   seenVersion   the version whose "what's new" was last shown (null: none yet, a new install shows none)
 *   projectsFolder   where the projects library is, when the person chose (null: the default; src/locations.mjs,
 *                 which the `openfilm` command reads too). Kept in the prefs.json of the home that holds the library
 *                 (OPENFILM_SHARED_HOME, else this one), so every OpenFilm on the computer shares it.
 *   keys          the keyboard shortcuts: the scheme in use and the custom ones (null: OpenFilm's). Kept as Studio's
 *                 page gives them, in shape only (keysOf); the page checks every action and key (ui/src/lib/keymap.ts).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { studioHome } from './projects.mjs';
import { chooseFolder, chosenFolder } from '../../src/locations.mjs';

/** @typedef {{ scheme: string, custom: Record<string, { base: string, keys: Record<string, string[]> }> }} Keys */
/** @typedef {{ proxies: { on: boolean, height: 540 | 720 | 1080 }, seenVersion: string | null, projectsFolder: string | null, keys: Keys | null }} Prefs */

/** Proxies on by default, at 720p. */
export const DEFAULT_PREFS = /** @type {Prefs} */ ({ proxies: { on: true, height: 720 }, seenVersion: null, projectsFolder: null, keys: null });
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const HEIGHTS = [540, 720, 1080];

const NAME = /^[\w-]{1,40}$/;
const SLOTS = ['custom1', 'custom2', 'custom3'];

/**
 * The keyboard shortcuts in shape: a scheme's name, and up to three custom schemes, each the scheme it came from and
 * its keys (an action's name, then up to 8 combinations of at most 40 characters). Null when there is no scheme.
 * @param {unknown} raw @returns {Keys | null}
 */
export function keysOf(raw) {
  const k = /** @type {{ scheme?: unknown, custom?: unknown } | null} */ (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  if (!k || typeof k.scheme !== 'string' || !NAME.test(k.scheme)) return null;
  /** @type {Keys['custom']} */
  const custom = {};
  const given = /** @type {Record<string, unknown>} */ (k.custom && typeof k.custom === 'object' ? k.custom : {});
  for (const slot of SLOTS) {
    const one = /** @type {{ base?: unknown, keys?: unknown } | undefined} */ (given[slot]);
    if (!one || typeof one !== 'object' || typeof one.base !== 'string' || !NAME.test(one.base)) continue;
    /** @type {Record<string, string[]>} */
    const keys = {};
    const list = Object.entries(one.keys && typeof one.keys === 'object' ? one.keys : {}).slice(0, 200);
    for (const [action, combos] of list) {
      if (!NAME.test(action) || !Array.isArray(combos)) continue;
      keys[action] = combos.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 40).slice(0, 8);
    }
    custom[slot] = { base: one.base, keys };
  }
  return { scheme: k.scheme, custom };
}

/** What is kept, each field checked; anything missing or wrong is its default. @param {unknown} raw @returns {Prefs} */
export function prefsOf(raw) {
  const p = /** @type {{ proxies?: { on?: unknown, height?: unknown }, seenVersion?: unknown, projectsFolder?: unknown, keys?: unknown } | null} */ (raw && typeof raw === 'object' ? raw : null);
  const folder = (/** @type {unknown} */ v) => (typeof v === 'string' && isAbsolute(v) ? resolve(v) : null);
  const height = Number(p?.proxies?.height);
  return {
    proxies: {
      on: typeof p?.proxies?.on === 'boolean' ? p.proxies.on : DEFAULT_PREFS.proxies.on,
      height: /** @type {540 | 720 | 1080} */ (HEIGHTS.includes(height) ? height : DEFAULT_PREFS.proxies.height),
    },
    seenVersion: typeof p?.seenVersion === 'string' && VERSION.test(p.seenVersion) ? p.seenVersion : null,
    projectsFolder: folder(p?.projectsFolder),
    keys: keysOf(p?.keys),
  };
}

const file = () => join(studioHome(), 'prefs.json');

/** @returns {Prefs} */
export function readPrefs() {
  let own = null;
  try { own = JSON.parse(readFileSync(file(), 'utf8')); } catch { /* none yet */ }
  return { ...prefsOf(own), projectsFolder: chosenFolder('projectsFolder') };
}

/**
 * Change some of them (a field at a time); returns them all. The file is shared with every OpenFilm on this computer
 * (`npx openfilm`, the app), older or newer: what this one does not know of it is written back as it was.
 * @param {unknown} patch @returns {Prefs}
 */
export function writePrefs(patch) {
  const now = readPrefs();
  const asked = /** @type {{ proxies?: object, seenVersion?: unknown, projectsFolder?: unknown, keys?: unknown }} */ (patch && typeof patch === 'object' ? patch : {});
  const next = prefsOf({ ...now, ...asked, proxies: { ...now.proxies, ...(asked.proxies ?? {}) } });
  const at = file();
  let kept = {};
  try { const raw = JSON.parse(readFileSync(at, 'utf8')); if (raw && typeof raw === 'object' && !Array.isArray(raw)) kept = raw; } catch { /* none yet */ }
  const { projectsFolder, ...own } = next;
  mkdirSync(studioHome(), { recursive: true });
  writeFileSync(`${at}.${process.pid}.tmp`, `${JSON.stringify({ ...kept, ...own, proxies: { ...(/** @type {{ proxies?: object }} */ (kept).proxies ?? {}), ...next.proxies } }, null, 2)}\n`);
  renameSync(`${at}.${process.pid}.tmp`, at);
  /* where the library is: in the home that holds it (src/locations.mjs) */
  if ('projectsFolder' in asked) chooseFolder('projectsFolder', projectsFolder);
  return next;
}
