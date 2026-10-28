/**
 * film.html: what it says. The one reading of a project's edit, shared by everything that plays it: Studio (its
 * preview and its export), and `look` / `render` (the timeline, timeline.mjs). A film that one of them accepts the
 * other accepts, and the same clip lands at the same seconds and the same place in both. Plain JavaScript with no
 * dependencies, so a browser page can import it as it is.
 *
 * The file is HTML; what it says is a value (`{ stage, tracks: [{ clips }] }`), the one every reader and editor works
 * on. The file is read into that value and the value written back into the file, changing only what changed.
 *
 *   readFilmFile(text)      → { value, doc, problems }: the file's edit, or every problem in it (nothing thrown)
 *   filmHtml(value, before) → the file that says `value`, written over `before` (what is unchanged stays as it was)
 *   readFilm(value)         → { doc, problems }: the normalized edit, or every problem in it
 *   parseFilm(value)        → doc, or an Error listing every problem
 *   clipSpan(clip, …)       → which seconds of its source a clip plays, and how long it lasts on the film
 *   pictureRect(kind, …)    → where a clip's picture lands on the stage (its `box`)
 */

export const FILM_FILE = 'film.html';
/** The stage of a film that says none. */
export const DEFAULT_STAGE = Object.freeze({ w: 1920, h: 1080 });
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4;
const TRIM_EPS = 1e-6;

const STILL_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'bmp', 'svg']);

/** A still picture (it has no length of its own: its clip's `time` is how long it stays). */
export function isStill(src) {
  /* `> 0`: a name with no dot, or a dot file (`.jpg`), is not a picture */
  const dot = src.lastIndexOf('.');
  return dot > 0 && STILL_EXTENSIONS.has(src.slice(dot + 1).toLowerCase());
}

/**
 * What a sound is for: `sfx`, `music` and `voice` by a folder it is in (where openfilm get saves them:
 * assets/audio/sfx/, music/, vo/; an agent's own assets/sfx/ alike), the nearest one deciding; elsewhere a name that
 * says music (bed, music, song, loop…) or an effect (sfx, hit, whoosh…) decides; anything else (a video's own sound
 * among them) is a voice.
 */
export function soundRole(src) {
  const path = String(src).toLowerCase();
  const folders = path.split('/').slice(0, -1).reverse();
  for (const folder of folders) {
    if (/^(sfx|fx|effects?|sound-?effects?)$/.test(folder)) return 'sfx';
    if (/^(music|bgm)$/.test(folder)) return 'music';
    if (/^(vo|voices?|voice-?over|narration)$/.test(folder)) return 'voice';
  }
  const name = path.split('/').pop() ?? '';
  if (/(^|[^a-z])(bed|music|song|soundtrack|score|theme|loop|ambient|ambience|beat)([^a-z]|$)/.test(name)) return 'music';
  if (/(^|[^a-z])(sfx|fx|hit|whoosh|swoosh|riser|impact|ding|chime)([^a-z]|$)/.test(name)) return 'sfx';
  return 'voice';
}

/* a src with a scheme (https:, data:) is an address, kept as written; any other is the path of a file */
const ADDRESS = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A clip's src as an address: its file's path with the three characters an address reads otherwise escaped (`%` an
 * escape, `#` the part of the file, `?` a query). Any other character, a space or a Chinese comma, is written as is.
 */
