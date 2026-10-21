// @ts-check
/**
 * A project's editor settings (`.film/settings.json`): what Studio keeps about a project that is not the film. Beside
 * film.html, not in it (SPEC §1: an editor's own state lives in `.film/`), so an agent rewriting the film never resets
 * them; each version in the history keeps them with the film (closure.mjs).
 *
 *   fps          the frame rate the editor counts in: its timecode, frame steps and the grid edits land on, and the
 *                export's default rate. One of FRAME_RATES. Absent: the editor takes the first footage's rate.
 *   trackNames   names given to tracks on the timeline, each with the clips its track had when it was named (film.html
 *                gives a track no id, so a moved track is found by them; see the editor's lib/timeline-nav.ts).
 *   trackHeights how tall tracks are drawn on the timeline, px, each with the clips its track had then (as trackNames;
 *                see the editor's lib/track-heights.ts).
 *
 *   GET   settings            → { settings }
 *   PATCH settings  { fps?, trackNames?, trackHeights? } → { settings } (null takes a setting away)
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { TOOL_DIR } from './projects.mjs';

export const PROJECT_SETTINGS_FILE = `${TOOL_DIR}/settings.json`;

/** The rates a project can be set to, as editors name them (23.976 is 24000/1001, and so on). */
export const FRAME_RATES = /** @type {const} */ ([23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120]);

/** @typedef {{ name: string, index: number, clips: string[] }} TrackName */
/** @typedef {{ height: number, index: number, clips: string[] }} TrackHeight */
/** @typedef {{ fps?: number, trackNames?: TrackName[], trackHeights?: TrackHeight[] }} ProjectSettings */

/** The heights a track can be drawn at, px (the editor's lib/track-heights.ts). */
const TRACK_MIN_H = 28;
const TRACK_MAX_H = 160;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A frame rate as one of FRAME_RATES (a probed 29.97002997 is 29.97), or null. @param {unknown} v */
export function frameRateOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return FRAME_RATES.find((r) => Math.abs(r - v) < 0.01) ?? null;
}

/** One track's name, checked; null when it is not one. @param {unknown} v @returns {TrackName | null} */
function trackNameOf(v) {
  if (!isRecord(v) || typeof v.name !== 'string' || !v.name.trim()) return null;
  if (!(Number.isInteger(v.index) && Number(v.index) >= 0)) return null;
  const clips = Array.isArray(v.clips) ? v.clips.filter((c) => typeof c === 'string' && c).slice(0, 500) : [];
  return { name: v.name.trim().slice(0, 40), index: Number(v.index), clips: /** @type {string[]} */ (clips) };
}

/** One track's height, checked; null when it is not one. @param {unknown} v @returns {TrackHeight | null} */
function trackHeightOf(v) {
  if (!isRecord(v) || typeof v.height !== 'number' || !Number.isFinite(v.height)) return null;
  if (!(Number.isInteger(v.index) && Number(v.index) >= 0)) return null;
  const clips = Array.isArray(v.clips) ? v.clips.filter((c) => typeof c === 'string' && c).slice(0, 500) : [];
  const height = Math.round(Math.max(TRACK_MIN_H, Math.min(TRACK_MAX_H, v.height)));
  return { height, index: Number(v.index), clips: /** @type {string[]} */ (clips) };
}

/** The settings as kept: what is not a setting, or not a good one, is left out. @param {unknown} raw @returns {ProjectSettings} */
export function parseProjectSettings(raw) {
  if (!isRecord(raw)) return {};
  /** @type {ProjectSettings} */
  const out = {};
  const fps = frameRateOf(raw.fps);
  if (fps != null) out.fps = fps;
  if (Array.isArray(raw.trackNames)) {
    const names = raw.trackNames.map(trackNameOf).filter((n) => n != null).slice(0, 200);
    if (names.length) out.trackNames = /** @type {TrackName[]} */ (names);
  }
  if (Array.isArray(raw.trackHeights)) {
    const heights = raw.trackHeights.map(trackHeightOf).filter((h) => h != null).slice(0, 200);
    if (heights.length) out.trackHeights = /** @type {TrackHeight[]} */ (heights);
  }
  return out;
}

/** @param {string} root @returns {Promise<ProjectSettings>} */
export async function readProjectSettings(root) {
  try {
    return parseProjectSettings(JSON.parse(await readFile(join(root, PROJECT_SETTINGS_FILE), 'utf8')));
  } catch { return {}; }
}

/**
 * Change some settings, the rest kept: `null` takes one away. A rate that is not one of FRAME_RATES is refused.
 * @param {string} root @param {Record<string, unknown>} patch @returns {Promise<ProjectSettings>}
 */
export async function patchProjectSettings(root, patch) {
  const now = await readProjectSettings(root);
  /** @type {Record<string, unknown>} */
  const next = { ...now };
  if ('fps' in patch) {
    if (patch.fps === null) delete next.fps;
    else if (frameRateOf(patch.fps) == null) throw new HttpError(400, `fps: one of ${FRAME_RATES.join(', ')}`);
    else next.fps = frameRateOf(patch.fps);
  }
  if ('trackNames' in patch) {
    if (patch.trackNames === null) delete next.trackNames;
    else if (!Array.isArray(patch.trackNames)) throw new HttpError(400, 'trackNames: a list of { name, index, clips }');
    else next.trackNames = patch.trackNames;
  }
  if ('trackHeights' in patch) {
    if (patch.trackHeights === null) delete next.trackHeights;
    else if (!Array.isArray(patch.trackHeights)) throw new HttpError(400, 'trackHeights: a list of { height, index, clips }');
    else next.trackHeights = patch.trackHeights;
  }
  const kept = parseProjectSettings(next);
  await mkdir(dirname(join(root, PROJECT_SETTINGS_FILE)), { recursive: true });
  await writeAtomic(join(root, PROJECT_SETTINGS_FILE), `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}

/**
 * `settings` of a project. True when it was this route.
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 */
export async function projectSettingsRoute(req, res, root, rest) {
  if (rest !== 'settings') return false;
  if (req.method === 'GET') { json(res, 200, { settings: await readProjectSettings(root) }); return true; }
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!isRecord(body)) throw new HttpError(400, 'which settings? { fps?, trackNames?, trackHeights? }');
    json(res, 200, { settings: await patchProjectSettings(root, body) });
    return true;
  }
  return false;
}
