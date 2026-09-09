// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneRedraw,
  type FreezoneRedrawAspectRatio,
} from '@/api/ops';
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';

import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { canvasAiGateway } from './canvasServices';
import { resolveErrorContent } from './errorDialog';
import { CURRENT_RUNTIME_SESSION_ID, extractRequestId } from './generationErrorReport';
import type { GenerateImagePayload } from './ports';
import { generationTaskDescriptor } from './resumeGeneration';

/**
 * Params persisted on an export node created by the 擦除 / 重绘 flow, so a failed
 * node can re-run its freezone `redraw` call without the overlay being mounted.
 */
interface FreezoneRedrawRequest {
  sourceUrl: string;
  maskUrl: string;
  aspectRatio: string;
  imageSize: string;
}

function readFreezoneRedrawRequest(
  data: Record<string, unknown>,
): FreezoneRedrawRequest | undefined {
  const req = data.freezoneRedrawRequest as Partial<FreezoneRedrawRequest> | undefined;
  if (!req || typeof req.sourceUrl !== 'string' || typeof req.maskUrl !== 'string') {
    return undefined;
  }
  return {
    sourceUrl: req.sourceUrl,
    maskUrl: req.maskUrl,
    aspectRatio: typeof req.aspectRatio === 'string' ? req.aspectRatio : 'original',
    imageSize: typeof req.imageSize === 'string' ? req.imageSize : '2K',
  };
}

/** Retry a failed 擦除/重绘 export node by re-running its stored freezone redraw. */
async function regenerateFreezoneRedrawNode(
  nodeId: string,
  request: FreezoneRedrawRequest,
): Promise<void> {
  const store = useCanvasStore.getState();
  const project = readUrl().project;
  if (!project) {
    store.updateNodeData(nodeId, { generationError: i18n.t('canvas.generation.missingProjectRetry') });
    return;
  }

  store.updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });

  try {
    const ref = await submitFreezoneRedraw(project, {
      sourceUrl: request.sourceUrl,
      maskUrl: request.maskUrl,
      aspectRatio: request.aspectRatio as FreezoneRedrawAspectRatio,
      numImages: 1,
      imageSize: request.imageSize,
    });
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      imageUrl: url,
      previewImageUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
    });
  } catch (error) {
    // Detached ≠ failed. The job may still land, and the descriptor written
    // above is the only way back to it — keep isGenerating and the handle so
    // resumeNodeGeneration re-attaches on the next load. Clearing them here
    // would strand a result the backend still produces.
    if (isTaskPollTimeoutError(error)) {
      console.warn('[regenerate] detached from a still-running redraw', {
        nodeId,
        taskKey: error.taskKey,
        idleMs: error.idleMs,
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[regenerate] freezone redraw failed', error);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
    });
  }
}

/**
 * Re-submit the generation that produced an export-result node, after it failed.
 *
 * Export nodes don't run their own submit loop — their parent (ImageEdit /
 * StoryboardGen) submits a job and stores the jobId, then Canvas.tsx polls it.
 * To retry without the parent being mounted/selected we persist the original
 * `generationRequestPayload` on the node at creation; here we re-submit it and
 * re-arm `generationJobId` so the existing Canvas polling effect picks it up.
 */
export async function regenerateExportImageNode(nodeId: string): Promise<void> {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((n) => n.id === nodeId);
  if (!node) {
    return;
  }

  const data = node.data as Record<string, unknown>;
  if (data.isGenerating === true) {
    return;
  }

  const freezoneRequest = readFreezoneRedrawRequest(data);
  if (freezoneRequest) {
    await regenerateFreezoneRedrawNode(nodeId, freezoneRequest);
    return;
  }

  const payload = data.generationRequestPayload as GenerateImagePayload | undefined;
  if (!payload) {
    console.warn('[regenerate] export node has no stored payload, cannot retry', nodeId);
    return;
  }

  store.updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationJobId: null,
    generationError: null,
    generationErrorDetails: null,
    generationErrorRequestId: null,
  });

  try {
    const { jobId, ref } = await canvasAiGateway.submitGenerateImageJob({ ...payload, nodeId });
    store.updateNodeData(nodeId, {
      generationJobId: jobId,
      generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
      // 与上面的重绘路径同口径：句柄落到节点上，脱离监听后刷新才接得回来。
      ...generationTaskDescriptor(ref),
    });
  } catch (error) {
    const resolved = resolveErrorContent(error, i18n.t('canvas.resumeGeneration.imageFailed'));
    store.updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationJobId: null,
      generationError: resolved.message,
      generationErrorDetails: resolved.details ?? null,
      generationErrorRequestId:
        extractRequestId(resolved.message) ?? extractRequestId(resolved.details),
    });
  }
}

/** Whether an export node has enough stored state to be regenerated. */
export function canRegenerateExportImageNode(data: Record<string, unknown>): boolean {
  return Boolean(data.generationRequestPayload) || Boolean(readFreezoneRedrawRequest(data));
}
