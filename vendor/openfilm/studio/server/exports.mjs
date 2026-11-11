// @ts-check
/**
 * Exports: the film as a video (any codec this machine's ffmpeg encodes, any delivery frame), a GIF, its sound (the
 * mix and stems), a poster or scene stills, its subtitles as files, slides, or its timeline for an editing program.
 * One at a time, in the order asked, each cancellable. A video export is `openfilm render` itself and the sound is the
 * same mix, so what Studio exports is what the agent checked with `look` and `render`.
 *
 * Files go to the exports folder (the Desktop, <OPENFILM_HOME>/exports when that is set, or OPENFILM_EXPORTS), or a
 * folder the person chose, named after the project, never over an earlier one.
 *
 * What an export asks (POST exports, one ask or `{ jobs: [ask…], folder? }`):
 *
 *   { kind: 'video', codec?, frame?, fill?, shortEdge?, fps?, quality?, audio?, clip?, scale?, preset?, sidecar? }
 *       codec    h264 (default) | hevc | vp9 | prores422hq | prores4444 | hevc_alpha | png (a zipped PNG sequence);
 *                vp9, prores4444, hevc_alpha and png keep transparency
 *       frame    native (default), or a ratio W:H from 1:4 to 4:1 (16:9, 9:16, 4:5, 2.39:1…): a delivery frame around
 *                the film, which is fitted with bars (fill: 'contain', default) or fills it and is cropped (fill: 'cover')
 *       shortEdge the picture's short side in pixels (default: the film's own size)
 *       clip     only this clip of film.html (by id), from its start, at the stage's size × `scale` (default 1)
 *       preset   a platform's name, for the file name
 *       sidecar  'srt' | 'vtt': the subtitles as a file beside the video too
 *   { kind: 'gif', frame?, fill?, width? (long side, default 640), fps? (default 15) }
 *   { kind: 'audio', format?: 'wav' | 'm4a' | 'mp3', mix?: boolean (default true), stems?: boolean }
 *       mix: `<name> - mix`; stems: voice, music, sound effects and the footage's own sound, each its own file
 *       (`<name> - voice`…), a sound grouped by where it is (assets/audio/music/…, assets/audio/sfx/…, anything
 *       else is voice) and a video's sound as the footage's (nle.mjs soundStem)
 *   { kind: 'stills', as?: 'files' | 'zip', format?: 'png' | 'jpg', frame?, fill?, shortEdge?, at?: number[] }
 *       one frame from the middle of each picture clip (or at the seconds `at`, each named by the scene it is in), zipped
 *       when there are several unless `as` explicitly asks for separate files or a zip (even for one frame)
 *   { kind: 'poster', format?, frame?, fill?, shortEdge?, at?: number }   one frame (default: the middle)
 *   { kind: 'subtitles', format?: 'srt' (default) | 'vtt' | 'txt' }   the film's subtitle cues as a file (txt: a
 *       plain transcript); refused when the film has none
 *   { kind: 'slides', format?: 'pptx' (default) | 'pdf', frame?, fill?, shortEdge? (default 1080), at?: number[] }
 *       the stills (each scene's middle, or the seconds `at`) bound as a deck (the scene's name in the speaker notes) or a
 *       PDF, one page each
 *   { kind: 'nle', format?: 'xml' (default) | 'fcpxml' | 'jianying' | 'capcut', fps? (snapped to 23.976, 24, 25, 29.97, 30, 50, 59.94 or 60;
 *     default 30), audio?: 'clips' (default) | 'stems', media?: 'copy' (default) | 'link', subtitles?: boolean (default true),
 *     alpha?: 'auto' | 'png' | 'prores' | 'prores4444' }
 *       a folder an editing program opens (see nle.mjs): `<name>.xml` (xmeml: Premiere Pro, DaVinci Resolve) or `<name>.fcpxml` (Final Cut Pro), each
 *       web page rendered with its alpha to a MOV in media/ (`alpha`, for a draft: `auto`, the default, a page with no
 *       clear pixel in any frame as H.264 and the others as lossless PNG, each picture kept once for as long as it
 *       shows; `png`, every page so; `prores`, 422 HQ and 4444 the same way. For xml ProRes 4444, the default, or PNG;
 *       for fcpxml ProRes 4444. 剪映 shows a VP9 WebM's alpha black, and lossless H.264 off its colors),
 *       footage, stills and sounds cloned there (`link`:
 *       pointed at where they are), the sound as clips or as mixed stems, `<name>.srt` when there are subtitles.
 *       FCPXML also includes subtitles as editable Basic Title clips above the picture tracks.
 *       `jianying`, `capcut`: the same timeline as a 剪映 or CapCut draft (see jianying.mjs), made in the app's drafts folder when this
 *       computer has one (else in the exports folder, to be moved there), its subtitles a text track
 *
 *   { kind: 'project', parts?: ('history' | 'chat' | 'logs')[], as?: 'zip' (default) | 'folder' }
 *       the project itself, to hand on or keep (see projectFiles): its work always, the parts asked besides; a zip
 *       holding the project's folder, or the folder itself, opened as a project like any other
 *
 * Any of them but the project also takes `range: [from, to]` (seconds; not stills, posters, slides or nle) and `label`
 * (how the person's list names it); any of them takes `name` (what the file is called; the project's own when there is
 * none); those with a picture (not one clip alone) take `burnSubtitles: true`, the subtitles drawn into the picture as
 * the editor shows them (captions.mjs: the cues and the person's style). `folder`: an absolute path (or ~/…) to write
 * to instead of the exports folder.
 * Time-based exports also accept `ranges: [[from, to], ...]` (1–100, seconds) to join the selections in their given
 * order, with the picture, sound and subtitles on the joined clock. Choose either `range` or `ranges`.
 */
import { execFile, fork, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir, setPriority, tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FilmPage, launch } from '../../src/host.mjs';
import { broken, encoders, FRAMES_709, hardwareEncoder, hardwareOptions, onTheChip, prores709, proresOptions } from '../../src/encoders.mjs';
import { COMMAND_ROOM, filmSound, filterScriptOption, kill as killProcess, mix, open } from '../../src/shared.mjs';
import { defaultWorkers, machine } from '../../src/render.mjs';
import { selectionClips } from '../../src/render-ranges.mjs';
import { filmVideos } from '../../src/seekable.mjs';
import { FILM_FILE, clipFade, filmHtml, fittedFade, kindOf, pictureRect, readFilmFile } from '../../src/film-doc.mjs';
import { layerBlocks, rowBadges, trackKind } from './track-layout.mjs';
import { fcpxmlDocument } from './fcpxml.mjs';
import { NLE_FPS, nleFps, planNleTimeline, probeSource, soundStem, xmemlDocument } from './nle.mjs';
import { draftsRoot, jianyingDraft } from './jianying.mjs';
import { slidesPdf, writePptx } from './slides.mjs';
import { subtitlesForExport } from './captions.mjs';
import { burned, even, frameBox, frameRatio, stageOf } from '../../src/burn.mjs';
export { frameBox, frameRatio };
import { filmSubtitleCuesInRange, filmSubtitleCuesInRanges, filmSubtitleShown, filmSubtitleSrt, filmSubtitleTranscript, filmSubtitleVtt } from './film-subtitle.mjs';
import { zipFiles } from './zip.mjs';
import { inProject } from './files.mjs';
import { filmClosure, folderView } from './closure.mjs';
import { PROJECT_PARTS, TOOL_DIR } from './projects.mjs';
import { exportsRoot } from '../../src/locations.mjs';
import { recordProblem } from '../../src/problems.mjs';

/** The exports folder: the one chosen in Settings, else the Desktop, where a file just made is found (src/locations.mjs). */
export { exportsRoot };

/**
 * @typedef {'h264' | 'hevc' | 'vp9' | 'prores422hq' | 'prores4444' | 'hevc_alpha' | 'png'} VideoCodec
 * @typedef {'native' | `${number}:${number}`} FrameId
 * @typedef {'standard' | 'high' | 'master'} Quality
 * @typedef {{ frame?: FrameId, fill?: 'contain' | 'cover', burnSubtitles?: boolean }} Framing
 * @typedef {Framing & { kind: 'video', codec?: VideoCodec, shortEdge?: number, scale?: number,
 *   fps?: number, quality?: Quality, audio?: boolean, clip?: string, preset?: string, sidecar?: 'srt' | 'vtt', hardware?: boolean }} VideoAsk
 * @typedef {Framing & { kind: 'gif', width?: number, fps?: number }} GifAsk
 * @typedef {{ kind: 'audio', format?: 'wav' | 'm4a' | 'mp3', mix?: boolean, stems?: boolean }} AudioAsk
 * @typedef {Framing & { kind: 'stills', as?: 'files' | 'zip', format?: 'png' | 'jpg', shortEdge?: number, at?: number[] }} StillsAsk
 * @typedef {Framing & { kind: 'poster', format?: 'png' | 'jpg', shortEdge?: number, at?: number }} PosterAsk
 * @typedef {{ kind: 'subtitles', format?: 'srt' | 'vtt' | 'txt' }} SubtitlesAsk
 * @typedef {Framing & { kind: 'slides', format?: 'pptx' | 'pdf', shortEdge?: number, at?: number[] }} SlidesAsk
 * @typedef {{ kind: 'nle', format?: 'xml' | 'fcpxml' | 'jianying' | 'capcut', fps?: number, audio?: 'clips' | 'stems', media?: 'copy' | 'link', subtitles?: boolean, alpha?: 'auto' | 'png' | 'prores' | 'prores4444' }} NleAsk
 * @typedef {{ kind: 'project', parts?: ProjectPart[], as?: 'zip' | 'folder' }} ProjectAsk
 * @typedef {typeof PROJECT_PARTS[number]} ProjectPart
 * @typedef {VideoAsk | GifAsk | AudioAsk | StillsAsk | PosterAsk | SubtitlesAsk | SlidesAsk | NleAsk | ProjectAsk} ExportSpec
 * @typedef {ExportSpec & { range?: [number, number], ranges?: [number, number][], label?: string, name?: string }} ExportAsk
 * @typedef {import('./film-subtitle.mjs').FilmSubtitleCue} Cue
 * @typedef {import('./film-subtitle.mjs').FilmSubtitleStyle} SubtitleStyle
 * @typedef {'preparing' | 'audio' | 'rendering' | 'encoding' | 'copying' | 'finishing'} ExportPhase
 * @typedef {{ id: string, project: string, name: string, label: string, kind: ExportSpec['kind'], ask: ExportAsk,
 *   status: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled', progress: number, phase: ExportPhase | null,
 *   framesDone: number, framesTotal: number, rate: number, etaMs: number | null, encoder: string | null,
 *   out?: string, outputs: string[], bytes: number | null, alpha: { any: boolean } | null, error?: string, cancelling?: boolean,
 *   at: number, startedAt: number | null, finishedAt: number | null, draftsRefused?: string, diskFull?: boolean }} ExportJob
 */

/** Whether an error is the disk being full, in ffmpeg's words or the system's (a Mac, Linux, Windows). @param {unknown} e */
export const diskFull = (e) => /** @type {{ code?: unknown }} */ (e)?.code === 'ENOSPC'
  || /no space left on device|not enough space on the disk|\bENOSPC\b/i.test(e instanceof Error ? e.message : String(e));

export class ExportError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ── what this machine can encode ───────────────────────────────────────── */

/** What the export dialog may offer: the encoders behind each choice that depends on this machine's ffmpeg. */
export async function exportCapabilities() {
  const have = await encoders();
  return {
    h264: have.has('libx264'),
    hevc: have.has('libx265') || have.has('hevc_videotoolbox'),
    hevcAlpha: have.has('hevc_videotoolbox'),
    vp9: have.has('libvpx-vp9'),
    prores: have.has('prores_ks') || have.has('prores_videotoolbox'),
    mp3: have.has('libmp3lame'),
  };
}

/** 剪映's or CapCut's drafts folder on this computer, or null. @param {'jianying' | 'capcut'} app */
const defaultDrafts = (app) => draftsRoot(app, { home: homedir(), localAppData: process.env.LOCALAPPDATA, exists: existsSync });
/** Which of 剪映 and CapCut are on this computer (their drafts folders are there): an editing project goes into its drafts. */
export const draftApps = () => ({ jianying: Boolean(defaultDrafts('jianying')), capcut: Boolean(defaultDrafts('capcut')) });

/* ── delivery frames (the same arithmetic as the editor's lib/film-frame.ts) ── */

const MAX_DIM = 4096;


/**
 * A box's size with its short side at `shortEdge` (even, no side over 4096), in the box's exact shape: a 16:9 frame
 * at 1080 is 1920 × 1080, whatever its rounded pixels around a 2:1 film.
 * @param {{ w: number, h: number, ratio?: number }} box @param {number} shortEdge
 */
export function dimsForShortEdge(box, shortEdge) {
  const r = box.ratio ?? box.w / Math.max(1, box.h);
  let w, h;
  if (r >= 1) { h = even(shortEdge); w = even(h * r); } else { w = even(shortEdge); h = even(w / r); }
  if (w > MAX_DIM || h > MAX_DIM) {
    const k = Math.min(MAX_DIM / w, MAX_DIM / h);
    w = even(w * k); h = even(h * k);
  }
  return { w, h };
}

