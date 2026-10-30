// @ts-check
/**
 * The fonts a film can use here: the ones installed on this machine (a web page draws with them in the preview and
 * in the export alike, both in this machine's browser). Read from the system's font folders once per process: each
 * file's family names (name table), its other-language names as aliases (so "霞鹜文楷" finds LXGW WenKai), the
 * script it is for (Chinese / Japanese / Korean / Latin), from those names and the font's code pages, and the weights
 * and italics the family really has (each face's OS/2 weight class and style bits; a variable font's `wght` axis).
 */
import { readdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/**
 * `weights`: the weights it has (a variable font: the named ones in its range, and `variable` the range itself);
 * `italics`: the weights it has an italic of (none: no italic); `sample`: a character of its script it really
 * draws (永, あ, 한), for the font menu to show beside a name in Latin letters.
 * @typedef {{ family: string, locale: 'latin' | 'zh-CN' | 'ja-JP' | 'ko-KR', role: string, aliases?: string[], weights: number[], italics?: number[], variable?: [number, number], sample?: string }} FontOption
 */
/** @typedef {{ family: string, aliases: string[], locale: FontOption['locale'], weight: number, italic: boolean, wght?: [number, number], ital?: boolean, sample?: string }} Face */

const FOLDERS = process.platform === 'darwin'
  ? ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts', join(homedir(), 'Library/Fonts')]
  : process.platform === 'win32'
    ? [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Windows/Fonts')]
    : ['/usr/share/fonts', '/usr/local/share/fonts', join(homedir(), '.fonts'), join(homedir(), '.local/share/fonts')];

const FONT_FILES = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/** @type {Promise<FontOption[]> | null} */
let listing = null;

/** The installed fonts, by family, sorted by name (hidden system families — names starting with "." — left out). */
export function installedFonts() {
  listing ??= scan().catch(() => []);
  return listing;
}

async function scan() {
  /** @type {Face[]} */
  const faces = [];
  for (const folder of FOLDERS) {
    for (const file of await fontFiles(folder, 3)) faces.push(...await facesOf(file).catch(() => []));
  }
  return familiesOf(faces);
}

/** The weights CSS names (Thin … Black): a variable font offers those in its range. */
const NAMED_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/**
 * Faces grouped by family, sorted by name: their names and script merged, their weights and italics gathered.
 * @param {Face[]} faces @returns {FontOption[]}
 */
export function familiesOf(faces) {
  /** @type {Map<string, { aliases: Set<string>, locale: FontOption['locale'], weights: Set<number>, italics: Set<number>, variable: [number, number] | null, sample?: string }>} */
  const families = new Map();
  for (const face of faces) {
    if (!face.family || face.family.startsWith('.')) continue;
    let known = families.get(face.family);
    if (!known) {
      known = { aliases: new Set(), locale: face.locale, weights: new Set(), italics: new Set(), variable: null };
      families.set(face.family, known);
    }
    for (const a of face.aliases) known.aliases.add(a);
    if (known.locale === 'latin' && face.locale !== 'latin') known.locale = face.locale;
    if (face.sample && !known.sample) known.sample = face.sample;
    const range = face.wght;
    const weights = range ? [...new Set([face.weight, ...NAMED_WEIGHTS.filter((w) => w >= range[0] && w <= range[1])])] : [face.weight];
    if (range) known.variable = known.variable ? [Math.min(known.variable[0], range[0]), Math.max(known.variable[1], range[1])] : range;
    for (const w of weights) {
      if (!face.italic) known.weights.add(w);
      if (face.italic || face.ital) known.italics.add(w);
    }
  }
  return [...families.entries()]
    .map(([family, { aliases, locale, weights, italics, variable, sample }]) => {
      const others = [...aliases].filter((a) => a !== family);
      /* a family of italics only: those are its weights too (an upright of it is drawn slanted anyway) */
      const upright = [...(weights.size ? weights : italics)].sort((a, b) => a - b);
      return {
        family, locale, role: '', ...(others.length ? { aliases: others } : {}), weights: upright,
        ...(italics.size ? { italics: [...italics].sort((a, b) => a - b) } : {}),
        ...(variable ? { variable } : {}),
        ...(sample && sample === SAMPLES[locale] ? { sample } : {}),
      };
    })
    .sort((a, b) => a.family.localeCompare(b.family));
}

/** Font files under `dir`, `depth` folders deep. */
async function fontFiles(/** @type {string} */ dir, /** @type {number} */ depth) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...await fontFiles(path, depth - 1));
    else if (e.isFile() && FONT_FILES.has(extname(e.name).toLowerCase())) out.push(path);
  }
  return out;
}

/* ── reading a font's names and styles (OpenType `name`, `OS/2` and `fvar` tables; a collection holds several fonts) ── */

