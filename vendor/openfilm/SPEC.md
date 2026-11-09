# OpenFilm Protocol 0.1 (draft)

A film is a web page, `film.html`, that cuts pages, footage, pictures and sound together. A page is a web page that
can draw any moment of itself.

That is the whole idea. A page exposes one object, `window.film`, so it can be previewed, scrubbed, checked,
rendered to video, cut into a timeline and edited by any host that speaks this protocol. It may be written with any
library or none: three.js, p5, Canvas 2D, WebGL, GSAP, SVG, plain DOM. The protocol says nothing about how a page
draws, only how a host asks it to.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## 1. The film: film.html

The edit, the part a person adjusts by hand in an editor, is `film.html`: HTML that says which clip plays when and
where, and CSS that says how each looks. A page draws a shot.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, height=1920">
<style>
  .card { object-fit: cover; object-position: top; border-radius: 24px; }
</style>
</head>
<body>
<section>
  <iframe id="title" src="scenes/title.html" at="1" style="left: 80px; top: 120px; width: 920px"
          overrides='[{"at":"#title","text":"Aura Pods","style":{"color":"#7fd4ff"},"t":[0,-40]}]'></iframe>
</section>
<section>
  <video id="open" src="assets/a.mp4#t=12.2,15" speed="0.5" volume="0.8" class="card"
         style="left: 56px; top: 700px; width: 968px; height: 474px" overrides='[{"fade":[0.5,0]}]'></video>
</section>
<section>
  <audio id="bed" src="assets/bed.mp3#t=0,10" volume="0.5"></audio>
</section>
</body>
</html>
```

- The stage, the frame in CSS pixels, is the viewport: `<meta name="viewport" content="width=…, height=…">`;
  without one, 1920 × 1080. The head is the film's own (styles, fonts), with no script: what moves is a page.
- The body is the tracks, each a `<section>`, in the order a timeline shows them: the first on top (a host stacks
  them; a page's own paint order does not). A track has no kind: any clip goes on any track. A track's clips do not
  overlap; overlapping pictures (a picture-in-picture, a title over footage) sit on different tracks. A track may be
  `hidden` (no picture and no sound), `muted` (no sound) or `locked`: the person's, so an agent changes nothing on it
  and an editor keeps it from being changed. Like any element of the film it may carry `id`, `class`, `title`,
  `lang`, `dir`, `aria-*` and `data-*`, which say nothing to the film.
- A clip is an element: `<iframe>` a page, `<video>`, `<img>` a still picture, `<audio>` a sound, holding nothing.
  - `src`: its file, relative to film.html. Which seconds of it play is a media fragment: `#t=in,out` in the file's
    own seconds, `#t=in` to its end; without one, all of it. A still, or a page without a `duration`, has no end:
    its `#t=0,length` is required, and is how long it stays.
  - `id`: unique across the film; without it, the file's name.
  - `at`: where it starts on the film, in seconds from 0 (default 0).
  - `speed` on videos and sounds: the playback rate, 0.25 to 4, sound keeping its pitch. The clip lasts
    `(out − in) / speed` on the film.
  - `volume` on videos and sounds: linear gain, 1 the file's own level; `muted` is 0.
  - `size` on pages: `size="1920x1080"`, the CSS pixels a page without its own `width` and `height` (§2) is laid
    out at; without it, the stage's. An editor writes it when the stage changes shape, so such a page is scaled into
    its box like a video rather than laid out again in the new shape.
  - Where a picture sits is its own style's `left`, `top`, `width` and `height` in stage pixels, and `rotate` in
    degrees, clockwise about its center. Nothing else places a clip: the host does, on the element, so no other CSS
    moves it (`position`, `transform`, `margin` and the like in a clip's style are an error). `width` and `height`
    default to the picture's own size (a page's `width × height` (§2), a video's or still's pixels); with one of them,
    the other follows the picture's proportions. A video or still is its box, the picture in it as its CSS says
    (`object-fit: contain` unless the film says otherwise: `cover` crops it to the box); without a box it is the
    stage. A page is fitted whole inside its box, centered; without one it is its own size, centered, so a page
    without a size covers the stage.
  - How a picture looks is CSS: its `class` and the rest of its `style` (`border-radius`, `clip-path`, `mask`,
    `filter`, `opacity`, `mix-blend-mode`…), and the film's `<style>`. The film's CSS has no time: what moves is a
    page.
  - `overrides` are the person's changes made in Studio, as JSON, a list of entries. An entry with `at` (a CSS
    selector), on a page clip only, tweaks an element of the page, applied by the host after each frame: optional `n`
    (which match, from 1), `t` (translate px), `s` (scale), `r` (rotate degrees) as the independent CSS transform
    properties so they compose with the page's own animation, `style` (CSS properties, camelCase or custom
    `--name`, applied with priority), `text`
    (replaces the element's own text: all of it when it has no child elements or only `<br>`s, a line break in `text`
    being a `<br>`; with other inline children, its first run of text, the children kept), `lock` (`true`: an editor keeps the element from being selected or moved; it changes
    nothing in the picture). An entry without `at`, at most one, on any clip, is the clip's own: `fade: [in, out]`,
    seconds (0 or more, to the millisecond, together no longer than the clip): its picture's opacity and its sound's
    gain ramp linearly from 0 to 1 over its first `in` seconds and from 1 to 0 over its last `out` seconds, times its
    own opacity and volume.
  - `alt`, `title`, `lang`, `dir`, `data-*` and `aria-*` are kept and say nothing to the film.
