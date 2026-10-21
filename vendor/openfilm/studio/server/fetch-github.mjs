// @ts-check
/**
 * A film from a public GitHub repository, over plain https: no git needed. GitHub's API names the commit and lists
 * the folder's files with their sizes, so the size of the whole is known before the first byte comes; the files then
 * come from GitHub's raw file host at that commit, a few at a time, each written as it streams in.
 *
 * When the API cannot help (a private repository, its hourly limit for this address used up, a listing too long to be
 * whole), it throws a FetchError with code 'use-git', before anything is downloaded: the caller fetches with git.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { FetchError } from './fetch-error.mjs';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_RAW = 'https://raw.githubusercontent.com';
/* files downloading at once */
const PARALLEL = 4;
/* tries at each file, and the wait before the second (doubled for each after) */
const TRIES = 5;
const RETRY_MS = 500;
/* the starts of a folder's address tried as a branch's name (a branch may have slashes in its name) */
const MAX_REF_PARTS = 6;

/**
 * @typedef {{ api?: string, raw?: string }} GitHubHosts where the API and the raw files are (a test's own server)
 * @typedef {{ path: string, size: number }} RemoteFile `path`: in the folder, with slashes
 * @typedef {{ commit: string, folder: string[], files: RemoteFile[], total: number }} RemoteListing
 */

const encodePath = (/** @type {string[]} */ parts) => parts.map(encodeURIComponent).join('/');

/** Whether GitHub refused because this address used up its hourly calls. @param {Response} res */
const limited = (res) => res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');

/** Wait `ms`, or less when `signal` stops it. @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal) => new Promise((done) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(undefined); }, { once: true });
});

/**
 * Ask GitHub. A connection that fails is tried again, a little later each time; failing every time, it is said as a
 * network failure. @param {string} url
 * @param {{ signal?: AbortSignal, accept?: string }} options @returns {Promise<Response>}
 */
async function request(url, { signal, accept }) {
  for (let tries = 1; ; tries++) {
    try {
      return await fetch(url, { signal, headers: { accept: accept ?? 'application/vnd.github+json', 'user-agent': 'OpenFilm-Studio' } });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (tries >= TRIES) throw new FetchError('Could not reach GitHub: check your internet connection.', 502, 'network');
      await pause(RETRY_MS * 2 ** (tries - 1), signal);
    }
  }
}

/**
 * The commit `tree` points at, and the folder in it: the shortest start of `tree` that GitHub knows as a branch, a
 * tag or a commit (null `tree`: the default branch, the whole repository). A file's address means its folder.
 * @param {{ owner: string, repo: string }} at @param {string[] | null} tree @param {boolean} blob
 * @param {{ signal?: AbortSignal, hosts?: GitHubHosts }} [options]
 * @returns {Promise<{ commit: string, folder: string[] }>}
 */
export async function resolveCommit(at, tree, blob, { signal, hosts = {} } = {}) {
  const base = `${hosts.api ?? GITHUB_API}/repos/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/commits/`;
  const tries = tree ? Array.from({ length: Math.min(tree.length, MAX_REF_PARTS) }, (_, i) => i + 1) : [0];
  for (const n of tries) {
    const ref = tree ? tree.slice(0, n) : ['HEAD'];
    const res = await request(base + encodePath(ref), { signal, accept: 'application/vnd.github.sha' });
    if (res.ok) {
      const commit = (await res.text()).trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new FetchError('GitHub answered with something that is not a commit.', 502, 'failed');
      const folder = tree ? tree.slice(n) : [];
      return { commit, folder: blob ? folder.slice(0, -1) : folder };
    }
    /* not to be seen (private, or no such repository), or no more calls this hour: git may still get it */
    if (res.status === 404 || res.status === 401 || limited(res)) throw new FetchError('GitHub’s API cannot list it.', 409, 'use-git');
    /* 422: no such branch or tag; try a longer start */
    if (res.status !== 422) throw new FetchError(`GitHub answered ${res.status}.`, 502, 'failed');
  }
  throw new FetchError(`There is no branch or tag “${tree?.[0] ?? 'HEAD'}” in that repository.`, 404, 'ref');
}

/**
 * The files of `folder` at `commit`, with their sizes. Links and submodules are left out.
 * @param {{ owner: string, repo: string }} at @param {string} commit @param {string[]} folder
 * @param {{ signal?: AbortSignal, hosts?: GitHubHosts }} [options]
 * @returns {Promise<RemoteFile[]>}
 */
