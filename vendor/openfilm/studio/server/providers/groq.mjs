// @ts-check
/**
 * Groq with the person's own key: fast transcription timed word by word (Whisper) and voice-over (Orpheus). Its API is
 * OpenAI's (https://console.groq.com/docs/api-reference), under /openai/v1, key as a bearer token. Orpheus speaks up to
 * 200 characters at a time, as WAV, with no word timings: a voice-over's words are left to Studio to spread over the
 * line.
 */
import { billedBy, call, clamp, landing, modelOf, needed, notes, number, round, serviceUrl, speechUpload, text, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Groq';
/** the models it makes each kind of media with, the default first (https://console.groq.com/docs/models) */
const MODELS = {
  asr: [{ id: 'whisper-large-v3-turbo', name: 'Whisper Large v3 Turbo' }, { id: 'whisper-large-v3', name: 'Whisper Large v3' }],
  tts: [{ id: 'canopylabs/orpheus-v1-english', name: 'Orpheus English' }, { id: 'canopylabs/orpheus-arabic-saudi', name: 'Orpheus Arabic (Saudi)' }],
};
/** each speech model's voices: id, name, gender */
const VOICES = /** @type {Record<string, [string, string, 'm' | 'f'][]>} */ ({
  'canopylabs/orpheus-v1-english': [['autumn', 'Autumn', 'f'], ['diana', 'Diana', 'f'], ['hannah', 'Hannah', 'f'], ['austin', 'Austin', 'm'], ['daniel', 'Daniel', 'm'], ['troy', 'Troy', 'm']],
  'canopylabs/orpheus-arabic-saudi': [['abdullah', 'Abdullah', 'm'], ['fahad', 'Fahad', 'm'], ['sultan', 'Sultan', 'm'], ['lulwa', 'Lulwa', 'f'], ['noura', 'Noura', 'f'], ['aisha', 'Aisha', 'f']],
});
/** the language each speech model speaks */
const LANGUAGE = /** @type {Record<string, string>} */ ({ 'canopylabs/orpheus-v1-english': 'en', 'canopylabs/orpheus-arabic-saudi': 'ar' });
/** the most text Orpheus speaks at once */
const MAX_TEXT = 200;
/** the largest file its transcription takes (25 MB on its free tier) */
const MAX_UPLOAD = 100 * 1024 * 1024;

/** @type {Provider} */
export default {
  id: 'groq',
  name: NAME,
  env: 'GROQ_API_KEY',
  keysUrl: 'https://console.groq.com/keys',
  billingUrl: 'https://console.groq.com/settings/billing',
  verbs: ['voice', 'tts', 'asr'],
  models: MODELS,
  async run(verb, args, ctx) {
    const base = serviceUrl('GROQ', 'https://api.groq.com');
    const send = (/** @type {string} */ path, /** @type {RequestInit} */ init) =>
      call(NAME, `${base}/openai/v1${path}`, { method: 'POST', ...init, headers: { authorization: `Bearer ${ctx.key}`, ...init.headers } }, ctx);

    if (verb === 'voice') {
      const model = modelOf(MODELS, 'tts', ctx);
      const language = text(args.language).toLowerCase();
      const gender = text(args.gender).toLowerCase().slice(0, 1);
      const said = [
        ...(language && !language.startsWith(LANGUAGE[model]) ? [`these voices speak ${LANGUAGE[model] === 'en' ? 'English' : 'Arabic'} only (another model in Settings → Services)`] : []),
        ...(text(args.prompt) ? ['--prompt does not narrow Groq\'s voices'] : []),
      ];
      const limit = clamp(Math.round(number(args.limit) ?? 5), 1, 100);
      const voices = VOICES[model].filter(([, , g]) => !gender || g === gender).slice(0, limit)
        .map(([id, name, g]) => ({ voiceId: id, name, language: LANGUAGE[model], gender: g, description: null }));
      return { files: [], index: [], receipt: { provider: 'groq', voices, ...notes(said) } };
    }
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      if (said.length > MAX_TEXT) throw new Error(`Groq's Orpheus speaks ${MAX_TEXT} characters at a time and this line has ${said.length}: split it into shorter lines.`);
      const path = landing('audio/vo', args.out, 'wav');
      const model = modelOf(MODELS, 'tts', ctx);
      const res = await send('/audio/speech', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: said, voice, response_format: 'wav' }) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const dur = wavSeconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'groq', model } }],
        receipt: { provider: 'groq', model, src: path, dur, voice, notes: ['Groq gives no word timings: subtitles spread the text over the line'] },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      if (upload.size > MAX_UPLOAD) throw new Error(`Groq transcribes files up to 100 MB and this speech is ${Math.ceil(upload.size / 1048576)} MB: use ElevenLabs for it.`);
      const model = modelOf(MODELS, 'asr', ctx);
      const form = new FormData();
      form.set('model', model);
      form.set('file', upload.blob, upload.name);
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      const body = /** @type {any} */ (await (await send('/audio/transcriptions', { body: form })).json());
      const words = (Array.isArray(body?.words) ? body.words : [])
        .filter((/** @type {any} */ w) => Number.isFinite(w?.start) && text(w.word))
        .map((/** @type {any} */ w) => ({ token: text(w.word), start: w.start, end: Number.isFinite(w.end) ? w.end : w.start }));
      const said = text(body?.text);
      return {
        files: [],
        index: [{ src, ...(Number.isFinite(body?.duration) ? { dur: round(body.duration) } : {}), text: said, words, transcribed: true }],
        receipt: { provider: 'groq', model, src, text: said, words: words.length, ...(body?.language ? { language: body.language } : {}) },
        cost: billedBy(NAME),
      };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
