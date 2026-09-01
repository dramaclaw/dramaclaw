// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fetchFreezoneJobResult, submitFreezoneVideoCompose } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

/** 结果视频节点的落位尺寸（与 VideoNode 的 DEFAULT_WIDTH/HEIGHT 一致）。 */
const CLIP_RESULT_LAYOUT_WIDTH = 580;
const CLIP_RESULT_LAYOUT_HEIGHT = 380;

/** 剪辑完成但后端没给产物地址时的提示（与 VideoNode.handleClipSubmit 原文一致）。 */
export const VIDEO_CLIP_NO_URL_MESSAGE = '剪辑完成但未返回视频地址';

export interface VideoClipSubmitResult {
  /** 新建的剪辑结果视频节点 id；失败时为 null。 */
  nodeId: string | null;
  /** 失败原因；成功时为 null。 */
  error: string | null;
}

/**
 * 视频剪辑提交编排（从 VideoNode.handleClipSubmit 原样搬出，语义零变化）：
 * 用单轨单片段的 compose 任务把 [startMs, endMs) 区间裁出来 → 等任务完成 →
 * 取 job result → 在源节点下游建视频节点承载产物并连边。
 *
 * 与 spawn 型编排（imageScene360 等）不同，这里的结果节点只有在任务成功返回
 * 产物地址后才建——原实现就是这个顺序，保持不变（失败不会在画布上留下空节点）。
 *
 * UI 状态（isComposingClip / clipError / 退出剪辑模式）由调用方自持：工作流的
 * VideoNode 与故事板详情的「剪辑轨道」共用这一条提交路径。
 */
export async function submitVideoClip(
  sourceNodeId: string,
  opts: {
    sourceUrl: string;
    startMs: number;
    endMs: number;
    /** 源节点的画质档（VideoNode 的 data.quality）——compose 只支持 720p/1080p。 */
    quality?: string | null;
    /** 结果节点标题，默认「剪辑」（与 VideoNode 原文一致）。 */
    displayName?: string;
  },
): Promise<VideoClipSubmitResult> {
  if (!opts.sourceUrl) return { nodeId: null, error: null };
  if (opts.endMs <= opts.startMs) return { nodeId: null, error: null };
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[video-clip] no project in URL');
    return { nodeId: null, error: null };
  }
  // Compose only supports 720p / 1080p — fall back to 720p for 480p sources.
  // 大小写不敏感：媒体目录里的档位现在是小写（"1080p"），老节点上仍可能存着
  // "1080P"，硬比较会把 1080p 源悄悄降到 720p。
  const composeResolution =
    (opts.quality ?? '').toLowerCase() === '1080p' ? '1080p' : '720p';
  const sourceStart = opts.startMs / 1000;
  const sourceEnd = opts.endMs / 1000;

  try {
    const ref = await submitFreezoneVideoCompose(projectId, {
      resolution: composeResolution,
      tracks: [
        {
          trackId: `track_${sourceNodeId}_video`,
          kind: 'video',
          items: [
            {
              itemId: `item_${sourceNodeId}_${Date.now()}`,
              sourceUrl: opts.sourceUrl,
              timelineStart: 0,
              sourceStart,
              sourceEnd,
            },
          ],
        },
      ],
    });
    await awaitTaskCompletion(ref.task_key, projectId);
    const result = await fetchFreezoneJobResult(
      projectId,
      'freezone_video_compose',
      ref.job_id,
    );
    if (!result.url) {
      console.warn('[video-clip] compose completed without url', result);
      return { nodeId: null, error: VIDEO_CLIP_NO_URL_MESSAGE };
    }
    const store = useCanvasStore.getState();
    const position = store.findNodePosition(
      sourceNodeId,
      CLIP_RESULT_LAYOUT_WIDTH,
      CLIP_RESULT_LAYOUT_HEIGHT,
    );
    const newNodeId = store.addNode(CANVAS_NODE_TYPES.video, position, {
      videoUrl: result.url,
      durationMs: Math.round((sourceEnd - sourceStart) * 1000),
      displayName: opts.displayName ?? '剪辑',
    } as unknown as Parameters<typeof store.addNode>[2]);
    store.addEdge(sourceNodeId, newNodeId);
    return { nodeId: newNodeId, error: null };
  } catch (error) {
    console.error('[video-clip] compose failed', error);
    return {
      nodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
