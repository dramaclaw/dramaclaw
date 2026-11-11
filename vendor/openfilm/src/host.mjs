// The reference host (SPEC §4): serves a film folder over HTTP, opens its page in Chromium and asks it for frames.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { createReadStream, readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { DEFAULT_STAGE, FILM_FILE, readFilmFile } from './film-doc.mjs';
import { readableLink } from './media-links.mjs';

// Media seeks that land inside the frame they name. A plain `video.currentTime = t` at a frame boundary otherwise
// shows the previous frame about a third of the time. Every page that draws a film by seeking video runs it first,
// so the same t shows the same source frame in `look`, `render` and Studio's export.
export const SEEK_INSIDE_FRAME = `(()=>{const d=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'currentTime');if(d.set.__film)return;const set=function(v){d.set.call(this,Number(v)+0.001)};set.__film=true;Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{configurable:true,enumerable:true,get(){return d.get.call(this)},set})})();`;
// The film's clock, for a page hosted to be drawn. Until the host draws the first frame the page runs on real time
// (loading may wait on timers and clocks); from then on, everything a page can read time from says the frame's t:
// `performance.now()` and requestAnimationFrame's timestamp are t in ms, `Date` is t after a fixed epoch, CSS and
// Web Animations the page left running stand at t (a CSS transition, whose progress is history, is finished), and
// `Math.random` restarts from a seed of t (and runs from a fixed seed while loading). So a page drawn with CSS
// keyframes, a requestAnimationFrame loop or random particles still draws the same picture for the same t, whatever
// was drawn before. The host calls `filmHost.time(t)` before `film.frame(t)` and `filmHost.settle(t)` after it;
// `filmHost.now()` is the real clock, for the host's own waiting.
export const FILM_CLOCK = `(()=>{const H=window.filmHost;if(!H||H.time)return;const P=performance,now=P.now.bind(P),D=Date,raf=window.requestAnimationFrame.bind(window),EPOCH=D.UTC(2026,0,1);let v=null,seed=0x2545f491;H.now=now;P.now=()=>v==null?now():v;function FilmDate(...a){const d=a.length||v==null?new D(...a):new D(EPOCH+v);return new.target?d:d.toString()}FilmDate.prototype=D.prototype;FilmDate.now=()=>v==null?D.now():EPOCH+v;FilmDate.parse=D.parse;FilmDate.UTC=D.UTC;window.Date=FilmDate;window.requestAnimationFrame=(cb)=>raf((ts)=>cb(v==null?ts:v));Math.random=()=>{seed=seed+0x6d2b79f5|0;let x=Math.imul(seed^seed>>>15,1|seed);x=x+Math.imul(x^x>>>7,61|x)^x;return((x^x>>>14)>>>0)/4294967296};const mine=new WeakSet();H.time=(t)=>{v=t*1000;seed=(Math.round(t*1e6)^0x2545f491)|0};H.settle=(t)=>{for(const a of document.getAnimations?.()??[]){if(typeof CSSTransition!=='undefined'&&a instanceof CSSTransition){a.finish();continue}if(!mine.has(a)){if(a.playState==='paused'||a.playState==='idle')continue;mine.add(a)}a.pause();a.currentTime=t*1000}}})();`;
// Before any page script: the host flag, the seek fix and the clock above.
export const HOST_FLAG = `window.filmHost={version:'0.1',name:'film'};${SEEK_INSIDE_FRAME}${FILM_CLOCK}`;

const TIMELINE = readFileSync(fileURLToPath(new URL('./timeline.mjs', import.meta.url)), 'utf8');
/* what film.html says, as Studio reads it too: the timeline imports it from here */
const FILM_DOC = readFileSync(fileURLToPath(new URL('./film-doc.mjs', import.meta.url)), 'utf8');
/* a page clip's overrides, applied: the timeline imports it from here, and so do Studio's thumbnails of a page clip */
const OVERRIDES = readFileSync(fileURLToPath(new URL('./overrides.mjs', import.meta.url)), 'utf8');

/**
 * The start of a film, before the timeline takes its clips over: nothing shows, a page clip has the stage's size to
 * lay itself out for while it loads (the timeline then places every clip on the element itself), and a video or sound
 * clip loads nothing as it is read (the timeline gives a video its file when the playhead comes near it): a film of a
 * hundred clips would otherwise open a hundred files at once, and its first frame wait behind them.
 */
const filmStart = (stage) => `<style>html,body{margin:0;overflow:hidden}:where(body){background:#000}`
  + `body>section{display:contents}body>section>:is(iframe,video,img,audio){position:absolute;left:0;top:0;margin:0;visibility:hidden}`
  + `body>section>iframe{border:0;width:${stage.w}px;height:${stage.h}px}:where(body>section>:is(video,img)){object-fit:contain}</style>`
  + `<script>${HOLD_MEDIA}</script>`
  + `<script type="module" src="__film/timeline.mjs"></script>`;
/* a clip's <video> or <audio> as the parser makes it: no loading (a media element starts loading in a task after its
   src is set; this runs before, at the end of the parser's task) */
