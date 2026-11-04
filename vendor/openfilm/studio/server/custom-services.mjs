// @ts-check
/**
 * The person's own services: any HTTP service, on this computer or elsewhere (a transcription server they run, their
 * own voice, a cloud API OpenFilm has no provider for), added in Settings → Providers with its address, a key when it
 * takes one, where the key goes, and a few words about what it does.
 *
 * `openfilm get call` sends a request to one through Studio, which adds the key (the agent never sees it) and lands
 * what comes back: a file under assets/<service>/, or text and JSON as they are, for the agent to read. OpenFilm knows
 * nothing about what a service answers; the agent does, from the person's words and the service's own docs. The key
 * goes where the agent writes {key} (a header, the path's query), as the docs say; else as `Authorization: Bearer`
 * (or where the person once said, `auth`).
 *
 * A request goes only to the address the person gave (a path under it, never another host), and carries only the
 * project's own files.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clipKind } from '../../src/film-doc.mjs';
import { inside } from './files.mjs';
import { dropTranscripts } from './transcripts.mjs';

/**
 * `auth`: the header the key goes in, `{key}` standing for it (`Authorization: Bearer {key}`, `x-api-key: {key}`).
 * @typedef {{ id: string, name: string, url: string, key?: string, auth: string, note: string }} CustomService
 */

export const DEFAULT_AUTH = 'Authorization: Bearer {key}';
/** The most a file sent to a service may be. */
const MAX_SEND_BYTES = 200 << 20;
/** Text longer than this is saved as a file, its start shown. */
const MAX_SHOWN_CHARS = 20_000;
/** The most the person's words about a service may be: what it does, how it is called, or its docs. */
const MAX_NOTE_CHARS = 2000;
/** How long a service has to answer. */
export const CALL_TIMEOUT_SEC = 600;

const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { status: 400 });
const plainText = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.trim() : '');

/** A service as kept, or null when it is not one (a file edited by hand). @param {unknown} raw @returns {CustomService | null} */
function kept(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = /** @type {Record<string, unknown>} */ (raw);
  if (typeof s.id !== 'string' || typeof s.name !== 'string' || typeof s.url !== 'string') return null;
  return {
    /* what a newer OpenFilm keeps on a service stays with it */
    ...unknownOf(s),
    id: s.id, name: s.name, url: s.url,
    ...(typeof s.key === 'string' && s.key ? { key: s.key } : {}),
    auth: typeof s.auth === 'string' && s.auth.includes('{key}') ? s.auth : DEFAULT_AUTH,
    note: typeof s.note === 'string' ? s.note : '',
  };
}

/** A service's fields this OpenFilm does not know (a newer one's). @param {Record<string, unknown>} s */
const unknownOf = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !['id', 'name', 'url', 'key', 'auth', 'note'].includes(k)));

/** The services kept in the settings file. @param {unknown} raw @returns {CustomService[]} */
export const keptServices = (raw) => (Array.isArray(raw) ? raw.map(kept).filter((s) => s !== null) : []);

