// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import type { FreezoneVideoProbe } from '@/api/ops';
import { availableVideoUpscaleResolutions } from '@/features/canvas/domain/videoUpscaleResolutions';

describe('availableVideoUpscaleResolutions', () => {
  const probe: FreezoneVideoProbe = {
    width: 1280,
    height: 720,
    fps: 24,
    duration: 10,
    upscale_resolutions: ['1080p', '2k', '4k'],
    frame_rate_resolutions: ['1080p', '2k'],
  };

  it('uses the upscale model options at original speed and intersects frame-rate options when needed', () => {
    expect(availableVideoUpscaleResolutions(probe, false)).toEqual(['1080p', '2k', '4k']);
    expect(availableVideoUpscaleResolutions(probe, true)).toEqual(['1080p', '2k']);
  });

  it('excludes configured tiers that do not improve the source video', () => {
    expect(availableVideoUpscaleResolutions({ ...probe, width: 1920, height: 1080 }, false))
      .toEqual(['2k', '4k']);
    expect(availableVideoUpscaleResolutions({ ...probe, width: 2560, height: 1440 }, true))
      .toEqual([]);
    expect(availableVideoUpscaleResolutions(null, false)).toEqual([]);
  });
});
