// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  FreezoneJobRef,
  FreezoneJobResult,
  FreezoneVideoComposePayload,
  FreezoneVideoComposeResolution,
} from '@/api/ops';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';

export const CREATIVE_INTRO_BLEND_DURATION_SEC = 5;

export interface CreativeIntroBlendRange {
  startSec: number;
  endSec: number;
  keyframeOffsetSec: number;
}

export interface CreativeIntroBlendCapability {
  modelId: string;
  modelLabel: string;
  genMode: 'allReference';
}

function includesFiveSeconds(min: number | null | undefined, max: number | null | undefined) {
  if (typeof min === 'number' && min > CREATIVE_INTRO_BLEND_DURATION_SEC) return false;
  if (typeof max === 'number' && max < CREATIVE_INTRO_BLEND_DURATION_SEC) return false;
  return true;
}

/**
 * A blended intro cannot silently fall back to image-only generation. Require
 * an explicit catalog contract for both media kinds and the fixed duration.
 */
export function resolveCreativeIntroBlendCapability(
  models: readonly ModelOption[],
): CreativeIntroBlendCapability | null {
  const model = models.find(
    (candidate) =>
      candidate.supportedModes?.includes('all_reference') === true &&
      typeof candidate.referenceImageMax === 'number' &&
      candidate.referenceImageMax >= 1 &&
      typeof candidate.referenceVideoMax === 'number' &&
      candidate.referenceVideoMax >= 1 &&
      includesFiveSeconds(candidate.minDuration, candidate.maxDuration) &&
      includesFiveSeconds(candidate.referenceVideoMinSeconds, candidate.referenceVideoMaxSeconds) &&
      includesFiveSeconds(
        candidate.referenceVideoTotalMinSeconds,
        candidate.referenceVideoTotalMaxSeconds,
      ),
  );
  return model
    ? { modelId: model.id, modelLabel: model.label, genMode: 'allReference' }
    : null;
}

export function creativeIntroBlendStartBounds(
  frameSec: number,
  sourceDurationSec: number,
): { min: number; max: number } | null {
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec < CREATIVE_INTRO_BLEND_DURATION_SEC) {
    return null;
  }
  const safeFrame = Math.min(Math.max(frameSec, 0), sourceDurationSec);
  return {
    min: Math.max(0, safeFrame - CREATIVE_INTRO_BLEND_DURATION_SEC),
    max: Math.min(safeFrame, sourceDurationSec - CREATIVE_INTRO_BLEND_DURATION_SEC),
  };
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Keep the title keyframe inside the source interval while preserving 5.000s. */
export function normalizeCreativeIntroBlendRange(
  requestedStartSec: number,
  frameSec: number,
  sourceDurationSec: number,
): CreativeIntroBlendRange | null {
  const bounds = creativeIntroBlendStartBounds(frameSec, sourceDurationSec);
  if (!bounds) return null;
  const safeRequested = Number.isFinite(requestedStartSec) ? requestedStartSec : bounds.min;
  const startSec = roundMillis(Math.min(Math.max(safeRequested, bounds.min), bounds.max));
  const endSec = roundMillis(startSec + CREATIVE_INTRO_BLEND_DURATION_SEC);
  return {
    startSec,
    endSec,
    keyframeOffsetSec: roundMillis(Math.min(Math.max(frameSec - startSec, 0), 5)),
  };
}

export function buildCreativeIntroBlendComposePayload(input: {
  sourceNodeId: string;
  sourceUrl: string;
  range: CreativeIntroBlendRange;
  resolution: FreezoneVideoComposeResolution;
  canvasId?: string | null;
}): FreezoneVideoComposePayload {
  return {
    title: 'creative-intro-source-clip',
    canvasId: input.canvasId ?? undefined,
    resolution: input.resolution,
    fps: 30,
    keepOriginalAudio: true,
    tracks: [
      {
        trackId: `track_${input.sourceNodeId}_creative_intro`,
        kind: 'video',
        items: [
          {
            itemId: `item_${input.sourceNodeId}_creative_intro`,
            sourceUrl: input.sourceUrl,
            timelineStart: 0,
            sourceStart: input.range.startSec,
            sourceEnd: input.range.endSec,
          },
        ],
      },
    ],
  };
}

export interface RenderCreativeIntroBlendClipDeps {
  submit: (projectId: string, payload: FreezoneVideoComposePayload) => Promise<FreezoneJobRef>;
  awaitCompletion: (taskKey: string, projectId: string, taskType: string) => Promise<unknown>;
  fetchResult: (
    projectId: string,
    taskType: 'freezone_video_compose',
    jobId: string,
  ) => Promise<FreezoneJobResult>;
}

/**
 * Render the source excerpt before mutating the graph. A failed local FFmpeg
 * job therefore cannot leave a half-connected creative-intro workflow behind.
 */
export async function renderCreativeIntroBlendClip(
  deps: RenderCreativeIntroBlendClipDeps,
  input: {
    projectId: string;
    sourceNodeId: string;
    sourceUrl: string;
    range: CreativeIntroBlendRange;
    resolution: FreezoneVideoComposeResolution;
    canvasId?: string | null;
  },
): Promise<string> {
  const ref = await deps.submit(
    input.projectId,
    buildCreativeIntroBlendComposePayload(input),
  );
  await deps.awaitCompletion(ref.task_key, input.projectId, ref.task_type);
  const result = await deps.fetchResult(
    input.projectId,
    'freezone_video_compose',
    ref.job_id,
  );
  if (!result.url) throw new Error('Creative-intro source clip completed without an output URL.');
  return result.url;
}
