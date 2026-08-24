// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  MEDIA_VARIANT_MAX_EDGE,
  pickMediaVariant,
  withMediaVariant,
} from '@/lib/media-url';

export function parseAspectRatio(value: string): number {
  const [width, height] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return width / height;
}

// 从一组候选比例（"w:h" 字符串）里挑数值上最接近 targetRatio 的那个。用比值的
// 对数距离，横/竖比例对称（2.33 与其倒数 0.43 到 1 的距离一致）。候选为空时回退 '1:1'。
export function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[],
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

// Aspect ratios the backend accepts for generation. The canvas may carry raw
// pixel-derived ratios (e.g. "43:24" from `reduceAspectRatio`) or "auto"; every
// generation request must snap to one of these before sending. Image and video
// pipelines accept different sets.
export const IMAGE_GENERATION_ASPECT_RATIOS = [
  '1:1',
  '9:16',
  '16:9',
  '3:4',
  '4:3',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  // 后端 FREEZONE_PRESET_IMAGE_ASPECT_RATIOS 支持 21:9，节点下拉也提供该选项；
  // 若这里缺失，提交时 snap 会把用户选的 21:9 错吸附成最接近的 16:9（issue #52）。
  '21:9',
] as const;

export const VIDEO_GENERATION_ASPECT_RATIOS = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
] as const;

// Snap any ratio string (incl. raw pixel ratios) to the numerically closest
// allowed value. Non-ratio inputs ("auto" / "" / garbage) resolve to `fallback`.
export function snapToAllowedAspectRatio(
  value: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed.includes(':')) return fallback;
  const candidates = allowed.length > 0 ? [...allowed] : [fallback];
  return pickClosestAspectRatio(parseAspectRatio(trimmed), candidates);
}

