// @ts-check
/**
 * The person's edits in Studio, per project, kept over writes of others, so an agent's write never undoes them. The
 * agent writes with its own file tools, often whole, from a copy it read earlier: every edit the person made after
 * that read would be lost. So Studio keeps the versions of film.html (and of the files it writes for the person) it
 * has seen on disk, its own writes and others', and merges a write of someone else's three ways, as git does
 * (person-merge.mjs): from the version the writer's copy is inferred to be (the one closest to it), with what Studio
 * has now. What only the writer changed is the writer's; what only the person (or Studio) changed since stays; where
 * both changed a thing differently, the person's stands, and the agent is told, in its next `openfilm` command or the
 * chat's next message. The person is asked nothing.
 *
 * Which copy a writer had is inferred, never known. A write that changes exactly what the person changed since an
 * older version reads alike from either: it is taken for the older copy, so the person's values stand (and the agent
 * is told). Once the agent has been told of those (a note naming them, which its command or the chat said it passed
 * on), a write that changes them is taken as meant. With one agent about, from the version the note was passed on at
 * (and then from each write of its taken so). With two (each that asked for notes since the person's edit), a write
 * is not signed, so no write but one only the told agent knows is taken as its: the write Studio kept out, sent again
 * unchanged while the note's version is the one Studio has. A writer that has not asked Studio since the person's
 * edit cannot be told apart from the one agent that was told: an agent that never runs `openfilm`, or the desktop
 * agent mid-turn (it asks when its turn starts, and when it runs `openfilm`). Either way, what the note named that
 * Studio's film changed again since stays.
 *
 * Where versions were let go (past the caps) before the one a write is nearest, its copy may have been one of them:
 * what changed from before them on stays the person's.
 *
 * A merge that fails (in the worker or here) never loses the person's edits: Studio keeps the person's film, the
 * writer's is kept aside in the project's history (keepAside), and the agent is told.
 *
 * Nothing is written into the film for this: the record is Studio's, in memory, and starts afresh when Studio does.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { replaceFile, tempPath } from './atomic.mjs';
import { compare, hashOf, keepFilm, keptClips, keptHash, keptSize, keptValue, lineDistance, linesNew, mergeLines, mergeWrite } from './person-merge.mjs';

/** @typedef {import('./ops.mjs').FilmValue} FilmValue @typedef {import('./ops.mjs').Op} Op @typedef {import('./person-merge.mjs').KeptFilm} KeptFilm */
/**
 * A version of a file Studio has seen: its content's hash, and the content: film.html's kept as a film (`film`, sharing
 * what is alike with the version before), another file's compressed (`data`, null: no file). `person`: written by
 * Studio for the person. An `anchor` outlives the others (VERSIONS_KEPT of those), let go only past the project's
 * bytes: the first seen, the version before each run of the person's edits (the copy an agent had while the person
 * worked), and the versions an agent asked for notes at (about to read) and passed one on at. `changed`: what a person's version changed from
 * the one before (its units), so edits of one thing in a row are kept as one version (a drag, say).
 * `over`: a write Studio wrote a merge over (what it had there was kept out of the film). `gap`: versions right before
 * it were let go. The first version is never let go.
 * @typedef {{ hash: string, film?: KeptFilm, data?: Buffer | null, size: number, person: boolean, anchor: boolean, changed?: string, over?: boolean, gap?: boolean }} Version
 */
/**
 * One file's record: its versions (oldest first), what Studio has now (`ours`: the last it wrote or took in; `film`
 * for film.html), what it last saw there (`seen`: a write of that is Studio's own), and when the person last wrote it.
 * @typedef {{ versions: Version[], ours: Buffer | null, seen: Buffer | string | null, film?: KeptFilm | null, at?: number }} Kept
 */
/**
 * A note an agent passed on: which agent, the units it named (for a file, `file␀path`), the version of film.html Studio
 * had then (by hash), when (`at`), and since when the person's edits it named were there (the earliest).
 * @typedef {{ agent: string, keys: Set<string>, hash: string, at: number, since: number }} Ack
 */
/**
 * `film`: film.html's record; `files`: the other files Studio wrote for the person; `said`: what the agents are to be
 * told, by unit (`file␀path` for a file), and `told`, which agents were; `acks`: the notes passed on about film.html
 * (the newest last), and `acked` about each file; `asked`: when each agent last asked for notes; `edited`: when the
 * person last changed each unit of film.html; `added`: the clips the person added to it; `mine`: the units Studio has
 * as the person left them (a write that changed them since made them the writer's: `taken`, inside a clip or an
 * entry the person added, too); `renames`: the clips writes renamed, old id to new.
 * @typedef {{ film: Kept, files: Map<string, Kept>, said: Map<string, string>, told: Map<string, Set<string>>,
 *   acks: Ack[], acked: Map<string, Ack>, asked: Map<string, number>, edited: Map<string, number>, added: Set<string>, mine: Set<string>, taken: Set<string>, renames: string[][] }} State
 */

