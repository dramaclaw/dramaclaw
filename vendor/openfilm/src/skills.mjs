// @ts-check
/**
 * Skills: ways of making a kind of film that an agent takes up when asked. A skill is a folder in the Agent Skills
 * format (agentskills.io): a `SKILL.md` whose front matter names it and says what it is for (`name`, `description`),
 * its body the way to work, and any files it brings (scripts, templates, libraries). A skill never changes OpenFilm
 * itself: what it makes is pages and media in the project, like anything else an agent writes.
 *
 * Three places hold them, the first a name is found in winning:
 *   project    `<project>/skills/<name>/`, kept with the project, so a film carries the ways it was made
 *   mine       `Skills/` beside the projects library (~/Movies/OpenFilm/Skills on macOS, ~/Videos/OpenFilm/Skills
 *              elsewhere; OPENFILM_SKILLS to name another): the person's own, and those they added. In sight beside
 *              their Projects and Exports, backed up with them, and never in Studio's own folder, which a reset clears.
 *              Skills kept in Studio's home before (~/.openfilm/skills) are moved there (migrateMySkills).
 *   official   `skills/` in this package, released with OpenFilm
 *
 * Nothing here deletes a skill outright: one replaced or removed goes to the system's trash.
 *
 * `openfilm skills` lists them and `openfilm skill <name>` prints one, as `openfilm` prints the manual: that is how any
 * agent reads a skill. The desktop app's chat offers the same list (apps/desktop).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { moveToTrash } from '../studio/server/trash.mjs';
import { pictureType } from '../studio/server/cover.mjs';
import { libraryDefault, setSharedPref, sharedPref } from './locations.mjs';

const mkdirSyncSafe = (/** @type {string} */ dir) => mkdirSync(dir, { recursive: true });
/** a folder moved to another place: renamed, else (another disk) copied and then removed */
function renameSyncSafe(/** @type {string} */ from, /** @type {string} */ to) {
  try { renameSync(from, to); } catch (e) {
    if (/** @type {any} */ (e)?.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

export const SKILL_FILE = 'SKILL.md';
/** The project's own skills, beside film.html. */
export const PROJECT_SKILLS = 'skills';
/** The places skills are looked for, the first winning a name. */
export const SKILL_SOURCES = /** @type {const} */ (['project', 'mine', 'official']);
/** @typedef {typeof SKILL_SOURCES[number]} SkillSource */

/**
 * The official skills, released with this package (a copy of openfilm/skills: `pnpm skills:sync`).
 * OPENFILM_OFFICIAL_SKILLS names another folder of them: a checkout's skills/, while they are being changed.
 */
export const officialSkillsDir = () => process.env.OPENFILM_OFFICIAL_SKILLS || join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
/**
 * The person's own skills: OPENFILM_SKILLS, else `Skills/` beside the default projects library (OPENFILM_LIBRARY, else
 * ~/Movies/OpenFilm/Projects on macOS, ~/Videos/OpenFilm/Projects elsewhere: locations.mjs libraryDefault). They stay
 * there when new projects are set to go elsewhere.
 */
export const mySkillsDir = () => process.env.OPENFILM_SKILLS || join(dirname(libraryDefault()), 'Skills');
/** Where the person's own skills were kept before: `skills/` in Studio's home. */
export const oldSkillsDir = () => join(process.env.OPENFILM_HOME || join(homedir(), '.openfilm'), 'skills');

/** A note left where the skills were, saying where they went. */
const MOVED_NOTE = 'README.txt';

/**
 * Move the person's own skills from where they were kept before (Studio's home) to their place beside the projects.
 * Each skill whose name is free there goes; one whose name is taken stays, and the note left says so. Run whenever the
 * skills are listed; it does nothing once they have moved. → the names moved.
 * @param {{ from?: string, to?: string }} [where]
 */
export function migrateMySkills({ from = oldSkillsDir(), to = mySkillsDir() } = {}) {
  if (resolve(from) === resolve(to) || !existsSync(from)) return [];
  const waiting = skillsIn(from, 'mine');
  if (!waiting.length) return [];
  /** @type {string[]} */
  const moved = [];
  /** @type {string[]} */
  const kept = [];
  try { mkdirSyncSafe(to); } catch { return []; }
  for (const skill of waiting) {
    const target = join(to, basename(skill.folder));
    if (existsSync(target)) { kept.push(basename(skill.folder)); continue; }
    try { renameSyncSafe(skill.folder, target); moved.push(skill.name); } catch { kept.push(basename(skill.folder)); }
  }
  try {
    writeFileSync(join(from, MOVED_NOTE), `Your OpenFilm skills are kept in ${to} now.
${kept.length ? `These stayed here, as a skill of the same name is there: ${kept.join(', ')}.
` : ''}`);
  } catch { /* the note is only a courtesy */ }
  return moved;
}

/** a skill's name, as the format allows it: lowercase letters, digits and dashes */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The front matter of a SKILL.md: its flat `key: value` lines, values plain, quoted, or a block (`|`, `>`) of the
 * lines indented under them. Enough for `name` and `description`; anything else is kept as text.
 * @param {string} text
 * @returns {{ fields: Record<string, string>, body: string }}
 */
export function parseSkillFile(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text.trim() };
  /** @type {Record<string, string>} */
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, raw] = kv;
    let value = raw.trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i]);
      const indent = Math.min(...block.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0));
      const kept = block.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      value = (value.startsWith('>') ? kept.join(' ').replace(/\s+/g, ' ') : kept.join('\n')).trim();
    } else if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
    } else if (/^'.*'$/.test(value)) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      /* a plain value may go on over the lines indented under it */
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) value += ` ${lines[++i].trim()}`;
    }
    fields[key] = value;
  }
  return { fields, body: text.slice(m[0].length).trim() };
}