export function reduceAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return '1:1';
  }

  const gcd = greatestCommonDivisor(Math.round(width), Math.round(height));
  return `${Math.round(width / gcd)}:${Math.round(height / gcd)}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }

  return x || 1;
}

const DEFAULT_PREVIEW_MAX_DIMENSION = 512;
const LOCAL_PATH_PREFIX_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export interface PreparedNodeImage {
  imageUrl: string;
  previewImageUrl: string;
  aspectRatio: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createImagePipelineError(message: string, details?: string, cause?: unknown): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  const detailParts: string[] = [];
  if (details) {
    detailParts.push(details);
  }
  if (cause !== undefined) {
    detailParts.push(`cause: ${stringifyUnknown(cause)}`);
  }
  if (detailParts.length > 0) {
    error.details = detailParts.join('\n');
  }
  return error;
}

const ORIGINAL_IMAGE_ZOOM_THRESHOLD = 1.45;

export function shouldUseOriginalImageByZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= ORIGINAL_IMAGE_ZOOM_THRESHOLD;
}

export function isLikelyLocalImagePath(imageUrl: string): boolean {
  if (!imageUrl) {
    return false;
  }

  const lower = imageUrl.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('asset:') ||
    lower.startsWith('file://')
  ) {
    return false;
  }

  return LOCAL_PATH_PREFIX_PATTERN.test(imageUrl);
}

export function resolveImageDisplayUrl(imageUrl: string): string {
  return imageUrl;
}

// 判断字符串是否是可作为 <img src> 渲染的真实图片来源（协议 URL 或本地图片路径）。
// 脚本表格的「角色图/参考」是后端占位字符串字段，模型常填入 `无` 之类的非 URL 文本，
// 直接塞进 <img> 会 404 变成裂图；渲染前用它过滤。
export function isRenderableImageSrc(value: string): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('asset:') ||
    lower.startsWith('file://')
  ) {
    return true;
  }
  return isLikelyLocalImagePath(value);
}

// Media drawn to a <canvas> that gets exported (toBlob / toDataURL) must be
// fetched with CORS, otherwise the canvas taints and export throws. This
// includes relative `/projects/.../media/*` paths: in production the backend
// 302-redirects them to a presigned OSS URL (see _serve_or_redirect_to_oss),
// so a no-cors load ends up cross-origin and taints anyway — that only
// surfaced online, never against the dev vite proxy which streams the bytes
// same-origin. CORS mode is harmless for true same-origin responses (no
// Access-Control-Allow-Origin required) and the OSS bucket allows the site
// origin. Only data:/blob: skip it — they can never taint a canvas.
// Shared by the <img> loader and the offscreen <video> frame-capture paths.
export function mediaNeedsCrossOrigin(url: string): boolean {
  const lower = url.toLowerCase();
  return !lower.startsWith('data:') && !lower.startsWith('blob:');
}

// Cache-busting convention:
// - `v` is a backend-authored content version and must be treated as authoritative.
// - `st_v` is a frontend fallback for newly-written same-path assets with no `v`.
// Do not stack both; changing `st_v` defeats the cache stability promised by `v`.
export function withImageCacheBust(imageUrl: string, token: string | number | null | undefined): string {
  if (!imageUrl || token === null || token === undefined) return imageUrl;
  const trimmed = imageUrl.trim();
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('asset:')
  ) {
    return imageUrl;
  }
  const [base, hash = ''] = trimmed.split('#', 2);
  const [path, query = ''] = base.split('?', 2);
  const params = new URLSearchParams(query);
  params.delete('st_v');
  if (params.has('v')) {
    const versioned = params.toString();
    const stable = versioned ? `${path}?${versioned}` : path;
    return hash ? `${stable}#${hash}` : stable;
  }
  params.set('st_v', String(token));
  const busted = `${path}?${params.toString()}`;
  return hash ? `${busted}#${hash}` : busted;
}

// ── 节点主体图：喂降采样副本 ────────────────────────────────────────────────
//
// 解码 + 光栅的成本只跟源图像素数有关，跟画进多大的盒子无关：一张 5504x3072
// 的 PNG 画进 580px 的节点里，仍然要付 16.9MP 的代价。zoom 0.35（刚好在 LOD
// shell 阈值之上）一屏能放下几十个这样的节点——和历史条那 9 张图是同一个问题，
// 只是规模大一个量级。
//
// 麻烦在于节点主体的 onLoad 同时是画布对这张图的「测量」：它喂分辨率角标，并把
// imageNaturalWidth/Height + aspectRatio 落到节点数据里。从降采样副本上读这些数
// 会把错的尺寸写进图里。所以只有当真实尺寸已经记在节点数据上时才用变体——那时
// 元素已经没有新东西可教我们，调用方改从记录里读（见 nodeBodyImageMeasurement）。
// 尺寸未知的节点照旧加载原图、照旧测量、照旧落库，下次挂载自然就用上变体了。
//
// 前端只请求生产会预热的 320px thumb。按 displayEdge × zoom × devicePixelRatio
// 算出这一格需要的设备像素；thumb 盖不住就回原图，避免放大模糊。
//
// 用 zoom 但不怕抖：pickMediaVariant 的输出只有 thumb 和 null，节点订阅的是这个
// 量化结果而不是 zoom 本身，只在跨过 320px 阈值时切换 src。
//
// 全屏查看器 / 下载 / 导出 / 各类编辑器一律仍然拿原图，见各调用点的
// viewerSourceUrl。
export const NODE_BODY_VARIANT_MAX_EDGE = MEDIA_VARIANT_MAX_EDGE.thumb;

/**
 * 节点主体图这一格需要多少设备像素（长边）。
 *
 * CSS 像素不是答案：一张 320px 的副本填进 315 CSS px 的框，1x 屏上锐利，2x 屏上
 * 只有需要的一半分辨率。zoom 同理——同一个节点缩到 0.4 只占屏幕四成宽。
 */
export function nodeBodyRequiredEdge(
  display: { width: number; height: number },
  zoom: number,
  devicePixelRatio: number,
): number {
  const edge = Math.max(display.width, display.height);
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.ceil(edge * scale * dpr);
}

export type ImagePixelSize = { width: number; height: number };

export type NodeBodyImage = {
  /** 喂给 <img src> 的地址。 */
  src: string;
  /** 未附变体的原图地址；判断「这张图已经不信记录了」时按它比对。 */
  original: string;
  /** true 表示 src 是降采样副本，元素上的 naturalWidth/Height 不可信。 */
  downscaled: boolean;
  /** 副本的长边预算；喂的是原图时为 null。核对元素尺寸时按它算。 */
  maxEdge: number | null;
};