/** A GIF's size: its long side at `width`. @param {{ w: number, h: number, ratio?: number }} box @param {number} width */
function gifDims(box, width) {
  const r = box.ratio ?? box.w / Math.max(1, box.h);
  return r >= 1 ? { w: even(width), h: even(width / r) } : { w: even(width * r), h: even(width) };
}

/**
 * How to draw the film for a picture `out` big in `frame`: the scale to render the film at (sharp at any size: the
 * browser draws it that big), and the ffmpeg filter that makes it exactly `out` (bars or a crop around it).
 * @param {{ w: number, h: number }} stage @param {string} frame @param {'contain' | 'cover'} fill
 * @param {{ w: number, h: number }} out @param {boolean} alpha
 */
export function framing(stage, frame, fill, out, alpha) {
  const box = frameBox(stage, frame, fill);
  const scale = (out.w / box.w) * box.scale;
  const native = frame === 'native' || Math.abs(stage.w / stage.h - out.w / out.h) < 0.01;
  if (native) return { scale: out.w / stage.w, vf: `scale=${out.w}:${out.h}:flags=lanczos` };
  const w = Math.round(stage.w * scale), h = Math.round(stage.h * scale);
  if (fill === 'cover') return { scale, vf: `scale=${Math.max(out.w, w)}:${Math.max(out.h, h)}:flags=lanczos,crop=${out.w}:${out.h}` };
  return {
    scale,
    vf: `scale=${Math.min(out.w, w)}:${Math.min(out.h, h)}:flags=lanczos,pad=${out.w}:${out.h}:(ow-iw)/2:(oh-ih)/2:color=${alpha ? 'black@0' : 'black'}`,
  };
}

/* ── names ──────────────────────────────────────────────────────────────── */

const safeName = (/** @type {string} */ text) => {
  /* no dot or space at the end (Windows drops them, and the file is not found under the name it was made with) */
  const name = text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '') || 'Dramaclaw';
  /* names Windows keeps for devices, whatever follows their first dot */
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name) ? name.replace(/^[^.]*/, (m) => `${m} film`) : name;
};

