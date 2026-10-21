// The film: film.html, played. The host serves film.html with this module (and, before it, its own start, filmStart
// in host.mjs); the file's own elements are the clips: an <iframe> a web page, a <video>, an <img> a still, an
// <audio> a sound for the mix. Where each plays and sits is what film-doc.mjs reads in the file, the same reading
// Studio plays and exports by; how each looks is the file's own CSS. Track 0, the first <section>, is on top.
import { clipFade, clipSpan, clipTag, declarations, fadeGain, filmHead, fittedFade, kindOf, parseFilm, pictureRect, readFilmFile, sourceAt, srcHref } from './film-doc.mjs';
import { override, restore } from './overrides.mjs';

/* the file as written (without what the host puts in it), read as every reader reads it */
const own = new URL(location.href);
own.searchParams.set('film-host', '0');
const ownText = await (await fetch(own, { cache: 'no-store' })).text();
const read = readFilmFile(ownText);
/* what the tracks and the stage are not (the styles, the fonts): changed, the film is loaded again, not changed in
   place. The stage is the viewport's size, and changes in place (see change) */
const VIEWPORT = /<meta\b[^>]*\bname\s*=\s*["']?viewport\b[^>]*>/i;
const styleOf = (text) => text.replace(VIEWPORT, '');
const head = styleOf(filmHead(ownText));
if (!read.doc) throw new Error(read.problems.length === 1 ? read.problems[0] : `film.html has ${read.problems.length} problems:\n  ${read.problems.join('\n  ')}`);
let doc = read.doc;
/* the stage, the same object while the film is shown: an edit of its size changes it in place (see reshape) */
const stage = { ...doc.stage };
Object.assign(document.body.style, { width: stage.w + 'px', height: stage.h + 'px', margin: '0', overflow: 'hidden', position: 'relative' });
/* the clips' elements, in the order the file has them (the reading above checked that is all a track holds) */
const CLIP_TAGS = new Set(['iframe', 'video', 'img', 'audio']);
const sections = [...document.body.children].filter((el) => el.localName === 'section');
const elements = sections.map((s) => { s.style.display = 'contents'; return [...s.children].filter((el) => CLIP_TAGS.has(el.localName)); });
const url = (src) => new URL(srcHref(src), location.href);
/* an editor's preview (`?film-missing=skip`) plays on past a clip whose file is not there: the clip keeps its time,
   but is neither loaded, drawn nor heard. Anything else (a check, an export) says the missing file and stops */
const SKIP_MISSING = new URL(location.href).searchParams.get('film-missing') === 'skip';
const ready = (a) => Promise.resolve(typeof a.ready === 'function' ? a.ready() : a.ready);

/** A gate that runs what is given to it when fewer than `most` of its runs are going. */
function gate(most) {
  let busy = 0;
  const waiting = [];
  return async (fn) => {
    if (busy >= most) await new Promise((go) => waiting.push(go));
    busy++;
    try { return await fn(); } finally { busy--; waiting.shift()?.(); }
  };
}
/* a browser opens about six connections to one server: more files asked at once only wait behind each other */
const limited = gate(6);

/**
 * Each media file's own length and picture size, read once (the clips of one recording share it); null: unreadable.
 * Asked as `?film-facts`: a host that plays a lighter copy in a file's place (a proxy) answers this with the file.
 */
const factsBySrc = new Map();
function factsOf(src) {
  const href = url(src).href;
  if (!factsBySrc.has(href)) {
    factsBySrc.set(href, limited(() => new Promise((ok) => {
      /* a video element reads a sound's length too; its file is let go once read */
      const m = document.createElement('video');
      m.preload = 'metadata'; m.muted = true;
      const done = (facts) => { m.removeAttribute('src'); m.load(); ok(facts); };
      m.onloadedmetadata = () => done({ duration: m.duration, w: m.videoWidth, h: m.videoHeight });
      m.onerror = () => done(null);
      const facts = new URL(href);
      facts.searchParams.set('film-facts', '1');
      m.src = facts.href;
    })));
  }
  return factsBySrc.get(href);
}

/**
 * Put a clip's element where film-doc's pictureRect says its picture lands in `box`. A page is drawn at its own size
 * (`c.nw` × `c.nh`) and scaled into place; a video or still is laid out at its box's size, so the file's CSS for it
 * (object-fit, border-radius, a mask) speaks in stage px. `c.w` × `c.h` is the element's own frame either way.
 * Everything that places it is written here, on the element itself: nothing in the file's CSS moves a clip.
 */
function place(c, box) {
  const at = pictureRect(c.kind, { w: c.nw, h: c.nh }, stage, box);
  const page = c.kind === 'page';
  c.w = page ? c.nw : at.w; c.h = page ? c.nh : at.h;
  const k = page ? ` scale(${at.w / c.nw}, ${at.h / c.nh})` : '';
  Object.assign(c.el.style, {
    position: 'absolute', left: '0', top: '0', right: 'auto', bottom: 'auto', margin: '0', translate: 'none', rotate: 'none', scale: 'none',
    width: c.w + 'px', height: c.h + 'px', transformOrigin: '0 0',
    transform: `translate(${at.x + at.w / 2}px, ${at.y + at.h / 2}px) rotate(${at.r}deg) translate(${-at.w / 2}px, ${-at.h / 2}px)${k}`,
  });
}

/**
 * A clip's own CSS on its element: only what changed, on the element as it is (rewritten whole, a playing video drops
 * the frame it shows). Its place is not in it: place() writes that.
 */
function wear(c, css) {
  if (c.css === css) return;
  /* its own opacity may change: the fade is taken off, its base read again, and put back at once (a frame between
     showed the clip whole where its fade has it faint, as an inspector's value is dragged) */
  unfade(c);
  c.base = undefined;
  const before = new Map(declarations(c.css)), after = new Map(declarations(css));
  for (const prop of before.keys()) if (!after.has(prop)) c.el.style.removeProperty(prop);
  for (const [prop, value] of after) if (before.get(prop) !== value) c.el.style.setProperty(prop, value.replace(/\s*!important\s*$/i, ''));
  c.css = css;
  refade(c);
}

/** A clip's look, as the file says it (its class and its own CSS), then its place and whether it shows. */
function dress(c, row) {
  if (!c.el) return;
  if ((c.el.getAttribute('class') ?? '') !== (row.class ?? '')) { unfade(c); c.base = undefined; c.el.setAttribute('class', row.class ?? ''); refade(c); }
  wear(c, row.style ?? '');
  if (c.kind === 'page' && !c.el.style.border) c.el.style.border = '0';
  c.el.style.zIndex = String(doc.tracks.length - c.ti); // track 0 on top
  /* a page coming on shows once it is drawn (see draw) */
  c.el.style.visibility = c.shown && !c.coming ? 'visible' : 'hidden';
  place(c, row.box);
}

/**
 * A clip's fades (SPEC §1): at `t` its picture shows `fadeGain` of its own opacity (its CSS's, `c.base`, read with
 * the fade off), set on its element with priority so no rule of the film's CSS hides it. Worked out from t alone.
 */
function fadeAt(c, t) {
  c.fadeT = t;
  const k = c.fade ? fadeGain(t - c.at, c.span.length, c.fade) : 1;
  if (k >= 1) { unfade(c); return; }
  if (c.base == null) { unfade(c); c.base = Number(getComputedStyle(c.el).opacity); }
  c.el.style.setProperty('opacity', String(c.base * k), 'important');
  c.faded = true;
}
/** The fade of a clip on screen, as at the moment it was last drawn (its look or its fades changed since). */
function refade(c) {
  if (c.shown && c.fadeT != null) fadeAt(c, c.fadeT);
}
/** The clip's own opacity back on its element, as its CSS says it. */
function unfade(c) {
  if (!c.faded) return;
  const own = new Map(declarations(c.css)).get('opacity');
  if (own) c.el.style.setProperty('opacity', own.replace(/\s*!important\s*$/i, ''));
  else c.el.style.removeProperty('opacity');
  c.faded = false;
}

/** `n` frames of the page's rendering: what was changed before is committed to the compositor. */
const frames = (n) => new Promise((done) => { const next = () => (--n > 0 ? requestAnimationFrame(next) : done()); requestAnimationFrame(next); });

const SAME_TIME = 1e-4; // s: a video's currentTime is kept to the microsecond, so a time set is read back a hair off
const PRESENT_MS = 1000; // how long a sought frame may take to be on screen before the seek is made again
const SEEK_TRIES = 3;

/**
 * Put a video on the frame at `t` and wait until that frame is the one on screen. `seeked` fires when the decoder
 * has the frame, not when the compositor shows it: captured right after, the picture is still the previous one
 * (often a stretch back, after a long seek), and the same t drew different pictures. The frame callback is the
 * moment the new frame is presented. Knowing how long the video's frames last (`frame`, from the host), the frame for t
 * is told by its time: the old frame, shown again as its video turns visible, is not taken for it, even after the seek
 * is done. Not knowing, a frame presented before the seek is done is taken for the old one when it is nearer where the
 * video was.
 */
async function showVideoAt(v, t, frame = null) {
  /* a seek still under way (the start a video was woken at, see wake): its `seeked` and its frame would be taken for
     this one's, and the picture captured was the earlier time's */
  if (v.seeking) await new Promise((done) => { v.addEventListener('seeked', done, { once: true }); setTimeout(done, 10000); });
  /* the same time again (to the microsecond the element keeps): no seek, nothing new to present (a seek there would
     present nothing, and the wait would run out) */
  if (!v.seeking && Math.abs(v.currentTime - t) < SAME_TIME && v.readyState >= 2) return;
  const before = v.currentTime;
  let sought = false;
  /* the frame a seek to t lands in starts at most a frame before t (and the seek goes a millisecond in, see host.mjs),
     with a quarter frame to spare for footage whose frames are not all as long; without the frame's length, the old
     frame is the one nearer where the video was than where it is sought (a frame there would look the same) */
  const right = (m) => (frame ? m <= t + 0.002 && t + 0.001 - m < frame * 1.25 : sought || Math.abs(m - t) <= Math.abs(m - before));
  const callback = typeof v.requestVideoFrameCallback === 'function';
  /* a seek made just after the file loaded can decode its frame and never present it (Chromium): the picture stays on
     the frame it had (the clip's first, where it was woken), however long it is waited for. Not presented in a
     moment, the seek is made again; the last try waits as long as a slow machine may need */
  for (let tries = 1; ; tries++) {
    const last = tries === SEEK_TRIES || !callback;
    let handle = 0;
    let timer = 0;
    const presented = callback
      ? new Promise((done) => {
        const next = () => { handle = v.requestVideoFrameCallback((now, meta) => { if (right(meta.mediaTime)) done(true); else next(); }); };
        next();
        timer = setTimeout(() => done(false), last ? 3000 : PRESENT_MS);
      })
      : null;
    /* again, half a millisecond on (the same frame): a seek to where the element already is may be skipped */
    v.currentTime = t + (tries - 1) * 0.0005;
    await new Promise((done) => {
      if (!v.seeking && v.readyState >= 2) { done(); return; }
      v.addEventListener('seeked', done, { once: true });
      v.addEventListener('loadeddata', done, { once: true });
      setTimeout(done, 10000);
    });
    sought = true;
    const shown = presented ? await presented : true;
    clearTimeout(timer);
    if (handle) v.cancelVideoFrameCallback?.(handle);
    if (shown || last) return;
  }
}

/**
 * Every video a page moved in its frame, until its new frame is on screen (SPEC §4: a host waits for pending seeks):
 * decoded (`seeked`), then presented (the frame callback), each with a time limit so a stalled video cannot hold the
 * film. A page's own footage is as exact as a video clip's.
 */
function mediaShown(page) {
  return Promise.all([...page.querySelectorAll('video')].map((v) => (v.seeking || v.readyState < 2 ? new Promise((done) => {
    const shown = () => (typeof v.requestVideoFrameCallback === 'function' ? (v.requestVideoFrameCallback(() => done()), setTimeout(done, 1000)) : done());
    v.addEventListener('seeked', shown, { once: true });
    v.addEventListener('loadeddata', shown, { once: true });
    setTimeout(done, 10000);
  }) : null)));
}

/*
 * While the film plays, a video plays by itself instead of being sought frame by frame (a seek decodes from the last
 * key frame: on a long one each frame costs more, and playback stutters). It is kept on the film's clock by its pace,
 * never by seeking while it is near: further off than ROLL_STEER (two frames running) it plays ROLL_NUDGE faster or
 * slower until it is back within ROLL_SETTLE, and only further off than ROLL_SEEK is it sought. The host says the film
 * plays (watch's `play`); a still moment or a scrub seeks (see glance). A video about to come on is sought ahead and
 * starts a moment before its cut, so it is running in step when it shows. When the film stops, every video stops; a
 * frame asked of window.film (an export's) is always exact.
 */
const ROLL_SEEK = 0.5;    // s: a playing video further off the film's clock than this is sought again
const ROLL_STEER = 0.04;  // s: further off than this, two frames running, its pace is nudged
const ROLL_SETTLE = 0.01; // s: back within this, it plays at its own pace again
const ROLL_NUDGE = 0.03;  // how much faster or slower a nudged video plays
const CUE_AHEAD = 1.5;    // s: how long before its clip starts a video is sought, ready
const PREROLL = 0.2;      // s: how long before its clip starts a video plays, hidden, to be in step at its cut
const START_LAG = 0.08;   // s: how long play() takes to get a video going
/** Keep a playing video at `want` as the film plays at `rate`: its pace nudged when it drifts, sought when far off. */
function roll(c, want, rate) {
  const v = c.el;
  const drift = v.currentTime - want;
  if (Math.abs(drift) > ROLL_SEEK || v.ended) { v.currentTime = want; c.steer = 0; c.off = 0; }
  else if (Math.abs(drift) > ROLL_STEER) { c.off = (c.off ?? 0) + 1; if (c.off >= 2) c.steer = drift > 0 ? -1 : 1; }
  else { c.off = 0; if (Math.abs(drift) < ROLL_SETTLE) c.steer = 0; }
  /* the pace is written only when it changes: each write is work for the media pipeline */
  const pace = (c.span.speed ?? 1) * rate * (1 + (c.steer ?? 0) * ROLL_NUDGE);
  if (Math.abs(v.playbackRate - pace) > 1e-4) v.playbackRate = pace;
  if (v.paused) v.play().catch((e) => { if (e?.name === 'NotAllowedError') c.held = true; });
  c.lastWant = want;
}
/**
 * A video the browser will not play here (an embedding app's autoplay rules): while the film plays it is stepped
 * instead, each frame sought without waiting for it, so the picture still moves. It is tried again after a pause.
 */
function step(c, want) {
  const v = c.el;
  c.lastWant = want;
  if (!v.seeking && Math.abs(v.currentTime - want) > 1 / 30) v.currentTime = want;
}
/**
 * A video on screen while a person looks at one moment or scrubs: sought, and waited for until its frame is decoded
 * (not until the compositor shows it: a seek within the frame on screen shows nothing new, and that wait would only
 * run out). The editor asks for the next moment once this one is drawn, so a scrub goes as fast as the decoder.
 */
async function glance(c, want) {
  const v = c.el;
  if (!v.paused) v.pause();
  c.lastWant = want;
  /* its file still loading: sought once it is, unless another moment was asked for meanwhile. Sought even when it
     loaded right there (its first second): a paused video's first frame may not be painted by itself (one loaded
     while its page was hidden or transparent, as Studio's preview loading behind the picture), and the picture
     stayed black until the playhead moved */
  let justLoaded = false;
  if (v.readyState < 2) {
    await wake(c);
    if (c.lastWant !== want || !c.awake) return;
    justLoaded = true;
  }
  if (!justLoaded && !v.seeking && Math.abs(v.currentTime - want) < SAME_TIME && v.readyState >= 2) return;
  v.currentTime = want;
  await new Promise((done) => {
    if (!v.seeking && v.readyState >= 2) { done(); return; }
    v.addEventListener('seeked', done, { once: true });
    v.addEventListener('loadeddata', done, { once: true });
    setTimeout(done, 3000);
  });
}
/**
 * A video whose clip starts `lead` film seconds from now, the film playing at `rate`: sought ahead (to PREROLL before
 * its first frame), started a moment before that point comes (play() takes a moment to get going), then kept in step
 * until its cut.
 */
function getReady(c, lead, rate) {
  const v = c.el;
  const speed = c.span.speed ?? 1;
  const first = sourceAt(c.span, 0, c.row);
  const cue = Math.max(0, first - PREROLL * speed);
  const rolling = (first - cue) / speed; // the lead at which the video is at `cue`
  if (lead < rolling) { roll(c, first - lead * speed, rate); return; }
  if (c.cued !== cue || c.lastWant !== cue) {
    if (!v.paused) v.pause();
    v.currentTime = cue;
    c.cued = c.lastWant = cue;
  }
  if (lead < rolling + START_LAG * rate && v.paused && !v.seeking && !c.held) {
    v.playbackRate = speed * rate;
    v.play().catch((e) => { if (e?.name === 'NotAllowedError') c.held = true; });
  }
}
function stopRolling() {
  for (const c of clips) {
    if (c.kind !== 'video') continue;
    if (!c.el.paused) c.el.pause();
    c.steer = 0; c.off = 0;
  }
  stopPageFootage();
}

/*
 * A page's own footage while the film plays. A page draws a video by setting its currentTime to the frame it wants and
 * waiting for that frame (SPEC §4): exact, as an export needs, but while the film plays each of those seeks decodes
 * from the last key frame, and a page showing a few videos plays them at a few frames a second. So while the film
 * plays, a video whose wanted times move on at a steady pace is played instead, at that pace, and kept on them as the
 * film's own videos are (see roll); the page is told each seek landed at once (currentTime reads what it asked, and
 * nothing is seeking). A jump, a held frame or a reverse is sought as asked, and when the film stops each such video
 * is sought exactly where its page last asked, so a still frame is as exact as ever. The page changes nothing.
 */
/** the film playing (`rate`, `now` as in draw's `play`) at the frame being drawn (`t`), or null */
let footagePlay = null;
/** which frame a person watching is being drawn (counted), or 0 for an exact one (an export's) */
let footageFrame = 0;
let footageFrames = 0;
/** each page video asked for a time while a person watches: where, at which frame and film second it was asked last,
    its pace, whether it plays by itself */
const footage = new WeakMap();
/** the page videos playing by themselves now */
const footageRolling = new Set();
const FOOTAGE_IDLE = 0.6; // film s: a playing page video not asked for this long is stopped (its page went off)

/** A task soon (a seek's events come as tasks, after whatever the page does next in its own turn). */
const soon = (() => {
  const channel = new MessageChannel();
  const queue = [];
  channel.port1.onmessage = () => queue.shift()?.();
  return (fn) => { queue.push(fn); channel.port2.postMessage(0); };
})();
/** `seeked`s said for a seek not made, a frame: a page asking again for a frame it gave up on is not answered on and on */
const SAID_MOST = 2;

/** Take over the time a page's videos are asked for (once a page): see above. */
function steerFootage(win) {
  const proto = win.HTMLMediaElement?.prototype;
  if (!proto || Object.hasOwn(proto, '__filmFootage')) return;
  const own = Object.getOwnPropertyDescriptor(proto, 'currentTime');
  Object.defineProperty(proto, '__filmFootage', { value: true });
  Object.defineProperty(proto, 'currentTime', {
    configurable: true, enumerable: true,
    get() { const f = footage.get(this); return f?.rolling ? f.want : own.get.call(this); },
    set(value) {
      const how = footageAsked(this, Number(value), own, win);
      if (how === 'seek') { own.set.call(this, value); return; }
      if (how === 'drop') return;
      /* the page waits for its seek as for any (SPEC §4): it lands at once, said as a seek is */
      const f = footage.get(this);
      if (f.said.seq !== f.seq) f.said = { seq: f.seq, n: 0 };
      if (++f.said.n > SAID_MOST) return;
      soon(() => this.dispatchEvent(new win.Event('seeked')));
    },
  });
}

/**
 * A page asks for its video `v` at `want` (media seconds): 'seek' to seek as asked; 'play' when it plays on there by
 * itself (the page is told its seek landed); 'drop' for an ask of a frame given up on (see below), neither sought nor
 * answered. `own`: the page's own currentTime, before this one took it over.
 */
function footageAsked(v, want, own, win) {
  const play = footagePlay;
  const frame = footageFrame;
  const f = footage.get(v);
  if (!frame || !(v instanceof win.HTMLVideoElement) || !Number.isFinite(want)) { footageStop(v, false); return 'seek'; }
  if (!f) { footage.set(v, { own, want, t: play?.t ?? null, seq: frame, pace: null, rolling: false, steer: 0, off: 0, said: { seq: null, n: 0 } }); return 'seek'; }
  if (f.seq === frame) {
    /* asked again within the same frame for the same time: the page making sure */
    if (Math.abs(want - f.want) < 1e-6) return f.rolling ? 'play' : 'seek';
    /* for another time, once this frame asked: an earlier frame's wait, left when the host gave up on that frame
       (a slow seek while playing or scrubbing), asking for that frame's time when a seek of this one lands. Sought,
       it would undo this frame's, which would ask again, and so on: the first ask of a frame stands */
    return 'drop';
  }
  f.seq = frame;
  /* a later frame, still: sought as asked */
  if (!play) { f.want = want; f.t = null; f.pace = null; return 'seek'; }
  /* playing: how far on the film went since the last ask, and the video with it */
  const dt = f.t == null ? 0 : play.t - f.t;
  const pace = dt > 0 ? (want - f.want) / dt : 0;
  /* moving on at a pace a video can play at, the same as the frame before: it plays (or plays on) at that pace. A gap
     between asks is a jump, unless it went on playing meanwhile (under a render, see playRenders) */
  const steady = pace > 0.0625 && pace < 16 && (dt < 0.5 || f.rolling) && f.pace != null && Math.abs(pace - f.pace) <= 0.02 * f.pace;
  f.t = play.t;
  f.pace = pace;
  if (!steady || v.readyState < 2) { footageStop(v, false); f.want = want; return 'seek'; }
  f.want = want;
  /* where it should be this moment: the frame asked is the one on its way to the screen, a moment from now */
  const expected = Math.max(0, want - pace * (play.t - play.now));
  const drift = own.get.call(v) - expected;
  if (!f.rolling) {
    own.set.call(v, expected);
    f.rolling = true;
    f.steer = 0; f.off = 0;
    footageRolling.add(v);
  } else if (Math.abs(drift) > ROLL_SEEK || v.ended) {
    own.set.call(v, expected);
    f.steer = 0; f.off = 0;
  } else if (Math.abs(drift) > ROLL_STEER) { f.off += 1; if (f.off >= 2) f.steer = drift > 0 ? -1 : 1; }
  else { f.off = 0; if (Math.abs(drift) < ROLL_SETTLE) f.steer = 0; }
  const rate = pace * play.rate * (1 + f.steer * ROLL_NUDGE);
  if (Math.abs(v.playbackRate - rate) > 1e-4) v.playbackRate = rate;
  /* a page has no sound (SPEC: every sound is a clip): never heard */
  v.muted = true;
  if (v.paused) v.play().catch(() => footageStop(v));
  return 'play';
}

/**
 * A page video that played by itself stops, sought exactly to where its page last asked (not with `seek` false: the
 * page is seeking it itself now).
 */
function footageStop(v, seek = true) {
  const f = footage.get(v);
  if (!f?.rolling) return;
  f.rolling = false;
  f.pace = null;
  footageRolling.delete(v);
  if (!v.paused) v.pause();
  if (seek) f.own.set.call(v, f.want);
}

/** The film stopped: every page video playing by itself stops where it was asked last. */
function stopPageFootage() {
  footagePlay = null;
  for (const v of [...footageRolling]) footageStop(v);
}

/** While playing: a page video no frame asked for lately (its page went off, or stopped showing it) stops. */
function idleFootage(t) {
  for (const v of [...footageRolling]) if (t - footage.get(v).t > FOOTAGE_IDLE) footageStop(v);
}

/*
 * Renders: stretches of the film an editor had rendered into a video because they played late (Studio's preview
 * renders), given as `{ a, b, src }`. While the film plays through one, its video plays above everything, kept on the
 * film's clock as a video clip is; the clips under it are drawn only a few times a second, out of sight, and every
 * frame again just before it ends, so they are on screen as it ends. Stopped, the film is drawn as ever and the render
 * goes once that is on screen. A film exported or looked at has none.
 */
const renders = [];
const RENDER_HANDOVER = 0.5; // s: how long before a render ends the clips under it are drawn every frame again
const RENDER_WARM = 0.25;    // s: before that, they are drawn this often, out of sight (see draw)
/** the film second the clips under a render were last drawn at */
let warmAt = -Infinity;
/** the render playing now, or null */
let renderOn = null;

/** The renders the film has now (each a video clip of its own, kept while it is the same stretch of the same file). */
function setRenders(list) {
  const kept = new Map(renders.map((r) => [`${r.row.src}\0${r.at}\0${r.end}`, r]));
  const next = [];
  for (const { a, b, src } of list) {
    const key = `${src}\0${a}\0${b}`;
    const had = kept.get(key);
    if (had) { kept.delete(key); next.push(had); continue; }
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.preload = 'none';
    Object.assign(el.style, { position: 'absolute', left: '0', top: '0', margin: '0', objectFit: 'fill', visibility: 'hidden', pointerEvents: 'none' });
    document.body.append(el);
    next.push({ kind: 'video', id: `render ${a}-${b}`, el, at: a, end: b, span: { from: 0, to: b - a, speed: 1, length: b - a }, row: { src }, awake: null });
  }
  for (const r of kept.values()) { r.el.pause(); r.el.removeAttribute('src'); r.el.load(); r.el.remove(); if (renderOn === r) renderOn = null; }
  renders.splice(0, renders.length, ...next);
}

/**
 * While playing (`play`), at frame t: the render the film is in plays and shows, one coming up gets ready. True when
 * the clips are not to be drawn this frame (a render covers them, not near its end).
 */
function playRenders(t, play) {
  const on = play ? renders.find((r) => play.now >= r.at && play.now < r.end) ?? null : null;
  for (const r of renders) {
    Object.assign(r.el.style, { width: stage.w + 'px', height: stage.h + 'px', zIndex: String(doc.tracks.length + 1) });
    if (r === on) continue;
    if (play && r.at > play.now && r.at - play.now < WAKE_AHEAD * play.rate) {
      if (!r.awake) { r.el.preload = 'auto'; r.el.src = r.row.src; r.awake = true; }
      if (r.at - play.now < CUE_AHEAD * play.rate) getReady(r, r.at - play.now, play.rate);
      continue;
    }
    if (!r.el.paused) r.el.pause();
    /* far from where the film plays: its file let go, as a video clip's (see near) */
    if (r.awake && play && (r.at - play.now > KEEP || play.now - r.end > KEEP)) { r.el.removeAttribute('src'); r.el.load(); r.awake = null; }
  }
  if (!on) { renderOn = null; return false; }
  if (!on.awake) { on.el.preload = 'auto'; on.el.src = on.row.src; on.awake = true; }
  roll(on, play.now - on.at, play.rate);
  if (on.el.readyState < 2) { renderOn = null; return false; }
  /* the clips under it are not drawn, but their videos play on, out of sight: paused, a page's many would be let go
     by the browser (it suspends paused players past a few), and at the render's end each is still in step */
  renderOn = on;
  on.el.style.visibility = 'visible';
  return t < on.end - RENDER_HANDOVER;
}
/** The renders but `keep` go from the screen (the film drawn under them is all there). */
function hideRenders(keep = null) {
  for (const r of renders) {
    if (r === keep) continue;
    if (r.el.style.visibility !== 'hidden') r.el.style.visibility = 'hidden';
    if (!r.el.paused) r.el.pause();
  }
}

/*
 * A video holds its file only near the playhead: a film of a hundred clips does not open a hundred files (a browser
 * loads a few at a time, and each one held keeps a decoder and its buffers). Every frame drawn wakes the videos on at
 * t, then the ones about to come on, nearest first; one far from t lets its file go. A frame waits for its own
 * videos to be loaded, so an export's frame is as exact as ever.
 */
const WAKE_AHEAD = 4;   // s: a video this close to coming on is given its file (more than CUE_AHEAD)
const WAKE_BEHIND = 1;  // s: and one that went off this recently keeps it (a scrub back)
const KEEP = 12;        // s: one further than this from t lets its file go
const AWAKE_MAX = 12;   // videos holding their files at once, besides those on at t
const LOAD_MS = 30_000; // how long an export's frame waits for a video's file before that is an error

/**
 * Give a video its file; for an exact frame, to start at its source second `from`. Resolves once its first frame is
 * there (or it failed: a frame of it then shows nothing). A page is opened (see wakePage).
 */
function wake(c, from = null) {
  if (c.awake) return c.awake;
  if (c.kind === 'page') return wakePage(c);
  const v = c.el;
  v.preload = 'auto';
  /* without the fragment: which seconds play is the film's to keep (a browser would stop the video at its end) */
  v.src = url(c.row.src).href;
  /* an exact frame's video loads at that frame: one sought at once after loading can stay on its first frame
     (Chromium). Not while a person watches: a start set before loading stalls the whole picture for a moment */
  if (from > 0) v.currentTime = from;
  c.awake = new Promise((done) => {
    v.addEventListener('loadeddata', () => done(), { once: true });
    v.addEventListener('error', () => done(), { once: true });
  });
  return c.awake;
}

/** Let a video's file go: its decoder and buffers are freed. A page is closed (see restPage). */
function rest(c) {
  if (c.kind === 'page') { restPage(c); return; }
  const v = c.el;
  if (!v.paused) v.pause();
  v.preload = 'none';
  if (v.hasAttribute('src')) { v.removeAttribute('src'); v.load(); }
  c.awake = null;
  c.lastWant = c.cued = undefined;
  c.held = false;
}

/*
 * A page is open only near the playhead too, once a film has more of them than PAGES_AWAKE: each open page keeps its
 * document, its libraries and its canvases, and a browser keeps only 16 WebGL contexts at once (more, and the oldest
 * page's 3D goes blank). A film of fewer pages keeps them all open, as loaded. A page opened again is the same page:
 * a frame is a function of t (SPEC §3), so it draws what it drew before.
 */
const PAGES_AWAKE = 8;
/* pages opening at once: with PAGES_AWAKE open, no more WebGL contexts than a browser keeps */
const pageLimited = gate(4);
/** the pages open now (or opening) */
const pagesAwake = new Set();

/**
 * Open a page clip's file and wait for its window.film to be ready. Rejects when the page is not a film; resolves
 * without opening when it was let go meanwhile (see restPage).
 */
function wakePage(c) {
  const mine = c.waking = {};
  c.awake = pageLimited(async () => {
    if (c.waking !== mine) return;
    const el = c.el;
    /* a film is a picture, never scrolled: a page a little larger than its frame shows no scrollbars (some browsers
       always draw them; exports draw none) */
    el.setAttribute('scrolling', 'no');
    /* still open (closed while it loaded, see restPage): taken up again as it is; else the document there now
       (blank) is not the page's, and its window.film, if any, is gone once the page commits */
    const href = url(c.row.src).href;
    const before = el.getAttribute('src') === href ? null : el.contentDocument;
    if (before) el.src = href;
    const t0 = performance.now();
    const film = () => (el.contentDocument !== before ? el.contentWindow?.film : null);
    while (!(film() && typeof film().frame === 'function')) {
      if (c.waking !== mine) return;
      if (performance.now() - t0 > 10000) throw new Error(`${c.row.src}: window.film with a frame() function did not appear`);
      await new Promise((r) => setTimeout(r, 20));
    }
    const win = el.contentWindow;
    await ready(win.film);
    if (c.waking !== mine) return;
    steerFootage(win);
    c.win = win;
    c.child = win.film;
    c.touched = new Map();
    c.drawn = false;
    /* its own size, when it says one (else its clip's size, or the stage's: see settle) */
    if (c.child.width > 0 && c.child.height > 0) c.own = { w: c.child.width, h: c.child.height };
    window.__filmEditor.stage.woke?.();
  });
  pagesAwake.add(c);
  /* one woken ahead and not waited for: its failure is said when a frame of it is drawn */
  c.awake.catch(() => {});
  return c.awake;
}

/**
 * Close a page clip's document: its length and size stay known, its tweaks are put on again when it opens. Closed once
 * its own files are in: a request cut short is a failed one, which a host reports.
 */
function restPage(c) {
  pagesAwake.delete(c);
  c.awake = c.waking = null;
  c.win = c.child = null;
  c.drawn = false;
  c.touched = new Map();
  const el = c.el;
  const close = () => { if (!c.awake && el.isConnected) el.setAttribute('src', 'about:blank'); };
  if (!el.hasAttribute('src') || el.contentDocument?.readyState === 'complete') close();
  else el.addEventListener('load', close, { once: true });
}

/**
 * Wake the videos and pages near t (those on at t always), and let those far from it rest. `only`: wake only those on
 * at t, and let none rest unless far too many are awake (a scrub: the rest is done once it stops, see draw). `exact`:
 * for an exact frame (an export's), each video woken at the frame it is wanted at.
 */
function near(t, { only = false, exact = false } = {}) {
  nearOf('video', AWAKE_MAX, t, only, exact);
  nearOf('page', PAGES_AWAKE, t, only, exact);
}
function nearOf(kind, max, t, only, exact) {
  const off = (c) => (t < c.at ? c.at - t : t >= c.end ? t - c.end : 0);
  const all = clips.filter((c) => c.kind === kind);
  const wanted = all
    .filter((c) => !c.hidden && !c.missing && (only ? off(c) === 0 : t < c.at ? c.at - t <= WAKE_AHEAD : t - c.end <= WAKE_BEHIND))
    .sort((a, b) => off(a) - off(b));
  const on = wanted.filter((c) => off(c) === 0).length;
  const keep = new Set(wanted.slice(0, Math.max(on, max)));
  for (const c of keep) wake(c, exact && kind === 'video' ? sourceAt(c.span, Math.min(Math.max(0, t - c.at), c.span.length), c.row) : null);
  /* the rest: videos far off rest, and the farthest while too many are awake (pages: only then, and never more than
     max, a scrub's included) */
  const most = only && kind === 'video' ? 2 * max : max;
  const awake = all.filter((c) => c.awake && !keep.has(c)).sort((a, b) => off(b) - off(a));
  let over = keep.size + awake.length - most;
  for (const c of awake) {
    /* one an edit is putting on screen (see cue) stays awake, wherever it is now */
    if (cueing.has(c)) continue;
    if ((kind === 'video' && !only && (c.hidden || off(c) > KEEP)) || over > 0) { rest(c); over--; }
  }
}
/** a scrub's last moment, its neighbors woken (and the far ones let go) once it stops */
let settleNear = 0;
/** the moment last drawn (or being drawn): what an edit puts on there is made ready before the edit shows */
let shownT = null;
/** clips being made ready for an edit (see cue): their files are not let go meanwhile */
const cueing = new Set();
/** how long an edit waits for what it puts on screen; then it shows anyway, the rest drawn as it comes */
const CUE_MS = 5000;

/** @type {Map<string, Promise<number | null>>} */
const frameLengths = new Map();
/**
 * How long a video clip's frames last, as the host that serves the film says (host.mjs, from ffprobe); null from a
 * server that cannot tell. Asked once a file.
 */
function frameOf(c) {
  const src = url(c.row.src);
  /* a video from another site: not the host's to say */
  if (src.origin !== location.origin) return Promise.resolve(null);
  if (!frameLengths.has(src.pathname)) {
    frameLengths.set(src.pathname, fetch(new URL(`__film/frame-duration?of=${encodeURIComponent(src.pathname)}`, location.href))
      .then((r) => (r.ok ? r.json() : null)).then((said) => (said?.seconds > 0 ? said.seconds : null)).catch(() => null));
  }
  return frameLengths.get(src.pathname);
}

/** Wait for a video's file for an exact frame: too long is the film's error, said by the clip. */
function loaded(c) {
  let timer;
  const late = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`clip "${c.id}" (${c.src}): its video did not load within ${LOAD_MS / 1000} s`)), LOAD_MS);
  });
  return Promise.race([wake(c), late]).finally(() => clearTimeout(timer));
}

