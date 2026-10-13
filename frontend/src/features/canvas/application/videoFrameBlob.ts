// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { mediaNeedsCrossOrigin } from './imageData';

/**
 * Render a single frame from a video URL into a PNG blob using an offscreen
 * <video>. Cross-origin CDN media (absolute http(s) URL, the production case)
 * must load with CORS, otherwise drawing it to the canvas taints it and
 * `toBlob` throws. Same-origin /static (the dev vite proxy) skips crossOrigin
 * since that origin doesn't echo Access-Control-Allow-Origin and isn't tainted.
 *
 * 从 VideoNode 的私有实现原样搬出（工作流截帧与故事板详情截帧共用）。单独成模块
 * 而不是并进 videoCaptureFrame.ts：那边的编排要在测试里跑，而这里真的要一个能
 * 解码的浏览器（jsdom 下 <video> 永远不会 loadeddata），必须能被整体替身掉。
 */
export async function captureVideoFrameBlob(
  src: string,
  seekSec: number,
): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = 'anonymous';

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
    video.addEventListener(
      'loadeddata',
      () => {
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
          fail('invalid video duration');
          return;
        }
        const targetTime = Math.max(0, Math.min(seekSec, Math.max(0, duration - 0.05)));
        video.addEventListener(
          'seeked',
          () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
              fail('canvas context unavailable');
              return;
            }
            try {
              ctx.drawImage(video, 0, 0);
            } catch (error) {
              fail(error);
              return;
            }
            canvas.toBlob((blob) => {
              cleanup();
              if (blob) resolve(blob);
              else reject(new Error('canvas.toBlob returned null'));
            }, 'image/png');
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
}