/** 从节点数据里读已记录的原图像素尺寸；没有或不合法时返回 null。 */
export function readNodeNaturalSize(data: unknown): ImagePixelSize | null {
  if (!data || typeof data !== 'object') return null;
  const { imageNaturalWidth: w, imageNaturalHeight: h } = data as {
    imageNaturalWidth?: unknown;
    imageNaturalHeight?: unknown;
  };
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
}

export function nodeBodyImageSrc(
  url: string,
  natural: ImagePixelSize | null,
  options?: { preferOriginal?: boolean; requiredEdge?: number },
): NodeBodyImage {
  const asOriginal: NodeBodyImage = { src: url, original: url, downscaled: false, maxEdge: null };
  // 放大到细看这一档：交回原图。
  if (options?.preferOriginal) return asOriginal;
  // 尺寸未知：这次加载还担着测量职责，必须是原图。
  if (!natural) return asOriginal;
  // 这一格要的像素比阶梯顶还多：给副本就是放大糊，交回原图。
  const variant = pickMediaVariant(options?.requiredEdge ?? NODE_BODY_VARIANT_MAX_EDGE);
  if (variant === null) return asOriginal;
  const maxEdge = MEDIA_VARIANT_MAX_EDGE[variant];
  // 本来就不比变体大：换成变体只是重编码一遍，白白多一个文件。
  if (Math.max(natural.width, natural.height) <= maxEdge) return asOriginal;
  // 变体只对受保护的项目静态图片生效；不适用时原样返回（blob:/data: 的上传预览、
  // 遗留路径、非图片后缀都会走到这里），downscaled 随之为 false。
  const src = withMediaVariant(url, variant);
  return src === url ? asOriginal : { src, original: url, downscaled: true, maxEdge };
}

/**
 * 记录里的尺寸，描述的是不是眼下这张加载好的图。
 *
 * 记录没有和任何 URL 绑定，而节点的图是会被换掉的：画册选主图、从历史恢复、
 * 生成完成回填，这几条路都只改 imageUrl/previewImageUrl，不动
 * imageNaturalWidth/Height。真实尺寸手动调过尺寸的节点更是连修正的机会都没有
 * （onLoad 里 isSizeManuallyAdjusted 那一支会提前 return）。所以「有记录」不等
 * 于「记录说的是这张图」，必须当场对一下。
 *
 * 对法是把记录按变体的规则算一遍，看元素报的是不是那个结果：后端 thumbnail 把
 * 长边正好压到预算上，短边按比例四舍五入（Pillow 的取整，±1px）。对不上就说明
 * 记录描述的是另一张图。
 *
 * 反过来不成立，这一点必须说清楚：对得上只说明比例对得上。副本的长边被钉死在预
 * 算上，原图有多大这个信息在降采样时就丢了，所以 5504x3072 和 2752x1536 的
 * thumb 副本都是 320x179，拿旧记录去比一样能过。换图时的那条线因此不能只靠
 * 这里——各节点在主图地址变了的当下就直接不信任记录（见 distrustRecord），
 * 这里只当兜底：
 * 管挂载时就已经存歪了的旧数据，那种情况没有「上一张」可比。
 */
export function nodeBodyRecordDescribesImage(
  image: { naturalWidth: number; naturalHeight: number },
  natural: ImagePixelSize | null,
  maxEdge: number,
): boolean {
  if (!natural) return false;
  const { naturalWidth: w, naturalHeight: h } = image;
  if (!(w > 0) || !(h > 0)) return false;
  // 横竖都不一样，不用再算了。
  if (w >= h !== natural.width >= natural.height) return false;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const recLong = Math.max(natural.width, natural.height);
  const recShort = Math.min(natural.width, natural.height);
  // 后端拒绝了这次降采样（渲染失败、或源图本就在预算内）直接给了原图。
  if (long === recLong && short === recShort) return true;
  if (long !== maxEdge) return false;
  return Math.abs(short - Math.round((long * recShort) / recLong)) <= 1;
}

/**
 * 这次 onLoad 该按哪组尺寸来测量。
 *
 * 喂的是降采样副本时元素在说谎，改用记录里的真实尺寸——于是后续的比例计算、
 * 自动尺寸、角标全都和喂原图时逐字节一致，不是「跳过测量」。
 *
 * 但只在记录确实描述这张图时才这么做；对不上时元素虽然也不是原图，至少是从这
 * 张图来的，比一个属于别的图的记录可信。调用方应当先用
 * nodeBodyRecordDescribesImage 判一下，对不上就退回原图重测（见各节点的
 * onLoad），那才拿得到真相。
 */
