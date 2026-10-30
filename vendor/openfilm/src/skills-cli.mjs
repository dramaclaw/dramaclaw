// @ts-check
/**
 * `openfilm skills`, `openfilm skill <name>`, `openfilm skill add <address | folder>` and `openfilm skill remove
 * <name>` (src/skills.mjs): the skills a film can be made with, one read whole, one added to the person's own, one of
 * theirs moved to the trash. Each resolves to `{ ok, lines, usage? }`. Skills kept where they used to be are moved
 * first (migrateMySkills).
 *
 * Adding from an address is two steps for an app to show what came before it is kept: previewSkills fetches it into
 * a folder of its own beside the person's skills, commitSkills keeps it, discardSkills lets it go. A folder on this
 * computer is looked at where it is (previewFolder) and copied in when kept (addSkills).
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FILM_FILE } from './film-doc.mjs';
import { addSkills, findSkill, folderSize, holdsSkills, migrateMySkills, mySkillsDir, readSkill, removeSkill, skillText, skillsIn, usableSkills, PROJECT_SKILLS } from './skills.mjs';

/** The project around a folder (the nearest film.html above), or null. @param {string} from */
export function projectAround(from) {
  for (let up = resolve(from); up !== dirname(up); up = dirname(up)) if (existsSync(join(up, FILM_FILE))) return up;
  return null;
}

const SOURCE = { project: 'this project', mine: 'yours', official: 'official' };
/** a path as the person reads it: from the current folder when it is under it */
const shown = (/** @type {string} */ p) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') ? r : p; };

/**
 * `openfilm skills`: the skills the project around here (if any) can be made with: its own, the person's and the
 * official ones they installed, none they turned off (usableSkills).
 * @param {string} run
 */
export function skillsCommand(run, { cwd = process.cwd() } = {}) {
  migrateMySkills();
  const project = projectAround(cwd);
  const skills = usableSkills({ project });
  if (!skills.length) {
    return { ok: true, lines: [`No skills installed. Install OpenFilm's in Studio's Skills, or \`${run} skill add <GitHub address or folder>\` adds one to yours (${shown(mySkillsDir())}).`] };
  }
  const width = Math.min(28, Math.max(...skills.map((s) => s.name.length)));
  return {
    ok: true,
    lines: [
      `Skills${project ? ' for this film' : ''}. \`${run} skill <name>\` prints one: read it whole before you follow it.`,
      '',
      ...skills.flatMap((s) => [
        `  ${s.name.padEnd(width)}  ${SOURCE[s.source]}${s.over ? ` (in place of the ${s.over.map((o) => SOURCE[o]).join(' and ')} one)` : ''} · ${shown(s.folder)}`,
        ...(s.description ? [`  ${' '.repeat(width)}  ${s.description}`] : []),
      ]),
    ],
  };
}

/** The skills in a folder: it one, or each in it (or in its skills/). @param {string} dir */
const skillsAt = (dir) => { const one = readSkill(dir, 'mine'); return one ? [one] : [...skillsIn(dir, 'mine'), ...skillsIn(join(dir, PROJECT_SKILLS), 'mine')]; };

/**
 * Fetch skills from a GitHub or GitLab address into a folder of their own beside the person's skills (never among
 * them), to be looked at before they are kept: `{ staging, skills }`, each skill with its size and whether one of the
 * same name is the person's already (`replaces`). Nothing fetched: the folder is gone and this throws.
 * @param {string} url @param {{ mine?: string, fetch?: (url: string, into: string) => Promise<string> }} [opts]
 */
