// @ts-check
/**
 * Subtitle styles: one table, one function, every place that draws them.
 *
 * Subtitles are drawn by Studio, never by the film: the editor lays them over the picture (SubtitleOverlay), and an
 * export burns them in or writes them as SRT / WebVTT / a transcript. Each of those builds its CSS here
 * (`filmSubtitleCss`, `filmSubtitleFrameHtml`), so what the person sees while editing is what the export draws. The
 * only legitimate difference is the unit of the font size (the editor follows the window with `cqmin`; an export draws
 * at the frame's pixels), so that one value is passed in.
 *
 * Everything that follows the frame is stored as a fraction or in `em`, never in px: the same style is used on a small
 * preview and on a 4K export.
 *
 * Plain JavaScript with no dependencies: the editor (studio/ui) imports it as it is, and so does the server's export.
 */

/* ── style ───────────────────────────────────────────────────────────────── */

/**
 * The typeface. `sizePct` is a percentage of the frame's SHORT edge (measuring by height would turn a vertical film's
 * subtitles into headlines); everything else follows the font size in `em`.
 * @typedef {{ family: string, sizePct: number, weight: number, italic: boolean, letterSpacingEm: number, lineHeight: number, upper: boolean }} FilmSubtitleFont
 */
/**
 * A real stroke (`-webkit-text-stroke` + `paint-order: stroke fill`), not eight text-shadows: those show jagged lobes on
 * a thick stroke and would take the text-shadow the drop shadow needs.
 * @typedef {{ widthEm: number, color: string }} FilmSubtitleStroke
 */
/** @typedef {{ dxEm: number, dyEm: number, blurEm: number, color: string }} FilmSubtitleShadow */
/**
 * A box behind the text. Color (`#rrggbb`) and opacity are separate: they are two controls, and dragging the opacity
 * must not rewrite the color.
 * @typedef {{ color: string, opacity: number, radiusEm: number, padXEm: number, padYEm: number }} FilmSubtitleBox
 */
/** @typedef {'left' | 'center' | 'right'} FilmSubtitleAlign */
/**
 * Word highlight (karaoke): the word being said gets a color (`color`), a box behind it (`box`), or a color and a
 * little growth (`pop`). Word times come from the cue's `words` when it has them, else each word gets a share of the
 * line's time by its length (a voice speaks at an even pace).
 * @typedef {'color' | 'box' | 'pop'} FilmSubtitleKaraokeMode
 * @typedef {{ mode: FilmSubtitleKaraokeMode, color: string }} FilmSubtitleKaraoke
 */
/**
 * How a project's subtitles look and where they sit. The person's look, kept with the project but not in film.html
 * (studio/server/captions.mjs: `.film/subtitles.json`): an agent rewriting the film never touches it.
 *
 * `pos` is a fraction of the frame (0..1): where the line nearest the frame's edge sits. It is dragged on the picture;
 * no top/bottom presets, since what a subtitle has to stay clear of differs in every film.
 * `language`: the language shown (null = the voices' own); each cue carries its translations (`alt`) and this picks
 * one. `bilingual`: the original on one line and the translation under it.
 * @typedef {{
 *   on: boolean,
 *   pos: { x: number, y: number },
 *   maxWidthPct: number,
 *   align: FilmSubtitleAlign,
 *   font: FilmSubtitleFont,
 *   fill: string,
 *   stroke: FilmSubtitleStroke | null,
 *   shadow: FilmSubtitleShadow | null,
 *   box: FilmSubtitleBox | null,
 *   karaoke: FilmSubtitleKaraoke | null,
 *   language: string | null,
 *   bilingual: boolean,
 * }} FilmSubtitleStyle
 */

/** @type {readonly FilmSubtitleKaraokeMode[]} */
export const FILM_SUBTITLE_KARAOKE_MODES = ['color', 'box', 'pop'];
/** @type {FilmSubtitleKaraoke} */
export const FILM_SUBTITLE_KARAOKE_DEFAULT = { mode: 'box', color: '#ffd400' };

/**
 * The languages subtitles can be translated into, named in their own language so whoever picks one recognizes it.
 * @type {ReadonlyArray<{ code: string, english: string, native: string }>}
 */
