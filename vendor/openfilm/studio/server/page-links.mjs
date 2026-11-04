// @ts-check
/**
 * A web page's links to the files beside it, kept true when it moves. A page is code: `<script src="anim.js">`,
 * `<img src="../assets/logo.png">`, `url(bg.png)` and `import './lib.js'` are read from where the page is, so a page
 * moved to another folder would look for them in the wrong place. Moving one (files.mjs moveFile) writes each such
 * link again so it still reaches the same file, wherever that file is now (a folder moved with its page takes its
 * files along).
 *
 * What is rewritten: in a page, `src`, `href` and `poster` attributes, CSS `url()` (in `<style>` and `style=""`), and
 * in its scripts `import … from '…'`, `import '…'`, `import('…')`, `new URL('…', import.meta.url)` and `fetch('…')`
 * with a literal path; in a stylesheet, its `url()` and `@import`; in a module script, its imports. A path made while
 * the page runs (`fetch(base + name)`, `` img.src = `${dir}/x.png` ``) cannot be seen: it is listed (`unseen`) so the
 * person is told before the page moves.
 */
import { posix } from 'node:path';

/** A link that leads elsewhere than a file beside the page: a scheme, the site's root, a fragment, a template. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|\/|#|\?|\$\{|\{\{)/i;

/**
 * The same link from `toDir`, to the file it reached from `fromDir` (`where` gives where that file is now). Null when
 * it is not a link to a file beside the page, or nothing changes.
 * @param {string} ref @param {string} fromDir @param {string} toDir @param {(path: string) => string} where
 * @param {boolean} [module] an import: it must start with ./ or ../ (a bare name is a package's)
 */
function relink(ref, fromDir, toDir, where, module = false) {
  const trimmed = ref.trim();
  if (!trimmed || NOT_RELATIVE.test(trimmed) || trimmed.includes('${')) return null;
  if (module && !/^\.\.?\//.test(trimmed)) return null;
  const cut = trimmed.search(/[?#]/);
  const path = cut < 0 ? trimmed : trimmed.slice(0, cut);
  const tail = cut < 0 ? '' : trimmed.slice(cut);
  if (!path) return null;
  const target = posix.normalize(posix.join(fromDir, path));
  if (target.startsWith('../')) return null;
  let next = posix.relative(toDir, where(target)) || posix.basename(target);
  if (path.endsWith('/') && !next.endsWith('/')) next += '/';
  if (module && !next.startsWith('.')) next = `./${next}`;
  const out = next + tail;
  return out === trimmed ? null : out;
}

/** Paths made while the code runs: what can be named, so the person knows what was not rewritten. */
const MADE_AT_RUN = [
  /\b(?:fetch|import|new\s+URL|new\s+Audio|new\s+Worker)\s*\(\s*(?![\s'"])[^)]{0,60}/g,
  /\b(?:fetch|import|new\s+URL|new\s+Audio|new\s+Worker)\s*\(\s*`[^`]*\$\{[^`]{0,60}`/g,
  /\.(?:src|href)\s*=\s*(?![\s'"])[^;\n]{0,60}/g,
  /\.(?:src|href)\s*=\s*`[^`]*\$\{[^`]{0,60}`/g,
  /\b(?:src|href)\s*=\s*["'][^"']*\$\{[^"']{0,60}["']/g,
];

/** What in `text` makes a path while it runs, each once, shortened. @param {string} text */
function unseenIn(text) {
  const found = new Set();
  for (const re of MADE_AT_RUN) for (const m of text.matchAll(re)) found.add(m[0].replace(/\s+/g, ' ').trim().slice(0, 80));
  return [...found];
}

/**
 * A file's links written again for its move. `kind`: what the file is (a page, a stylesheet, a module script).
 * @param {string} text @param {'html' | 'css' | 'js'} kind @param {string} fromDir @param {string} toDir
 * @param {(path: string) => string} [where] where a file that was at `path` is now (its own place by default)
 * @returns {{ text: string, changed: number, unseen: string[] }}
 */
export function rewriteLinks(text, kind, fromDir, toDir, where = (p) => p) {
  let changed = 0;
  const swap = (/** @type {string} */ whole, /** @type {string} */ ref, /** @type {boolean} */ module = false) => {
    const next = relink(ref, fromDir, toDir, where, module);
    if (next == null) return whole;
    changed++;
    const at = whole.lastIndexOf(ref);
    return whole.slice(0, at) + next + whole.slice(at + ref.length);
  };
  let out = text;
  /* CSS, in a stylesheet or a page */
  out = out.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi, (whole, _q, ref) => swap(whole, ref));
  if (kind === 'css') out = out.replace(/@import\s+(["'])([^"']+)\1/gi, (whole, _q, ref) => swap(whole, ref));
  if (kind === 'html') {
    out = out.replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi, (whole, _a, _q, ref) => swap(whole, ref));
    out = out.replace(/\bfetch\(\s*(["'])([^"']+)\1/g, (whole, _q, ref) => swap(whole, ref));
  }
  if (kind === 'html' || kind === 'js') {
    out = out.replace(/(\b(?:import|export)\b[^'";]*?\bfrom\s*)(["'])([^"']+)\2/g, (whole, _a, _q, ref) => swap(whole, ref, true));
    out = out.replace(/\bimport\s*(["'])([^"']+)\1/g, (whole, _q, ref) => swap(whole, ref, true));
    out = out.replace(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g, (whole, _q, ref) => swap(whole, ref, true));
    out = out.replace(/\bnew\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url/g, (whole, _q, ref) => swap(whole, ref));
  }
  return { text: out, changed, unseen: kind === 'css' ? [] : unseenIn(text) };
}

/** What a file is, for its links: a page, a stylesheet, a module script, or none. @param {string} name */
export function linkKind(name) {
  const ext = posix.extname(name).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.js' || ext === '.mjs') return 'js';
  return null;
}
