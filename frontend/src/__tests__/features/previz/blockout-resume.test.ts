// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「参考图转白模」走画布统一的恢复路径：节点上有任务句柄就接上去等，落地后写回。
// 关掉编辑器、刷新页面之后也是这一条路把结果接回来。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { TaskCompletionError } from "@/api/tasks";
import { resumeNodeGeneration } from "@/features/canvas/application/resumeGeneration";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { createDefaultScene, type PrevizScene } from "@/features/previz/domain/scene";
import { usePrevizStore } from "@/features/previz/store";

const listTasks = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneImageToBlockoutResult = vi.fn();

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});
vi.mock("@/api/ops", () => ({
  fetchFreezoneJobResult: vi.fn(),
  fetchFreezoneReversePromptResult: vi.fn(),
  fetchFreezoneStoryScriptResult: vi.fn(),
  fetchFreezoneTextGenerateResult: vi.fn(),
  fetchFreezoneImageToBlockoutResult: (...args: unknown[]) =>
    fetchFreezoneImageToBlockoutResult(...args),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

const TASK_KEY = "freezone_image_to_blockout:job-7";

function piece(index: number): Record<string, unknown> {
  return {
    id: `blockout-box_${index}`,
    kind: "prop",
    name: `box_${index}`,
    visible: true,
    locked: false,
    transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    assetUrl: "cube",
    assetFormat: "primitive",
    blockout: { id: `box_${index}`, semanticType: "prop" },
  };
}

function previzNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "previz-1",
    type: CANVAS_NODE_TYPES.previz,
    position: { x: 0, y: 0 },
    data: {
      scene: null,
      isGenerating: true,
      generationTaskKey: TASK_KEY,
      generationTaskType: "freezone_image_to_blockout",
      generationTaskJobId: "job-7",
      blockoutImportMode: "replace",
      ...extra,
    },
  } as unknown as CanvasNode;
}

function resume(node: CanvasNode) {
  const updateNodeData = vi.fn();
  const promise = resumeNodeGeneration({
    node,
    projectId: "demo",
    updateNodeData,
    getNodeData: () => node.data as Record<string, unknown>,
  });
  return { promise, updateNodeData };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  listTasks.mockResolvedValue([{ task_key: TASK_KEY, status: "running" }]);
  awaitTaskCompletion.mockResolvedValue({ task_key: TASK_KEY, status: "completed", result: {} });
  fetchFreezoneImageToBlockoutResult.mockResolvedValue({
    objects: [piece(0), piece(1)],
    reference_camera_id: null,
    warnings: [],
  });
  usePrevizStore.getState().loadScene(createDefaultScene());
  usePrevizStore.getState().unloadScene();
});

