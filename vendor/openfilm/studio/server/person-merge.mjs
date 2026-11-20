// @ts-check
/**
 * Three-way merges of what an agent writes over what the person has, as git merges: film.html by clip, field and
 * smaller, a text file by lines. Pure: values in, values out (person-edits.mjs keeps the versions and writes the result).
 *
 * The agent writes with its own tools from a copy it read at some point; which, Studio cannot know, so it is inferred:
 * the version Studio has seen (its own writes and others') closest to the write (`closest`). A copy read before the
 * person's edits still has the old values everywhere the person changed since, so it is closest to that older version.
 * Then each unit (a clip there or not, a field, a key of its box or attributes, an overrides entry, each property of
 * the entry, each key of its style, the track a clip is on, a track's flag, the tracks' order, the stage) is merged:
 * changed by the writer only, the writer's; by the person (or Studio) only, theirs; by both, differently, the person's.
 */
import { createHash } from 'node:crypto';
import { readFilm } from '../../src/film-doc.mjs';

/** @typedef {import('./ops.mjs').FilmValue} FilmValue @typedef {import('./ops.mjs').Clip} Clip @typedef {import('./ops.mjs').Track} Track */
/**
 * The units in doubt (merge3): `has` a unit, or what holds it; `all`, those named; `mine`, whether Studio has a unit
 * as the person left it (only those stand over a write); `forPerson`, units of the writer's that gave way to the
 * person's though no unit of the person's (a clip that would not read), named too.
 * @typedef {{ has: (k: string) => boolean, all: Set<string>, mine: (k: string) => boolean, forPerson: Set<string> }} Doubt
 */

/** A value as one string, its objects' keys sorted, so two equal values read the same; `NONE` for none. */
export const NONE = '-';
export function canon(/** @type {unknown} */ v) {
  if (v === undefined) return NONE;
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}
export const hashOf = (/** @type {string | Buffer} */ v) => createHash('sha256').update(v).digest('hex').slice(0, 24);

const isRecord = (/** @type {unknown} */ v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/**
 * Two values alike: numbers within float noise of each other, objects and lists alike in every part.
 * @param {unknown} a @param {unknown} b @returns {boolean}
 */
export function alike(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => alike(x, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(/** @type {object} */ (a)), ...Object.keys(/** @type {object} */ (b))]);
    return [...keys].every((k) => alike(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]));
  }
  return a === b;
}

/** An overrides entry's name: what it points at. The entry without `at` is the clip's own (its fades). */
const entryName = (/** @type {Record<string, unknown>} */ e) => (e && 'at' in e ? JSON.stringify([e.at, e.n ?? null, e.copy ?? null]) : '');
const FLAGS = /** @type {const} */ (['locked', 'hidden', 'muted']);
/** A clip's fields that have a value when left out (film.html writes none for it): left out and that value are alike. */
const DEFAULTS = /** @type {Record<string, unknown>} */ ({ at: 0, volume: 1, speed: 1 });
const orDefault = (/** @type {string} */ key, /** @type {unknown} */ v) => (v === undefined ? DEFAULTS[key] : v);

/* ── units: what is merged one by one ─────────────────────────────────────── */

/**
 * The film's units, by name: `clip␀id` (there), `field␀id␀name`, `box␀id␀key`, `attrs␀id␀key`, `entry␀id␀name` (there),
 * `prop␀id␀name␀prop`, `style␀id␀name␀key`, `track␀id` (the clips it shares a track with), `flag␀id␀flag` (its
 * track's), `order` (the tracks, each as its clips), `stage`. What two versions differ by; what a note names.
 * @param {FilmValue} film @returns {Map<string, unknown>}
 */
export function unitsOf(film) {
  /** @type {Map<string, unknown>} */
  const out = new Map();
  out.set('stage', film.stage);
  out.set('order', film.tracks.map((t) => t.clips.map((c) => c.id).sort()));
  for (const track of film.tracks) {
    const ids = track.clips.map((c) => c.id);
    for (const clip of track.clips) {
      const id = clip.id;
      out.set(`clip\0${id}`, true);
      out.set(`track\0${id}`, ids.filter((x) => x !== id).sort());
      for (const f of FLAGS) if (track[f]) out.set(`flag\0${id}\0${f}`, true);
      clipUnits(clip, out);
    }
  }
  return out;
}

/** A clip's own units (its fields, its box's and attributes' keys, its overrides), into `out`. */
function clipUnits(/** @type {Clip} */ clip, /** @type {Map<string, unknown>} */ out) {
  const id = clip.id;
  for (const [key, v] of Object.entries(clip)) {
    if (key === 'id') continue;
    if ((key === 'box' || key === 'attrs') && isRecord(v)) for (const [k, x] of Object.entries(/** @type {object} */ (v))) out.set(`${key}\0${id}\0${k}`, x);
    else if (key === 'overrides' && Array.isArray(v)) {
      for (const e of v) {
        const name = entryName(e);
        out.set(`entry\0${id}\0${name}`, true);
        for (const [p, x] of Object.entries(e ?? {})) {
          if (p === 'style' && isRecord(x)) for (const [k, s] of Object.entries(/** @type {object} */ (x))) out.set(`style\0${id}\0${name}\0${k}`, s);
          else out.set(`prop\0${id}\0${name}\0${p}`, x);
        }
      }
    } else if (!alike(v, DEFAULTS[key])) out.set(`field\0${id}\0${key}`, v);
  }
  return out;
}

/* ── films as kept among versions ─────────────────────────────────────────── */

/**
 * A film as Studio keeps it among its versions: its stage and each clip as JSON, by track, with the track's flags. A
 * track alike in the version before is that version's (the same object), so a version of a long film costs only what
 * changed; and versions are compared clip by clip as strings first (`compare`), which is quick.
 * @typedef {{ flags: string, ids: string[], clips: string[] }} KeptTrack
 * @typedef {{ stage: string, tracks: KeptTrack[] }} KeptFilm
 */

/** `film` as kept, sharing what is alike with `before` (the version before it). @returns {KeptFilm} */
export function keepFilm(/** @type {FilmValue} */ film, /** @type {KeptFilm | null} */ before = null) {
  /** @type {Map<string, KeptTrack> | null} */
  let byIds = null;
  const tracks = film.tracks.map((t, i) => {
    const flags = FLAGS.filter((f) => t[f]).join(' ');
    const ids = t.clips.map((c) => c.id);
    const clips = t.clips.map((c) => JSON.stringify(c));
    let was = before?.tracks[i];
    if (before && !(was && was.ids.length === ids.length && was.ids.every((id, k) => id === ids[k]))) {
      byIds ??= new Map(before.tracks.map((x) => [x.ids.join('\0'), x]));
      was = byIds.get(ids.join('\0')) ?? was;
    }
    if (!was) return { flags, ids, clips };
    if (was.flags === flags && was.clips.length === clips.length && clips.every((c, k) => c === was.clips[k])) return was;
    /* a clip alike before is the string before, kept once */
    const old = new Map(was.clips.map((c) => [c, c]));
    return { flags, ids, clips: clips.map((c) => old.get(c) ?? c) };
  });
  return { stage: film.stage === undefined ? NONE : JSON.stringify(film.stage), tracks };
}

/** A film kept back as its value. @returns {FilmValue} */
export function keptValue(/** @type {KeptFilm} */ kept) {
  const tracks = kept.tracks.map((t) => /** @type {Track} */ ({ clips: t.clips.map((c) => JSON.parse(c)), ...Object.fromEntries(t.flags ? t.flags.split(' ').map((f) => [f, true]) : []) }));
  return kept.stage === NONE ? { tracks } : { stage: JSON.parse(kept.stage), tracks };
}

