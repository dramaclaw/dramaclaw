// film render: the deliverable. Frames are rendered in parallel page instances, averaged
// over the shutter for motion blur, encoded with tagged BT.709 color, and muxed with the mix of the film's sounds.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { clipKind, FILM_FILE } from './film-doc.mjs';
import { broken, encoders, hardwareEncoder, hardwareOptions, proresOptions } from './encoders.mjs';
import { FilmPage, launch } from './host.mjs';
import { exactRate, ffmpegRate } from './rate.mjs';
import { browserCopies, filmVideos } from './seekable.mjs';
import { ffmpeg, filmSound, fmt, kill, mix, open, outDir, parseTarget, shown, UsageError, write } from './shared.mjs';

const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const TAG_709 = ['-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'];

/** Output formats: picture codec, pixel format, sound codec. Transparency needs .webm or .mov. */
const FORMATS = {
  '.mp4': { video: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '16', ...BT709], pix: 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', audio: ['-c:a', 'aac', '-b:a', '192k'], tag: TAG_709 },
  '.webm': { video: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '20', '-row-mt', '1'], pix: 'format=yuva420p', audio: ['-c:a', 'libopus', '-b:a', '160k'], tag: [] },
  '.mov': { video: ['-c:v', 'prores_ks', '-profile:v', '4444', '-vendor', 'apl0'], pix: 'format=yuva444p10le', audio: ['-c:a', 'pcm_s16le'], tag: [] },
};

/** Bits per pixel per frame for the chip's H.264: Studio's "high", with room for screen text (exports.mjs). */
const CHIP_BPP = 0.165;

/**
 * The container's picture through the graphics chip, when it has an encoder that works and takes the picture's size:
 * H.264 for an MP4, a key frame every two seconds; ProRes 4444 for a MOV. Null otherwise: the container's own.
 * @param {string} ext @param {{ w: number, h: number }} size @param {number} fps
 */
async function chipFormat(ext, size, fps) {
  if (Math.min(size.w, size.h) < 64 || Math.max(size.w, size.h) > 4096) return null;
  const have = await encoders();
  if (ext === '.mp4') {
    const encoder = await hardwareEncoder('h264', have);
    const bits = Math.min(120e6, Math.max(2e6, size.w * size.h * fps * CHIP_BPP));
    return encoder ? { encoder, format: { video: [...hardwareOptions(encoder, bits, { gop: fps * 2 }), ...BT709] } } : null;
  }
  if (ext === '.mov') {
    const encoder = await hardwareEncoder('prores', have);
    return encoder ? { encoder, format: proresOptions(encoder, true) } : null;
  }
  return null;
}

/** The encoder a format's picture options name. @param {string[] | undefined} video */
const encoderOf = (video = []) => video[video.indexOf('-c:v') + 1] ?? 'ffmpeg';

/** What an encoder out of memory says: x264's failed malloc, ffmpeg's ENOMEM, or Windows ending it (STATUS_NO_MEMORY). */
const OUT_OF_MEMORY = /malloc of size \d+ failed|cannot allocate memory|out of memory|exit 3221225495\b/i;

/**
 * An encode's error, said plainly when the encoder ran out of memory: each browser feeds an encoder of its own, so
 * fewer browsers is what helps. Any other error as it is.
 * @param {unknown} e @param {number} workers
 */
export function outOfMemory(e, workers) {
  if (!(e instanceof Error) || !OUT_OF_MEMORY.test(e.message)) return e;
  const said = workers > 1
    ? `ffmpeg ran out of memory with ${workers} browsers rendering at once: try fewer, for example --workers ${Math.floor(workers / 2)}`
    : 'ffmpeg ran out of memory: close other apps and try again';
  return new Error(`${said}\n${e.message}`, { cause: e });
}

