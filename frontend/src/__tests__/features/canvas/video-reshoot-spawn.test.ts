// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 视频节点工具栏点「片段重拍」= 在下游复制一个同内容的视频节点并连边。这里锁住
// 那条边和那份拷贝：addEdge 的建边收口会静默丢掉不合规的边（返回 null），而少抄一个
// durationMs 就会让时间轨道退化成「时长未知、点了没反应」。
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

const SOURCE_VIDEO: CanvasNode = {
  id: "v1",
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: {
    videoUrl: "/static/demo.mp4",
    previewImageUrl: "/static/demo.jpg",
    aspectRatio: "16:9",
    durationMs: 12_000,
    displayName: "素材",
  },
} as CanvasNode;

describe("video → 片段重拍 spawn", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO], edges: [] });
  });

  it("copies the clip onto a downstream node in reshoot mode and keeps the edge", () => {
    const store = useCanvasStore.getState();
    const position = store.findNodePosition("v1", 580, 380);
    const reshootId = store.addNode(CANVAS_NODE_TYPES.video, position, {
      displayName: "素材-片段重拍",
      videoUrl: "/static/demo.mp4",
      previewImageUrl: "/static/demo.jpg",
      aspectRatio: "16:9",
      durationMs: 12_000,
      isReshootMode: true,
      reshootClips: [],
    } as unknown as Parameters<typeof store.addNode>[2]);

    expect(useCanvasStore.getState().addEdge("v1", reshootId)).not.toBeNull();

    const { nodes, edges } = useCanvasStore.getState();
    const created = nodes.find((item) => item.id === reshootId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.video);
    // 轨道要有画面帧和刻度，videoUrl / durationMs 少一个都截不出片段。
    expect(created?.data.videoUrl).toBe("/static/demo.mp4");
    expect(created?.data.durationMs).toBe(12_000);
    expect(created?.data.isReshootMode).toBe(true);
    expect(created?.data.reshootClips).toEqual([]);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("v1");
    expect(edges[0].target).toBe(reshootId);
  });

  it("survives a reload: the reshoot flag and clips are not normalized away", () => {
    const store = useCanvasStore.getState();
    const reshootId = store.addNode(
      CANVAS_NODE_TYPES.video,
      { x: 600, y: 0 },
      {
        videoUrl: "/static/demo.mp4",
        aspectRatio: "16:9",
        durationMs: 12_000,
        isReshootMode: true,
        reshootClips: [{ id: "rc-1", startMs: 1_000, endMs: 5_000 }],
      } as unknown as Parameters<typeof store.addNode>[2],
    );
    useCanvasStore.getState().addEdge("v1", reshootId);

    const { nodes, edges } = useCanvasStore.getState();
    useCanvasStore.getState().setCanvasData(nodes, edges);

    const reloaded = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === reshootId);
    expect(reloaded?.data.isReshootMode).toBe(true);
    expect(reloaded?.data.reshootClips).toEqual([
      { id: "rc-1", startMs: 1_000, endMs: 5_000 },
    ]);
    expect(
      useCanvasStore.getState().edges.some((edge) => edge.target === reshootId),
    ).toBe(true);
  });
});