- Times (`at`, the fragment's) are seconds to the millisecond: a host rounds them to three decimals as it reads them,
  and an editor writes no more (no frame shows a finer difference). Each is rounded alone, so clips on a track that
  overlap by a millisecond or less touch.
- A page clip: the host calls the page's `frame` with the clip's local time `in + (t − at)`, holding the page's
  last frame when the clip runs past the page's `duration`.
- Anything else is an error: a host reads film.html strictly, so a misspelled attribute or a stray element is
  reported, at its line, not ignored. The reference reading is `src/film-doc.mjs`.
- The film's sound is its sound clips and the sound of its video clips, each unless its volume is 0 or its track is
  muted or hidden.

A host plays film.html as a film: served, it is itself a protocol page (the reference host puts its timeline,
`src/timeline.mjs`, in it), so a film can be previewed, checked and rendered like any page. Editors change
film.html, writing over only what they changed; the pages stay as their authors wrote them.

What film.html says is kept to what an agent and a person must agree on, so it hardly ever changes. An attribute is
added only when it changes the film (or is an agreement between the person and the agent) and cannot be CSS, a page
or a file: a look is CSS, a title is a page, a transition is a page or clips that overlap and fade, a treated recording
is a file. An editor's own state (its history, caches, what it shows) lives in its own folder (`.film/`), not in
film.html.

### Sound

A page has no sound. Every sound in a film is a clip: an `<audio>`, or a `<video>`'s own sound, each one placed,
trimmed, muted and set in volume on the timeline like any clip. A sound that belongs to a shot is placed at the film
second the shot plays it; moving the page clip does not move it. The host mixes and encodes the sound; it never
records it from the page.

Timing that follows sound (beats, onsets, word timings) is data, not API: precompute it into files the page reads
during `ready`. Hosts MAY provide tools that write such files.

### Words

What a sound or a video says is a WebVTT file beside it with the same name (`assets/vo/1.wav` → `assets/vo/1.vtt`),
in the file's own seconds: a cue is a line, timestamp tags inside it time its words, and a voice tag names who speaks.
Its translations are beside it as `1.<language>.vtt`, the same lines at the same times. A file that begins with
`NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.` has its cues as the person cut them: each is shown
as one subtitle as it is, where an editor would otherwise cut long lines into subtitles. An editor's subtitles are the
lines of the clips that can be heard, placed by each clip's `at`, its `#t=` fragment and `speed`; a host draws none
of them into the picture.

## 2. The page

```js
window.film = {
  frame(t) { /* the picture at t seconds */ },   // may return a Promise
  duration: 12,                 // optional: its own length in seconds, finite, > 0
  ready: loadEverything(),      // optional: a Promise, or a function returning one
  width: 480, height: 320,      // optional: a page that is part of the picture; without them, the stage
};
```

| Field | Type | Meaning |
| --- | --- | --- |
| `frame(t)` | function | Draw the complete picture for time `t ≥ 0` (below `duration` when there is one). If it returns a Promise, the picture is complete when it resolves. |
| `duration` | number | Optional. The page's own length in seconds. Without it a page has no end, like a still: its clip's media fragment (`title.html#t=0,4`) says how long it plays, and a range is given to check or render it alone. |
| `ready` | Promise \| () => Promise | Optional. Resolves when fonts, images, models and data are loaded. The host calls `frame` only after it settles. For web fonts, load each face used (`document.fonts.load('700 64px Fraunces')`), not only `document.fonts.ready`. |
| `width`, `height` | number | Optional. The page's size in CSS pixels, for a page that is part of the picture (a chart in a corner). Without them the page is its clip's `size` (§1), else the size of the stage, or 1920 × 1080 opened on its own. The host sizes the viewport to it; higher resolutions use device pixel ratio. |

The frame rate is not the page's: a film is timed in seconds, and the rate is chosen when it is rendered.

A page SHOULD set `window.film` before its `load` event. Hosts wait for it to appear (for at least 10 seconds
after `load`) before reporting the page as not a film.

## 3. The one rule: a frame is a function of t

For the same `t`, `frame` MUST produce the same picture, whatever was drawn before it and in whatever order frames
are requested. Hosts rely on this to scrub, to render frames in parallel, to render fractions of a frame for motion
blur, and to re-render one shot without the rest.

In practice:

- Read time from `t`. A host holds the page's clocks at `t` while it draws (§4), so `performance.now()`,
  `requestAnimationFrame` timestamps, `Date`, CSS animations and `Math.random` agree with it; timers and history
  do not.
- Repaint everything each call. Do not accumulate (`x += v`) across calls; if something has history (a trail, a
  physics run), compute it from `t`, or precompute it during `ready` and look it up.
- Tweens that record their start values the first time they run (GSAP `to`, `from`) remember whatever was on screen
  then, which depends on the order frames were drawn. Give every tween explicit start and end values (`fromTo`).
- Any library that runs its own clock is driven by `t` instead: `timeline.seek(t)`, `animation.currentTime = t * 1000`,
  `p5.redraw()`, `renderer.render(scene, camera)`, `video.currentTime = …` (awaiting `seeked`).

Notes for authors:

- `window.film` may be assigned from a module script (`<script type="module">`): modules run before `load`.
- A WebGL canvas is captured after `frame` returns. Draw inside `frame` and create the context with
  `preserveDrawingBuffer: true`, or the host may capture a cleared buffer.
- Lay the page out for its viewport (`innerWidth` × `innerHeight`, in CSS pixels): the same page can then be cut
  into films of other shapes. Hosts raise resolution with device pixel ratio, so a canvas should allocate
  `innerWidth × devicePixelRatio` pixels.
- Repeating a frame is not always bit-identical in a browser (layers are re-rasterized as they change). Hosts compare
  repeated frames with a tolerance, not byte for byte.

## 4. Hosts

Before any page script runs, a host sets `window.filmHost = { version: '0.1', name }`. When it is present the page
MUST NOT advance on its own (no self-running loop, no autoplay of media or sound). When it is absent the page is
being opened as an ordinary web page and SHOULD play itself, so every film is also a page you can just open:

```js
if (!window.filmHost) {
  const t0 = performance.now();
  const loop = () => { const t = (performance.now() - t0) / 1000; film.frame(film.duration ? t % film.duration : t); requestAnimationFrame(loop); };
  Promise.resolve(typeof film.ready === 'function' ? film.ready() : film.ready).then(loop);
}
```

A host:

- serves the page over HTTP (not `file://`), with its project (the folder of the film.html around it, else the
  page's own folder) as the root, so a page can load the project's assets;
- sizes the viewport to the page's `width × height`, or the stage's (times a device pixel ratio for higher
  resolutions);
- awaits `ready`, then calls `frame(t)` and awaits its result before capturing the viewport;
- MAY call `frame` concurrently in separate page instances, and at fractional frame times;
- reports uncaught errors and failed requests from the page.

From the first frame it draws, a host holds the page's clocks at the frame's `t`: `performance.now()` and
`requestAnimationFrame` timestamps read `t` in milliseconds, `Date` reads `t` after the epoch 2026-01-01T00:00:00Z,
CSS and Web Animations the page left running stand at `t` (a CSS transition, whose progress is history, is
finished), and `Math.random` restarts from a seed of `t` (while loading it runs from a fixed seed). Before the first
frame (`ready`, loading) the page runs on real time. The reference host's prelude is `FILM_CLOCK` in
`src/host.mjs`: `filmHost.time(t)` before `frame(t)`, `filmHost.settle(t)` after it.

A page may play footage with native `<video>` elements, silent, and set `currentTime` from `t`. The host makes
that exact: a media seek lands inside the frame it names, and the host waits until each video's new frame is on
screen before it captures.

## 5. Versioning

This is version 0.1. Attributes may be added (§1 says when); their absence must keep meaning what it means today.
