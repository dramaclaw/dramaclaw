// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 框选整个组再点复制:marquee 把组本身从 selected 里剔掉了(否则拖动会双重位移),
// 所以传给 duplicateNodesAsSiblings 的只有成员,副本会散架并塞回原组。这里锁住
// 「补回组」和「前序」两件事 —— 后者是 store 用 idMap 重指 parentId 的前提。
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { collectDuplicableIds } from "@/features/canvas/domain/groupSelectionDuplicate";

function node(id: string, type: CanvasNode["type"], extra: Partial<CanvasNode> = {}): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data: {}, ...extra } as CanvasNode;
}

function member(id: string, parentId: string, extra: Partial<CanvasNode> = {}): CanvasNode {
  return node(id, CANVAS_NODE_TYPES.imageGen, { parentId, extent: "parent", ...extra });
}

describe("collectDuplicableIds", () => {
  it("框选整组(只有成员被选中)时把组补回来,且组排在成员前面", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g"), member("m2", "g")];

    expect(collectDuplicableIds(nodes, ["m1", "m2"])).toEqual(["g", "m1", "m2"]);
  });

  it("组已显式选中时结果不变,顺序仍是父在前", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g")];

    expect(collectDuplicableIds(nodes, ["m1", "g"])).toEqual(["g", "m1"]);
  });

  it("组只选中一部分成员时不补组 —— 那是「复制这几个节点」,不是「复制这个组」", () => {
    const nodes = [node("g", CANVAS_NODE_TYPES.group), member("m1", "g"), member("m2", "g")];

    expect(collectDuplicableIds(nodes, ["m1"])).toEqual(["m1"]);
  });

  it("嵌套组:先补内层再补外层,输出仍是前序", () => {
    const nodes = [
      node("outer", CANVAS_NODE_TYPES.group),
      node("inner", CANVAS_NODE_TYPES.group, { parentId: "outer", extent: "parent" }),
      member("m1", "inner"),
      member("m2", "inner"),
    ];

    // 内层被成员填满 → 补 inner;outer 的唯一子节点 inner 因此也被覆盖 → 补 outer。
    expect(collectDuplicableIds(nodes, ["m1", "m2"])).toEqual(["outer", "inner", "m1", "m2"]);
  });

  it("preset/主线锁定的组不替用户补进来", () => {
    const nodes = [
      node("g", CANVAS_NODE_TYPES.group, { data: { preset_managed: true } }),
      member("m1", "g"),
    ];

    expect(collectDuplicableIds(nodes, ["m1"])).toEqual(["m1"]);
  });

  it("显式选中的锁定成员照旧保留 —— 复制不是破坏性操作,不沿用删除侧的过滤", () => {
    const nodes = [
      node("a", CANVAS_NODE_TYPES.imageGen, { data: { preset_managed: true } }),
      node("b", CANVAS_NODE_TYPES.imageGen),
    ];

    expect(collectDuplicableIds(nodes, ["a", "b"])).toEqual(["a", "b"]);
  });

  it("没有组时原样返回(按 nodes 顺序)", () => {
    const nodes = [node("a", CANVAS_NODE_TYPES.imageGen), node("b", CANVAS_NODE_TYPES.imageGen)];

    expect(collectDuplicableIds(nodes, ["b", "a"])).toEqual(["a", "b"]);
  });
});