/**
 * Every clip of the film, as loaded: its element, its source's own length (`native`) and picture size, and what
 * film.html says of it now (`row`). A sound has no element. `sounds` is worked out from these, so an edit to a clip's
 * fields is applied by changing its record (see update).
 */
const clips = [];
const sounds = [];

/** A clip's timing, volume and placement from its film.html row (its source already loaded). */
function settle(c, row, track, ti) {
  const where = `clip "${row.id}" (${row.src})`;
  c.row = row;
  c.ti = ti;
  c.track = ti;
  c.at = row.at ?? 0;
  /* a hidden track's clips are loaded (an editor shows them, grayed) but neither drawn nor heard */
  c.hidden = Boolean(track.hidden);
  c.volume = track.muted || c.hidden || c.missing ? 0 : (row.volume ?? 1);
  c.span = clipSpan(row, c.native, where);
  c.end = c.at + c.span.length;
  c.fade = fittedFade(clipFade(row), c.span.length);
  /* a page that sets no size of its own is laid out at its clip's size, else the stage's */
  if (c.kind === 'page') { const own = c.own ?? row.size ?? stage; c.nw = own.w; c.nh = own.h; }
  dress(c, row);
  /* the tweaks of a page's elements (the clip's own entry, its fades, is not one) */
  const tweaks = row.overrides?.filter((o) => o.at !== undefined);
  if (c.kind === 'page' && JSON.stringify(c.overrides ?? []) !== JSON.stringify(tweaks ?? [])) {
    restore(c);
    c.overrides = tweaks?.length ? tweaks : undefined;
  }
}

