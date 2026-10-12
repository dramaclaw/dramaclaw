// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 视频生成的计费契约——**行为断言**，不是源码 grep。
//
// 询价与提交禁用条件住在 `useVideoGenerationForm` 里，工作流的 VideoNode 和故事板
// 的 AssetBoardVideoGenForm 都挂它，所以对着 hook 断言就同时覆盖了两个视图。这份
// 文件取代了原来 readFileSync + toContain 的版本：那种写法在重构把代码搬进新文件
// 后，只要字符串跟着搬过去就照样「通过」，验证力为零。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useCanvasStore } from "@/stores/canvasStore";
import { submitFreezoneVideoGen } from "@/api/ops";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string"
        ? fallback
        : ((fallback as { defaultValue?: string } | undefined)?.defaultValue ?? key),
  }),
}));

// 只替换 hook，保留真的 BillingRuleNotConfiguredError —— 断言依赖 instanceof。
vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: vi.fn(() => ({ data: undefined, error: null })),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "default" }),
}));

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: "huimeng/test-video",
      providerId: "huimeng",
      apiModel: "test_video_api",
      label: "测试视频模型",
      catalogId: "catalog-1",
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => ({
    task_key: "task-1",
    task_type: "freezone_video_gen",
    job_id: "job-1",
  })),
}));

const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "vid-1",
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      prompt: "一只猫跳上桌子",
      modelId: "huimeng/test-video",
      genMode: "textToVideo",
      ...data,
    },
  } as CanvasNode;
}

function seed(data: Record<string, unknown> = {}) {
  useCanvasStore.getState().setCanvasData([videoNode(data)], []);
}

/** 询价 hook 最近一次的 (value, options)。 */
function latestProbe() {
  const calls = vi.mocked(useGenerationCreditCost).mock.calls;
  const featureCalls = calls.filter((call) => call[1] === VIDEO_GENERATE_FEATURE_KEY);
  return featureCalls[featureCalls.length - 1] ?? null;
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "vid-1")?.data ??
    {}) as Record<string, unknown>;
}

describe("canvas video generation credit contract", () => {
  beforeEach(() => {
    vi.mocked(useGenerationCreditCost).mockClear();
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: null,
    } as ReturnType<typeof useGenerationCreditCost>);
    vi.mocked(submitFreezoneVideoGen).mockClear();
  });

  it("quotes the product feature with the output and input-video parameters", async () => {
    seed({ count: 2, durationSec: 5 });

    renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(latestProbe()).not.toBeNull();
    });
    const [, , options] = latestProbe()!;
    expect(options).toMatchObject({
      surface: "canvas",
      quantity: 2,
      params: expect.objectContaining({
        catalog_id: "catalog-1",
        video_backend: "test_video_api",
        operation: "textToVideo",
        // 视频按「条数 × 时长」计价，不是按条数。
        pricing_quantity: 2 * 5,
        video_input_present: false,
        input_video_duration_seconds: 0,
      }),
    });
  });

  it("blocks submission and reports it on the node when the billing rule is missing", async () => {
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: new BillingRuleNotConfiguredError("no rule", 409),
    } as unknown as ReturnType<typeof useGenerationCreditCost>);
    seed();

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(true);
    });

    await result.current.submit();

    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
    expect(String(nodeData().generationError)).toContain("计费规则未配置");
    expect(nodeData().generationErrorDetails).toBe(nodeData().generationError);
    expect(nodeData().isGenerating).toBe(false);
  });

  it("gates the error-state regenerate path on the billing rule too", async () => {
    // 失败横幅上的重试按钮是节点未选中时唯一还能提交的入口，它的 disabled 接的
    // 就是 submitDisabled（VideoNode.tsx），handleSubmit 开头也再拦一道。
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: new BillingRuleNotConfiguredError("no rule", 409),
    } as unknown as ReturnType<typeof useGenerationCreditCost>);
    seed({ generationError: "上游服务超时", isGenerating: false });

    const { result } = renderHook(() =>
      // 未选中 —— 宿主关掉了常规询价，失败态仍须拿到 billing 闸门。
      useVideoGenerationForm("vid-1", { costProbeEnabled: false }),
    );

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(true);
    });

    await result.current.submit();
    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
  });

  it("allows submission once the billing rule resolves", async () => {
    seed();

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
  });
});
