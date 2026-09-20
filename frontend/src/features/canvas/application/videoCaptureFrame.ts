// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { resolveImageDisplayUrl } from './imageData';
import { captureVideoFrameBlob } from './videoFrameBlob';

/** 截帧档位：首帧 / 尾帧 / 播放器当前帧。 */
export type VideoCaptureFrameMode = 'first' | 'last' | 'current';

export { captureVideoFrameBlob };

/**
 * 三档截帧对应的 seek 位置（从 VideoNode.handleCaptureFrame 抽出的纯计算）：
 * - first  → 0
 * - last   → 时长 - 0.05s；时长完全未知时给 MAX_SAFE_INTEGER，让
 *            captureVideoFrameBlob 内部按实际 duration 夹到末尾
 * - current→ 活的播放器 currentTime；拿不到就退回 0
 *
 * `liveDurationSec` 是详情/节点里那个正在播的 <video> 报的时长（最准），
 * `fallbackDurationSec` 是节点 data.durationMs 换算来的兜底。
 */
export function resolveCaptureSeekSec(
  mode: VideoCaptureFrameMode,
  live: {
    currentTimeSec?: number | null;
    durationSec?: number | null;
    fallbackDurationSec?: number | null;
  },
): number {
  if (mode === 'first') return 0;
  if (mode === 'last') {
    const liveDuration =
      typeof live.durationSec === 'number' && Number.isFinite(live.durationSec)
        ? live.durationSec
        : null;
    const knownDuration = liveDuration ?? live.fallbackDurationSec ?? null;
    return knownDuration != null
      ? Math.max(0, knownDuration - 0.05)
      : Number.MAX_SAFE_INTEGER;
  }
  return typeof live.currentTimeSec === 'number' && Number.isFinite(live.currentTimeSec)
    ? live.currentTimeSec
    : 0;
}

export interface VideoCaptureFrameResult {
  /** 新建的图片节点 id；失败时为 null。 */
  nodeId: string | null;
  /** 失败原因；成功时为 null。 */
  error: string | null;
  reused?: boolean;
}

const pendingCaptures = new Map<string, Promise<VideoCaptureFrameResult>>();

/** Reuse persisted captures across branches; failed captures are always retryable. */
export async function getOrCaptureVideoFrame(
  sourceNodeId: string,
  mode: 'first' | 'last',
  projectId?: string | null,
  displayName = mode === 'last' ? '上一镜尾帧' : '视频首帧',
): Promise<VideoCaptureFrameResult> {
  const source = useCanvasStore.getState().nodes.find((node) => node.id === sourceNodeId);
  const data = source?.data as Record<string, unknown> | undefined;
  const videoUrl = data?.videoUrl;
  if (typeof videoUrl !== 'string' || !videoUrl) {
    return { nodeId: null, error: '上一镜头尚无视频，请先完成上一镜头。' };
  }
  const storyMedia = data?.storyMedia as { version?: unknown } | undefined;
  const provenance = {
    sourceVideoNodeId: sourceNodeId,
    sourceVideoUrl: videoUrl,
    sourceMediaVersion: storyMedia?.version ?? null,
    sourceTaskJobId: data?.generationTaskJobId ?? null,
    captureMode: mode,
    seekSec: resolveCaptureSeekSec(mode, {
      fallbackDurationSec: typeof data?.durationMs === 'number' ? data.durationMs / 1000 : null,
    }),
  };
  const existing = useCanvasStore.getState().nodes.find((node) => {
    const frame = node.data.videoFrameSource as Record<string, unknown> | undefined;
    return node.data.imageUrl && frame && Object.entries(provenance).every(([key, value]) => frame[key] === value);
  });
  if (existing) return { nodeId: existing.id, error: null, reused: true };
  const key = JSON.stringify([projectId || readUrl().project, readUrl().canvas, provenance]);
  const pending = pendingCaptures.get(key);
  if (pending) return pending;
  const work = (async () => {
    const result = await captureVideoFrameToNode(sourceNodeId, {
      videoUrl, seekSec: provenance.seekSec, projectId, displayName,
      requireUnchangedSource: true,
    });
    if (result.nodeId) {
      useCanvasStore.getState().updateNodeData(result.nodeId, {
        videoFrameSource: { ...provenance, capturedAt: new Date().toISOString() },
      });
    }
    return result;
  })();
  pendingCaptures.set(key, work);
  try { return await work; } finally { pendingCaptures.delete(key); }
}

