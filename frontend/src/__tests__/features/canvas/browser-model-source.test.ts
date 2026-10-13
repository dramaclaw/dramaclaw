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
const HF_MIRROR = "https://www.modelscope.cn/models";
const WASM_MIRROR = "https://registry.npmmirror.com/onnxruntime-web/{version}/files/dist";
const NONE = { assetBase: null, hfEndpoint: null, ortWasmBase: null };
const SELF_HOSTED = { ...NONE, assetBase: BASE };
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
    expect(resolveBrowserModelSource({ ...NONE, assetBase: `${BASE}/` }, ORT, false)).toEqual({
      models: { remoteHost: `${BASE}/models/`, remotePathTemplate: "{model}/" },
      wasmPaths: {
        mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.wasm`,
      },
    });
  });

  it("uses the plain wasm build on Safari", () => {
    expect(resolveBrowserModelSource(SELF_HOSTED, ORT, true)?.wasmPaths).toEqual({
      mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.mjs`,
      wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.wasm`,
    });
  });

  it("points at public mirrors, keeping the hub path layout and filling in the version", () => {
    expect(
      resolveBrowserModelSource(
        { ...NONE, hfEndpoint: `${HF_MIRROR}/`, ortWasmBase: `${WASM_MIRROR}/` },
        ORT,
        false,
      ),
    ).toEqual({
      models: { remoteHost: `${HF_MIRROR}/` },
      wasmPaths: {
        mjs: `https://registry.npmmirror.com/onnxruntime-web/${ORT}/files/dist/ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: `https://registry.npmmirror.com/onnxruntime-web/${ORT}/files/dist/ort-wasm-simd-threaded.asyncify.wasm`,
      },
    });
  });

  it("lets each mirror override its half of the self-hosted prefix", () => {
    const onlyModels = resolveBrowserModelSource({ ...SELF_HOSTED, hfEndpoint: HF_MIRROR }, ORT, false);
    expect(onlyModels?.models).toEqual({ remoteHost: `${HF_MIRROR}/` });
    expect(onlyModels?.wasmPaths?.wasm).toBe(
      `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.wasm`,
    );

    const onlyWasm = resolveBrowserModelSource({ ...NONE, ortWasmBase: WASM_MIRROR }, ORT, false);
    expect(onlyWasm?.models).toBeUndefined();
    expect(onlyWasm?.wasmPaths).toBeDefined();
  });

  it("keeps library defaults when nothing is configured", () => {
    expect(resolveBrowserModelSource(null, ORT, false)).toBeNull();
    expect(resolveBrowserModelSource(NONE, ORT, false)).toBeNull();
    expect(resolveBrowserModelSource({ ...NONE, assetBase: "   " }, ORT, false)).toBeNull();
  });

  it("leaves the wasm on the library default without an onnxruntime version", () => {
    expect(resolveBrowserModelSource(SELF_HOSTED, undefined, false)).toEqual({
      models: { remoteHost: `${BASE}/models/`, remotePathTemplate: "{model}/" },
    });
    expect(resolveBrowserModelSource({ ...NONE, ortWasmBase: WASM_MIRROR }, undefined, false)).toBeNull();
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
    applyBrowserModelSource(env, SELF_HOSTED, { userAgent: CHROME_UA, vendor: "Google Inc." });

    expect(env.remoteHost).toBe(`${BASE}/models/`);
    expect(env.remotePathTemplate).toBe("{model}/");
    expect(env.backends.onnx.wasm?.wasmPaths).toEqual({
      mjs: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${BASE}/onnxruntime-web/${ORT}/ort-wasm-simd-threaded.asyncify.wasm`,
    });
  });

  it("keeps the hub path template when only the host is mirrored", () => {
    const env = libraryDefaults();
    applyBrowserModelSource(
      env,
      { ...NONE, hfEndpoint: HF_MIRROR, ortWasmBase: WASM_MIRROR },
      { userAgent: CHROME_UA, vendor: "Google Inc." },
    );

    expect(env.remoteHost).toBe(`${HF_MIRROR}/`);
    expect(env.remotePathTemplate).toBe("{model}/resolve/{revision}/");
    expect(env.backends.onnx.wasm?.wasmPaths).toEqual({
      mjs: `https://registry.npmmirror.com/onnxruntime-web/${ORT}/files/dist/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `https://registry.npmmirror.com/onnxruntime-web/${ORT}/files/dist/ort-wasm-simd-threaded.asyncify.wasm`,
    });
  });

  it("leaves the env untouched when nothing is configured", () => {
    const env = libraryDefaults();
    applyBrowserModelSource(env, NONE, { userAgent: CHROME_UA });
    expect(env).toEqual(libraryDefaults());
  });

  it("leaves the wasm path alone when the onnxruntime version is unknown", () => {
    const env = libraryDefaults();
    env.backends.onnx.versions = undefined;
    applyBrowserModelSource(env, SELF_HOSTED, { userAgent: CHROME_UA });
    expect(env.remoteHost).toBe(`${BASE}/models/`);
    expect(env.backends.onnx.wasm?.wasmPaths).toBe("jsdelivr-default");
  });
});
