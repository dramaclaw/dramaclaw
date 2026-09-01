// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneUpscale,
  type FreezoneUpscaleScaleFactor,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isUploadNode,
  resolveNodeSourceImageUrl,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

export const UPSCALE_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type UpscaleImageSize = (typeof UPSCALE_IMAGE_SIZES)[number];
export const DEFAULT_UPSCALE_IMAGE_SIZE: UpscaleImageSize = '2K';

export const UPSCALE_SCALE_FACTORS: readonly FreezoneUpscaleScaleFactor[] = [2, 4, 6];
export const DEFAULT_UPSCALE_SCALE_FACTOR: FreezoneUpscaleScaleFactor = 2;

/** 工作流预建节点默认写入的模型 id（SelectedNodeOverlay 原硬编码值）。 */
export const DEFAULT_UPSCALE_MODEL_ID = 'newapi_gpt_image2';

/**
 * 预建「高清放大」结果节点（从 SelectedNodeOverlay.handleOpenUpscale 原样搬出，
 * 语义零变化）：在源图片节点下游建一个 resultKind:'upscale' 的 exportImage 占位
 * 节点并连边——不提交任务。工作流入口随后选中它以展开 UpscaleEditorOverlay 配置
 * 面板；故事板详情在详情内选好配置后直接对它调 {@link submitImageUpscale}。
 *
 * @returns 新建占位节点 id；源节点不存在 / 类型不支持 / 无图源时返回 null。
 */
export function createUpscaleResultNode(
  sourceNodeId: string,
  opts: {
    displayName: string;
    modelId?: string;
    imageSize?: UpscaleImageSize;
    scaleFactor?: FreezoneUpscaleScaleFactor;
  },
): string | null {
  const store = useCanvasStore.getState();
  const sourceNode = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!sourceNode) {
    return null;
  }
  if (
    !isUploadNode(sourceNode)
    && !isImageEditNode(sourceNode)
    && !isImageGenNode(sourceNode)
    && !isExportImageNode(sourceNode)
  ) {
    return null;
  }
  // 与工具栏 canHandleImage / 其它图片工具一致，用统一 helper 取图源
  // ——它能识别 imageGen 节点（含 referenceImageUrl 兜底）。
  const sourceImageUrl = resolveNodeSourceImageUrl(sourceNode);
  if (!sourceImageUrl) {
    return null;
  }

  const sourceAspectRatio =
    typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    sourceNode.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const placeholderNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: sourceImageUrl,
      aspectRatio: sourceAspectRatio,
      resultKind: 'upscale',
      isGenerating: false,
      // Persist enough to (re-)run the upscale and to drive the always-attached panel.
      upscaleSourceUrl: sourceImageUrl,
      upscaleModelId: opts.modelId ?? DEFAULT_UPSCALE_MODEL_ID,
      upscaleImageSize: opts.imageSize ?? DEFAULT_UPSCALE_IMAGE_SIZE,
      upscaleScaleFactor: opts.scaleFactor ?? DEFAULT_UPSCALE_SCALE_FACTOR,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(sourceNode.id, placeholderNodeId);
  return placeholderNodeId;
}

/**
 * 高清放大提交编排（从 UpscaleEditorOverlay.handleSubmit 原样搬出，语义零变化）：
 * 对结果节点置 isGenerating → 提交 /freezone/upscale → 等任务完成（output_url
 * 缺失时回退 job result）→ 把产物 url 回填到该节点；失败把错误写到该节点。
 *
 * @returns 后台链 settle 时 resolve 的 Promise（不 reject）；缺 sourceUrl 或
 *   缺 project 时不落任何状态、返回 null。
 */
export function submitImageUpscale(
  nodeId: string,
  opts: {
    sourceUrl: string;
    scaleFactor: FreezoneUpscaleScaleFactor;
    imageSize: string;
    model: string;
  },
): Promise<void> | null {
  if (!opts.sourceUrl) {
    console.error('[upscale] missing source url — cannot submit');
    return null;
  }
  const project = readUrl().project;
  if (!project) {
    console.error('[upscale] no project in URL — cannot submit');
    return null;
  }

  const generationStartedAt = Date.now();
  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt,
    generationError: null,
  });

  return (async () => {
    try {
      const ref = await submitFreezoneUpscale(project, {
        sourceUrl: opts.sourceUrl.split('?')[0],
        scaleFactor: opts.scaleFactor,
        imageSize: opts.imageSize,
        model: opts.model,
      });
      useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project);
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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[upscale] generation failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();
}
