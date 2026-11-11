// @ts-check
/**
 * Xiaomi MiMo with the person's own key: speech recognition (MiMo-V2.5-ASR) and voice-over (MiMo-V2.5-TTS) through
 * the MiMo API (https://platform.xiaomimimo.com/docs). Both are chat completions under /v1/chat/completions with the
 * key in an `api-key` header. A platform key (sk-…) answers at the pay-as-you-go API; a Token Plan key (tp-…) at its
 * gateway (https://token-plan-cn.xiaomimimo.com) — the key says which, so neither is set by hand.
 * OPENFILM_MIMO_URL points both somewhere else (a test server, a proxy).
 *
 * Recognition answers text with no word timings. To keep subtitles honest, the speech is cut at its pauses first
 * (ffmpeg, as `get` already needs it) and each stretch is asked for on its own, so every stretch's words carry the
 * real time it was said in and a pause is a cue boundary; without a pause to cut at, the one answer spreads over the
 * recording. Voice-over sends the line as the assistant's message and answers a WAV in `message.audio.data`, with no
 * word timings either. The voices are the ones the API names; it has no endpoint to list them.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billedBy, call, clamp, landing, modelOf, needed, noBalance, notes, number, round, serviceUrl, text, wavSeconds, wordsFromCharacters } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Xiaomi MiMo';
/** the models it makes each kind of media with, the default first (https://platform.xiaomimimo.com/docs) */
const MODELS = {
  asr: [{ id: 'mimo-v2.5-asr', name: 'MiMo-V2.5-ASR' }],
  tts: [{ id: 'mimo-v2.5-tts', name: 'MiMo-V2.5-TTS' }],
};
/** the voices it speaks with, as the API names them in its errors (no listing endpoint) */
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
/** the largest speech sent at once */
const MAX_UPLOAD = 100 * 1024 * 1024;
/** how long one request may take (a long stretch, a long line) */
const TIMEOUT_MS = 300_000;
/** a pause at least this long, this quiet, is where the speech is cut */
const CUT_NOISE = '-20dB', CUT_SECONDS = 0.4;
/** a stretch shorter than this is one with its neighbours (a breath between close pauses) */
const MIN_STRETCH = 0.7;
/** the longest stretch asked for at once */
const MAX_STRETCH = 30;

/** Where a key answers: a Token Plan key (tp-…) at its gateway, a platform key (sk-…) at the pay-as-you-go API. */
export const baseFor = (/** @type {string} */ key) =>
  key.startsWith('tp-') ? 'https://token-plan-cn.xiaomimimo.com' : 'https://api.xiaomimimo.com';

/** What MiMo says when a key cannot work where it was sent, or the plan has nothing left. */
function guided(/** @type {unknown} */ e, /** @type {string} */ key) {
  const said = String(/** @type {Error} */ (e)?.message ?? e);
  /* a Token Plan key answered 401: it went where it was told (an OPENFILM_MIMO_URL), not where it belongs */
  if (/\(401\)/.test(said) && key.startsWith('tp-')) {
    return new Error(`${said} A Token Plan key answers at https://token-plan-cn.xiaomimimo.com; check OPENFILM_MIMO_URL is not pointing it elsewhere.`);
  }
  /* the plan's quota used up answers 429 */
  if (/answered 429/.test(said)) return noBalance(NAME);
  return e;
}

/**
 * The speech cut at its pauses: each stretch with its own bytes and where it starts in the file's seconds. Without a
 * pause to cut at there is one stretch, the whole of it. ffmpeg's own reading of the file decides how long it is.
 * @param {Uint8Array} bytes @param {AbortSignal} signal
 * @returns {Promise<{ stretches: { at: number, bytes: Uint8Array }[], total: number | null }>}
 */