const HOLD_MEDIA = `(()=>{const o=new MutationObserver((list)=>{for(const m of list)for(const n of m.addedNodes)if((n.localName==='video'||n.localName==='audio')&&n.parentNode?.localName==='section')n.preload='none'});o.observe(document,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',()=>o.disconnect(),{once:true})})();`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
  '.glsl': 'text/plain', '.txt': 'text/plain',
};

/**
 * A handler that serves the files of `root` for one request, at `path` (the part of the URL inside the folder): HTML
 * with `inject` put before any page script (unless `?film-host=0`, the page as a visitor sees it), media with ranges.
 * `headers` go on every response (a host adds its own policy); the film (film.html) is played by the built-in
 * timeline, and gets `timelineInject` instead of `inject` (a host that drives it, like Studio, adds its bridge there). Returns false when the path is not inside
 * `root`, or leads out of it through a link.
 * `swap(file)` may name another file to serve in a file's place (a render's fast-seeking copy of a video, seekable.mjs;
 * the preview's proxy of heavy footage, studio/server/proxies.mjs); not for `?film-facts`, which asks what the file is.
 * @param {string} root @param {{ inject?: string, timelineInject?: string, headers?: Record<string, string>, swap?: (file: string) => string | null }} [options]
 */
export function folderFiles(root, { inject = `<script>${HOST_FLAG}</script>`, timelineInject = inject, headers: extraHeaders = {}, swap } = {}) {
  root = resolve(root);
  return (req, res, path, query) => {
    /* beside any film, wherever in the folder it is (its page asks for them relative to itself) */
    if (path.endsWith('/__film/timeline.mjs')) {
      // the built-in timeline: plays a film.html (see timeline.mjs)
      res.writeHead(200, { ...extraHeaders, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(TIMELINE);
      return true;
    }
    if (path.endsWith('/__film/film-doc.mjs')) {
      res.writeHead(200, { ...extraHeaders, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(FILM_DOC);
      return true;
    }
    if (path.endsWith('/__film/overrides.mjs')) {
      res.writeHead(200, { ...extraHeaders, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(OVERRIDES);
      return true;
    }
    if (path.endsWith('/__film/frame-duration')) {
      /* how long a video's frames last, for the timeline's exact frames (`?of=` the video's address) */
      const file = fileInRoot(root, query?.get('of') ?? '');
      const answer = (seconds) => res.writeHead(200, { ...extraHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ seconds }));
      if (!file) answer(null);
      else void frameDuration(file).then(answer);
      return true;
    }
    if (path.endsWith('/__film/media-facts')) {
      /* what a video or sound is when the browser cannot read it (ProRes, a codec it has no decoder for): its length
         and picture size as ffprobe reads them (`?of=` the file, from the film's folder) */
      const file = fileInRoot(root, `${path.slice(0, -'/__film/media-facts'.length)}/${query?.get('of') ?? ''}`);
      const answer = (facts) => res.writeHead(200, { ...extraHeaders, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(facts));
      if (!file) answer(null);
      else void mediaFacts(file).then(answer);
      return true;
    }
    let rel;
    try { rel = decodeURIComponent(path); } catch { res.writeHead(400, extraHeaders).end('bad address'); return true; }
    /* an address speaks in `/`: a `\` in it (escaped as %5C) would be a separator on Windows, past every check */
    if (rel.includes('\\') || rel.includes('\0')) { res.writeHead(400, extraHeaders).end('bad address'); return true; }
    if (rel.endsWith('/')) rel += 'index.html';
    const asked = normalize(join(root, rel));
    if (asked !== root && !asked.startsWith(root + sep)) return false;
    try { statSync(asked); } catch { res.writeHead(404, extraHeaders).end('not found'); return true; }
    // a link out of the folder is not followed: a film from elsewhere can bring one to any of the person's files. Only
    // media the person linked is (src/media-links.mjs)
    let inRoot = false;
    try { inRoot = within(realpathSync(root), realpathSync(asked)) || readableLink(root, asked); } catch { /* gone meanwhile */ }
    if (!inRoot) return false;
    /* what a file is (its length and size: `film-facts`) is the file's own, never its copy's */
    const file = (query?.has('film-facts') ? null : swap?.(asked)) ?? asked;
    let stat;
    try { stat = statSync(file); } catch { res.writeHead(404, extraHeaders).end('not found'); return true; }
    if (stat.isDirectory()) { res.writeHead(302, { ...extraHeaders, location: `${path}/` }).end(); return true; }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = { ...extraHeaders, 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    /* a HEAD has no body (the browser cancels one that brings it) */
    if (req.method === 'HEAD') { res.writeHead(200, headers).end(); return true; }
    if (type.startsWith('text/html') && query?.get('film-host') !== '0') {
      const html = readFileSync(file, 'utf8');
      /* the film itself: played by the timeline, and the host's driving of it (`timelineInject`) put in */
      const film = rel === `/${FILM_FILE}` || rel.endsWith(`/${FILM_FILE}`);
      const start = film ? timelineInject + filmStart(readFilmFile(html).doc?.stage ?? DEFAULT_STAGE) : inject;
      res.writeHead(200, headers).end(injectFirst(film ? holdPages(html) : html, start));
      return true;
    }
    /* A cancelled preview is normal: pipeline closes its file; its callback deliberately ignores the error. */
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      /* `bytes=-500` is the last 500 bytes. An open end (`bytes=X-`) is at most the next 2 MiB: one response must
         not hold a connection for the rest of a long file. A browser keeps six HTTP/1.1 connections to a host, and
         a frame's duration lookup waits behind them until one is free. A paused video stops reading once it has
         buffered enough and leaves the rest of its piece unread: pieces of 8 MiB still held all six with more than
         six videos awake; pieces of 2 MiB are read to their end. */
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && !range[2] ? Math.min(start + 2 * 1024 * 1024 - 1, stat.size - 1)
        : range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) { res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }).end(); return true; }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      pipeline(createReadStream(file, { start, end }), res, () => {});
      return true;
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    pipeline(createReadStream(file), res, () => {});
    return true;
  };
}

const within = (folder, path) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

/** The file an address names inside `root` (not through a link out of it, but for media the person linked), or null. */
function fileInRoot(root, address) {
  let rel;
  try { rel = decodeURIComponent(address); } catch { return null; }
  if (!rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return null;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) return null;
  try { return (within(realpathSync(root), realpathSync(file)) || readableLink(root, file)) && statSync(file).isFile() ? file : null; } catch { return null; }
}

/** @type {Map<string, Promise<number | null>>} */
const frameDurations = new Map();
/**
 * How long a video's frames last on average (ffprobe's frame rate), once per version of the file; null when ffprobe
 * cannot tell (no ffprobe, no video stream).
 * @param {string} file
 */
export function frameDuration(file) {
  let key;
  try { const stat = statSync(file); key = `${file}\0${stat.size}\0${stat.mtimeMs}`; } catch { return Promise.resolve(null); }
  if (!frameDurations.has(key)) {
    frameDurations.set(key, new Promise((done) => {
      execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate,r_frame_rate', '-of', 'json', file],
        { timeout: 20_000, windowsHide: true }, (error, stdout) => {
          if (error) { frameDurations.delete(key); done(null); return; }
          let stream;
          try { stream = JSON.parse(String(stdout)).streams?.[0]; } catch { /* nothing to read */ }
          const rate = [stream?.avg_frame_rate, stream?.r_frame_rate].map((r) => String(r ?? '').split('/').map(Number))
            .map(([n, d]) => (n > 0 && d > 0 ? n / d : 0)).find((r) => r > 0 && r <= 1000);
          done(rate ? 1 / rate : null);
        });
    }));
  }
  return /** @type {Promise<number | null>} */ (frameDurations.get(key));
}

/** @type {Map<string, Promise<{ duration: number, w: number, h: number } | null>>} */
const mediaFactsOf = new Map();
/**
 * A video's or sound's length (s) and picture size (0 for a sound), as ffprobe reads them, once per version of the file;
 * null when it cannot tell.
 * @param {string} file
 */
export function mediaFacts(file) {
  let key;
  try { const stat = statSync(file); key = `${file}\0${stat.size}\0${stat.mtimeMs}`; } catch { return Promise.resolve(null); }
  if (!mediaFactsOf.has(key)) {
    mediaFactsOf.set(key, new Promise((done) => {
      execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file],
        { timeout: 20_000, windowsHide: true }, (error, stdout) => {
          if (error) { mediaFactsOf.delete(key); done(null); return; }
          let said;
          try { said = JSON.parse(String(stdout)); } catch { /* nothing to read */ }
          const duration = Number(said?.format?.duration);
          const video = said?.streams?.find((s) => s.codec_type === 'video');
          done(duration > 0 ? { duration, w: video?.width ?? 0, h: video?.height ?? 0 } : null);
        });
    }));
  }
  return /** @type {Promise<{ duration: number, w: number, h: number } | null>} */ (mediaFactsOf.get(key));
}

/**
 * Serve `root`. HTML gets the host flag injected before any page script;
 * ?film-host=0 serves the page untouched, as a visitor would see it.
 */
export function serve(root, { port = 0, swap } = {}) {
  const files = folderFiles(root, { swap });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!files(req, res, url.pathname, url.searchParams)) res.writeHead(403).end();
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  })));
}

