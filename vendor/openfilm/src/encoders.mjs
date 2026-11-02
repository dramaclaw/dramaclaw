// @ts-check
/**
 * The graphics chip's encoders and decoders, for everything that writes video: Studio's exports, `openfilm render`,
 * the fast-seeking copies a render makes (seekable.mjs) and the preview's proxies. Which ones this machine's ffmpeg
 * has, whether each works here (a moment of video goes through it first, once a launch), and the options each takes.
 * A caller uses the processor's own encoder when the chip has none, and when the chip's fails partway (`broken`).
 */
import { execFile, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

/** @typedef {'h264' | 'hevc' | 'prores'} ChipCodec */

/** @type {Promise<Set<string>> | null} */
let encoderList = null;
/**
 * The encoders this machine's ffmpeg has (none when there is no ffmpeg). No ffmpeg is asked about again next time:
 * the desktop app downloads it while Studio is already running.
 * @returns {Promise<Set<string>>}
 */
export function encoders() {
  encoderList ??= new Promise((done) => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { maxBuffer: 8 << 20, windowsHide: true }, (error, stdout) => {
      if (error) encoderList = null;
      done(new Set(error ? [] : [...String(stdout).matchAll(/^ [VAS][.A-Z]{5} (\S+)/gm)].map((m) => m[1])));
    });
  });
  return encoderList;
}

/** @type {Promise<Set<string>> | null} */
let accelList = null;
/** The hardware decoders this machine's ffmpeg has (`-hwaccels`), asked again while there is no ffmpeg. @returns {Promise<Set<string>>} */
function hwaccels() {
  accelList ??= new Promise((done) => {
    execFile('ffmpeg', ['-hide_banner', '-hwaccels'], { windowsHide: true }, (error, stdout) => {
      if (error) accelList = null;
      done(new Set(error ? [] : String(stdout).split('\n').slice(1).map((l) => l.trim()).filter(Boolean)));
    });
  });
  return accelList;
}

/**
 * The graphics chip's encoders this platform's ffmpeg may have, in the order they are tried: the Mac's own (its media
 * engine, ProRes too); on Windows NVIDIA's, Intel's, AMD's, then Windows' own (Media Foundation, through whichever chip
 * there is); NVIDIA's on Linux.
 */
const HARDWARE = /** @type {Record<string, Partial<Record<ChipCodec, string[]>>>} */ ({
  darwin: { h264: ['h264_videotoolbox'], hevc: ['hevc_videotoolbox'], prores: ['prores_videotoolbox'] },
  win32: { h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'], hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'] },
  linux: { h264: ['h264_nvenc'], hevc: ['hevc_nvenc'] },
});

/**
 * A hardware H.264 or HEVC encoder's options at a bitrate (they take no quality number that means the same on every
 * chip): peaks allowed at half again, for cuts and screen text. `gop`: frames from one key frame to the next (left
 * to itself, the Mac's puts one every 12 frames, and a bitrate spent on key frames is lost to the picture).
 * @param {string} encoder @param {number} bits a second @param {{ gop?: number }} [options]
 */
export function hardwareOptions(encoder, bits, { gop } = {}) {
  const k = (/** @type {number} */ n) => `${Math.round(n / 1000)}k`;
  const rate = ['-b:v', k(bits), '-maxrate', k(bits * 1.5), '-bufsize', k(bits * 2)];
  const hevc = encoder.startsWith('hevc_');
  const tag = [...(hevc ? ['-tag:v', 'hvc1'] : []), ...(gop ? ['-g', String(Math.max(1, Math.round(gop)))] : [])];
  switch (encoder.slice(encoder.indexOf('_') + 1)) {
    case 'videotoolbox': return ['-c:v', encoder, ...(hevc ? [] : ['-profile:v', 'high']), '-b:v', k(bits), ...tag];
    case 'nvenc': return ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', ...rate, ...tag];
    case 'qsv': return ['-c:v', encoder, '-preset', 'medium', ...rate, ...tag];
    case 'amf': return ['-c:v', encoder, '-quality', 'quality', '-rc', 'vbr_peak', ...rate, ...tag];
    /* the chip's own encoder, never Windows' software one (x264 is better at that) */
    case 'mf': return ['-c:v', encoder, '-hw_encoding', '1', '-rate_control', 'u_vbr', '-b:v', k(bits), ...tag];
    default: return ['-c:v', encoder, '-b:v', k(bits), ...tag];
  }
}

/**
 * ProRes 4444 with its alpha, or 422 HQ: through the Mac's ProRes engine (`prores_videotoolbox`, Apple's own
 * encoder), else ffmpeg's. `video`: the encoder's options; `pix`: the pixel format it takes, as a filter.
 * @param {string} encoder @param {boolean} alpha
 */
