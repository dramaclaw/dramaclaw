// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 深度动作捕捉 worker 的主线程客户端。与 matteClient 的单例不同，这里一个任务一个
// worker：取消就是 terminate，不用在 worker 里做可中断的推理循环。
import type { DepthCaptureErrorCode } from "@/features/canvas/domain/canvasNodes";
import type { DepthWorkerInbound, DepthWorkerOutbound } from "./depthCaptureProtocol";

export class DepthCaptureError extends Error {
  readonly code: DepthCaptureErrorCode;

  constructor(code: DepthCaptureErrorCode, message: string) {
    super(message);
    this.name = "DepthCaptureError";
    this.code = code;
  }
}

export interface DepthCaptureResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
}

export interface DepthCaptureJob {
  promise: Promise<DepthCaptureResult>;
  cancel: () => void;
}

/** progress 回调收到 0–1。 */
export function runDepthCaptureInWorker(
  blob: Blob,
  onProgress: (progress: number) => void,
): DepthCaptureJob {
  const worker = new Worker(new URL("./depthCaptureWorker.ts", import.meta.url), {
    type: "module",
  });
  let settled = false;
  let rejectJob: (err: Error) => void = () => {};

  const promise = new Promise<DepthCaptureResult>((resolve, reject) => {
    rejectJob = reject;
    const settle = () => {
      settled = true;
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<DepthWorkerOutbound>) => {
      if (settled) {
        return;
      }
      const message = event.data;
      if (message.type === "progress") {
        onProgress(message.progress);
        return;
      }
      settle();
      if (message.type === "result") {
        resolve({
          blob: message.blob,
          width: message.width,
          height: message.height,
          durationMs: message.durationMs,
        });
      } else {
        reject(new DepthCaptureError(message.code, message.message));
      }
    };
    worker.onerror = (event) => {
      if (settled) {
        return;
      }
      settle();
      reject(new DepthCaptureError("failed", event.message || "depth capture worker crashed"));
    };
  });

  worker.postMessage({ type: "run", blob } satisfies DepthWorkerInbound);

  return {
    promise,
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      worker.terminate();
      rejectJob(new DepthCaptureError("cancelled", "cancelled"));
    },
  };
}
