// @ts-check
/**
 * A project's film.html as Studio changes it: read with its revision, edited by clip id, written atomically over what
 * it was (what an edit leaves alone keeps its text).
 *
 * The agent and the person edit the same file. Studio never addresses a clip by its place (a track index and a clip
 * index move whenever the agent rewrites the file); every operation names the clip by its id. An edit carries the
 * revision it was made against; when the file changed since, the operations are replayed on the newer file, and any
 * that names a clip no longer there fails the whole edit instead of landing on another clip.
 *
 * The agent writes with its own tools, often the whole file from a copy it read earlier: a write that is not Studio's
 * is merged with the person's edits made since (person-edits.mjs) before Studio reads it for anything
 * (settleProjectFilm), so the person's edits stay.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_FILE, filmHtml, readFilm, readFilmFile } from '../../src/film-doc.mjs';
import { EditError, applyOps } from './ops.mjs';
import { filmMerged, filmToMerge, filmWritten, keepAside, mergeFilmWrite, replaceIfStill } from './person-edits.mjs';

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

/** @type {Map<string, Promise<unknown>>} each project's reads and writes of film.html, one at a time */
const queues = new Map();
/** @template T @param {string} root @param {() => Promise<T>} job @returns {Promise<T>} */
function serial(root, job) {
  const next = (queues.get(root) ?? Promise.resolve()).then(job);
  const settled = next.catch(() => {});
  queues.set(root, settled);
  void settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}

/** How long an outside write of film.html must stay the same bytes to be taken as finished. */
const STABLE_MS = 150;
/** A text cut off inside a tag: a write still on its way. */
const insideTag = (/** @type {string} */ text) => text.lastIndexOf('<') > text.lastIndexOf('>');

/**
 * The film as the folder has it, once a write of someone else's (the agent's) is merged with the person's edits made
 * since (person-edits.mjs): what Studio reads the film as. A file that does not read, or is cut off inside a tag (the
 * agent is writing it), is left alone and merged once it is whole. `stable` (the folder watcher's): a write to merge is
 * first left to settle, the same bytes read twice STABLE_MS apart, since a file cut off between two clips still reads
 * as a film; reads and edits never wait. Before the merge is written, the agent's text and the merge are kept aside in
 * the project's history, so a merge can always be undone by hand; it is written only over the text it was made from.
 * @param {string} root @param {{ stable?: boolean }} [o] @returns {ReturnType<typeof readProjectFilm>}
 */
export function settleProjectFilm(root, { stable = false } = {}) {
  return serial(root, () => settle(root, stable));
}

/** @returns {ReturnType<typeof readProjectFilm>} */
async function settle(/** @type {string} */ root, stable = false, tries = 0) {
  const current = await readProjectFilm(root);
  if (!current.value || insideTag(current.text)) return current;
  if (stable && tries < 20 && filmToMerge(root, current.rev)) {
    await new Promise((done) => setTimeout(done, STABLE_MS));
    const again = await readFile(join(root, FILM_FILE), 'utf8').catch(() => null);
    if (again !== current.text) return settle(root, stable, tries + 1);
  }
  const merge = await mergeFilmWrite(root, { rev: current.rev, value: current.value });
  if (!merge || !readFilm(merge.value).doc) return current;
  const text = filmHtml(merge.value, current.text);
  await keepAside(root, { 'agent.html': current.text, 'merged.html': text }, `Kept the person's edits over a write of film.html: ${merge.kept.map((k) => k.words).join('; ')}`);
  /* written again meanwhile: that write is the one to merge */
  if (!(await replaceIfStill(join(root, FILM_FILE), current.text, text))) return settle(root, stable, tries + 1);
  const rev = revOf(text);
  filmMerged(root, merge.value, rev, merge.kept);
  const { doc, problems } = readFilm(merge.value);
  /* the merged value is what the file reads as (it is written from it): not read again, which takes long in a long film */
  return { text, rev, value: /** @type {typeof current.value} */ (/** @type {unknown} */ (merge.value)), doc, problems };
}

/**
 * Change the film on disk as Studio does for the person, once any write of someone else's is merged: `change` gets
 * its value to change (a copy) and returns whether it changed it. Written only over the text it was read as (else it
 * is done again on the newer file), and recorded as the person's edit (person-edits.mjs) with the edit's `ops` when
 * there are some; an `undo` is done with the edits it puts back. Null when nothing changed.
 * @template {{ value: FilmValue }} R
 * @param {string} root @param {(value: FilmValue, current: Awaited<ReturnType<typeof readProjectFilm>>) => R | null} change
 * @param {{ ops?: Op[], undo?: boolean }} [edit]
 * @returns {Promise<(R & { text: string, rev: string, current: Awaited<ReturnType<typeof readProjectFilm>> }) | null>}
 */
export function changeProjectFilm(root, change, edit = {}) {
  return serial(root, async () => {
    for (let tries = 0; ; tries++) {
      const current = await settle(root);
      const made = change(/** @type {FilmValue} */ (structuredClone(current.value ?? EMPTY_FILM)), current);
      if (!made) return null;
      const text = filmHtml(made.value, current.text);
      if (await replaceIfStill(join(root, FILM_FILE), current.text, text)) {
        const rev = revOf(text);
        filmWritten(root, current.value, made.value, rev, edit);
        return { ...made, text, rev, current };
      }
      if (tries >= 10) throw new EditError(`${FILM_FILE} keeps changing: try again`, 'conflict');
    }
  });
}

/**
 * Apply an edit to the film on disk. `base` is the revision the edit was made against; a newer file gets the same
 * operations by clip id. Returns the new text, revision, the value written and the checked edit. Throws EditError:
 * `conflict` when an operation names a clip that is gone, `invalid` when the result is not a film. `undo`: the edit
 * puts back an earlier one of the person's.
 * @param {string} root @param {string | null} base @param {Op[]} ops @param {{ undo?: boolean }} [o]
 */
export async function editProjectFilm(root, base, ops, { undo = false } = {}) {
  const done = await changeProjectFilm(root, (start, current) => {
    /* a film.html that does not read is the agent's to fix: Studio never writes over it */
    if (!current.value && current.text.trim()) throw new EditError(current.problems.join('\n'), 'invalid');
    const value = applyOps(start, ops);
    const { doc, problems } = readFilm(value);
    if (!doc) throw new EditError(problems.join('\n'), 'invalid');
    return { value, doc };
  }, { ops, undo });
  if (!done) throw new EditError('nothing to edit', 'invalid');
  return { text: done.text, rev: done.rev, value: done.value, doc: done.doc, rebased: base != null && base !== done.current.rev };
}

