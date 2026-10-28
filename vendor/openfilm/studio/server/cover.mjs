// @ts-check
/**
 * A project's own cover: the picture its card shows in the projects list in place of the film's poster, chosen by the
 * person (a picture from this computer, a picture of the project, or the film at a moment). It is Studio's, kept in
 * `.film/cover.<ext>` as a copy; without one, the card shows the film's poster (pageframes.mjs filmPoster).
 */
import { statSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The kinds of picture a cover may be, by the ending its copy is kept under. */
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** How wide the film is drawn for a cover taken of it: as wide as a frame is drawn (pageframes.mjs), sharp on any card. */
export const COVER_FRAME_W = 960;

/** A cover is a picture for a card, never footage. */
export const COVER_MAX_BYTES = 20 << 20;

export class CoverError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** What kind of picture the bytes are, by their first bytes (a name or a header can say anything). */
export function pictureType(/** @type {Buffer} */ bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (bytes.length > 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'gif';
  return null;
}

/* `.film/` (projects.mjs TOOL_DIR, not imported: projects.mjs lists each project's cover with coverAt) */
const coverPath = (/** @type {string} */ root, /** @type {string} */ ext) => join(root, '.film', `cover.${ext}`);

/** When the project's cover was set (ms), for its card to ask for the new picture; null when it has none. */
export function coverAt(/** @type {string} */ root) {
  for (const ext of Object.keys(TYPES)) {
    const info = statSync(coverPath(root, ext), { throwIfNoEntry: false });
    if (info?.isFile()) return Math.round(info.mtimeMs);
  }
  return null;
}

/**
 * The project's cover, if it has one: where it is, its media type and when it was set (ms).
 * @param {string} root
 * @returns {Promise<{ path: string, type: string, at: number } | null>}
 */
export async function readCover(root) {
  for (const [ext, type] of Object.entries(TYPES)) {
    const path = coverPath(root, ext);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) return { path, type, at: Math.round(info.mtimeMs) };
  }
  return null;
}

/**
 * Make these bytes the project's cover, in place of any it had. Written whole before it takes the old one's place: a
 * card never shows half a picture.
 * @param {string} root @param {Buffer} bytes
 */
export async function setCover(root, bytes) {
  if (bytes.length > COVER_MAX_BYTES) throw new CoverError('That picture is too large for a cover.', 413);
  const ext = pictureType(bytes);
  if (!ext) throw new CoverError('A cover has to be a JPEG, PNG, WebP or GIF picture.', 415);
  const path = coverPath(root, ext);
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
  for (const other of Object.keys(TYPES)) if (other !== ext) await rm(coverPath(root, other), { force: true });
  return /** @type {NonNullable<Awaited<ReturnType<typeof readCover>>>} */ (await readCover(root));
}

/** A picture of the project made its cover; `abs`, where it is (files.mjs readable). @param {string} root @param {string} abs */
export async function setCoverFromFile(root, abs) {
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new CoverError('That picture is not there any more.', 404);
  if (info.size > COVER_MAX_BYTES) throw new CoverError('That picture is too large for a cover.', 413);
  return setCover(root, await readFile(abs));
}

/** No cover of its own: the card shows the film's poster again. @param {string} root */
export async function clearCover(root) {
  for (const ext of Object.keys(TYPES)) await rm(coverPath(root, ext), { force: true });
}

/** The request's body as bytes, at most a cover's size. @param {import('node:http').IncomingMessage} req */
export async function readCoverBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > COVER_MAX_BYTES) throw new CoverError('That picture is too large for a cover.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