export function proresOptions(encoder, alpha) {
  if (encoder === 'prores_videotoolbox') return { video: ['-c:v', encoder, '-profile:v', alpha ? '4444' : 'hq'], pix: alpha ? 'format=bgra' : 'format=p210le' };
  return { video: ['-c:v', 'prores_ks', '-profile:v', alpha ? '4444' : '3', '-vendor', 'apl0'], pix: alpha ? 'format=yuva444p10le' : 'format=yuv422p10le' };
}

/** @type {Map<string, Promise<boolean>>} */
const tried = new Map();
/**
 * Whether a hardware encoder works on this machine: one built into ffmpeg may have no chip or driver behind it (a Mac
 * without a ProRes engine, a PC without that maker's chip), so a moment of video goes through it first (once a
 * launch; `broken` remembers one that failed after that).
 * @param {string} encoder
 */
function works(encoder) {
  if (!tried.has(encoder)) {
    const prores = encoder.startsWith('prores_') ? proresOptions(encoder, true) : null;
    const options = prores ? ['-vf', prores.pix, ...prores.video] : ['-vf', 'format=yuv420p', ...hardwareOptions(encoder, 2e6)];
    tried.set(encoder, new Promise((done) => {
      execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '10',
        ...options, '-f', 'null', '-'], { timeout: 20_000, windowsHide: true }, (error) => done(!error));
    }));
  }
  return /** @type {Promise<boolean>} */ (tried.get(encoder));
}

/** A hardware encoder that failed partway: the rest of this launch uses another. @param {string} encoder */
export const broken = (encoder) => { tried.set(encoder, Promise.resolve(false)); };

/**
 * The first hardware encoder for H.264, HEVC or ProRes that works here, or null.
 * @param {ChipCodec} codec @param {Set<string>} have @param {string} [platform]
 */
export async function hardwareEncoder(codec, have, platform = process.platform) {
  for (const encoder of HARDWARE[platform]?.[codec] ?? []) if (have.has(encoder) && await works(encoder)) return encoder;
  return null;
}

/** Linux's render nodes (`/dev/dri/renderD128`…), the way to a chip's VA-API without a display. */
function renderNodes() {
  try { return readdirSync('/dev/dri').filter((n) => /^renderD\d+$/.test(n)).sort().map((n) => `/dev/dri/${n}`); } catch { return []; }
}

/**
 * The graphics chip's decoders a platform's ffmpeg may have, in the order they are tried, as the input options that
 * turn each on: the Mac's media engine; on Windows Direct3D 11's, which every maker's chip has, then NVIDIA's own; on
 * Linux VA-API's (Intel's and AMD's) through the first render node, then NVIDIA's. With no output format asked, each
 * hands its frames back to memory, where any filter and either kind of encoder takes them.
 * @param {string} [platform] @param {string[]} [nodes] Linux's render nodes
 * @returns {string[][]}
 */
export function decoderCandidates(platform = process.platform, nodes = platform === 'linux' ? renderNodes() : []) {
  if (platform === 'darwin') return [['-hwaccel', 'videotoolbox']];
  if (platform === 'win32') return [['-hwaccel', 'd3d11va'], ['-hwaccel', 'cuda']];
  if (platform === 'linux') return [...(nodes.length ? [['-hwaccel', 'vaapi', '-hwaccel_device', nodes[0]]] : []), ['-hwaccel', 'cuda']];
  return [];
}

/** A moment of H.264 (ten frames, raw), for trying decoders on; null when this ffmpeg can't make one. @returns {Promise<Buffer | null>} */
function sampleH264() {
  return new Promise((done) => {
    execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-frames:v', '10',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'], { encoding: 'buffer', maxBuffer: 16 << 20, timeout: 20_000, windowsHide: true },
    (error, stdout) => done(error || !stdout.length ? null : stdout));
  });
}

/**
 * `sample` decoded with these input options, as the MD5 of its frames in 8-bit 4:2:0; null when it does not decode. A
 * decoder whose device does not open (no chip, no driver, a virtual machine) fails at once. H.264 decodes to the same
 * pixels on every correct decoder, so a chip whose frames differ from the processor's has a driver that is wrong.
 * @param {string[]} options @param {Buffer} sample @returns {Promise<string | null>}
 */
function decodedMd5(options, sample) {
  return new Promise((done) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...options, '-f', 'h264', '-i', 'pipe:0', '-pix_fmt', 'yuv420p', '-f', 'md5', '-'],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    proc.on('error', () => { clearTimeout(timer); done(null); });
    proc.on('close', (code) => { clearTimeout(timer); done(code === 0 && /^MD5=\w+$/.test(out.trim()) ? out.trim() : null); });
    proc.stdin.on('error', () => {});
    proc.stdin.end(sample);
  });
}

