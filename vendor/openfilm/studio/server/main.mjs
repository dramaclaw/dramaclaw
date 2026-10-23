// @ts-check
/**
 * Studio's process: `openfilm open` starts it in the background when none is running. It writes where it listens and
 * its launch key to ~/.openfilm/run.json (readable by this user only), which is how the CLI finds it, and removes the
 * file when it stops.
 *
 * Started this way, the process is a small supervisor and Studio runs in a child of it (OPENFILM_STUDIO_WORKER): a
 * Studio that ends unexpectedly (a crash, the system ending it) is started again a second later, on the same port with
 * the same key, so the pages open on it reconnect by themselves. It is not started again when it stopped because it
 * was asked to (exit 0: replaced by a newer one, or quit), when another Studio has taken over the machine (run.json
 * names it), or after five ends within a minute (something a restart does not fix; studio.log says what).
 */
import { spawn } from 'node:child_process';
import { fstatSync, openSync, readFileSync } from 'node:fs';
import { devNull, setPriority } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* fds 0–2 open before anything else is: a launcher that closed one (a detached shell, a service) would make every
   spawn of ffmpeg, ffprobe or git fail with EBADF from then on, while the page still says Studio is up */
for (const fd of [0, 1, 2]) {
  try { fstatSync(fd); } catch { openSync(devNull, fd === 0 ? 'r' : 'a'); }
}
/* below the person's own apps: an export or a poster never takes the computer from them, and what Studio starts
   (its browsers, ffmpeg) runs at this priority too */
try { setPriority(10); } catch { /* not allowed here: as it is */ }
/* each line of studio.log with its time */
for (const level of /** @type {const} */ (['log', 'warn', 'error'])) {
  const write = console[level].bind(console);
  console[level] = (...args) => write(new Date().toISOString(), ...args);
}

if (process.env.OPENFILM_STUDIO_WORKER !== '1') await supervise();

const { startStudio } = await import('./server.mjs');
const { closePageFrames } = await import('./pageframes.mjs');
const { closeBrowsers } = await import('../../src/host.mjs');
const { recordProblem } = await import('../../src/problems.mjs');

/* A browser's pipe that breaks (Playwright then throws where nothing can catch it) ends only the work on that browser:
   every browser is closed, so a render waiting on one fails and says so, the next one starts a new browser, and Studio
   keeps serving. Anything else still ends the process, its state unknown. */
process.on('uncaughtException', (e) => {
  console.error('uncaught:', e);
  recordProblem({ area: 'studio', step: 'uncaught', what: String(e?.message ?? e) });
  if (/playwright-core/.test(String(e?.stack ?? ''))) { void closePageFrames().catch(() => {}); void closeBrowsers(); return; }
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('unhandled rejection:', e);
  recordProblem({ area: 'studio', step: 'unhandled rejection', what: String(/** @type {any} */ (e)?.message ?? e) });
});

const given = process.env.OPENFILM_STUDIO_PORT;
const port = given != null && given !== '' && Number.isInteger(Number(given)) ? Number(given) : 4747;
/** @type {Awaited<ReturnType<typeof startStudio>> | undefined} */
let studio;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await studio?.close();
  process.exit(0);
};
/* the port is taken (by something else: the CLI asks run.json for a running Studio first) or reserved (Windows keeps
   ranges for Hyper-V and WSL, and refuses them with EACCES): any free one does, the CLI finds it through run.json */
const taken = (/** @type {unknown} */ e) => ['EADDRINUSE', 'EACCES'].includes(/** @type {NodeJS.ErrnoException} */ (e).code ?? '');
try {
  studio = await startStudio({ port, advertise: true, onQuit: stop }).catch((e) => {
    if (!port || !taken(e)) throw e;
    /* started again after an end: another Studio took the port meanwhile, and it is the one to use */
    if (process.env.OPENFILM_STUDIO_RESTARTED === '1') {
      console.error(`port ${port} is taken by another Studio now; this one stops`);
      process.exit(0);
    }
    console.error(`port ${port} is not free; Studio takes another`);
    return startStudio({ port: 0, advertise: true, onQuit: stop });
  });
} catch (e) {
  console.error(e);
  process.exit(1);
}
console.log(`Dramaclaw Studio · ${studio.origin}`);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/** The supervisor (see the top): never returns; it ends with the Studio it keeps. */
async function supervise() {
  const { studioHome } = await import('./projects.mjs');
  const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const advertisedPid = () => {
    try { return Number(JSON.parse(readFileSync(join(studioHome(), 'run.json'), 'utf8')).pid) || null; } catch { return null; }
  };
  /** @type {number[]} */
  const ends = [];
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let stopping = false;
  const start = (/** @type {boolean} */ restarted) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, OPENFILM_STUDIO_WORKER: '1', OPENFILM_STUDIO_SUPERVISOR: String(process.pid) };
    if (restarted) env.OPENFILM_STUDIO_RESTARTED = '1';
    const worker = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true });
    child = worker;
    worker.once('exit', (code, signal) => {
      if (stopping || code === 0) process.exit(code ?? 0);
      const now = Date.now();
      ends.push(now);
      while (ends.length && now - /** @type {number} */ (ends[0]) > 60_000) ends.shift();
      if (ends.length >= 5) {
        console.error('Studio ended 5 times within a minute; it is not started again');
        process.exit(1);
      }
      const other = advertisedPid();
      if (other && other !== worker.pid && alive(other)) process.exit(0);
      console.error(`Studio ended (${signal ?? `exit code ${code}`}); starting it again`);
      setTimeout(() => start(true), 1000);
    });
  };
  const stop = (/** @type {NodeJS.Signals} */ signal) => { stopping = true; if (child?.exitCode === null) child.kill(signal); else process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  start(false);
  await new Promise(() => {});
}