/** @type {WeakMap<KeptTrack, string>} */
const trackHashes = new WeakMap();
/** A kept film's hash: two films kept alike (their clips written alike) have one. */
export function keptHash(/** @type {KeptFilm} */ kept) {
  const of = (/** @type {KeptTrack} */ t) => {
    let h = trackHashes.get(t);
    if (!h) trackHashes.set(t, (h = hashOf(`${t.flags}\n${t.clips.join('\n')}`)));
    return h;
  };
  return hashOf(`${kept.stage}\n${kept.tracks.map(of).join('\n')}`);
}
/** How many clips a kept film has. */
export const keptClips = (/** @type {KeptFilm} */ kept) => kept.tracks.reduce((n, t) => n + t.ids.length, 0);
/** A kept film's size in bytes, as far as its strings go (`only`: just these tracks). */
export const keptSize = (/** @type {KeptFilm} */ kept, /** @type {(t: KeptTrack) => boolean} */ only = () => true) =>
  kept.stage.length + kept.tracks.filter(only).reduce((n, t) => n + t.clips.reduce((m, c) => m + c.length, 0), 0);

/** @type {WeakMap<KeptTrack, string>} */
const trackClips = new WeakMap();

/**
 * How a film (`w`, kept) differs from a version (`v`): `distance` as `distance` counts it (the same number, without
 * making either's units: clips written alike are alike), `apart` the units as `differing` names them, and `moved` the
 * clips whose track differs. `cache` (one per `w`): each of the versions' clips compared with w's, by its JSON, as
 * versions share most of theirs; `skip`, clips left out on both sides.
 * @param {KeptFilm} w @param {KeptFilm} v
 * @param {{ at?: Map<string, [number, number]>, clips?: Map<string, { keys: string[], n: number }>, skip?: Set<string>, changed?: Map<string, number> }} [cache]
 */
export function compare(w, v, cache = {}) {
  const skip = cache.skip ?? new Set();
  const at = (cache.at ??= new Map(w.tracks.flatMap((t, i) => t.ids.flatMap((id, j) => (skip.has(id) ? [] : [/** @type {[string, [number, number]]} */ ([id, [i, j]])])))));
  const clips = (cache.clips ??= new Map());
  /** @type {string[]} */
  const apart = [];
  /** @type {string[]} */
  const moved = [];
  /* the clips only one has */
  /** @type {Set<string>} */
  const lone = new Set();
  let shared = 0;
  for (const t of v.tracks) for (const id of t.ids) if (at.has(id)) shared++; else if (!skip.has(id)) lone.add(id);
  if (shared < at.size) {
    const there = new Set(v.tracks.flatMap((t) => t.ids));
    for (const id of at.keys()) if (!there.has(id)) lone.add(id);
  }
  for (const id of lone) apart.push(`clip\0${id}`);
  let n = 0;
  for (const id of lone) if (at.has(id)) n += 1 + (cache.changed?.get(id) ?? 0);
  if (v.stage !== w.stage && !alike(parse(v.stage), parse(w.stage))) { n++; apart.push('stage'); }
  /* each track as the clips both have, sorted: where clips are */
  const sorted = (/** @type {KeptTrack} */ t) => {
    const out = (/** @type {string} */ id) => lone.has(id) || skip.has(id);
    if ((lone.size || skip.size) && t.ids.some(out)) return t.ids.filter((id) => !out(id)).sort().join('\0');
    let s = trackClips.get(t);
    if (s === undefined) trackClips.set(t, (s = [...t.ids].sort().join('\0')));
    return s;
  };
  const sw = w.tracks.map(sorted), sv = v.tracks.map(sorted);
  const ow = sw.filter(Boolean), ov = sv.filter(Boolean);
  if (ow.length !== ov.length || ow.some((x, i) => x !== ov[i])) n++;
  v.tracks.forEach((tv, i) => tv.ids.forEach((id, j) => {
    const here = at.get(id);
    if (!here) return;
    const tw = w.tracks[here[0]];
    if (sw[here[0]] !== sv[i]) { n++; moved.push(id); }
    if (tw.flags !== tv.flags) {
      const has = (/** @type {KeptTrack} */ t, /** @type {string} */ f) => t.flags.split(' ').includes(f);
      for (const f of FLAGS) if (has(tw, f) !== has(tv, f)) { n++; apart.push(`flag\0${id}\0${f}`); }
    }
    const cv = tv.clips[j];
    let got = clips.get(cv);
    if (!got) {
      const cw = tw.clips[here[1]];
      got = cw === cv ? { keys: [], n: 0 } : unitsApart(JSON.parse(cw), JSON.parse(cv));
      clips.set(cv, got);
    }
    n += got.n;
    apart.push(...got.keys);
  }));
  return { distance: n, apart, moved };
}
const parse = (/** @type {string} */ s) => (s === NONE ? undefined : JSON.parse(s));
/**
 * The units two clips of one id differ in (an overrides entry one lacks as that entry alone), and how far `a` (the
 * write's) is from `b` (as `distance` counts).
 */
function unitsApart(/** @type {Clip} */ a, /** @type {Clip} */ b) {
  const ua = clipUnits(a, new Map()), ub = clipUnits(b, new Map());
  const entries = new Set(/** @type {string[]} */ ([]));
  for (const k of ua.keys()) if (k.startsWith('entry\0') && !ub.has(k)) entries.add(k);
  for (const k of ub.keys()) if (k.startsWith('entry\0') && !ua.has(k)) entries.add(k);
  const keys = [...entries];
  for (const [k, x] of ua) if (!k.startsWith('entry\0') && !entries.has(entryOf(k)) && (!ub.has(k) || !alike(x, ub.get(k)))) keys.push(k);
  for (const k of ub.keys()) if (!k.startsWith('entry\0') && !entries.has(entryOf(k)) && !ua.has(k)) keys.push(k);
  return { keys, n: keys.length - [...entries].filter((e) => !ua.has(e)).length };
}

/**
 * The units two films' units differ in, a clip one lacks as that clip alone, leaving out where clips are (a clip's
 * track, the tracks' order: they follow from the clips).
 * @param {Map<string, unknown>} a @param {Map<string, unknown>} b
 */
export function differing(a, b) {
  const clipOf = (/** @type {string} */ k) => k.split('\0')[1];
  const lone = new Set(/** @type {string[]} */ ([]));
  for (const k of a.keys()) if (k.startsWith('clip\0') && !b.has(k)) lone.add(clipOf(k));
  for (const k of b.keys()) if (k.startsWith('clip\0') && !a.has(k)) lone.add(clipOf(k));
  const out = [...lone].map((id) => `clip\0${id}`);
  const entries = loneEntries(a, b);
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (/^(clip|track)\0|^order$/.test(k) || lone.has(clipOf(k)) || entries.has(entryOf(k))) continue;
    if (!alike(a.get(k), b.get(k))) out.push(k);
  }
  return [...out, ...entries];
}

/** The overrides entry a unit is of (`entry␀id␀name`), or ''. */
const entryOf = (/** @type {string} */ k) => (/^(prop|style)\0/.test(k) ? `entry\0${k.split('\0').slice(1, 3).join('\0')}` : '');
/** The overrides entries only one of two films' units has, of clips both have: each counts once, not its properties. */
function loneEntries(/** @type {Map<string, unknown>} */ a, /** @type {Map<string, unknown>} */ b) {
  const out = new Set(/** @type {string[]} */ ([]));
  const both = (/** @type {string} */ k) => a.has(`clip\0${k.split('\0')[1]}`) && b.has(`clip\0${k.split('\0')[1]}`);
  for (const k of a.keys()) if (k.startsWith('entry\0') && !b.has(k) && both(k)) out.add(k);
  for (const k of b.keys()) if (k.startsWith('entry\0') && !a.has(k) && both(k)) out.add(k);
  return out;
}

/**
 * How far a write's units (`a`) are from a version's (`b`): a unit one lacks counts once; a clip or overrides entry
 * the write has and the version lacks, once (not its fields too), and one the write lacks, not at all (the writer may
 * have removed it from any version: no sign of which it had). `changed` (by clip id): of a clip the write has and the
 * version lacks, what the write changed in it, which counts too: the writer's own changes count alike against every
 * version, so a version where the person removed a clip the writer changed is no nearer than the writer's copy.
 * @param {Map<string, unknown>} a @param {Map<string, unknown>} b @param {Map<string, number>} [changed]
 */
