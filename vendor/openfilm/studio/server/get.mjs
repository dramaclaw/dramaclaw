// @ts-check
/**
 * `openfilm get`: media for a project (voice-over, music, sound effects, transcripts, pictures, video) from a provider
 * the person connected with their own key (providers/). The CLI sends the verb and its options to Studio (`/api/get`);
 * here they are checked, a provider is picked (`--via`, else the person's choice in Studio's Settings; none chosen,
 * nothing runs), it runs, and what comes back lands in the project: files under assets/ only, and timed speech's
 * transcript beside it (transcripts.mjs). The answer is the receipt the agent reads, without what it cost.
 *
 * Who makes the media, with which model and for what price is the person's business, chosen in Studio: the agent is
 * told what it can get here now, and for what is not connected, which services make it.
 *
 * A video clip spends a lot, so the person confirms it first, in the Studio page showing the project (an `ask` event on
 * its stream, answered with POST /api/get/asks/:id) while the CLI waits. With no page open, the agent is told to ask
 * the person and run it again with `--yes`.
 *
 * A provider whose account has no balance left for a run (code 'balance', the same for every provider) is said once to
 * the person, in the Studio pages showing the project (a `notice` event, with where to top it up), and to the agent,
 * which stops. Nothing anyone reads here carries an amount: that is on each provider's own page.
 *
 * Subtitle translation goes through the provider chosen for `translate` too (`subtitleTranslator`, for captions.mjs).
 *
 * Web search and reading web pages (WEB_VERBS) are listed only for an agent without web tools of its own: the app's
 * own agents say so with OPENFILM_GET_WEB=1 (the CLI asks for them); an agent like Claude Code or Codex searches with
 * its own. Either can run them.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { FILM_FILE, clipKind } from '../../src/film-doc.mjs';
import { spokenLines } from './captions.mjs';
import { dropTranscripts, readTranscript, transcriptIsCurrent, transcriptPath, writeTranscript } from './transcripts.mjs';
import { inside } from './files.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { kindOf, modelFor, providerKey } from './keys.mjs';
import { chooseProvider, listProviders, providerSettings } from './providers/index.mjs';
import { CALL_TIMEOUT_SEC, callService, servicesHelp } from './custom-services.mjs';

/**
 * @typedef {import('./http.mjs').Req} Req @typedef {import('./http.mjs').Res} Res
 * @typedef {import('./providers/contract.mjs').Provider} Provider
 * @typedef {import('./providers/contract.mjs').RunResult} RunResult
 * @typedef {import('./providers/contract.mjs').Spend} Spend
 * @typedef {import('./providers/contract.mjs').Verb} Verb
 * @typedef {import('./captions.mjs').TranslateLines} TranslateLines
 */

/**
 * An option: `value` names what it takes in the help (none: a switch). `path`: a project file it names, which must be
 * a recording (`speech`) or a picture.
 * @typedef {{ value?: string, required?: boolean, repeat?: boolean, choices?: string[], min?: number, max?: number,
 *   integer?: boolean, default?: string | number, alias?: string, path?: 'speech' | 'picture' }} Option
 * @typedef {{ help: string, dir?: string, timeoutSec: number, options: Record<string, Option> }} VerbSpec
 */

const out = /** @type {Option} */ ({ value: 'name', required: true });
const prompt = /** @type {Option} */ ({ value: 'text', required: true });

