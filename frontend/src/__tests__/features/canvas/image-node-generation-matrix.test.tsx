// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 工作流图片节点的等价性矩阵：文生图 / 图生图 / 多参考图 × 提交载荷、多结果、
// 恢复句柄、历史刷新。
//
// 为什么要单独有这一份：ImageGenNode 的表单逻辑整体搬进了 `useImageGenerationForm`
// （与故事板资产板共用）。asset-board-* 那一大批测试盯的是**资产板视图**，工作流
// 节点这一侧走的是同一个 hook 但另一套宿主参数（自身参考图、上游连线、画册、任务
// 句柄持久化），此前只有报价与失败态有行为覆盖。这里补的是「同一个 hook 在节点视图
// 下产出的东西还是不是原来那个」。
//
// 断言一律落在 ops 层的载荷与节点数据上——中间怎么重构都行，这两头必须不变。
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneGen } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "canvas-7" }),
}));

let submitSeq = 0;

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
    submitSeq += 1;
    return {
      task_key: `task-${submitSeq}`,
      task_type: "freezone_gen",
      job_id: `job-${submitSeq}`,
    };
  }),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: "/static/fallback.png" })),
}));

vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  // 每个任务回一张与自己 task_key 对应的图，方便断言画册收齐了几张。
  awaitTaskCompletion: vi.fn(async (taskKey: string) => ({
    result: { output_url: `/static/${taskKey}.png` },
  })),
}));

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

function imageGenNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "img-1",
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "一只在窗台上的猫", modelId: "huimeng/test-image", ...data },
  } as CanvasNode;
}

function uploadNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: { imageUrl: url },
  } as CanvasNode;
}

function edge(id: string, source: string): { id: string; source: string; target: string } {
  return { id, source, target: "img-1" };
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "img-1")?.data ??
    {}) as Record<string, unknown>;
}

function payloads() {
  return vi.mocked(submitFreezoneGen).mock.calls.map((call) => call[1]);
}

/** 挂 hook、等就绪、提交、等落地。 */
async function submitAndSettle(options?: { onGenerationSettled?: () => void }) {
  const { result } = renderHook(() => useImageGenerationForm("img-1", options));
  await waitFor(() => {
    expect(result.current.submitDisabled).toBe(false);
  });
  await result.current.submit();
  await waitFor(() => {
    expect(nodeData().isGenerating).toBe(false);
  });
  return result;
}

beforeEach(() => {
  submitSeq = 0;
  vi.mocked(submitFreezoneGen).mockClear();
});

describe("图片节点：三种参考图形态的提交载荷", () => {
  it("文生图 —— 没有任何参考图", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode()], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({
      genMode: "text_to_image",
      referenceUrls: [],
      model: "test_image_api",
      modelId: "huimeng/test-image",
      // 画布 id 从 URL 取，后端按它归档产物。
      canvasId: "canvas-7",
      nodeId: "img-1",
    });
  });

  it("图生图 —— 单张上游图", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode(), uploadNode("src-1", "/static/a.png")], [edge("e1", "src-1")]);

    await submitAndSettle();

    expect(payloads()[0]).toMatchObject({
      genMode: "image_to_image",
      referenceUrls: ["/static/a.png"],
    });
  });

  it("多参考图 —— 自身参考图排第 1、上游按连线顺序接在后面，URL 去重", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          imageGenNode({ referenceImageUrl: "/static/own.png" }),
          uploadNode("src-1", "/static/a.png"),
          uploadNode("src-2", "/static/b.png"),
          // 与自身参考图同一张：不能在列表里出现两次，否则后端的 @图片N 整体偏移。
          uploadNode("src-3", "/static/own.png"),
        ],
        [edge("e1", "src-1"), edge("e2", "src-2"), edge("e3", "src-3")],
      );

    await submitAndSettle();

    expect(payloads()[0]).toMatchObject({
      genMode: "image_to_image",
      referenceUrls: ["/static/own.png", "/static/a.png", "/static/b.png"],
    });
  });
});

describe("图片节点：多结果画册", () => {
  it("生成数量 3 → 并发提交 3 次，三张全落进同一个节点的画册", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 3 })], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(3);
    // 不再复制兄弟节点：画布上还是只有这一个图片节点。
    expect(
      useCanvasStore.getState().nodes.filter((n) => n.type === CANVAS_NODE_TYPES.imageGen),
    ).toHaveLength(1);

    const batch = nodeData().generationBatch as string[];
    expect(batch).toHaveLength(3);
    expect([...batch].sort()).toEqual([
      "/static/task-1.png",
      "/static/task-2.png",
      "/static/task-3.png",
    ]);
    // 第 1 张完成的同时成为主图。
    expect(batch).toContain(nodeData().imageUrl);
  });

  it("单张时不写画册（叠卡 UI 只在多结果下出现）", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 1 })], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(1);
    expect(nodeData().generationBatch).toBeNull();
    expect(nodeData().imageUrl).toBe("/static/task-1.png");
  });
});

describe("图片节点：恢复与历史", () => {
  it("提交后立刻把任务句柄写到节点上（刷新页面才能续上轮询）", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode()], []);

    await submitAndSettle();

    expect(nodeData()).toMatchObject({
      generationTaskKey: "task-1",
      generationTaskType: "freezone_gen",
      generationTaskJobId: "job-1",
    });
  });

  it("多结果时只持久化 run 0 的句柄（节点上只有一份，不能被后来的覆盖）", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 3 })], []);

    await submitAndSettle();

    expect(nodeData().generationTaskKey).toBe("task-1");
  });

  it("整批落地后回调宿主刷新历史", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 2 })], []);
    const onGenerationSettled = vi.fn();

    await submitAndSettle({ onGenerationSettled });

    await waitFor(() => {
      expect(onGenerationSettled).toHaveBeenCalled();
    });
  });
});
