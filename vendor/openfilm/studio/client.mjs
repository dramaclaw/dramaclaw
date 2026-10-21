// @ts-check
/**
 * The CLI's side of Studio: find the Studio running on this machine (~/.openfilm/run.json), or start one in the
 * background, and ask it to open a folder or get media for one. One Studio per machine, like one editor window per
 * project.
 */
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioHome, studioKey } from './server/projects.mjs';

const MAIN = fileURLToPath(new URL('./server/main.mjs', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
/** A source checkout (Studio's editor source is here): git pull updates it, not npm. */
export const FROM_SOURCE = existsSync(new URL('./ui/src', import.meta.url));

/** @typedef {{ pid?: number, supervisor?: number, origin: string, filmOrigin: string, key: string, version?: string, app?: boolean }} Running */

/** What a Studio says about itself, or null when nothing (or something else) answers at `origin`. */
async function health(/** @type {string} */ origin, ms = 1500) {
  try {
    const said = await (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(ms) })).json();
    return said?.product === 'openfilm-studio' ? said : null;
  } catch { return null; }
}

/**
 * The Studio that is running, if it answers: the one run.json names, else one of this home on the usual port (its
 * run.json was lost; it opens with the machine's key, so it can still be used).
 * @returns {Promise<Running | null>}
 */
export async function running() {
  /** @type {Running | null} */
  let run = null;
  try { run = JSON.parse(readFileSync(join(studioHome(), 'run.json'), 'utf8')); } catch { /* none advertised */ }
  if (run) {
    const said = await health(run.origin);
    if (said) return { ...run, version: said.version, ...(said.app ? { app: true } : {}) };
  }
  const given = Number(process.env.OPENFILM_STUDIO_PORT);
  const origin = `http://127.0.0.1:${Number.isInteger(given) && given > 0 ? given : 4747}`;
  const said = await health(origin);
  /* it says which home it serves as a hash of the path (the path itself is not told to anyone who asks) */
  if (said?.home !== createHash('sha256').update(studioHome()).digest('hex') || !said.filmOrigin) return null;
  return { origin, filmOrigin: said.filmOrigin, key: studioKey(), version: said.version, ...(said.app ? { app: true } : {}) };
}

/**
 * The Studio its supervisor is starting again after it ended (main.mjs): run.json names a supervisor still alive. It is
 * waited for (a few seconds), so a second Studio is not started beside it; null when there is none, or it is not back.
 * @returns {Promise<Running | null>}
 */
async function restarting() {
  /** @type {Running | null} */
  let run = null;
  try { run = JSON.parse(readFileSync(join(studioHome(), 'run.json'), 'utf8')); } catch { return null; }
  const supervisor = run?.supervisor;
  if (!supervisor) return null;
  try { process.kill(supervisor, 0); } catch { return null; }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const up = await running();
    if (up) return up;
  }
  return null;
}

/** Whether `version` (x.y.z) is older than this package's: an older Studio is replaced. */
export function olderThanThis(/** @type {string | undefined} */ version, mine = VERSION) {
  if (!version) return true;
  const a = version.split(/[.-]/).map(Number);
  const b = mine.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
  return false;
}

/**
 * What npm has: the latest openfilm (null when it was never learnt) and when it was asked. Asked of the registry at
 * most once a day (the answer kept in Studio's folder) unless `force`, never for more than `waitMs`, and never with
 * `network` false (only what was learnt before). A check that fails is no answer, and nothing else waits on it.
 * OPENFILM_NO_UPDATE_CHECK=1: never asked.
 * @param {{ network?: boolean, waitMs?: number, force?: boolean }} [options]
 * @returns {Promise<{ latest: string | null, checkedAt: number | null }>}
 */
export async function npmOpenfilm({ network = true, waitMs = 1500, force = false } = {}) {
  if (process.env.OPENFILM_NO_UPDATE_CHECK) return { latest: null, checkedAt: null };
  const file = join(studioHome(), 'update.json');
  /** @type {{ checkedAt?: number, latest?: string }} */
  let known = {};
  try { known = JSON.parse(readFileSync(file, 'utf8')); } catch { /* never asked */ }
  if (network && (force || !(Date.now() - (known.checkedAt ?? 0) < 24 * 3_600_000))) {
    try {
      const res = await fetch('https://registry.npmjs.org/openfilm/latest', { signal: AbortSignal.timeout(waitMs), headers: { accept: 'application/json' } });
      const latest = res.ok ? String((await res.json()).version ?? '') : '';
      if (/^\d+\.\d+\.\d+/.test(latest)) {
        known = { checkedAt: Date.now(), latest };
        mkdirSync(studioHome(), { recursive: true });
        writeFileSync(file, `${JSON.stringify(known)}\n`);
      }
    } catch { /* offline, or slow: asked again next time */ }
  }
  return { latest: known.latest ?? null, checkedAt: known.checkedAt ?? null };
}

