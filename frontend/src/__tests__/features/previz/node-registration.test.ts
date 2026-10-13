// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { canvasNodeFactory } from "@/features/canvas/application/canvasServices";
import {
  CANVAS_NODE_TYPES,
  isPrevizNode,
  type CanvasNode,
  type PrevizNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  DOWNSTREAM_SPAWN_WHITELIST,
  canvasNodeDefinitions,
  getDownstreamSpawnTypes,
  getMenuNodeDefinitions,
  getUpstreamSpawnTypes,
} from "@/features/canvas/domain/nodeRegistry";
import { isAgentCreatableCanvasNodeType } from "@/features/freezone/agentCreatableNodeTypes";
import { normalizeCanvasCommandCreateNodeData } from "@/features/freezone/canvasCommandNodeData";
import { buildCanvasNodeActionCatalog } from "@/features/freezone/canvasNodeActionCatalog";
import {
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  type CanvasChatCommandEnvelope,
} from "@/features/freezone/canvasChatCommands";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import { landNodeAgentSceneEdit, nodeAgentSceneDigest } from "@/features/previz/agentSceneEdit";
import { createDefaultScene } from "@/features/previz/domain/scene";
import { loadNodeScene } from "@/features/previz/nodeScene";
import { usePrevizStore } from "@/features/previz/store";
import {
  buildCommonNodeTypeGuidance,
  getCanvasNodeSemanticSpec,
} from "@/features/freezone/canvasNodeSemantics";

describe("previz canvas node registration", () => {
  it("creates a previz node with an empty scene and the default title", () => {
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 });

    expect(node.type).toBe("previzNode");
    expect(isPrevizNode(node)).toBe(true);

    const data = node.data as PrevizNodeData;
    expect(data.displayName).toBe("预演台");
    expect(data.scene).toBeNull();
    expect(data.summary).toBeNull();
    expect(data.previewImageUrl).toBeNull();
  });

  it("does not classify other node types as previz", () => {
    const other = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });

    expect(isPrevizNode(other)).toBe(false);
    // 下面两行在运行时是恒真的——`null?.type` 无论签名怎么写都是 undefined。
    // 真正钉住签名的是 tsc，而且是各钉一半：签名收窄成 `CanvasNode | undefined`
    // 只有 null 那行报 TS2345，收窄成 `CanvasNode | null` 只有 undefined 那行报。
    // tsconfig.app.json 的 include: ["src"] 覆盖了 src/__tests__，所以它们确实会被
    // 检查到；反过来说，只跑 vitest 不跑 tsc，签名收窄不会被发现。
    expect(isPrevizNode(null)).toBe(false);
    expect(isPrevizNode(undefined)).toBe(false);
  });

  // 定义登记进表里，不等于连得上：connectMenu / handle 任一关掉，预演台就从连线
  // 菜单里消失。这些错法都不会让上面两条用例变红——它们只看 createNode 的产物。
  //
  // 注意本用例**不覆盖添加面板**：面板 map 的是 canvas-node-menu-shared.tsx 里手写的
  // CANVAS_ADD_NODE_TYPES，而 getMenuNodeDefinitions 在生产代码里没有调用方。
  // 面板里点得到预演台由 Task 6 的 canvas-add-node-panel.test.tsx 保证。
  it("registers the previz node in the menu registry and on both handles", () => {
    const definition = canvasNodeDefinitions[CANVAS_NODE_TYPES.previz];

    expect(definition.menuLabelKey).toBe("node.menu.previz");
    expect(definition.connectivity.sourceHandle).toBe(true);
    expect(definition.connectivity.targetHandle).toBe(true);

    // 走 getMenuNodeDefinitions 而不是直接断言 visibleInMenu：后者被前者蕴含。
    expect(getMenuNodeDefinitions().map((entry) => entry.type)).toContain(
      CANVAS_NODE_TYPES.previz,
    );

    // 下面两条钉的是 connectMenu 那对开关，它们与 handle 开关是 AND 关系、不是正交：
    // getConnectMenuNodeTypes 对每个候选算的是「下游菜单 = fromSource && targetHandle，
    // 上游菜单 = fromTarget && sourceHandle」。所以 56/57 行与这两条在「菜单候选」
    // 这一维上重叠，这两条额外覆盖的是 connectMenu 那一半——少了它们，把 connectMenu
    // 两个开关都关掉的实现照样全绿，而那时预演台从任何 handle 都拖不出来。
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.textAnnotation)).toContain(
      CANVAS_NODE_TYPES.previz,
    );
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.textAnnotation)).toContain(
      CANVAS_NODE_TYPES.previz,
    );
  });

  it("offers image and video nodes as downstream spawns", () => {
    const declared = DOWNSTREAM_SPAWN_WHITELIST[CANVAS_NODE_TYPES.previz];

    expect(declared).toContain(CANVAS_NODE_TYPES.video);
    expect(declared).toContain(CANVAS_NODE_TYPES.exportImage);
    expect(declared).not.toContain(CANVAS_NODE_TYPES.audio);

    // 白名单声明了不等于菜单真给：getDownstreamSpawnTypes 会拿它和
    // getConnectMenuNodeTypes('source') + isManualConnectionAllowed 求交。
    // 精确 toEqual 而不是 toContain，是为了把「声明 5 项、实际只生效 3 项」这件事
    // 写进测试里——upload（fromSource:false + targetHandle:false）和 exportImage
    // （fromSource:false）永远过不了那道交集，白名单里那两项是死条目。这两个死
    // 条目是从 pano360ViewerNodeDefinition 一字不差抄来的，属既有惯例，不在本任务
    // 修；但测试要如实记下生效集合，免得将来有人以为菜单里能点出导出图片。
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.previz)).toEqual([
      CANVAS_NODE_TYPES.imageEdit,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.video,
    ]);
  });
});