export const FILM_SUBTITLE_LANGUAGES = [
  { code: 'en', english: 'English', native: 'English' },
  { code: 'zh', english: 'Simplified Chinese', native: '简体中文' },
  { code: 'zh-TW', english: 'Traditional Chinese', native: '繁體中文' },
  { code: 'ja', english: 'Japanese', native: '日本語' },
  { code: 'ko', english: 'Korean', native: '한국어' },
  { code: 'es', english: 'Spanish', native: 'Español' },
  { code: 'fr', english: 'French', native: 'Français' },
  { code: 'de', english: 'German', native: 'Deutsch' },
  { code: 'pt', english: 'Portuguese', native: 'Português' },
  { code: 'ru', english: 'Russian', native: 'Русский' },
  { code: 'ar', english: 'Arabic', native: 'العربية' },
  { code: 'hi', english: 'Hindi', native: 'हिन्दी' },
  { code: 'id', english: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'vi', english: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', english: 'Thai', native: 'ไทย' },
  { code: 'it', english: 'Italian', native: 'Italiano' },
];

/**
 * Which of FILM_SUBTITLE_LANGUAGES a text is in, by script: enough to name the original ("Original · Chinese") and to
 * skip translating a voice into its own language. Latin-script languages cannot be told apart this way: null.
 * @param {string} text @returns {string | null}
 */
export function filmSubtitleLanguageOf(text) {
  const sample = text.slice(0, 4000);
  const count = (/** @type {RegExp} */ re) => (sample.match(re) ?? []).length;
  const kana = count(/[\u3040-\u30ff]/g);
  const hangul = count(/[\uac00-\ud7af]/g);
  const han = count(/[\u4e00-\u9fff]/g);
  /** @type {Array<[string, number]>} */
  const scripts = [
    ['ja', kana * 3 + (kana ? han : 0)], ['ko', hangul], ['zh', kana ? 0 : han],
    ['th', count(/[\u0e00-\u0e7f]/g)], ['ar', count(/[\u0600-\u06ff]/g)],
    ['hi', count(/[\u0900-\u097f]/g)], ['ru', count(/[\u0400-\u04ff]/g)],
  ];
  const [best, n] = scripts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n >= 2 ? best : null;
}

/**
 * The same language for subtitles: Simplified and Traditional Chinese are different targets, everything else by its
 * base code.
 * @param {string | null | undefined} a @param {string | null | undefined} b
 */
export function sameFilmSubtitleLanguage(a, b) {
  return !!a && !!b && (a === b || (a.split('-')[0] === b.split('-')[0] && a.split('-')[0] !== 'zh'));
}

/** @param {unknown} code @returns {code is string} */
export const isFilmSubtitleLanguage = (code) =>
  typeof code === 'string' && FILM_SUBTITLE_LANGUAGES.some((item) => item.code === code);

/**
 * The typeface when none is chosen: a system stack, not one font, since subtitles have to set Chinese, Japanese,
 * Korean and Latin alike, and this stack lands on each platform's own sans for each.
 */
export const FILM_SUBTITLE_FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB",'
  + ' "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

/** The widest a subtitle block gets, as a percentage of the frame (default). 100 = edge to edge. */
export const FILM_SUBTITLE_MAX_W_PCT = 100;

/**
 * Font size as a percentage of the frame's short edge. The three sizes are only ticks on the slider now (and the
 * decoding of an older `size` field); the size itself is continuous.
 * @typedef {'sm' | 'md' | 'lg'} FilmSubtitleSize
 * @type {Record<FilmSubtitleSize, number>}
 */
export const FILM_SUBTITLE_SIZE_PCT = { sm: 3.2, md: 4.0, lg: 5.2 };

/** The size slider's ends: smaller cannot be read on a feed thumbnail, larger leaves a few words per line. */
export const FILM_SUBTITLE_SIZE_PCT_MIN = 2;
export const FILM_SUBTITLE_SIZE_PCT_MAX = 10;

/* ── looks ───────────────────────────────────────────────────────────────── */

/**
 * A ready-made look, like a character style: picking one sets the whole set, and every value can still be changed
 * after. They stay because the combinations that read well are few; built from scratch, subtitles tend to sink into
 * the picture.
 * @typedef {'outline' | 'bar' | 'bold' | 'yellow' | 'clean'} FilmSubtitleLookId
 * @typedef {Pick<FilmSubtitleStyle, 'font' | 'fill' | 'stroke' | 'shadow' | 'box'>} FilmSubtitleLook
 */

/** @type {readonly FilmSubtitleLookId[]} */
export const FILM_SUBTITLE_LOOK_IDS = ['outline', 'bar', 'bold', 'yellow', 'clean'];

/** @param {Partial<FilmSubtitleFont>} [over] @returns {FilmSubtitleFont} */
function font(over = {}) {
  return {
    family: FILM_SUBTITLE_FONT_STACK,
    sizePct: FILM_SUBTITLE_SIZE_PCT.md,
    weight: 500,
    italic: false,
    /* set tight, Chinese subtitles look like UI labels: a little tracking and leading make them read as a line of text */
    letterSpacingEm: 0.04,
    lineHeight: 1.45,
    upper: false,
    ...over,
  };
}

/**
 * Each look's values. Only how it looks: never the position or the switch (a new look must not undo a drag).
 * @type {Record<FilmSubtitleLookId, FilmSubtitleLook>}
 */
export const FILM_SUBTITLE_LOOKS = {
  /* the default is an outline, not a box: a box covers the picture, and subtitles sit in the lower third where there
     often is something; an outline reads on any background and hides almost nothing */
  outline: {
    font: font(),
    fill: '#ffffff',
    /* the stroke keeps the letters on light or busy backgrounds; the glow is what lifts them off the picture */
    stroke: { widthEm: 0.055, color: 'rgba(0,0,0,0.84)' },
    shadow: { dxEm: 0, dyEm: 0.05, blurEm: 0.22, color: 'rgba(0,0,0,0.72)' },
    box: null,
  },
  bar: {
    font: font(),
    fill: '#ffffff',
    stroke: null,
    shadow: null,
    box: { color: '#000000', opacity: 0.62, radiusEm: 0.08, padXEm: 0.4, padYEm: 0.12 },
  },
  /* the heavy social-media outline: muted feeds need words that read at thumbnail size */
  bold: {
    font: font({ weight: 800, letterSpacingEm: 0.01 }),
    fill: '#ffffff',
    stroke: { widthEm: 0.08, color: '#000000' },
    shadow: { dxEm: 0, dyEm: 0.03, blurEm: 0.08, color: 'rgba(0,0,0,0.6)' },
    box: null,
  },
  yellow: {
    font: font({ weight: 700 }),
    fill: '#ffe14d',
    stroke: { widthEm: 0.075, color: '#000000' },
    shadow: { dxEm: 0, dyEm: 0.03, blurEm: 0.08, color: 'rgba(0,0,0,0.6)' },
    box: null,
  },
  clean: {
    font: font(),
    fill: '#ffffff',
    stroke: null,
    shadow: { dxEm: 0, dyEm: 0.04, blurEm: 0.2, color: 'rgba(0,0,0,0.62)' },
    box: null,
  },
};

/**
 * Where the default position sits (y): one line at the default size ends about 3% above the bottom edge, where players
 * put subtitles, and two lines still fit. The overlay's snap lines use this value; do not copy it.
 */
export const FILM_SUBTITLE_HOME_Y = 0.94;

/** @type {FilmSubtitleStyle} */
export const FILM_SUBTITLE_DEFAULT = {
  on: true,
  pos: { x: 0.5, y: FILM_SUBTITLE_HOME_Y },
  maxWidthPct: FILM_SUBTITLE_MAX_W_PCT,
  align: 'center',
  ...FILM_SUBTITLE_LOOKS.outline,
  karaoke: null,
  language: null,
  bilingual: false,
};

/**
 * The default position on a vertical frame: Shorts / Reels / TikTok put their own title, avatar and buttons over the
 * bottom fifth, right on the landscape baseline.
 */
export const FILM_SUBTITLE_PORTRAIT_Y = 0.72;

/**
 * The style as used on this frame: never moved (still at the default spot) on a vertical frame → the vertical default
 * spot. A moved one is the person's choice. Every renderer applies this first.
 * @param {FilmSubtitleStyle} style @param {{ w: number, h: number }} frame @returns {FilmSubtitleStyle}
 */
export function filmSubtitleStyleFor(style, frame) {
  const home = style.pos.x === 0.5 && style.pos.y === FILM_SUBTITLE_HOME_Y;
  return home && frame.h > frame.w ? { ...style, pos: { x: 0.5, y: FILM_SUBTITLE_PORTRAIT_Y } } : style;
}

/**
 * The look this style is exactly (any size), else null: the swatch shown as picked. Worked out from the values, not
 * stored, so changing a color after picking a look un-picks it.
 * @param {FilmSubtitleStyle} style @returns {FilmSubtitleLookId | null}
 */
export function matchFilmSubtitleLook(style) {
  for (const id of FILM_SUBTITLE_LOOK_IDS) {
    const look = FILM_SUBTITLE_LOOKS[id];
    if (JSON.stringify({ ...look, font: { ...look.font, sizePct: style.font.sizePct } })
      === JSON.stringify({ font: style.font, fill: style.fill, stroke: style.stroke, shadow: style.shadow, box: style.box })) return id;
  }
  return null;
}

/* ── CSS ─────────────────────────────────────────────────────────────────── */

/** `#rrggbb` + opacity → `rgba(...)`; any other color as it is. @param {string} color @param {number} opacity */
function rgba(color, opacity) {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!digits) return color;
  const hex = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  const n = parseInt(hex, 16);
  const a = Math.min(1, Math.max(0, opacity));
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Number(a.toFixed(3))})`;
}

/**
 * A family name → a valid `font-family` value. Font lists give bare names (`Press Start 2P`, `Noto Serif SC`); a
 * multi-word name needs quotes and one starting with a digit is never a valid identifier, and an invalid declaration
 * is silently dropped. A stack (with commas) is used as it is; a single name is quoted, with the system stack behind it.
 * @param {string} family
 */
export function cssFontFamily(family) {
  const name = family.trim();
  if (!name) return FILM_SUBTITLE_FONT_STACK;
  if (name.includes(',')) return name;
  return `"${name.replace(/"/g, '')}", ${FILM_SUBTITLE_FONT_STACK}`;
}

