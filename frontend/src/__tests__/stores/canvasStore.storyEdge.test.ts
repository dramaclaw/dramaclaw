/**
 * 回归测试:storyChoiceEdge 在 normalizeEdgesWithNodes 中存活
 *
 * 核心坑:videoNode → videoNode 不在 isUpstreamConnectionAllowed 允许列表,
 * 普通边会被 normalize 清掉。storyChoiceEdge 应跳过该校验,只要两端节点存在即保留。
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  STORY_CHOICE_EDGE_TYPE,
} from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

describe("canvasStore — storyChoiceEdge survives normalizeEdgesWithNodes", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("retains storyChoiceEdge between two videoNodes after setCanvasData", () => {
    const nodeA = {
      id: "vid-a",
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: "/static/a.mp4" },
    };
    const nodeB = {
      id: "vid-b",
      type: CANVAS_NODE_TYPES.video,
      position: { x: 400, y: 0 },
      data: { videoUrl: "/static/b.mp4" },
    };
    const storyEdge = {
      id: "choice-1",
      type: STORY_CHOICE_EDGE_TYPE,
      source: "vid-a",
      target: "vid-b",
      data: { choiceText: "走左边", order: 0 },
    };

    useCanvasStore.getState().setCanvasData([nodeA, nodeB], [storyEdge]);

    const { edges } = useCanvasStore.getState();
    expect(edges.some((e) => e.id === "choice-1")).toBe(true);
    expect(edges.find((e) => e.id === "choice-1")?.type).toBe(
      STORY_CHOICE_EDGE_TYPE,
    );
  });

  it("does not restore a selected storyChoiceEdge when reloading a canvas", () => {
    const nodeA = {
      id: "vid-a",
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: "/static/a.mp4" },
    };
    const nodeB = {
      id: "vid-b",
      type: CANVAS_NODE_TYPES.video,
      position: { x: 400, y: 0 },
      data: { videoUrl: "/static/b.mp4" },
    };
    const selectedChoice = {
      id: "choice-1",
      type: STORY_CHOICE_EDGE_TYPE,
      source: "vid-a",
      target: "vid-b",
      selected: true,
      data: { choiceText: "走左边", order: 0 },
    };

    useCanvasStore.getState().setCanvasData([nodeA, nodeB], [selectedChoice]);

    expect(useCanvasStore.getState().edges.find((edge) => edge.id === "choice-1")?.selected)
      .toBe(false);
  });

  it("drops a storyChoiceEdge whose target node is missing", () => {
    const nodeA = {
      id: "vid-a",
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: { videoUrl: "/static/a.mp4" },
    };
    const danglingEdge = {
      id: "dangling",
      type: STORY_CHOICE_EDGE_TYPE,
      source: "vid-a",
      target: "ghost-node",
      data: { choiceText: "幽灵", order: 0 },
    };

    useCanvasStore.getState().setCanvasData([nodeA], [danglingEdge]);

    const { edges } = useCanvasStore.getState();
    expect(edges.some((e) => e.id === "dangling")).toBe(false);
  });

  it("upgrades a legacy regular edge between clips in one story group", () => {
    const group = {
      id: "story-group",
      type: CANVAS_NODE_TYPES.group,
      position: { x: 0, y: 0 },
      data: { storyGroup: true },
    };
    const nodeA = {
      id: "vid-a",
      type: CANVAS_NODE_TYPES.video,
      parentId: "story-group",
      position: { x: 20, y: 40 },
      data: { videoUrl: "/static/a.mp4", storySegmentId: "segment-a" },
    };
    const nodeB = {
      id: "vid-b",
      type: CANVAS_NODE_TYPES.video,
      parentId: "story-group",
      position: { x: 720, y: 40 },
      data: { videoUrl: "/static/b.mp4", storySegmentId: "segment-b" },
    };
    const legacyEdge = {
      id: "legacy-edge",
      type: "disconnectableEdge",
      source: "vid-a",
      target: "vid-b",
      data: {},
    };

    useCanvasStore.getState().setCanvasData([group, nodeA, nodeB], [legacyEdge]);

    expect(useCanvasStore.getState().edges).toContainEqual(
      expect.objectContaining({
        id: "legacy-edge",
        type: STORY_CHOICE_EDGE_TYPE,
        data: expect.objectContaining({ choiceText: "", order: 0 }),
      }),
    );
  });
});
