// @ts-check
/**
 * Edits to film.html, by clip id: the one implementation both Studio's server (which writes the file) and its editor
 * (which shows the change at once, before the server has written it) apply, so the two never disagree. Pure: no file,
 * no clock, nothing but the film's value.
 */
import { FILM_FILE, clipFade, clipIdFor, clipKind, clipSpeed, kindOf } from '../../src/film-doc.mjs';

/** @typedef {{ src: string, id: string, [field: string]: unknown }} Clip */
/** @typedef {{ clips: Clip[], locked?: boolean, hidden?: boolean, muted?: boolean }} Track */
/** @typedef {{ stage?: { w: number, h: number }, tracks: Track[] }} FilmValue */
/**
 * @typedef {(
 *   | { op: 'set', clip: string, field: string, value?: unknown }
 *   | { op: 'move', clip: string, at: number, track?: number, newTrack?: number }
 *   | { op: 'insert', clip?: Partial<Clip> & { src: string }, from?: string, at?: number, after?: string, track?: number | { insert: number }, newTrack?: number, link?: string | null }
 *   | { op: 'remove', clip: string }
 *   | { op: 'split', clip: string, at: number, time: [number, number], restTime: [number, number], restId?: string }
 *   | { op: 'split', clip: string, left: Record<string, PropValue>, right: Record<string, PropValue>, rightId?: string }
 *   | { op: 'props', edits: PropEdit[] }
 *   | { op: 'stage', w: number, h: number }
 *   | { op: 'fields', clip: string, fields: Record<string, unknown> }
 *   | { op: 'track', track: number, field: 'locked' | 'hidden' | 'muted', value: boolean }
 *   | { op: 'reorder', from: number, to: number }
 * )} Op
 */
/** @typedef {number | string | boolean | readonly number[] | Record<string, unknown> | null} PropValue */
/**
 * One property of one clip, as the timeline, the inspector and the picture write it: a field of the clip (`at`,
 * `start` / `end` = its trim in source seconds, `volume`, `speed`, `box`, `overrides`, `link` = its `data-link`, `fade` = its
 * fades `[in, out]` in seconds, kept in its `overrides`, …), a flag of
 * its track (`locked` / `hidden` / `muted`), the track it goes to (`track`: an index, or `{ insert: index }` for a
 * new track there), or the order of the tracks (`trackOrder`: `{ from, to }`). `null` removes the field.
 * @typedef {{ clip: string, prop: string, value: PropValue }} PropEdit
 */

