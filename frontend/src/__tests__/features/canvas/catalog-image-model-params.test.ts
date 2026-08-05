// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 目录声明的动态参数（`request.parameters`）→ 节点上的取值 → 后端 `model_params`。
//
// 这条链原来在两处断掉：
//   1. `toImageModelDefinition` 把目录参数翻译成静态注册表的 `extraParamsSchema`，
//      multiselect 被拍成单选、数字/布尔选项被拍成字符串，类型全丢；
//   2. 就算填了，`freezoneAiGateway` 只从 extraParams 里读 quality，其余键一律丢弃
//      —— 用户在节点上改目录参数，提交时等于什么都没发生，也没有任何提示。
// 所以断言必须一路走到 ops 层的 payload，并且盯住**值的类型**，只测「有没有这个键」
// 是测不出第 1 条的。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaModelParameterDefinition } from "@/api/ops";
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

const PARAMETERS: MediaModelParameterDefinition[] = [
  {
    key: "styles",
    label: "风格",
    control: "multiselect",
    requestPath: "extra_body.styles",
    options: ["anime", "photoreal", "sketch"],
  },
  {
    key: "steps",
    label: "步数",
    control: "number",
    requestPath: "extra_body.steps",
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: "hd",
    label: "高清",
    control: "switch",
    requestPath: "extra_body.hd",
  },
  {
    key: "only_edit",
    label: "仅编辑可用",
    control: "select",
    requestPath: "extra_body.only_edit",
    options: ["a", "b"],
    modes: ["image_to_image"],
  },
];

const CATALOG_ENTRY: CatalogImageModelEntry = {
  id: "studio-image-v1",
  providerId: "openrouter",
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  request: { endpoint: "images/generations", parameters: PARAMETERS },
};

/** 走一次真实提交，返回 gateway 交给 ops 层的 payload。 */
async function submittedBody(
  modelParams: Record<string, unknown>,
  referenceImages: string[] = [],
): Promise<Record<string, unknown>> {
  const definition = toImageModelDefinition(CATALOG_ENTRY);
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
    modelParams,
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

describe("目录动态参数的端到端往返", () => {
  it("目录参数原样挂在定义上，不再降级成 extraParamsSchema", () => {
    const definition = toImageModelDefinition(CATALOG_ENTRY);
    // 原样：控件类型、选项类型、modes 过滤条件都得留着，UI 才画得出多选与数字输入。
    expect(definition.requestParameters).toEqual(PARAMETERS);
    // 旧的翻译产物必须消失——它存在就意味着某处还会拿它去画控件，
    // 而它画出来的值提交路径根本不认。
    expect(definition.extraParamsSchema).toBeUndefined();
  });

  it("没有 request.parameters 的目录条目不凭空造出参数字段", () => {
    const definition = toImageModelDefinition({
      id: "plain",
      providerId: "huimeng",
      apiModel: "huimeng_gpt_image2",
      label: "Plain",
    });
    expect(definition.requestParameters).toBeUndefined();
  });

  it("生成路径：model_params 原值上送，类型不被拍平", async () => {
    const body = await submittedBody({
      styles: ["anime", "sketch"],
      steps: 28,
      hd: true,
    });
    expect(body.modelParams).toEqual({
      styles: ["anime", "sketch"],
      steps: 28,
      hd: true,
    });
    // 数组仍是数组、数字仍是数字、布尔仍是布尔 —— 后端
    // `media_model_request_schema` 按目录声明校验，字符串化会直接被判非法。
    expect(Array.isArray((body.modelParams as Record<string, unknown>).styles)).toBe(true);
    expect(typeof (body.modelParams as Record<string, unknown>).steps).toBe("number");
    expect(typeof (body.modelParams as Record<string, unknown>).hd).toBe("boolean");
  });

  it("编辑路径（带参考图）同样带上 model_params", async () => {
    const body = await submittedBody({ steps: 12 }, ["https://x/base.png"]);
    expect(body.modelParams).toEqual({ steps: 12 });
  });

  it("节点没填任何目录参数时不硬造空对象", async () => {
    const definition = toImageModelDefinition(CATALOG_ENTRY);
    await freezoneAiGateway.generateImage({
      prompt: "hi",
      model: definition.resolveRequest({ referenceImageCount: 0 }).requestModel,
      modelId: definition.id,
      size: "2K",
      aspectRatio: "1:1",
      referenceImages: [],
    });
    const body = submitFreezoneGen.mock.calls[0][1] as Record<string, unknown>;
    expect(body.modelParams).toBeUndefined();
  });

  it("按模式失活的参数照样上送，由后端按 modes 过滤", async () => {
    // 与 ImageGenNode 既有口径一致：前端不做 modes 裁剪，后端
    // `_resolve_catalog_request` 会静默过滤掉当前模式用不上的键。
    // 前端各自裁一遍只会让两边口径漂移。
    const body = await submittedBody({ only_edit: "a", steps: 4 });
    expect(body.modelParams).toEqual({ only_edit: "a", steps: 4 });
  });
});
