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