export function srcHref(src) {
  return ADDRESS.test(src) ? src : src.replace(/[%#?]/g, (c) => encodeURIComponent(c));
}

/** The path a src attribute names: its escapes read (`%23` is `#`), a `%` that escapes nothing kept as it is. */
function srcPath(value) {
  if (ADDRESS.test(value)) return value;
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
}

/** A web page clip: an .html file that sets `window.film` (SPEC.md). */
export function isPage(src) {
  return /\.html?$/i.test(src);
}

const SOUND_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'weba']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv']);

/** What a clip is, from its `src`: a web page, a video, a still picture or a sound; null when it is none of them. */
export function clipKind(src) {
  if (typeof src !== 'string') return null;
  if (isPage(src)) return 'page';
  if (isStill(src)) return 'still';
  const ext = src.slice(src.lastIndexOf('.') + 1).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (SOUND_EXTENSIONS.has(ext)) return 'sound';
  return null;
}

/**
 * What a clip is: its file's kind (clipKind), but a clip of a video's sound alone (`sound: true`, an <audio> of a
 * video file in film.html, as when its sound is taken apart from its picture) is a sound.
 */
export function kindOf(clip) {
  const kind = clipKind(clip?.src);
  return clip?.sound === true && kind === 'video' ? 'sound' : kind;
}

/** A clip that draws a picture (everything but a sound). */
export function hasPicture(src) {
  const kind = clipKind(src);
  return kind != null && kind !== 'sound';
}

/* ── reading ─────────────────────────────────────────────────────────────── */

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isFinite = (v) => typeof v === 'number' && Number.isFinite(v);
const isPositive = (v) => isFinite(v) && v > 0;
const pair = (v, ok) => Array.isArray(v) && v.length === 2 && ok(v[0]) && ok(v[1]);

/** The fields each kind of clip takes, in the order they are written back. */
const CLIP_FIELDS = {
  page: ['src', 'id', 'at', 'time', 'box', 'size', 'class', 'style', 'overrides', 'attrs'],
  video: ['src', 'id', 'at', 'time', 'box', 'volume', 'speed', 'class', 'style', 'overrides', 'attrs'],
  still: ['src', 'id', 'at', 'time', 'box', 'class', 'style', 'overrides', 'attrs'],
  sound: ['src', 'id', 'sound', 'at', 'time', 'volume', 'speed', 'overrides', 'attrs'],
};
/** Attributes a clip keeps that say nothing to the film: a description, a person's own data. */
const KEPT_ATTRIBUTE = /^(alt|title|lang|dir|data-[a-z0-9-]+|aria-[a-z]+)$/;
/** What a track keeps of its element that says nothing to the film: a name, a class, a description. */
const KEPT_TRACK_ATTRIBUTE = /^(id|class|title|lang|dir|data-[a-z0-9-]+|aria-[a-z]+)$/;
const OVERRIDE_FIELDS = ['at', 'n', 't', 's', 'r', 'style', 'lock', 'text', 'fade'];
/** A key of an override's style: a CSS property in camelCase, or a custom property as CSS writes it (`--accent`). */
const STYLE_KEY = /^(?:[a-zA-Z]{1,40}|--[A-Za-z0-9_-]{1,60})$/;
const BOX_FIELDS = ['x', 'y', 'w', 'h', 'r'];
/** The largest side a page is laid out at (`size`): a stage's. */
const PAGE_SIZE_MAX = 8192;
/** A copy of `row` with only `fields`, in that order: what is written back reads the same every time. */
const ordered = (row, fields) => Object.fromEntries(fields.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
const TRACK_FIELDS = ['clips', 'locked', 'hidden', 'muted', 'attrs'];

function unknownKeys(row, allowed, where, problems) {
  const extra = Object.keys(row).filter((k) => !allowed.includes(k));
  if (extra.length) problems.push(`${where}unrecognised field: ${extra.join(' · ')}`);
}

function checkTime(v, where, problems) {
  if (!Array.isArray(v) || (v.length !== 1 && v.length !== 2) || !v.every(isFinite)) {
    problems.push(`${where}its part of the file has to be [start, end] in seconds (#t=start,end).`);
    return;
  }
  if (v[0] < 0) problems.push(`${where}its part of the file (#t=${v.join(',')}) cannot start below 0.`);
  if (v.length === 2 && !(v[1] > v[0])) problems.push(`${where}its part of the file (#t=${v.join(',')}) has to end after it starts.`);
}

function checkBox(v, where, problems) {
  if (!isObject(v)) { problems.push(`${where}its place has to be left and top in px from the picture's top-left (style="left: 200px; top: 300px"), with a width and height if it has its own.`); return; }
  unknownKeys(v, BOX_FIELDS, `${where}its place: `, problems);
  if (!isFinite(v.x) || !isFinite(v.y)) problems.push(`${where}its place needs left and top: px from the picture's top-left.`);
  for (const [k, prop] of [['w', 'width'], ['h', 'height']]) if (v[k] !== undefined && !isPositive(v[k])) problems.push(`${where}${prop} has to be px above 0.`);
  if (v.r !== undefined && !isFinite(v.r)) problems.push(`${where}rotate has to be a number of degrees.`);
}

function checkOverride(o, where, problems, kind) {
  if (!isObject(o)) { problems.push(`${where}an override has to be an object: { "at": "#title", … }.`); return; }
  /* an entry without `at` is the clip's own: its fades */
  if (o.at === undefined) {
    unknownKeys(o, ['fade'], `${where}the clip's own entry (no at) holds fade only: `, problems);
    if (!pair(o.fade, (v) => isFinite(v) && v >= 0)) problems.push(`${where}fade has to be [in, out]: seconds, 0 or more.`);
    return;
  }
  if (kind !== 'page') { problems.push(`${where}at names an element inside a web page; this clip is not one (its own entry has no at: { "fade": [in, out] }).`); return; }
  unknownKeys(o, OVERRIDE_FIELDS.filter((k) => k !== 'fade'), where, problems);
  if (typeof o.at !== 'string' || !o.at || o.at.length > 512) problems.push(`${where}at has to be a CSS selector of the element.`);
  if (o.n !== undefined && !(Number.isInteger(o.n) && o.n > 0)) problems.push(`${where}n has to be a whole number from 1.`);
  if (o.t !== undefined && !pair(o.t, isFinite)) problems.push(`${where}t has to be [x, y] in px.`);
  if (o.s !== undefined && !isPositive(o.s) && !pair(o.s, isPositive)) problems.push(`${where}s has to be a multiplier above 0, or [x, y].`);
  if (o.r !== undefined && !isFinite(o.r)) problems.push(`${where}r has to be a number of degrees.`);
  if (o.style !== undefined) {
    const entries = isObject(o.style) ? Object.entries(o.style) : null;
    /* a value up to 2000 characters: a mask's inline SVG (`mask-image: url("data:image/svg+xml,…")`) runs to a few hundred */
    if (!entries || entries.length > 24
      || !entries.every(([k, v]) => STYLE_KEY.test(k) && ((typeof v === 'string' && v.length <= 2000) || isFinite(v)))) {
      problems.push(`${where}style has to be at most 24 properties, camelCase or custom (--name), each text or a number.`);
    }
  }
  if (o.lock !== undefined && o.lock !== true) problems.push(`${where}lock is true, or not written.`);
  if (o.text !== undefined && (typeof o.text !== 'string' || o.text.length > 2000)) problems.push(`${where}text has to be text (at most 2000 characters).`);
}

/** One clip, checked for what its file is. Returns the clip with its fields in their written order. */
function readClip(raw, where, problems) {
  if (!isObject(raw)) { problems.push(`${where}: a clip has to be an object: { "src": …, "at": … }.`); return null; }
  const at = `${where}: `;
  if (typeof raw.src !== 'string' || !raw.src) {
    unknownKeys(raw, [...new Set(Object.values(CLIP_FIELDS).flat())], at, problems);
    problems.push(`${at}src has to be a path, relative to ${FILM_FILE}.`);
    return null;
  }
  /* a path written on Windows (path.join) uses `\`: a film's paths are `/` everywhere, as in a URL */
  if (raw.src.includes('\\') && !/^[a-z][a-z0-9+.-]*:/i.test(raw.src)) raw = { ...raw, src: raw.src.replace(/\\/g, '/') };
  if (raw.sound !== undefined && !(raw.sound === true && clipKind(raw.src) === 'video')) {
    problems.push(`${at}sound is true, on a clip of a video file's sound alone.`);
    return null;
  }
  const kind = kindOf(raw);
  if (!kind) {
    problems.push(`${at}src has to be a web page (.html), a video, a picture or a sound file — "${raw.src}" is none of them.`);
    return null;
  }
  const before = problems.length;
  /* times are kept to the millisecond (SPEC), in place like the ids (fillClipIds): what is written back is what was
     read. Finer is noise no frame shows, and clips that touch would overlap by it */
  if (typeof raw.at === 'number' && isFinite(raw.at)) raw.at = toMs(raw.at);
  if (Array.isArray(raw.time)) raw.time = raw.time.map((v) => (typeof v === 'number' && isFinite(v) ? toMs(v) : v));
  if (raw.at !== undefined && typeof raw.at !== 'number') {
    problems.push(`${at}at has to be a number of seconds from the film's start: work out the number before writing it.`);
    return null;
  }
  if (raw.time != null && !Array.isArray(raw.time)) {
    problems.push(`${at}its part of the file has to be #t=start,end in seconds.`);
    return null;
  }
  unknownKeys(raw, CLIP_FIELDS[kind], at, problems);
  if (typeof raw.id !== 'string' || !raw.id) problems.push(`${at}every clip needs an id, unique across the film`);
  if (raw.at !== undefined && !(isFinite(raw.at) && raw.at >= 0)) problems.push(`${at}at has to be seconds from the film's start (0 or more).`);
  if (raw.time !== undefined) checkTime(raw.time, at, problems);
  if (raw.volume !== undefined && CLIP_FIELDS[kind].includes('volume') && !(isFinite(raw.volume) && raw.volume >= 0)) problems.push(`${at}volume has to be 0 or more (1 is the original level).`);
  if (raw.speed !== undefined && CLIP_FIELDS[kind].includes('speed') && !(isFinite(raw.speed) && raw.speed >= SPEED_MIN && raw.speed <= SPEED_MAX)) {
    problems.push(`${at}speed has to be a number from ${SPEED_MIN} to ${SPEED_MAX}.`);
  }
  if (raw.box !== undefined && kind !== 'sound') checkBox(raw.box, at, problems);
  if (raw.size !== undefined && !(isObject(raw.size) && Object.keys(raw.size).length === 2 && [raw.size.w, raw.size.h].every((v) => Number.isInteger(v) && v > 0 && v <= PAGE_SIZE_MAX))) {
    problems.push(`${at}size is the px a page is laid out at, whole numbers up to ${PAGE_SIZE_MAX}: { "w": 1920, "h": 1080 }.`);
  }
  if (raw.overrides !== undefined) {
    if (!Array.isArray(raw.overrides) || raw.overrides.length > 200) problems.push(`${at}overrides has to be a list (at most 200).`);
    else {
      /* fades to the millisecond, as every time is */
      for (const o of raw.overrides) if (isObject(o) && Array.isArray(o.fade)) o.fade = o.fade.map((v) => (typeof v === 'number' && isFinite(v) ? toMs(v) : v));
      raw.overrides.forEach((o, i) => checkOverride(o, `${at}overrides[${i}]: `, problems, kind));
      const own = raw.overrides.filter((o) => isObject(o) && o.at === undefined);
      if (own.length > 1) problems.push(`${at}overrides has one entry of the clip's own (without at), not ${own.length}.`);
      /* both fades fit in the clip, when its length is written (a still's, or a fragment's end) */
      const fade = own[0]?.fade;
      const length = Array.isArray(raw.time) && raw.time.length === 2 && raw.time.every(isFinite) ? (raw.time[1] - raw.time[0]) / (CLIP_FIELDS[kind].includes('speed') && isFinite(raw.speed) && raw.speed > 0 ? raw.speed : 1) : null;
      if (pair(fade, isFinite) && length != null && fade[0] + fade[1] > length + 1e-3) {
        problems.push(`${at}fade [${fade.join(', ')}] is longer than the clip (${toMs(length)} s): in + out fit in its length.`);
      }
    }
  }
  if (raw.class !== undefined && (typeof raw.class !== 'string' || !raw.class.trim())) problems.push(`${at}class has to be class names.`);
  if (raw.style !== undefined && (typeof raw.style !== 'string' || !raw.style.trim())) problems.push(`${at}style has to be CSS declarations.`);
  if (raw.attrs !== undefined && !(isObject(raw.attrs) && Object.entries(raw.attrs).every(([k, v]) => (KEPT_ATTRIBUTE.test(k) || (kind === 'sound' && k === 'class')) && typeof v === 'string'))) {
    problems.push(`${at}attrs has to be text attributes: alt, title, lang, dir, data-* or aria-*.`);
  }
  if (problems.length > before) return null;
  const clip = ordered(raw, CLIP_FIELDS[kind]);
  if (clip.box) clip.box = ordered(clip.box, BOX_FIELDS);
  if (clip.size) clip.size = { w: clip.size.w, h: clip.size.h };
  if (clip.overrides) clip.overrides = clip.overrides.map((o) => ordered(o, OVERRIDE_FIELDS));
  return clip;
}

/** Seconds, to the millisecond. @param {number} s */
const toMs = (s) => Math.round(s * 1000) / 1000 || 0;

/** A name without the dashes at its ends (by index: a pattern for it backtracks over a long run of them). */
function trimDashes(/** @type {string} */ name) {
  let start = 0, end = name.length;
  while (start < end && name[start] === '-') start++;
  while (end > start && name[end - 1] === '-') end--;
  return name.slice(start, end);
}

/**
 * The name a clip gets when it has none: its source's file name (`assets/audio/vo/02-turn.m4a` → `02-turn`), with
 * `-2`, `-3` when taken. Letters are Unicode letters: a file named in Chinese keeps its name.
 */
export function clipIdFor(src, used) {
  const base = (src ?? '').split(/[/\\]/).pop() ?? '';
  const stem = trimDashes(base.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-')) || 'clip';
  const taken = new Set(used);
  if (!taken.has(stem)) return stem;
  let n = 2;
  while (taken.has(`${stem}-${n}`)) n++;
  return `${stem}-${n}`;
}

/**
 * Name the clips that have no id, in place (before checking, so every clip downstream has a name). In place on
 * purpose: what is written back is what was read, so a name, once given, stays put on disk.
 */
function fillClipIds(tracks) {
  const taken = new Set();
  const blank = [];
  for (const track of tracks) {
    if (!isObject(track) || !Array.isArray(track.clips)) continue;
    for (const clip of track.clips) {
      if (!isObject(clip)) continue;
      if (typeof clip.id === 'string' && clip.id) taken.add(clip.id);
      else blank.push(clip);
    }
  }
  for (const clip of blank) {
    clip.id = clipIdFor(typeof clip.src === 'string' ? clip.src : undefined, taken);
    taken.add(clip.id);
  }
}

/**
 * Read an edit. Returns the normalized edit (fields in their written order) and every
 * problem found; `doc` is null when there is any (`whole`: the problem is with the edit as a whole, so nothing in it
 * was checked). Clips without an id are named in `value` itself (see fillClipIds).
 */
export function readFilm(value) {
  /* a problem with the whole (a wrong stage, no tracks) stops the reading: nothing below it can be checked */
  const fail = (message) => ({ doc: null, problems: [message], whole: true });
  if (!isObject(value)) return fail(`${FILM_FILE} has to be read as a stage and its tracks.`);
  if ('clips' in value && !('tracks' in value)) {
    return fail(`${FILM_FILE} holds its clips in tracks: each <section> is a track.`);
  }
  const extra = Object.keys(value).filter((k) => !['stage', 'tracks'].includes(k));
  if (extra.length) return fail(`${FILM_FILE} is a stage and its tracks; there is nothing else: ${extra.join(' · ')}`);
  const stage = value.stage ?? DEFAULT_STAGE;
  if (!isObject(stage) || !(Number.isInteger(stage.w) && stage.w > 0) || !(Number.isInteger(stage.h) && stage.h > 0)) {
    return fail(`${FILM_FILE} wants a picture size of positive whole numbers: <meta name="viewport" content="width=1920, height=1080"> (without one, it is 1920 × 1080).`);
  }
  if (!Array.isArray(value.tracks)) return fail(`${FILM_FILE} needs its tracks: each <section> is one.`);
  fillClipIds(value.tracks);

  const problems = [];
  const tracks = [];
  const seen = new Map();
  value.tracks.forEach((row, ti) => {
    if (!isObject(row)) { problems.push(`tracks[${ti}]: a track is a <section> of clips.`); return; }
    const extraKeys = Object.keys(row).filter((k) => !TRACK_FIELDS.includes(k));
    if (extraKeys.length) problems.push(`tracks[${ti}]: unrecognised field: ${extraKeys.join(' · ')}`);
    if (!Array.isArray(row.clips)) { problems.push(`tracks[${ti}]: a track is a <section> of clips; this one has none to read.`); return; }
    const clips = [];
    row.clips.forEach((raw, ci) => {
      const src = isObject(raw) && typeof raw.src === 'string' ? ` "${raw.src}"` : '';
      const where = `tracks[${ti}].clips[${ci}]${src}`;
      const clip = readClip(raw, where, problems);
      if (!clip) return;
      const dup = seen.get(clip.id);
      if (dup != null) {
        problems.push(`tracks[${ti}].clips[${ci}] and ${dup} both have the id "${clip.id}" — every clip id has to be unique.`);
        return;
      }
      seen.set(clip.id, `tracks[${ti}].clips[${ci}]`);
      clips.push(clip);
    });
    for (const flag of ['locked', 'hidden', 'muted']) {
      if (row[flag] != null && typeof row[flag] !== 'boolean') { problems.push(`tracks[${ti}]: ${flag} has to be true / false.`); return; }
    }
    if (row.attrs !== undefined && !(isObject(row.attrs) && Object.entries(row.attrs).every(([k, v]) => KEPT_TRACK_ATTRIBUTE.test(k) && typeof v === 'string'))) {
      problems.push(`tracks[${ti}]: attrs has to be text attributes: id, class, title, lang, dir, data-* or aria-*.`);
      return;
    }
    tracks.push({ clips, ...(row.locked === true ? { locked: true } : {}), ...(row.hidden === true ? { hidden: true } : {}), ...(row.muted === true ? { muted: true } : {}), ...(row.attrs && Object.keys(row.attrs).length ? { attrs: row.attrs } : {}) });
  });
  if (problems.length) return { doc: null, problems };
  return { doc: { stage: { w: stage.w, h: stage.h }, tracks }, problems };
}

/** The edit, or an Error that lists every problem in it. */
export function parseFilm(value) {
  const { doc, problems, whole } = readFilm(value);
  if (doc) return doc;
  throw new Error(whole ? problems[0] : `${FILM_FILE} has ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n  ${problems.join('\n  ')}`);
}

/* ── timing ──────────────────────────────────────────────────────────────── */

/** The rate a clip plays its source at: 1 for web pages and stills, which have no `speed`. */
export function clipSpeed(clip) {
  const kind = kindOf(clip);
  if (kind === 'page' || kind === 'still') return 1;
  const v = clip.speed;
  return isFinite(v) && v >= SPEED_MIN && v <= SPEED_MAX ? v : 1;
}

/**
 * Which part of its source a clip plays and how long it lasts on the film.
 *
 * `native`: the source's own length in seconds: a video's or a sound's file length, a web page's duration. Not
 * needed for a still, whose `time` is its length (a still is a source of endless length, cut by `time`), and none
 * for a page without a duration, which has no end either: its `time` is its length too.
 *
 * Returns `{ from, to, speed, length }`: the source seconds [from, to) and the film seconds the clip takes,
 * `(to − from) / speed`. A web page may run past its own end (it holds its last frame); a file may not. Throws, with
 * the clip named by `where`, when the trim is impossible.
 */
export function clipSpan(clip, native, where = 'clip') {
  const kind = kindOf(clip);
  const time = clip.time ?? [];
  const from = time[0] ?? 0;
  const still = kind === 'still';
  if (still) {
    if (!(time.length === 2 && time[1] > 0)) {
      throw new Error(`${where}: a still has no length of its own — say how long it stays with a media fragment, e.g. src="photo.png#t=0,4".`
        + '\n  On a video or a sound #t= is a trim into the file; on a picture there is nothing to trim,'
        + ' so those two numbers are the length.');
    }
    return { from, to: time[1], speed: 1, length: time[1] - from };
  }
  if (!(isFinite(native) && native > 0) && time.length !== 2) {
    if (kind === 'page') {
      throw new Error(`${where}: this page has no duration, so it has no end of its own — say how long it plays with a media fragment, e.g. src="title.html#t=0,4".`
        + '\n  A page with a duration plays all of it without #t=; a page without one is like a still.');
    }
    throw new Error(`${where}: no length to trim against.`);
  }
  const to = time[1] ?? native;
  if (from < -TRIM_EPS) throw new Error(`${where}: #t=${from},… starts below 0 (#t= is a part of the file, within [0, its length]).`);
  if (to + TRIM_EPS < from) throw new Error(`${where}: #t=${from},${to} has to end after it starts.`);
  if (kind !== 'page' && isFinite(native) && native > 0) {
    if (to > native + TRIM_EPS) throw new Error(`${where}: #t=${from},${to} ends past the file's length of ${native} s (#t= is a part of the file, within [0, its length]).`);
    if (from > native + TRIM_EPS) throw new Error(`${where}: #t=${from},${to} starts past the file's length of ${native} s (#t= is a part of the file, within [0, its length]).`);
  }
  const speed = clipSpeed(clip);
  return { from, to, speed, length: (to - from) / speed };
}

/**
 * The source second a clip shows `localSec` into the film's span of it. A web page past its own end holds its last
 * frame (`native` − 1 ms: the page's frame(t) takes t in [0, duration)).
 */
export function sourceAt(span, localSec, clip, native) {
  const t = span.from + localSec * span.speed;
  return kindOf(clip) === 'page' && isFinite(native) ? Math.max(0, Math.min(t, native - 1e-3)) : t;
}

/* ── fades ───────────────────────────────────────────────────────────────── */

/** A clip's fades, `[in, out]` in seconds (its overrides' entry without `at`), or null when it has none. */
export function clipFade(clip) {
  const own = Array.isArray(clip?.overrides) ? clip.overrides.find((o) => isObject(o) && o.at === undefined) : null;
  const fade = own?.fade;
  return pair(fade, (v) => isFinite(v) && v >= 0) && (fade[0] > 0 || fade[1] > 0) ? [fade[0], fade[1]] : null;
}

/**
 * How much of a clip shows and is heard `local` seconds into its `length` on the film, 0 to 1: a straight ramp up
 * over its first `fade[0]` seconds and down over its last `fade[1]` (SPEC §1). Fades longer together than the clip
 * (its length not written in the file) are shortened alike to fit.
 */
export function fadeGain(local, length, fade) {
  if (!fade || !(length > 0)) return 1;
  const k = fade[0] + fade[1] > length ? length / (fade[0] + fade[1]) : 1;
  const fin = fade[0] * k, fout = fade[1] * k;
  let g = 1;
  if (fin > 0) g = Math.min(g, local / fin);
  if (fout > 0) g = Math.min(g, (length - local) / fout);
  return Math.max(0, Math.min(1, g));
}

/** A clip's fades fitted to its `length` (see fadeGain), or null. @returns {[number, number] | null} */
export function fittedFade(fade, length) {
  if (!fade || !(length > 0)) return null;
  const k = fade[0] + fade[1] > length ? length / (fade[0] + fade[1]) : 1;
  return [fade[0] * k, fade[1] * k];
}

/* ── placement ───────────────────────────────────────────────────────────── */

/**
 * Where a clip's picture lands on the stage. `kind` is the clip's (see clipKind); `own` the picture's own size: a
 * page's width × height (when it sets none, its clip's `size`, else the stage's), a video's or still's pixels. The box's w and h, its own size
 * without them, and with only one of them the other follows the picture's proportions. A video or still is its box
 * (the stage without one), the picture inside it as CSS says; a page is fitted whole inside its box and centered (its
 * own size, centered, without one). Returns the rectangle drawn `{ x, y, w, h }` before it turns, and `r`: degrees clockwise
 * about its center, which is the box's.
 */
export function pictureRect(kind, own, stage, box) {
  const [ow, oh] = own?.w > 0 && own?.h > 0 ? [own.w, own.h] : [stage.w, stage.h];
  const b = box ?? (kind === 'page' ? { x: (stage.w - ow) / 2, y: (stage.h - oh) / 2 } : { x: 0, y: 0, w: stage.w, h: stage.h });
  const bw = b.w ?? (b.h != null ? (b.h * ow) / oh : ow);
  const bh = b.h ?? (b.w != null ? (b.w * oh) / ow : oh);
  /* a video or still is its box; how the picture sits in it is CSS (object-fit: contain, unless the film says) */
  if (kind !== 'page') return { x: b.x, y: b.y, w: bw, h: bh, r: b.r ?? 0 };
  const k = Math.min(bw / ow, bh / oh);
  const w = ow * k, h = oh * k;
  return { x: b.x + (bw - w) / 2, y: b.y + (bh - h) / 2, w, h, r: b.r ?? 0 };
}

/* ── film.html: the file ──────────────────────────────────────────────────── */

/*
 * A film is a web page. Its <head> is the page's own (styles, fonts, the stage's size as the viewport); its <body> is
 * the tracks, each a <section>, the first on top, and each track's clips: <iframe> a web page, <video>, <img> a still,
 * <audio> a sound. Which seconds of its source a clip plays is a media fragment on its src (`a.mp4#t=2,6`); where it
 * starts on the film, `at`; where its picture sits, `left`, `top`, `width`, `height` and `rotate` in its own style;
 * how it looks, any other CSS. The reader below takes no more than that, and says where anything else is.
 */

/** The element of each kind of clip, and back. */
const KIND_OF_TAG = { iframe: 'page', video: 'video', img: 'still', audio: 'sound' };
const TAG_OF_KIND = { page: 'iframe', video: 'video', still: 'img', sound: 'audio' };
/** Where a picture sits: these of its style, in stage px (rotate in degrees), and nothing else may move it. */
const BOX_OF_PROP = { left: 'x', top: 'y', width: 'w', height: 'h', rotate: 'r' };
/** What the film sets itself (BOX_OF_PROP does the placing): written in a clip's style, it would fight the film. */
const PLACING = new Set(['position', 'inset', 'right', 'bottom', 'margin', 'transform', 'translate', 'scale', 'z-index', 'visibility', 'display']);
const TRACK_FLAGS = ['hidden', 'muted', 'locked'];
/** CSS that moves in time: a film's styles hold still (they would run on the film's clock, not a clip's). */
const TIMED = /^(animation|transition)(-|$)/;
const STILL_CSS = 'a film\'s CSS holds still — what moves is a web page of its own, a clip (its animation runs on the clip\'s time; in film.html it would run on the film\'s).';
/** A clip's attributes, each with what it says. */
const CLIP_ATTRIBUTES = new Set(['id', 'src', 'at', 'speed', 'volume', 'muted', 'size', 'class', 'style', 'overrides']);

/** What one kind of clip does not take, and why. */
const NO_SOUND = 'has no sound: a sound is a clip of its own, an <audio> (or a <video>\'s own sound)';
const PAGE_ONLY = 'size is the px a web page is laid out at: a file has its own size.';
const NOT_OF_KIND = {
  page: { volume: `a page ${NO_SOUND}.`, muted: `a page ${NO_SOUND}.`, speed: 'a page has no speed: its own frame(t) decides how fast it moves.' },
  video: { size: PAGE_ONLY },
  still: { volume: `a still ${NO_SOUND}.`, muted: `a still ${NO_SOUND}.`, speed: 'a still has no speed: it holds for as long as its #t=0,length.', size: PAGE_ONLY },
  sound: { style: 'a sound has no look: it is heard, not seen.', size: PAGE_ONLY },
};

/**
 * What an agent writes from elsewhere (other editors' and video formats, web pages), answered with what it is here.
 */
const ATTRIBUTE_HINTS = {
  time: 'the part of the file goes on src as a media fragment: src="a.mp4#t=2,6" (its seconds 2 to 6)',
  start: 'at="…" (the film second it starts at)',
  'data-start': 'at="…" (the film second it starts at)',
  offset: 'at="…" (the film second it starts at)',
  duration: 'src="…#t=start,end" (which seconds of the file it plays; a still, or a page without a duration: #t=0,length)',
  'data-duration': 'src="…#t=start,end" (which seconds of the file it plays; a still, or a page without a duration: #t=0,length)',
  end: 'src="…#t=start,end" (which seconds of the file it plays)',
  'data-track-index': 'nothing: a clip\'s track is the <section> it is in (the first section is on top)',
  track: 'nothing: a clip\'s track is the <section> it is in (the first section is on top)',
  width: 'style="width: …px" (stage px)',
  height: 'style="height: …px" (stage px)',
  rate: 'speed="…"',
  playbackrate: 'speed="…"',
  gain: 'volume="…" (1 is the file\'s own level, 0 silent)',
  autoplay: 'nothing: the film plays its clips itself',
  controls: 'nothing: the film plays its clips itself',
  loop: 'nothing: the film plays its clips itself; a clip plays its part of the file once',
  playsinline: 'nothing: the film plays its clips itself',
  preload: 'nothing: the film loads its clips itself',
  loading: 'nothing: the film loads its clips itself',
  poster: 'nothing: a video shows its own frames',
  frameborder: 'nothing: a page clip has no border',
  scrolling: 'nothing: a page clip never scrolls',
  allow: 'nothing',
  allowfullscreen: 'nothing',
};

/** What a page's head holds; any other element begins the body. */
const HEAD_TAGS = new Set(['html', 'head', 'meta', 'link', 'style', 'title', 'base', 'script', 'noscript']);
const VOID_TAGS = new Set(['img', 'meta', 'link', 'br', 'hr', 'base', 'input', 'source', 'track', 'col', 'area', 'embed', 'param', 'wbr']);
/** Elements whose content is text up to their end tag, not markup. */
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'noscript']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

const decode = (v) => v.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? all;
});
const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The markup of an HTML text, as a list: start tags (with their attributes, in order), end tags, comments and text,
 * each with where it is. The content of an element of RAW_TEXT is one text. Enough of HTML for a film's file: tags,
 * quoted and bare attribute values, comments, a doctype.
 */
