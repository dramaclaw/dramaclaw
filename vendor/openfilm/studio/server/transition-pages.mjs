// @ts-check
/**
 * The pages a transition puts under its clips (the timeline's dip to white, studio/ui/src/lib/transitions.ts): one
 * per kind, in the project's `transitions/` folder, written once and then kept as it is (the person or an agent may
 * have changed it).
 *
 *   POST transition-pages { name, html } → { path }: `transitions/<name>.html`, written when there is none
 */
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inside } from './files.mjs';
import { HttpError, json, readJson } from './http.mjs';

export const TRANSITIONS_DIR = 'transitions';
/** A transition's page is small: a color and a few lines of script. */
const MAX_PAGE = 64 << 10;

/** Keep a transition's page as `transitions/<name>.html` unless one is there. Returns its path. @param {string} root @param {string} name @param {string} html */
export async function writeTransitionPage(root, name, html) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 40) throw new HttpError(400, `"${name}" is not a transition page's name`);
  if (typeof html !== 'string' || html.length > MAX_PAGE || !/^<!doctype html>/i.test(html) || !html.includes('window.film')) {
    throw new HttpError(400, 'a transition page is a page: <!doctype html> … window.film');
  }
  const path = `${TRANSITIONS_DIR}/${name}.html`;
  const file = inside(root, path);
  await mkdir(dirname(file), { recursive: true });
  /* `wx`: made here or not at all, so one there already is never written over */
  const handle = await open(file, 'wx').catch((e) => (e?.code === 'EEXIST' ? null : Promise.reject(e)));
  if (handle) { try { await handle.writeFile(html, 'utf8'); } finally { await handle.close(); } }
  return path;
}

/**
 * The route under /api/projects/:id/ (see the top). Returns whether it answered.
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 */
export async function transitionPageRoutes(req, res, root, rest) {
  if (rest !== 'transition-pages' || req.method !== 'POST') return false;
  const { name, html } = /** @type {{ name?: unknown, html?: unknown }} */ (await readJson(req));
  if (typeof name !== 'string' || typeof html !== 'string') throw new HttpError(400, 'which page? { name, html }');
  json(res, 200, { path: await writeTransitionPage(root, name, html) });
  return true;
}
