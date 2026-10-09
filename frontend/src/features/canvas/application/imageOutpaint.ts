// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneOutpaint,
  type FreezoneOutpaintAspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

export const OUTPAINT_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type OutpaintImageSize = (typeof OUTPAINT_IMAGE_SIZES)[number];

export const OUTPAINT_ASPECT_RATIOS: readonly FreezoneOutpaintAspectRatio[] = [
  'original',
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
];

// 数量 > 1 时多个结果节点纵向错开摆放的间距。
const RESULT_STACK_GAP = 24;

export interface OutpaintImageResult {
  /** 新建的 exportImage 结果节点 id（数量 N 时按纵向摆放顺序）。 */
  nodeIds: string[];
  /** 全部单图链（提交 → 轮询 → 回填/写错）settle 时 resolve（不 reject）。 */
  completion: Promise<void>;
}

/**
 * 扩图提交编排（从 OutpaintEditorOverlay.handleSubmit 原样搬出，语义零变化）：
 * 同步在源节点下游建 N 个 isGenerating 的 exportImage 结果节点（纵向错开）并连边
 * ——后端 outpaint 单次仅出 1 张，选了 N 张就发起 N 次单图请求，每个节点各自独立
 * 轮询 / 回填 / 报错。结果节点经 inheritMainlineFields 继承主线字段（1→1 outpaint
 * 语义：新节点仍代表同一 canonical slot 的另一候选）。
 *
 * @returns 结果节点 id 列表 + 后台链 completion；缺 project 或源节点已不存在时
 *   返回 null（不落任何状态）。
 */
export function outpaintImage(
  sourceNodeId: string,
  imageSource: string,
  opts: {
    displayName: string;
    targetAspectRatio: FreezoneOutpaintAspectRatio;
    imageSize: string;
    numImages: number;
    model: string;
  },
): OutpaintImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[outpaint] no project in URL — cannot submit');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const sourceAspectRatio =
    typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const base = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );

  const count = Math.max(1, opts.numImages);
  const nodeIds = Array.from({ length: count }, (_unused, i) => {
    const generationStartedAt = Date.now();
    // 1→1 outpaint: inherit source's mainline fields so the new node still
    // resolves to the same canonical slot at Push time. user_spawned: true
    // is stamped by inheritMainlineFields; preset_managed is never set.
    const initialData = inheritMainlineFields(
      { data: node.data as Record<string, unknown> },
      {
        displayName: opts.displayName,
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio:
          opts.targetAspectRatio === 'original' ? sourceAspectRatio : opts.targetAspectRatio,
        resultKind: 'generic',
        isGenerating: true,
        generationStartedAt,
      },
    );
    const nextNodeId = store.addNode(
      CANVAS_NODE_TYPES.exportImage,
      {
        x: base.x,
        y: base.y + i * (EXPORT_RESULT_NODE_LAYOUT_HEIGHT + RESULT_STACK_GAP),
      },
      initialData as unknown as Parameters<typeof store.addNode>[2],
    );
    store.addEdge(node.id, nextNodeId);
    return nextNodeId;
  });

  const completion = Promise.allSettled(
    nodeIds.map((id) =>
      runOutpaintGeneration(project, id, {
        sourceUrl: imageSource,
        targetAspectRatio: opts.targetAspectRatio,
        imageSize: opts.imageSize,
        model: opts.model,
      }),
    ),
  ).then(() => undefined);

  return { nodeIds, completion };
}

/** 针对已建好的节点提交单图扩图（num_images=1）→ 轮询 → 回填。 */
async function runOutpaintGeneration(
  project: string,
  nodeId: string,
  opts: {
    sourceUrl: string;
    targetAspectRatio: FreezoneOutpaintAspectRatio;
    imageSize: string;
    model: string;
  },
): Promise<void> {
  try {
    const ref = await submitFreezoneOutpaint(project, {
      sourceUrl: opts.sourceUrl.split('?')[0],
      targetAspectRatio: opts.targetAspectRatio,
      numImages: 1,
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
    console.error('[outpaint] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}