/** A name in `dir` that is free: `name.ext`, else `name 2.ext`… */
function freeFile(/** @type {string} */ dir, /** @type {string} */ name, /** @type {string} */ ext) {
  let candidate = join(dir, `${name}${ext}`);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${name} ${n}${ext}`);
  return candidate;
}

/**
 * Where a file is written until it is whole: beside its name, hidden, and renamed to it once made, so a stop or a crash
 * midway never leaves a file under the export's name that looks made. It names the process writing it (`sweep`).
 * @param {string} out @param {string} id
 */
const partialOf = (out, id) => { const ext = extname(out); return join(dirname(out), `.${basename(out, ext)}.partial-${process.pid}-${id}${ext}`); };

/**
 * A rename that rides out Windows: a file that a virus scanner, the search indexer or an editor watching its folder holds
 * for a moment refuses to move (EPERM, EACCES, EBUSY), and is let go a moment later. Tried again for a few seconds, as
 * tools on Windows do; any other error, or a hold that lasts, is the error.
 * @param {string} from @param {string} to
 */
export async function renameSafely(from, to) {
  for (let i = 1; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (i >= 12 || !['EPERM', 'EACCES', 'EBUSY'].includes(/** @type {NodeJS.ErrnoException} */ (e).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, i * 100));
    }
  }
}

/** Scratch removed if it can be: what something still holds is left behind, never failing an export that is made. @param {string} path */
const tidy = (path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});

/* what an export makes on its way, each named with the process making it: a half-made file or draft beside the made
   ones, a project's export scratch, a render's parts, a seek copy being written (src/seekable.mjs) */
const LEFT = {
  output: /^\..+\.partial-(\d+)-[0-9a-f]+/,
  scratch: /^(?:clip|burn|nle)-(\d+)-[0-9a-f]+$/,
  parts: /^\.parts-(\d+)$/,
  copy: /\.part-(\d+)-[0-9a-f]+\.\w+$/,
};

/** Whether a process is running (one this user may not signal is). @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * What exports Studio could not finish left in `dir` (it was ended partway: forced to quit, crashed, the computer
 * shut down): each entry `pattern` names whose process (its first group) has ended.
 * @param {string} dir @param {RegExp} pattern
 */
export async function sweep(dir, pattern) {
  const names = await readdir(dir).catch(() => /** @type {string[]} */ ([]));
  await Promise.all(names.map((name) => {
    const pid = Number(pattern.exec(name)?.[1]);
    return pid && pid !== process.pid && !alive(pid) ? tidy(join(dir, name)) : undefined;
  }));
}

const ALPHA_CODECS = new Set(['vp9', 'prores4444', 'hevc_alpha', 'png']);
const CODECS = ['h264', 'hevc', 'vp9', 'prores422hq', 'prores4444', 'hevc_alpha', 'png'];
const CODEC_EXT = /** @type {Record<VideoCodec, string>} */ ({ h264: '.mp4', hevc: '.mp4', vp9: '.webm', prores422hq: '.mov', prores4444: '.mov', hevc_alpha: '.mov', png: '.zip' });
const SOUND_CODECS = /** @type {Record<string, string[]>} */ ({ wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac', '-b:a', '256k'], mp3: ['-c:a', 'libmp3lame', '-b:a', '256k'] });

/** What a file of this ask is called, before its extension. @param {string} project @param {ExportAsk} ask */
function baseName(project, ask) {
  /* a name typed at export time wins over the project's: a named file keeps the suffixes that tell the files of one
     export apart (a platform, alpha, stills) and loses the ones that only describe the project (a size, a range) */
  const named = typeof ask.name === 'string' && ask.name.trim() ? safeName(ask.name) : null;
  const base = named ?? safeName(project);
  const range = named ? '' : ask.range ? ` ${ask.range[0]}-${ask.range[1]}s` : ask.ranges ? ` ${ask.ranges.length} parts` : '';
  switch (ask.kind) {
    case 'video': {
      if (ask.preset) return `${base} · ${safeName(ask.preset)}${range}`;
      const alpha = ALPHA_CODECS.has(ask.codec ?? 'h264');
      if (ask.clip) return `${base} · ${safeName(ask.clip)}${alpha ? ' (alpha)' : ''}`;
      if (alpha) return `${base} (alpha)${range}`;
      if (named) return base;
      const frame = ask.frame && ask.frame !== 'native' ? ` ${ask.frame.replace(':', 'x')}` : '';
      return `${base}${frame}${ask.shortEdge ? ` ${ask.shortEdge}p` : ''}${range}`;
    }
    case 'stills': return `${base} stills`;
    case 'poster': return `${base} poster`;
    case 'nle':
      if (ask.format === 'fcpxml') return `${base} · Final Cut Pro`;
      return ask.format === 'jianying' || ask.format === 'capcut' ? base : `${base} · Editor XML`;
    default: return `${base}${range}`;
  }
}

/* ── checking what was asked ────────────────────────────────────────────── */

const isNum = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
const between = (/** @type {unknown} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => v === undefined || (isNum(v) && /** @type {number} */ (v) >= lo && /** @type {number} */ (v) <= hi);

/** Check what was asked: a kind Studio exports, each field what it takes. Throws an ExportError saying what is wrong. */
function checked(/** @type {ExportAsk} */ ask) {
  const kinds = ['video', 'gif', 'audio', 'stills', 'poster', 'subtitles', 'slides', 'nle', 'project'];
  if (!ask || typeof ask !== 'object' || !kinds.includes(ask.kind)) throw new ExportError(`export one of: ${kinds.join(', ')}`);
  if (ask.range !== undefined && !(Array.isArray(ask.range) && ask.range.length === 2 && isNum(ask.range[0]) && isNum(ask.range[1]) && ask.range[0] >= 0 && ask.range[1] > ask.range[0])) {
    throw new ExportError('a range is [from, to] in seconds, to after from');
  }
  if (ask.ranges !== undefined) {
    if (ask.range !== undefined || !['video', 'gif', 'audio', 'subtitles'].includes(ask.kind) || ('clip' in ask && ask.clip)) throw new ExportError('ranges: choose a whole-film video, GIF, audio or subtitle export without a single range');
    if (!Array.isArray(ask.ranges) || !ask.ranges.length || ask.ranges.length > 100 || !ask.ranges.every((r) => Array.isArray(r) && r.length === 2 && r.every(isNum) && r[0] >= 0 && r[1] > r[0])) throw new ExportError('ranges: 1 to 100 [from, to] pairs in seconds, to after from');
  }
  if (ask.label !== undefined && (typeof ask.label !== 'string' || ask.label.length > 120)) throw new ExportError('label: text, at most 120 characters');
  if (ask.name !== undefined && (typeof ask.name !== 'string' || ask.name.length > 120)) throw new ExportError('name: text, at most 120 characters');
  if ('frame' in ask && ask.frame !== undefined && ask.frame !== 'native' && frameRatio(ask.frame) == null) throw new ExportError('frame: native, or a ratio W:H from 1:4 to 4:1 (16:9, 2.39:1)');
  if ('fill' in ask && ask.fill !== undefined && ask.fill !== 'contain' && ask.fill !== 'cover') throw new ExportError('fill: contain or cover');
  if ('shortEdge' in ask && !between(ask.shortEdge, 64, MAX_DIM)) throw new ExportError(`shortEdge: 64 to ${MAX_DIM} pixels`);
  if ('burnSubtitles' in ask && ask.burnSubtitles !== undefined && typeof ask.burnSubtitles !== 'boolean') throw new ExportError('burnSubtitles: true or false');
  switch (ask.kind) {
    case 'video':
      if (ask.codec !== undefined && !CODECS.includes(ask.codec)) throw new ExportError(`codec: ${CODECS.join(', ')}`);
      if (!between(ask.fps, 1, 120)) throw new ExportError('fps: 1 to 120');
      if (!between(ask.scale, 0.25, 4)) throw new ExportError('scale: 0.25 to 4');
      if (ask.quality !== undefined && !['standard', 'high', 'master'].includes(ask.quality)) throw new ExportError('quality: standard, high or master');
      if (ask.hardware !== undefined && typeof ask.hardware !== 'boolean') throw new ExportError('hardware: true or false');
      if (ask.clip !== undefined && (typeof ask.clip !== 'string' || !ask.clip || ask.clip.length > 200)) throw new ExportError(`clip: a clip id of ${FILM_FILE}`);
      if (ask.preset !== undefined && (typeof ask.preset !== 'string' || ask.preset.length > 60)) throw new ExportError('preset: a name, at most 60 characters');
      if (ask.sidecar !== undefined && ask.sidecar !== 'srt' && ask.sidecar !== 'vtt') throw new ExportError('sidecar: srt or vtt');
      break;
    case 'gif':
      if (!between(ask.width, 64, 1920)) throw new ExportError('width: 64 to 1920 pixels');
      if (!between(ask.fps, 1, 50)) throw new ExportError('fps: 1 to 50');
      break;
    case 'audio':
      if (ask.format !== undefined && !(ask.format in SOUND_CODECS)) throw new ExportError('sound as wav, m4a or mp3');
      if (ask.mix === false && !ask.stems) throw new ExportError('choose the mix, the stems, or both');
      break;
    case 'stills':
    case 'poster':
      if (ask.range !== undefined) throw new ExportError('a still is a moment: give `at`, not a range');
      if (ask.kind === 'stills' && ask.as !== undefined && ask.as !== 'files' && ask.as !== 'zip') throw new ExportError('stills as files or zip');
      if (ask.format !== undefined && ask.format !== 'png' && ask.format !== 'jpg') throw new ExportError('format: png or jpg');
      if (ask.kind === 'stills' && ask.at !== undefined && !(Array.isArray(ask.at) && ask.at.length <= 500 && ask.at.every((t) => isNum(t) && t >= 0))) {
        throw new ExportError('at: a list of seconds');
      }
      if (ask.kind === 'poster' && ask.at !== undefined && !(isNum(ask.at) && ask.at >= 0)) throw new ExportError('at: a second of the film');
      break;
    case 'subtitles':
      if (ask.format !== undefined && !['srt', 'vtt', 'txt'].includes(ask.format)) throw new ExportError('format: srt, vtt or txt');
      break;
    case 'slides':
      if (ask.range !== undefined) throw new ExportError('slides are moments: give `at`, not a range');
      if (ask.format !== undefined && ask.format !== 'pptx' && ask.format !== 'pdf') throw new ExportError('format: pptx or pdf');
      if (ask.at !== undefined && !(Array.isArray(ask.at) && ask.at.length <= 200 && ask.at.every((t) => isNum(t) && t >= 0))) throw new ExportError('at: a list of seconds');
      break;
    case 'nle':
      if (ask.range !== undefined) throw new ExportError('an editor gets the whole timeline: no range');
      if (ask.format !== undefined && !['xml', 'fcpxml', 'jianying', 'capcut'].includes(ask.format)) throw new ExportError('format: xml, fcpxml, jianying or capcut');
      if (!between(ask.fps, 1, 120)) throw new ExportError(`fps: ${NLE_FPS.join(', ')}`);
      if (ask.audio !== undefined && ask.audio !== 'clips' && ask.audio !== 'stems') throw new ExportError('audio: clips or stems');
      if (ask.media !== undefined && ask.media !== 'copy' && ask.media !== 'link') throw new ExportError('media: copy or link');
      if (ask.subtitles !== undefined && typeof ask.subtitles !== 'boolean') throw new ExportError('subtitles: true or false');
      if (ask.alpha !== undefined) {
        const draft = ask.format === 'jianying' || ask.format === 'capcut';
        const can = ask.format === 'fcpxml' ? ['prores4444'] : draft ? ['auto', 'png', 'prores'] : ['prores4444', 'png'];
        if (!can.includes(ask.alpha)) throw new ExportError(`alpha for ${ask.format ?? 'xml'}: ${can.join(', ')}`);
      }
      break;
    case 'project':
      if (ask.range !== undefined) throw new ExportError('a project is exported whole: no range');
      if (ask.parts !== undefined && !(Array.isArray(ask.parts) && ask.parts.every((p) => PROJECT_PARTS.includes(p)))) throw new ExportError(`parts: some of ${PROJECT_PARTS.join(', ')}`);
      if (ask.as !== undefined && ask.as !== 'zip' && ask.as !== 'folder') throw new ExportError('as: zip or folder');
      break;
  }
  return ask;
}

/** Where to write: the folder asked (absolute, or under ~), else the exports folder. */
function folderOf(/** @type {unknown} */ folder) {
  if (folder === undefined || folder === null || folder === '') return exportsRoot();
  if (typeof folder !== 'string') throw new ExportError('folder: a path');
  const path = folder === '~' ? homedir() : folder.startsWith('~/') ? join(homedir(), folder.slice(2)) : folder;
  if (!isAbsolute(path)) throw new ExportError('folder: a full path, like ~/Movies/Exports');
  if (existsSync(path) && !statSync(path).isDirectory()) throw new ExportError('folder: that is a file, not a folder');
  return resolve(path);
}

/* ── the project itself ─────────────────────────────────────────────────── */

/** Never in a project's export, wherever they are: another tool's repository or packages, and the Finder's notes. */
const NOT_THE_PROJECT = new Set(['.git', 'node_modules', '.DS_Store']);

/**
 * The files of the project at `root` its export takes, with their names in it ('/' between folders): its work (every
 * file but those of `.film/` and NOT_THE_PROJECT; a link to a file is followed, so the export has the media itself)
 * with the subtitles' style, and the parts of `.film/` asked. A link to a folder (a whole footage library, often) is
 * not taken whole: only the files in it the film uses (closure.mjs: a clip's file, its subtitles and transcripts, what
 * a page loads), as files at the same places, so the copy plays. Never the project's id (a copy gets its own) nor its
 * cache. `skip`: a folder not to take (where the export is being written, when it is inside).
 * @param {string} root @param {readonly ProjectPart[]} parts @param {string} [skip]
 * @returns {Promise<{ name: string, file: string, size: number }[]>}
 */
export async function projectFiles(root, parts, skip) {
  /** @type {{ name: string, file: string, size: number }[]} */
  const files = [];
  /** @type {Promise<Map<string, number>> | undefined} */
  let used;
  const walk = async (/** @type {string} */ dir, /** @type {string} */ rel) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (NOT_THE_PROJECT.has(entry.name) || (!rel && entry.name === TOOL_DIR) || path === skip) continue;
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory() && !entry.isSymbolicLink()) await walk(path, name);
      else if (info?.isDirectory()) {
        used ??= filmClosure(folderView(root));
        for (const [file, size] of [...await used].filter(([f]) => f.startsWith(`${name}/`)).sort(([a], [b]) => a.localeCompare(b))) {
          files.push({ name: file, file: join(root, ...file.split('/')), size });
        }
      } else if (info?.isFile()) files.push({ name, file: path, size: info.size });
    }
  };
  await walk(root, '');
  const style = join(root, TOOL_DIR, 'subtitles.json');
  if (existsSync(style)) files.push({ name: `${TOOL_DIR}/subtitles.json`, file: style, size: statSync(style).size });
  const settings = join(root, TOOL_DIR, 'settings.json');
  if (existsSync(settings)) files.push({ name: `${TOOL_DIR}/settings.json`, file: settings, size: statSync(settings).size });
  for (const part of parts) await walk(join(root, TOOL_DIR, part), `${TOOL_DIR}/${part}`);
  return files;
}

/**
 * How big the project at `root` is in its export: its work, and each part of `.film/` it has (null: none), in bytes.
 * @param {string} root @returns {Promise<{ work: number } & Record<ProjectPart, number | null>>}
 */
export async function projectSizes(root) {
  const sum = (/** @type {{ size: number }[]} */ files) => files.reduce((n, f) => n + f.size, 0);
  /** @type {{ work: number } & Record<ProjectPart, number | null>} */
  const sizes = { work: sum(await projectFiles(root, [])), history: null, chat: null, logs: null };
  for (const part of PROJECT_PARTS) {
    if (!existsSync(join(root, TOOL_DIR, part))) continue;
    sizes[part] = sum((await projectFiles(root, [part])).filter((f) => f.name.startsWith(`${TOOL_DIR}/${part}/`)));
  }
  return sizes;
}

/* ── doing it ───────────────────────────────────────────────────────────── */

/**
 * Below the person's own apps: an export's processes (its renderer, and through it its browsers and encoders, which
 * start below too; its ffmpeg runs) give way to what the person is doing, and take the computer whole when it is
 * idle. Studio started by `openfilm open` runs below already (main.mjs); the desktop app's does not.
 * @param {import('node:child_process').ChildProcess} proc
 */
const below = (proc) => { try { if (proc.pid) setPriority(proc.pid, 10); } catch { /* not allowed here: as it is */ } };

/**
 * ffmpeg, stopped when `signal` aborts. `input`: what it reads from its standard input.
 * @param {string[]} args @param {AbortSignal} signal @param {Buffer} [input]
 */
function run(args, signal, input) {
  if (signal.aborted) return Promise.reject(new Error('cancelled'));
  return new Promise((done, fail) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
    below(proc);
    let err = '';
    proc.stderr?.on('data', (d) => { err += d; });
    const kill = () => killProcess(proc);
    signal.addEventListener('abort', kill, { once: true });
    proc.on('error', (e) => { signal.removeEventListener('abort', kill); fail(new Error(`ffmpeg: ${/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? 'not found on the PATH' : e.message}`)); });
    proc.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) fail(new Error('cancelled'));
      else if (code === 0) done(undefined);
      else fail(new Error(`ffmpeg: ${err.trim() || `exit ${code}`}`));
    });
    /* ffmpeg that stops before reading all of it (cancelled, or failing as it starts) closes its end: the write's
       error is not one to throw (Studio would stop with it), its exit says what happened */
    proc.stdin?.on('error', () => {});
    if (input) proc.stdin?.end(input);
  });
}

/** The project's film.html, read. @param {string} root */
function filmDoc(root) {
  const file = join(root, FILM_FILE);
  if (!existsSync(file)) throw new ExportError(`one clip is exported from ${FILM_FILE}, and there is none`);
  const { doc, problems } = readFilmFile(readFileSync(file, 'utf8'));
  if (!doc) throw new ExportError(`${FILM_FILE} has problems: ${problems[0]}`);
  return doc;
}

/**
 * Where a clip's file is: in the project, never out of it (a film from elsewhere can name `../` sources, or bring a
 * link out of its folder, and the export would copy whatever is there). An address (`https:`) is left as it is.
 * @param {string} root @param {string} src
 */
function clipPath(root, src) {
  if (/^[a-z][a-z0-9+.-]+:/i.test(src)) return join(root, src);
  const file = inProject(root, src.replace(/^\/+/, ''));
  if (!file) throw new ExportError(`${src} is not a file inside the project`);
  return file;
}

/**
 * A film of the project's, made elsewhere in it (`dir`, inside its .film): `value`, its sources pointing back at the
 * project's files, written with the project's own head (its styles, fonts), whose addresses point back too.
 * @param {string} root @param {string} dir @param {import('./ops.mjs').FilmValue} value
 */
async function filmElsewhere(root, dir, value) {
  const up = relative(dir, root).split(sep).join('/');
  const back = (/** @type {string} */ path) => (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(path) ? path : `${up}/${path}`);
  const urls = (/** @type {string} */ css) => css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_, q, /** @type {string} */ path) => `url(${q}${back(path)}${q})`);
  const own = existsSync(join(root, FILM_FILE)) ? readFileSync(join(root, FILM_FILE), 'utf8') : '';
  /* the head's addresses: a stylesheet's href, and url() in its styles (and in a clip's own) */
  const head = urls(own.replace(/(<link\b[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/gi, (_, a, q, /** @type {string} */ path) => `${a}${q}${back(path)}${q}`));
  const moved = { ...value, tracks: value.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, src: back(c.src), ...(typeof c.style === 'string' ? { style: urls(c.style) } : {}) })) })) };
  await writeFile(join(dir, FILM_FILE), filmHtml(moved, head));
}

/**
 * The film with one clip only, from its start: a temporary edit inside the project's .film, whose sources point back
 * at the project's own files. `change`: fields of the clip to change (its `time`); `doc`: the edit to take it from
 * (film.html by default). `remove()` when done.
 * @param {string} root @param {string} clipId
 * @param {{ change?: Record<string, unknown>, doc?: import('../../src/film-doc.mjs').FilmDoc }} [options]
 */
async function clipFilm(root, clipId, { change = {}, doc = filmDoc(root) } = {}) {
  const track = doc.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  const clip = track?.clips.find((c) => c.id === clipId);
  if (!track || !clip) throw new ExportError(`${FILM_FILE} has no clip "${clipId}"`);
  const dir = join(root, '.film', 'cache', 'export', `clip-${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(dir, { recursive: true });
  await filmElsewhere(root, dir, { stage: doc.stage, tracks: [{ clips: [{ ...clip, ...change, at: 0 }], ...(track.muted ? { muted: true } : {}) }] });
  return { dir, stage: doc.stage, remove: () => tidy(dir) };
}


const H264_CRF = { standard: 23, high: 18, master: 14 };
const X265_CRF = { standard: 28, high: 23, master: 19 };
const VP9_CRF = { standard: 36, high: 30, master: 20 };
/** Bits per pixel per frame by quality, for encoders that take a bitrate (the same scale as the dialog's estimate). */
const BPP = { standard: 0.07, high: 0.11, master: 0.2 };
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const TO_709 = 'scale=out_color_matrix=bt709:out_range=tv';
/** The browser's frames as YUV in `format` for an encoder: BT.709 limited range (swscale's own default is BT.601), said on the frames. */
const YUV_709 = (/** @type {string} */ format) => `${TO_709},format=${format},${FRAMES_709}`;
/* BT.709 written into the stream once it is encoded, whatever encoder wrote it (never into HEVC with alpha: its alpha
   layer does not survive it) */
const H264_709 = ['-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'];
const HEVC_709 = ['-bsf:v', 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0'];

/**
 * The graphics chip's encoder to try for a codec, or null: H.264 and HEVC below master, as editors do (several times
 * faster, and the processor stays free for drawing the frames and for the person; master stays x264 and x265 at
 * their slowest and best), and ProRes at any quality (the Mac's ProRes engine is Apple's own encoder).
 * @param {VideoCodec} codec @param {Quality} quality
 */
const chipCodec = (codec, quality) => ((codec === 'h264' || codec === 'hevc') && quality !== 'master' ? codec
  : codec === 'prores422hq' || codec === 'prores4444' ? 'prores' : null);

/**
 * How render should encode a codec: its encoder (for the person's list), and the container format render takes,
 * through the graphics chip's encoder when it has one that works (`hw`: hardwareEncoder for chipCodec).
 * @param {VideoCodec} codec @param {Quality} quality @param {{ w: number, h: number }} size @param {number} fps @param {Set<string>} have @param {string | null} [hw]
 */
function encoding(codec, quality, size, fps, have, hw = null) {
  const bits = (/** @type {number} */ k) => Math.min(120e6, Math.max(2e6, size.w * size.h * fps * BPP[quality] * k));
  const bitrate = (/** @type {number} */ k) => `${Math.round(bits(k) / 1000)}k`;
  /* a key frame every two seconds */
  const gop = Math.round(fps * 2);
  switch (codec) {
    case 'h264':
      /* with room for screen text: half again the dialog's scale */
      if (hw) return { encoder: hw, format: { video: [...hardwareOptions(hw, bits(1.5), { gop }), ...BT709] } };
      return { encoder: 'libx264', format: { video: ['-c:v', 'libx264', '-preset', quality === 'master' ? 'slow' : 'medium', '-crf', String(H264_CRF[quality]), ...BT709] } };
    case 'hevc':
      if (hw) return { encoder: hw, format: { video: [...hardwareOptions(hw, bits(0.8), { gop }), ...BT709], tag: ['-tag:v', 'hvc1', ...HEVC_709] } };
      if (have.has('libx265')) {
        return { encoder: 'libx265', format: { video: ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(X265_CRF[quality]), '-x265-params', 'log-level=error', '-tag:v', 'hvc1', ...BT709], tag: ['-tag:v', 'hvc1', ...HEVC_709] } };
      }
      if (have.has('hevc_videotoolbox')) return { encoder: 'hevc_videotoolbox', format: { video: ['-c:v', 'hevc_videotoolbox', '-b:v', bitrate(0.8), '-g', String(gop), '-tag:v', 'hvc1', ...BT709], tag: ['-tag:v', 'hvc1', ...HEVC_709] } };
      throw new ExportError('this computer\'s ffmpeg has no HEVC encoder (libx265 or hevc_videotoolbox)');
    case 'vp9':
      return { encoder: 'libvpx-vp9', format: { video: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(VP9_CRF[quality]), '-row-mt', '1', ...BT709] } };
    case 'prores422hq':
    case 'prores4444': {
      const encoder = hw ?? 'prores_ks';
      return { encoder, format: prores709(encoder, codec === 'prores4444') };
    }
    case 'hevc_alpha':
      if (!have.has('hevc_videotoolbox')) throw new ExportError('HEVC with alpha needs macOS\'s hevc_videotoolbox encoder');
      return { encoder: 'hevc_videotoolbox', format: { video: ['-c:v', 'hevc_videotoolbox', '-alpha_quality', '0.75', '-b:v', bitrate(0.8), '-tag:v', 'hvc1'], pix: `format=bgra,${FRAMES_709}`, tag: ['-tag:v', 'hvc1'] } };
    case 'png':
      return { encoder: 'png', format: { video: ['-c:v', 'png'], pix: 'format=rgba' } };
  }
}

