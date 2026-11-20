// @ts-check
/**
 * Read-only copies of saved versions on the film origin. Previews never check out the working project or borrow its
 * current media. Repeated requests share a preparation; failed copies can be retried. Copies live outside the
 * project, so its watcher never sees them; the last KEPT are kept, and they are removed when Studio closes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyVersion, HistoryError } from './history.mjs';

/** How many versions' copies are kept: each is the whole project, footage included (a full copy on Windows and Linux). */
const KEPT = 3;

export function createHistoryPreviews() {
  /** @type {Map<string, Promise<{ path: string, missing: string[] }>>} the copies, the one used last at the end */
  const copies = new Map();
  let closed = false;
  /* the copies used longest ago go, past KEPT: one looked at again is copied again */
  const trim = () => {
    for (const [key, copy] of [...copies].slice(0, Math.max(0, copies.size - KEPT))) {
      copies.delete(key);
      void copy.then((prepared) => rm(prepared.path, { recursive: true, force: true }), () => {});
    }
  };
  return {
    /** @param {string} root @param {string} commit */
    get(root, commit) {
      if (closed) throw new HistoryError('version previews are closed', 503);
      if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new HistoryError('which version?', 400, 'none');
      const key = `${root}\0${commit}`;
      let copy = copies.get(key);
      /* used again: the last used */
      if (copy) { copies.delete(key); copies.set(key, copy); }
      if (!copy) {
        copy = (async () => {
          const path = await mkdtemp(join(tmpdir(), 'openfilm-history-preview-'));
          try {
            const { missing } = await copyVersion(root, commit, path);
            return { path, missing };
          } catch (e) {
            await rm(path, { recursive: true, force: true });
            copies.delete(key);
            throw e;
          }
        })();
        copies.set(key, copy);
        trim();
      }
      return copy;
    },
    /** Forget deleted versions, including their prepared read-only files.
     * @param {string} root @param {string[]} commits
     */
    async invalidate(root, commits) {
      const pending = [...copies.entries()].filter(([key]) => {
        const [folder, id] = key.split('\0');
        return folder === root && commits.some((commit) => commit.startsWith(id));
      });
      for (const [key] of pending) copies.delete(key);
      await Promise.all(pending.map(async ([, copy]) => {
        const prepared = await copy.catch(() => null);
        if (prepared) await rm(prepared.path, { recursive: true, force: true });
      }));
    },
    async close() {
      closed = true;
      const prepared = await Promise.allSettled(copies.values());
      await Promise.all(prepared.map((r) => r.status === 'fulfilled' ? rm(r.value.path, { recursive: true, force: true }) : undefined));
      copies.clear();
    },
  };
}
