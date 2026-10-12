// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import {
  applyBrowserModelSource,
  isSafariUserAgent,
  resolveBrowserModelSource,
  type TransformersEnvLike,
} from "@/features/canvas/application/browserModelSource";

const BASE = "https://cdn.example.com/browser-models";
const ORT = "1.26.0-dev.20260416-b7804b056c";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

function libraryDefaults(): TransformersEnvLike {
  return {
    remoteHost: "https://huggingface.co/",
    remotePathTemplate: "{model}/resolve/{revision}/",
    backends: { onnx: { versions: { web: ORT }, wasm: { wasmPaths: "jsdelivr-default" } } },
  };
}

describe("resolveBrowserModelSource", () => {
  it("points models and the asyncify wasm at the self-hosted prefix", () => {
    expect(resolveBrowserModelSource(`${BASE}/`, ORT, false)).toEqual({
      remoteHost: `${BASE}/models/`,
      remotePathTemplate: "{model}/",
      wasmPaths: {
        mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.wasm`,
      },
    });
  });

  it("uses the plain wasm build on Safari", () => {
    expect(resolveBrowserModelSource(BASE, ORT, true)?.wasmPaths).toEqual({
      mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.mjs`,
      wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.wasm`,
    });
  });

  it("keeps library defaults without a prefix or without an onnxruntime version", () => {
    expect(resolveBrowserModelSource(null, ORT, false)).toBeNull();
    expect(resolveBrowserModelSource("   ", ORT, false)).toBeNull();
    expect(resolveBrowserModelSource(BASE, undefined, false)).toBeNull();
  });
});

describe("isSafariUserAgent", () => {
  it("matches desktop Safari only", () => {
    expect(isSafariUserAgent(SAFARI_UA, "Apple Computer, Inc.")).toBe(true);
    expect(isSafariUserAgent(CHROME_UA, "Google Inc.")).toBe(false);
    expect(isSafariUserAgent(SAFARI_UA.replace("Version/18.0", "CriOS/140.0"), "Apple Computer, Inc.")).toBe(false);
  });

  it("is false when the worker navigator has no vendor, like the library", () => {
    expect(isSafariUserAgent(SAFARI_UA, "")).toBe(false);
  });
});

describe("applyBrowserModelSource", () => {
  it("rewrites the transformers env when a prefix is configured", () => {
    const env = libraryDefaults();
    applyBrowserModelSource(env, BASE, { userAgent: CHROME_UA, vendor: "Google Inc." });

    expect(env.remoteHost).toBe(`${BASE}/models/`);
    expect(env.remotePathTemplate).toBe("{model}/");
    expect(env.backends.onnx.wasm?.wasmPaths).toEqual({
      mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.wasm`,
    });
  });

  it("leaves the env untouched without a prefix", () => {
    const env = libraryDefaults();
    applyBrowserModelSource(env, null, { userAgent: CHROME_UA });
    expect(env).toEqual(libraryDefaults());
  });

  it("does not half-apply when the onnxruntime version is unknown", () => {
    const env = libraryDefaults();
    env.backends.onnx.versions = undefined;
    applyBrowserModelSource(env, BASE, { userAgent: CHROME_UA });
    expect(env.remoteHost).toBe("https://huggingface.co/");
    expect(env.backends.onnx.wasm?.wasmPaths).toBe("jsdelivr-default");
  });
});
