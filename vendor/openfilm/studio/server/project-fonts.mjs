// @ts-check
/**
 * The fonts a project brings with it: the families its pages declare with `@font-face` (in their own `<style>` or
 * in a stylesheet of the folder), each with the weights and styles it declares and the files it loads, and — for one
 * page — the families that page can draw with (declared in it or in a stylesheet it links) and the ones its CSS names.
 *
 * The inspector's font menu lists them first, "In this project", set in their own faces. Read from the folder's
 * .css and .html files; each file's reading is kept until its mtime or size changes, so asking again is cheap.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, posix } from 'node:path';

/**
 * One `@font-face` rule. `weight`: its range (one weight: both the same); `src`: the files it loads, by their path in
 * the project, a web address, or a `local()` font's name.
 * @typedef {{ family: string, weight: [number, number], style: 'normal' | 'italic', src: FontSrc[], file: string }} FontFace
 * @typedef {{ path?: string, url?: string, local?: string, format?: string }} FontSrc
 * @typedef {{ family: string, weights: number[], italics?: number[], variable?: [number, number], faces: FontFace[], missing?: true }} ProjectFont
 */

const NAMED_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
/** CSS's generic families and keywords: what a font-family names that is no font of anyone's. */
export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'revert',
  'revert-layer', 'default',
]);

