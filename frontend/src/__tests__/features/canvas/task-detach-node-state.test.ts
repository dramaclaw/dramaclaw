// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 脱离监听 ≠ 生成失败。后端还在跑，节点上的任务句柄（generationTaskKey /
// TaskType / TaskJobId）是刷新后 resumeNodeGeneration 找回结果的唯一线索——
// 这里锁住「脱离时保留句柄、不写错误」和「真失败时清句柄、写错误」两条相反的路径。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPollTimeoutError } from "@/api/tasks";
import { regenerateExportImageNode } from "@/features/canvas/application/regenerateExportNode";
import { DETACHED_GENERATION_PATCH } from "@/features/canvas/application/resumeGeneration";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

const submitFreezoneRedraw = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const submitGenerateImageJob = vi.fn();

// 只替 gateway，其余（canvasNodeFactory 等）走真身，否则 store.addNode 会炸。
vi.mock("@/features/canvas/application/canvasServices", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/canvas/application/canvasServices")
  >();
  return {
    ...actual,
    canvasAiGateway: {
      ...actual.canvasAiGateway,
      submitGenerateImageJob: (...args: unknown[]) => submitGenerateImageJob(...args),
    },
  };
});

vi.mock("@/api/ops", () => ({
  submitFreezoneRedraw: (...args: unknown[]) => submitFreezoneRedraw(...args),
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
  readUrl: () => ({ project: "demo" }),
}));

const IMAGE_JOB_REF = {
  task_type: "freezone_image",
  job_id: "img-1",
  task_key: "freezone_image:img-1",
};

const JOB_REF = {
  task_type: "freezone_image_redraw",
  job_id: "job-1",
  task_key: "freezone_image_redraw:job-1",
};

function seedRedrawNode(): string {
  const store = useCanvasStore.getState();
  store.setCanvasData([], []);
  return useCanvasStore.getState().addNode(
    CANVAS_NODE_TYPES.exportImage,
    { x: 0, y: 0 },
    {
      freezoneRedrawRequest: {
        sourceUrl: "src.png",
        maskUrl: "mask.png",
        aspectRatio: "original",
        imageSize: "2K",
      },
    },
  );
}

function nodeData(nodeId: string): Record<string, unknown> {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  return (node?.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitFreezoneRedraw.mockResolvedValue(JOB_REF);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("重绘节点：轮询脱离后的节点状态", () => {
  it("脱离时保留 isGenerating 与任务句柄，且不写错误横幅", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockRejectedValue(
      new TaskPollTimeoutError(JOB_REF.task_key, 40 * 60 * 1000, 35 * 60 * 1000, "running"),
    );

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    // 任务还活着：横幅不能写，转圈不能停。
    expect(data.generationError ?? null).toBeNull();
    expect(data.isGenerating).toBe(true);
    // 句柄三件套完整保留，刷新后才接得回来。
    expect(data.generationTaskKey).toBe(JOB_REF.task_key);
    expect(data.generationTaskType).toBe(JOB_REF.task_type);
    expect(data.generationTaskJobId).toBe(JOB_REF.job_id);
  });

  it("真失败时照旧写错误并清掉句柄", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockRejectedValue(new Error("redraw exploded"));

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    expect(data.generationError).toBe("redraw exploded");
    expect(data.isGenerating).toBe(false);
    expect(data.generationTaskKey).toBeNull();
    expect(data.generationTaskType).toBeNull();
    expect(data.generationTaskJobId).toBeNull();
  });

  it("图片任务提交后同样落句柄——脱离时才有东西可留", async () => {
    const store = useCanvasStore.getState();
    store.setCanvasData([], []);
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      { generationRequestPayload: { prompt: "p", model: "m", size: "2K", aspectRatio: "1:1" } },
    );
    submitGenerateImageJob.mockResolvedValue({ jobId: IMAGE_JOB_REF.job_id, ref: IMAGE_JOB_REF });

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    // gateway 的内存 job id 只服务本次会话的轮询循环……
    expect(data.generationJobId).toBe(IMAGE_JOB_REF.job_id);
    // ……真正能跨刷新的是这三件套。以前这条路径只存 jobId，脱离后无从找回。
    expect(data.generationTaskKey).toBe(IMAGE_JOB_REF.task_key);
    expect(data.generationTaskType).toBe(IMAGE_JOB_REF.task_type);
    expect(data.generationTaskJobId).toBe(IMAGE_JOB_REF.job_id);
  });

  it("脱离后的节点状态，下次加载确实会被 resume 扫描捡起来", async () => {
    const store = useCanvasStore.getState();
    store.setCanvasData([], []);
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      { generationRequestPayload: { prompt: "p", model: "m", size: "2K", aspectRatio: "1:1" } },
    );
    submitGenerateImageJob.mockResolvedValue({ jobId: IMAGE_JOB_REF.job_id, ref: IMAGE_JOB_REF });
    await regenerateExportImageNode(nodeId);

    // 用 Canvas.tsx detached 分支真正写下去的那个补丁，别手抄——手抄的话谁在
    // Canvas.tsx 里补回一句 isGenerating: false，这条用例照样绿。
    useCanvasStore.getState().updateNodeData(nodeId, DETACHED_GENERATION_PATCH);

    const detached = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)!;
    expect((detached.data as Record<string, unknown>).isGenerating).toBe(true);
    expect((detached.data as Record<string, unknown>).generationError ?? null).toBeNull();

    // 重新加载模块 = 模拟刷新：sessionOwnedTaskKeys 是空的，扫描不再跳过它。
    // 这一步是提示语「稍后刷新页面查看结果」能否兑现的判定点。
    vi.resetModules();
    const { nodeNeedsGenerationResume } = await import(
      "@/features/canvas/application/resumeGeneration"
    );
    expect(nodeNeedsGenerationResume(detached)).toBe(true);
  });

  it("成功时落图并清掉句柄", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockResolvedValue({
      task_key: JOB_REF.task_key,
      status: "completed",
      result: { output_url: "out.png" },
    });

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    expect(data.imageUrl).toBe("out.png");
    expect(data.isGenerating).toBe(false);
    expect(data.generationTaskKey).toBeNull();
  });
});
