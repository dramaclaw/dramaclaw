// @ts-check
/**
 * What the web search providers share: their hits as the agent reads them, and web pages saved as Markdown under
 * assets/fetch/, each named after its address and saying where and when it was read.
 *
 * `readPage` reads a page with no service at all: its HTML is fetched from this machine and turned into text. Public
 * pages only: an address on this machine or its network (and every redirect) is refused.
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { list, text } from './common.mjs';

/** @typedef {import('./contract.mjs').RunContext} RunContext @typedef {import('./contract.mjs').RunResult} RunResult */

/** The most queries or pages one run takes (the verbs' help says so). */
export const MOST = 3;
/** Hits per query. */
export const HITS = 8;
/** How long an excerpt is: enough to tell which page to read, not to read it. */
const EXCERPT = 300;
/** How much of a page the receipt shows. */
const HEAD = 400;
/** The largest page read. */
const MAX_PAGE = 5 << 20;
/** How many redirects a page may take. */
const MAX_HOPS = 5;
/** `publicOnly: false` lets tests read pages from 127.0.0.1. */
export const reading = { publicOnly: true };

/** The queries asked (up to MOST) and the rest. @param {Record<string, unknown>} args */
export function queriesOf(args) {
  const all = list(args.query);
  if (!all.length) throw new Error('--query is required.');
  return { queries: all.slice(0, MOST), ignored: all.slice(MOST) };
}

/** One hit as the agent reads it: its excerpt on one line, cut short. @param {{ title: unknown, url: unknown, excerpt: unknown, publishedAt?: unknown }} hit */
export function hitOf(hit) {
  const excerpt = text(hit.excerpt).replace(/\s+/g, ' ');
  const published = text(hit.publishedAt);
  return {
    title: text(hit.title), url: text(hit.url), ...(published ? { publishedAt: published } : {}),
    excerpt: excerpt.length > EXCERPT ? `${excerpt.slice(0, EXCERPT)}…` : excerpt,
  };
}

/**
 * A search's result: one query's `{ query, hits }`, or `{ searches, ignored? }` for more.
 * @param {string} provider @param {{ query: string, hits: ReturnType<typeof hitOf>[] }[]} rows @param {string[]} ignored
 * @returns {RunResult}
 */
export function searched(provider, rows, ignored) {
  const receipt = rows.length === 1 && !ignored.length ? { provider, ...rows[0] } : { provider, searches: rows, ...(ignored.length ? { ignored } : {}) };
  return { files: [], index: [], receipt };
}