function markup(text) {
  const out = [];
  let i = 0;
  const textUpTo = (end) => { if (end > i) out.push({ type: 'text', start: i, end, text: text.slice(i, end) }); i = end; };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { textUpTo(text.length); break; }
    textUpTo(lt);
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const end = close < 0 ? text.length : close + 3;
      out.push({ type: 'comment', start: i, end });
      i = end;
      continue;
    }
    if (text[i + 1] === '!' || text[i + 1] === '?') {
      const end = text.indexOf('>', i) < 0 ? text.length : text.indexOf('>', i) + 1;
      out.push({ type: 'doctype', start: i, end });
      i = end;
      continue;
    }
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(i, i + 64));
    if (!tag) { textUpTo(i + 1); continue; }
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    let j = i + tag[0].length;
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j >= text.length) break;
      if (text[j] === '>') { j++; break; }
      if (text.startsWith('/>', j)) { selfClosing = true; j += 2; break; }
      if (text[j] === '/') { j++; continue; }
      const at = /^[^\s"'>\/=]+/.exec(text.slice(j, j + 256));
      if (!at) { j++; continue; }
      const attr = { name: at[0].toLowerCase(), value: '', start: j, end: j + at[0].length, bare: true };
      j += at[0].length;
      let k = j;
      while (k < text.length && /\s/.test(text[k])) k++;
      if (text[k] === '=') {
        k++;
        while (k < text.length && /\s/.test(text[k])) k++;
        const q = text[k];
        if (q === '"' || q === "'") {
          const close = text.indexOf(q, k + 1);
          const stop = close < 0 ? text.length : close;
          attr.value = decode(text.slice(k + 1, stop));
          j = Math.min(text.length, stop + 1);
        } else {
          const bare = /^[^\s>]*/.exec(text.slice(k))[0];
          attr.value = decode(bare);
          j = k + bare.length;
        }
        attr.bare = false;
        attr.end = j;
      }
      attrs.push(attr);
    }
    out.push({ type: closing ? 'close' : 'open', name, attrs, start: i, end: j, selfClosing });
    i = j;
    if (!closing && RAW_TEXT.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(i));
      const end = close ? i + close.index : text.length;
      if (end > i) out.push({ type: 'text', start: i, end, text: text.slice(i, end), raw: true });
      i = end;
      if (close) { out.push({ type: 'close', name, attrs: [], start: end, end: end + close[0].length }); i = end + close[0].length; }
    }
  }
  return out;
}

