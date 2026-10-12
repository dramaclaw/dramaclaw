// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 深度动作捕捉编排：取源视频 → worker 计算 → 上传 → 写回节点。
//
// 任务表是模块级的，不挂在 React 组件上：画布 LOD、切画布都会卸载节点组件，但只有
// 节点真的从 store 里消失才该取消。页面刷新后表是空的，残留的 running 态节点据此
// 显示为「已中断」（见 DepthCaptureBody）。
import { uploadFreezoneVideo } from "@/api/ops";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { DepthCaptureState } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  DepthCaptureError,
  runDepthCaptureInWorker,
  type DepthCaptureJob,
} from "./depthCaptureClient";

const activeJobs = new Map<string, { sourceVideoUrl: string; cancel: () => void }>();

// 每个任务一个 worker、一份模型 session，同时跑几个只会互相抢本机 GPU/显存，
// 谁也快不了，低配机器还会直接爆内存。所以全局只放行一个，其余按点击顺序排队。
const MAX_CONCURRENT_JOBS = 1;
let runningJobs = 0;
const slotWaiters: Array<(granted: boolean) => void> = [];

function acquireSlot(): { granted: Promise<boolean>; abandon: () => void } {
  if (runningJobs < MAX_CONCURRENT_JOBS) {
    runningJobs += 1;
    return { granted: Promise.resolve(true), abandon: () => {} };
  }
  let waiter: (granted: boolean) => void = () => {};
  const granted = new Promise<boolean>((resolve) => {
    waiter = resolve;
  });
  slotWaiters.push(waiter);
  return {
    granted,
    // 还在排队就被取消：直接出队，不用等轮到它再放弃。
    abandon: () => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) {
        slotWaiters.splice(index, 1);
        waiter(false);
      }
    },
  };
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    // 名额直接转交给下一个，runningJobs 不变。
    next(true);
  } else {
    runningJobs -= 1;
  }
}

export function isDepthCaptureActive(nodeId: string): boolean {
  return activeJobs.has(nodeId);
}

/** 是否有任务在跑或在排队；新任务会排在它们后面。 */
export function hasActiveDepthCapture(): boolean {
  return activeJobs.size > 0;
}

/** 同一条源视频在途（含排队）任务的结果节点；没有返回 null。 */
export function findActiveDepthCaptureNodeId(sourceVideoUrl: string): string | null {
  for (const [nodeId, job] of activeJobs) {
    if (job.sourceVideoUrl === sourceVideoUrl) {
      return nodeId;
    }
  }
  return null;
}

export function cancelDepthCapture(nodeId: string): void {
  activeJobs.get(nodeId)?.cancel();
}

function nodeExists(nodeId: string): boolean {
  return useCanvasStore.getState().nodes.some((node) => node.id === nodeId);
}

export interface StartDepthCaptureOptions {
  nodeId: string;
  projectId: string;
  sourceVideoUrl: string;
}

export async function startDepthCapture({
  nodeId,
  projectId,
  sourceVideoUrl,
}: StartDepthCaptureOptions): Promise<void> {
  if (activeJobs.has(nodeId)) {
    return;
  }
  let cancelled = false;
  let job: DepthCaptureJob | null = null;
  const slot = acquireSlot();
  let holdsSlot = false;
  // 排队和取源视频期间 worker 还没建，也要先占住任务表，否则节点会误显示「已中断」。
  activeJobs.set(nodeId, {
    sourceVideoUrl,
    cancel: () => {
      cancelled = true;
      slot.abandon();
      job?.cancel();
    },
  });
  const unsubscribe = useCanvasStore.subscribe((state) => {
    if (!state.nodes.some((node) => node.id === nodeId)) {
      cancelDepthCapture(nodeId);
    }
  });

  const { updateNodeData } = useCanvasStore.getState();
  const writeState = (state: DepthCaptureState) =>
    // 进度写很频繁，不进撤销栈。
    updateNodeData(nodeId, { depthCapture: state }, { recordHistory: false });
  const running = (progress: number): DepthCaptureState => ({
    status: "running",
    progress,
    sourceVideoUrl,
    errorCode: null,
    errorDetail: null,
  });

  try {
    writeState(running(0));
    // 源视频也等轮到了再取，排队的任务不占内存。
    holdsSlot = await slot.granted;
    if (!holdsSlot || cancelled) {
      return;
    }
    const response = await fetch(resolveImageDisplayUrl(sourceVideoUrl));
    if (!response.ok) {
      throw new DepthCaptureError("failed", `source video HTTP ${response.status}`);
    }
    const sourceBlob = await response.blob();
    if (cancelled) {
      return;
    }

    let lastPercent = 0;
    job = runDepthCaptureInWorker(sourceBlob, (progress) => {
      const percent = Math.round(progress * 100);
      if (percent === lastPercent) {
        return;
      }
      lastPercent = percent;
      writeState(running(percent));
    });
    const result = await job.promise;
    if (cancelled) {
      return;
    }

    const { url } = await uploadFreezoneVideo(
      projectId,
      result.blob,
      `depth-capture-${Date.now()}.mp4`,
    );
    if (cancelled || !nodeExists(nodeId)) {
      return;
    }
    updateNodeData(nodeId, {
      videoUrl: url,
      previewImageUrl: null,
      widthPx: result.width,
      heightPx: result.height,
      durationMs: result.durationMs,
      depthCapture: null,
    });
  } catch (err) {
    if (cancelled || !nodeExists(nodeId)) {
      return;
    }
    writeState({
      status: "failed",
      progress: 0,
      sourceVideoUrl,
      errorCode: err instanceof DepthCaptureError ? err.code : "failed",
      errorDetail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    unsubscribe();
    activeJobs.delete(nodeId);
    if (holdsSlot) {
      releaseSlot();
    }
  }
}
