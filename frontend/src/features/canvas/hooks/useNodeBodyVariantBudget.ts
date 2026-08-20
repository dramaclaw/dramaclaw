// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useStore } from '@xyflow/react';

import { nodeBodyRequiredEdge } from '@/features/canvas/application/imageData';
import { MEDIA_VARIANT_MAX_EDGE, pickMediaVariant, type MediaVariant } from '@/lib/media-url';
import { useDevicePixelRatio } from '@/lib/useDevicePixelRatio';

/**
 * 这个节点的主体图该按多大的长边预算去挑副本。
 *
 * 返回的不是「需要多少像素」的原始值，而是它落在阶梯上的那一档（320 / 640 /
 * 1280），一档都盖不住时返回 Infinity——nodeBodyImageSrc 拿到它会交回原图。
 *
 * 之所以先量化再返回：原始值随 zoom 每一帧都在变，而节点订阅的是这个 selector
 * 的结果。量化之后取值只有四个，缩放全程最多重渲染两次、换两次 src，且两次都命
 * 中缓存。这条线原本就是节点为了躲开「平移每帧重渲染」而只订阅布尔值的那条线，
 * 沿用同一个手法。
 */
export function useNodeBodyVariant(display: {
  width: number;
  height: number;
}): MediaVariant | null {
  const devicePixelRatio = useDevicePixelRatio();
  return useStore((state) =>
    pickMediaVariant(nodeBodyRequiredEdge(display, state.transform[2], devicePixelRatio)),
  );
}

export function useNodeBodyVariantBudget(display: {
  width: number;
  height: number;
}): number {
  const variant = useNodeBodyVariant(display);
  return variant === null ? Number.POSITIVE_INFINITY : MEDIA_VARIANT_MAX_EDGE[variant];
}
