// @ts-check
/**
 * A project's film.html as Studio changes it: read with its revision, edited by clip id, written atomically over what
 * it was (what an edit leaves alone keeps its text).
 *
 * The agent and the person edit the same file. Studio never addresses a clip by its place (a track index and a clip
 * index move whenever the agent rewrites the file); every operation names the clip by its id. An edit carries the
 * revision it was made against; when the file changed since, the operations are replayed on the newer file, and any
 * that names a clip no longer there fails the whole edit instead of landing on another clip.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_FILE, filmHtml, readFilm, readFilmFile } from '../../src/film-doc.mjs';
import { EditError, applyOps } from './ops.mjs';
import { writeAtomic } from './atomic.mjs';

export { EditError };

/** @typedef {import('./ops.mjs').FilmValue} FilmValue @typedef {import('./ops.mjs').Op} Op */

/** What a folder starts as: one 1920×1080 stage and no clips. */
export const EMPTY_FILM = Object.freeze({ stage: Object.freeze({ w: 1920, h: 1080 }), tracks: Object.freeze([]) });

/** The revision of a film.html text: what an edit is made against. */
export const revOf = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * The film as it is on disk: its text, revision, the raw value (clips named, see readFilm) and the checked edit, or the
 * problems that keep it from being one. A folder without film.html reads as an empty film.
 * @param {string} root
 */
export async function readProjectFilm(root) {
  let text;
  try { text = await readFile(join(root, FILM_FILE), 'utf8'); }
  catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    text = '';
  }
  const rev = revOf(text);
  if (!text.trim()) return { text, rev, value: null, doc: null, problems: [`${FILM_FILE} is empty`] };
  const { value, doc, problems } = readFilmFile(text);
  return { text, rev, value: doc ? value : null, doc, problems };
}

/**
 * How a page clip is drawn, by its id, as film.html has it now: its overrides (SPEC §1, null when none) and the size
 * its page is laid out at (its `size`, null when it has none). What its thumbnails are drawn with; null when no clip
 * has that id.
 * @param {string} root @param {string} id
 * @returns {Promise<{ overrides: object[] | null, size: { w: number, h: number } | null } | null>}
 */
export async function pageClipLook(root, id) {
  const { value } = await readProjectFilm(root);
  for (const track of value?.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      if (clip.id === id) return { overrides: clip.overrides?.length ? clip.overrides : null, size: clip.size?.w && clip.size?.h ? clip.size : null };
    }
  }
  return null;
}

/**
 * film.html as Studio writes it: over `before` (its text as read), so what did not change stays as it was, through a
 * temporary file so no reader sees half.
 * @param {string} root @param {FilmValue} value @param {string} [before]
 */
export async function writeProjectFilm(root, value, before = '') {
  const text = filmHtml(value, before);
  const path = join(root, FILM_FILE);
  await writeAtomic(path, text);
  return { text, rev: revOf(text) };
}

/**
 * Apply an edit to the film on disk. `base` is the revision the edit was made against; a newer file gets the same
 * operations by clip id. Returns the new text, revision, the value written and the checked edit. Throws EditError:
 * `conflict` when an operation names a clip that is gone, `invalid` when the result is not a film.
 * @param {string} root @param {string | null} base @param {Op[]} ops
 */
export async function editProjectFilm(root, base, ops) {
  const current = await readProjectFilm(root);
  /* a film.html that does not read is the agent's to fix: Studio never writes over it */
  if (!current.value && current.text.trim()) throw new EditError(current.problems.join('\n'), 'invalid');
  const value = applyOps(/** @type {FilmValue} */ (structuredClone(current.value ?? EMPTY_FILM)), ops);
  const { doc, problems } = readFilm(value);
  if (!doc) throw new EditError(problems.join('\n'), 'invalid');
  const written = await writeProjectFilm(root, /** @type {FilmValue} */ (value), current.text);
  return { ...written, value, doc, rebased: base != null && base !== current.rev };
}

