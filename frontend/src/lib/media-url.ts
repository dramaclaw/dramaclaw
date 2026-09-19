// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readUrl } from "@/lib/url-params";

// Allowlist scheme/origin handling prevents a poisoned backend response from
// producing `javascript:`, `data:`, or arbitrary cross-origin URLs that later
// reach an <a href>, window.location, or download anchor.
//
// Rules:
//   null/undefined/empty -> null
//   same-origin absolute https URL -> returned as-is
//   absolute http/https URL with a different origin -> null (rejected)
//   `/static/projects/<project-id>/...` path -> returned as canonical project static media
//   `/static/<user>/<project>/...` path -> `/static/projects/<route-project-id>/...` when on a project route
//   `/api/v1/projects/<legacy>/media/...` path -> `/static/projects/<route-project-id>/...` when on a project route
//   `/static/...` non-project path or non-media `/api/...` path -> returned as-is
//   any other value (including javascript:, data:, vbscript:, ftp:, //host,
//     protocol-relative, malformed) -> null
//
// `options.variant` additionally asks the backend for a downscaled copy of a
// project image (see novelvideo/utils/thumbnails.py). Pass it wherever the
// image paints into a small box; never on a path that feeds a download, a
// fullscreen preview, or a <canvas> export, and never on a value that gets
// persisted — stored URLs must stay pointed at the original.
export function resolveMediaUrl(
  path: string | null | undefined,
  options?: { variant?: MediaVariant },
): string | null {
  const resolved = resolveMediaPath(path);
  if (resolved === null || !options?.variant) return resolved;
  return withMediaVariant(resolved, options.variant);
}

// 阶梯必须和后端 `novelvideo/utils/thumbnails.py` 的 VARIANTS 一致。
//
// 这里一度只有 `thumb` 一档,理由是「只请求生成历史写入路径预热过的那一档」。
// 代价比预期大得多:一个 480 CSS px 宽的节点在 2x 屏上要 960 设备像素,320 档喂不饱,
// `pickMediaVariant` 返回 null 就回落原图——于是画布上一张 3840x2160 被解码进
// 169x95 的框里,约 33MB 位图。降采样这套机制在节点主体上等于从没生效过。
//
// 现在三档齐全,预热侧也跟着补齐(history.py 与 liblib_assets.py 都改为预热全档位)。
export type MediaVariant = "thumb" | "thumb2x" | "card";

export const MEDIA_VARIANT_MAX_EDGE: Record<MediaVariant, number> = {
  thumb: 320,
  thumb2x: 640,
  card: 1280,
};

// 由小到大:`pickMediaVariant` 取第一个够用的,也就是最省的那一档。
const MEDIA_VARIANT_LADDER: MediaVariant[] = ["thumb", "thumb2x", "card"];

/**
 * Return ``thumb`` when its 320px edge can fill the requested device pixels,
 * or ``null`` so the caller uses the original.
 *
 * Device pixels, not CSS pixels: a 320px copy in a 315 CSS px box is crisp on a
 * 1x display and visibly soft on a 2x one, and that difference is exactly what
 * a fixed budget per call site cannot express. Callers compute the requirement
 * as `displayEdge * zoom * devicePixelRatio` and let this pick.
 *
 * `null` means "serve the original". Upscaling the 320px thumbnail is avoided
 * because its decode saving would come with visible blur.
 */
export function pickMediaVariant(requiredEdge: number): MediaVariant | null {
  if (!Number.isFinite(requiredEdge) || requiredEdge <= 0) return null;
  for (const variant of MEDIA_VARIANT_LADDER) {
    if (MEDIA_VARIANT_MAX_EDGE[variant] >= requiredEdge) return variant;
  }
  return null;
}

// Query key is `st_thumb`, matching the `st_`-prefixed convention already used
// for cache-busting; a bare `v` is taken — callers pass their own version
// token under it (see withImageCacheBust).
const MEDIA_VARIANT_PARAM = "st_thumb";

