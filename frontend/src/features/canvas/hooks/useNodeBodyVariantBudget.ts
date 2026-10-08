// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useStore } from '@xyflow/react';
import { useState } from 'react';

import { nodeBodyRequiredEdge } from '@/features/canvas/application/imageData';
import { MEDIA_VARIANT_MAX_EDGE, type MediaVariant } from '@/lib/media-url';
import { useDevicePixelRatio } from '@/lib/useDevicePixelRatio';
import { chooseStableCanvasTier } from '@/features/canvas/application/canvasPreviewPolicy';

/**
 * 这个节点的主体图该按多大的长边预算去挑副本。
 *
 * 返回 320/640/1280 档位或原图，缩小降档留出余量以避免边界反复换图。
 *
 * 之所以先量化再返回：原始值随 zoom 每一帧都在变，而节点订阅的是这个 selector
 * 的结果。只有跨过档位边界时才重渲染、切换 src。这条
 * 线原本就是节点为了躲开「平移每帧重渲染」而只订阅布尔值的那条线，沿用同一个
 * 手法。
 */
export function useNodeBodyVariant(display: {
  width: number;
  height: number;
}): MediaVariant | null {
  const devicePixelRatio = useDevicePixelRatio();
  const [previous, setPrevious] = useState<MediaVariant | null>();
  const variant = useStore((state) =>
    chooseStableCanvasTier(previous, nodeBodyRequiredEdge(display, state.transform[2], devicePixelRatio)),
  );
  // Derived state belongs to this hook; the store selector remains read-only.
  if (variant !== previous) setPrevious(variant);
  return variant;
}

export function useNodeBodyVariantBudget(display: {
  width: number;
  height: number;
}): number {
  const variant = useNodeBodyVariant(display);
  return variant === null ? Number.POSITIVE_INFINITY : MEDIA_VARIANT_MAX_EDGE[variant];
}