async function stretches(bytes, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'openfilm-mimo-'));
  const speech = join(dir, 'speech.mp3');
  await writeFile(speech, bytes);
  try {
    const stderr = await new Promise((done, fail) => execFile('ffmpeg',
      ['-nostdin', '-i', speech, '-af', `silencedetect=noise=${CUT_NOISE}:d=${CUT_SECONDS}`, '-f', 'null', '-'],
      { signal, encoding: 'utf8', windowsHide: true }, (error, _out, err) => error ? fail(error) : done(err)));
    const head = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(String(stderr));
    const total = head ? Number(head[1]) * 3600 + Number(head[2]) * 60 + Number(head[3]) : 0;
    const starts = [...String(stderr).matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...String(stderr).matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    /** @type {[number, number][]} */
    const silences = [];
    for (const [i, a] of starts.entries()) {
      const b = ends[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const last = silences.at(-1);
      /* a run of flutters is one pause */
      if (last && a - last[1] < 0.3) last[1] = b; else silences.push([a, b]);
    }
    const cuts = [0, ...silences.map(([a, b]) => (a + b) / 2), total || Infinity];
    /** @type {[number, number][]} */
    const spans = [];
    for (const [i, from] of cuts.slice(0, -1).entries()) {
      const to = cuts[i + 1];
      if (!(to > from)) continue;
      if (to - from < MIN_STRETCH) {
        const last = spans.at(-1);
        if (last) last[1] = to;
        else if (to - from > 0.05) spans.push([from, to]);
        continue;
      }
      spans.push([from, to]);
    }
    /** @type {{ at: number, bytes: Uint8Array }[]} */
    const out = [];
    let index = 0;
    for (const [from, to] of spans) {
      for (let at = from; at < to; at += MAX_STRETCH, index += 1) {
        const end = Math.min(at + MAX_STRETCH, to);
        const file = join(dir, `stretch-${index}.mp3`);
        await new Promise((done, fail) => execFile('ffmpeg',
          ['-nostdin', '-y', '-ss', at.toFixed(3), '-to', end.toFixed(3), '-i', speech, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', file],
          { signal, windowsHide: true }, (error) => error ? fail(error) : done(undefined)));
        out.push({ at, bytes: await readFile(file) });
      }
    }
    return { stretches: out, total: total || null };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Stretch texts joined as they are written: a space between words, none next to CJK. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** @param {string[]} parts */
function joined(parts) {
  let out = '';
  for (const part of parts.filter(Boolean)) out += out && !CJK.test(out.slice(-1)) && !CJK.test(part.slice(0, 1)) ? ` ${part}` : part;
  return out;
}

/** @type {Provider} */
export default {
  id: 'mimo',
  name: NAME,
  env: 'MIMO_API_KEY',
  keysUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  billingUrl: 'https://platform.xiaomimimo.com/console/recharge',
  verbs: ['voice', 'tts', 'asr'],
  models: MODELS,
  speechFormat: 'mp3',
  async run(verb, args, ctx) {
    const base = serviceUrl('MIMO', baseFor(ctx.key));
    const send = (/** @type {Record<string, unknown>} */ payload) =>
      call(NAME, `${base}/v1/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: { 'content-type': 'application/json', 'api-key': ctx.key }, body: JSON.stringify(payload),
      }, ctx).catch((e) => { throw guided(e, ctx.key); });
    /** @returns {Promise<any>} */
    const answered = async (/** @type {Record<string, unknown>} */ payload) => {
      const res = await send(payload);
      try { return await res.json(); } catch { throw new Error(`${NAME} answered without JSON. Not retried.`); }
    };

    if (verb === 'voice') {
      const said = [
        ...(text(args.language) ? ['MiMo\'s voices speak what they are given: --language does not narrow them'] : []),
        ...(text(args.gender) ? ['MiMo\'s voices have no set gender'] : []),
        ...(text(args.prompt) ? ['--prompt does not narrow MiMo\'s voices'] : []),
      ];
      const limit = clamp(Math.round(number(args.limit) ?? 5), 1, 100);
      const voices = VOICES.slice(0, limit).map((id) => ({ voiceId: id, name: id === 'mimo_default' ? 'Default' : id, language: null, gender: null, description: null }));
      return { files: [], index: [], receipt: { provider: 'mimo', voices, ...notes(said) } };
    }
    if (verb === 'tts') {
      const said = needed(args, 'text');
      const voice = needed(args, 'voice');
      const model = modelOf(MODELS, 'tts', ctx);
      const body = await answered({
        model,
        messages: [{ role: 'assistant', content: said }],
        audio: { format: 'wav', voice },
      });
      const data = body?.choices?.[0]?.message?.audio?.data;
      if (typeof data !== 'string' || !data) throw new Error(`${NAME} answered with no audio. Not retried.`);
      const bytes = new Uint8Array(Buffer.from(data, 'base64'));
      const dur = wavSeconds(bytes);
      const path = landing('audio/vo', args.out, 'wav');
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, provider: 'mimo', model } }],
        receipt: { provider: 'mimo', model, src: path, dur, voice, notes: ['MiMo gives no word timings: `get asr` on the file makes timed subtitles'] },
        cost: billedBy(NAME),
      };
    }
    if (verb === 'asr') {
      const src = needed(args, 'src');
      const bytes = await ctx.read(src);
      if (!bytes.length || bytes.length >= MAX_UPLOAD) throw new Error(`MiMo takes speech under 100 MB and this is ${Math.ceil(bytes.length / 1048576)} MB. No audio was uploaded.`);
      const model = modelOf(MODELS, 'asr', ctx);
      /* the speech cut at its pauses, each stretch asked for on its own: when it was said is real, within a
         stretch is spread by characters, as there is nothing finer to go by */
      const cut = await stretches(bytes, ctx.signal).catch(() => ({ stretches: [{ at: 0, bytes }], total: null }));
      /** @type {{ at: number, line: string, seconds: number | null }[]} */
      const heard = [];
      for (const stretch of cut.stretches) {
        const body = await answered({
          model,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/mpeg;base64,${Buffer.from(stretch.bytes).toString('base64')}` } }] }],
        });
        const line = text(body?.choices?.[0]?.message?.content);
        const seconds = Number(body?.usage?.seconds);
        heard.push({ at: stretch.at, line, seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null });
      }
      /* the file's own length, or the stretches' own counted seconds when ffmpeg could not read it */
      const total = cut.total ?? (heard.reduce((end, h) => Math.max(end, h.at + (h.seconds ?? 0)), 0) || null);
      /** @type {{ token: string, start: number, end: number }[]} */
      const words = [];
      const said = [];
      for (const [i, h] of heard.entries()) {
        if (!h.line) continue;
        said.push(h.line);
        const until = heard[i + 1]?.at ?? total ?? h.at + (h.seconds ?? MAX_STRETCH);
        const characters = [...h.line];
        const step = Math.max(0.1, until - h.at) / characters.length;
        words.push(...wordsFromCharacters(characters,
          characters.map((_, k) => h.at + k * step), characters.map((_, k) => h.at + (k + 1) * step), total ?? undefined)
          .map((w) => ({ ...w, start: round(w.start), end: round(w.end) })));
      }
      const full = joined(said);
      return {
        files: [],
        index: [{ src, text: full, ...(total ? { dur: round(total) } : {}), ...(words.length ? { words } : {}), transcribed: true }],
        receipt: { provider: 'mimo', model, src, text: full, notes: ['Word times are the pauses MiMo\'s speech was cut at, spread within each stretch'] },
        cost: billedBy(NAME),
      };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
