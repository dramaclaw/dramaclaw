// @ts-check
/**
 * Where `openfilm get` gets media from: services the person connects with their own key, each paid directly, with the
 * model the person chose for each kind of media. Each provider is a module
 * whose default export is a `Provider`; `get.mjs` picks one per verb (`--via`, else the person's choice in Settings;
 * nothing is picked for them) and lands what it returns in the project.
 *
 * Verbs (the same flags whoever serves them; a provider takes the ones it can honor and says so for the rest):
 *   voice         list voices                  --language --gender --prompt --limit
 *   tts           voice-over                   --out --text --voice
 *   sfx           sound effect                 --out --prompt --sec
 *   music         music                        --out --prompt --sec
 *   asr           transcribe a project file    --src --force
 *   image-search  find pictures on the web     --out --prompt --n
 *   image         make a picture               --out --prompt --ratio --quality --transparent
 *   video         make a video clip            --out --prompt --duration --aspect-ratio --first-frame --last-frame
 *                                              --input-reference
 *   web-search    search the web               --query (up to 3)
 *   web-fetch     read web pages               --url (up to 3)
 * and `translate` (subtitles: `{ lines, language }` → translated lines), which is not a CLI verb. Its args also carry
 * the voice it comes from (`src`, `text`, `words`, `dur`) and each line's `times` ({ startSec, endSec }); the lines come
 * back as `receipt.lines`, one string per line asked.
 */

/**
 * @typedef {'voice' | 'tts' | 'sfx' | 'music' | 'asr' | 'image-search' | 'image' | 'video' | 'translate' | 'web-search' | 'web-fetch'} Verb
 */

/**
 * What a run says about a file it made or heard: `{ src, kind, text?, dur?, words?:
 * [{ token, start, end }], cast?, voice?, ... }`. Speech whose words are timed gets its transcript from it (get.mjs).
 * @typedef {Record<string, unknown> & { src: string }} IndexRow
 */

/**
 * What a run gives back. Files go under `assets/` only (no `..`); `index` says what is in them.
 * @typedef {{
 *   files: { path: string, bytes: Uint8Array }[],
 *   index: IndexRow[],
 *   receipt: Record<string, unknown>,
 *   cost?: { note?: string },
 * }} RunResult
 */

/**
 * What spending needs the person's go-ahead for: a video clip before it is made (the provider, the model's name, how
 * long, what it shows), whoever makes it. It carries no amounts: what an account has left is on the provider's own page.
 * @typedef {{
 *   kind: 'video',
 *   provider: string,
 *   model?: string,
 *   seconds?: number,
 *   prompt?: string,
 * }} Spend
 */

/**
 * `read`: a project file's bytes (for `asr`, the speech alone: a small mono copy, in `speechFormat` when requested).
 * `model`: the id of the model, one of the provider's `models` for the verb, the person chose (a provider uses its first
 * when there is none).
 * @typedef {{
 *   key: string,
 *   model?: string,
 *   root: string,
 *   signal: AbortSignal,
 *   say: (line: string) => void,
 *   read: (path: string) => Promise<Uint8Array>,
 * }} RunContext
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   env: string,
 *   keysUrl: string,
 *   billingUrl: string,
 *   verbs: Verb[],
 *   models?: Partial<Record<Verb, { id: string, name: string }[]>>,
 *   checkKey?: (key: string) => void,
 *   speechFormat?: 'mp3',
 *   run: (verb: Verb, args: Record<string, unknown>, ctx: RunContext) => Promise<RunResult>,
 * }} Provider
 * `models`: the models it can make each kind of media with, its default first, each with the name people know it by
 * (Settings → Services shows "ElevenLabs · Multilingual v2").
 * `checkKey`: throws a sentence when a pasted key cannot work as it is (Azure's must carry its region), shown where it
 * is pasted instead of at the first run. Only for what the provider knows without calling anyone: it must not fetch.
 * `billingUrl`: the provider's own page where the person tops up its balance. A run that fails because the account has
 * no balance left throws an Error with `code: 'balance'` (common.mjs `noBalance`), the same for every provider: the
 * person is told in Studio, with this page, and the agent is told to stop.
 */

export {};