describe("resumeNodeGeneration for a previz node", () => {
  it("waits with the blockout budget, fetches the result and writes the scene onto the node", async () => {
    const { promise, updateNodeData } = resume(previzNode());
    await promise;

    expect(awaitTaskCompletion).toHaveBeenCalledWith(TASK_KEY, "demo", {
      taskType: "freezone_image_to_blockout",
    });
    expect(fetchFreezoneImageToBlockoutResult).toHaveBeenCalledWith("demo", "job-7");
    expect(updateNodeData).toHaveBeenCalledTimes(1);
    const [id, patch] = updateNodeData.mock.calls[0]! as [string, Record<string, unknown>];
    expect(id).toBe("previz-1");
    expect(patch).toMatchObject({
      isGenerating: false,
      generationStartedAt: null,
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
      blockoutImportMode: null,
      blockoutHeld: null,
    });
    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual([
      "blockout-box_0",
      "blockout-box_1",
    ]);
    expect(patch.summary).toMatchObject({ objectCount: 2 });
    expect(toast.success).toHaveBeenCalledWith('previz.blockout.done:{"count":2}');
  });

  it("imports into the open editor instead when that node is being edited", async () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-1");

    const { promise, updateNodeData } = resume(previzNode());
    await promise;

    const patch = updateNodeData.mock.calls[0]![1] as Record<string, unknown>;
    const storeIds = usePrevizStore.getState().scene.objects.map((object) => object.id);
    expect(storeIds).toEqual(["blockout-box_0", "blockout-box_1"]);
    // 场景当场写回节点，store 标为已保存：刷新页面也丢不掉付过费的结果。
    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual(storeIds);
    expect(patch.summary).toMatchObject({ objectCount: 2 });
    expect(usePrevizStore.getState().dirty).toBe(false);
  });

  it("lands on the scene saved while the result was being fetched, not the one read before", async () => {
    const node = previzNode();
    const manual: Record<string, unknown> = { ...piece(9), id: "manual-crate", name: "crate" };
    delete manual.blockout;
    const saved = createDefaultScene();
    saved.objects = [manual] as unknown as PrevizScene["objects"];
    fetchFreezoneImageToBlockoutResult.mockImplementationOnce(async () => {
      // 等结果的这段时间里，用户摆了一个物件、关掉编辑器，场景存回了节点。
      // 画布 store 写节点是换一份新的 data，不是原地改。
      node.data = { ...node.data, scene: saved } as CanvasNode["data"];
      return { objects: [piece(0)], reference_camera_id: null, warnings: [] };
    });

    const { promise, updateNodeData } = resume(node);
    await promise;

    const patch = updateNodeData.mock.calls[0]![1] as Record<string, unknown>;
    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual([
      "manual-crate",
      "blockout-box_0",
    ]);
  });

  it("leaves the open editor alone when the task handle was replaced during the fetch", async () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-1");
    const node = previzNode();
    fetchFreezoneImageToBlockoutResult.mockImplementationOnce(async () => {
      (node.data as Record<string, unknown>).generationTaskKey = "freezone_image_to_blockout:job-8";
      return { objects: [piece(0), piece(1)], reference_camera_id: null, warnings: [] };
    });

    const { promise, updateNodeData } = resume(node);
    await promise;

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().scene.objects).toEqual([]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("says nothing about a failed fetch once the task handle is gone", async () => {
    const node = previzNode();
    fetchFreezoneImageToBlockoutResult.mockImplementationOnce(async () => {
      (node.data as Record<string, unknown>).generationTaskKey = null;
      throw new Error("502");
    });

    const { promise, updateNodeData } = resume(node);
    await promise;

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("holds the finished job when its result cannot be fetched, so the paid result is not lost", async () => {
    fetchFreezoneImageToBlockoutResult.mockRejectedValueOnce(new Error("502"));

    const { promise, updateNodeData } = resume(previzNode());
    await promise;

    expect(updateNodeData).toHaveBeenCalledTimes(1);
    const patch = updateNodeData.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      isGenerating: false,
      generationTaskJobId: null,
      blockoutHeld: { jobId: "job-7", rejection: { reason: "fetch-failed", message: "502" } },
    });
    expect(patch.scene).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.rejected.fetchFailed:{"message":"502"}',
    );
  });

  it("clears the generating state and says so when the task failed", async () => {
    awaitTaskCompletion.mockRejectedValueOnce(
      new TaskCompletionError("model said no", "failed", TASK_KEY),
    );

    const { promise, updateNodeData } = resume(previzNode());
    await promise;

    expect(updateNodeData).toHaveBeenCalledWith("previz-1", {
      isGenerating: false,
      generationStartedAt: null,
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
      blockoutImportMode: null,
    });
    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.failed:{"message":"model said no"}',
    );
    expect(fetchFreezoneImageToBlockoutResult).not.toHaveBeenCalled();
  });

  it("treats a cancellation as news, not an error", async () => {
    awaitTaskCompletion.mockRejectedValueOnce(
      new TaskCompletionError("cancelled", "cancelled", TASK_KEY),
    );

    const { promise, updateNodeData } = resume(previzNode());
    await promise;

    expect(updateNodeData).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith("previz.blockout.cancelled");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("clears the state and complains when the task is gone from the server", async () => {
    vi.useFakeTimers();
    try {
      listTasks.mockResolvedValue([]);

      const { promise, updateNodeData } = resume(previzNode());
      await vi.runAllTimersAsync();
      await promise;

      expect(updateNodeData).toHaveBeenCalledTimes(1);
      expect(updateNodeData.mock.calls[0]![1]).toMatchObject({ isGenerating: false });
      expect(toast.error).toHaveBeenCalledWith(
        'previz.blockout.failed:{"message":"canvas.resumeGeneration.taskGone"}',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