/** How many of a file's versions are kept, besides anchors (those go only past the bytes); how many bytes of a project's. */
let VERSIONS_KEPT = 200;
const BYTES_KEPT = 64 << 20;
/** A film of this many clips is merged in a worker, so Studio answers meanwhile; a merge there past this long has failed. */
const CLIPS_IN_WORKER = 1000;
let MERGE_MS = 60_000;
/** How many notes passed on are remembered, to tell a write made from what they named. */
const ACKS_KEPT = 50;
/** How long a note given out waits to be said passed on. */
const NOTE_MS = 10 * 60 * 1000;

/** @type {Map<string, State>} by project folder */
const projects = new Map();
/** What happened before what: the person's edits, agents asking for notes (a count, as two can fall in one ms). */
let clock = 0;
/** @type {Map<string, { root: string, agent: string, keys: string[], at: number }>} notes given out, by their id */
const notes = new Map();
/** where texts are kept aside before a merge is written (history.mjs keepAside) */
let keep = async (/** @type {string} */ _root, /** @type {Record<string, string | Buffer>} */ _files, /** @type {string} */ _message) => {};

/** the merge run here, and the worker's module (tests put others in) */
let merging = mergeWrite;
let workerModule = new URL('./person-merge-worker.mjs', import.meta.url);

/**
 * Where the texts a merge read and wrote are kept aside. For tests: how many versions of a file are kept besides
 * anchors (`versions`), the merge run here (`merge`), the worker's module (`worker`), how long a merge there may take.
 * @param {{ keep?: (root: string, files: Record<string, string | Buffer>, message: string) => Promise<unknown>, versions?: number,
 *   merge?: typeof mergeWrite, worker?: URL, mergeMs?: number }} o
 */
export function configure({ keep: aside, versions, merge, worker: module, mergeMs }) {
  if (aside) keep = async (root, files, message) => { await aside(root, files, message); };
  if (versions) VERSIONS_KEPT = versions;
  if (merge) merging = merge;
  if (module) { workerModule = module; void worker?.terminate(); }
  if (mergeMs) MERGE_MS = mergeMs;
}

/** The texts a merge read and wrote, kept aside before it is written; a merge goes on without them (no git, say). */
export async function keepAside(/** @type {string} */ root, /** @type {Record<string, string | Buffer>} */ files, /** @type {string} */ message) {
  try { await keep(root, files, message); }
  catch (e) { console.error(`Studio: the texts of a merge could not be kept aside: ${/** @type {Error} */ (e).message}`); }
}

const record = () => /** @type {Kept} */ ({ versions: [], ours: null, seen: null, film: null });
const state = (/** @type {string} */ root) => {
  let s = projects.get(root);
  if (!s) projects.set(root, (s = { film: record(), files: new Map(), said: new Map(), told: new Map(), acks: [], acked: new Map(), asked: new Map(), edited: new Map(), added: new Set(), mine: new Set(), taken: new Set(), renames: [] }));
  return s;
};

/* ── versions ─────────────────────────────────────────────────────────────── */

/**
 * `content` added to `kept`'s versions as the newest, once (one seen before moves up, an anchor still): film.html's as
 * a kept film (`film`), another file's as bytes (null: no file). `person`: Studio wrote it for the person, `changed` the
 * units it changed; such a version right after one of the person's that changed the same takes its place, and the
 * version before a run of the person's is an anchor. Past the caps the oldest go first, never the first nor the last
 * two; anchors only past the project's bytes, when nothing else is left.
 * @param {State} s @param {Kept} kept @param {{ film?: KeptFilm, data?: Buffer | null, person?: boolean, changed?: string, anchor?: boolean }} content
 */
