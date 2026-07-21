// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Persisting + resuming task_key-based generations across page reloads.
//
// Most canvas generations (image / video / audio / 3D / script / 反推提示词) submit
// a freezone job, get a `FreezoneJobRef`, then `await awaitTaskCompletion(task_key)`.
// That promise lives only in memory, so a page refresh used to drop the progress
// bar and stop polling entirely. We fix this by persisting the task identity on the
// node (so the 生成中 overlay re-appears from `generationStartedAt`) and re-attaching
// to the task API on reload via {@link resumeNodeGeneration}.

import type { CanvasNode, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  fetchFreezoneJobResult,
  fetchFreezoneReversePromptResult,
  fetchFreezoneStoryScriptResult,
  type FreezoneJobRef,
} from '@/api/ops';
import { awaitTaskCompletion, listTasks, type TaskState } from '@/api/tasks';
import { resolveErrorContent } from '@/features/canvas/application/errorDialog';
import { providerErrorMessage } from '@/lib/api-errors';
import { extractRequestId } from '@/features/canvas/application/generationErrorReport';
import {
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';

type FreezoneTaskType = FreezoneJobRef['task_type'];

/**
 * The persisted handle that lets a refreshed page re-attach to a running job.
 * `generationTaskJobId` is intentionally separate from `generationJobId` — the
 * latter belongs to the canvasAiGateway image-job poller in Canvas.tsx and must
 * not be confused with a freezone task job id.
 */
export interface GenerationTaskDescriptor {
  generationTaskKey: string;
  generationTaskType: FreezoneTaskType;
  generationTaskJobId: string;
  // Index signature so the descriptor spreads cleanly into updateNodeData's
  // Partial<CanvasNodeData> union (some node-data members carry index signatures).
  [key: string]: unknown;
}

// Task keys whose awaitTaskCompletion promise is already owned by an in-session
// submit flow. The resume scanner must skip these — re-calling awaitTaskCompletion
// for the same key would overwrite the original resolver and strand that promise.
// This set is empty on a fresh page load, so persisted-but-orphaned tasks resume.
const sessionOwnedTaskKeys = new Set<string>();

/**
 * Build the patch that records a freezone job on a node right after submit so the
 * generation can be resumed after a refresh. Spread alongside the
 * `{ isGenerating: true, generationStartedAt }` patch each flow already writes.
 *
 * Also marks the task key as session-owned so {@link nodeNeedsGenerationResume}
 * won't double-attach while the originating flow is still awaiting it.
 */
export function generationTaskDescriptor(ref: FreezoneJobRef): GenerationTaskDescriptor {
  sessionOwnedTaskKeys.add(ref.task_key);
  return {
    generationTaskKey: ref.task_key,
    generationTaskType: ref.task_type,
    generationTaskJobId: ref.job_id,
  };
}

type ResumeKind = 'image' | 'video' | 'audio' | 'ply' | 'script' | 'reverse-prompt';

function resumeKindForNodeType(type: CanvasNodeType): ResumeKind | null {
  switch (type) {
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.exportImage:
      return 'image';
    case CANVAS_NODE_TYPES.video:
      return 'video';
    case CANVAS_NODE_TYPES.audio:
      return 'audio';
    case CANVAS_NODE_TYPES.threeDWorld:
      return 'ply';
    case CANVAS_NODE_TYPES.script:
      return 'script';
    case CANVAS_NODE_TYPES.textAnnotation:
      return 'reverse-prompt';
    default:
      return null;
  }
}

function resolveUrlFromResult(
  result: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!result) return null;
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Mirror ThreeDWorldNode's pickPlyUrlFromResult so 3D scenes resume the same way.
function pickPlyUrlFromResult(result: TaskState['result'] | undefined): string | null {
  if (!result) return null;
  const candidates: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (/\.(ply|sog|splat|ksplat|spz)(\?|#|$)/i.test(value) || /scene_3gs|ply_fs|splat/i.test(value)) {
        candidates.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(result, 0);
  const sog = candidates.find((c) => /\.sog(\?|#|$)/i.test(c));
  if (sog) return sog;
  const packaged = candidates.find((c) => /\.(ksplat|splat|spz)(\?|#|$)/i.test(c));
  if (packaged) return packaged;
  const ply = candidates.find((c) => /\.ply(\?|#|$)/i.test(c));
  if (ply) return ply;
  return candidates[0] ?? null;
}

/** Fields cleared on every settle so the node leaves the 生成中 state cleanly. */
const CLEARED_TASK_FIELDS = {
  isGenerating: false,
  generationStartedAt: null,
  generationTaskKey: null,
  generationTaskType: null,
  generationTaskJobId: null,
} as const;

async function buildSuccessPatch(
  kind: ResumeKind,
  completed: TaskState,
  taskType: FreezoneTaskType,
  jobId: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case 'image': {
      let url = resolveUrlFromResult(completed.result, ['output_url', 'image_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS, generationError: '生成未返回结果' };
      }
      return { ...CLEARED_TASK_FIELDS, imageUrl: url, previewImageUrl: url, generationError: null };
    }
    case 'video': {
      let url = resolveUrlFromResult(completed.result, ['video_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS, generationError: '视频生成未返回结果' };
      }
      return {
        ...CLEARED_TASK_FIELDS,
        videoUrl: url,
        sourceFileName: null,
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      };
    }
    case 'audio': {
      let url = resolveUrlFromResult(completed.result, ['audio_url', 'output_url', 'url']);
      if (!url && jobId) {
        url = await fetchFreezoneJobResult(projectId, taskType, jobId).then((r) => r.url).catch(() => null);
      }
      if (!url) {
        return { ...CLEARED_TASK_FIELDS };
      }
      return { ...CLEARED_TASK_FIELDS, audioUrl: url, durationMs: null };
    }
    case 'ply': {
      const plyUrl = pickPlyUrlFromResult(completed.result);
      if (!plyUrl) {
        return { ...CLEARED_TASK_FIELDS, taskKey: null, errorMessage: '生成失败: 未能在 task.result 中找到 3D 世界地址' };
      }
      return { ...CLEARED_TASK_FIELDS, plyUrl, taskKey: null, errorMessage: null };
    }
    case 'script': {
      const result = await fetchFreezoneStoryScriptResult(projectId, jobId);
      return { ...CLEARED_TASK_FIELDS, scriptResult: result, scriptTitle: result.title ?? null };
    }
    case 'reverse-prompt': {
      const { prompt } = await fetchFreezoneReversePromptResult(projectId, jobId);
      if (prompt && prompt.trim().length > 0) {
        return { ...CLEARED_TASK_FIELDS, content: prompt };
      }
      return { ...CLEARED_TASK_FIELDS };
    }
    default:
      return { ...CLEARED_TASK_FIELDS };
  }
}

function buildErrorPatch(kind: ResumeKind, error: unknown): Record<string, unknown> {
  if (kind === 'ply') {
    const message = error instanceof Error ? error.message : String(error);
    return { ...CLEARED_TASK_FIELDS, taskKey: null, errorMessage: `生成失败: ${message}` };
  }
  if (kind === 'image' || kind === 'video') {
    const resolved = resolveErrorContent(error, kind === 'video' ? '视频生成失败' : '图像生成失败');
    const rawMessage = resolved.message;
    return {
      ...CLEARED_TASK_FIELDS,
      generationError: providerErrorMessage(rawMessage) ?? rawMessage,
      generationErrorDetails: resolved.details ?? rawMessage,
      generationErrorRequestId:
        extractRequestId(rawMessage) ?? extractRequestId(resolved.details),
    };
  }
  // audio / script / reverse-prompt surface their own inline errors elsewhere;
  // just leave the 生成中 state.
  return { ...CLEARED_TASK_FIELDS };
}

/**
 * Re-attach to a running freezone task for a node that came back from storage
 * still flagged `isGenerating`. Resolves the result and writes it onto the node,
 * or records the failure — mirroring each flow's own success/error handling.
 *
 * Returns once the task settles (or is found to no longer exist). Safe to call
 * once per node; callers should dedupe.
 */
export async function resumeNodeGeneration(params: {
  node: CanvasNode;
  projectId: string;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  getNodeData?: (id: string) => Record<string, unknown> | null | undefined;
}): Promise<void> {
  const { node, projectId, updateNodeData, getNodeData } = params;
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  const taskType =
    typeof data.generationTaskType === 'string' ? (data.generationTaskType as FreezoneTaskType) : null;
  const jobId = typeof data.generationTaskJobId === 'string' ? data.generationTaskJobId : '';
  const kind = resumeKindForNodeType(node.type as CanvasNodeType);

  if (!taskKey || !taskType || !kind) {
    return;
  }

  const readLatestNodeData = () =>
    getNodeData?.(node.id)
    ?? (node.data as Record<string, unknown>);

  // Quick pre-check: if the task no longer exists server-side (expired/cleaned),
  // avoid hanging on the 20-minute poll timeout — clear the stuck 生成中 state now.
  try {
    const tasks = await listTasks(projectId);
    const found = tasks.find((task) => task.task_key === taskKey);
    if (!found) {
      const latestNodeData = readLatestNodeData();
      if (isStaleGenerationTask({ nodeData: latestNodeData, taskKey })) {
        return;
      }

      updateNodeData(node.id, buildErrorPatch(kind, new Error('生成任务已结束或不存在')));
      return;
    }
  } catch {
    // List failed (transient/offline) — fall through to awaitTaskCompletion,
    // which has its own poll + timeout handling.
  }

  try {
    const completed = await awaitTaskCompletion(taskKey, projectId);
    updateNodeData(node.id, await buildSuccessPatch(kind, completed, taskType, jobId, projectId));
  } catch (error) {
    console.warn('[resume-generation] task resume failed', { nodeId: node.id, taskKey, error });
    if (kind === 'image' || kind === 'video') {
      const latestNodeData = readLatestNodeData();
      if (isStaleGenerationTask({ nodeData: latestNodeData, taskKey })) {
        return;
      }
      if (!shouldWriteGenerationError({ nodeData: latestNodeData, taskKey, error })) {
        updateNodeData(node.id, { ...CLEARED_TASK_FIELDS });
        return;
      }
    }

    updateNodeData(node.id, buildErrorPatch(kind, error));
  }
}

/**
 * Whether a node restored from storage needs {@link resumeNodeGeneration}. Returns
 * false for tasks already being awaited by an in-session flow (see
 * {@link sessionOwnedTaskKeys}).
 */
export function nodeNeedsGenerationResume(node: CanvasNode): boolean {
  const data = node.data as Record<string, unknown>;
  const taskKey = typeof data.generationTaskKey === 'string' ? data.generationTaskKey : '';
  return data.isGenerating === true && taskKey.length > 0 && !sessionOwnedTaskKeys.has(taskKey);
}
