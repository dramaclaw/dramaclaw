// openfilm look: the agent's eyes. Draws the film (or one frame, or a range), checks it while drawing, and prints
// what is wrong before the path of the picture.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { FrameError, launch, SOFTWARE_GL } from './host.mjs';
import { blockDiff, checkSound, cutText, fileOf, ffmpeg, filmSound, fmt, hash, homeFor, mix, open, outDir, parseTarget, SAME_LIMIT, shown, shuffled, spread, UsageError } from './shared.mjs';

const MEDIA = /\.(mp4|mov|m4v|webm|mkv|avi|png|jpe?g|webp|gif|mp3|wav|m4a|aac|ogg|flac)$/i;
const CELL_WIDTH = 480;
/* VP9's and VP8's alpha is a side channel ffmpeg's own decoders drop: libvpx reads it, when this ffmpeg has it */
const LIBVPX = { vp9: 'libvpx-vp9', vp8: 'libvpx' };
let decoders;
const hasDecoder = (name) => {
  decoders ??= spawnSync('ffmpeg', ['-hide_banner', '-decoders'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(decoders);
};

export async function look(args, opts = {}) {
  const { film: target, at, range } = parseTarget(args);
  if (MEDIA.test(target)) return lookMedia(target, at, range, opts);
  let s;
  /* `playable`: footage the browser does not decode (ProRes; HEVC without a chip for it) is looked at through a copy it plays */
  try { s = await open(target, { root: opts.root, offline: opts.offline, network: opts.network, transparent: true, launch: opts.launch, playable: true }); }
  catch (e) { if (e instanceof FrameError) return { ok: false, lines: [`✗ ${e.message}`], files: [] }; throw e; }
  const { film, browser } = s;
  const m = film.meta;
  /* a page without a duration has no end: it is looked at by a range or at a time */
  const end = m.duration ?? Infinity;
  const errors = [];
  const warnings = [];
  const files = [];
  const passed = [];
  const sounds = [];
  const dir = outDir(homeFor(s.dir), 'look');
  const rel = shown;
  try {
    // The contract
    if (m.duration != null && !(Number.isFinite(m.duration) && m.duration > 0)) errors.push('film.duration, when set, must be a finite number of seconds > 0');
    if (m.duration == null && at == null && !range) throw new UsageError('this page has no duration, so it has no end: say what to look at, a range (openfilm look 0-6) or a time (openfilm look 2)');
    if (!(Number.isInteger(m.width) && m.width > 0 && Number.isInteger(m.height) && m.height > 0)) errors.push('film.width and film.height, when set, must both be positive whole numbers of CSS pixels');
    for (const clip of m.sounds) if (!existsSync(fileOf(s.root, s.entry, clip.src))) errors.push(`sound not found: ${clip.src}`);
    /* a page plays no sound of its own: what it still lists in `audio` is heard nowhere until it is a clip */
    for (const page of await pagesWithAudio()) warnings.push(`${page}: window.film.audio is not played: a sound is a clip in film.html`);
    const gpu = await film.gpu();
    if (SOFTWARE_GL.test(gpu)) warnings.push(`WebGL runs in software (${gpu}): slow, and pictures may differ from a GPU`);
    if (errors.length) return finish();

    try { await draw(); } catch (e) {
      if (!(e instanceof FrameError)) throw e;
      errors.push(e.message);
      film.problems.length = 0; // already part of the message
    }
    const missing = await film.page.evaluate(() => [...(document.fonts ?? [])].filter((f) => f.status === 'error').map((f) => f.family)).catch(() => []);
    for (const family of new Set(missing)) errors.push(`font failed to load: ${family}`);
    /* what the person changed inside pages in Studio (film.html `overrides`): said, so a page that draws differently
       from its source is not a surprise, and a change that lost its element (the page was rewritten) is caught */
    const edits = await film.page.evaluate(() => window.__filmOverrides?.() ?? []).catch(() => []);
    for (const clip of edits) {
      const fade = clip.fade ? [`fades ${[clip.fade[0] > 0 && `in ${fmt(clip.fade[0])}`, clip.fade[1] > 0 && `out ${fmt(clip.fade[1])}`].filter(Boolean).join(', ')}`] : [];
      sounds.push(`✎ ${clip.id}  changed in Studio: ${[...fade, ...clip.overrides.map((o) => `${o.at} ${[o.text != null && 'text', o.t && 'moved', o.s != null && 'scaled', o.r != null && 'rotated', ...Object.keys(o.style ?? {})].filter(Boolean).join(', ')}`)].join(' · ')}`);
      for (const o of clip.overrides) {
        if (clip.drawn && !o.found) warnings.push(`${clip.id}: the person's change to ${o.at} finds nothing in ${clip.src} any more; keep that element (and its id) in the page, or drop the entry from the clip's overrides`);
      }
    }
    return finish();
  } finally {
    await s.close();
  }

  async function draw() {
    const dur = end;
    const clamp = (t) => Math.min(Math.max(0, t), dur - 1e-3);
    // PNG with alpha: a page meant as a layer (white type, nothing behind it) is judged by what it draws, not by a
    // default white it never asked for.
    const shoot = async (t) => { await film.seek(clamp(t)); return film.capture({ format: 'png' }); };

    if (at != null) {
      // One frame at full size, and the same frame again after another one: it must not change.
      const t = clamp(at);
      if (at >= dur) warnings.push(`${fmt(at)} is past the film's end (${fmt(dur)}): its last frame is drawn`);
      const png = await shoot(t);
      const file = join(dir, `${fmt(t)}.png`);
      writeFileSync(file, png);
      files.push(file);
      /* another frame between: half the film away, or a second on for a page with no end */
      await shoot(Number.isFinite(dur) ? (t < dur / 2 ? t + dur / 2 : t - dur / 2) : t + 1);
      await film.seek(t);
      const again = await film.capture({ format: 'png' });
      if (await compare([[t, png, again]], 'png')) passed.push('drawn again after another frame: same picture');
    } else {
      if (range && range[0] >= dur) throw new UsageError(`range ${fmt(range[0])}-${fmt(range[1])} starts at or after the film's end (${fmt(dur)})`);
      if (range && range[1] > dur) warnings.push(`${fmt(range[0])}-${fmt(range[1])} runs past the film's end (${fmt(dur)}): the sheet stops there`);
      const [from, to] = range ? [clamp(range[0]), Math.min(range[1], dur)] : [0, dur];
      const count = Math.max(1, Math.round(opts.count ?? 12));
      const times = Array.from({ length: count }, (_, i) => clamp(from + ((to - from) * i) / count));
      // Twice, each time in its own shuffled order, the way a person scrubs: a frame that depends on what was
      // drawn before it shows up as two different pictures.
      const cut = new Map();
      const pass = async (order, scan) => {
        const out = new Map();
        for (const t of order) { out.set(t, await shoot(t)); if (scan) await scanText(t, cut); }
        return out;
      };
      /* an agent's shell shows nothing until the command ends: say what is being done, so a long look never looks hung */
      if (!process.stderr.isTTY) process.stderr.write(`  drawing ${count} frames twice (${fmt(from)}–${fmt(to)}) and mixing the sound…\n`);
      const first = await pass(shuffled(times, 1), true);
      const second = await pass(shuffled(times, 2));
      const shots = times.map((t) => ({ t, png: first.get(t) }));
      if (await compare(times.map((t) => [t, first.get(t), second.get(t)]), 'png')) passed.push(`${times.length} frames drawn twice, in two shuffled orders: same t, same picture`);
      if (new Set(shots.map((x) => hash(x.png))).size === 1 && shots.length > 1) warnings.push('every frame looks the same: frame(t) may not draw anything that changes with t');
      /* text cut off in two frames or more: once can be text on its way in */
      for (const [key, seen] of cut) {
        if (seen.times.length < 2) continue;
        const when = seen.times.sort((x, y) => x - y).map(fmt);
        warnings.push(`text cut off ${seen.why === 'edge' ? 'by the edge of the frame' : 'by its box'} at ${when.length > 4 ? `${when.slice(0, 3).join(', ')} … (${when.length} frames)` : when.join(', ')}: "${seen.text}" (${key.split('\n')[1]} in ${seen.page})`);
      }
      await checkCuts(from, to);
      await checkOverlaps();
      const wave = await waveform(s, from, to);
      const marks = joinPieces(m.sounds).filter((c) => (c.at ?? 0) >= from && (c.at ?? 0) < to).map((c) => ({ t: c.at ?? 0, name: basename(c.src) }));
      const file = join(dir, `${Number(from.toFixed(3))}-${fmt(to)}.png`);
      writeFileSync(file, await sheet(browser, shots, m, from, to, wave, marks));
      files.push(file);
    }
    sounds.push(...listSounds(s, m, at != null ? [at, at] : range ?? [0, end], warnings));
    if (s.loudness) sounds.push(s.loudness);
  }

  /* every web page drawn in this frame, checked for text a viewer cannot read whole */
  async function scanText(t, cut) {
    for (const frame of film.page.frames()) {
      const owner = await frame.frameElement().catch(() => null);
      if (owner && !(await owner.evaluate((el) => getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.05).catch(() => false))) continue;
      const isPage = await frame.evaluate(() => Boolean(window.film && typeof window.film.frame === 'function')).catch(() => false);
      /* the film itself is no page of words: its clips are */
      if (!isPage || (s.isFilm && frame === film.page.mainFrame())) continue;
      const found = await frame.evaluate(cutText).catch(() => []);
      const page = decodeURIComponent(new URL(frame.url()).pathname).replace(/^\//, '') || s.entry;
      for (const f of found) {
        const key = `${f.why}\n${f.sel}\n${page}`;
        const seen = cut.get(key) ?? { why: f.why, text: f.text, page, times: [] };
        if (!seen.times.includes(t)) seen.times.push(t);
        cut.set(key, seen);
      }
    }
  }

  /* the web pages of the film (its clips, or the page itself) that still set window.film.audio, each once */
  async function pagesWithAudio() {
    const pages = new Set();
    for (const frame of film.page.frames()) {
      if (s.isFilm && frame === film.page.mainFrame()) continue;
      if (await frame.evaluate(() => Boolean(window.film && 'audio' in window.film)).catch(() => false)) {
        pages.add(decodeURIComponent(new URL(frame.url()).pathname).replace(/^\//, '') || s.entry);
      }
    }
    return [...pages];
  }

  /* clips on one track follow each other: one that starts before the one before it ends (by more than the
     millisecond rounding can make, SPEC) is a mistake in film.html, and what plays there is undefined */
  async function checkOverlaps() {
    const spans = await film.page.evaluate(() => window.__filmSpans?.() ?? []).catch(() => []);
    const byTrack = new Map();
    for (const s of spans) if (Number.isFinite(s.at) && Number.isFinite(s.end)) byTrack.set(s.track, [...(byTrack.get(s.track) ?? []), s]);
    const found = [];
    for (const [track, list] of byTrack) {
      list.sort((a, b) => a.at - b.at);
      for (let i = 1; i < list.length; i += 1) {
        const before = list[i - 1], clip = list[i];
        if (clip.at < before.end - 0.001) found.push(`track ${track}: ${clip.id} starts at ${fmt(clip.at)}, before ${before.id} ends (${fmt(before.end)})`);
      }
    }
    if (found.length) warnings.push(`clips overlap on a track (clips on one track follow each other; move one, or put it on a track of its own): ${found.slice(0, 5).join('; ')}${found.length > 5 ? ` and ${found.length - 5} more` : ''}`);
  }

  /* each picture of a project halfway through its time (its ends may fade from or to black, drawn by the page): a flat
     picture there is a page or media that did not draw */
  async function checkCuts(from, to) {
    const cuts = await film.page.evaluate(() => window.__filmCuts?.() ?? []).catch(() => []);
    const flat = [];
    for (const c of cuts.slice(0, 60)) {
      const t = c.at + (Math.min(c.end, end) - c.at) / 2;
      if (t < from || t >= Math.min(to, c.end, end)) continue;
      await film.seek(t);
      if (await spread(browser, await film.capture({ format: 'png' })) < 6) flat.push(`${fmt(t)} (${c.id})`);
    }
    if (flat.length) warnings.push(`the picture is one flat color halfway through ${flat.length === 1 ? 'a clip' : 'clips'}: ${flat.join(', ')}; if that is not meant, its page or media drew nothing there`);
  }

  async function compare(pairs, ext) {
    const bad = [];
    for (const [t, a, b] of pairs) {
      if (hash(a) === hash(b)) continue;
      if (await blockDiff(browser, a, b) <= SAME_LIMIT) continue; // anti-aliasing noise on text and edges, not the film
      if (!bad.length) { writeFileSync(join(dir, `${fmt(t)}-a.${ext}`), a); writeFileSync(join(dir, `${fmt(t)}-b.${ext}`), b); }
      bad.push(t);
    }
    if (bad.length) {
      const t = bad[0];
      errors.push(`the same t drew two different pictures at ${bad.sort((x, y) => x - y).map(fmt).join(', ')}\n`
        + `        compare ${rel(join(dir, `${fmt(t)}-a.${ext}`))} with ${rel(join(dir, `${fmt(t)}-b.${ext}`))}\n`
        + '        something besides t decides the picture: a clock, unseeded randomness, state kept between calls,\n'
        + '        a tween that took its start value from the screen (use fromTo), or media still seeking');
    }
    return bad.length === 0;
  }

  function finish() {
    for (const p of film.problems) errors.push(`${p.kind === 'request' ? 'request' : 'page'}: ${p.message}`);
    const n = m.sounds.length;
    const head = `film  ${m.width}×${m.height} · ${m.duration != null ? fmt(m.duration) : 'no duration'} · ${n} sound${n === 1 ? '' : 's'}`;
    const lines = [head, ...sounds, ...errors.map((e) => `✗ ${e}`), ...warnings.map((w) => `! ${w}`),
      ...(errors.length ? [] : passed.map((p) => `✓ ${p}`)), ...files.map((f) => `→ ${rel(f)}`)];
    return { ok: errors.length === 0, lines, files };
  }
}

/** The film's sounds in the order they start, each with where it ends on the film. */
function joinPieces(list = []) {
  return [...list].sort((x, y) => (x.at ?? 0) - (y.at ?? 0))
    .map((c) => ({ ...c, end: c.to != null ? (c.at ?? 0) + (c.to - (c.from ?? 0)) / (c.speed ?? 1) : null }));
}

/** One line per sound that plays in [a, b]: where it starts, how long it plays, how loud it peaks. */
function listSounds(s, m, [a, b], warnings) {
  const lines = [];
  for (const c of joinPieces(m.sounds)) {
    checkSound(c);
    const file = c?.src ? fileOf(s.root, s.entry, c.src) : '';
    if (!c?.src || !existsSync(file)) continue;
    const at = c.at ?? 0;
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
    const facts = (() => { try { return JSON.parse(probe.stdout); } catch { return {}; } })();
    /* a video without a sound track is in the film's sounds too (the player cannot tell): it has nothing to hear */
    if (facts.streams && !facts.streams.some((st) => st.codec_type === 'audio')) continue;
    const source = Number(facts.format?.duration) || 0;
    const length = Math.max(0, Math.min(c.to ?? source, source) - (c.from ?? 0)) / (c.speed ?? 1);
    if (at > b || at + length < a) continue;
    /* seek to the used part and read only the sound: a minute from deep inside a long recording must not decode the
       whole file (slow, and enough warnings on stderr to overflow the buffer, which read as silence) */
    const from = c.from ?? 0;
    const span = c.to != null ? ['-t', String(Math.max(0, c.to - from))] : [];
    const stats = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', '-ss', String(from), ...span, '-i', file, '-vn',
      '-af', `volume=${c.volume ?? 1},astats=metadata=0`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
    const peak = Number((/Overall[\s\S]*?Peak level dB:\s*(-?[\d.]+|-inf)/.exec(stats.stderr) ?? [])[1] ?? NaN);
    const loud = Number.isFinite(peak) ? `peak ${peak.toFixed(0)} dB` : 'silent';
    const name = c.src.replace(/^\//, '');
    lines.push(`♪ ${fmt(at).padEnd(7)} ${name}  ${fmt(length)}  ${loud}`);
    if (!(peak > -30)) warnings.push(`${name} peaks at ${Number.isFinite(peak) ? `${peak.toFixed(0)} dB` : '-inf'}: too quiet to hear in the mix`);
  }
  return lines;
}

/** The mix of [from, to) as a PNG waveform, or null when the film has no sound. */
async function waveform(s, from, to) {
  const clips = await filmSound(s, from);
  if (!clips.length) return null;
  const dir = outDir(homeFor(s.dir), 'look');
  const wav = join(dir, '.mix.wav');
  const png = join(dir, '.mix.png');
  try {
    await mix(clips, to - from, wav, ['-c:a', 'pcm_s16le']);
    await ffmpeg(['-i', wav, '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1920x160:colors=#ff8a4c:scale=sqrt', '-frames:v', '1', png]).done;
    /* how loud the mix is as a whole (EBU R128): the waveform shows where sound is, not how loud it reads */
    const meter = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true }).stderr ?? '';
    const lufs = /I:\s*(-?[\d.]+) LUFS/.exec(meter.slice(meter.lastIndexOf('Summary')))?.[1];
    const peak = /Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(meter.slice(meter.lastIndexOf('Summary')))?.[1];
    if (lufs) s.loudness = `♪ mix     ${lufs} LUFS integrated${peak ? ` · true peak ${peak} dBTP` : ''}`;
    return readFileSync(png);
  } finally {
    rmSync(wav, { force: true });
    rmSync(png, { force: true });
  }
}

async function sheet(browser, shots, meta, from, to, wave, marks, label = 'sound mix') {
  const cols = shots.length <= 4 ? shots.length : shots.length <= 9 ? 3 : 4;
  const cellW = CELL_WIDTH;
  const cellH = Math.round((cellW * meta.height) / meta.width);
  /* a sound on its own has no frames: the sheet keeps the width of four, the waveform fills it */
  const W = (cols || 4) * (cellW + 6) - 6;
  const x = (t) => ((t - from) / (to - from)) * W;
  /* without frames to number, the waveform gets a line every second (every fifth for long ones) to read beats against */
  const step = to - from > 60 ? 5 : 1;
  const seconds = shots.length ? [] : Array.from({ length: Math.floor((to - from) / step) }, (_, i) => from + (i + 1) * step);
  const ticks = shots.map((s, i) => `<div style="position:absolute;left:${x(s.t)}px;top:0;bottom:0;border-left:1px solid #fff4"><span style="position:absolute;left:3px;bottom:2px;color:#fff8">#${i + 1}</span></div>`).join('')
    + seconds.map((t) => `<div style="position:absolute;left:${x(t)}px;top:0;bottom:0;border-left:1px solid #fff3"><span style="position:absolute;left:3px;bottom:2px;color:#fff8">${Number(t.toFixed(2))}s</span></div>`).join('')
    + (() => {
      // one label per sound file (with a count when it repeats), one line per start
      const count = {}; for (const mk of marks) count[mk.name] = (count[mk.name] ?? 0) + 1;
      const seen = new Set(); let row = 0;
      return marks.map((mk) => {
        const first = !seen.has(mk.name); seen.add(mk.name);
        const label = first ? `<span style="position:absolute;left:4px;top:${2 + (row++ % 3) * 15}px;color:#5fd1ff;white-space:nowrap;background:#000a">${mk.name} ${count[mk.name] > 1 ? `×${count[mk.name]}` : `${Number(mk.t.toFixed(2))}s`}</span>` : '';
        return `<div style="position:absolute;left:${x(mk.t)}px;top:0;bottom:0;border-left:${first ? 2 : 1}px solid #5fd1ff">${label}</div>`;
      }).join('');
    })();
  const html = `<body style="margin:0;background:#111;font:600 13px ui-monospace,monospace;color:#eee">
    <div style="padding:6px;width:${W}px">
      <div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:6px">
        ${shots.map((s, i) => `<div style="position:relative;width:${cellW}px;height:${cellH}px"><img style="width:100%;height:100%;display:block;background:repeating-conic-gradient(#333 0 25%,#222 0 50%) 0 0/20px 20px" src="data:image/png;base64,${s.png.toString('base64')}"><span style="position:absolute;left:6px;top:4px;background:#000b;padding:1px 6px">${i + 1} · ${Number(s.t.toFixed(2))}s</span></div>`).join('')}
      </div>
      ${wave ? `<div style="position:relative;margin-top:6px;height:${shots.length ? 80 : 320}px;background:#000 url(data:image/png;base64,${wave.toString('base64')}) 0 0/100% 100%">${ticks}</div>
      <div style="display:flex;justify-content:space-between;color:#888;margin-top:2px"><span>${Number(from.toFixed(2))}s</span><span>${label}${shots.length ? " · #n = frame n above" : ""}${marks.length ? ' · blue = where each sound starts' : ''}</span><span>${Number(to.toFixed(2))}s</span></div>` : ''}
    </div></body>`;
  const page = await browser.newPage({ viewport: { width: W + 12, height: 100 } });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await page.screenshot({ fullPage: true });
  } finally { await page.close(); }
}

/**
 * A media file on its own, to choose what to use from it: frames across the file (or a range, or one second at
 * full size) and its own sound, from ffmpeg. Output goes to the project's .film/cache/look (see homeFor).
 */
async function lookMedia(target, at, range, opts) {
  const file = resolve(target);
  if (!existsSync(file) || !statSync(file).isFile()) throw new UsageError(`${target}: no such file`);
  const dir = outDir(homeFor(dirname(file)), 'look');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:stream_tags=alpha_mode', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
  let info;
  try { info = JSON.parse(probe.stdout); } catch { return { ok: false, lines: [`✗ ${target}: ffprobe cannot read it`], files: [] }; }
  const video = (info.streams ?? []).find((x) => x.codec_type === 'video');
  const audio = (info.streams ?? []).some((x) => x.codec_type === 'audio');
  const still = /\.(png|jpe?g|webp|gif)$/i.test(file);
  const dur = still ? 0 : Number(info.format?.duration ?? 0);
  const [w, h] = video ? [video.width, video.height] : [0, 0];
  /* avg or r, whichever is a plausible rate: either can be a timebase (a WebM: avg 1000/1, r 30/1) */
  const rate = (v) => { const [a, b] = String(v ?? '').split('/').map(Number); const r = b ? a / b : a; return r > 0 && r <= 240 ? r : null; };
  const fps = video ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) : null;
  const name = basename(file, extname(file));
  const head = `${basename(file)}  ${video ? `${w}×${h}` : 'sound only'}${dur ? ` · ${fmt(dur)}` : ''}${fps && !still ? ` · ${Number(fps.toFixed(3))} fps` : ''}${audio ? ' · with sound' : ''}`;
  const libvpx = video?.tags?.alpha_mode === '1' && LIBVPX[video.codec_name];
  const decode = libvpx && hasDecoder(libvpx) ? ['-c:v', libvpx] : [];
  const grab = (t, thumbnail = false) => {
    const out = join(dir, `.${name}-${fmt(t)}.png`);
    // Resize before base64 embedding: full-size high-bit-depth PNGs can exceed Node's string limit together. 8 bits, alpha kept.
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...(still ? [] : ['-ss', String(t)]), ...decode, '-i', file,
      ...(thumbnail ? ['-vf', `scale=${CELL_WIDTH}:-1,format=rgb24|rgba`] : []), '-frames:v', '1', out], { windowsHide: true });
    if (r.status !== 0) throw new Error(`ffmpeg could not take a frame at ${fmt(t)}`);
    const png = readFileSync(out); rmSync(out, { force: true }); return png;
  };
  const files = [];
  if (video && (at != null || still)) {
    const t = still ? 0 : Math.min(Math.max(0, at), Math.max(0, dur - 0.04));
    const out = join(dir, still ? `${name}.png` : `${name}-${fmt(t)}.png`);
    writeFileSync(out, grab(t)); files.push(out);
  } else {
    const [from, to] = range ? [Math.max(0, range[0]), Math.min(range[1], dur)] : [0, dur];
    const count = Math.max(1, Math.round(opts.count ?? 12));
    const times = video ? Array.from({ length: count }, (_, i) => from + ((to - from) * i) / count) : [];
    let wave = null;
    if (audio) {
      const png = join(dir, `.${name}-wave.png`);
      /* a sound on its own: the waveform is the whole sheet, so it gets the height to read beats in */
      await ffmpeg(['-ss', String(from), '-t', String(to - from), '-i', file, '-filter_complex', `aformat=channel_layouts=mono,showwavespic=s=1920x${video ? 160 : 640}:colors=#ff8a4c:scale=sqrt`, '-frames:v', '1', png]).done;
      wave = readFileSync(png); rmSync(png, { force: true });
    }
    const browser = await launch(opts.launch);
    try {
      const shots = times.map((t) => ({ t, png: grab(t, true) }));
      const out = join(dir, `${name}-${Number(from.toFixed(3))}-${fmt(to)}.png`);
      writeFileSync(out, await sheet(browser, shots, { width: w || 1920, height: h || 1080 }, from, to, wave, [], 'its sound'));
      files.push(out);
    } finally { await browser.close(); }
  }
  return { ok: true, lines: [head, ...files.map((f) => `→ ${shown(f)}`)], files };
}
