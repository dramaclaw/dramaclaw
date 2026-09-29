// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { AudioNodeData, AudioTransformBinding } from '@/features/canvas/domain/canvasNodes';

export const AUDIO_TRANSFORM_MIN_SPEED = 0.5;
export const AUDIO_TRANSFORM_MAX_SPEED = 2;
export const AUDIO_TRANSFORM_MIN_DURATION_MS = 100;

export interface AudioTransformDraft {
  startMs: number;
  endMs: number;
  speed: number;
}

export type AudioTransformValidation =
  | { ok: true; value: AudioTransformDraft }
  | {
      ok: false;
      reason: 'duration-unknown' | 'invalid-range' | 'range-too-short' | 'invalid-speed';
    };

export function validateAudioTransform(
  draft: AudioTransformDraft,
  sourceDurationMs: number | null | undefined,
): AudioTransformValidation {
  if (
    typeof sourceDurationMs !== 'number' ||
    !Number.isFinite(sourceDurationMs) ||
    sourceDurationMs <= 0
  ) {
    return { ok: false, reason: 'duration-unknown' };
  }
  const startMs = Math.round(draft.startMs);
  const endMs = Math.round(draft.endMs);
  const speed = Number(draft.speed.toFixed(2));
  if (startMs < 0 || endMs > Math.round(sourceDurationMs) || endMs <= startMs) {
    return { ok: false, reason: 'invalid-range' };
  }
  if (endMs - startMs < AUDIO_TRANSFORM_MIN_DURATION_MS) {
    return { ok: false, reason: 'range-too-short' };
  }
  if (
    !Number.isFinite(speed) ||
    speed < AUDIO_TRANSFORM_MIN_SPEED ||
    speed > AUDIO_TRANSFORM_MAX_SPEED
  ) {
    return { ok: false, reason: 'invalid-speed' };
  }
  return { ok: true, value: { startMs, endMs, speed } };
}

export function transformedAudioDurationMs(draft: AudioTransformDraft): number {
  return Math.max(1, Math.round((draft.endMs - draft.startMs) / draft.speed));
}

export function buildAudioTransformNodeData(args: {
  sourceNodeId: string;
  sourceAudioUrl: string;
  sourceData: AudioNodeData;
  draft: AudioTransformDraft;
  displayName: string;
}): AudioNodeData {
  const binding: AudioTransformBinding = {
    version: 1,
    sourceNodeId: args.sourceNodeId,
    sourceAudioUrl: args.sourceAudioUrl,
    startMs: args.draft.startMs,
    endMs: args.draft.endMs,
    speed: args.draft.speed,
  };
  return {
    audioUrl: null,
    sourceFileName: `${args.displayName}.m4a`,
    displayName: args.displayName,
    durationMs: transformedAudioDurationMs(args.draft),
    audioKind: args.sourceData.audioKind,
    audioTransform: binding,
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  };
}
