/*
 * Studio's bridge into the film's timeline page (src/timeline.mjs), injected after the host flag and before the
 * page's own script. The editor, on another origin, drives the film through it:
 *
 *   editor → { source: 'openfilm-studio', type: 'seek', t, seq, behind }   draw the film at t, still (`behind`: this
 *                                         load is not shown yet, another one is: its first picture is waited for whole)
 *            { type: 'play', t, at, rate, fps }   play: film second t at `at` (ms on this page's clock), `rate` film
 *                                         seconds a second; the frames are drawn here, on the film's frame grid
 *            { type: 'clock', ping }      what this page's clock says now (to put the editor's moments on it)
 *            { type: 'update', film, head, seq }  film.html changed: change the film in place if it can be
 *            { type: 'renders', list }    stretches rendered for the preview to play in their place: [{ a, b, src }]
 *            { type: 'preview', clip, overrides }   show a tweak on a page, not kept (null: stop showing)
 *            { type: 'overrides', list }  a page on its own: its clip's changes (SPEC §1), applied after each frame
 *            { type: 'pick', x, y, seq }          what is under this stage point
 *   film   → { source: 'openfilm-film', type: 'ready', duration, width, height, sounds, spans, origin }
 *            { type: 'seeked', t, seq }           the frame at t is on screen
 *            { type: 'clock', ping, now }         this page's clock (performance.now) when the ping came
 *            { type: 'played', frames, drawn, late, rendered, ms, spans }   while playing, about once a second over
 *                                         `ms`: the screen's refreshes, the film's frames drawn, the refreshes that got
 *                                         no new frame, whether a render played, and per half second of film [its start,
 *                                         refreshes, late]
 *            { type: 'updated', seq, inPlace, duration, sounds, spans }   (inPlace false: load the page again)
 *            { type: 'picked', seq, target }      (null: nothing there)
 *            { type: 'error', message }           the film or a page failed
 *
 * Only the editor's origin is listened to and answered (the server puts it in for EDITOR).
 */
