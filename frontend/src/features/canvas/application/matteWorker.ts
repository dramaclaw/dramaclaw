// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/// <reference lib="webworker" />
//
// 抠图(背景去除)Web Worker。
//
// 推理内核:`@huggingface/transformers`(Apache-2.0)的 background-removal pipeline。
// 之前用的 `@imgly/background-removal` 是 AGPL-3.0(传染性 copyleft),与本仓库的
// Elastic License v2 闭源策略冲突,已替换。模型权重选用宽松商用许可的开源模型
// (见 MATTE_MODEL),不含任何 non-commercial / copyleft 约束。
//
// 为什么要自建 Worker:推理(尤其 WASM 回退路径)若跑在主线程会把整个画布卡死。
// 把 pipeline 整段放进 worker,无论 WebGPU 是否可用,主线程都不被阻塞。

import { env, pipeline } from "@huggingface/transformers";
import { applyBrowserModelSource, type TransformersEnvLike } from "./browserModelSource";

// 抠图模型(全部为宽松商用许可,可随时切换):
//   - "Xenova/modnet"            Apache-2.0,~6.6MB(q8)/13MB(fp16),人像/角色 matting,体积最小
//   - "onnx-community/BEN2-ONNX" MIT,~219MB(fp16),通用物体抠图质量最高,但首次下载很大
// 本项目画布以角色立绘/分镜人物为主,默认用 MODNet(下载远小于旧的 imgly ~45MB)。
const MATTE_MODEL = "Xenova/modnet";

// modelAssetBase：模型自托管前缀（见 browserModelSource.ts）；null 走库默认源。
type InboundMessage =
  | { type: "preload"; id: number; modelAssetBase: string | null }
  | { type: "matte"; id: number; blob: Blob; modelAssetBase: string | null };

type OutboundMessage =
  | { type: "ready"; id: number }
  | { type: "result"; id: number; blob: Blob }
  | { type: "error"; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// onnxruntime-web 在建 session 时会把 `wasm.numThreads` 设成 hardwareConcurrency。
// 但 WASM 多线程依赖 SharedArrayBuffer,而 SAB 只有在页面「跨源隔离」(COOP+COEP)时
// 才可用。我们的页面只设了 COOP 没设 COEP,所以 `crossOriginIsolated === false`,
// 多线程起不来,ort 会打印告警再回落单线程。既然注定单线程,就把上报核数压到 1,
// 让库一开始就只申请单线程,结果相同但没有无效的多线程初始化尝试和告警。
if (!ctx.crossOriginIsolated) {
  try {
    Object.defineProperty(ctx.navigator, "hardwareConcurrency", {
      configurable: true,
      get: () => 1,
    });
  } catch {
    // 个别引擎可能拒绝重定义该只读属性;拒绝了也无妨,告警本身无害。
  }
}

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

// pipeline 在 worker 内只初始化一次(懒加载单例):preload 与 matte 共用同一实例,
// 命中已初始化的推理 session,避免重复加载模型权重。
//
// 返回形态:transformers.js 的 BackgroundRemovalPipeline 对「单个输入」返回单个
// RawImage,对「数组输入」才返回 RawImage[](源码:`Array.isArray(images) ? result : result[0]`)。
// 我们每次只抠一张,所以拿到的是单个 RawImage——之前按数组解构会触发
// 「(intermediate value) is not iterable」。
type MatteImage = { toBlob(): Promise<Blob> };
type RemoveBackground = (input: string) => Promise<MatteImage>;
let removerPromise: Promise<RemoveBackground> | null = null;

function getRemover(modelAssetBase: string | null): Promise<RemoveBackground> {
  if (!removerPromise) {
    removerPromise = (async () => {
      applyBrowserModelSource(env as unknown as TransformersEnvLike, modelAssetBase, ctx.navigator);
      const useGpu = await detectGpu();
      const remover = await pipeline("background-removal", MATTE_MODEL, {
        device: useGpu ? "webgpu" : "wasm",
        // WebGPU 用 fp16;WASM(CPU)回退用 q8 量化权重,体积与内存最小。
        dtype: useGpu ? "fp16" : "q8",
      });
      return remover as unknown as RemoveBackground;
    })();
  }
  return removerPromise;
}

ctx.onmessage = async (event: MessageEvent<InboundMessage>) => {
  const message = event.data;
  try {
    if (message.type === "preload") {
      await getRemover(message.modelAssetBase);
      ctx.postMessage({ type: "ready", id: message.id } satisfies OutboundMessage);
      return;
    }
    const remover = await getRemover(message.modelAssetBase);
    // background-removal pipeline 对单个输入返回单个 RawImage(已把 matte 合成到 alpha 通道)。
    const url = URL.createObjectURL(message.blob);
    try {
      const image = await remover(url);
      const out = await image.toBlob();
      ctx.postMessage({ type: "result", id: message.id, blob: out } satisfies OutboundMessage);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    ctx.postMessage({
      type: "error",
      id: message.id,
      message: err instanceof Error ? err.message : String(err),
    } satisfies OutboundMessage);
  }
};

// 模型权重与 ort wasm 的来源见 ./browserModelSource.ts:后端配了
// BROWSER_MODEL_ASSET_BASE 就从该前缀拉,否则走 transformers.js 默认行为
// (权重 Hugging Face Hub、wasm jsDelivr)。
