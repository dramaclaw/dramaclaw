// @ts-check
/**
 * Settings → Developer's diagnostic file: one zip with everything that says why something went wrong lately, for a
 * person to look at and then attach to an issue. The copied report is short; this is the rest of it:
 *
 *   report.txt          the report the page copies (`openfilm doctor`, the browser, the desktop app's agents)
 *   problems.jsonl      the problems of the last KEEP_DAYS days (src/problems.mjs)
 *   logs/…              the last of each log Studio and the desktop app write (OPENFILM_APP_LOGS)
 *   turns/…             the logs of the turns the last agent problems were in. Unless `conversations`, only how they
 *                       went (turnLogForFile): never a word the person or the agent wrote, a tool's title, command,
 *                       input or output, or anything from the person's files
 *   agents/codex.txt    Codex's own warnings and errors around each of its problems, from its log database
 *
 * Everything in it is redacted as problems are (the home folder as ~, no keys, tokens or email addresses).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { exportsDefault, studioHomeDir } from '../../src/locations.mjs';
import { KEEP_DAYS, problemsFile, recentProblems, redact } from '../../src/problems.mjs';
import { zipFiles } from './zip.mjs';

/** The most of a log that goes in: its end. */
const LOG_TAIL = 1 << 20;
/** How many of the last agent problems bring their turn's log, and how much of each. */
const TURNS_MAX = 5;
const TURN_MAX = 2 << 20;
/** Codex's log around a problem: from this long before it to this long after. */
const CODEX_BEFORE_S = 120;
const CODEX_AFTER_S = 15;

/** A path a problem wrote with the home folder as ~, back to where it is. @param {string} path */
const expand = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : path);

/** The end of a file, from a whole line. @param {string} file @param {number} max */
function tail(file, max) {
  const text = readFileSync(file, 'utf8');
  return text.length > max ? text.slice(text.length - max).replace(/^[^\n]*\n/, '') : text;
}

/* what a turn's log says of how it went, never what was said: kept whole */
const TURN_KINDS = new Set(['start', 'done', 'exit', 'cancel', 'set-option', 'steer-answer', 'permission-answer']);
/* the agent's own updates that say how it goes, not what it says or does */
const STATE_UPDATES = new Set(['notice', 'session_info_update', 'usage_update', 'current_mode_update', 'config_option_update', 'available_commands_update']);
/* asked of the person: that it was, and when, never what */
const ASKED = new Set(['permission', 'question', 'question-answer']);

/**
 * A turn's log as it goes in the file: whole with `conversations`; else only how it went: its start and how it ended,
 * the agent's notices and state, the prompt's agent, model and program without its words, each tool's step as its
 * kind, name, status and exit code (no title, command, input or output), and when it asked the person something.
 * @param {string} text @param {boolean} conversations
 */
export function turnLogForFile(text, conversations) {
  if (conversations) return text;
  return text.split('\n').flatMap((line) => {
    let e;
    try { e = line ? JSON.parse(line) : null; } catch { return []; }
    if (!e || typeof e !== 'object') return [];
    if (TURN_KINDS.has(e.kind)) return [line];
    if (e.kind === 'update' && STATE_UPDATES.has(e.update?.sessionUpdate)) return [line];
    if (e.kind === 'update' && (e.update?.sessionUpdate === 'tool_call' || e.update?.sessionUpdate === 'tool_call_update')) {
      const { sessionUpdate, toolCallId, name, kind, status } = e.update;
      const exitCode = e.update.rawOutput?.exit_code ?? e.update.rawOutput?.exitCode;
      return [JSON.stringify({ t: e.t, kind: 'update', update: { sessionUpdate, toolCallId, name, kind, status, ...(Number.isInteger(exitCode) ? { exitCode } : {}) } })];
    }
    if (ASKED.has(e.kind)) return [JSON.stringify({ t: e.t, kind: e.kind, words: '(left out)' })];
    if (e.kind === 'prompt') {
      const { t, kind, agent, meta, session, opened } = e;
      return [JSON.stringify({ t, kind, agent, model: meta?.model ?? null, agentInfo: session?.agentInfo ?? null,
        program: opened?.program ?? null, adapter: opened?.adapter ?? null, words: '(left out)' })];
    }
    return [];
  }).join('\n');
}

