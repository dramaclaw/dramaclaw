// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneScene360,
  type FreezoneScene360AspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

const PANO_VIEWER_LAYOUT_WIDTH = 720;
const PANO_VIEWER_LAYOUT_HEIGHT = 420;

export interface Scene360ImageResult {
  /** 新建的 exportImage 全景候选节点 id。 */
  nodeId: string;
  /** 后台链（提交 → 轮询 → 回填 + 建 360 查看器 / 写错）settle 时 resolve（不 reject）。 */
  completion: Promise<void>;
}

/**
 * 全景生成编排（从 Scene360Overlay.handleSubmit 原样搬出，语义零变化）：
 * 同步在源节点下游建 isGenerating 的 exportImage 全景候选节点
 * （output_role:'scene_360_candidate' / media_kind:'pano360'）并连边，然后提交
 * /freezone/scene-360 → 等任务完成 → 回填产物 url，并在候选节点下游建
 * pano360Viewer 查看器节点连边；失败把错误写到候选节点。
 *
 * @returns 候选节点 id + 后台链 completion；缺 project 或源节点已不存在时返回 null。
 */
export function scene360Image(
  sourceNodeId: string,
  imageSource: string,
  opts: {
    displayName: string;
    aspectRatio: FreezoneScene360AspectRatio;
  },
): Scene360ImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[scene-360] no project in URL — cannot submit');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const generationStartedAt = Date.now();
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: opts.aspectRatio,
      resultKind: 'generic',
      output_role: 'scene_360_candidate',
      media_kind: 'pano360',
      isGenerating: true,
      generationStartedAt,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);

  const completion = (async () => {
    try {
      const ref = await submitFreezoneScene360(project, {
        referenceUrl: imageSource.split('?')[0],
        aspectRatio: opts.aspectRatio,
      });
      useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project);
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      const doneStore = useCanvasStore.getState();
      doneStore.updateNodeData(nextNodeId, {
        imageUrl: url,
        previewImageUrl: url,
        aspectRatio: opts.aspectRatio,
        output_role: 'scene_360_candidate',
        media_kind: 'pano360',
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });

      const viewerPosition = doneStore.findNodePosition(
        nextNodeId,
        PANO_VIEWER_LAYOUT_WIDTH,
        PANO_VIEWER_LAYOUT_HEIGHT,
      );
      const viewerNodeId = doneStore.addNode(
        CANVAS_NODE_TYPES.pano360Viewer,
        viewerPosition,
      );
      doneStore.addEdge(nextNodeId, viewerNodeId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[scene-360] generation failed', err);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}