/** The verbs, their options and where their files go. A provider takes the options it can honor and says so for the rest. */
export const VERBS = /** @type {Record<string, VerbSpec>} */ ({
  voice: {
    help: 'Find voices for tts: voiceId, name, language, gender and description.',
    timeoutSec: 60,
    options: { language: { value: 'code' }, gender: { value: 'gender', choices: ['m', 'f'] }, prompt: { value: 'text' },
      limit: { value: 'n', min: 1, max: 100, integer: true, default: 5, alias: 'n' } },
  },
  tts: {
    help: 'Voice-over: one line spoken. Returns src, dur and its transcript: a WebVTT of the text in pause-separated cues, in source seconds. Its word timing is kept, so never run asr on it.',
    dir: 'assets/audio/vo', timeoutSec: 300,
    options: { out, text: { value: 'text', required: true }, voice: { value: 'voiceId', required: true } },
  },
  sfx: {
    help: 'A sound effect. Returns src, its measured dur and, when measured, attack (seconds into the file where the hit is) and peakDb. --sec is a request: the dur returned is what it is.',
    dir: 'assets/audio/sfx', timeoutSec: 300,
    options: { out, prompt, sec: { value: 'seconds', min: 0.5, max: 22 } },
  },
  music: {
    help: 'Music. Returns src and its measured dur. --sec is a request and the track is often longer: play the part you need with a media fragment on the clip\'s src (#t=in,out).',
    dir: 'assets/audio/music', timeoutSec: 300,
    options: { out, prompt, sec: { value: 'seconds', min: 3, max: 300 } },
  },
  asr: {
    help: 'Transcribe a recording in the project. Returns a preview of the text and its transcript: a WebVTT of the whole text in pause-separated cues, each labeled with the pause before it; cut only in pauses of 0.12 s or more. What is transcribed already is not done again (--force redoes a recording; synthesized speech never needs it).',
    timeoutSec: 900,
    options: { src: { value: 'path', required: true, path: 'speech' }, force: {} },
  },
  'image-search': {
    help: 'Find pictures on the web and download them (1 to 8). Returns their paths and sizes.',
    dir: 'assets/image', timeoutSec: 300,
    options: { out, prompt, n: { value: 'n', min: 1, max: 8, integer: true, default: 1, alias: 'limit' } },
  },
  image: {
    help: 'Make one picture. Returns its path and size.',
    dir: 'assets/image', timeoutSec: 300,
    options: { out, prompt, ratio: { value: 'ratio', choices: ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'], default: '3:2' },
      quality: { value: 'level', choices: ['low', 'high'], default: 'low' }, transparent: {} },
  },
  video: {
    help: 'Make one video clip. Returns src, dur, its size and preview frames. It spends a lot: the person confirms it in Studio first (--yes when they already agreed). The same request again returns the same clip; --force makes a new one.',
    dir: 'assets/video', timeoutSec: 1200,
    options: { out, prompt, force: {}, duration: { value: 'seconds', min: 4, max: 30, integer: true, default: 5 },
      'aspect-ratio': { value: 'ratio', choices: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '9:21', '3:2', '2:3', 'adaptive'] },
      'first-frame': { value: 'path', path: 'picture' }, 'last-frame': { value: 'path', path: 'picture' },
      'input-reference': { value: 'path', path: 'picture', repeat: true } },
  },
  'web-search': {
    help: 'Search the web (up to 3 --query at once). Returns the pages that match: title, URL and an excerpt of each. web-fetch reads a whole page.',
    timeoutSec: 120,
    options: { query: { value: 'text', required: true, repeat: true } },
  },
  'web-fetch': {
    help: 'Read public web pages (up to 3 --url at once): each page\'s text is saved as Markdown. Returns its path, title and how it starts.',
    dir: 'assets/fetch', timeoutSec: 120,
    options: { url: { value: 'url', required: true, repeat: true } },
  },
  call: {
    help: 'A request to one of the person\'s own services (below): how to call it is in the person\'s words or the service\'s docs. Studio adds its key as Authorization: Bearer, or where you write {key} (a --header, the --path\'s query), as the docs say; you never see the key. Its answer comes back as it is: text or JSON here, a file saved under assets/<service>/. What it means is yours to read.',
    timeoutSec: CALL_TIMEOUT_SEC,
    options: { service: { value: 'id', required: true }, path: { value: '/path', default: '/' },
      method: { value: 'method', choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, json: { value: 'json' },
      form: { value: 'name=value', repeat: true }, file: { value: 'name=path', repeat: true }, body: { value: 'path' },
      header: { value: 'Name: value', repeat: true }, out: { value: 'name' } },
  },
});

/** Listed only for an agent without web tools of its own (see the top). */
export const WEB_VERBS = ['web-search', 'web-fetch'];

/** Where the person connects a service and picks its models, said the same way everywhere. */
export const WHERE_TO_CONNECT = 'In Studio, the gear at the top left opens Settings: connect a service under Providers, '
  + 'with the person\'s own key, then choose the model for each kind of media under Services.';
/** The services that make `verb`, by name: "fal.ai, Google or OpenAI". @param {string} verb */
const makers = (verb) => {
  const names = listProviders().filter((p) => /** @type {readonly string[]} */ (p.verbs).includes(verb)).map((p) => p.name).sort((a, b) => a.localeCompare(b));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0] ?? 'no service here makes it yet';
};
/** What is not connected here, which services make each, and where the person connects one. @param {string[]} verbs */
const notConnected = (verbs) => `Not connected here: ${verbs.map((v) => `${v} (${makers(v)})`).join(', ')}. `
  + `Each works only once the person connects a service that makes it. ${WHERE_TO_CONNECT}`;
/** Whether any of the services, connected or not, can make `verb`. */
const offered = (/** @type {string} */ verb) => listProviders().some((p) => /** @type {readonly string[]} */ (p.verbs).includes(verb));
/** The whole of `openfilm get` when nothing is connected. */
const nothing = () => 'Nothing is connected for media here: each kind works only once the person connects a service that makes it (below). '
  + 'Until then, make sound and pictures in code, or use a service the person has a key for (with its API docs), and save them under assets/. '
  + `\`openfilm get <what> --help\` shows what one kind takes (${Object.keys(VERBS).filter((v) => !WEB_VERBS.includes(v) && offered(v)).join(', ')}).`;

/** What `call` says when the person has added no service of their own. */
const NO_OWN_SERVICES = 'The person has added no services of their own. In Studio, the gear at the top left opens Settings: '
  + 'they add one under Providers (its address, its key if it takes one, and what it does).';