/**
 * @typedef {{ name: string, description: string, folder: string, source: SkillSource, file: string,
 *   scripts: string[], over?: SkillSource[], shown?: SkillShown, version?: string } & SkillLook} Skill
 *   `over`: the places that had a skill of the same name, which this one takes the place of. `version`: its
 *   openfilm.json's, else its front matter's.
 * @typedef {{ title: Record<string, string>, summary: Record<string, string>, details?: Record<string, string> }} SkillShown
 *   how people see it in an app (openfilm.json beside SKILL.md, optional): a title, a one-line summary and a few lines
 *   on who it is for and what it does, by language (`en`, `zh-CN`…); the SKILL.md's description is for the agent
 * @typedef {{ kind?: 'workflow' | 'style', order?: number, icon?: string, cover?: string, preview?: string, repository?: string }} SkillLook
 *   where an app shows it (openfilm.json, each optional): `kind` a way of working or a look, `order` among its kind,
 *   `icon` a mark's name, `cover` a picture and `preview` a video in its folder, `repository` where its source is read
 */

/** The words of an openfilm.json field: a string (any language), or one per language; anything else is none. */
const byLanguage = (/** @type {unknown} */ v, max = 200) => (typeof v === 'string' && v.trim() ? { en: v.trim().slice(0, max) }
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, w]) => /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(k) && typeof w === 'string' && w.trim()).map(([k, w]) => [k, String(w).trim().slice(0, max)])) : {});

/** A file named by openfilm.json, when it is one in the skill's folder. @param {string} folder @param {unknown} name */
const fileIn = (folder, name) => (typeof name === 'string' && /^[\w./-]{1,200}$/.test(name) && !name.split('/').includes('..')
  && existsSync(join(folder, name)) ? name : undefined);

/**
 * A skill's openfilm.json: how people see it and where an app shows it (anything missing or wrong left out).
 * @param {string} folder @returns {{ shown?: SkillShown, version?: string } & SkillLook}
 */
function openfilmJson(folder) {
  let raw;
  try { raw = JSON.parse(readFileSync(join(folder, 'openfilm.json'), 'utf8')); } catch { return {}; }
  const details = byLanguage(raw?.details, 1000);
  /** @type {SkillShown} */
  const shown = { title: byLanguage(raw?.title), summary: byLanguage(raw?.summary), ...(Object.keys(details).length ? { details } : {}) };
  /** @type {{ shown?: SkillShown, version?: string } & SkillLook} */
  const out = {};
  if (Object.keys(shown.title).length || Object.keys(shown.summary).length) out.shown = shown;
  if (typeof raw?.version === 'string' && VERSION.test(raw.version)) out.version = raw.version;
  if (raw?.kind === 'workflow' || raw?.kind === 'style') out.kind = raw.kind;
  if (Number.isFinite(raw?.order)) out.order = raw.order;
  if (typeof raw?.icon === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(raw.icon)) out.icon = raw.icon;
  if (typeof raw?.repository === 'string' && /^https:\/\/[^\s]{4,300}$/.test(raw.repository)) out.repository = raw.repository;
  const cover = fileIn(folder, raw?.cover), preview = fileIn(folder, raw?.preview);
  if (cover) out.cover = cover;
  if (preview) out.preview = preview;
  return out;
}