/** A newer openfilm on npm than this one, or null (see npmOpenfilm). @param {{ network?: boolean, waitMs?: number }} [options] */
export async function newerOpenfilm(options) {
  const { latest } = await npmOpenfilm(options);
  return latest && olderThanThis(VERSION, latest) ? latest : null;
}

/** Whether the Studio at `origin` stops answering within `ms`. */
async function gone(/** @type {string} */ origin, /** @type {number} */ ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!(await health(origin, 500))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Ask a Studio to stop so a new one starts: once nothing is being exported or made. One that agreed and is still there
 * after a while (stuck) is ended. Pages open on it reconnect to the new one (same port, same key). `{ pages }`: how many
 * were open on it; `{ stays }`: why it stays (an export is running, media is being made, an app keeps it).
 * @returns {Promise<{ pages: number } | { stays: string }>}
 */
async function replace(/** @type {Running} */ old) {
  const res = await fetch(`${old.origin}/api/quit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-key': old.key },
    body: JSON.stringify({ whenIdle: true }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);
  const said = await res?.json().catch(() => null);
  if (res && !res.ok) return { stays: said?.error ?? `it answered ${res.status}` };
  const pages = Number(said?.pages) || 0;
  if (await gone(old.origin, 10_000)) return { pages };
  /* the supervisor first, or it would start the stuck one again */
  for (const pid of [old.supervisor, old.pid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone meanwhile */ } }
  return (await gone(old.origin, 3000)) ? { pages } : { stays: 'it did not stop' };
}

/**
 * The Studio on this machine, started in the background when there is none. `fresh`: one running is stopped and
 * started again (unless it is busy, or an app's), so whatever it was stuck on is gone. `say` tells the person it is
 * starting. `pages`: how many pages were open on the Studio it replaced.
 * @param {(line: string) => void} [say] @param {{ fresh?: boolean }} [options] @returns {Promise<Running & { pages?: number }>}
 */
export async function ensureStudio(say = () => {}, { fresh = false } = {}) {
  const found = (await running()) ?? (await restarting());
  if (found && !fresh && !olderThanThis(found.version)) return found;
  let pages = 0;
  if (found) {
    const older = olderThanThis(found.version);
    say(older ? `Updating OpenFilm Studio to ${VERSION}…` : 'Restarting OpenFilm Studio…');
    const replaced = await replace(found);
    if ('stays' in replaced) {
      say(`OpenFilm Studio keeps running: ${replaced.stays}`);
      return found;
    }
    pages = replaced.pages;
  }
  const logs = join(studioHome(), 'logs');
  mkdirSync(logs, { recursive: true });
  const log = openSync(join(logs, 'studio.log'), 'a');
  const child = spawn(process.execPath, [MAIN], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  let exited = /** @type {number | null} */ (null);
  child.once('exit', (code) => { exited = code ?? 1; });
  child.unref();
  if (!found) say('Starting OpenFilm Studio…');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const up = await running();
    /* the one just started, by the run.json it writes once it listens: the run.json of the one before (stopped for
       good, never cleaning up) names the same address with an older key */
    if (up && (up.pid === child.pid || up.supervisor === child.pid)) return { ...up, pages };
    if (exited != null) {
      const last = readFileSync(join(logs, 'studio.log'), 'utf8').trim().split('\n').pop();
      throw new Error(`Studio did not start: ${last}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Studio did not start; see ${join(logs, 'studio.log')}`);
}

/**
 * `openfilm update`: the newest openfilm, and Studio on it. This one is the newest, or the newest is run to do it
 * (`npx -y openfilm@<latest> update` fetches it); then a Studio on an older one is started again on it once it is
 * idle, and the pages open on it come back on the new version. The desktop app's Studio updates with the app, and a
 * source checkout with git pull: each is said instead. `ok` false when it could not be done (offline, Studio busy).
 * @param {(line: string) => void} [say] @returns {Promise<{ ok: boolean, lines: string[] }>}
 */
export async function updateOpenfilm(say = () => {}) {
  if (FROM_SOURCE) return { ok: true, lines: [`openfilm ${VERSION} runs from a source checkout: git pull updates it.`] };
  const found = (await running()) ?? (await restarting());
  if (found?.app) return { ok: true, lines: ['Studio is the OpenFilm app\'s: it updates with the app (OpenFilm → Check for Updates…).'] };
  const { latest } = await npmOpenfilm({ force: true, waitMs: 8000 });
  if (!latest) return { ok: false, lines: ['Could not reach npm to learn the newest openfilm: try again when online.'] };
  if (olderThanThis(VERSION, latest)) {
    /* the newest does it, fetched by npx; it ran already and is still not the newest: npx gave another */
    if (process.env.OPENFILM_UPDATING) return { ok: false, lines: [`npx ran openfilm ${VERSION}, not ${latest}.`] };
    say(`Getting openfilm ${latest}…`);
    const r = spawnSync('npx', ['-y', `openfilm@${latest}`, 'update'], {
      stdio: 'inherit', env: { ...process.env, OPENFILM_UPDATING: '1' }, shell: process.platform === 'win32', windowsHide: true,
    });
    if (r.error) return { ok: false, lines: [`Could not run npx (it comes with Node.js): ${r.error.message}`] };
    /* an `openfilm` installed with npm -g is not npx's: it stays as it is until npm updates it */
    const installed = process.env.npm_command !== 'exec' && !process.env.OPENFILM_RUN;
    return { ok: r.status === 0, lines: installed && r.status === 0 ? [`The \`openfilm\` command installed here is still ${VERSION}: \`npm install -g openfilm@latest\` updates it.`] : [] };
  }
  if (!found) return { ok: true, lines: [`openfilm ${VERSION} is the newest. Studio starts on it the next time it opens.`] };
  if (!olderThanThis(found.version)) return { ok: true, lines: [`openfilm ${VERSION} is the newest, and Studio runs it.`] };
  say(`Updating OpenFilm Studio from ${found.version} to ${VERSION}…`);
  const replaced = await replace(found);
  if ('stays' in replaced) return { ok: false, lines: [`Studio keeps running ${found.version} for now: ${replaced.stays}. Update again once that is done.`] };
  await ensureStudio(say);
  return { ok: true, lines: [`Studio runs openfilm ${VERSION} now${replaced.pages ? `: the ${replaced.pages === 1 ? 'page' : `${replaced.pages} pages`} open on it come back on it` : ''}.`] };
}

