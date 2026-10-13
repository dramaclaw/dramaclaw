// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  orderedReferenceUrlsWithOwnFirst,
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";

type Node = { id: string; position?: { y?: number } };

const ids = (nodes: Node[]) => nodes.map((node) => node.id);

describe("sortUpstreamByReferenceOrder", () => {
  it("keeps newly connected nodes in connection order, ignoring canvas y position", () => {
    // 回归用例:旧图(red,先引用,在画布下方 y=900)应排在新图(grid,后引用,
    // 在画布上方 y=0)之前。曾经按 y 排序会把上方的新图错误地放到第 1 位。
    const connectionOrder: Node[] = [
      { id: "red", position: { y: 900 } },
      { id: "grid", position: { y: 0 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, undefined);

    expect(ids(sorted)).toEqual(["red", "grid"]);
  });

  it("honors an explicit manual referenceOrder over connection order", () => {
    const connectionOrder: Node[] = [
      { id: "a", position: { y: 0 } },
      { id: "b", position: { y: 100 } },
      { id: "c", position: { y: 200 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, ["c", "a", "b"]);

    expect(ids(sorted)).toEqual(["c", "a", "b"]);
  });

  it("places manually-ordered nodes first, then unordered ones in connection order", () => {
    // b 被手动拖到首位;a 和后来连入的 c、d 都不在 referenceOrder 里,
    // 应按连接顺序(输入数组顺序)接在 b 之后。
    const connectionOrder: Node[] = [
      { id: "a", position: { y: 50 } },
      { id: "b", position: { y: 999 } },
      { id: "c", position: { y: 10 } },
      { id: "d", position: { y: 5 } },
    ];

    const sorted = sortUpstreamByReferenceOrder(connectionOrder, ["b"]);

    expect(ids(sorted)).toEqual(["b", "a", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const input: Node[] = [
      { id: "x", position: { y: 1 } },
      { id: "y", position: { y: 0 } },
    ];

    sortUpstreamByReferenceOrder(input, undefined);

    expect(ids(input)).toEqual(["x", "y"]);
  });
});

describe("upstreamNodesInEdgeOrder", () => {
  it("returns upstream nodes in edge-connection order, not nodes-array order", () => {
    // 回归用例：@图片N 编号按连线顺序（useUpstreamNodes），提交曾按 nodes 数组
    // 顺序收集 —— 先创建但后连线的 gen 节点会被错误排到 references[0]，导致
    // prompt 里的 @图片1 在后端指向另一张图。两边必须走同一个函数。
    const nodes: Node[] = [
      { id: "gen" }, // 创建最早（nodes 数组第 1 位），但最后才连线
      { id: "upload-a" },
      { id: "upload-b" },
    ];
    const edges = [
      { source: "upload-a", target: "video" },
      { source: "upload-b", target: "video" },
      { source: "gen", target: "video" },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "video");

    expect(ids(upstream)).toEqual(["upload-a", "upload-b", "gen"]);
  });

  it("ignores edges targeting other nodes and edges with missing source nodes", () => {
    const nodes: Node[] = [{ id: "a" }, { id: "b" }];
    const edges = [
      { source: "a", target: "video" },
      { source: "b", target: "other" },
      { source: "ghost", target: "video" },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "video");

    expect(ids(upstream)).toEqual(["a"]);
  });

  it("excludes execution-only dependency edges from consumable upstream inputs", () => {
    const nodes: Node[] = [{ id: "outline" }, { id: "anchor" }];
    const edges = [
      {
        source: "outline",
        target: "image",
        data: { link_type: "dependency_for" },
      },
      {
        source: "anchor",
        target: "image",
        data: { link_type: "media_input_for" },
      },
    ];

    const upstream = upstreamNodesInEdgeOrder(nodes, edges, "image");

    expect(ids(upstream)).toEqual(["anchor"]);
  });
});

describe("orderedReferenceUrlsWithOwnFirst", () => {
  it("puts the node's own reference image first, upstream images after", () => {
    // 回归用例：图片节点自带参考图时，提交给后端的第 1 张就是它 —— @图片N
    // 编号必须也把它算作图片1，否则 prompt 里所有 @图片N 到后端整体偏移 1。
    expect(
      orderedReferenceUrlsWithOwnFirst("own.png", ["a.png", "b.png"]),
    ).toEqual(["own.png", "a.png", "b.png"]);
  });

  it("returns upstream urls unchanged when there is no own reference image", () => {
    expect(orderedReferenceUrlsWithOwnFirst(null, ["a.png", "b.png"])).toEqual([
      "a.png",
      "b.png",
    ]);
  });

  it("dedupes an upstream url that equals the own reference image, keeping the front slot", () => {
    expect(
      orderedReferenceUrlsWithOwnFirst("a.png", ["a.png", "b.png"]),
    ).toEqual(["a.png", "b.png"]);
  });
});
