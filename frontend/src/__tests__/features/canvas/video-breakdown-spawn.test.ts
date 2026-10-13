// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 视频节点工具栏点「逐帧拉片」= 在下游建一个拉片节点并连边。这里锁住那条边：
// addEdge 的建边收口会静默丢掉不合规的边（返回 null），白名单一旦漏项，用户点下去
// 只会看到一个孤零零、认不到素材的空节点，没有任何报错。
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  isManualConnectionAllowed,
  isUpstreamConnectionAllowed,
} from "@/features/canvas/domain/nodeRegistry";
import { useCanvasStore } from "@/stores/canvasStore";

const SOURCE_VIDEO: CanvasNode = {
  id: "v1",
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: { videoUrl: "/static/demo.mp4", displayName: "素材" },
} as CanvasNode;

describe("video → 逐帧拉片 spawn", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO], edges: [] });
  });

  it("keeps the edge the toolbar draws from the video to the new breakdown node", () => {
    const store = useCanvasStore.getState();
    const position = store.findNodePosition("v1", 300, 292);
    const breakdownId = store.addNode(CANVAS_NODE_TYPES.videoBreakdown, position, {
      sourceNodeId: "v1",
    });

    expect(useCanvasStore.getState().addEdge("v1", breakdownId)).not.toBeNull();

    const { nodes, edges } = useCanvasStore.getState();
    const created = nodes.find((item) => item.id === breakdownId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.videoBreakdown);
    // 素材靠这根上游边认，节点本身不抄一份 URL —— 抄了「断开边退回空态」就失效了。
    expect(created?.data.sourceVideoUrl ?? null).toBeNull();
    expect(
      edges.some((edge) => edge.source === "v1" && edge.target === breakdownId),
    ).toBe(true);
  });

  it("spawns downstream of the source instead of on top of it", () => {
    const store = useCanvasStore.getState();
    const position = store.findNodePosition("v1", 300, 292);

    expect(position.x).toBeGreaterThan(SOURCE_VIDEO.position.x);
  });

  it("lets users draw the same edge by hand", () => {
    // 工具栏建的是普通边，不是系统专用边：用户手动拖一根、或删掉后重连都该成立。
    expect(
      isUpstreamConnectionAllowed(
        CANVAS_NODE_TYPES.video,
        CANVAS_NODE_TYPES.videoBreakdown,
      ),
    ).toBe(true);
    expect(
      isManualConnectionAllowed(
        CANVAS_NODE_TYPES.video,
        CANVAS_NODE_TYPES.videoBreakdown,
      ),
    ).toBe(true);
  });
});
