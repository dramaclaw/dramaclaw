// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 生成失败时节点上留下的三个字段必须各司其职：
//   generationError        → 给用户看的、已本地化/归一化的文案
//   generationErrorDetails → 原始后端报文，一字不动（工单要靠它）
//   generationErrorRequestId → 从原始报文里抽出的 request id
// 把 display 覆盖进 details 是最容易犯的回归，且 UI 上完全看不出来。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { InsufficientCreditsError } from "@/lib/api-errors";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// 关键：t 返回 key 而不是 defaultValue，这样「已本地化的展示文案」和「原始后端
// 报文」天然不同，断言才能证明两者被分开存了。真实运行时也是这样（有译文）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "default" }),
}));

const RAW_BACKEND_ERROR =
  "gateway rejected the request: quota exhausted (request_id=req-abc123)";

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "测试模型",
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneGen: vi.fn(async () => {
    throw new InsufficientCreditsError(RAW_BACKEND_ERROR, 402);
  }),
}));

// 整批失败后会弹一次错误框，测试树里不需要它。
vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/application/errorDialog")
  >()),
  showErrorDialog: vi.fn(async () => undefined),
}));

function seed() {
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "img-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: { prompt: "一只在窗台上的猫", modelId: "huimeng/test-image" },
      } as CanvasNode,
    ],
    [],
  );
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "img-1")?.data ??
    {}) as Record<string, unknown>;
}

describe("ImageGen error notification contract", () => {
  beforeEach(() => {
    seed();
  });

  it("stores the raw backend error separately from the displayed message", async () => {
    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(nodeData().generationErrorDetails).toBeTruthy();
    });

    // 原始报文一字不动地留在 details 里。
    expect(nodeData().generationErrorDetails).toBe(RAW_BACKEND_ERROR);
    // 展示文案是本地化后的，不等于原始报文。
    expect(nodeData().generationError).toBe("translated:common.insufficientCredits");
    expect(nodeData().generationError).not.toBe(RAW_BACKEND_ERROR);
    // request id 从原始报文里抽出来，单独存一份供工单引用。
    expect(nodeData().generationErrorRequestId).toBe("req-abc123");
    // 失败必须终结 loading，否则节点会一直转圈。
    expect(nodeData().isGenerating).toBe(false);
  });
});