/** @type {Record<FilmSubtitleAlign, string>} */
const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' };

/**
 * `box`: the positioning block (absolute at `pos`, its max width, aligned); `text`: the text block (font, color,
 * stroke, shadow, box). camelCase properties, as React's `style` takes them (`filmSubtitleCssText` for a style
 * attribute).
 * @typedef {{ box: Record<string, string>, text: Record<string, string> }} FilmSubtitleCss
 */

/**
 * A style → its two sets of CSS declarations. The one way every renderer builds subtitles; `fontSize` is given by the
 * caller, which alone knows its units (the editor: container units; an export: the frame's pixels).
 * @param {FilmSubtitleStyle} style @param {{ fontSize: string }} opts @returns {FilmSubtitleCss}
 */
export function filmSubtitleCss(style, opts) {
  const f = style.font;
  /* `pos` is where the line nearest the frame's edge sits (its middle). More lines (a long sentence wrapping, the
     original above its translation) grow away from that edge; centering the whole block pushed a bilingual pair's last
     line onto the frame's bottom edge. Near the middle the block stays centered. The box sits on its edge and the text
     reaches back half a line past it (a margin in `em`, so every renderer writes the same box whatever its units). */
  const anchor = style.pos.y > 0.55 ? 'bottom' : style.pos.y < 0.45 ? 'top' : 'middle';
  const halfLineEm = `-${Math.round((f.lineHeight / 2 + (style.box?.padYEm ?? 0)) * 1000) / 1000}em`;
  const dy = anchor === 'bottom' ? '-100%' : anchor === 'top' ? '0' : '-50%';

  /** @type {Record<string, string>} */
  const box = {
    position: 'absolute',
    left: `${style.pos.x * 100}%`,
    top: `${style.pos.y * 100}%`,
    transform: `translate(-50%, ${dy})`,
    /* `max-content` is needed: an absolute box with only `left` may be as wide as from there to the right edge (half
       the frame when centered), so a sentence would wrap at 50%; max-content sizes it by its text, then max-width caps
       it by the whole frame */
    width: 'max-content',
    maxWidth: `${style.maxWidthPct}%`,
    display: 'flex',
    justifyContent: JUSTIFY[style.align],
    zIndex: '5',
  };

  /** @type {Record<string, string>} */
  const text = {
    whiteSpace: 'pre-wrap',
    /* `strict` keeps CJK punctuation on the line it closes instead of starting the next one with it */
    lineBreak: 'strict',
    overflowWrap: 'break-word',
    /* a flex item's min-width:auto could push the text past a capped box */
    minWidth: '0',
    maxWidth: '100%',
    textAlign: style.align,
    lineHeight: String(f.lineHeight),
    fontSize: opts.fontSize,
    fontFamily: cssFontFamily(f.family),
    fontWeight: String(f.weight),
    color: style.fill,
  };
  if (anchor === 'bottom') text.marginBottom = halfLineEm;
  if (anchor === 'top') text.marginTop = halfLineEm;
  if (f.italic) text.fontStyle = 'italic';
  if (f.letterSpacingEm) text.letterSpacing = `${f.letterSpacingEm}em`;
  if (f.upper) text.textTransform = 'uppercase';

  if (style.stroke && style.stroke.widthEm > 0) {
    text.WebkitTextStrokeWidth = `${style.stroke.widthEm}em`;
    text.WebkitTextStrokeColor = style.stroke.color;
    /* without it the stroke is centered on the outline and eats into the letters, worst at light weights */
    text.paintOrder = 'stroke fill';
  }
  if (style.shadow) {
    const s = style.shadow;
    text.textShadow = `${s.dxEm}em ${s.dyEm}em ${s.blurEm}em ${s.color}`;
  }
  if (style.box) {
    const b = style.box;
    text.background = rgba(b.color, b.opacity);
    text.padding = `${b.padYEm}em ${b.padXEm}em`;
    text.borderRadius = `${b.radiusEm}em`;
  }
  return { box, text };
}