/** Each kind of media, in words (finding voices is part of voice-over). */
const WORDS = /** @type {Record<string, string>} */ ({
  tts: 'voice-over', music: 'music', sfx: 'sound effects', asr: 'transcripts', image: 'images', 'image-search': 'image search',
  video: 'video', translate: 'subtitle translation', 'web-search': 'web search',
});
/** The media services `get` can use, by name (none comes first), what each makes, and where the person connects them. */
export const services = () => `Media services, each used with the person's own key: ${listProviders()
  .map((p) => ({ name: p.name, makes: p.verbs.filter((v) => WORDS[v]).map((v) => WORDS[v]).join(', ') }))
  .sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name} (${p.makes})`).join(', ')}. ${WHERE_TO_CONNECT}`;

/** How long the person has to answer a question about spending. */
const ASK_WAIT_MS = 15 * 60_000;
/** The most a file sent to a provider may be (a recording's speech, a frame). */
const MAX_INPUT_BYTES = 48 << 20;
/** Receipt fields about money: the person sees what was spent on the provider's own page, the agent sees what landed. */
const BILLING = new Set(['budget', 'balance', 'spent', 'plan', 'planName', 'price', 'prices', 'usd', 'cost', 'costUsd', 'charged']);

/** Why a get did not run; `code` is the CLI's exit status (2: not a project or a wrong command, 1: it did not run). */
export class GetError extends Error {
  /** @param {string} message @param {1 | 2} [code] */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}
const usage = (/** @type {string} */ message) => new GetError(message, 2);

/* ── options ─────────────────────────────────────────────────────────────── */

/** An option as the help writes it: `--out <name>`, `[--n <n>]`. @param {string} name @param {Option} o */
export function flagHelp(name, o) {
  const flag = o.value ? `--${name} <${o.choices ? o.choices.join('|') : o.value}>` : `--${name}`;
  return o.required ? flag : `[${flag}]`;
}

/**
 * The verb's options from what the CLI sent (`{ name: string | true | (string | true)[] }`): known, typed, checked and
 * with their defaults. Paths must be files of the project of the right kind. Throws a GetError (exit 2) saying what is
 * wrong.
 * @param {string} root @param {string} verb @param {Record<string, unknown>} given
 */
export async function checkArgs(root, verb, given) {
  const spec = VERBS[verb];
  if (!spec) throw usage(`there is no ${verb || 'verb'}; there is ${Object.keys(VERBS).join(', ')}`);
  const all = Object.entries(spec.options).map(([n, o]) => flagHelp(n, o)).join(' ');
  /** @type {Record<string, unknown>} */
  const args = {};
  for (const [flag, raw] of Object.entries(given)) {
    const name = spec.options[flag] ? flag : Object.keys(spec.options).find((n) => spec.options[n].alias === flag);
    if (!name) throw usage(`${verb} has no --${flag}; it takes ${all}`);
    const option = spec.options[name];
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length > 1 && !option.repeat) throw usage(`--${name} is given once`);
    if (!option.value) {
      if (values.some((v) => v !== true && v !== 'true')) throw usage(`--${name} takes no value`);
      args[name] = true;
      continue;
    }
    const typed = values.map((v) => {
      if (typeof v !== 'string' || !v.trim()) throw usage(`--${name} needs a value: ${flagHelp(name, option)}`);
      if (option.choices && !option.choices.includes(v)) throw usage(`--${name} is one of ${option.choices.join(', ')}`);
      if (option.min === undefined) return v;
      const n = Number(v);
      if (!Number.isFinite(n) || (option.integer && !Number.isInteger(n)) || n < option.min || n > /** @type {number} */ (option.max)) {
        throw usage(`--${name} is ${option.integer ? 'a whole number' : 'a number'} from ${option.min} to ${option.max}`);
      }
      return n;
    });
    args[name] = option.repeat ? typed : typed[0];
  }
  for (const [name, option] of Object.entries(spec.options)) {
    if (args[name] === undefined && option.default !== undefined) args[name] = option.default;
    if (args[name] === undefined && option.required) throw usage(`${verb} needs ${flagHelp(name, option)}`);
  }
  if (typeof args.out === 'string' && (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,120}$/u.test(args.out) || /\.[a-z0-9]{2,4}$/i.test(args.out))) {
    throw usage('--out is a simple name, without a folder or an extension (e.g. --out intro)');
  }
  for (const [name, option] of Object.entries(spec.options)) {
    if (!option.path || args[name] === undefined) continue;
    for (const rel of /** @type {string[]} */ ([args[name]].flat())) await projectFile(root, rel, name, option.path);
  }
  if (args['last-frame'] && !args['first-frame']) throw usage('--last-frame needs --first-frame');
  if (args['first-frame'] && args['input-reference']) throw usage('--first-frame and --input-reference do not go together');
  return args;
}

/** A file of the project the option names, of the kind it wants. @param {string} root @param {string} rel @param {string} name @param {'speech' | 'picture'} want */
async function projectFile(root, rel, name, want) {
  let abs;
  try { abs = inside(root, rel); } catch { throw usage(`--${name} ${rel} is not a path inside the project`); }
  if (!(await stat(abs).catch(() => null))?.isFile()) throw usage(`--${name} ${rel} is not in the project`);
  const kind = clipKind(rel);
  if (want === 'speech' ? kind !== 'sound' && kind !== 'video' : kind !== 'still') {
    throw usage(`--${name} wants ${want === 'speech' ? 'a sound or video file' : 'a picture'}; ${basename(rel)} is not one`);
  }
  /* a recording's transcript is written beside it, and files and folders starting with a dot are the tools' (.git) */
  if (want === 'speech' && relative(root, abs).split(sep).some((part) => part.startsWith('.'))) {
    throw usage(`--${name} ${rel} belongs to the tools (a name starting with a dot), and its transcript would go beside it: copy it elsewhere in the project first`);
  }
}

/* ── running ─────────────────────────────────────────────────────────────── */

/**
 * The question asked in Studio: 'allow', 'deny', 'timeout', or null when no page shows the project.
 * @typedef {(spend: Spend) => Promise<'allow' | 'deny' | 'timeout' | null>} Ask
 */

/**
 * What the person is told in Studio, without a question: a provider whose account has no balance left for a run.
 * @typedef {{ kind: 'balance', provider: string, providerId: string }} Notice
 */

/**
 * Run `verb` for the project at `root` and land what it makes. Resolves with the receipt for the agent; throws a
 * GetError (or a provider's own Error) saying why it did not run.
 * `model`: the provider's model for this run, instead of the person's choice for this kind of media.
 * @param {string} root @param {string} verb @param {Record<string, unknown>} given
 * `tell`: says a Notice to the person in Studio.
 * @param {{ via?: string, model?: string, yes?: boolean, ask?: Ask, tell?: (notice: Notice) => void, signal?: AbortSignal }} [options]
 */
export async function runGet(root, verb, given, { via, model, yes = false, ask, tell, signal = new AbortController().signal } = {}) {
  const args = await checkArgs(root, verb, given);
  if (verb === 'call') {
    const { custom } = await providerSettings();
    const service = custom.find((s) => s.id === args.service);
    if (!service) throw usage(custom.length ? `There is no service ${args.service}: there is ${custom.map((s) => s.id).join(', ')}` : NO_OWN_SERVICES);
    const { service: _, ...rest } = args;
    try { return await callService(root, service, /** @type {Parameters<typeof callService>[2]} */ (rest), signal); }
    catch (e) { throw /** @type {{ status?: number }} */ (e)?.status === 400 ? usage(/** @type {Error} */ (e).message) : e; }
  }
  if (verb === 'asr' && args.force !== true && await transcriptIsCurrent(root, String(args.src))) {
    return show(await speechReceipt(root, 'asr', String(args.src), { skip: true, note: 'It has a transcript already, made since the file last changed (--force makes it again).' }));
  }
  const settings = await providerSettings();
  /* `--via` names one: when it cannot, it says why (no such provider, not this verb, no key) */
  const provider = await chooseProvider(/** @type {Verb} */ (verb), { via: via ?? null, settings }).catch((e) => { throw usage(e.message); });
  if (!provider) {
    throw new GetError(`${notConnected([verb])} Tell the person. Until then, make it in code, or use a service the person has a key for (with its API docs), and save it under assets/.`);
  }

  /* the model named for this run: one the provider has for this kind of media */
  const kind = /** @type {Verb} */ (kindOf(verb));
  const offered = provider.models?.[kind] ?? [];
  if (model !== undefined && !offered.some((m) => m.id === model)) {
    throw usage(offered.length ? `--model is one of ${offered.map((m) => m.id).join(', ')} with ${provider.name}` : `${provider.name} names no models for ${verb}`);
  }
  const runModel = model ?? modelFor(settings, provider, verb);

  const spec = VERBS[verb];
  const said = /** @type {string[]} */ ([]);
  const clock = deadline(spec.timeoutSec + 60, signal);
  /** @param {Spend} spend */
  const approve = async (spend) => {
    if (yes) return;
    clock.pause();
    try { await approved(spend, ask ? await ask(spend) : null); } finally { clock.resume(); }
  };
  const ctx = {
    key: providerKey(provider, settings)?.key ?? '',
    model: runModel,
    root,
    signal: clock.signal,
    say: (/** @type {string} */ line) => { said.push(line); },
    read: (/** @type {string} */ path) => readInput(root, path, verb === 'asr' && path === args.src, clock.signal, provider.speechFormat),
  };
  try {
    if (verb === 'video' && !yes) {
      const words = typeof args.prompt === 'string' ? args.prompt : '';
      const named = offered.find((m) => m.id === runModel)?.name ?? runModel;
      await approve({ kind: 'video', provider: provider.name, ...(named ? { model: named } : {}), seconds: Number(args.duration),
        ...(words ? { prompt: words.length > 200 ? `${words.slice(0, 199).trimEnd()}…` : words } : {}) });
    }
    const result = await provider.run(/** @type {Verb} */ (verb), args, ctx);
    await land(root, verb, args, result);
    return [...said, show(await receiptFor(root, verb, args, result.receipt))].join('\n');
  } catch (e) {
    if (clock.timedOut()) throw new GetError(`${provider.name} did not finish within ${spec.timeoutSec + 60} s, so Studio stopped waiting. Nothing landed in the project; try again later.`);
    if (/** @type {{ code?: string }} */ (e)?.code === 'balance') {
      tell?.({ kind: 'balance', provider: provider.name, providerId: provider.id });
      throw new GetError(`This did not run: ${provider.name} doesn't have enough balance. The person can top it up at ${provider.billingUrl}, `
        + 'or switch to another service. Nothing was made. Stop and tell them; do not run it again until they say so.');
    }
    throw e;
  } finally {
    clock.clear();
  }
}

