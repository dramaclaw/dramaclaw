// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { canvasNodeFactory } from "@/features/canvas/application/canvasServices";
import {
  CANVAS_NODE_TYPES,
  isPrevizNode,
  type PrevizNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  DOWNSTREAM_SPAWN_WHITELIST,
  canvasNodeDefinitions,
  getDownstreamSpawnTypes,
  getMenuNodeDefinitions,
} from "@/features/canvas/domain/nodeRegistry";

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
    expect(isPrevizNode(null)).toBe(false);
    expect(isPrevizNode(undefined)).toBe(false);
  });

  // 定义登记进表里，不等于用户点得到：visibleInMenu 一关，节点就从添加面板消失；
  // connectMenu / handle 一关，就从 handle 上拖不出来。这两种错法都不会让上面
  // 两条用例变红——它们只看 createNode 的产物。
  it("exposes the previz node in the add menu and on both handles", () => {
    const definition = canvasNodeDefinitions[CANVAS_NODE_TYPES.previz];

    expect(definition.menuLabelKey).toBe("node.menu.previz");
    expect(definition.connectivity.sourceHandle).toBe(true);
    expect(definition.connectivity.targetHandle).toBe(true);

    // 走 getMenuNodeDefinitions 而不是直接断言 visibleInMenu：后者被前者蕴含，
    // 而前者才是菜单真正读的那条路径。
    expect(getMenuNodeDefinitions().map((entry) => entry.type)).toContain(
      CANVAS_NODE_TYPES.previz,
    );
  });

  it("offers image and video nodes as downstream spawns", () => {
    const declared = DOWNSTREAM_SPAWN_WHITELIST[CANVAS_NODE_TYPES.previz];

    expect(declared).toContain(CANVAS_NODE_TYPES.video);
    expect(declared).toContain(CANVAS_NODE_TYPES.exportImage);
    expect(declared).not.toContain(CANVAS_NODE_TYPES.audio);

    // 白名单声明了不等于菜单真给：getDownstreamSpawnTypes 会拿它和
    // getConnectMenuNodeTypes('source') + isManualConnectionAllowed 求交，
    // 连通性开关关着就会被过滤成空。这条跨了三张表，不是拿谓词查自己的输出。
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.previz)).toContain(
      CANVAS_NODE_TYPES.video,
    );
  });
});