export function distance(a, b, changed = new Map()) {
  const clipOf = (/** @type {string} */ k) => k.split('\0')[1];
  const lone = new Set(/** @type {string[]} */ ([]));
  for (const k of a.keys()) if (k.startsWith('clip\0') && !b.has(k)) lone.add(clipOf(k));
  for (const k of b.keys()) if (k.startsWith('clip\0') && !a.has(k)) lone.add(clipOf(k));
  const entries = loneEntries(a, b);
  /* where clips are, with the lone ones left out: one clip added is not every clip's track and the order changed too */
  const without = (/** @type {string} */ k, /** @type {unknown} */ v) => {
    if (k.startsWith('track\0')) return /** @type {string[]} */ (v).filter((id) => !lone.has(id));
    if (k === 'order') return /** @type {string[][]} */ (v).map((t) => t.filter((id) => !lone.has(id))).filter((t) => t.length);
    return v;
  };
  let n = 0;
  for (const id of lone) if (a.has(`clip\0${id}`)) n += 1 + (changed.get(id) ?? 0);
  for (const e of entries) if (a.has(e)) n++;
  const counted = (/** @type {string} */ k) => !k.startsWith('clip\0') && !lone.has(clipOf(k)) && !entries.has(entryOf(k));
  for (const [k, v] of a) if (counted(k) && (!b.has(k) || !alike(without(k, v), without(k, b.get(k))))) n++;
  for (const k of b.keys()) if (counted(k) && !a.has(k)) n++;
  return n;
}

/**
 * Of `versions` (oldest first), the one `write` is closest to: the fewest units apart; of those alike, the oldest. A
 * write that changes exactly what the person changed since an older version is as near that version as the person's:
 * it is taken for an older copy, so the person's edit is a conflict and stands (the agent is told). Its index, and how
 * far it is.
 * @param {Map<string, unknown>} write @param {Map<string, unknown>[]} versions
 */
export function closest(write, versions) {
  let best = -1, least = Infinity;
  versions.forEach((v, i) => { const d = distance(write, v); if (d < least) { least = d; best = i; } });
  return { index: best, distance: least };
}

/**
 * The clips a write renamed: each clip it has under an id its base does not, matched to one the base has and the
 * write does not, of the same file and kind, and alike in its other units (its time, box keys, overrides): a third of
 * them when it is the only one of its file and kind on both sides, else half; the likest first. A clip removed and a
 * new one of the same file added are a removal and an addition.
 * By the write's id, the base's.
 * @param {FilmValue} base @param {FilmValue} theirs @returns {Map<string, string>}
 */
export function renamesOf(base, theirs) {
  return matchRenames(base, theirs).names;
}

/** renamesOf, and how alike the clips matched are in all (to tell which version the renamed clips are from). */
function matchRenames(/** @type {FilmValue} */ base, /** @type {FilmValue} */ theirs) {
  const O = byId(base), W = byId(theirs);
  /** @type {Map<string, string[]>} ours' clips the write lacks, by file and kind */
  const gone = new Map();
  const kind = (/** @type {Record<string, any>} */ c) => `${c.src}\0${c.kind ?? ''}`;
  for (const [id, { clip }] of O) if (!W.has(id)) gone.set(kind(clip), [...(gone.get(kind(clip)) ?? []), id]);
  /** the write's new clips, by file and kind */
  const fresh = new Map();
  for (const [to, { clip }] of W) if (!O.has(to)) fresh.set(kind(clip), (fresh.get(kind(clip)) ?? 0) + 1);
  /** @type {{ to: string, from: string, score: number }[]} */
  const pairs = [];
  for (const [to, { clip }] of W) {
    if (O.has(to)) continue;
    const a = /** @type {Record<string, any>} */ (clip);
    const from = gone.get(kind(a)) ?? [];
    for (const id of from) {
      const score = likeness(/** @type {Clip} */ (clip), /** @type {Clip} */ (O.get(id)?.clip));
      /* the one clip of its file gone and the one come: that clip, if a third of it is alike; else half */
      if (score >= (from.length === 1 && fresh.get(kind(a)) === 1 ? 1 / 3 : 1 / 2)) pairs.push({ to, from: id, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score || (x.to < y.to ? -1 : x.to > y.to ? 1 : 0) || (x.from < y.from ? -1 : 1));
  /** @type {Map<string, string>} */
  const names = new Map();
  const taken = new Set();
  let score = 0;
  for (const p of pairs) if (!names.has(p.to) && !taken.has(p.from)) { names.set(p.to, p.from); taken.add(p.from); score += p.score; }
  return { names, score };
}

/** How alike two clips are, apart from their id and file: the share of their units (time, box keys, overrides) alike. */
function likeness(/** @type {Clip} */ a, /** @type {Clip} */ b) {
  const name = (/** @type {string} */ k) => k.split('\0').filter((_, i) => i !== 1).join('\0');
  const own = (/** @type {Clip} */ c) => new Map([...clipUnits(c, new Map())].filter(([k]) => k !== `field\0${c.id}\0src` && k !== `field\0${c.id}\0kind`).map(([k, v]) => [name(k), v]));
  const ua = own(a), ub = own(b);
  const keys = new Set([...ua.keys(), ...ub.keys()]);
  return keys.size ? [...keys].filter((k) => ua.has(k) && ub.has(k) && alike(ua.get(k), ub.get(k))).length / keys.size : 1;
}

/**
 * Whether `write`, where it differs from version `at` (`apart`, its units), has a value an older version had there
 * instead: a sign it was made from an older copy than `at`. Not the writes Studio wrote a merge over (`over`): a value
 * kept out of the film is not one it had.
 * @param {FilmValue} write @param {KeptFilm[]} versions @param {number} at @param {string[]} apart @param {boolean[]} [over]
 */
function stale(write, versions, at, apart, over = []) {
  const ids = new Set(apart.map((k) => k.split('\0')[1] ?? ''));
  /* the units of the clips named, from the tracks they are on (all of a film's, when a unit names no clip) */
  const part = (/** @type {FilmValue} */ f) => unitsOf(ids.has('') ? f : { ...f, tracks: f.tracks.filter((t) => t.clips.some((c) => ids.has(c.id))) });
  const kept = (/** @type {KeptFilm} */ k) => part(keptValue(ids.has('') ? k : { ...k, tracks: k.tracks.filter((t) => t.ids.some((id) => ids.has(id))) }));
  const w = part(write), now = kept(versions[at]);
  for (let i = 0; i < at; i++) {
    if (over[i]) continue;
    const then = kept(versions[i]);
    if (apart.some((k) => !alike(then.get(k), now.get(k)) && alike(w.get(k), then.get(k)))) return true;
  }
  return false;
}

/** `film` with its clips' ids changed as `ids` says (a copy). */
function renamed(/** @type {FilmValue} */ film, /** @type {Map<string, string>} */ ids) {
  if (!ids.size) return film;
  return { ...film, tracks: film.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, id: /** @type {string} */ (ids.get(c.id)) } : c)) })) };
}