function addVersion(s, kept, { film, data = null, person = false, changed, anchor = false }) {
  const hash = film ? keptHash(film) : data == null ? '-' : hashOf(data);
  const had = kept.versions.findIndex((v) => v.hash === hash);
  if (had >= 0) {
    const [v] = kept.versions.splice(had, 1);
    kept.versions.push(Object.assign(v, { anchor: v.anchor || anchor, person: v.person && person }));
    return;
  }
  const last = kept.versions.at(-1);
  if (person && changed && last?.person && !last.anchor && last.changed === changed) kept.versions.pop();
  else if (person && last && !last.person) last.anchor = true;
  const before = kept.versions.at(-1)?.film;
  const size = film ? keptSize(film, (t) => !before?.tracks.includes(t)) : data == null ? 0 : deflateRawSync(data).length;
  kept.versions.push({ hash, ...(film ? { film } : { data: data == null ? null : deflateRawSync(data) }), size, person, anchor: anchor || !kept.versions.length, ...(changed ? { changed } : {}) });
  /* the oldest version that may go, but never the first nor the last two; its bytes, or -1 when none may. The one
     after it knows a version before it was let go */
  const drop = (/** @type {Kept} */ k, /** @type {boolean | null} */ anchors) => {
    const i = k.versions.findIndex((v, n) => n > 0 && n < k.versions.length - 2 && (anchors == null || v.anchor === anchors));
    if (i < 0) return -1;
    k.versions[i + 1].gap = true;
    return k.versions.splice(i, 1)[0].size;
  };
  while (kept.versions.filter((v) => !v.anchor).length > VERSIONS_KEPT) if (drop(kept, false) < 0) break;
  /* the project's bytes: the versions of the file with the most go first, anchors last */
  const all = () => [s.film, ...s.files.values()];
  let total = all().reduce((n, k) => n + k.versions.reduce((m, v) => m + v.size, 0), 0);
  for (const anchors of [false, null]) {
    while (total > BYTES_KEPT) {
      const most = all().filter((k) => k.versions.some((v, n) => n < k.versions.length - 2 && (anchors == null || v.anchor === anchors)))
        .reduce((a, b) => (!a || b.versions.length > a.versions.length ? b : a), /** @type {Kept | null} */ (null));
      if (!most) break;
      total -= drop(most, anchors);
    }
  }
}
const contentOf = (/** @type {Version} */ v) => (v.data == null ? null : inflateRawSync(v.data));

/* ── film.html ────────────────────────────────────────────────────────────── */

/**
 * Studio wrote film.html for the person: `before` and `after` the film's values, `rev` the text written. (An undo is a
 * write like any other here.) What it changed is the person's again: told of before or not, it is kept anew.
 * @param {string} root @param {FilmValue | null} before @param {FilmValue} after @param {string} rev @param {{ ops?: Op[], undo?: boolean }} [_edit]
 */
export function filmWritten(root, before, after, rev, _edit = {}) {
  const s = state(root);
  const kept = s.film;
  let was = kept.film ?? null;
  if (before) {
    const had = keepFilm(before, was);
    /* not what Studio last had (a write of someone else's it did not merge): that is a version too */
    if (!was || had.stage !== was.stage || had.tracks.length !== was.tracks.length || had.tracks.some((t, i) => t !== was?.tracks[i])) addVersion(s, kept, { film: had });
    was = had;
  }
  const now = keepFilm(after, was);
  /** @type {string[]} */
  let changed = [];
  if (was) {
    const c = compare(now, was);
    changed = [...c.apart, ...c.moved.map((id) => `track\0${id}`), ...(c.distance > c.apart.length + c.moved.length ? ['order'] : [])].sort();
    const at = ++clock;
    for (const key of changed) {
      s.edited.delete(key); s.edited.set(key, at); s.said.delete(key); s.mine.add(key); s.taken.delete(key);
      /* a clip or an entry the person added or removed: all of it is the person's again */
      const holder = key.split('\0').slice(1);
      if (/^(clip|entry)\0/.test(key)) for (const k of s.taken) if (holder.every((x, i) => k.split('\0')[i + 1] === x)) s.taken.delete(k);
    }
    /* the clips the person added (and has not removed since) */
    const ids = new Set(now.tracks.flatMap((t) => t.ids));
    for (const key of changed) if (key.startsWith('clip\0')) { if (ids.has(key.slice(5))) s.added.add(key.slice(5)); else s.added.delete(key.slice(5)); }
    while (s.edited.size > 100_000) s.edited.delete(/** @type {string} */ (s.edited.keys().next().value));
  }
  addVersion(s, kept, { film: now, person: true, changed: changed.join('\n') });
  kept.film = now;
  kept.seen = rev;
}

/** The project put back as a version had it, or its changes discarded: the person's as it is, nothing to merge into. */
export function filmReplaced(/** @type {string} */ root) {
  const s = projects.get(root);
  if (!s) return;
  s.film.film = null;
  s.mine.clear();
  s.taken.clear();
  s.renames = [];
  s.files.clear();
  s.acks = [];
  s.acked.clear();
  s.said.clear();
}

/** Whether film.html at `rev` is a write of someone else's with edits to merge (one worth waiting on to settle). */
export const filmToMerge = (/** @type {string} */ root, /** @type {string} */ rev) => {
  const s = projects.get(root);
  return Boolean(s && rev !== s.film.seen && s.film.film);
};

/**
 * film.html as the folder has it, `rev` and `value`, merged with what Studio has when someone else wrote it since Studio
 * last did (person-merge.mjs mergeWrite; a long film's in a worker, so Studio answers meanwhile). Null when there is
 * nothing to write (Studio then has the write as it is). Otherwise the film to write and the units where the person's
 * stand over the write (`kept`), to be passed to `filmMerged` once written. A merge that fails (in the worker, it is
 * done again here; a worker past MERGE_MS is not) is the person's film over the whole write, which the agent is told:
 * the write is taken as seen only once merged, so it is never taken as it is for want of a merge.
 * @param {string} root @param {{ rev: string, value: FilmValue }} current
 */
