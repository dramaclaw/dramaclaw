// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 从视频 URL 抓取单帧的公共设施。
 *
 * 两个消费方：
 *   1. 「抓取当前帧 / 首帧 / 末帧」用户操作 —— 要原尺寸 PNG，用完即上传。
 *   2. 画布低缩放档（LOD）的静态缩略图 —— 要小尺寸 JPEG，进模块级缓存长期复用。
 *
 * 两者共用同一套离屏 <video> 管道：跨域 CDN 媒体（生产环境 `/projects/.../media/*`
 * 会被后端 302 到预签名 OSS）必须带 CORS 加载，否则画进 canvas 会污染，导出直接抛。
 * 判定统一走 [[mediaNeedsCrossOrigin]]。
 *
 * 刻意不复用画布上正在展示的那个 <video>：它没有设 crossOrigin（一旦某个媒体源没回
 * CORS 头，设了会让视频加载失败、整个节点变黑，代价远大于少一张缩略图），所以从它
 * 身上抓帧在生产环境必然污染失败。离屏元素没有这个顾虑——加载失败只是少一张图。
 */

import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';
import { liblibVideoPosterUrl } from '@/features/canvas/domain/liblibMediaUrl';

type VideoFrameOptions = {
  /**
   * 默认 `auto`：用户主动触发的抓帧要尽快出结果。LOD 缩略图改用 `metadata`，
   * 只拉够解出首帧的字节，避免为一张 320px 的图下整段视频。
   */
  preload?: 'auto' | 'metadata';
  /** 超时后 reject 并释放并发槽位。不传则永不超时（保持既有抓帧行为不变）。 */
  timeoutMs?: number;
};

/**
 * 起一个离屏 <video>，seek 到指定秒数，等该帧解码完成后交给 `render` 处理。
 *
 * `render` 拿到的 video 元素在回调返回（或其 Promise settle）后即被回收，
 * 不要把它存下来异步使用。
 */
async function withVideoFrame<T>(
  src: string,
  seekSec: number,
  render: (video: HTMLVideoElement) => T | Promise<T>,
  options?: VideoFrameOptions,
): Promise<T> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = options?.preload ?? 'auto';
  if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: number | null = null;

      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== null) window.clearTimeout(timer);
        run();
      };
      const fail = (reason: unknown) =>
        finish(() =>
          reject(reason instanceof Error ? reason : new Error(String(reason))),
        );
      const done = (value: T) => finish(() => resolve(value));

      const timeoutMs = options?.timeoutMs;
      if (timeoutMs !== undefined) {
        timer = window.setTimeout(
          () => fail(`video frame capture timed out after ${timeoutMs}ms`),
          timeoutMs,
        );
      }

      video.addEventListener('error', () => fail('video element error'));
      video.addEventListener(
        'loadeddata',
        () => {
          const duration = video.duration;
          if (!Number.isFinite(duration) || duration <= 0) {
            fail('invalid video duration');
            return;
          }
          const targetTime = Math.max(
            0,
            Math.min(seekSec, Math.max(0, duration - 0.05)),
          );
          video.addEventListener(
            'seeked',
            () => {
              void (async () => {
                try {
                  done(await render(video));
                } catch (error) {
                  fail(error);
                }
              })();
            },
            { once: true },
          );
          try {
            video.currentTime = targetTime;
          } catch (error) {
            fail(error);
          }
        },
        { once: true },
      );

      video.src = src;
      try {
        video.load();
      } catch {
        // ignored
      }
    });
  } finally {
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // ignored
    }
  }
}

/**
 * 把视频某一帧抓成原尺寸 PNG blob。供「抓取首帧/末帧/当前帧」等用户操作使用。
 */
export async function captureVideoFrameBlob(
  src: string,
  seekSec: number,
): Promise<Blob> {
  return await withVideoFrame(
    src,
    seekSec,
    (video) =>
      new Promise<Blob>((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas context unavailable'));
          return;
        }
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('canvas.toBlob returned null'));
        }, 'image/png');
      }),
  );
}

/* ------------------------------------------------------------------------- *
 * 低缩放档（LOD）静态缩略图
 *
 * 画布缩到 0.35 以下时，视频节点里的 <video> 会被换成这里产出的静态图：每个
 * <video> 都是一个独立合成层，数量随可见节点数线性增长，实测只有连同视频层一起
 * 降级才能把 p90 帧时从 26ms 拉回 14ms（见 [[canvasLod]] 的实测数据）。
 * ------------------------------------------------------------------------- */

/** 低缩放档下节点在屏幕上不到 140px，320px 宽的缩略图绰绰有余。 */
const LOD_STILL_WIDTH = 320;

/** t=0 在部分浏览器是黑帧或干脆不绘制，取 0.1s（与画布其它封面用法一致）。 */
const LOD_STILL_SEEK_SEC = 0.1;