/**
 * Open `folder` in Studio (none: the project opened last, else the Projects window) and show it in a browser: the
 * person's opens it `fallback` seconds on unless a page opened the address first (an agent's own browser), or at once
 * with `now`. Studio pages already open switch to it too.
 * @param {string | null} folder @param {{ fallback?: number, now?: boolean, say?: (line: string) => void }} [options]
 */
export async function openInStudio(folder, { fallback = 15, now = false, say } = {}) {
  /* the running one when it answers and is this version: starting it afresh would drop every page open on it (and the
     person's own work there) each time an agent opens a project; one that does not answer is started anew */
  const run = await ensureStudio(say);
  const res = await fetch(`${run.origin}/api/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-studio-key': run.key },
    /* the folder as the person means it, from where the command runs (Studio runs elsewhere) */
    body: JSON.stringify({ ...(folder != null ? { path: resolve(folder) } : {}), fallback, now, pages: run.pages ?? 0 }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Studio answered ${res.status}`);
  return /** @type {{ project: { id: string, name: string, path: string } | null, url: string, pages: number }} */ (body);
}

/**
 * POST to Studio and wait as long as it takes: a video clip is made inside one request (fetch would give up on the
 * answer after five minutes).
 * @param {Running} run @param {string} path @param {unknown} payload @returns {Promise<any>}
 */