export class EditError extends Error {
  /** @param {string} message @param {'conflict' | 'invalid'} kind */
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

/** Where a clip is now: its track and its place in it. */
function find(/** @type {FilmValue} */ value, /** @type {string} */ id) {
  for (let t = 0; t < value.tracks.length; t++) {
    const c = value.tracks[t].clips.findIndex((clip) => clip.id === id);
    if (c >= 0) return { t, c, clip: value.tracks[t].clips[c] };
  }
  throw new EditError(`clip "${id}" is not in ${FILM_FILE} any more`, 'conflict');
}

const usedIds = (/** @type {FilmValue} */ value) => value.tracks.flatMap((track) => track.clips.map((clip) => clip.id));

/** A track index the edit may write to: an existing one, or `newTrack` (a new empty track inserted at that place). */
function targetTrack(/** @type {FilmValue} */ value, /** @type {number | undefined} */ track, /** @type {number | undefined} */ newTrack) {
  if (newTrack != null) {
    if (!Number.isInteger(newTrack) || newTrack < 0 || newTrack > value.tracks.length) throw new EditError(`no place ${newTrack} for a new track`, 'invalid');
    value.tracks.splice(newTrack, 0, { clips: [] });
    return newTrack;
  }
  if (track == null) return value.tracks.length ? 0 : (value.tracks.push({ clips: [] }), 0);
  if (!Number.isInteger(track) || !value.tracks[track]) throw new EditError(`no track ${track}`, 'conflict');
  return track;
}

/** Tracks left with no clips go: a track is its clips (the agent never sees an empty one appear out of an edit). */
const dropEmptyTracks = (/** @type {FilmValue} */ value) => { value.tracks = value.tracks.filter((track) => track.clips.length); };

/** Fields a person sets from Studio, by kind of clip (the rest of a clip is the agent's to write). */
const SETTABLE = new Set(['at', 'time', 'box', 'size', 'volume', 'speed', 'overrides', 'src']);

/** @param {FilmValue} value @param {Op[]} ops */
export function applyOps(value, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new EditError('an edit needs at least one operation', 'invalid');
  for (const op of ops) {
    switch (op.op) {
      case 'set': {
        if (!SETTABLE.has(op.field)) throw new EditError(`Studio does not set "${op.field}" on a clip`, 'invalid');
        const { clip } = find(value, op.clip);
        if (op.value === undefined || op.value === null) delete clip[op.field];
        else clip[op.field] = op.value;
        break;
      }
      case 'move': {
        const from = find(value, op.clip);
        if (!(typeof op.at === 'number' && op.at >= 0)) throw new EditError('a move needs at: seconds from 0', 'invalid');
        value.tracks[from.t].clips.splice(from.c, 1);
        const t = op.track == null && op.newTrack == null ? from.t : targetTrack(value, op.track, op.newTrack);
        /** @type {Clip} */
        const moved = { ...from.clip };
        const at = round(op.at);
        if (at) moved.at = at;
        else delete moved.at;
        value.tracks[t].clips.push(moved);
        sortTrack(value.tracks[t]);
        break;
      }
      case 'insert': {
        /* a new clip, or a copy of one in the film (pasting copies the clip as the file has it, every field) */
        const source = op.from != null ? cloneClip(find(value, op.from).clip) : op.clip;
        if (!source || typeof source.src !== 'string' || !clipKind(source.src)) throw new EditError('an insert needs a clip with a src Studio can play', 'invalid');
        const taken = usedIds(value);
        /* a clip put back by its id (an undo) that is back already (the agent wrote it again): nothing to put back, or
           there would be two of it */
        if (op.from == null && typeof source.id === 'string' && taken.includes(source.id) && find(value, source.id).clip.src === source.src) break;
        const id =typeof source.id === 'string' && source.id && !taken.includes(source.id) ? source.id : clipIdFor(source.src, taken);
        /** @type {Clip} */
        const clip = { ...source, id };
        /* a copy's link: a new one for copies pasted together, none for one alone (or it would move the original's) */
        if (op.link !== undefined) setField(clip, 'link', op.link);
        if (op.at != null) {
          if (!(typeof op.at === 'number' && Number.isFinite(op.at))) throw new EditError('at has to be seconds', 'invalid');
          if (round(op.at)) clip.at = round(op.at);
          else delete clip.at;
        }
        if (op.after != null) {
          /* right after that clip, on its track */
          const where = find(value, op.after);
          value.tracks[where.t].clips.splice(where.c + 1, 0, clip);
        } else if (op.track != null && typeof op.track === 'object') {
          const at = Math.max(0, Math.min(value.tracks.length, Math.trunc(op.track.insert)));
          value.tracks.splice(at, 0, { clips: [clip] });
        } else if (op.track == null && op.newTrack == null) {
          /* no track named: the last track showing the same kind of clip, else a new one at the end */
          const kind = studioKind(clip);
          const track = [...value.tracks].reverse().find((tr) => tr.clips.length && trackKind(tr) === kind);
          if (track) track.clips.push(clip);
          else value.tracks.push({ clips: [clip] });
        } else {
          const t = targetTrack(value, /** @type {number | undefined} */ (op.track), op.newTrack);
          value.tracks[t].clips.push(clip);
          sortTrack(value.tracks[t]);
        }
        break;
      }
      case 'remove': {
        const { t, c } = find(value, op.clip);
        value.tracks[t].clips.splice(c, 1);
        break;
      }
      case 'split': {
        if ('left' in op) {
          /* the halves as the timeline worked them out: each is the clip (a deep copy: the halves share nothing,
             or moving one on the picture would move the other) with its own fields changed */
          const { t, c, clip } = find(value, op.clip);
          const left = /** @type {Clip} */ (structuredClone(clip));
          const right = /** @type {Clip} */ (structuredClone(clip));
          /* the right half's id: the one asked for (so the editor can select it) when it is free, else `<id>-b` */
          const asked = typeof op.rightId === 'string' && /^[A-Za-z][\w-]*$/.test(op.rightId) && !usedIds(value).includes(op.rightId)
            ? op.rightId : null;
          right.id = asked ?? mintClipId(usedIds(value), clip.id);
          /* a fade belongs to the end it is at: the left half keeps the fade in, the right one the fade out */
          splitFades(left, right);
          for (const [prop, v] of Object.entries(op.left ?? {})) setField(left, prop, snapTime(prop, v));
          for (const [prop, v] of Object.entries(op.right ?? {})) setField(right, prop, snapTime(prop, v));
          value.tracks[t].clips.splice(c, 1, left, right);
          break;
        }
        /* Studio works out both halves' trims (it knows the clip's length); the file only learns the two clips */
        const { t, c, clip } = find(value, op.clip);
        const [restFrom, restTo] = op.restTime ?? [];
        if (!(typeof op.at === 'number' && op.at > 0) || !(restTo > restFrom)) throw new EditError('a split needs at and both halves\' time', 'invalid');
        const rest = { ...structuredClone(clip), id: op.restId && !usedIds(value).includes(op.restId) ? op.restId : clipIdFor(clip.src, usedIds(value)), at: round(op.at), time: op.restTime };
        clip.time = op.time;
        splitFades(clip, rest);
        value.tracks[t].clips.splice(c + 1, 0, rest);
        break;
      }
      case 'track': {
        if (!['locked', 'hidden', 'muted'].includes(op.field)) throw new EditError(`a track has no "${op.field}"`, 'invalid');
        const track = value.tracks[op.track];
        if (!track) throw new EditError(`no track ${op.track}`, 'conflict');
        if (op.value) track[op.field] = true;
        else delete track[op.field];
        break;
      }
      case 'reorder': {
        const { from, to } = op;
        if (!value.tracks[from] || !(Number.isInteger(to) && to >= 0 && to < value.tracks.length)) throw new EditError('no such tracks to reorder', 'conflict');
        const [track] = value.tracks.splice(from, 1);
        value.tracks.splice(to, 0, track);
        break;
      }
      case 'props':
        applyProps(value, op.edits);
        break;
      case 'fields': {
        /* a clip's fields exactly as given (null removes one): what undo writes back, unrounded and unnormalised */
        const { clip } = find(value, op.clip);
        for (const [key, v] of Object.entries(op.fields ?? {})) {
          if (key === 'id') continue;
          if (v === null || v === undefined) delete (/** @type {Record<string, unknown>} */ (clip))[key];
          else (/** @type {Record<string, unknown>} */ (clip))[key] = v;
        }
        break;
      }
      case 'stage': {
        /* the canvas's size (a new film's shape, picked before anything is placed on it) */
        if (!(Number.isInteger(op.w) && Number.isInteger(op.h) && op.w > 0 && op.h > 0 && op.w <= 8192 && op.h <= 8192)) throw new EditError('a stage is whole pixels, up to 8192', 'invalid');
        value.stage = { ...value.stage, w: op.w, h: op.h };
        break;
      }
      default:
        throw new EditError(`unknown operation ${/** @type {{ op?: string }} */ (op).op}`, 'invalid');
    }
  }
  /* after the whole edit, so every operation in it names tracks as the ones before it left them */
  dropEmptyTracks(value);
  fitFades(value);
  return value;
}

/** A clip cut in two: its fade in stays with the left half, its fade out goes with the right. */
function splitFades(/** @type {Clip} */ left, /** @type {Clip} */ right) {
  const fade = clipFade(/** @type {{ overrides?: unknown[] }} */ (left));
  if (!fade) return;
  setField(left, 'fade', [fade[0], 0]);
  setField(right, 'fade', [0, fade[1]]);
}

/**
 * Fades longer together than their clip (it was trimmed shorter) shortened alike to fit, so the film stays one the
 * format reads (in + out within the clip's length). Only a length the file says can be checked: `#t=start,end`.
 */
function fitFades(/** @type {FilmValue} */ value) {
  for (const track of value.tracks) {
    for (const clip of track.clips) {
      const fade = clipFade(/** @type {{ overrides?: unknown[] }} */ (clip));
      const time = /** @type {unknown} */ (clip.time);
      if (!fade || !Array.isArray(time) || time.length !== 2) continue;
      const length = (Number(time[1]) - Number(time[0])) / clipSpeed(/** @type {{ src: string }} */ (clip));
      if (!(fade[0] + fade[1] > length + 1e-9)) continue;
      const k = Math.max(0, length) / (fade[0] + fade[1]);
      const down = (/** @type {number} */ v) => Math.floor(v * k * 1000) / 1000;
      setField(clip, 'fade', [down(fade[0]), down(fade[1])]);
    }
  }
}

/* seconds as a person would write them: no float noise from a drag (0.30000000000000004) */
const round = (/** @type {number} */ s) => Math.round(s * 1000) / 1000;
/* a track's clips in the order they play, so the file reads like the timeline */
const sortTrack = (/** @type {Track} */ track) => track.clips.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));