/* ------------------------------------------------------------------------- *
 * 服务端抽帧封面
 *
 * 离屏 <video> 抓帧对远端 CDN 素材有两个硬伤：跨域没回 CORS 头则连加载都失败
 * （抓帧必然拿不到），而且每个视频节点都要白白起一个离屏 <video> 去拉整段远端
 * 视频。对象存储自带服务端抽帧（OSS `video/snapshot`），一次 HTTP 就能拿到静态
 * 封面，和 [[withRemoteImageVariant]] 的图片缩放走同一套「只在无 query 时追加、
 * 避开预签名地址」的规则。
 *
 * 命中服务端抽帧的 src：`getLodStill` 同步返回封面 URL，`requestLodStill` 直接
 * 短路——不入队、不起离屏 <video>。未命中的 src（本地素材、blob:/data:、非 OSS
 * 远端）完全走原有的离屏抓帧管道，行为不变。
 *
 * `serverSidePosterUrl` 是纯函数：同一 src 恒定返回同一字符串值，满足
 * `useSyncExternalStore` 对 getSnapshot 稳定性的要求（字符串按值比较）。
 * ------------------------------------------------------------------------- */

/** OSS `video/snapshot` 的时间点用毫秒；与离屏抓帧的 seek 秒数保持一致。 */
const LOD_STILL_SEEK_MS = Math.round(LOD_STILL_SEEK_SEC * 1000);

/**
 * 只对真正的远端视频对象追加抽帧参数。非视频后缀不动，避免给图片/未知资源挂上
 * 一个什么都不做的 query。
 */
const REMOTE_VIDEO_EXTENSION_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;

/**
 * 「视频 URL → 服务端抽帧封面 URL」的纯函数表。不适用时返回 null，交回离屏抓帧。
 *
 * 以后接入别的对象存储（腾讯 COS 的 `imageMogr2`/视频截帧、七牛等）只需在这里加
 * 一条分支，消费方和缓存逻辑都不动。
 */
export function serverSidePosterUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  // 远端对象存储：OSS 服务端抽帧。只在没有任何 query 时追加——预签名地址的签名
  // 覆盖 query，多一个参数会让签名失效、图直接裂掉；而预签名地址必然带 query，
  // 这条规则正好把它们排除干净。
  if (/^https?:\/\//i.test(src)) {
    if (src.includes('?')) return null;
    if (!REMOTE_VIDEO_EXTENSION_RE.test(src)) return null;
    // m_fast 取最近关键帧，f_jpg 出 JPEG，w_ 限宽到缩略图尺寸；转换失败时 OSS
    // 回落原视频字节，对不支持的地址天然安全（只是渲染成裂图，和现状同级）。
    const process = `video/snapshot,t_${LOD_STILL_SEEK_MS},f_jpg,w_${LOD_STILL_WIDTH},m_fast`;
    return `${src}?x-oss-process=${encodeURIComponent(process)}`;
  }
  // 本地 /static/projects/... 的后端封面（thumbnails.py 的 poster 变体）尚未接入，
  // 暂回落离屏抓帧——本地素材同源，离屏抓帧不会被 CORS 挡，只是慢。
  // blob:/data:/本地路径同样回落。
  return null;
}

export type LodPosterInput = {
  /** 导入/生成时落库的封面。 */
  previewImageUrl?: string | null;
  /** liblib 导入节点的原始素材地址（liblibImport.sourceUrl）。 */
  liblibSourceUrl?: string | null;
  /** 展示用的视频源地址（可能已本地化）。 */
  videoSource?: string | null;
};

/**
 * 无需本地解码就能拿到的视频封面，按优先级返回第一个可用的；都没有返回 null。
 *
 *   1. 落库封面 `previewImageUrl`（导入/生成时写入）——一张现成小图；
 *   2. liblib 源地址现算封面（`liblibVideoPosterUrl(sourceUrl)`）——这是关键兜底：
 *      即使 `previewImageUrl` 因旧导入器/本地化而丢失，只要节点还带着原始 liblib
 *      `sourceUrl`，就能直接拿到 OSS 服务端抽帧封面，无需重新导入；
 *   3. 远端对象存储视频地址的服务端抽帧（`serverSidePosterUrl(videoSource)`）。
 *
 * 返回值是「候选源」；调用方按各自需要再套 resolveImageDisplayUrl / withMediaVariant
 * （对绝对 https 地址两者都是 no-op，安全）。
 */
export function derivedVideoPoster(input: LodPosterInput): string | null {
  const preview =
    typeof input.previewImageUrl === 'string' ? input.previewImageUrl.trim() : '';
  if (preview) return preview;
  const liblib = liblibVideoPosterUrl(input.liblibSourceUrl ?? null);
  if (liblib) return liblib;
  return serverSidePosterUrl(input.videoSource);
}

