// @ts-check
/**
 * A spoken line cut into subtitles the way subtitlers cut them: one clause per subtitle, one line per subtitle, on
 * screen long enough to read and never for ages.
 *
 * A transcript (transcripts.mjs) keeps what was said as spoken lines; the film's subtitles (captions.mjs) are cut from
 * each line here, at cue time. So the transcript stays as it was spoken (the person corrects a line, an agent rewrites
 * it, a translation follows it line by line) and every subtitle is derived: a piece knows its line and its place in it
 * (`part`, `from`/`to`), so a correction of one subtitle goes back into the right characters of the right line.
 *
 * The rules, in order (every number is in SUBTITLE_SEGMENT_RULES):
 *   1. Units. The line's words (cores): a Latin word whole (with its inner `.'-/`: 3.5, e.g, don't, node.js), a CJK
 *      run cut into words by Intl.Segmenter. Punctuation sticks to its word: closing marks to the one before, opening
 *      ones to the one after. Each character has a time: from the word marks when the line has them (speech between
 *      marks at a speaking pace, the rest of the span is a pause), else spread over the line by weight (a CJK character
 *      1, a Latin letter less, a comma or full stop a short pause).
 *   2. Hard breaks: a sentence end (。！？!?… and a full stop that is not a decimal, an initial or an abbreviation like
 *      e.g. / Mr.), and a pause between two words of at least `pauseMs`.
 *   3. Clause breaks: ，；：,;:— and the edges of parentheses start a new subtitle when the part before and the part
 *      after each have `minUnits` (CJK 4 characters, Latin 2 words): no orphans like 好，. The enumeration comma 、
 *      joins the items of one list (苹果、香蕉、橙子): it is where a list too long for a line is cut first, not a break.
 *   4. Length: a subtitle is one line, at most `maxCells` (CJK: full-width 1, the rest ½) or `maxChars` (Latin). A clause
 *      still too long (or longer than `maxMs`) is cut where it costs least: a long pause first, then before a
 *      conjunction or after a closing particle, then balanced halves; never inside a word, between a number and its
 *      unit, or inside brackets and quotes (unless what they hold does not fit), and only reluctantly where Latin meets
 *      CJK ("MIT 协议" reads as one term).
 *   5. Time. A subtitle starts with its first word and ends with its last, held up to `holdMs` longer but never into
 *      the next one; a gap under `closeGapMs` is closed (no flicker); one shorter than `minMs` is held into the silence
 *      after it, else joined to a neighbor when the two still fit on a line. A line's last subtitle ends with the line.
 *   6. Text. Chinese convention: no ，。、；： at the end of a subtitle (？！… and closing quotes stay); Latin keeps its
 *      punctuation (subtitleEnd).
 *   7. Translations follow the original's cuts (alignTranslation): the translated line is cut, by the same marks, into
 *      as many pieces near the same moments; where it cannot be cut well, one translated piece spans several.
 *
 * Plain JavaScript, no dependencies, no I/O.
 */

export const SUBTITLE_SEGMENT_RULES = Object.freeze({
  /** Longest subtitle when the line has CJK, in cells: a full-width character is 1, anything else ½ (16 ≈ a phone's width). */
  maxCells: 16,
  /** Longest subtitle in Latin script, in characters (the broadcast and streaming norm). */
  maxChars: 42,
  /** A clause mark starts a new subtitle only when each side has this many units: a CJK character is 1, a word 2. */
  minUnits: 4,
  /** A pause this long between two words ends a subtitle. */
  pauseMs: 500,
  /** Shortest time on screen: less cannot be read. */
  minMs: 700,
  /** Longest time on screen: more is a wall of text; cut further. */
  maxMs: 7000,
  /** A subtitle stays up this much after its last word ends (never into the next one). */
  holdMs: 200,
  /** A gap shorter than this between two subtitles is closed: the line blinking off and on is worse. */
  closeGapMs: 150,
  /** How long a CJK character takes to say, for timing text between word marks; everything else by its weight. */
  msPerCell: 220,
  /** Speaking weight of a character, a CJK character being 1. Punctuation weighs as the pause it is. */
  weight: Object.freeze({ latin: 0.32, space: 0.15, clause: 1.5, sentence: 2.5 }),
  /**
   * What a cut costs (lower is better), for a clause too long for one line and for cutting a translation. The pause
   * bonus outweighs the words', which outweigh balance: the speaker's own pause is the surest boundary.
   */
  cost: Object.freeze({
    /** each subtitle (fewer is better), and how much uneven pieces cost: balance × Σ(width / cap)² */
    piece: 10, balance: 4,
    /** a piece under minUnits; one over the cap (when nothing else fits); one over maxMs (× its length / maxMs) */
    short: 6, over: 50, long: 20,
    /** where the cut is: between CJK words (more when one is a single character: often a word the dictionary missed),
        where Latin meets CJK, inside brackets or quotes, before a particle that leans on the word before (了 的 们),
        after a word that leans on the next (the, by, 用, 把) */
    cjk: 1, cjkSingle: 1, mixed: 3, bracket: 8, leansBack: 8, leansForward: 4,
    /** before a conjunction, after a closing particle, at the most a pause (scaled up to pauseMs) */
    conjunction: -4, particle: -3, pause: -10,
    /** cutting a translation: at a sentence or clause mark, how far from the original's moment (× the fraction off),
        and not cutting it there at all */
    sentence: -6, clause: -4, distance: 20, merge: 6,
  }),
});

