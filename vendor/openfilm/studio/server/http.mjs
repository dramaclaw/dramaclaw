// @ts-check
/** Small HTTP helpers for Studio's server: JSON in and out, errors as JSON. */

/** @typedef {import('node:http').IncomingMessage} Req */
/** @typedef {import('node:http').ServerResponse} Res */

export class HttpError extends Error {
  /** @param {number} status @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** @param {Res} res @param {number} status @param {unknown} body */
export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The request's JSON body (at most 4 MB: an edit or a project path, never media). */
export async function readJson(/** @type {Req} */ req, limit = 4 << 20) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'the body is not JSON'); }
}

/** The value of a cookie on the request. */
export function cookie(/** @type {Req} */ req, /** @type {string} */ name) {
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}
