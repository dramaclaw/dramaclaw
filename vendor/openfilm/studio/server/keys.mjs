// @ts-check
/**
 * The person's own keys for media services (Settings → Providers), which service makes each kind of media and with
 * which model (Settings → Services).
 *
 * Kept in ~/.openfilm/providers.json, readable by this user only (0600, in a 0700 folder), written whole and atomically:
 *   { "keys": { "<provider id>": "<key>" }, "use": { "<verb>": "<provider id>" }, "model": { "<verb>": "<model id>" },
 *     "custom": [ the person's own services (custom-services.mjs), each with its key ] }
 * A kind of media with no model (or one its provider no longer has) is made with the provider's first. Listing voices
 * goes with voice-over: same provider, same model.
 *
 * The file is shared with every OpenFilm on this computer (`npx openfilm`, the app), which may be older or newer than
 * this one: what this one does not know of it (a newer one's field) is written back as it was, never dropped.
 *
 * A key in the environment (the provider's variable, e.g. ELEVENLABS_API_KEY) wins over the file: it is how people
 * already keep keys, and Studio cannot remove it. Keys leave this process only towards their own service; the editor
 * page sees where a key comes from and its last four characters, never the key.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { studioHome } from './projects.mjs';
import { replaceFile } from './atomic.mjs';
import { keptServices } from './custom-services.mjs';

/** @typedef {import('./providers/contract.mjs').Provider} Provider */
/**
 * `off`: the providers disconnected while the environment has a key for them (that key is not used). `custom`: the
 * person's own services.
 * @typedef {{ keys: Record<string, string>, use: Record<string, string>, model: Record<string, string>, off: string[],
 *   custom: import('./custom-services.mjs').CustomService[] }} ProviderSettings
 */

/** Where the keys and choices are kept: ~/.openfilm/providers.json. */
export const providersFile = () => join(studioHome(), 'providers.json');

/** Other names a provider's key goes by in the wild (Google's own tools read either). */
const ALSO = /** @type {Record<string, string[]>} */ ({ GEMINI_API_KEY: ['GOOGLE_API_KEY'] });

const plain = (/** @type {unknown} */ v) => v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
const strings = (/** @type {unknown} */ v) => /** @type {Record<string, string>} */ (Object.fromEntries(Object.entries(plain(v)).filter(([, s]) => typeof s === 'string')));

/** The saved keys and choices (empty when there are none yet). */
export async function readSettings(file = providersFile()) {
  try {
    const info = await stat(file);
    /* someone loosened it: keys are this user's alone */
    if (info.mode & 0o077) await chmod(file, 0o600);
    const raw = plain(JSON.parse(await readFile(file, 'utf8')));
    /* 'auto' was a choice once: it means none now */
    const use = Object.fromEntries(Object.entries(strings(raw.use)).filter(([, id]) => id !== 'auto'));
    const off = Array.isArray(raw.off) ? raw.off.filter((id) => typeof id === 'string') : [];
    return /** @type {ProviderSettings} */ ({ keys: strings(raw.keys), use, model: strings(raw.model), off, custom: keptServices(raw.custom) });
  } catch { return /** @type {ProviderSettings} */ ({ keys: {}, use: {}, model: {}, off: [], custom: [] }); }
}

/**
 * The kind of media a verb is chosen with: voices are found by what speaks them, web pages read by what searches.
 * @param {string} verb
 */
export const kindOf = (verb) => (verb === 'voice' ? 'tts' : verb === 'web-fetch' ? 'web-search' : verb);

/**
 * The model `provider` makes `verb` with: the person's choice while the provider has it, else its first. Voices are
 * found with voice-over's. undefined: the provider names no models for it.
 * @param {ProviderSettings} settings @param {Provider} provider @param {string} verb
 */
export function modelFor(settings, provider, verb) {
  const kind = kindOf(verb);
  const models = provider.models?.[/** @type {import('./providers/contract.mjs').Verb} */ (kind)] ?? [];
  return (models.find((m) => m.id === settings.model[kind]) ?? models[0])?.id;
}

/** @type {Promise<unknown>} one change at a time, each on the file as the last one left it */
let changing = Promise.resolve();

/** Change the settings with `edit` and write them back. Resolves with what was written. */
export function changeSettings(/** @type {(s: ProviderSettings) => void} */ edit, file = providersFile()) {
  const next = changing.catch(() => {}).then(async () => {
    const settings = await readSettings(file);
    edit(settings);
    /* what another OpenFilm keeps here, unknown to this one, stays */
    const kept = plain(await readFile(file, 'utf8').then(JSON.parse, () => null));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ ...kept, ...settings }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await replaceFile(tmp, file);
    return settings;
  });
  changing = next;
  return next;
}

/**
 * A provider's key and where it comes from: the one pasted in Studio (the person's choice), else the environment's
 * unless the person disconnected it there. null: no key.
 * @param {Provider} provider @param {ProviderSettings} settings
 * @returns {{ key: string, source: 'env' | 'file', env: string } | null}
 */
export function providerKey(provider, settings, env = process.env) {
  const kept = settings.keys[provider.id];
  if (kept) return { key: kept, source: 'file', env: provider.env };
  if (settings.off?.includes(provider.id)) return null;
  return envKey(provider, env);
}

/** The environment's key for a provider, connected or not, or null. @param {Provider} provider */
export function envKey(provider, env = process.env) {
  for (const name of [provider.env, ...(ALSO[provider.env] ?? [])]) {
    const key = env[name]?.trim();
    if (key) return { key, source: /** @type {const} */ ('env'), env: name };
  }
  return null;
}

/** A pasted key as it is kept: trimmed, one line, of a plausible length. Throws a sentence the page can show. */
export function cleanKey(/** @type {unknown} */ value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (key.length < 8 || key.length > 512 || /[\s\u0000-\u001f\u007f]/.test(key)) throw new Error('That does not look like an API key: paste the whole key, on its own.');
  return key;
}