export async function mergeFilmWrite(root, { rev, value }) {
  const s = state(root);
  const kept = s.film;
  if (rev === kept.seen) return null;
  const ours = kept.film;
  if (!ours || !kept.versions.length) {
    kept.seen = rev;
    kept.film = keepFilm(value, ours);
    addVersion(s, kept, { film: kept.film });
    return null;
  }
  const versions = kept.versions.map((v) => /** @type {KeptFilm} */ (v.film));
  const index = new Map(kept.versions.map((v, i) => [v.hash, i]));
  /* the notes passed on: those of the one agent about, and any at the version Studio has */
  const now = keptHash(ours);
  const sure = new Set(trusted(s, s.acks));
  const notesOn = s.acks.filter((a) => index.has(a.hash) && (sure.has(a) || a.hash === now));
  const acks = notesOn.map((a) => ({ index: /** @type {number} */ (index.get(a.hash)), keys: [...a.keys], latest: !sure.has(a) }));
  const notes = [...s.said.keys()].filter((k) => !k.startsWith('file\0'));
  /* (the clips the person added, there now) */
  const ourIds = new Set(ours.tracks.flatMap((t) => t.ids));
  const input = { ours: keptValue(ours), write: value, versions, over: kept.versions.map((v) => Boolean(v.over)), gaps: kept.versions.map((v) => Boolean(v.gap)), added: [...s.added].filter((id) => ourIds.has(id)), acks, notes, mine: [...s.mine], taken: [...s.taken], renames: s.renames };
  /** @type {ReturnType<typeof mergeWrite>} */
  let merge;
  try {
    merge = keptClips(ours) >= CLIPS_IN_WORKER ? await inWorker(root, input).catch((e) => (e.late ? Promise.reject(e) : merging(input))) : merging(input);
    last.set(root, { base: kept.versions[merge.base].hash, note: notesOn[merge.note]?.agent ?? null, latest: Boolean(acks[merge.note]?.latest), far: kept.versions.slice(0, merge.base + 1).some((v) => v.gap) });
  } catch (e) {
    console.error(`Studio: a write of film.html could not be merged, so the person's film stands over it (it is kept aside): ${/** @type {Error} */ (e).message}`);
    merge = { value: input.ours, kept: ['film'], base: -1, note: -1, renamed: [], agreed: [] };
    last.set(root, { base: '', note: null, latest: false, far: false });
  }
  kept.seen = rev;
  const theirs = keepFilm(value, ours);
  addVersion(s, kept, { film: theirs });
  /* clips the write renamed: what the person did to them is under their new ids */
  const ids = new Map(merge.renamed);
  for (const [from, to] of ids) if (!s.renames.some(([a, b]) => a === from && b === to)) s.renames.push([from, to]);
  if (ids.size) {
    const move = (/** @type {string} */ k) => { const p = k.split('\0'); if (ids.has(p[1])) p[1] = /** @type {string} */ (ids.get(p[1])); return p.join('\0'); };
    for (const set of [s.mine, s.taken]) { const all = [...set].map(move); set.clear(); for (const k of all) set.add(k); }
    s.added = new Set([...s.added].map((id) => ids.get(id) ?? id));
    s.edited = new Map([...s.edited].map(([k, v]) => [move(k), v]));
  }
  /* what the film takes from the write is the writer's now, not the person's */
  const taken = compare(keepFilm(merge.value, ours), keepFilm(renamedIds(keptValue(ours), ids)));
  for (const key of [...taken.apart, ...taken.moved.map((id) => `track\0${id}`), ...(taken.distance > taken.apart.length + taken.moved.length ? ['order'] : [])]) {
    s.mine.delete(key);
    s.taken.add(key);
    /* a clip or an entry: all it holds */
    const holder = key.split('\0').slice(1);
    if (/^(clip|entry)\0/.test(key)) for (const k of s.mine) if (holder.every((x, i) => k.split('\0')[i + 1] === x)) s.mine.delete(k);
  }
  /* taken as made after the one agent's note: it knows the film it wrote, so its note moves on to it (another agent's
     note, taken while it is about, does not: the write may be anyone's) */
  const by = notesOn[merge.note];
  if (by && sure.has(by)) {
    Object.assign(by, { hash: keptHash(theirs), at: ++clock });
    const v = kept.versions.find((x) => x.hash === by.hash);
    if (v) v.anchor = true;
  }
  /* a note is done with where the writer has what Studio keeps */
  for (const key of merge.agreed) s.said.delete(key);
  if (!merge.kept.length && compare(keepFilm(merge.value, theirs), theirs).distance === 0) {
    kept.film = theirs;
    return null;
  }
  const written = kept.versions.find((v) => v.film === theirs || v.hash === keptHash(theirs));
  if (written) written.over = true;
  return { value: merge.value, kept: merge.kept.map((key) => ({ key, words: words(key) })) };
}