/** `css` without its comments. */
const uncomment = (/** @type {string} */ css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** `text` split at `sep`, but not inside brackets or quotes. */
function splitOutside(/** @type {string} */ text, /** @type {string} */ sep) {
  /** @type {string[]} */
  const out = [];
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (/** @type {string} */ s) => s.trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();

/** A `font-weight` descriptor as a range: `100 900`, `bold`, `400`. */
export function weightRange(/** @type {string | undefined} */ value) {
  const words = String(value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const one = (/** @type {string | undefined} */ w) => (w === 'bold' ? 700 : w === 'normal' || w == null ? 400 : Number(w));
  const a = one(words[0]);
  const b = words[1] != null ? one(words[1]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return /** @type {[number, number]} */ ([400, 400]);
  return /** @type {[number, number]} */ ([Math.min(a, b), Math.max(a, b)]);
}

/**
 * Where an address in `file` (a project path) leads, as a project path; null when out of the folder or not a file of
 * it (a web address, `data:`, an absolute path).
 */
export function resolveIn(/** @type {string} */ file, /** @type {string} */ address) {
  const raw = address.trim().replace(/[?#].*$/, '');
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* as written */ }
  const joined = posix.normalize(posix.join(posix.dirname(file), decoded));
  return joined.startsWith('../') || joined === '..' ? null : joined;
}

/** A `src` descriptor's sources, each resolved from `file`. */
function sourcesOf(/** @type {string} */ value, /** @type {string} */ file) {
  /** @type {FontSrc[]} */
  const out = [];
  for (const item of splitOutside(value, ',')) {
    const local = /^local\(\s*([^)]*)\)/i.exec(item);
    if (local) { out.push({ local: unquote(local[1] ?? '') }); continue; }
    const url = /^url\(\s*(["']?)([^"')]*)\1\s*\)/i.exec(item);
    if (!url) continue;
    const format = /format\(\s*["']?([^"')]+)["']?\s*\)/i.exec(item)?.[1];
    const address = url[2] ?? '';
    if (/^data:/i.test(address)) continue;
    const path = resolveIn(file, address);
    if (path) out.push({ path, ...(format ? { format } : {}) });
    else if (/^https?:\/\//i.test(address)) out.push({ url: address, ...(format ? { format } : {}) });
  }
  return out;
}

/** The `@font-face` rules of `css` (a stylesheet, or a page's whole text), read as declared in `file`. */
export function parseFontFaces(/** @type {string} */ css, /** @type {string} */ file) {
  /** @type {FontFace[]} */
  const out = [];
  for (const m of uncomment(css).matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    /** @type {Record<string, string>} */
    const said = {};
    for (const decl of splitOutside(m[1] ?? '', ';')) {
      const colon = decl.indexOf(':');
      if (colon > 0) said[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim();
    }
    const family = unquote(said['font-family'] ?? '');
    if (!family || /\$\{|var\(/.test(family)) continue;
    const style = /^(italic|oblique)\b/i.test(said['font-style'] ?? '') ? 'italic' : 'normal';
    out.push({ family, weight: weightRange(said['font-weight']), style, src: sourcesOf(said.src ?? '', file), file });
  }
  return out;
}

/** The families a `font-family` value names, in order: no generic family, no keyword, nothing worked out. */
export function familiesIn(/** @type {string} */ value) {
  return splitOutside(value.replace(/!important\s*$/i, ''), ',')
    .map(unquote)
    .filter((f) => f && !GENERIC_FAMILIES.has(f.toLowerCase()) && !/[${}()<>]|^--|^var\b/i.test(f));
}

/** The families `css` names in `font-family` and in `font` shorthands. */
export function fontFamiliesUsed(/** @type {string} */ css) {
  const text = uncomment(css).replace(/@font-face\s*\{[^}]*\}/gi, ' ');
  /** @type {string[]} */
  const out = [];
  for (const m of text.matchAll(/(?:^|[\s;{"'`])font-family\s*:\s*([^;}"`<>]+)/gi)) out.push(...familiesIn(m[1] ?? ''));
  for (const m of text.matchAll(/(?:^|[\s;{"'`])font\s*:\s*([^;}"`<>]+)/gi)) {
    /* `[style] [weight] size[/line-height] family, …` */
    const rest = /(?:^|\s)(?:[\d.]+(?:px|em|rem|pt|%|vw|vh|vmin|vmax|ch|ex)|(?:xx?-)?(?:small|large)|medium|larger|smaller)(?:\s*\/\s*\S+)?\s+(.+)$/i.exec((m[1] ?? '').trim())?.[1];
    if (rest) out.push(...familiesIn(rest));
  }
  return [...new Set(out)];
}

/** The stylesheets a page or a stylesheet loads (`<link rel="stylesheet">`, `@import`), as written. */
export function stylesheetsOf(/** @type {string} */ text) {
  /** @type {string[]} */
  const out = [];
  for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const address = href?.[1] ?? href?.[2] ?? href?.[3];
    if (address) out.push(address);
  }
  for (const m of uncomment(text).matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi)) if (m[1]) out.push(m[1]);
  return out;
}

/**
 * Families from their faces: the weights each has (a range: the named weights in it, and `variable` the range), the
 * weights it has an italic of. `exists`: whether a project file is there (a family none of whose files is: `missing`).
 * @param {FontFace[]} faces @param {(path: string) => boolean} [exists] @returns {ProjectFont[]}
 */
export function projectFamilies(faces, exists = () => true) {
  /** @type {Map<string, FontFace[]>} */
  const byFamily = new Map();
  for (const face of faces) {
    const key = face.family.toLowerCase();
    byFamily.set(key, [...(byFamily.get(key) ?? []), face]);
  }
  return [...byFamily.values()].map((list) => {
    const weights = new Set(/** @type {number[]} */ ([]));
    const italics = new Set(/** @type {number[]} */ ([]));
    /** @type {[number, number] | null} */
    let variable = null;
    for (const face of list) {
      const [lo, hi] = face.weight;
      const ws = hi > lo ? [...new Set([lo, ...NAMED_WEIGHTS.filter((w) => w >= lo && w <= hi), hi])] : [lo];
      if (hi > lo) variable = variable ? [Math.min(variable[0], lo), Math.max(variable[1], hi)] : [lo, hi];
      for (const w of ws) (face.style === 'italic' ? italics : weights).add(w);
    }
    const files = list.flatMap((f) => f.src.filter((s) => s.path));
    const missing = files.length > 0 && !list.some((f) => f.src.some((s) => s.url || s.local)) && !files.some((s) => exists(/** @type {string} */ (s.path)));
    const sorted = (/** @type {Set<number>} */ s) => [...s].sort((a, b) => a - b);
    return {
      family: /** @type {FontFace} */ (list[0]).family,
      weights: sorted(weights.size ? weights : italics),
      ...(italics.size ? { italics: sorted(italics) } : {}),
      ...(variable ? { variable } : {}),
      faces: list,
      ...(missing ? { missing: /** @type {const} */ (true) } : {}),
    };
  }).sort((a, b) => a.family.localeCompare(b.family));
}

/* ── the folder ── */

const READ = new Set(['.css', '.html', '.htm']);
const MAX_FILES = 4000;
const MAX_BYTES = 4 * 1024 * 1024;

/** @typedef {{ mtimeMs: number, size: number, faces: FontFace[], used: string[], links: string[] }} FileFacts */
/** @type {Map<string, Map<string, FileFacts>>} what each project's files said, by their path */
const known = new Map();

/** The .css / .html files of the folder (not in hidden folders or node_modules), as project paths. */
async function styleFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const out = [];
  const walk = async (/** @type {string} */ rel, /** @type {number} */ depth) => {
    let entries;
    try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth > 0 && e.name !== 'node_modules') await walk(path, depth - 1); }
      else if (e.isFile() && READ.has(extname(e.name).toLowerCase())) out.push(path);
    }
  };
  await walk('', 8);
  return out;
}

/** What one file says, read again only when it changed. */
async function factsOf(/** @type {string} */ root, /** @type {Map<string, FileFacts>} */ cache, /** @type {string} */ path) {
  const full = join(root, ...path.split('/'));
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) { cache.delete(path); return null; }
  const had = cache.get(path);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had;
  const text = st.size > MAX_BYTES ? '' : await readFile(full, 'utf8').catch(() => '');
  const links = stylesheetsOf(text).map((a) => resolveIn(path, a)).filter((p) => p != null);
  /** @type {FileFacts} */
  const facts = { mtimeMs: st.mtimeMs, size: st.size, faces: parseFontFaces(text, path), used: fontFamiliesUsed(text), links };
  cache.set(path, facts);
  return facts;
}

/**
 * The project's fonts, and for `page` (a project path) the families it can draw with from the project (`declared`)
 * and the ones its CSS names (`used`).
 * @param {string} root @param {string | null} [page]
 */
export async function projectFonts(root, page = null) {
  let cache = known.get(root);
  if (!cache) { cache = new Map(); known.set(root, cache); }
  const files = await styleFiles(root);
  const listed = new Set(files);
  for (const path of [...cache.keys()]) if (!listed.has(path)) cache.delete(path);
  /** @type {FontFace[]} */
  const faces = [];
  for (const path of files) faces.push(...(await factsOf(root, cache, path))?.faces ?? []);
  const fonts = projectFamilies(faces, (path) => existsSync(join(root, ...path.split('/'))));
  if (!page) return { fonts };
  /* the page and every stylesheet it loads, those they load in turn */
  const reach = new Set(/** @type {string[]} */ ([]));
  const used = new Set(/** @type {string[]} */ ([]));
  const queue = [page];
  while (queue.length && reach.size < 200) {
    const path = /** @type {string} */ (queue.shift());
    if (reach.has(path)) continue;
    reach.add(path);
    const facts = await factsOf(root, cache, path);
    if (!facts) continue;
    for (const f of facts.used) used.add(f);
    queue.push(...facts.links);
  }
  const declared = [...new Set(faces.filter((f) => reach.has(f.file)).map((f) => f.family))];
  return { fonts, page: { path: page, declared, used: [...used] } };
}
