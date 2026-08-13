// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 刷新恢复路径上的两个时序坑：
//   1. 任务列表瞬时漏项（后端 list_tasks_for_project 单行解析失败会静默跳过），
//      单次 miss 就判「不存在」会把还在跑的任务写成失败；
//   2. 上个会话遗留的 generationJobId 与 descriptor resume 抢同一个节点——
//      gateway 内存 Map 刷新后是空的，轮询必然 not_found，写失败又比 resume 快。
// 两条都会让「稍后刷新页面查看结果」落空，所以在这里钉死。
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { CURRENT_RUNTIME_SESSION_ID } from "@/features/canvas/application/generationErrorReport";
import {
  DETACHED_GENERATION_PATCH,
  TASK_MISS_CONFIRM_ATTEMPTS,
  nodeNeedsGenerationResume,
  nodeOwnsLiveGenerationJob,
  resumeNodeGeneration,
  staleGenerationJobPatch,
} from "@/features/canvas/application/resumeGeneration";

const listTasks = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneTextGenerateResult = vi.fn();

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/api/ops", () => ({
  fetchFreezoneJobResult: vi.fn().mockResolvedValue({ url: "out.png" }),
  fetchFreezoneReversePromptResult: vi.fn(),
  fetchFreezoneStoryScriptResult: vi.fn(),
  fetchFreezoneTextGenerateResult: (...args: unknown[]) => fetchFreezoneTextGenerateResult(...args),
}));

const TASK_KEY = "freezone_image:job-9";

/** 一个刷新后待恢复的图片节点：句柄齐全、仍在生成中。 */
function resumableNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "n1",
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: TASK_KEY,
      generationTaskType: "freezone_image",
      generationTaskJobId: "job-9",
      ...extra,
    },
  } as unknown as CanvasNode;
}

function resumableTextNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "text-1",
    type: CANVAS_NODE_TYPES.textAnnotation,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: "freezone_text_generate:text-job-1",
      generationTaskType: "freezone_text_generate",
      generationTaskJobId: "text-job-1",
      ...extra,
    },
  } as unknown as CanvasNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("恢复路径：列表漏项不等于任务不存在", () => {
  it("第一次列表为空、随后出现时，照常等到结果，不写失败", async () => {
    vi.useFakeTimers();
    try {
      listTasks
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ task_key: TASK_KEY, status: "running" }]);
      awaitTaskCompletion.mockResolvedValue({
        task_key: TASK_KEY,
        status: "completed",
        result: { output_url: "out.png" },
      });
      const updateNodeData = vi.fn();

      const pending = resumeNodeGeneration({
        node: resumableNode(),
        projectId: "demo",
        updateNodeData,
      });
      await vi.runAllTimersAsync();
      await pending;

      // 第二次列表命中，于是进了 awaitTaskCompletion —— 这才是有 idle budget
      // 语义的那条路。
      expect(awaitTaskCompletion).toHaveBeenCalledTimes(1);
      const calls = updateNodeData.mock.calls;
      const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
      expect(patch.imageUrl).toBe("out.png");
      expect(patch.generationError ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续 miss 到确认次数才判定任务不存在", async () => {
    vi.useFakeTimers();
    try {
      listTasks.mockResolvedValue([]);
      const updateNodeData = vi.fn();

      const pending = resumeNodeGeneration({
        node: resumableNode(),
        projectId: "demo",
        updateNodeData,
      });
      await vi.runAllTimersAsync();
      await pending;

      expect(listTasks).toHaveBeenCalledTimes(TASK_MISS_CONFIRM_ATTEMPTS);
      // 确认到底了才写失败，并且没有白等一整个轮询预算。
      expect(awaitTaskCompletion).not.toHaveBeenCalled();
      const calls = updateNodeData.mock.calls;
      const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
      expect(patch.isGenerating).toBe(false);
      expect(patch.generationError).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("列表接口报错时绝不判失败——列不出来不等于任务没了", async () => {
    listTasks.mockRejectedValue(new Error("offline"));
    awaitTaskCompletion.mockResolvedValue({
      task_key: TASK_KEY,
      status: "completed",
      result: { output_url: "out.png" },
    });
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node: resumableNode(),
      projectId: "demo",
      updateNodeData,
    });

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(awaitTaskCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("恢复路径：文本任务按任务类型取回结果", () => {
  it("刷新后使用文本生成结果接口恢复正文和模型", async () => {
    const taskKey = "freezone_text_generate:text-job-1";
    listTasks.mockResolvedValue([{ task_key: taskKey, status: "running" }]);
    awaitTaskCompletion.mockResolvedValue({
      task_key: taskKey,
      status: "completed",
      result: { output_format: "json" },
    });
    fetchFreezoneTextGenerateResult.mockResolvedValue({
      generated_text: "雨落在旧车站的铁轨上。",
      model: "DC-freezone-text-writer-LLM",
    });
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node: resumableTextNode(),
      projectId: "demo",
      updateNodeData,
    });

    expect(fetchFreezoneTextGenerateResult).toHaveBeenCalledWith("demo", "text-job-1");
    const calls = updateNodeData.mock.calls;
    const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
    expect(patch.content).toBe("雨落在旧车站的铁轨上。");
    expect(patch.model).toBe("DC-freezone-text-writer-LLM");
    expect(patch.isGenerating).toBe(false);
  });
});

describe("恢复路径：旧会话的 generationJobId 不许抢跑", () => {
  it("旧 session jobId + 完整 descriptor：不轮询，清死 id，resume 独占", () => {
    const node = resumableNode({
      generationJobId: "gateway-job-1",
      generationClientSessionId: "session-from-before-the-refresh",
    });

    // 关键：不进轮询循环。否则 gateway 内存 Map 里查无此 id → not_found →
    // 错误分支把 isGenerating 清成 false，descriptor resume 就此断路。
    expect(nodeOwnsLiveGenerationJob(node)).toBe(false);

    const patch = staleGenerationJobPatch(node);
    expect(patch).toEqual(DETACHED_GENERATION_PATCH);
    expect(patch!.generationJobId).toBeNull();
    // isGenerating 与句柄没被动过，所以打完补丁仍然是可恢复态。
    const patched = { ...node, data: { ...node.data, ...patch } } as CanvasNode;
    expect(nodeNeedsGenerationResume(patched)).toBe(true);
  });

  it("本次会话写下的 jobId 照常轮询，不被当成遗留", () => {
    const node = resumableNode({
      generationJobId: "gateway-job-1",
      generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
    });

    expect(nodeOwnsLiveGenerationJob(node)).toBe(true);
    expect(staleGenerationJobPatch(node)).toBeNull();
  });

  it("旧 session jobId 但没有 descriptor：直接给终态，别让节点永远转圈", () => {
    // 本 PR 之前提交的老节点——后端句柄压根没落盘，谁都接不回来。
    const node = {
      id: "n2",
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: {
        isGenerating: true,
        generationJobId: "gateway-job-2",
        generationClientSessionId: "session-from-before-the-refresh",
      },
    } as unknown as CanvasNode;

    const patch = staleGenerationJobPatch(node)!;
    expect(patch.isGenerating).toBe(false);
    expect(patch.generationError).toBeTruthy();
  });

  it("没在生成中的节点一律不管", () => {
    const node = {
      id: "n3",
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: { isGenerating: false, generationJobId: "gateway-job-3" },
    } as unknown as CanvasNode;

    expect(nodeOwnsLiveGenerationJob(node)).toBe(false);
    expect(staleGenerationJobPatch(node)).toBeNull();
  });
});
