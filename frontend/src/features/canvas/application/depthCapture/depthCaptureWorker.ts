// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/// <reference lib="webworker" />
//
// 深度动作捕捉 Web Worker：解码 → 逐帧深度估计 → 灰度帧 → H.264 编码，整条链都在
// worker 里，主线程只收进度和最终 mp4。一个任务一个 worker，完成或取消就 terminate；
// 模型权重走浏览器缓存，重建 worker 只多一次建推理 session。
//
// 模型 onnx-community/depth-anything-v2-small（Apache-2.0）。权重从 HF Hub、ort wasm
// 从 jsDelivr 加载，CSP 要求与 matteWorker 相同。

import { pipeline, RawImage } from "@huggingface/transformers";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
} from "mediabunny";
import type { DepthCaptureErrorCode } from "@/features/canvas/domain/canvasNodes";
import type { DepthWorkerInbound, DepthWorkerOutbound } from "./depthCaptureProtocol";
import {
  DEPTH_INFERENCE_HEIGHT,
  DEPTH_MAX_DURATION_SEC,
  DEPTH_MAX_OUTPUT_HEIGHT,
  depthToGray,
  fitHeight,
  percentileRange,
  smoothRange,
  type DepthRange,
} from "./depthMath";

const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// 同 matteWorker：页面没有跨源隔离，ort 的 wasm 多线程起不来，把核数压到 1 免掉无效尝试和告警。
if (!ctx.crossOriginIsolated) {
  try {
    Object.defineProperty(ctx.navigator, "hardwareConcurrency", {
      configurable: true,
      get: () => 1,
    });
  } catch {
    // 个别引擎拒绝重定义只读属性，无妨。
  }
}

class WorkerJobError extends Error {
  readonly code: DepthCaptureErrorCode;

  constructor(code: DepthCaptureErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type DepthEstimator = (
  image: RawImage,
) => Promise<{ predicted_depth: { data: ArrayLike<number> } }>;

async function detectGpu(): Promise<boolean> {
  const gpu = (ctx.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) {
    return false;
  }
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

async function createEstimator(): Promise<DepthEstimator> {
  const useGpu = await detectGpu();
  const estimator = await pipeline("depth-estimation", DEPTH_MODEL, {
    device: useGpu ? "webgpu" : "wasm",
    dtype: useGpu ? "fp16" : "q8",
  });
  return estimator as unknown as DepthEstimator;
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new WorkerJobError("failed", "OffscreenCanvas 2d context unavailable");
  }
  return context;
}

function post(message: DepthWorkerOutbound): void {
  ctx.postMessage(message);
}

async function captureDepth(blob: Blob): Promise<void> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      throw new WorkerJobError("noVideoTrack", "source has no video track");
    }
    if (!(await track.canDecode())) {
      throw new WorkerJobError("cannotDecode", "video codec is not decodable in this browser");
    }
    const durationSec = await input.computeDuration();
    if (durationSec > DEPTH_MAX_DURATION_SEC) {
      throw new WorkerJobError("tooLong", `${durationSec.toFixed(1)}s`);
    }
    const stats = await track.computePacketStats(100);

    // 推理画布小（模型输入量级），输出画布按 1080 封顶；predicted_depth 会被 pipeline
    // 插值回推理画布尺寸，灰度图再由浏览器双线性放大到输出尺寸。
    const outSize = fitHeight(track.displayWidth, track.displayHeight, DEPTH_MAX_OUTPUT_HEIGHT);
    const inferSize = fitHeight(track.displayWidth, track.displayHeight, DEPTH_INFERENCE_HEIGHT);

    const frameCanvas = new OffscreenCanvas(inferSize.width, inferSize.height);
    const frameCtx = context2d(frameCanvas);
    const grayCanvas = new OffscreenCanvas(inferSize.width, inferSize.height);
    const grayCtx = context2d(grayCanvas);
    const grayImage = grayCtx.createImageData(inferSize.width, inferSize.height);
    const outCanvas = new OffscreenCanvas(outSize.width, outSize.height);
    const outCtx = context2d(outCanvas);
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";

    const target = new BufferTarget();
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });
    const videoSource = new CanvasSource(outCanvas, { codec: "avc", bitrate: QUALITY_HIGH });
    output.addVideoTrack(
      videoSource,
      stats.averagePacketRate > 0 ? { frameRate: stats.averagePacketRate } : {},
    );
    await output.start();

    const estimator = await createEstimator();
    post({ type: "progress", progress: 0 });

    let range: DepthRange | null = null;
    let firstTimestamp: number | null = null;
    let lastProgress = 0;
    for await (const sample of new VideoSampleSink(track).samples()) {
      const { timestamp, duration } = sample;
      try {
        sample.draw(frameCtx, 0, 0, inferSize.width, inferSize.height);
      } finally {
        sample.close();
      }
      firstTimestamp ??= timestamp;

      const { predicted_depth: depth } = await estimator(RawImage.fromCanvas(frameCanvas));
      range = smoothRange(range, percentileRange(depth.data));
      depthToGray(depth.data, range, grayImage.data);
      grayCtx.putImageData(grayImage, 0, 0);
      outCtx.drawImage(grayCanvas, 0, 0, outSize.width, outSize.height);
      // 逐帧对应源时间戳，只把起点挪到 0。
      await videoSource.add(timestamp - firstTimestamp, duration);

      const progress = durationSec > 0 ? Math.min(1, (timestamp + duration) / durationSec) : 0;
      if (progress - lastProgress >= 0.01) {
        lastProgress = progress;
        post({ type: "progress", progress });
      }
    }
    if (firstTimestamp === null) {
      throw new WorkerJobError("noVideoTrack", "video has no frames");
    }

    await output.finalize();
    if (!target.buffer) {
      throw new WorkerJobError("failed", "encoder produced no data");
    }
    post({
      type: "result",
      blob: new Blob([target.buffer], { type: "video/mp4" }),
      width: outSize.width,
      height: outSize.height,
      durationMs: Math.round(durationSec * 1000),
    });
  } finally {
    input.dispose();
  }
}

ctx.onmessage = (event: MessageEvent<DepthWorkerInbound>) => {
  if (event.data.type !== "run") {
    return;
  }
  captureDepth(event.data.blob).catch((err: unknown) => {
    post({
      type: "error",
      code: err instanceof WorkerJobError ? err.code : "failed",
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
