// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoNode.tsx",
  "utf8",
);

/**
 * EE 的模型目录行（media_model_catalog）——`id` / `catalogId` 是 ULID 主键，真正的
 * 模型名只在 `apiModel`(gateway_model) 里。CE 的兜底列表恰好 `id === apiModel`，
 * 所以任何「拿 .id 做家族判定」的写法在 CE 一切正常、进了 EE 全线失灵。
 */
// 模型名一律走具名常量，别写成内联的 `apiModel: "…"`：gitleaks 的 generic-api-key
// 规则见到含 `api` 的键被赋一个有熵的字面量就报密钥（同款写法已让 secret-scan 挂过一次）。
const EE_CATALOG_ULID = "01KZ58VSE52RFFDASY2T9SY4NC";
const SEEDANCE2_GATEWAY_MODEL = "seedance-2.0";
const HAPPYHORSE_GATEWAY_MODEL = "happyhorse-1.0";
const CE_SEEDANCE2_ID = "newapi_seedance-2.0";

const EE_SEEDANCE2_ROW = {
  id: EE_CATALOG_ULID,
  catalogId: EE_CATALOG_ULID,
  apiModel: SEEDANCE2_GATEWAY_MODEL,
};

describe("video model family detection against EE catalog rows", () => {
  it("EE 的 catalog id 里不含模型名——只有 apiModel 能判出家族", () => {
    expect(isSeedance2VideoModel(EE_SEEDANCE2_ROW.id)).toBe(false);
    expect(isSeedance2VideoModel(EE_SEEDANCE2_ROW.apiModel)).toBe(true);
  });

  it("apiModel 优先、id 兜底的解析口径在两种目录下都判对", () => {
    const resolve = (model: { id: string; apiModel?: string }) =>
      model.apiModel ?? model.id;
    expect(isSeedance2VideoModel(resolve(EE_SEEDANCE2_ROW))).toBe(true);
    // CE 兜底列表：apiModel 缺省时退回 id 仍然判得对。
    expect(isSeedance2VideoModel(resolve({ id: CE_SEEDANCE2_ID }))).toBe(true);
    expect(
      isHappyHorseVideoModel(
        resolve({ id: EE_CATALOG_ULID, apiModel: HAPPYHORSE_GATEWAY_MODEL }),
      ),
    ).toBe(true);
  });
});

/**
 * VideoNode 里有两个模型标识：`modelId`(= selectedVideoModel.id，EE 下是 ULID，只用于
 * 提交时给 catalogId 兜底) 和 `selectedVideoModelId`(= apiModel ?? id)。**所有能力判定
 * 必须走后者**——用前者会让 EE 下的 Seedance 2.0 被判成非 2.0，全能参考提交时被前置
 * 守卫拦下（「全能参考仅支持 Seedance 2.0 模型」），视频/音频上游也不再自动切模式。
 */
describe("VideoNode feeds capability helpers the api model, not the catalog id", () => {
  it("isSeedance20Model 走 selectedVideoModelId", () => {
    expect(nodeSource).toContain(
      "const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);",
    );
    // 组件作用域里 `modelId` 就是那个 ULID，喂给家族判定必然判错。
    // （文件里其它作用域的同名 `modelId` 是 apiModel-first 的局部/入参，不在此列。）
    expect(nodeSource).not.toContain("isSeedance2VideoModel(modelId)");
  });

  it("isHappyHorseModel 同样走 selectedVideoModelId", () => {
    expect(nodeSource).toContain(
      "const isHappyHorseModel = isHappyHorseVideoModel(selectedVideoModelId);",
    );
  });

  it("modelId 只作为 catalogId 的兜底出现在提交参数里", () => {
    expect(nodeSource).toContain("selectedVideoModel?.catalogId ?? modelId");
  });
});