// Mirrors the formats the backend will downscale; anything else is passed
// through untouched so the URL does not gain a parameter that does nothing.
const THUMBNAILABLE_EXTENSION_RE = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

/**
 * 远端对象存储图片的降采样地址。不适用时原样返回。
 *
 * 为什么需要:本地素材有 `st_thumb` 阶梯,远端素材什么都没有,只能吃原图。导入进来的
 * 画布在本地化成功之前(或者本地化失败时)全是远端地址,一张 3840x2160 被解码进
 * 169x95 的框里约 33MB 位图,拖动直接卡死。LibTV 自己的画布就是这么解的——实测它给
 * 同一张图挂的是 `w_200/w_400/w_800` 三档 srcset。
 *
 * `ignore-error,1` 是关键:转换失败时 OSS 回落原图而不是报错,所以这个参数对不支持
 * 转换的地址天然安全。`format,webp` 顺带把 PNG 压下来。
 *
 * **只在没有任何查询参数时才加**。预签名地址的签名覆盖 query,多加一个参数会让签名
 * 失效、图直接裂掉;而预签名地址必然带 query,这条规则正好把它们排除干净。
 * 已经带 `x-oss-process` 的地址是例外——它自己就证明了服务端认这个语法,直接换宽度。
 */
export function withRemoteImageVariant(url: string, maxEdge: number): string {
  if (!Number.isFinite(maxEdge) || maxEdge <= 0) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  const process = `image/resize,w_${Math.round(maxEdge)},m_lfit/format,webp/ignore-error,1`;
  const queryAt = url.indexOf('?');
  if (queryAt === -1) {
    if (!THUMBNAILABLE_EXTENSION_RE.test(url)) return url;
    return `${url}?x-oss-process=${encodeURIComponent(process)}`;
  }
  const params = new URLSearchParams(url.slice(queryAt + 1));
  const existing = params.get('x-oss-process');
  // 视频抽帧(video/snapshot,...)不是图片缩放,别拿图片参数覆盖掉它。
  if (!existing || !existing.startsWith('image/resize')) return url;
  params.set('x-oss-process', process);
  return `${url.slice(0, queryAt)}?${params.toString()}`;
}

// Exported for callers that have already resolved a URL through some other
// path (canvas nodes go through resolveImageDisplayUrl + withImageCacheBust)
// and only need the variant appended. Returns `url` untouched whenever the
// variant cannot apply, so the caller can compare identity to find out whether
// it actually got a downscaled copy.
export function withMediaVariant(url: string, variant: MediaVariant): string {
  // Only the protected project static route understands variants. Legacy and
  // non-project paths are served by other handlers that would ignore it.
  if (!url.startsWith("/static/projects/")) return url;
  // split(sep, 2) would *truncate*: "a.png#x#y".split("#", 2) drops "#y"
  // entirely rather than keeping it in the tail. Cut at the first separator and
  // keep everything after it.
  const hashAt = url.indexOf("#");
  const hash = hashAt === -1 ? "" : url.slice(hashAt + 1);
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = base.indexOf("?");
  const pathname = queryAt === -1 ? base : base.slice(0, queryAt);
  const query = queryAt === -1 ? "" : base.slice(queryAt + 1);
  if (!THUMBNAILABLE_EXTENSION_RE.test(pathname)) return url;
  const params = new URLSearchParams(query);
  params.set(MEDIA_VARIANT_PARAM, variant);
  const next = `${pathname}?${params.toString()}`;
  return hash ? `${next}#${hash}` : next;
}