/** Put `tag` before any script of the page: after <head> if there is one before the first script, else after the doctype. */
/**
 * The film's page clips served without loading: each <iframe>'s `src` is `data-film-src`. The timeline opens pages
 * itself, a few at a time and only those near the playhead in a film of many (it reads the clips from the file as
 * written); a page the parser had started loading would be cut short, a failed request to every host.
 * @param {string} html
 */
export function holdPages(html) {
  return html.replace(/<iframe\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => tag.replace(
    /(\s)([^\s=>"'/]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?/g,
    (attr, space, name, value = '') => (name.toLowerCase() === 'src' ? `${space}data-film-src${value}` : attr),
  ));
}

export function injectFirst(html, tag) {
  const firstScript = html.search(/<script\b/i);
  const prefix = firstScript < 0 ? html : html.slice(0, firstScript);
  const head = /<head\b[^>]*>/i.exec(prefix);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
}

/**
 * A browser for pages: Playwright's headless shell by default. It draws the same pixels as the full Chromium (WebGL
 * included), is the smaller download, starts inside agents'
 * OS sandboxes where the full Chromium cannot, and is the build Studio's engine uses — one browser on the machine.
 * A visible window needs the full Chromium (`headed`). A host may pick another build, add arguments and its own
 * environment.
 */
export async function launch({ headed = false, channel = headed ? 'chromium' : null, args: extra = [], env } = {}) {
  /* CanvasDrawElement: HTML-in-Canvas (drawElementImage, texElementImage2D), so a page can draw its own DOM into 2D or WebGL */
  const args = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--enable-blink-features=CanvasDrawElement', ...extra];
  const open = async (/** @type {string[]} */ angle) => {
    try {
      return await chromium.launch({ ...(channel ? { channel } : {}), headless: !headed, args: [...args, ...angle], ...(env ? { env } : {}) });
    } catch (e) {
      /* The host may have a Chrome but no Playwright build (a desktop app, a dev machine): use it rather than lose
         thumbnails and exports. A deployment that needs the pinned pixels installs Playwright's browser. */
      if (channel || !/Executable doesn't exist|browserType\.launch/i.test(String(e?.message ?? e))) throw e;
      return chromium.launch({ channel: process.env.OPENFILM_CHROME_CHANNEL || 'chrome', headless: !headed, args: [...args, ...angle], ...(env ? { env } : {}) });
    }
  };
  const browser = extra.some((a) => a.startsWith('--use-angle')) ? await open([])
    : process.platform === 'darwin' ? await open(['--use-angle=metal'])
    : process.platform === 'win32' ? await onWindows(open)
    : await open([]);
  LIVE.add(browser);
  browser.on('disconnected', () => LIVE.delete(browser));
  return browser;
}

/** A renderer string that is not a GPU: WebGL drawn on the CPU. Windows' WARP is one: "Microsoft Basic Render Driver". */
export const SOFTWARE_GL = /swiftshader|llvmpipe|software|basic render/i;

/** The page's WebGL renderer as the driver names it; 'none' without WebGL. */
const readRenderer = () => {
  const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
  if (!gl) return 'none';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

/** @param {import('playwright-core').Browser} browser */
async function rendererOf(browser) {
  const page = await browser.newPage();
  try { return await page.evaluate(readRenderer); } finally { await page.close(); }
}

/* two seconds of video, red then blue, 640 × 360 at 4 fps, large enough to be decoded on the chip: H.264, and HEVC
   Main 10 (what phones and cameras such as DJI's record) */
const PRESENT_CHECKS = [
  { type: 'video/mp4; codecs="avc1.4D401E"', src: 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANkbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAArN0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAoAAAAFoAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAgAAABAAAAAAIrbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAkABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB1m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAZZzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAoABaABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBTUAW/+EAGGdNQBbsoFAX/LgIgAAAAwCAAAAEB4sWywEABWjr48sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAD8QAAAUMAAAAGHN0dHMAAAAAAAAAAQAAAAgAABAAAAAAGHN0c3MAAAAAAAAAAgAAAAEAAAAFAAAAQGN0dHMAAAAAAAAABgAAAAEAACAAAAAAAQAAQAAAAAACAAAQAAAAAAEAACAAAAAAAQAAQAAAAAACAAAQAAAAABxzdHNjAAAAAAAAAAEAAAABAAAACAAAAAEAAAA0c3RzegAAAAAAAAAAAAAACAAAAGYAAAAWAAAAEwAAABMAAABlAAAAFgAAABMAAAATAAAAFHN0Y28AAAAAAAAAAQAAA5QAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAFLbWRhdAAAAGJliIQAEv/+6Mn8yysv49Q3s0Yps0mnHMI9HTDq9Ryj5DaMReURDAAAAwAAAwAAAwDAA6AsaXWRAN14AAAGSADXhLQmodQXAagd4oI6hTCAEAAAAwAAAwAAAwAAAwAAAwAW8QAAABJBmiNsQQ/+qlUAAAMAAAMAOqAAAAAPQZ5BeIIfAAADAAADACThAAAADwGeYmpBDwAAAwAAAwAk4AAAAGFliIIABX/+7M9+BTcgPIv1lAh0tW5145jTpoZ4rq/03qFxGMOPJbgAAAMAAAMAAAXj8myN92IA8GNgAAAakALcEDCABQhFRBxGhnCVELHSMkAAAAMAAAMAAAMAAAMAAEBBAAAAEkGaI2xBD/6qVQAAAwAAAwA6oQAAAA9BnkF4gj8AAAMAAAMAE3EAAAAPAZ5iakEPAAADAAADACTh' },
  { type: 'video/mp4; codecs="hvc1.2.4.L90.90"', src: 'data:video/mp4;base64,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' },
];

/**
 * Whether this browser shows a paused video's frame once sought, for each kind of video it plays. On some Windows
 * computers with Vulkan the frame sought is never the one shown (every seek waits out its tries in showVideoAt,
 * timeline.mjs: five seconds a frame), or nothing is shown at all (a black video), for some only with HEVC. A video
 * this browser does not play or load says nothing either way: such footage gets a copy it plays (seekable.mjs).
 * @param {import('playwright-core').Browser} browser
 */
export async function presentsVideo(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async (checks) => {
      for (const { type, src } of checks) {
        const v = document.createElement('video');
        if (!v.canPlayType(type) || typeof v.requestVideoFrameCallback !== 'function') continue;
        v.muted = true;
        v.style.cssText = 'width:320px;height:180px';
        document.body.append(v);
        const loaded = await new Promise((done) => {
          v.addEventListener('loadeddata', () => done(true), { once: true });
          v.addEventListener('error', () => done(false), { once: true });
          setTimeout(() => done(false), 5000);
          v.src = src;
        });
        /* the frame shown must be the one sought (each is a quarter second); a seek just after the file loaded may
           never present it (see showVideoAt), so it is tried again, elsewhere */
        let shown = !loaded;
        for (const t of loaded ? [1.5, 0.5, 1.25] : []) {
          shown = await new Promise((done) => {
            const next = () => v.requestVideoFrameCallback((now, meta) => (Math.abs(meta.mediaTime - t) < 0.125 ? done(true) : next()));
            next();
            setTimeout(() => done(false), 1500);
            v.currentTime = t;
          });
          if (shown) break;
        }
        v.remove();
        if (!shown) return false;
      }
      return true;
    }, PRESENT_CHECKS);
  } finally {
    await page.close();
  }
}

/** The device id in an ANGLE renderer string (`(0x00002489)`), the same GPU's through Vulkan and D3D11. */
const deviceOf = (/** @type {string} */ renderer) => {
  const id = /\(0x([0-9a-f]+)\)/i.exec(renderer);
  return id ? parseInt(id[1], 16) : null;
};

/**
 * Windows: headless Chromium picks no ANGLE backend by itself and draws WebGL with SwiftShader, on the CPU. Vulkan
 * reaches the GPU (on a laptop with two, the discrete one: d3d11 and gl take the integrated one). A virtual machine, a
 * CI runner or a computer without a Vulkan driver has none, so the first browser reads its renderer once: when Vulkan
 * did not start, or is software too, it and every later browser take Chromium's default.
 *
 * Vulkan on a GPU may still never show a video's frames (presentsVideo). Then Direct3D is taken when it reaches the
 * same GPU (a computer with one), else Vulkan with videos decoded on the CPU, else Direct3D on the other GPU; each only
 * when it shows them. When none does, the default.
 * @param {(browser: import('playwright-core').Browser) => Promise<string>} [renderer]
 * @param {(browser: import('playwright-core').Browser) => Promise<boolean>} [presents]
 */
export function vulkanFirst(renderer = rendererOf, presents = presentsVideo) {
  /** @type {Promise<string[]> | null} what every browser after the first is opened with */
  let chosen = null;
  /* false once a film's videos were never seen in Vulkan's browsers (videoNotShown): its check is not trusted again */
  let vulkanVideo = true;
  /** @param {(angle: string[]) => Promise<import('playwright-core').Browser>} open */
  const pick = async (open) => {
    if (chosen) return open(await chosen);
    /** @type {(angle: string[]) => void} */
    let choose = () => {};
    chosen = new Promise((r) => { choose = r; });
    const read = (/** @type {import('playwright-core').Browser} */ b) => inTime(renderer(b), 30_000, 'no renderer').catch(() => 'none');
    const shows = (/** @type {import('playwright-core').Browser} */ b) => inTime(presents(b), 30_000, '').catch(() => true);
    const vulkan = ['--use-angle=vulkan'];
    const browser = await open(vulkan).catch(() => null);
    const gpu = browser ? await read(browser) : 'none';
    if (!browser || gpu === 'none' || SOFTWARE_GL.test(gpu)) {
      await browser?.close().catch(() => {});
      choose([]);
      return open([]);
    }
    if (vulkanVideo && await shows(browser)) {
      choose(vulkan);
      return browser;
    }
    await browser.close().catch(() => {});
    /* Direct3D, asked for by name (the default is SwiftShader, on the CPU): first on the same GPU, a computer with one */
    const d3d11 = ['--use-angle=d3d11'];
    const direct = await open(d3d11).catch(() => null);
    const directGpu = direct ? await read(direct) : 'none';
    /** @type {boolean | null} */
    let directShows = null;
    const directShown = async () => (directShows ??= Boolean(direct) && await shows(/** @type {import('playwright-core').Browser} */ (direct)));
    if (deviceOf(gpu) != null && deviceOf(directGpu) === deviceOf(gpu) && await directShown()) {
      choose(d3d11);
      return /** @type {import('playwright-core').Browser} */ (direct);
    }
    /* then Vulkan with videos decoded on the CPU: pages stay on its GPU, the discrete one on a laptop with two (#64) */
    const decoded = [...vulkan, '--disable-accelerated-video-decode'];
    const cpu = await open(decoded).catch(() => null);
    if (cpu && await shows(cpu)) {
      await direct?.close().catch(() => {});
      choose(decoded);
      return cpu;
    }
    await cpu?.close().catch(() => {});
    /* then Direct3D on the other GPU, still not the CPU */
    if (direct && directGpu !== 'none' && !SOFTWARE_GL.test(directGpu) && await directShown()) {
      choose(d3d11);
      return direct;
    }
    await direct?.close().catch(() => {});
    choose([]);
    return open([]);
  };
  /**
   * A film's video frames were never seen in browsers opened with Vulkan, though its check passed (footage it does
   * not tell, as the check's clips do): the browsers opened from now on take the next way. Whether there was one.
   */
  pick.videoNotShown = async () => {
    const was = chosen && await chosen;
    if (!was || was.join() !== '--use-angle=vulkan') return false;
    vulkanVideo = false;
    chosen = null;
    return true;
  };
  return pick;
}
const onWindows = vulkanFirst();

/** A film's video frames were never seen (FilmPage.seek): on Windows, browsers opened from now on show video another way. */
export const videoNotShown = () => (process.platform === 'win32' ? onWindows.videoNotShown() : Promise.resolve(false));

/** Every browser launch() opened and that is still open. */
const LIVE = new Set();
/** Close them all: what waits on one (a render, a poster) fails at once instead of never answering. */
export async function closeBrowsers() {
  await Promise.allSettled([...LIVE].map((b) => b.close()));
}

/**
 * How long a film may take to be ready (its pages and media loaded) before that counts as failing. A film that says
 * how far it is (the built-in timeline counts its clips loaded, `__filmProgress`) may take as long as it needs, as
 * long as it gets further within this time.
 */
const READY_MS = 60_000;

/** How many times a page is loaded when the system has no network buffer for it (FilmPage.open). */
const OPEN_TRIES = 3;

/** How long a frame's picture may take once it is drawn. */
const CAPTURE_MS = 30_000;

/** A frame that threw inside the page: the film's fault, reported as such rather than as a crash of the tool. */
export class FrameError extends Error {}
/** A film whose video frames this browser never showed, drawn again in browsers that show video another way. */
export class VideoNotShown extends FrameError {}
/** How many exact frames of video may go unseen, none seen yet, before the browser counts as showing no video. */
const UNSEEN_VIDEO = 3;

/**
 * `work`, or a FrameError saying `why` once `ms` pass. The limit is kept here, not in the page: a page whose code
 * never yields (a loop that never ends) never runs its own timers either.
 * @template T @param {Promise<T>} work @param {number} ms @param {string} why @returns {Promise<T>}
 */
function inTime(work, ms, why) {
  let timer;
  const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new FrameError(why)), ms); });
  /* given up on, it may still fail later: heard, so it cannot end the process */
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * `work` in `page`, or a FrameError saying `why` once `ms` pass without it getting further: a page that says how far
 * it is (`window.__filmProgress()`, a number that grows) has `ms` again each time it grows; one that does not has `ms`.
 * @template T @param {import('playwright-core').Page} page @param {Promise<T>} work @param {number} ms @param {string} why
 * @returns {Promise<T>}
 */