function post(run, path, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((done, fail) => {
    const req = request(`${run.origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-studio-key': run.key },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { try { done(JSON.parse(text)); } catch { fail(new Error(`Studio answered ${res.statusCode}`)); } });
    });
    req.on('error', fail);
    req.end(body);
  });
}

/** The project around `from`: the nearest folder up with a film.html. @param {string} from */
function projectAround(from) {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'film.html'))) return dir;
    if (dir === dirname(dir)) return null;
  }
}

/**
 * `openfilm get [verb] [--option value …] [--yes]`: media for the project around the current folder, made by Studio
 * (started when needed). Without a verb (or with --help): what can be got here now. `--via <provider>` and
 * `--model <id>` override the person's choices in Studio's Settings (Models) for one run; the listing leaves them
 * out, as it leaves out who makes what. `code` is the exit status: 0 done, 1 it did not run, 2 not a project or a wrong
 * command.
 * @param {string[]} argv @param {(line: string) => void} [say] @returns {Promise<{ code: number, lines: string[] }>}
 */
export async function getMedia(argv, say) {
  /** @type {Record<string, string | true | (string | true)[]>} */
  const flags = {};
  /** @type {string | null} */
  let verb = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) {
      if (verb !== null) return { code: 2, lines: [`openfilm get: unexpected ${a}: options are written --name value`] };
      verb = a;
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const value = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    const had = flags[name];
    flags[name] = had === undefined ? value : [...[had].flat(), value];
  }
  const { help, via, model, yes, ...args } = flags;
  if (via !== undefined && typeof via !== 'string') return { code: 2, lines: ['openfilm get: --via names a provider, e.g. --via elevenlabs'] };
  if (model !== undefined && typeof model !== 'string') return { code: 2, lines: ['openfilm get: --model names a model, e.g. --model eleven_v4'] };
  const listing = !verb || verb === 'help' || help !== undefined;
  const folder = projectAround('.');
  if (!folder && !listing) return { code: 2, lines: [`openfilm get: ${resolve('.')} is not in a project; \`openfilm open\` makes one`] };
  /* the listing is read from a Studio already running, else here: asking what there is starts nothing */
  const run = listing ? await running() : await ensureStudio(say);
  if (!listing && run) {
    const answer = await post(run, '/api/get', { folder, verb, args, ...(via ? { via } : {}), ...(model ? { model } : {}), yes: yes === true });
    if (typeof answer?.text !== 'string') return { code: 1, lines: [`openfilm get: ${answer?.error ?? 'Studio did not say how it went'}`] };
    return { code: answer.ok ? 0 : answer.code === 2 ? 2 : 1, lines: [answer.text] };
  }
  const one = verb && verb !== 'help' ? verb : null;
  /* web search and web pages, for an agent without web tools of its own (the app's own agents say so) */
  const web = process.env.OPENFILM_GET_WEB === '1';
  /** @type {{ verbs: { verb: string, help: string, dir?: string, options: Record<string, { value?: string, required?: boolean, choices?: string[] }> }[], note: string | null, services?: string, error?: string }} */
  let listed;
  if (run) {
    const query = new URLSearchParams({ ...(one ? { verb: one } : {}), ...(web ? { web: '1' } : {}) }).toString();
    const res = await fetch(`${run.origin}/api/get${query ? `?${query}` : ''}`, { headers: { 'x-studio-key': run.key } });
    listed = await res.json();
    if (!res.ok) return { code: 2, lines: [`openfilm get: ${listed.error ?? `Studio answered ${res.status}`}`] };
  } else {
    const { catalog } = await import('./server/get.mjs');
    try { listed = await catalog(one ?? undefined, { web }); } catch (e) { return { code: 2, lines: [`openfilm get: ${/** @type {Error} */ (e).message}`] }; }
  }
  const { verbs, note, services } = listed;
  const where = one || !services ? [] : ['', services];
  /* nothing connected: what to do instead, and which services there are */
  if (!verbs.length) return { code: 0, lines: [...(note ? [note] : []), ...where] };
  const width = Math.max(...verbs.map((v) => v.verb.length));
  const pad = ' '.repeat(width + 4);
  return { code: 0, lines: [
    'openfilm get <what> [--option value …]   media for this project, saved under assets/',
    '  --yes              the person already agreed to what it spends',
    '',
    ...verbs.flatMap((v) => {
      const options = Object.entries(v.options).map(([name, o]) => {
        const flag = o.value ? `--${name} <${o.choices ? o.choices.join('|') : o.value}>` : `--${name}`;
        return o.required ? flag : `[${flag}]`;
      }).join(' ');
      return [`  ${v.verb.padEnd(width)}  ${v.help}${v.dir ? ` Saved under ${v.dir}/.` : ''}`, `${pad}${options}`];
    }),
    ...(note ? ['', note] : []),
    ...where,
  ] };
}