/** @type {Promise<string[]> | null} */
let decoding = null;
/**
 * The input options that decode footage on the graphics chip here, or none: the first of decoderCandidates this
 * ffmpeg has that decodes a moment of H.264 to the processor's very pixels (once a launch). What the chip can't take (a
 * codec, a bit depth, a size) ffmpeg decodes on the processor by itself; a chip that fails partway is left out from
 * then on (`onTheChip`).
 * @returns {Promise<string[]>}
 */
export function hardwareDecoding() {
  decoding ??= (async () => {
    const built = await hwaccels();
    const candidates = decoderCandidates().filter((options) => built.has(options[1]));
    const sample = candidates.length ? await sampleH264() : null;
    const expected = sample ? await decodedMd5([], sample) : null;
    if (sample && expected) for (const options of candidates) if (await decodedMd5(options, sample) === expected) return options;
    return [];
  })();
  return decoding;
}

/**
 * A conversion on the chip, and again without what failed: `make(encoder, decoding)` with the chip's decoding and
 * `encoder` (either may be none), then with the processor's decoding, then with the processor for both (`encoder`
 * null). What made the difference is left out for the rest of this launch: the chip's decoding when the same encoder
 * then worked, else the chip's encoder. Cancelled (`signal`), it is not tried again.
 * @template T
 * @param {string | null} encoder @param {(encoder: string | null, decoding: string[]) => Promise<T>} make
 * @param {AbortSignal} [signal] @returns {Promise<T>}
 */
export async function onTheChip(encoder, make, signal) {
  const chip = await hardwareDecoding();
  const tries = /** @type {[string | null, string[]][]} */ ([[encoder, chip], [encoder, []], [null, []]])
    .filter(([e, d], i, all) => all.findIndex(([e2, d2]) => e2 === e && d2.length === d.length) === i);
  /** @type {string | null | undefined} the encoder of the try that failed last */
  let failed;
  for (const [i, [e, d]] of tries.entries()) {
    try {
      const made = await make(e, d);
      if (failed !== undefined) {
        if (failed === e) decoding = Promise.resolve([]);
        else if (failed) broken(failed);
      }
      return made;
    } catch (error) {
      if (signal?.aborted || i === tries.length - 1) throw error;
      failed = e;
    }
  }
  throw new Error('no conversion was tried');
}

/* the codes of H.273 (what an H.264 stream says), by the names ffprobe gives */
const PRIMARIES = /** @type {Record<string, number>} */ ({ bt709: 1, bt470m: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, film: 8, bt2020: 9, smpte428: 10, smpte431: 11, smpte432: 12, 'jedec-p22': 22 });
const TRANSFERS = /** @type {Record<string, number>} */ ({ bt709: 1, gamma22: 4, gamma28: 5, smpte170m: 6, smpte240m: 7, linear: 8, log100: 9, log316: 10, 'iec61966-2-4': 11, bt1361e: 12, 'iec61966-2-1': 13, 'bt2020-10': 14, 'bt2020-12': 15, smpte2084: 16, smpte428: 17, 'arib-std-b67': 18 });
const MATRICES = /** @type {Record<string, number>} */ ({ gbr: 0, bt709: 1, fcc: 4, bt470bg: 5, smpte170m: 6, smpte240m: 7, ycgco: 8, bt2020nc: 9, bt2020c: 10, smpte2085: 11, 'chroma-derived-nc': 12, 'chroma-derived-c': 13, ictcp: 14 });

/**
 * A source's color tags written into the H.264 stream of its copy (`h264_metadata`): a chip's encoder drops the ones
 * it has no key for (the sRGB transfer screen recordings carry), and a copy must show as its source does. Empty when
 * the source says nothing.
 * @param {{ color_primaries?: string, color_transfer?: string, color_space?: string, color_range?: string }} tags
 */
export function h264ColorTags(tags) {
  const parts = [];
  const code = (/** @type {Record<string, number>} */ table, /** @type {string | undefined} */ name) => (name && Object.hasOwn(table, name) ? table[name] : null);
  const primaries = code(PRIMARIES, tags.color_primaries), transfer = code(TRANSFERS, tags.color_transfer), matrix = code(MATRICES, tags.color_space);
  if (primaries != null) parts.push(`colour_primaries=${primaries}`);
  if (transfer != null) parts.push(`transfer_characteristics=${transfer}`);
  if (matrix != null) parts.push(`matrix_coefficients=${matrix}`);
  if (tags.color_range === 'tv' || tags.color_range === 'pc') parts.push(`video_full_range_flag=${tags.color_range === 'pc' ? 1 : 0}`);
  return parts.length ? ['-bsf:v', `h264_metadata=${parts.join(':')}`] : [];
}

/** The color tags of a video's first picture stream (none when ffprobe can't say). @param {string} file */
export function colorTagsOf(file) {
  return new Promise((done) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range', '-of', 'json', file],
      { windowsHide: true }, (error, stdout) => {
        try { done(error ? {} : JSON.parse(String(stdout)).streams?.[0] ?? {}); } catch { done({}); }
      });
  });
}