/** The same declarations as a `style="..."` attribute's text. @param {Record<string, string>} decls */
export function filmSubtitleCssText(decls) {
  return Object.entries(decls)
    /* `WebkitTextStroke` → `-webkit-text-stroke`: the capital W gives the leading dash */
    .map(([k, v]) => `${k.replace(/([A-Z])/g, '-$1').toLowerCase()}:${v}`)
    .join(';');
}

/** The font size in a frame's pixels (an export's): by the short edge, as `sizePct` says. */
export function filmSubtitleFontSizePx(/** @type {FilmSubtitleStyle} */ style, /** @type {{ w: number, h: number }} */ frame) {
  return Math.round((Math.min(frame.w, frame.h) * style.font.sizePct) / 100);
}

/* ── cues ────────────────────────────────────────────────────────────────── */

/**
 * One subtitle line on the film: film milliseconds, its text, who says it (only when the film has more than one
 * speaker), word times when known (film ms), its translations by language, the clip it comes from, and the line it
 * shows: `src`'s transcript line starting at `line` (source ms), and which subtitle of it (`part`, from 0) when the
 * spoken line is cut into several (studio/server/subtitle-segments.mjs).
 * @typedef {{
 *   startMs: number,
 *   durMs: number,
 *   text: string,
 *   speaker?: string,
 *   words?: readonly { text: string, startMs: number, durMs: number }[],
 *   alt?: Readonly<Record<string, string>>,
 *   clip?: string,
 *   src?: string,
 *   line?: number,
 *   part?: number,
 * }} FilmSubtitleCue
 */

