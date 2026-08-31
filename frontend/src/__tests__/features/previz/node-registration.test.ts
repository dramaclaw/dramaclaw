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
  getUpstreamSpawnTypes,
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
    // 这两行在运行时是恒真的（`null?.type` 无论签名怎么写都是 undefined），
    // 真正钉住签名的是 tsc：旧签名 `Node | undefined` 下它们是编译错误，而
    // tsconfig.app.json 的 include: ["src"] 覆盖了 src/__tests__。
    // 也就是说只跑 vitest 不跑 tsc，签名回退不会被发现。
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

    // connectMenu.fromSource / fromTarget 与上面两个 handle 开关管的是正交的事：
    // handle 决定卡片自己画不画把手，connectMenu 决定 previz 会不会作为候选出现在
    // **别人**的连线菜单里。少了下面两条，把 connectMenu 两个开关都关掉的实现
    // 照样全绿——而那时预演台从任何 handle 都拖不出来。
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
