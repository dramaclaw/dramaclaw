// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { parseAspectRatio } from '../domain/aspectRatio';

export interface ImageNodeSize {
  width: number;
  height: number;
}

export interface ImageNodeMinSize {
  minWidth: number;
  minHeight: number;
}

function roundPositive(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.round(value));
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(roundPositive(left));
  let b = Math.abs(roundPositive(right));
  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return Math.max(1, a);
}

export function aspectRatioFromImageDimensions(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const roundedWidth = roundPositive(width);
  const roundedHeight = roundPositive(height);
  const divisor = greatestCommonDivisor(roundedWidth, roundedHeight);
  return `${Math.round(roundedWidth / divisor)}:${Math.round(roundedHeight / divisor)}`;
}

export function shouldForceNaturalImageSize(data: Record<string, unknown>): boolean {
  const outputRole = typeof data.output_role === 'string' ? data.output_role : '';
  if (outputRole === 'current_sketch_candidate' || outputRole === 'current_frame_candidate') {
    return true;
  }
  const slotTarget = data.slot_target && typeof data.slot_target === 'object'
    ? data.slot_target as Record<string, unknown>
    : null;
  const slotKind = typeof slotTarget?.kind === 'string' ? slotTarget.kind : '';
  if (slotKind === 'sketch' || slotKind === 'frame') {
    return true;
  }
  const source = data.__freezone_source && typeof data.__freezone_source === 'object'
    ? data.__freezone_source as Record<string, unknown>
    : null;
  const sourceRole = typeof source?.role === 'string' ? source.role : '';
  if (sourceRole === 'current_sketch' || sourceRole === 'current_frame') {
    return true;
  }
  const contexts = Array.isArray(data.mainline_context) ? data.mainline_context : [];
  return contexts.some((context) => {
    if (!context || typeof context !== 'object') {
      return false;
    }
    const kind = (context as Record<string, unknown>).kind;
    return kind === 'sketch' || kind === 'frame';
  });
}

export function resolveAspectRatioValue(aspectRatio: string): number {
  return Math.max(0.1, parseAspectRatio(aspectRatio));
}

function resolveMinSizeByRatio(
  ratio: number,
  constraints: ImageNodeMinSize
): ImageNodeSize {
  const safeRatio = Math.max(0.1, ratio);
  const minWidth = roundPositive(constraints.minWidth);
  const minHeight = roundPositive(constraints.minHeight);
  const minRatio = minWidth / Math.max(1, minHeight);

  if (safeRatio >= minRatio) {
    return {
      width: roundPositive(minHeight * safeRatio),
      height: minHeight,
    };
  }

  return {
    width: minWidth,
    height: roundPositive(minWidth / safeRatio),
  };
}

export function resolveMinEdgeFittedSize(
  aspectRatio: string,
  constraints: ImageNodeMinSize
): ImageNodeSize {
  const ratio = resolveAspectRatioValue(aspectRatio);
  return resolveMinSizeByRatio(ratio, constraints);
}

export function resolveResizeMinConstraintsByAspect(
  aspectRatio: string,
  constraints: ImageNodeMinSize
): ImageNodeMinSize {
  // 把基准 min 当作「最小短边」，按图片比例换算出互相自洽的最小宽高。配合
  // keepAspectRatio：宽屏图片高为绑定约束、竖屏图片宽为绑定约束，节点能缩到一个
  // 一致的小框，而不是被两个独立的 min 卡成过大的最小框。
  const fitted = resolveMinEdgeFittedSize(aspectRatio, constraints);
  return { minWidth: fitted.width, minHeight: fitted.height };
}

export function resolveSizeInsideTargetBox(
  aspectRatio: string,
  target: ImageNodeSize
): ImageNodeSize {
  const ratio = resolveAspectRatioValue(aspectRatio);
  const targetWidth = roundPositive(target.width);
  const targetHeight = roundPositive(target.height);
  const targetRatio = targetWidth / Math.max(1, targetHeight);

  if (ratio >= targetRatio) {
    return {
      width: targetWidth,
      height: roundPositive(targetWidth / ratio),
    };
  }

  return {
    width: roundPositive(targetHeight * ratio),
    height: targetHeight,
  };
}

export function ensureAtLeastOneMinEdge(
  size: ImageNodeSize,
  constraints: ImageNodeMinSize
): ImageNodeSize {
  const minWidth = roundPositive(constraints.minWidth);
  const minHeight = roundPositive(constraints.minHeight);
  const width = roundPositive(size.width);
  const height = roundPositive(size.height);
  const ratio = width / Math.max(1, height);

  if (width >= minWidth && height >= minHeight) {
    return { width, height };
  }

  return resolveMinSizeByRatio(ratio, { minWidth, minHeight });
}