/** The film's sound: each sound clip's and each video's own, placed where its clip sits (`clip`: whose). */
function hear() {
  sounds.length = 0;
  for (const c of clips) {
    if (c.volume <= 0 || (c.kind !== 'sound' && c.kind !== 'video')) continue;
    sounds.push({ clip: c.id, src: url(c.row.src).pathname, at: c.at, from: c.span.from, to: c.span.to, volume: c.volume, speed: c.span.speed,
      ...(c.fade ? { fade: c.fade } : {}) });
  }
}

/**
 * A clip's file has to be there: a missing one is said at once, by its name (not as a page that never answered).
 * In an editor's preview (SKIP_MISSING) it is not an error: false, and the clip is played as missing.
 */
async function mustBeThere(src) {
  const res = await fetch(url(src), { method: 'HEAD' }).catch(() => null);
  if (!(res && res.status === 404)) return true;
  if (SKIP_MISSING) return false;
  throw new Error(`${src}: there is no such file`);
}

/** Clips loaded so far: what a host waiting for `ready` sees moving (see host.mjs). */
let progress = 0;

/**
 * Take over one clip's element (`el`, the file's own, or one an update made): read its source and make its record.
 * A video's file is read for its length and size only; it loads when the playhead comes near (see near).
 */
async function load(row, track, ti, el) {
  const kind = kindOf(row);
  /* the element's own style as the file wrote it, its place (left, top…) included: place() writes over that */
  const c = { kind, id: row.id, src: row.src, track: ti, el, node: el, touched: new Map(), found: [], drawn: false, shown: false, css: el.getAttribute('style') ?? '' };
  if (kind === 'sound') {
    /* a sound is heard in the mix (see hear), never by its element */
    el.pause?.();
    el.preload = 'none';
    c.el = null;
    const facts = await factsOf(row.src);
    if (!facts && !(await mustBeThere(row.src))) c.missing = true;
    c.native = facts?.duration ?? 0;
  } else if (kind === 'still') {
    /* its file as the film names it: a name written with a bare `?` or `%` asks the browser for another file */
    const href = url(row.src).href;
    if (el.src.replace(/#.*$/, '') !== href) el.src = href;
    await el.decode().catch(() => {});
    if (!el.naturalWidth && !(await mustBeThere(row.src))) c.missing = true;
    c.nw = el.naturalWidth || stage.w; c.nh = el.naturalHeight || stage.h;
  } else if (kind === 'video') {
    el.muted = true; el.playsInline = true;
    rest(c);
    const facts = await factsOf(row.src);
    if (!facts && !(await mustBeThere(row.src))) c.missing = true;
    c.native = facts?.duration ?? NaN;
    c.nw = facts?.w || stage.w; c.nh = facts?.h || stage.h;
  } else if (!(await mustBeThere(row.src))) {
    /* a page that is not there: its clip keeps its time, at the stage's size */
    c.missing = true;
    c.nw = stage.w; c.nh = stage.h;
  } else {
    /* opened to read its length (the host serves it unopened, see holdPages; filmStart gives it the stage's size) */
    c.row = row;
    await wakePage(c);
    /* a page without a duration has no end: its clip's #t= is its length, as a still's */
    const length = c.child.duration;
    c.native = Number.isFinite(length) && length > 0 ? length : undefined;
    /* more pages than are kept open: the ones read later close again until the playhead comes near (see near) */
    if ([...pagesAwake].filter((p) => p.child).length > PAGES_AWAKE) restPage(c);
  }
  settle(c, row, track, ti);
  progress++;
  return c;
}

/**
 * Load clips side by side (a few files at a time, see limited) and give their records in file order; a clip that
 * fails is said, the first one in the file's order when several do.
 */
async function loadAll(list) {
  const settled = await Promise.allSettled(list.map(({ row, track, ti, el }) => load(row, track, ti, el)));
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((s) => s.value);
}

/* window.film is there at once and `ready` is the loading: a film of many pages (each with its own libraries and
   fonts from the network) takes longer to load than a host waits for the object to appear. Ready is every clip's
   length and place known and every page ready; a video's picture loads when a frame needs it. */
const loading = (async () => {
  clips.push(...await loadAll(doc.tracks.flatMap((track, ti) => track.clips.map((row, ci) => ({ row, track, ti, el: elements[ti][ci] })))));
  hear();
})();
/* a film that cannot load (a clip with no length, a missing file) is the host's to report, once, when it awaits
   `ready`: until it does, that is not an error nobody handled */
loading.catch(() => {});

/** the latest frame drawn for a person watching: an earlier one that finishes after it does not change what shows */
let watched = 0;

/**
 * Draw the film at t. `live`: a person is watching (an editor, or the film opened as a page), so a scrub's frame does
 * not wait for its video to be on screen; otherwise the frame is exact (an export's, `look`'s). `play`: the film is
 * playing, `rate` film seconds a second, and is at film second `now` this moment (t is the frame on its way to the
 * screen, a moment later): videos play by themselves, kept on that clock; without it, every video stops.
 */
async function draw(t, live, play = null) {
  shownT = t;
  const playing = live && play != null;
  if (!playing) stopRolling();
  clearTimeout(settleNear);
  if (live && !playing) { near(t, { only: true }); settleNear = setTimeout(() => near(t), 250); } else near(t, { exact: !live });
  /* watched, a page coming on shows once its frame is drawn, and the pictures going off stay until then: shown first,
     it showed what it held before (its own first state, or the frame it drew the last time it was on) for as long as
     its frame took, a flash at the cut. An exact frame is taken when all of it is drawn, so it shows each at once. */
  const turn = live ? ++watched : 0;
  const coming = [], going = [];
  /* a render of this stretch plays instead of the clips (see setRenders). Under it they are drawn a few times a
     second, out of sight: what a page loads as it goes (its footage, its pictures) comes as it would, not all at once
     as the render ends, and its footage goes on playing in step */
  if (live && playRenders(t, playing ? play : null) && Math.abs(t - warmAt) < RENDER_WARM) return;
  warmAt = t;
  /* the pages' footage plays by itself while the film does (see steerFootage) */
  footageFrame = live ? ++footageFrames : 0;
  footagePlay = playing ? { rate: play.rate, now: play.now, t } : null;
  try {
    await Promise.all(clips.map((c) => drawClip(c, t, live, playing ? play : null, turn, coming, going)));
    if (playing) idleFootage(t);
  } finally {
    /* the film drawn: a render not playing now goes */
    hideRenders(playing ? renderOn : null);
    for (const c of coming) if (c.coming === turn) c.coming = 0;
    if (live && turn === watched) {
      for (const c of going) if (!c.shown) c.el.style.visibility = 'hidden';
      for (const c of coming) if (c.shown) c.el.style.visibility = 'visible';
    }
  }
}

/** One clip's part of a frame (see draw): a page coming on while watched is put in `coming`, a picture going off in `going`. */
async function drawClip(c, t, live, play, turn, coming, going) {
  if (c.kind === 'sound') return;
  const on = !c.hidden && !c.missing && t >= c.at && t < c.end;
  c.shown = on;
  const appears = on && c.el.style.visibility !== 'visible';
  if (live && appears && c.kind === 'page') { c.coming = turn; coming.push(c); }
  else if (live && !on && c.el.style.visibility === 'visible') going.push(c);
  else c.el.style.visibility = on ? 'visible' : 'hidden';
  if (on) fadeAt(c, t);
  if (!on) {
    if (c.kind !== 'video') return;
    if (play && c.awake && c.at > t && c.at - play.now < CUE_AHEAD * play.rate) getReady(c, c.at - play.now, play.rate);
    else { if (!c.el.paused) c.el.pause(); c.lastWant = c.cued = undefined; }
    return;
  }
  if (c.kind === 'still') return;
  if (c.kind === 'video') {
    if (play) {
      /* where it should be this moment (not at the frame on its way): its own clock runs on to that frame */
      const playing = sourceAt(c.span, Math.min(Math.max(0, play.now - c.at), c.span.length), c.row);
      if (c.held) step(c, playing); else roll(c, playing, play.rate);
      return;
    }
    const want = sourceAt(c.span, t - c.at, c.row);
    c.held = false;
    if (live) { await glance(c, want); return; }
    if (!c.el.paused) c.el.pause();
    c.lastWant = want;
    await loaded(c);
    /* a video coming on: shown before it is sought. A frame made current in the moment it turns visible is said to
       be presented, yet the picture keeps the frame it had for a second or so (Chromium, its frames sent apart from
       the page's): the same t drew two pictures */
    if (appears) await frames(2);
    await showVideoAt(c.el, want, await frameOf(c));
    return;
  }
  /* a page closed while the playhead was far (see near): opened again, then drawn; one that will not open is the
     film's error in an exact frame, and shows nothing to a person watching */
  if (!c.child) {
    try { await wake(c); } catch (e) { if (live) return; throw new Error(`clip "${c.id}" (${c.src}): ${e?.message ?? e}`); }
    if (!c.child || !c.shown) return;
  }
  const local = sourceAt(c.span, t - c.at, c.row, c.native);
  c.win.filmHost?.time?.(local);
  /* a page's error says which clip and which of its own seconds, not only the film's t */
  try { await c.child.frame(local); }
  catch (e) { throw new Error(`clip "${c.id}" (${c.src}) at its ${Number(local.toFixed(3))}s: ${e?.message ?? e}`); }
  c.win.filmHost?.settle?.(local);
  if (!live) await mediaShown(c.win.document);
  c.drawn = true;
  override(c, c.preview ?? c.overrides);
}

window.film = {
  get duration() { return Math.max(0.001, ...clips.filter((c) => !c.hidden).map((c) => c.end)); },
  width: stage.w, height: stage.h,
  ready: loading,
  frame(t) { return draw(t, false); },
};

/* for every tool that plays the film's sound (render, look, Studio's preview and exports): what is heard, where, how
   loud; `src` is a path on the film's origin */
window.__filmSounds = () => sounds;
/* for a host waiting for `ready`: how many clips have loaded, so a long film still loading is told from a stuck one */
window.__filmProgress = () => progress;
/* for `look`: where each picture starts, to check the picture is there */
window.__filmCuts = () => clips.filter((c) => c.kind !== 'sound' && !c.hidden).map((c) => ({ id: c.id, src: c.src, at: c.at, end: c.end }));
/* for an editor: where every clip sits on the film, sounds included, in seconds, its source's own length and picture
   size (a page's width × height, a video's frame, a still's pixels; none for a sound), whether it is a page that sets
   no size of its own (`reflows`: laid out at its clip's size, else the stage's), and how a picture looks */
window.__filmSpans = () => clips.map((c) => ({
  id: c.id, src: c.src, track: c.track, at: c.at, end: c.end, native: Number.isFinite(c.native) ? c.native : null,
  ...(c.kind !== 'sound' && c.nw > 0 && c.nh > 0 ? { w: c.nw, h: c.nh } : {}),
  ...(c.kind === 'page' && !c.own ? { reflows: true } : {}),
  ...(c.el ? { look: lookOf(c) } : {}),
}));
/**
 * How a picture looks as all of the film's CSS for it makes it (its classes and its own style): what an editor shows.
 * Its opacity is its own, not as a fade has it now.
 */
function lookOf(c) {
  const css = getComputedStyle(c.el);
  return {
    fit: css.objectFit, position: css.objectPosition, radius: css.borderTopLeftRadius, opacity: c.faded && c.base != null ? String(c.base) : css.opacity,
    blend: css.mixBlendMode, clip: css.clipPath, filter: css.filter,
  };
}
/* for `look`: the person's tweaks inside pages, whether each still finds its element in the frames drawn, and fades */
window.__filmOverrides = () => clips.filter((c) => (c.overrides?.length || c.fade) && !c.hidden).map((c) => ({
  id: c.id, src: c.src, drawn: c.drawn, overrides: (c.overrides ?? []).map((o, i) => ({ ...o, found: Boolean(c.found[i]) })),
  ...(c.fade ? { fade: clipFade(c.row) } : {}),
}));

/* ── for an editor: change the film in place, find what is under a point, show a tweak before it is kept ── */

/** A clip's element as film.html holds it (film-doc's clipTag), for a clip an edit added; its file is not loaded yet. */
function element(row) {
  const shell = document.createElement('template');
  shell.innerHTML = clipTag(row);
  const el = document.importNode(shell.content.firstElementChild, true);
  if (el.localName === 'video' || el.localName === 'audio') el.preload = 'none';
  /* a page opens when it is loaded (see wakePage), a few at a time */
  if (el.localName === 'iframe') el.removeAttribute('src');
  /* out of sight until it is placed and drawn: a page loading would show at its own size in the corner */
  el.style.visibility = 'hidden';
  return el;
}

/** Track `ti`'s section; one more is made after the last for a track the film did not have when it loaded. */
function sectionOf(ti, track) {
  while (sections.length <= ti) {
    const s = document.createElement('section');
    for (const flag of ['hidden', 'muted', 'locked']) if (track[flag] && sections.length === ti) s.setAttribute(flag, '');
    s.style.display = 'contents';
    if (sections.length) sections.at(-1).after(s); else document.body.append(s);
    sections.push(s);
  }
  return sections[ti];
}

/**
 * The film after an edit, changed in place: clips kept (by id, with the same source) take their new fields, clips
 * added get elements and load (a video's file only once the playhead comes near), clips gone are taken out. False
 * when the film has to be loaded again: another head (its styles), or a clip that cannot load (that says why). Another
 * stage is changed in place too (reshape).
 */
async function change(value, look) {
  if (look != null && styleOf(look) !== head) return false;
  const next = parseFilm(value);
  const rows = next.tracks.flatMap((track, ti) => track.clips.map((row) => ({ row, track, ti })));
  const byId = new Map(clips.map((c) => [c.id, c]));
  const kept = (row) => { const c = byId.get(row.id); return c && c.src === row.src && c.kind === kindOf(row) ? c : null; };
  /* each new element right after the one before it on its track, where that one is */
  const fresh = [];
  let before = null;
  rows.forEach(({ row, track, ti }, i) => {
    if (i === 0 || rows[i - 1].ti !== ti) before = null;
    const c = kept(row);
    if (c) { if (c.node.parentElement === sections[ti]) before = c.node; return; }
    const el = element(row);
    if (before) before.after(el); else sectionOf(ti, track).prepend(el);
    before = el;
    fresh.push({ row, track, ti, el });
  });
  let made;
  try { made = new Map((await loadAll(fresh)).map((c) => [c.id, c])); }
  catch { for (const f of fresh) f.el.remove(); return false; }
  const records = rows.map(({ row }) => made.get(row.id) ?? kept(row));
  if (shownT != null) {
    const t = shownT;
    let timer;
    const late = new Promise((done) => { timer = setTimeout(done, CUE_MS); });
    const ready = Promise.all(rows.map(({ row, track }, i) => cue(records[i], row, track, t, made.has(row.id)).catch(() => {})));
    await Promise.race([ready, late]);
    clearTimeout(timer);
  }
  try { reshape(next.stage); doc = next; rows.forEach(({ row, track, ti }, i) => settle(records[i], row, track, ti)); }
  catch { return false; }
  /* what the change put on at the moment shown and made ready shows now, with the clips it took away going: the
     picture changes at once, not first without them until that moment is drawn again */
  if (shownT != null) {
    for (const c of records) {
      const on = c.el && !c.hidden && !c.missing && shownT >= c.at && shownT < c.end;
      const ready = c.kind === 'still' || (c.kind === 'video' && c.el.readyState >= 2) || (c.kind === 'page' && made.has(c.id) && c.drawn);
      if (on && !c.shown && ready) { c.shown = true; c.el.style.visibility = 'visible'; fadeAt(c, shownT); }
    }
  }
  const now = new Set(records);
  for (const c of clips) {
    if (now.has(c)) continue;
    if (c.kind === 'video' || c.kind === 'page') rest(c);
    c.node.remove();
  }
  clips.splice(0, clips.length, ...records);
  hear();
  window.__filmEditor.stage.updated?.();
  return true;
}
/**
 * The stage at another size, in place: the body, the viewport and what the film says of its size. Every clip is
 * placed again after (settle): a picture without a box fills the new stage, a page without a size of its own is laid
 * out at it, a boxed one stays where its box says.
 */
function reshape(next) {
  if (next.w === stage.w && next.h === stage.h) return;
  stage.w = next.w; stage.h = next.h;
  Object.assign(document.body.style, { width: stage.w + 'px', height: stage.h + 'px' });
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', `width=${stage.w}, height=${stage.h}`);
  window.film.width = stage.w; window.film.height = stage.h;
}
/* edits are changed in the order they came, each once the one before is done */
let changing = Promise.resolve(true);

/**
 * Make ready, out of sight, what an edit puts on screen at `t` (`row` on `track`: the clip as the edit has it): a
 * video not showing now is given its file and sought to its frame there, a page just added is drawn there. Until
 * then the picture stays as it was: it does not go black while a file loads, and a page does not show its first
 * state before its frame. A video on screen already keeps its picture until its new frame is drawn.
 */
async function cue(c, row, track, t, fresh) {
  if (track.hidden || c.missing || (c.kind !== 'video' && !(fresh && c.kind === 'page'))) return;
  if (c.kind === 'video' && c.shown && c.el.readyState >= 2) return;
  let span;
  try { span = clipSpan(row, c.native, row.id); } catch { return; }
  const at = row.at ?? 0;
  if (t < at || t >= at + span.length) return;
  cueing.add(c);
  try {
    if (c.kind === 'video') { await glance(c, sourceAt(span, t - at, row)); return; }
    await wake(c);
    if (!c.child) return;
    const local = sourceAt(span, t - at, row, c.native);
    c.win.filmHost?.time?.(local);
    await c.child.frame(local);
    c.win.filmHost?.settle?.(local);
    c.drawn = true;
    override(c, c.overrides);
  } finally { cueing.delete(c); }
}

/** Where a clip's own pixel (x, y) is on the stage: its placement, as the browser applies it. */
const matrixOf = (c) => new DOMMatrix(getComputedStyle(c.el).transform);
const toStage = (c, x, y) => { const p = matrixOf(c).transformPoint(new DOMPoint(x, y)); return [p.x, p.y]; };

/** A selector that finds this element in its page (a unique id or class, else its path), and which match it is. */
function selectorOf(el) {
  const page = el.ownerDocument;
  const unique = (s) => { try { return page.querySelectorAll(s).length === 1; } catch { return false; } };
  if (el.id && unique(`#${CSS.escape(el.id)}`)) return { at: `#${CSS.escape(el.id)}` };
  for (const cls of el.classList) if (unique(`${el.localName}.${CSS.escape(cls)}`)) return { at: `${el.localName}.${CSS.escape(cls)}` };
  const parts = [];
  for (let node = el; node && node !== page.body && node.nodeType === 1; node = node.parentElement) {
    if (node !== el && node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const same = [...node.parentElement.children].filter((n) => n.localName === node.localName);
    parts.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName);
  }
  const at = parts.join(' > ');
  const all = [...page.querySelectorAll(at)];
  return all.length > 1 ? { at, n: all.indexOf(el) + 1 } : { at };
}

/** Whether a person sees the element: not hidden, and not faded out along the way up. */
function seen(win, el) {
  let opacity = 1;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    opacity *= Number(style.opacity);
  }
  return opacity > 0.05;
}

const STYLE_KEYS = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align', 'background-color', 'opacity', 'border-radius'];

/** What an editor shows of a target: its corners on the stage, its text when it holds text alone, its style. */
function describe(c, el) {
  const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, right: c.w, bottom: c.h };
  const quad = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]].map(([x, y]) => toStage(c, x, y));
  if (!el) return { clip: c.id, kind: c.kind, quad };
  const computed = c.win.getComputedStyle(el);
  return {
    clip: c.id, kind: 'element', quad, ...selectorOf(el), tag: el.localName,
    text: el.childElementCount === 0 && el.textContent.trim() ? el.textContent : null,
    style: Object.fromEntries(STYLE_KEYS.map((k) => [k, computed.getPropertyValue(k)])),
  };
}

