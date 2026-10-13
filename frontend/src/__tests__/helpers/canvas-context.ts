// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { vi, type MockInstance } from "vitest";

/**
 * 单测用的 getContext 探针：把重载收成「任意 contextId → 任意上下文」。
 *
 * getContext 是重载方法，vi.spyOn 只认最后一条重载。pixi.js 带进来的 WebGPU 类型给它
 * 追加了 `getContext('webgpu'): GPUCanvasContext`，于是直接 spyOn 之后就只能塞
 * GPUCanvasContext，2D 假上下文过不了类型检查。各处统一从这里拿探针。
 */
export function spyOnCanvasGetContext() {
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext") as unknown as MockInstance<
    (contextId: string) => RenderingContext | null
  >;
}