/**
 * Whether a video with an alpha channel lets anything through: a few frames' alpha, sampled. Null when it can't be
 * read here.
 * @param {string} file @param {boolean} vp9
 */
function alphaOf(file, vp9) {
  return new Promise((done) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...(vp9 ? ['-c:v', 'libvpx-vp9'] : []), '-i', file,
      '-vf', 'fps=4,alphaextract,scale=48:-2,format=gray', '-frames:v', '12', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    /** @type {Buffer[]} */
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', () => done(null));
    proc.on('close', (code) => {
      const bytes = Buffer.concat(chunks);
      done(code === 0 && bytes.length ? { any: bytes.some((b) => b < 250) } : null);
    });
  });
}

/** The stems a film's sound is split into, in this order (nle.mjs soundStem says which a sound is in). */
const STEMS = /** @type {import('./nle.mjs').SoundRole[]} */ (['voice', 'music', 'sfx', 'footage']);

/** How many frames a video file has (its packets, counted). 0 when it can't be read. @param {string} file */
function countFrames(file) {
  return new Promise((done) => {
    execFile('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { windowsHide: true },
      (error, stdout) => done(error ? 0 : parseInt(String(stdout).trim(), 10) || 0));
  });
}

/** atempo stages for a speed (each takes 0.5 to 2; the pitch is kept). @param {number} speed */
function tempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  out.push(`atempo=${Number(s.toFixed(6))}`);
  return out.join(',');
}

/**
 * A source an editor can't read, made into one it can: video → ProRes 422 HQ, or with its alpha the export's alpha
 * codec (PNG, ProRes 4444 or HEVC with alpha); sound → 48 kHz WAV (`segment`: only those source seconds, at that
 * speed, exactly `seconds` long). `video`: the picture's size and rate, which HEVC's bitrate follows.
 * @param {Extract<import('./nle.mjs').NleMediaJob, { kind: 'transcode' }>} make @param {string} out @param {AbortSignal} signal
 * @param {{ w: number, h: number, fps?: number }} [video]
 */
async function transcode(make, out, signal, video) {
  if (make.to === 'wav') {
    const seg = make.segment;
    /* the part is cut from the source before its speed changes, as the film's mix cuts it (after the -i, -ss and -t
       would count the seconds coming out, slowed or sped); then padded with silence or trimmed to its clip's length,
       so the file ends where its clip does */
    await run([...(seg ? ['-ss', String(seg.from), '-t', String(seg.to - seg.from)] : []), '-vn', '-i', make.from,
      ...(seg ? ['-af', `asetpts=PTS-STARTPTS,${tempo(seg.speed)},apad=whole_dur=${seg.seconds},atrim=0:${seg.seconds}`] : []),
      '-c:a', 'pcm_s16le', '-ar', '48000', out], signal);
    return;
  }
  const alpha = make.to !== 'prores422hq';
  const prores = make.to === 'prores422hq' || make.to === 'prores4444';
  const have = await encoders();
  /* decoded on the graphics chip and, ProRes, written by the Mac's ProRes engine when it can, else by ffmpeg's own encoder */
  const chip = prores ? await hardwareEncoder('prores', have) : null;
  await onTheChip(chip, async (encoder, decoding) => {
    const own = prores ? null : encoding('png', 'master', video ?? { w: 1920, h: 1080 }, video?.fps ?? 30, have).format;
    const { video: codec, pix } = own ? { video: own.video, pix: /** @type {{ pix: string }} */ (own).pix } : proresOptions(encoder ?? 'prores_ks', alpha);
    const tail = ['-map', '0:v:0', '-map', '0:a?', '-vf', pix, ...codec, '-c:a', 'pcm_s16le', '-ar', '48000', out];
    /* VP9's alpha is a side channel ffmpeg's own decoder drops: libvpx reads it */
    if (alpha) {
      try { await run(['-c:v', 'libvpx-vp9', '-i', make.from, ...tail], signal); return; } catch (e) { if (signal.aborted) throw e; }
    }
    await run([...decoding, '-i', make.from, ...tail], signal);
  }, signal);
}

const execFileP = promisify(execFile);

/**
 * How a draft's page with alpha is drawn before its pictures are thinned (keepChanges writes them at ffmpeg's own PNG
 * settings): PNG at zlib's fastest with each pixel kept as its difference from the one on its left. The same pixels for
 * an eighth of the processor: ffmpeg's own PNG settings take about 0.4 s of processor time per 1080p frame, more than
 * drawing it.
 */
const QUICK_PNG = { video: ['-c:v', 'png', '-compression_level', '1', '-pred', 'sub'], pix: 'format=rgba' };

/**
 * A PNG video with each picture kept once: a frame that repeats the one before is dropped and the one before lasts
 * until the next (the timestamps say so), so a page that holds still is one picture, not a second's worth. A repeat is
 * found by its bytes: one encoder at one setting writes the same picture the same way, so a frame a pixel apart is
 * never taken for one; the frames kept are written again as PNG at ffmpeg's own settings, the same pixels. The last
 * frame stays, so the length does too; a video that changes in most of its frames keeps every frame, written again the
 * same way (it may have been drawn as a quick PNG).
 * @param {string} file @param {AbortSignal} signal
 */
export async function keepChanges(file, signal) {
  const { stdout } = await execFileP('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framemd5', '-'],
    { maxBuffer: 256 << 20, signal, windowsHide: true });
  const sums = String(stdout).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()?.trim());
  const kept = sums.flatMap((sum, i) => (i === 0 || i === sums.length - 1 || sum !== sums[i - 1] ? [i] : []));
  /* frames kept one after another are one term; the terms are added as a balanced tree, since ffmpeg parses no more
     than 100 in a row */
  /** @type {[number, number][]} */
  const runs = [];
  for (const i of kept) { const last = runs.at(-1); if (last && last[1] === i - 1) last[1] = i; else runs.push([i, i]); }
  /** @type {(part: [number, number][]) => string} */
  const sum = (part) => (part.length === 1 ? (part[0][0] === part[0][1] ? `eq(n,${part[0][0]})` : `between(n,${part[0][0]},${part[0][1]})`)
    : `(${sum(part.slice(0, part.length >> 1))}+${sum(part.slice(part.length >> 1))})`);
  const part = `${file}.part.mov`;
  const all = kept.length > sums.length / 2;
  const graph = all ? '' : `[0:v:0]select='${sum(runs)}'[v]`;
  /* a long one goes in a file: Windows takes a command of no more than 32,767 characters, and a long page that steps
     every few frames keeps thousands of runs */
  const script = graph.length > COMMAND_ROOM ? `${part}.filter` : null;
  if (script) await writeFile(script, graph, 'utf8');
  try {
    const select = all ? ['-map', '0:v:0'] : [...(script ? [await filterScriptOption(), script] : ['-filter_complex', graph]), '-map', '[v]', '-fps_mode', 'vfr'];
    await run(['-i', file, ...select, '-c:v', 'png', part], signal);
  } finally {
    if (script) await tidy(script);
  }
  await renameSafely(part, file);
}