/** @typedef {typeof SUBTITLE_SEGMENT_RULES} SubtitleSegmentRules */
/** @typedef {{ text: string, startMs: number, endMs: number, marks?: readonly { index: number, startMs: number }[] }} SegmentLine */
/**
 * One subtitle cut from a line: its text (as the line has it, trimmed), its times, its timed words (indexes in `text`),
 * which piece of the line it is, and where its text sits in the line's (`from`/`to`, for putting a correction back).
 * @typedef {{ text: string, startMs: number, endMs: number, marks?: { index: number, startMs: number }[], part: number, from: number, to: number }} SubtitlePiece
 */

/* ── characters ──────────────────────────────────────────────────────────── */

/* written without spaces between words: cut by the dictionary, a character at a time */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u3006\u30fc\uff70]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LETTER = /[\p{L}\p{N}\p{M}]/u;
const DIGIT = /\p{N}/u;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
const FULL_PUNCT = /[\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f]/;
/* inside a Latin word when a letter follows: 3.5, e.g, don't, state-of-the-art, and/or, R&D, snake_case */
const JOIN = new Set(['.', '\'', '\u2019', '-', '_', '/', '&']);
/* inside a number when digits are on both sides: 1,000 and 10:30 */
const NUM_JOIN = new Set([',', ':']);
const OPEN = new Set([...'\uff08([\u3010\uff3b\u300c\u300e\u300a\u3008\u201c\u2018\uff5b{']);
const CLOSE = new Set([...'\uff09)]\u3011\uff3d\u300d\u300f\u300b\u3009\u201d\u2019\uff5d}']);
/* parentheses (not quotes or title marks): their edges are clause boundaries */
const PAREN_OPEN = /[\uff08(\u3010\uff3b[]/;
const PAREN_CLOSE = /[\uff09)\u3011\uff3d\]]/;
const CURRENCY = new Set([...'$\u00a5\u20ac\u00a3\u20a9#@']);
const SENTENCE_MARK = /[\u3002\uff01\uff1f!?\u2026\u203c\u2047\u2048\u2049\uff61]|\.{2,}/;
const CLAUSE_MARK = /[\uff0c,\uff1b;\uff1a:\u2014\uff5c|]/;
const LIST_MARK = /\u3001/;
/* a dash between spaces (a false start, "th- the", has none before it) */
const SPACED_DASH = /\s[-\u2013]+(?:\s|$)/;
const DOT = /[.\uff0e]/;