const VERSION = /^\d+\.\d+(\.\d+)?([-+][\w.]+)?$/;

/**
 * The skill in one folder, or null when it has no SKILL.md. Its name is the front matter's, else the folder's.
 * @param {string} folder @param {SkillSource} source @returns {Skill | null}
 */
export function readSkill(folder, source) {
  const file = join(folder, SKILL_FILE);
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const { fields } = parseSkillFile(text);
  const name = (fields.name || basename(folder)).trim();
  const extra = openfilmJson(folder);
  if (!extra.version && fields.version && VERSION.test(fields.version.trim())) extra.version = fields.version.trim();
  return { name, description: (fields.description ?? '').trim(), folder, source, file, scripts: scriptsIn(folder), ...extra };
}

/** The scripts a skill brings (any file under scripts/, and executables anywhere), for the person to see. */
function scriptsIn(/** @type {string} */ folder) {
  /** @type {string[]} */
  const found = [];
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel, depth = 0) => {
    if (depth > 4 || found.length >= 50) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), path, depth + 1);
      else if (rel.split('/')[0] === 'scripts' || /\.(sh|py|mjs|cjs|js|ts|rb|pl|ps1|bat|cmd)$/i.test(e.name)) found.push(path);
    }
  };
  walk(folder, '');
  return found.sort();
}

/** The skills in one place: each folder in it with a SKILL.md. @param {string} dir @param {SkillSource} source */
export function skillsIn(dir, source) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith('.')).flatMap((n) => {
    const folder = join(dir, n);
    try { if (!statSync(folder).isDirectory()) return []; } catch { return []; }
    const skill = readSkill(folder, source);
    return skill ? [skill] : [];
  });
}

/**
 * Every skill available to a project (or none: only the person's own and the official ones), by name, the first
 * place holding a name winning; sorted by name.
 * @param {{ project?: string | null, mine?: string, official?: string }} [where]
 * @returns {Skill[]}
 */
