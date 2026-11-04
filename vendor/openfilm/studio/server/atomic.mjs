// @ts-check
/**
 * Writing a file whole or not at all: the bytes go to a sibling with a name of its own (random, so two writes at once
 * never share one), which is then renamed over the file. On Windows a rename onto a file someone else has open
 * (Defender, the search indexer, OneDrive, an editor) fails for a moment with EPERM, EBUSY or EACCES: it is tried
 * again a few times, as graceful-fs does.
 */
import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** A name beside `path` for the bytes on their way to it. */
export const tempPath = (/** @type {string} */ path) => `${path}.${randomBytes(6).toString('hex')}.tmp`;

/** Rename `from` over `to`, trying again while Windows says the file is busy. */
export async function replaceFile(/** @type {string} */ from, /** @type {string} */ to) {
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code ?? '';
      if (process.platform !== 'win32' || !BUSY.has(code) || attempt >= 8) throw e;
      await new Promise((done) => setTimeout(done, 20 * 2 ** attempt));
    }
  }
}

/**
 * Write `data` to `path` atomically.
 * @param {string} path @param {string | Uint8Array} data @param {import('node:fs').WriteFileOptions} [options]
 */
export async function writeAtomic(path, data, options) {
  const tmp = tempPath(path);
  try {
    await writeFile(tmp, data, options);
    await replaceFile(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
