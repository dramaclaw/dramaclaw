// @ts-check
/**
 * What Studio works out from media files, with ffmpeg and ffprobe: a video's poster, a frame at a moment (timeline
 * thumbnails), a sound's waveform, the loudness of a part of it, and any media's length and size. Each is cached in `.film/cache/`, keyed by the
 * file's path, size and modification time, so a changed file is worked out again and an unchanged one never is.
 *
 * ffmpeg runs a few at a time: a project opened with fifty clips must not start fifty decoders. The editor's sound of
 * each file (soundOf) is made a few at a time of its own, so a long recording's does not hold up the thumbnails.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readable } from './files.mjs';
import { TOOL_DIR } from './projects.mjs';
import { writeAtomic } from './atomic.mjs';

export class MediaError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

/** @typedef {{ size: number, busy: number, waiting: (() => void)[] }} Slots */
/** @type {Slots} */
const SLOTS = { size: 3, busy: 0, waiting: [] };
/** @type {Slots} */
const SOUND_SLOTS = { size: 2, busy: 0, waiting: [] };
/** Run `tool` with `args` when one of `slots` is free; resolves with its stdout (`stderr`: its stderr) as a Buffer. */
async function tool(/** @type {'ffmpeg' | 'ffprobe'} */ name, /** @type {string[]} */ args, slots = SLOTS, stderrOut = false) {
  if (slots.busy >= slots.size) await new Promise((r) => slots.waiting.push(() => r(undefined)));
  slots.busy++;
  try {
    return await new Promise((resolve, reject) => {
      execFile(name, args, { encoding: 'buffer', maxBuffer: 64 << 20, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) return resolve(stderrOut ? stderr : stdout);
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
          return reject(new MediaError(`${name} is not installed (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg)`, 501));
        }
        reject(new MediaError(stderr.toString().trim().split('\n').pop() || error.message));
      });
    });
  } finally {
    slots.busy--;
    slots.waiting.shift()?.();
  }
}

/** The file, and the cache key that changes when it does. */
async function source(/** @type {string} */ root, /** @type {string} */ rel) {
  const abs = readable(root, rel);
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) throw new MediaError(`${rel} is not there`, 404);
  const key = createHash('sha1').update(`${rel}\0${info.size}\0${Math.round(info.mtimeMs)}`).digest('hex').slice(0, 20);
  return { abs, key };
}

/** A cached result: the file in `.film/cache/<kind>/`, made by `make` (written whole, through a temporary name). */
async function cached(/** @type {string} */ root, /** @type {string} */ kind, /** @type {string} */ name, /** @type {() => Promise<Buffer>} */ make) {
  const dir = join(root, TOOL_DIR, 'cache', kind);
  const file = join(dir, name);
  if (existsSync(file)) return readFile(file);
  const bytes = await make();
  await mkdir(dir, { recursive: true });
  await writeAtomic(file, bytes);
  return bytes;
}

/**
 * Length and picture size of a media file: `{ duration (s), width, height, fps, audio, codec, pixfmt }`; a still has no
 * duration. The size is the picture as it is shown: a video turned a quarter (a phone's portrait video) has its sides
 * swapped. `codec` and `pixfmt` are its picture's (proxies.mjs tells heavy footage by them).
 * @param {string} root @param {string} rel
 */