/**
 * 截帧编排（从 VideoNode.handleCaptureFrame 原样搬出，语义零变化；节点类型
 * 后改为 exportImage，见下）：抽帧 → 上传成 png → 在源节点下游建派生图片
 * 结果节点并连边、写标题。图片比例优先取源视频的像素宽高，退到
 * data.aspectRatio，再退 16:9。
 *
 * 结果节点用 addDerivedExportNode 建成 exportImage（不是 upload）：upload
 * 节点没有 target handle，下面的 addEdge 会静默失效连不上；exportImage 有
 * target handle 且不受上游白名单限制，与抠图/旋转等派生图片流一致。
 *
 * seek 位置由调用方用 {@link resolveCaptureSeekSec} 先算好——只有调用方能拿到
 * 那个活的 <video> 元素（工作流是节点内播放器，故事板是详情大播放器）。
 */
export async function captureVideoFrameToNode(
  sourceNodeId: string,
  opts: {
    videoUrl: string;
    seekSec: number;
    projectId?: string | null;
    /** FMV reuse must not attach a frame after its source or canvas changed. */
    requireUnchangedSource?: boolean;
    /** 结果节点标题（首帧/尾帧/当前帧，文案由调用方按各自 i18n 决定）。 */
    displayName: string;
  },
): Promise<VideoCaptureFrameResult> {
  if (!opts.videoUrl) return { nodeId: null, error: null };
  const projectId = opts.projectId?.trim() || readUrl().project;
  if (!projectId) {
    console.error('[video-capture-frame] no project in URL');
    return { nodeId: null, error: null };
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return { nodeId: null, error: null };
  const data = node.data as Record<string, unknown>;
  const canvasAtStart = opts.requireUnchangedSource ? readUrl().canvas : null;

  try {
    const blob = await captureVideoFrameBlob(
      resolveImageDisplayUrl(opts.videoUrl),
      opts.seekSec,
    );
    const filename = `frame-${Date.now()}.png`;
    const file = new File([blob], filename, { type: 'image/png' });
    const uploaded = await uploadFreezoneImage(projectId, file, filename);

    const widthPx = typeof data.widthPx === 'number' ? data.widthPx : null;
    const heightPx = typeof data.heightPx === 'number' ? data.heightPx : null;
    const aspectForNode =
      widthPx && heightPx && widthPx > 0 && heightPx > 0
        ? `${widthPx}:${heightPx}`
        : (typeof data.aspectRatio === 'string' && data.aspectRatio) || '16:9';

    const done = useCanvasStore.getState();
    if (opts.requireUnchangedSource) {
      const current = done.nodes.find((candidate) => candidate.id === sourceNodeId);
      if (readUrl().canvas !== canvasAtStart || !current ||
          current.data.videoUrl !== data.videoUrl ||
          current.data.generationTaskJobId !== data.generationTaskJobId) {
        return { nodeId: null, error: '画布或来源视频已变化，请重新截帧。' };
      }
    }
    // exportImage（非 upload）：upload 节点没有 target handle（nodeRegistry.ts），
    // 下面的 addEdge 连不上、静默失效。exportImage 有 target handle 且不在上游
    // 白名单里，是抠图/旋转等派生图片流的统一落点。aspectRatioStrategy 取
    // 'derivedFromSource'，与 addDerivedUploadNode 尺寸表现保持一致
    // （两者都走 resolveDerivedAspectRatio(sourceNode, aspectRatio)）。
    const createdNodeId = done.addDerivedExportNode(
      sourceNodeId,
      uploaded.url,
      aspectForNode,
      uploaded.url,
      { aspectRatioStrategy: 'derivedFromSource' },
    );
    if (createdNodeId) {
      done.updateNodeData(createdNodeId, { displayName: opts.displayName });
      done.addEdge(sourceNodeId, createdNodeId);
    }
    return { nodeId: createdNodeId, error: null };
  } catch (error) {
    console.error('[video-capture-frame] frame capture failed', error);
    return {
      nodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