/** `film` with its clips' ids changed as `ids` says. */
const renamedIds = (/** @type {FilmValue} */ film, /** @type {Map<string, string>} */ ids) => (ids.size ? { ...film, tracks: film.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (ids.has(c.id) ? { ...c, id: /** @type {string} */ (ids.get(c.id)) } : c)) })) } : film);

/**
 * The notes passed on that a write may be taken as made after: each one's, while no agent but the one that passed it on
 * has asked for notes since the person's edits it named (one that has not asked cannot be told apart).
 * @param {State} s @param {Ack[]} acks
 */
function trusted(s, acks) {
  return acks.filter((a) => [...s.asked].every(([agent, at]) => agent === a.agent || at < a.since));
}

/** @type {Worker | null} */
let worker = null;
let calls = 0;
/** @type {Map<number, { done: (v: any) => void, fail: (e: Error & { late?: boolean }) => void }>} */
const waiting = new Map();
/**
 * The tracks of each project's versions the worker has (it keeps them, so a merge sends only what is new), by an id
 * each track is given here once.
 * @type {Map<string, Set<number>>}
 */
const sent = new Map();
/** @type {WeakMap<import('./person-merge.mjs').KeptTrack, number>} */
const trackIds = new WeakMap();
let tracks = 0;

/**
 * mergeWrite in a worker of its own (one for all projects, started when first needed, let go when idle). The worker
 * keeps each project's tracks: a merge sends the versions as lists of track ids, and only the tracks it lacks. Fails
 * when the worker throws, dies, or takes past MERGE_MS (`late`: then it is stopped).
 * @param {string} root @param {Parameters<typeof mergeWrite>[0]} input @returns {Promise<ReturnType<typeof mergeWrite>>}
 */
function inWorker(root, input) {
  if (!worker) {
    const w = new Worker(workerModule);
    const failAll = (/** @type {Error} */ e) => { for (const call of waiting.values()) call.fail(e); waiting.clear(); };
    w.on('message', ({ id, out, error }) => {
      const call = waiting.get(id);
      waiting.delete(id);
      if (!waiting.size) w.unref();
      if (error) call?.fail(new Error(error));
      else call?.done(out);
    });
    w.on('error', (e) => { if (worker === w) { worker = null; sent.clear(); } failAll(e); });
    w.on('exit', (code) => { if (worker === w) { worker = null; sent.clear(); } failAll(new Error(`the merge's worker stopped (${code})`)); });
    worker = w;
  }
  const w = worker;
  const id = ++calls;
  w.ref();
  /* the versions as track ids; the tracks the worker lacks */
  const had = sent.get(root) ?? new Set();
  /** @type {Map<number, import('./person-merge.mjs').KeptTrack>} */
  const fresh = new Map();
  const versions = input.versions.map((v) => ({ stage: v.stage, tracks: v.tracks.map((t) => {
    let n = trackIds.get(t);
    if (n === undefined) trackIds.set(t, (n = ++tracks));
    if (!had.has(n)) fresh.set(n, t);
    return n;
  }) }));
  sent.set(root, new Set(versions.flatMap((v) => v.tracks)));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      fail(Object.assign(new Error(`the merge took longer than ${MERGE_MS} ms`), { late: true }));
      void w.terminate();
    }, MERGE_MS);
    waiting.set(id, {
      done: (v) => { clearTimeout(timer); done(v); },
      fail: (e) => { clearTimeout(timer); sent.delete(root); fail(e); },
    });
    w.postMessage({ id, root, input: { ...input, versions: [] }, versions, tracks: [...fresh] });
  });
}

/** The merge was written as `rev`: Studio has it, and the agents are to be told what was kept. */
export function filmMerged(/** @type {string} */ root, /** @type {FilmValue} */ value, /** @type {string} */ rev, /** @type {{ key: string, words: string }[]} */ kept) {
  const s = state(root);
  s.film.film = keepFilm(value, s.film.versions.at(-1)?.film ?? s.film.film);
  addVersion(s, s.film, { film: s.film.film });
  s.film.seen = rev;
  for (const { key, words: said } of kept) { s.said.set(key, said); s.told.delete(key); }
}

/* ── other files ──────────────────────────────────────────────────────────── */

const bytes = (/** @type {string | Buffer | Uint8Array | null | undefined} */ v) => (v == null ? null : typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v));
const same = (/** @type {Buffer | null} */ a, /** @type {Buffer | null} */ b) => (a == null || b == null ? a === b : a.equals(b));
/** Bytes as one character each: lines split at line feeds, whatever the encoding, and back to the same bytes. */
const latin = (/** @type {Buffer | null} */ b) => (b == null ? '' : b.toString('latin1'));

