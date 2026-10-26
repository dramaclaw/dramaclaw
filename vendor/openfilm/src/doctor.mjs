// @ts-check
/**
 * `openfilm doctor`: what this computer has for OpenFilm, as text a person pastes into an issue. Studio's Settings →
 * Developer copies the same report, with what the browser it is open in can do.
 *
 * Each check is a line: what it is, what was found, and when something is wrong, what to do about it. A path under the
 * home folder reads ~. No keys, accounts, projects or variables' values are in it: of the variables an agent sets, only
 * their names, which say which agent ran the command. After the checks, the problems of the last week (problems.mjs)
 * and the last errors in Studio's log.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { arch, homedir, platform, release, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { freeSpace, libraryRoot, studioHomeDir } from './locations.mjs';
import { problemLines, problemsFile } from './problems.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const FROM_SOURCE = existsSync(new URL('../studio/ui/src', import.meta.url));
const FFMPEG_HELP = 'macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg';

/** The agents a variable's name tells, by the prefix each one's variables have. */
const AGENT_PREFIXES = /** @type {const} */ ([
  ['CLAUDE', 'Claude Code'], ['CODEX', 'Codex'], ['CURSOR', 'Cursor'], ['COPILOT', 'GitHub Copilot'],
  ['OPENCODE', 'OpenCode'], ['CODEBUDDY', 'CodeBuddy'], ['QWEN', 'Qwen Code'], ['KIMI', 'Kimi'],
]);

/**
 * A path as the report shows it: the home folder as ~.
 * @param {string} path @param {string} [home]
 */
export function tidy(path, home = homedir()) {
  if (!home || home.length < 2) return path;
  const lower = platform() === 'win32';
  const starts = lower ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home);
  return starts ? `~${path.slice(home.length)}` : path;
}

/**
 * Which agents ran this, by the names of the variables they set: `{ agents, names }`. Values are never read.
 * @param {Record<string, string | undefined>} env
 */
export function agentHints(env) {
  const names = Object.keys(env).filter((name) => AGENT_PREFIXES.some(([prefix]) => name.toUpperCase().startsWith(prefix))).sort();
  const agents = AGENT_PREFIXES.filter(([prefix]) => names.some((name) => name.toUpperCase().startsWith(prefix))).map(([, label]) => label);
  return { agents, names };
}

/**
 * The lines of studio.log that say something went wrong, the last few, each cut short.
 * @param {string} text @param {number} [count]
 */
export function logTrouble(text, count = 10) {
  /** @type {{ line: string, times: number }[]} */
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/error|fail|uncaught|cannot|EACCES|EPERM|ENOENT|EADDRINUSE/i.test(line)) continue;
    const short = line.length > 300 ? `${line.slice(0, 299)}…` : line;
    /* the same line again (a retry, a stack's head) counts once, with how many times */
    if (kept.at(-1)?.line === short) kept[kept.length - 1].times += 1;
    else kept.push({ line: short, times: 1 });
  }
  return kept.slice(-count).map(({ line, times }) => (times > 1 ? `${line} (×${times})` : line));
}

/**
 * A WebGL renderer drawn without the graphics chip: every frame is slow.
 * @param {string | null} renderer
 */
export const softwareRenderer = (renderer) => Boolean(renderer && /swiftshader|llvmpipe|software|basic render/i.test(renderer));

/** @typedef {{ label: string, text: string, problem?: string }} Check */

/**
 * The report as text: one line per check, then what to fix.
 * @param {Check[]} checks @param {string[]} [extra] more lines after the checks (the log's)
 */
export function formatReport(checks, extra = []) {
  const width = Math.max(...checks.map((c) => c.label.length)) + 2;
  const problems = checks.filter((c) => c.problem);
  return [
    'OpenFilm doctor',
    '',
    ...checks.map((c) => `${c.problem ? '✗' : '✓'} ${c.label.padEnd(width)}${c.text}`),
    ...(problems.length ? ['', 'To fix:', ...problems.map((c) => `  ${c.label}: ${c.problem}`)] : ['', 'Nothing to fix.']),
    ...(extra.length ? ['', ...extra] : []),
  ].join('\n');
}

