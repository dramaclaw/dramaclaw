// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 「素材含真人被内容安全拦截」的专用引导，靠的是在**保真的**诊断报文里找厂商错误
// 码。归一化后的展示文案里没有这个码——一旦策略判定改回去扫 resolved/display，
// 用户看到的就只是一句泛泛的「视频生成失败」，不知道去开「真人素材审核」开关。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneVideoGen } from "@/api/ops";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// t 返回 key：模拟「有译文」的真实运行时，展示文案因此不含厂商错误码——
// 这正是本用例要区分的两条路径。
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

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

const POLICY_CODE = "InputImageSensitiveContentDetected.PrivateInformation";
const RAW_BACKEND_ERROR = `provider rejected: ${POLICY_CODE} (request_id=req-xyz789)`;

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: "huimeng/test-video",
      providerId: "huimeng",
      apiModel: "test_video_api",
      label: "测试视频模型",
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => {
    throw new Error(RAW_BACKEND_ERROR);
  }),
}));

function seed() {
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "vid-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: {
          prompt: "一只猫跳上桌子",
          modelId: "huimeng/test-video",
          genMode: "textToVideo",
        },
      } as CanvasNode,
    ],
    [],
  );
}

describe("VideoNode error notification contract", () => {
  beforeEach(() => {
    vi.mocked(showErrorDialog).mockClear();
    seed();
  });

  it("routes a policy-blocked failure to the real-person-review guidance", async () => {
    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(showErrorDialog).toHaveBeenCalled();
    });
    const dialogCalls = vi.mocked(showErrorDialog).mock.calls;
    const [message, title, details] = dialogCalls[dialogCalls.length - 1];
    expect(String(message)).toContain("真人素材审核");
    expect(String(title)).toBe("素材被拦截");
    // 诊断报文原样透传给对话框——展开「详情」时看到的必须是厂商原文。
    expect(String(details)).toContain(POLICY_CODE);
  });

  it("falls back to the generic dialog when the failure is not policy-related", async () => {
    vi.mocked(submitFreezoneVideoGen).mockImplementationOnce(async () => {
      throw new Error("upstream timed out (request_id=req-timeout)");
    });

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(showErrorDialog).toHaveBeenCalled();
    });
    const dialogCalls = vi.mocked(showErrorDialog).mock.calls;
    const [message] = dialogCalls[dialogCalls.length - 1];
    expect(String(message)).not.toContain("真人素材审核");
  });
});
