// @ts-check
/**
 * The film's origin: the projects' files, read only, on a port of their own. The preview's pages, pictures and sounds
 * load from here, so a web page (code an agent wrote) runs on another origin than the editor: it cannot read the
 * editor, its cookie or its API. Every project shares this one origin, each under a token of its own (`/p/<token>/…`).
 * The token is the project's id signed with Studio's key: a page cannot work out another project's address, and it is
 * the same after Studio restarts (with the machine's key, see studioKey), so a page left open keeps drawing its film
 * from the address it has. That is all that keeps projects apart: they are not isolated from each other. Pages of
 * every project share the origin's storage (localStorage, IndexedDB, caches), and a page can reach another project's
 * pages open at the same time (and learn its address from them).
 *
 * Only the film's own files are served: no dot file or folder (`.film/`, `.git/`, `.env`), no name with a `:` (a
 * Windows stream), nothing a link leads to out of the folder. Only requests addressed to 127.0.0.1, localhost or
 * [::1] at this port are answered (ownHost).
 *
 * Pages get the host flag (the film's clock, see src/host.mjs) before any of their scripts, as `look` and `render`
 * give it, so a film draws here exactly as it renders. Everything may be read by the editor's origin (its sound mixer
 * fetches the media), which frames the pages. A media file asked for with `?film-sound` is its sound,
 * small (derived.mjs soundOf): what the mixer plays, never the whole of a video; 204 when it has none.
 */
import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { HOST_FLAG, folderFiles } from '../../src/host.mjs';
import { readableLink } from '../../src/media-links.mjs';
import { clipKind } from '../../src/film-doc.mjs';
import { readPrefs } from './prefs.mjs';
import { readyProxy } from './proxies.mjs';
import { madeCopy } from '../../src/seekable.mjs';
import { isPreviewKey, previewDir } from './preview-cache.mjs';
import { soundOf } from './derived.mjs';

const BRIDGE = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');

/* sounds a browser cannot play (AIFF, which macOS's `say` writes): the preview gets a WAV of each, made once */
const UNPLAYABLE = /\.(aif|aiff|aifc)$/i;
const PLAYABLE_DIR = join('.film', 'cache', 'playable');
/** @type {Map<string, Promise<string | null>>} copies being made, by where they go */
const making = new Map();

/**
 * The playable copy of the project file `rel` (a WAV in .film/cache/playable, named by the file's version), or null
 * when it is not a file inside `root` or ffmpeg cannot read it.
 * @param {string} root @param {string} rel
 */