export async function listFiles(at, commit, folder, { signal, hosts = {} } = {}) {
  const treeish = folder.length ? `${commit}:${folder.join('/')}` : commit;
  const url = `${hosts.api ?? GITHUB_API}/repos/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/git/trees/${encodeURIComponent(treeish)}?recursive=1`;
  const res = await request(url, { signal });
  if (res.status === 404) throw new FetchError(`There is no folder “${folder.join('/')}” in that repository.`, 404, 'no-folder');
  if (res.status === 401 || limited(res)) throw new FetchError('GitHub’s API cannot list it.', 409, 'use-git');
  if (!res.ok) throw new FetchError(`GitHub answered ${res.status}.`, 502, 'failed');
  const body = /** @type {{ truncated?: boolean, tree?: { path?: unknown, type?: unknown, mode?: unknown, size?: unknown }[] }} */ (await res.json());
  if (body.truncated || !Array.isArray(body.tree)) throw new FetchError('GitHub’s listing is not whole.', 409, 'use-git');
  /** @type {RemoteFile[]} */
  const files = [];
  for (const entry of body.tree) {
    if (entry.type !== 'blob' || entry.mode === '120000' || typeof entry.path !== 'string') continue;
    const parts = entry.path.split('/');
    if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) continue;
    files.push({ path: entry.path, size: typeof entry.size === 'number' && entry.size > 0 ? entry.size : 0 });
  }
  return files;
}

/**
 * Download `files` (of `folder` at `commit`) into `dir`, a few at a time; `onBytes` hears each piece as it comes.
 * @param {{ owner: string, repo: string }} at @param {string} commit @param {string[]} folder @param {RemoteFile[]} files
 * @param {{ dir: string, signal?: AbortSignal, hosts?: GitHubHosts, onBytes?: (n: number) => void }} options
 */
export async function downloadFiles(at, commit, folder, files, { dir, signal, hosts = {}, onBytes = () => {} }) {
  const base = `${hosts.raw ?? GITHUB_RAW}/${encodeURIComponent(at.owner)}/${encodeURIComponent(at.repo)}/${commit}/`;
  /* the biggest first, so the last to finish are small; one that fails stops the others */
  const queue = [...files].sort((a, b) => b.size - a.size);
  const control = new AbortController();
  const stopAll = () => control.abort();
  if (signal?.aborted) stopAll();
  signal?.addEventListener('abort', stopAll, { once: true });
  /** @type {unknown} */
  let failed = null;
  /** One try at a file, counting only the bytes past `counted` (what an earlier try already told). */
  const attempt = async (/** @type {RemoteFile} */ file, /** @type {string} */ to, /** @type {{ counted: number }} */ told) => {
    const res = await request(base + encodePath([...folder, ...file.path.split('/')]), { signal: control.signal, accept: '*/*' });
    if (!res.ok || !res.body) {
      const error = new FetchError(`GitHub did not send “${file.path}” (${res.status}).`, 502, 'failed');
      throw res.status === 429 || res.status >= 500 ? Object.assign(error, { again: true }) : error;
    }
    let got = 0;
    const count = new Transform({
      transform(chunk, _, done) {
        got += chunk.length;
        if (got > told.counted) { onBytes(got - told.counted); told.counted = got; }
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(/** @type {import('node:stream/web').ReadableStream} */ (res.body)), count, createWriteStream(to), { signal: control.signal });
    } catch (e) {
      if (control.signal.aborted) throw e;
      throw Object.assign(new FetchError('The download broke off: check your internet connection.', 502, 'network'), { again: true });
    }
  };
  const one = async (/** @type {RemoteFile} */ file) => {
    const to = join(dir, ...file.path.split('/'));
    const inside = relative(dir, to);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new FetchError(`“${file.path}” is not a path in the folder.`, 422, 'failed');
    await mkdir(dirname(to), { recursive: true });
    /* a connection that drops is tried again, a little later each time, from the start of the file */
    const told = { counted: 0 };
    for (let tries = 1; ; tries++) {
      try {
        await attempt(file, to, told);
        return;
      } catch (e) {
        if (control.signal.aborted || !(/** @type {any} */ (e)?.again) || tries >= TRIES) throw e;
        await pause(RETRY_MS * 2 ** (tries - 1), control.signal);
      }
    }
  };
  const worker = async () => {
    for (let file = queue.shift(); file && !control.signal.aborted; file = queue.shift()) {
      try {
        await one(file);
      } catch (e) {
        failed ??= e;
        stopAll();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  signal?.removeEventListener('abort', stopAll);
  if (failed) throw failed;
}