/** The line a place in the text is on, from 1. */
const lineAt = (text, at) => { let n = 1; for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++; return n; };

/** Seconds as a media fragment writes them: plain seconds, `mm:ss` or `hh:mm:ss`, each with a fraction. */
function fragmentSeconds(v) {
  const s = v.replace(/^npt:/, '').trim();
  if (s === '') return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/** A style attribute's declarations, in order: `[property, value]`, the property in lower case. */
export function declarations(style) {
  const out = [];
  let depth = 0, quote = '', from = 0;
  const take = (to) => {
    const part = style.slice(from, to);
    const colon = part.indexOf(':');
    if (colon > 0) out.push([part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim()]);
    else if (part.trim()) out.push([part.trim().toLowerCase(), '']);
  };
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { take(i); from = i + 1; }
  }
  take(style.length);
  return out;
}

/** A number of `unit` (`56px`, `12deg`; a bare 0 too), or NaN. */
const amount = (v, unit) => { const m = new RegExp(`^(-?\\d+(?:\\.\\d+)?|-?\\.\\d+)${unit}$`).exec(v.trim()); return m ? Number(m[1]) : v.trim() === '0' ? 0 : NaN; };

/** How an element is called in a problem: its tag, with its id or its file. */
function named(tag) {
  const id = tag.attrs.find((a) => a.name === 'id')?.value;
  const src = tag.attrs.find((a) => a.name === 'src')?.value;
  return `<${tag.name}${id ? ` id="${id}"` : src ? ` src="${src}"` : ''}>`;
}

