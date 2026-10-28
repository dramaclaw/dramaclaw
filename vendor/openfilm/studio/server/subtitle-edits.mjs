// @ts-check
/**
 * The subtitles of one source as the timeline's subtitle row edits them: retimed, moved, split, merged, deleted, added
 * and typed (the editing itself is the editor's, studio/ui/src/lib/subtitle-cues.ts; this reads and writes).
 *
 * A source's subtitles are its transcript's lines (transcripts.mjs), each cut into subtitles by subtitle-segments.mjs.
 * The row shows and edits those subtitles, so they are read here as the film shows them: one cue per subtitle, in the
 * source's own milliseconds, each with its words' times and its translations (cut to follow it, as captions.mjs does).
 * Written back, the transcript holds one cue per subtitle and says so (CUT_NOTE): Studio no longer cuts its lines, the
 * person did. Its translations are written beside it at the same times.
 *
 * Every write answers the files as they were and as they are now (a Snapshot); undo and redo put one back, and only
 * over the files they left (anything written in between, by the agent or another window, is kept and said).
 *
 *   GET captions/source?src=     → SourceSubtitles
 *   PUT captions/source          { src, cues } → { before: Snapshot, after: Snapshot }
 *   PUT captions/files           { src, from: Snapshot, to: Snapshot } → { ok } (409 when the files are not `from`)
 */
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { isFilmSubtitleLanguage } from './film-subtitle.mjs';
import { inProject, inside } from './files.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { alignTranslation, segmentLine } from './subtitle-segments.mjs';
import { readTranscript, transcriptPath, translationsOf, vttOf } from './transcripts.mjs';

/** @typedef {import('./transcripts.mjs').SpokenLine} SpokenLine */
/**
 * One subtitle of a source, in its milliseconds. `line` and `part` say which it is as captions.mjs names it (a cue's
 * `line` and `part`), so the row finds the one a cue on the film shows.
 * @typedef {{ startMs: number, endMs: number, text: string, marks?: { index: number, startMs: number }[],
 *   alt?: Record<string, string>, line?: number, part?: number }} SourceCue
 * @typedef {{ src: string, cut: boolean, speaker?: string, cues: SourceCue[] }} SourceSubtitles
 * The transcript files of a source (path in the project → text, null: no such file).
 * @typedef {{ files: Record<string, string | null> }} Snapshot
 */

/** A source's text is at most this long: a transcript, not a book. */
const MAX_CUES = 5000;
const MAX_TEXT = 2000;

/**
 * The subtitles of `src` (a path in the project) as the film shows them, or none when it has no transcript.
 * @param {string} root @param {string} src @returns {Promise<SourceSubtitles>}
 */
export async function sourceSubtitles(root, src) {
  const said = await readTranscript(root, src);
  if (!said) return { src, cut: false, cues: [] };
  /** @type {Map<number, Record<string, string>>} */
  const alt = new Map();
  for (const language of await translationsOf(root, src)) {
    for (const line of (await readTranscript(root, src, language))?.lines ?? []) alt.set(line.startMs, { ...alt.get(line.startMs), [language]: line.text });
  }
  /** @type {SourceCue[]} */
  const cues = [];
  for (const line of said.lines) {
    const translated = Object.entries(alt.get(line.startMs) ?? {});
    if (said.cut) {
      cues.push({ ...lineOf(line), ...(translated.length ? { alt: Object.fromEntries(translated) } : {}), line: line.startMs });
      continue;
    }
    const pieces = segmentLine(line);
    const parts = translated.map(([language, text]) => /** @type {const} */ ([language, alignTranslation(text, pieces)]));
    pieces.forEach((piece, k) => {
      const altOf = Object.fromEntries(parts.map(([language, list]) => [language, list[k].text]).filter(([, text]) => text));
      cues.push({
        text: piece.text, startMs: piece.startMs, endMs: piece.endMs, ...(piece.marks?.length ? { marks: piece.marks } : {}),
        ...(Object.keys(altOf).length ? { alt: altOf } : {}), line: line.startMs, ...(pieces.length > 1 ? { part: k } : {}),
      });
    });
  }
  return { src, cut: Boolean(said.cut), ...(said.speaker ? { speaker: said.speaker } : {}), cues };
}