/** Go on when the person said yes; otherwise say what the agent does now. @param {Spend} spend @param {'allow' | 'deny' | 'timeout' | null} answer */
function approved(spend, answer) {
  if (answer === 'allow') return;
  if (answer === null) {
    throw new GetError('A video clip is expensive, so the person confirms it first, and no Studio page is showing this project to ask them in. Ask the person; once they agree, run the same command again with --yes.');
  }
  if (answer === 'timeout') {
    throw new GetError('The person did not confirm this video clip in time, so it was not made. Carry on without it (a still picture or motion graphics instead) and mention it in one line.');
  }
  throw new GetError('The person chose not to make this video clip. Carry on without it (a still picture or motion graphics instead); do not run it again unless they ask.');
}

/**
 * A time limit that stops while the person is being asked (they may take minutes; the provider does not).
 * @param {number} seconds @param {AbortSignal} outer
 */
function deadline(seconds, outer) {
  const controller = new AbortController();
  let left = seconds * 1000, since = Date.now(), fired = false;
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const start = () => { since = Date.now(); timer = setTimeout(() => { fired = true; controller.abort(); }, Math.max(0, left)); };
  start();
  return {
    signal: AbortSignal.any([outer, controller.signal]),
    pause() { clearTimeout(timer); left -= Date.now() - since; },
    resume: start,
    clear() { clearTimeout(timer); },
    timedOut: () => fired,
  };
}

