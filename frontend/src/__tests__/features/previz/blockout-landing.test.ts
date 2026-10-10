// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 「参考图转白模」结果落地：编辑器开着就进 store 并当场写回节点，关着就直接写进
// 节点数据。两条路都由画布的恢复路径调用，所以这里不碰任何 hook。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { TaskCompletionError } from "@/api/tasks";
import { PREVIZ_PRIMITIVE_LIMIT } from "@/features/previz/domain/limits";
import { createDefaultScene, type PrevizProp, type PrevizScene } from "@/features/previz/domain/scene";
import { landBlockoutResult, reportBlockoutFailure } from "@/features/previz/blockoutLanding";
import { usePrevizStore } from "@/features/previz/store";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("i18next", () => ({
  default: {
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  },
}));

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

function result(pieces: number, warnings: string[] = []) {
  return {
    objects: Array.from({ length: pieces }, (_, index) => piece(index)),
    reference_camera_id: null,
    warnings,
  };
}

function handPlaced(count: number): PrevizProp[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `hand-${index}`,
    kind: "prop",
    name: `hand ${index}`,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    assetUrl: "cube",
    assetFormat: "primitive",
  }));
}

const storeIds = () => usePrevizStore.getState().scene.objects.map((object) => object.id);

beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
  usePrevizStore.getState().unloadScene();
});

describe("landBlockoutResult with the editor open on that node", () => {
  it("imports into the store as one undo step and writes the scene onto the node at once", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-1");

    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: result(3, ["a 悬空"]),
      mode: "replace",
    });

    expect(storeIds()).toEqual(["blockout-box_0", "blockout-box_1", "blockout-box_2"]);
    expect(usePrevizStore.getState().past).toHaveLength(1);
    // 写回不等自动保存的 600ms 窗口：任务句柄跟着这份补丁一起清，刷新页面也不会
    // 出现「句柄没了、节点上还是旧场景」的窗口。写回之后 store 是干净的，自动保存
    // 没有第二份要写。
    expect(patch.blockoutHeld).toBeNull();
    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual(storeIds());
    expect(patch.summary).toMatchObject({ objectCount: 3 });
    expect(usePrevizStore.getState().dirty).toBe(false);
    // 全局 toaster 只显示一条、只停 2.2 秒：意见和「已生成」合成一条，给够时间读。
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith('previz.blockout.done:{"count":3}', {
      description: 'previz.blockout.warnings:{"count":1}\na 悬空',
      duration: 8_000,
    });
  });

  it("undoes the import and holds the job when the node cannot carry the scene", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-1");
    const bulky = result(3);
    for (const object of bulky.objects) object.name = "x".repeat(400_000);

    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: bulky,
      mode: "replace",
    });

    expect(storeIds()).toEqual([]);
    expect(usePrevizStore.getState().past).toHaveLength(0);
    expect(patch).toEqual({
      blockoutHeld: { jobId: "job-1", rejection: { reason: "too-large", bytes: expect.any(Number) } },
    });
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it("lists at most three warnings, in order", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-1");

    landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: result(1, ["w1", "w2", "w3", "w4"]),
      mode: "replace",
    });

    expect(toast.warning).toHaveBeenCalledWith('previz.blockout.done:{"count":1}', {
      description: 'previz.blockout.warnings:{"count":4}\nw1\nw2\nw3',
      duration: 8_000,
    });
  });

  it("does not touch the store when the editor shows another node", () => {
    usePrevizStore.getState().loadScene(createDefaultScene(), "previz-2");

    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: result(2),
      mode: "replace",
    });

    expect(storeIds()).toEqual([]);
    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual([
      "blockout-box_0",
      "blockout-box_1",
    ]);
  });
});

describe("landBlockoutResult with the editor closed", () => {
  it("writes the scene and summary onto the node, starting from an empty node", () => {
    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: result(2),
      mode: "replace",
    });

    const scene = patch.scene as PrevizScene;
    expect(scene.objects.map((object) => object.id)).toEqual(["blockout-box_0", "blockout-box_1"]);
    expect(patch.summary).toEqual({
      objectCount: 2,
      durationFrames: scene.settings.durationFrames,
      audioClipCount: 0,
    });
    expect(patch.blockoutHeld).toBeNull();
    expect(storeIds()).toEqual([]);
    expect(toast.success).toHaveBeenCalledWith('previz.blockout.done:{"count":2}');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("appends to the scene stored on the node", () => {
    const stored = { ...createDefaultScene(), objects: handPlaced(1) };

    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: stored },
      jobId: "job-1",
      body: result(1),
      mode: "append",
    });

    expect((patch.scene as PrevizScene).objects.map((object) => object.id)).toEqual([
      "hand-0",
      "blockout-box_0",
    ]);
  });

  it("holds a result that does not fit, remembering the job so no credits are spent again", () => {
    const stored = { ...createDefaultScene(), objects: handPlaced(PREVIZ_PRIMITIVE_LIMIT - 1) };

    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: stored },
      jobId: "job-1",
      body: result(3),
      mode: "append",
    });

    expect(patch).toEqual({
      blockoutHeld: {
        jobId: "job-1",
        rejection: { reason: "primitive-limit", missing: 2, limit: PREVIZ_PRIMITIVE_LIMIT },
      },
    });
    expect(toast.error).toHaveBeenCalledWith(
      `previz.blockout.rejected.primitiveLimit:{"missing":2,"limit":${PREVIZ_PRIMITIVE_LIMIT}}`,
    );
  });

  it("holds nothing when the result is empty", () => {
    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: null },
      jobId: "job-1",
      body: { objects: [{ id: "x", kind: "prop", assetFormat: "glb" }] },
      mode: "replace",
    });

    expect(patch).toEqual({ blockoutHeld: null });
    expect(toast.error).toHaveBeenCalledWith("previz.blockout.rejected.empty");
  });

  it("holds the result instead of overwriting a node scene written by a newer version", () => {
    const patch = landBlockoutResult({
      nodeId: "previz-1",
      nodeData: { scene: { schemaVersion: 999 } },
      jobId: "job-1",
      body: result(1),
      mode: "replace",
    });

    expect(patch).toEqual({
      blockoutHeld: { jobId: "job-1", rejection: { reason: "version-too-new" } },
    });
    expect(patch.scene).toBeUndefined();
    expect(toast.error).toHaveBeenCalledWith("previz.blockout.rejected.versionTooNew");
  });
});

describe("reportBlockoutFailure", () => {
  it("treats a cancellation as news, not an error", () => {
    reportBlockoutFailure(new TaskCompletionError("cancelled", "cancelled", "k"));

    expect(toast.info).toHaveBeenCalledWith("previz.blockout.cancelled");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the failure message", () => {
    reportBlockoutFailure(new Error("model said no"));

    expect(toast.error).toHaveBeenCalledWith(
      'previz.blockout.failed:{"message":"model said no"}',
    );
  });
});
