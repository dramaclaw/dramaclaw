// @ts-check
/**
 * Microsoft Azure with the person's own key: voice-over from the neural voices of Azure AI Speech
 * (https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech), as WAV, with no word timings: a
 * voice-over's words are left to Studio to spread over the line.
 *
 * Azure's address carries the resource's region (`https://<region>.tts.speech.microsoft.com`), so the key must say it:
 * pasted as `<region>:<key>` (e.g. `eastus:a1b2…`), or `AZURE_SPEECH_KEY` with the region in `AZURE_SPEECH_REGION`.
 * There is no model to choose: each voice (`en-US-AvaMultilingualNeural`, …) is its own, picked with `--voice`.
 */
import { billedBy, call, clamp, landing, needed, notes, number, serviceUrl, text, wavSeconds } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider */

const NAME = 'Microsoft Azure';
/** WAV straight from the service: its length is read from the file itself. */
const FORMAT = 'riff-24khz-16bit-mono-pcm';

/**
 * The region and the key proper from what the person gave: `<region>:<key>`, else the key with `AZURE_SPEECH_REGION`.
 * A sentence when the region is nowhere, or does not look like one (it becomes the host name): a guess would send the
 * key to the wrong address and fail as "bad key". `checkKey` runs this when the key is pasted, so a key that cannot
 * work is refused where it is pasted, not at the first voice-over.
 */
function placed(/** @type {string} */ raw) {
  const split = /^([a-z0-9]+):(.{8,})$/i.exec(raw);
  if (split) return { region: split[1].toLowerCase(), key: split[2] };
  const region = text(process.env.AZURE_SPEECH_REGION).toLowerCase();
  if (!region) throw new Error(`${NAME} needs the resource's region: paste the key as <region>:<key> (e.g. eastus:a1b2…) in Studio, or set AZURE_SPEECH_REGION.`);
  if (!/^[a-z0-9]+$/.test(region)) throw new Error(`AZURE_SPEECH_REGION does not look like an Azure region (letters and digits, e.g. eastus): ${region}`);
  return { region, key: raw };
}

/** Text inside SSML: the five XML escapes. */
const xml = (/** @type {string} */ s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);

/** @type {Provider} */
export default {
  id: 'azure',
  name: NAME,
  env: 'AZURE_SPEECH_KEY',
  keysUrl: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/SpeechServices',
  billingUrl: 'https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/overview',
  verbs: ['voice', 'tts'],
  checkKey(key) { placed(key); },
  async run(verb, args, ctx) {
    const { region, key } = placed(ctx.key);
    const base = serviceUrl('AZURE', `https://${region}.tts.speech.microsoft.com`);
    const send = (/** @type {string} */ path, /** @type {RequestInit} */ init = {}) =>
      call(NAME, `${base}/cognitiveservices${path}`, { ...init, headers: { 'ocp-apim-subscription-key': key, 'user-agent': 'openfilm', ...init.headers } }, ctx);

    if (verb === 'voice') {
      const limit = clamp(Math.round(number(args.limit) ?? 5), 1, 100);
      const language = text(args.language).toLowerCase();
      const gender = text(args.gender).toLowerCase().slice(0, 1);
      const prompt = text(args.prompt).toLowerCase();
      const all = /** @type {any[]} */ (await (await send('/voices/list')).json());
      const said = [];
      const match = (/** @type {any} */ v) => [v.ShortName, v.DisplayName, v.LocalName, v.LocaleName, ...(Array.isArray(v.StyleList) ? v.StyleList : [])]
        .some((field) => text(field).toLowerCase().includes(prompt));
      let found = (Array.isArray(all) ? all : []).filter((v) => !prompt || match(v));
      if (prompt && !found.length) {
        found = Array.isArray(all) ? all : [];
        said.push(`no voice matched "${prompt}"; these are others`);
      }
      const list = found.map((v) => {
        const sex = text(v.Gender).toLowerCase();
        const styles = Array.isArray(v.StyleList) ? v.StyleList.map(text).filter(Boolean) : [];
        return {
          voiceId: text(v.ShortName),
          name: text(v.DisplayName) || text(v.LocalName),
          language: text(v.Locale) || null,
          gender: sex === 'male' ? 'm' : sex === 'female' ? 'f' : null,
          description: [text(v.LocaleName), styles.length ? `styles: ${styles.join(', ')}` : ''].filter(Boolean).join(' · ') || null,
        };
      }).filter((v) => v.voiceId
        && (!language || (v.language ?? '').toLowerCase().startsWith(language))
        && (!gender || v.gender === gender));
      return { files: [], index: [], receipt: { provider: 'azure', voices: list.slice(0, limit), ...notes(said) } };
    }
    if (verb === 'tts') {
      const voice = needed(args, 'voice');
      const said = needed(args, 'text');
      const path = landing('audio/vo', args.out, 'wav');
      /* the voice's own locale (en-US-AvaNeural → en-US) tells the service how to read numbers and names */
      const lang = /^[a-z]{2,3}-[A-Za-z0-9]+/.exec(voice)?.[0] ?? 'en-US';
      const ssml = `<speak version='1.0' xml:lang='${lang}'><voice name='${xml(voice)}'>${xml(said)}</voice></speak>`;
      const res = await send('/v1', { method: 'POST', headers: { 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': FORMAT }, body: ssml });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const dur = wavSeconds(bytes);
      return {
        files: [{ path, bytes }],
        index: [{ src: path, kind: 'audio', ...(dur !== null ? { dur } : {}), text: said, voice, from: { mode: 'synth', text: said, voice, provider: 'azure' } }],
        receipt: { provider: 'azure', src: path, dur, voice, notes: ['Azure gives no word timings: subtitles spread the text over the line'] },
        cost: billedBy(NAME),
      };
    }
    throw new Error(`${NAME} does not do ${verb}.`);
  },
};
