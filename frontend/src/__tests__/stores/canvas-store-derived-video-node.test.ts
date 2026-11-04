// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

function node(id: string) {
  return useCanvasStore.getState().nodes.find((n) => n.id === id)!;
}

describe("canvasStore.addDerivedVideoNode — 录出来的视频节点带上成片信息", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("把 videoUrl、画幅、标题和时长一起盖到新节点上", () => {
    const store = useCanvasStore.getState();
    const source = store.addNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 }, {});

    const id = useCanvasStore
      .getState()
      .addDerivedVideoNode(source, "/static/take.mp4", "16:9", "预演台轨道录制 1", 4000);

    expect(id).not.toBeNull();
    // 时长得在视频元数据加载完之前就在：合成弹窗兜底的片段长度、参考素材是否就绪，
    // 读的都是节点数据。
    expect(node(id!).data).toMatchObject({
      videoUrl: "/static/take.mp4",
      aspectRatio: "16:9",
      displayName: "预演台轨道录制 1",
      durationMs: 4000,
    });
  });

  it("没给时长就写 null，而不是留 undefined 让下游再猜", () => {
    const store = useCanvasStore.getState();
    const source = store.addNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 }, {});

    const id = useCanvasStore.getState().addDerivedVideoNode(source, "/static/take.mp4", "16:9");

    expect(node(id!).data).toMatchObject({ durationMs: null });
  });
});
