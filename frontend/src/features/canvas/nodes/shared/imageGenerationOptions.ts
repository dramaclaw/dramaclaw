// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ImageQuality, ImageSize } from '@/features/canvas/domain/canvasNodes';
import {
  parseAspectRatio,
  pickClosestAspectRatio,
} from '@/features/canvas/application/imageData';

/**
 * 图片生成的比例/分辨率/画质的**内置兜底选项**。
 *
 * 统一计费（#210）之后这三档优先由媒体目录（admin 后台可配的 `ratioOptions` /
 * `resolutionOptions` / `qualityOptions`）驱动，这里的常量只在目录没声明时兜底。
 *
 * 放在独立模块而不是留在 `ImageGenerationForm` 里，是因为 `useImageGenerationForm`
 * 也要用同一份兜底来算 `effectiveImageSize` / `effectiveAspectRatio`——两边各拷一份
 * 迟早会分叉，而分叉的表现是「chip 上显示的比例」与「提交下发的比例」不一致。
 */
export const IMAGE_ASPECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '自适应' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
  { value: '21:9', label: '21:9' },
];

export const IMAGE_SIZE_OPTIONS: ReadonlyArray<ImageSize> = ['1K', '2K', '4K'];

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