/**
 * The cues as the style shows them: the original, one language's translation, or both (original above). Lines not
 * translated yet stay in the original. A translated line loses its word times (they are the original's). Where a
 * translation could not be cut as finely as its original, the same words follow pieces of one line: shown alone they
 * are one cue (not the same words flashing anew, nor repeated in a file).
 * @template {FilmSubtitleCue} T
 * @param {readonly T[]} cues @param {Pick<FilmSubtitleStyle, 'language' | 'bilingual'>} style @returns {T[]}
 */
export function filmSubtitleShown(cues, style) {
  const language = style.language;
  if (!language) return [...cues];
  /** @type {T[]} */
  const out = [];
  for (const cue of cues) {
    const alt = cue.alt?.[language];
    if (!alt) { out.push(cue); continue; }
    const prev = out.at(-1);
    if (!style.bilingual && prev && cue.src !== undefined && prev.src === cue.src && prev.line === cue.line && prev.clip === cue.clip
      && prev.alt?.[language] === alt && prev.text === alt) {
      out[out.length - 1] = { ...prev, durMs: Math.max(prev.durMs, cue.startMs + cue.durMs - prev.startMs) };
      continue;
    }
    const { words: _words, ...rest } = cue;
    out.push(/** @type {T} */ ({ ...rest, text: style.bilingual ? `${cue.text}\n${alt}` : alt }));
  }
  return out;
}

/** The languages these cues have translations in (any line counts). @param {readonly FilmSubtitleCue[]} cues */
export function filmSubtitleLanguagesIn(cues) {
  const found = new Set();
  for (const cue of cues) for (const code of Object.keys(cue.alt ?? {})) found.add(code);
  return /** @type {string[]} */ ([...found]);
}

/** A piece of a line: a word (which takes its turn to light up), or space, punctuation, a speaker prefix. @typedef {{ text: string, active: boolean }} FilmSubtitleWord */

const PUNCT_START = /^[\s，。、！？,.!?;:；：]/;

/**
 * A line cut into pieces, the one being said at `timeMs` marked. Every renderer uses it, so the highlight falls on the
 * same word in the editor and the export. Without word times: words by Intl.Segmenter (CJK into words, else by
 * character), punctuation and spaces take no time, each word gets time by its length.
 * @param {FilmSubtitleCue} cue @param {number} timeMs @returns {FilmSubtitleWord[]}
 */
export function filmSubtitleWords(cue, timeMs) {
  /** @type {FilmSubtitleWord[]} */
  const out = [];
  if (cue.speaker) out.push({ text: `${cue.speaker}：`, active: false });
  const words = cue.words;
  if (words?.length) {
    words.forEach((w, i) => {
      if (i > 0 && !PUNCT_START.test(w.text) && /[A-Za-z0-9]$/.test(words[i - 1].text)) out.push({ text: ' ', active: false });
      out.push({ text: w.text, active: timeMs >= w.startMs && timeMs < w.startMs + w.durMs });
    });
    return out;
  }
  const segs = segmentWords(cue.text);
  const weight = segs.reduce((n, s) => n + (s.word ? [...s.text].length : 0), 0);
  if (!weight) {
    out.push({ text: cue.text, active: false });
    return out;
  }
  const at = Math.min(Math.max(0, timeMs - cue.startMs), Math.max(0, cue.durMs - 1));
  let t = 0;
  for (const seg of segs) {
    if (!seg.word) {
      out.push({ text: seg.text, active: false });
      continue;
    }
    const len = ([...seg.text].length / weight) * cue.durMs;
    out.push({ text: seg.text, active: at >= t && at < t + len });
    t += len;
  }
  return out;
}

