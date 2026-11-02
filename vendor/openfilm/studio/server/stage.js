/*
 * Studio's stage inside the film's timeline page (src/timeline.mjs), injected after bridge.js. The editor runs on
 * another origin and cannot touch the picture's DOM, so what the stage needs of it lives here: what is under a point,
 * what a layer is (its kind, words, style, override, parents), where it is drawn, a move / scale / turn / style / text
 * shown before it is kept, the in-place text box, and the keys pressed while the picture has focus.
 *
 * Nothing here writes film.html: a change is only shown (as a preview of the clip's `overrides`, or a clip placed in a
 * box) until the editor keeps it, and the film's next update takes the shown change back.
 *
 *   editor → { source: 'openfilm-studio', type: 'stage', seq, op, ...args }    (ops below, at `ops`)
 *   film   → { source: 'openfilm-film', type: 'stage', seq, result }           the answer (null when nothing)
 *            { type: 'stage-event', event: 'typing', handle, value }   the words of an in-place edit as they are typed
 *            { type: 'stage-event', event: 'text', handle, commit, value?, before? }   an in-place edit ended
 *            { type: 'stage-event', event: 'key', key, code, repeat, metaKey, ctrlKey, shiftKey, altKey }
 *                                                   a key pressed in the picture (not while typing in it)
 *
 * Points and boxes are in stage px (the film's own size, before the editor scales its frame). A layer is named by a
 * `handle` (a number, good while its element is in the page) and by `loc`: its selector, with `#n` when the selector
 * finds several (the override target `{ at, n }`).
 *
 * Only the editor's origin is listened to and answered (the server puts it in for EDITOR).
 */