/** @param {SpokenLine} line */
const lineOf = (line) => ({ text: line.text, startMs: line.startMs, endMs: line.endMs, ...(line.marks?.length ? { marks: line.marks } : {}) });

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const whole = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN);

/**
 * Cues as a request has them, made safe to write: in order of start, none overlapping the next (an end past the next
 * start is brought back to it), none empty or of no length, word marks inside their text and their time.
 * @param {unknown} raw @returns {SourceCue[]}
 */
export function cleanCues(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_CUES) throw new HttpError(400, 'which subtitles? { src, cues: [{ startMs, endMs, text }] }');
  /** @type {SourceCue[]} */
  const cues = [];
  for (const one of raw) {
    if (!isRecord(one)) throw new HttpError(400, 'a subtitle is { startMs, endMs, text }');
    const startMs = Math.max(0, whole(one.startMs)), endMs = whole(one.endMs);
    const text = typeof one.text === 'string' ? one.text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '';
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new HttpError(400, 'a subtitle\'s times are milliseconds');
    if (!text || endMs <= startMs) continue;
    /** @type {Record<string, string>} */
    const alt = {};
    if (isRecord(one.alt)) {
      for (const [language, value] of Object.entries(one.alt)) {
        if (isFilmSubtitleLanguage(language) && typeof value === 'string' && value.trim()) alt[language] = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      }
    }
    const marks = Array.isArray(one.marks) ? one.marks.flatMap((m) => (isRecord(m) && Number.isInteger(m.index) && Number.isFinite(whole(m.startMs))
      ? [{ index: /** @type {number} */ (m.index), startMs: whole(m.startMs) }] : [])) : [];
    cues.push({ startMs, endMs, text, ...(marks.length ? { marks } : {}), ...(Object.keys(alt).length ? { alt } : {}) });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  /** @type {SourceCue[]} */
  const out = [];
  for (const [i, cue] of cues.entries()) {
    const prev = out.at(-1);
    const startMs = prev ? Math.max(cue.startMs, prev.endMs) : cue.startMs;
    const next = cues[i + 1];
    const endMs = next ? Math.min(cue.endMs, Math.max(next.startMs, startMs)) : cue.endMs;
    if (endMs <= startMs) continue;
    /* marks: inside the text, in order, inside the cue's time (the first word starts with the cue) */
    let last = -1;
    const marks = (cue.marks ?? []).filter((m) => {
      const ok = m.index > last && m.index < cue.text.length;
      if (ok) last = m.index;
      return ok;
    }).map((m) => ({ index: m.index, startMs: Math.min(endMs, Math.max(startMs, m.startMs)) }));
    out.push({ ...cue, startMs, endMs, ...(marks.length ? { marks } : {}) });
    if (!marks.length) delete out[out.length - 1].marks;
  }
  return out;
}

/** The transcript files of `src` now: its own and its translations', and `also` (paths of it, maybe not there). @param {string} root @param {string} src @param {readonly string[]} [also] */
async function snapshot(root, src, also = []) {
  const paths = new Set([transcriptPath(src), ...(await translationsOf(root, src)).map((language) => transcriptPath(src, language)), ...also]);
  /** @type {Snapshot} */
  const out = { files: {} };
  for (const path of [...paths].sort()) {
    const file = inProject(root, path);
    out.files[path] = file ? await readFile(file, 'utf8').catch(() => null) : null;
  }
  return out;
}

/**
 * Write `src`'s subtitles as `cues` (in its milliseconds): its transcript, cut by hand, and each translation at the same
 * times. A translation a cue no longer has loses that line; one no cue has is written empty (its file stays, so the
 * language stays known). Returns the files before and after.
 * @param {string} root @param {string} src @param {unknown} rawCues
 * @returns {Promise<{ before: Snapshot, after: Snapshot }>}
 */
