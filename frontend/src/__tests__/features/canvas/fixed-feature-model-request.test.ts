// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 无模型选择器的面板（360 全景 / 宫格动作）：调用方选定模型后，报价参数与提交字段必须同源。
//
// 原来两边各写各的 —— 报价按选定模型 + 收敛后的 size/quality 算，提交却什么
// 都不带，后端于是用自己的默认模型和固定 2K 去跑。目录首模型不是后端默认模型、
// 或它根本不支持 2K 时，界面标的价格和能力档位与真正执行的是两回事。
import { describe, expect, it } from "vitest";

import { resolveFixedFeatureModelRequest } from "@/features/canvas/domain/fixedFeatureModelRequest";

const CATALOG_MODEL = {
  catalogId: "cat-77",
  apiModel: "google/gemini-2.5-flash-image-preview",
  resolutionOptions: ["1K", "4K"],
  qualityOptions: ["low", "high"],
};

describe("resolveFixedFeatureModelRequest", () => {
  it("提交的 size/quality 与报价用的完全一致", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    expect(submit.imageSize).toBe(billingParams.size);
    expect(submit.quality).toBe(billingParams.quality);
  });

  it("模型不支持默认档位时收敛到它真支持的档位，而不是硬发 2K/medium", () => {
    const { submit } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    // 目录只配了 1K / 4K 与 low / high。
    expect(submit.imageSize).toBe("1K");
    expect(submit.quality).toBe("low");
  });

  it("带上模型与目录身份，不把模型选择留给后端默认", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    expect(submit.model).toBe(CATALOG_MODEL.apiModel);
    expect(submit.catalogId).toBe("cat-77");
    // 报价侧的模型身份也来自同一个条目。
    expect(billingParams.image_selection).toBe(CATALOG_MODEL.apiModel);
    expect(billingParams.catalog_id).toBe("cat-77");
  });

  it("模型名不加 provider 前缀", () => {
    const { submit } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    // scene-360 那条老路由把 provider 恒定当成 newapi，整串 `provider/model`
    // 会被原样当作模型名送给网关。
    expect(submit.model).not.toContain("openrouter/");
  });

  it("目录没声明画质：既不下发 quality，也不按 quality 报价", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest({
      apiModel: "huimeng_gpt_image2",
      resolutionOptions: ["1K", "2K"],
    });
    expect(submit.quality).toBeUndefined();
    expect(billingParams).not.toHaveProperty("quality");
    expect(submit.imageSize).toBe("2K");
  });

  it("目录没配分辨率时用通用兜底档位，且两侧仍一致", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest({
      apiModel: "huimeng_gpt_image2",
    });
    expect(submit.imageSize).toBe("2K");
    expect(billingParams.size).toBe("2K");
  });

  it("没有可用模型时不伪造模型身份", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(undefined);
    expect(submit.model).toBeUndefined();
    expect(submit.catalogId).toBeUndefined();
    expect(billingParams).not.toHaveProperty("image_selection");
  });

  it("额外报价参数（宫格 mode）只进报价，不污染提交字段", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL, {
      mode: "multi_camera_nine_grid",
    });
    expect(billingParams.mode).toBe("multi_camera_nine_grid");
    expect(submit).not.toHaveProperty("mode");
  });
});
