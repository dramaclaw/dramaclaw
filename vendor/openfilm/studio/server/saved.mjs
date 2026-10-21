// @ts-check
/**
 * Saved: the person's own library, one for every project, kept as a folder (src/locations.mjs savedRoot,
 * ~/Movies/OpenFilm/Saved). Anything can go in it, in folders of the person's: files of any kind, uploaded or added from
 * a project, and what Studio saves from a film, each as a folder of its own holding what it needs (a bundle):
 *
 *   <bundle>/saved.json   { version, savedAt, kind: 'clip' | 'group' | 'page', clip | clips | path, durationMs?, w?,
 *                           h? }   a clip as the film has it (its place, its look, the changes made in its page, the
 *                           properties it offers; no time, no id), clips saved together (each one's track from the top
 *                           one they had and `at` seconds from the first), or a page of a project with what it loads
 *   <bundle>/files/…      the clip's file and what it loads (closure.mjs), at the places they had in its project, so a
 *                         page's own references still find what they name
 *   <bundle>/poster.jpg   its picture, when one could be drawn
 *
 * A bundle is named as the person reads it (its folder's name), and moved, renamed and taken away as any folder is.
 * The API names what is in the library from `saved/` (LIBRARY), as a project's media is named from `assets/`, so the
 * media pane shows both the same way. Used in a project, a thing is a copy: a file is imported into its assets/ as one
 * from the computer is (the same bytes there already are that file), a bundle's files go to `saved/<its place>/` there
 * once (taken again, what is there is used). Changing one never changes the other. A page clip saved with
 * properties (its `data-props`, lib/component-props) is a component: every clip taken from it offers them.
 */