/* ── The timeline's, the inspector's and the picture's edits: one batch of clip properties ── */

/** Props that are not fields of the clip: they act on its track, or move it to another. */
const TRACK_FLAGS = new Set(['locked', 'hidden', 'muted']);
const TIME_PROPS = new Set(['at', 'start', 'end']);

/** A moment from a drag carries float noise: written to the millisecond. */
function snapTime(/** @type {string} */ prop, /** @type {PropValue} */ v) {
  if (typeof v !== 'number' || !TIME_PROPS.has(prop)) return v;
  if (!Number.isFinite(v)) throw new EditError(`${prop} is not a finite number`, 'invalid');
  return round(v);
}

/** One field of a clip, as film.html writes it (defaults are not written). */
function setField(/** @type {Clip} */ clip, /** @type {string} */ prop, /** @type {PropValue} */ v) {
  const raw = /** @type {Record<string, unknown>} */ (clip);
  if (prop === 'track' || prop === 'trackOrder' || TRACK_FLAGS.has(prop) || prop === 'id' || prop === 'src' && typeof v !== 'string') return;
  if (prop === 'start' || prop === 'end') {
    /* the trim, in the source's own seconds: `time` [start, end]; start 0 and no end is the default */
    const time = Array.isArray(raw.time) ? /** @type {number[]} */ (raw.time) : [];
    let start = time[0] ?? 0;
    /** @type {number | undefined} */
    let end = time.length === 2 ? time[1] : undefined;
    if (prop === 'start') start = v === null ? 0 : Number(v);
    else end = v === null ? undefined : Number(v);
    if (!(start > 0) && end == null) delete raw.time;
    else raw.time = end == null ? [start] : [start, end];
    return;
  }
  if (prop === 'volume' || prop === 'speed') {
    if (v === null || v === 1) delete raw[prop];
    else raw[prop] = v;
    return;
  }
  if (prop === 'gainDb') {
    if (v === null) delete raw.volume;
    else if (typeof v === 'number') {
      const volume = Math.round(10 ** (v / 20) * 1000) / 1000;
      if (volume === 1) delete raw.volume;
      else raw.volume = volume;
    }
    return;
  }
  if (prop === 'at') {
    if (v === null || v === 0) delete raw.at;
    else raw.at = v;
    return;
  }
  if (prop === 'fade') {
    /* the clip's own entry of its overrides (the one without `at`): first, and gone when it fades nothing */
    const list = Array.isArray(raw.overrides) ? /** @type {Record<string, unknown>[]} */ (raw.overrides).filter((o) => o?.at !== undefined) : [];
    if (v !== null && !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0))) {
      throw new EditError('fade has to be [in, out]: seconds, 0 or more', 'invalid');
    }
    const fade = v === null ? null : [round(/** @type {number[]} */ (v)[0]), round(/** @type {number[]} */ (v)[1])];
    if (fade && (fade[0] > 0 || fade[1] > 0)) list.unshift({ fade });
    if (list.length) raw.overrides = list;
    else delete raw.overrides;
    return;
  }
  if (prop === 'link' || prop === 'props') {
    /* Studio's own attributes, which the film keeps and gives no meaning (SPEC §1): linked clips (a video and the sound
       taken off it) share a `data-link`; a page clip's component properties are its `data-props` (a JSON list) */
    const name = prop === 'link' ? 'data-link' : 'data-props';
    const attrs = /** @type {Record<string, string>} */ ({ ...(/** @type {Record<string, string> | undefined} */ (raw.attrs) ?? {}) });
    if (typeof v === 'string' && v) attrs[name] = v;
    else delete attrs[name];
    if (Object.keys(attrs).length) raw.attrs = attrs;
    else delete raw.attrs;
    return;
  }
  if (v === null) { delete raw[prop]; return; }
  raw[prop] = v;
}