/** A project file for a provider: as it is, or (`speech`) the sound alone, small. @param {string} root @param {string} rel @param {boolean} speech @param {AbortSignal} signal @param {'mp3'} [speechFormat] */
async function readInput(root, rel, speech, signal, speechFormat) {
  const abs = inside(root, rel);
  const bytes = speech ? await speechOf(abs, signal, speechFormat) : await readFile(abs);
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new GetError(speech
      ? `${rel} is too long to transcribe in one go (${Math.round(bytes.length / 1e6)} MB of speech even compressed, about ${Math.round(bytes.length / 3000 / 3600)} hours). Split it into parts first.`
      : `${rel} is too large to send (${Math.round(bytes.length / 1e6)} MB); use a smaller picture.`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * The speech of a recording, as transcription needs it: mono, 16 kHz, low bitrate, in the same format as the file (its
 * name and extension go with it). An hour of video is gigabytes; its speech this way is about 11 MB.
 * @param {string} abs @param {AbortSignal} signal @param {'mp3'} [speechFormat]
 */
async function speechOf(abs, signal, speechFormat) {
  // A provider may require MP3 regardless of the source container. Stream it without temporary files.
  if (speechFormat === 'mp3') {
    return new Promise((done, fail) => {
      execFile('ffmpeg', ['-nostdin', '-v', 'error', '-i', abs, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-af', 'aresample=async=1:first_pts=0', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', 'pipe:1'],
        { signal, windowsHide: true, encoding: 'buffer', maxBuffer: MAX_INPUT_BYTES }, (error, out) => {
          if (error) return fail(new GetError('Could not prepare MP3 speech for transcription. Check the audio track, FFmpeg and recording length. No audio was uploaded.'));
          done(out);
        });
    });
  }
  const ext = extname(abs).toLowerCase();
  const format = ['.mp4', '.m4a', '.m4v', '.mov', '.3gp'].includes(ext) ? { codec: ['-c:a', 'aac', '-b:a', '32k'], f: 'mp4' }
    : ext === '.mp3' ? { codec: ['-c:a', 'libmp3lame', '-b:a', '32k'], f: 'mp3' }
    : ext === '.wav' ? { codec: ['-c:a', 'pcm_s16le'], f: 'wav' }
    : { codec: ['-c:a', 'libopus', '-b:a', '24k'], f: ext === '.webm' ? 'webm' : 'matroska' };
  const dir = await mkdtemp(join(tmpdir(), 'openfilm-speech-'));
  const to = join(dir, `speech${ext || '.mka'}`);
  try {
    await new Promise((done, fail) => {
      execFile('ffmpeg', ['-y', '-v', 'error', '-i', abs, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', ...format.codec, '-f', format.f, to], { signal, windowsHide: true }, (error, _out, stderr) => {
        if (!error) return done(undefined);
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return fail(new GetError('Transcribing needs ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg).'));
        if (signal.aborted) return fail(error);
        fail(new GetError(`Could not read a sound track from ${basename(abs)} to transcribe it (${String(stderr).trim().split('\n').pop()?.slice(0, 160)}). Check that the file has sound.`));
      });
    });
    return await readFile(to);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether `abs` is inside `root` once links are followed: the nearest folder of it that is there decides. */
async function landsInside(/** @type {string} */ root, /** @type {string} */ abs) {
  const top = await realpath(root);
  for (let dir = dirname(abs); ; dir = dirname(dir)) {
    const real = await realpath(dir).catch(() => null);
    if (real) return real === top || real.startsWith(`${top}${sep}`);
    if (dirname(dir) === dir) return false;
  }
}

/** A path a provider may write: under assets/, with nothing odd in it. @param {unknown} path @returns {path is string} */
function landable(path) {
  return typeof path === 'string' && path.startsWith('assets/') && !/[\\\u0000-\u001f:]/.test(path)
    && !path.split('/').some((part) => !part || part === '.' || part === '..');
}

/** A row's word times, as `{ token, startSec, endSec? }` (rows carry `start` / `end`). @param {unknown} raw */
function wordsOf(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w) => {
    if (!w || typeof w !== 'object' || typeof w.token !== 'string' || !w.token) return [];
    const start = Number(w.startSec ?? w.start), end = Number(w.endSec ?? w.end);
    return Number.isFinite(start) && start >= 0 ? [{ token: w.token, startSec: start, ...(Number.isFinite(end) && end >= start ? { endSec: end } : {}) }] : [];
  });
}

/**
 * Land what a provider made: its files under assets/ (nothing else, no `..`), and for speech whose words came timed
 * (a voice-over from a service that times them, a transcript), its transcript beside it (transcripts.mjs). A voice-over
 * without word times gets none: `get asr` makes it.
 * @param {string} root @param {string} verb @param {Record<string, unknown>} args @param {RunResult} result
 */
async function land(root, verb, args, result) {
  for (const file of result.files ?? []) {
    if (!landable(file?.path) || file.path.endsWith('.vtt')) continue;
    const abs = join(root, file.path);
    /* a link the project brings under assets/ is not written through to wherever it leads */
    if (!(await landsInside(root, abs))) continue;
    if ((await lstat(abs).catch(() => null))?.isSymbolicLink()) await rm(abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.bytes);
    /* a sound or video made again under its name: the old take's subtitles go (its own are written below) */
    const kind = clipKind(file.path);
    if (kind === 'sound' || kind === 'video') await dropTranscripts(root, file.path);
  }
  if (verb !== 'tts' && verb !== 'asr') return;
  for (const row of result.index ?? []) {
    /* asr: beside the recording --src names, checked already (in the project, not the tools'); tts: beside the
       provider's file, under assets/ */
    const src = verb === 'asr' ? String(args.src) : row?.src;
    const words = wordsOf(row?.words);
    if ((verb === 'tts' && !landable(src)) || !words.length) continue;
    const text = typeof row.text === 'string' && row.text.trim() ? row.text : words.map((w) => w.token).join(' ');
    const dur = Number(row.dur);
    const lines = spokenLines(text, words, Number.isFinite(dur) && dur > 0 ? dur * 1000 : undefined);
    if (!lines.length) continue;
    const speaker = typeof row.cast === 'string' && row.cast.trim() ? row.cast.trim() : undefined;
    await writeTranscript(root, src, { lines, ...(speaker ? { speaker } : {}) });
    if (verb === 'asr') break;
  }
}

/**
 * The receipt as the agent reads it. Voice-over and transcripts say the same few things whoever made them: what was
 * said comes from the transcript, when there is one. What the provider sent beyond that stays out of the agent's way.
 * @param {string} root @param {string} verb @param {Record<string, unknown>} args @param {Record<string, unknown> | unknown[]} receipt
 */
async function receiptFor(root, verb, args, receipt) {
  const facts = Array.isArray(receipt) ? { results: receipt } : receipt ?? {};
  if (verb !== 'tts' && verb !== 'asr') return facts;
  return speechReceipt(root, verb, String(verb === 'asr' ? args.src : facts.src ?? ''), facts);
}

/**
 * tts and asr receipts: the same fields, in the same order, every time. `transcript`: its path, or why there is none.
 * @param {string} root @param {'tts' | 'asr'} verb @param {string} src @param {Record<string, unknown>} r
 */
async function speechReceipt(root, verb, src, r) {
  const read = await readTranscript(root, src);
  const transcript = read ? transcriptPath(src) : 'none: the service does not time words; `get asr --src` makes one';
  if (verb === 'tts') return { src, dur: r.dur, voiceId: r.voiceId ?? r.voice, skip: r.skip, note: r.note, transcript };
  const text = read ? read.lines.map((l) => l.text).join(' ') : typeof r.text === 'string' ? r.text : '';
  return { src, dur: r.dur, text: text.slice(0, 400), ...(text.length > 400 ? { textOmitted: text.length - 400 } : {}), skip: r.skip, note: r.note, transcript };
}

/** A receipt as text, without what it cost. @param {unknown} receipt */
function show(receipt) {
  /** @type {(v: unknown) => unknown} */
  const visible = (v) => Array.isArray(v) ? v.map(visible)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !BILLING.has(k)).map(([k, x]) => [k, visible(x)])) : v;
  return JSON.stringify(visible(receipt), null, 2);
}

