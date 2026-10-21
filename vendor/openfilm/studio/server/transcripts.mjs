// @ts-check
/**
 * What a media file says: a WebVTT beside it with the same name (`assets/vo/1.wav` → `assets/vo/1.vtt`), and its
 * translations beside that (`1.zh.vtt`). Its times are the file's own seconds. A cue is a subtitle line; the times of
 * its words are WebVTT timestamp tags inside it (`<00:00:01.250>`); a voice tag (`<v Name>`) says who speaks.
 *
 * `openfilm get tts` writes one when its service times the words, `get asr` for any speech, an agent for speech it
 * makes itself, and the person's edits in Studio go back into it. The film's subtitles are made from these (captions.mjs).
 *
 * `src` comes from film.html or a request: a transcript is read or written only inside the project (files.mjs inside),
 * never at a `../` or through a link out of the folder.
 *
 * Studio cuts each line into subtitles itself (subtitle-segments.mjs). A transcript whose subtitles the person timed on
 * the timeline (subtitle-edits.mjs) says so in a note at its top (CUT_NOTE): each of its cues is then one subtitle as
 * it is, not cut again. The note is a WebVTT comment, so every other reader takes the file as it always did.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { inProject, inside, trashFile } from './files.mjs';
import { alignTranslation, replacePiece, segmentLine } from './subtitle-segments.mjs';

/** @typedef {{ token: string, startSec: number, endSec?: number }} Word */

/**
 * A subtitle line, in its source's milliseconds. `marks`: where each timed word starts in `text`, and when.
 * @typedef {{ text: string, startMs: number, endMs: number, marks?: { index: number, startMs: number }[] }} SpokenLine
 * `cut`: each line is one subtitle as it is (CUT_NOTE).
 * @typedef {{ lines: SpokenLine[], speaker?: string, cut?: boolean }} Transcript
 */

/** The note at the top of a transcript whose lines are each one subtitle, as the person cut them. */
export const CUT_NOTE = 'NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.';
const CUT_NOTE_RE = /^NOTE Each cue is one subtitle\b/;

/** The transcript of `src` (a path in the project), in `language` when given: its translation. @param {string} src @param {string} [language] */
export function transcriptPath(src, language) {
  const name = basename(src, extname(src));
  const dir = dirname(src);
  return `${dir === '.' ? '' : `${dir}/`}${name}${language ? `.${language}` : ''}.vtt`;
}

/** `00:01.250` or `00:00:01.250` → milliseconds. @param {string} stamp */
function msOf(stamp) {
  const parts = stamp.trim().split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return NaN;
  return Math.round(parts.reduce((acc, n) => acc * 60 + n, 0) * 1000);
}

