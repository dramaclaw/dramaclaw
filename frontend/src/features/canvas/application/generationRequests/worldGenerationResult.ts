// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../../core/environment';
import { isThreeDWorldNode, type CanvasNode, type ThreeDWorldNodeData } from '../../domain/canvasNodes';
import { mergeDirectorWorldSources, sourceFromImageTo3gsResult } from '../../domain/directorWorldSources';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import { generationTaskDescriptor } from '../generationTaskDescriptor';
import type { WorldGenerationPreparedRequest } from './worldGenerationRequest';

type WorldOutput = { plyUrl?: string; panoUrl?: string };
type WorldPatch = Partial<ThreeDWorldNodeData>;

/** Start uses the captured render's sources; it retains previous URLs unless adding raw pano. */
export function worldGenerationStartPatch(input: {
  request: WorldGenerationPreparedRequest; data: ThreeDWorldNodeData; startedAtMs: number;
}): WorldPatch {
  const { request, data, startedAtMs } = input;
  const { sourceNodeId, sourceKind, sourceUrl, rawPanoSource } = request;
  return {
    isGenerating: true, generationStartedAt: startedAtMs, errorMessage: null,
    sourceNodeId, sourceKind: 'image', plyKind: sourceKind, previewImageUrl: sourceUrl,
    ...(rawPanoSource ? {
      sources: mergeDirectorWorldSources(data.sources ?? [], rawPanoSource),
      activeSourceId: rawPanoSource.id ?? null,
      panoUrl: rawPanoSource.pano_url ?? rawPanoSource.url ?? null,
    } : {}),
  };
}

export function worldGenerationAcceptedPatch(ref: { task_key: string; task_type: string; job_id: string }): WorldPatch {
  return { taskKey: ref.task_key, ...generationTaskDescriptor(ref) };
}

/**
 * generatedId is allocated by the caller's completion clock. Read currentSources
 * after waiting, not from the initial request. No stale-task arbitration is added.
 * Success keeps generationStartedAt and the descriptor, clears only taskKey,
 * and sets panoUrl to null for a non-pano run even if a previous pano existed.
 * A missing URL follows the ordinary failure path with the supplied label.
 */
export function worldGenerationSuccessPatch(input: {
  result: unknown;
  generatedId: string;
  sourceKind: WorldGenerationPreparedRequest['sourceKind'];
  rawPanoSource: DirectorWorldSource | null;
  currentSources: DirectorWorldSource[];
  labels: { pano3dgs: string; image3dgs: string; worldUrlMissing: string };
}): { kind: 'completed'; patch: WorldPatch; output: WorldOutput } | { kind: 'missing_world_url'; message: string } {
  const { result, generatedId, sourceKind, rawPanoSource, currentSources, labels } = input;
  const generatedSource = sourceFromImageTo3gsResult(result, {
    id: generatedId, sourceKind, label: sourceKind === 'pano' ? labels.pano3dgs : labels.image3dgs,
  });
  if (!generatedSource) return { kind: 'missing_world_url', message: labels.worldUrlMissing };
  const nextPlyUrl = generatedSource.ply_url ?? generatedSource.url ?? null;
  const nextPanoUrl = rawPanoSource?.pano_url ?? rawPanoSource?.url ?? null;
  return { kind: 'completed', patch: {
    sources: mergeDirectorWorldSources(currentSources, rawPanoSource, generatedSource),
    activeSourceId: generatedSource.id ?? null, plyUrl: nextPlyUrl, panoUrl: nextPanoUrl,
    isGenerating: false, taskKey: null, errorMessage: null,
  }, output: {
    ...(nextPlyUrl ? { plyUrl: nextPlyUrl } : {}),
    ...(nextPanoUrl ? { panoUrl: nextPanoUrl } : {}),
  } };
}

/** Timeout leaves all node fields alone; ordinary failures retain the descriptor and start time. */
export function worldGenerationFailureOutcome(
  outcome: { kind: 'poll_timeout' } | { kind: 'failed'; message: string },
  translate: CanvasEnvironment['translate'],
): { patches: WorldPatch[]; notice: 'still_running' | null } {
  if (outcome.kind === 'poll_timeout') return { patches: [], notice: 'still_running' };
  return { patches: [{ isGenerating: false, taskKey: null,
    errorMessage: translate('node.threeDWorld.generateFailed', { message: outcome.message }),
  }], notice: null };
}

/** The subscriber prefers latest truthy string URLs, even after a silent refusal or timeout. */
export function worldGenerationActionResult(input:
  { output: WorldOutput; latestNode: CanvasNode | undefined } | { error: string },
): { status: 'success'; output: WorldOutput } | { status: 'error'; error: string } {
  if ('error' in input) return { status: 'error', error: input.error };
  const latestData = isThreeDWorldNode(input.latestNode) ? input.latestNode.data : null;
  const latestPlyUrl = typeof latestData?.plyUrl === 'string' ? latestData.plyUrl : undefined;
  const latestPanoUrl = typeof latestData?.panoUrl === 'string' ? latestData.panoUrl : undefined;
  return { status: 'success', output: {
    ...(input.output.plyUrl ? { plyUrl: input.output.plyUrl } : {}),
    ...(input.output.panoUrl ? { panoUrl: input.output.panoUrl } : {}),
    ...(latestPlyUrl ? { plyUrl: latestPlyUrl } : {}),
    ...(latestPanoUrl ? { panoUrl: latestPanoUrl } : {}),
  } };
}
