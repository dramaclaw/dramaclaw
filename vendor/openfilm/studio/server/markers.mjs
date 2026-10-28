// @ts-check
/**
 * A project's markers (`.film/markers.json`): named, colored places on the film or on a clip, set in Studio's
 * timeline (M). Studio's own, beside film.html, not in it (SPEC §1: an editor's own state lives in `.film/`): a marker
 * changes nothing in the film. A marker is `{ id, t, clip?, name?, color }`: `t` in film seconds, or with `clip` (a
 * clip's id) in seconds of that clip's file (see the editor's lib/markers.ts).
 *
 *   GET markers               → { markers }
 *   PUT markers { markers }   → { markers }: the whole list, as kept
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { TOOL_DIR } from './projects.mjs';

export const MARKERS_FILE = `${TOOL_DIR}/markers.json`;
const COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple'];
const MAX = 1000;
const NAME_MAX = 80;

/** @typedef {{ id: string, t: number, clip?: string, name?: string, color: string }} Marker */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The markers as kept: what is not one is left out. @param {unknown} raw @returns {Marker[]} */
export function parseMarkers(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Marker[]} */
  const out = [];
  const ids = new Set();
  for (const m of raw) {
    if (!isRecord(m) || typeof m.id !== 'string' || !m.id || m.id.length > 64 || ids.has(m.id)) continue;
    if (typeof m.t !== 'number' || !Number.isFinite(m.t) || m.t < 0) continue;
    ids.add(m.id);
    const name = typeof m.name === 'string' ? m.name.trim().slice(0, NAME_MAX) : '';
    out.push({
      id: m.id,
      t: Math.round(m.t * 1000) / 1000,
      ...(typeof m.clip === 'string' && m.clip ? { clip: m.clip.slice(0, 200) } : {}),
      ...(name ? { name } : {}),
      color: COLORS.includes(String(m.color)) ? String(m.color) : 'blue',
    });
    if (out.length >= MAX) break;
  }
  return out;
}

/** @param {string} root @returns {Promise<Marker[]>} */
export async function readMarkers(root) {
  try {
    return parseMarkers(JSON.parse(await readFile(join(root, MARKERS_FILE), 'utf8')));
  } catch { return []; }
}

/** @param {string} root @param {unknown} list @returns {Promise<Marker[]>} */
export async function writeMarkers(root, list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'markers: a list of { id, t, clip?, name?, color }');
  const kept = parseMarkers(list);
  await mkdir(dirname(join(root, MARKERS_FILE)), { recursive: true });
  await writeAtomic(join(root, MARKERS_FILE), `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

/**
 * `markers` of a project. True when it was this route.
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 */
export async function markersRoute(req, res, root, rest) {
  if (rest !== 'markers') return false;
  if (req.method === 'GET') { json(res, 200, { markers: await readMarkers(root) }); return true; }
  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (!isRecord(body)) throw new HttpError(400, 'which markers? { markers }');
    json(res, 200, { markers: await writeMarkers(root, body.markers) });
    return true;
  }
  return false;
}
