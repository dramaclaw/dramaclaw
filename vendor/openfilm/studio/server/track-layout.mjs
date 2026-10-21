// @ts-check
import { kindOf } from '../../src/film-doc.mjs';

/** Studio's row kind, including audio-only uses of video files.
 * @param {{ clips: readonly { src: string, sound?: boolean }[] }} track
 * @returns {'mg' | 'video' | 'audio'}
 */
export function trackKind(track) {
  const kinds = new Set(track.clips.map((clip) => {
    const kind = kindOf(clip);
    return kind === 'page' ? 'mg' : kind === 'sound' ? 'audio' : 'video';
  }));
  return kinds.size === 1 ? /** @type {'mg' | 'video' | 'audio'} */ ([...kinds][0]) : 'video';
}

/** Picture rows count bottom up, sound rows top down; each prefix counts separately.
 * @param {readonly string[]} kinds
 */
export function rowBadges(kinds) {
  const prefixes = kinds.map((kind) => kind === 'mg' ? 'P' : kind === 'video' ? 'V' : 'A');
  const total = new Map();
  for (const prefix of prefixes) total.set(prefix, (total.get(prefix) ?? 0) + 1);
  const seen = new Map();
  return prefixes.map((prefix) => {
    const nth = (seen.get(prefix) ?? 0) + 1;
    seen.set(prefix, nth);
    return `${prefix}${prefix === 'A' ? nth : total.get(prefix) - nth + 1}`;
  });
}

/** Greedy rows in milliseconds; one millisecond of overlap is rounding at a shared edge.
 * @template {{ startMs: number, endMs: number }} T
 * @param {readonly T[]} blocks @returns {T[][]}
 */
export function layerBlocks(blocks) {
  /** @type {T[][]} */
  const rows = [];
  for (const block of [...blocks].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const row = rows.find((r) => (r.at(-1)?.endMs ?? 0) <= block.startMs + 1);
    if (row) row.push(block); else rows.push([block]);
  }
  return rows;
}
