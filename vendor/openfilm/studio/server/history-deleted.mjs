// @ts-check
/** Deleted version records stay recoverable without rewriting the project's Git commits or touching its files. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { HistoryError } from './history-store.mjs';

/** @typedef {{ at: number, parents: string[] }} DeletedVersion */
const fullId = (/** @type {unknown} */ id) => typeof id === 'string' && /^[0-9a-f]{40,64}$/.test(id);

/** @param {string} gitDir @returns {Promise<Map<string, DeletedVersion>>} */
export async function readDeletedVersions(gitDir) {
  let text;
  try { text = await readFile(join(gitDir, 'deleted-versions.json'), 'utf8'); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return new Map(); throw error; }
  try {
    const data = JSON.parse(text);
    if (data.format !== 1 || !data.commits || typeof data.commits !== 'object' || Array.isArray(data.commits)) throw new Error('format');
    /** @type {Map<string, DeletedVersion>} */
    const records = new Map();
    for (const [id, raw] of Object.entries(data.commits)) {
      const entry = /** @type {DeletedVersion} */ (raw);
      if (!fullId(id) || !entry || !Number.isFinite(entry.at) || !Array.isArray(entry.parents) || !entry.parents.every(fullId)) throw new Error('record');
      records.set(id, { at: entry.at, parents: [...entry.parents] });
    }
    return records;
  } catch { throw new HistoryError('the deleted-version list could not be read', 500); }
}

/** @param {string} gitDir @param {Map<string, DeletedVersion>} records */
export function writeDeletedVersions(gitDir, records) {
  return writeAtomic(join(gitDir, 'deleted-versions.json'), JSON.stringify({ format: 1, commits: Object.fromEntries(records) }) + '\n');
}