/** @param {string} file */
async function facesOf(file) {
  const fh = await open(file, 'r');
  try {
    return await readFaces(async (at, len) => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, at);
      return buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
}

/**
 * The faces of one font file, read through `read` (bytes at an offset).
 * @param {(at: number, len: number) => Promise<Buffer>} read @returns {Promise<Face[]>}
 */
export async function readFaces(read) {
  const head = await read(0, 12);
  if (head.length < 12) return [];
  /** @type {number[]} */
  let offsets = [0];
  if (head.toString('latin1', 0, 4) === 'ttcf') {
    const count = Math.min(head.readUInt32BE(8), 64);
    const table = await read(12, count * 4);
    offsets = Array.from({ length: Math.floor(table.length / 4) }, (_, i) => table.readUInt32BE(i * 4));
  }
  const faces = [];
  for (const offset of offsets) faces.push(await faceAt(read, offset));
  return /** @type {Face[]} */ (faces.filter((f) => f != null));
}

/** @param {(at: number, len: number) => Promise<Buffer>} read @param {number} offset */
async function faceAt(read, offset) {
  const dir = await read(offset, 12);
  if (dir.length < 12) return null;
  const count = dir.readUInt16BE(4);
  const records = await read(offset + 12, count * 16);
  /** @type {Record<string, { at: number, len: number }>} */
  const tables = {};
  for (let i = 0; i + 16 <= records.length; i += 16) {
    tables[records.toString('latin1', i, i + 4)] = { at: records.readUInt32BE(i + 8), len: records.readUInt32BE(i + 12) };
  }
  if (!tables.name) return null;
  const name = await read(tables.name.at, Math.min(tables.name.len, 256 * 1024));
  const names = nameRecords(name);
  /* the typographic family (16) groups weights under one name; the legacy family (1) splits them */
  const pick = (/** @type {number} */ id) => names.filter((n) => n.id === id);
  const english = (/** @type {{ text: string, lang: number, platform: number }[]} */ list) =>
    list.find((n) => n.platform === 3 && n.lang === 0x409)?.text ?? list.find((n) => n.platform === 1 && n.lang === 0)?.text ?? list[0]?.text;
  const typographic = pick(16);
  const legacy = pick(1);
  const family = english(typographic.length ? typographic : legacy);
  if (!family) return null;
  const aliases = [...new Set([...typographic, ...legacy].map((n) => n.text))];
  const os2 = tables['OS/2'] ? await read(tables['OS/2'].at, 96) : null;
  /* the weight class (old fonts wrote 1–9) and the italic / oblique bits; the style name when there is no OS/2 */
  const subfamily = english(pick(17).length ? pick(17) : pick(2)) ?? '';
  let weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 400;
  if (weight > 0 && weight < 10) weight *= 100;
  if (!(weight >= 1 && weight <= 1000)) weight = 400;
  const italic = os2 && os2.length >= 64 ? Boolean(os2.readUInt16BE(62) & ((1 << 0) | (1 << 9))) : /italic|oblique/i.test(subfamily);
  const axes = tables.fvar ? fvarAxes(await read(tables.fvar.at, Math.min(tables.fvar.len, 4096))) : [];
  const wght = axes.find((a) => a.tag === 'wght');
  const ital = axes.some((a) => (a.tag === 'ital' && a.max > 0) || (a.tag === 'slnt' && a.min < 0));
  const locale = localeOf(names, os2);
  /* a CJK font's sample, if its character map has it (code pages file some fonts under a script they do not draw) */
  const ch = SAMPLES[locale];
  const cmap = ch && tables.cmap ? await read(tables.cmap.at, Math.min(tables.cmap.len, 2 * 1024 * 1024)) : null;
  const sample = ch && cmap && hasCodepoint(cmap, /** @type {number} */ (ch.codePointAt(0))) ? ch : undefined;
  return {
    family, aliases, locale, weight, italic, ...(sample ? { sample } : {}),
    /* a weight axis on CSS's scale only (Skia's runs 0.5–3) */
    ...(wght && wght.min >= 1 && wght.max <= 1000 && wght.max - wght.min >= 50 ? { wght: /** @type {[number, number]} */ ([Math.round(wght.min), Math.round(wght.max)]) } : {}),
    ...(ital ? { ital } : {}),
  };
}

/** The character the font menu shows of each CJK script. @type {Record<string, string>} */
const SAMPLES = { 'zh-CN': '永', 'ja-JP': 'あ', 'ko-KR': '한' };

/**
 * Whether a character map (`cmap`, its Unicode subtable: format 12, else 4) gives `cp` a glyph.
 * @param {Buffer} buf @param {number} cp
 */
export function hasCodepoint(buf, cp) {
  if (buf.length < 4) return false;
  const count = buf.readUInt16BE(2);
  /** @type {{ platform: number, encoding: number, at: number }[]} */
  const subtables = [];
  for (let i = 0; i < count && 4 + i * 8 + 8 <= buf.length; i++) {
    const r = 4 + i * 8;
    subtables.push({ platform: buf.readUInt16BE(r), encoding: buf.readUInt16BE(r + 2), at: buf.readUInt32BE(r + 4) });
  }
  const unicode = subtables.filter((t) => t.platform === 0 || (t.platform === 3 && (t.encoding === 1 || t.encoding === 10)));
  for (const t of unicode) {
    if (t.at + 4 > buf.length) continue;
    const format = buf.readUInt16BE(t.at);
    if (format === 12 && t.at + 16 <= buf.length) {
      const groups = buf.readUInt32BE(t.at + 12);
      for (let g = 0; g < groups; g++) {
        const o = t.at + 16 + g * 12;
        if (o + 12 > buf.length) break;
        if (cp >= buf.readUInt32BE(o) && cp <= buf.readUInt32BE(o + 4)) return buf.readUInt32BE(o + 8) + (cp - buf.readUInt32BE(o)) !== 0;
      }
      return false;
    }
    if (format === 4 && cp <= 0xffff && t.at + 14 <= buf.length) {
      const segs = buf.readUInt16BE(t.at + 6) / 2;
      const ends = t.at + 14;
      const starts = ends + segs * 2 + 2;
      const deltas = starts + segs * 2;
      const ranges = deltas + segs * 2;
      if (ranges + segs * 2 > buf.length) continue;
      for (let i = 0; i < segs; i++) {
        if (cp > buf.readUInt16BE(ends + i * 2)) continue;
        const start = buf.readUInt16BE(starts + i * 2);
        if (cp < start) return false;
        const delta = buf.readInt16BE(deltas + i * 2);
        const range = buf.readUInt16BE(ranges + i * 2);
        if (!range) return ((cp + delta) & 0xffff) !== 0;
        const o = ranges + i * 2 + range + (cp - start) * 2;
        return o + 2 <= buf.length && buf.readUInt16BE(o) !== 0;
      }
      return false;
    }
  }
  return false;
}

/** A variable font's axes (`fvar`): each one's tag and range. @param {Buffer} buf */
function fvarAxes(buf) {
  if (buf.length < 16) return [];
  const at = buf.readUInt16BE(4);
  const count = buf.readUInt16BE(8);
  const size = buf.readUInt16BE(10);
  const fixed = (/** @type {number} */ o) => buf.readInt32BE(o) / 65536;
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = at + i * size;
    if (o + 20 > buf.length) break;
    out.push({ tag: buf.toString('latin1', o, o + 4), min: fixed(o + 4), max: fixed(o + 12) });
  }
  return out;
}

