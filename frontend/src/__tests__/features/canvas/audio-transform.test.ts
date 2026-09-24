// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  buildAudioTransformNodeData,
  transformedAudioDurationMs,
  validateAudioTransform,
} from '@/features/canvas/application/audioTransform';

describe('audio transform contract', () => {
  it('normalizes a valid range and speed', () => {
    expect(validateAudioTransform({ startMs: 1000.4, endMs: 5000.4, speed: 1.249 }, 8000))
      .toEqual({ ok: true, value: { startMs: 1000, endMs: 5000, speed: 1.25 } });
  });

  it('rejects unknown duration, short ranges, overflow, and unsupported speeds', () => {
    expect(validateAudioTransform({ startMs: 0, endMs: 1000, speed: 1 }, null)).toEqual({
      ok: false,
      reason: 'duration-unknown',
    });
    expect(validateAudioTransform({ startMs: 0, endMs: 99, speed: 1 }, 1000)).toEqual({
      ok: false,
      reason: 'range-too-short',
    });
    expect(validateAudioTransform({ startMs: 0, endMs: 1001, speed: 1 }, 1000)).toEqual({
      ok: false,
      reason: 'invalid-range',
    });
    expect(validateAudioTransform({ startMs: 0, endMs: 1000, speed: 2.1 }, 1000)).toEqual({
      ok: false,
      reason: 'invalid-speed',
    });
  });

  it('derives output duration from source span and playback speed', () => {
    expect(transformedAudioDurationMs({ startMs: 1000, endMs: 5000, speed: 2 })).toBe(2000);
    expect(transformedAudioDurationMs({ startMs: 1000, endMs: 5000, speed: 0.5 })).toBe(8000);
  });

  it('builds a traceable derived audio node without copying the source URL as output', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    const data = buildAudioTransformNodeData({
      sourceNodeId: 'source-1',
      sourceAudioUrl: '/static/u/p/source.mp3',
      sourceData: { audioUrl: '/static/u/p/source.mp3', audioKind: 'music' },
      draft: { startMs: 1000, endMs: 5000, speed: 2 },
      displayName: '片段 · 2×',
    });
    expect(data).toMatchObject({
      audioUrl: null,
      durationMs: 2000,
      audioKind: 'music',
      isGenerating: true,
      generationStartedAt: 1234,
      audioTransform: {
        version: 1,
        sourceNodeId: 'source-1',
        sourceAudioUrl: '/static/u/p/source.mp3',
        startMs: 1000,
        endMs: 5000,
        speed: 2,
      },
    });
  });
});