/** One clip's element as the value's clip (unchecked: readFilm checks it), or null with what is wrong said. */
function clipOfTag(tag, where, problems) {
  const kind = KIND_OF_TAG[tag.name];
  const raw = {};
  const attrs = {};
  const before = problems.length;
  let muted = false;
  for (const a of tag.attrs) {
    const { name, value } = a;
    /* a sound's class names it, nothing more: it has no look */
    if (kind === 'sound' && name === 'class') { if (value.trim()) attrs.class = value; continue; }
    if (NOT_OF_KIND[kind]?.[name]) { problems.push(`${where}: ${NOT_OF_KIND[kind][name]}`); continue; }
    if (!CLIP_ATTRIBUTES.has(name)) {
      const hint = ATTRIBUTE_HINTS[name];
      if (!hint && KEPT_ATTRIBUTE.test(name)) { attrs[name] = value; continue; }
      problems.push(`${where}: ${name} is not an attribute of a clip${hint ? ` → ${hint}` : ' (a clip takes id, src, at, speed, volume, muted, class and style)'}.`);
      continue;
    }
    if (name === 'id') { if (value) raw.id = value; }
    else if (name === 'src') {
      const hash = value.indexOf('#');
      raw.src = srcPath(hash < 0 ? value : value.slice(0, hash));
      if (hash >= 0) {
        const m = /^t=([^,]*)(?:,(.*))?$/.exec(value.slice(hash + 1));
        const from = m ? fragmentSeconds(m[1]) : NaN;
        const to = m && m[2] !== undefined ? fragmentSeconds(m[2]) : undefined;
        if (!m || !Number.isFinite(from) || (to !== undefined && !Number.isFinite(to))) {
          problems.push(`${where}: src's fragment says which seconds of the file it plays, like src="a.mp4#t=2,6" (2 s to 6 s) or "#t=2" (2 s to the end) — "${value.slice(hash)}" is not that.${m ? '' : ' A # in the file\'s name is written %23.'}`);
        } else if (to !== undefined) raw.time = [from, to];
        else if (from > 0) raw.time = [from];
      }
    } else if (name === 'class') { if (value.trim()) raw.class = value.trim().split(/\s+/).join(' '); }
    else if (name === 'size') {
      const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
      if (!m) problems.push(`${where}: size is the px the page is laid out at, width x height, like size="1920x1080" — "${value}" is not.`);
      else raw.size = { w: Number(m[1]), h: Number(m[2]) };
    }
    else if (name === 'muted') muted = true;
    else if (name === 'overrides') {
      try { raw.overrides = JSON.parse(value); }
      catch { problems.push(`${where}: overrides is Studio's list of the person's changes, as JSON — it does not read as JSON.`); }
    } else if (name === 'style') {
      const rest = [];
      for (const [prop, v] of declarations(value)) {
        if (BOX_OF_PROP[prop]) {
          const n = amount(v, prop === 'rotate' ? 'deg' : 'px');
          if (!Number.isFinite(n)) problems.push(`${where}: ${prop} is ${prop === 'rotate' ? 'degrees, like rotate: 8deg' : 'stage px, like ' + prop + ': 120px'} — "${v}" is not.`);
          else (raw.box ??= {})[BOX_OF_PROP[prop]] = n;
        } else if (PLACING.has(prop)) {
          problems.push(`${where}: ${prop} would move the clip — a picture is placed by left, top, width, height and rotate in its style.`);
        } else if (TIMED.test(prop)) {
          problems.push(`${where}: ${STILL_CSS}`);
        } else rest.push(`${prop}: ${v}`);
      }
      if (rest.length) raw.style = rest.join('; ');
    } else {
      /* at, speed, volume: numbers */
      const n = value.trim() === '' ? NaN : Number(value);
      if (!Number.isFinite(n)) problems.push(`${where}: ${name} is a number${name === 'at' ? ' of seconds (the film second it starts at)' : ''} — "${value}" is not.`);
      else raw[name] = n;
    }
  }
  if (raw.box) raw.box = { x: raw.box.x ?? 0, y: raw.box.y ?? 0, ...raw.box };
  if (muted) raw.volume = 0;
  if (Object.keys(attrs).length) raw.attrs = attrs;
  /* an <audio> of a video file is that video's sound alone (its picture, if used, is a <video> clip of its own) */
  if (kind === 'sound' && clipKind(raw.src) === 'video') raw.sound = true;
  if (typeof raw.src !== 'string' || !raw.src) problems.push(`${where}: a clip needs src, its file (relative to ${FILM_FILE}).`);
  else if (clipKind(raw.src) !== kind && !raw.sound) {
    const is = clipKind(raw.src);
    problems.push(`${where}: "${raw.src}" is ${is ? `a ${is === 'page' ? 'web page' : is}, a clip of <${TAG_OF_KIND[is]}>` : 'no clip a film plays (a web page, a video, a picture or a sound)'} — <${tag.name}> is for ${kind === 'page' ? 'a web page (.html)' : `a ${kind}`}.`);
  }
  return problems.length > before ? null : raw;
}

