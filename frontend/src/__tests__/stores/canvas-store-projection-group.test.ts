// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { projectionScopedId } from "@/features/freezone/projectionGraphIds";
import { useCanvasStore } from "@/stores/canvasStore";

describe("canvasStore projection groups", () => {
  const scoped = projectionScopedId;

  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("drops persisted no-prop sentinel edges during canvas normalization", () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "no_prop",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { label: "__NO_PROP__", imageUrl: "/assets/no-prop.png" },
        },
        {
          id: "skill_frame",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 300, y: 0 },
          data: { skill_id: "freezone.frame_from_context" },
        },
      ],
      [
        {
          id: "edge_no_prop",
          source: "no_prop",
          target: "skill_frame",
          sourceHandle: "source",
          targetHandle: "prop:__NO_PROP__",
          data: {
            role: "prop",
            reference_target: { kind: "prop", prop_id: "__NO_PROP__" },
          },
        },
      ],
    );

    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it("drops persisted no-prop sentinel nodes during canvas normalization", () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "no_prop",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: {
            label: "__NO_PROP__",
            preset_managed: true,
            projection_key: "beat:1:4:prop:__NO_PROP__",
          },
        },
      ],
      [],
    );

    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("allows deleting stale no-prop sentinel nodes even when they carry preset flags", () => {
    useCanvasStore.setState({
      nodes: [
        {
          id: "no_prop",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: {
            label: "__NO_PROP__",
            preset_managed: true,
            projection_key: "beat:1:4:prop:__NO_PROP__",
          },
        },
      ],
      edges: [],
    });

    expect(useCanvasStore.getState().nodes).toHaveLength(1);

    useCanvasStore.getState().deleteNode("no_prop");

    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("deduplicates persisted reference input edges that target the same skill identity handle", () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "identity_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: {
            label: "陆辰_青年时期",
            __freezone_source: {
              kind: "identity",
              role: "character_identity",
              meta: { identity_id: "陆辰_青年时期" },
            },
          },
        },
        {
          id: "portrait_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 140 },
          data: {
            label: "陆辰",
            __freezone_source: {
              kind: "identity",
              role: "character_portrait",
              meta: { character: "陆辰" },
            },
          },
        },
        {
          id: "skill_frame",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 320, y: 0 },
          data: { skill_id: "freezone.frame_from_context" },
        },
      ],
      [
        {
          id: "edge_identity_ref",
          source: "identity_ref",
          target: "skill_frame",
          sourceHandle: "source",
          targetHandle: "identity:陆辰_青年时期",
          data: {
            role: "identity",
            reference_target: { kind: "identity", identity_id: "陆辰_青年时期" },
          },
        },
        {
          id: "edge_portrait_ref",
          source: "portrait_ref",
          target: "skill_frame",
          sourceHandle: "source",
          targetHandle: "identity:陆辰_青年时期",
          data: {
            role: "identity",
            reference_target: { kind: "identity", identity_id: "陆辰_青年时期" },
          },
        },
      ],
    );

    const identityEdges = useCanvasStore
      .getState()
      .edges.filter((edge) => (edge.data as { role?: unknown } | undefined)?.role === "identity");

    expect(identityEdges).toHaveLength(1);
    expect(identityEdges[0].source).toBe("identity_ref");
  });

  it("stores explicit dimensions for capture groups so children are not clamped into a tiny parent", () => {
    const source = "source_world";
    useCanvasStore.getState().setCanvasData([
      {
        id: source,
        type: CANVAS_NODE_TYPES.threeDWorld,
        position: { x: 10, y: 20 },
        width: 320,
        height: 220,
        style: { width: 320, height: 220 },
        data: { label: "导演世界" },
      },
    ], []);

    const groupId = useCanvasStore.getState().addPanoCaptureGroup(
      source,
      [
        { dataUrl: "data:image/png;base64,a", width: 1600, height: 900, label: "导演合成图" },
        { dataUrl: "data:image/png;base64,b", width: 1600, height: 900, label: "纯背景图" },
      ],
      { cols: 2, groupName: "导演世界输出" }
    );

    expect(groupId).not.toBeNull();
    const group = useCanvasStore.getState().nodes.find((node) => node.id === groupId);
    expect(group?.type).toBe(CANVAS_NODE_TYPES.group);
    expect(group?.width).toBe(1130);
    expect(group?.height).toBe(354);
    expect(group?.style).toMatchObject({ width: 1130, height: 354 });

    const children = useCanvasStore
      .getState()
      .nodes.filter((node) => node.parentId === groupId);
    expect(children).toHaveLength(2);
    expect(children.every((node) => node.extent === "parent")).toBe(true);
    expect(children.map((node) => [node.width, node.height])).toEqual([
      [533, 300],
      [533, 300],
    ]);
  });

  it("stores explicit dimensions for manually created groups", () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "a",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 100, y: 100 },
        width: 260,
        height: 160,
        style: { width: 260, height: 160 },
        data: { imageUrl: "a.png" },
      },
      {
        id: "b",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 420, y: 130 },
        width: 240,
        height: 180,
        style: { width: 240, height: 180 },
        data: { imageUrl: "b.png" },
      },
    ], []);

    const groupId = useCanvasStore.getState().groupNodes(["a", "b"]);
    expect(groupId).not.toBeNull();

    const group = useCanvasStore.getState().nodes.find((node) => node.id === groupId);
    expect(group?.type).toBe(CANVAS_NODE_TYPES.group);
    expect(group?.width).toBe(600);
    expect(group?.height).toBe(264);
    expect(group?.style).toMatchObject({ width: 600, height: 264 });
  });

  it("allows normal groups to be ungrouped", () => {
    const group = "group_normal";
    const child = "child_normal";
    useCanvasStore.getState().setCanvasData([
      {
        id: group,
        type: CANVAS_NODE_TYPES.group,
        position: { x: 0, y: 0 },
        style: { width: 300, height: 220 },
        data: { label: "普通分组" },
      },
      {
        id: child,
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 20, y: 34 },
        parentId: group,
        extent: "parent",
        data: { imageUrl: "a.png" },
      },
    ], []);

    expect(useCanvasStore.getState().ungroupNode(group)).toBe(true);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === group)).toBe(false);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === child)?.parentId).toBeUndefined();
  });

  it("does not ungroup backend-managed projection groups", () => {
    const group = "projection_group_beat_1_4";
    const child = "child_projection";
    useCanvasStore.getState().setCanvasData([
      {
        id: group,
        type: CANVAS_NODE_TYPES.group,
        position: { x: 0, y: 0 },
        style: { width: 300, height: 220 },
        data: {
          label: "EP1/B4",
          preset_managed: true,
          projection_key: "beat:1:4",
        },
      },
      {
        id: child,
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 20, y: 34 },
        parentId: group,
        extent: "parent",
        data: { imageUrl: "a.png" },
      },
    ], []);

    expect(useCanvasStore.getState().ungroupNode(group)).toBe(false);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === scoped("beat:1:4", group))).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === scoped("beat:1:4", child))?.parentId).toBe(scoped("beat:1:4", group));
  });

  it("does not ungroup projection groups that only carry projection_key", () => {
    const group = "projection_group_beat_1_5";
    const child = "child_projection_key_only";
    useCanvasStore.getState().setCanvasData([
      {
        id: group,
        type: CANVAS_NODE_TYPES.group,
        position: { x: 0, y: 0 },
        style: { width: 300, height: 220 },
        data: {
          label: "EP1/B5",
          projection_key: "beat:1:5",
        },
      },
      {
        id: child,
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 20, y: 34 },
        parentId: group,
        extent: "parent",
        data: { imageUrl: "a.png" },
      },
    ], []);

    expect(useCanvasStore.getState().ungroupNode(group)).toBe(false);
    expect(useCanvasStore.getState().nodes.some((node) => node.id === scoped("beat:1:5", group))).toBe(true);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === scoped("beat:1:5", child))?.parentId).toBe(scoped("beat:1:5", group));
  });

  /**
   * 「主线投影 · 锁定」锁的是**拓扑**（不能解组、不能删成员），不该连几何一起锁死。
   * 用户反馈投影组「不能调整」：整理排列只搬成员位置、不改归属，必须放开，
   * 否则后端算出来的布局一旦不合意，用户毫无补救手段。
   */
  it("arranges children of a backend-managed projection group", () => {
    const group = "projection_group_beat_1_7";
    useCanvasStore.getState().setCanvasData([
      {
        id: group,
        type: CANVAS_NODE_TYPES.group,
        position: { x: 0, y: 0 },
        width: 900,
        height: 600,
        style: { width: 900, height: 600 },
        data: { label: "EP1/B7", preset_managed: true, projection_key: "beat:1:7" },
      },
      {
        id: "member_right",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 400, y: 300 },
        parentId: group,
        extent: "parent",
        width: 200,
        height: 120,
        style: { width: 200, height: 120 },
        data: { imageUrl: "a.png", preset_managed: true, projection_key: "beat:1:7" },
      },
      {
        id: "member_left",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 40, y: 300 },
        parentId: group,
        extent: "parent",
        width: 200,
        height: 120,
        style: { width: 200, height: 120 },
        data: { imageUrl: "b.png", preset_managed: true, projection_key: "beat:1:7" },
      },
    ], []);

    useCanvasStore.getState().arrangeGroupChildren(scoped("beat:1:7", group), "horizontal");

    const left = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === scoped("beat:1:7", "member_left"));
    const right = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === scoped("beat:1:7", "member_right"));
    expect(left?.position).toEqual({ x: 20, y: 34 });
    expect(right?.position).toEqual({ x: 252, y: 34 });
    // 只动几何：成员仍归属同一个投影组。
    expect(right?.parentId).toBe(scoped("beat:1:7", group));
    // 解组依旧被拦（拓扑保护不受影响）。
    expect(useCanvasStore.getState().ungroupNode(scoped("beat:1:7", group))).toBe(false);
  });

  it("deduplicates hydrated edges by id before React Flow renders them", () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "selected_background",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { imageUrl: "background.png" },
      },
      {
        id: "skill_frame",
        type: CANVAS_NODE_TYPES.skill,
        position: { x: 360, y: 0 },
        data: { skill_id: "freezone.frame_from_context" },
      },
    ], [
      {
        id: "edge_selected_background_to_skill_frame_background",
        source: "selected_background",
        target: "skill_frame",
        data: { role: "background", version: "old" },
      },
      {
        id: "edge_selected_background_to_skill_frame_background",
        source: "selected_background",
        target: "skill_frame",
        data: { role: "background", version: "new" },
      },
    ]);

    const matchingEdges = useCanvasStore
      .getState()
      .edges.filter((edge) => edge.id === "edge_selected_background_to_skill_frame_background");
    expect(matchingEdges).toHaveLength(1);
    expect(matchingEdges[0]?.data).toMatchObject({ role: "background", version: "new" });
  });

  it("deduplicates hydrated nodes by id and keeps projection nodes over stale local copies", () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "context_beat",
        type: CANVAS_NODE_TYPES.beatContext,
        position: { x: 0, y: 0 },
        data: { content: "stale local" },
      },
      {
        id: "context_beat",
        type: CANVAS_NODE_TYPES.beatContext,
        position: { x: 10, y: 20 },
        data: { projection_key: "beat:1:4", content: "fresh projection" },
      },
      {
        id: "skill_frame",
        type: CANVAS_NODE_TYPES.skill,
        position: { x: 360, y: 0 },
        data: { projection_key: "beat:1:4", skill_id: "freezone.frame_from_context" },
      },
    ], [
      {
        id: "edge_context_to_skill",
        source: "context_beat",
        target: "skill_frame",
        data: { projection_key: "beat:1:4" },
      },
    ]);

    const matchingNodes = useCanvasStore
      .getState()
      .nodes.filter((node) => node.id === scoped("beat:1:4", "context_beat"));
    expect(matchingNodes).toHaveLength(1);
    expect(matchingNodes[0]?.position).toEqual({ x: 10, y: 20 });
    expect(matchingNodes[0]?.data).toMatchObject({
      projection_key: "beat:1:4",
      content: "fresh projection",
    });
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it("orders hydrated projection parents before children for React Flow", () => {
    const group = "projection_group_beat_1_9";
    const child = "context_beat";
    useCanvasStore.getState().setCanvasData([
      {
        id: child,
        type: CANVAS_NODE_TYPES.beatContext,
        position: { x: 20, y: 34 },
        parentId: group,
        extent: "parent",
        data: { projection_key: "beat:1:9", content: "child first" },
      },
      {
        id: group,
        type: CANVAS_NODE_TYPES.group,
        position: { x: 0, y: 0 },
        style: { width: 300, height: 220 },
        data: { projection_key: "beat:1:9", label: "EP1/B9" },
      },
    ], []);

    const ids = useCanvasStore.getState().nodes.map((node) => node.id);
    expect(ids).toEqual([scoped("beat:1:9", group), scoped("beat:1:9", child)]);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === scoped("beat:1:9", child))?.parentId).toBe(scoped("beat:1:9", group));
  });

  it("detaches hydrated children whose parent group is missing", () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "context_beat",
        type: CANVAS_NODE_TYPES.beatContext,
        position: { x: 20, y: 34 },
        parentId: "projection_group_beat_1_9",
        extent: "parent",
        data: { projection_key: "beat:1:9", content: "orphan" },
      },
    ], []);

    const node = useCanvasStore.getState().nodes.find((item) => item.id === scoped("beat:1:9", "context_beat"));
    expect(node?.parentId).toBeUndefined();
    expect(node?.extent).toBeUndefined();
  });

  it("deduplicates replaced edges by id before React Flow renders them", () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "selected_background",
        type: CANVAS_NODE_TYPES.imageEdit,
        position: { x: 0, y: 0 },
        data: { imageUrl: "background.png" },
      },
      {
        id: "skill_frame",
        type: CANVAS_NODE_TYPES.skill,
        position: { x: 360, y: 0 },
        data: { skill_id: "freezone.frame_from_context" },
      },
    ], []);

    useCanvasStore.getState().replaceEdges([
      {
        id: "edge_selected_background_to_skill_frame_background",
        source: "selected_background",
        target: "skill_frame",
        data: { role: "background", version: "old" },
      },
      {
        id: "edge_selected_background_to_skill_frame_background",
        source: "selected_background",
        target: "skill_frame",
        data: { role: "background", version: "new" },
      },
    ]);

    const matchingEdges = useCanvasStore
      .getState()
      .edges.filter((edge) => edge.id === "edge_selected_background_to_skill_frame_background");
    expect(matchingEdges).toHaveLength(1);
    expect(matchingEdges[0]?.data).toMatchObject({ role: "background", version: "new" });
  });

  it("allows skill output candidate edges when the output node carries the same beat context", () => {
    const beatContext = {
      kind: "beat",
      projectId: "demo",
      episode: 1,
      beat: 28,
    };
    useCanvasStore.getState().setCanvasData([
      {
        id: "beat_context",
        type: CANVAS_NODE_TYPES.beatContext,
        position: { x: 0, y: 0 },
        data: { mainline_context: [beatContext] },
      },
      {
        id: "skill_frame",
        type: CANVAS_NODE_TYPES.skill,
        position: { x: 360, y: 0 },
        data: { skill_id: "freezone.frame_from_context" },
      },
      {
        id: "frame_candidate",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 720, y: 0 },
        data: {
          imageUrl: "/frame.png",
          mainline_context: [beatContext],
          output_role: "current_frame_candidate",
        },
      },
    ], [
      {
        id: "e-beat_context-skill_frame-beat_context",
        source: "beat_context",
        target: "skill_frame",
        sourceHandle: "source",
        targetHandle: "beat_context",
        type: "disconnectableEdge",
        data: {
          edgeKind: "role_binding",
          role: "beat_context",
        },
      },
    ]);

    const edgeId = useCanvasStore.getState().addEdgeWithData(
      "skill_frame",
      "frame_candidate",
      {
        edgeKind: "role_binding",
        role: "current_frame_candidate",
        label: "分镜候选",
        propagates: false,
      },
      {
        id: "e-skill_frame-frame_candidate-current_frame_candidate",
        sourceHandle: "current_frame_candidate",
        targetHandle: "target",
      },
    );

    expect(edgeId).toBe("e-skill_frame-frame_candidate-current_frame_candidate");
  });
});
