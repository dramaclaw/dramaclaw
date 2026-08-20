// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 复制一个组 = 组框 + 全部成员一起克隆。历史上这里踩过三个坑：成员被塞回原组、
// 每个成员各自往下偏移一次（组内瞬间散架）、组框尺寸丢失（createNode 不带 width/height）。
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { collectDuplicableIds } from "@/features/canvas/domain/groupSelectionDuplicate";
import { useCanvasStore } from "@/stores/canvasStore";

function node(
  id: string,
  type: CanvasNode["type"],
  position: { x: number; y: number },
  data: Record<string, unknown> = {},
  extra: Partial<CanvasNode> = {},
): CanvasNode {
  return { id, type, position, data, ...extra } as CanvasNode;
}

describe("duplicateNodesAsSiblings", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  it("keeps a duplicated group intact", () => {
    const group = node(
      "g",
      CANVAS_NODE_TYPES.group,
      { x: 0, y: 0 },
      { label: "苏鸾" },
      { width: 640, height: 480, style: { zIndex: -1 } },
    );
    const member = node(
      "m",
      CANVAS_NODE_TYPES.imageGen,
      { x: 40, y: 60 },
      { displayName: "立绘" },
      { parentId: "g", extent: "parent" },
    );
    useCanvasStore.setState({ nodes: [group, member], edges: [] });

    const [groupCloneId, memberCloneId] = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(["g", "m"]);

    const nodes = useCanvasStore.getState().nodes;
    const groupClone = nodes.find((candidate) => candidate.id === groupCloneId);
    const memberClone = nodes.find((candidate) => candidate.id === memberCloneId);

    expect(groupClone).toBeDefined();
    expect(memberClone).toBeDefined();
    // 成员挂到新组上，而不是原组
    expect(memberClone?.parentId).toBe(groupCloneId);
    // 成员坐标是相对父组的，跟着组走就行，不能再各自下移
    expect(memberClone?.position).toEqual({ x: 40, y: 60 });
    // 组框自己才需要让开一个身位
    expect(groupClone?.position).toEqual({ x: 0, y: 480 + 24 });
    // 尺寸/样式是节点级字段，createNode 带不过来，必须手动搬
    expect(groupClone?.width).toBe(640);
    expect(groupClone?.height).toBe(480);
    // 只有被直接复制的对象加「副本」后缀，组内成员保持原名
    expect((groupClone?.data as { label?: string }).label).toBe("苏鸾 - 副本");
    expect((memberClone?.data as { displayName?: string }).displayName).toBe("立绘");
  });

  // 框选整组走的是这条路:marquee 剔除祖先组，工具栏拿到的 selected 里只有成员。
  // 直接把它递给 store 会重现「副本散架 + 塞回原组」；补组后必须和显式选中组等价。
  it("keeps the group intact when only its members are selected (marquee path)", () => {
    const group = node(
      "g",
      CANVAS_NODE_TYPES.group,
      { x: 0, y: 0 },
      { label: "苏鸾" },
      { width: 640, height: 480, style: { zIndex: -1 } },
    );
    const member = node(
      "m",
      CANVAS_NODE_TYPES.imageGen,
      { x: 40, y: 60 },
      { displayName: "立绘" },
      { parentId: "g", extent: "parent" },
    );
    const nodes = [group, member];
    useCanvasStore.setState({ nodes, edges: [] });

    const [groupCloneId, memberCloneId] = useCanvasStore
      .getState()
      .duplicateNodesAsSiblings(collectDuplicableIds(nodes, ["m"]));

    const after = useCanvasStore.getState().nodes;
    const groupClone = after.find((candidate) => candidate.id === groupCloneId);
    const memberClone = after.find((candidate) => candidate.id === memberCloneId);

    expect(memberClone?.parentId).toBe(groupCloneId);
    expect(memberClone?.position).toEqual({ x: 40, y: 60 });
    expect(groupClone?.position).toEqual({ x: 0, y: 480 + 24 });
    expect(groupClone?.width).toBe(640);
    // 成员不加后缀，只有组框自己算「被直接复制的对象」
    expect((groupClone?.data as { label?: string }).label).toBe("苏鸾 - 副本");
    expect((memberClone?.data as { displayName?: string }).displayName).toBe("立绘");
  });

  it("still offsets a standalone node below the original", () => {
    useCanvasStore.setState({
      nodes: [
        node("solo", CANVAS_NODE_TYPES.imageGen, { x: 10, y: 20 }, { displayName: "封面" }, {
          measured: { width: 320, height: 200 },
        }),
      ],
      edges: [],
    });

    const [cloneId] = useCanvasStore.getState().duplicateNodesAsSiblings(["solo"]);
    const clone = useCanvasStore.getState().nodes.find((candidate) => candidate.id === cloneId);

    expect(clone?.position).toEqual({ x: 10, y: 20 + 200 + 24 });
    expect(clone?.parentId).toBeUndefined();
    expect((clone?.data as { displayName?: string }).displayName).toBe("封面 - 副本");
  });
});

describe("createdAt on duplication", () => {
  beforeEach(() => {
    useCanvasStore.setState({ nodes: [], edges: [] });
  });

  // 工厂里 createdAt 压在 ...data 之后，就是为了这条：duplicateNodeAsSibling 会把
  // 源节点的整份 data 摊进去，放前面的话复制出来的节点会继承源节点的创建时刻，
  // 而侧栏大纲正是靠这个时刻区分「同一条提示词复制三份」的重名行。
  it("gives each clone its own creation moment instead of inheriting the source's", () => {
    const createdAt = new Date(2020, 0, 1).getTime();
    useCanvasStore.setState({
      nodes: [node("src", CANVAS_NODE_TYPES.video, { x: 0, y: 0 }, { displayName: "海边的黄昏", createdAt })],
      edges: [],
    });

    const cloneId = useCanvasStore.getState().duplicateNodeAsSibling("src", 1);
    const clone = useCanvasStore.getState().nodes.find((n) => n.id === cloneId);

    expect(clone).toBeDefined();
    expect((clone!.data as { displayName?: string }).displayName).toBe("海边的黄昏");
    expect((clone!.data as { createdAt?: number }).createdAt).not.toBe(createdAt);
    expect((clone!.data as { createdAt?: number }).createdAt).toBeGreaterThan(createdAt);
  });
});
