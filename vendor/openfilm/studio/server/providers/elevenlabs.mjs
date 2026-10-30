// @ts-check
/**
 * ElevenLabs with the person's own key: its voices, voice-over timed word by word, sound effects, music and
 * transcription. REST API (https://elevenlabs.io/docs/api-reference), key in `xi-api-key`. Audio comes as constant
 * 128 kbps MP3, so its length is known from its size.
 */
import { billedBy, call, clamp, mp3Seconds, modelOf, needed, landing, notes, number, serviceUrl, speechUpload, text, wordsFromCharacters } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'ElevenLabs';
/** the models it makes each kind of media with, the default first (https://elevenlabs.io/docs/models) */
const MODELS = {
  tts: [
    { id: 'eleven_multilingual_v2', name: 'Multilingual v2' },
    { id: 'eleven_v4', name: 'Eleven v4' },
    { id: 'eleven_flash_v2_5', name: 'Flash v2.5' },
  ],
  sfx: [{ id: 'eleven_text_to_sound_v2', name: 'Sound Effects v2' }],
  music: [{ id: 'music_v2_5', name: 'Music v2.5' }, { id: 'music_v2', name: 'Music v2' }],
  asr: [{ id: 'scribe_v2', name: 'Scribe v2' }],
};
const FORMAT = 'mp3_44100_128';

/** @type {Provider} */
export default {
  id: 'elevenlabs',
  name: NAME,
  env: 'ELEVENLABS_API_KEY',
  keysUrl: 'https://elevenlabs.io/app/settings/api-keys',
  billingUrl: 'https://elevenlabs.io/app/subscription',
  verbs: ['voice', 'tts', 'sfx', 'music', 'asr'],
  models: MODELS,
  async run(verb, args, ctx) {
    const base = serviceUrl('ELEVENLABS', 'https://api.elevenlabs.io');
    const send = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
      call(NAME, `${base}${path}`, { ...init, headers: { 'xi-api-key': ctx.key, ...init.headers } }, ctx);
    const post = (/** @type {string} */ path, /** @type {unknown} */ body) =>
      send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    if (verb === 'voice') return voices(args, send);
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const path = landing('audio/vo', args.out, 'mp3');
      const model = modelOf(MODELS, 'tts', ctx);
      const body = await (await post(`/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=${FORMAT}`, { text: said, model_id: model })).json();
      if (typeof body?.audio_base64 !== 'string') throw new Error(`${NAME} answered without audio.`);
      const bytes = new Uint8Array(Buffer.from(body.audio_base64, 'base64'));
      const dur = mp3Seconds(bytes);
      const a = body.alignment ?? body.normalized_alignment;
      const words = Array.isArray(a?.characters) ? wordsFromCharacters(a.characters, a.character_start_times_seconds ?? [], a.character_end_times_seconds ?? [], dur) : [];
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', dur, text: said, voice, ...(words.length ? { words } : {}), from: { mode: 'synth', text: said, voice, provider: 'elevenlabs', model } }],
        receipt: { provider: 'elevenlabs', model, src: path, dur, voice, words: words.length },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'sfx' || verb === 'music') {
      const prompt = needed(args, 'prompt');
      const sec = number(args.sec);
      const path = landing(verb === 'sfx' ? 'audio/sfx' : 'audio/music', args.out, 'mp3');
      const model = modelOf(MODELS, verb, ctx);
      const res = verb === 'sfx'
        ? await post(`/v1/sound-generation?output_format=${FORMAT}`, { text: prompt, model_id: model, ...(sec !== null ? { duration_seconds: clamp(sec, 0.5, 30) } : {}) })
        : await post(`/v1/music?output_format=${FORMAT}`, { prompt, model_id: model, ...(sec !== null ? { music_length_ms: Math.round(clamp(sec, 3, 600) * 1000) } : {}) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const dur = mp3Seconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', dur, from: { mode: 'generate', prompt, ...(sec !== null ? { sec } : {}), provider: 'elevenlabs', model } }],
        receipt: { provider: 'elevenlabs', model, src: path, dur },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      const model = modelOf(MODELS, 'asr', ctx);
      const form = new FormData();
      form.set('model_id', model);
      form.set('file', upload.blob, upload.name);
      form.set('timestamps_granularity', 'word');
      form.set('tag_audio_events', 'false');
      const body = await (await send('/v1/speech-to-text', { method: 'POST', body: form })).json();
      const words = (Array.isArray(body?.words) ? body.words : [])
        .filter((/** @type {any} */ w) => w?.type === 'word' && Number.isFinite(w.start) && text(w.text))
        .map((/** @type {any} */ w) => ({ token: text(w.text), start: w.start, end: Number.isFinite(w.end) ? w.end : w.start }));
      const said = text(body?.text);
      return {
        files: [],
        index: [{ src, text: said, words, transcribed: true }],
        receipt: { provider: 'elevenlabs', model, src, text: said, words: words.length, ...(body?.language_code ? { language: body.language_code } : {}) },
        cost: billedBy(NAME),
      };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};

/**
 * The account's voices (its own and the premade ones), searched by the prompt, then by language and gender. Each as
 * `openfilm get voice` gives it: { voiceId, name, language, gender, description }.
 * @param {Record<string, unknown>} args @param {(path: string) => Promise<Response>} send
 */
async function voices(args, send) {
  const limit = clamp(Math.round(number(args.limit) ?? 5), 1, 100);
  const language = text(args.language).toLowerCase();
  const gender = text(args.gender).toLowerCase().slice(0, 1);
  const prompt = text(args.prompt);
  const page = async (/** @type {string} */ search) => {
    const query = new URLSearchParams({ page_size: '100', ...(search ? { search } : {}) });
    const body = await (await send(`/v2/voices?${query}`)).json();
    return /** @type {any[]} */ (Array.isArray(body?.voices) ? body.voices : []);
  };
  const said = [];
  let found = await page(prompt);
  if (prompt && !found.length) {
    found = await page('');
    said.push(`no voice matched "${prompt}"; these are others`);
  }
  const list = found.map((v) => {
    const labels = v.labels && typeof v.labels === 'object' ? v.labels : {};
    const languages = [...new Set([...(Array.isArray(v.verified_languages) ? v.verified_languages.map((/** @type {any} */ l) => text(l?.language)) : []), text(labels.language)].filter(Boolean))];
    const sex = text(labels.gender).toLowerCase();
    return {
      voiceId: text(v.voice_id),
      name: text(v.name),
      language: languages.join(', ') || null,
      gender: sex === 'male' ? 'm' : sex === 'female' ? 'f' : null,
      description: text(v.description) || [labels.description, labels.accent, labels.age, labels.use_case].map(text).filter(Boolean).join(', ') || null,
      languages,
    };
  }).filter((v) => v.voiceId
    /* a voice that says nothing of its languages speaks them all (the multilingual model) */
    && (!language || !v.languages.length || v.languages.some((l) => l.toLowerCase().startsWith(language)))
    && (!gender || v.gender === gender));
  return {
    files: [],
    index: [],
    receipt: { provider: 'elevenlabs', voices: list.slice(0, limit).map(({ languages: _, ...v }) => v), ...notes(said) },
  };
}
