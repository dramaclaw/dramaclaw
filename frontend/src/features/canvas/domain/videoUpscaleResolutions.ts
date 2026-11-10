// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneVideoProbe, FreezoneVideoUpscaleResolution } from '@/api/ops';

export const VIDEO_UPSCALE_RESOLUTIONS: FreezoneVideoUpscaleResolution[] = [
  '1080p',
  '2k',
  '4k',
];
export const VIDEO_UPSCALE_RESOLUTION_LABEL: Record<FreezoneVideoUpscaleResolution, string> = {
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K',
};

const RESOLUTION_LONG_EDGE: Record<FreezoneVideoUpscaleResolution, number> = {
  '1080p': 1920,
  '2k': 2560,
  '4k': 3840,
};

export function availableVideoUpscaleResolutions(
  probe: FreezoneVideoProbe | null,
  needsFrameRate: boolean,
): FreezoneVideoUpscaleResolution[] {
  if (!probe) return [];
  const sourceLongEdge = Math.max(probe.width, probe.height);
  const upscaleOptions = new Set(probe.upscale_resolutions);
  const frameRateOptions = new Set(probe.frame_rate_resolutions);
  return VIDEO_UPSCALE_RESOLUTIONS.filter((value) =>
    RESOLUTION_LONG_EDGE[value] > sourceLongEdge
    && upscaleOptions.has(value)
    && (!needsFrameRate || frameRateOptions.has(value)),
  );
}