export async function probe(root, rel) {
  const { abs, key } = await source(root, rel);
  /* `.3`: since the size is as shown (an older answer has a turned video's sides as stored), with the codec */
  const bytes = await cached(root, 'probe', `${key}.3.json`, async () => {
    const out = JSON.parse((await tool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs])).toString());
    const video = out.streams?.find((/** @type {{ codec_type: string }} */ s) => s.codec_type === 'video');
    const audio = out.streams?.some((/** @type {{ codec_type: string }} */ s) => s.codec_type === 'audio');
    const [n, d] = String(video?.avg_frame_rate ?? '0/1').split('/').map(Number);
    const duration = Number(out.format?.duration);
    const turn = Number(video?.side_data_list?.find((/** @type {{ rotation?: number }} */ s) => s.rotation != null)?.rotation ?? video?.tags?.rotate ?? 0);
    const quarter = Math.abs(Math.round(turn / 90)) % 2 === 1;
    return Buffer.from(JSON.stringify({
      ...(Number.isFinite(duration) && duration > 0 && !/image|png|mjpeg/.test(String(out.format?.format_name)) ? { duration } : {}),
      ...(video ? (quarter ? { width: video.height, height: video.width } : { width: video.width, height: video.height }) : {}),
      ...(d && n ? { fps: Math.round((n / d) * 100) / 100 } : {}),
      ...(video?.codec_name ? { codec: String(video.codec_name), pixfmt: String(video.pix_fmt ?? '') } : {}),
      audio: Boolean(audio),
    }));
  });
  return JSON.parse(bytes.toString());
}

