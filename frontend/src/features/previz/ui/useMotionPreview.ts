// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, type RefObject } from 'react';

import type { PrevizCharacterDraft } from '../domain/characterDraft';
import type { EvaluatedMotion } from '../domain/evaluate';
import type { CameraPreviewCanvas } from '../engine/cameraPreview';

/** 预览按 30 fps 推时间：离屏渲染一次不便宜，跟着显示器跑到 120 Hz 纯属浪费。 */
const PREVIEW_FRAME_MS = 1000 / 30;

export type PrevizMotionPreviewRender = (
  canvas: CameraPreviewCanvas,
  draft: PrevizCharacterDraft,
  motion: EvaluatedMotion,
) => void;

/**
 * 拿人物草稿在画布上循环播一条动作，从 0 秒开始。单次动作播完也从头来：预览是给人看清
 * 动作的，不是看定格。`ref` 为 null（还没选）时什么都不画。
 *
 * 第 0 秒那一帧在 effect 里同步画：选中的反馈要立刻出来，不等下一个动画帧。
 */
export function useMotionPreview(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  draft: PrevizCharacterDraft,
  ref: string | null,
  durationSec: number,
  render: PrevizMotionPreviewRender,
): void {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || ref === null) return;
    const draw = (elapsedSec: number) =>
      render(canvas, draft, { primary: { ref, time: elapsedSec % durationSec }, weight: 1 });
    draw(0);
    if (typeof requestAnimationFrame !== 'function') return;
    const startedAt = performance.now();
    let lastDrawn = startedAt;
    let handle = requestAnimationFrame(function tick(now) {
      if (now - lastDrawn >= PREVIEW_FRAME_MS) {
        lastDrawn = now;
        draw((now - startedAt) / 1000);
      }
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, [canvasRef, draft, ref, durationSec, render]);
}
