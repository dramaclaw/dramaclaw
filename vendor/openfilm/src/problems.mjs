// @ts-check
/**
 * What went wrong lately, kept so a person can say why when something does not work: one line per problem (an agent
 * that did not start or answer, an export that failed, an error Studio did not expect) in `logs/problems.jsonl` in
 * Studio's home. Written always, not only in Developer mode, and small: the last KEEP_DAYS days, at most KEEP_MAX
 * lines. Each says what failed and why in a line, and where its details are (a turn's log, Studio's log); the details
 * stay there.
 *
 * What goes in is tidied first: the home folder reads ~, and keys, tokens and email addresses are taken out
 * (`redact`). The desktop app writes here too (OPENFILM_HOME is the same), so Studio's report has its agents'
 * problems.
 *
 * Reads no Studio module, so the command and the desktop app can use it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { studioHomeDir } from './locations.mjs';

/** How long a problem is kept, and how many are. */
export const KEEP_DAYS = 14;
export const KEEP_MAX = 500;
/** A line's longest field: a message, what stderr said. */
const FIELD_MAX = 2000;
/** Past this size the file is trimmed to KEEP_DAYS and KEEP_MAX as the next problem is written. */
const TRIM_AT = 256 * 1024;

/** @param {string} [home] Studio's home */
export const problemsFile = (home = studioHomeDir()) => join(home, 'logs', 'problems.jsonl');

/**
 * Text with what must not leave the computer taken out: the home folder as ~, keys (sk-…, a bearer token, a key or
 * token named in a setting or an address), and email addresses.
 * @param {string} text @param {string} [home]
 */
export function redact(text, home = homedir()) {
  let out = String(text);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, '$1 (hidden)')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{12,}/g, '(key hidden)')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"'&,}]{6,}/gi, '$1(hidden)')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '(email)');
}

/** @param {unknown} value */
const field = (value) => {
  const text = redact(typeof value === 'string' ? value : JSON.stringify(value));
  return text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX - 1)}…` : text;
};

/**
 * @typedef {{ t: string, area: 'agent' | 'export' | 'studio' | string, what: string, agent?: string, agentId?: string,
 *             version?: string, step?: string, code?: string, project?: string, log?: string, stderr?: string,
 *             ownLogs?: string }} Problem
 * `what`: the message, in a line. `agent`: its name, `agentId` the app's id for it. `log`: its turn's log (in
 * `.film/logs/` of the project). `ownLogs`: where the agent keeps its own logs (Codex: ~/.codex).
 */

/**
 * Keep a problem. Never throws: a problem that cannot be kept does not become another.
 * @param {Omit<Problem, 't'> & { t?: string }} problem @param {{ file?: string, now?: Date }} [options]
 */
export function recordProblem(problem, { file = problemsFile(), now = new Date() } = {}) {
  try {
    /** @type {Record<string, string>} */
    const line = { t: problem.t ?? now.toISOString() };
    for (const [key, value] of Object.entries(problem)) {
      if (key !== 't' && value != null && value !== '') line[key] = key === 'what' ? field(value).replace(/\s+/g, ' ').trim() : field(value);
    }
    if (!line.what) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    if (statSync(file).size > TRIM_AT) trimProblems({ file, now });
  } catch { /* not kept */ }
}

/** @param {string} file @returns {Problem[]} */
function readAll(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { const p = line ? JSON.parse(line) : null; return p && typeof p.t === 'string' && typeof p.what === 'string' ? [p] : []; } catch { return []; }
  });
}

/**
 * The problems of the last `days` days, oldest first (by their time: two processes write here), the last `max` of them.
 * @param {{ file?: string, days?: number, max?: number, now?: Date }} [options]
 */
export function recentProblems({ file = problemsFile(), days = KEEP_DAYS, max = KEEP_MAX, now = new Date() } = {}) {
  const since = now.getTime() - days * 86_400_000;
  return readAll(file).filter((p) => Date.parse(p.t) >= since).sort((a, b) => Date.parse(a.t) - Date.parse(b.t)).slice(-max);
}

/**
 * The file cut to what is kept: KEEP_DAYS days, KEEP_MAX lines.
 * @param {{ file?: string, now?: Date }} [options]
 */
export function trimProblems({ file = problemsFile(), now = new Date() } = {}) {
  try {
    if (!existsSync(file)) return;
    const kept = recentProblems({ file, now });
    writeFileSync(file, kept.map((p) => JSON.stringify(p)).join('\n') + (kept.length ? '\n' : ''));
  } catch { /* as it was */ }
}

/**
 * A problem as one line of the report: when (local time, to the minute), what it was about, what it said. No project,
 * no turn: those are in the file the full report exports.
 * @param {Problem} p
 */
export function problemLine(p) {
  const at = new Date(p.t);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const when = Number.isNaN(at.getTime()) ? p.t : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const about = [p.agent ? `${p.agent}${p.version ? ` ${p.version}` : ''}` : p.area, p.step].filter(Boolean).join(' · ');
  const what = p.what.length > 240 ? `${p.what.slice(0, 239)}…` : p.what;
  return `${when}  ${about}  ${what}`;
}

/**
 * The report's lines for the problems of the last `days` days: the last `count`, newest last; none when there are none.
 * @param {{ file?: string, days?: number, count?: number, now?: Date }} [options]
 */
export function problemLines({ file = problemsFile(), days = 7, count = 10, now = new Date() } = {}) {
  const all = recentProblems({ file, days, now });
  if (!all.length) return [];
  const shown = all.slice(-count);
  return [
    `Problems in the last ${days} days (${all.length}${all.length > shown.length ? `, the last ${shown.length}` : ''}):`,
    ...shown.map((p) => `  ${problemLine(p)}`),
  ];
}