/**
 * Read a film.html: the value it says (clips named, see readFilm), checked, or every problem in it, each with the
 * line it is on. `layout` is where each part of the value is in the text, for filmHtml to write over.
 */
export function readFilmFile(text) {
  const marks = markup(text);
  const problems = [];
  const at = (m) => `${FILM_FILE}:${lineAt(text, m.start)}`;
  let stage;
  let bodyStart = -1;
  let viewport = null;
  let i = 0;
  /* the head: anything a page's head holds, but no script (a film is not code: code is a page's), and the stage */
  for (; i < marks.length; i++) {
    const m = marks[i];
    if (m.type === 'open' && m.name === 'body') { bodyStart = m.end; i++; break; }
    /* an element of the body begins it, <body> written or not (as a browser reads it) */
    if (m.type === 'open' && !HEAD_TAGS.has(m.name)) { bodyStart = m.start; break; }
    if (m.type === 'text' && !m.raw && m.text.trim()) { bodyStart = m.start; break; }
    if (m.type !== 'open') continue;
    if (m.name === 'script') problems.push(`${at(m)}: a film runs no script — what moves is a web page of its own, a clip (<iframe src="title.html">).`);
    if (m.name === 'style' && /@keyframes|(^|[;{\s])(animation|transition)(-[a-z-]+)?\s*:/i.test(marks[i + 1]?.raw ? marks[i + 1].text : '')) problems.push(`${at(m)}: ${STILL_CSS}`);
    if (m.name === 'base') problems.push(`${at(m)}: a film has no <base>: its clips' files are relative to ${FILM_FILE}.`);
    if (m.name === 'meta' && m.attrs.find((a) => a.name === 'name')?.value.toLowerCase() === 'viewport') {
      viewport = m;
      const content = m.attrs.find((a) => a.name === 'content')?.value ?? '';
      const w = Number(/(?:^|[,;\s])width\s*=\s*(\d+)/i.exec(content)?.[1]);
      const h = Number(/(?:^|[,;\s])height\s*=\s*(\d+)/i.exec(content)?.[1]);
      if (!(w > 0 && h > 0)) problems.push(`${at(m)}: the viewport is the film's frame, in px: <meta name="viewport" content="width=1920, height=1080">.`);
      else stage = { w, h };
    }
  }
  if (bodyStart < 0) bodyStart = text.length;
  /* the body: tracks, each a <section> of clips */
  const tracks = [];
  const lines = [];
  const layout = { bodyStart, bodyEnd: text.length, viewport: viewport ? { start: viewport.start, end: viewport.end } : null, tracks: [], tail: [] };
  let track = null;
  let pending = [];
  /** Where an element that has no place here ends (said once: its content and end tag are passed over with it). */
  const past = (from) => {
    const m = marks[from];
    if (m.type !== 'open' || VOID_TAGS.has(m.name) || m.selfClosing) return from;
    for (let j = from + 1, depth = 1; j < marks.length; j++) {
      if (marks[j].name !== m.name) continue;
      depth += marks[j].type === 'open' ? 1 : marks[j].type === 'close' ? -1 : 0;
      if (!depth) return j;
    }
    return marks.length;
  };
  const stray = (m) => m.type === 'open' && m.name === 'script' ? 'a film runs no script — what moves is a web page of its own, a clip (<iframe src="title.html">).'
    : m.type === 'open' && (m.name === 'style' || m.name === 'link') ? 'styles go in <head>.'
      : `<${m.type === 'close' ? '/' : ''}${m.name}> — a film's body is its tracks, each a <section> of clips (<iframe>, <video>, <img>, <audio>); anything else on screen is a web page of its own, a clip.`;
  for (; i < marks.length; i++) {
    const m = marks[i];
    if (m.type === 'comment') { pending.push(m); continue; }
    if (m.type === 'text') {
      if (m.text.trim()) problems.push(`${at(m)}: text "${m.text.trim().slice(0, 40)}" is outside any clip — words on screen are a web page of their own, a clip (<iframe src="title.html">).`);
      continue;
    }
    if (m.type === 'close' && (m.name === 'body' || m.name === 'html')) { layout.bodyEnd = m.start; break; }
    if (!track) {
      if (m.type === 'open' && m.name === 'section') {
        const raw = { clips: [] };
        for (const a of m.attrs) {
          if (TRACK_FLAGS.includes(a.name)) raw[a.name] = true;
          else if (KEPT_TRACK_ATTRIBUTE.test(a.name)) (raw.attrs ??= {})[a.name] = a.value;
          else problems.push(`${at(m)}: ${a.name} is not an attribute of a track — a <section> takes hidden, muted and locked (and id, class, title, data-*, aria-*, which say nothing to the film).`);
        }
        track = { raw, open: m, lead: pending, clips: [] };
        pending = [];
        continue;
      }
      problems.push(m.type === 'open' && KIND_OF_TAG[m.name]
        ? `${at(m)}: ${named(m)} is outside any track — every clip is in a <section>, a track (the first section is on top).`
        : `${at(m)}: ${stray(m)}`);
      i = past(i);
      continue;
    }
    if (m.type === 'close' && m.name === 'section') {
      track.close = m;
      track.tail = pending;
      pending = [];
      tracks.push(track.raw);
      lines.push({ line: lineAt(text, track.open.start), clips: track.clips.map((c) => c.line) });
      layout.tracks.push({ open: track.open, close: m, lead: track.lead, tail: track.tail, clips: track.clips.map((c) => c.at) });
      track = null;
      continue;
    }
    if (m.type === 'open' && KIND_OF_TAG[m.name]) {
      const where = `${at(m)}: ${named(m)}`;
      let end = m.end;
      if (!VOID_TAGS.has(m.name) && !m.selfClosing) {
        /* <video>, <audio>, <iframe>: nothing inside, up to their end tag */
        let j = i + 1;
        while (j < marks.length && !(marks[j].type === 'close' && marks[j].name === m.name)) j++;
        if (j >= marks.length) { problems.push(`${where} has no </${m.name}>.`); break; }
        const inside = marks.slice(i + 1, j).find((n) => n.type !== 'comment' && !(n.type === 'text' && !n.text.trim()));
        if (inside) {
          problems.push(`${at(inside)}: ${named(m)} holds nothing: ${inside.name === 'source' ? 'its file is its own src' : inside.name === 'track' ? 'its words are a WebVTT beside its file (a.mp4 → a.vtt)' : 'a clip is its file'}.`);
        }
        end = marks[j].end;
        i = j;
      }
      const raw = clipOfTag(m, where, problems);
      if (raw) {
        track.raw.clips.push(raw);
        track.clips.push({ line: lineAt(text, m.start), at: { start: m.start, end, lead: pending, named: Boolean(raw.id) } });
      }
      pending = [];
      continue;
    }
    problems.push(`${at(m)}: ${m.type === 'open' && (m.name === 'script' || m.name === 'style') ? stray(m) : `<${m.type === 'close' ? '/' : ''}${m.name}> in a track — a track holds clips: <iframe> (a web page), <video>, <img> (a still) and <audio> (a sound).`}`);
    i = past(i);
  }
  if (track) problems.push(`${at(track.open)}: this <section> has no </section>.`);
  layout.tail = pending;
  const value = { stage: stage ?? { ...DEFAULT_STAGE }, tracks };
  if (problems.length) return { value: null, doc: null, problems, layout: null };
  const read = readFilm(value);
  /* the value's places (tracks[1].clips[0]) said as the file's lines */
  const said = read.problems.map((p) => p.replace(/\btracks\[(\d+)\](?:\.clips\[(\d+)\])?(?: "[^"]*")?/g, (all, t, c) => {
    const place = lines[Number(t)];
    if (!place) return all;
    return c === undefined ? `${FILM_FILE}:${place.line} <section>` : `${FILM_FILE}:${place.clips[Number(c)]}`;
  }));
  return { value: read.doc ? value : null, doc: read.doc, problems: said, layout: read.doc ? layout : null };
}