export function nodeBodyImageMeasurement(
  image: { naturalWidth: number; naturalHeight: number },
  body: NodeBodyImage,
  natural: ImagePixelSize | null,
): ImagePixelSize {
  if (
    body.downscaled
    && natural
    && nodeBodyRecordDescribesImage(image, natural, body.maxEdge ?? 0)
  ) {
    return natural;
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export type NaturalSizeRecordWrite = {
  /** 要不要把这一轮量到的尺寸写回节点数据。 */
  persist: boolean;
  /** 这次写回该不该进撤销栈。 */
  recordHistory: boolean;
  /** 要不要顺带把节点尺寸改成贴合这张图的尺寸。 */
  applySize: boolean;
};

/**
 * onLoad 量完之后，这次要不要落库、算不算一次用户可撤销的改动。
 *
 * 三种要写的情形，性质完全不同：
 *
 * 1. 比例变了 / 显示尺寸对不上 —— 节点在屏幕上会跟着变形，是用户看得见的改动，
 *    进撤销栈天经地义。
 * 2. 记录本来就是空的 —— 老项目里的节点比例早就算对了、尺寸也早就贴合了，上面
 *    两个条件永远是 false，于是 imageNaturalWidth/Height 一辈子写不进去；而
 *    nodeBodyImageSrc 没有记录就只能喂原图，这个节点从此享受不到降采样副本。
 *    补这一笔不改变屏幕上的任何一个像素。
 * 3. 记录和真相对不上 —— 换成同比例的另一张图（5504x3072 -> 2752x1536）比例和
 *    显示尺寸都不变，只靠第 1 条的话修正永远落不了地。同样不改变屏幕。
 *
 * 后两种只是把画布早就知道的事实补记下来，不是编辑。放进撤销栈的话，光是打开
 * 一个老项目就会堆进几十条「忘掉图片尺寸」的条目，还会把重做栈清空——所以
 * recordHistory 只在第 1 种情形为真。
 *
 * 第 2、3 种都自带收敛：写完记录就和真相一致，下次同一判断直接为假。
 *
 * sizeLockedByUser 是「用户手动拖过尺寸」。它只关掉 applySize，不关掉记录纠正：
 * 保住用户拖出来的显示尺寸，和把真实像素尺寸记对，是两件互不相干的事。
 *
 * measuringRecordSubject 是给 ImageNode 那种「放大档换喂另一个 URL」的节点用的：
 * 那一轮元素上的尺寸属于另一张图（旋转/补光/多视角的结果都写在 previewImageUrl
 * 里，和 imageUrl 不必同尺寸），拿它去纠正记录是把错的换成另一个错的。
 */
export function planNaturalSizeRecordWrite(input: {
  aspectRatioChanged: boolean;
  displaySizeMismatch: boolean;
  record: ImagePixelSize | null;
  measured: ImagePixelSize;
  measuringRecordSubject: boolean;
  sizeLockedByUser: boolean;
}): NaturalSizeRecordWrite {
  const recordIsWrong =
    input.measuringRecordSubject
    && (input.record === null
      || input.record.width !== input.measured.width
      || input.record.height !== input.measured.height);
  // 用户拖定过尺寸：屏幕上的尺寸归他，记录归事实。这两件事原本捆在一起，于是
  // 「不许自动改尺寸」把「纠正记录」也一并跳过了——换图之后角标当次靠组件局部
  // state 还是对的，重新挂载读到的却是旧记录，变体也按旧尺寸挑。
  if (input.sizeLockedByUser) {
    return { persist: recordIsWrong, recordHistory: false, applySize: false };
  }
  if (input.aspectRatioChanged || input.displaySizeMismatch) {
    return { persist: true, recordHistory: true, applySize: true };
  }
  return { persist: recordIsWrong, recordHistory: false, applySize: false };
}

export async function persistImageLocally(source: string): Promise<string> {
  return source;
}

export async function loadImageElement(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  const displaySource = resolveImageDisplayUrl(source);
  if (mediaNeedsCrossOrigin(displaySource)) {
    image.crossOrigin = 'anonymous';
  }

  return await new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        createImagePipelineError('图片加载失败', `source=${source}\ndisplaySource=${displaySource}`)
      );
    image.src = displaySource;
  });
}

