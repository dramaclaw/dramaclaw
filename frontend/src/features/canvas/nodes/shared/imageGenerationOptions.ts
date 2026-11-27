// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ImageQuality } from '@/features/canvas/domain/canvasNodes';
import { parseAspectRatio, pickClosestAspectRatio } from '../../domain/aspectRatio';
import { IMAGE_ASPECT_OPTIONS } from '../../domain/imageGenerationOptions';
export { IMAGE_ASPECT_OPTIONS, IMAGE_SIZE_OPTIONS } from '../../domain/imageGenerationOptions';

export const IMAGE_QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: 'low', label: '低画质' },
  { value: 'medium', label: '标准画质' },
  { value: 'high', label: '高画质' },
];

/**
 * 图片按自然尺寸算出的比例常是约分形式（如 21:9 会被约成 7:3），不在可选列表里，
 * 直接显示就会出现「7:3」这种列表外的标签。这里退回到「数值最接近的可选比例」
 * ——chip 标签与下拉里的高亮选项都基于它，保证两边一致。
 */
export function resolveNearestAspectOption(
  aspectRatio: string,
  options: ReadonlyArray<{ value: string; label: string }> = IMAGE_ASPECT_OPTIONS,
): { value: string; label: string } {
  const exact = options.find((option) => option.value === aspectRatio);
  if (exact) return exact;
  const candidates = options.filter((option) => option.value !== 'auto');
  const nearestValue = pickClosestAspectRatio(
    parseAspectRatio(aspectRatio),
    candidates.map((option) => option.value),
  );
  return (
    candidates.find((option) => option.value === nearestValue)
    ?? { value: aspectRatio, label: aspectRatio }
  );
}