/**
 * The part of a film.html that is not its tracks (its head: the stage, the styles, the fonts), as text: a player
 * changes the film in place when only the tracks changed, and loads it again when this did.
 */
export function filmHead(text) {
  const { layout } = readFilmFile(text);
  return layout ? text.slice(0, layout.bodyStart) + text.slice(layout.bodyEnd) : text;
}

/** A clip's element: its attributes in one order, its picture's place first in its style. */
export function clipTag(clip) {
  const kind = kindOf(clip);
  const tag = TAG_OF_KIND[kind];
  const t = clip.time;
  const num = (n) => String(Number(n.toFixed(3)));
  const src = srcHref(clip.src) + (t ? (t.length === 2 ? `#t=${num(t[0])},${num(t[1])}` : `#t=${num(t[0])}`) : '');
  const parts = [];
  if (clip.id) parts.push(`id="${escapeAttr(clip.id)}"`);
  parts.push(`src="${escapeAttr(src)}"`);
  if (clip.at) parts.push(`at="${num(clip.at)}"`);
  if (clip.speed != null && clip.speed !== 1) parts.push(`speed="${clip.speed}"`);
  if (clip.volume === 0) parts.push('muted');
  else if (clip.volume != null && clip.volume !== 1) parts.push(`volume="${clip.volume}"`);
  if (clip.size) parts.push(`size="${clip.size.w}x${clip.size.h}"`);
  if (clip.class) parts.push(`class="${escapeAttr(clip.class)}"`);
  const b = clip.box;
  const px = (v) => Number(v.toFixed(3));
  const style = [
    /* left and top always: a box at 0, 0 is still a box (without one, a picture has its own place) */
    ...(b ? [`left: ${px(b.x)}px`, `top: ${px(b.y)}px`] : []),
    ...(b?.w != null ? [`width: ${px(b.w)}px`] : []),
    ...(b?.h != null ? [`height: ${px(b.h)}px`] : []),
    ...(b?.r ? [`rotate: ${px(b.r)}deg`] : []),
    ...(clip.style ? [clip.style] : []),
  ];
  if (style.length) parts.push(`style="${escapeAttr(style.join('; '))}"`);
  if (clip.overrides?.length) parts.push(`overrides='${JSON.stringify(clip.overrides).replace(/&/g, '&amp;').replace(/'/g, '&#39;')}'`);
  /* a value with double quotes in it (JSON, as Studio's data-props): in single quotes, as overrides are, so it reads as
     written */
  for (const [k, v] of Object.entries(clip.attrs ?? {})) {
    parts.push(v.includes('"') ? `${k}='${v.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}'` : `${k}="${escapeAttr(v)}"`);
  }
  return `<${tag} ${parts.join(' ')}>${tag === 'img' ? '' : `</${tag}>`}`;
}