export async function imageUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    return imageUrl;
  }

  if (isLikelyLocalImagePath(imageUrl)) {
    const localResponse = await fetch(resolveImageDisplayUrl(imageUrl));
    if (!localResponse.ok) {
      throw createImagePipelineError(
        '无法读取本地图片数据',
        `source=${imageUrl}\nstatus=${localResponse.status}`
      );
    }
    const localBlob = await localResponse.blob();
    return await blobToDataUrl(localBlob);
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw createImagePipelineError('无法下载图片数据', `url=${imageUrl}\nstatus=${response.status}`);
  }

  const blob = await response.blob();
  return await blobToDataUrl(blob);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();

  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('图片转换失败'));
    reader.readAsDataURL(blob);
  });
}

export function extractBase64Payload(dataUrl: string): string {
  const [, payload = ''] = dataUrl.split(',');
  return payload;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header = '', payload = ''] = dataUrl.split(',');
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = /;base64/i.test(header);
  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  const reader = new FileReader();

  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

export async function prepareNodeImageFromFile(
  file: File,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<PreparedNodeImage> {
  const started = performance.now();
  const dataUrlStarted = performance.now();
  const source = await readFileAsDataUrl(file);
  const dataUrlElapsed = Math.round(performance.now() - dataUrlStarted);
  const prepared = await prepareNodeImage(source, maxPreviewDimension);
  console.info(
    `[upload-perf][imageData] prepareNodeImageFromFile dataurl-fallback name="${file.name}" size=${file.size}B readDataUrl=${dataUrlElapsed}ms total=${Math.round(performance.now() - started)}ms`
  );
  return prepared;
}

export async function detectAspectRatio(imageUrl: string): Promise<string> {
  const image = await loadImageElement(imageUrl);
  return reduceAspectRatio(image.naturalWidth, image.naturalHeight);
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function resolvePreviewMimeType(imageUrl: string): string {
  if (imageUrl.startsWith('data:image/png')) {
    return 'image/png';
  }
  if (imageUrl.startsWith('data:image/webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function renderPreviewDataUrl(
  image: HTMLImageElement,
  sourceDataUrl: string,
  maxDimension: number
): string {
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (longestSide <= maxDimension) {
    return sourceDataUrl;
  }

  const scale = maxDimension / longestSide;
  const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return sourceDataUrl;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const mimeType = resolvePreviewMimeType(sourceDataUrl);
  if (mimeType === 'image/jpeg') {
    return canvas.toDataURL(mimeType, 0.86);
  }
  return canvas.toDataURL(mimeType);
}

export async function createPreviewDataUrl(
  imageUrl: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<string> {
  const normalizedDataUrl = await imageUrlToDataUrl(imageUrl);
  const image = await loadImageElement(normalizedDataUrl);
  const safeMaxDimension = Math.max(64, Math.floor(maxDimension));
  return renderPreviewDataUrl(image, normalizedDataUrl, safeMaxDimension);
}

export async function prepareNodeImage(
  imageUrl: string,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<PreparedNodeImage> {
  const trimmedImageUrl = imageUrl.trim();
  if (!trimmedImageUrl) {
    throw createImagePipelineError('未获取到可用图片结果', 'imageUrl is empty');
  }

  const started = performance.now();

  try {
    const persistedImagePath = await persistImageLocally(trimmedImageUrl);
    const normalizedDataUrl = await imageUrlToDataUrl(persistedImagePath);
    const image = await loadImageElement(normalizedDataUrl);
    const safeMaxDimension = Math.max(64, Math.floor(maxPreviewDimension));
    const previewDataUrl = renderPreviewDataUrl(image, normalizedDataUrl, safeMaxDimension);
    const previewImagePath =
      previewDataUrl === normalizedDataUrl
        ? persistedImagePath
        : await persistImageLocally(previewDataUrl);

    console.info(
      `[upload-perf][imageData] prepareNodeImage browser-fallback total=${Math.round(performance.now() - started)}ms`
    );
    return {
      imageUrl: persistedImagePath,
      previewImageUrl: previewImagePath,
      aspectRatio: reduceAspectRatio(image.naturalWidth, image.naturalHeight),
    };
  } catch (error) {
    throw createImagePipelineError(
      '生成结果无法解析为图片',
      `source=${trimmedImageUrl}`,
      error
    );
  }
}
