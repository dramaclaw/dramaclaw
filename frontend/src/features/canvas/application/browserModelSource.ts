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
// 不想自托管时也可以分别指向公共镜像（各自优先于自托管前缀）：
//   BROWSER_MODEL_HF_ENDPOINT  权重源，路径规则与 Hugging Face Hub 一致
//                              （<endpoint>/<org>/<model>/resolve/<revision>/<file>）
//   BROWSER_ORT_WASM_BASE      wasm 目录，`{version}` 替换成 onnxruntime-web 版本号
//
// worker 拿不到主线程的运行时配置，这些地址由主线程随任务消息带进来。

/** 后端 /api/v1/config 下发的三个地址，随任务消息带进 worker。 */
export interface BrowserModelSourceConfig {
  /** 自托管前缀（BROWSER_MODEL_ASSET_BASE）。 */
  assetBase: string | null;
  /** Hugging Face 路径规则的权重镜像（BROWSER_MODEL_HF_ENDPOINT）。 */
  hfEndpoint: string | null;
  /** onnxruntime wasm 目录，可含 `{version}`（BROWSER_ORT_WASM_BASE）。 */
  ortWasmBase: string | null;
}

/** 两部分各自独立：缺哪部分，哪部分就保持库默认源。 */
export interface BrowserModelSource {
  /** 对应 transformers.js 的 env.remoteHost / env.remotePathTemplate。 */
  models?: { remoteHost: string; remotePathTemplate?: string };
  /** 对应 env.backends.onnx.wasm.wasmPaths。 */
  wasmPaths?: { mjs: string; wasm: string };
}

function normalizeBase(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

/** 什么都没配时返回 null：保持库默认源。 */
export function resolveBrowserModelSource(
  config: BrowserModelSourceConfig | null | undefined,
  ortWebVersion: string | null | undefined,
  isSafari: boolean,
): BrowserModelSource | null {
  const assetBase = normalizeBase(config?.assetBase);
  const hfEndpoint = normalizeBase(config?.hfEndpoint);
  const ortWasmBase = normalizeBase(config?.ortWasmBase);
  const source: BrowserModelSource = {};

  if (hfEndpoint) {
    // 镜像沿用 Hub 的路径规则，只换 host，remotePathTemplate 保持库默认。
    source.models = { remoteHost: `${hfEndpoint}/` };
  } else if (assetBase) {
    source.models = { remoteHost: `${assetBase}/models/`, remotePathTemplate: "{model}/" };
  }

  // wasm 必须与打进包里的 JS 胶水同版本；拿不到版本号就拼不出目录，保持库默认。
  if (ortWebVersion) {
    const wasmDir = ortWasmBase
      ? ortWasmBase.split("{version}").join(ortWebVersion)
      : assetBase
        ? `${assetBase}/onnxruntime-web/${ortWebVersion}`
        : "";
    if (wasmDir) {
      // 与 transformers.js 自己的选择一致：Safari 用普通版，其余用 asyncify 版。
      const stem = isSafari ? "ort-wasm-simd-threaded" : "ort-wasm-simd-threaded.asyncify";
      source.wasmPaths = { mjs: `${wasmDir}/${stem}.mjs`, wasm: `${wasmDir}/${stem}.wasm` };
    }
  }

  return source.models || source.wasmPaths ? source : null;
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

/** 在 worker 里、建 pipeline 之前调用。什么都没配时不动 env。 */
export function applyBrowserModelSource(
  env: TransformersEnvLike,
  config: BrowserModelSourceConfig | null | undefined,
  navigatorLike: { userAgent?: string; vendor?: string },
): void {
  const onnx = env.backends.onnx;
  const source = resolveBrowserModelSource(
    config,
    onnx.versions?.web,
    isSafariUserAgent(navigatorLike.userAgent ?? "", navigatorLike.vendor ?? ""),
  );
  if (!source) {
    return;
  }
  if (source.models) {
    env.remoteHost = source.models.remoteHost;
    if (source.models.remotePathTemplate) {
      env.remotePathTemplate = source.models.remotePathTemplate;
    }
  }
  if (source.wasmPaths && onnx.wasm) {
    onnx.wasm.wasmPaths = source.wasmPaths;
  }
}
