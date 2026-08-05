// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「后台一个图片模型都没配」和「目录接口挂了」必须是两种状态。
//
// 之前 useCatalogImageModels 无条件把空目录换成前端硬编码的 SHARED_MODELS，两种
// 情况被抹平成同一种：用户在权威空目录下看到一堆能选的模型，选中、点生成，才被
// 后端 `_resolve_catalog_request` 用 409 顶回来。失败兜底是对的（不然接口一抖用户
// 就干不了活），把「没配」也伪装成「有」是错的。
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCatalogImageModels } from "@/features/canvas/domain/catalogImageModels";
import type { UseFreezoneImageModelsResult } from "@/features/canvas/hooks/useFreezoneImageModels";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { SHARED_MODELS } from "@/features/canvas/ui/ProviderModelPicker";

let hookState: UseFreezoneImageModelsResult;

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => hookState,
  prefetchFreezoneImageModels: () => {},
}));

const CATALOG_MODEL: ModelOption = {
  id: "studio-image-v1",
  providerId: "openrouter",
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
};

function read(state: UseFreezoneImageModelsResult) {
  hookState = state;
  return renderHook(() => useCatalogImageModels()).result.current;
}

describe("useCatalogImageModels 的空目录语义", () => {
  it("拉取失败：hook 已经塞了兜底列表，照常可用，不算空", () => {
    const result = read({
      models: SHARED_MODELS,
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    });
    expect(result.isEmpty).toBe(false);
    expect(result.models.length).toBe(SHARED_MODELS.length);
    expect(result.getModel(null)).toBeDefined();
  });

  it("加载中：先用兜底撑住，别闪一下「无可用模型」", () => {
    const result = read({
      models: SHARED_MODELS,
      isLoading: true,
      isFallback: true,
      error: null,
    });
    expect(result.isEmpty).toBe(false);
    expect(result.isLoading).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("接口成功但返回空列表：这是后台的权威答案，不许拿硬编码模型盖掉", () => {
    const result = read({
      models: [],
      isLoading: false,
      isFallback: false,
      error: null,
    });
    expect(result.isEmpty).toBe(true);
    expect(result.models).toEqual([]);
    // 节点上存着的旧模型 id 也不能凭空复活成兜底模型。
    expect(result.getModel("huimeng_gpt_image2")).toBeUndefined();
    expect(result.getModel(null)).toBeUndefined();
  });

  it("正常目录：只出目录里的模型，不掺兜底", () => {
    const result = read({
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: false,
      error: null,
    });
    expect(result.isEmpty).toBe(false);
    expect(result.models.map((model) => model.id)).toEqual([CATALOG_MODEL.id]);
    expect(result.getModel(CATALOG_MODEL.apiModel)?.id).toBe(CATALOG_MODEL.id);
  });
});