import { existsSync, createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { FILM_FILE, clipKind, filmHtml } from '../../src/film-doc.mjs';
import { savedRoot } from '../../src/locations.mjs';
import { STUDIO_STATE, filmClosure, folderView } from './closure.mjs';
import { readProjectFilm } from './film.mjs';
import { cleanName, importFile, inside, kindOf } from './files.mjs';

export class SavedError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const VERSION = 2;
/** What the API calls the library's top folder: its paths are `saved/<place in the library>`. */
export const LIBRARY = 'saved';
/** The file that makes a folder of the library a bundle. */
const BUNDLE = 'saved.json';

/** The library's folder, made when it is not there yet. */
export async function libraryRoot() {
  const root = savedRoot();
  await mkdir(root, { recursive: true });
  return root;
}

/** A library path (`saved/<rel>`, `saved` for the top) as its place in the library ('' for the top). */
export function libraryRel(/** @type {unknown} */ path) {
  if (path === LIBRARY || path === '') return '';
  if (typeof path !== 'string' || !path.startsWith(`${LIBRARY}/`)) throw new SavedError('a place in Saved, please', 400);
  return path.slice(LIBRARY.length + 1);
}

/** A place in the library as the API names it. */
export const libraryPath = (/** @type {string} */ rel) => (rel ? `${LIBRARY}/${rel}` : LIBRARY);

/**
 * The library as the media pane lists a project's media (files.mjs listFiles): its files and folders, any depth, by
 * their `saved/` paths. A bundle is one entry, of the kind of its (top) file, with what it is in `saved`.
 */
export async function listLibrary() {
  const root = await libraryRoot();
  /** @type {{ path: string, kind: string, size: number, mtime: number, added: number, saved?: object }[]} */
  const files = [];
  /** @type {string[]} */
  const folders = [];
  async function walk(/** @type {string} */ rel, /** @type {number} */ depth) {
    const entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const bundle = await readBundle(join(root, at));
        if (bundle) { files.push(bundleEntry(at, bundle)); continue; }
        folders.push(libraryPath(at));
        if (depth < 8) await walk(at, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(join(root, at)).catch(() => null);
      if (info) files.push({ path: libraryPath(at), kind: kindOf(entry.name), size: info.size, mtime: Math.round(info.mtimeMs), added: Math.round(info.birthtimeMs || info.mtimeMs) });
    }
  }
  await walk('', 0);
  const sort = (/** @type {{ path: string }} */ a, /** @type {{ path: string }} */ b) => a.path.localeCompare(b.path, undefined, { numeric: true });
  folders.sort();
  return { files: files.sort(sort), folders, made: folders, pages: [], links: {} };
}

/** A bundle's saved.json, or null when the folder is no bundle. @param {string} dir */
async function readBundle(dir) {
  const raw = await readFile(join(dir, BUNDLE), 'utf8').catch(() => null);
  if (!raw) return null;
  let item;
  try { item = JSON.parse(raw); } catch { return null; }
  if (!item || typeof item !== 'object') return null;
  /* a page of a project was 'file' before */
  if (item.kind === 'file') item.kind = 'page';
  if (item.kind === 'clip' && typeof item.clip?.src === 'string') return item;
  if (item.kind === 'group' && Array.isArray(item.clips) && item.clips.length && item.clips.every((/** @type {any} */ c) => typeof c?.clip?.src === 'string')) return item;
  if (item.kind === 'page' && typeof item.path === 'string') return item;
  return null;
}

/** Its main file: the clip's, a group's top one, the page. */
const mainOf = (/** @type {any} */ item) => (item.kind === 'clip' ? item.clip.src : item.kind === 'group' ? item.clips[0].clip.src : item.path);

/** A bundle as the listing shows it. @param {string} rel @param {any} item */
function bundleEntry(rel, item) {
  const kind = kindOf(mainOf(item));
  /* a page saved, or a page clip: where its page is in the library, and how its clip had it (its size, the changes
     made in it), so the media pane's viewer plays it as the film did */
  const clip = item.kind === 'clip' && kind === 'page' ? item.clip : null;
  const size = clip?.size?.w > 0 && clip?.size?.h > 0 ? { w: clip.size.w, h: clip.size.h } : null;
  /* a component: how many properties it offers (its clip's data-props) */
  const props = (() => {
    try { const list = JSON.parse(item.kind === 'clip' ? item.clip.attrs?.['data-props'] ?? '[]' : '[]'); return Array.isArray(list) ? list.length : 0; } catch { return 0; }
  })();
  const overrides = Array.isArray(clip?.overrides) && clip.overrides.some((/** @type {any} */ o) => o && typeof o === 'object' && 'at' in o) ? clip.overrides : null;
  const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const savedAt = Date.parse(item.savedAt) || 0;
  const saved = {
    kind: item.kind,
    ...(item.kind === 'group' ? { count: item.clips.length } : {}),
    ...(props ? { props } : {}),
    ...(num(item.durationMs) ? { durationMs: num(item.durationMs) } : {}),
    ...(num(item.w) ? { w: num(item.w) } : {}),
    ...(num(item.h) ? { h: num(item.h) } : {}),
    ...(kind === 'page' && item.kind !== 'group' ? { page: `${rel}/files/${mainOf(item)}` } : {}),
    ...(size ? { size } : {}),
    ...(overrides ? { overrides } : {}),
  };
  return { path: libraryPath(rel), kind: kind === 'page' ? 'page' : kind, size: 0, mtime: savedAt, added: savedAt, saved };
}

/** A bundle's picture, or null. */
export async function bundlePoster(/** @type {unknown} */ path) {
  const root = await libraryRoot();
  const file = join(inside(root, libraryRel(path)), 'poster.jpg');
  return existsSync(file) ? file : null;
}

/** A name that is free in folder `dir`: `name`, else `name 2`, `name 3`… */
function freeName(/** @type {string} */ dir, /** @type {string} */ name) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} ${n}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

/**
 * The files a clip needs in project `root`: its own and what it loads, read as the film would (closure.mjs) from a film
 * holding that clip alone; a page beside it only when it is named (another clip's page beside it is not its).
 * @param {string} root @param {Record<string, unknown> & { src: string }} clip
 */
async function clipFiles(root, clip) {
  const folder = folderView(root);
  const film = filmHtml({ tracks: [{ clips: [{ ...clip, id: 'saved' }] }] });
  const held = await filmClosure({
    ...folder,
    size: (path) => (path === FILM_FILE ? Promise.resolve(Buffer.byteLength(film)) : folder.size(path)),
    text: (path) => (path === FILM_FILE ? Promise.resolve(film) : folder.text(path)),
  });
  const files = [...held.keys()].filter((path) => path !== FILM_FILE && !STUDIO_STATE.includes(path));
  /* a version of a project keeps every page beside a page, in case one loads it; a saved clip needs only the pages it
     names */
  const texts = new Map();
  for (const path of files) if (/\.(html?|css|m?js|json|svg)$/i.test(path)) texts.set(path, await folder.text(path) ?? '');
  const named = (/** @type {string} */ page) => [...texts].some(([path, text]) => path !== page && text.includes(posix.basename(page)));
  return files.filter((path) => !/\.html?$/i.test(path) || path === clip.src || named(path));
}

