// Overrides (SPEC §1): a person's tweaks of elements inside a page clip, applied after the page draws a frame. The
// film's timeline applies them to each page clip it plays (timeline.mjs); Studio's thumbnails of a page clip apply them
// too (studio/server/pageframes.mjs), so the timeline's pictures of a clip show what was changed in it. `c` is the
// clip as the timeline keeps it: its page's window (`win`), what its tweaks changed (`touched`), which ones found an
// element (`found`).

/**
 * Overrides: a person's tweak of one element inside a page, applied after the page draws each frame. `found` keeps,
 * per tweak, whether its selector ever found an element (a page rewritten since may have lost it). What a tweak
 * changes is remembered as it was before (`touched`), so a tweak taken away, or changed, leaves nothing behind.
 */
export function override(c, list = []) {
  const win = c.win;
  if (!win) return;
  const touch = (el, prop) => {
    let saved = c.touched.get(el);
    if (!saved) { saved = { props: new Map(), texts: null }; c.touched.set(el, saved); }
    if (!saved.props.has(prop)) saved.props.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  };
  const set = (el, prop, value, priority = '') => { touch(el, prop); el.style.setProperty(prop, value, priority); };
  for (const [i, o] of list.entries()) {
    if (o.at === undefined) continue; // the clip's own entry (its fades): not an element's
    let nodes = [];
    try { nodes = [...win.document.querySelectorAll(o.at)]; } catch { continue; }
    if (o.n) nodes = nodes.slice(o.n - 1, o.n);
    if (nodes.length) c.found[i] = true;
    for (const el of nodes) {
      if (o.t) set(el, 'translate', `${o.t[0]}px ${o.t[1]}px`);
      if (o.s != null) set(el, 'scale', Array.isArray(o.s) ? `${o.s[0]} ${o.s[1]}` : String(o.s));
      if (o.r != null) set(el, 'rotate', `${o.r}deg`);
      for (const [k, v] of Object.entries(o.style ?? {})) {
        /* a custom property (`--accent`) is set as it is named, its value as it is: what a number means is the page's */
        if (k.startsWith('--')) { set(el, k, String(v), 'important'); continue; }
        const prop = k.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase());
        set(el, prop, typeof v === 'number' && !/opacity|z-index|font-weight|line-height|flex/.test(prop) ? v + 'px' : String(v), 'important');
      }
      if (o.text != null) {
        const saved = (touch(el, 'translate'), c.touched.get(el));
        if ([...el.children].every((ch) => ch.localName === 'br')) {
          /* words alone, or lines between <br>s: all of them change, a <br> at each line break (SPEC §1) */
          saved.nodes ??= [...el.childNodes];
          if (linesOf(el) !== o.text) {
            const doc = el.ownerDocument;
            el.replaceChildren(...o.text.split('\n').flatMap((line, k) => (k ? [doc.createElement('br'), doc.createTextNode(line)] : [doc.createTextNode(line)])));
          }
        } else {
          const parts = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data.trim());
          saved.texts ??= parts.map((n) => [n, n.data]);
          /* a heading with other inline parts (`Quiet<br><em>you</em>`): its own words change, the parts stay */
          parts.forEach((n, k) => { n.data = k ? '' : o.text; });
        }
      }
    }
  }
}

/** An element's words with a line break for each <br>, as a `text` override writes them. */
export function linesOf(el) {
  return [...el.childNodes].map((n) => (n.nodeType === 3 ? n.data : n.localName === 'br' ? '\n' : '')).join('');
}

/** Put back what a clip's tweaks changed (before a changed list is applied, or when it is taken away). */
export function restore(c) {
  for (const [el, saved] of c.touched) {
    for (const [prop, [value, priority]] of saved.props) {
      if (value) el.style.setProperty(prop, value, priority); else el.style.removeProperty(prop);
    }
    if (saved.nodes) el.replaceChildren(...saved.nodes);
    else if (saved.texts) for (const [node, data] of saved.texts) node.data = data;
  }
  c.touched = new Map();
  c.found = [];
}