export async function writeSourceSubtitles(root, src, rawCues) {
  if (!inProject(root, src)) throw new HttpError(400, `${src} is not a file inside the project`);
  const cues = cleanCues(rawCues);
  const had = await readTranscript(root, src);
  const languages = new Set([...await translationsOf(root, src), ...cues.flatMap((c) => Object.keys(c.alt ?? {}))]);
  const paths = [transcriptPath(src), ...[...languages].map((language) => transcriptPath(src, language))];
  const before = await snapshot(root, src, paths);
  /** @type {SpokenLine[]} */
  const lines = cues.map((c) => ({ text: c.text, startMs: c.startMs, endMs: c.endMs, ...(c.marks ? { marks: c.marks } : {}) }));
  await writeAtomic(inside(root, transcriptPath(src)), vttOf(lines, { ...(had?.speaker ? { speaker: had.speaker } : {}), cut: true }), 'utf8');
  for (const language of languages) {
    const translated = cues.flatMap((c) => (c.alt?.[language] ? [{ text: c.alt[language], startMs: c.startMs, endMs: c.endMs }] : []));
    await writeAtomic(inside(root, transcriptPath(src, language)), vttOf(translated), 'utf8');
  }
  return { before, after: await snapshot(root, src, paths) };
}

/** Whether `path` is one of `src`'s transcript files: `name.vtt` or `name.<language>.vtt` beside it. @param {string} src @param {string} path */
function transcriptOf(src, path) {
  if (path === transcriptPath(src)) return true;
  const name = basename(src, extname(src));
  const dir = dirname(src);
  const prefix = `${dir === '.' ? '' : `${dir}/`}${name}.`;
  return path.startsWith(prefix) && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.vtt$/.test(path.slice(prefix.length));
}

/** @param {unknown} v @param {string} src @returns {Snapshot} */
function snapshotOf(v, src) {
  if (!isRecord(v) || !isRecord(v.files)) throw new HttpError(400, 'a snapshot is { files: { path: text | null } }');
  /** @type {Record<string, string | null>} */
  const files = {};
  for (const [path, body] of Object.entries(v.files)) {
    if (!transcriptOf(src, path)) throw new HttpError(400, `${path} is not a transcript of ${src}`);
    if (body !== null && typeof body !== 'string') throw new HttpError(400, `what goes in ${path}?`);
    files[path] = body;
  }
  return { files };
}

/**
 * Put `src`'s transcript files back as `to`, when they are now as `from` left them (a file `to` has as null goes:
 * the step made it). Otherwise nothing is written, and a 409 says they changed.
 * @param {string} root @param {string} src @param {unknown} rawFrom @param {unknown} rawTo
 */
export async function restoreSourceFiles(root, src, rawFrom, rawTo) {
  if (!inProject(root, src)) throw new HttpError(400, `${src} is not a file inside the project`);
  const from = snapshotOf(rawFrom, src), to = snapshotOf(rawTo, src);
  const paths = [...new Set([...Object.keys(from.files), ...Object.keys(to.files)])];
  const now = await snapshot(root, src, paths);
  for (const path of paths) {
    if ((now.files[path] ?? null) !== (from.files[path] ?? null)) throw new HttpError(409, 'These subtitles were changed since, elsewhere: they are left as they are now.', { code: 'changed' });
  }
  for (const path of paths) {
    const body = to.files[path] ?? null;
    if (body === null) await rm(inside(root, path), { force: true });
    else await writeAtomic(inside(root, path), body, 'utf8');
  }
}

/**
 * The routes under /api/projects/:id/ (see the top). Returns whether it answered.
 * @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {string} root @param {string} rest
 */
export async function subtitleEditRoutes(req, res, root, rest) {
  if (rest === 'captions/source' && req.method === 'GET') {
    const src = new URL(req.url ?? '/', 'http://x').searchParams.get('src') ?? '';
    if (!src || !inProject(root, src)) throw new HttpError(400, `${src || 'which source?'} is not a file inside the project`);
    json(res, 200, await sourceSubtitles(root, src));
    return true;
  }
  if (rest === 'captions/source' && req.method === 'PUT') {
    const { src, cues } = /** @type {{ src?: unknown, cues?: unknown }} */ (await readJson(req));
    if (typeof src !== 'string') throw new HttpError(400, 'which source? { src, cues }');
    json(res, 200, await writeSourceSubtitles(root, src, cues));
    return true;
  }
  if (rest === 'captions/files' && req.method === 'PUT') {
    const { src, from, to } = /** @type {{ src?: unknown, from?: unknown, to?: unknown }} */ (await readJson(req));
    if (typeof src !== 'string') throw new HttpError(400, 'which source? { src, from, to }');
    await restoreSourceFiles(root, src, from, to);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}