/**
 * A new bundle in the library folder `into` ('' its top), named `name` (a number after it when taken): `files` of
 * project `root` copied in, what it is written, its picture drawn. Returns its path.
 * @param {string} root @param {string[]} files @param {Record<string, unknown>} about @param {string} name @param {string} into
 * @param {(() => Promise<Buffer | null>) | null} poster
 */
async function keep(root, files, about, name, into, poster) {
  const lib = await libraryRoot();
  const parent = into ? inside(lib, into) : lib;
  await mkdir(parent, { recursive: true });
  const folder = freeName(parent, cleanName(name) || 'Saved');
  const dir = join(parent, folder);
  await mkdir(join(dir, 'files'), { recursive: true });
  for (const rel of files) {
    const to = join(dir, 'files', rel);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(join(root, rel), to);
  }
  const picture = poster ? await poster().catch(() => null) : null;
  if (picture) await writeFile(join(dir, 'poster.jpg'), picture);
  await writeFile(join(dir, BUNDLE), `${JSON.stringify({ version: VERSION, ...about, savedAt: new Date().toISOString() }, null, 2)}\n`);
  return libraryPath(into ? `${into}/${folder}` : folder);
}

/** Sizes as asked, when they are some. */
const sizes = (/** @type {{ durationMs?: number, w?: number, h?: number }} */ o) => Object.fromEntries(
  /** @type {const} */ (['durationMs', 'w', 'h']).flatMap((k) => (typeof o[k] === 'number' && Number.isFinite(o[k]) && /** @type {number} */ (o[k]) > 0 ? [[k, Math.round(/** @type {number} */ (o[k]))]] : [])),
);

/**
 * @typedef {{ name?: string, into?: string, durationMs?: number, w?: number, h?: number,
 *   poster?: (clip: Record<string, unknown> & { src: string }) => Promise<Buffer | null> }} SaveOptions
 */

/**
 * Saves the clip `clipId` of the project at `root` into the library (`o.into`, a `saved/` path; its top by default): the
 * clip as the film has it, without its place in time or its id (it gets a new one where it is put), and every file it
 * needs. A link to clips left behind is not kept. Returns its path.
 * @param {string} root @param {string} clipId @param {SaveOptions} [o]
 */
export async function saveClip(root, clipId, o = {}) {
  const { value } = await readProjectFilm(root);
  const found = value?.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
  if (!found) throw new SavedError('That clip is not in the film any more.', 404);
  const clip = /** @type {Record<string, unknown> & { src: string, attrs?: Record<string, string> }} */ (structuredClone(found));
  delete clip.at;
  delete clip.id;
  if (clip.attrs) {
    delete clip.attrs['data-link'];
    if (!Object.keys(clip.attrs).length) delete clip.attrs;
  }
  const files = await clipFiles(root, clip);
  if (!files.includes(clip.src)) throw new SavedError('That clip’s file is not in the project.', 409);
  const name = o.name?.trim() || clip.src.split('/').pop()?.replace(/\.[^.]+$/, '') || clipId;
  return keep(root, files, { kind: 'clip', clip, ...sizes(o) }, name, libraryRel(o.into ?? LIBRARY), o.poster ? () => /** @type {NonNullable<typeof o.poster>} */ (o.poster)(clip) : null);
}

/**
 * Saves the clips `clipIds` of the project at `root` together, as they are laid out: each one's track counted from the
 * top one among them, its time from the first of them. Links among them are kept (they are made anew where they go),
 * links to clips left out are not. The picture is the top one's that draws one. Returns its path.
 * @param {string} root @param {string[]} clipIds @param {SaveOptions} [o]
 */