async function playableCopy(root, rel) {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) return null;
  let info;
  try {
    info = statSync(file);
    if (!realpathSync(file).startsWith(realpathSync(root) + sep) && !readableLink(root, file)) return null;
  } catch { return null; }
  const name = `${createHash('sha1').update(`${rel}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 20)}.wav`;
  const out = join(root, PLAYABLE_DIR, name);
  try { statSync(out); return name; } catch { /* not made yet */ }
  let made = making.get(out);
  if (!made) {
    made = (async () => {
      await mkdir(join(root, PLAYABLE_DIR), { recursive: true });
      const part = `${out}.part.wav`;
      const ok = await new Promise((done) => execFile('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', file, '-vn', '-c:a', 'pcm_s16le', part], { windowsHide: true }, (e) => done(!e)));
      if (!ok) return null;
      await rename(part, out);
      return name;
    })().finally(() => making.delete(out));
    making.set(out, made);
  }
  return made;
}
const STAGE = readFileSync(new URL('./stage.js', import.meta.url), 'utf8');
/*
 * A page in the preview's film draws at the pixels the viewer shows it at: its devicePixelRatio is the one the editor
 * put in the film's address (`film-dpr`, editor/Preview.tsx), so a canvas sized by it (SPEC §3) is no larger than what is
 * seen. The film's own videos and pictures, and every page drawn for an export, are as the screen is.
 */
const PAGE_SCALE = `(()=>{try{if(parent===window)return;const k=Number(new URL(parent.location.href).searchParams.get('film-dpr'));if(k>0)Object.defineProperty(window,'devicePixelRatio',{configurable:true,get:()=>k})}catch{}})();`;

/**
 * Whether a request was addressed to this machine at `port` by name (its Host): another site whose name is made to
 * point at 127.0.0.1 (DNS rebinding) is the same origin as nothing here, but its requests say its own name, and are
 * refused. Studio's two origins both ask it.
 * @param {import('node:http').IncomingMessage} req @param {number} port
 */
export function ownHost(req, port) {
  const host = String(req.headers.host ?? '').toLowerCase();
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  /* a browser leaves the port out when it is the scheme's own */
  return names.some((name) => host === `${name}:${port}` || (port === 80 && host === name));
}

/**
 * Whether the decoded path `plain` of a project folder may be served: no part of it hidden (`.film`, `.git`, `.env`,
 * `..`) or with a `:` (on Windows `name::$DATA` is the file `name`, and `.film:` the folder), and the file it names,
 * when there is one, really in the folder (not through a link out of it, but for media the person linked:
 * src/media-links.mjs) and not hidden by its real name either (on Windows `ENV~1` is the short name of `.env`).
 * @param {string} root @param {string} plain
 */
function servable(root, plain) {
  const parts = plain.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part.startsWith('.') || part.includes(':'))) return false;
  let real;
  try { real = realpathSync.native(join(root, ...parts)); } catch { return true; /* not there: answered 404 */ }
  let home;
  try { home = realpathSync.native(root); } catch { return false; }
  const back = relative(home, real);
  if (isAbsolute(back) || back.split(sep)[0] === '..') return readableLink(root, join(root, ...parts));
  return !back || !back.split(sep).some((part) => part.startsWith('.'));
}

/**
 * `secret`: what tokens are signed with (Studio's key). `projects`: the projects there are, for a token not seen since
 * this launch (a page open from before Studio restarted).
 * @param {{ port: number, editorOrigin: () => string, secret: string, projects: () => Promise<{ id: string, path: string }[]> }} options
 */
export async function startPages({ port, editorOrigin, secret, projects }) {
  /* read by the editor (its mixer fetches the media). Framed by it with no frame-ancestors rule: that rule is checked
     against every frame up to the window, so Studio shown inside another app's frame (an agent's preview pane) would
     lose its picture; a page is reached only through its project's token, which only the editor has */
  const policy = () => ({
    'access-control-allow-origin': editorOrigin(),
    'x-content-type-options': 'nosniff',
  });
  /* Studio's scripts, told the editor's origin (the only one they answer) */
  const scripts = (/** @type {string[]} */ ...list) => list.map((js) => `<script>${js.replaceAll('__EDITOR__', JSON.stringify(editorOrigin()))}</script>`).join('');
  /* the timeline page (the preview) gets the bridge and the stage; a web page gets the bridge too, so the editor can
     play one on its own (the media pane's viewer) — inside the timeline it stays quiet: its parent is not the editor */
  const filesOf = (/** @type {string} */ root) => folderFiles(root, {
    inject: `<script>${HOST_FLAG}${PAGE_SCALE}</script>${scripts(BRIDGE)}`,
    timelineInject: `<script>${HOST_FLAG}</script>${scripts(BRIDGE, STAGE)}`,
    headers: policy(),
    /* heavy footage is played from its proxy once it is made, while proxies are on (proxies.mjs); else from a copy made
       for footage the browser does not decode, or that seeks slowly (src/seekable.mjs), when there is one */
    swap: (file) => {
      if (clipKind(file) !== 'video') return null;
      const { proxies } = readPrefs();
      return (proxies.on ? readyProxy(root, relative(root, file).split(sep).join('/'), proxies.height) : null) ?? madeCopy(file, root);
    },
  });

  /** a project's playable copies (UNPLAYABLE), served as its files are */
  const copiesOf = (/** @type {string} */ root) => folderFiles(join(root, PLAYABLE_DIR), { headers: policy() });

  /** @type {Map<string, { root: string, files: ReturnType<typeof folderFiles> }>} */
  const byToken = new Map();
  const tokenOf = (/** @type {string} */ id) => createHmac('sha256', secret).update(`film origin\0${id}`).digest().subarray(0, 18).toString('base64url');
  /** The project's token, pointing at its folder as it is now (a renamed folder keeps its token). */
  const serve = (/** @type {{ id: string, path: string }} */ project) => {
    const token = tokenOf(project.id);
    if (byToken.get(token)?.root !== project.path) byToken.set(token, { root: project.path, files: filesOf(project.path) });
    return token;
  };
  /** The folder a token reaches: one served since this launch, else the listed project it is the token of. */
  const entryOf = async (/** @type {string} */ token) => {
    if (!byToken.has(token)) {
      const project = (await projects().catch(() => [])).find((p) => tokenOf(p.id) === token);
      if (project) serve(project);
    }
    return byToken.get(token);
  };

  const server = createServer(async (req, res) => {
    const headers = policy();
    if (!ownHost(req, /** @type {import('node:net').AddressInfo} */ (server.address()).port)) { res.writeHead(403, headers).end('not this address'); return; }
    const url = new URL(req.url ?? '/', 'http://pages');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers).end(); return; }
    const match = /^\/p\/([\w-]+)(\/.*)?$/.exec(url.pathname);
    const entry = match && await entryOf(match[1]);
    if (!match || !entry) { res.writeHead(404, headers).end('not found'); return; }
    const path = match[2] ?? '/';
    /* what the address names once decoded (an escaped dot or `\` is the same name): never a hidden file or folder, a
       Windows stream, or a file out of the folder */
    let plain = path;
    try { plain = decodeURIComponent(path); } catch { /* folderFiles refuses it */ }
    if (!servable(entry.root, plain)) { res.writeHead(404, headers).end('not found'); return; }
    if (url.searchParams.has('film-sound')) {
      /* waited for while it is made (a few seconds for a long recording): the mixer plays the film without it meanwhile */
      const file = await soundOf(entry.root, plain.replace(/^\/+/, '')).catch((/** @type {any} */ e) => (e?.status === 404 ? undefined : null));
      if (file === undefined) { res.writeHead(404, headers).end('not found'); return; }
      if (!file) { res.writeHead(204, headers).end(); return; }
      if (!folderFiles(dirname(file), { headers: policy() })(req, res, `/${basename(file)}`, url.searchParams)) res.writeHead(403, headers).end();
      return;
    }
    /* a stretch of the film rendered for the preview to play in its place (preview-cache.mjs): its cache, not the
       project's files */
    const render = /^\/__film\/preview\/([0-9a-f]+)\.mp4$/.exec(plain);
    if (render && isPreviewKey(render[1])) {
      if (!folderFiles(previewDir(entry.root), { headers: policy() })(req, res, `/${render[1]}.mp4`, url.searchParams)) res.writeHead(403, headers).end();
      return;
    }
    if (UNPLAYABLE.test(plain)) {
      const copy = await playableCopy(entry.root, plain.replace(/^\/+/, ''));
      if (!copy) { res.writeHead(404, headers).end('not found'); return; }
      if (!copiesOf(entry.root)(req, res, `/${copy}`, url.searchParams)) res.writeHead(403, headers).end();
      return;
    }
    if (!entry.files(req, res, path, url.searchParams)) res.writeHead(403, headers).end();
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => done(undefined)); });
  /* named `localhost`, not 127.0.0.1 as the editor is: another site to the browser, not only another origin, so it puts
     the film (footage decoding, pages drawing) in a process of its own, away from the editor's */
  const origin = `http://localhost:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

  return {
    origin,
    /** The address of a project's folder on the film's origin; a renamed folder keeps it (pass the project as it is now). */
    folderUrl: (/** @type {{ id: string, path: string }} */ project) => `${origin}/p/${serve(project)}/`,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done(undefined)); }),
  };
}
