// @ts-check
/**
 * fal.ai with the person's own key: pictures (FLUX.2), video (Seedance 2.0, Kling 3.0), music (Stable Audio 2.5, Lyria 2)
 * and sound effects (ElevenLabs Sound Effects v2, Stable Audio 2.5). Every model runs through fal's queue
 * (https://fal.ai/docs/model-apis/model-endpoints/queue), key as `Authorization: Key …`: a request is submitted, asked
 * after until it is done, then its result fetched; results are files on fal's servers, downloaded here. Pictures a
 * model is given go inline, as data: URIs.
 */
import { extname } from 'node:path';
import { RATIO_SIZE, billedBy, call, clamp, dataUri, download, extOf, landing, list, madePicture, modelOf, mp3Seconds, needed, notes, number, ownAddress, round, serviceUrl, sleep, text, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'fal.ai';
/** the models it makes each kind of media with, the default first (each model's page on fal.ai/models) */
const MODELS = {
  image: [{ id: 'fal-ai/flux-2-pro', name: 'FLUX.2 [pro]' }, { id: 'fal-ai/flux-2-max', name: 'FLUX.2 [max]' }],
  video: [
    { id: 'seedance-2.0', name: 'Seedance 2.0' },
    { id: 'seedance-2.0-fast', name: 'Seedance 2.0 Fast' },
    { id: 'kling-3.0-pro', name: 'Kling 3.0 Pro' },
    { id: 'kling-3.0-standard', name: 'Kling 3.0 Standard' },
  ],
  music: [{ id: 'fal-ai/stable-audio-25/text-to-audio', name: 'Stable Audio 2.5' }, { id: 'fal-ai/lyria2', name: 'Lyria 2' }],
  sfx: [{ id: 'fal-ai/elevenlabs/sound-effects/v2', name: 'ElevenLabs Sound Effects v2' }, { id: 'fal-ai/stable-audio-25/text-to-audio', name: 'Stable Audio 2.5' }],
};

/**
 * Each sound model's input for a prompt and a length, and the lengths it makes: `seconds`, a range (`whole`: in whole
 * seconds), or `fixed`. `chooses`: with no length asked, it chooses one. `mp3`: it answers with 128 kbps MP3, whose
 * length is known from its size.
 * @type {Record<string, { name: string, seconds?: [number, number], whole?: boolean, fixed?: number, chooses?: boolean, mp3?: boolean, input: (prompt: string, sec: number | null) => Record<string, unknown> }>}
 */
const AUDIO = {
  'fal-ai/stable-audio-25/text-to-audio': { name: 'Stable Audio 2.5', seconds: [1, 190], whole: true, input: (prompt, sec) => ({ prompt, seconds_total: sec }) },
  'fal-ai/lyria2': { name: 'Lyria 2', fixed: 30, input: (prompt) => ({ prompt }) },
  'fal-ai/elevenlabs/sound-effects/v2': {
    name: 'ElevenLabs Sound Effects', seconds: [0.5, 22], chooses: true, mp3: true,
    input: (prompt, sec) => ({ text: prompt, ...(sec !== null ? { duration_seconds: sec } : {}), output_format: 'mp3_44100_128' }),
  },
};
/** the length asked of a model that needs one when none is given */
const LENGTH = { music: 60, sfx: 5 };

/**
 * Each video model's endpoints (from a prompt, from a first frame, from reference pictures when it takes them), the
 * resolution it is asked for, and the shapes and lengths it makes.
 * @type {Record<string, { name: string, text: string, image: string, reference: string | null, resolution: string | null, ratios: string[], seconds: [number, number] }>}
 */
const VIDEO = {
  'seedance-2.0': {
    name: 'Seedance', text: 'bytedance/seedance-2.0/text-to-video', image: 'bytedance/seedance-2.0/image-to-video', reference: 'bytedance/seedance-2.0/reference-to-video',
    resolution: '1080p', ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], seconds: [4, 15],
  },
  'seedance-2.0-fast': {
    name: 'Seedance Fast', text: 'bytedance/seedance-2.0/fast/text-to-video', image: 'bytedance/seedance-2.0/fast/image-to-video', reference: 'bytedance/seedance-2.0/fast/reference-to-video',
    resolution: '720p', ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], seconds: [4, 15],
  },
  'kling-3.0-pro': {
    name: 'Kling', text: 'fal-ai/kling-video/v3/pro/text-to-video', image: 'fal-ai/kling-video/v3/pro/image-to-video', reference: null,
    resolution: null, ratios: ['16:9', '9:16', '1:1'], seconds: [3, 15],
  },
  'kling-3.0-standard': {
    name: 'Kling', text: 'fal-ai/kling-video/v3/standard/text-to-video', image: 'fal-ai/kling-video/v3/standard/image-to-video', reference: null,
    resolution: null, ratios: ['16:9', '9:16', '1:1'], seconds: [3, 15],
  },
};