/** @param {string} text @returns {{ text: string, word: boolean }[]} */
function segmentWords(text) {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)]
      .map((s) => ({ text: s.segment, word: Boolean(s.isWordLike) }));
  }
  return text.split(/(\s+|[，。、！？,.!?;:；：]+)/).filter(Boolean)
    .map((part) => ({ text: part, word: !/^(\s+|[，。、！？,.!?;:；：]+)$/.test(part) }));
}

/**
 * What the word being said gets on top of the line's style. Only color, background and scale, never the font: a word
 * growing wider would make the whole line jump. The scale is an inline-block transform, which takes no room.
 * @param {FilmSubtitleStyle} style @returns {Record<string, string>}
 */
export function filmSubtitleWordCss(style) {
  const k = style.karaoke;
  if (!k) return {};
  if (k.mode === 'box') {
    return {
      backgroundColor: k.color,
      color: readableOn(k.color),
      borderRadius: '0.18em',
      padding: '0 0.14em',
      margin: '0 -0.14em',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
      WebkitTextStroke: '0',
    };
  }
  if (k.mode === 'pop') {
    /* the growth spills over the gaps between words (a transform takes no room): more than this runs into neighbors */
    return { color: k.color, display: 'inline-block', transform: 'scale(1.08)', transformOrigin: '50% 60%' };
  }
  return { color: k.color };
}

/** Black or white text on a background, by its brightness. @param {string} bg */
function readableOn(bg) {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim())?.[1];
  if (!digits) return '#000000';
  const hex = digits.length === 3 ? digits.split('').map((c) => c + c).join('') : digits;
  const n = parseInt(hex, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000000' : '#ffffff';
}

/**
 * The line shown at `timeMs`. Ranges are [start, end); when two overlap the later-starting one wins (the earlier one's
 * tail is still hanging while the next has begun, and the viewer reads the one being said).
 * @template {FilmSubtitleCue} T
 * @param {readonly T[]} cues @param {number} timeMs @returns {T | null}
 */
export function filmSubtitleAt(cues, timeMs) {
  /** @type {T | null} */
  let best = null;
  for (const cue of cues) {
    if (timeMs < cue.startMs || timeMs >= cue.startMs + cue.durMs) continue;
    if (!best || cue.startMs > best.startMs) best = cue;
  }
  return best;
}

/** A line as printed (speaker first). @param {FilmSubtitleCue} cue */
export function filmSubtitleText(cue) {
  return cue.speaker ? `${cue.speaker}：${cue.text}` : cue.text;
}

/* ── reading a stored style ──────────────────────────────────────────────── */

const clamp01 = (/** @type {number} */ n) => Math.min(1, Math.max(0, n));

/** @param {unknown} v @param {number} fallback @param {number} lo @param {number} hi */
function num(v, fallback, lo, hi) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/** @param {unknown} v @param {string} fallback */
const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback);
/** @param {unknown} v @param {boolean} fallback */
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

/**
 * `null` is "no such layer", `undefined` is "not said": the two must not mix, or a stroke could never be turned off.
 * @template T
 * @param {unknown} v @param {T | null} fallback @param {(o: Record<string, unknown>) => T} read @returns {T | null}
 */
function layer(v, fallback, read) {
  if (v === null) return null;
  if (v && typeof v === 'object') return read(/** @type {Record<string, unknown>} */ (v));
  return fallback;
}

/**
 * A style from outside (a file, the browser's storage, a request), field by field: what was stored may be an earlier
 * shape, and one unreadable field should fall back alone rather than reset the whole style. The earlier shape
 * `{ on, size: 'md', look: 'outline', pos }` is still understood: the look first, then `size` over its font size.
 * @param {unknown} raw @returns {FilmSubtitleStyle}
 */
