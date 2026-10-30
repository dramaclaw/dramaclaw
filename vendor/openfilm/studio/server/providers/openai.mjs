// @ts-check
/**
 * OpenAI with the person's own key: pictures, voice-over, transcription timed word by word and subtitle translation.
 * REST API (https://platform.openai.com/docs/api-reference), key as a bearer token. Its speech has no word timings, so
 * a voice-over's words are left to Studio to spread over the line; transcription uses whisper-1, the model that times
 * each word.
 */
import { RATIO_SIZE, billedBy, call, clamp, landing, madePicture, modelOf, needed, notes, number, round, serviceUrl, speechUpload, text, translatedLines, translationAsk, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'OpenAI';
/**
 * The models it makes each kind of media with, the default first (https://developers.openai.com/api/docs/models).
 * Transcription is whisper-1's alone: the only one that times each word.
 */
const MODELS = {
  tts: [{ id: 'gpt-4o-mini-tts', name: 'GPT-4o mini TTS' }],
  image: [
    { id: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
    { id: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
    { id: 'gpt-image-2', name: 'GPT Image 2' },
  ],
  asr: [{ id: 'whisper-1', name: 'Whisper' }],
  translate: [
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  ],
};
/** the voices its speech models have (they speak every language) */
const VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
/** the largest file its transcription takes */
const MAX_UPLOAD = 25 * 1024 * 1024;

/** @type {Provider} */
export default {
  id: 'openai',
  name: NAME,
  env: 'OPENAI_API_KEY',
  keysUrl: 'https://platform.openai.com/api-keys',
  billingUrl: 'https://platform.openai.com/settings/organization/billing',
  verbs: ['voice', 'tts', 'image', 'asr', 'translate'],
  models: MODELS,
  async run(verb, args, ctx) {
    const base = serviceUrl('OPENAI', 'https://api.openai.com');
    const send = (/** @type {string} */ path, /** @type {RequestInit} */ init) =>
      call(NAME, `${base}${path}`, { method: 'POST', ...init, headers: { authorization: `Bearer ${ctx.key}`, ...init.headers } }, ctx);
    const post = (/** @type {string} */ path, /** @type {unknown} */ body) =>
      send(path, { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    if (verb === 'voice') {
      const ignored = ['language', 'gender', 'prompt'].filter((f) => text(args[f])).map((f) => `--${f} does not narrow OpenAI's voices: they all speak every language`);
      const limit = clamp(Math.round(number(args.limit) ?? VOICES.length), 1, VOICES.length);
      return {
        files: [],
        index: [],
        receipt: { provider: 'openai', voices: VOICES.slice(0, limit).map((id) => ({ voiceId: id, name: id[0].toUpperCase() + id.slice(1), language: null, gender: null, description: null })), ...notes(ignored) },
      };
    }
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const path = landing('audio/vo', args.out, 'wav');
      const model = modelOf(MODELS, 'tts', ctx);
      const bytes = new Uint8Array(await (await post('/v1/audio/speech', { model, input: said, voice, response_format: 'wav' })).arrayBuffer());
      const dur = wavSeconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'openai', model } }],
        receipt: { provider: 'openai', model, src: path, dur, voice, notes: ['OpenAI gives no word timings: subtitles spread the text over the line'] },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const ratio = text(args.ratio) || '3:2';
      const size = RATIO_SIZE[ratio];
      if (!size) throw new Error(`--ratio is one of ${Object.keys(RATIO_SIZE).join(', ')}.`);
      const quality = text(args.quality) === 'high' ? 'high' : 'low';
      const transparent = Boolean(args.transparent);
      const path = landing('image', args.out, 'png');
      const model = modelOf(MODELS, 'image', ctx);
      const body = await (await post('/v1/images/generations', {
        model, prompt, size: `${size.width}x${size.height}`, quality, output_format: 'png', ...(transparent ? { background: 'transparent' } : {}),
      })).json();
      const b64 = body?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string') throw new Error(`${NAME} answered without a picture.`);
      return { ...madePicture({ path, bytes: new Uint8Array(Buffer.from(b64, 'base64')), prompt, provider: 'openai', model, notes: [] }), cost: billedBy(NAME) };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      if (upload.size > MAX_UPLOAD) throw new Error(`OpenAI transcribes files up to 25 MB and this speech is ${Math.ceil(upload.size / 1048576)} MB: use ElevenLabs for it.`);
      const model = modelOf(MODELS, 'asr', ctx);
      const form = new FormData();
      form.set('model', model);
      form.set('file', upload.blob, upload.name);
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      const body = await (await send('/v1/audio/transcriptions', { body: form })).json();
      const words = (Array.isArray(body?.words) ? body.words : [])
        .filter((/** @type {any} */ w) => Number.isFinite(w?.start) && text(w.word))
        .map((/** @type {any} */ w) => ({ token: text(w.word), start: w.start, end: Number.isFinite(w.end) ? w.end : w.start }));
      const said = text(body?.text);
      return {
        files: [],
        index: [{ src, ...(Number.isFinite(body?.duration) ? { dur: round(body.duration) } : {}), text: said, words, transcribed: true }],
        receipt: { provider: 'openai', model, src, text: said, words: words.length, ...(body?.language ? { language: body.language } : {}) },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'translate') {
      const ask = translationAsk(args.lines, args.language);
      const model = modelOf(MODELS, 'translate', ctx);
      const body = await (await post('/v1/responses', {
        model,
        instructions: ask.system,
        input: ask.user,
        text: { format: { type: 'json_schema', name: 'subtitles', strict: true, schema: {
          type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'], additionalProperties: false,
        } } },
      })).json();
      const answer = (Array.isArray(body?.output) ? body.output : [])
        .flatMap((/** @type {any} */ item) => item?.type === 'message' && Array.isArray(item.content) ? item.content : [])
        .filter((/** @type {any} */ part) => part?.type === 'output_text').map((/** @type {any} */ part) => String(part.text ?? '')).join('');
      return { files: [], index: [], receipt: { provider: 'openai', model, language: text(args.language), lines: translatedLines(answer, ask.count) }, cost: billedBy(NAME) };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