/** How long to wait between asking after a request (tests make it short). */
export const polling = { ms: { image: 1000, audio: 2000, video: 5000 } };

/** @type {Provider} */
export default {
  id: 'fal',
  name: NAME,
  env: 'FAL_KEY',
  keysUrl: 'https://fal.ai/dashboard/keys',
  billingUrl: 'https://fal.ai/dashboard/billing',
  verbs: ['image', 'video', 'music', 'sfx'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb === 'image') {
      const prompt = needed(args, 'prompt');
      const ratio = text(args.ratio) || '3:2';
      const size = RATIO_SIZE[ratio];
      if (!size) throw new Error(`--ratio is one of ${Object.keys(RATIO_SIZE).join(', ')}.`);
      const model = modelOf(MODELS, 'image', ctx);
      const said = [...(args.transparent ? ['--transparent: FLUX.2 makes opaque pictures'] : []), ...(text(args.quality) === 'high' ? ['--quality high: FLUX.2 has one quality'] : [])];
      const result = await queued(model, { prompt, image_size: size, output_format: 'png' }, ctx, polling.ms.image);
      const image = result?.images?.[0];
      if (!text(image?.url)) throw new Error(`${NAME} answered without a picture.`);
      const { bytes, type } = await download(NAME, image.url, ctx);
      const path = landing('image', args.out, extOf(image.content_type ?? type, 'png'));
      return { ...madePicture({ path, bytes, prompt, provider: 'fal', model, notes: said }), cost: billedBy(NAME) };
    }
    if (verb === 'video') return video(args, ctx);
    if (verb === 'music' || verb === 'sfx') return sound(verb, args, ctx);
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};

/**
 * A clip with sound, of the lengths and shapes the chosen model makes: from the prompt, from a first (and last) frame,
 * or (Seedance) from up to 9 reference pictures.
 * @param {Record<string, unknown>} args @param {RunContext} ctx
 */
async function video(args, ctx) {
  const prompt = needed(args, 'prompt');
  const path = landing('video', args.out, 'mp4');
  const spec = VIDEO[modelOf(MODELS, 'video', ctx)];
  const said = [];
  const first = text(args['first-frame']);
  const last = text(args['last-frame']);
  let refs = list(args['input-reference']);
  if (refs.length && !spec.reference) { said.push(`${spec.name} takes no reference pictures: they were left out`); refs = []; }
  if (refs.length > 9) { said.push(`${spec.name} takes 9 reference pictures: the rest were left out`); refs = refs.slice(0, 9); }

  const asked = number(args.duration) ?? 5;
  const seconds = clamp(Math.round(asked), ...spec.seconds);
  if (seconds !== asked) said.push(`${spec.name} makes ${spec.seconds[0]} to ${spec.seconds[1]} second clips: ${seconds} s`);
  const ratio = text(args['aspect-ratio']);
  const tall = ['9:21', '2:3', '3:4', '9:16'].includes(ratio);
  const aspect = !ratio || ratio === 'adaptive' ? null : spec.ratios.includes(ratio) ? ratio : tall ? '9:16' : ['4:3', '1:1'].includes(ratio) && spec.ratios.includes('1:1') ? '1:1' : '16:9';
  if (aspect && aspect !== ratio) said.push(`${spec.name} makes ${spec.ratios.join(', ')} clips: ${aspect}`);

  const endpoint = first ? spec.image : refs.length && spec.reference ? spec.reference : spec.text;
  /* Kling calls the first frame start_image_url, and shapes only a clip made from the prompt */
  const kling = !spec.reference;
  const input = {
    prompt, duration: String(seconds), ...(spec.resolution ? { resolution: spec.resolution } : {}),
    ...(aspect && !(kling && first) ? { aspect_ratio: aspect } : {}),
    ...(first ? { [kling ? 'start_image_url' : 'image_url']: await dataUri(first, ctx) } : {}),
    ...(last ? { end_image_url: await dataUri(last, ctx) } : {}),
    ...(refs.length ? { image_urls: await Promise.all(refs.map((r) => dataUri(r, ctx))) } : {}),
  };
  const result = await queued(endpoint, input, ctx, polling.ms.video);
  if (!text(result?.video?.url)) throw new Error(`${NAME} answered without a clip.`);
  const { bytes } = await download(NAME, result.video.url, ctx);
  const resolution = spec.resolution ? { resolution: spec.resolution } : {};
  return {
    files: [{ path, bytes }],
    index: [{ src: path, kind: 'video', dur: seconds, hasAudio: true, from: {
      mode: 'generate', prompt, provider: 'fal', model: endpoint, ...resolution, sec: seconds,
      ...(first ? { firstFrame: first } : {}), ...(last ? { lastFrame: last } : {}), ...(refs.length ? { refs } : {}),
    } }],
    receipt: { provider: 'fal', model: endpoint, src: path, dur: seconds, hasAudio: true, ...resolution, ...notes(said) },
    cost: billedBy(NAME),
  };
}