const sectionTag = (track) => `<section${Object.entries(track.attrs ?? {}).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')}${TRACK_FLAGS.filter((f) => track[f]).map((f) => ` ${f}`).join('')}>`;
const viewportTag = (stage) => `<meta name="viewport" content="width=${stage.w}, height=${stage.h}">`;
/** Two values read alike: what a reader makes of them is the same. */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The film.html that says `value`, written over `before` (the file's text as it was): its head stays as it was but
 * for the stage, and in its body every track and clip that did not change keeps its own text and the comments before
 * it; what changed is written anew. The body is laid out one element a line, a track's clips indented.
 */
export function filmHtml(value, before = '') {
  const prev = before ? readFilmFile(before) : null;
  const old = prev?.doc && prev.layout ? { text: before, doc: prev.doc, layout: prev.layout } : null;
  const stage = value.stage ?? DEFAULT_STAGE;
  const piece = (m) => old.text.slice(m.start, m.end);
  const comments = (list, indent) => list.map((c) => `${indent}${piece(c)}\n`).join('');
  /* the old clips by id, with their text: an unchanged one is written as it was */
  const kept = new Map();
  if (old) {
    old.layout.tracks.forEach((t, ti) => t.clips.forEach((place, ci) => {
      const clip = old.doc.tracks[ti]?.clips[ci];
      /* one written without an id gets it written (a name, once given, stays put) */
      if (clip) kept.set(clip.id, { clip, place, named: place.named });
    }));
  }
  const checked = readFilm(structuredClone(value)).doc;
  let body = '\n';
  (value.tracks ?? []).forEach((track, ti) => {
    const was = old?.layout.tracks[ti];
    const wasTrack = old?.doc.tracks[ti];
    body += was ? comments(was.lead, '') : '';
    const sameTrack = wasTrack && TRACK_FLAGS.every((f) => Boolean(wasTrack[f]) === Boolean(track[f])) && same(wasTrack.attrs ?? {}, track.attrs ?? {});
    body += was && sameTrack ? piece(was.open) : sectionTag(track);
    body += '\n';
    (track.clips ?? []).forEach((clip, ci) => {
      const now = checked?.tracks[ti]?.clips[ci] ?? clip;
      const k = kept.get(now.id);
      if (k) body += comments(k.place.lead, '  ');
      body += `  ${k && k.named && same(k.clip, now) ? old.text.slice(k.place.start, k.place.end) : clipTag(now)}\n`;
    });
    if (was) body += comments(was.tail, '  ');
    body += '</section>\n';
  });
  if (old) body += comments(old.layout.tail, '');
  if (!old) {
    return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${viewportTag(stage)}\n</head>\n<body>${body}</body>\n</html>\n`;
  }
  let head = old.text.slice(0, old.layout.bodyStart);
  const sameStage = old.doc.stage.w === stage.w && old.doc.stage.h === stage.h;
  if (!sameStage) {
    const v = old.layout.viewport;
    if (v) head = head.slice(0, v.start) + viewportTag(stage) + head.slice(v.end);
    else {
      const open = /<head\b[^>]*>/i.exec(head) ?? /^\s*<!doctype[^>]*>/i.exec(head);
      const at = open ? open.index + open[0].length : 0;
      head = `${head.slice(0, at)}\n${viewportTag(stage)}${head.slice(at)}`;
    }
  }
  return head + body + old.text.slice(old.layout.bodyEnd);
}