/**
 * A write of someone else's merged into `ours` (Studio's film), from the version the writer's copy is inferred to be:
 * of `versions` (kept, oldest first), the oldest of those it is closest to (`compare`), where the person's values stand
 * in every unit the others as near differ in (ties go to the person); or, where an agent passed on a note (`acks`: the
 * version Studio had then, by index, and the units the note named; newest last), that version, when the write is as
 * near to it as to any, or differs from it only in what the note named (the agent knew the person's values, and
 * changed them), where the person's still stand in what the versions nearest differ from it in, but what the note
 * named, and in what it named that the person changed again since. A note of
 * another agent's, while it is about (`latest`: the version is the one Studio has), counts only for a write Studio
 * overruled, sent again as it was. Where versions older than the base were let go (`gaps`), what changed from before
 * the first of those to the base stays the person's. Clips the write renamed (`renamesOf`) are merged as the clips they were, under the write's ids, when
 * the base had them, but not clips the person added (`added`, by id) since the oldest as near. `notes`: units the agents are to be told of; `agreed` says those where the write has what the
 * merge has. `mine`: the units ours has as the person left them; only those stand over the write, in a conflict, a
 * tie, a note, and only those are named (`kept`); what ours has from a write gives way to this one. Returns too the
 * base's index, the note's (`acks`) that made it the base (-1: none), and the clips renamed (ours' id, the write's).
 * Pure, so it can run in a worker.
 * @param {{ ours: FilmValue, write: FilmValue, versions: KeptFilm[], over?: boolean[], gaps?: boolean[], added?: string[], acks?: { index: number, keys: string[], latest?: boolean }[], notes?: string[], mine?: string[] | null, taken?: string[], renames?: string[][] }} input
 */