(() => {
  const EDITOR = __EDITOR__;
  const BLUE = '#0d99ff';
  const post = (message) => parent.postMessage({ source: 'openfilm-film', ...message }, EDITOR);
  const editor = () => window.__filmEditor;
  const hooks = () => window.__filmEditor?.stage;
  const clips = () => hooks()?.clips() ?? [];

  /* ── handles: a number per element, kept weakly ── */
  let nextHandle = 1;
  const byHandle = new Map();
  const handles = new WeakMap();
  const handleOf = (el) => {
    let h = handles.get(el);
    if (!h) {
      h = nextHandle++;
      handles.set(el, h);
      byHandle.set(h, new WeakRef(el));
      if (byHandle.size > 4000) for (const [k, ref] of byHandle) if (!ref.deref()?.isConnected) byHandle.delete(k);
    }
    return h;
  };
  const nodeOf = (h) => {
    if (h == null) return null;
    const el = byHandle.get(h)?.deref();
    return el?.isConnected ? el : null;
  };
  const clipOfNode = (el) => clips().find((c) => c.kind === 'page' && c.win === el?.ownerDocument?.defaultView) ?? null;
  const clipById = (id) => clips().find((c) => c.id === id) ?? null;

  /* ── a clip on the stage: its placement maps its own px to stage px ── */
  const matrixOf = (c) => new DOMMatrix(getComputedStyle(c.el).transform);
  const mapPoint = (M, x, y) => { const p = M.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; };
  /** A box in the clip's px → the stage box around it. */
  const mapRect = (M, r) => {
    const pts = [[r.left, r.top], [r.left + r.width, r.top], [r.left + r.width, r.top + r.height], [r.left, r.top + r.height]]
      .map(([x, y]) => mapPoint(M, x, y));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  };
  /** A frame (center, size, turn) in the clip's px → the same frame on the stage (the clip's turn and scale added). */
  const mapFrame = (M, f) => {
    const rad = (f.r * Math.PI) / 180;
    const ux = { x: Math.cos(rad), y: Math.sin(rad) };
    const uy = { x: -Math.sin(rad), y: Math.cos(rad) };
    const at = (kx, ky) => mapPoint(M, f.cx + (ux.x * kx * f.w + uy.x * ky * f.h) / 2, f.cy + (ux.y * kx * f.w + uy.y * ky * f.h) / 2);
    const c = mapPoint(M, f.cx, f.cy);
    const p0 = at(-1, -1);
    const p1 = at(1, -1);
    const p3 = at(-1, 1);
    const r = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
    return { cx: c.x, cy: c.y, w: Math.hypot(p1.x - p0.x, p1.y - p0.y), h: Math.hypot(p3.x - p0.x, p3.y - p0.y), r: Math.abs(r) < 1e-6 ? 0 : r };
  };
  const clipTurn = (M) => (Math.atan2(M.b, M.a) * 180) / Math.PI;
  const clipScale = (M) => Math.hypot(M.a, M.b) || 1;

  /** The picture clips a person sees now, the top one first (track 0 is on top). */
  const shown = () => clips()
    .filter((c) => c.el && c.kind !== 'sound' && c.el.style.visibility === 'visible' && !(Number(c.el.style.opacity || 1) <= 0))
    .sort((a, b) => a.ti - b.ti);
  /** The top clip under a stage point, by its placed box (a full-frame video draws nothing a point test could find). */
  const clipAt = (x, y, pictures = false) => {
    for (const c of shown()) {
      if (pictures && c.kind === 'page') continue;
      const p = matrixOf(c).inverse().transformPoint(new DOMPoint(x, y));
      if (p.x >= 0 && p.y >= 0 && p.x <= c.w && p.y <= c.h) return c;
    }
    return null;
  };

  /* ── a page's layers (ported from the old Studio's stage-dom / stage-inspect) ── */
  const SKIP = new Set(['script', 'style', 'link', 'meta', 'template', 'noscript', 'title', 'head', 'br', 'wbr']);
  const IMAGE_TAGS = new Set(['img', 'video', 'canvas', 'picture']);
  const SHAPE_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'g', 'text', 'tspan', 'use']);
  const SVG_TEXT_TAGS = new Set(['text', 'tspan', 'textpath']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const INLINE = new Set(['BR', 'WBR', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SPAN', 'SMALL', 'SUP', 'SUB', 'A', 'MARK', 'CODE', 'ABBR', 'Q', 'TIME']);
  const EDITOR_ATTR = 'data-openfilm-text-editor';
  const LIMIT = 1500;
  /** At most this many custom properties, and as many words, as a page's template controls. */
  const CONTROLS = 40;

  const view = (el) => el.ownerDocument.defaultView;
  const css = (el) => view(el).getComputedStyle(el);
  const tagKind = (tag) => (IMAGE_TAGS.has(tag) ? 'image' : SHAPE_TAGS.has(tag) ? 'shape' : null);
  const isSvgText = (el) => el.namespaceURI === SVG_NS && SVG_TEXT_TAGS.has(el.localName.toLowerCase());
  const isGroup = (el) => Boolean(el?.hasAttribute?.('data-group'));
  const kebab = (key) => key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);

  /** Every element of a page that can be a layer, in document order. */
  const layersOf = (doc) => {
    const out = [];
    if (!doc.body) return out;
    for (const el of doc.body.querySelectorAll('*')) {
      if (out.length >= LIMIT) break;
      if (SKIP.has(el.localName.toLowerCase()) || el.hasAttribute(EDITOR_ATTR) || el.closest(`[${EDITOR_ATTR}]`)) continue;
      out.push(el);
    }
    return out;
  };

  /** Faded out to nothing, here or on the way up: not hit, not framed. */
  const invisible = (el) => {
    for (let node = el; node; node = node.parentElement) {
      if (!(Number.parseFloat(css(node).opacity) > 0)) return true;
      if (node === el.ownerDocument.documentElement) break;
    }
    return false;
  };

  const collapse = (raw) => raw.replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
  /** The words on an element as written, line breaks kept (`<br>` and block children both break a line). */
  const stageText = (el) => {
    let out = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === 3) { out += node.nodeValue ?? ''; return; }
      if (node.nodeType !== 1) return;
      if (node.localName === 'br') { out += '\n'; return; }
      const display = css(node).display;
      if (!display.startsWith('inline') && display !== 'contents' && out && !out.endsWith('\n')) out += '\n';
      out += stageText(node);
    });
    return collapse(out);
  };
  /** An element's own words: all of them, or, when it holds inline parts (`<em>`, `<br>`…), those written in it. */
  const ownWords = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.data).join('').replace(/\s+/g, ' ').trim();
  /* an icon beside the words (a badge's ✓, a button's arrow) does not stop them being the element's text: its own
     words are typed in place, and the icon stays (a text override changes the element's own words only) */
  const ICON = new Set(['svg', 'img']);
  /** Words alone, or lines between <br>s: a `text` override changes all of them, a <br> at each line break. */
  const onlyBreaks = (el) => [...el.children].every((ch) => ch.localName === 'br');
  /* words of its own beside blocks of their own (a title with its subtitle written inside it) are its text too: the
     blocks are layers of their own, and a text override changes its own words only */
  const textOf = (el) => (onlyBreaks(el) ? stageText(el) : ownWords(el));
  /** The blocks written inside a line of words (a subtitle inside its title): layers of their own. */
  const blocksOf = (el) => [...el.children].filter((ch) => !INLINE.has(ch.tagName) && !ICON.has(ch.localName) && !SKIP.has(ch.localName.toLowerCase()));
  /** Those shown now: still shown while the line's own words are typed. */
  const blocksIn = (el) => blocksOf(el).filter((ch) => css(ch).visibility === 'visible');
  /**
   * A line of words with blocks written inside it: its own words are the layer (its box hugs them, the inspector shows
   * them), and the blocks in it stay where they are and as they look when it is moved or restyled (holdBlocks).
   */
  const mixedText = (el) => el.namespaceURI !== SVG_NS && !onlyBreaks(el) && blocksOf(el).length > 0 && Boolean(ownWords(el));
  /** The box of an element's own words on its page (the union of their lines' boxes). */
  const wordsRect = (el) => {
    const range = el.ownerDocument.createRange();
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.data.trim()) continue;
      range.selectNodeContents(n);
      for (const x of range.getClientRects()) {
        if (x.width < 0.5 && x.height < 0.5) continue;
        l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
      }
    }
    if (l < r && t < b) return { left: l, top: t, width: r - l, height: b - t };
    const x = el.getBoundingClientRect();
    return { left: x.left, top: x.top, width: x.width, height: x.height };
  };
  /** The size of an element's own words as laid out, before any transform (each run measured in a span of its own). */
  const wordsSize = (el) => {
    const doc = el.ownerDocument;
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    for (const n of [...el.childNodes]) {
      if (n.nodeType !== 3 || !n.data.trim()) continue;
      const span = doc.createElement('span');
      n.before(span);
      span.append(n);
      l = Math.min(l, span.offsetLeft); t = Math.min(t, span.offsetTop);
      r = Math.max(r, span.offsetLeft + span.offsetWidth); b = Math.max(b, span.offsetTop + span.offsetHeight);
      span.replaceWith(n);
    }
    return l < r && t < b ? { w: r - l, h: b - t } : { w: el.offsetWidth, h: el.offsetHeight };
  };

  const transparent = (color) => {
    const c = color.trim();
    if (!c || c === 'transparent') return true;
    const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/.exec(c);
    return m != null && Number(m[1]) === 0;
  };
  /** Whether a layer paints anything itself: a fill, a border, a background picture, a shadow. */
  const paints = (cs) => !transparent(cs.backgroundColor)
    || (cs.backgroundImage && cs.backgroundImage !== 'none')
    || (Number.parseFloat(cs.borderTopWidth) > 0 && !transparent(cs.borderTopColor))
    || (cs.boxShadow && cs.boxShadow !== 'none')
    || (Number.parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none' && !transparent(cs.outlineColor))
    || (cs.backdropFilter && cs.backdropFilter !== 'none');
  /** Whether the person changed how it looks in Studio (an override's style is written with priority): theirs to
      select again, though it paints nothing now (its fill taken off) */
  const restyled = (el) => [...el.style].some((p) => el.style.getPropertyPriority(p) === 'important');

  /** text, image, shape or box; null for an empty shell (a click there goes to what is under it). */
  const kindOf = (el) => {
    if (isSvgText(el) && textOf(el)) return 'text';
    const byTag = tagKind(el.localName.toLowerCase());
    if (byTag) return byTag;
    if (el.namespaceURI !== SVG_NS && textOf(el)) return 'text';
    return paints(css(el)) || restyled(el) ? 'box' : null;
  };

  const angleDeg = (raw) => {
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) return 0;
    if (/rad$/i.test(raw)) return (v * 180) / Math.PI;
    if (/turn$/i.test(raw)) return v * 360;
    if (/grad$/i.test(raw)) return v * 0.9;
    return v;
  };
  const transformTurn = (transform) => {
    if (!transform || transform === 'none') return 0;
    const m = /matrix(3d)?\(([^)]+)\)/i.exec(transform);
    if (!m) return 0;
    const n = m[2].split(',').map((x) => Number.parseFloat(x));
    return Number.isFinite(n[0]) && Number.isFinite(n[1]) ? (Math.atan2(n[1], n[0]) * 180) / Math.PI : 0;
  };
  const ownTurn = (el) => { const r = css(el).rotate; return r && r !== 'none' ? angleDeg(r.split(/\s+/).pop()) : 0; };
  /** How far a layer and everything around it in its page is turned (the `rotate` property and `transform`). */
  const totalTurn = (el) => {
    let r = 0;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) r += ownTurn(node) + transformTurn(css(node).transform);
    return r;
  };

  /** The override geometry painted on a layer now (inline translate / scale / rotate). */
  const paintedOf = (el) => {
    const tr = el.style.getPropertyValue('translate').trim();
    const sc = el.style.getPropertyValue('scale').trim();
    const ro = el.style.getPropertyValue('rotate').trim();
    const px = tr && tr !== 'none' ? tr.split(/\s+/).map((v) => Number.parseFloat(v) || 0) : [];
    const sp = sc && sc !== 'none' ? sc.split(/\s+/).map((v) => Number.parseFloat(v) || 1) : [];
    return { t: [px[0] ?? 0, px[1] ?? 0], s: [sp[0] ?? 1, sp[1] ?? sp[0] ?? 1], r: ro && ro !== 'none' ? angleDeg(ro) : 0 };
  };

  /** A layer's box in its page. A group's is the box of what is in it (it fills the frame and paints nothing). */
  const rectOf = (el) => {
    if (isGroup(el)) {
      let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
      for (const c of el.querySelectorAll('*')) {
        if (isGroup(c) || SKIP.has(c.localName.toLowerCase()) || invisible(c)) continue;
        const x = c.getBoundingClientRect();
        if (x.width < 1 || x.height < 1) continue;
        l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
      }
      if (l < r && t < b) return { left: l, top: t, width: r - l, height: b - t };
    }
    if (mixedText(el)) return wordsRect(el);
    const x = el.getBoundingClientRect();
    return { left: x.left, top: x.top, width: x.width, height: x.height };
  };

  /**
   * A layer's frame in its page as drawn: center from its box, true width and height worked out from its laid-out
   * aspect (times the override's scale) and its turn, so whatever scaled it is counted.
   */
  const measureFrame = (el, s, r) => {
    const mixed = mixedText(el);
    const box = mixed ? wordsRect(el) : el.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    if (mixed && Math.abs(r % 360) < 0.01) return { cx, cy, w: box.width, h: box.height, r: 0 };
    let { w: lw, h: lh } = mixed ? wordsSize(el) : { w: el.offsetWidth, h: el.offsetHeight };
    if (!(lw > 0 && lh > 0)) {
      try { const bb = el.getBBox?.(); lw = bb?.width ?? 0; lh = bb?.height ?? 0; } catch { lw = 0; lh = 0; }
    }
    if (!(lw > 0 && lh > 0)) return { cx, cy, w: box.width, h: box.height, r: 0 };
    const ratio = (lw * s[0]) / (lh * s[1]);
    const rad = (r * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    const h = (box.width + box.height) / (ratio * c + sn + ratio * sn + c);
    return { cx, cy, w: ratio * h, h, r };
  };
  /** The frame a layer is drawn in (turned with it and its parents): hover, hit and the selection box share it. */
  const frameOf = (el, rect = rectOf(el)) => {
    const r = totalTurn(el);
    if (Math.abs(r % 360) < 0.01 || isGroup(el)) return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w: rect.width, h: rect.height, r: 0 };
    return measureFrame(el, paintedOf(el).s, r);
  };
  const inFrame = (f, x, y) => {
    if (!f.r) return Math.abs(x - f.cx) <= f.w / 2 && Math.abs(y - f.cy) <= f.h / 2;
    const rad = (-f.r * Math.PI) / 180;
    const dx = x - f.cx;
    const dy = y - f.cy;
    return Math.abs(dx * Math.cos(rad) - dy * Math.sin(rad)) <= f.w / 2 + 0.5 && Math.abs(dx * Math.sin(rad) + dy * Math.cos(rad)) <= f.h / 2 + 0.5;
  };
  /** Override px → page px: `translate` is in the parent's coordinates, so the parent's own scale counts. */
  const localScale = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      if (p.offsetWidth > 0 && r.width > 0) return r.width / p.offsetWidth;
    }
    return 1;
  };

  /* ── selectors: a name a person's tweak keeps pointing at when the page is rewritten around it ── */
  const stepOf = (el) => {
    const tag = el.localName;
    const classes = [...el.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 3);
    const named = tag + classes.map((c) => `.${CSS.escape(c)}`).join('');
    const siblings = [...el.parentElement.children];
    if (siblings.filter((c) => c.tagName === el.tagName && classes.every((k) => c.classList.contains(k))).length === 1) return named;
    const typed = siblings.filter((c) => c.tagName === el.tagName);
    return `${named}:nth-of-type(${typed.indexOf(el) + 1})`;
  };
  const selectorOf = (el) => {
    const doc = el.ownerDocument;
    if (el.id && doc.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parentEl = el.parentElement;
    if (!parentEl || el === doc.body) return el.localName;
    return `${parentEl === doc.body ? 'body' : selectorOf(parentEl)} > ${stepOf(el)}`;
  };
  const matches = (doc, o) => {
    let nodes = [];
    try { nodes = [...doc.querySelectorAll(o.at)]; } catch { return []; }
    return o.n ? nodes.slice(o.n - 1, o.n) : nodes;
  };
  /** Its selector, and which match it is when the selector finds several. */
  const locOf = (el) => {
    const at = selectorOf(el);
    const all = matches(el.ownerDocument, { at });
    if (all.length <= 1) return { at, loc: at };
    const n = all.indexOf(el) + 1;
    return { at, n, loc: `${at}#${n}`, instance: n, instances: all.length };
  };
  const targetOf = (el) => { const { at, n } = locOf(el); return n ? { at, n } : { at }; };
  /** Layers like it, wherever they are: its tag and classes (`h2.title`), or null when it has no class to go by. */
  const similarOf = (el) => {
    const classes = [...el.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 3);
    return classes.length ? el.localName + classes.map((c) => `.${CSS.escape(c)}`).join('') : null;
  };

  /** The clip's kept override that applies to this element (the last one that finds it). */
  const overrideOf = (c, el) => {
    let found = null;
    for (const o of c.overrides ?? []) if (matches(el.ownerDocument, o).includes(el)) found = o;
    if (!found) return null;
    const out = {};
    if (Array.isArray(found.t)) out.t = [Number(found.t[0]) || 0, Number(found.t[1]) || 0];
    if (found.s != null) out.s = found.s;
    if (typeof found.r === 'number') out.r = found.r;
    if (found.style && typeof found.style === 'object') out.style = found.style;
    if (found.lock === true) out.lock = true;
    if (typeof found.text === 'string') out.text = found.text;
    return Object.keys(out).length ? out : null;
  };
  /** Locked here or on a layer around it: not dragged, not boxed, not hovered. */
  const lockedOf = (c, el) => {
    const locks = (c.overrides ?? []).filter((o) => o.lock === true);
    if (!locks.length) return false;
    const held = new Set(locks.flatMap((o) => matches(el.ownerDocument, o)));
    for (let node = el; node; node = node.parentElement) if (held.has(node)) return true;
    return false;
  };

  /* what arrange (below) needs to know of a layer and its parents */
  const FLEX_OR_GRID = /^(inline-)?(flex|grid)$/;
  const stackingContext = (node) => {
    /* the root only: a body with a background of its own would hide a layer sent behind it */
    if (node === node.ownerDocument.documentElement) return true;
    const cs = css(node);
    /* a flex or grid item with a z-index is one too (zOf, below) */
    return cs.isolation === 'isolate' || (cs.position !== 'static' && cs.zIndex !== 'auto') || Number.parseFloat(cs.opacity) < 1
      || cs.transform !== 'none' || cs.translate !== 'none' || cs.scale !== 'none' || cs.rotate !== 'none'
      || cs.filter !== 'none' || cs.mixBlendMode !== 'normal' || cs.clipPath !== 'none'
      || (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none' || zOf(node) != null;
  };
  /** Whether a z-index on it counts: it has a position, or it is laid out by a flex or grid parent. */
  const placedIn = (node) => css(node).position !== 'static' || FLEX_OR_GRID.test(css(node.parentElement ?? node).display);
  /** The z-index it is drawn by, null for auto (a z-index where it does not count is auto). */
  const zOf = (node) => {
    if (!placedIn(node)) return null;
    const z = Number.parseInt(css(node).zIndex, 10);
    return Number.isFinite(z) ? z : null;
  };
  /**
   * Where a layer is drawn in the stacking context it is in, as CSS paints them: by z-index (auto is 0); at the same
   * z, those without a position first, then those with one and the stacking contexts made otherwise (a transform, an
   * opacity, an isolation); then in document order (compare `order` last).
   */
  const paintKey = (node) => {
    const z = zOf(node);
    if (z == null) return [0, css(node).position !== 'static' || stackingContext(node) ? 1 : 0];
    return [z, z < 0 ? 0 : z === 0 ? 1 : 2];
  };
  const paintCompare = (a, b) => {
    const ka = paintKey(a);
    const kb = paintKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  };
  /**
   * The part of a layer drawn last: the layer itself when it is a stacking context (all of it is drawn at once), else
   * the latest of it and what is in it, since those are drawn among its siblings (a transformed card inside a plain
   * column is drawn with the positioned layers, after a sibling column with a z-index of 0). `memo`: per reading.
   */
  const reachOf = (node, memo) => {
    let best = memo.get(node);
    if (best) return best;
    best = node;
    if (!stackingContext(node)) {
      for (const ch of node.children) {
        if (SKIP.has(ch.localName.toLowerCase())) continue;
        const r = reachOf(ch, memo);
        if (paintCompare(best, r) < 0) best = r;
      }
    }
    memo.set(node, best);
    return best;
  };
  /** Siblings in the order they are drawn, by what of each is drawn last; a fresh reading each time. */
  const siblingOrder = (nodes) => {
    const memo = new Map();
    return [...nodes].sort((a, b) => paintCompare(reachOf(a, memo), reachOf(b, memo)));
  };
  /** whether giving `node` a position would move what is placed inside it against something further out */
  const unsafe = (node) => [...node.querySelectorAll('*')].some((inner) => {
    if (css(inner).position !== 'absolute') return false;
    for (let up = inner.parentElement; up && up !== node; up = up.parentElement) if (css(up).position !== 'static') return false;
    return true;
  });

  /* styles the inspector shows per kind (computed: a page states none as source keys) */
  const TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'lineHeight', 'letterSpacing', 'textAlign', 'color', 'opacity'];
  const SVG_TEXT_STYLE_KEYS = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'fill', 'opacity'];
  const KIND_STYLE_KEYS = {
    text: [...TEXT_STYLE_KEYS, 'textTransform', 'textDecorationLine'],
    image: ['opacity', 'borderRadius', 'objectFit', 'objectPosition', 'clipPath'],
    shape: ['opacity', 'fill'],
    box: ['backgroundColor', 'borderRadius', 'opacity', 'clipPath', 'boxShadow'],
  };
  /* the look every kind shows (blend, adjustments and shadow, stroke, faded edges, what is behind blurred): as the
     page draws it, its CSS's or its own */
  const LOOK_STYLE_KEYS = ['mixBlendMode', 'filter', 'border', 'outline', 'outlineOffset', 'backdropFilter', 'maskImage', 'maskComposite'];
  const LOOK_KEYS = new Set([...LOOK_STYLE_KEYS, 'textTransform', 'textDecorationLine', 'objectPosition', 'clipPath', 'boxShadow']);
  const UNITLESS = new Set(['opacity', 'fontWeight', 'lineHeight', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom', 'scale', 'fillOpacity', 'strokeOpacity', 'strokeMiterlimit']);
  const isColorKey = (key) => /^(color|fill|stroke|background|backgroundColor|borderColor|outlineColor|stopColor)$/.test(key) || /Color$/.test(key);
  const pxNumber = (value) => {
    const m = /^(-?[\d.]+)px$/.exec(String(value).trim());
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : undefined;
  };
  /** `rgb(…)` / `rgba(…)` as hex; a see-through color keeps its alpha (`#00ff0080`), as the inspector wrote it. */
  const rgbToHex = (color) => {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(color.trim());
    if (!m) return color.startsWith('#') ? color : undefined;
    const hex = (n) => Number(n).toString(16).padStart(2, '0');
    const a = m[4] == null ? 1 : Number(m[4]);
    return `#${[m[1], m[2], m[3]].map(hex).join('')}${a < 1 ? hex(Math.round(a * 255)) : ''}`;
  };
  const own = (el, name) => el.style.getPropertyValue(name).trim();
  const styleValue = (el, key, cs) => {
    const name = kebab(key);
    if (key === 'lineHeight') {
      const mine = own(el, 'line-height');
      if (mine && !mine.endsWith('px')) { const n = Number(mine); return Number.isFinite(n) ? n : mine; }
      const size = pxNumber(cs.fontSize);
      const leading = pxNumber(mine || cs.lineHeight);
      return leading != null && size ? Math.round((leading / size) * 100) / 100 : undefined;
    }
    if (isColorKey(key)) {
      const mine = own(el, name);
      if (mine && /gradient|url\(/i.test(mine)) return mine;
      return rgbToHex(mine || cs.getPropertyValue(name)) ?? (mine || undefined);
    }
    if (key === 'fontWeight') return own(el, 'font-weight') || cs.fontWeight || undefined;
    if (key === 'fontFamily') return own(el, 'font-family') || cs.fontFamily || undefined;
    if (key === 'fontStyle') { const v = own(el, 'font-style') || cs.fontStyle; return v && v !== 'normal' ? v : undefined; }
    if (key === 'textAlign') { const v = own(el, 'text-align') || cs.textAlign; return v && v !== 'start' ? v : undefined; }
    if (LOOK_KEYS.has(key)) {
      const v = own(el, name) || cs.getPropertyValue(name);
      /* an outline is computed color first: "rgb(0, 0, 0) none 0px" is none */
      if (key === 'outline' && /\bnone\b/.test(v)) return undefined;
      return v && !/^(none|normal|add|50% 50%)$/.test(v) && !/^0px none\b/.test(v) ? v : undefined;
    }
    if (UNITLESS.has(key)) {
      const mine = own(el, name);
      const n = Number(mine || cs.getPropertyValue(name));
      return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : (mine || undefined);
    }
    const mine = own(el, name);
    if (!mine || /^-?[\d.]+px$/.test(mine) || mine === '0') { const n = pxNumber(mine || cs.getPropertyValue(name)); if (n != null) return n; }
    return mine || undefined;
  };
  const styleOf = (el, kind) => {
    const style = {};
    const cs = css(el);
    let keys = [...(kind === 'text' && isSvgText(el) ? SVG_TEXT_STYLE_KEYS : KIND_STYLE_KEYS[kind]), ...LOOK_STYLE_KEYS];
    /* a line with its own fill (a badge, a tag) is a box too */
    if (kind === 'text' && paints(cs)) keys.push('backgroundColor', 'borderRadius', 'boxShadow');
    keys = [...new Set(keys)];
    for (const key of keys) {
      if (key === 'backgroundColor' && transparent(cs.backgroundColor)) continue;
      if (key === 'objectFit') { const fit = own(el, 'object-fit') || cs.objectFit; if (fit) style[key] = fit; continue; }
      if (key === 'borderRadius') {
        const mine = own(el, 'border-radius');
        /* four corners not alike: all four, as the shorthand writes them (top left, top right, bottom right, left) */
        const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
        if (!mine && new Set(corners).size > 1 && corners.every((c) => pxNumber(c) != null)) { style[key] = corners.join(' '); continue; }
        const n = pxNumber(mine || cs.borderTopLeftRadius);
        if (n != null) style[key] = n; else if (mine) style[key] = mine;
        continue;
      }
      const value = styleValue(el, key, cs);
      if (value != null && value !== '') style[key] = value;
    }
    return style;
  };

  const labelOf = (el, kind) => {
    if (kind === 'text') {
      const text = textOf(el).replace(/\s+/g, ' ');
      if (text) return text.length <= 32 ? text : `${text.slice(0, 32)}…`;
    }
    if (kind === 'image') {
      const src = el.getAttribute('src') ?? '';
      const name = src.startsWith('data:') ? null : src.split(/[?#]/)[0].split('/').pop();
      if (name) { try { return decodeURIComponent(name); } catch { return name; } }
    }
    if ((kind === 'box' || kind === 'shape') && el.querySelectorAll('*').length <= 1) {
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (text && text.length <= 24) return text;
    }
    return el.localName.toLowerCase();
  };
  /** The layers around this one in its page (nearest first), at most four: the inspector's breadcrumb. */
  const parentsOf = (el) => {
    const out = [];
    for (let node = el.parentElement; node && node !== el.ownerDocument.body && out.length < 4; node = node.parentElement) {
      const kind = kindOf(node) ?? (isGroup(node) ? 'box' : null);
      if (kind) out.push({ loc: locOf(node).loc, label: labelOf(node, kind), kind });
    }
    return out;
  };

  /** All layers under a point of a clip's page, the smallest first (equal areas: the one drawn later first). */
  const layersAt = (c, x, y, includeLocked) => {
    const doc = c.win.document;
    /* what is really at the point: a line's own stroke, not the box around it (a diagonal line's box covers the words
       beside it, and as the smaller box it was taken for them) */
    const under = seeingAll(doc, () => doc.elementsFromPoint(x, y));
    const hits = [];
    layersOf(doc).forEach((el, order) => {
      const rect = mixedText(el) ? wordsRect(el) : el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      if (!under.some((u) => el === u || el.contains(u))) return;
      const frame = frameOf(el, rect);
      if (frame.r && !inFrame(frame, x, y)) return;
      const kind = kindOf(el);
      if (!kind || invisible(el)) return;
      if (!includeLocked && lockedOf(c, el)) return;
      hits.push({ el, kind, rect, frame, area: frame.w * frame.h, order });
    });
    return hits.sort((a, b) => a.area - b.area || b.order - a.order);
  };
  /**
   * A box that fills its whole page is the page's backdrop: a click there takes the clip
   * (moving the picture), not the box (which would only move what is inside the page). It is selected in Layers, or
   * with Alt, and once in hand a click on it keeps it.
   */
  const backdrop = (c, hit) => hit.kind === 'box' && !hit.frame.r
    && hit.rect.left <= 1 && hit.rect.top <= 1 && hit.rect.right >= c.win.innerWidth - 1 && hit.rect.bottom >= c.win.innerHeight - 1;
  /** A layer that fills its whole page, whatever it is (a vignette's box, a grain's canvas, a letterbox's picture). */
  const fillsPage = (c, hit) => !hit.frame.r
    && hit.rect.left <= 1 && hit.rect.top <= 1 && hit.rect.right >= c.win.innerWidth - 1 && hit.rect.bottom >= c.win.innerHeight - 1;
  /**
   * The page a point of the picture is about. The top page under it, unless all it has there fills the page (a
   * letterbox, a vignette, grain laid over the film) while a page under it has a layer of its own there: then that
   * one, so a click on a title under a full-frame overlay takes the title. A layer in hand keeps its own page.
   */
  const pageAt = (x, y, includeLocked, held) => {
    const inside = (c) => { const p = matrixOf(c).inverse().transformPoint(new DOMPoint(x, y)); return p.x >= 0 && p.y >= 0 && p.x <= c.w && p.y <= c.h ? p : null; };
    if (held) {
      const own = shown().find((c) => c.kind === 'page' && c.win && c.win.document === held.ownerDocument && inside(c));
      if (own) return own;
    }
    const top = clipAt(x, y);
    if (!top || top.kind !== 'page' || !top.win) return top;
    for (const c of shown()) {
      const p = inside(c);
      if (!p) continue;
      if (c.kind !== 'page' || !c.win) break;
      if (layersAt(c, p.x, p.y, includeLocked).some((h) => !fillsPage(c, h))) return c;
    }
    return top;
  };
  /** A layer inside a group is the group until the group is entered (a layer of it is in hand). */
  const liftToGroup = (hit, current) => {
    const groups = [];
    for (let n = hit.el.parentElement; n && n !== hit.el.ownerDocument.body; n = n.parentElement) if (isGroup(n)) groups.unshift(n);
    for (const g of groups) {
      if (current && current !== g && g.contains(current)) continue;
      return { el: g, kind: 'box' };
    }
    return hit;
  };

  /**
   * The picture a layer draws, when it is one a file can be put in place of: an <img> (what it shows now, the file an
   * override's `content` puts there before its own), or a box painted with one image (`bg`). A box that holds one
   * <img> filling most of it (a frame around a photo, what a click on it takes first) has that picture: `at` / `n`
   * name the <img>, where the file goes. `changed`: the clip has put another file there.
   */
  const pictureOf = (c, el) => {
    const url = (v) => /^url\("?([^"]*)"?\)$/.exec(v ?? '')?.[1] ?? null;
    const changed = (target, key) => overrideOf(c, target)?.style?.[key] != null;
    const imgOf = (img) => {
      const src = url(css(img).content) ?? (img.currentSrc || img.src);
      return src ? { kind: 'img', src, changed: changed(img, 'content') } : null;
    };
    if (el.localName.toLowerCase() === 'img') return imgOf(el);
    const painted = url(css(el).backgroundImage);
    if (painted) return { kind: 'bg', src: painted, changed: changed(el, 'backgroundImage') };
    const imgs = [...el.querySelectorAll('img')].filter((img) => !img.closest('svg'));
    if (imgs.length !== 1) return null;
    const box = el.getBoundingClientRect();
    const pic = imgs[0].getBoundingClientRect();
    const w = Math.max(0, Math.min(box.right, pic.right) - Math.max(box.left, pic.left));
    const h = Math.max(0, Math.min(box.bottom, pic.bottom) - Math.max(box.top, pic.top));
    if (!(box.width * box.height > 0) || w * h < 0.6 * box.width * box.height) return null;
    const inner = imgOf(imgs[0]);
    return inner ? { ...inner, ...targetOf(imgs[0]) } : null;
  };
  /** What the editor gets of a layer: who it is, and where it is on the stage now. */
  const describe = (c, el, kind = kindOf(el) ?? (isGroup(el) ? 'box' : null)) => {
    if (!kind) return null;
    const M = matrixOf(c);
    const rect = rectOf(el);
    const g = paintedOf(el);
    const group = isGroup(el);
    const local = group
      ? { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, w: rect.width, h: rect.height, r: 0 }
      : measureFrame(el, g.s, totalTurn(el));
    const words = kind === 'text' ? textOf(el) : '';
    const picture = kind === 'image' || kind === 'box' ? pictureOf(c, el) : null;
    const where = locOf(el);
    const turn = clipTurn(M);
    return {
      handle: handleOf(el),
      clip: c.id,
      ...where,
      kind,
      tag: el.localName.toLowerCase(),
      ...(similarOf(el) ? { similar: similarOf(el) } : {}),
      label: labelOf(el, kind),
      ...(words ? { text: { value: words, shape: 'value' } } : {}),
      ...(picture ? { picture } : {}),
      style: styleOf(el, kind),
      parents: parentsOf(el),
      override: overrideOf(c, el),
      group,
      locked: lockedOf(c, el),
      svg: el.namespaceURI === SVG_NS,
      rect: mapRect(M, rect),
      frame: mapFrame(M, local),
      geo: {
        g,
        /* stage px per override px */
        k: localScale(el) * clipScale(M),
        parentR: (el.parentElement ? totalTurn(el.parentElement) : 0) + turn,
        around: totalTurn(el) - ownTurn(el) + turn,
      },
    };
  };
  /** Just where a hovered layer is (asked once a frame). */
  const outline = (c, hit) => {
    const M = matrixOf(c);
    const turned = hit.frame.r || clipTurn(M);
    return { handle: handleOf(hit.el), rect: mapRect(M, hit.rect), ...(turned ? { frame: mapFrame(M, hit.frame) } : {}) };
  };
  /** A layer by its handle, else by its clip and its selector (`at` and `n`, or a `loc`: `at`, or `at#n`). */
  const layerOf = (ref) => {
    let el = nodeOf(ref.handle);
    let c = el ? clipOfNode(el) : null;
    if (!el && ref.clip) {
      c = clipById(ref.clip);
      const doc = c?.win?.document;
      const loc = ref.loc && /^(.*)#(\d+)$/.exec(ref.loc);
      if (doc && ref.at) el = matches(doc, { at: ref.at, n: ref.n })[0] ?? null;
      else if (doc && ref.loc) el = matches(doc, { at: ref.loc })[0] ?? (loc ? matches(doc, { at: loc[1], n: Number(loc[2]) })[0] : null) ?? null;
    }
    return el && c ? { el, c } : null;
  };

  /* ── changes shown before they are kept: the clip's overrides with the drafts merged, as its preview ── */
  const drafts = new Map();
  const sameTarget = (o, t) => o.at === t.at && (o.n ?? null) === (t.n ?? null);
  const show = (c) => {
    const d = drafts.get(c.id);
    if (!d) return;
    const list = (c.overrides ?? []).map((o) => ({ ...o, ...(o.style ? { style: { ...o.style } } : {}) }));
    for (const { target, patch } of d.items.values()) {
      /* null: the override taken away */
      if (patch === null) { const i = list.findIndex((x) => sameTarget(x, target)); if (i >= 0) list.splice(i, 1); continue; }
      let o = list.find((x) => sameTarget(x, target));
      if (!o) { o = { at: target.at, ...(target.n ? { n: target.n } : {}) }; list.push(o); }
      if (patch.t) o.t = patch.t;
      if ('s' in patch) o.s = patch.s;
      if ('r' in patch) o.r = patch.r;
      if (patch.style) {
        const style = { ...(o.style ?? {}) };
        for (const [k, v] of Object.entries(patch.style)) { if (v == null || v === '') delete style[k]; else style[k] = v; }
        o.style = style;
      }
      if ('text' in patch) { if (patch.text == null) delete o.text; else o.text = patch.text; }
    }
    editor()?.preview(c.id, list);
  };
  const draftKey = (target) => `${target.at}\u0000${target.n ?? ''}`;
  /** Show a change of a layer (`patch` null: its override taken away); the blocks written inside it stay put. */
  const draft = (c, target, patch) => {
    let d = drafts.get(c.id);
    if (!d) { d = { base: JSON.stringify(c.overrides ?? []), items: new Map() }; drafts.set(c.id, d); }
    const el = c.win ? matches(c.win.document, target)[0] : null;
    const blocks = el && mixedText(el) ? blocksOf(el).map(blockNow) : null;
    const g0 = blocks ? paintedOf(el) : null;
    const key = draftKey(target);
    const prev = d.items.get(key)?.patch ?? {};
    d.items.set(key, { target, patch: patch === null ? null : { ...prev, ...patch, ...(prev.style || patch.style ? { style: { ...(prev.style ?? {}), ...(patch.style ?? {}) } } : {}) } });
    show(c);
    if (blocks) holdBlocks(c, blocks, g0, paintedOf(el));
  };
  /* what a block keeps when the line it is written in changes: its look (the type it takes from the line) and its place */
  const INHERITED = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'wordSpacing', 'textTransform', 'textAlign', 'textShadow', 'fontVariant'];
  const blockNow = (b) => {
    const cs = css(b);
    const turn = totalTurn(b);
    const f = measureFrame(b, paintedOf(b).s, turn);
    const box = b.getBoundingClientRect();
    /* held by the side its words start from (a block's width follows the line's, its words do not) */
    const align = cs.textAlign;
    const ax = /center/.test(align) ? 0.5 : /right|end/.test(align) ? 1 : 0;
    return {
      b, turn, ax, look: Object.fromEntries(INHERITED.map((k) => [k, cs[k]])),
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      frame: { w: f.w, h: f.h, ow: b.offsetWidth, oh: b.offsetHeight },
    };
  };
  /**
   * The blocks inside a line put back as they were: the type they took from it written on them, then their move, scale
   * and turn undone around where they were (their own overrides, drafted: written with the line's edit, see riders).
   */
  const holdBlocks = (c, before, g0, g1) => {
    /* the line's own scale and turn, undone on each block (exact: from its overrides, not measured) */
    const ks = [g1.s[0] ? g0.s[0] / g1.s[0] : 1, g1.s[1] ? g0.s[1] / g1.s[1] : 1];
    const dr = g0.r - g1.r;
    for (const was of before) {
      const { b } = was;
      const own = overrideOf(c, b)?.style ?? {};
      const cs = css(b);
      const look = {};
      for (const k of INHERITED) if (!(k in own) && cs[k] !== was.look[k]) look[k] = was.look[k];
      if (Object.keys(look).length) draft(c, targetOf(b), { style: look });
      const now = blockNow(b);
      const g = paintedOf(b);
      /* its anchor (the start of its words, its top) where it was, with its box as it will be: its laid-out size at
         the scale and turn it had */
      const rad = (was.turn * Math.PI) / 180;
      const fw = was.frame.ow > 0 ? (was.frame.w * b.offsetWidth) / was.frame.ow : 0;
      const fh = was.frame.oh > 0 ? (was.frame.h * b.offsetHeight) / was.frame.oh : 0;
      const flat = Math.abs(was.turn % 360) < 0.01;
      const w = flat ? (was.box.width * b.offsetWidth) / (was.frame.ow || 1) : Math.abs(fw * Math.cos(rad)) + Math.abs(fh * Math.sin(rad));
      const h = flat ? (was.box.height * b.offsetHeight) / (was.frame.oh || 1) : Math.abs(fw * Math.sin(rad)) + Math.abs(fh * Math.cos(rad));
      const center = { x: was.box.left + was.ax * was.box.width + (0.5 - was.ax) * w, y: was.box.top + h / 2 };
      const moved = Math.hypot(now.box.left + now.box.width / 2 - center.x, now.box.top + now.box.height / 2 - center.y);
      if (Math.abs(ks[0] - 1) < 1e-4 && Math.abs(ks[1] - 1) < 1e-4 && Math.abs(dr) < 0.01 && moved < 0.05) continue;
      const round = (n) => Math.round(n * 10000) / 10000;
      paintAround(b, c, { t: g.t, s: [round(g.s[0] * ks[0]), round(g.s[1] * ks[1])], r: Math.round((g.r + dr) * 100) / 100 }, center);
    }
  };
  const release = (id) => {
    if (!drafts.delete(id)) return;
    editor()?.preview(id, null);
  };
  /* the film was updated: a clip whose kept overrides changed shows them, not the drafts made against the old ones */
  const updated = () => {
    for (const [id, d] of drafts) {
      const c = clipById(id);
      if (!c || JSON.stringify(c.overrides ?? []) !== d.base) release(id);
    }
  };

  const paint = (el, c, g) => draft(c, targetOf(el), { t: [g.t[0], g.t[1]], s: g.s[0] === g.s[1] ? g.s[0] : [g.s[0], g.s[1]], r: g.r });
  /**
   * Paint an override and shift its offset until the layer's center sits at `target` (page px): CSS scales and turns
   * about the box before the page's own transform, so a layer the page moved (or an SVG shape) would otherwise not
   * scale or turn in place. The offset is outermost, a pure shift: paint, measure, correct, two or three times.
   */
  const paintAround = (el, c, g, target) => {
    /* the center moves with the offset as an affine map (whatever turns and scales the parents): measured at the offset
       and one px along each axis, then solved for the offset that puts it at `target` */
    const centerAt = (t) => {
      paint(el, c, { ...g, t });
      const box = mixedText(el) ? wordsRect(el) : el.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    };
    const t0 = [g.t[0], g.t[1]];
    const p0 = centerAt(t0);
    let t = t0;
    if (Math.abs(target.x - p0[0]) >= 0.05 || Math.abs(target.y - p0[1]) >= 0.05) {
      const px = centerAt([t0[0] + 1, t0[1]]);
      const py = centerAt([t0[0], t0[1] + 1]);
      const a = px[0] - p0[0]; const b = py[0] - p0[0]; const cy = px[1] - p0[1]; const d = py[1] - p0[1];
      const det = a * d - b * cy;
      const ex = target.x - p0[0]; const ey = target.y - p0[1];
      if (Math.abs(det) > 1e-9) t = [t0[0] + (d * ex - b * ey) / det, t0[1] + (a * ey - cy * ex) / det];
    }
    t = [Math.round(t[0] * 10) / 10, Math.round(t[1] * 10) / 10];
    paint(el, c, { ...g, t });
    return { ...g, t };
  };
  /** Where a frame's center goes when it takes a new size with `pivot` (a corner, an edge or the center) held. */
  const pivotCenter = (f, next, pivot) => {
    const rad = (f.r * Math.PI) / 180;
    const ux = { x: Math.cos(rad), y: Math.sin(rad) };
    const uy = { x: -Math.sin(rad), y: Math.cos(rad) };
    const ax = f.cx + (ux.x * pivot.hx * f.w) / 2 + (uy.x * pivot.hy * f.h) / 2;
    const ay = f.cy + (ux.y * pivot.hx * f.w) / 2 + (uy.y * pivot.hy * f.h) / 2;
    return { x: ax - (ux.x * pivot.hx * next.w) / 2 - (uy.x * pivot.hy * next.h) / 2, y: ay - (ux.y * pivot.hx * next.w) / 2 - (uy.y * pivot.hy * next.h) / 2 };
  };
  const pair = (s) => (Array.isArray(s) ? [s[0] ?? 1, s[1] ?? 1] : typeof s === 'number' && s > 0 ? [s, s] : [1, 1]);
  const placed = (el, c) => {
    const M = matrixOf(c);
    const g = paintedOf(el);
    return { rect: mapRect(M, rectOf(el)), frame: mapFrame(M, measureFrame(el, g.s, totalTurn(el))) };
  };

  /* ── typing a line in place ── */
  let editing = null;
  /**
   * The box typed in when the line cannot be typed in itself: an SVG text (no contentEditable there), or a line with
   * inline parts (only its own words are its text). Fixed in the page over the line, in its type, the line hidden.
   */
  const openOverlay = (el) => {
    const doc = el.ownerDocument;
    const rect = el.getBoundingClientRect();
    const cs = css(el);
    const svg = isSvgText(el);
    let scale = 1;
    if (svg) {
      try {
        const bb = el.getBBox?.();
        if (bb && bb.height > 0 && rect.height > 0) scale = rect.height / bb.height;
        else { const ctm = el.getScreenCTM?.(); if (ctm) scale = Math.hypot(ctm.a, ctm.b) || 1; }
      } catch { scale = 1; }
    }
    const round = (n) => Math.round(n * 100) / 100;
    const size = pxNumber(cs.fontSize);
    const spacing = pxNumber(cs.letterSpacing);
    const fill = cs.fill.trim();
    const color = svg ? (/^url\(/i.test(fill) || fill === 'none' || !fill ? '#ffffff' : fill) : cs.color;
    const align = svg ? (cs.textAnchor === 'middle' ? 'center' : cs.textAnchor === 'end' ? 'right' : 'left') : cs.textAlign;
    const box = doc.createElement('div');
    box.setAttribute(EDITOR_ATTR, '');
    box.textContent = textOf(el);
    const style = {
      position: 'fixed', left: `${round(rect.left)}px`, top: `${round(rect.top)}px`,
      'min-width': `${round(Math.max(1, rect.width))}px`, 'min-height': `${round(Math.max(1, rect.height))}px`,
      ...(svg ? { height: `${round(Math.max(1, rect.height))}px`, 'line-height': `${round(Math.max(1, rect.height))}px` } : { 'line-height': cs.lineHeight }),
      margin: '0', padding: '0', border: '0', background: 'transparent', 'box-sizing': 'content-box',
      'white-space': svg ? 'pre' : 'pre-wrap', 'text-align': align,
      'font-family': cs.fontFamily, 'font-weight': cs.fontWeight, 'font-style': cs.fontStyle || 'normal',
      'font-size': size != null ? `${round(size * scale)}px` : cs.fontSize,
      ...(spacing != null ? { 'letter-spacing': `${round(spacing * scale)}px` } : {}),
      ...(cs.textTransform && cs.textTransform !== 'none' ? { 'text-transform': cs.textTransform } : {}),
      color, 'z-index': '2147483647',
    };
    for (const [name, value] of Object.entries(style)) box.style.setProperty(name, value, 'important');
    (doc.body ?? doc.documentElement).appendChild(box);
    return box;
  };
  const finishText = (commit) => {
    const edit = editing;
    if (!edit) return;
    editing = null;
    edit.cleanup();
    const { el, host, c } = edit;
    const value = edit.overlay ? collapse(host.innerText ?? host.textContent ?? '') : stageText(host);
    if (edit.overlay) host.remove();
    const put = (name, v) => { if (v == null) el.removeAttribute(name); else el.setAttribute(name, v); };
    put('contenteditable', edit.attrs.contentEditable);
    put('style', edit.attrs.style);
    put('spellcheck', edit.attrs.spellcheck);
    for (const [b, style] of edit.blocks) { if (style == null) b.removeAttribute('style'); else b.setAttribute('style', style); }
    el.replaceChildren(...edit.children);
    edit.data.forEach((text, n) => { n.data = text; });
    el.ownerDocument.getSelection()?.removeAllRanges();
    const kept = commit && value && value !== edit.before;
    /* the new words stay on screen until the edit is kept (or refused: the editor releases the clip), with what held
       the others in place as they were typed (kept with them) */
    const hold = kept && edit.hold && Object.keys(edit.hold).length ? edit.hold : null;
    if (kept) draft(c, edit.target, { text: value, ...(hold ? { style: hold } : {}) });
    post({ type: 'stage-event', event: 'text', handle: edit.handle, commit: Boolean(kept), ...(kept ? { value, before: edit.before, ...(hold ? { hold } : {}) } : {}) });
  };
  /**
   * Only `el` takes the pointer in its document until the returned function is called. While a line is typed in, a
   * press on its words moves the caret or selects them, though the page draws something over it there (a number still
   * to come in, at opacity 0; a grain) or another clip lies on top; a press anywhere else blurs it, which keeps it.
   */
  const TYPING_ATTR = 'data-openfilm-typing';
  const onlyHit = (el) => {
    const doc = el.ownerDocument;
    const style = doc.createElement('style');
    style.textContent = `* { pointer-events: none !important; } [${TYPING_ATTR}], [${TYPING_ATTR}] * { pointer-events: auto !important; }`;
    el.setAttribute(TYPING_ATTR, '');
    (doc.head ?? doc.documentElement).append(style);
    return () => { style.remove(); el.removeAttribute(TYPING_ATTR); };
  };
  const startText = ({ handle }) => {
    const el = nodeOf(handle);
    const c = el && clipOfNode(el);
    if (!el || !c || editing) return false;
    const doc = el.ownerDocument;
    const data = new Map();
    const walker = doc.createTreeWalker(el, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) data.set(n, n.data);
    const attrs = { contentEditable: el.getAttribute('contenteditable'), style: el.getAttribute('style'), spellcheck: el.getAttribute('spellcheck') };
    /* typed in place, lines and all, where it can be: the line keeps its own width and wraps as it does */
    const overlay = isSvgText(el) || !onlyBreaks(el);
    /* typed in place, the words beside it and under it stay where they are as it grows (holdSearch), its box hugging
       them: worked out from the page as it is now, and shown on it as each word is typed */
    const search = !overlay && el instanceof c.win.HTMLElement ? holdSearch(c.win, el, keptHold(c, targetOf(el)).unheld) : null;
    const kebab = (k) => k.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
    const inlineWas = new Map(HOLD_KEYS.map((k) => [k, [el.style.getPropertyValue(kebab(k)), el.style.getPropertyPriority(kebab(k))]]));
    const holdInline = (extra) => {
      for (const k of HOLD_KEYS) {
        const prop = kebab(k);
        if (!(k in extra)) { const [v, pr] = inlineWas.get(k); if (v) el.style.setProperty(prop, v, pr); else el.style.removeProperty(prop); }
        else if (extra[k] == null) el.style.removeProperty(prop);
        else el.style.setProperty(prop, extra[k], 'important');
      }
    };
    /* the editor shows the words as they are typed (the inspector's box with them); they are kept at Enter or blur */
    const onInput = () => {
      if (!editing) return;
      if (search) editing.hold = search(holdInline);
      post({ type: 'stage-event', event: 'typing', handle, value: overlay ? collapse(host.innerText ?? host.textContent ?? '') : stageText(host) });
    };
    const host = overlay ? openOverlay(el) : el;
    /* the line hidden under its overlay, the blocks in it still shown (they are not what is typed) */
    const blocks = overlay ? blocksIn(el).map((b) => [b, b.getAttribute('style')]) : [];
    if (overlay) el.style.setProperty('visibility', 'hidden', 'important');
    for (const [b] of blocks) b.style.setProperty('visibility', 'visible', 'important');
    try { host.contentEditable = 'plaintext-only'; } catch { host.contentEditable = 'true'; }
    if (host.contentEditable !== 'plaintext-only') host.contentEditable = 'true';
    host.spellcheck = false;
    for (const [name, value] of [['user-select', 'text'], ['-webkit-user-select', 'text'], ['cursor', 'text'], ['outline', 'none'], ['pointer-events', 'auto'], ['caret-color', BLUE]]) {
      host.style.setProperty(name, value, 'important');
    }
    /* Shift+Enter breaks the line (where the words can hold one); Enter keeps them, Esc gives them up */
    const lines = !overlay;
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); finishText(false); }
      else if (e.key === 'Enter' && !(lines && e.shiftKey)) { e.preventDefault(); finishText(true); }
    };
    const onBlur = () => finishText(true);
    host.addEventListener('keydown', onKey);
    host.addEventListener('blur', onBlur);
    host.addEventListener('input', onInput);
    editing = {
      el, host, c, handle, overlay, data, attrs, blocks, target: targetOf(el),
      children: [...el.childNodes],
      before: textOf(el),
      hold: null,
      cleanup: () => { host.removeEventListener('keydown', onKey); host.removeEventListener('blur', onBlur); host.removeEventListener('input', onInput); release(); },
    };
    /* the line in its page, and its page in the film */
    const hits = [onlyHit(host), onlyHit(c.el)];
    const release = () => { for (const off of hits) off(); };
    window.focus();
    c.win.focus();
    host.focus({ preventScroll: true });
    doc.getSelection()?.selectAllChildren(host);
    return true;
  };

  /* ── keys pressed while the picture has focus go to the editor (its own keys work there too) ── */
  const typing = (target) => {
    const el = target?.nodeType === 1 ? target : null;
    return Boolean(el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable));
  };
  const EDITOR_KEYS = new Set([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', '[', ']']);
  const onKey = (e) => {
    if (editing || typing(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    /* ⌘A is the editor's select-all, not the page's text selected */
    if ((EDITOR_KEYS.has(e.key) && !mod) || (mod && (k === 'z' || (k === 'a' && !e.shiftKey && !e.altKey) || (e.shiftKey && (k === 'h' || k === 'l'))))) e.preventDefault();
    post({ type: 'stage-event', event: 'key', key: e.key, code: e.code, repeat: e.repeat, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
  };
  /* by document: a page closed and opened again (the timeline does, far from the playhead) is a new one to hear */
  const listening = new WeakSet();
  const listen = (win) => {
    if (!win?.document || listening.has(win.document)) return;
    listening.add(win.document);
    win.addEventListener('keydown', onKey, true);
  };
  const listenAll = () => { listen(window); for (const c of clips()) if (c.win) listen(c.win); };
  listen(window);
  (async () => {
    while (!window.film) await new Promise((r) => setTimeout(r, 20));
    try { await window.film.ready; } catch { return; }
    listenAll();
    const h = hooks();
    /* an update may have added pages: their keys are heard too */
    if (h) { h.updated = () => { listenAll(); updated(); }; h.woke = listenAll; }
  })();

  /* ── restacking ── */
  /** Hit tests that see every layer (a page may turn pointer events off), for as long as `fn` runs. */
  const seeingAll = (doc, fn) => {
    const probe = doc.createElement('style');
    probe.textContent = '* { pointer-events: auto !important; }';
    doc.head.append(probe);
    try { return fn(); } finally { probe.remove(); }
  };
  /**
   * Whether `upper` (or anything in it) is drawn over `lower` where their boxes overlap, as hit tests at a few points
   * there find them: null when they do not overlap or nothing of them is found there. The page's paint, not a model
   * of it (a transformed layer deep inside a group is drawn with the positioned ones, wherever its group is).
   */
  const drawnOver = (upper, lower) => {
    const doc = upper.ownerDocument;
    const a = upper.getBoundingClientRect();
    const b = lower.getBoundingClientRect();
    const l = Math.max(a.left, b.left), t = Math.max(a.top, b.top);
    const r = Math.min(a.right, b.right), bt = Math.min(a.bottom, b.bottom);
    if (r - l < 1 || bt - t < 1) return null;
    let over = 0;
    let under = 0;
    for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
      const hits = doc.elementsFromPoint(l + (r - l) * fx, t + (bt - t) * fy);
      const iu = hits.findIndex((h) => upper === h || upper.contains(h));
      const il = hits.findIndex((h) => lower === h || lower.contains(h));
      if (iu < 0 || il < 0) continue;
      if (iu < il) over += 1; else under += 1;
    }
    return over + under ? over > under : null;
  };
  const near = (p, q) => Math.abs(p.left - q.left) < 0.5 && Math.abs(p.top - q.top) < 0.5 && Math.abs(p.width - q.width) < 0.5 && Math.abs(p.height - q.height) < 0.5;
  /**
   * Restacking edits (override targets and styles) as they can be kept, or null. A position given to a layer the page
   * left static makes the offsets its CSS gave it count (top: 2em on a static block is nothing, on a relative one a
   * shift), so the edits are shown for a moment and every layer measured, then again with those offsets set back to
   * auto. `check`, asked while they are shown: whether they do what they were for.
   */
  const steady = (c, edits, check = () => true) => {
    const seen = layersOf(c.win.document);
    const before = seen.map((o) => o.getBoundingClientRect());
    const had = drafts.get(c.id);
    const kept = had && new Map(had.items);
    const holds = (list) => {
      for (const e of list) draft(c, e.target, { style: e.style });
      const ok = seen.every((o, i) => near(o.getBoundingClientRect(), before[i])) && check();
      if (had) { had.items = new Map(kept); drafts.set(c.id, had); show(c); } else release(c.id);
      return ok;
    };
    if (holds(edits)) return edits;
    const inset = { top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' };
    const pinned = edits.map((e) => (e.style.position ? { ...e, style: { ...e.style, ...inset } } : e));
    return pinned.some((e) => e.style.position) && holds(pinned) ? pinned : null;
  };

  /* ── a layer restyled: the others stay where they are; one layer's look never moves another ── */
  /** The style a hold sets (holdFor): kept apart from what the person set, so a new hold replaces the one before. */
  const HOLD_KEYS = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'width'];
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  /**
   * The search for a hold, begun while the page shows `el` as it was: what the other layers' places are, the room `el`
   * takes in the page's flow, where its words sit. Returned: the search itself, given how to show `el` changed with a
   * hold's style on it (`show`, style keys to null take a kept one away). `unheld`: a hold kept before, taken away
   * first (it was for the change before).
   *
   * The layer takes its new size (its box grows with a larger font or more words); margins
   * give back to the page's flow the room it gained or lost, on the side the flow lays it out from, so what is beside
   * it, under it or lined up with its baseline stays put. Words in a block as wide as what holds it get a box that hugs
   * them, and stay where they were set in it (centered, at its end).
   */
  const holdSearch = (win, el, unheld) => {
    const others = layersOf(el.ownerDocument).filter((o) => o !== el && !o.contains(el) && !el.contains(o));
    const before = others.map((o) => o.getBoundingClientRect());
    const marginsNow = () => {
      const cs = win.getComputedStyle(el);
      return Object.fromEntries(SIDES.map((side) => [side, Number.parseFloat(cs[`margin${side}`]) || 0]));
    };
    const was = marginsNow();
    const roomW = el.offsetWidth + was.Left + was.Right;
    const roomH = el.offsetHeight + was.Top + was.Bottom;
    const cs = win.getComputedStyle(el);
    const fit = Boolean(textOf(el)) && !isGroup(el) && /^(block|flow-root|list-item)$/.test(cs.display) ? { width: 'fit-content' } : {};
    const align = cs.textAlign;
    const anchorOf = () => (/center/.test(align) ? el.offsetLeft + el.offsetWidth / 2 : /right|end/.test(align) ? el.offsetLeft + el.offsetWidth : el.offsetLeft);
    const anchor0 = anchorOf();
    /* how far the others went, the furthest, and which way up or down */
    const moved = () => {
      let far = 0;
      let dy = 0;
      others.forEach((o, i) => {
        const r = o.getBoundingClientRect();
        const d = Math.max(Math.abs(r.left - before[i].left), Math.abs(r.top - before[i].top));
        if (d > far) { far = d; dy = r.top - before[i].top; }
      });
      return { far, dy };
    };
    return (show) => {
      const base = { ...unheld, ...fit };
      show(base);
      /* changed, with the page's own margins: the room it would take, more or less than it takes now */
      const margin = marginsNow();
      const shift = fit.width ? anchor0 - anchorOf() : 0;
      const dw = el.offsetWidth + margin.Left + margin.Right - roomW;
      const dh = el.offsetHeight + margin.Top + margin.Bottom - roomH;
      const hold = (give) => {
        const side = { ...give, Left: (give.Left ?? 0) - shift, Right: (give.Right ?? 0) + shift };
        return { ...base, ...Object.fromEntries(SIDES.filter((k) => side[k]).map((k) => [`margin${k}`, `${Math.round((margin[k] - side[k]) * 100) / 100}px`])) };
      };
      show(hold({}));
      const alone = moved().far;
      if (alone < 0.5) return hold({});
      let best = { hold: hold({}), far: alone };
      const tryGive = (give) => {
        const h = hold(give);
        show(h);
        const m = moved();
        if (m.far < best.far) best = { hold: h, far: m.far };
        return m;
      };
      /* laid out from the start, the middle or the end of its row and of its column */
      const across = [{ Right: dw }, { Left: dw / 2, Right: dw / 2 }, { Left: dw }];
      const down = [{ Bottom: dh }, { Top: dh / 2, Bottom: dh / 2 }, { Top: dh }];
      for (const x of across) {
        for (const y of down) {
          const give = { ...x, ...y };
          let m = tryGive(give);
          /* lined up by its baseline: the words sit higher or lower in the new box, the room above them gives that back */
          for (let i = 0; i < 2 && m.far >= 0.5 && Math.abs(m.dy) >= 0.5; i++) {
            give.Top = (give.Top ?? 0) + m.dy;
            give.Bottom = (give.Bottom ?? 0) - m.dy;
            m = tryGive(give);
          }
          if (best.far < 0.5) return best.hold;
        }
      }
      show(best.hold);
      return best.hold;
    };
  };
  /** The style keys of a hold kept for this layer, to null: taken away before a hold is worked out again. */
  const keptHold = (c, target) => {
    const kept = (c.overrides ?? []).find((o) => o.at === target.at && (o.n ?? null) === (target.n ?? null));
    return { style: kept?.style ?? {}, text: kept?.text, unheld: Object.fromEntries(HOLD_KEYS.filter((k) => k in (kept?.style ?? {})).map((k) => [k, null])) };
  };
  /**
   * What the layer at `target` needs besides `style` (and new words, `text`) so that no other layer of its page moves
   * (holdSearch): style for the same override; {} when it needs none, or the change is what is kept already (a preview
   * taken back: the hold kept with it stands). Measured against the page as shown without this change (the kept
   * overrides, and other changes not kept yet).
   */
  const holdFor = (c, target, style, text) => {
    const doc = c.win?.document;
    /* a size or margin the person sets is meant to move what is around it */
    if (!doc || ['width', 'height', ...HOLD_KEYS, 'margin'].some((k) => k in style)) return {};
    const kept = keptHold(c, target);
    if (Object.entries(style).every(([k, v]) => k in kept.style && String(kept.style[k]) === String(v)) && (text == null || text === kept.text)) return {};
    const had = drafts.get(c.id);
    const items0 = had && new Map(had.items);
    const key = draftKey(target);
    const own = items0?.get(key)?.patch;
    const ownStyle = { ...(own?.style ?? {}) };
    for (const k of [...Object.keys(style), ...HOLD_KEYS]) delete ownStyle[k];
    const { text: _ownText, ...ownRest } = own ?? {};
    const showWith = (extra, changed) => {
      const items = new Map(items0 ?? []);
      const patch = { ...(changed || text == null ? own ?? {} : ownRest), style: { ...ownStyle, ...(changed ? style : {}), ...extra }, ...(changed && text != null ? { text } : {}) };
      items.set(key, { target, patch });
      drafts.set(c.id, { base: had?.base ?? JSON.stringify(c.overrides ?? []), items });
      show(c);
    };
    try {
      showWith({}, false);
      const el = matches(doc, target)[0];
      if (!el || !(el instanceof c.win.HTMLElement)) return {};
      return holdSearch(c.win, el, kept.unheld)((extra) => showWith(extra, true));
    } finally {
      if (had) { had.items = new Map(items0); drafts.set(c.id, had); show(c); } else release(c.id);
    }
  };

  /* ── the Layers panel's tree ── */
  const ROWS = 800;
  /** Per element, whether the clip's kept overrides hide it (the panel's eye) or lock it: the last one to say counts. */
  const ownOverrides = (c) => {
    const out = new Map();
    for (const o of c.overrides ?? []) {
      const says = {
        ...(o.style && 'visibility' in o.style ? { hidden: o.style.visibility === 'hidden' } : {}),
        ...('lock' in o ? { locked: o.lock === true } : {}),
      };
      if (Object.keys(says).length) for (const el of matches(c.win.document, o)) out.set(el, { ...out.get(el), ...says });
    }
    return out;
  };
  const nameOf = (el) => {
    if (el.id) return `#${el.id}`;
    const cls = [...el.classList].find((k) => /^[A-Za-z_][\w-]*$/.test(k));
    return cls ? `${el.localName}.${cls}` : el.localName;
  };
  /**
   * A page's layers as rows: words, pictures and SVG drawings are rows without rows inside; an element around
   * several rows is a group row (its own paint, if any, makes it a box); one around a single row is no row of its
   * own (that row stands for it). `branch` is the handle of the child of the row's parent row that holds it: rows are
   * restacked by it. `off`: not drawn at this moment (faded out, hidden, no size).
   */
  const rowsOf = (c) => {
    let count = 0;
    const doc = c.win.document;
    const kept = ownOverrides(c);
    const collect = (parentEl) => {
      const out = [];
      for (const ch of parentEl.children) {
        if (count >= ROWS) break;
        const tag = ch.localName.toLowerCase();
        if (SKIP.has(tag) || ch.hasAttribute(EDITOR_ATTR)) continue;
        const kind = kindOf(ch) ?? (isGroup(ch) ? 'box' : null);
        const leaf = tag === 'svg' || kind === 'text' || kind === 'image';
        const inner = leaf ? [] : collect(ch);
        if (!kind && !leaf) {
          if (!inner.length) continue;
          if (inner.length === 1) { out.push({ ...inner[0], branch: handleOf(ch), at: ch }); continue; }
        }
        count += 1;
        const own = kept.get(ch) ?? {};
        const r = ch.getBoundingClientRect();
        const where = locOf(ch);
        const named = kind ? labelOf(ch, kind) : tag;
        out.push({
          handle: handleOf(ch),
          branch: handleOf(ch),
          at: ch,
          loc: where.loc,
          ...(where.instance ? { instance: where.instance } : {}),
          tag,
          kind: kind ?? (leaf ? 'shape' : 'group'),
          /* a layer with nothing better to go by than its tag goes by its id or class */
          label: named === tag ? nameOf(ch) : named,
          hidden: own.hidden === true,
          locked: own.locked === true,
          off: invisible(ch) || css(ch).visibility === 'hidden' || r.width < 1 || r.height < 1,
          children: inner,
        });
      }
      /* the one drawn on top first; `at` is the element each row is restacked by, dropped once sorted */
      const drawn = siblingOrder(out.map((r) => r.at));
      return out.sort((a, b) => drawn.indexOf(b.at) - drawn.indexOf(a.at)).map(({ at, ...row }) => row);
    };
    return collect(doc.body);
  };

  /* ── the ops ── */
  const ops = {
    /** The layer under a point: the smallest (Alt: the next one under `cycleFrom`); groups stand for their layers. */
    hit({ x, y, cycleFrom, includeLocked, from, enter, detail }) {
      const c = pageAt(x, y, Boolean(includeLocked), nodeOf(cycleFrom) ?? nodeOf(from));
      if (!c || c.kind !== 'page' || !c.win) return null;
      const p = matrixOf(c).inverse().transformPoint(new DOMPoint(x, y));
      const all = layersAt(c, p.x, p.y, Boolean(includeLocked));
      let current = nodeOf(from);
      if (enter && current) current = current.firstElementChild;
      const cycle = nodeOf(cycleFrom);
      let hit;
      if (!cycle || all.length < 2) hit = all[0] && (cycle || all[0].el === current || !backdrop(c, all[0])) ? liftToGroup(all[0], current) : null;
      else hit = all[(all.findIndex((h) => h.el === cycle) + 1) % all.length] ?? all[0];
      if (!hit) return null;
      if (detail) return describe(c, hit.el, hit.kind);
      const rect = hit.rect ?? rectOf(hit.el);
      return outline(c, { el: hit.el, rect, frame: hit.frame ?? frameOf(hit.el, rect) });
    },
    /** A layer again, by handle, else by its clip and selector (after the page was drawn anew). */
    /** `any`: a layer that paints nothing itself (a Layers panel group) is taken as a box. */
    layer(ref) {
      const found = layerOf(ref);
      if (!found) return null;
      return describe(found.c, found.el, kindOf(found.el) ?? (isGroup(found.el) || ref.any ? 'box' : null));
    },
    layers({ refs }) { return refs.map((ref) => { const found = layerOf(ref); return found ? describe(found.c, found.el) : null; }); },
    /**
     * The outermost layers wholly inside a stage box (a marquee): not locked, not faded out, not under a pixel. `all`:
     * every one of them, those inside others too (the words in a box drawn to point at).
     */
    box({ x, y, w, h, all }) {
      const out = [];
      for (const c of shown()) {
        if (c.kind !== 'page' || !c.win) continue;
        const M = matrixOf(c);
        const inside = layersOf(c.win.document).filter((el) => {
          if (!(kindOf(el) || isGroup(el))) return false;
          const r = mapRect(M, rectOf(el));
          if (r.width < 1 || r.height < 1) return false;
          if (r.left < x || r.top < y || r.left + r.width > x + w || r.top + r.height > y + h) return false;
          return !invisible(el) && !lockedOf(c, el);
        });
        for (const el of inside) if (all || !inside.some((other) => other !== el && other.contains(el))) out.push(describe(c, el));
      }
      return out.filter(Boolean);
    },
    /** What the snapping of a layer move can catch: the stage, and up to 80 other visible layers of its page. */
    snaps({ handle }) {
      const el = nodeOf(handle);
      const c = el && clipOfNode(el);
      const out = [{ x: 0, y: 0, w: document.body.offsetWidth, h: document.body.offsetHeight }];
      if (!el || !c) return out;
      const M = matrixOf(c);
      for (const other of layersOf(c.win.document)) {
        if (out.length > 80) break;
        if (other === el || other.contains(el) || el.contains(other)) continue;
        const r = other.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || invisible(other)) continue;
        const m = mapRect(M, r);
        out.push({ x: m.left, y: m.top, w: m.width, h: m.height });
      }
      return out;
    },
    /** The picture clips: whether each is on screen now, and its box on the stage. */
    clips() {
      const on = new Set(shown());
      return clips().filter((c) => c.el && c.kind !== 'sound').map((c) => {
        const r = mapRect(matrixOf(c), { left: 0, top: 0, width: c.w, height: c.h });
        return { id: c.id, visible: on.has(c), x: r.left, y: r.top, w: r.width, h: r.height };
      });
    },
    /** `pictures`: a video or a still only (a page is clicked by its layers; what is under its empty parts is found). */
    clipAt({ x, y, pictures }) { return clipAt(x, y, Boolean(pictures))?.id ?? null; },
    /** Show a clip placed in a box not kept yet (null: in its own again). */
    place({ clip, box }) { hooks()?.place(clip, box ?? null); return true; },
    /** Show a clip in CSS of its own not kept yet (null: its own again). */
    look({ clip, css }) { hooks()?.look?.(clip, typeof css === 'string' ? css : null); return true; },
    /** Show a layer's move / scale / turn; with `center` (stage px), its offset keeps its center there. */
    paint({ handle, g, center }) {
      const el = nodeOf(handle);
      const c = el && clipOfNode(el);
      if (!el || !c) return null;
      let out = g;
      if (center) {
        const p = matrixOf(c).inverse().transformPoint(new DOMPoint(center.x, center.y));
        out = paintAround(el, c, g, { x: p.x, y: p.y });
      } else paint(el, c, g);
      return { g: out, ...placed(el, c) };
    },
    paintMany({ items }) {
      return items.map(({ handle, g }) => {
        const el = nodeOf(handle);
        const c = el && clipOfNode(el);
        if (!el || !c) return null;
        paint(el, c, g);
        return placed(el, c);
      });
    },
    /** The inspector's live tweaks of a layer (named by clip and selector): style keys, words, geometry. */
    tweak({ clip, at, n, patch }) {
      const c = clipById(clip);
      if (!c || c.kind !== 'page') return false;
      const target = n ? { at, n } : { at };
      if (!patch.style && typeof patch.text !== 'string') { draft(c, target, patch); return true; }
      /* restyled or retyped, held in place (holdFor): the hold shown before gives way to this one */
      const style = patch.style ?? {};
      const hold = holdFor(c, target, style, typeof patch.text === 'string' ? patch.text : undefined);
      const shown = drafts.get(c.id)?.items.get(draftKey(target))?.patch.style;
      if (shown) for (const k of HOLD_KEYS) if (!(k in style)) delete shown[k];
      draft(c, target, { ...patch, style: { ...style, ...hold } });
      return true;
    },
    /**
     * What goes with an edit of a line that has blocks written inside it (`patch` null: its override taken away): the
     * edit shown, the overrides of the layers inside it that keep them where they were and as they looked, to be
     * written with it ([] for any other layer).
     */
    riders({ clip, at, n, patch }) {
      const c = clipById(clip);
      const target = n ? { at, n } : { at };
      const el = c?.win ? matches(c.win.document, target)[0] : null;
      if (!c || !el || !mixedText(el)) return [];
      draft(c, target, patch ?? null);
      const out = [];
      for (const item of drafts.get(c.id)?.items.values() ?? []) {
        const inner = matches(c.win.document, item.target)[0];
        if (inner && inner !== el && el.contains(inner) && item.patch) out.push({ ...item.target, patch: item.patch });
      }
      return out;
    },
    /** What keeps the other layers in place when this style (and these words) is kept for the layer at `at` (holdFor). */
    hold({ clip, at, n, style, text }) {
      const c = clipById(clip);
      return c?.kind === 'page' ? holdFor(c, n ? { at, n } : { at }, style ?? {}, typeof text === 'string' ? text : undefined) : {};
    },
    /**
     * The inspector's scale / turn of a layer about a pivot (a corner of its box, or its center): the offset that keeps
     * that point in place, shown.
     */
    pivot({ clip, at, n, base, patch, pivot }) {
      const c = clipById(clip);
      const el = c?.win ? matches(c.win.document, { at, n })[0] : null;
      if (!el || !c) return null;
      const b = { t: base.t ?? [0, 0], s: pair(base.s), r: base.r ?? 0 };
      paint(el, c, b);
      const f0 = measureFrame(el, b.s, totalTurn(el));
      const next = pair(patch.s ?? base.s);
      const center = pivotCenter(f0, { w: (f0.w * next[0]) / b.s[0], h: (f0.h * next[1]) / b.s[1] }, pivot);
      return paintAround(el, c, { t: patch.t ?? b.t, s: next, r: patch.r ?? b.r }, center).t;
    },
    /**
     * The person's changes inside pages whose element the page no longer has: per page clip with changes (or only
     * `clip`), the selectors (`at`) of the lost ones. A change is lost when its page is drawn, no frame drawn so far
     * found its element and the page does not have it now either (an element a page makes only at some moments is
     * not lost once a frame found it).
     */
    lostOverrides({ clip } = {}) {
      return clips()
        .filter((c) => c.kind === 'page' && c.win && c.drawn && c.overrides?.length && (clip == null || c.id === clip))
        .map((c) => ({
          clip: c.id,
          lost: c.overrides.filter((o, i) => o?.at && !c.found?.[i] && !matches(c.win.document, o).length).map((o) => o.at),
        }));
    },
    /** Stop showing what was not kept on a clip (a refused edit, a cancelled drag). */
    release({ clip }) { release(clip); return true; },
    /**
     * Bring a layer to the front of what it overlaps, or send it to the back of it — whatever part
     * of the page the other layer is in. A z-index orders only siblings, so for each layer it overlaps the order is
     * set where the two meet: on the two branches under their nearest common ancestor, the branch it is in is given a
     * z-index past the other's (with position: relative where it has none, which moves nothing). Sent back, a common
     * ancestor that is no stacking context is made one (isolation), or a negative z-index would go behind its
     * background. Answers the edits (an override target and its style) and, when there is nothing to do, why:
     * 'alone' (it overlaps nothing), 'already' (it is in front / at the back already), 'blocked' (a branch cannot be
     * given a position without moving what is placed inside it).
     */
    arrange({ handle, to }) {
      const el = nodeOf(handle);
      const c = el && clipOfNode(el);
      if (!el || !c) return null;
      const doc = el.ownerDocument;
      const front = to === 'front';
      const others = [];
      seeingAll(doc, () => {
        for (const o of layersOf(doc)) {
          if (o === el || o.contains(el) || el.contains(o) || invisible(o) || !kindOf(o)) continue;
          const above = drawnOver(o, el);
          if (above != null) others.push({ o, above });
        }
      });
      if (!others.length) return { edits: [], reason: 'alone' };
      const todo = others.filter((x) => (front ? x.above : !x.above));
      if (!todo.length) return { edits: [], reason: 'already' };
      /** per branch to restack: the z-index it needs */
      const want = new Map();
      const isolate = new Set();
      for (const { o } of todo) {
        let lca = el.parentElement;
        while (lca && !lca.contains(o)) lca = lca.parentElement;
        if (!lca) continue;
        const branch = (x) => { let n = x; while (n.parentElement !== lca) n = n.parentElement; return n; };
        const a = branch(el);
        const b = branch(o);
        const z = front ? Math.max(zOf(b) ?? 0, 0) + 1 : Math.min(zOf(b) ?? 0, 0) - 1;
        const prev = want.get(a);
        want.set(a, prev == null ? z : front ? Math.max(prev, z) : Math.min(prev, z));
        if (!front && !stackingContext(lca)) isolate.add(lca);
      }
      const edits = [];
      for (const [a, z] of want) {
        const needs = !placedIn(a);
        if (needs && unsafe(a)) return { edits: [], reason: 'blocked' };
        const now = zOf(a);
        if (now != null && (front ? now >= z : now <= z)) continue;
        edits.push({ target: targetOf(a), style: { zIndex: z, ...(needs ? { position: 'relative' } : {}) } });
      }
      for (const lca of isolate) edits.push({ target: targetOf(lca), style: { isolation: 'isolate' } });
      if (!edits.length) return { edits: [], reason: 'already' };
      const kept = steady(c, edits, () => seeingAll(doc, () => todo.every(({ o }) => drawnOver(front ? el : o, front ? o : el) !== false)));
      return kept ? { edits: kept, reason: null } : { edits: [], reason: 'blocked' };
    },
    /**
     * The layers of the picture clips shown now, the top clip first; a page's as a tree, each level in the order it
     * is drawn, the one on top first (the Layers panel). See rowsOf.
     */
    tree() {
      return shown().map((c) => ({ clip: c.id, kind: c.kind, layers: c.kind === 'page' && c.win?.document?.body ? rowsOf(c) : [] }));
    },
    /**
     * Restack siblings in the order a person put them in (the Layers panel): `order` the handles of the elements
     * under one parent, the top one first, `moved` the one that was moved. Only the moved one is given a z-index when
     * a z-index between its new neighbors puts it there; else all of them are numbered, bottom to top. Answers the
     * edits as arrange does, reason 'blocked' when they would move something, 'already' when the order is the page's.
     */
    restack({ order, moved }) {
      const items = (order ?? []).map(nodeOf);
      const m = nodeOf(moved);
      const parentEl = m?.parentElement;
      const c = m && clipOfNode(m);
      if (!c || !parentEl || items.some((x) => !x || x.parentElement !== parentEl) || !items.includes(m)) return null;
      const want = [...items].reverse();
      const now = siblingOrder(items);
      if (now.every((x, i) => x === want[i])) return { edits: [], reason: 'already' };
      const at = want.indexOf(m);
      const below = want[at - 1] ?? null;
      const above = want[at + 1] ?? null;
      /* where m would be drawn with z-index z (it is given a position where it has none) */
      const keyWith = (z) => [z, z < 0 ? 0 : z === 0 ? 1 : 2];
      const before = (ka, a, kb, b) => (ka[0] - kb[0] || ka[1] - kb[1] || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)) < 0;
      /* m given a z-index is drawn all at once; its neighbors are drawn as far as what is in them reaches */
      const memo = new Map();
      const lowN = below && reachOf(below, memo);
      const highN = above && reachOf(above, memo);
      const fits = (z) => (!lowN || before(paintKey(lowN), lowN, keyWith(z), m)) && (!highN || before(keyWith(z), m, paintKey(highN), highN));
      const lo = lowN ? paintKey(lowN)[0] : (highN ? paintKey(highN)[0] - 1 : 0);
      const hi = highN ? paintKey(highN)[0] : lo + 1;
      /* the others keep their order among themselves: only m moves, by the first z-index that works (positive first:
         a z-index of 0 ties with the positioned layers, and a negative one needs its parent isolated) */
      const rest = want.filter((x) => x !== m);
      const others = now.filter((x) => x !== m);
      const sole = rest.every((x, i) => x === others[i])
        ? [...new Set([lo + 1, lo, hi, hi - 1, lo - 1, hi + 1])].filter(fits).sort((a, b) => (a <= 0) - (b <= 0) || Math.abs(a) - Math.abs(b))
        : [];
      const editsOf = (plan) => {
        const edits = [];
        for (const [node, z] of plan) {
          const needs = !placedIn(node);
          if (needs && unsafe(node)) return null;
          if (!needs && zOf(node) === z) continue;
          edits.push({ target: targetOf(node), style: { zIndex: z, ...(needs ? { position: 'relative' } : {}) } });
        }
        if (plan.some(([, z]) => z < 0) && !stackingContext(parentEl)) edits.push({ target: targetOf(parentEl), style: { isolation: 'isolate' } });
        /* drawn as wanted: by the model, and where two of them overlap, by what the page's hit tests find */
        return steady(c, edits, () => siblingOrder(items).every((x, i) => x === want[i])
          && seeingAll(parentEl.ownerDocument, () => want.every((lower, i) => want.slice(i + 1).every((upper) => drawnOver(upper, lower) !== false))));
      };
      let kept = null;
      for (const z of sole) if (!kept) kept = editsOf([[m, z]]);
      kept ??= editsOf(want.map((x, i) => [x, i + 1]));
      return kept ? { edits: kept, reason: null } : { edits: [], reason: 'blocked' };
    },
    textStart: startText,
    textFinish({ commit }) { finishText(Boolean(commit)); return true; },
    /**
     * What a page clip shows that it can change without opening the page (its properties are made of these): the CSS
     * custom properties its stylesheets set on `:root` (or `html`), each with its value now; its words, each layer of
     * text with its selector and its words now; and its pictures, each <img> and each box painted with one image, with
     * the address drawn now. Null when the clip is not a page on the picture now.
     */
    controls({ clip }) {
      const c = clipById(clip);
      const doc = c?.kind === 'page' ? c.win?.document : null;
      if (!doc?.documentElement || !doc.body) return null;
      const names = new Set();
      const root = /^(?::root|html)$/i;
      const read = (rules) => {
        for (const rule of rules ?? []) {
          if (names.size >= CONTROLS) return;
          if (rule.cssRules && !rule.selectorText) { read(rule.cssRules); continue; }
          if (!rule.selectorText || !rule.selectorText.split(',').some((sel) => root.test(sel.trim()))) continue;
          for (const prop of rule.style) if (prop.startsWith('--')) names.add(prop);
        }
      };
      for (const sheet of doc.styleSheets) {
        try { read(sheet.cssRules); } catch { /* a stylesheet from elsewhere: not readable */ }
      }
      const now = c.win.getComputedStyle(doc.documentElement);
      const vars = [...names].slice(0, CONTROLS).map((name) => ({ name, value: now.getPropertyValue(name).trim() }));
      const texts = [];
      for (const el of layersOf(doc)) {
        if (texts.length >= CONTROLS) break;
        if (kindOf(el) !== 'text' || isSvgText(el) || el.closest('svg')) continue;
        const value = textOf(el);
        if (!value) continue;
        const { at, n } = locOf(el);
        texts.push({ at, ...(n ? { n } : {}), label: el.id ? nameOf(el) : '', value });
      }
      const images = [];
      for (const el of layersOf(doc)) {
        if (images.length >= CONTROLS) break;
        if (el.closest('svg')) continue;
        const img = el.localName.toLowerCase() === 'img';
        const painted = img ? null : /^url\("?([^"]*)"?\)$/.exec(css(el).backgroundImage);
        const src = img ? el.currentSrc || el.src : painted?.[1] ?? '';
        if (!src) continue;
        const { at, n } = locOf(el);
        images.push({ at, ...(n ? { n } : {}), label: el.id ? nameOf(el) : (img && el.alt) || '', kind: img ? 'img' : 'bg', src });
      }
      return { vars, texts, images, page: c.win.location.href };
    },
  };

  window.addEventListener('message', async (e) => {
    if (e.origin !== EDITOR || e.source !== parent || e.data?.source !== 'openfilm-studio' || e.data.type !== 'stage') return;
    const { seq, op, ...args } = e.data;
    const fn = Object.hasOwn(ops, op) ? ops[op] : null;
    let result = null;
    try {
      if (window.film) await window.film.ready;
      listenAll();
      /* the line being typed was drawn anew (an undo, the page rewritten): what was typed is kept, the box closes */
      if (editing && !editing.el.isConnected) finishText(true);
      result = fn ? fn(args) ?? null : null;
    } catch (error) {
      post({ type: 'stage', seq, result: null, error: String(error?.message ?? error) });
      return;
    }
    post({ type: 'stage', seq, result });
  });
})();