/**
 * Music or a sound effect from a prompt, as long as asked within what the chosen model makes. Its length is measured
 * from the file (WAV, or the MP3's size); else it is the length the model was asked for.
 * @param {'music' | 'sfx'} verb @param {Record<string, unknown>} args @param {RunContext} ctx
 */
async function sound(verb, args, ctx) {
  const prompt = needed(args, 'prompt');
  const dir = verb === 'sfx' ? 'audio/sfx' : 'audio/music';
  landing(dir, args.out, 'wav');
  const model = modelOf(MODELS, verb, ctx);
  const spec = AUDIO[model];
  const said = [];
  const asked = number(args.sec);
  const within = (/** @type {number} */ v) => { const s = clamp(v, ...(spec.seconds ?? [v, v])); return spec.whole ? Math.round(s) : round(s); };
  const sec = spec.fixed ?? (asked === null ? (spec.chooses ? null : LENGTH[verb]) : within(asked));
  if (asked !== null && sec !== asked) said.push(spec.fixed ? `${spec.name} makes ${spec.fixed} s tracks` : `${spec.name} makes ${spec.seconds?.[0]} to ${spec.seconds?.[1]} s: ${sec} s`);
  const result = await queued(model, spec.input(prompt, sec), ctx, polling.ms.audio);
  const audio = result?.audio;
  if (!text(audio?.url)) throw new Error(`${NAME} answered without audio.`);
  const { bytes, type } = await download(NAME, audio.url, ctx);
  /* a type it does not say plainly: the file's own extension, when it is one */
  const named = extname(text(audio.file_name)).slice(1).toLowerCase();
  const path = landing(dir, args.out, extOf(audio.content_type ?? type, /^[a-z0-9]{2,4}$/.test(named) ? named : 'wav'));
  const dur = wavSeconds(bytes) ?? (spec.mp3 && path.endsWith('.mp3') ? mp3Seconds(bytes) : sec);
  return {
    files: [{ path, bytes }],
    index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), from: { mode: 'generate', prompt, ...(asked !== null ? { sec: asked } : {}), provider: 'fal', model } }],
    receipt: { provider: 'fal', model, src: path, dur, ...notes(said) },
    cost: billedBy(NAME),
  };
}

/**
 * One request through fal's queue: submit, ask after it every `every` ms, fetch the result. A cancelled run cancels
 * the request too, so nothing more is billed for it.
 * @param {string} model @param {Record<string, unknown>} input @param {RunContext} ctx @param {number} every
 */
async function queued(model, input, ctx, every) {
  const auth = { authorization: `Key ${ctx.key}` };
  const base = serviceUrl('FAL', 'https://queue.fal.run');
  const job = await (await call(NAME, `${base}/${model}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(input) }, ctx)).json();
  if (!text(job?.status_url) || !text(job?.response_url)) throw new Error(`${NAME} did not take the request.`);
  /* the queue's own addresses, which the key goes to: on the queue's origin only */
  const statusUrl = ownAddress(NAME, job.status_url, base);
  const responseUrl = ownAddress(NAME, job.response_url, base);
  const cancelUrl = text(job.cancel_url) ? ownAddress(NAME, job.cancel_url, base) : null;
  const cancel = () => { if (cancelUrl) fetch(cancelUrl, { method: 'PUT', headers: auth }).then((r) => r.body?.cancel(), () => {}); };
  ctx.signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const status = await (await call(NAME, statusUrl, { headers: auth }, ctx)).json();
      if (status?.status === 'COMPLETED') {
        if (status.error) throw new Error(`${NAME} could not make it: ${text(status.error) || JSON.stringify(status.error)}`);
        break;
      }
      await sleep(every, ctx.signal);
    }
    return /** @type {any} */ (await (await call(NAME, responseUrl, { headers: auth }, ctx)).json());
  } finally {
    ctx.signal.removeEventListener('abort', cancel);
  }
}