export function parseFilmSubtitleStyle(raw) {
  const v = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  const lookId = typeof v.look === 'string' && v.look in FILM_SUBTITLE_LOOKS ? /** @type {FilmSubtitleLookId} */ (v.look) : null;
  /** @type {FilmSubtitleStyle} */
  const base = lookId ? { ...FILM_SUBTITLE_DEFAULT, ...FILM_SUBTITLE_LOOKS[lookId] } : FILM_SUBTITLE_DEFAULT;
  const legacySizePct = typeof v.size === 'string' && v.size in FILM_SUBTITLE_SIZE_PCT
    ? FILM_SUBTITLE_SIZE_PCT[/** @type {FilmSubtitleSize} */ (v.size)]
    : null;
  const rf = /** @type {Record<string, unknown>} */ (v.font && typeof v.font === 'object' ? v.font : {});
  const pos = /** @type {{ x?: unknown, y?: unknown } | undefined} */ (v.pos);

  return {
    on: bool(v.on, base.on),
    pos: typeof pos?.x === 'number' && typeof pos?.y === 'number' && Number.isFinite(pos.x) && Number.isFinite(pos.y)
      ? { x: clamp01(pos.x), y: clamp01(pos.y) }
      : base.pos,
    maxWidthPct: num(v.maxWidthPct, base.maxWidthPct, 10, 100),
    align: v.align === 'left' || v.align === 'right' || v.align === 'center' ? v.align : base.align,
    font: {
      family: str(rf.family, base.font.family),
      sizePct: num(rf.sizePct, legacySizePct ?? base.font.sizePct, FILM_SUBTITLE_SIZE_PCT_MIN, FILM_SUBTITLE_SIZE_PCT_MAX),
      weight: num(rf.weight, base.font.weight, 100, 900),
      italic: bool(rf.italic, base.font.italic),
      letterSpacingEm: num(rf.letterSpacingEm, base.font.letterSpacingEm, -0.1, 0.5),
      lineHeight: num(rf.lineHeight, base.font.lineHeight, 0.8, 3),
      upper: bool(rf.upper, base.font.upper),
    },
    fill: str(v.fill, base.fill),
    stroke: layer(v.stroke, base.stroke, (o) => ({
      widthEm: num(o.widthEm, base.stroke?.widthEm ?? 0.055, 0, 0.3),
      color: str(o.color, base.stroke?.color ?? '#000000'),
    })),
    shadow: layer(v.shadow, base.shadow, (o) => ({
      dxEm: num(o.dxEm, base.shadow?.dxEm ?? 0, -0.5, 0.5),
      dyEm: num(o.dyEm, base.shadow?.dyEm ?? 0, -0.5, 0.5),
      blurEm: num(o.blurEm, base.shadow?.blurEm ?? 0.22, 0, 1),
      color: str(o.color, base.shadow?.color ?? 'rgba(0,0,0,0.72)'),
    })),
    box: layer(v.box, base.box, (o) => ({
      color: str(o.color, base.box?.color ?? '#000000'),
      opacity: num(o.opacity, base.box?.opacity ?? 0.62, 0, 1),
      radiusEm: num(o.radiusEm, base.box?.radiusEm ?? 0.08, 0, 1),
      padXEm: num(o.padXEm, base.box?.padXEm ?? 0.4, 0, 2),
      padYEm: num(o.padYEm, base.box?.padYEm ?? 0.12, 0, 2),
    })),
    karaoke: layer(v.karaoke, base.karaoke ?? null, (o) => ({
      mode: FILM_SUBTITLE_KARAOKE_MODES.includes(/** @type {FilmSubtitleKaraokeMode} */ (o.mode))
        ? /** @type {FilmSubtitleKaraokeMode} */ (o.mode)
        : FILM_SUBTITLE_KARAOKE_DEFAULT.mode,
      color: str(o.color, FILM_SUBTITLE_KARAOKE_DEFAULT.color),
    })),
    language: isFilmSubtitleLanguage(v.language) ? v.language : null,
    bilingual: bool(v.bilingual, false),
  };
}

/* ── for an export ───────────────────────────────────────────────────────── */

const escapeHtml = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The subtitle layer of one frame, for an export that burns subtitles in: an HTML fragment to lay over the picture.
 *
 *   cues   the film's cues as studio/server/captions.mjs gives them (`filmCaptions(root).cues`), in film ms
 *   style  the project's style (`readSubtitleStyle(root)`), as the person left it; off → nothing
 *   frame  the delivered frame in pixels, `{ w, h }` (the delivery frame, bars included, not the film's stage:
 *          subtitles sit on the frame, as in the editor)
 *   timeMs the moment, in film ms
 *
 * Returns '' when nothing is said then. Otherwise one `<div>` of exactly `frame.w × frame.h` px, positioned absolute at
 * 0,0 (put it in a `position: relative` box of the frame's size, over the picture), holding the line with the same
 * declarations the editor's overlay uses, the font size in px. It picks the shown language, the vertical default spot
 * and the word highlight itself, so an export needs nothing else. The fonts are the machine's installed ones (the same
 * the editor offers), so a headless browser on this machine draws it as the editor does.
 * @param {readonly FilmSubtitleCue[]} cues @param {FilmSubtitleStyle} style @param {{ w: number, h: number }} frame
 * @param {number} timeMs @returns {string}
 */
