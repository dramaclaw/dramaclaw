// @ts-check
/**
 * person-edits.mjs's merges of a long film, here, so Studio answers meanwhile: mergeWrite's input in, its result out.
 * Each project's versions arrive as lists of track ids; the tracks are kept here, so each merge sends only new ones.
 */
import { parentPort } from 'node:worker_threads';
import { mergeWrite } from './person-merge.mjs';

/** @type {Map<string, Map<number, import('./person-merge.mjs').KeptTrack>>} each project's tracks, by id */
const projects = new Map();

parentPort?.on('message', ({ id, root, input, versions, tracks }) => {
  try {
    const had = projects.get(root) ?? new Map();
    for (const [n, t] of tracks) had.set(n, t);
    const all = versions.map((/** @type {{ stage: string, tracks: number[] }} */ v) => ({ stage: v.stage, tracks: v.tracks.map((n) => had.get(n)) }));
    /* only the tracks of these versions stay */
    const used = new Set(versions.flatMap((/** @type {{ tracks: number[] }} */ v) => v.tracks));
    for (const n of had.keys()) if (!used.has(n)) had.delete(n);
    projects.set(root, had);
    parentPort?.postMessage({ id, out: mergeWrite({ ...input, versions: all }) });
  } catch (e) {
    projects.delete(root);
    parentPort?.postMessage({ id, error: /** @type {Error} */ (e)?.stack ?? String(e) });
  }
});
