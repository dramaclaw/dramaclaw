// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 深度动作捕捉 worker 与主线程之间的消息。一个 worker 只跑一个任务，所以不需要请求 id。
import type { BrowserModelSourceConfig } from "@/features/canvas/application/browserModelSource";
import type { DepthCaptureErrorCode } from "@/features/canvas/domain/canvasNodes";

export type DepthWorkerInbound = {
  type: "run";
  blob: Blob;
  /** 模型与 wasm 的来源（见 browserModelSource.ts）；全为 null 走库默认源。 */
  modelSource: BrowserModelSourceConfig;
};

export type DepthWorkerOutbound =
  /** progress 为 0–1。 */
  | { type: "progress"; progress: number }
  | { type: "result"; blob: Blob; width: number; height: number; durationMs: number }
  | { type: "error"; code: DepthCaptureErrorCode; message: string };
