// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 脱离监听 ≠ 生成失败。后端还在跑，节点上的任务句柄（generationTaskKey /
// TaskType / TaskJobId）是刷新后 resumeNodeGeneration 找回结果的唯一线索——
// 这里锁住「脱离时保留句柄、不写错误」和「真失败时清句柄、写错误」两条相反的路径。
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPollTimeoutError } from "@/api/tasks";
import { regenerateExportImageNode } from "@/features/canvas/application/regenerateExportNode";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

const submitFreezoneRedraw = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneJobResult = vi.fn();

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