/**
 * Studio wrote text files of the project for the person (a subtitle edit, a page's links after a move, a layer pasted
 * into a page): each one's content before and after, by its folder-relative path (null: no file), as text (UTF-8) or as
 * the bytes written. (An undo is a write like any other here.)
 * @param {string} root @param {Record<string, string | Buffer | null>} before @param {Record<string, string | Buffer | null>} after
 * @param {{ undo?: boolean }} [_o]
 */
export function filesWritten(root, before, after, _o = {}) {
  const s = state(root);
  for (const [path, raw] of Object.entries(after)) {
    const ours = bytes(raw);
    let kept = s.files.get(path);
    if (!kept) s.files.set(path, (kept = record()));
    if (!kept.versions.length || !same(bytes(before[path]), kept.ours)) addVersion(s, kept, { data: bytes(before[path]) });
    addVersion(s, kept, { data: ours, person: true, changed: 'file' });
    Object.assign(kept, { ours, seen: ours, at: ++clock });
    s.acked.delete(`file\0${path}`);
    s.said.delete(`file\0${path}`);
  }
}

/**
 * A text file the person edited through Studio, as the folder has it now (`theirs`, its bytes, null: gone), merged with
 * what Studio has when someone else wrote it: three ways by lines, from the version nearest to the write. Undefined
 * when there is nothing to write; else the bytes (null: the file goes). A page the writer deleted is deleted, unless the
 * person changed it since the version the writer had (then it comes back, and the agent is told); a page the person
 * made comes back. Files are merged as bytes, so a page in any encoding stays in it.
 * @param {string} root @param {string} path @param {Buffer | null} theirs @returns {Buffer | null | undefined}
 */
export function mergeFileWrite(root, path, theirs) {
  const s = projects.get(root);
  const kept = s?.files.get(path);
  /* Studio's own write, or one of the same bytes */
  if (!s || !kept || same(theirs, /** @type {Buffer | null} */ (kept.seen))) return undefined;
  last.delete(`${root}\0${path}`);
  const take = () => { addVersion(s, /** @type {Kept} */ (kept), { data: theirs }); Object.assign(/** @type {Kept} */ (kept), { ours: theirs, seen: theirs }); s.said.delete(`file\0${path}`); return undefined; };
  const ack = s.acked.get(`file\0${path}`);
  const told = Boolean(ack && trusted(s, [ack]).length);
  if (same(theirs, kept.ours) || (told && theirs == null)) return take();
  /** @type {Buffer | null} the person's page, unless a merge is good */
  let out = kept.ours;
  try {
    /* the versions the writer's copy is nearest to (a deleted file: the one where it was not there, else the oldest):
       merged from the oldest, or the next whose merge is good (below), or none (ties go to the person). Told of the
       page, a write as near to it as it was then as to those is taken as made from it: with one agent about; with
       two, only the write Studio kept out, sent again unchanged while the note's page is the one Studio has (only the
       told agent knows it) */
    const versions = kept.versions.map(contentOf);
    const apart = (/** @type {Buffer | null} */ v) => linesNew(latin(v), latin(theirs));
    const far = versions.map(apart);
    const least = Math.min(...far);
    const tied = theirs == null ? [Math.max(0, versions.findIndex((v) => v == null))] : far.flatMap((d, i) => (d === least ? [i] : []));
    const at = ack ? kept.versions.findIndex((v) => v.hash === ack.hash) : -1;
    const resend = kept.versions.some((v) => v.over && same(contentOf(v), theirs));
    const sure = at >= 0 && (told || (ack?.hash === (kept.ours == null ? '-' : hashOf(kept.ours)) && resend));
    /* (as near counted in all lines here: the note's page against each other, removals too) */
    const whole = versions.map((v) => lineDistance(latin(v), latin(theirs)));
    const byNote = sure && whole[at] <= Math.min(...whole.filter((_, i) => !resend || !kept.versions[i].over));
    /** @param {Buffer | null} base @returns {Buffer | null} */
    const from = (base) => {
      if (theirs == null || kept.ours == null) return same(kept.ours, base) ? theirs : kept.ours;
      const merged = mergeLines(latin(base), latin(kept.ours), latin(theirs), 'ours');
      return merged == null ? kept.ours : Buffer.from(merged, 'latin1');
    };
    /* a merge from one of those as near is good when, from each of them, it keeps what Studio added and leaves out
       what Studio removed, and has no line more often than both sides' changes from its base make it (a line both
       added, as `</div>`: as many as the two added and the base had); none good: the person's page stands */
    const count = (/** @type {Buffer | null} */ v) => { const m = new Map(); for (const l of latin(v).split(/(?<=\n)/)) m.set(l, (m.get(l) ?? 0) + 1); return m; };
    const o = count(kept.ours), w = count(theirs), bases = tied.map((i) => count(versions[i]));
    const good = (/** @type {Buffer | null} */ v, /** @type {number} */ from, all = true) => {
      const got = count(v), b = count(versions[from]);
      for (const [l, k] of got) {
        if (k > Math.max(0, (o.get(l) ?? 0) + (w.get(l) ?? 0) - (b.get(l) ?? 0))) return false;
        if (all && !o.has(l) && bases.some((b) => b.has(l))) return false;
      }
      if (all) for (const l of o.keys()) if (!got.has(l) && bases.some((b) => !b.has(l))) return false;
      return true;
    };
    /* the note's page first (its merge with no line twice), then the oldest as near, then the next good one */
    const tries = [...(byNote ? [{ i: at, all: false }] : []), { i: tied[0], all: tied.length > 1 }, ...tied.slice(1).map((i) => ({ i, all: true }))];
    let pick = -1;
    for (const t of tries) {
      const v = from(versions[t.i]);
      if (good(v, t.i, t.all)) { pick = t.i; out = v; break; }
    }
    if (pick < 0) pick = tied[0];
    last.set(`${root}\0${path}`, { base: kept.versions[pick].hash, note: byNote && pick === at ? /** @type {Ack} */ (ack).agent : null, latest: byNote && pick === at && !told });
  } catch (e) {
    /* the person's page stands; the writer's is kept aside (settleFiles), and the agent told */
    console.error(`Studio: a write of ${path} could not be merged, so the person's stands over it: ${/** @type {Error} */ (e).message}`);
    out = kept.ours;
  }
  addVersion(s, kept, { data: theirs });
  if (same(out, theirs)) return take();
  const written = kept.versions.find((v) => v.hash === (theirs == null ? '-' : hashOf(theirs)));
  if (written) written.over = true;
  addVersion(s, kept, { data: out });
  Object.assign(kept, { ours: out, seen: out });
  s.said.set(`file\0${path}`, path);
  s.told.delete(`file\0${path}`);
  return out;
}