window.__filmEditor = {
  /** Draw the film at t for a person watching it (see draw); `play` while it plays: `{ rate, now }`. */
  watch: (t, play = null) => draw(t, true, play),
  /**
   * For Studio's stage (studio/server/stage.js): the clips as loaded, a clip placed by a box not kept yet (null: by
   * its own again), `updated`, which the stage sets to hear of each update made in place, and `woke`, to hear of a page
   * opened again (see wakePage).
   */
  stage: {
    clips: () => clips,
    place(id, box) {
      const c = clips.find((x) => x.id === id);
      if (c?.el && c.kind !== 'sound') place(c, box ?? c.row.box);
    },
    /** Show a clip in CSS of its own not kept yet (null: its own again), as an inspector's value is dragged. */
    look(id, css) {
      const c = clips.find((x) => x.id === id);
      if (!c?.el) return;
      wear(c, css ?? c.row.style ?? '');
      place(c, c.row.box);
    },
    updated: null,
    woke: null,
  },
  /**
   * The film after an edit (`look`: its file's filmHead, when the edit came from the file; another one than this film
   * was loaded with needs the page loaded again): changed in place (see change), resolving to true, or to false when
   * the page has to be loaded again.
   */
  update(value, look) {
    changing = changing.then(() => change(value, look)).catch(() => false);
    return changing;
  },
  /** The stretches rendered for the preview, `{ a, b, src }` (see setRenders); [] none. */
  renders(list) { setRenders(Array.isArray(list) ? list.filter((r) => r && r.b > r.a && typeof r.src === 'string') : []); },
  /** Whether a render plays in the film's place now. */
  rendering: () => renderOn != null,
  /** Show `overrides` on a page clip instead of its own until called with null (a drag, a typed word). */
  preview(id, overrides) {
    const c = clips.find((x) => x.id === id && x.kind === 'page');
    if (!c) return;
    restore(c);
    c.preview = overrides ?? undefined;
    if (c.drawn) override(c, c.preview ?? c.overrides);
  },
  /** What is on top under the stage point (x, y) now: an element of a page, or a clip. */
  pick(x, y) {
    const shown = clips.filter((c) => c.el && c.el.style.visibility === 'visible').sort((a, b) => a.ti - b.ti);
    for (const c of shown) {
      const local = matrixOf(c).inverse().transformPoint(new DOMPoint(x, y));
      if (local.x < 0 || local.y < 0 || local.x > c.w || local.y > c.h) continue;
      if (c.kind !== 'page' || !c.win) return describe(c, null);
      /* the topmost element a person can see there: one faded out or hidden (a line still to come) is passed over */
      const page = c.win.document;
      const el = page.elementsFromPoint(local.x, local.y).find((e) => e !== page.body && e !== page.documentElement && seen(c.win, e));
      return describe(c, el ?? null);
    }
    return null;
  },
};

if (!window.filmHost) {
  await loading;
  const t0 = performance.now();
  const loop = async () => {
    const t = ((performance.now() - t0) / 1000) % film.duration;
    await draw(t, true, { rate: 1, now: t });
    requestAnimationFrame(loop);
  };
  loop();
}
