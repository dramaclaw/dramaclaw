// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { submitFreezoneAnalyzeVideoStory } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { normalizeVideoStoryRows } from './videoStoryNormalizer';

/** 视频故事节点的落位尺寸（与 NodeActionToolbar.handleVideoAnalyze 一致）。 */
const STORY_LAYOUT_WIDTH = 720;
const STORY_LAYOUT_HEIGHT = 360;

export interface VideoAnalyzeStoryResult {
  /** 同步建好的 videoStory 节点 id（loading 态，数据回来后原地回填）。 */
  nodeId: string;
  /** 后台链（提交 → 轮询 → 归一化回填 / 写错）settle 时 resolve（不 reject）。 */
  completion: Promise<void>;
}

/**
 * 提交 → 轮询 → 归一化 → 回填的后台链（首次解析与重新解析共用）。
 *
 * @param storyNodeId 承载结果的 videoStory 节点（首次解析是刚建的，重新解析是它自己）。
 * @param sourceNodeId 触发解析的源视频节点；重新解析时为 null（没有独立源节点要同步
 *   loading/错误态——故事节点自己就是源）。
 */
function runStoryAnalysis(
  projectId: string,
  storyNodeId: string,
  sourceNodeId: string | null,
  opts: { videoUrl: string; durationSec?: number },
): Promise<void> {
  return (async () => {
    try {
      const submitResp = (await submitFreezoneAnalyzeVideoStory(projectId, {
        videoUrl: opts.videoUrl,
        durationSec: opts.durationSec,
      })) as unknown;
      console.info('[video-analyze] submit response', submitResp);

      const submitRecord =
        submitResp && typeof submitResp === 'object'
          ? (submitResp as Record<string, unknown>)
          : {};
      const taskKey =
        typeof submitRecord.task_key === 'string' ? submitRecord.task_key : null;

      let rawResult: Record<string, unknown>;
      if (taskKey) {
        const completed = await awaitTaskCompletion(taskKey, projectId);
        console.info('[video-analyze] task completed', completed.result);
        rawResult = (completed.result ?? {}) as Record<string, unknown>;
      } else {
        // Endpoint returned the result synchronously (OpenAPI 200 is `{}` —
        // not guaranteed to be the async FreezoneJobAcceptedResponse).
        console.info('[video-analyze] no task_key, treating response as inline result');
        rawResult = submitRecord;
      }

      const rows = normalizeVideoStoryRows(rawResult);
      console.info('[video-analyze] normalized rows', rows.length, rows);

      // 把解析结果回填到承载结果的故事节点。
      const done = useCanvasStore.getState();
      done.updateNodeData(storyNodeId, {
        rows,
        rawResult,
        isAnalyzing: false,
        analysisError: null,
      } as unknown as Parameters<typeof done.updateNodeData>[1]);
      if (sourceNodeId) {
        done.updateNodeData(sourceNodeId, {
          isAnalyzing: false,
          analysisError: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[video-analyze] failed', error);
      // 把错误写到故事节点,清掉它的 loading 态。
      const failed = useCanvasStore.getState();
      failed.updateNodeData(storyNodeId, {
        isAnalyzing: false,
        analysisError: message,
      });
      if (sourceNodeId) {
        failed.updateNodeData(sourceNodeId, {
          isAnalyzing: false,
          analysisError: message,
        });
      }
    }
  })();
}

/**
 * 视频解析（生成分镜故事）编排（从 NodeActionToolbar 的 handleVideoAnalyze 内联
 * 闭包原样搬出，语义零变化）：
 * 源节点置 isAnalyzing → 立即在下游建一个 loading 态 videoStory 节点并连边（不等
 * 后端返回）→ 提交 /freezone/analyze-video-story → 有 task_key 就等任务完成，没有
 * 就把响应本身当同步结果 → normalizeVideoStoryRows 后回填故事节点；失败把错误同时
 * 写到故事节点与源节点。
 *
 * @returns 故事节点 id + 后台链；缺 project 或源节点已不存在时返回 null。
 */
export function analyzeVideoStory(
  sourceNodeId: string,
  opts: {
    videoUrl: string;
    /** 源视频时长（秒）——没有就不下发，让后端自己探测。 */
    durationSec?: number;
  },
): VideoAnalyzeStoryResult | null {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-analyze] no project in URL');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return null;

  store.updateNodeData(sourceNodeId, {
    isAnalyzing: true,
    analysisError: null,
  });

  // 立即在下游建一个 loading 态的视频故事节点 —— 不等后端返回。
  // 数据回来后再 updateNodeData 把分镜填进去；失败则把错误写到该节点。
  const storyPosition = store.findNodePosition(
    sourceNodeId,
    STORY_LAYOUT_WIDTH,
    STORY_LAYOUT_HEIGHT,
  );
  const storyNodeId = store.addNode(CANVAS_NODE_TYPES.videoStory, storyPosition, {
    sourceVideoUrl: opts.videoUrl,
    rows: [],
    rawResult: null,
    isAnalyzing: true,
    analysisStartedAt: Date.now(),
    analysisError: null,
  } as unknown as Parameters<typeof store.addNode>[2]);
  store.addEdge(sourceNodeId, storyNodeId);

  return {
    nodeId: storyNodeId,
    completion: runStoryAnalysis(projectId, storyNodeId, sourceNodeId, opts),
  };
}

/**
 * 重新解析一个已存在的视频故事节点：不建新节点、不连新边，直接把它自己重置成
 * loading 态并用**它记着的源片源**（data.sourceVideoUrl）再跑一次同一条链，结果
 * 原地覆盖 rows/rawResult。
 *
 * 与 {@link analyzeVideoStory} 共用 runStoryAnalysis —— 首次解析建节点、重新解析
 * 复用节点，除此之外提交/轮询/归一化/回填完全同一份实现。
 *
 * @returns 故事节点 id + 后台链；缺 project、节点已不存在或它没记住片源时返回 null。
 */
export function reanalyzeVideoStory(
  storyNodeId: string,
  opts?: { durationSec?: number },
): VideoAnalyzeStoryResult | null {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-analyze] no project in URL');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === storyNodeId);
  if (!node) return null;
  const sourceVideoUrl = (node.data as { sourceVideoUrl?: unknown }).sourceVideoUrl;
  if (typeof sourceVideoUrl !== 'string' || sourceVideoUrl.length === 0) {
    console.warn('[video-analyze] reanalyze: story node has no sourceVideoUrl', storyNodeId);
    return null;
  }

  store.updateNodeData(storyNodeId, {
    isAnalyzing: true,
    analysisStartedAt: Date.now(),
    analysisError: null,
  });

  return {
    nodeId: storyNodeId,
    completion: runStoryAnalysis(projectId, storyNodeId, null, {
      videoUrl: sourceVideoUrl,
      durationSec: opts?.durationSec,
    }),
  };
}
