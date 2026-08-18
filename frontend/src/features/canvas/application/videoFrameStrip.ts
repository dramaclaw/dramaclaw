// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';

/** 整条缩略图带的解码预算。超时按「有几帧算几帧」返回，不再干等。 */
const CAPTURE_TIMEOUT_MS = 15_000;
/** 单次 seek 的预算。个别关键帧卡住时跳过它，而不是拖垮整条带子。 */
const SEEK_TIMEOUT_MS = 4_000;
/** 缓存条数上限，按插入顺序淘汰最老的。一条带子约 8 张 160px jpeg，量级几百 KB。 */
const CACHE_LIMIT = 12;

const cache = new Map<string, Promise<string[]>>();

function cacheKey(src: string, count: number): string {
  return `${count}|${src}`;
}

/**
 * 均匀抽 N 帧做缩略图条，走隐藏 <video> + <canvas>。
 *
 * 从 VideoClipPanel 抽出来共用 —— 片段重拍的时间轨道要的是同一条缩略图带，
 * 复制一份会连带把下面这些踩过的坑复制两份：
 * - 跨域 CDN 素材（线上是绝对 http(s) URL）必须 `crossOrigin='anonymous'`，
 *   否则 canvas 被污染、toDataURL 直接抛；同源 `/static/*`（dev 的 vite 代理）
 *   反而要跳过——那个源不回 `Access-Control-Allow-Origin`，而同源绘制本就不会污染。
 * - 第一次 seek 前要等 `loadeddata`（至少有一帧可用），否则首帧画出来是黑的。
 * - 每一步都要有超时：`seeked` 在部分容器/编码上可能永远不来，没有兜底的话
 *   面板会一直停在「提取画面帧中…」，而且那个隐藏 <video> 也不会被回收。
 *
 * 结果按 (src, count) 缓存：剪辑面板和重拍轨道会反复挂载/卸载（LOD、切模式），
 * 每次重来都要 8 次 seek + 解码，是这个面板最贵的一笔开销。只缓存「抽满 count 帧」
 * 的成功结果，超时降级的半条带子和失败都不进缓存，好让下次挂载能重试。
 */
export async function captureVideoFrames(
  src: string,
  count: number,
): Promise<string[]> {
  const key = cacheKey(src, count);
  const cached = cache.get(key);
  if (cached) return await cached;

  const pending = captureUncached(src, count);
  cache.set(key, pending);
  try {
    const frames = await pending;
    if (frames.length < count) {
      // 降级结果不留缓存，下次挂载还有机会抽全。
      cache.delete(key);
    } else if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done && oldest.value !== key) cache.delete(oldest.value);
    }
    return frames;
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}

/** 丢掉某条素材的缩略图缓存（视频被替换/重生成时用）。不传就整体清空。 */
export function clearVideoFrameCache(src?: string): void {
  if (!src) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.slice(key.indexOf('|') + 1) === src) cache.delete(key);
  }
}

function captureUncached(src: string, count: number): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('canvas context unavailable'));
      return;
    }

    const thumbs: string[] = [];
    let settled = false;
    let seekTimer: ReturnType<typeof setTimeout> | null = null;
    let overallTimer: ReturnType<typeof setTimeout> | null = null;

    const onError = () => fail('video element error');
    const onLoadedData = () => start();
    const onSeeked = () => captureCurrent();

    const teardown = () => {
      if (seekTimer !== null) clearTimeout(seekTimer);
      seekTimer = null;
      if (overallTimer !== null) clearTimeout(overallTimer);
      overallTimer = null;
      video.removeEventListener('error', onError);
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('seeked', onSeeked);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignored
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      teardown();
      resolve(thumbs);
    };

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      teardown();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    // 抽到一半超时也把已有的帧交出去：半条带子比一句「加载失败」有用得多。
    const onTimeout = () => {
      if (thumbs.length > 0) finish();
      else fail('thumbnail extraction timed out');
    };

    overallTimer = setTimeout(onTimeout, CAPTURE_TIMEOUT_MS);

    let index = 0;

    const seekNext = (duration: number) => {
      if (seekTimer !== null) clearTimeout(seekTimer);
      if (index >= count) {
        finish();
        return;
      }
      const t = (duration * (index + 0.5)) / count;
      // 单帧 seek 不回来就收工，不跳过它继续往后抽：那个 `seeked` 迟到时会把
      // 一张对不上位置的帧插进来，带子顺序就乱了。宁可交一条短的。
      seekTimer = setTimeout(onTimeout, SEEK_TIMEOUT_MS);
      video.currentTime = Math.min(Math.max(t, 0), Math.max(0, duration - 0.05));
    };

    const captureCurrent = () => {
      if (settled) return;
      if (seekTimer !== null) {
        clearTimeout(seekTimer);
        seekTimer = null;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
      } catch (error) {
        fail(error);
        return;
      }
      index += 1;
      seekNext(video.duration);
    };

    const start = () => {
      if (settled) return;
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        fail('invalid duration for thumbnails');
        return;
      }
      const targetWidth = 160;
      const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * ratio));
      seekNext(duration);
    };

    video.addEventListener('error', onError);
    video.addEventListener('loadeddata', onLoadedData);
    video.addEventListener('seeked', onSeeked);

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored — `src` assignment already kicks off the fetch in most browsers
    }
  });
}