/* abbreviations a full stop follows without ending the sentence; the second kind ends it only before a capital */
const NEVER_ENDS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'e.g', 'i.e', 'cf', 'approx', 'dept', 'gen', 'gov', 'sgt', 'capt', 'lt', 'col', 'rev', 'hon']);
const NUMBERED = new Set(['no', 'nos', 'vol', 'ch', 'p', 'pp', 'fig', 'art', 'sec', 'ep']);
const ENDS_BEFORE_CAPITAL = new Set(['etc', 'inc', 'ltd', 'co', 'corp', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']);

/* a CJK word after a number is mostly its unit or measure word (3 个, 5 秒, 100 元): they stay together */
const MEASURE = /^[\u79d2\u5206\u65f6\u4e2a\u53ea\u5143\u5757\u5c81\u5e74\u6708\u65e5\u53f7\u5929\u5468\u6b21\u500d\u5ea6\u7c73\u514b\u65a4\u91cc\u5c42\u4ef6\u4f4d\u540d\u6761\u5f20\u90e8\u672c\u53f0\u79cd\u70b9\u5e27\u884c\u9875\u5206\u4e07\u4ebf\u5343\u767e\u6beb\u5398\u5c0f\u79d2\u5341]/;
const UNITS = new Set(['s', 'ms', 'sec', 'secs', 'min', 'mins', 'h', 'hr', 'hrs', 'k', 'm', 'km', 'cm', 'mm', 'g', 'kg', 'mg', 'lb', 'lbs', 'ft', 'in', 'b', 'kb', 'mb', 'gb', 'tb', 'fps', 'px', 'pt', 'em', 'x', 'hz', 'khz', 'mhz', 'ghz', 'db', 'am', 'pm', 'p', 'mph', 'kph', 'percent', 'usd', 'rmb', 'yuan']);

/* a cut before these is where speech turns; after the particles, a thought has ended */
const CJK_CONJUNCTIONS = ['\u4f46\u662f', '\u4f46', '\u6240\u4ee5', '\u56e0\u4e3a', '\u7136\u540e', '\u800c\u4e14', '\u5982\u679c', '\u548c', '\u6216', '\u6216\u8005', '\u8fd8\u662f', '\u4e0d\u8fc7', '\u53ef\u662f', '\u5e76\u4e14', '\u4e8e\u662f', '\u56e0\u6b64', '\u867d\u7136', '\u7136\u800c', '\u800c\u662f', '\u4ee5\u53ca', '\u53ea\u8981', '\u5373\u4f7f'];
const LATIN_CONJUNCTIONS = new Set(['and', 'but', 'so', 'because', 'which', 'that', 'or', 'when', 'while', 'if', 'where', 'who', 'though', 'although', 'then', 'unless', 'until']);
/* words that lean on the one before (写了, 我们, 好的, 愿意的话): a cut before them leaves them hanging */
const LEANS_BACK = new Set(['\u4e86', '\u7684', '\u7740', '\u8fc7', '\u4eec', '\u5730', '\u5f97', '\u5417', '\u5462', '\u5427', '\u554a', '\u5440', '\u561b', '\u4e48', '\u4e4b', '\u7684\u8bdd']);
/* words that lean on the one after (to the, by, 用, 把): a cut after them leaves them hanging */
const LEANS_FORWARD = new Set(['a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'about', 'my', 'your', 'our',
  'their', 'his', 'her', 'its', 'this', 'these', 'those', 'very', '\u628a', '\u88ab', '\u7ed9', '\u5bf9', '\u4ece', '\u5411', '\u8ddf', '\u7528', '\u5728', '\u5c06']);
/* hesitations, which the printed subtitle leaves out (captions.mjs): they count for nothing in a piece's length */
const FILLERS = new Set(['\u5443', '\u55ef', '\u989d', 'uh', 'um', 'erm', 'mm', 'mmm', 'hmm', 'mhm']);
const CJK_PARTICLES = ['\u7684\u8bdd', '\u5427', '\u5462', '\u554a', '\u5417', '\u5440', '\u561b'];

/** @param {string} t @param {number} i */
const cpAt = (t, i) => String.fromCodePoint(/** @type {number} */ (t.codePointAt(i)));

/** Whether a text is set by CJK rules: it has CJK characters or full-width marks. @param {string} t */
const cjkText = (t) => CJK.test(t) || HANGUL.test(t) || FULL_PUNCT.test(t);

/** A text's width in cells: a full-width character is one, anything else half. @param {string} t */
export function subtitleCells(t) {
  let n = 0;
  for (const ch of t) n += WIDE.test(ch) || CJK.test(ch) ? 1 : 0.5;
  return n;
}

/**
 * The end of a subtitle as it is printed. Chinese (and Japanese, Korean) subtitles drop a trailing ，。、；： (the
 * subtitle's end is the pause); a question, an exclamation, an ellipsis and closing quotes stay, they say something.
 * Latin subtitles keep their punctuation.
 * @param {string} text
 */
export function subtitleEnd(text) {
  const t = text.trimEnd();
  if (!cjkText(t) || /(?:\.{2,}|\u2026)$/.test(t)) return t;
  return t.replace(/[\s\uff0c,\u3001\u3002\uff0e.\uff1b;\uff1a:]+$/u, '');
}

/* ── words ───────────────────────────────────────────────────────────────── */

/** @type {Intl.Segmenter | null | undefined} */
let segmenter;

/** A CJK run cut into words ([from, to) in the run): by the dictionary, else a character each. @param {string} run */
function cjkWords(run) {
  if (segmenter === undefined) segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  if (segmenter) return [...segmenter.segment(run)].map((s) => ({ from: s.index, to: s.index + s.segment.length }));
  /** @type {{ from: number, to: number }[]} */
  const out = [];
  for (let i = 0; i < run.length;) { const n = cpAt(run, i).length; out.push({ from: i, to: i + n }); i += n; }
  return out;
}

/** The words of a text, [from, to) each: CJK words, and Latin (or Hangul) words with their inner marks. @param {string} t */
function coresOf(t) {
  /** @type {{ from: number, to: number, cjk: boolean }[]} */
  const out = [];
  let i = 0;
  while (i < t.length) {
    const ch = cpAt(t, i);
    if (CJK.test(ch)) {
      let j = i;
      while (j < t.length && CJK.test(cpAt(t, j))) j += cpAt(t, j).length;
      for (const w of cjkWords(t.slice(i, j))) out.push({ from: i + w.from, to: i + w.to, cjk: true });
      i = j;
      continue;
    }
    if (!LETTER.test(ch)) { i += ch.length; continue; }
    let j = i + ch.length;
    while (j < t.length) {
      const c = cpAt(t, j);
      if (LETTER.test(c) && !CJK.test(c)) { j += c.length; continue; }
      const next = j + c.length < t.length ? cpAt(t, j + c.length) : '';
      const joins = next && LETTER.test(next) && !CJK.test(next)
        && (JOIN.has(c) || (NUM_JOIN.has(c) && DIGIT.test(t[j - 1] ?? '') && DIGIT.test(next)));
      if (!joins) break;
      j += c.length;
    }
    out.push({ from: i, to: j, cjk: false });
    i = j;
  }
  return out;
}

/**
 * A word with the punctuation that sticks to it: `from`..`coreFrom` opening marks, `coreTo`..`to` closing marks and the
 * spaces after. The atoms of a text cover it end to end.
 * @typedef {{ from: number, coreFrom: number, coreTo: number, to: number, core: string, trail: string, lead: string, cjk: boolean, number: boolean, units: number, start: number, end: number }} Atom
 */
/**
 * Between two atoms: what kind of boundary (`hard`: sentence end or pause; `clause`; `soft`), never to be cut (`glue`),
 * how much a cut costs there, and the silence there (ms).
 * @typedef {{ hard: boolean, sentence: boolean, clause: boolean, glue: boolean, cost: number, gap: number, depth: number }} Bound
 */

/** @param {string} t @returns {Atom[]} */
function atomsOf(t) {
  const cores = coresOf(t);
  return cores.map((c, k) => {
    const from = k === 0 ? 0 : leadStart(t, cores[k - 1].to, c.from);
    const to = k + 1 < cores.length ? leadStart(t, c.to, cores[k + 1].from) : t.length;
    const core = t.slice(c.from, c.to);
    return {
      from, coreFrom: c.from, coreTo: c.to, to, core, trail: t.slice(c.to, to), lead: t.slice(from, c.from), cjk: c.cjk,
      number: /^\p{N}[\p{N}.,:]*$/u.test(core),
      /* a CJK character is a unit, a word two: CJK ≥ 4 characters, Latin ≥ 2 words */
      units: FILLERS.has(core.toLowerCase()) ? 0 : c.cjk ? [...core].length : 2,
      start: 0, end: 0,
    };
  });
}

/**
 * Where a word's opening marks begin, between the word before (ending at `prevTo`) and it (at `from`): opening
 * brackets and quotes, a currency sign. A straight quote opens when what is before it is not a letter.
 * @param {string} t @param {number} prevTo @param {number} from
 */
function leadStart(t, prevTo, from) {
  let i = from;
  while (i > prevTo) {
    const ch = t[i - 1];
    const opening = OPEN.has(ch) || CURRENCY.has(ch) || (ch === '"' && i - 1 > prevTo && !LETTER.test(t[i - 2] ?? ''));
    if (!opening) break;
    i -= 1;
  }
  return i;
}

/** Whether a full stop after `prev` ends its sentence (`next`: the word after, if any). @param {Atom} prev @param {Atom | undefined} next */
function stopEnds(prev, next) {
  if (!next || next.cjk) return true;
  const word = prev.core.toLowerCase();
  if (NEVER_ENDS.has(word)) return false;
  /* No. 5, p. 12 */
  if (next.number && NUMBERED.has(word)) return false;
  /* an initial: J. K. Rowling */
  if (/^\p{Lu}$/u.test(prev.core)) return false;
  /* U.S., a.m., etc.: the sentence ends there only if the next word starts one */
  if (/^(?:\p{L}\.)+\p{L}$/u.test(prev.core) || ENDS_BEFORE_CAPITAL.has(word)) return /^\p{Lu}/u.test(next.core) && next.core !== 'I';
  return true;
}

/* ── timing ──────────────────────────────────────────────────────────────── */

/** @param {string} ch @param {SubtitleSegmentRules} R */
function weightOf(ch, R) {
  if (CJK.test(ch) || HANGUL.test(ch)) return 1;
  if (LETTER.test(ch)) return R.weight.latin;
  if (/\s/.test(ch)) return R.weight.space;
  if (SENTENCE_MARK.test(ch) || DOT.test(ch)) return R.weight.sentence;
  if (CLAUSE_MARK.test(ch) || LIST_MARK.test(ch) || PAREN_OPEN.test(ch) || PAREN_CLOSE.test(ch)) return R.weight.clause;
  return 0;
}

/**
 * When each character of a line starts and ends (ms, by code unit). With word marks, the text from one mark to the
 * next is said at the speaking pace from its mark (faster when the next mark comes sooner); what is left before the
 * next mark is a pause. Without marks, the line's time is shared out by weight.
 * @param {SegmentLine} line @param {SubtitleSegmentRules} R
 */
function timeline(line, R) {
  const t = line.text;
  const start = new Float64Array(t.length), end = new Float64Array(t.length);
  const weights = new Float64Array(t.length);
  for (let i = 0; i < t.length;) { const ch = cpAt(t, i); weights[i] = weightOf(ch, R); i += ch.length; }
  const marks = (line.marks ?? []).filter((m) => m.index >= 0 && m.index < t.length);
  const spans = marks.length
    ? [...(marks[0].index > 0 ? [{ index: 0, startMs: line.startMs }] : []), ...marks]
    : [{ index: 0, startMs: line.startMs }];
  spans.forEach((m, k) => {
    const to = spans[k + 1]?.index ?? t.length;
    const until = spans[k + 1]?.startMs ?? line.endMs;
    const room = Math.max(0, until - m.startMs);
    let total = 0;
    for (let i = m.index; i < to; i += 1) total += weights[i];
    const per = !total ? 0 : !marks.length ? room / total : Math.min(R.msPerCell, room / total);
    let at = m.startMs;
    for (let i = m.index; i < to; i += 1) { start[i] = at; at += weights[i] * per; end[i] = at; }
  });
  return { start, end };
}

/* ── one line ────────────────────────────────────────────────────────────── */

/**
 * A text's atoms and the boundaries between them (`bounds[k]`: between atom k-1 and k), timed when `times` is given;
 * pauses are told only from real word times (`heard`): spread-out times would invent them.
 * @param {string} t @param {SubtitleSegmentRules} R @param {{ start: Float64Array, end: Float64Array } | null} times @param {boolean} heard
 */
function analyse(t, R, times, heard) {
  const atoms = atomsOf(t);
  if (times) for (const a of atoms) { a.start = times.start[a.coreFrom]; a.end = times.end[a.coreTo - 1]; }
  /** @type {Bound[]} */
  const bounds = [];
  const C = R.cost;
  let depth = 0, quoted = false;
  for (let k = 0; k + 1 < atoms.length; k += 1) {
    const a = atoms[k], next = atoms[k + 1];
    for (const ch of a.lead) { if (OPEN.has(ch)) depth += 1; else if (ch === '"') { depth += 1; quoted = true; } }
    for (const ch of a.trail) {
      if (CLOSE.has(ch)) depth = Math.max(0, depth - 1);
      else if (ch === '"' && quoted) { depth = Math.max(0, depth - 1); quoted = false; }
    }
    const trail = a.trail.trim();
    const gap = heard ? Math.max(0, next.start - a.end) : 0;
    const stop = DOT.test(trail.slice(-1)) && !/\.{2,}$/.test(trail) && stopEnds(a, next);
    const sentence = SENTENCE_MARK.test(trail) || stop;
    const clause = CLAUSE_MARK.test(trail) || SPACED_DASH.test(a.trail) || PAREN_CLOSE.test(trail) || PAREN_OPEN.test(next.lead);
    /* a number with its unit (3.5 s, 5 秒), 第 with its number */
    const glue = !trail && ((a.number && (next.cjk ? MEASURE.test(next.core) : UNITS.has(next.core.toLowerCase())))
      || (a.cjk && a.core.endsWith('\u7b2c') && next.number));
    let cost = 0;
    if (a.cjk && next.cjk) cost += C.cjk + ([...a.core].length === 1 || [...next.core].length === 1 ? C.cjkSingle : 0);
    else if (a.cjk !== next.cjk) cost += C.mixed;
    if (depth > 0) cost += C.bracket;
    if (next.cjk && LEANS_BACK.has(next.core)) cost += C.leansBack;
    if (!trail && LEANS_FORWARD.has(a.core.toLowerCase())) cost += C.leansForward;
    if (gap >= 120) cost += C.pause * Math.min(1, (gap - 120) / Math.max(1, R.pauseMs - 120));
    const conjunction = next.cjk
      ? CJK_CONJUNCTIONS.some((c) => next.core === c || (c.length > 1 && next.core.startsWith(c)))
      : LATIN_CONJUNCTIONS.has(next.core.toLowerCase());
    if (conjunction) cost += C.conjunction;
    if (a.cjk && CJK_PARTICLES.some((p) => a.core === p || (p.length > 1 && a.core.endsWith(p)))) cost += C.particle;
    if (sentence) cost += C.sentence;
    else if (clause || LIST_MARK.test(trail)) cost += C.clause;
    bounds[k + 1] = {
      hard: gap >= R.pauseMs || (depth === 0 && sentence), sentence: depth === 0 && sentence, clause: depth === 0 && clause,
      glue, cost, gap, depth,
    };
  }
  return { atoms, bounds };
}

/**
 * Measures of a text's atoms: the width of atoms [i, j) (cells for CJK text, characters for Latin), their units, how
 * long they take to say.
 * @param {string} t @param {Atom[]} atoms @param {SubtitleSegmentRules} R
 */
function measures(t, atoms, R) {
  const cjk = cjkText(t);
  const cap = cjk ? R.maxCells : R.maxChars;
  /** @param {number} i @param {number} j */
  const width = (i, j) => {
    const shown = t.slice(atoms[i].from, atoms[j - 1].coreTo).trim();
    return cjk ? subtitleCells(shown) : [...shown].length;
  };
  /** @param {number} i @param {number} j */
  const units = (i, j) => { let n = 0; for (let k = i; k < j; k += 1) n += atoms[k].units; return n; };
  /** @param {number} i @param {number} j */
  const dur = (i, j) => atoms[j - 1].end - atoms[i].start;
  return { cap, width, units, dur };
}

/**
 * Atoms [s, e) too long for one subtitle, cut where the cuts cost least (dynamic programming over the boundaries):
 * returns the atom indexes the pieces start at.
 * @param {number} s @param {number} e @param {Bound[]} bounds @param {ReturnType<typeof measures>} m @param {SubtitleSegmentRules} R
 */
function cutLong(s, e, bounds, m, R) {
  const C = R.cost;
  const n = e - s;
  const best = new Float64Array(n + 1).fill(Infinity);
  const back = new Int32Array(n + 1);
  best[0] = 0;
  for (let j = 1; j <= n; j += 1) {
    for (let i = j - 1; i >= 0; i -= 1) {
      if (!Number.isFinite(best[i]) || (i > 0 && bounds[s + i].glue)) continue;
      const w = m.width(s + i, s + j);
      let cost = best[i] + C.piece + C.balance * (Math.min(w, m.cap) / m.cap) ** 2;
      if (w > m.cap) cost += C.over * (w - m.cap);
      if (m.units(s + i, s + j) < R.minUnits) cost += C.short;
      const d = m.dur(s + i, s + j);
      if (d > R.maxMs) cost += C.long * (d / R.maxMs);
      if (i > 0) cost += bounds[s + i].cost;
      if (cost < best[j]) { best[j] = cost; back[j] = i; }
    }
  }
  /** @type {number[]} */
  const starts = [];
  for (let j = n; j > 0; j = back[j]) starts.unshift(s + back[j]);
  return starts;
}

/**
 * A spoken line cut into subtitles (see the rules at the top). Always at least one piece; the pieces cover the line's
 * text end to end, in order, and depend on nothing but the line, so the same line always gives the same pieces (a
 * correction names its piece by number).
 * @param {SegmentLine} line @param {SubtitleSegmentRules} [R]
 * @returns {SubtitlePiece[]}
 */
export function segmentLine(line, R = SUBTITLE_SEGMENT_RULES) {
  const t = line.text;
  const whole = () => [{ text: t.trim(), startMs: line.startMs, endMs: line.endMs, ...(line.marks?.length ? { marks: [...line.marks] } : {}), part: 0, from: t.length - t.trimStart().length, to: t.trimEnd().length }];
  const times = timeline(line, R);
  const { atoms, bounds } = analyse(t, R, times, Boolean(line.marks?.length));
  if (atoms.length < 2) return whole();
  const m = measures(t, atoms, R);

  /* 2. sentences (and long pauses), 3. clauses with enough on both sides, 4. what is still too long */
  /** @type {number[]} */
  const starts = [];
  let sentence = 0;
  for (let k = 1; k <= atoms.length; k += 1) {
    if (k < atoms.length && !bounds[k].hard) continue;
    let piece = sentence;
    /** @type {number[]} */
    const clauses = [sentence];
    for (let c = sentence + 1; c < k; c += 1) {
      if (!bounds[c].clause) continue;
      if (m.units(piece, c) >= R.minUnits && m.units(c, k) >= R.minUnits) { clauses.push(c); piece = c; }
    }
    clauses.forEach((from, n) => {
      const to = clauses[n + 1] ?? k;
      if (m.width(from, to) <= m.cap && m.dur(from, to) <= R.maxMs) starts.push(from);
      else starts.push(...cutLong(from, to, bounds, m, R));
    });
    sentence = k;
  }

  /* 5. times, the short ones held or joined */
  /** @type {{ a: number, b: number, startMs: number, endMs: number }[]} */
  let pieces = starts.map((a, n) => ({ a, b: starts[n + 1] ?? atoms.length, startMs: 0, endMs: 0 }));
  const strength = (/** @type {number} */ k) => (bounds[k].gap >= R.pauseMs ? 3 : bounds[k].sentence ? 2 : bounds[k].clause ? 1 : 0);
  const time = () => {
    pieces.forEach((p, n) => {
      p.startMs = n === 0 ? line.startMs : Math.max(Math.round(atoms[p.a].start), pieces[n - 1].startMs + 1);
    });
    pieces.forEach((p, n) => {
      const next = pieces[n + 1];
      if (!next) { p.endMs = Math.max(line.endMs, p.startMs + 1); return; }
      let end = Math.min(next.startMs, Math.max(Math.round(atoms[p.b - 1].end), p.startMs + 1) + R.holdMs);
      if (end - p.startMs < R.minMs) end = Math.min(next.startMs, p.startMs + R.minMs);
      if (next.startMs - end < R.closeGapMs) end = next.startMs;
      p.endMs = end;
    });
  };
  time();
  for (let guard = pieces.length; guard > 0; guard -= 1) {
    const n = pieces.findIndex((p, i) => p.endMs - p.startMs < R.minMs && pieces.length > 1 && [i - 1, i + 1].some((o) => joinable(i, o)));
    if (n < 0) break;
    const options = [n - 1, n + 1].filter((o) => joinable(n, o));
    /* across the weaker boundary, else into the shorter neighbor */
    options.sort((x, y) => strength(pieces[Math.max(n, x)].a) - strength(pieces[Math.max(n, y)].a) || m.width(pieces[x].a, pieces[x].b) - m.width(pieces[y].a, pieces[y].b));
    const o = options[0];
    const [lo, hi] = o < n ? [o, n] : [n, o];
    pieces.splice(lo, 2, { a: pieces[lo].a, b: pieces[hi].b, startMs: 0, endMs: 0 });
    time();
  }
  function joinable(/** @type {number} */ n, /** @type {number} */ o) {
    const p = pieces[n], q = pieces[o];
    if (!p || !q) return false;
    const a = Math.min(p.a, q.a), b = Math.max(p.b, q.b);
    return m.width(a, b) <= m.cap && m.dur(a, b) <= R.maxMs;
  }
  if (pieces.length === 1) return whole();

  /* the pieces' text and timed words, each mark moved to its place in the piece */
  const marks = line.marks ?? [];
  return pieces.map((p, part) => {
    const from = p.a === 0 ? t.length - t.trimStart().length : atoms[p.a].from;
    const to = p.b === atoms.length ? t.trimEnd().length : from + t.slice(from, atoms[p.b].from).trimEnd().length;
    const own = marks.filter((mk) => mk.index >= from && mk.index < to).map((mk) => ({ index: mk.index - from, startMs: mk.startMs }));
    const timed = marks.length ? (own[0]?.index === 0 ? own : [{ index: 0, startMs: p.startMs }, ...own]) : [];
    return { text: t.slice(from, to), startMs: p.startMs, endMs: p.endMs, ...(timed.length ? { marks: timed } : {}), part, from, to };
  });
}

/* ── translations ────────────────────────────────────────────────────────── */

/**
 * A translation of a line cut to follow the original's pieces: one entry per piece, its text and where it sits in
 * `text`. The translation is cut by the same marks (sentence, clause, word boundaries) as near as it can to the moments
 * the original's pieces start (by its speaking weight: the translation is read over the same speech). A cut too far
 * from any good boundary is not made: then one translated piece spans several of the original's (the same entry
 * repeated), rather than a translation cut mid-thought.
 * @param {string} text @param {readonly { startMs: number, endMs: number }[]} pieces @param {SubtitleSegmentRules} [R]
 * @returns {{ text: string, from: number, to: number }[]}
 */
export function alignTranslation(text, pieces, R = SUBTITLE_SEGMENT_RULES) {
  const lead = text.length - text.trimStart().length, tail = text.trimEnd().length;
  const whole = { text: text.trim(), from: lead, to: Math.max(lead, tail) };
  if (pieces.length < 2 || !whole.text) return pieces.map(() => whole);
  const { atoms, bounds } = analyse(text, R, null, false);
  const A = atoms.length, N = pieces.length;
  if (A < 2) return pieces.map(() => whole);
  const C = R.cost;
  const m = measures(text, atoms, R);
  /* how far into the translation each boundary is, by speaking weight */
  const before = new Float64Array(A + 1);
  for (let k = 0; k < A; k += 1) {
    let w = 0;
    for (const ch of atoms[k].core) w += weightOf(ch, R);
    before[k + 1] = before[k] + w;
  }
  const total = before[A] || 1;
  const span = Math.max(1, pieces[N - 1].endMs - pieces[0].startMs);
  const target = pieces.slice(1).map((p) => (p.startMs - pieces[0].startMs) / span);
  const shortCost = (/** @type {number} */ a, /** @type {number} */ b) => (m.units(a, b) < R.minUnits ? C.short : 0);
  /* best[j][p]: the first j of the original's boundaries decided, the last cut at atom p (0: none yet) */
  const best = Array.from({ length: N }, () => new Float64Array(A).fill(Infinity));
  const back = Array.from({ length: N }, () => new Int32Array(A).fill(-1));
  best[0][0] = 0;
  for (let j = 0; j < N - 1; j += 1) {
    for (let p = 0; p < A; p += 1) {
      const here = best[j][p];
      if (!Number.isFinite(here)) continue;
      if (here + C.merge < best[j + 1][p]) { best[j + 1][p] = here + C.merge; back[j + 1][p] = p; }
      for (let q = p + 1; q < A; q += 1) {
        if (bounds[q].glue) continue;
        const cost = here + C.distance * Math.abs(before[q] / total - target[j]) + bounds[q].cost + shortCost(p, q);
        if (cost < best[j + 1][q]) { best[j + 1][q] = cost; back[j + 1][q] = p; }
      }
    }
  }
  let last = 0, lowest = Infinity;
  for (let p = 0; p < A; p += 1) {
    const cost = best[N - 1][p] + shortCost(p, A);
    if (cost < lowest) { lowest = cost; last = p; }
  }
  /* each of the original's boundaries: where the translation is cut there, or -1 */
  const cuts = new Array(N - 1).fill(-1);
  for (let j = N - 1, p = last; j > 0; j -= 1) {
    const prev = back[j][p];
    if (prev !== p) cuts[j - 1] = p;
    p = prev;
  }
  /** @type {{ text: string, from: number, to: number }[]} */
  const out = [];
  for (let n = 0, at = 0; n < N;) {
    /* pieces n..last share the translation from atom `at` to the next cut */
    let last = n;
    while (last < N - 1 && cuts[last] < 0) last += 1;
    const until = last < N - 1 ? cuts[last] : A;
    const a = at === 0 ? lead : atoms[at].from;
    const b = until === A ? tail : a + text.slice(a, atoms[until].from).trimEnd().length;
    const one = { text: text.slice(a, b), from: a, to: b };
    for (; n <= last; n += 1) out.push(one);
    at = until;
  }
  return out;
}

/* ── corrections ─────────────────────────────────────────────────────────── */

/**
 * A line with the person's correction of one of its pieces (`from`/`to` in its text) put in. What the subtitle dropped
 * at its end (a comma) goes back after the new words, unless they end with a mark of their own; emptied, the piece goes
 * with the space after it. Timed words outside the piece keep their times (so the other subtitles stay as they were);
 * the piece's own are one mark at its start (`startMs`): a changed piece is timed as a whole.
 * @param {SegmentLine} line @param {{ from: number, to: number }} piece @param {string} text @param {number} [startMs]
 * @returns {{ text: string, marks?: { index: number, startMs: number }[] }}
 */
export function replacePiece(line, piece, text, startMs) {
  const t = line.text;
  const raw = t.slice(piece.from, piece.to);
  const dropped = raw.slice(subtitleEnd(raw).length);
  const said = text.replace(/\s+/g, ' ').trim();
  let end = piece.to;
  let insert = said;
  if (!said) {
    while (end < t.length && /\s/.test(t[end])) end += 1;
  } else if (!/\p{P}$/u.test(said)) {
    insert += dropped;
  }
  let out = t.slice(0, piece.from) + insert + t.slice(end);
  const delta = insert.length - (end - piece.from);
  /** @type {{ index: number, startMs: number }[]} */
  let marks = [];
  for (const mk of line.marks ?? []) {
    if (mk.index < piece.from) marks.push(mk);
    else if (mk.index >= end) marks.push({ index: mk.index + delta, startMs: mk.startMs });
  }
  if (said && startMs !== undefined && piece.from > 0 && line.marks?.length) {
    marks.push({ index: piece.from, startMs });
    marks.sort((a, b) => a.index - b.index);
  }
  const lead = out.length - out.trimStart().length;
  out = out.trim();
  marks = marks.map((mk) => ({ index: mk.index - lead, startMs: mk.startMs })).filter((mk) => mk.index >= 0 && mk.index < out.length);
  return { text: out, ...(marks.length ? { marks } : {}) };
}
