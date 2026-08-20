// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 复制图片节点时，上游连边整体克隆过来是对的 —— 唯独风格节点不行。风格节点是
// 「下游图片节点 styleTemplateId 的投影」，一对一是 styleNodeSync 全部规则的前提。
// 克隆出「一个风格节点 → 两个图片节点」后，两个下游各按自己的选择改同一个节点，
// 互相触发对方的 effect，React 到 50 层直接 Maximum update depth exceeded。
import { beforeEach, describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

function node(
  id: string,
  type: CanvasNode["type"],
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return {
    id: `e-${source}-${target}`,
    source,
    target,
    sourceHandle: "source",
    targetHandle: "target",
    type: "disconnectableEdge",
  } as CanvasEdge;
}

function seed() {
  useCanvasStore.setState({
    nodes: [
      node("style", CANVAS_NODE_TYPES.style, { styleTemplateId: "golden_age" }),
      node("upload", CANVAS_NODE_TYPES.upload, { imageUrl: "https://x/a.png" }),
      node("img", CANVAS_NODE_TYPES.imageGen, { styleTemplateId: "golden_age" }),
    ],
    edges: [edge("style", "img"), edge("upload", "img")],
  });
}

function edgesInto(nodeId: string): string[] {
  return useCanvasStore
    .getState()
    .edges.filter((item) => item.target === nodeId)
    .map((item) => item.source);
}

describe("复制图片节点时的风格连边", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("duplicateNodesAsSiblings 不把风格节点的连边一起克隆", () => {
    seed();

    const [cloneId] = useCanvasStore.getState().duplicateNodesAsSiblings(["img"]);

    expect(cloneId).toBeTruthy();
    // 普通上游照旧跟过来，只有风格边被丢掉。
    expect(edgesInto(cloneId)).toEqual(["upload"]);
    // 原节点的连边一根都不能少。
    expect(edgesInto("img").sort()).toEqual(["style", "upload"]);
  });

  it("风格节点跟着一起复制时，副本连的是新的那个风格节点", () => {
    seed();

    const created = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(["style", "img"]);
    const [styleCloneId, imgCloneId] = created;

    expect(edgesInto(imgCloneId).sort()).toEqual(
      [styleCloneId, "upload"].sort(),
    );
    // 指向的是新克隆出来的风格节点，不是原来那个（否则又变成一对二）。
    expect(edgesInto(imgCloneId)).not.toContain("style");
  });

  it("duplicateNodeAsSibling 走的是同一套规则", () => {
    seed();

    const cloneId = useCanvasStore.getState().duplicateNodeAsSibling("img", 1);

    expect(cloneId).toBeTruthy();
    expect(edgesInto(cloneId!)).toEqual(["upload"]);
  });
});
