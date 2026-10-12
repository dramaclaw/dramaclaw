// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 浏览器端推理（抠图、深度动作捕捉）从哪里拉模型权重和 onnxruntime wasm。
//
// transformers.js 默认从 Hugging Face Hub 拉权重、从 jsDelivr 拉 wasm，国内网络基本
// 不可达。后端配了 BROWSER_MODEL_ASSET_BASE 时改从该前缀拉，目录布局：
//
//   <base>/models/<org>/<model>/{config.json,preprocessor_config.json,onnx/*.onnx}
//   <base>/onnxruntime-web/<version>/ort-wasm-simd-threaded[.asyncify].{mjs,wasm}
//
// 目录由 scripts/fetch_browser_models.py 生成。wasm 目录带 onnxruntime-web 版本号：
// wasm 必须与打进包里的 JS 胶水同版本，升级依赖后旧目录不能被新前端误用。
//
// worker 拿不到主线程的运行时配置，前缀由主线程随任务消息带进来。

export interface BrowserModelSource {
  /** 对应 transformers.js 的 env.remoteHost。 */
  remoteHost: string;
  /** 对应 env.remotePathTemplate。 */
  remotePathTemplate: string;
  /** 对应 env.backends.onnx.wasm.wasmPaths。 */
  wasmPaths: { mjs: string; wasm: string };
}

/** 没配前缀，或拿不到 onnxruntime-web 版本号（拼不出 wasm 目录）时返回 null：保持库默认源。 */
export function resolveBrowserModelSource(
  assetBase: string | null | undefined,
  ortWebVersion: string | null | undefined,
  isSafari: boolean,
): BrowserModelSource | null {
  const base = assetBase?.trim().replace(/\/+$/, "");
  if (!base || !ortWebVersion) {
    return null;
  }
  // 与 transformers.js 自己的选择一致：Safari 用普通版，其余用 asyncify 版。
  const stem = isSafari ? "ort-wasm-simd-threaded" : "ort-wasm-simd-threaded.asyncify";
  const wasmDir = `${base}/onnxruntime-web/${ortWebVersion}/`;
  return {
    remoteHost: `${base}/models/`,
    remotePathTemplate: "{model}/",
    wasmPaths: { mjs: `${wasmDir}${stem}.mjs`, wasm: `${wasmDir}${stem}.wasm` },
  };
}

/**
 * 照抄 transformers.js 的 isSafari，保证选到的 wasm 变体与库默认行为一致。
 * 注意 worker 里的 navigator 通常没有 vendor，此时库和这里都会判成非 Safari。
 */
export function isSafariUserAgent(userAgent: string, vendor: string): boolean {
  const isAppleVendor = vendor.includes("Apple");
  const notOtherBrowser =
    !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i.test(userAgent) &&
    !userAgent.includes("Chrome") &&
    !userAgent.includes("Android");
  return isAppleVendor && notOtherBrowser;
}

/** transformers.js 的 env 里本模块要写的那部分。 */
export interface TransformersEnvLike {
  remoteHost: string;
  remotePathTemplate: string;
  backends: {
    onnx: {
      versions?: { web?: string };
      wasm?: { wasmPaths?: unknown };
    };
  };
}

/** 在 worker 里、建 pipeline 之前调用。前缀为空时不动 env。 */
export function applyBrowserModelSource(
  env: TransformersEnvLike,
  assetBase: string | null | undefined,
  navigatorLike: { userAgent?: string; vendor?: string },
): void {
  const onnx = env.backends.onnx;
  const source = resolveBrowserModelSource(
    assetBase,
    onnx.versions?.web,
    isSafariUserAgent(navigatorLike.userAgent ?? "", navigatorLike.vendor ?? ""),
  );
  if (!source || !onnx.wasm) {
    return;
  }
  env.remoteHost = source.remoteHost;
  env.remotePathTemplate = source.remotePathTemplate;
  onnx.wasm.wasmPaths = source.wasmPaths;
}
