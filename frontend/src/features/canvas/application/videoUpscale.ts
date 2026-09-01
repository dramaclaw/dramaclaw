// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoUpscale,
  type FreezoneVideoUpscaleDenoise,
  type FreezoneVideoUpscaleResolution,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';
import { notifyTaskStillRunning } from './errorDialog';

export const VIDEO_UPSCALE_RESOLUTIONS: FreezoneVideoUpscaleResolution[] = [
  '1080p',
  '2k',
  '4k',
];
export const VIDEO_UPSCALE_RESOLUTION_LABEL: Record<FreezoneVideoUpscaleResolution, string> = {
  '1080p': '1080P',
  '2k': '2K',
  '4k': '4K',
};
export const VIDEO_UPSCALE_DENOISE_OPTIONS: FreezoneVideoUpscaleDenoise[] = [
  'none',
  '1x',
  '2x',
];

/**
 * 在源视频下游建「高清」结果节点（payload 与 NodeActionToolbar.handleVideoUpscale
 * 一致：复用 video 节点的播放器/角标/尺寸，打 isUpscaleNode 标记）。不切换选中态——
 * 工作流入口选中新节点是为了展开 VideoUpscaleEditorOverlay 配置面板；故事板详情的
 * 配置在详情内完成后直接提交，无需该面板。
 *
 * @returns 新建结果节点 id；源节点已不存在时返回 null。
 */
export function createVideoUpscaleResultNode(
  sourceNodeId: string,
  opts: {
    sourceUrl: string;
    displayName: string;
    resolution: FreezoneVideoUpscaleResolution;
    denoise: FreezoneVideoUpscaleDenoise;
  },
): string | null {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }
  const videoData = node.data as Record<string, unknown>;
  const position = store.findNodePosition(node.id, 580, 380);
  const upscaleNodeId = store.addNode(
    CANVAS_NODE_TYPES.video,
    position,
    {
      displayName: opts.displayName,
      videoUrl: null,
      previewImageUrl:
        typeof videoData.previewImageUrl === 'string' ? videoData.previewImageUrl : null,
      aspectRatio:
        typeof videoData.aspectRatio === 'string' ? videoData.aspectRatio : '16:9',
      isUpscaleNode: true,
      upscaleSourceUrl: opts.sourceUrl,
      upscaleResolution: opts.resolution,
      upscaleDenoise: opts.denoise,
      isGenerating: false,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, upscaleNodeId);
  return upscaleNodeId;
}

/**
 * 视频高清提交编排（从 VideoUpscaleEditorOverlay.handleSubmit 原样搬出，语义零变化）：
 * 对 isUpscaleNode 结果节点置 isGenerating → 提交 /freezone/video/upscale →
 * 等任务完成（output_url 缺失时回退 job result）→ 把产物 videoUrl 回填到该节点；
 * 失败把错误写到该节点。project/canvasId 取自当前 URL。
 */
export async function submitVideoUpscale(
  nodeId: string,
  opts: {
    sourceUrl: string;
    resolution: FreezoneVideoUpscaleResolution;
    denoise: FreezoneVideoUpscaleDenoise;
  },
): Promise<void> {
  const project = readUrl().project;
  if (!project) {
    console.error('[video-upscale] no project in URL — cannot submit');
    return;
  }
  const canvasId = readUrl().canvas ?? 'default';

  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });

  try {
    const ref = await submitFreezoneVideoUpscale(project, {
      sourceUrl: opts.sourceUrl.split('?')[0],
      resolution: opts.resolution,
      frameInterpolation: 'none',
      denoiseStrength: opts.denoise,
      canvasId,
      nodeId,
    });
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project, {
      taskType: ref.task_type,
    });
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      videoUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    });
  } catch (err) {
    if (isTaskPollTimeoutError(err)) {
      notifyTaskStillRunning();
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[video-upscale] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}
