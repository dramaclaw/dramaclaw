// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 抠图 Worker 的主线程客户端:懒加载单例 worker,做请求↔响应的 id 关联。
// 见 ./matteWorker.ts 顶部注释:整段推理在 worker 内执行,主线程(画布)不被阻塞。
import { browserModelAssetBase } from "@/lib/runtime-config";

type OutboundMessage =
  | { type: "ready"; id: number }
  | { type: "result"; id: number; blob: Blob }
  | { type: "error"; id: number; message: string };

let worker: Worker | null = null;
let nextRequestId = 1;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (err: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./matteWorker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<OutboundMessage>) => {
    const message = event.data;
    if (message.type === "ready") {
      return; // 预热 ack,无需 pending promise
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    if (message.type === "result") {
      entry.resolve(message.blob);
    } else {
      entry.reject(new Error(message.message));
    }
  };
  worker.onerror = (event) => {
    // worker 整体崩溃:拒绝所有在途请求,并重置以便下次重建。
    const err = new Error(event.message || "matte worker crashed");
    for (const [, entry] of pending) {
      entry.reject(err);
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** 空闲预热:创建 worker 并预加载模型,把一次性初始化挪到用户点击之前。 */
export function preloadMatteWorker(): void {
  ensureWorker().postMessage({ type: "preload", id: 0, modelAssetBase: browserModelAssetBase() });
}

/** 在 worker 内抠图;主线程不阻塞。返回去背后的 PNG blob。 */
export function matteInWorker(blob: Blob): Promise<Blob> {
  const target = ensureWorker();
  const id = nextRequestId++;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ type: "matte", id, blob, modelAssetBase: browserModelAssetBase() });
  });
}
