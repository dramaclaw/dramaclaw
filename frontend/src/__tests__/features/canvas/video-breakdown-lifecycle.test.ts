// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 拉片节点的三条生命周期约定，每一条坏掉都只在「用户中途做了别的事」时才暴露，
// 手测很难碰上：
//   1. 刷新页面时正在拉片 —— 复位跑丢的进行态，否则按钮永久禁用，节点只能删掉重建；
//   2. 从画布拾取素材 —— 上游边是唯一事实来源，不许再抄一份 URL 进节点；
//   3. 拉片途中节点被删 —— 静默收工，别弹「零产出」误报。
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import {
  commitVideoPickToNode,
  landVideoBreakdownResult,
} from "@/features/canvas/application/videoBreakdownLanding";
import { useCanvasStore } from "@/stores/canvasStore";

const BREAKDOWN_NODE = (data: Record<string, unknown> = {}): CanvasNode =>
  ({
    id: "b1",
    type: CANVAS_NODE_TYPES.videoBreakdown,
    position: { x: 400, y: 0 },
    data: { displayName: "逐帧拉片", ...data },
  }) as CanvasNode;

const SOURCE_VIDEO: CanvasNode = {
  id: "v1",
  type: CANVAS_NODE_TYPES.video,
  position: { x: 0, y: 0 },
  data: { videoUrl: "/static/demo.mp4", displayName: "素材" },
} as CanvasNode;

const LABELS = {
  storyboardFallbackLabel: (index: number) => `分镜组${index}`,
  motionFallbackLabel: "动态",
  musicFallbackLabel: "音乐",
};

describe("拉片进行态在水合时复位", () => {
  it("clears isBreakingDown so a refresh mid-run does not disable the button forever", () => {
    // 拉片没有 task_key 续跑机制（不像 isGenerating 有 resumeNodeGeneration），
    // 存下来的 true 没有任何东西会把它翻回 false。
    useCanvasStore
      .getState()
      .setCanvasData(
        [BREAKDOWN_NODE({ isBreakingDown: true, breakdownStartedAt: 1_700_000_000 })],
        [],
      );

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "b1");
    expect(node?.data.isBreakingDown).toBe(false);
    expect(node?.data.breakdownStartedAt ?? null).toBeNull();
  });

  it("leaves an idle node untouched", () => {
    useCanvasStore.getState().setCanvasData([BREAKDOWN_NODE()], []);

    const node = useCanvasStore.getState().nodes.find((item) => item.id === "b1");
    expect(node?.data.isBreakingDown ?? false).toBe(false);
  });
});

describe("从画布拾取视频", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO, BREAKDOWN_NODE()], edges: [] });
  });

  it("connects the edge without copying the URL into the node", () => {
    // 抄一份进 data.sourceVideoUrl 会让「断开边退回空态」失效 —— 用户断开边想换源，
    // 节点还捏着旧 URL 照跑不误。
    expect(
      commitVideoPickToNode({
        sourceNodeId: "v1",
        requesterNodeId: "b1",
        videoUrl: "/static/demo.mp4",
        label: "素材",
      }),
    ).toBe(true);

    const { nodes, edges } = useCanvasStore.getState();
    const requester = nodes.find((item) => item.id === "b1");
    expect(requester?.data.sourceVideoUrl ?? null).toBeNull();
    expect(edges.some((edge) => edge.source === "v1" && edge.target === "b1")).toBe(
      true,
    );
  });

  it("wipes a stale local upload left on the node", () => {
    // 先本地传过一个文件、再改用画布拾取：旧 URL 留着就成了断边后的兜底来源。
    useCanvasStore.setState({
      nodes: [
        SOURCE_VIDEO,
        BREAKDOWN_NODE({
          sourceVideoUrl: "/static/old-upload.mp4",
          sourceFileName: "old-upload.mp4",
        }),
      ],
      edges: [],
    });

    commitVideoPickToNode({
      sourceNodeId: "v1",
      requesterNodeId: "b1",
      videoUrl: "/static/demo.mp4",
      label: "素材",
    });

    const requester = useCanvasStore
      .getState()
      .nodes.find((item) => item.id === "b1");
    expect(requester?.data.sourceVideoUrl ?? null).toBeNull();
    expect(requester?.data.sourceFileName ?? null).toBeNull();
  });

  it("falls back to copying the URL when the edge is refused", () => {
    // 建边收口（类型规则 / 参考上限）会静默返回 null。真丢了边就只能抄一份，
    // 否则用户点完「从画布选择」什么都没发生。
    useCanvasStore.setState({ nodes: [SOURCE_VIDEO, BREAKDOWN_NODE()], edges: [] });

    expect(
      commitVideoPickToNode({
        sourceNodeId: "v1",
        requesterNodeId: "missing-node",
        videoUrl: "/static/demo.mp4",
        label: "素材",
      }),
    ).toBe(false);
  });
});

describe("拉片结果落盘", () => {
  const RESULT = {
    storyboard: {
      groups: [
        {
          label: "开场",
          shots: [{ code: "S01", description: "少年停在田埂", image_url: "/static/s1.jpg" }],
        },
      ],
    },
  };

  beforeEach(() => {
    useCanvasStore.setState({ nodes: [BREAKDOWN_NODE()], edges: [] });
  });

  it("lands the groups when the node is still on the canvas", () => {
    expect(landVideoBreakdownResult({ nodeId: "b1", result: RESULT, labels: LABELS })).toBe(
      "ok",
    );
    expect(useCanvasStore.getState().nodes.length).toBeGreaterThan(1);
  });

  it("reports node-gone instead of empty when the node was deleted mid-run", () => {
    // 拉片要跑几分钟，用户中途删掉节点很正常；那不是「零产出」，不该弹错误。
    useCanvasStore.setState({ nodes: [], edges: [] });

    expect(landVideoBreakdownResult({ nodeId: "b1", result: RESULT, labels: LABELS })).toBe(
      "node-gone",
    );
  });

  it("reports empty when the job genuinely produced nothing", () => {
    expect(
      landVideoBreakdownResult({ nodeId: "b1", result: {}, labels: LABELS }),
    ).toBe("empty");
  });
});