/** The system's name and version, as a person knows it (macOS 26.6.2, Windows 11 Pro 10.0.26100). */
function systemName() {
  if (platform() === 'darwin') {
    const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
    const v = r.status === 0 ? r.stdout.trim() : '';
    return `macOS ${v || '(unknown)'} (darwin ${release()}, ${arch()})`;
  }
  return `${osVersion()} ${release()} (${platform()}, ${arch()})`;
}

/** @param {string} bin */
function toolVersion(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split(/\r?\n/)[0].replace(new RegExp(`^${bin} version\\s+`), '').split(' ')[0] || '(unknown)';
}

/** @param {string} folder */
function writable(folder) {
  try { accessSync(folder, constants.W_OK); return true; } catch { return false; }
}

/** @param {number | null} bytes */
const gb = (bytes) => (bytes == null ? '' : `, ${(bytes / 1e9).toFixed(bytes < 10e9 ? 1 : 0)} GB free`);

/**
 * The browser films are drawn in: its version, what draws WebGL in it, and the video codecs it decodes on the graphics
 * chip (Chromium's `powerEfficient`), which a film's footage is played with. null when it is not downloaded yet.
 * @returns {Promise<{ version: string, renderer: string | null, chipVideo: string[] } | null>}
 */
async function filmBrowser() {
  const { launch } = await import('./host.mjs');
  let browser;
  try { browser = await launch(); }
  catch (e) { if (/Executable doesn't exist/.test(String(/** @type {Error} */ (e).message))) return null; throw e; }
  try {
    const page = await browser.newPage();
    const renderer = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    });
    const chipVideo = await page.evaluate(async () => {
      const codecs = { 'H.264': 'video/mp4; codecs="avc1.640028"', HEVC: 'video/mp4; codecs="hvc1.1.6.L120.90"', VP9: 'video/webm; codecs="vp09.00.40.08"', AV1: 'video/mp4; codecs="av01.0.08M.08"' };
      const on = [];
      for (const [name, contentType] of Object.entries(codecs)) {
        try {
          const info = await navigator.mediaCapabilities.decodingInfo({ type: 'file', video: { contentType, width: 1920, height: 1080, bitrate: 8e6, framerate: 30 } });
          if (info.powerEfficient) on.push(name);
        } catch { /* not this one */ }
      }
      return on;
    }).catch(() => []);
    return { version: browser.version(), renderer, chipVideo };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** What this machine's ffmpeg does on the graphics chip (encoders.mjs): the encoders that work here, and the decoding. */
async function chipText() {
  const { encoders, hardwareDecoding, hardwareEncoder } = await import('./encoders.mjs');
  const have = await encoders();
  const encoding = (await Promise.all(/** @type {const} */ (['h264', 'hevc', 'prores']).map((codec) => hardwareEncoder(codec, have)))).filter(Boolean);
  const decoding = await hardwareDecoding();
  return `ffmpeg ${encoding.length ? `encodes with ${encoding.join(', ')}` : 'encodes on the processor'}; ${decoding.length ? `decodes with ${decoding[1]}` : 'decodes on the processor'}`;
}

/**
 * Every check, run now. `studio`: the Studio asking, when it is Studio that runs this (it is not looked for then).
 * `browser: false` and `network: false` leave those checks out (tests).
 * @param {{ run?: string, env?: Record<string, string | undefined>, studio?: { origin: string, version: string, app?: boolean } | null,
 *           browser?: boolean, network?: boolean, home?: string }} [options]
 */
export async function doctor({ run = 'openfilm', env = process.env, studio = null, browser = true, network = true, home = homedir() } = {}) {
  /** @type {Check[]} */
  const checks = [];
  const at = (/** @type {string} */ path) => tidy(path, home);

  const from = FROM_SOURCE ? 'a source checkout' : studio?.app ? 'the desktop app' : 'npm';
  checks.push({ label: 'OpenFilm', text: `${VERSION} (${from}; run as ${run})` });
  checks.push({ label: 'System', text: systemName() });
  const [major, minor] = process.versions.node.split('.').map(Number);
  const oldNode = major < 22 || (major === 22 && minor < 18);
  checks.push({ label: 'Node', text: `${process.version} (${at(process.execPath)})`, ...(oldNode ? { problem: 'OpenFilm needs Node 22.18 or newer: install it from nodejs.org' } : {}) });

  const { agents, names } = agentHints(env);
  const term = env.TERM_PROGRAM ? `; terminal ${env.TERM_PROGRAM}` : '';
  const shown = names.length > 4 ? `${names.slice(0, 4).join(', ')} and ${names.length - 4} more` : names.join(', ');
  checks.push({ label: 'Run by', text: agents.length ? `${agents.join(', ')} (${shown})${term}` : `no agent's variables${term}` });

  if (studio) {
    checks.push({ label: 'Studio', text: `${studio.version} at ${studio.origin}${studio.app ? ' (the desktop app\'s)' : ''}` });
  } else {
    const { running } = await import('../studio/client.mjs');
    const up = await running().catch(() => null);
    checks.push(up
      ? { label: 'Studio', text: `${up.version ?? '(unknown version)'} at ${up.origin}${up.app ? ' (the desktop app\'s)' : ''}` }
      : { label: 'Studio', text: `not running (\`${run} open\` starts it)` });
  }

  for (const bin of ['ffmpeg', 'ffprobe']) {
    const v = toolVersion(bin);
    checks.push(v ? { label: bin, text: v } : { label: bin, text: 'not found on the PATH', problem: `install ffmpeg (${FFMPEG_HELP})` });
  }
  if (toolVersion('ffmpeg')) checks.push({ label: 'Hardware', text: await chipText() });

  if (browser) {
    try {
      const b = await filmBrowser();
      if (!b) checks.push({ label: 'Browser', text: 'not downloaded yet', problem: `\`${run} open\` downloads it (about 100 MB, once)` });
      else {
        const slow = softwareRenderer(b.renderer);
        const video = b.chipVideo.length ? `video decoded on the chip: ${b.chipVideo.join(', ')}` : 'video decoded by the processor';
        checks.push({ label: 'Browser', text: `Chromium ${b.version}; WebGL ${b.renderer ?? 'unavailable'}; ${video}`,
          ...(slow ? { problem: 'films are drawn without the graphics chip, so looks and renders are slow: update the graphics driver' } : {}) });
      }
    } catch (e) {
      checks.push({ label: 'Browser', text: 'does not start', problem: String(/** @type {Error} */ (e).message).split('\n')[0].slice(0, 300) });
    }
  }

  const data = studioHomeDir();
  const projects = libraryRoot();
  const dataOk = !existsSync(data) || writable(data);
  const projectsOk = !existsSync(projects) || writable(projects);
  checks.push({ label: 'Data', text: `${at(data)}${existsSync(data) ? (dataOk ? '' : ' (not writable)') : ' (not made yet)'}`,
    ...(dataOk ? {} : { problem: `OpenFilm cannot write to ${at(data)}: give your account write access to it` }) });
  checks.push({ label: 'Projects', text: `${at(projects)}${existsSync(projects) ? (projectsOk ? '' : ' (not writable)') : ' (not made yet)'}${gb(freeSpace(projects))}`,
    ...(projectsOk ? {} : { problem: `OpenFilm cannot write to ${at(projects)}: choose another folder in Studio's Settings → General` }) });

  if (network) {
    const reached = await fetch('https://registry.npmjs.org/openfilm', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    checks.push(reached ? { label: 'Network', text: 'npm reachable' }
      : { label: 'Network', text: 'npm not reachable', problem: 'npx and updates need registry.npmjs.org: check the network, a proxy, or the agent\'s sandbox' });
  }

  const log = join(data, 'logs', 'studio.log');
  const trouble = existsSync(log) ? logTrouble(readFileSync(log, 'utf8')).map((line) => (home.length > 1 ? line.replaceAll(home, '~') : line)) : [];
  const recent = problemLines({ file: problemsFile(data) });
  const extra = [
    ...recent,
    ...(recent.length && trouble.length ? [''] : []),
    ...(trouble.length ? [`Last errors in ${at(log)}:`, ...trouble.map((line) => `  ${line}`)] : []),
  ];

  return { ok: !checks.some((c) => c.problem), checks, text: formatReport(checks, extra) };
}
