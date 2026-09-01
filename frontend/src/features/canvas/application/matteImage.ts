// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { matteInWorker } from './matteClient';

export interface MatteImageResult {
  /** 新建的 exportImage 结果节点 id。 */
  nodeId: string;
  /** 后台去背链（fetch → worker → 上传 → 回填/写错）settle 时 resolve（不 reject）。 */
  completion: Promise<void>;
}

/**
 * 抠图编排（从 NodeActionToolbar.handleMatteImage 原样搬出，语义零变化）：
 * 立即在源节点下游建一个 isGenerating 的 exportImage 结果节点并连边/选中，然后
 * 在自建 Worker 里去背 → 上传 → 把结果 url 回填到结果节点；失败把错误写到该节点。
 * 工作流节点工具栏与故事板详情工具条共用这一条路径。
 *
 * @param nodeId 源图片节点 id（用于取 aspectRatio / 主线继承字段与摆位）。
 * @param imageSource 源图片 url（调用方已用 resolveNodeSourceImageUrl 解析）。
 * @param options.displayName 结果节点标题（工作流传 t('nodeToolbar.matting')）。
 * @returns 结果节点 id + 后台链 completion（详情工具条用它收 busy 态）；
 *   缺 project 或源节点已不存在时返回 null。
 */
export function matteImage(
  nodeId: string,
  imageSource: string,
  options?: { displayName?: string },
): MatteImageResult | null {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return null;
  }
  const projectId = readUrl().project;
  if (!projectId) {
    console.warn(
      '[matte] no project_id in URL (?p=<project_id>) — cannot persist matted PNG',
    );
    return null;
  }

  const sourceAspectRatio =
    typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((node.data as { aspectRatio?: string }).aspectRatio ?? '1:1')
      : '1:1';
  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  // Same inheritance contract as the spawn-style overlays — matting produces a
  // user_spawned exportImage child that still represents the same canonical
  // slot at Push time.
  const matteInitialData = inheritMainlineFields(
    { data: node.data as Record<string, unknown> },
    {
      displayName: options?.displayName ?? '抠图',
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: sourceAspectRatio,
      resultKind: 'matte',
      isGenerating: true,
      generationStartedAt: Date.now(),
    },
  );
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    matteInitialData as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);
  store.setSelectedNode(nextNodeId);
  store.requestFocusNode(nextNodeId);

  const sourceUrl = imageSource;
  const completion = (async () => {
    try {
      const sourceResp = await fetch(sourceUrl);
      if (!sourceResp.ok) {
        throw new Error(`fetch source failed: ${sourceResp.status}`);
      }
      const sourceBlob = await sourceResp.blob();
      // 整段去背在自建 Worker 内执行(见 matteClient / matteWorker):无论 WebGPU
      // 是否可用,主线程都不阻塞,点击抠图后画布保持流畅。
      const mattedBlob = await matteInWorker(sourceBlob);
      const filename = `matte-${node.id}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(projectId, mattedBlob, filename);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (error) {
      console.error('[matte] failed', error);
      const message = error instanceof Error ? error.message : String(error);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}