/**
 * A batch, in this order: fields first, then track flags, then moves to other tracks, then the tracks' order.
 * Moves are planned against the clips and tracks themselves (not their places), then made all at once: moving one
 * clip shifts the places of the next, and a track may both lose a clip and take one in the same batch.
 */
function applyProps(/** @type {FilmValue} */ value, /** @type {PropEdit[]} */ edits) {
  if (!Array.isArray(edits) || !edits.length) throw new EditError('props needs edits', 'invalid');
  const fields = edits.filter((e) => e.prop !== 'track' && e.prop !== 'trackOrder' && !TRACK_FLAGS.has(e.prop));
  /** the tracks whose clips moved in time or took a clip: put back in the order they play */
  const resort = new Set(/** @type {Track[]} */ ([]));
  for (const e of fields) {
    const at = find(value, e.clip);
    setField(at.clip, e.prop, snapTime(e.prop, e.value));
    if (e.prop === 'at') resort.add(value.tracks[at.t]);
  }
  for (const e of edits.filter((x) => TRACK_FLAGS.has(x.prop))) {
    const track = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (value.tracks[find(value, e.clip).t]));
    if (e.value === true) track[e.prop] = true;
    else delete track[e.prop];
  }
  /** @type {{ clip: Clip, from: Track, to?: Track, before?: Track, insert: boolean }[]} */
  const plan = [];
  for (const e of edits.filter((x) => x.prop === 'track')) {
    const { t, clip } = find(value, e.clip);
    const dest = e.value;
    const insertAt = dest && typeof dest === 'object' && !Array.isArray(dest) && typeof (/** @type {{ insert?: unknown }} */ (dest)).insert === 'number'
      ? /** @type {number} */ ((/** @type {{ insert: number }} */ (dest)).insert) : null;
    const destIndex = typeof dest === 'number' ? dest : null;
    if (insertAt == null && destIndex == null) throw new EditError('track has to be the index of a track, or { insert: index } for a new one', 'invalid');
    const from = value.tracks[t];
    if (insertAt == null) {
      if (destIndex === t) continue;
      const to = value.tracks[/** @type {number} */ (destIndex)];
      if (!to) throw new EditError(`no track ${destIndex}`, 'conflict');
      plan.push({ clip, from, to, insert: false });
    } else {
      plan.push({ clip, from, insert: true, ...(value.tracks[insertAt] ? { before: value.tracks[insertAt] } : {}) });
    }
  }
  for (const step of plan) {
    const at = step.from.clips.indexOf(step.clip);
    if (at >= 0) step.from.clips.splice(at, 1);
  }
  for (const step of plan) if (step.to) { step.to.clips.push(step.clip); resort.add(step.to); }
  for (const step of plan) {
    if (!step.insert) continue;
    const before = step.before ? value.tracks.indexOf(step.before) : -1;
    value.tracks.splice(before >= 0 ? before : value.tracks.length, 0, { clips: [step.clip] });
  }
  for (const track of resort) sortTrack(track);
  for (const e of edits.filter((x) => x.prop === 'trackOrder')) {
    const dest = /** @type {{ from?: unknown, to?: unknown } | null} */ (e.value && typeof e.value === 'object' && !Array.isArray(e.value) ? e.value : null);
    const from = dest?.from;
    const to = dest?.to;
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) throw new EditError('trackOrder has to be { from, to }', 'invalid');
    if (!value.tracks[from]) throw new EditError(`no track ${from}`, 'conflict');
    if (from === to) continue;
    const [taken] = value.tracks.splice(from, 1);
    value.tracks.splice(Math.max(0, Math.min(value.tracks.length, to)), 0, taken);
  }
}

/** A copy of a clip to paste: every field but its identity. */
function cloneClip(/** @type {Clip} */ clip) {
  const out = /** @type {Clip} */ (structuredClone(clip));
  delete (/** @type {Record<string, unknown>} */ (out)).id;
  return out;
}

/** The id for the right half of a split: `<id>-b`, then `<id>-b-2`… */
function mintClipId(/** @type {string[]} */ used, /** @type {string | undefined} */ base) {
  const taken = new Set(used);
  const stem = base && /^[A-Za-z][\w-]*$/.test(base) ? `${base}-b` : 'clip';
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/** Studio's kind of a clip (mg, video, audio) and of a track (from what is on it). */
const studioKind = (/** @type {Clip} */ clip) => { const k = kindOf(clip); return k === 'page' ? 'mg' : k === 'sound' ? 'audio' : 'video'; };
const trackKind = (/** @type {Track} */ track) => { const kinds = new Set(track.clips.map((c) => studioKind(c))); return kinds.size === 1 ? [...kinds][0] : 'video'; };