export function mergeWrite({ ours, write, versions, over = [], gaps = [], added = [], acks = [], notes = [], mine = null, taken = [], renames = [] }) {
  /* the units ours has as the person left them (all, when not said); a clip's or an entry's with it, but those a write
     changed since (`taken`) */
  const mineSet = mine ? new Set(mine) : null;
  const takenSet = new Set(taken);
  const mineClips = new Set((mine ?? []).map((k) => k.split('\0')[1]).filter(Boolean));
  /* a clip by each id writes gave it (renamed twice from one id, back and forth: all one clip); an older copy has it
     by an older one */
  /** @type {Map<string, Set<string>>} */
  const linked = new Map();
  for (const [a, b] of renames) for (const [x, y] of [[a, b], [b, a]]) linked.set(x, new Set([...(linked.get(x) ?? []), y]));
  const current = new Set(ours.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  /** a unit by each id its clip has had, the one ours has last */
  const asItWas = (/** @type {string} */ k) => {
    const p = k.split('\0');
    if (!p[1] || !linked.has(p[1])) return [k];
    const all = new Set([p[1]]);
    for (const id of all) for (const x of linked.get(id) ?? []) all.add(x);
    return [...all].sort((a, b) => Number(current.has(a)) - Number(current.has(b))).map((id) => [p[0], id, ...p.slice(2)].join('\0'));
  };
  const owns = (/** @type {string} */ key) => asItWas(key).some(ownsAs);
  const ownsAs = (/** @type {string} */ k) => {
    if (!mineSet || mineSet.has(k)) return true;
    if (takenSet.has(k)) return false;
    const id = k.split('\0')[1], entry = entryOf(k);
    /* in an entry the person added (or one a write did), then in a clip; a clip: anything of it the person's */
    if (entry && mineSet.has(entry)) return true;
    if (entry && takenSet.has(entry)) return false;
    if (k.startsWith('clip\0')) return mineClips.has(id);
    return Boolean(id) && mineSet.has(`clip\0${id}`);
  };
  /** @type {Set<KeptTrack>} */
  const seenTracks = new Set(versions.flatMap((v) => v.tracks));
  /* the base: the oldest of the nearest, and the units where the others as near differ from it; or a note's */
  const baseFor = (/** @type {FilmValue} */ theirs, skip = new Set()) => {
    const w = keepFilm(theirs);
    /* what the write changed in each of its clips at least: from the likest the versions have of it */
    /** @type {Map<string, Set<string>>} */
    const had = new Map();
    for (const t of seenTracks) t.ids.forEach((id, j) => { if (!had.has(id)) had.set(id, new Set()); /** @type {Set<string>} */ (had.get(id)).add(t.clips[j]); });
    /** @type {Map<string, number>} */
    const changed = new Map();
    for (const t of w.tracks) t.ids.forEach((id, j) => {
      const all = had.get(id);
      if (all && !all.has(t.clips[j])) changed.set(id, Math.min(...[...all].map((c) => unitsApart(JSON.parse(t.clips[j]), JSON.parse(c)).n)));
    });
    const cache = { skip, changed };
    const all = versions.map((v) => compare(w, v, cache));
    let index = 0;
    all.forEach((c, i) => { if (c.distance < all[index].distance) index = i; });
    const tied = all.flatMap((c, i) => (c.distance === all[index].distance ? [i] : []));
    /* versions let go before `at` (`gaps`), and the write has a value an older version had where `at` differs: its
       copy may have been one let go, so what changed from the version before the first such gap to `at` may be newer
       than the copy: the person's */
    const gapped = (/** @type {number} */ at) => {
      const g = gaps.findIndex((x, i) => x && i <= at);
      if (g < 0 || !stale(theirs, versions, at, all[at].apart)) return [];
      const d = compare(versions[Math.max(0, g - 1)], versions[at]);
      return [...d.apart, ...d.moved.map((id) => `track\0${id}`), ...(d.distance > d.apart.length + d.moved.length ? ['order'] : [])];
    };
    /* units where those as near as `index` differ from version `at` (`skip`: but these): the person's may be newer */
    const unsure = (/** @type {number} */ at, /** @type {string[]} */ but = []) => {
      /** @type {Set<string>} */
      const out = new Set();
      for (const i of tied) {
        if (i === at) continue;
        const d = compare(versions[i], versions[at]);
        for (const k of [...d.apart, ...d.moved.map((id) => `track\0${id}`)]) if (!but.includes(k)) out.add(k);
        if (d.distance > d.apart.length + d.moved.length && !but.includes('order')) out.add('order');
      }
      return out;
    };
    for (let n = acks.length - 1; n >= 0; n--) {
      const { index: at, keys, latest } = acks[n];
      const c = all[at];
      if (!c) continue;
      /* another agent's note, at the version Studio still has, counts only for a write Studio overruled, sent again
         as it was (the told agent insisting: a write is not signed, so no other is known to be that agent's), as near
         to that version as to any but the overruled, with no value an older version had */
      const resend = latest && all.some((x, i) => over[i] && x.distance === 0);
      const near = c.distance <= Math.min(...all.filter((_, i) => !resend || !over[i]).map((x) => x.distance));
      if (latest ? resend && near && !stale(theirs, versions, at, c.apart, over) : near || (c.apart.length && c.apart.every((k) => keys.includes(k)))) {
        /* what it named that the person changed again since stays the person's */
        const since = compare(keepFilm(ours), versions[at]);
        const again = keys.filter((k) => owns(k) && (since.apart.includes(k) || since.moved.some((id) => k === `track\0${id}`)));
        return { index: at, doubt: new Set([...unsure(at, keys.filter((k) => !again.includes(k))), ...again, ...gapped(at)]), note: n, tied };
      }
    }
    return { index, doubt: new Set([...unsure(index), ...gapped(index)]), note: -1, tied };
  };
  /* clips the write may have renamed (one with an id no version has, one of the same file a version has under an id the
     write lacks) are left out of the first guess, as either id would pull it to versions with or without it */
  /** @type {Map<string, string>} each id the versions have that the write lacks, as one of its clips is written */
  const gone = new Map();
  const writ = new Set(write.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  for (const t of seenTracks) t.ids.forEach((id, j) => { if (!writ.has(id) && !gone.has(id)) gone.set(id, t.clips[j]); });
  const known = new Set([...seenTracks].flatMap((t) => t.ids));
  const fresh = write.tracks.flatMap((t) => t.clips).filter((c) => !known.has(c.id));
  const kinds = new Set(fresh.map((c) => `${c.src}\0${c.kind ?? ''}`));
  const maybe = [...gone].filter(([, json]) => { const c = JSON.parse(json); return kinds.has(`${c.src}\0${c.kind ?? ''}`); }).map(([id]) => id);
  const skip = new Set(maybe.length ? [...maybe, ...fresh.map((c) => c.id)] : []);
  let { index, doubt, note, tied } = baseFor(write, skip);
  /* clips renamed: matched in the version nearest by the ids as written (the writer's copy: the person's edits since
     are not in the write), the oldest of those as near that has them; then the base by the clips renamed */
  let names = new Map();
  for (const i of skip.size ? tied : [tied[0]]) {
    /* not a clip the person added since the oldest as near: the writer did not have it (ties go to the person) */
    /* (a clip the first version has is no new one, put back by an undo, say) */
    const oldest = new Set([...versions[tied[0]].tracks, ...versions[0].tracks].flatMap((t) => t.ids));
    const got = new Map([...renamesOf(keptValue(versions[i]), write)].filter(([, from]) => oldest.has(from) || !added.includes(from)));
    if (got.size) { names = got; break; }
  }
  if (names.size || skip.size) ({ index, doubt, note } = baseFor(renamed(write, names)));
  /* clips renamed since the base by another write Studio took in: the base's and the write's under ours' ids */
  const base = keptValue(versions[index]);
  /* (not to an id the write has already: that is another clip of its own) */
  const inWrite = new Set(renamed(write, names).tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const toOurs = new Map([...renamesOf(base, ours)].filter(([id]) => !inWrite.has(id)).map(([id, was]) => [was, id]));
  /* and those Studio knows a write renamed */
  const ourIds = new Set(ours.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  for (const t of base.tracks) for (const c of t.clips) {
    const id = /** @type {string} */ (asItWas(`clip\0${c.id}`).at(-1)).slice(5);
    if (id !== c.id && ourIds.has(id) && !ourIds.has(c.id) && !inWrite.has(id) && ![...toOurs.values()].includes(id)) toOurs.set(c.id, id);
  }
  const rekey = (/** @type {Map<string, string>} */ ids) => (/** @type {string} */ key) => {
    const parts = key.split('\0');
    if (parts[1] && ids.has(parts[1])) parts[1] = /** @type {string} */ (ids.get(parts[1]));
    return parts.join('\0');
  };
  /* an id of the write's that Studio knows a write renamed since, to one ours has: that clip, by ours' id */
  const later = new Map(renamed(renamed(write, names), toOurs).tracks.flatMap((t) => t.clips).flatMap((c) => {
    const id = /** @type {string} */ (asItWas(`clip\0${c.id}`).at(-1)).slice(5);
    return id !== c.id && current.has(id) && !inWrite.has(id) ? [[c.id, id]] : [];
  }));
  const theirs = renamed(renamed(renamed(write, names), toOurs), later);
  /* a clip the person removed, in the write: its copy had it, whatever the base (ids are not given twice) */
  const has = new Set(ours.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  /* (but one the note the write was taken after named: the agent knew, and puts it back) */
  const told = new Set(note >= 0 ? acks[note].keys : []);
  const removed = theirs.tracks.flatMap((t) => t.clips.map((c) => c.id)).filter((id) => !has.has(id) && !told.has(`clip\0${id}`) && asItWas(`clip\0${id}`).some((k) => mineSet?.has(k))).map((id) => `clip\0${id}`);
  const { value, kept } = merge3(renamed(base, toOurs), ours, theirs, new Set([...[...doubt].map(rekey(toOurs)), ...removed]), owns);
  /* the result under the write's ids */
  const back = new Map([...names].map(([to, from]) => [toOurs.get(from) ?? from, to]));
  const rename = rekey(back);
  const result = renamed(value, back);
  /* the notes the write agrees with: by the tracks of the clips they name, alone, unless one names no clip (the order,
     the stage): then by the whole films */
  const named = new Set(notes.map((k) => k.split('\0')[1] ?? ''));
  const only = (/** @type {FilmValue} */ f) => unitsOf(named.has('') ? f : { ...f, tracks: f.tracks.filter((t) => t.clips.some((c) => named.has(c.id))) });
  const [uw, ur] = [only(write), only(result)];
  return { value: result, kept: kept.map(rename), base: index, note, renamed: [...back], agreed: notes.filter((k) => alike(uw.get(k), ur.get(k))) };
}

/* ── the merge ────────────────────────────────────────────────────────────── */

/**
 * One unit merged: `b` the base's, `o` ours, `w` the writer's. `conflict`: both changed it differently: ours stands
 * where it is the person's (`mine`), the writer's where it came from a write (only the person's edits outrank one).
 * `unsure`: the bases the write is as near to differ here, so the person may have changed it since: the person's.
 */
function pick(/** @type {unknown} */ b, /** @type {unknown} */ o, /** @type {unknown} */ w, unsure = false, mine = true) {
  if (unsure && mine) return { v: o, from: 'o', conflict: !alike(o, w) };
  if (alike(o, b)) return { v: w, from: 'w', conflict: false };
  if (alike(w, b) || alike(w, o)) return { v: o, from: 'o', conflict: false };
  return mine ? { v: o, from: 'o', conflict: true } : { v: w, from: 'w', conflict: true };
}

/**
 * Merge film `theirs` (the writer's) into `ours` (as Studio has it) from `base` (the version the writer's copy is
 * inferred to be). Returns the film, and the units where it has ours over a value of theirs (`kept`), so the writer
 * can be told. `doubt`: units where other versions the write is as near to differ from `base`: there, the person's
 * stand. `owns`: whether a unit of ours is as the person left it; where ours is a write's, Studio's own or another's,
 * it does not stand over this write, and is never named. A clip whose merge would not read (a fade longer than a clip
 * the writer cut shorter) has an earlier write's fields give way to this writer's, then the writer's that clash with
 * the person's put back (named), one by one.
 * @param {FilmValue} base @param {FilmValue} ours @param {FilmValue} theirs @param {Set<string>} [doubt] @param {(k: string) => boolean} [owns]
 * @returns {{ value: FilmValue, kept: string[] }}
 */
export function merge3(base, ours, theirs, doubt = new Set(), owns = (/** @type {string} */ _k) => true) {
  /** @type {Set<string>} */
  const kept = new Set();
  /** the clips with a unit in doubt */
  const doubted = new Set([...doubt].map((k) => k.split('\0')[1]));
  /* a unit is in doubt with what holds it: a clip some of the versions as near lack, all its fields; an entry, all
     its properties */
  /** @type {Doubt} */
  const unsure = { all: doubt, mine: owns, forPerson: new Set(), has: (k) => doubt.has(k) || doubt.has(`clip\0${k.split('\0')[1]}`) || (entryOf(k) !== '' && doubt.has(entryOf(k))) };
  const B = byId(base), O = byId(ours), W = byId(theirs);
  /** @type {Map<string, Clip>} the result's clips */
  const clips = new Map();
  /** clips placed as ours places them: ones the writer lacks, and ones the person moved */
  const placeOurs = new Set(/** @type {string[]} */ ([]));
  for (const id of new Set([...B.keys(), ...O.keys(), ...W.keys()])) {
    const b = B.get(id)?.clip, o = O.get(id)?.clip, w = W.get(id)?.clip;
    if (o && w) {
      /* most clips: changed by the writer only, or alike on both sides */
      const same = (/** @type {Clip | undefined} */ x, /** @type {Clip} */ y) => x !== undefined && (JSON.stringify(x) === JSON.stringify(y) || alike(x, y));
      clips.set(id, doubted.has(id) ? mergeClip(id, b, o, w, kept, ours.stage, unsure)
        : same(b, o) ? structuredClone(w) : same(o, w) ? structuredClone(o) : mergeClip(id, b, o, w, kept, ours.stage, unsure));
      if (doubt.has(`track\0${id}`)) placeOurs.add(id);
      continue;
    }
    const lone = doubt.has(`clip\0${id}`) && owns(`clip\0${id}`);
    if (o) {
      /* the writer removed it: so it goes, unless the person changed it since; one added since the base, or there in
         some of the versions as near and not others, stays (nothing is lost) */
      const person = (b !== undefined && !alike(o, b) && unitsApart(o, b).keys.some(owns)) || [...doubt].some((k) => k.split('\0')[1] === id && owns(k));
      if (b && !doubt.has(`clip\0${id}`) && !person) continue;
      clips.set(id, structuredClone(o));
      placeOurs.add(id);
      kept.add(`clip\0${id}`);
    } else if (w) {
      /* the person removed it (the writer's changes to it go with it); or a write did, and the writer's changes
         bring it back; or the writer added it */
      if (lone || (b && owns(`clip\0${id}`))) { kept.add(`clip\0${id}`); continue; }
      if (b && alike(w, b) && !doubt.has(`clip\0${id}`)) continue;
      clips.set(id, structuredClone(w));
    }
  }
  /* the tracks: the writer's, with the person's moves of clips and the clips only ours has put back */
  const stable = new Set([...clips.keys()].filter((id) => B.has(id) && O.has(id) && W.has(id)));
  const movedByOurs = moved(ours, base, stable), movedByTheirs = moved(theirs, base, stable);
  for (const [id, to] of movedByOurs) {
    /* the writer moved it too, elsewhere: the person's place (a write's: the writer's) */
    if (movedByTheirs.has(id) && movedByTheirs.get(id) !== to) {
      if (!owns(`track\0${id}`)) continue;
      kept.add(`track\0${id}`);
    }
    placeOurs.add(id);
  }
  /** @type {Track[]} */
  const tracks = theirs.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => clips.has(c.id) && !placeOurs.has(c.id)).map((c) => /** @type {Clip} */ (clips.get(c.id))) }));
  /* the person's placings: on a track with clips it shares one with in ours, else on one of its own where ours has it */
  const touched = new Set(/** @type {Track[]} */ ([]));
  for (const [t, track] of ours.tracks.entries()) {
    for (const c of track.clips) {
      if (!placeOurs.has(c.id)) continue;
      const others = new Set(track.clips.map((x) => x.id).filter((x) => x !== c.id && clips.has(x)));
      const clip = /** @type {Clip} */ (clips.get(c.id));
      const home = tracks.find((x) => x.clips.some((y) => others.has(y.id)));
      if (home) { home.clips.push(clip); touched.add(home); continue; }
      const made = { clips: [clip] };
      tracks.splice(Math.min(t, tracks.length), 0, made);
      touched.add(made);
    }
  }
  for (const t of touched) t.clips.sort((a, b) => Number(a.at ?? 0) - Number(b.at ?? 0));
  /** @type {FilmValue} */
  let film = { tracks: tracks.filter((t) => t.clips.length) };
  /* the stage, the tracks' order and their flags */
  const stage = pick(base.stage, ours.stage, theirs.stage, doubt.has('stage'), owns('stage'));
  if (stage.from === 'o' && !alike(stage.v, theirs.stage)) kept.add('stage');
  if (stage.v !== undefined) film = { stage: structuredClone(/** @type {FilmValue['stage']} */ (stage.v)), ...film };
  film = orderTracks(film, base, ours, theirs, kept, doubt.has('order'), owns('order'));
  /* the first of a film's tracks with one of `track`'s clips */
  const [tb, to, tw] = [B, O, W].map((m) => (/** @type {Track} */ track) => Math.min(...track.clips.map((c) => m.get(c.id)?.t ?? Infinity)));
  for (const track of film.tracks) {
    const ids = track.clips.map((c) => c.id);
    const where = new Map([[base, tb(track)], [ours, to(track)], [theirs, tw(track)]]);
    const of = (/** @type {FilmValue} */ f) => f.tracks[/** @type {number} */ (where.get(f))];
    for (const f of FLAGS) {
      const got = pick(Boolean(of(base)?.[f]), Boolean(of(ours)?.[f]), Boolean(of(theirs)?.[f]), ids.some((id) => doubt.has(`flag\0${id}\0${f}`)), ids.some((id) => owns(`flag\0${id}\0${f}`)));
      if (got.from === 'o' && Boolean(of(theirs)?.[f]) !== got.v) kept.add(`flag\0${ids[0]}\0${f}`);
      if (got.v) track[f] = true;
      else delete track[f];
    }
  }
  return { value: film, kept: [...kept].filter((k) => owns(k) || unsure.forPerson.has(k)) };
}

/**
 * The clips `film` has on another track than `base` has them on: each of film's tracks matched to the base track it
 * shares the most clips with (one each; a track made only of one base track's clips first), and a clip moved when its
 * track matches another base track than its own, or none. By id, the base track it went to (-1: a new one).
 * @param {FilmValue} film @param {FilmValue} base @param {Set<string>} stable the clips both have
 */
function moved(film, base, stable) {
  const of = (/** @type {FilmValue} */ f) => f.tracks.map((t) => t.clips.map((c) => c.id).filter((id) => stable.has(id)));
  const mine = of(film), theirs = of(base);
  /** @type {Map<string, number>} each clip's base track */
  const home = new Map(theirs.flatMap((t, j) => t.map((id) => /** @type {[string, number]} */ ([id, j]))));
  /** @type {{ i: number, j: number, n: number, pure: boolean }[]} */
  const pairs = [];
  mine.forEach((m, i) => {
    /** @type {Map<number, number>} how many of this track's clips each base track has */
    const counts = new Map();
    for (const id of m) { const j = /** @type {number} */ (home.get(id)); counts.set(j, (counts.get(j) ?? 0) + 1); }
    for (const [j, n] of counts) pairs.push({ i, j, n, pure: n === m.length });
  });
  pairs.sort((a, b) => Number(b.pure) - Number(a.pure) || b.n - a.n || a.i - b.i || a.j - b.j);
  /** @type {Map<number, number>} film's track → base track */
  const match = new Map();
  const taken = new Set();
  for (const { i, j } of pairs) if (!match.has(i) && !taken.has(j)) { match.set(i, j); taken.add(j); }
  /** @type {Map<string, number>} */
  const out = new Map();
  mine.forEach((m, i) => {
    const to = match.get(i) ?? -1;
    for (const id of m) if (home.get(id) !== to) out.set(id, to);
  });
  return out;
}

/** The clips of `film` by id: each with its track. */
function byId(/** @type {FilmValue} */ film) {
  /** @type {Map<string, { clip: Clip, t: number }>} */
  const out = new Map();
  film.tracks.forEach((track, t) => track.clips.forEach((clip) => out.set(clip.id, { clip, t })));
  return out;
}

/** One clip both have: merged field by field, its box and attributes key by key, its overrides entry by entry. */
function mergeClip(/** @type {string} */ id, /** @type {Clip | undefined} */ b, /** @type {Clip} */ o, /** @type {Clip} */ w, /** @type {Set<string>} */ kept, /** @type {FilmValue['stage']} */ stage, /** @type {Doubt} */ doubt) {
  const B = /** @type {Record<string, any>} */ (b ?? {}), O = /** @type {Record<string, any>} */ (o), W = /** @type {Record<string, any>} */ (w);
  /** @type {Record<string, any>} */
  const out = { id };
  for (const key of new Set([...Object.keys(O), ...Object.keys(W), ...Object.keys(B)])) {
    if (key === 'id') continue;
    let v;
    if ((key === 'box' || key === 'attrs') && (isRecord(O[key]) || isRecord(W[key]))) v = mergeKeys(B[key], O[key], W[key], `${key}\0${id}`, kept, doubt);
    else if (key === 'overrides') v = mergeOverrides(id, B[key], O[key], W[key], kept, doubt);
    else {
      /* a default and its absence alike; the value as the side it comes from writes it */
      const got = pick(orDefault(key, B[key]), orDefault(key, O[key]), orDefault(key, W[key]), doubt.has(`field\0${id}\0${key}`), doubt.mine(`field\0${id}\0${key}`));
      if (got.from === 'o' && !alike(got.v, orDefault(key, W[key]))) kept.add(`field\0${id}\0${key}`);
      v = got.from === 'o' ? O[key] : W[key];
    }
    if (v !== undefined) out[key] = structuredClone(v);
  }
  if (alike(out, O) || alike(out, W) || fits(stage, out)) return /** @type {Clip} */ (out);
  /* a mix that does not read (a fade longer than a clip the writer cut shorter), one field at a time until it reads:
     what an earlier write left gives way to this writer's; then, the clash being with the person's, the writer's go
     back to ours (named). Else the writer's clip, or ours when only it reads */
  const set = (/** @type {string} */ key, /** @type {unknown} */ v) => { if (v === undefined) delete out[key]; else out[key] = structuredClone(v); };
  /* a field is the person's when any unit it holds is, as the base, the writer or ours has it (one the person
     removed): asked of its units alone, so a field only writes ever set is no one's but theirs */
  const mine = (/** @type {string} */ key) => [B, W, O].some((c) => [...clipUnits(/** @type {Clip} */ ({ id, [key]: c[key] }), new Map()).keys()].some(doubt.mine));
  /* what the writer is told of: only units that stood over its write (a whole field, by all it holds) */
  const told = (/** @type {Record<string, any>} */ c) => {
    const uc = clipUnits(/** @type {Clip} */ (c), new Map()), uw = clipUnits(/** @type {Clip} */ (W), new Map());
    const same = (/** @type {string} */ k) => {
      const [kind, , name] = k.split('\0');
      return kind === 'field' ? alike(orDefault(name, c[name]), orDefault(name, W[name])) : alike(uc.get(k), uw.get(k));
    };
    for (const k of [...kept]) if (k.split('\0')[1] === id && !k.startsWith('clip\0') && same(k)) { kept.delete(k); doubt.forPerson.delete(k); }
    return /** @type {Clip} */ (c);
  };
  for (const key of new Set([...Object.keys(out), ...Object.keys(W)])) {
    if (key === 'id' || alike(out[key], W[key]) || mine(key)) continue;
    set(key, W[key]);
    if (fits(stage, out)) return told(out);
  }
  for (const key of Object.keys({ ...out, ...O })) {
    if (key === 'id' || alike(out[key], O[key])) continue;
    set(key, O[key]);
    kept.add(`field\0${id}\0${key}`);
    doubt.forPerson.add(`field\0${id}\0${key}`);
    if (fits(stage, out)) return told(out);
  }
  kept.add(`clip\0${id}`);
  return told(structuredClone(fits(stage, W) ? W : O));
}

/** A record merged key by key (a box, attributes, a style); none when it has no key left. */
function mergeKeys(/** @type {any} */ b, /** @type {any} */ o, /** @type {any} */ w, /** @type {string} */ unit, /** @type {Set<string>} */ kept, /** @type {Doubt} */ doubt) {
  const B = isRecord(b) ? b : {}, O = isRecord(o) ? o : {}, W = isRecord(w) ? w : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of new Set([...Object.keys(B), ...Object.keys(O), ...Object.keys(W)])) {
    const got = pick(B[k], O[k], W[k], doubt.has(`${unit}\0${k}`), doubt.mine(`${unit}\0${k}`));
    if (got.from === 'o' && !alike(got.v, W[k])) kept.add(`${unit}\0${k}`);
    if (got.v !== undefined) out[k] = got.v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A clip's overrides merged entry by entry (by what each points at), each entry property by property. */
function mergeOverrides(/** @type {string} */ id, /** @type {any} */ b, /** @type {any} */ o, /** @type {any} */ w, /** @type {Set<string>} */ kept, /** @type {Doubt} */ doubt) {
  const list = (/** @type {any} */ v) => new Map((Array.isArray(v) ? v : []).map((e) => [entryName(e), e]));
  const B = list(b), O = list(o), W = list(w);
  /* in ours' order, then the writer's new ones after the entry before them in its list */
  const names = [...O.keys()];
  [...W.keys()].forEach((name, i, all) => {
    if (names.includes(name)) return;
    const before = all.slice(0, i).reverse().find((n) => names.includes(n));
    names.splice(before == null ? names.length : names.indexOf(before) + 1, 0, name);
  });
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const name of names) {
    const eb = B.get(name), eo = O.get(name), ew = W.get(name);
    if (eo && ew) {
      /** @type {Record<string, unknown>} */
      const e = {};
      for (const p of new Set([...Object.keys(eo), ...Object.keys(ew), ...Object.keys(eb ?? {})])) {
        if (p === 'style' && (isRecord(eo.style) || isRecord(ew.style))) {
          const s = mergeKeys(eb?.style, eo.style, ew.style, `style\0${id}\0${name}`, kept, doubt);
          if (s) e.style = s;
          continue;
        }
        const got = pick(eb?.[p], eo[p], ew[p], doubt.has(`prop\0${id}\0${name}\0${p}`), doubt.mine(`prop\0${id}\0${name}\0${p}`));
        if (got.from === 'o' && !alike(got.v, ew[p])) kept.add(`prop\0${id}\0${name}\0${p}`);
        if (got.v !== undefined) e[p] = got.v;
      }
      out.push(e);
    } else if (eo) {
      /* the writer removed it: it goes, unless the person changed it since */
      const of = (/** @type {string} */ k) => k === `entry\0${id}\0${name}` || k.startsWith(`prop\0${id}\0${name}\0`) || k.startsWith(`style\0${id}\0${name}\0`);
      const unsure = [...doubt.all].some((k) => of(k) && doubt.mine(k));
      const person = eb && !alike(eo, eb) && Object.keys({ ...eo, ...eb, ...eo.style, ...eb.style })
        .some((p) => doubt.mine(`prop\0${id}\0${name}\0${p}`) || doubt.mine(`style\0${id}\0${name}\0${p}`));
      if (eb && !unsure && !person) continue;
      kept.add(`entry\0${id}\0${name}`);
      out.push(structuredClone(eo));
    } else if (ew) {
      /* the person removed it; or a write did, and the writer's changes bring it back; or the writer added it */
      if ((eb || doubt.has(`entry\0${id}\0${name}`)) && doubt.mine(`entry\0${id}\0${name}`)) { kept.add(`entry\0${id}\0${name}`); continue; }
      if (eb && alike(ew, eb)) continue;
      out.push(structuredClone(ew));
    }
  }
  /* the clip's own entry (its fades) goes first */
  out.sort((x, y) => Number('at' in x) - Number('at' in y));
  return out.length ? out : undefined;
}

/** The result's tracks in the writer's order, or in ours where the person reordered them since the base. */
function orderTracks(/** @type {FilmValue} */ film, /** @type {FilmValue} */ base, /** @type {FilmValue} */ ours, /** @type {FilmValue} */ theirs, /** @type {Set<string>} */ kept, unsure = false, mine = true) {
  /* each of the result's tracks: where it is in `f`, by a clip they share (-1: none) */
  const rank = (/** @type {FilmValue} */ f) => {
    const at = byId(f);
    return film.tracks.map((t) => { const i = Math.min(...t.clips.map((c) => at.get(c.id)?.t ?? Infinity)); return i === Infinity ? -1 : i; });
  };
  const [pb, po, pw] = [base, ours, theirs].map(rank);
  /* the order of the tracks all three know, as each has it */
  const all = film.tracks.map((_t, i) => i).filter((i) => pb[i] >= 0 && po[i] >= 0 && pw[i] >= 0);
  const seq = (/** @type {number[]} */ p) => [...all].sort((a, b) => p[a] - p[b] || a - b);
  const [sb, so, sw] = [pb, po, pw].map(seq);
  if (alike(so, sw) || (alike(so, sb) && !(unsure && mine))) return film;
  /* both changed it: the person's order; a write's: the writer's */
  if (!alike(sw, sb) && !mine) return film;
  if (!alike(sw, sb) || unsure) kept.add('order');
  /* the tracks ours has, in ours' order, in the places they hold; the rest stay put */
  const known = film.tracks.map((t, i) => ({ t, i, p: po[i] })).filter((x) => x.p >= 0);
  const slots = known.map((x) => x.i);
  const sorted = [...known].sort((a, b) => a.p - b.p);
  const tracks = [...film.tracks];
  slots.forEach((slot, k) => { tracks[slot] = sorted[k].t; });
  return { ...film, tracks };
}

/** Whether a clip reads as the format says, checked alone, which is quick. */
function fits(/** @type {FilmValue['stage']} */ stage, /** @type {Record<string, any>} */ clip) {
  return Boolean(readFilm({ stage, tracks: [{ clips: [structuredClone(clip)] }] }).doc);
}

/* ── text files, by lines ─────────────────────────────────────────────────── */

/** Past this many differences between two texts, they are not compared line by line. */
const EDITS_MAX = 4000;

/**
 * `ours` (the person's, from `base`) and `theirs` (the writer's) merged by lines, as diff3 does: each side's changes are
 * its hunks (base lines replaced, lines added), and a hunk only one side has is taken; so are hunks of both that touch
 * without overlapping (one side's line changed right after a line the other changed, removed or added). Where both
 * changed the same base lines, the stretch is merged as closely as it can be (one side only added lines around what
 * the other changed, both only added lines: ours first, line by line when both kept the count), else `prefer` says
 * whose stand. Null when the texts differ too much to compare.
 * @param {string} base @param {string} ours @param {string} theirs @param {'ours' | 'theirs'} prefer
 */
export function mergeLines(base, ours, theirs, prefer) {
  if (theirs === base || theirs === ours) return ours;
  if (ours === base) return theirs;
  const [B, O, T] = [base, ours, theirs].map(lines);
  const mo = matches(B, O), mt = matches(B, T);
  if (!mo || !mt) return null;
  /* both sides' hunks, by where they start; those that overlap make one region */
  const all = [...hunks(B, O, mo).map((h) => ({ ...h, ours: true })), ...hunks(B, T, mt).map((h) => ({ ...h, ours: false }))]
    .sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  /** @type {{ start: number, end: number, hunks: typeof all }[]} */
  const regions = [];
  for (const h of all) {
    const r = regions.at(-1);
    const overlaps = r && ((h.start < r.end && h.end > r.start) || (h.start === h.end && r.start === r.end && h.start === r.start));
    if (r && overlaps) { r.end = Math.max(r.end, h.end); r.hunks.push(h); }
    else regions.push({ start: h.start, end: h.end, hunks: [h] });
  }
  /** @type {string[]} */
  const out = [];
  let at = 0;
  for (const r of regions) {
    out.push(...B.slice(at, r.start));
    /* a side's lines for the region: its hunks, and the base lines between them */
    const side = (/** @type {boolean} */ ours) => {
      /** @type {string[]} */
      const got = [];
      let p = r.start;
      for (const h of r.hunks.filter((x) => x.ours === ours)) { got.push(...B.slice(p, h.start), ...h.lines); p = h.end; }
      return [...got, ...B.slice(p, r.end)];
    };
    const both = r.hunks.some((h) => h.ours) && r.hunks.some((h) => !h.ours);
    out.push(...(both ? stretch(B.slice(r.start, r.end), side(true), side(false), prefer) : side(r.hunks[0].ours)));
    at = r.end;
  }
  out.push(...B.slice(at));
  return out.join('');
}

/** A side's changes of `base` (`b`), from the lines matched (`m`): each the base lines it replaces, and its lines for them. */
function hunks(/** @type {string[]} */ b, /** @type {string[]} */ x, /** @type {number[]} */ m) {
  /** @type {{ start: number, end: number, lines: string[] }[]} */
  const out = [];
  let i = 0, k = 0;
  while (i < b.length || k < x.length) {
    if (i < b.length && m[i] === k) { i++; k++; continue; }
    const start = i, from = k;
    while (i < b.length && m[i] < 0) i++;
    k = i < b.length ? m[i] : x.length;
    out.push({ start, end: i, lines: x.slice(from, k) });
  }
  return out;
}

/**
 * How far a write (`b`) is from a version (`a`): the lines it has that the version lacks, not those it lacks (it may
 * have removed them from any version), as `distance` counts a film; Infinity past EDITS_MAX.
 */
export function linesNew(/** @type {string} */ a, /** @type {string} */ b) {
  const A = lines(a), Bl = lines(b);
  const m = matches(A, Bl);
  if (!m) return Infinity;
  return Bl.length - m.filter((x) => x >= 0).length;
}

/** How many lines two texts differ by (lines one has that the other lacks); Infinity past EDITS_MAX. */
export function lineDistance(/** @type {string} */ a, /** @type {string} */ b) {
  const A = lines(a), Bl = lines(b);
  const m = matches(A, Bl);
  if (!m) return Infinity;
  const same = m.filter((x) => x >= 0).length;
  return A.length - same + Bl.length - same;
}

/** One stretch where the sides differ from base `b`: `m` the person's lines for it, `w` the writer's. */
function stretch(/** @type {string[]} */ b, /** @type {string[]} */ m, /** @type {string[]} */ w, /** @type {'ours' | 'theirs'} */ prefer) {
  const eq = (/** @type {string[]} */ x, /** @type {string[]} */ y) => x.length === y.length && x.every((l, k) => l === y[k]);
  if (eq(m, b)) return w;
  if (eq(w, b) || eq(w, m)) return m;
  /* both only added lines here: each side's, ours first, the lines both added once (where both have them in order) */
  if (!b.length) {
    const mw = matches(m, w);
    if (!mw) return [...m, ...w];
    /** @type {string[]} */
    const out = [];
    let k = 0;
    m.forEach((l, i) => {
      if (mw[i] < 0) { out.push(l); return; }
      out.push(...w.slice(k, mw[i]), l);
      k = mw[i] + 1;
    });
    return [...out, ...w.slice(k)];
  }
  /* one side only added lines around the base lines the other changed */
  const around = (/** @type {string[]} */ x) => {
    for (let k = 0; k + b.length <= x.length; k++) if (eq(x.slice(k, k + b.length), b)) return [x.slice(0, k), x.slice(k + b.length)];
    return null;
  };
  const wa = around(w);
  if (wa) return [...wa[0], ...m, ...wa[1]];
  const ma = around(m);
  if (ma) return [...ma[0], ...w, ...ma[1]];
  /* the same number of lines on every side: line by line, each line the side that changed it */
  if (m.length === b.length && w.length === b.length) {
    return b.map((l, k) => (m[k] === l ? w[k] : w[k] === l || w[k] === m[k] ? m[k] : prefer === 'ours' ? m[k] : w[k]));
  }
  return prefer === 'ours' ? m : w;
}

/** A text's lines, each with its line break. */
const lines = (/** @type {string} */ text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * For each line of `a`, the line of `b` it is matched to in a shortest edit script (Myers), -1 for none; null past
 * EDITS_MAX differences. Lines the texts begin and end with alike are matched first.
 */
function matches(/** @type {string[]} */ a, /** @type {string[]} */ b) {
  const m = new Array(a.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { m[s] = s; s++; }
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; m[ea] = eb; }
  const n = ea - s, k = eb - s, max = n + k;
  if (!max) return m;
  /* the furthest x on each diagonal after each number of edits, kept for the walk back */
  const v = new Int32Array(2 * max + 2);
  /** @type {Int32Array[]} */
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, EDITS_MAX) && found < 0; d++) {
    trace.push(v.slice(max - d, max + d + 2));
    for (let diag = -d; diag <= d; diag += 2) {
      let x = diag === -d || (diag !== d && v[max + diag - 1] < v[max + diag + 1]) ? v[max + diag + 1] : v[max + diag - 1] + 1;
      let y = x - diag;
      while (x < n && y < k && a[s + x] === b[s + y]) { x++; y++; }
      v[max + diag] = x;
      if (x >= n && y >= k) { found = d; break; }
    }
  }
  if (found < 0) return null;
  /* back from the end: each step's snake is a run of matched lines */
  let x = n, y = k;
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const at = (/** @type {number} */ diag) => before[diag + d];
    const diag = x - y;
    const up = diag === -d || (diag !== d && at(diag - 1) < at(diag + 1));
    const prev = up ? diag + 1 : diag - 1;
    const px = at(prev), py = px - prev;
    const sx = up ? px : px + 1;
    while (x > sx && y > (sx - diag)) { x--; y--; m[s + x] = s + y; }
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; m[s + x] = s + y; }
  return m;
}