const IMAGE_TYPES = /** @type {Record<string, string>} */ ({ svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp' });

/**
 * A picture an editor can't read (SVG, WebP, AVIF, GIF) drawn by Chromium to a PNG of `w` × `h`, transparent where it is.
 * @param {import('playwright-core').Browser} browser @param {string} file @param {number} w @param {number} h @param {string} out
 */
async function rasterize(browser, file, w, h, out) {
  const type = IMAGE_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/png';
  const page = await browser.newPage({ viewport: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) } });
  try {
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${w}px;height:${h}px}</style><img src="data:${type};base64,${(await readFile(file)).toString('base64')}">`);
    /* decoded, then two frames: a picture on screen to capture. Captured before its first frame, a page has none and
       Chromium fails ("Unable to capture screenshot"): a browser just started, on a busy machine, is slow to make it */
    await page.evaluate(async () => {
      await document.images[0]?.decode().catch(() => {});
      await /** @type {Promise<void>} */ (new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    });
    await writeFile(out, await page.screenshot({ type: 'png', omitBackground: true }));
  } finally {
    await page.close();
  }
}

/**
 * Whether a folder takes a new folder: one is made in it and removed. False when it refuses (EPERM, EACCES on
 * Windows when security software or the folder's permissions say no) or is not there.
 * @param {string} dir
 */
export async function writableFolder(dir) {
  try {
    await rmdir(await mkdtemp(join(dir, '.openfilm-')));
    return true;
  } catch {
    return false;
  }
}

/** How long Studio's close waits for a stopped export to clean up after itself (the app waits ten seconds for Studio). */
const STOP_WAIT_MS = 8000;

/**
 * The export queue. `onChange(job)` is told every change of a job (its progress included), for the pages watching.
 * `captions(root)`: a film's subtitle cues and the person's style for them (captions.mjs by default).
 * `drafts(app)`: 剪映's or CapCut's drafts folder, where its draft goes (null: the exports folder); this computer's by default.
 * @param {{ onChange?: (job: ExportJob) => void, captions?: (root: string) => Promise<{ cues: Cue[], style: SubtitleStyle }>,
 *   drafts?: (app: 'jianying' | 'capcut') => string | null }} [options]
 */
export function createExports({ onChange = () => {}, captions = subtitlesForExport, drafts = defaultDrafts } = {}) {
  /** @type {ExportJob[]} */
  const jobs = [];
  /** @type {Map<string, { root: string, folder: string, abort: AbortController, twin?: string }>} */
  const work = new Map();
  let running = false;
  /* Studio is closing: nothing new starts (stopAll) */
  let closing = false;
  /** settles when no export is running */
  let idle = Promise.resolve();

  const update = (/** @type {ExportJob} */ job, /** @type {Partial<ExportJob>} */ change) => { Object.assign(job, change); onChange({ ...job, outputs: [...job.outputs] }); };

  /** The cues as the person's style shows them (the language picked, or both), and the style. @param {string} root */
  const subtitlesOf = async (root) => {
    const { cues, style } = await captions(root);
    return { cues: filmSubtitleShown(cues, style).filter((c) => c.durMs > 0 && c.text.trim()), style };
  };
  /** The film with its subtitles burned in, or null (burn.mjs). @param {string} root @param {Framing} ask @param {boolean} [transparent] */
  const burnedOf = (root, ask, transparent = false) => burned(root, ask, captions, transparent);

  /**
   * render's frame count as the job's progress, its rate and what is left: `share` is the part of the whole job the
   * frames are (an encode or a zip after them takes the rest).
   * @param {ExportJob} job @param {number} share
   */
  const frames = (job, share = 0.96) => {
    let first = 0;
    let told = 0;
    return (/** @type {number} */ done, /** @type {number} */ total) => {
      const now = Date.now();
      if (done === 1) first = now;
      const rate = done > 1 ? (done - 1) / Math.max(0.001, (now - first) / 1000) : 0;
      if (now - told < 200 && done < total) return;
      told = now;
      update(job, {
        phase: done >= total ? 'finishing' : 'rendering',
        framesDone: done, framesTotal: total, rate,
        etaMs: rate > 0 ? Math.round(((total - done) / rate) * 1000) : null,
        progress: Math.floor((done / total) * share * 100) / 100,
      });
    };
  };

  /** Render the film (or `target`) to `out`, with progress. @param {ExportJob} job @param {string} target @param {string} out @param {Record<string, unknown>} opts @param {AbortSignal} signal */
  const renderTo = (job, target, out, opts, signal, share = 0.96) => {
    const range = job.ask.range ? [`${num(job.ask.range[0])}-${num(job.ask.range[1])}`] : [];
    return render([target, ...range], { ...opts, ...(job.ask.ranges ? { ranges: job.ask.ranges } : {}), out, signal, onProgress: frames(job, share) });
  };

  /** @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal */
  async function exportVideo(job, root, dir, signal) {
    const ask = /** @type {VideoAsk & { range?: [number, number], ranges?: [number, number][] }} */ (job.ask);
    const codec = ask.codec ?? 'h264';
    const alpha = ALPHA_CODECS.has(codec);
    const clip = ask.clip ? await clipFilm(root, ask.clip) : null;
    const burn = clip ? null : await burnedOf(root, ask, alpha);
    const scratch = codec === 'png' || codec === 'hevc_alpha' ? await mkdtemp(join(tmpdir(), 'openfilm-export-')) : null;
    try {
      const stage = clip?.stage ?? await stageOf(root);
      let size, place;
      if (burn) {
        /* the frame is the page: drawn at the size asked, nothing around it */
        size = dimsForShortEdge(burn.box, ask.shortEdge ?? Math.min(burn.box.w, burn.box.h));
        place = { scale: size.w / burn.box.w, vf: `scale=${size.w}:${size.h}:flags=lanczos` };
      } else if (clip) {
        const k = ask.scale ?? 1;
        size = { w: even(stage.w * k), h: even(stage.h * k) };
        place = { scale: k, vf: `scale=${size.w}:${size.h}:flags=lanczos` };
      } else {
        const box = frameBox(stage, ask.frame ?? 'native', ask.fill ?? 'contain');
        size = dimsForShortEdge(box, ask.shortEdge ?? Math.min(box.w, box.h));
        place = framing(stage, ask.frame ?? 'native', ask.fill ?? 'contain', size, alpha);
      }
      /* no fps asked: render's own (30) */
      const fps = ask.fps;
      const quality = ask.quality ?? 'high';
      const have = await encoders();
      const chipFor = chipCodec(codec, quality);
      const hw = ask.hardware !== false && chipFor ? await hardwareEncoder(chipFor, have) : null;
      /** @param {string | null} chip */
      const how = (chip) => {
        const { encoder, format } = encoding(codec, quality, size, fps ?? 30, have, chip);
        const container = /** @type {{ pix?: string }} */ (format).pix ?? (codec === 'h264' || codec === 'hevc' ? YUV_709('yuv420p') : codec === 'vp9' ? YUV_709('yuva420p') : 'format=yuva444p10le');
        return { encoder, opts: { fps, scale: place.scale, alpha, silent: ask.audio === false || codec === 'png', format: { ...format, pix: `${place.vf},${container}` }, ...(clip || burn ? { root } : {}) } };
      };
      let { encoder, opts } = how(hw);
      update(job, { encoder });
      const target = clip ? clip.dir : burn ? burn.dir : root;
      const out = freeFile(dir, baseName(job.name, ask), CODEC_EXT[codec]);
      if (codec !== 'png') {
        const part = partialOf(out, job.id);
        /** @type {[number, number][] | null} The ranges actually drawn, at the output's rate and within the film. */
        let selectedRanges = null;
        update(job, { out: part, outputs: [part] });
        try {
          if (codec === 'hevc_alpha') {
            /* HEVC with alpha is encoded once, straight into its file: ffmpeg copying it (as render does, joining its
               parts and adding the sound) drops its alpha layer's parameter sets, and no Apple app opens it then. Drawn
               first as a quick PNG with its sound (the same frames, as many browsers as any render), then encoded */
            const frames = join(/** @type {string} */ (scratch), 'frames.mov');
            const rendered = await renderTo(job, target, frames, { ...opts, format: { ...QUICK_PNG, pix: `${place.vf},format=rgba` } }, signal, 0.85);
            selectedRanges = rendered.ranges ?? null;
            update(job, { phase: 'encoding', progress: 0.86, rate: 0, etaMs: null });
            const { format } = encoding(codec, quality, size, fps ?? 30, have);
            await run(['-i', frames, '-map', '0:v:0', '-map', '0:a?', '-vf', /** @type {{ pix: string }} */ (format).pix, ...format.video, '-c:a', 'copy', part], signal);
          } else {
            const rendered = await renderTo(job, target, part, opts, signal);
            selectedRanges = rendered.ranges ?? null;
          }
        } catch (e) {
          /* the graphics chip's encoder gave up partway (a driver, a size it does not take, sessions or memory it ran out
             of): the rest of this launch encodes without it, starting with this export again */
          if (!hw || signal.aborted || !/^ffmpeg[: ]/.test(e instanceof Error ? e.message : '')) throw e;
          broken(hw);
          ({ encoder, opts } = how(null));
          update(job, { encoder, framesDone: 0, progress: 0, etaMs: null });
          const rendered = await renderTo(job, target, part, opts, signal);
          selectedRanges = rendered.ranges ?? null;
        }
        await renameSafely(part, out);
        update(job, { out, outputs: [out] });
        if (alpha) update(job, { alpha: await alphaOf(out, codec === 'vp9') });
        /* the subtitles as a file beside it, timed to the part exported */
        if (ask.sidecar) {
          const { cues } = await subtitlesOf(root);
          const selected = selectedRanges?.map(([from, to]) => /** @type {[number, number]} */ ([from * 1000, to * 1000]));
          const part = selected ? filmSubtitleCuesInRanges(cues, selected) : ask.range ? filmSubtitleCuesInRange(cues, ask.range[0] * 1000, ask.range[1] * 1000) : cues;
          const text = ask.sidecar === 'vtt' ? filmSubtitleVtt(part) : filmSubtitleSrt(part);
          if (text) {
            const file = `${out.slice(0, -CODEC_EXT[codec].length)}.${ask.sidecar}`;
            await writeFile(file, text, 'utf8');
            update(job, { outputs: [out, file] });
          }
        }
        return;
      }
      /* a PNG sequence: frames rendered losslessly into a .mov of PNGs, taken out as files, zipped */
      const scratchDir = /** @type {string} */ (scratch);
      const movie = join(scratchDir, 'frames.mov');
      await renderTo(job, target, movie, opts, signal, 0.8);
      const part = partialOf(out, job.id);
      update(job, { phase: 'encoding', progress: 0.82, out: part, outputs: [part] });
      const stem = baseName(job.name, ask);
      await mkdir(join(scratchDir, 'png'));
      await run(['-i', movie, '-c:v', 'copy', '-f', 'image2', '-start_number', '0', join(scratchDir, 'png', '%06d.png')], signal);
      const names = (await readdir(join(scratchDir, 'png'))).sort();
      update(job, { phase: 'finishing', progress: 0.9 });
      await zipFiles(part, names.map((n) => ({ name: `${stem}_${n}`, file: join(scratchDir, 'png', n) })), signal);
      await renameSafely(part, out);
      update(job, { out, outputs: [out] });
    } finally {
      await clip?.remove();
      await burn?.remove();
      if (scratch) await tidy(scratch);
    }
  }

  /** @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal */
  async function exportGif(job, root, dir, signal) {
    const ask = /** @type {GifAsk} */ (job.ask);
    const scratch = await mkdtemp(join(tmpdir(), 'openfilm-export-'));
    const burn = await burnedOf(root, ask);
    try {
      /* with subtitles, the frame is the page drawn */
      const stage = burn ? burn.box : await stageOf(root);
      const frame = burn ? 'native' : ask.frame ?? 'native', fill = ask.fill ?? 'contain';
      const size = gifDims(frameBox(stage, frame, fill), ask.width ?? 640);
      const place = framing(stage, frame, fill, size, false);
      const fps = ask.fps ?? 15;
      const movie = join(scratch, 'gif.mp4');
      update(job, { encoder: 'gif' });
      /* near-lossless picture to make the palette from */
      await renderTo(job, burn ? burn.dir : root, movie, { fps, scale: place.scale, silent: true, ...(burn ? { root } : {}),
        format: { video: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '8', ...BT709], pix: `${place.vf},${TO_709},format=yuv420p` } }, signal, 0.8);
      const out = freeFile(dir, baseName(job.name, ask), '.gif');
      const part = partialOf(out, job.id);
      update(job, { phase: 'encoding', progress: 0.85, out: part, outputs: [part] });
      await run(['-i', movie, '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', '-loop', '0', part], signal);
      await renameSafely(part, out);
      update(job, { out, outputs: [out] });
    } finally {
      await burn?.remove();
      await tidy(scratch);
    }
  }

  /** @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal */
  async function exportSound(job, root, dir, signal) {
    const ask = /** @type {AudioAsk & { range?: [number, number], ranges?: [number, number][] }} */ (job.ask);
    const format = ask.format ?? 'wav';
    const codec = SOUND_CODECS[format];
    if (format === 'mp3' && !(await encoders()).has('libmp3lame')) throw new ExportError('this computer\'s ffmpeg has no MP3 encoder (libmp3lame)');
    update(job, { phase: 'audio', encoder: codec[1] });
    const probe = await open(root);
    try {
      const meta = probe.film.meta;
      /* a page without a duration has no end (and no sound: a page has none) */
      const length = meta.duration ?? Infinity;
      const selected = ask.ranges?.map(([from, to]) => ({ from, to: Math.min(to, length) }));
      if (selected?.some((part) => part.to <= part.from)) throw new ExportError('a selected range is outside the film');
      const [from, to] = selected ? [0, selected.reduce((n, part) => n + part.to - part.from, 0)] : ask.range ? [ask.range[0], Math.min(ask.range[1], length)] : [0, length];
      const allClips = await filmSound(probe, selected ? 0 : from);
      const clips = selected ? selectionClips(allClips, selected) : allClips;
      if (!clips.length) throw new ExportError('this film has no sound');
      /** @type {{ suffix: string, clips: typeof clips }[]} */
      const plan = [];
      /* named for what each is: the whole mix, or one stem of it */
      if (ask.mix !== false) plan.push({ suffix: ' - mix', clips });
      if (ask.stems) {
        for (const role of STEMS) {
          const part = clips.filter((c) => soundStem(relative(root, c.file).split(sep).join('/')) === role);
          if (part.length) plan.push({ suffix: ` - ${role}`, clips: part });
        }
      }
      const base = baseName(job.name, ask);
      /** @type {string[]} */
      const outputs = [];
      for (const [i, step] of plan.entries()) {
        if (signal.aborted) throw new Error('cancelled');
        const out = freeFile(dir, `${base}${step.suffix}`, `.${format}`);
        const part = partialOf(out, job.id);
        outputs.push(part);
        update(job, { out: outputs[0], outputs: [...outputs], progress: Math.floor((i / plan.length) * 100) / 100 });
        await mix(step.clips, to - from, part, codec);
        await renameSafely(part, out);
        outputs[i] = out;
        update(job, { out: outputs[0], outputs: [...outputs] });
      }
    } finally {
      await probe.close();
    }
  }

  /**
   * Frames of the film drawn at the size asked, as files in `scratch`: one moment (a poster), the seconds `at`, or the
   * middle of each picture clip (clips starting together give one), each named after its clip.
   * @param {ExportJob} job @param {string} root @param {StillsAsk | PosterAsk | SlidesAsk} ask @param {'.png' | '.jpg'} ext
   * @param {string} scratch @param {AbortSignal} signal
   */
  async function stillFrames(job, root, ask, ext, scratch, signal) {
    const burn = await burnedOf(root, ask);
    /* footage the browser does not decode (ProRes; HEVC without a chip for it) drawn through a copy it plays: the film's
       video clips, the project's when the film is drawn inside a frame with its subtitles */
    const probe = await open(burn ? burn.dir : root, burn ? { root, playable: filmVideos(root, FILM_FILE) } : { playable: true }).catch(async (e) => { await burn?.remove(); throw e; });
    try {
      const meta = probe.film.meta;
      /* with subtitles, the frame is the page drawn */
      const stage = burn ? burn.box : { w: meta.width, h: meta.height };
      const frame = burn ? 'native' : ask.frame ?? 'native', fill = ask.fill ?? 'contain';
      const box = frameBox(stage, frame, fill);
      const size = dimsForShortEdge(box, ask.shortEdge ?? Math.min(box.w, box.h));
      const place = framing(stage, frame, fill, size, false);
      /* a page without a duration has no end, and no middle to take a frame from: only the moments asked for */
      const picked = ask.kind === 'poster' ? ask.at != null : Boolean(ask.at?.length);
      if (meta.duration == null && !picked) throw new ExportError('this page has no duration, so it has no middle or end: say which moments to export');
      const length = meta.duration ?? Infinity;
      const end = Math.max(0, length - 1e-3);
      /* the film's scenes: a still or a slide is named by the one it is in (a page's speaker notes) */
      const cuts = ask.kind === 'poster' ? []
        : [.../** @type {{ id: string, at: number, end: number }[] | null} */ (await probe.film.page.evaluate(() => /** @type {any} */ (window).__filmCuts?.() ?? null)) ?? []]
          .sort((a, b) => a.at - b.at);
      /** the scene showing at `t`: of those that do, the one that started last */
      const sceneAt = (/** @type {number} */ t) => cuts.findLast((c) => c.at <= t && t < c.end)?.id ?? '';
      /** @type {{ t: number, label: string }[]} */
      let moments;
      if (ask.kind === 'poster') moments = [{ t: Math.min(end, ask.at ?? length / 2), label: '' }];
      else if (ask.at?.length) moments = ask.at.map((t) => ({ t: Math.min(end, t), label: sceneAt(Math.min(end, t)) }));
      else {
        moments = [];
        let lastAt = -Infinity;
        for (const c of cuts) {
          if (!(c.end > c.at) || c.at >= length || c.at - lastAt < 0.4) continue;
          lastAt = c.at;
          moments.push({ t: Math.min(end, (c.at + Math.min(c.end, length)) / 2), label: c.id });
        }
        if (!moments.length) moments = [{ t: length / 2, label: '' }];
        moments = moments.slice(0, 120);
      }
      update(job, { phase: 'rendering', framesTotal: moments.length });
      const film = await FilmPage.open(probe.browser, probe.site.url, probe.entry, { scale: place.scale });
      /** @type {{ name: string, file: string, label: string }[]} */
      const files = [];
      try {
        for (const [i, m] of moments.entries()) {
          if (signal.aborted) throw new Error('cancelled');
          await film.seek(m.t);
          const png = await film.capture({ format: 'png' });
          const name = `${String(i + 1).padStart(2, '0')}${m.label ? ` ${safeName(m.label)}` : ''}${ext}`;
          const file = join(scratch, name);
          await run(['-f', 'png_pipe', '-i', '-', '-vf', place.vf, '-frames:v', '1', ...(ext === '.jpg' ? ['-q:v', '2'] : []), file], signal, png);
          files.push({ name, file, label: m.label });
          update(job, { framesDone: i + 1, progress: Math.floor(((i + 1) / moments.length) * 0.9 * 100) / 100 });
        }
      } finally {
        await film.close();
      }
      return { files, size };
    } finally {
      await probe.close();
      await burn?.remove();
    }
  }

  /** A poster or scene stills. @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal */
  async function exportStills(job, root, dir, signal) {
    const ask = /** @type {StillsAsk | PosterAsk} */ (job.ask);
    const ext = ask.format === 'jpg' ? '.jpg' : '.png';
    const scratch = await mkdtemp(join(tmpdir(), 'openfilm-export-'));
    update(job, { encoder: ext === '.jpg' ? 'mjpeg' : 'png' });
    try {
      const { files } = await stillFrames(job, root, ask, ext, scratch, signal);
      update(job, { phase: 'finishing' });
      const base = baseName(job.name, ask);
      const archive = ask.kind === 'stills' && (ask.as === 'zip' || (ask.as !== 'files' && files.length > 1));
      if (archive) {
        const out = freeFile(dir, base, '.zip');
        const part = partialOf(out, job.id);
        update(job, { out: part, outputs: [part] });
        await zipFiles(part, files, signal);
        await renameSafely(part, out);
        update(job, { out, outputs: [out] });
      } else {
        /** @type {string[]} */
        const outputs = [];
        for (const file of files) {
          if (signal.aborted) throw new Error('cancelled');
          const out = freeFile(dir, ask.kind === 'stills' ? `${base} ${file.name.replace(/\.\w+$/, '')}` : base, ext);
          const part = partialOf(out, job.id);
          outputs.push(part);
          update(job, { out: outputs[0], outputs: [...outputs] });
          await copyFile(file.file, part, fsConstants.COPYFILE_FICLONE);
          await renameSafely(part, out);
          outputs[outputs.length - 1] = out;
          update(job, { out: outputs[0], outputs: [...outputs] });
        }
      }
    } finally {
      await tidy(scratch);
    }
  }

  /** Slides: the scene stills as a PowerPoint deck or a PDF. @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal */
  async function exportSlides(job, root, dir, signal) {
    const ask = /** @type {SlidesAsk} */ (job.ask);
    const pdf = ask.format === 'pdf';
    const scratch = await mkdtemp(join(tmpdir(), 'openfilm-export-'));
    update(job, { encoder: pdf ? 'pdf' : 'pptx' });
    try {
      const { files, size } = await stillFrames(job, root, { ...ask, shortEdge: ask.shortEdge ?? 1080 }, '.jpg', scratch, signal);
      if (signal.aborted) throw new Error('cancelled');
      update(job, { phase: 'encoding', progress: 0.92 });
      const pages = await Promise.all(files.map(async (f) => ({ jpeg: await readFile(f.file), w: size.w, h: size.h, label: f.label })));
      const out = freeFile(dir, baseName(job.name, ask), pdf ? '.pdf' : '.pptx');
      const part = partialOf(out, job.id);
      update(job, { out: part, outputs: [part] });
      if (pdf) await writeFile(part, await slidesPdf(pages));
      else await writePptx(part, pages, job.name, signal);
      await renameSafely(part, out);
      update(job, { out, outputs: [out] });
    } finally {
      await tidy(scratch);
    }
  }

  /** The film's subtitles as a file. @param {ExportJob} job @param {string} root @param {string} dir */
  async function exportSubtitles(job, root, dir) {
    const ask = /** @type {SubtitlesAsk & { range?: [number, number], ranges?: [number, number][] }} */ (job.ask);
    const { cues: all } = await subtitlesOf(root);
    const cues = ask.ranges ? filmSubtitleCuesInRanges(all, ask.ranges.map(([from, to]) => [from * 1000, to * 1000])) : ask.range ? filmSubtitleCuesInRange(all, ask.range[0] * 1000, ask.range[1] * 1000) : all;
    const format = ask.format ?? 'srt';
    const text = format === 'vtt' ? filmSubtitleVtt(cues) : format === 'txt' ? filmSubtitleTranscript(cues) : filmSubtitleSrt(cues);
    if (!text) throw new ExportError('this film has no subtitles');
    update(job, { encoder: format });
    const out = freeFile(dir, baseName(job.name, ask), `.${format}`);
    update(job, { out, outputs: [out] });
    await writeFile(out, text, 'utf8');
  }

  /**
   * The timeline for an editing program: a folder with the XML, the media it points at, and the subtitles as SRT
   * (see nle.mjs), or a 剪映 or CapCut draft (jianying.mjs) in the app's drafts folder. Made in a hidden folder beside it and moved
   * into place when whole.
   * @param {ExportJob} job @param {string} root @param {string} out @param {AbortSignal} signal
   */
  async function exportNle(job, root, out, signal) {
    const ask = /** @type {NleAsk} */ (job.ask);
    const fcp = ask.format === 'fcpxml';
    const app = ask.format === 'jianying' || ask.format === 'capcut' ? ask.format : null;
    /* a draft goes where its app lists its drafts, when the app is on this computer; a drafts folder that refuses the
       write (security software, or the app's own permissions on it) leaves the draft in the exports folder, said so */
    const draftsDir = app ? drafts(app) : null;
    const dir = draftsDir && await writableFolder(draftsDir) ? draftsDir : out;
    if (draftsDir && dir !== draftsDir) update(job, { draftsRefused: draftsDir });
    if (dir !== out) await sweep(dir, LEFT.output);
    const fps = nleFps(ask.fps ?? 30);
    const mode = ask.audio ?? 'clips';
    const title = safeName(job.name);
    /* how the pages are written: for a draft, `auto` (each page's alpha read in every frame as it is drawn, as Studio
       shows it: an opaque page as H.264, one with any clear pixel as lossless PNG), all `png`, or `prores` (422 HQ and
       4444 the same way); ProRes 4444 or PNG for the other editors */
    const alpha = ask.alpha ?? (app ? 'auto' : 'prores4444');
    const prores = alpha === 'prores' || alpha === 'prores4444';
    const have = await encoders();
    /** how a page with alpha is drawn: PNG (a draft's a quick one, its pictures thinned after; PNG's alpha is exact,
        ProRes's comes back a little off full), or (null) ProRes 4444, whose encoder render picks */
    const pngFormat = app ? QUICK_PNG : alpha === 'png' ? encoding('png', 'master', { w: 0, h: 0 }, fps, have).format : null;
    /* the edit with every track shown: a hidden track comes over disabled, one click from back on, so it is drawn too */
    const doc = existsSync(join(root, FILM_FILE)) ? filmDoc(root)
      : { stage: await stageOf(root), tracks: [{ clips: [{ src: 'index.html', id: title }] }] };
    update(job, { encoder: prores && !app ? (await hardwareEncoder('prores', have)) ?? 'prores_ks' : 'png' });
    /* a source out of the project fails the export before anything is drawn */
    for (const track of doc.tracks) for (const row of track.clips) clipPath(root, row.src);
    const { cues, style: shown } = ask.subtitles === false ? { cues: [], style: null } : await subtitlesOf(root).catch((error) => {
      if (fcp) throw error;
      return { cues: [], style: null };
    });
    const scratch = join(root, '.film', 'cache', 'export', `nle-${process.pid}-${randomBytes(4).toString('hex')}`);
    const final = freeFile(dir, baseName(job.name, ask), '');
    const staging = join(dir, `.${basename(final)}.partial-${process.pid}-${job.id}`);
    try {
      await mkdir(scratch, { recursive: true });
      await filmElsewhere(root, scratch, { stage: doc.stage, tracks: doc.tracks.map((t) => ({ clips: t.clips })) });
      const probe = await open(scratch, { root });
      /** @type {{ id: string, at: number, end: number, from: number, to: number, speed: number, native: number | null, w: number | null, h: number | null }[]} */
      let loaded;
      try {
        loaded = await probe.film.page.evaluate(() => /** @type {any} */ (window).__filmEditor.stage.clips().map((/** @type {any} */ c) => ({
          id: c.id, at: c.at, end: c.end, from: c.span.from, to: c.span.to, speed: c.span.speed,
          native: Number.isFinite(c.native) ? c.native : null, w: c.nw ?? null, h: c.nh ?? null,
        })));
      } finally {
        await probe.close();
      }
      if (signal.aborted) throw new Error('cancelled');
      const byId = new Map(loaded.map((c) => [c.id, c]));

      const rows = ask.format === 'fcpxml' ? doc.tracks.flatMap((track) => {
        const blocks = track.clips.flatMap((clip) => {
          const c = byId.get(clip.id);
          return c ? [{ id: clip.id, startMs: Math.round(c.at * 1000), endMs: Math.round(c.end * 1000) }] : [];
        });
        const layers = layerBlocks(blocks);
        return (layers.length ? layers : [[]]).map((clips) => ({ kind: trackKind(track), clips }));
      }) : [];
      const badges = rowBadges(rows.map((row) => row.kind));
      const sourceRows = new Map(rows.flatMap((row, i) => row.clips.map((clip) => [clip.id, badges[i]])));

      /* every source's facts, once */
      /** @type {Map<string, import('./nle.mjs').SourceFacts>} */
      const facts = new Map();
      const factsOf = async (/** @type {string} */ path) => {
        if (!facts.has(path)) facts.set(path, existsSync(path) ? await probeSource(path) : {});
        return /** @type {import('./nle.mjs').SourceFacts} */ (facts.get(path));
      };
      /** @type {import('./nle.mjs').NlePicture[]} */
      const pictures = [];
      /** @type {import('./nle.mjs').NleSound[]} */
      const sounds = [];
      let duration = 0;
      for (const [ti, track] of doc.tracks.entries()) {
        for (const row of track.clips) {
          const c = byId.get(row.id);
          const kind = kindOf(row);
          if (!c || !kind) continue;
          const path = clipPath(root, row.src);
          const volume = /** @type {{ volume?: number }} */ (row).volume ?? 1;
          const heard = !track.muted && !track.hidden && volume > 0;
          const fade = fittedFade(clipFade(row), c.end - c.at);
          if (!track.hidden) duration = Math.max(duration, c.end);
          if (kind !== 'sound') {
            /** @type {import('./nle.mjs').SourceFacts | null} */
            let f = kind === 'page' ? null : { ...(await factsOf(path)), ...(c.w && c.h ? { w: c.w, h: c.h } : {}) };
            /* a drawing has no pixels of its own: it is drawn as big as it shows, so the editor doesn't blow it up */
            if (f?.w && f.h && /\.svg$/i.test(row.src)) {
              const k = pictureRect(kind, { w: f.w, h: f.h }, doc.stage, row.box).w / f.w;
              f = { ...f, w: Math.max(1, Math.round(f.w * k)), h: Math.max(1, Math.round(f.h * k)) };
            }
            pictures.push({ id: row.id, kind, src: row.src, path, at: c.at, end: c.end, from: c.from, speed: c.speed, box: row.box,
              track: ti, hidden: Boolean(track.hidden), styled: Boolean(row.class || row.style), ...(fade ? { faded: true } : {}), facts: f });
          }
          if (kind === 'sound' || kind === 'video') {
            const f = await factsOf(path);
            if (f.hasAudio) {
              sounds.push({ id: row.id, src: row.src, path, at: c.at, from: c.from, to: c.to, speed: c.speed, volume,
                enabled: heard, role: soundStem(row.src), track: ti, sourceRow: sourceRows.get(row.id), facts: f, ...(kind === 'video' ? { picture: row.id } : {}), ...(fade ? { fade } : {}) });
            }
          }
        }
      }
      if (!pictures.length && !sounds.length) throw new ExportError('the film is empty');

      await mkdir(join(staging, 'media'), { recursive: true });
      /* stems: each role's sound mixed (what is heard: muted tracks and silenced clips out) */
      /** @type {Map<import('./nle.mjs').SoundRole, string>} */
      const stems = new Map();
      if (mode === 'stems') {
        update(job, { phase: 'audio', progress: 0.02 });
        for (const role of STEMS) {
          const part = sounds.filter((x) => x.enabled && x.role === role);
          if (!part.length) continue;
          if (signal.aborted) throw new Error('cancelled');
          const file = join(scratch, `${role}.wav`);
          await mix(part.map((x) => ({ file: x.path, at: x.at, from: x.from, to: x.to, volume: x.volume, speed: x.speed,
            ...(x.fade ? { fade: { in: x.fade[0], out: x.fade[1], length: (x.to - x.from) / x.speed, skip: 0 } } : {}) })),
            duration || 0.001, file, SOUND_CODECS.wav);
          stems.set(role, file);
        }
      }

      const timeline = planNleTimeline({ stage: doc.stage, duration: duration || 0.001, pictures, sounds },
        { title, fps, audio: mode, media: ask.media ?? 'copy', mediaDir: join(final, 'media'), stems: [...stems.keys()],
          audioTracks: fcp ? 'source' : 'roles', alpha: prores ? 'prores4444' : 'png' });
      const staged = (/** @type {import('./nle.mjs').NleFile} */ f) => join(staging, 'media', basename(f.path));

      /* each web page (and each picture Basic Motion can't place) drawn alone, full frame, with alpha. Several are drawn at
         once, the longest first, with as many browsers in all as one render of every frame would get (render.mjs
         defaultWorkers), shared by their frames (shareOf), kept from page to page in one process (drawer); a PNG page's
         pictures are thinned while the next ones draw. One that fails stops the others */
      const renders = timeline.files.filter((f) => f.job.kind === 'render').sort((a, b) => framesOf(b) - framesOf(a));
      const totalFrames = renders.reduce((n, f) => n + framesOf(f), 0);
      const tick = frames(job, 0.88);
      /** @type {Map<string, number>} */
      const drawnFrames = new Map();
      const budget = machine();
      /* Hosted exports share the same two-browser budget across all pages drawing at once. */
      let free = Math.min(defaultWorkers(budget, totalFrames), process.env.OPENFILM_HOSTED_RENDER === '1' ? 2 : Infinity);
      /* the chip's ProRes until one of the pages has to do without it: the rest do without it too */
      let hardware = true;
      const stop = new AbortController();
      const quit = () => stop.abort();
      signal.addEventListener('abort', quit, { once: true });
      /* the pages' browsers, started once for all of them */
      const pool = drawer();
      /** @type {Set<Promise<void>>} */
      const drawing = new Set();
      /** @type {Promise<void>[]} */
      const pages = [];
      /** @type {unknown} */
      let failed = null;
      /**
       * A draft's page written as it is drawn, as editors play it best: opaque in every frame, H.264 (the graphics
       * chip's when it has one, else x264 at master quality, BT.709 like a video export) or ProRes 422 HQ; drawn again
       * at the first pixel that shows through as quick PNG (its pictures thinned after) or ProRes 4444. The result
       * says which (`clear`).
       * @param {(how: Record<string, unknown>) => Promise<{ clear?: boolean }>} draw @param {'h264' | 'prores'} codec
       */
      const asEditorsPlay = async (draw, codec) => {
        /** @param {string | null} encoder */
        const formats = (encoder) => (codec === 'h264'
          ? { format: { video: [...encoding('h264', 'master', doc.stage, timeline.rate.fps, have, encoder).format.video, ...H264_709], pix: YUV_709('yuv420p') }, clear: QUICK_PNG }
          : { format: prores709(encoder ?? 'prores_ks', false), clear: prores709(encoder ?? 'prores_ks', true) });
        const chip = await hardwareEncoder(codec, have);
        try {
          return await draw(formats(chip));
        } catch (e) {
          /* the chip's encoder gave up partway: the page again without it, and the rest of this launch does without it (a
             full disk is no encoder's doing) */
          if (!chip || stop.signal.aborted || diskFull(e) || !/^ffmpeg/.test(e instanceof Error ? e.message : '')) throw e;
          broken(chip);
          return draw(formats(null));
        }
      };
      /** @param {import('./nle.mjs').NleFile} file @param {number} workers @param {() => void} drawn */
      const page = async (file, workers, drawn) => {
        const { clip: id, frames } = /** @type {Extract<import('./nle.mjs').NleMediaJob, { kind: 'render' }>} */ (file.job);
        const p = /** @type {import('./nle.mjs').NlePicture} */ (pictures.find((x) => x.id === id));
        const native = byId.get(id)?.native ?? Infinity;
        /* as long as its frames on the sequence: a page holds its last frame, a still lasts as long as it is told */
        const time = p.kind === 'video' ? [p.from, Math.min(native, p.from + (frames / timeline.rate.fps) * p.speed)] : [p.from, p.from + frames / timeline.rate.fps];
        /* a draft's page with no clear pixel in any frame needs no alpha (each frame's alpha is read as it is drawn, so
           it is what Studio shows): written opaque as it is drawn, nothing written twice. At the first pixel that shows
           through it is drawn again with its alpha: as lossless PNG, or as ProRes 4444 (`prores`) */
        let clear = true;
        try {
          const one = await clipFilm(root, id, { change: { time }, doc });
          try {
            /** @param {Record<string, unknown>} how */
            const draw = async (how) => {
              const result = await pool.render([one.dir], {
                root, alpha: true, silent: true, fps: timeline.rate.fps, out: staged(file), signal: stop.signal, workers, ...how,
                /* a page drawn again counts from where it was: it holds until the second drawing passes it */
                onProgress: (/** @type {number} */ done) => {
                  drawnFrames.set(file.id, Math.max(drawnFrames.get(file.id) ?? 0, done));
                  tick([...drawnFrames.values()].reduce((n, d) => n + d, 0), totalFrames);
                },
              });
              if (result.encoder !== job.encoder) update(job, { encoder: result.encoder });
              return result;
            };
            if (app && alpha !== 'png') clear = (await asEditorsPlay(draw, alpha === 'prores' ? 'prores' : 'h264')).clear === true;
            else if ((await draw(pngFormat ? { format: pngFormat } : { hardware })).encoder === 'prores_ks') hardware = false;
          } finally {
            await one.remove();
          }
        } finally {
          drawn();
        }
        /* a source shorter than its place by a frame of rounding: the clip ends where its picture does */
        const made = await countFrames(staged(file));
        if (made > 0 && made !== frames) {
          file.durationFrames = made;
          for (const t of timeline.video) for (const c of t.clips) if (c.fileId === file.id) { c.out = made; c.end = c.start + made; }
        }
        /* a draft's PNG page keeps each picture once, for as long as it shows (剪映 plays a picture's own length): a
           fraction of the frames, the same pixels */
        if (app && clear && alpha !== 'prores') await keepChanges(staged(file), stop.signal);
      };
      try {
        let left = totalFrames;
        for (const file of renders) {
          while (!free && !failed) await Promise.race(drawing);
          if (failed) break;
          const workers = shareOf(free, framesOf(file), left, defaultWorkers(budget, framesOf(file)));
          left -= framesOf(file);
          free -= workers;
          /* its browsers back for the next page once it is drawn, while its pictures are thinned (a PNG page) */
          /** @type {() => void} */
          let drawn = () => {};
          const slot = new Promise((r) => { drawn = () => r(undefined); }).then(() => { drawing.delete(slot); free += workers; });
          drawing.add(slot);
          pages.push(page(file, workers, drawn).catch((e) => {
            failed ??= e;
            stop.abort();
          }));
        }
        await Promise.all(pages);
      } finally {
        signal.removeEventListener('abort', quit);
        await pool.close();
      }
      if (signal.aborted) throw new Error('cancelled');
      if (failed) throw failed;

      update(job, { phase: 'encoding', progress: 0.9, rate: 0, etaMs: null });
      const others = timeline.files.filter((f) => f.job.kind !== 'render' && f.job.kind !== 'link');
      /** @type {import('playwright-core').Browser | null} */
      let browser = null;
      try {
        for (const [i, file] of others.entries()) {
          if (signal.aborted) throw new Error('cancelled');
          const make = file.job;
          const to = staged(file);
          /* a clone on APFS: instant, and no more room taken */
          if (make.kind === 'copy') await copyFile(make.from, to, fsConstants.COPYFILE_FICLONE);
          else if (make.kind === 'stem') await copyFile(/** @type {string} */ (stems.get(make.role)), to);
          else if (make.kind === 'raster') {
            browser ??= await launch();
            await rasterize(browser, make.from, make.w, make.h, to);
          } else if (make.kind === 'transcode') {
            await transcode(make, to, signal, file.video);
            // Full video conversions can retain timecode; use the produced file's metadata, not the original's.
            if (!app && !fcp && file.video && !make.segment) file.timecode = (await probeSource(to)).timecode;
          }
          update(job, { progress: Math.floor((0.9 + 0.08 * ((i + 1) / others.length)) * 100) / 100 });
        }
      } finally {
        await browser?.close();
      }

      update(job, { phase: 'finishing', progress: 0.98 });
      if (app) {
        /* the app on Windows reads draft_content.json, on a Mac draft_info.json: the same draft in both */
        /* the subtitles' language: a translation shown alone is in its own; else told from the words (jianying.mjs) */
        const draft = jianyingDraft(timeline, { app, name: basename(final), folder: final, root: dir, cues, language: shown?.bilingual ? null : shown?.language });
        const info = JSON.stringify(draft.info);
        await writeFile(join(staging, 'draft_info.json'), info, 'utf8');
        await writeFile(join(staging, 'draft_content.json'), info, 'utf8');
        await writeFile(join(staging, 'draft_meta_info.json'), JSON.stringify(draft.meta), 'utf8');
      } else {
        const srt = filmSubtitleSrt(cues);
        if (srt) await writeFile(join(staging, `${title}.srt`), srt, 'utf8');
        const xml = fcp ? fcpxmlDocument(timeline, { cues }) : xmemlDocument(timeline);
        await writeFile(join(staging, `${title}.${fcp ? 'fcpxml' : 'xml'}`), xml, 'utf8');
      }
      if (signal.aborted) throw new Error('cancelled');
      if (!(await readdir(join(staging, 'media'))).length) await rmdir(join(staging, 'media'));
      await renameSafely(staging, final);
      const media = existsSync(join(final, 'media')) ? (await readdir(join(final, 'media'))).sort().map((n) => join(final, 'media', n)) : [];
      const first = app ? 'draft_info.json' : fcp ? '.fcpxml' : '.xml';
      const top = (await readdir(final)).filter((n) => n !== 'media').sort((a, b) => Number(!a.endsWith(first)) - Number(!b.endsWith(first)) || a.localeCompare(b));
      /* the XML (the draft) first: "Show in Finder" shows the first */
      const outputs = [...top.map((n) => join(final, n)), ...media];
      update(job, { out: outputs[0], outputs });
    } finally {
      await tidy(scratch);
      await tidy(staging);
    }
  }

  /**
   * The project itself (see projectFiles): a zip holding its folder, or the folder, under the name asked for or else
   * the project's. Copied a piece at a time, so its footage can be any size; a link to a file is copied as the file.
   * @param {ExportJob} job @param {string} root @param {string} dir @param {AbortSignal} signal
   */
  async function exportProject(job, root, dir, signal) {
    const ask = /** @type {ProjectAsk} */ (job.ask);
    const title = baseName(job.name, ask);
    const files = await projectFiles(root, ask.parts ?? [], resolve(dir));
    const total = Math.max(1, files.reduce((n, f) => n + f.size, 0));
    let told = 0;
    const copied = (/** @type {number} */ bytes) => {
      if (Date.now() - told < 200 && bytes < total) return;
      told = Date.now();
      update(job, { phase: 'copying', progress: Math.floor((bytes / total) * 99) / 100 });
    };
    if ((ask.as ?? 'zip') === 'zip') {
      const out = freeFile(dir, title, '.zip');
      const part = partialOf(out, job.id);
      update(job, { out: part, outputs: [part] });
      await zipFiles(part, files.map((f) => ({ name: `${title}/${f.name}`, file: f.file })), signal, copied);
      await renameSafely(part, out);
      update(job, { out, outputs: [out] });
      return;
    }
    const final = freeFile(dir, title, '');
    const staging = join(dir, `.${basename(final)}.partial-${process.pid}-${job.id}`);
    try {
      let bytes = 0;
      for (const f of files) {
        if (signal.aborted) throw new Error('cancelled');
        const to = join(staging, ...f.name.split('/'));
        await mkdir(dirname(to), { recursive: true });
        await copyFile(f.file, to, fsConstants.COPYFILE_FICLONE);
        copied(bytes += f.size);
      }
      await mkdir(staging, { recursive: true });
      await renameSafely(staging, final);
      update(job, { out: final, outputs: [final] });
    } finally {
      await tidy(staging);
    }
  }

  /**
   * An export the same as `made` but for its name: `made`'s files, cloned under this one's name beside them (on APFS at
   * once, taking no more room), a sidecar with its file.
   * @param {ExportJob} job @param {ExportJob} made @param {string} dir
   */
  async function cloneOf(job, made, dir) {
    const main = made.outputs[0];
    const ext = extname(main);
    const out = freeFile(dir, baseName(job.name, job.ask), ext);
    const stem = main.slice(0, main.length - ext.length);
    /** @type {string[]} */
    const outputs = [];
    for (const file of made.outputs) {
      const to = file === main ? out : `${out.slice(0, out.length - ext.length)}${file.slice(stem.length)}`;
      outputs.push(to);
      update(job, { out, outputs: [...outputs] });
      await copyFile(file, to, fsConstants.COPYFILE_FICLONE);
    }
    update(job, { encoder: made.encoder, alpha: made.alpha });
  }

  async function next() {
    if (running || closing) return;
    /* the oldest waiting: the list is newest first, and exports run in the order asked */
    const job = jobs.findLast((j) => j.status === 'waiting');
    if (!job) return;
    running = true;
    /** @type {() => void} */
    let finished = () => {};
    idle = new Promise((r) => { finished = () => r(undefined); });
    const { root, folder, abort, twin } = /** @type {{ root: string, folder: string, abort: AbortController, twin?: string }} */ (work.get(job.id));
    try {
      await mkdir(folder, { recursive: true });
      /* what an export Studio could not finish left behind, gone before this one starts */
      await Promise.all([sweep(folder, LEFT.output), sweep(join(root, '.film', 'cache', 'export'), LEFT.scratch),
        sweep(join(root, '.film', 'cache', 'render'), LEFT.parts), sweep(join(root, '.film', 'cache', 'seek'), LEFT.copy)]);
      update(job, { status: 'running', phase: 'preparing', startedAt: Date.now() });
      const kind = job.ask.kind;
      /* the same export as one made just before it (asked together), but for its name: that one's files, cloned */
      const made = twin ? jobs.find((j) => j.id === twin && j.status === 'done' && j.outputs.length) : undefined;
      if (made) await cloneOf(job, made, folder);
      else if (kind === 'video') await exportVideo(job, root, folder, abort.signal);
      else if (kind === 'gif') await exportGif(job, root, folder, abort.signal);
      else if (kind === 'audio') await exportSound(job, root, folder, abort.signal);
      else if (kind === 'subtitles') await exportSubtitles(job, root, folder);
      else if (kind === 'slides') await exportSlides(job, root, folder, abort.signal);
      else if (kind === 'nle') await exportNle(job, root, folder, abort.signal);
      else if (kind === 'project') await exportProject(job, root, folder, abort.signal);
      else await exportStills(job, root, folder, abort.signal);
      if (abort.signal.aborted) throw new Error('cancelled');
      const bytes = job.outputs.reduce((n, f) => n + (existsSync(f) ? statSync(f).size : 0), 0);
      update(job, { status: 'done', progress: 1, phase: null, etaMs: null, bytes, finishedAt: Date.now() });
    } catch (e) {
      /* what a cancelled or failed export left half written is not an export */
      for (const f of job.outputs) await rm(f, { force: true }).catch(() => {});
      const ended = { phase: null, etaMs: null, outputs: [], out: undefined, finishedAt: Date.now() };
      const said = e instanceof Error ? e.message : String(e);
      /* a full disk is the person's to fix, said plainly (in ffmpeg's words it is lines of its own) */
      const full = diskFull(e);
      const error = full ? 'the disk is full: free up some space, then export again' : said;
      update(job, abort.signal.aborted ? { ...ended, status: 'cancelled' } : { ...ended, status: 'failed', error, ...(full ? { diskFull: true } : {}) });
      if (!abort.signal.aborted) recordProblem({ area: 'export', step: job.ask.kind, what: said, project: root });
    } finally {
      work.delete(job.id);
      running = false;
      finished();
      next();
    }
  }

  /** @param {{ id: string, name: string, path: string }} project @param {ExportAsk} ask @param {string} folder */
  /** @param {{ id: string, name: string, path: string }} project @param {ExportAsk} ask @param {string} folder @param {string} [twin] */
  function queue(project, ask, folder, twin) {
    /** @type {ExportJob} */
    const job = {
      id: randomBytes(6).toString('hex'), project: project.id, name: project.name, label: ask.label ?? '', kind: ask.kind, ask,
      status: 'waiting', progress: 0, phase: null, framesDone: 0, framesTotal: 0, rate: 0, etaMs: null, encoder: null,
      outputs: [], bytes: null, alpha: null, at: Date.now(), startedAt: null, finishedAt: null,
    };
    jobs.unshift(job);
    work.set(job.id, { root: project.path, folder, abort: new AbortController(), ...(twin ? { twin } : {}) });
    onChange({ ...job, outputs: [] });
    return job;
  }

  return {
    /** Queue an export of the project at `root`. @param {{ id: string, name: string, path: string }} project @param {ExportAsk} ask @param {{ folder?: string }} [where] */
    start(project, ask, where = {}) {
      const job = queue(project, checked(ask), folderOf(where.folder));
      next();
      return { ...job };
    },
    /**
     * Queue several exports at once (`{ jobs: [ask…], folder? }`): all of them, or, when one is wrong, none.
     * @param {{ id: string, name: string, path: string }} project @param {{ jobs?: unknown, folder?: unknown }} body
     */
    startAll(project, body) {
      /* Up to 100 selected stretches for each of the destinations a single export could already queue. */
      if (!Array.isArray(body?.jobs) || !body.jobs.length || body.jobs.length > 2400) throw new ExportError('jobs: a list of 1 to 2400 exports');
      const asks = body.jobs.map((ask) => checked(/** @type {ExportAsk} */ (ask)));
      const folder = folderOf(body.folder);
      /* asks the same but for their name (platforms that take the same frame, size and rate: 抖音, 快手, 视频号) are
         drawn once, and the others get that one's files */
      /** @type {Map<string, string>} */
      const first = new Map();
      const queued = asks.map((ask) => {
        const { preset, label, ...rest } = /** @type {ExportAsk & { preset?: string }} */ (ask);
        const same = ask.kind === 'video' || ask.kind === 'gif' ? JSON.stringify(rest, Object.keys(rest).sort()) : null;
        const job = queue(project, ask, folder, same ? first.get(same) : undefined);
        if (same && !first.has(same)) first.set(same, job.id);
        return job;
      });
      next();
      return queued.map((job) => ({ ...job }));
    },
    /** The exports of a project, newest first (those of this launch). */
    list: (/** @type {string} */ projectId) => jobs.filter((j) => j.project === projectId).map((j) => ({ ...j, outputs: [...j.outputs] })),
    /** Cancel a waiting or running export. */
    cancel(/** @type {string} */ id) {
      const job = jobs.find((j) => j.id === id);
      if (!job) throw new ExportError('no such export', 404);
      if (job.status === 'waiting') { work.delete(id); update(job, { status: 'cancelled', finishedAt: Date.now() }); return; }
      const running = work.get(id);
      if (!running || running.abort.signal.aborted) return;
      /* said at once: stopping a render takes a moment (its browsers and encoders closing) */
      update(job, { cancelling: true, etaMs: null });
      running.abort.abort();
    },
    /** How many subtitle cues the film at `root` has (0 when they can't be read): the dialog's subtitle choices need some. */
    async subtitles(/** @type {string} */ root) {
      try { return (await subtitlesOf(root)).cues.length; } catch { return 0; }
    },
    /** Whether an export is waiting or running. */
    busy: () => work.size > 0 || jobs.some((j) => j.status === 'waiting'),
    /**
     * Stop everything (Studio is closing): what waits is cancelled, what runs stops. Resolves once the running export has
     * cleaned up after itself (its half-made files gone), or after STOP_WAIT_MS.
     */
    stopAll() {
      closing = true;
      for (const job of jobs) if (job.status === 'waiting') { work.delete(job.id); update(job, { status: 'cancelled', finishedAt: Date.now() }); }
      for (const { abort } of work.values()) abort.abort();
      return Promise.race([idle, new Promise((r) => { setTimeout(r, STOP_WAIT_MS).unref(); })]);
    },
  };
}

/**
 * render (src/render.mjs) in a process of its own (render-worker.mjs), as an editor's export runs apart from the editor:
 * what breaks in its browsers or encoders ends that export, said in its error, and never Studio. Same arguments and
 * result as render; `signal` asks it to stop, and it is ended if it has not after a few seconds.
 * @param {string[]} args @param {Record<string, any>} opts @returns {Promise<{ out: string, encoder: string, lines: string[], ranges?: [number, number][] }>}
 */
function render(args, opts) {
  const { signal, onProgress, ...rest } = opts;
  return new Promise((done, fail) => {
    if (signal?.aborted) return fail(new Error('cancelled'));
    const child = fork(fileURLToPath(new URL('./render-worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'inherit', 'pipe', 'ipc'] });
    /* before it is told what to render, so every browser and encoder it starts starts below too */
    below(child);
    let said = '';
    child.stderr?.on('data', (d) => { said = (said + d).slice(-4000); process.stderr.write(d); });
    let settled = false;
    /** @param {() => void} end */
    const settle = (end) => { if (settled) return; settled = true; signal?.removeEventListener('abort', cancel); end(); };
    function cancel() {
      if (child.connected) child.send({ type: 'cancel' });
      /* its browsers and encoders with it: on Windows ending a process leaves its children running */
      setTimeout(() => killProcess(child), 5000).unref();
    }
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('message', (/** @type {any} */ m) => {
      if (m?.type === 'progress') onProgress?.(m.done, m.total);
      else if (m?.type === 'done') settle(() => done(m.result));
      else if (m?.type === 'failed') settle(() => fail(new Error(m.error)));
    });
    child.on('error', (e) => settle(() => fail(e)));
    child.on('exit', (code, sig) => settle(() => {
      const last = said.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l)).pop();
      fail(new Error(signal?.aborted ? 'cancelled' : `the renderer stopped (${sig ?? `exit ${code}`})${last ? `: ${last.slice(0, 300)}` : ''}`));
    }));
    child.send({ args, opts: rest });
  });
}

/**
 * Renders in one process of their own (render-worker.mjs `--pool`) that share its browsers: an editing project's
 * pages, drawn several at once and page after page, start a browser once rather than for each page, and one whose
 * browser crashed or stopped answering is drawn again in new ones. `render` takes render's arguments and gives its
 * result, as the one-shot render does; `close` ends the process and every browser (after the last page, or on cancel).
 * A process that dies fails every render still in it.
 */
function drawer() {
  const child = fork(fileURLToPath(new URL('./render-worker.mjs', import.meta.url)), ['--pool'], { stdio: ['ignore', 'inherit', 'pipe', 'ipc'] });
  below(child);
  let said = '';
  child.stderr?.on('data', (d) => { said = (said + d).slice(-4000); process.stderr.write(d); });
  /** @type {Map<string, { onProgress?: (done: number, total: number) => void, done: (r: any) => void, fail: (e: Error) => void, signal?: AbortSignal }>} */
  const jobs = new Map();
  /** @type {Error | null} */
  let gone = null;
  let next = 0;
  child.on('message', (/** @type {any} */ m) => {
    const job = jobs.get(m?.id);
    if (!job) return;
    if (m.type === 'progress') job.onProgress?.(m.done, m.total);
    else if (m.type === 'done' || m.type === 'failed') {
      jobs.delete(m.id);
      if (m.type === 'done') job.done(m.result);
      else job.fail(new Error(job.signal?.aborted ? 'cancelled' : m.error));
    }
  });
  const end = (/** @type {Error} */ e) => {
    gone ??= e;
    for (const [id, job] of jobs) { jobs.delete(id); job.fail(job.signal?.aborted ? new Error('cancelled') : e); }
  };
  child.on('error', end);
  child.on('exit', (code, sig) => {
    const last = said.trim().split('\n').filter((l) => l.trim() && !/^\s+at /.test(l) && !/drawn again in new browsers$/.test(l)).pop();
    end(new Error(`the renderer stopped (${sig ?? `exit ${code}`})${last ? `: ${last.slice(0, 300)}` : ''}`));
  });
  return {
    /** @param {string[]} args @param {Record<string, any>} opts @returns {Promise<{ out: string, encoder: string, clear?: boolean, lines: string[] }>} */
    render(args, opts) {
      const { signal, onProgress, ...rest } = opts;
      return new Promise((done, fail) => {
        if (signal?.aborted) return fail(new Error('cancelled'));
        if (gone) return fail(gone);
        const id = String(++next);
        const cancel = () => { if (child.connected) child.send({ type: 'cancel', id }); };
        signal?.addEventListener('abort', cancel, { once: true });
        const off = () => signal?.removeEventListener('abort', cancel);
        jobs.set(id, { onProgress, signal, done: (r) => { off(); done(r); }, fail: (e) => { off(); fail(e); } });
        child.send({ type: 'render', id, args, opts: rest });
      });
    },
    /** Ends the process: what still draws stops, the browsers close; ended outright if it has not after a few seconds. */
    async close() {
      if (child.exitCode != null || child.signalCode != null) return;
      const exited = new Promise((r) => child.once('exit', r));
      if (child.connected) child.send({ type: 'close' });
      /* its browsers and encoders with it: on Windows ending a process leaves its children running */
      const kill = setTimeout(() => killProcess(child), 6000);
      await exited;
      clearTimeout(kill);
    },
  };
}

/** How many frames a file of an editing project is drawn with: a page's or a still's, 0 for anything else. @param {import('./nle.mjs').NleFile} file */
const framesOf = (file) => (file.job.kind === 'render' ? file.job.frames : 0);

/**
 * How many of the `free` browsers a page of `frames` draws with, when `left` frames are still to be drawn (its own
 * included): its share by its frames, at least one, and no more than it would get alone (`alone`). Pages of a film each
 * draw with one, several at once, so no browser is started for a few frames; a long page gets more.
 * @param {number} free @param {number} frames @param {number} left @param {number} alone
 */
export const shareOf = (free, frames, left, alone) => Math.max(1, Math.min(free, alone, Math.ceil((free * frames) / Math.max(1, left))));

/** A number as render's range takes it: plain digits, no exponent. @param {number} n */
const num = (n) => String(Number(n.toFixed(3)));