/** The pages asked (up to MOST, http or https only) and the rest. @param {Record<string, unknown>} args */
export function urlsOf(args) {
  const all = list(args.url);
  if (!all.length) throw new Error('--url is required.');
  const bad = all.filter((u) => !/^https?:\/\//i.test(u));
  if (bad.length) throw new Error(`Not web addresses: ${bad.join(', ')}. Files of the project need no fetching: read them.`);
  return { urls: all.slice(0, MOST), ignored: all.slice(MOST) };
}

/** A page's file name: its site and the end of its path, and a short hash (two sites' /docs/intro differ). @param {string} url */
function nameOf(url) {
  let base = '';
  try {
    const u = new URL(url);
    base = `${u.hostname.replace(/^www\./, '')}-${u.pathname.split('/').filter(Boolean).slice(-2).join('-')}`;
  } catch { /* not an address: the hash names it */ }
  base = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return `${base || 'page'}-${createHash('sha256').update(url).digest('hex').slice(0, 6)}`;
}

/**
 * The pages read, saved as `assets/fetch/<name>.md`, and what the agent is told: one page's `{ src, url, title, chars,
 * head }`, or `{ pages, failed?, ignored? }`. Throws, saying why for each, when none was read.
 * @param {string} provider
 * @param {{ url: string, title: string, text: string }[]} pages
 * @param {{ url: string, why: string }[]} failed @param {string[]} ignored
 * @returns {RunResult}
 */
export function fetched(provider, pages, failed, ignored) {
  if (!pages.length) throw new Error(['Could not read:', ...failed.map((f) => `  ${f.url}: ${f.why}`)].join('\n'));
  const at = new Date().toISOString();
  const files = [], index = [], rows = [];
  for (const page of pages) {
    const path = `assets/fetch/${nameOf(page.url)}.md`;
    const body = [`<!-- source: ${page.url} -->`, `<!-- fetched: ${at} -->`, ...(page.title ? [`# ${page.title}`] : []), '', page.text.trim(), ''].join('\n');
    files.push({ path, bytes: new Uint8Array(Buffer.from(body, 'utf8')) });
    index.push({ src: path, kind: 'file', ...(page.title ? { title: page.title } : {}), from: { mode: 'fetch', sourceUrl: page.url, provider } });
    rows.push({ src: path, url: page.url, ...(page.title ? { title: page.title } : {}), chars: page.text.length, head: page.text.replace(/\s+/g, ' ').trim().slice(0, HEAD) });
  }
  const receipt = rows.length === 1 && !failed.length && !ignored.length ? { provider, ...rows[0] }
    : { provider, pages: rows, ...(failed.length ? { failed } : {}), ...(ignored.length ? { ignored } : {}) };
  return { files, index, receipt };
}

/* ── reading a page here ─────────────────────────────────────────────────── */

const privateV4 = new BlockList();
for (const [net, bits] of /** @type {[string, number][]} */ ([['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]])) privateV4.addSubnet(net, bits, 'ipv4');
const privateV6 = new BlockList();
for (const [net, bits] of /** @type {[string, number][]} */ ([['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]])) privateV6.addSubnet(net, bits, 'ipv6');
/* the addresses a fake-ip proxy (common on desktops) gives every name: where the name really is, the proxy knows */
const fakeIp = new BlockList();
fakeIp.addSubnet('198.18.0.0', 15, 'ipv4');

const publicIp = (/** @type {string} */ ip) => {
  const family = isIP(ip);
  return family === 4 ? !privateV4.check(ip, 'ipv4') : family === 6 ? !privateV6.check(ip, 'ipv6') : false;
};

/** Throws unless `url` is a public web page (by its name, and the addresses that name has). @param {string} url */
async function publicPage(url) {
  const deny = () => { throw new Error('only public web pages are read, not this machine or its network.'); };
  let at;
  try { at = new URL(url); } catch { throw new Error('not a web address.'); }
  if (!['http:', 'https:'].includes(at.protocol) || at.username || at.password) throw new Error('only http and https pages are read.');
  if (!reading.publicOnly) return;
  const host = at.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (/(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|test|invalid)$/.test(host) || (!host.includes('.') && !isIP(host))) deny();
  if (isIP(host)) { if (!publicIp(host)) deny(); return; }
  let addresses;
  try { addresses = await lookup(host, { all: true, verbatim: true }); } catch { throw new Error(`${host} could not be found.`); }
  const real = addresses.filter((a) => !(a.family === 4 && fakeIp.check(a.address, 'ipv4')));
  if (!addresses.length || real.some((a) => !publicIp(a.address))) deny();
}

/** A page's bytes, up to MAX_PAGE. @param {Response} res */
async function bytesOf(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (res.body ?? [])) {
    size += chunk.length;
    if (size > MAX_PAGE) throw new Error(`it is larger than ${MAX_PAGE >> 20} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The text of bytes in the character set the page says (its header, else its own meta tag), UTF-8 otherwise. @param {Buffer} bytes @param {string} type */
function decode(bytes, type) {
  const label = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8';
  try { return new TextDecoder(label).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/**
 * A public web page's title and text, read from this machine: HTML as Markdown-like text, plain text as it is.
 * Throws a short reason (the caller names the page).
 * @param {string} url @param {RunContext} ctx @returns {Promise<{ url: string, title: string, text: string }>}
 */
export async function readPage(url, ctx) {
  let at = url;
  for (let hop = 0; ; hop += 1) {
    await publicPage(at);
    let res;
    try {
      res = await fetch(at, { redirect: 'manual', signal: ctx.signal, headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; OpenFilm)',
      } });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      throw new Error(`it could not be reached (${/** @type {Error} */ (e).message}).`);
    }
    const next = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && next) {
      await res.body?.cancel();
      if (hop >= MAX_HOPS) throw new Error('it redirects too many times.');
      at = new URL(next, at).href;
      continue;
    }
    if (!res.ok) { await res.body?.cancel(); throw new Error(`it answered ${res.status}.`); }
    const type = res.headers.get('content-type') ?? '';
    if (type && !/text\/html|application\/xhtml|text\/plain|text\/markdown/i.test(type)) {
      await res.body?.cancel();
      throw new Error(`it is not a web page (${type.split(';')[0]}); download it with curl instead.`);
    }
    const body = decode(await bytesOf(res), type);
    const page = /html/i.test(type) || /^\s*</.test(body) ? htmlText(body) : { title: '', text: body.trim() };
    if (!page.text) throw new Error('it has no text (a page drawn by its scripts is not read here).');
    return { url: at, ...page };
  }
}

const ENTITIES = /** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', laquo: '«', raquo: '»', times: '×',
});

/** Text with its character references written out. @param {string} s */
function entities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A page's title and its text from its HTML: its one article (else its main part, else its body) without scripts, styles,
 * navigation, asides and footers; headings as `#`, list items as `-`, one blank line between blocks.
 * @param {string} html
 */
export function htmlText(html) {
  const title = entities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  let s = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside|button|select)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  /* one article is the page's; many are a list of them (a blog's front page), read whole */
  const articles = [...s.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1]);
  const part = (articles.length === 1 ? articles[0] : null) ?? /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(s)?.[1] ?? /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(s)?.[1] ?? s;
  s = part
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, inner) => {
      const said = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      return said ? `\n\n${'#'.repeat(Number(level))} ${said}\n\n` : '\n\n';
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|main|blockquote|pre|table|tr|ul|ol|dl|dt|dd|figure|figcaption|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  const text = entities(s).split('\n').map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim()).join('\n')
    .replace(/^-$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}
