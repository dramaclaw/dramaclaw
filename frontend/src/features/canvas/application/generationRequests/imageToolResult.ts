// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES } from '../../domain/canvasNodes';
import { generationTaskDescriptor } from '../generationTaskDescriptor';
import type { ImageGenerationTaskRef } from './imageGenerationResult';
import type { ImageToolAction, ImageToolLayout } from './imageToolRequest';

/** The subscriber keeps these task fields on both success and failure. */
export function imageToolAcceptedPatch(task: ImageGenerationTaskRef) {
  return generationTaskDescriptor(task);
}

/**
 * Only output_url is read. Null/undefined requests a job-result lookup; an empty
 * string is already a resolved URL. Caller performs the lookup and propagates
 * its rejection as an ordinary failure; even an empty fetched url is successful.
 */
export function imageToolOutputResolution(input: {
  result: { output_url?: string | null } | null | undefined;
  task: ImageGenerationTaskRef;
}): { kind: 'resolved'; url: string } | { kind: 'fetch_job_result'; task_type: string; job_id: string } {
  const url = input.result?.output_url;
  return url == null
    ? { kind: 'fetch_job_result', task_type: input.task.task_type, job_id: input.task.job_id }
    : { kind: 'resolved', url };
}

/** No task-handle, diagnostic, source-name or stale-result fields are cleared. */
export function imageToolSuccessPatch(input: { action: ImageToolAction; url: string }): Record<string, unknown> {
  return {
    imageUrl: input.url, previewImageUrl: input.url,
    ...(input.action === 'run_scene360_tool' ? {
      aspectRatio: '2:1', output_role: 'scene_360_candidate', media_kind: 'pano360',
    } : {}),
    isGenerating: false, generationStartedAt: null, generationError: null,
  };
}

/** Raw Error.message / String(thrown), including cancellation and poll timeout. */
export function imageToolFailurePatch(message: string): Record<string, unknown> {
  return { isGenerating: false, generationStartedAt: null, generationError: message };
}

/** After the scene image success write, allocate a viewer without an addNode data argument. */
export function imageToolViewerPlan(input: { action: ImageToolAction; childNodeId: string }): {
  node: { type: typeof CANVAS_NODE_TYPES.pano360Viewer; layout: ImageToolLayout };
  edge: { source: string; target: 'viewer' };
} | null {
  return input.action === 'run_scene360_tool' ? {
    node: { type: CANVAS_NODE_TYPES.pano360Viewer, layout: { anchorNodeId: input.childNodeId, width: 720, height: 420 } },
    edge: { source: input.childNodeId, target: 'viewer' },
  } : null;
}

export type ImageToolActionResultInput = { message: string } | ({
  childNodeId: string;
  url: string;
  task: ImageGenerationTaskRef;
} & (
  | { action: 'run_scene360_tool'; viewerNodeId: string }
  | { action: Exclude<ImageToolAction, 'run_scene360_tool'> }
));

/** Request id, source node id and action envelope belong to the caller. */
export function imageToolActionResult(input: ImageToolActionResultInput):
  | { status: 'success'; output: Record<string, unknown> }
  | { status: 'error'; error: string } {
  if ('message' in input) return { status: 'error', error: input.message };
  return { status: 'success', output: {
    nodeId: input.childNodeId,
    ...(input.action === 'run_scene360_tool' ? { viewerNodeId: input.viewerNodeId } : {}),
    imageUrl: input.url, previewImageUrl: input.url,
    task_key: input.task.task_key, job_id: input.task.job_id,
  } };
}
