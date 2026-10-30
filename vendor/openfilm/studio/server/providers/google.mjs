// @ts-check
/**
 * Google's Gemini API with the person's own key: pictures, video (Veo), voice-over, transcription and subtitle
 * translation. REST API (https://ai.google.dev/api), key in `x-goog-api-key`. Pictures, speech and text come from
 * `generateContent`; transcription uses Gemini Transcribe through the Interactions API; a video is a long-running
 * operation, asked after until it is done. Generated speech has no word timings and comes as raw PCM, wrapped here in
 * a WAV file.
 */
import { RATIO_SIZE, billedBy, call, clamp, download, extOf, imageSize, landing, list, madePicture, mimeOf, modelOf, needed, notes, number, ownAddress, serviceUrl, sleep, speechUpload, text, translatedLines, translationAsk, wav, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'Google';
/** the models it makes each kind of media with, the default first (https://ai.google.dev/gemini-api/docs/models) */
const MODELS = {
  tts: [{ id: 'gemini-3.8-flash-tts', name: 'Gemini 3.8 Flash TTS' }, { id: 'gemini-3.8-flash-lite-tts', name: 'Gemini 3.8 Flash-Lite TTS' }],
  asr: [{ id: 'gemini-3.5-transcribe', name: 'Gemini 3.5 Transcribe' }],
  image: [
    { id: 'gemini-3.1-flash-image', name: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3-pro-image', name: 'Nano Banana Pro' },
    { id: 'gemini-3.1-flash-lite-image', name: 'Gemini 3.1 Flash-Lite Image' },
  ],
  video: [
    { id: 'veo-3.1-generate-preview', name: 'Veo 3.1' },
    { id: 'veo-3.1-fast-generate-preview', name: 'Veo 3.1 Fast' },
    { id: 'veo-3.1-lite-generate-preview', name: 'Veo 3.1 Lite' },
  ],
  translate: [
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
};
/** the image model that makes 1K pictures only */
const ONE_K_ONLY = 'gemini-3.1-flash-lite-image';

/** The prebuilt voices (they speak every language), each with how Google describes it. */
const VOICES = /** @type {[string, string][]} */ ([
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'], ['Leda', 'Youthful'],
  ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'], ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'], ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'], ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'], ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
]);

/** How long to wait between asking after a video (tests make it short). */
export const polling = { ms: 10_000 };

/** @type {Provider} */
export default {
  id: 'google',
  name: NAME,
  env: 'GEMINI_API_KEY',
  keysUrl: 'https://aistudio.google.com/apikey',
  /* AI Studio's keys page is where a key's project shows its billing */
  billingUrl: 'https://aistudio.google.com/apikey',
  verbs: ['voice', 'tts', 'image', 'video', 'asr', 'translate'],
  models: MODELS,
  async run(verb, args, ctx) {
    const base = serviceUrl('GOOGLE', 'https://generativelanguage.googleapis.com');
    const send = (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) =>
      call(NAME, url, { ...init, headers: { 'x-goog-api-key': ctx.key, 'content-type': 'application/json', ...init.headers } }, ctx);
    const generate = async (/** @type {string} */ model, /** @type {unknown} */ body) =>
      /** @type {any} */ (await (await send(`${base}/v1beta/models/${model}:generateContent`, { method: 'POST', body: JSON.stringify(body) })).json());

    if (verb === 'voice') {
      const prompt = text(args.prompt).toLowerCase();
      const ignored = ['language', 'gender'].filter((f) => text(args[f])).map((f) => `--${f} does not narrow Google's voices: they all speak every language`);
      /* the voices whose description the prompt names come first */
      const ranked = prompt ? [...VOICES].sort((a, b) => Number(prompt.includes(b[1].toLowerCase())) - Number(prompt.includes(a[1].toLowerCase()))) : VOICES;
      const limit = clamp(Math.round(number(args.limit) ?? 5), 1, VOICES.length);
      return {
        files: [],
        index: [],
        receipt: { provider: 'google', voices: ranked.slice(0, limit).map(([name, description]) => ({ voiceId: name, name, language: null, gender: null, description })), ...notes(ignored) },
      };
    }
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const path = landing('audio/vo', args.out, 'wav');
      const model = modelOf(MODELS, 'tts', ctx);
      const body = await generate(model, {
        contents: [{ parts: [{ text: said }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      });
      const audio = inline(body, 'audio');
      const raw = new Uint8Array(Buffer.from(audio.data, 'base64'));
      /* raw PCM says its rate in its type: audio/L16;codec=pcm;rate=24000 */
      const bytes = /wav/i.test(audio.mimeType) ? raw : wav(raw, Number(/rate=(\d+)/.exec(audio.mimeType)?.[1]) || 24000);
      const dur = wavSeconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'google', model } }],
        receipt: { provider: 'google', model, src: path, dur, voice, notes: ['Google gives no word timings: subtitles spread the text over the line'] },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const upload = await speechUpload(src, ctx);
      const model = modelOf(MODELS, 'asr', ctx);
      const file = await uploadFile(upload, base, send);
      try {
        const body = await (await send(`${base}/v1beta/interactions`, {
          method: 'POST',
          body: JSON.stringify({
            model,
            input: [{ type: 'audio', uri: file.uri, mime_type: file.mimeType }],
            generation_config: { transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } } },
          }),
        })).json();
        const words = interactionWords(body);
        const said = interactionText(body);
        if (said && !words.length) throw new Error(`${NAME} answered without word timestamps.`);
        return {
          files: [],
          index: [{ src, text: said, words, transcribed: true }],
          receipt: { provider: 'google', model, src, text: said, words: words.length },
          cost: billedBy(NAME),
        };
      } finally {
        /* Files otherwise remain in the person's Gemini project for up to 48 hours. Cleanup must not hide the ASR result. */
        if (/^files\/[a-z0-9-]+$/i.test(file.name)) await send(`${base}/v1beta/${file.name}`, { method: 'DELETE' }).catch(() => {});
      }
    }
    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const ratio = text(args.ratio) || '3:2';
      if (!RATIO_SIZE[ratio]) throw new Error(`--ratio is one of ${Object.keys(RATIO_SIZE).join(', ')}.`);
      const model = modelOf(MODELS, 'image', ctx);
      const high = text(args.quality) === 'high' && model !== ONE_K_ONLY;
      const said = [
        ...(args.transparent ? ['--transparent: Gemini makes opaque pictures'] : []),
        ...(text(args.quality) === 'high' && !high ? ['--quality high: Flash-Lite Image makes 1K pictures only'] : []),
      ];
      const body = await generate(model, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio, imageSize: high ? '2K' : '1K' } },
      });
      const picture = inline(body, 'image');
      const path = landing('image', args.out, extOf(picture.mimeType, 'png'));
      return { ...madePicture({ path, bytes: new Uint8Array(Buffer.from(picture.data, 'base64')), prompt, provider: 'google', model, notes: said }), cost: billedBy(NAME) };
    }
    if (verb === 'translate') {
      const ask = translationAsk(args.lines, args.language);
      const model = modelOf(MODELS, 'translate', ctx);
      const body = await generate(model, {
        systemInstruction: { parts: [{ text: ask.system }] },
        contents: [{ role: 'user', parts: [{ text: ask.user }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });
      const answer = (body?.candidates?.[0]?.content?.parts ?? []).map((/** @type {any} */ p) => String(p?.text ?? '')).join('');
      return { files: [], index: [], receipt: { provider: 'google', model, language: text(args.language), lines: translatedLines(answer, ask.count) }, cost: billedBy(NAME) };
    }
    if (verb === 'video') return video(args, ctx, base, send);
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};

/**
 * A prepared speech file uploaded with Gemini's resumable Files API. The returned upload address is accepted only on
 * Google's configured origin, so the person's key and bytes cannot be redirected elsewhere.
 * @param {{ blob: Blob, name: string, size: number }} upload @param {string} base
 * @param {(url: string, init?: RequestInit) => Promise<Response>} send
 */
async function uploadFile(upload, base, send) {
  const mimeType = upload.blob.type || mimeOf(upload.name);
  const started = await send(`${base}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(upload.size),
      'x-goog-upload-header-content-type': mimeType,
    },
    body: JSON.stringify({ file: { display_name: upload.name } }),
  });
  const uploadUrl = ownAddress(NAME, started.headers.get('x-goog-upload-url'), base);
  const body = await (await send(uploadUrl, {
    method: 'POST',
    headers: {
      'content-type': mimeType,
      'content-length': String(upload.size),
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
    },
    body: upload.blob,
  })).json();
  const file = body?.file;
  const uri = text(file?.uri), name = text(file?.name);
  if (!uri || !name) throw new Error(`${NAME} did not keep the speech upload.`);
  return { uri, name, mimeType: text(file?.mimeType ?? file?.mime_type) || mimeType };
}

/** Seconds from a protobuf duration such as `0.450s`. @param {unknown} value */
function offsetSeconds(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/s$/, '') : value;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** The text output parts of a completed interaction. @param {any} body */
function interactionContents(body) {
  return (Array.isArray(body?.steps) ? body.steps : [])
    .filter((/** @type {any} */ step) => !step?.type || step.type === 'model_output')
    .flatMap((/** @type {any} */ step) => Array.isArray(step?.content) ? step.content : []);
}

/** @param {any} body */
function interactionText(body) {
  const direct = text(body?.output_text ?? body?.outputText);
  return direct || interactionContents(body).map((/** @type {any} */ part) => text(part?.text)).filter(Boolean).join(' ').trim();
}

/** Gemini word annotations as OpenFilm's provider word contract. @param {any} body */
function interactionWords(body) {
  return interactionContents(body).flatMap((/** @type {any} */ part) => Array.isArray(part?.annotations) ? part.annotations : [])
    .filter((/** @type {any} */ a) => a?.type === 'word_info' && text(a?.text))
    .map((/** @type {any} */ a) => {
      const start = offsetSeconds(a.start_offset ?? a.startOffset);
      const end = offsetSeconds(a.end_offset ?? a.endOffset);
      return start === null ? null : { token: text(a.text), start, end: end === null || end < start ? start : end };
    }).filter(Boolean);
}

/** The first inline file of a `generateContent` answer, or a sentence saying why there is none. */
function inline(/** @type {any} */ body, /** @type {string} */ what) {
  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const found = parts.map((/** @type {any} */ p) => p?.inlineData ?? p?.inline_data).find((/** @type {any} */ d) => typeof d?.data === 'string');
  if (found) return { data: /** @type {string} */ (found.data), mimeType: String(found.mimeType ?? found.mime_type ?? '') };
  const why = body?.promptFeedback?.blockReason ?? body?.candidates?.[0]?.finishReason;
  throw new Error(`Gemini made no ${what}${why ? ` (${why})` : ''}.`);
}

/**
 * A Veo clip: 4, 6 or 8 seconds (8 with reference pictures), 16:9 or 9:16 at 720p, with sound. Started as an
 * operation, then asked after until it is done or the run is cancelled.
 * @param {Record<string, unknown>} args @param {RunContext} ctx @param {string} base
 * @param {(url: string, init?: RequestInit) => Promise<Response>} send
 */
async function video(args, ctx, base, send) {
  const prompt = needed(args, 'prompt');
  const path = landing('video', args.out, 'mp4');
  const model = modelOf(MODELS, 'video', ctx);
  const said = [];
  const first = text(args['first-frame']);
  const last = text(args['last-frame']);
  let refs = list(args['input-reference']);
  if (refs.length > 3) { said.push('Veo takes 3 reference pictures: the rest were left out'); refs = refs.slice(0, 3); }

  /* the nearest length Veo makes, the longer one on a tie */
  const asked = number(args.duration) ?? 8;
  const seconds = refs.length ? 8 : [4, 6, 8].reduce((best, s) => Math.abs(s - asked) <= Math.abs(best - asked) ? s : best, 8);
  if (seconds !== asked) said.push(`Veo makes 4, 6 or 8 second clips${refs.length ? ' (8 with reference pictures)' : ''}: ${seconds} s`);

  const picture = async (/** @type {string} */ file) => ({ inlineData: { mimeType: mimeOf(file), data: Buffer.from(await ctx.read(file)).toString('base64') } });
  const instance = {
    prompt,
    ...(first ? { image: await picture(first) } : {}),
    ...(last ? { lastFrame: await picture(last) } : {}),
    ...(refs.length ? { referenceImages: await Promise.all(refs.map(async (r) => ({ image: await picture(r), referenceType: 'asset' }))) } : {}),
  };
  /* with a first frame and no ratio asked, the picture's own shape decides */
  let ratio = text(args['aspect-ratio']);
  if (!ratio && first) { const size = imageSize(await ctx.read(first)); ratio = size && size.h > size.w ? '9:16' : '16:9'; }
  const tall = ['9:16', '3:4', '2:3', '9:21'].includes(ratio);
  const aspectRatio = tall ? '9:16' : '16:9';
  if (ratio && ratio !== aspectRatio && ratio !== 'adaptive') said.push(`Veo makes 16:9 or 9:16 clips: ${aspectRatio}`);

  const started = await (await send(`${base}/v1beta/models/${model}:predictLongRunning`, {
    method: 'POST', body: JSON.stringify({ instances: [instance], parameters: { aspectRatio, durationSeconds: seconds } }),
  })).json();
  const name = text(started?.name);
  if (!name) throw new Error(`${NAME} did not start the video.`);
  /** @type {any} */
  let op = started;
  while (!op?.done) {
    await sleep(polling.ms, ctx.signal);
    op = await (await send(`${base}/v1beta/${name}`)).json();
  }
  if (op.error) throw new Error(`Veo could not make the clip: ${text(op.error.message) || JSON.stringify(op.error)}`);
  const result = op.response?.generateVideoResponse;
  const uri = text(result?.generatedSamples?.[0]?.video?.uri);
  if (!uri) throw new Error(`Veo made no clip${result?.raiMediaFilteredReasons ? `: ${[].concat(result.raiMediaFilteredReasons).join('; ')}` : ''}.`);
  const { bytes } = await download(NAME, ownAddress(NAME, uri, base), ctx, { headers: { 'x-goog-api-key': ctx.key } });
  const [width, height] = tall ? [720, 1280] : [1280, 720];
  return {
    files: [{ path, bytes }],
    index: [{ src: path, kind: 'video', w: width, h: height, dur: seconds, hasAudio: true, from: {
      mode: 'generate', prompt, provider: 'google', model, resolution: '720p', sec: seconds,
      ...(first ? { firstFrame: first } : {}), ...(last ? { lastFrame: last } : {}), ...(refs.length ? { refs } : {}),
    } }],
    receipt: { provider: 'google', model, src: path, dur: seconds, width, height, hasAudio: true, resolution: '720p', ...notes(said) },
    cost: billedBy(NAME),
  };
}
