// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const AUDIO_SPLIT_MAX_SEGMENTS = 24;
export const AUDIO_SPLIT_MIN_SEGMENT_MS = 100;

export interface AudioSplitSegment {
  startMs: number;
  endMs: number;
}

export interface AudioSplitAnalysis {
  durationMs: number;
  segments: AudioSplitSegment[];
  detectedSilenceCount: number;
  limited: boolean;
}

export type CustomAudioSplitValidation =
  | { ok: true; segments: AudioSplitSegment[] }
  | {
      ok: false;
      reason:
        | 'duration-unknown'
        | 'points-required'
        | 'invalid-point'
        | 'range-too-short'
        | 'too-many-segments';
    };

export function buildCustomAudioSegments(
  rawPoints: string,
  durationMs: number | null | undefined,
): CustomAudioSplitValidation {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, reason: 'duration-unknown' };
  }
  const tokens = rawPoints
    .split(/[\s,，;；]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: 'points-required' };

  const points = tokens.map((token) => Math.round(Number(token) * 1000));
  if (
    points.some(
      (point) => !Number.isFinite(point) || point <= 0 || point >= Math.round(durationMs),
    )
  ) {
    return { ok: false, reason: 'invalid-point' };
  }
  const uniquePoints = [...new Set(points)].sort((left, right) => left - right);
  if (uniquePoints.length + 1 > AUDIO_SPLIT_MAX_SEGMENTS) {
    return { ok: false, reason: 'too-many-segments' };
  }
  const boundaries = [0, ...uniquePoints, Math.round(durationMs)];
  const segments = boundaries.slice(0, -1).map((startMs, index) => ({
    startMs,
    endMs: boundaries[index + 1],
  }));
  if (segments.some((segment) => segment.endMs - segment.startMs < AUDIO_SPLIT_MIN_SEGMENT_MS)) {
    return { ok: false, reason: 'range-too-short' };
  }
  return { ok: true, segments };
}

export function analysisFromSeconds(input: {
  durationSec: number;
  segments: Array<{ startSec: number; endSec: number }>;
  detectedSilenceCount: number;
  limited: boolean;
}): AudioSplitAnalysis | null {
  if (!Number.isFinite(input.durationSec) || input.durationSec <= 0) return null;
  const durationMs = Math.round(input.durationSec * 1000);
  const segments = input.segments.map((segment) => ({
    startMs: Math.round(segment.startSec * 1000),
    endMs: Math.round(segment.endSec * 1000),
  }));
  if (
    segments.length === 0 ||
    segments.length > AUDIO_SPLIT_MAX_SEGMENTS ||
    segments[0].startMs !== 0 ||
    segments[segments.length - 1]?.endMs !== durationMs ||
    segments.some(
      (segment, index) =>
        segment.endMs <= segment.startMs ||
        segment.startMs < 0 ||
        segment.endMs > durationMs ||
        (index > 0 && segment.startMs !== segments[index - 1].endMs),
    )
  ) {
    return null;
  }
  return {
    durationMs,
    segments,
    detectedSilenceCount: input.detectedSilenceCount,
    limited: input.limited,
  };
}