/** @param {Buffer} buf */
function nameRecords(buf) {
  if (buf.length < 6) return [];
  const count = buf.readUInt16BE(2);
  const strings = buf.readUInt16BE(4);
  /** @type {{ id: number, text: string, lang: number, platform: number }[]} */
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const lang = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    if (id !== 1 && id !== 2 && id !== 16 && id !== 17) continue;
    const len = buf.readUInt16BE(r + 8);
    const at = strings + buf.readUInt16BE(r + 10);
    if (at + len > buf.length) continue;
    const raw = buf.subarray(at, at + len);
    let text;
    if (platform === 3 || platform === 0) text = utf16be(raw);
    else if (platform === 1 && encoding === 0) text = raw.toString('latin1');
    else continue;
    text = text.replace(/\0/g, '').trim();
    if (text) out.push({ id, text, lang, platform });
  }
  return out;
}

const utf16be = (/** @type {Buffer} */ raw) => {
  const swapped = Buffer.from(raw);
  if (swapped.length % 2) return '';
  swapped.swap16();
  return swapped.toString('utf16le');
};

/* Windows language ids of the CJK names a font may carry, and the OS/2 code page bits for the same scripts */
const LANG = /** @type {const} */ ([
  [[0x804, 0x404, 0xc04, 0x1004, 0x1404], 'zh-CN'],
  [[0x411], 'ja-JP'],
  [[0x412], 'ko-KR'],
]);

/** @param {{ lang: number, platform: number }[]} names @param {Buffer | null} os2 @returns {FontOption['locale']} */
function localeOf(names, os2) {
  for (const [langs, locale] of LANG) {
    if (names.some((n) => n.platform === 3 && /** @type {readonly number[]} */ (langs).includes(n.lang))) return locale;
  }
  if (os2 && os2.length >= 82) {
    const pages = os2.readUInt32BE(78);
    if (pages & ((1 << 18) | (1 << 20))) return 'zh-CN';
    if (pages & (1 << 17)) return 'ja-JP';
    if (pages & ((1 << 19) | (1 << 21))) return 'ko-KR';
  }
  return 'latin';
}