/** milliseconds → `00:00:01.250`. @param {number} ms */
function stampOf(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000), m = Math.floor(t / 60_000) % 60, s = Math.floor(t / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(t % 1000).padStart(3, '0')}`;
}

const unescape = (/** @type {string} */ s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const escape = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A WebVTT's lines. Tags other than timestamps and voices (`<b>`, `<c.x>`, `<lang>`) are dropped; a cue's own lines
 * are one subtitle line.
 * @param {string} body @returns {Transcript}
 */
export function parseVtt(body) {
  /** @type {SpokenLine[]} */
  const lines = [];
  /** @type {string | undefined} */
  let speaker;
  let cut = false;
  for (const block of body.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/)) {
    const rows = block.split('\n');
    if (CUT_NOTE_RE.test(rows[0] ?? '')) cut = true;
    const timing = rows.findIndex((r) => r.includes('-->'));
    if (timing < 0 || /^(NOTE|STYLE|REGION)\b/.test(rows[0] ?? '')) continue;
    const [a, b] = rows[timing].split('-->');
    const startMs = msOf(a), endMs = msOf(b.trim().split(/\s+/)[0] ?? '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    let raw = '';
    /** @type {{ index: number, startMs: number }[]} */
    const timed = [];
    let pending = /** @type {number | null} */ (null);
    for (const [, tag, chunk] of rows.slice(timing + 1).join(' ').matchAll(/<([^>]*)>|([^<]+)/g)) {
      if (tag !== undefined) {
        const at = msOf(tag);
        if (Number.isFinite(at)) pending = at;
        else if (/^v[\s.]/.test(tag)) speaker ??= tag.replace(/^v(\.\S*)?\s+/, '').trim() || undefined;
        continue;
      }
      const piece = unescape(chunk);
      if (pending !== null && piece.trim()) { timed.push({ index: raw.length + piece.length - piece.trimStart().length, startMs: pending }); pending = null; }
      raw += piece;
    }
    const said = raw.replace(/\s+/g, ' ').trim();
    if (!said) continue;
    const marks = remapMarks(raw, said, timed);
    /* a line whose words are timed: its first word starts with the cue */
    const all = marks.length && marks[0].index > 0 ? [{ index: 0, startMs }, ...marks] : marks;
    lines.push({ text: said, startMs, endMs: Math.max(endMs, startMs + 1), ...(all.length ? { marks: all } : {}) });
  }
  return { lines, ...(speaker ? { speaker } : {}), ...(cut ? { cut: true } : {}) };
}

/**
 * Marks found in the raw cue text, moved to the same characters once runs of spaces are one and the ends trimmed.
 * @param {string} raw @param {string} said @param {{ index: number, startMs: number }[]} marks
 */
function remapMarks(raw, said, marks) {
  /* the position in `said` of each raw position: spaces collapse, leading ones go */
  const at = new Array(raw.length + 1).fill(0);
  let j = 0, prevSpace = true;
  for (let i = 0; i < raw.length; i += 1) {
    at[i] = j;
    const space = /\s/.test(raw[i]);
    if (space && prevSpace) continue;
    j += 1;
    prevSpace = space;
  }
  at[raw.length] = j;
  return marks.map((m) => ({ index: Math.min(said.length, at[m.index] ?? said.length), startMs: m.startMs }))
    .filter((m, i, list) => m.index < said.length && (i === 0 || m.index > list[i - 1].index));
}

/**
 * A WebVTT of `lines`, the words timed where their marks are; `cut`: with CUT_NOTE.
 * @param {readonly SpokenLine[]} lines @param {{ speaker?: string, cut?: boolean }} [options]
 */
export function vttOf(lines, { speaker, cut } = {}) {
  const cues = lines.map((line) => {
    const marks = (line.marks ?? []).filter((m) => m.index > 0 && m.index < line.text.length);
    let payload = '', from = 0;
    for (const m of marks) {
      payload += `${escape(line.text.slice(from, m.index))}<${stampOf(m.startMs)}>`;
      from = m.index;
    }
    payload += escape(line.text.slice(from));
    return `${stampOf(line.startMs)} --> ${stampOf(line.endMs)}\n${speaker ? `<v ${speaker}>` : ''}${payload}`;
  });
  return `WEBVTT\n\n${cut ? `${CUT_NOTE}\n\n` : ''}${cues.join('\n\n')}\n`;
}

/** @param {string} path */
async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch { return null; }
}

/**
 * The transcript of `src` (in `language`: its translation), or null when it has none.
 * @param {string} root @param {string} src @param {string} [language] @returns {Promise<Transcript | null>}
 */
export async function readTranscript(root, src, language) {
  const file = inProject(root, transcriptPath(src, language));
  const body = file ? await readText(file) : null;
  if (body == null) return null;
  const read = parseVtt(body);
  if (!read.lines.length) return null;
  /* cut by hand: one word a cue is what the person made */
  return !read.cut && wordCues(read.lines) ? { ...read, lines: linesOfWords(read.lines) } : read;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Pieces of text joined as they are written: a space between words, none next to CJK. @param {readonly string[]} parts */
function joinParts(parts) {
  let out = '';
  for (const part of parts) out += out && !CJK.test(out.slice(-1)) && !CJK.test(part.slice(0, 1)) ? ` ${part}` : part;
  return out;
}

/** Whether a transcript's cues are its words, one each (as some tools time speech), rather than its lines. @param {readonly SpokenLine[]} lines */
function wordCues(lines) {
  if (lines.length < 3) return false;
  const words = lines.filter((l) => !/\s/.test(l.text) && l.endMs - l.startMs < 1200).length;
  return words / lines.length > 0.8;
}

/**
 * Word cues made into lines, as a transcript is cut (spokenLines), each word still timed. A cue of one letter after
 * another is the same word spelt out letter by letter: no space between them.
 * @param {readonly SpokenLine[]} cues
 */
function linesOfWords(cues) {
  const words = cues.map((c) => ({ token: c.text, startSec: c.startMs / 1000, endSec: c.endMs / 1000 }));
  let text = '';
  cues.forEach((c, i) => {
    const letters = c.text.length === 1 && cues[i - 1]?.text.length === 1;
    text = letters ? text + c.text : joinParts([text, c.text].filter(Boolean));
  });
  return spokenLines(text, words, cues.at(-1)?.endMs);
}

/** Keep `src`'s transcript (or its translation into `language`). @param {string} root @param {string} src @param {Transcript} transcript @param {string} [language] */
export async function writeTranscript(root, src, transcript, language) {
  await writeAtomic(inside(root, transcriptPath(src, language)), vttOf(transcript.lines, {
    ...(transcript.speaker ? { speaker: transcript.speaker } : {}), ...(transcript.cut ? { cut: true } : {}),
  }), 'utf8');
}

/** Whether `src` has a transcript made since the file itself last changed. @param {string} root @param {string} src */
export async function transcriptIsCurrent(root, src) {
  const file = inProject(root, src), vtt = inProject(root, transcriptPath(src));
  if (!file || !vtt) return false;
  const [media, words] = await Promise.all([stat(file).catch(() => null), stat(vtt).catch(() => null)]);
  return Boolean(media && words && words.mtimeMs >= media.mtimeMs);
}

/**
 * A sound or video made again in place (a voice-over spoken again under its name, a service's answer saved over the
 * last one): its transcript and translations are the old take's, and go to the trash. Subtitles are never timed by
 * another take's words; when the new one came with timed words, its own transcript is written after.
 * @param {string} root @param {string} src
 */
export async function dropTranscripts(root, src) {
  for (const rel of [transcriptPath(src), ...(await translationsOf(root, src)).map((language) => transcriptPath(src, language))]) {
    const abs = inProject(root, rel);
    if (abs && await stat(abs).catch(() => null)) await trashFile(root, rel).catch(() => {});
  }
}

/** The languages `src` has a translation in (`name.<language>.vtt` beside it). @param {string} root @param {string} src */
export async function translationsOf(root, src) {
  const name = basename(src, extname(src));
  const file = inProject(root, src);
  if (!file) return [];
  const names = await readdir(dirname(file)).catch(() => /** @type {string[]} */ ([]));
  /** @type {string[]} */
  const out = [];
  for (const file of names) {
    const m = file.startsWith(`${name}.`) && /^\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.vtt$/.exec(file.slice(name.length));
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * The person's change to one line: the line of `src`'s transcript that starts at `startMs` reads `text` now. Its
 * timed words go (a changed line is timed as a whole); returns whether there was such a line. With a `language`, the
 * line's translation into it changes instead (made, at the original's times, when that line had none yet).
 *
 * With a `part`, only that subtitle of the line changes (the pieces subtitle-segments.mjs cuts the line into, the same
 * every time for the same line): its words are replaced in the line, the other pieces' words keep their times. In a
 * translation, the part of it that follows that piece (alignTranslation).
 * @param {string} root @param {string} src @param {number} startMs @param {string} text @param {string} [language]
 * @param {number} [part]
 */
export async function setLine(root, src, startMs, text, language, part) {
  const had = await readTranscript(root, src);
  const original = had?.lines.find((l) => l.startMs === startMs);
  if (!had || !original) return false;
  const said = text.replace(/\s+/g, ' ').trim();
  /* a transcript cut by hand shows each line whole: a part of it is all of it */
  const pieces = part === undefined || had.cut ? null : segmentLine(original);
  const piece = pieces?.[part ?? 0];
  if (pieces && !piece) return false;
  if (language) {
    const kept = (await readTranscript(root, src, language))?.lines ?? [];
    const others = kept.filter((l) => l.startMs !== startMs);
    const before = kept.find((l) => l.startMs === startMs);
    /* a piece of a translated line: its words in the translation; a line with no translation yet gets the words */
    const next = before && pieces && piece ? replacePiece(before, alignTranslation(before.text, pieces)[piece.part], said).text : said;
    const lines = next ? [...others, { text: next, startMs, endMs: original.endMs }].sort((a, b) => a.startMs - b.startMs) : others;
    await writeTranscript(root, src, { lines }, language);
    return true;
  }
  /** @type {SpokenLine | null} */
  let changed;
  if (piece) {
    const next = replacePiece(original, piece, said, piece.startMs);
    changed = next.text ? { ...next, startMs: original.startMs, endMs: original.endMs } : null;
  } else {
    if (said === original.text) return true;
    changed = said ? { text: said, startMs: original.startMs, endMs: original.endMs } : null;
  }
  const lines = changed ? had.lines.map((l) => (l === original ? changed : l)) : had.lines.filter((l) => l !== original);
  await writeTranscript(root, src, { ...had, lines });
  return true;
}

/** Everything the project's transcripts say (not their translations), for telling which language it speaks. @param {string} root */
export async function projectSpeech(root) {
  /** @type {string[]} */
  const out = [];
  const walk = async (/** @type {string} */ rel) => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) await walk(path); }
      else if (entry.name.endsWith('.vtt') && !/\.[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\.vtt$/.test(entry.name)) {
        const file = inProject(root, path);
        if (file) out.push(parseVtt(await readText(file) ?? '').lines.map((l) => l.text).join(' '));
      }
    }
  };
  await walk('assets');
  return out.join(' ');
}

/* ── lines ───────────────────────────────────────────────────────────────── */

/*
 * A transcript broken into subtitle lines, by the usual rules (not equal lengths):
 *   · a line ends after the end of a sentence: one sentence per line reads easiest;
 *   · too long, it breaks after a clause mark (comma, enumeration comma), else at the length;
 *   · a pause of GAP_MS ends a line too: the pause was a boundary already.
 * A line's text comes from the text (spaces and punctuation are lost in tokens), its times from the word timings.
 * Performance tags for TTS ([short pause]) are taken out first: they are not words.
 */

/** A line holds at most this many cells: a full-width character is one, anything else half. */
const MAX_CELLS = 20;
/** A sentence with only this many cells left stays on its line: a stub line reads worse than a longer one. */
const TAIL_CELLS = 6;
/** A hard break looks for a pause of at least this between two words. */
const MIN_BREAK_GAP_MS = 120;
/** A pause this long breaks the line. */
const GAP_MS = 700;
/** Without timing, about how long a cell takes to say. */
const FALLBACK_MS_PER_CELL = 180;
const SENTENCE_END = /[。！？!?…;；]/;
/* full-width and half-width both: Chinese text uses the full-width comma */
const CLAUSE_END = /[,，、:：]/;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
/* the structural particles de, le, de, de, zhe: after these a Chinese word has almost always ended */
const PARTICLE = /[\u7684\u4e86\u5730\u5f97\u7740]/;
const AUDIO_TAG = /\[[a-z][a-z '-]{1,30}\] ?/g;

/** @param {string} t */
function cells(t) {
  let n = 0;
  for (const ch of t) n += WIDE.test(ch) ? 1 : 0.5;
  return n;
}

/** @param {string} t */
export function stripAudioTags(t) {
  return t.replace(AUDIO_TAG, '').replace(/ {2,}/g, ' ').trim();
}

/** A half-width full stop ends a sentence only before a space or the end, and not after a digit (1.21, 0.5%). @param {string} t @param {number} i */
function endsSentence(t, i) {
  const ch = t[i];
  if (SENTENCE_END.test(ch)) return true;
  if (ch !== '.') return false;
  const next = t[i + 1];
  if (next != null && !/\s/.test(next)) return false;
  return !/\d/.test(t[i - 1] ?? '');
}

/** Each word's place in the text (words are said in order; one that does not match is skipped). @param {string} t @param {readonly Word[]} words */
function alignedAt(t, words) {
  /** @type {{ index: number, startSec: number, endSec?: number }[]} */
  const out = [];
  let cursor = 0;
  for (const w of words) {
    if (!w.token) continue;
    const index = t.indexOf(w.token, cursor);
    if (index < 0) continue;
    out.push({ index, startSec: Number.isFinite(w.startSec) ? w.startSec : 0, ...(w.endSec !== undefined ? { endSec: w.endSec } : {}) });
    cursor = index + w.token.length;
  }
  return out;
}

/** Chinese with no pause to break at: after the last structural particle in the second half of the line. @param {string} t @param {number} from @param {number} to */
function particleBreak(t, from, to) {
  for (let k = to - 1; k > from; k -= 1) {
    if (cells(t.slice(from, k)) < MAX_CELLS / 2) break;
    if (PARTICLE.test(t[k - 1])) return k;
  }
  return -1;
}

/** Cells from `i` to the next clause or sentence mark (a line full right before a comma breaks after it, not before the word). @param {string} t @param {number} i */
function restOfClause(t, i) {
  let j = i;
  while (j < t.length && !endsSentence(t, j) && !CLAUSE_END.test(t[j])) j += 1;
  return cells(t.slice(i, j + 1));
}

/**
 * The text cut into lines, as [from, to) indexes. `pauseAt(from, to)`: with no mark to break at, before the longest
 * pause in (from, to] (Chinese has no spaces: the speaker's own pause is the word boundary).
 * @param {string} t @param {(from: number, to: number) => number} [pauseAt]
 */
function chunks(t, pauseAt) {
  /** @type {{ from: number, to: number }[]} */
  const out = [];
  let from = 0;
  let fallback = -1;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (CLAUSE_END.test(ch)) fallback = i + 1;
    const long = cells(t.slice(from, i + 1)) >= MAX_CELLS;
    if (endsSentence(t, i)) {
      let to = i + 1;
      while (to < t.length && SENTENCE_END.test(t[to])) to += 1;
      out.push({ from, to });
      from = to;
      i = to - 1;
      fallback = -1;
      continue;
    }
    if (!long) continue;
    if (fallback <= from && cells(t.slice(from, i + 1)) < MAX_CELLS + TAIL_CELLS && restOfClause(t, i + 1) <= TAIL_CELLS) continue;
    /* too long: a clause mark, else a space (Latin text must not break inside a word), else a pause, a particle, here */
    let to = fallback > from ? fallback : -1;
    if (to <= from) {
      const space = t.lastIndexOf(' ', i);
      const pause = space > from ? -1 : pauseAt?.(from, i + 1) ?? -1;
      const particle = pause > from || space > from ? -1 : particleBreak(t, from, i + 1);
      to = space > from ? space + 1 : pause > from ? pause : particle > from ? particle : i + 1;
    }
    out.push({ from, to });
    from = to;
    i = to - 1;
    fallback = -1;
  }
  if (from < t.length) out.push({ from, to: t.length });
  return out.filter((c) => t.slice(c.from, c.to).trim().length > 0);
}

/** The first mark whose index is above `at` (marks are in text order). @param {readonly { index: number }[]} marks @param {number} at */
function firstAfter(marks, at) {
  let lo = 0, hi = marks.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (marks[mid].index > at) hi = mid; else lo = mid + 1; }
  return lo;
}

/**
 * A speech's text and word times broken into lines, in the source's own milliseconds (what a transcript is written
 * as). `marks`: each matched word's place in the line and its start. `durMs`: the source's length (the last line's
 * end), if known.
 * @param {string | undefined} source @param {readonly Word[] | undefined} words @param {number | undefined} durMs
 * @returns {SpokenLine[]}
 */
export function spokenLines(source, words, durMs) {
  const said = stripAudioTags(source ?? '');
  if (!said) return [];
  const total = durMs !== undefined && Number.isFinite(durMs) ? durMs : undefined;
  const marks = words?.length ? alignedAt(said, words) : [];
  if (!marks.length) {
    /* no word times: the same lines, each given a share of the length by how much of the text it is */
    const pieces = chunks(said).map((piece) => said.slice(piece.from, piece.to).trim()).filter(Boolean);
    const length = total ?? cells(said) * FALLBACK_MS_PER_CELL;
    const weights = pieces.map((piece) => Math.max(1, cells(piece)));
    const sum = weights.reduce((a, b) => a + b, 0);
    let at = 0;
    return pieces.map((t, i) => {
      const startMs = Math.round(at);
      at += (length * weights[i]) / sum;
      return { text: t, startMs, endMs: Math.round(at) };
    });
  }
  const pauseAt = (/** @type {number} */ from, /** @type {number} */ to) => {
    let best = -1, bestGap = MIN_BREAK_GAP_MS / 1000;
    for (let k = Math.max(1, firstAfter(marks, from)); k < marks.length && marks[k].index <= to; k += 1) {
      const m = marks[k], prev = marks[k - 1];
      if (cells(said.slice(from, m.index)) < MAX_CELLS / 2) continue;
      const gap = m.startSec - (prev.endSec ?? prev.startSec);
      if (gap > bestGap) { best = m.index; bestGap = gap; }
    }
    return best;
  };
  const started = chunks(said, pauseAt).map((piece) => {
    const inPiece = marks.slice(firstAfter(marks, piece.from - 1), firstAfter(marks, piece.to - 1));
    const raw = said.slice(piece.from, piece.to);
    const lead = raw.length - raw.trimStart().length;
    return {
      text: raw.trim(),
      /* a piece with no matched word (all digits or marks) follows the one before */
      startMs: inPiece[0] ? Math.round(inPiece[0].startSec * 1000) : 0,
      spokenUntilMs: inPiece.reduce((end, m) => Math.max(end, Math.round((m.endSec ?? m.startSec) * 1000)), 0),
      marks: inPiece.map((m) => ({ index: m.index - piece.from - lead, startMs: Math.round(m.startSec * 1000) })),
    };
  });
  for (const [i, one] of started.entries()) {
    if (i > 0 && one.startMs <= started[i - 1].startMs) one.startMs = started[i - 1].startMs + 1;
  }
  return started.map((one, i) => {
    /* a line stays up until the next one starts (a gap would blank the line being read), the last until the source
       ends, unless that is a long silence: then through its words or the estimated speaking time, plus GAP_MS */
    const until = started[i + 1]?.startMs ?? total ?? Infinity;
    const spoken = Math.max(500, cells(one.text) * FALLBACK_MS_PER_CELL);
    return {
      text: one.text,
      startMs: one.startMs,
      endMs: Math.min(until, Math.max(one.startMs + spoken, one.spokenUntilMs) + GAP_MS),
      ...(one.marks.length ? { marks: one.marks } : {}),
    };
  }).filter((l) => l.endMs > l.startMs);
}