/* ── what there is, and subtitle translation ─────────────────────────────── */

/**
 * What the agent can get here now: the verbs something connected makes, with their options, and `note`, what is not
 * connected (null: everything is). With nothing connected, no verbs and a note saying what to do instead. `only`: that
 * one verb, connected or not. `web`: with web search and reading web pages (WEB_VERBS), for an agent without its own.
 * @param {string} [only] @param {{ web?: boolean }} [options]
 * `services`: the services there are and where the person connects them (services()).
 * @returns {Promise<{ verbs: { verb: string, help: string, dir?: string, options: Record<string, Option> }[], note: string | null, services: string }>}
 */
export async function catalog(only, { web = false } = {}) {
  if (only !== undefined && !VERBS[only]) throw new HttpError(400, `there is no ${only}; there is ${Object.keys(VERBS).join(', ')}`);
  const settings = await providerSettings();
  /* the person's own services: `call`, listed with each of them, whenever there is one */
  const own = settings.custom;
  const listed = Object.entries(VERBS).filter(([verb]) => (only === undefined
    ? (verb === 'call' ? own.length > 0 : (web || !WEB_VERBS.includes(verb)) && offered(verb))
    : verb === only));
  const all = await Promise.all(listed.map(async ([verb, spec]) => ({
    verb, help: verb === 'call' && own.length ? `${spec.help} The person's services: ${servicesHelp(own).join('; ')}` : spec.help,
    ...(spec.dir ? { dir: spec.dir } : {}), options: spec.options,
    usable: verb === 'call' ? own.length > 0 : Boolean(await chooseProvider(/** @type {Verb} */ (verb), { settings })),
  })));
  const missing = all.filter((v) => !v.usable && v.verb !== 'call').map((v) => v.verb);
  if (only === undefined && !all.some((v) => v.usable)) return { verbs: [], note: nothing(), services: services() };
  const notes = [...(missing.length ? [notConnected(missing)] : []), ...(only === 'call' && !own.length ? [NO_OWN_SERVICES] : [])];
  return {
    verbs: all.filter((v) => only !== undefined || v.usable).map(({ usable: _, ...v }) => v),
    note: notes.length ? notes.join(' ') : null,
    services: services(),
  };
}