/**
 * Codex's own warnings and errors around these times (each problem's), from its log database (logs_*.sqlite in its
 * home), as text; null when there is none to read (no Codex, a Node without node:sqlite, a database it cannot open).
 * @param {string} dir Codex's home @param {number[]} times milliseconds
 */
export async function codexLogAround(dir, times) {
  if (!times.length || !existsSync(dir)) return null;
  const file = readdirSync(dir).filter((n) => /^logs_\d+\.sqlite$/.test(n)).sort().pop();
  if (!file) return null;
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return null; }
  let db;
  try {
    db = new sqlite.DatabaseSync(join(dir, file), { readOnly: true });
    const query = db.prepare("SELECT ts, level, target, feedback_log_body AS body FROM logs WHERE ts BETWEEN ? AND ? AND level IN ('ERROR', 'WARN') ORDER BY ts, ts_nanos LIMIT 400");
    const parts = times.map((ms) => {
      const at = Math.floor(ms / 1000);
      const rows = /** @type {{ ts: number, level: string, target: string, body: string | null }[]} */ (query.all(at - CODEX_BEFORE_S, at + CODEX_AFTER_S));
      return [`Around ${new Date(ms).toISOString()}:`, ...(rows.length ? rows.map((r) => `  ${new Date(r.ts * 1000).toISOString()} ${r.level} ${r.target} ${String(r.body ?? '').replace(/\s+/g, ' ').slice(0, 1000)}`) : ['  (nothing)'])].join('\n');
    });
    return redact(parts.join('\n\n'));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* closed */ }
  }
}

/** A name for the file, by the time: `OpenFilm diagnostics 2026-10-18 1013.zip`. @param {Date} now */
export function diagnosticsName(now) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `Dramaclaw diagnostics ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/**
 * Write the diagnostic file; → where it is.
 * @param {{ report: string, conversations?: boolean, folder?: string, home?: string, appLogs?: string | null, now?: Date }} options
 */
export async function exportDiagnostics({ report, conversations = false, folder = exportsDefault(), home = studioHomeDir(), appLogs = process.env.OPENFILM_APP_LOGS ?? null, now = new Date() }) {
  /** @type {{ name: string, data: Buffer }[]} */
  const entries = [];
  const add = (/** @type {string} */ name, /** @type {string} */ text) => entries.push({ name, data: Buffer.from(text) });

  add('report.txt', redact(report));
  const problems = recentProblems({ file: problemsFile(home), days: KEEP_DAYS, now });
  add('problems.jsonl', problems.map((p) => JSON.stringify(p)).join('\n') + (problems.length ? '\n' : ''));

  /* the logs: Studio's (its home's logs/) and the desktop app's (its own logs/), the end of each */
  for (const [under, dir] of /** @type {const} */ ([['studio', join(home, 'logs')], ['app', appLogs]])) {
    if (!dir || !isAbsolute(dir) || !existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.log')).sort()) {
      try { if (statSync(join(dir, name)).isFile()) add(`logs/${under}/${name}`, redact(tail(join(dir, name), LOG_TAIL))); } catch { /* unreadable */ }
    }
  }

  /* the turns of the last agent problems, each once */
  const turns = [...new Set(problems.filter((p) => p.area === 'agent' && typeof p.log === 'string').map((p) => expand(/** @type {string} */ (p.log))))].slice(-TURNS_MAX);
  for (const file of turns) {
    try { if (existsSync(file)) add(`turns/${basename(file)}`, redact(turnLogForFile(tail(file, TURN_MAX), conversations))); } catch { /* unreadable */ }
  }

  /* Codex's own log around each of its problems */
  const codex = problems.filter((p) => p.area === 'agent' && /^codex$/i.test(String(p.agentId ?? p.agent ?? '')));
  if (codex.length) {
    const dir = expand(String(codex.at(-1)?.ownLogs ?? join('~', '.codex')));
    const text = await codexLogAround(dir, codex.slice(-TURNS_MAX).map((p) => Date.parse(p.t)).filter(Number.isFinite));
    if (text) add('agents/codex.txt', text);
  }

  await mkdir(folder, { recursive: true });
  const out = join(folder, diagnosticsName(now));
  await zipFiles(out, entries);
  return { path: out, files: entries.map((e) => e.name), conversations };
}