/**
 * 低细节档要不要为这个视频起离屏 `<video>` 自截封面。
 *
 * 「封面优先、自截兜底」：只要 `derivedVideoPoster` 能给出任何无需本地解码的封面
 * 就返回 false，调用方据此跳过 `requestLodStill`，避免为一张已经有封面的视频白白
 * 起一个离屏 `<video>` 在本地解码整段视频（正是画布卡顿的来源）。
 */
export function shouldSelfCaptureLodStill(input: LodPosterInput): boolean {
  return derivedVideoPoster(input) === null;
}

/** ~320px JPEG 单张约 15–25KB，400 条上限对应几 MB 量级，可接受。 */
const LOD_STILL_CACHE_LIMIT = 400;

/**
 * 同时最多跑 2 个离屏抓帧。
 *
 * 这是纯粹的背景预热任务，不能跟用户正在等的请求抢带宽和解码器；画布上可能同时
 * 挂着几十个视频节点，不设闸门会一次性发起几十路视频加载。
 */
const LOD_STILL_MAX_CONCURRENT = 2;

/** 单次抓帧超时。卡住的媒体不能长期占着并发槽位。 */
const LOD_STILL_TIMEOUT_MS = 15_000;

/** key = 视频 URL；value = dataURL，或 null 表示「试过但拿不到」。 */
const lodStills = new Map<string, string | null>();
/** 已排队或正在抓的 URL，用于去重。 */
const lodInFlight = new Set<string>();
const lodQueue: string[] = [];
let lodActiveCount = 0;
const lodListeners = new Set<() => void>();

function scheduleIdle(run: () => void): void {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 2_000 });
    return;
  }
  window.setTimeout(run, 300);
}

function commitLodStill(src: string, still: string | null): void {
  if (lodStills.size >= LOD_STILL_CACHE_LIMIT && !lodStills.has(src)) {
    // Map 保持插入顺序，最早写入的先出局。
    const oldest = lodStills.keys().next();
    if (!oldest.done) lodStills.delete(oldest.value);
  }
  lodStills.set(src, still);
  for (const listener of lodListeners) listener();
}

async function runLodCapture(src: string): Promise<void> {
  let still: string | null = null;
  try {
    still = await withVideoFrame(
      src,
      LOD_STILL_SEEK_SEC,
      (video) => {
        const sourceWidth = video.videoWidth || LOD_STILL_WIDTH;
        const sourceHeight = video.videoHeight || LOD_STILL_WIDTH;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, LOD_STILL_WIDTH / sourceWidth);
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
      },
      { preload: 'metadata', timeoutMs: LOD_STILL_TIMEOUT_MS },
    );
  } catch {
    // 加载失败 / 跨域污染 / 超时：记 null，渲染侧降级成占位块，且不再重试——
    // 失败往往是媒体源本身的属性，重试只会反复拉流。
    still = null;
  }
  commitLodStill(src, still);
}

function pumpLodQueue(): void {
  while (lodActiveCount < LOD_STILL_MAX_CONCURRENT && lodQueue.length > 0) {
    const src = lodQueue.shift();
    if (src === undefined) return;
    lodActiveCount += 1;
    scheduleIdle(() => {
      void runLodCapture(src).finally(() => {
        lodActiveCount -= 1;
        lodInFlight.delete(src);
        pumpLodQueue();
      });
    });
  }
}

/**
 * 读缓存里的缩略图。`null` = 还没有（尚未抓到，或确认抓不到）。
 *
 * 同步返回且对同一入参返回稳定的原始值，可直接用作 `useSyncExternalStore` 的快照。
 */
export function getLodStill(src: string | null | undefined): string | null {
  if (!src) return null;
  // 服务端抽帧命中：同步返回封面 URL，不碰离屏缓存。纯函数，同一 src 返回同一
  // 字符串值，getSnapshot 稳定。
  const serverPoster = serverSidePosterUrl(src);
  if (serverPoster !== null) return serverPoster;
  return lodStills.get(src) ?? null;
}

/**
 * 请求为该视频准备一张缩略图。幂等：已有结论或已在队列里都会直接返回。
 *
 * 刻意不区分当前缩放档——低缩放档下画布上根本不挂 <video>，等到那时才开始抓，
 * 用户会先看到一屏占位块。在节点挂载时就排进空闲队列，缩小时缩略图已经就位。
 */
export function requestLodStill(src: string | null | undefined): void {
  if (!src) return;
  // 服务端抽帧命中：封面由对象存储直出，不需要离屏预热，直接短路。
  if (serverSidePosterUrl(src) !== null) return;
  if (lodStills.has(src) || lodInFlight.has(src)) return;
  lodInFlight.add(src);
  lodQueue.push(src);
  pumpLodQueue();
}

/** 缓存写入时回调；返回取消订阅函数。 */
export function subscribeLodStills(listener: () => void): () => void {
  lodListeners.add(listener);
  return () => {
    lodListeners.delete(listener);
  };
}
