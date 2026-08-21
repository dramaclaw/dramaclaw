const ORG_BRAND_ROOT = "/assets/org-brand";
const ORG_BRAND_PREFIX = `${ORG_BRAND_ROOT}/`;
const ORG_BRAND_PATH =
  /^\/assets\/org-brand\/sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.(png|webp)$/;
const SUCCESS_HEADERS: Record<string, string> = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const ERROR_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export interface OrgBrandAssetOptions {
  assetOrigin: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
// Cross-repository wire contract: must match the backend constant of the same name.
const MAX_NORMALIZED_LOGO_BYTES = 20 * 1024 * 1024;

export function isOrgBrandAssetRequest(url: URL): boolean {
  return url.pathname === ORG_BRAND_ROOT || url.pathname.startsWith(ORG_BRAND_PREFIX);
}

function assetPath(
  pathname: string,
): { path: string; contentType: "image/png" | "image/webp" } | null {
  const match = ORG_BRAND_PATH.exec(pathname);
  if (!match || match[1] !== match[3].slice(0, 2) || match[2] !== match[3].slice(2, 4)) {
    return null;
  }
  return {
    path: pathname,
    contentType: match[4] === "png" ? "image/png" : "image/webp",
  };
}

function errorResponse(status: number, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(ERROR_HEADERS);
  new Headers(extraHeaders).forEach((value, name) => headers.set(name, value));
  return new Response(null, {
    status,
    headers,
  });
}

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function validContentLength(response: Response, maxBytes: number): number | null {
  const value = response.headers.get("content-length");
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length <= 0 || length > maxBytes) return null;
  return length;
}

function streamBody(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  maxBytes: number,
  deadline: Promise<never>,
  finish: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
      finish();
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (done) {
          if (total !== expectedBytes) {
            throw new Error("organization brand asset length mismatch");
          }
          release();
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes || total > expectedBytes) {
          throw new Error("organization brand asset exceeds response limit");
        }
        controller.enqueue(value);
      } catch (error) {
        try {
          await reader.cancel(error);
        } catch {
          // Preserve the original timeout/limit failure.
        }
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function handleOrgBrandAsset(
  request: Request,
  options: OrgBrandAssetOptions,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, { Allow: "GET, HEAD" });
  }

  const incoming = new URL(request.url);
  const asset = assetPath(incoming.pathname);
  if (!asset || incoming.search) return errorResponse(404);

  const origin = parseOrigin(options.assetOrigin);
  if (!origin) return errorResponse(503);

  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timeout !== undefined) clearTimeout(timeout);
  };
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      abort.abort();
      reject(new Error("organization brand asset upstream timeout"));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
  try {
    const storagePath = asset.path.slice("/assets".length);
    const upstream = await Promise.race([
      (options.fetcher ?? fetch)(new URL(storagePath, origin).toString(), {
        method: request.method,
        redirect: "manual",
        signal: abort.signal,
      }),
      deadline,
    ]);
    if (upstream.status !== 200) {
      await cancelBody(upstream);
      finish();
      return errorResponse(upstream.status);
    }
    const contentType = upstream.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== asset.contentType) {
      await cancelBody(upstream);
      finish();
      return errorResponse(502);
    }

    const maxBytes = options.maxBytes ?? MAX_NORMALIZED_LOGO_BYTES;
    const contentLength = validContentLength(upstream, maxBytes);
    if (contentLength === null) {
      await cancelBody(upstream);
      finish();
      return errorResponse(502);
    }

    const headers = new Headers({ "Content-Type": asset.contentType });
    for (const name of ["content-length", "etag", "last-modified"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    for (const [key, value] of Object.entries(SUCCESS_HEADERS)) headers.set(key, value);
    if (request.method === "HEAD") {
      await cancelBody(upstream);
      finish();
      return new Response(null, { status: 200, headers });
    }
    if (!upstream.body) {
      finish();
      return errorResponse(502);
    }
    return new Response(
      streamBody(upstream.body, contentLength, maxBytes, deadline, finish),
      { status: 200, headers },
    );
  } catch {
    finish();
    return errorResponse(502);
  }
}