export async function render(args, opts = {}) {
  const started = Date.now();
  const { film: target, at, range } = parseTarget(args);
  if (at != null) throw new UsageError(`render takes a range (for example ${at}-${at + 2}), not one time; for one frame use openfilm look ${at}`);
  /* `root`: the folder to serve (a host rendering an edit kept elsewhere in a project serves the project). The videos
     the pages ask for are noted, and served as their fast-seeking copies once there are some (seekable.mjs). */
  const videos = new Set();
  /** @type {Map<string, string>} */
  let copies = new Map();
  const swap = (/** @type {string} */ file) => {
    if (clipKind(file) === 'video') videos.add(file);
    return copies.get(file) ?? null;
  };
  const probe = await open(target, { ...(opts.root ? { root: opts.root } : {}), swap });
  const { entry, dir, name, site, browser, isFilm, root } = probe;
  const meta = probe.film.meta;
  await probe.film.close();

  /* 29.97 is 30000/1001, as the footage shot at it is (rate.mjs) */
  const rate = exactRate(Number(opts.fps ?? 30));
  const fps = rate.fps;
  /* a page without a duration has no end: it is rendered by a range */
  const end = meta.duration ?? Infinity;
  if (!range && meta.duration == null) { await probe.close(); throw new UsageError('this page has no duration, so it has no end: give a range to render, e.g. openfilm render 0-6'); }
  const [from, to] = range ? [range[0], Math.min(range[1], end)] : [0, end];
  const f0 = Math.round(from * fps);
  const f1 = Math.round(to * fps);
  const total = f1 - f0;
  if (total <= 0) { await probe.close(); throw new UsageError(`nothing to render between ${fmt(from)} and ${fmt(to)}${meta.duration != null ? `: the film is ${fmt(meta.duration)} long` : ''}`); }
  if (range && range[1] > end) console.error(`openfilm render: ${fmt(range[0])}-${fmt(range[1])} runs past the film's end (${fmt(meta.duration)}): rendered to there`);
  const scale = opts.scale ?? (opts['4k'] ? 3840 / meta.width : 1);
  const samples = Math.max(1, Number(opts.samples ?? (opts.blur ? 8 : 1)));
  const shutter = Number(opts.shutter ?? 0.5);
  const alpha = !!opts.alpha;
  /* the whole film is the person's, beside film.html; a stretch rendered to check something stays in the tool's folder */
  const out = resolve(opts.out ?? (range
    ? join(outDir(dir, 'render'), `${name}-${from}-${to}${alpha ? '.webm' : '.mp4'}`)
    : join(dir, `${name}${alpha ? '.webm' : '.mp4'}`)));
  mkdirSync(dirname(out), { recursive: true });
  const container = FORMATS[extname(out).toLowerCase()];
  if (!container) { await probe.close(); throw new UsageError(`can't write ${extname(out)}: use .mp4, .webm or .mov`); }
  if (alpha && extname(out).toLowerCase() === '.mp4') { await probe.close(); throw new UsageError('mp4 has no transparency: write .webm or .mov with --alpha'); }
  /* a host may encode the container its own way (Studio's export: another codec, a quality, a frame around the film),
     and gets exactly that; else the picture goes through the graphics chip when it can */
  const own = { ...container, ...opts.format };
  const size = { w: Math.round(meta.width * scale), h: Math.round(meta.height * scale) };
  const chip = opts.format || opts.hardware === false ? null : await chipFormat(extname(out).toLowerCase(), size, fps);
  let format = chip ? { ...own, ...chip.format } : own;
  let encoder = chip?.encoder ?? encoderOf(own.video);
  const workers = Math.max(1, Math.min(Number(opts.workers ?? defaultWorkers(machine(), total)), total));
  /* the videos get copies this browser plays: those it does not decode here (ProRes; HEVC without a chip for it), and
     for a render of more than a moment those that seek slowly (seekable.mjs). A film's video clips load only when
     their time comes, so they are read from film.html (a page drawn around the project's film, as a burned-in
     subtitle export is, reads the project's); a page's own videos are the ones it asked for */
  if (opts.seekable !== false) {
    const film = isFilm ? entry : opts.root ? FILM_FILE : null;
    const files = [...new Set([...videos, ...(film ? filmVideos(root, film) : [])])];
    copies = await browserCopies(browser, site.url, root, files, { signal: opts.signal, slow: total >= fps * 2 });
  }

  if (!process.stderr.isTTY && !opts.onProgress) process.stderr.write(`  rendering ${total} frames with ${workers} browser${workers > 1 ? 's' : ''}…\n`);
  const work = join(outDir(dir, 'render'), `.parts-${process.pid}`);
  mkdirSync(work, { recursive: true });
  let done = 0;
  /* a terminal gets a live counter; an agent's shell (no TTY) a line every tenth, so a long render never looks hung */
  let t0 = Date.now();
  let told = 0;
  const progress = () => {
    done++;
    if (done === 1) t0 = Date.now(); // the rate from the first frame on: starting the browsers is not a frame's cost
    /* a host showing its own progress (Studio's export) is told each frame, and the terminal is left alone */
    if (opts.onProgress) { opts.onProgress(done, total); return; }
    if (process.stderr.isTTY) { process.stderr.write(`\r  ${done}/${total} frames`); return; }
    const tenth = Math.floor((done / total) * 10);
    if (tenth > told && done < total) {
      told = tenth;
      const left = ((Date.now() - t0) / Math.max(1, done - 1)) * (total - done) / 1000;
      process.stderr.write(`  ${done}/${total} frames · about ${Math.ceil(left)} s left\n`);
    }
  };
  const problems = [];
  /* cancelled (`signal`): stop now, not once every browser has drawn the frame it is on; the finally closes them */
  const cancelled = opts.signal?.aborted ? Promise.reject(new Error('cancelled'))
    : new Promise((_, fail) => opts.signal?.addEventListener('abort', () => fail(new Error('cancelled')), { once: true }));
  cancelled.catch(() => {});
  /** @type {import('playwright-core').Browser[]} */
  const browsers = [];
  /* what is left of a step given up fails as the browsers close: that is no one's error */
  const unlessCancelled = (/** @type {Promise<any>} */ step) => { step.catch(() => {}); return Promise.race([step, cancelled]); };
  try {
    /* a browser each: pages sharing one browser share its GPU process, and stop getting faster after three or four */
    const more = await unlessCancelled(Promise.all(Array.from({ length: workers - 1 }, () => launch().then((b) => { browsers.push(b); return b; }))));
    const pages = await unlessCancelled(Promise.all([browser, ...more].map((b) => FilmPage.open(b, site.url, entry, { scale, transparent: alpha }))));
    /* a film paints its stage behind its clips (black, or its own background): with alpha, only what the clips draw is kept */
    if (alpha && isFilm) await Promise.all(pages.map((p) => p.page.addStyleTag({ content: 'html, body { background: transparent !important; }' })));
    const per = Math.ceil(total / workers);
    const parts = pages.map((film, i) => ({ film, a: f0 + i * per, b: Math.min(f1, f0 + (i + 1) * per), file: join(work, `part-${i}${extname(out)}`) })).filter((p) => p.a < p.b);
    /** Every part, encoded with `f`: one that fails stops the others before its error is told. @param {typeof format} f */
    const encodeAll = async (f) => {
      const stop = new AbortController();
      const quit = () => stop.abort();
      opts.signal?.addEventListener('abort', quit, { once: true });
      const runs = parts.map((p) => encode(p, { fps, rate, samples, shutter, duration: end, format: f, onFrame: progress, still: alpha ? 'png' : 'jpeg', signal: stop.signal }));
      try {
        await unlessCancelled(Promise.all(runs));
      } catch (e) {
        stop.abort();
        await Promise.allSettled(runs);
        throw outOfMemory(e, parts.length);
      } finally {
        opts.signal?.removeEventListener('abort', quit);
      }
    };
    try {
      await encodeAll(format);
    } catch (e) {
      /* the chip's encoder gave up partway (a driver, a size it does not take): the frames again without it, and the
         rest of this launch does without it */
      if (!chip || opts.signal?.aborted || !/^ffmpeg/.test(e instanceof Error ? e.message : '')) throw e;
      broken(chip.encoder);
      format = own;
      encoder = encoderOf(own.video);
      done = 0;
      told = 0;
      await encodeAll(format);
    }
    if (process.stderr.isTTY && !opts.onProgress) process.stderr.write('\n');
    for (const p of pages) problems.push(...p.problems);

    /* names, not paths: concat reads them beside the list, and a path can hold a `'` (C:\\Users\\O'Brien) */
    writeFileSync(join(work, 'list.txt'), parts.map((p) => `file '${basename(p.file)}'`).join('\n'));
    const video = join(work, `video${extname(out)}`);
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'), '-c', 'copy', video]).done;
    const clips = opts.silent ? [] : await filmSound(probe, from);
    if (opts.signal?.aborted) throw new Error('cancelled');
    if (clips.length) {
      const sound = join(work, `sound${extname(out) === '.mp4' ? '.m4a' : extname(out) === '.webm' ? '.webm' : '.wav'}`);
      await mix(clips, to - from, sound, format.audio);
      await ffmpeg(['-i', video, '-i', sound, '-map', '0:v', '-map', '1:a', '-c', 'copy', ...format.tag, ...(extname(out) === '.mp4' ? ['-movflags', '+faststart'] : []), out]).done;
    } else {
      await ffmpeg(['-i', video, '-c', 'copy', ...format.tag, ...(extname(out) === '.mp4' ? ['-movflags', '+faststart'] : []), out]).done;
    }
  } finally {
    /* Windows lets go of a file a moment after ffmpeg exits, and later still after one that failed: a folder it
       still holds is left behind rather than told in place of what went wrong */
    try { rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    await Promise.allSettled(browsers.map((b) => b.close()));
    await probe.close();
  }
  const seconds = (Date.now() - started) / 1000;
  return {
    out,
    encoder,
    lines: [
      `→ ${shown(out)}`,
      `  ${total} frames · ${fmt(to - from)} at ${Number(fps.toFixed(3))} fps · ${Math.round(meta.width * scale)}×${Math.round(meta.height * scale)}${samples > 1 ? ` · ${samples} samples/frame` : ''}${alpha ? ' · alpha' : ''} · ${workers} worker${workers > 1 ? 's' : ''} · ${encoder} · ${seconds.toFixed(1)} s`,
      ...problems.map((p) => `✗ ${p.kind === 'request' ? 'request' : 'page'}: ${p.message}`),
    ],
  };
}

/**
 * One browser per three cores, at most four, and memory to spare (a page with its media takes 1.5 GB or more, and the
 * encoder and the person's own apps need theirs): a render leaves the computer usable while it runs.
 */
/** The memory a browser drawing a film takes, with its share of the encoding (a 1080p film's page measured 1.1 GB). */
const WORKER_MEMORY = 1.5 * 2 ** 30;
/** Memory left free for the person's own apps. */
const RESERVE = 2 * 2 ** 30;
/** Frames worth a browser of their own: for fewer, starting one costs more than it saves. */
const FRAMES_PER_WORKER = 60;
/** More browsers stop drawing faster: they share one graphics chip (measured: three draw twice as fast as one;
 * past four, slower, and eight ran out of resources). */
const MAX_WORKERS = 4;

/**
 * What a render may use of this machine: its performance cores (Apple silicon's efficiency cores are slow for
 * drawing; elsewhere a core is two threads) and the memory free now. On a Mac `os.freemem()` counts only memory never
 * used, a fraction of what is free: the system's own share of free memory is read instead.
 */
export function machine() {
  const sysctl = (/** @type {string} */ name) => Number(spawnSync('sysctl', ['-n', name], { encoding: 'utf8', timeout: 2000 }).stdout?.trim());
  let cores = Math.max(1, Math.floor(availableParallelism() / 2));
  let available = freemem();
  if (process.platform === 'darwin') {
    const performance = sysctl('hw.perflevel0.physicalcpu');
    if (performance > 0) cores = performance;
    const free = sysctl('kern.memorystatus_level');
    if (free > 0 && free <= 100) available = (totalmem() * free) / 100;
  }
  return { cores, available };
}

/**
 * How many browsers draw a render: one for each performance core but one (the person keeps one), as many as the
 * memory free now holds with room left for the person's apps, and enough frames for each; at most four. The
 * computer stays usable while it renders: a render takes only memory that is free when it starts.
 * @param {{ cores: number, available: number }} [budget] @param {number} [frames]
 */
export function defaultWorkers({ cores, available } = machine(), frames = Infinity) {
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1, Math.floor((available - RESERVE) / WORKER_MEMORY), Math.floor(frames / FRAMES_PER_WORKER)));
}

