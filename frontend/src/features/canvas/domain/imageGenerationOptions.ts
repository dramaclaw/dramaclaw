// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ImageSize } from './canvasNodes';

/** Shared form defaults when a model declares no aspect or resolution options. */
export const IMAGE_ASPECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '自适应' }, // i18n-exempt -- label moved verbatim from shared options
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