/**
 * Subtitle translation for captions.mjs, through the provider chosen for `translate`; null when none can.
 * @param {string} root @returns {Promise<TranslateLines | null>}
 */
export async function subtitleTranslator(root) {
  const settings = await providerSettings();
  const provider = await chooseProvider('translate', { settings });
  if (!provider) return null;
  const key = providerKey(provider, settings)?.key ?? '';
  return async ({ signal = new AbortController().signal, ...job }) => {
    const result = await provider.run('translate', job, {
      key, model: modelFor(settings, provider, 'translate'), root, signal, say: () => {}, read: (path) => readInput(root, path, false, signal),
    }).catch((e) => {
      /* the person asked for it in Studio: said to them, with where to top it up */
      if (e?.code === 'balance') throw new Error(`${provider.name} doesn't have enough balance for this. Top it up at ${provider.billingUrl}, or switch to another service, then try again.`);
      throw e;
    });
    const lines = result.receipt?.lines;
    if (!Array.isArray(lines)) throw new Error(`${provider.name} answered without the translated lines.`);
    return /** @type {string[]} */ (lines);
  };
}

/**
 * Transcription for Studio's "make subtitles" (captions.mjs): `get asr` for one source, through the provider chosen for
 * it. The person asked for it in Studio, so it asks nothing more. Throws `code: 'not-connected'` when nothing can.
 * @returns {Promise<import('./captions.mjs').Transcribe>}
 */
export async function subtitleTranscriber() {
  return async (root, src, signal) => {
    if (!(await chooseProvider('asr', { settings: await providerSettings() }).catch(() => null))) {
      throw Object.assign(new Error(notConnected(['asr'])), { code: 'not-connected' });
    }
    await runGet(root, 'asr', { src }, { yes: true, signal });
  };
}

/* ── asking the person ───────────────────────────────────────────────────── */

