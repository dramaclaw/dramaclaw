// @ts-check
/**
 * What a film is made of: the files a version of a project holds (history.mjs). It is read from film.html, so it
 * follows the film and nothing else:
 *
 *   film.html                  and what its own head loads (styles, fonts, scripts)
 *   every clip's file          video, sound, picture or page, and a picture an override draws in a page (`url()`)
 *   what a page loads          relative `src` / `href` / `srcset` and the like in its HTML, `url()` and `@import` in
 *                              its CSS, imports in its scripts (an import map is followed), and any string in its
 *                              scripts and JSON that names a file of the project (`fetch('lib/plan.json')`); a
 *                              template string names every file it can match in one folder (`thumbs/${n}.png`)
 *   beside a page              the small code, data and font files in the page's own folder, in case it loads one in
 *                              a way not read above
 *   beside a video or sound    its subtitles and transcripts (`a.mp4` → `a.vtt`, `a.zh.vtt`, `a.srt`)
 *   Studio's state of it       .film/settings.json, markers.json and subtitles.json
 *
 * Anything else in the folder (renders, frames, logs, scripts that made the film, other takes) is not the film, and a
 * version neither holds nor touches it. Reading is pragmatic: a page that builds a file's name at run time from parts
 * this cannot see should keep its files in its own folder or name them whole somewhere in its code.
 *
 * It reads through a `View`, so the same rule reads the folder now (`folderView`) or a version kept in history.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { FILM_FILE, readFilmFile } from '../../src/film-doc.mjs';
import { TOOL_DIR } from './projects.mjs';

/**
 * A project's files as the closure reads them, by folder-relative path with `/`. `size`: a file's bytes, or null
 * when there is no such file; `list`: the files in a folder (not its folders), or null; `text`: a file's text, or null.
 * @typedef {{ size(path: string): Promise<number | null>, list(dir: string): Promise<string[] | null>, text(path: string): Promise<string | null> }} View
 */

/** Studio's own state of a project that is part of the film (see projects.mjs): kept with each version. */
export const STUDIO_STATE = [`${TOOL_DIR}/settings.json`, `${TOOL_DIR}/markers.json`, `${TOOL_DIR}/subtitles.json`];

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi']);
const AUDIO = new Set(['mp3', 'm4a', 'wav', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'exr', 'heic', 'psd']);
const FONT = new Set(['woff', 'woff2', 'ttf', 'otf']);
/* what is read for the files it names */
const READ = new Set(['html', 'htm', 'svg', 'css', 'js', 'mjs', 'cjs', 'json']);
/* what is taken from beside a page */
const BESIDE_PAGE = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'svg', ...FONT]);
/** Larger than this, a file beside a page is not taken (a font may be larger); larger than READ_MAX, not read. */
const BESIDE_MAX = 2 << 20;
const FONT_MAX = 64 << 20;
const READ_MAX = 4 << 20;

const extOf = (/** @type {string} */ path) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? '';

/** A video, a sound or a picture: kept by its content outside git (history-store.mjs), whatever its size. */
export const isMediaFile = (/** @type {string} */ path) => {
  const ext = extOf(path);
  return VIDEO.has(ext) || AUDIO.has(ext) || IMAGE.has(ext);
};

/** Folders that are never part of a film, wherever a reference points: version control, Studio's own. */
const NEVER = /^(\.git|\.film)(\/|$)/;

/**
 * A reference as it is written (`../a b.png?x#t=2`) made a project path (`a b.png`), from the folder `base` it is
 * read in; null when it names nothing in the project: another site, a data: URL, a fragment, outside the folder.
 */