describe("previz node as seen by the agent", () => {
  it("lets the agent create one and tells it what the node is for", () => {
    expect(isAgentCreatableCanvasNodeType(CANVAS_NODE_TYPES.previz)).toBe(true);
    expect(getCanvasNodeSemanticSpec(CANVAS_NODE_TYPES.previz)?.role).toBe("viewer");
    expect(buildCommonNodeTypeGuidance()).toContain("previzNode=");
  });

  it("drops an agent-written scene on create and keeps the display name", () => {
    // 场景只有编辑器写得对；Agent 塞进来的那份没过校验，落进节点就打不开。
    const data = normalizeCanvasCommandCreateNodeData(CANVAS_NODE_TYPES.previz, {
      displayName: "第三场走位",
      scene: { objects: [] },
      summary: { objectCount: 9, durationFrames: 1 },
    } as unknown as Partial<PrevizNodeData>);

    expect(data).toEqual({ displayName: "第三场走位" });
  });

  it("drops a scene edit on create: there is no scene to edit yet", () => {
    const data = normalizeCanvasCommandCreateNodeData(CANVAS_NODE_TYPES.previz, {
      displayName: "迷宫",
      sceneEdit: { add: [{ kind: "prop", shape: "cube", position: [0, 0, 0] }] },
    } as unknown as Partial<PrevizNodeData>);

    expect(data).toEqual({ displayName: "迷宫" });
  });

  it("lets the agent rename the node and edit its scene, and shows it the current objects", () => {
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 });
    const catalog = buildCanvasNodeActionCatalog(node);

    expect(catalog.editable_fields).toEqual(["displayName", "sceneEdit"]);
    expect(catalog.editable_schema.sceneEdit.current_value).toMatchObject({
      objectCount: 0,
      primitiveCount: 0,
      objects: [],
    });
  });

  it("rejects a bad scene edit before the user is asked to confirm it", () => {
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 });
    const validate = (sceneEdit: unknown) =>
      validateCanvasChatCommandEnvelopes(
        [
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: [{ type: "update_node_data", node_id: node.id, data: { sceneEdit } }],
          } as CanvasChatCommandEnvelope,
        ],
        [node],
        [],
      );

    expect(validate({ add: [{ kind: "prop", shape: "cube", position: [0, 0, 0] }] })).toEqual({
      ok: true,
      issues: [],
    });

    const rejected = validate({ add: [{ kind: "prop", shape: "teapot", position: [0, 0, 0] }] });
    expect(rejected.ok).toBe(false);
    expect(rejected.issues[0]?.message).toContain("sceneEdit rejected");
  });

  it("validates each scene edit against what the earlier ones in the batch leave behind", () => {
    const wall = { kind: "prop", shape: "cube", ref: "wall", position: [0, 0, 0] };
    const removeTwice = (node: CanvasNode) =>
      validateCanvasChatCommandEnvelopes(
        [
          {
            schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
            commands: ["first", "second"].map(() => ({
              type: "update_node_data",
              node_id: node.id,
              data: { sceneEdit: { remove: [wallId] } },
            })),
          } as CanvasChatCommandEnvelope,
        ],
        [node],
        [],
      );
    const created = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.previz, { x: 0, y: 0 });
    const patch = landNodeAgentSceneEdit(created.id, { scene: null }, { add: [wall] });
    const node = { ...created, data: { ...created.data, ...patch } } as CanvasNode;
    const wallId = nodeAgentSceneDigest(node.id, node.data as Record<string, unknown>)!.objects[0].id;

    const closed = removeTwice(node);
    expect(closed.ok).toBe(false);
    expect(closed.issues.map((issue) => issue.path)).toEqual(["envelopes[0].commands[1]"]);

    // 编辑器开着这个节点时真相在 store 里，同批次里前一条的结果一样要算进去。
    const loaded = loadNodeScene((node.data as Record<string, unknown>).scene);
    if (!loaded.ok) throw new Error("scene did not load");
    usePrevizStore.getState().loadScene(loaded.scene, node.id);
    const open = removeTwice(node);
    usePrevizStore.getState().loadScene(createDefaultScene(), null);
    expect(open.issues.map((issue) => issue.path)).toEqual(["envelopes[0].commands[1]"]);
  });
});
