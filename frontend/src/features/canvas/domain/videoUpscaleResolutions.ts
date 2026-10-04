// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezoneVideoProbe, FreezoneVideoUpscaleResolution } from '@/api/ops';

const RESOLUTION_LONG_EDGE: Record<FreezoneVideoUpscaleResolution, number> = {
  '1080p': 1920,
  '2k': 2560,
  '4k': 3840,
};

const RESOLUTIONS = Object.keys(RESOLUTION_LONG_EDGE) as FreezoneVideoUpscaleResolution[];

export function availableVideoUpscaleResolutions(
  probe: FreezoneVideoProbe | null,
  needsFrameRate: boolean,
): FreezoneVideoUpscaleResolution[] {
  if (!probe) return [];
  const sourceLongEdge = Math.max(probe.width, probe.height);
  const upscaleOptions = new Set(probe.upscale_resolutions);
  const frameRateOptions = new Set(probe.frame_rate_resolutions);
  return RESOLUTIONS.filter((value) =>
    RESOLUTION_LONG_EDGE[value] > sourceLongEdge
    && upscaleOptions.has(value)
    && (!needsFrameRate || frameRateOptions.has(value)),
  );
}