function resolveMediaPath(path: string | null | undefined): string | null {
  if (!path) return null;

  // Relative site-paths we explicitly trust as media roots.
  if (path.startsWith("/static/")) {
    return projectStaticToCanonicalUrl(path) ?? path;
  }
  if (path.startsWith("/api/")) {
    return projectMediaApiToStaticUrl(path) ?? path;
  }

  // Reject protocol-relative URLs (`//evil/…`) which browsers resolve against
  // the page protocol and origin.
  if (path.startsWith("//")) return null;

  // Absolute URL path. Parse against the current origin so relative strings
  // without a leading slash do not accidentally become https:// URLs.
  let parsed: URL;
  try {
    parsed = new URL(path, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (typeof window !== "undefined" && parsed.origin !== window.location.origin) {
    // Cross-origin media not supported in this deploy — backend always serves
    // /static from the same origin (routed via the edge Worker reverse proxy).
    return null;
  }

  if (parsed.pathname.startsWith("/static/")) {
    const mediaUrl = projectStaticToCanonicalUrl(
      parsed.pathname + parsed.search + parsed.hash,
    );
    if (mediaUrl) return mediaUrl;
  }

  if (parsed.pathname.startsWith("/api/")) {
    const mediaUrl = projectMediaApiToStaticUrl(
      parsed.pathname + parsed.search + parsed.hash,
    );
    if (mediaUrl) return mediaUrl;
  }

  // Return the normalized path+query so weird inputs (`/static/a/../b`) are
  // resolved by the URL parser rather than concatenated as strings downstream.
  return parsed.pathname + parsed.search + parsed.hash;
}

const PROJECT_STATIC_MEDIA_ROOTS = new Set([
  "assets",
  "audio",
  "director_control_frames",
  "frames",
  "freezone",
  "grids",
  "images",
  "renders",
  "sketches",
  "uploads",
  "videos",
]);

function projectMediaApiToStaticUrl(path: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(path, "http://localhost");
  } catch {
    return null;
  }

  const parts = parsed.pathname.split("/");
  // /api/v1/projects/<project>/media/<file_path...>
  if (
    parts.length < 7 ||
    parts[1] !== "api" ||
    parts[2] !== "v1" ||
    parts[3] !== "projects" ||
    parts[5] !== "media"
  ) {
    return null;
  }

  const routeProject = currentRouteProjectId() ?? normalizePathSegment(parts[4]);
  if (!routeProject) return null;

  const filePath = parts.slice(6).map(normalizePathSegment).join("/");
  if (!filePath) return null;

  return `/static/projects/${routeProject}/${filePath}${parsed.search}${parsed.hash}`;
}

function projectStaticToCanonicalUrl(path: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(path, "http://localhost");
  } catch {
    return null;
  }

  const parts = parsed.pathname.split("/");
  if (parts.length < 5 || parts[1] !== "static") return null;

  // /static/projects/<project>/<file_path...>
  if (parts[2] === "projects") {
    const project = normalizePathSegment(parts[3]);
    const fileRoot = decodePathSegment(parts[4]);
    if (!project || !PROJECT_STATIC_MEDIA_ROOTS.has(fileRoot)) return null;

    const filePath = parts.slice(4).map(normalizePathSegment).join("/");
    if (!filePath) return null;
    return `/static/projects/${project}/${filePath}${parsed.search}${parsed.hash}`;
  }

  // Legacy: /static/<user>/<project>/<file_path...>
  const fileRoot = decodePathSegment(parts[4]);
  if (!PROJECT_STATIC_MEDIA_ROOTS.has(fileRoot)) return null;

  const legacyProjectPathName = normalizePathSegment(parts[3]);
  const project = currentRouteProjectId() ?? legacyProjectPathName;
  const filePath = parts.slice(4).map(normalizePathSegment).join("/");
  if (!project || !filePath) return null;

  return `/static/projects/${project}/${filePath}${parsed.search}${parsed.hash}`;
}

function currentRouteProjectId(): string | null {
  if (typeof window === "undefined") return null;
  const current = readUrl().project;
  if (current) return normalizePathSegment(current);

  const parts = window.location.pathname.split("/");
  const index = parts.findIndex((part) => part === "projects");
  if (index < 0 || index + 1 >= parts.length) return null;

  const raw = parts[index + 1];
  if (!raw) return null;
  return normalizePathSegment(raw);
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizePathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}
