// @ts-check
/**
 * A page of a project read and written as text, for what Studio writes into a page (layers pasted, the editor's
 * lib/layer-paste). Each read says the page's `rev`; a write names the rev it was made from and is refused when the
 * page changed since (the agent wrote it meanwhile), so nothing written by someone else is written over. A page
 * written where there was none (`expect: null`) is a new one; `text: null` takes a page away (to the trash). A page is
 * written back in the encoding it has.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FileError, inside, trashFile } from './files.mjs';
import { filesWritten } from './person-edits.mjs';

const PAGE = /\.html?$/i;

/** A page's rev: what a write names to say which page it was made from (its bytes, whatever they say). */
export const revOf = (/** @type {string | Buffer} */ bytes) => createHash('sha1').update(bytes).digest('hex');

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A page's text: UTF-8 (a mark at its start kept), else one byte a character (an older page's own encoding, read and
 * written back byte for byte, so what is not changed stays what it was).
 * @param {Buffer} bytes
 */
function decode(bytes) {
  try { return { text: UTF8.decode(bytes), bytewise: false }; } catch { return { text: bytes.toString('latin1'), bytewise: true }; }
}

/** @param {string} text @param {boolean} bytewise @param {string} rel */
function encode(text, bytewise, rel) {
  if (!bytewise) return Buffer.from(text, 'utf8');
  if (/[^\u0000-\u00ff]/.test(text)) {
    throw new FileError(`${rel} is not written in UTF-8, and what goes in it has characters its encoding cannot hold`, 415);
  }
  return Buffer.from(text, 'latin1');
}

/** @param {string} root @param {unknown} rel */
function pagePath(root, rel) {
  if (typeof rel !== 'string' || !PAGE.test(rel)) throw new FileError('a page of the project (.html), please');
  return inside(root, rel);
}

/**
 * The page `rel` of the project at `root`, as text, with its rev.
 * @param {string} root @param {unknown} rel
 */
export async function readPage(root, rel) {
  const abs = pagePath(root, rel);
  if (!existsSync(abs)) throw new FileError(`${rel} is not there`, 404);
  const bytes = await readFile(abs);
  return { text: decode(bytes).text, rev: revOf(bytes) };
}

/**
 * The page `rel` written as `text` (null: taken away), when it is still the page of rev `expect` (null: when there is
 * no page there yet), in the encoding it has. Its new rev (null once taken away). `undo`: the write takes back one of
 * Studio's own (a paste undone), for what keeps track of Studio's writes.
 * @param {string} root @param {unknown} rel @param {string | null} text @param {string | null} expect
 * @param {{ undo?: boolean }} [how]
 */
export async function writePage(root, rel, text, expect, { undo = false } = {}) {
  const abs = pagePath(root, rel);
  const bytes = existsSync(abs) ? await readFile(abs) : null;
  const now = bytes ? revOf(bytes) : null;
  if (now !== expect) {
    throw new FileError(expect == null ? `${rel} is there already` : `${rel} was changed since (by the agent, or in another window)`, 409);
  }
  if (text == null) {
    if (bytes) await trashFile(root, /** @type {string} */ (rel));
    filesWritten(root, { [/** @type {string} */ (rel)]: bytes }, { [/** @type {string} */ (rel)]: null }, { undo });
    return { rev: null };
  }
  if (typeof text !== 'string') throw new FileError('the page\'s text, please');
  const out = encode(text, bytes ? decode(bytes).bytewise : false, /** @type {string} */ (rel));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, out);
  /* kept over an agent's write of the page from an older copy (person-edits.mjs), as the bytes written */
  filesWritten(root, { [/** @type {string} */ (rel)]: bytes }, { [/** @type {string} */ (rel)]: out }, { undo });
  return { rev: revOf(out) };
}
