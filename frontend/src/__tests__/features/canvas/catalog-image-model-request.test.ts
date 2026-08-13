// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 目录条目 → `ImageModelDefinition.resolveRequest` → `freezoneAiGateway` 的
// provider/model 往返。这条链上唯一的耦合点是「gateway 按**第一个** `/` 拆
// provider/model」，而目录的 apiModel 自己可能就带命名空间（OpenRouter 的
// `google/gemini-...`）。只测 resolveRequest 的返回值形状是测不出问题的——
// 必须让真的 gateway 去拆一遍，断言后端最终收到的两个字段。
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  toImageModelDefinition,
  type CatalogImageModelEntry,
} from "@/features/canvas/domain/catalogImageModels";
import { freezoneAiGateway } from "@/features/canvas/infrastructure/freezoneAiGateway";

const submitFreezoneGen = vi.fn();
const submitFreezoneEdit = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();

vi.mock("@/api/ops", () => ({
  submitFreezoneGen: (...args: unknown[]) => submitFreezoneGen(...args),
  submitFreezoneEdit: (...args: unknown[]) => submitFreezoneEdit(...args),
  fetchFreezoneJobResult: (...args: unknown[]) => fetchFreezoneJobResult(...args),
}));

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));

const JOB_REF = {
  task_type: "freezone_image",
  job_id: "img-1",
  task_key: "freezone_image:img-1",
};

function entry(overrides: Partial<CatalogImageModelEntry>): CatalogImageModelEntry {
  return {
    id: "openrouter/gemini-2.5-flash-image",
    providerId: "openrouter",
    apiModel: "google/gemini-2.5-flash-image-preview",
    label: "Gemini 2.5 Flash Image",
    ...overrides,
  };
}

/** 走一次真实提交，返回 gateway 交给 ops 层的 payload（provider/model 已拆好）。 */
async function submittedBody(
  model: CatalogImageModelEntry,
  referenceImages: string[] = [],
): Promise<Record<string, unknown>> {
  const definition = toImageModelDefinition(model);
  const { requestModel } = definition.resolveRequest({
    referenceImageCount: referenceImages.length,
  });
  await freezoneAiGateway.generateImage({
    prompt: "hi",
    model: requestModel,
    modelId: definition.id,
    size: "2K",
    aspectRatio: "1:1",
    referenceImages,
  });
  const spy = referenceImages.length > 0 ? submitFreezoneEdit : submitFreezoneGen;
  return spy.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitFreezoneGen.mockResolvedValue(JOB_REF);
  submitFreezoneEdit.mockResolvedValue(JOB_REF);
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/1.png" } });
});

describe("目录模型的 provider/model 往返", () => {
  it("OpenRouter 命名空间模型：provider 归 openrouter，model 保留完整多段名", async () => {
    const body = await submittedBody(entry({}));
    expect(body.provider).toBe("openrouter");
    // 关键断言：不能被截成 `gemini-2.5-flash-image-preview`——那个串不在目录
    // 条目的 identifiers 里，后端会 400 "model does not match configured media model"。
    expect(body.model).toBe("google/gemini-2.5-flash-image-preview");
  });

  it("编辑路径（带参考图）同样保留完整模型名", async () => {
    const body = await submittedBody(entry({}), ["https://x/base.png"]);
    expect(body.provider).toBe("openrouter");
    expect(body.model).toBe("google/gemini-2.5-flash-image-preview");
  });

  it("apiModel 不带命名空间时也不能丢 provider", async () => {
    const body = await submittedBody(
      entry({
        id: "huimeng/gpt-image-2",
        providerId: "huimeng",
        apiModel: "huimeng_gpt_image2",
      }),
    );
    expect(body.provider).toBe("huimeng");
    expect(body.model).toBe("huimeng_gpt_image2");
  });

  it("目录 id 与 provider/apiModel 组合不一致时，送的是 apiModel 而非 id", async () => {
    // 后台可以给条目配任意 id；能被后端 identifiers 认出来的是 apiModel。
    const body = await submittedBody(
      entry({ id: "custom-slug", providerId: "openai", apiModel: "gpt-image-2" }),
    );
    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-image-2");
    expect(body.modelId).toBe("custom-slug");
  });
});