export function listSkills({ project = null, mine = mySkillsDir(), official = officialSkillsDir() } = {}) {
  /** @type {Map<string, Skill>} */
  const byName = new Map();
  const places = /** @type {Array<[string | null, SkillSource]>} */ ([[project ? join(project, PROJECT_SKILLS) : null, 'project'], [mine, 'mine'], [official, 'official']]);
  for (const [dir, source] of places) {
    if (!dir) continue;
    for (const skill of skillsIn(dir, source)) {
      const first = byName.get(skill.name);
      if (first) first.over = [...(first.over ?? []), source];
      else byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Which skills agents get. The official ones are a catalog: one is installed to be used (`skillsInstalled`); the
 * person's own and a project's are theirs already. Any of them can be turned off (`skillsOff`) and stays where it is,
 * offered to no agent until it is turned on again. Both are kept in the shared prefs.json, so every OpenFilm on this
 * computer agrees; `home`: the Studio home that holds it.
 */
const namesIn = (/** @type {unknown} */ value) => (Array.isArray(value) ? [...new Set(value.filter((n) => typeof n === 'string' && SKILL_NAME.test(n)))].sort() : []);

/** The official skills the person installed, by name. @param {string} [home] @returns {string[]} */
export function skillsInstalled(home) {
  return namesIn(sharedPref('skillsInstalled', home));
}

/** The skills the person turned off, by name. @param {string} [home] @returns {string[]} */
export function skillsOff(home) {
  return namesIn(sharedPref('skillsOff', home));
}

/** @param {'skillsInstalled' | 'skillsOff'} key @param {string} name @param {boolean} present @param {string} [home] */
function keepName(key, name, present, home) {
  if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a skill's name.`);
  const names = new Set(namesIn(sharedPref(key, home)));
  if (present) names.add(name); else names.delete(name);
  setSharedPref(key, [...names].sort(), home);
}

/** Turn a skill on or off, by name. @param {string} name @param {boolean} on @param {string} [home] */
export function setSkillOn(name, on, home) {
  keepName('skillsOff', name, !on, home);
}

/** Install an official skill (it starts on), or uninstall it. @param {string} name @param {boolean} installed @param {string} [home] */
export function setSkillInstalled(name, installed, home) {
  keepName('skillsInstalled', name, installed, home);
  if (installed) keepName('skillsOff', name, false, home);
}

/**
 * The skills agents get for a project: listSkills's, but the official ones not installed and any turned off.
 * @param {Parameters<typeof listSkills>[0] & { home?: string }} [where]
 */
export function usableSkills({ home, ...where } = {}) {
  const installed = new Set(skillsInstalled(home));
  const off = new Set(skillsOff(home));
  return listSkills(where).filter((s) => (s.source !== 'official' || installed.has(s.name)) && !off.has(s.name));
}

/** One skill by name, as listSkills finds it, or null. @param {string} name @param {Parameters<typeof listSkills>[0]} [where] */
export function findSkill(name, where) {
  return listSkills(where).find((s) => s.name === name) ?? null;
}

/**
 * A skill as an agent reads it: its name, where its files are (only read: what a film uses is copied into the
 * project), and its SKILL.md whole.
 * @param {Skill} skill
 */
export function skillText(skill) {
  return `<skill name="${skill.name}" folder="${skill.folder}">\n${readFileSync(skill.file, 'utf8').trim()}\n</skill>`;
}

/**
 * Add a skill to the person's own (`mine`): a folder on this computer, copied; or one fetched by the caller into
 * `from` (a GitHub or GitLab address, studio/server/fetch-repo.mjs). A folder holding several skills (each a folder
 * with a SKILL.md) adds them all. One of the same name is replaced. → the skills added.
 * Where each came from is kept beside them (skillOrigins).
 * @param {string} from @param {{ mine?: string, move?: boolean, origin?: SkillOrigin, covers?: Record<string, string> }} [opts]  `move`: the folder is a
 *   download of the caller's; `origin`: where it came from (default: the folder)
 * @returns {Promise<Skill[]>}
 */
export async function addSkills(from, { mine = mySkillsDir(), move = false, origin = { from: 'folder', address: resolve(from) }, covers = {} } = {}) {
  const src = resolve(from);
  const one = readSkill(src, 'mine');
  const found = one ? [one] : skillsIn(src, 'mine').concat(skillsIn(join(src, PROJECT_SKILLS), 'mine'));
  if (!found.length) throw new Error(`There is no ${SKILL_FILE} in ${from}: it is not a skill.`);
  /* Validate all chosen covers before moving or replacing any skill. */
  const pictures = new Map(found.filter((s) => Object.hasOwn(covers, s.name)).map((s) => [s.name, coverPicture(covers[s.name])]));
  await mkdir(mine, { recursive: true });
  /** @type {Skill[]} */
  const added = [];
  for (const skill of found) {
    const name = SKILL_NAME.test(skill.name) ? skill.name : basename(skill.folder).toLowerCase().replace(/[^a-z0-9-]+/g, '-').split('-').filter(Boolean).join('-') || 'skill';
    const to = join(mine, name);
    const staging = `${to}.adding-${process.pid}`;
    await rm(staging, { recursive: true, force: true });
    if (move && found.length === 1) await rename(skill.folder, staging);
    else await cp(skill.folder, staging, { recursive: true, filter: (p) => basename(p) !== '.git' });
    const picture = pictures.get(skill.name);
    if (picture) writeSkillCover(staging, picture);
    /* one of the same name is replaced: the one there goes to the trash, never deleted */
    if (existsSync(to)) await moveToTrash(to);
    await rename(staging, to);
    const kept = readSkill(to, 'mine');
    if (kept) added.push(kept);
  }
  noteOrigins(mine, Object.fromEntries(added.map((k) => [basename(k.folder), { ...origin, added: new Date().toISOString() }])));
  return added;
}

/**
 * A chosen raster picture, bounded before decoding; never an SVG or an arbitrary file. Its format is what its bytes
 * are, whatever type the browser gave it from the file's name (a JPEG named .png is still a JPEG). @param {string} data
 */
function coverPicture(data) {
  if (typeof data !== 'string' || data.length > 7 * 1024 * 1024) throw new Error('Skill cover exceeds 5 MB.');
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw new Error('Skill cover must be a PNG, JPEG or WebP image.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > 5 * 1024 * 1024) throw new Error('Skill cover exceeds 5 MB.');
  const extension = pictureType(bytes);
  if (extension !== 'png' && extension !== 'jpg' && extension !== 'webp') throw new Error('Skill cover must be a PNG, JPEG or WebP image.');
  return { bytes, extension };
}

/* the name a cover chosen in OpenFilm is saved under: only such a file is removed when the cover changes */
const CHOSEN_COVER = /^openfilm-cover-[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

/** Replace the metadata atomically. The previous cover's file goes only when OpenFilm saved it (CHOSEN_COVER); a
 * picture of the skill's own stays, as its content may use it.
 * @param {string} folder @param {{ bytes: Buffer, extension: string } | null} picture */
function writeSkillCover(folder, picture) {
  const metadataFile = join(folder, 'openfilm.json');
  /** @type {Record<string, unknown>} */
  let metadata = {};
  try { metadata = JSON.parse(readFileSync(metadataFile, 'utf8')); } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') throw new Error('Cannot update the skill\'s openfilm.json.', { cause: e });
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Cannot update the skill\'s openfilm.json.');
  const previous = metadata.cover;
  const file = picture ? `openfilm-cover-${randomUUID()}.${picture.extension}` : null;
  const temporary = join(folder, `.openfilm-${randomUUID()}.json`);
  let wrotePicture = false;
  try {
    if (picture && file) { writeFileSync(join(folder, file), picture.bytes, { flag: 'wx' }); wrotePicture = true; metadata.cover = file; }
    else delete metadata.cover;
    writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
    /* Rename replaces a metadata symlink itself, without writing through it to the source. */
    renameSync(temporary, metadataFile);
  } catch (e) {
    if (wrotePicture && file) rmSync(join(folder, file), { force: true });
    throw e;
  } finally { rmSync(temporary, { force: true }); }
  if (typeof previous === 'string' && previous !== file && CHOSEN_COVER.test(previous)) rmSync(join(folder, previous), { force: true });
}

/** Change only a person's own installed skill. Null removes its cover: a picture of the skill's own stays.
 * @param {string} name @param {string | null} cover @param {{ mine?: string }} [where] */
export function setSkillCover(name, cover, { mine = mySkillsDir() } = {}) {
  const skill = skillsIn(mine, 'mine').find((s) => s.name === name);
  if (!skill) throw new Error('No personal skill with that name.');
  if (!realpathSync(skill.folder).startsWith(`${realpathSync(mine)}${sep}`)) throw new Error('The skill must be kept inside your skills folder.');
  writeSkillCover(skill.folder, cover === null ? null : coverPicture(cover));
  return readSkill(skill.folder, 'mine');
}

/**
 * @typedef {{ from: 'link' | 'folder', address: string, added?: string }} SkillOrigin
 *   where one of the person's skills came from: a GitHub or GitLab address, or a folder on this computer. One with
 *   none was made where it is (with the agent, or by hand).
 */

const ORIGINS = '.origins.json';

/** Where each of the person's skills came from, by its folder's name. @param {string} [mine] @returns {Record<string, SkillOrigin>} */
export function skillOrigins(mine = mySkillsDir()) {
  try {
    const raw = JSON.parse(readFileSync(join(mine, ORIGINS), 'utf8'));
    return Object.fromEntries(Object.entries(raw ?? {}).filter(([, o]) => (o?.from === 'link' || o?.from === 'folder') && typeof o.address === 'string'));
  } catch { return {}; }
}

/** Keep (or with null, forget) where skills came from. @param {string} mine @param {Record<string, SkillOrigin | null>} changes */
function noteOrigins(mine, changes) {
  const all = { ...skillOrigins(mine), ...changes };
  for (const [k, v] of Object.entries(all)) if (!v) delete all[k];
  try { writeFileSync(join(mine, ORIGINS), `${JSON.stringify(all, null, 2)}\n`); } catch { /* a skill without its origin is still a skill */ }
}

/**
 * Remove one of the person's own skills: to the system's trash, where it can be taken back. → whether it was there.
 * @param {string} name @param {{ mine?: string }} [where]
 */
export async function removeSkill(name, { mine = mySkillsDir() } = {}) {
  const skill = skillsIn(mine, 'mine').find((s) => s.name === name);
  if (!skill || resolve(dirname(skill.folder)) !== resolve(mine)) return false;
  await moveToTrash(skill.folder);
  noteOrigins(mine, { [basename(skill.folder)]: null });
  return true;
}

/** How many bytes a folder holds (its .git left out). @param {string} dir */
export function folderSize(dir) {
  let total = 0;
  const walk = (/** @type {string} */ d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir);
  return total;
}

/** Whether a folder holds a skill, or skills (each a folder with a SKILL.md, or under skills/). @param {string} dir */
export function holdsSkills(dir) {
  if (existsSync(join(dir, SKILL_FILE))) return true;
  return skillsIn(dir, 'mine').length > 0 || skillsIn(join(dir, PROJECT_SKILLS), 'mine').length > 0;
}
