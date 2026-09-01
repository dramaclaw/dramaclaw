// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  submitFreezoneVideoGen,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoResolution,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  type VideoGenCount,
  type VideoGenQuality,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

/** 后端不再支持一次出多条——按视频节点选的「生成数量」并发调 N 次，上限 4。 */
const MAX_PARALLEL_COUNT = 4;

function resolveVideoOutputUrl(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) return null;
  for (const key of ['video_url', 'output_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q.toLowerCase() as FreezoneVideoResolution;
}

/** 取文本节点第一条下游边指向的视频节点（文生视频的参数与产物都落在它身上）。 */
export function resolveTextNodeDownstreamVideoNodeId(nodeId: string): string | null {
  const state = useCanvasStore.getState();
  const downstreamEdge = state.edges.find((edge) => edge.source === nodeId);
  if (!downstreamEdge) return null;
  const targetNode = state.nodes.find((node) => node.id === downstreamEdge.target);
  if (!targetNode || targetNode.type !== CANVAS_NODE_TYPES.video) return null;
  return targetNode.id;
}

export interface TextToVideoSubmitResult {
  /** 本次承载产物的视频节点 id（第 1 个是下游那个原节点，其余是并排复制出来的）。 */
  nodeIds: string[];
  /** 任一条失败时的首个错误原因；全部成功为 null。 */
  error: string | null;
}

/**
 * 文生视频提交编排（从 TextAnnotationNode.runTextToVideo 原样搬出，语义零变化）：
 *
 * 参数**读自下游视频节点**（画幅/画质/时长/音轨/数量/模型），不读文本节点——文本
 * 节点只提供 prompt。按「生成数量」并发调 N 次接口：第 1 条回填下游视频节点，其余
 * 用 duplicateNodeAsSibling 复制成同类视频节点并排承载。
 *
 * 失败只清对应视频节点的 loading 态（错误进 console），与原实现一致；返回值让调用
 * 方（故事板详情）能把失败文案显示在源文本节点的工具条上。
 */
export async function submitTextToVideo(
  nodeId: string,
  opts: {
    /** 提交用的提示词（工作流传节点当前正文；详情同源）。 */
    content: string;
    /** 下游视频节点没选模型时的兜底 id（调用方从 useFreezoneVideoModels 解析）。 */
    fallbackModelId: string;
  },
): Promise<TextToVideoSubmitResult> {
  const promptText = opts.content.trim();
  if (promptText.length === 0) return { nodeIds: [], error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[text-node] no project in URL');
    return { nodeIds: [], error: '当前 URL 缺少 project 参数' };
  }
  const targetNodeId = resolveTextNodeDownstreamVideoNodeId(nodeId);
  if (!targetNodeId) {
    console.warn('[text-node] textToVideo: no downstream video node');
    return { nodeIds: [], error: '下游没有可承载产物的视频节点' };
  }
  const store = useCanvasStore.getState();
  const targetNode = store.nodes.find((node) => node.id === targetNodeId);
  if (!targetNode) return { nodeIds: [], error: '下游没有可承载产物的视频节点' };
  const videoData = targetNode.data as VideoNodeData;
  const aspectRatio = (videoData.aspectRatio ?? '16:9') as FreezoneVideoAspectRatio;
  const quality: VideoGenQuality = videoData.quality ?? '720P';
  const durationSec = typeof videoData.durationSec === 'number' ? videoData.durationSec : 5;
  const generateAudio = Boolean(videoData.generateAudio);
  const count: VideoGenCount = (videoData.count ?? 1) as VideoGenCount;
  const videoModel =
    typeof videoData.model === 'string' && videoData.model.length > 0
      ? videoData.model
      : opts.fallbackModelId;

  const total = Math.min(Math.max(count, 1), MAX_PARALLEL_COUNT);
  store.updateNodeData(targetNodeId, {
    prompt: promptText,
    isGenerating: true,
    generationStartedAt: Date.now(),
    // 目标节点可能带着上次批量生成的画册，本次单条回填后画册与主视频脱钩——清掉。
    generationBatch: null,
  });
  const targetIds: string[] = [targetNodeId];
  for (let i = 1; i < total; i += 1) {
    const siblingId = useCanvasStore.getState().duplicateNodeAsSibling(targetNodeId, i, {
      prompt: promptText,
      isGenerating: true,
      generationStartedAt: Date.now(),
      count: 1,
      videoUrl: null,
      sourceFileName: null,
      // duplicateNodeAsSibling 整份展开源节点 data，画册字段必须显式清空，
      // 否则兄弟节点会继承源节点的旧画册（卡边 + 徽标显示别人的结果）。
      generationBatch: null,
    });
    if (siblingId) targetIds.push(siblingId);
  }

  const errors: string[] = [];
  const runOne = async (videoNodeId: string) => {
    const updateNodeData = useCanvasStore.getState().updateNodeData;
    try {
      const ref = await submitFreezoneVideoGen(projectId, {
        prompt: promptText,
        genMode: "textToVideo",
        aspectRatio,
        resolution: qualityToResolution(quality),
        durationSeconds: durationSec,
        generateAudio,
        model: videoModel,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: videoNodeId,
      });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(videoNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, projectId);
      const url = resolveVideoOutputUrl(completed.result);
      const done = useCanvasStore.getState().updateNodeData;
      if (url) {
        done(videoNodeId, {
          videoUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          sourceFileName: null,
        });
      } else {
        console.warn('[text-node] textToVideo completed without output url', completed);
        done(videoNodeId, { isGenerating: false, generationStartedAt: null });
      }
    } catch (error) {
      console.error('[text-node] textToVideo failed', error);
      errors.push(error instanceof Error ? error.message : String(error));
      useCanvasStore
        .getState()
        .updateNodeData(videoNodeId, { isGenerating: false, generationStartedAt: null });
    }
  };

  await Promise.allSettled(targetIds.map(runOne));
  return { nodeIds: targetIds, error: errors[0] ?? null };
}
