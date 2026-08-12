// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { mediaNeedsCrossOrigin } from '@/features/canvas/application/imageData';

/**
 * 均匀抽 N 帧做缩略图条，走隐藏 <video> + <canvas>。
 *
 * 从 VideoClipPanel 抽出来共用 —— 片段重拍的时间轨道要的是同一条缩略图带，
 * 复制一份会连带把下面这些踩过的坑复制两份：
 * - 跨域 CDN 素材（线上是绝对 http(s) URL）必须 `crossOrigin='anonymous'`，
 *   否则 canvas 被污染、toDataURL 直接抛；同源 `/static/*`（dev 的 vite 代理）
 *   反而要跳过——那个源不回 `Access-Control-Allow-Origin`，而同源绘制本就不会污染。
 * - 第一次 seek 前要等 `loadeddata`（至少有一帧可用），否则首帧画出来是黑的。
 */
export async function captureVideoFrames(
  src: string,
  count: number,
): Promise<string[]> {
  return await new Promise((resolve, reject) => {
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

    const cleanup = () => {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignored
      }
    };

    const fail = (reason: unknown) => {
      cleanup();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    video.addEventListener('error', () => fail('video element error'));

    video.addEventListener('loadeddata', () => {
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) {
        fail('invalid duration for thumbnails');
        return;
      }
      const targetWidth = 160;
      const ratio = video.videoHeight / Math.max(video.videoWidth, 1);
      canvas.width = targetWidth;
      canvas.height = Math.max(1, Math.round(targetWidth * ratio));

      const thumbs: string[] = [];
      let index = 0;

      const seekNext = () => {
        if (index >= count) {
          cleanup();
          resolve(thumbs);
          return;
        }
        const t = (duration * (index + 0.5)) / count;
        video.currentTime = Math.min(Math.max(t, 0), Math.max(0, duration - 0.05));
      };

      video.addEventListener('seeked', () => {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumbs.push(canvas.toDataURL('image/jpeg', 0.6));
        } catch (error) {
          fail(error);
          return;
        }
        index += 1;
        seekNext();
      });

      seekNext();
    });

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored — `src` assignment already kicks off the fetch in most browsers
    }
  });
}