/**
 * Write `data` over `path` (null: take the file away) only while it still holds `expect` (null: no file; '' an empty
 * one or none), as one rename right after the check, so a write that lands meanwhile is never written over. Whether
 * it was written.
 * @param {string} path @param {string | Buffer | null} expect @param {string | Buffer | null} data
 */
export async function replaceIfStill(path, expect, data) {
  const tmp = data == null ? null : tempPath(path);
  try {
    if (tmp) await writeFile(tmp, /** @type {string | Buffer} */ (data));
    const now = await readFile(path).catch((e) => (e?.code === 'ENOENT' ? null : Promise.reject(e)));
    const want = bytes(expect);
    if (!(same(now, want) || (want?.length === 0 && now == null))) return false;
    if (tmp) await replaceFile(tmp, path);
    else await rm(path, { force: true });
    return true;
  } finally {
    if (tmp) await rm(tmp, { force: true });
  }
}

/** @type {Map<string, Promise<unknown>>} each project's merges of text files, one at a time */
const fileQueues = new Map();

/**
 * The text files the person edited through Studio, as the folder has them, merged with what Studio has where someone
 * else wrote them since: `paths`, the folder-relative files that changed (all those kept, when not known).
 * @param {string} root @param {string[] | null} [paths]
 */
export function settleFiles(root, paths = null) {
  const s = projects.get(root);
  if (!s?.files.size) return Promise.resolve();
  const next = (fileQueues.get(root) ?? Promise.resolve()).then(async () => {
    for (const path of paths ?? [...s.files.keys()]) {
      for (let tries = 0; tries < 10 && s.files.has(path); tries++) {
        const abs = join(root, path);
        const theirs = await readFile(abs).catch((e) => (e?.code === 'ENOENT' ? null : undefined));
        if (theirs === undefined) break;
        const out = mergeFileWrite(root, path, theirs);
        if (out === undefined) break;
        const name = basename(path);
        await keepAside(root, { [`agent.${name}`]: theirs ?? '', [`merged.${name}`]: out ?? '' }, `Kept the person's edits over a write of ${path}`);
        /* written again meanwhile: that write is the one to merge */
        if (await replaceIfStill(abs, theirs, out)) break;
      }
    }
  }).catch((e) => { console.error(`Studio: the person's edits could not be merged: ${e.message}`); });
  fileQueues.set(root, next);
  return next;
}

/* ── what the agent is told ───────────────────────────────────────────────── */

/**
 * The note for the agent named `agent` (studio/client.mjs agentName) about the project: what the person changed that a
 * write would have undone, kept, and it has not been given yet, in one line, with the note's `id`. Null when nothing.
 * It counts only once `noteSaid(id)` says it was passed on (printed by its command, in a turn the chat sent). At once.
 * @param {string} root @param {string} agent @returns {{ id: string, line: string } | null}
 */