export async function previewSkills(url, { mine = mySkillsDir(), fetch = fetchSkill } = {}) {
  await mkdir(mine, { recursive: true });
  const work = await mkdtemp(join(mine, '.adding-'));
  try {
    const staging = await fetch(url, work);
    /* the address, for commitSkills to keep as where they came from */
    writeFileSync(join(work, '.from'), url);
    const found = skillsAt(staging);
    if (!found.length || !holdsSkills(staging)) throw new Error(`There is no SKILL.md in ${url}: it is not a skill.`);
    return { staging: work, skills: looked(found, mine) };
  } catch (e) {
    await rm(work, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Skills as they are looked at before they are kept: each with its size and whether it replaces one of the person's. */
const looked = (/** @type {import('./skills.mjs').Skill[]} */ found, /** @type {string} */ mine) => {
  const mineNow = new Set(skillsIn(mine, 'mine').map((s) => s.name));
  return found.map((s) => ({ ...s, size: folderSize(s.folder), replaces: mineNow.has(s.name) }));
};

/**
 * The skills in a folder on this computer, looked at where they are before they are copied in (addSkills): as
 * previewSkills gives them (a SKILL.md given: its folder). A folder that is not a skill, or one of the person's own
 * already, throws.
 * @param {string} folder @param {{ mine?: string }} [opts]
 */
export function previewFolder(folder, { mine = mySkillsDir() } = {}) {
  /* a skill's SKILL.md stands for its folder */
  const src = basename(folder) === 'SKILL.md' ? dirname(resolve(folder)) : resolve(folder);
  const inside = relative(resolve(mine), src);
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error('This folder is among your skills already.');
  let found = [];
  try { if (statSync(src).isDirectory()) found = skillsAt(src); } catch { /* not there */ }
  if (!found.length) throw new Error(`There is no SKILL.md in ${folder}: it is not a skill.`);
  return { folder: src, skills: looked(found, mine) };
}

/** A fetched folder (previewSkills' `staging`) only: one in the person's skills folder, made for a fetch. */
const ownFetch = (/** @type {string} */ staging, /** @type {string} */ mine) => resolve(dirname(staging)) === resolve(mine) && /^\.adding-/.test(staging.split(/[\\/]/).pop() ?? '');

/** Keep what previewSkills fetched: added to the person's own (one of the same name to the trash). → the skills kept. */
export async function commitSkills(/** @type {string} */ staging, { mine = mySkillsDir(), covers = /** @type {Record<string, string>} */ ({}) } = {}) {
  if (!ownFetch(staging, mine)) throw new Error('Nothing is waiting to be added.');
  try {
    const [fetched] = readdirSync(staging).filter((n) => !n.startsWith('.')).map((n) => join(staging, n));
    if (!fetched) throw new Error('Nothing is waiting to be added.');
    let address = '';
    try { address = readFileSync(join(staging, '.from'), 'utf8').trim(); } catch { /* fetched before addresses were kept */ }
    return await addSkills(fetched, { mine, covers, ...(address ? { origin: { from: 'link', address } } : {}) });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Let go of what previewSkills fetched (it was never the person's). */
export async function discardSkills(/** @type {string} */ staging, { mine = mySkillsDir() } = {}) {
  if (ownFetch(staging, mine)) await rm(staging, { recursive: true, force: true }).catch(() => {});
}

/**
 * Add skills to the person's own from a GitHub or GitLab address (fetched without its history) or a folder on this
 * computer (copied): one skill, or a folder of them. → the skills added.
 * @param {string} from @param {{ cwd?: string, mine?: string, fetch?: (url: string, into: string) => Promise<string> }} [opts]
 */
export async function addSkillFrom(from, { cwd = process.cwd(), mine = mySkillsDir(), fetch = fetchSkill } = {}) {
  if (!/^https?:\/\//i.test(from)) {
    if (!existsSync(resolve(cwd, from))) throw Object.assign(new Error(`there is no folder ${from}`), { code: 'url' });
    return addSkills(resolve(cwd, from), { mine });
  }
  const { staging } = await previewSkills(from, { mine, fetch });
  return commitSkills(staging, { mine });
}

/**
 * `openfilm skill <name>`, or `openfilm skill add <address | folder>`.
 * @param {string[]} args @param {string} run @param {Parameters<typeof addSkillFrom>[1]} [opts]
 */
export async function skillCommand(args, run, opts = {}) {
  migrateMySkills();
  const [first, second] = args;
  if (!first) return { ok: false, usage: true, lines: [`${run} skill <name> prints a skill; ${run} skill add <GitHub address or folder> adds one. ${run} skills lists them.`] };
  if (first === 'add') {
    if (!second) return { ok: false, usage: true, lines: [`${run} skill add <GitHub address or folder>`] };
    try {
      const added = await addSkillFrom(second, opts);
      return {
        ok: true,
        lines: added.flatMap((s) => [
          `Added ${s.name}${s.description ? `: ${s.description}` : ''}`,
          `  ${shown(s.folder)}`,
          ...(s.scripts.length ? [`  It brings scripts an agent can run: ${s.scripts.join(', ')}`] : []),
        ]).concat(added.some((s) => s.scripts.length) ? ['A skill\'s scripts run with your agent\'s access: keep only skills you trust.'] : []),
      };
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      return { ok: false, usage: code === 'url' || code === 'host', lines: [`${run} skill add: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  if (first === 'remove') {
    if (!second) return { ok: false, usage: true, lines: [`${run} skill remove <name>`] };
    const gone = await removeSkill(second, opts.mine ? { mine: opts.mine } : {});
    return gone ? { ok: true, lines: [`Moved ${second} to the trash: you can take it back from there.`] }
      : { ok: false, usage: true, lines: [`${run} skill remove: ${second} is not one of yours (${shown(opts.mine ?? mySkillsDir())}).`] };
  }
  const skill = findSkill(first, { project: projectAround(opts.cwd ?? process.cwd()), ...(opts.mine ? { mine: opts.mine } : {}) });
  if (!skill) return { ok: false, usage: true, lines: [`${run} skill: no skill ${first}. \`${run} skills\` lists them.`] };
  return { ok: true, lines: [skillText(skill)] };
}

/** A skill on GitHub or GitLab, fetched into a folder of `into` (src/../studio/server/fetch-repo.mjs). */
async function fetchSkill(/** @type {string} */ url, /** @type {string} */ into) {
  const { fetchFilm, parseRepoUrl } = await import('../studio/server/fetch-repo.mjs');
  return fetchFilm(parseRepoUrl(url), { library: into, skill: true });
}