async function whileMoving(page, work, ms, why) {
  work.catch(() => {});
  let since = Date.now();
  let last = null;
  for (;;) {
    let timer;
    const tick = new Promise((done) => { timer = setTimeout(done, Math.min(1000, ms)); });
    const finished = await Promise.race([work.then(() => true, () => true), tick.then(() => false)]);
    clearTimeout(timer);
    if (finished) return work;
    /* a page whose code never yields does not answer either: that is no progress */
    const now = await inTime(page.evaluate(() => /** @type {any} */ (window).__filmProgress?.() ?? null), 1000, '').catch(() => null);
    if (now != null && now !== last) { last = now; since = Date.now(); }
    if (Date.now() - since >= ms) throw new FrameError(last == null ? why : `film.ready stopped: nothing more loaded in ${ms / 1000} s`);
  }
}

/** Why a page that ran out of time did: said when it no longer answers at all (its code still running). */
const stuck = async (/** @type {import('playwright-core').Page} */ page) =>
  (await inTime(page.evaluate(() => 0), 1000, '').then(() => false, () => true)) ? ' (the page is still running code: a loop that never ends?)' : '';

/** One web page in one browser tab. */
export class FilmPage {
  static async open(browser, origin, entry, { scale = 1, size = null, transparent = false, black = false, offline = false, network = {}, waitMs = 10_000, readyMs = READY_MS, onVideoNotShown = videoNotShown } = {}) {
    // Hosted films are untrusted: use the existing folder-only network policy
    // for thumbnails and exports too, not just the browser-facing preview.
    const hosted = process.env.OPENFILM_HOSTED_RENDER === '1';
    if (hosted) {
      offline = true;
      network = {};
    }
    const film = new FilmPage();
    film.problems = [];
    film.onVideoNotShown = onVideoNotShown;
    film.browser = browser;
    film.origin = origin;
    film.entry = entry;
    film.scale = scale;
    /* `size`: a page clip's (SPEC §1), what a page without a size of its own is laid out at, from its first layout */
    const laid = size?.w > 0 && size?.h > 0 ? { width: Math.round(size.w), height: Math.round(size.h) } : { width: 1920, height: 1080 };
    film.context = await browser.newContext({ viewport: laid, deviceScaleFactor: scale, ...(hosted ? { serviceWorkers: 'block' } : {}) });
    if (hosted) await film.context.routeWebSocket(/.*/, (socket) => socket.close());
    film.page = await film.context.newPage();
    const problems = film.problems;
    film.page.on('pageerror', (e) => problems.push({ kind: 'error', message: e.message }));
    film.page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) problems.push({ kind: 'console', message: m.text() }); }); // 404s are reported by URL below
    film.page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? 'failed';
      if (why === 'net::ERR_ABORTED' && r.resourceType() === 'media') return; // media elements cancel range requests routinely
      if (why === 'net::ERR_ABORTED' && r.method() === 'HEAD') return; // a file's presence asked (timeline.mjs): its status is the answer
      if (why === 'net::ERR_ABORTED' && new URL(r.url()).pathname.endsWith('/__film/frame-duration')) return; // given up on after 10 s (timeline.mjs frameOf): the frame is drawn from the guess
      if (why === 'net::ERR_BLOCKED_BY_CLIENT') return; // reported by the offline route with its reason
      problems.push({ kind: 'request', message: `${why} ${r.url()}` });
    });
    film.page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) problems.push({ kind: 'request', message: `${r.status()} ${r.url()}` }); });
    if (offline) {
      // A host that plays pages in an isolated surface with only some origins open (`network.allow`): probe them the
      // same way, so a page that reaches elsewhere fails here, with a reason, instead of later as a blank clip.
      // `network.fetch` may answer the open origins itself (a cache), so checking a page twice does not fetch twice.
      const allow = new Set(network.allow ?? []);
      await film.context.route((url) => !url.href.startsWith(origin + '/') && !/^(data|blob):/.test(url.protocol), async (route) => {
        const url = route.request().url();
        let at = '';
        try { at = new URL(url).origin; } catch { /* not a URL */ }
        if (!allow.has(at)) {
          problems.push({ kind: 'request', message: `web pages load only from their own folder${allow.size ? ` and ${[...allow].map((o) => o.replace('https://', '')).join(', ')}` : ''}: ${url}` });
          return route.abort('blockedbyclient');
        }
        if (!network.fetch) return route.continue();
        try {
          const answer = await network.fetch(url, route.request().headers());
          return route.fulfill({ status: answer.status, headers: answer.headers, body: answer.body });
        } catch (e) {
          problems.push({ kind: 'request', message: `could not load ${url}: ${e?.message ?? e}` });
          return route.abort('blockedbyclient');
        }
      });
    }
    /* a page that never loads is closed: its tab would go on running. Windows sometimes has no socket buffer free for
       a moment (net::ERR_NO_BUFFER_SPACE, seen with many browsers or servers at once): that page is loaded again */
    for (let tries = 1; ; tries++) {
      const missed = await film.page.goto(new URL(entry, origin + '/').href, { waitUntil: 'load', timeout: 60_000 }).then(() => null, (e) => e);
      if (!missed) break;
      if (tries === OPEN_TRIES || !/net::ERR_NO_BUFFER_SPACE/.test(String(missed?.message))) {
        await film.context.close();
        throw missed;
      }
      await new Promise((r) => setTimeout(r, 500 * tries));
    }
    /* what else the page said, once (not what `said` already says), and failed files by their path in the folder */
    const failed = (said = '') => {
      const req = [...new Set(problems.filter((p) => p.kind === 'request').map((p) => p.message.replace(`${origin}/`, '')))]
        .filter((m) => !said.includes(m.slice(m.indexOf(' ') + 1)));
      /* by its first line: what is said is cut there */
      const err = problems.filter((p) => p.kind === 'error').map((p) => p.message.replace(/^Error: /, '')).filter((m) => !said.includes(m.split('\n')[0]));
      return `${err.length ? `; the page threw: ${err.join(' | ')}` : ''}${req.length ? `; failed to load: ${req.join(', ')}` : ''}`;
    };
    try {
      await film.page.waitForFunction(() => window.film && typeof window.film.frame === 'function', null, { timeout: waitMs, polling: 50 });
    } catch {
      await film.context.close();
      throw new FrameError(`window.film with a frame() function did not appear within ${waitMs / 1000} s${failed()}`);
    }
    /* a ready that never comes (a file that never loads, a loop that never ends) is said, rather than waited on for ever */
    film.meta = await whileMoving(film.page, film.page.evaluate(async (laid) => {
      const a = window.film;
      await (typeof a.ready === 'function' ? a.ready() : a.ready);
      await document.fonts?.ready;
      /* a page without a size of its own, opened on its own, is 1920 × 1080, or its clip's `size` (inside a film it
         is the stage's); one without a duration has no end (null) */
      const sized = a.width != null || a.height != null;
      return { duration: a.duration ?? null, width: sized ? a.width : laid.width, height: sized ? a.height : laid.height, sized,
        /* an edit's sound, from the built-in timeline (a single page has none) */
        sounds: window.__filmSounds?.() ?? [] };
    }, laid), readyMs, `film.ready did not finish within ${readyMs / 1000} s`).catch(async (e) => {
      const late = e instanceof FrameError ? await stuck(film.page) : '';
      await film.context.close();
      if (e instanceof FrameError) throw new FrameError(`${entry.startsWith('__film/') ? '' : `${entry}: `}${e.message}${late}${failed(e.message)}`);
      const why = String(e.message).replace(/^page\.evaluate: /, '').split('\n')[0].replace(/^Error: /, '');
      /* the built-in timeline says what failed in its own words; a page's own ready is named as such */
      throw new FrameError(`${entry.startsWith('__film/') ? why : `film.ready failed: ${why}`}${failed(why)}`);
    });
    if (film.meta.width > 0 && film.meta.height > 0) await film.page.setViewportSize({ width: film.meta.width, height: film.meta.height });
    film.cdp = await film.context.newCDPSession(film.page);
    // What a page does not paint is white by the browser's default: transparent for alpha exports, black where the
    // picture stands for the film (a moment with nothing below is black).
    if (transparent || black) await film.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: transparent ? 0 : 1 } });
    return film;
  }

  /** Draw t and wait until the picture is complete; a frame that never finishes fails after `timeoutMs`. */
  async seek(t, { timeoutMs = 60_000 } = {}) {
    const drawn = this.page.evaluate(async (t) => {
      if (!window.film || typeof window.film.frame !== 'function') throw new Error('window.film.frame is gone (the page reloaded or replaced it)');
      window.filmHost?.time?.(t);
      await window.film.frame(t);
      window.filmHost?.settle?.(t);
      // media the page moved but did not wait for: until the new frame is decoded, then until it is on screen
      // (`seeked` comes before the compositor shows the frame; captured then, it is still the previous one). One not
      // in the picture (hidden, or holding no file: a film's video away from t) is not waited for.
      await Promise.all([...document.querySelectorAll('video')].map((v) => (v.seeking || v.readyState < 2)
        && v.networkState !== v.NETWORK_EMPTY && v.checkVisibility?.({ visibilityProperty: true }) !== false
        ? new Promise((r) => {
          const shown = () => (typeof v.requestVideoFrameCallback === 'function' ? (v.requestVideoFrameCallback(() => r()), setTimeout(r, 1000)) : r());
          v.addEventListener('seeked', shown, { once: true }); v.addEventListener('loadeddata', shown, { once: true }); setTimeout(r, 3000);
        })
        : null));
      // two frames: the first commits style and layout, the second lets layers (filters, 3D) finish rasterizing
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      return window.__filmVideos?.() ?? null;
    }, t).catch((e) => {
      const why = String(e.message).replace(/^page\.evaluate: /, '').split('\n')[0].replace(/^Error: /, '');
      /* files that failed, by their path in the folder, once, and not the ones the reason names already */
      const origin = new URL(this.page.url()).origin;
      const failed = [...new Set(this.problems.filter((p) => p.kind === 'request').map((p) => p.message.replace(`${origin}/`, '')))]
        .filter((m) => !/^net::ERR_ABORTED /.test(m) && !why.includes(m.slice(m.indexOf(' ') + 1)));
      /* the built-in timeline names the clip and its time itself */
      const said = /^clip "/.test(why) ? why : `frame(${Number(t.toFixed(3))}) threw: ${why}`;
      throw new FrameError(`${said}${failed.length ? ` (failed to load: ${failed.join(', ')})` : ''}`);
    });
    const why = `frame(${Number(t.toFixed(3))}) did not finish within ${timeoutMs / 1000} s`;
    const videos = await inTime(drawn, timeoutMs, why).catch(async (e) => { throw e.message === why ? new FrameError(`${why}${await stuck(this.page)}`) : e; });
    /* every seek waited out (five seconds a frame) and the picture black: when browsers can show video another way,
       the film is drawn again in those */
    if (videos && videos.shown === 0 && videos.unshown >= UNSEEN_VIDEO && await this.onVideoNotShown()) {
      throw new VideoNotShown(`this browser never showed the film's video frames (${videos.unshown} sought): video is shown another way from now on`);
    }
  }

  /** PNG (or JPEG) of the viewport as composited. */
  async capture({ format = 'png', quality } = {}) {
    // Without a clip, headless Chromium returns CSS pixels; a clip at the device pixel ratio returns real pixels.
    const clip = { x: 0, y: 0, width: this.meta.width, height: this.meta.height, scale: this.scale };
    // Fast compression, for a PNG too: the same pixels in a larger file, two to four times sooner (a 4K frame of
    // footage: 240 ms instead of a second).
    const { data } = await inTime(this.cdp.send('Page.captureScreenshot', { format, quality, clip, fromSurface: true, optimizeForSpeed: true }),
      CAPTURE_MS, `the picture did not come within ${CAPTURE_MS / 1000} s`);
    return Buffer.from(data, 'base64');
  }

  async gpu() {
    return this.page.evaluate(readRenderer);
  }

  async close() { await this.context.close(); }
}