/** Frames [a, b) of one page into one file; sub-frames are averaged by ffmpeg (tmix) and every n-th kept. */
async function encode({ film, a, b, file }, { fps, rate, samples, shutter, duration, format, onFrame, still, signal }) {
  const blur = samples > 1 ? `tmix=frames=${samples},select='eq(mod(n\\,${samples})\\,${samples - 1})',setpts=N/((${ffmpegRate(rate)})*TB),` : '';
  const enc = ffmpeg(['-f', 'image2pipe', '-framerate', ffmpegRate(rate, samples), '-c:v', still === 'png' ? 'png' : 'mjpeg', '-i', '-',
    '-vf', blur + format.pix, '-r', ffmpegRate(rate), ...format.video, file], { input: true });
  /* a cancelled render stops its encoder at once: the frames ffmpeg still holds are thrown away, not encoded (a 4K
     encode takes seconds to drain); the parts folder goes with it (see render's finally) */
  const stop = () => kill(enc.proc);
  enc.proc.stdin.on('error', () => {});
  /* an ffmpeg that ends before its last frame (not found, an encoder that fails to start) never drains its input:
     the frame being written fails with ffmpeg's own error instead of waiting for it forever */
  const ended = enc.done.then(() => { throw new Error('ffmpeg ended before the last frame'); });
  ended.catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let f = a; f < b; f++) {
      if (signal?.aborted) {
        stop();
        throw new Error('cancelled');
      }
      for (let k = 0; k < samples; k++) {
        const t = (f + (samples > 1 ? (k / samples - 0.5) * shutter : 0)) / fps;
        await film.seek(Math.min(Math.max(0, t), duration - 1e-4));
        const frame = await film.capture(still === 'png' ? { format: 'png' } : { format: 'jpeg', quality: 95 });
        await Promise.race([write(enc.proc.stdin, frame), ended]);
      }
      onFrame();
    }
  } finally {
    signal?.removeEventListener('abort', stop);
    enc.proc.stdin.end();
  }
  await enc.done;
}