(() => {
  /* a page inside the timeline page (a clip of the film) has the film's own page for parent, not the editor: it says
     nothing (a message to the editor's origin would only be refused) */
  try { if (parent !== window && parent.location.origin === location.origin) return; } catch { /* the parent is the editor */ }
  const EDITOR = __EDITOR__;
  const post = (message) => parent.postMessage({ source: 'openfilm-film', ...message }, EDITOR);
  const fail = (error) => post({ type: 'error', message: String(error?.message ?? error ?? 'the film failed') });
  window.addEventListener('error', (e) => fail(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => fail(e.reason));
  /* the page's real clock: the host holds performance.now() at a frame's t while it draws one (src/host.mjs) */
  const clock = () => (window.filmHost?.now ?? performance.now.bind(performance))();

  /* window.film is set by the page's module script, which runs after this one: wait for it */
  const film = new Promise((resolve) => {
    const look = () => (window.film && typeof window.film.frame === 'function' ? resolve(window.film) : setTimeout(look, 10));
    look();
  });
  const facts = (f) => ({ duration: f.duration, width: f.width, height: f.height, sounds: window.__filmSounds?.() ?? [], spans: window.__filmSpans?.() ?? [] });
  const editor = () => window.__filmEditor;
  /* a page on its own played as a clip had it (a clip of Saved): its changes, after each frame, as the film's
     timeline applies them (src/overrides.mjs); what they changed is remembered, so the page's own look comes back */
  let tweaks = null;
  let tweaker = null;
  const tweakState = { win: window, touched: new Map(), found: [] };
  const drawn = async (f, t) => {
    await f.frame(t);
    if (!tweaks) return;
    tweaker ??= import(new URL('__film/overrides.mjs', location.href).href).then((m) => m.override);
    (await tweaker)(tweakState, tweaks);
  };

  /* the film once loaded, or null: one that fails to load (a clip with no length, a missing file) says why once, here,
     and draws and answers nothing after — a page error for each later message would only repeat it */
  let up = null;
  const loaded = film.then(async (f) => {
    try { await f.ready; up = f; post({ type: 'ready', ...facts(f), origin: performance.timeOrigin }); return f; } catch (e) { fail(e); return null; }
  });

  /* one frame at a time: a seek that comes while one is drawing waits, and only the latest waiting one is drawn */
  const FRAME_WAIT_MS = 1000;
  /* a load of the film behind the one shown: the editor swaps it in at its first picture, so that picture is waited
     for whole (its videos' files loaded, sought there), up to this long; let go sooner, it swapped in black */
  const BEHIND_WAIT_MS = 20_000;
  let drawing = false;
  let next = null;
  /* the moment last asked for (drawn, being drawn or waiting): what an edit changed in place is drawn at */
  let asked = 0;
  const draw = async () => {
    if (drawing || !next) return;
    drawing = true;
    const { t, seq, behind } = next;
    next = null;
    try {
      const f = await loaded;
      if (!f) { drawing = false; return; }
      /* a person is watching: the timeline draws for them (a scrub does not wait for its videos to be composited); a
         page on its own draws its frame. A frame that does not come within a moment is let go: one stuck page or
         video must not stop the picture. */
      const watch = editor()?.watch;
      let timer;
      await Promise.race([watch ? watch(t) : drawn(f, t), new Promise((done) => { timer = setTimeout(done, behind ? BEHIND_WAIT_MS : FRAME_WAIT_MS); })]);
      clearTimeout(timer);
      post({ type: 'seeked', t, seq });
    } catch (e) { fail(e); }
    drawing = false;
    if (line) requestFrame(); else draw();
  };

  /*
   * Playing: the frames are drawn here, one each time the screen refreshes, from the line the editor gave (where the
   * film is, from its sound), not one message a frame from the editor: a busy editor does not hold the picture. Each
   * frame is the film where it will be when that frame reaches the screen (a refresh from now), on the film's frame
   * grid, so a 60 fps film on a 120 Hz screen draws each of its frames once and shows it twice. A frame still being
   * drawn when the next refresh comes is let finish; the one after it is the film where it is then (frames are dropped,
   * never queued).
   */
  let line = null;
  let raf = 0;
  /* the last frame drawn while playing, and how long the screen takes between frames (ms, measured as it plays) */
  let lastT = null;
  let refresh = 1000 / 60;
  let lastTick = 0;
  /* what the editor is told about how playing goes: frames drawn and late, and late frames per half second of film */
  let tally = { frames: 0, drawn: 0, late: 0, since: 0, rendered: false, spans: new Map() };
  const requestFrame = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const lineAt = (ms) => line.t + (Math.max(0, ms - line.at) / 1000) * line.rate;
  async function tick() {
    raf = 0;
    if (!line || !up) return;
    requestFrame();
    const now = clock();
    const gap = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (gap > 2 && gap < 60) refresh += (Math.min(gap, refresh * 2) - refresh) * 0.1;
    /* refreshes the screen got no new frame for (this one came more than half a frame after it was due) */
    const late = gap > refresh * 1.5 ? Math.round(gap / refresh) - 1 : 0;
    const end = Math.max(0, (up.duration ?? Infinity) - 1e-3);
    let t = Math.min(lineAt(now + refresh), end);
    if (line.fps > 0) t = Math.min(Math.floor(t * line.fps + 1e-6) / line.fps, end);
    count(t, late || (drawing && t !== lastT ? 1 : 0));
    if (drawing || t === lastT) return;
    lastT = t;
    drawing = true;
    tally.drawn += 1;
    try {
      const watch = editor()?.watch;
      const play = { rate: line.rate, now: Math.min(lineAt(now), end) };
      let timer;
      await Promise.race([watch ? watch(t, play) : drawn(up, t), new Promise((done) => { timer = setTimeout(done, FRAME_WAIT_MS); })]);
      clearTimeout(timer);
    } catch (e) { fail(e); }
    drawing = false;
    /* a seek that came while this frame drew (the film stopped): drawn now */
    if (next) draw();
  }
  /** Count a refresh while playing at film second t, and tell the editor how it went about once a second. */
  function count(t, late) {
    tally.frames += 1;
    tally.late += late;
    if (editor()?.rendering?.()) tally.rendered = true;
    const half = Math.floor(t * 2) / 2;
    const span = tally.spans.get(half) ?? [0, 0];
    span[0] += 1 + late;
    span[1] += late;
    tally.spans.set(half, span);
    const now = clock();
    if (!tally.since) tally.since = now;
    if (now - tally.since >= 1000) say();
  }
  function say() {
    if (tally.frames) post({ type: 'played', frames: tally.frames, drawn: tally.drawn, late: tally.late, rendered: tally.rendered, ms: Math.round(clock() - tally.since), spans: [...tally.spans].map(([t, [frames, late]]) => [t, frames, late]) });
    tally = { frames: 0, drawn: 0, late: 0, since: 0, rendered: false, spans: new Map() };
  }
  function stop() {
    if (!line) return;
    line = null;
    lastT = null;
    lastTick = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    say();
  }

  window.addEventListener('message', async (e) => {
    if (e.origin !== EDITOR || e.data?.source !== 'openfilm-studio') return;
    const m = e.data;
    if (m.type === 'clock') { post({ type: 'clock', ping: m.ping, now: clock() }); return; }
    /* before the next frame is drawn: the one asked for after them shows them */
    if (m.type === 'overrides') { if (!editor()) tweaks = Array.isArray(m.list) && m.list.length ? m.list : null; return; }
    if (m.type === 'seek') { stop(); next = m; asked = m.t; draw(); return; }
    if (m.type === 'play') {
      const fps = Number(m.fps);
      line = { t: Number(m.t), at: Number(m.at), rate: Number(m.rate) || 1, fps: fps > 0 ? fps : 0 };
      next = null;
      lastT = null;
      requestFrame();
      return;
    }
    const f = await loaded;
    if (!f) return;
    if (m.type === 'update') {
      let inPlace = false;
      try { inPlace = Boolean(await editor()?.update(m.film, m.head)); } catch { inPlace = false; }
      post({ type: 'updated', seq: m.seq, inPlace, ...(inPlace ? facts(f) : {}) });
      /* the moment asked for, drawn again as the film is now; not the last one drawn, which is older while a draw
         is still going (the first one, as the film comes up): the picture went back there, the playhead stayed.
         Playing, the next frame draws it */
      if (inPlace && line) lastT = null;
      else if (inPlace && !next) { next = { t: asked, seq: m.seq }; draw(); }
    }
    if (m.type === 'renders') editor()?.renders?.(m.list);
    if (m.type === 'preview') editor()?.preview(m.clip, m.overrides);
    if (m.type === 'pick') post({ type: 'picked', seq: m.seq, target: editor()?.pick(m.x, m.y) ?? null });
  });
})();