export function noteFor(root, agent) {
  const s = projects.get(root);
  if (!s) return null;
  const now = Date.now();
  s.asked.set(agent, ++clock);
  /* the agent is about to read the project: the version it reads is kept while any is */
  if (s.film.film) {
    const hash = keptHash(s.film.film);
    const v = s.film.versions.find((x) => x.hash === hash);
    if (v) v.anchor = true;
  }
  for (const [id, note] of notes) if (now - note.at > NOTE_MS) notes.delete(id);
  const due = [...s.said].filter(([key]) => !s.told.get(key)?.has(agent));
  if (!due.length) return null;
  const id = randomUUID();
  notes.set(id, { root, agent, keys: due.map(([key]) => key), at: now });
  const said = [...new Set(due.map(([, words]) => words))];
  return { id, line: `The person changed these in Studio while you worked, and they stand over what you wrote: ${said.join('; ')}. Read the files again before you change them: a change you make then is yours, unless the person changes the same thing after this note. While another agent works here too, what the person changed stands over a change of yours unless you send the very write that was kept out again, unchanged.` };
}

/** The note `id` was passed on to its agent: what it names is known to the agent. Whether there was such a note. */
export function noteSaid(/** @type {string} */ id) {
  const note = notes.get(id);
  if (!note) return false;
  notes.delete(id);
  const s = projects.get(note.root);
  if (!s) return true;
  /** @type {Set<string>} */
  const named = new Set();
  for (const key of note.keys) {
    if (!s.said.has(key)) continue;
    const told = s.told.get(key) ?? new Set();
    told.add(note.agent);
    s.told.set(key, told);
    if (key.startsWith('file\0')) {
      const file = s.files.get(key.slice(5));
      const hash = file?.ours == null ? '-' : hashOf(file.ours);
      const v = file?.versions.find((x) => x.hash === hash);
      if (v) v.anchor = true;
      s.acked.set(key, { agent: note.agent, keys: new Set([key]), hash, at: ++clock, since: file?.at ?? clock });
    } else named.add(key);
  }
  const at = s.film.versions.at(-1);
  if (named.size && s.film.film && at) {
    /* the version Studio has, kept while the note is */
    const hash = keptHash(s.film.film);
    const v = s.film.versions.find((x) => x.hash === hash) ?? at;
    v.anchor = true;
    const since = Math.min(...[...named].map((k) => s.edited.get(k) ?? clock));
    s.acks.push({ agent: note.agent, keys: named, hash: v.hash, at: ++clock, since });
    if (s.acks.length > ACKS_KEPT) s.acks.shift();
  }
  return true;
}

/** What a unit is, in a few words: `clip title at`, `clip title box.x`, `clip intro`. */
function words(/** @type {string} */ key) {
  const [kind, id, name, more] = key.split('\0');
  const at = (/** @type {string} */ n) => (n ? `overrides at ${JSON.parse(n)[0]}` : 'fade');
  switch (kind) {
    case 'clip': return `clip ${id}`;
    case 'field': return `clip ${id} ${name}`;
    case 'box': case 'attrs': return `clip ${id} ${kind}.${name}`;
    case 'entry': return `clip ${id} ${at(name)}`;
    case 'prop': return `clip ${id} ${at(name)} ${more}`;
    case 'style': return `clip ${id} ${at(name)} style.${more}`;
    case 'track': return `clip ${id} track`;
    case 'flag': return `a track ${name === 'hidden' ? 'shown or hidden' : name === 'muted' ? 'muted or not' : 'locked or not'}`;
    case 'order': return 'the tracks\' order';
    case 'film': return 'film.html as a whole (your write could not be merged; it is kept aside in the project\'s history)';
    default: return 'the stage size';
  }
}

/**
 * Each project's last merge of film.html (by its folder) or of a file (`folder␀path`): its base, and whose note made it
 * so, the one agent's about or (`latest`) one at the version Studio had, and whether versions before the base were
 * let go (`far`) (tests).
 * @type {Map<string, { base: string, note: string | null, latest: boolean, far?: boolean }>}
 */
const last = new Map();
export const lastMerge = (/** @type {string} */ root, path = '') => last.get(path ? `${root}\0${path}` : root) ?? null;

/** The film Studio has now, as far as the record knows (tests). */
export const personFilm = (/** @type {string} */ root) => { const f = projects.get(root)?.film.film; return f ? keptValue(f) : null; };
/** How many versions are kept of film.html, how many are anchors, their bytes, and their hashes (tests). */
export const keptVersions = (/** @type {string} */ root) => {
  const v = projects.get(root)?.film.versions ?? [];
  return { count: v.length, anchors: v.filter((x) => x.anchor).length, bytes: v.reduce((n, x) => n + x.size, 0), hashes: v.map((x) => x.hash) };
};
/** A film's hash as its versions are kept (tests). */
export const versionHash = (/** @type {FilmValue} */ film) => keptHash(keepFilm(film));

/** Forget a project (tests). */
export function forget(/** @type {string} */ root) { projects.delete(root); sent.delete(root); }