/**
 * Questions for the person in the Studio pages showing a project: an `{ type: 'ask', ask }` event on its stream, until
 * one page answers (or 15 minutes pass, or the run is called off); then `{ type: 'asked', id }` so every page drops it.
 * A Notice is told the same way, as `{ type: 'notice', notice }`, and wants no answer.
 * `roots`: the projects pages are watching now.
 * @typedef {{ type: 'ask', ask: Spend & { id: string } } | { type: 'asked', id: string } | { type: 'notice', notice: Notice & { id: string } }} AskEvent
 * @param {{ emit: (root: string, event: AskEvent) => void, roots: () => string[] }} pages
 */
export function createAsks(pages) {
  /** @type {Map<string, { root: string, event: { type: 'ask', ask: Spend & { id: string } }, settle: (answer: 'allow' | 'deny' | 'timeout') => void }>} */
  const waiting = new Map();
  const real = (/** @type {string} */ path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return {
    /** @param {string} root @param {Spend} spend @param {AbortSignal} [signal] @returns {Promise<'allow' | 'deny' | 'timeout' | null>} */
    ask(root, spend, signal) {
      const shown = pages.roots().find((r) => real(r) === real(root));
      if (!shown) return Promise.resolve(null);
      const id = randomUUID();
      const event = /** @type {const} */ ({ type: 'ask', ask: { id, ...spend } });
      return new Promise((done) => {
        const settle = (/** @type {'allow' | 'deny' | 'timeout'} */ answer) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          waiting.delete(id);
          pages.emit(shown, { type: 'asked', id });
          done(answer);
        };
        const cancel = () => settle('timeout');
        const timer = setTimeout(cancel, ASK_WAIT_MS);
        timer.unref();
        signal?.addEventListener('abort', cancel, { once: true });
        waiting.set(id, { root: shown, event, settle });
        pages.emit(shown, event);
      });
    },
    /** The person's answer from a page; false when nothing waits for it (answered elsewhere, or too late). @param {string} id @param {boolean} allow */
    answer(id, allow) {
      const one = waiting.get(id);
      one?.settle(allow ? 'allow' : 'deny');
      return Boolean(one);
    },
    /** Tell the pages showing the project (none showing it: nobody is told). @param {string} root @param {Notice} notice */
    tell(root, notice) {
      const shown = pages.roots().find((r) => real(r) === real(root));
      if (shown) pages.emit(shown, { type: 'notice', notice: { id: randomUUID(), ...notice } });
    },
    /** The questions waiting in a project, for a page that opens meanwhile. @param {string} root */
    pending(root) {
      return [...waiting.values()].filter((w) => w.root === root).map((w) => w.event);
    },
  };
}

/* ── the route ───────────────────────────────────────────────────────────── */

/**
 * Studio's `/api/get` (the CLI, with the launch key; a page answers asks with its cookie):
 *   GET  /api/get[?verb=][&web=1] → { verbs: [{ verb, help, dir?, options }], note, services }: what can be got here now
 *                           (see catalog; `web=1` for an agent without web tools of its own)
 *   POST /api/get           { folder, verb, args, via?, model?, yes? } → { ok: true, text } once it is done, or
 *                           { ok: false, code, text }: code 2, not a project or a wrong command; 1, it did not run
 *   POST /api/get/asks/:id  { allow } → { answered }: the person's answer to a question about spending
 * @param {Req} req @param {Res} res @param {string[]} parts the path after /api/get @param {ReturnType<typeof createAsks>} asks
 */
export async function getRoute(req, res, parts, asks) {
  if (!parts.length && req.method === 'GET') {
    const query = new URL(req.url ?? '', 'http://studio').searchParams;
    return json(res, 200, await catalog(query.get('verb') ?? undefined, { web: query.get('web') === '1' }));
  }
  if (parts[0] === 'asks' && parts[1] && req.method === 'POST') {
    const { allow } = /** @type {{ allow?: unknown }} */ (await readJson(req));
    return json(res, 200, { answered: asks.answer(parts[1], allow === true) });
  }
  if (parts.length || req.method !== 'POST') throw new HttpError(404, 'no such API');
  const body = /** @type {{ folder?: unknown, verb?: unknown, args?: unknown, via?: unknown, model?: unknown, yes?: unknown }} */ (await readJson(req));
  /* the CLI gone (Ctrl-C): the run stops with it */
  const controller = new AbortController();
  res.once('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const root = resolve(String(body.folder ?? ''));
    if (!(await stat(join(root, FILM_FILE)).catch(() => null))?.isFile()) throw usage(`${root} is not a project; \`openfilm open\` makes one`);
    const given = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? /** @type {Record<string, unknown>} */ (body.args) : {};
    const text = await runGet(root, String(body.verb ?? ''), given, {
      ...(typeof body.via === 'string' && body.via ? { via: body.via } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      yes: body.yes === true,
      ask: (spend) => asks.ask(root, spend, controller.signal),
      tell: (notice) => asks.tell(root, notice),
      signal: controller.signal,
    });
    json(res, 200, { ok: true, text });
  } catch (e) {
    if (controller.signal.aborted) return;
    json(res, 200, { ok: false, code: e instanceof GetError ? e.code : 1, text: e instanceof Error ? e.message : String(e) });
  }
}