/** An address the person gave: http(s), no password in it, no query or fragment; kept without a trailing slash. */
export function cleanAddress(/** @type {unknown} */ value) {
  let url;
  try { url = new URL(plainText(value)); } catch { throw bad('The address is a web address, e.g. http://localhost:8000 or https://api.example.com/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('The address starts with http:// or https://');
  if (url.username || url.password) throw bad('Leave the key out of the address: it has its own field');
  if (url.search || url.hash) throw bad('The address is where the service is, without ? or #: the agent adds the rest');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Where the key goes: `Header-Name: … {key} …`. */
export function cleanAuth(/** @type {unknown} */ value) {
  const auth = plainText(value) || DEFAULT_AUTH;
  if (!/^[A-Za-z0-9-]+:\s*[^\r\n]*\{key\}[^\r\n]*$/.test(auth)) throw bad('Where the key goes is a header with {key} in it, e.g. Authorization: Bearer {key}');
  return auth;
}

/** A key as kept: one line, of a plausible length. */
function cleanServiceKey(/** @type {string} */ key) {
  if (key.length < 4 || key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) throw bad('That does not look like a key: paste the whole key, on its own');
  return key;
}

/** The id a name is called by on the command line: `My Whisper` → `my-whisper`. */
const idOf = (/** @type {string} */ name) => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'service';

/**
 * A service added (`id` null) or changed, from what Settings sends: `name`, `url`, `key` (absent: kept as it is; '':
 * none), `auth`, `note`. Throws a sentence the page shows (status 400).
 * @param {CustomService[]} services @param {string | null} id @param {Record<string, unknown>} input
 * @returns {CustomService[]}
 */
export function withService(services, id, input) {
  const was = id === null ? null : services.find((s) => s.id === id);
  if (id !== null && !was) throw Object.assign(new Error('There is no such service'), { status: 404 });
  const name = plainText(input.name);
  if (!name || name.length > 40 || /[\u0000-\u001f]/.test(name)) throw bad('Give the service a short name (40 characters at most)');
  const others = services.filter((s) => s !== was);
  if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw bad(`There is a service named ${name} already`);
  let newId = was?.id ?? idOf(name);
  for (let n = 2; others.some((s) => s.id === newId); n++) newId = `${idOf(name)}-${n}`;
  const note = plainText(input.note);
  if (note.length > MAX_NOTE_CHARS) throw bad(`Say what it does and how it is called, or where its docs are (${MAX_NOTE_CHARS} characters at most)`);
  const key = input.key === undefined ? was?.key : plainText(input.key) ? cleanServiceKey(plainText(input.key)) : undefined;
  /* where the key goes, when Settings says (it no longer asks: the agent writes {key} where the docs want it) */
  const auth = input.auth === undefined ? (was?.auth ?? DEFAULT_AUTH) : cleanAuth(input.auth);
  /** @type {CustomService} */
  const service = { ...(was ? unknownOf(was) : {}), id: newId, name, url: cleanAddress(input.url), ...(key ? { key } : {}), auth, note };
  return was ? services.map((s) => (s === was ? service : s)) : [...services, service];
}

/** A service as Settings shows it: never its key, only its last four characters. @param {CustomService} s */
export const shownService = (s) => ({ id: s.id, name: s.name, url: s.url, auth: s.auth, note: s.note, last4: s.key ? s.key.slice(-4) : null });

/** The services as `openfilm get` lists them for the agent. @param {CustomService[]} services */
export const servicesHelp = (services) => services.map((s) => `--service ${s.id}: ${s.name} at ${s.url}${s.note ? `. ${s.note.replace(/\s+/g, ' ')}` : ''}`);

/* ── a request ───────────────────────────────────────────────────────────── */

/**
 * The address a path asks for, under the service's own: `/v1/audio/transcriptions?x=1` → its URL. Never another host,
 * never out of the service's path. @param {string} base @param {string} path
 */
export function targetOf(base, path) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f#]/.test(path)) throw bad('--path starts with / and stays under the service, e.g. --path /v1/audio/transcriptions');
  const at = new URL(base);
  const prefix = at.pathname.replace(/\/+$/, '');
  const url = new URL(`${at.origin}${prefix}${path}`);
  if (url.origin !== at.origin || !(url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) || url.pathname.split('/').includes('..')) {
    throw bad('--path stays under the service\'s address');
  }
  return url;
}

/** A project file to send. @param {string} root @param {string} rel @param {string} flag */
async function projectBytes(root, rel, flag) {
  let abs;
  try { abs = inside(root, rel); } catch { throw bad(`${flag} ${rel} is not a path inside the project`); }
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw bad(`${flag} ${rel} is not in the project`);
  if (info.size > MAX_SEND_BYTES) throw bad(`${rel} is too large to send (${Math.round(info.size / 1e6)} MB)`);
  return { bytes: await readFile(abs), name: basename(rel), type: typeOf(rel) };
}

/** `name=value` of --form and --file. @param {string} pair @param {string} flag */
function split(pair, flag) {
  const at = pair.indexOf('=');
  if (at < 1) throw bad(`${flag} is written name=value, e.g. ${flag === '--file' ? '--file file=assets/voice/1.wav' : '--form model=whisper-1'}`);
  return [pair.slice(0, at), pair.slice(at + 1)];
}

const TYPES = /** @type {Record<string, string>} */ ({
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.vtt': 'text/vtt',
  '.srt': 'text/plain', '.html': 'text/html', '.csv': 'text/csv', '.pdf': 'application/pdf',
});
const typeOf = (/** @type {string} */ path) => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
/** The extension for what a service answered with. */
const extFor = (/** @type {string} */ type) => Object.entries(TYPES).find(([, t]) => t === type)?.[0]
  ?? ({ 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-flac': '.flac', 'audio/webm': '.webm' })[type] ?? '.bin';
const isText = (/** @type {string} */ type) => /^text\/|[/+]json$|\/xml$|[/+]xml$|javascript|x-www-form-urlencoded|x-ndjson/.test(type);

/**
 * Send `args` to `service` and land what it answers, for the project at `root`. Resolves with what the agent reads;
 * throws an Error whose `status` 400 is a mistake in the command, anything else what went wrong on the way.
 * @param {string} root @param {CustomService} service
 * @param {{ path?: string, method?: string, json?: string, form?: string[], file?: string[], body?: string, header?: string[], out?: string }} args
 * @param {AbortSignal} signal
 */
export async function callService(root, service, args, signal) {
  /* {key}: where the agent wants the key, filled in here (it never has it); with none, the usual header */
  const placed = [args.path ?? '', ...(args.header ?? [])].some((v) => v.includes('{key}'));
  if (placed && !service.key) throw bad(`${service.name} has no key in Settings, so {key} has nothing to stand for`);
  const fill = (/** @type {string} */ v, encode = false) => (service.key ? v.replaceAll('{key}', encode ? encodeURIComponent(service.key) : service.key) : v);
  const url = targetOf(service.url, fill(args.path ?? '/', true));
  const forms = args.form ?? [], files = args.file ?? [];
  const kinds = [args.json !== undefined, forms.length + files.length > 0, args.body !== undefined].filter(Boolean).length;
  if (kinds > 1) throw bad('Send one kind of body: --json, or --form and --file, or --body');
  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {BodyInit | undefined} */
  let body;
  if (args.json !== undefined) {
    try { JSON.parse(args.json); } catch { throw bad('--json is JSON, e.g. --json \'{"text":"Hello"}\''); }
    body = args.json;
    headers['content-type'] = 'application/json';
  } else if (forms.length || files.length) {
    const form = new FormData();
    for (const pair of forms) { const [k, v] = split(pair, '--form'); form.append(k, v); }
    for (const pair of files) {
      const [k, rel] = split(pair, '--file');
      const f = await projectBytes(root, rel, '--file');
      form.append(k, new Blob([f.bytes], { type: f.type }), f.name);
    }
    body = form;
  } else if (args.body !== undefined) {
    const f = await projectBytes(root, args.body, '--body');
    body = new Blob([f.bytes], { type: f.type });
    headers['content-type'] = f.type;
  }
  for (const line of args.header ?? []) {
    const at = line.indexOf(':');
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(line)) throw bad('--header is written "Name: value"');
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(name)) throw bad(`--header ${name} is set by Studio`);
    headers[name.toLowerCase()] = fill(line.slice(at + 1).trim());
  }
  if (service.key && !placed) {
    const at = service.auth.indexOf(':');
    headers[service.auth.slice(0, at).trim().toLowerCase()] = service.auth.slice(at + 1).trim().replaceAll('{key}', service.key);
  }
  const method = (args.method ?? (body === undefined ? 'GET' : 'POST')).toUpperCase();
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) throw bad(`A ${method} request sends no body: use --method POST`);
  const hide = (/** @type {string} */ text) => (service.key ? text.replaceAll(service.key, '••••') : text);

  let res;
  try {
    res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_SEC * 1000)]) });
  } catch (e) {
    if (signal.aborted) throw e;
    const why = /** @type {{ cause?: { code?: string } }} */ (e)?.cause?.code;
    throw new Error(why === 'ECONNREFUSED' ? `${service.name} is not answering at ${service.url}: is it running?`
      : /** @type {Error} */ (e)?.name === 'TimeoutError' ? `${service.name} did not answer within ${CALL_TIMEOUT_SEC} s.`
        : `${service.name} could not be reached at ${service.url} (${hide(String(/** @type {Error} */ (e)?.message ?? e))}).`);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const head = `${service.name} answered ${res.status}${type ? ` (${type})` : ''}`;
  if (!res.ok) {
    const said = hide((await res.text().catch(() => '')).slice(0, 2000)).trim();
    throw new Error(`${head}${said ? `:\n${said}` : '.'}`);
  }
  const name = args.out ?? `${service.id}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`;
  const dir = `assets/${service.id}`;
  if (!res.body) return `${head}, with nothing in it.`;
  /* no type said: text when its bytes are text */
  /** @type {Readable | null} */
  let stream = null;
  let text = isText(type) ? await res.text() : null;
  if (!type) {
    const bytes = Buffer.from(await res.arrayBuffer());
    try { text = bytes.includes(0) ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = null; }
    stream = Readable.from([bytes]);
  }
  if (text !== null) {
    text = hide(text);
    if (text.length <= MAX_SHOWN_CHARS) return `${head}:\n${text}`;
    const rel = `${dir}/${name}${type.includes('json') ? '.json' : '.txt'}`;
    await land(root, rel, Readable.from([text]));
    return `${head}, ${Math.round(text.length / 1000)} k characters, saved as ${rel}. Its start:\n${text.slice(0, 4000)}`;
  }
  const rel = `${dir}/${name}${extFor(type)}`;
  const size = await land(root, rel, stream ?? Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (res.body)), signal);
  /* a sound or video saved over the last one: the old take's subtitles are not this one's */
  const kind = clipKind(rel);
  if (kind === 'sound' || kind === 'video') await dropTranscripts(root, rel);
  return `${head}: saved as ${rel} (${size < 1e6 ? `${Math.max(1, Math.round(size / 1000))} kB` : `${(size / 1e6).toFixed(1)} MB`}).`;
}

/** Write a stream under the project's assets/ (a hidden name until it is whole); resolves with its size. */
async function land(/** @type {string} */ root, /** @type {string} */ rel, /** @type {Readable} */ from, /** @type {AbortSignal | undefined} */ signal = undefined) {
  const abs = inside(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  const part = join(dirname(abs), `.${basename(abs)}.${process.pid}.part`);
  try {
    await pipeline(from, createWriteStream(part), ...(signal ? [{ signal }] : []));
    await rename(part, abs);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  return (await stat(abs)).size;
}
