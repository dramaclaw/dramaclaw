// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";

function edgesOf(nodeId: string) {
  return useCanvasStore
    .getState()
    .edges.filter((edge) => edge.source === nodeId || edge.target === nodeId);
}

describe("canvasStore.convertNodeType — 换类型后同步清理不再合法的边", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("Upload 转成音频后，原来连向图片节点的边被清掉", () => {
    // 空 Upload 节点先连到图片节点（合法），之后用户往里丢了个音频文件，
    // UploadNode 会把它转成 Audio —— 那条边从此不合法。不清掉的话它会一直留在
    // 画布上，直到下次加载被规范化静默删除。
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const image = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: image,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(edgesOf(upload)).toHaveLength(1);

    const ok = useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });

    expect(ok).toBe(true);
    expect(edgesOf(upload)).toEqual([]);
  });

  it("换类型后仍然合法的边原样保留", () => {
    // 音频 → 视频是合法的，Upload 转成 Audio 之后这条边不该被误伤。
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const video = store.addNode(CANVAS_NODE_TYPES.video, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: video,
      sourceHandle: "source",
      targetHandle: "target",
    });
    expect(edgesOf(upload)).toHaveLength(1);

    useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });

    expect(edgesOf(upload)).toHaveLength(1);
  });

  it("清理后的边可以被撤销恢复", () => {
    const store = useCanvasStore.getState();
    const upload = store.addNode(CANVAS_NODE_TYPES.upload, { x: 0, y: 0 }, {});
    const image = store.addNode(CANVAS_NODE_TYPES.imageGen, { x: 400, y: 0 }, {});

    useCanvasStore.getState().onConnect({
      source: upload,
      target: image,
      sourceHandle: "source",
      targetHandle: "target",
    });
    useCanvasStore
      .getState()
      .convertNodeType(upload, CANVAS_NODE_TYPES.audio, { audioUrl: "a.mp3" });
    expect(edgesOf(upload)).toEqual([]);

    useCanvasStore.getState().undo();

    expect(edgesOf(upload)).toHaveLength(1);
    const restored = useCanvasStore.getState().nodes.find((node) => node.id === upload);
    expect(restored?.type).toBe(CANVAS_NODE_TYPES.upload);
  });
});