/** A video's poster: one frame a second in (or its first), 480 px wide, as JPEG. */
export async function poster(/** @type {string} */ root, /** @type {string} */ rel) {
  const { abs, key } = await source(root, rel);
  return cached(root, 'posters', `${key}.jpg`, async () => {
    const grab = (/** @type {string} */ at) => tool('ffmpeg', ['-v', 'error', '-ss', at, '-i', abs, '-frames:v', '1', '-vf', 'scale=480:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '4', '-']);
    const frame = await grab('1').catch(() => Buffer.alloc(0));
    return frame.length ? frame : grab('0');
  });
}

/** The frame of a video at `ms`, `width` px wide (the timeline's thumbnails). */
export async function frame(/** @type {string} */ root, /** @type {string} */ rel, /** @type {number} */ ms, /** @type {number} */ width) {
  if (!(Number.isFinite(ms) && ms >= 0)) throw new MediaError('which moment?', 400);
  const w = Math.max(32, Math.min(640, Math.round(width / 2) * 2 || 160));
  const { abs, key } = await source(root, rel);
  return cached(root, 'frames', `${key}-${Math.round(ms)}-${w}.jpg`, () => tool('ffmpeg', [
    '-v', 'error', '-ss', String(ms / 1000), '-i', abs, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-',
  ]));
}

/** Peaks per second of waveform: enough to see a word, few enough to send for an hour of sound. */
const PEAKS_PER_SECOND = 40;
const RATE = 8000;

/**
 * A sound's waveform (or a video's sound): `{ duration (s), peaks }`, `peaks` between 0 and 1, PEAKS_PER_SECOND of them
 * a second.
 * @param {string} root @param {string} rel
 */
export async function waveform(root, rel) {
  const { abs, key } = await source(root, rel);
  const bytes = await cached(root, 'waves', `${key}.json`, async () => {
    const pcm = await tool('ffmpeg', ['-v', 'error', '-i', abs, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-']);
    return Buffer.from(JSON.stringify(peaksOf(pcm)));
  });
  return JSON.parse(bytes.toString());
}

/** Mono 16-bit samples at RATE → `{ duration (s), peaks }`. */
function peaksOf(/** @type {Buffer} */ pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = RATE / PEAKS_PER_SECOND;
  const peaks = [];
  for (let i = 0; i < samples.length; i += per) {
    let max = 0;
    const end = Math.min(samples.length, i + per);
    for (let j = i; j < end; j++) { const v = Math.abs(samples[j]); if (v > max) max = v; }
    peaks.push(Math.round((max / 32768) * 1000) / 1000);
  }
  return { duration: samples.length / RATE, peaks };
}

/** Sound files small and compressed enough to be played as they are. */
const COMPACT = /\.(mp3|m4a|aac|ogg|oga|opus)$/i;
const COMPACT_BYTES = 16 << 20;
/** @type {Map<string, Promise<string | null>>} copies being made, by where they go */
const makingSound = new Map();

/**
 * The sound of a media file as the editor plays it, small: a compressed sound file of up to COMPACT_BYTES is its
 * own; any other (a video, a WAV, a long recording) gets a copy of its sound in `.film/cache/audio/`, AAC in .m4a:
 * the file's own AAC as it is, any other sound encoded at 128 kb/s, stereo at most. Made once per version of the
 * file; returns the path to play, or null when there is no sound in it. Exports mix from the files themselves.
 * @param {string} root @param {string} rel
 */
export async function soundOf(root, rel) {
  const { abs, key } = await source(root, rel);
  if (COMPACT.test(rel) && (await stat(abs)).size <= COMPACT_BYTES) return abs;
  const out = join(root, TOOL_DIR, 'cache', 'audio', `${key}.m4a`);
  if (existsSync(out)) return out;
  let made = makingSound.get(out);
  if (!made) {
    made = (async () => {
      if (!(await probe(root, rel)).audio) return null;
      const info = JSON.parse((await tool('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels', '-of', 'json', abs])).toString());
      const stream = info.streams?.[0] ?? {};
      const channels = Number(stream.channels) || 2;
      /* AAC is what a browser decodes everywhere: kept as it is when it is that already (no loss, no time) */
      const codec = stream.codec_name === 'aac' && channels <= 2 ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k', '-ac', String(Math.min(2, channels))];
      await mkdir(join(root, TOOL_DIR, 'cache', 'audio'), { recursive: true });
      const part = `${out}.part`;
      try {
        await tool('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', abs, '-map', '0:a:0', '-vn', '-sn', '-dn', ...codec, '-f', 'mp4', part], SOUND_SLOTS);
        await rename(part, out);
      } catch (e) {
        await rm(part, { force: true });
        throw e;
      }
      return out;
    })().finally(() => makingSound.delete(out));
    makingSound.set(out, made);
  }
  return made;
}

/**
 * The loudness of the part of a media file's sound from `from` to `to` (its own seconds; no `to`: to its end), as
 * EBU R128 measures it: `{ lufs, peak }`, the integrated loudness (LUFS) and the true peak (dBTP); `lufs` is null when
 * there is no sound in it. What the timeline's "Normalize loudness" sets a clip's volume by.
 * @param {string} root @param {string} rel @param {number} from @param {number} [to]
 * @returns {Promise<{ lufs: number | null, peak: number | null }>}
 */
export async function loudness(root, rel, from = 0, to) {
  if (!(Number.isFinite(from) && from >= 0) || (to != null && !(Number.isFinite(to) && to > from))) throw new MediaError('which part? from < to, in seconds', 400);
  const { abs, key } = await source(root, rel);
  const span = `${Math.round(from * 1000)}-${to == null ? 'end' : Math.round(to * 1000)}`;
  const bytes = await cached(root, 'loudness', `${key}-${span}.json`, async () => {
    if (!(await probe(root, rel)).audio) return Buffer.from(JSON.stringify({ lufs: null, peak: null }));
    const part = ['-ss', String(from), ...(to == null ? [] : ['-t', String(to - from)])];
    const log = (await tool('ffmpeg', ['-nostdin', '-hide_banner', '-nostats', ...part, '-i', abs, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], SLOTS, true)).toString();
    return Buffer.from(JSON.stringify(loudnessOf(log)));
  });
  return JSON.parse(bytes.toString());
}

/** ebur128's summary → `{ lufs, peak }`; silence (−70 LUFS, the gate) has no loudness. @param {string} log */
export function loudnessOf(log) {
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const number = (/** @type {RegExp} */ re) => {
    const m = re.exec(summary);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const lufs = number(/\bI:\s+(-?[\d.]+|-inf) LUFS/);
  return { lufs: lufs != null && lufs > -70 ? lufs : null, peak: number(/\bPeak:\s+(-?[\d.]+|-inf) dBFS/) };
}