export async function saveGroup(root, clipIds, o = {}) {
  const { value } = await readProjectFilm(root);
  /** @type {{ track: number, clip: Record<string, unknown> & { src: string, at?: number, attrs?: Record<string, string> } }[]} */
  const found = [];
  value?.tracks.forEach((track, t) => track.clips.forEach((clip) => { if (clipIds.includes(clip.id)) found.push({ track: t, clip: structuredClone(clip) }); }));
  if (!found.length || found.length !== new Set(clipIds).size) throw new SavedError('Those clips are not all in the film any more.', 404);
  const tracks = [...new Set(found.map((f) => f.track))].sort((a, b) => a - b);
  const first = Math.min(...found.map((f) => f.clip.at ?? 0));
  const links = new Map();
  for (const { clip } of found) { const l = clip.attrs?.['data-link']; if (l) links.set(l, (links.get(l) ?? 0) + 1); }
  const clips = found
    .map(({ track, clip }) => {
      const at = Math.round(((clip.at ?? 0) - first) * 1000) / 1000;
      delete clip.at;
      delete clip.id;
      if (clip.attrs?.['data-link'] && (links.get(clip.attrs['data-link']) ?? 0) < 2) delete clip.attrs['data-link'];
      if (clip.attrs && !Object.keys(clip.attrs).length) delete clip.attrs;
      return { track: tracks.indexOf(track), at, clip };
    })
    .sort((a, b) => a.track - b.track || a.at - b.at);
  const files = new Set();
  for (const { clip } of clips) {
    const need = await clipFiles(root, clip);
    if (!need.includes(clip.src)) throw new SavedError('A clip’s file is not in the project.', 409);
    for (const f of need) files.add(f);
  }
  const top = clips.find(({ clip }) => clipKind(clip.src) !== 'sound' && clip.sound !== true)?.clip ?? null;
  const name = o.name?.trim() || `${clips.length} clips`;
  return keep(root, [...files], { kind: 'group', clips, ...sizes(o) }, name, libraryRel(o.into ?? LIBRARY), top && o.poster ? () => /** @type {NonNullable<typeof o.poster>} */ (o.poster)(top) : null);
}

/**
 * Saves the file `rel` of the project at `root` into the library: a page as a bundle, with what it loads; any other
 * file as itself (the same bytes there already are that file). Returns its path.
 * @param {string} root @param {string} rel @param {Omit<SaveOptions, 'poster'> & { poster?: () => Promise<Buffer | null> }} [o]
 */
export async function saveFile(root, rel, o = {}) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new SavedError('a file of the project, please', 400);
  const info = await stat(join(root, rel)).catch(() => null);
  if (!info?.isFile()) throw new SavedError('That file is not in the project any more.', 404);
  const into = libraryRel(o.into ?? LIBRARY);
  if (clipKind(rel) === 'page') {
    const files = await clipFiles(root, { src: rel });
    if (!files.includes(rel)) files.unshift(rel);
    const name = o.name?.trim() || rel.split('/').pop()?.replace(/\.[^.]+$/, '') || rel;
    return keep(root, files, { kind: 'page', path: rel, ...sizes(o) }, name, into, o.poster ?? null);
  }
  const lib = await libraryRoot();
  const { path } = await importFile(lib, into ? `${into}/${basename(rel)}` : basename(rel), createReadStream(join(root, rel)));
  return libraryPath(path);
}

/**
 * What a project needs to use a thing of the library (`path`, a `saved/` path): a file imported into its assets/ (as
 * one from the computer is), or a bundle's files copied to `saved/<its place>/` there (a file there already is kept as
 * it is) and the clip, a group's clips or the page, with their files' places there.
 * @param {string} root @param {unknown} path
 * @returns {Promise<{ clip: Record<string, unknown> & { src: string } } | { clips: { track: number, at: number, clip: Record<string, unknown> & { src: string } }[] } | { path: string }>}
 */
export async function takeSaved(root, path) {
  const lib = await libraryRoot();
  const rel = libraryRel(path);
  if (!rel) throw new SavedError('a thing in Saved, please', 400);
  const at = inside(lib, rel);
  const info = await stat(at).catch(() => null);
  if (!info) throw new SavedError('That is not in Saved any more.', 404);
  if (info.isFile()) return { path: (await importFile(root, `assets/${basename(rel)}`, createReadStream(at))).path };
  const item = await readBundle(at);
  if (!item) throw new SavedError('That is a folder: open it and pick what is in it.', 400);
  /* its place in the project: the library's, made a name a page's address takes as it is */
  const base = `saved/${rel.split('/').map((part) => part.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'saved').join('/')}`;
  const from = join(at, 'files');
  for (const entry of await readdir(from, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const src = join(entry.parentPath ?? entry.path, entry.name);
    const to = join(root, base, src.slice(from.length + 1));
    /* there already (taken before, maybe changed since in this project): it stays as it is */
    if ((await stat(to).catch(() => null))?.isFile()) continue;
    await mkdir(dirname(to), { recursive: true });
    await copyFile(src, to);
  }
  if (item.kind === 'page') return { path: `${base}/${item.path}` };
  if (item.kind === 'group') return { clips: item.clips.map((/** @type {any} */ c) => ({ track: c.track, at: c.at, clip: { ...c.clip, src: `${base}/${c.clip.src}` } })) };
  return { clip: { ...item.clip, src: `${base}/${item.clip.src}` } };
}
