// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  analysisFromSeconds,
  buildCustomAudioSegments,
} from '@/features/canvas/application/audioSplit';

describe('audio split', () => {
  it('sorts and deduplicates custom cut points into continuous segments', () => {
    expect(buildCustomAudioSegments('8, 2.5；8', 10_000)).toEqual({
      ok: true,
      segments: [
        { startMs: 0, endMs: 2_500 },
        { startMs: 2_500, endMs: 8_000 },
        { startMs: 8_000, endMs: 10_000 },
      ],
    });
  });

  it('rejects out-of-range and too-close custom cut points', () => {
    expect(buildCustomAudioSegments('0', 10_000)).toEqual({
      ok: false,
      reason: 'invalid-point',
    });
    expect(buildCustomAudioSegments('0.05', 10_000)).toEqual({
      ok: false,
      reason: 'range-too-short',
    });
  });

  it('accepts only continuous smart-analysis payloads', () => {
    expect(analysisFromSeconds({
      durationSec: 6,
      segments: [
        { startSec: 0, endSec: 2.5 },
        { startSec: 2.5, endSec: 6 },
      ],
      detectedSilenceCount: 1,
      limited: false,
    })).toEqual({
      durationMs: 6_000,
      segments: [
        { startMs: 0, endMs: 2_500 },
        { startMs: 2_500, endMs: 6_000 },
      ],
      detectedSilenceCount: 1,
      limited: false,
    });
    expect(analysisFromSeconds({
      durationSec: 6,
      segments: [{ startSec: 1, endSec: 6 }],
      detectedSilenceCount: 0,
      limited: false,
    })).toBeNull();
  });
});