export function filmSubtitleFrameHtml(cues, style, frame, timeMs) {
  if (!style.on) return '';
  const cue = filmSubtitleAt(filmSubtitleShown(cues, style), timeMs);
  if (!cue) return '';
  const fitted = filmSubtitleStyleFor(style, frame);
  const css = filmSubtitleCss(fitted, { fontSize: `${filmSubtitleFontSizePx(fitted, frame)}px` });
  const body = fitted.karaoke
    ? filmSubtitleWords(cue, timeMs).map((w) => (w.active
      ? `<span style="${escapeHtml(filmSubtitleCssText(filmSubtitleWordCss(fitted)))}">${escapeHtml(w.text)}</span>`
      : escapeHtml(w.text))).join('')
    : escapeHtml(filmSubtitleText(cue));
  return `<div style="position:absolute;left:0;top:0;width:${frame.w}px;height:${frame.h}px;overflow:hidden;pointer-events:none">`
    + `<div style="${escapeHtml(filmSubtitleCssText(css.box))}"><span style="${escapeHtml(filmSubtitleCssText(css.text))}">${body}</span></div></div>`;
}

/* ── files ───────────────────────────────────────────────────────────────── */

/** `00:01:23,456`: SRT's time, with a comma. @param {number} ms */
function srtStamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor((total % 3_600_000) / 60_000))}`
    + `:${pad(Math.floor((total % 60_000) / 1000))},${pad(total % 1000, 3)}`;
}

/**
 * Sorted, empty lines dropped, and an overlapping line cut short where the next begins (files have no "two at once":
 * players disagree on overlaps). Cut, not dropped: the dropped line was really said.
 * @param {readonly FilmSubtitleCue[]} cues
 */
export function filmSubtitleSequence(cues) {
  const sorted = [...cues].filter((c) => c.text.trim() && c.durMs > 0).sort((a, b) => a.startMs - b.startMs);
  /** @type {{ cue: FilmSubtitleCue, end: number }[]} */
  const out = [];
  for (const [i, cue] of sorted.entries()) {
    const next = sorted[i + 1];
    let end = cue.startMs + cue.durMs;
    if (next && end > next.startMs) end = next.startMs;
    if (end > cue.startMs) out.push({ cue, end });
  }
  return out;
}

/**
 * An SRT file of the cues (pass them through `filmSubtitleShown` first for the shown language). The speaker takes an
 * ASCII colon here: players and translation tools read this file, and some choke on full-width punctuation.
 * @param {readonly FilmSubtitleCue[]} cues
 */
export function filmSubtitleSrt(cues) {
  const blocks = filmSubtitleSequence(cues).map(({ cue, end }, i) => {
    const line = cue.speaker ? `${cue.speaker}:${cue.text}` : cue.text;
    return `${i + 1}\n${srtStamp(cue.startMs)} --> ${srtStamp(end)}\n${line.trim()}`;
  });
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

/** `&`, `<` and `>` as VTT's escapes: a raw `<` starts a tag, `&` an escape, and `-->` would end the cue's timing. */
const escapeVtt = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A WebVTT file; the speaker as `<v name>`, VTT's own voice tag. @param {readonly FilmSubtitleCue[]} cues */
export function filmSubtitleVtt(cues) {
  const blocks = filmSubtitleSequence(cues).map(({ cue, end }) => {
    const text = escapeVtt(cue.text.trim());
    const line = cue.speaker ? `<v ${escapeVtt(cue.speaker)}>${text}` : text;
    return `${srtStamp(cue.startMs).replace(',', '.')} --> ${srtStamp(end).replace(',', '.')}\n${line}`;
  });
  return blocks.length ? `WEBVTT\n\n${blocks.join('\n\n')}\n` : '';
}

/** A plain transcript: one line per cue, a blank line where the speaker changes. @param {readonly FilmSubtitleCue[]} cues */
export function filmSubtitleTranscript(cues) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string | undefined} */
  let lastSpeaker;
  for (const { cue } of filmSubtitleSequence(cues)) {
    if (lines.length && cue.speaker !== lastSpeaker) lines.push('');
    lines.push(cue.speaker && cue.speaker !== lastSpeaker ? `${cue.speaker}:${cue.text.trim()}` : cue.text.trim());
    lastSpeaker = cue.speaker;
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * The cues of one stretch of the film (an in–out export): outside dropped, crossing ones cut, and moved so the stretch
 * starts at 0.
 * @template {FilmSubtitleCue} T
 * @param {readonly T[]} cues @param {number} fromMs @param {number} toMs @returns {T[]}
 */
export function filmSubtitleCuesInRange(cues, fromMs, toMs) {
  /** @type {T[]} */
  const out = [];
  for (const cue of cues) {
    const start = Math.max(cue.startMs, fromMs);
    const end = Math.min(cue.startMs + cue.durMs, toMs);
    if (end <= start) continue;
    out.push({ ...cue, startMs: start - fromMs, durMs: end - start });
  }
  return out;
}