export function projectPath(/** @type {string} */ ref, /** @type {string} */ base) {
  let s = String(ref).trim().replace(/&amp;/g, '&');
  if (!s || s.length > 1000 || /^(#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(s) || /[\s<>"'`{}|\\^]/.test(s.replace(/%20| /g, ''))) return null;
  s = s.replace(/[?#].*$/, '');
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* as written */ }
  const path = posix.normalize(s.startsWith('/') ? s.slice(1) : posix.join(base, s));
  if (!path || path === '.' || path.startsWith('../') || path === '..' || path.startsWith('/')) return null;
  return path.replace(/\/$/, '');
}

/**
 * A clip's src (its file's path from film.html, as film-doc reads it: any character a name has) made a project path;
 * null for another site, or outside the folder.
 */
export function clipFile(/** @type {string} */ src) {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return null;
  const path = posix.normalize(src.replace(/^\/+/, ''));
  return !path || path === '.' || path === '..' || path.startsWith('../') ? null : path;
}

/* ── reading files for what they name ────────────────────────────────────── */

/** The strings of a script or JSON text (comments skipped): quoted ones, and template strings with `${…}` as `\0`. */
function scriptStrings(/** @type {string} */ text) {
  /** @type {string[]} */
  const out = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === '\'') {
      let j = i + 1, s = '';
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j += 1; s += text[j] ?? ''; j += 1; }
      out.push(s);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1, s = '';
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') { s += text[j + 1] ?? ''; j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          /* what is inside is code: its own strings are read too, and the whole stands for any name */
          let depth = 1, k = j + 2;
          while (k < n && depth) { if (text[k] === '{') depth += 1; else if (text[k] === '}') depth -= 1; k += 1; }
          out.push(...scriptStrings(text.slice(j + 2, k - 1)));
          s += '\0';
          j = k;
          continue;
        }
        s += text[j];
        j += 1;
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** What a CSS text names: `url(…)` and `@import "…"`. */
function cssRefs(/** @type {string} */ text) {
  const out = [];
  for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) out.push(m[2]);
  for (const m of text.matchAll(/@import\s+(['"])([^'"]+)\1/gi)) out.push(m[2]);
  return out;
}

/* attributes whose values are never a file */
const NOT_A_FILE = new Set(['id', 'class', 'style', 'alt', 'title', 'lang', 'dir', 'type', 'rel', 'name', 'content', 'charset', 'width', 'height', 'at', 'volume', 'speed']);

/**
 * An HTML text, read for what it names: every attribute's value that may be a file (`srcset` split up), each style
 * attribute and <style> as CSS, each inline <script> as code, and the import map.
 * @returns {{ refs: string[], css: string[], scripts: string[], imports: Record<string, string> }}
 */
function htmlRefs(/** @type {string} */ text) {
  /** @type {string[]} */
  const refs = [], css = [], scripts = [];
  /** @type {Record<string, string>} */
  const imports = {};
  const body = text.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const [, tag, attrs, inner] = m;
    if (tag.toLowerCase() === 'style') { css.push(inner); continue; }
    if (/\btype\s*=\s*["']?importmap/i.test(attrs)) {
      try {
        const map = JSON.parse(inner);
        for (const [k, v] of Object.entries(map?.imports ?? {})) if (typeof v === 'string') imports[k] = v;
      } catch { /* not one */ }
      continue;
    }
    scripts.push(inner);
  }
  const tags = body.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1\s*>/gi, '<$1$2>');
  for (const tag of tags.matchAll(/<[A-Za-z][\w:-]*(\s[^>]*)?>/g)) {
    for (const a of (tag[1] ?? '').matchAll(/([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = a[1].toLowerCase();
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (name === 'style') css.push(value);
      else if (name === 'srcset' || name === 'imagesrcset') refs.push(...value.split(',').map((part) => part.trim().split(/\s+/)[0]));
      else if (!NOT_A_FILE.has(name) && !name.startsWith('on') && !name.startsWith('aria-')) refs.push(value);
    }
  }
  for (const v of Object.values(imports)) refs.push(v);
  return { refs, css, scripts, imports };
}

/* ── the closure ─────────────────────────────────────────────────────────── */

/**
 * The files of the film `view` holds: path → size. Empty when it has no film.html.
 * @param {View} view @returns {Promise<Map<string, number>>}
 */
export async function filmClosure(view) {
  /** @type {Map<string, number>} */
  const held = new Map();
  /** @type {Map<string, Promise<number | null>>} */
  const sizes = new Map();
  const sizeOf = (/** @type {string} */ path) => {
    if (NEVER.test(path)) return Promise.resolve(null);
    let known = sizes.get(path);
    if (!known) { known = view.size(path).catch(() => null); sizes.set(path, known); }
    return known;
  };
  /** @type {Map<string, Promise<string[] | null>>} */
  const lists = new Map();
  const listOf = (/** @type {string} */ dir) => {
    let known = lists.get(dir);
    if (!known) { known = view.list(dir).catch(() => null); lists.set(dir, known); }
    return known;
  };
  /** files to read, each with the page it is read for (scripts resolve against the page, as a browser does) */
  /** @type {{ path: string, page: string, imports: Record<string, string> }[]} */
  const queue = [];
  const read = new Set();
  /** pages whose folder was looked through, and media whose sidecars were */
  const pageDirs = new Set();
  const mediaSeen = new Set();

  /** Take a file that exists; read it later for what it names. */
  const take = async (/** @type {string} */ path, /** @type {string} */ page, /** @type {Record<string, string>} */ imports = {}) => {
    const size = await sizeOf(path);
    if (size == null) return false;
    held.set(path, size);
    const ext = extOf(path);
    if (READ.has(ext) && size <= READ_MAX) {
      const key = `${path}\n${page}`;
      if (!read.has(key)) { read.add(key); queue.push({ path, page: ext === 'html' || ext === 'htm' ? path : page, imports }); }
    }
    if ((VIDEO.has(ext) || AUDIO.has(ext)) && !mediaSeen.has(path)) { mediaSeen.add(path); await sidecars(path); }
    return true;
  };

  /** A reference made a path from each of `bases` in turn, the first that exists taken; a template takes every match. */
  const ref = async (/** @type {string} */ raw, /** @type {string[]} */ bases, /** @type {string} */ page, /** @type {Record<string, string>} */ imports = {}) => {
    if (!raw || raw.length > 1000 || /[\n\r]/.test(raw)) return;
    if (raw.includes('\0') || raw.includes('${')) { await template(raw.replace(/\$\{[^}]*\}/g, '\0'), bases, page); return; }
    /* a bare module name, through the page's import map: exact, or the longest prefix ending in / */
    if (!/^(\.{0,2}\/)/.test(raw) && Object.keys(imports).length) {
      const exact = imports[raw];
      const prefix = exact ? null : Object.keys(imports).filter((k) => k.endsWith('/') && raw.startsWith(k)).sort((a, b) => b.length - a.length)[0];
      const mapped = exact ?? (prefix ? imports[prefix] + raw.slice(prefix.length) : null);
      if (mapped) {
        const path = projectPath(mapped, posix.dirname(page));
        if (path && await take(path, page, imports)) return;
      }
    }
    for (const base of bases) {
      const path = projectPath(raw, base);
      if (path && await take(path, page, imports)) return;
    }
  };

  /** A name with parts made at run time (`\0`): every file of the one folder it names whose name matches. */
  const template = async (/** @type {string} */ raw, /** @type {string[]} */ bases, /** @type {string} */ page) => {
    const clean = raw.replace(/[?#].*$/, '');
    const slash = clean.lastIndexOf('/');
    const dirPart = slash < 0 ? '' : clean.slice(0, slash);
    const name = clean.slice(slash + 1);
    /* only what is said enough of: a known folder and a name with something fixed in it (`${a}` alone names anything) */
    if (dirPart.includes('\0') || !name.replace(/\0/g, '') || (!dirPart && !/\.[A-Za-z0-9]+$/.test(name))) return;
    const pattern = new RegExp(`^${name.split('\0').map((s) => s.replace(/[.*+?^$()[\]{}|\\]/g, '\\$&')).join('[^/]*')}$`);
    for (const base of bases) {
      const dir = dirPart ? projectPath(dirPart, base) : (base || '');
      if (dir == null) continue;
      const names = await listOf(dir);
      if (!names) continue;
      for (const n of names) if (pattern.test(n)) await take(dir ? `${dir}/${n}` : n, page);
      return;
    }
  };

  /** A video's or sound's subtitles and transcripts beside it: same name, `.vtt` or `.srt`, with a language or not. */
  const sidecars = async (/** @type {string} */ path) => {
    const dir = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const stem = posix.basename(path).replace(/\.[^.]+$/, '');
    const names = await listOf(dir);
    for (const n of names ?? []) {
      if (!n.startsWith(stem)) continue;
      const rest = n.slice(stem.length);
      if (/^(\.[A-Za-z0-9_-]+)?\.(vtt|srt)$/i.test(rest)) {
        const side = dir ? `${dir}/${n}` : n;
        const size = await sizeOf(side);
        if (size != null) held.set(side, size);
      }
    }
  };

  /** The small code, data and fonts in a page's own folder. */
  const besidePage = async (/** @type {string} */ page) => {
    const dir = posix.dirname(page) === '.' ? '' : posix.dirname(page);
    if (pageDirs.has(dir)) return;
    pageDirs.add(dir);
    for (const n of (await listOf(dir)) ?? []) {
      const ext = extOf(n);
      if (!BESIDE_PAGE.has(ext)) continue;
      const path = dir ? `${dir}/${n}` : n;
      const size = await sizeOf(path);
      if (size != null && size <= (FONT.has(ext) ? FONT_MAX : BESIDE_MAX)) held.set(path, size);
    }
  };

  const filmText = await view.text(FILM_FILE);
  if (filmText == null) return held;
  held.set(FILM_FILE, (await sizeOf(FILM_FILE)) ?? Buffer.byteLength(filmText));
  for (const path of STUDIO_STATE) {
    const size = await view.size(path).catch(() => null);
    if (size != null) held.set(path, size);
  }
  /* the clips, as the film reads them (a film with problems still names its files) */
  let value = null;
  try { value = readFilmFile(filmText).value; } catch { /* read as HTML below */ }
  for (const track of value?.tracks ?? []) {
    for (const clip of /** @type {{ src?: unknown, overrides?: unknown }[]} */ (track.clips ?? [])) {
      if (typeof clip?.src !== 'string') continue;
      const file = clipFile(clip.src);
      if (file) await take(file, FILM_FILE);
      /* a picture the person put in a page's place (an override's `url()`), named from the page's folder */
      const dir = posix.dirname(clip.src) === '.' ? '' : posix.dirname(clip.src);
      for (const o of Array.isArray(clip.overrides) ? clip.overrides : []) {
        for (const v of Object.values(o?.style ?? {})) if (typeof v === 'string') for (const r of cssRefs(v)) await ref(r, [dir], clip.src);
      }
    }
  }
  /* and the film read as the page it is: its head, and any clip the reading above did not take */
  queue.push({ path: FILM_FILE, page: FILM_FILE, imports: {} });

  while (queue.length) {
    const { path, page, imports } = /** @type {{ path: string, page: string, imports: Record<string, string> }} */ (queue.shift());
    const text = path === FILM_FILE ? filmText : await view.text(path).catch(() => null);
    if (text == null) continue;
    const ext = extOf(path);
    const here = posix.dirname(path) === '.' ? '' : posix.dirname(path);
    const pageDir = posix.dirname(page) === '.' ? '' : posix.dirname(page);
    if (ext === 'html' || ext === 'htm' || ext === 'svg') {
      if (path !== FILM_FILE && ext !== 'svg') await besidePage(path);
      const found = htmlRefs(text);
      const map = { ...imports, ...found.imports };
      for (const r of found.refs) await ref(r, [here], ext === 'svg' ? page : path, map);
      for (const c of found.css) for (const r of cssRefs(c)) await ref(r, [here], page, map);
      for (const s of found.scripts) for (const r of scriptStrings(s)) await stringRef(r, [here], ext === 'svg' ? page : path, map);
    } else if (ext === 'css') {
      for (const r of cssRefs(text)) await ref(r, [here], page, imports);
    } else {
      /* a script or JSON: a name in it is read from its own folder (an import, new URL(…, import.meta.url)) or the page's (fetch) */
      for (const r of scriptStrings(text)) await stringRef(r, here === pageDir ? [here] : [here, pageDir], page, imports);
    }
  }
  return held;

  /** A string in code: a file's name, or markup or CSS that names files. */
  async function stringRef(/** @type {string} */ s, /** @type {string[]} */ bases, /** @type {string} */ page, /** @type {Record<string, string>} */ imports) {
    if (s.length > 20000) return;
    if (/[<]/.test(s) || /url\(/i.test(s)) {
      const found = htmlRefs(s.replace(/\0/g, '${}'));
      for (const r of found.refs) await ref(r, bases, page, imports);
      for (const c of [...found.css, s]) for (const r of cssRefs(c)) await ref(r, bases, page, imports);
      return;
    }
    if (/\s/.test(s) || !/[./]/.test(s)) return;
    await ref(s, bases, page, imports);
  }
}

/* ── the folder as it is ─────────────────────────────────────────────────── */

/**
 * The project folder at `root` as a View. A link is followed to what it points at (a file outside the folder is read
 * as the link's content, as a browser loading the page would).
 * @param {string} root @returns {View}
 */
export function folderView(root) {
  const abs = (/** @type {string} */ path) => posix.join(root.split('\\').join('/'), path);
  return {
    async size(path) {
      const info = await stat(abs(path)).catch(() => null);
      return info?.isFile() ? info.size : null;
    },
    async list(dir) {
      const entries = await readdir(abs(dir || '.'), { withFileTypes: true }).catch(() => null);
      if (!entries) return null;
      const out = [];
      for (const e of entries) {
        if (e.isFile()) out.push(e.name);
        else if (e.isSymbolicLink() && (await stat(abs(dir ? `${dir}/${e.name}` : e.name)).catch(() => null))?.isFile()) out.push(e.name);
      }
      return out;
    },
    async text(path) {
      return readFile(abs(path), 'utf8').catch(() => null);
    },
  };
}

/** Folders a person's project has that are never anyone's film: walked past when counting what history leaves out. */
const NOT_THE_PROJECT = new Set(['.git', 'node_modules', TOOL_DIR, '.DS_Store', 'Thumbs.db']);

/**
 * Every file of the project folder (but Studio's own `.film/`, version control and packages): path → size (0 when
 * `sizes` is false: the walk alone, without asking each file's size).
 * @param {string} root @param {{ sizes?: boolean }} [o] @returns {Promise<Map<string, number>>}
 */
export async function projectFiles(root, { sizes = true } = {}) {
  /** @type {Map<string, number>} */
  const out = new Map();
  const walk = async (/** @type {string} */ rel) => {
    const entries = await readdir(rel ? posix.join(root, rel) : root, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (NOT_THE_PROJECT.has(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) out.set(path, sizes ? (await stat(posix.join(root, path)).catch(() => null))?.size ?? 0 : 0);
    }
  };
  await walk('');
  return out;
}
