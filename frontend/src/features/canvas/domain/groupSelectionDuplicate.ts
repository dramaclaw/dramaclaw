// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode } from "./canvasNodes";
import { isPresetManagedNode } from "./mainlineNodeFlags";

/** 节点到根的祖先层数；带环保护（画布数据损坏时不至于死循环）。 */
function nodeDepth(node: CanvasNode, byId: Map<string, CanvasNode>): number {
  let depth = 0;
  const visited = new Set<string>([node.id]);
  let parentId = node.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentId;
  }
  return depth;
}

/**
 * 批量复制时,「所选节点」实际要送进 `duplicateNodesAsSiblings` 的 id 列表。
 *
 * 和 {@link collectBatchDeletableIds} 是同一个坑的两面:画布的自定义 marquee 会把
 * 「包住其它命中节点的组」从选择里剔除(`Canvas.tsx` 的 `ancestorsOfHits`),否则拖动
 * 多选时父子会双重位移。代价是**用户框选整个组时,组本身的 `selected` 始终为假**。
 *
 * 复制若只拿 selected,`duplicateNodesAsSiblings` 里的 `parentIsCloned` 全为假,于是
 * 每个成员各自下移一个身位、各自加「- 副本」、`parentId` 回指原组 —— 副本散架并塞回
 * 原来那个组。这里把「会被整组复制」的普通组补回去。
 *
 * 两点和删除侧不同:
 * - **不过滤 preset/主线锁定的成员**。复制不是破坏性操作,现有行为就是照单全收;
 *   只有*补回来的组*本身受锁定约束 —— 用户没选它,不该替他克隆一个受管容器。
 * - **返回值保证前序**(父一定排在成员前面)。`duplicateNodesAsSiblings` 靠这个顺序
 *   用 `idMap.get(source.parentId)` 把成员重指到新克隆的组上;顺序反了,成员会拿不到
 *   父组的克隆 id 而落回原组。删除侧没有这个约束,所以它直接 `Array.from(Set)` 就够。
 *
 * 嵌套组也要成立:先深后浅地补,深层子组补进来之后,外层组才看得见「成员已全覆盖」。
 */
export function collectDuplicableIds(
  nodes: CanvasNode[],
  selectedIds: Iterable<string>,
): string[] {
  const selected = new Set(selectedIds);
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const result = new Set<string>();
  for (const node of nodes) {
    if (selected.has(node.id)) {
      result.add(node.id);
    }
  }

  // 一次遍历统计每个父节点的子节点总数,子节点的「已覆盖」数随补组过程增长。
  const childrenByParent = new Map<string, CanvasNode[]>();
  for (const node of nodes) {
    if (!node.parentId) {
      continue;
    }
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) {
      siblings.push(node);
    } else {
      childrenByParent.set(node.parentId, [node]);
    }
  }

  const groups = nodes
    .filter((node) => node.type === CANVAS_NODE_TYPES.group)
    .map((node) => ({ node, depth: nodeDepth(node, byId) }))
    // 深的先判定:嵌套组补进 result 后,它的父组才能算「成员全覆盖」。
    .sort((a, b) => b.depth - a.depth);
  for (const { node } of groups) {
    if (result.has(node.id) || isPresetManagedNode(node)) {
      continue;
    }
    const children = childrenByParent.get(node.id);
    if (children && children.length > 0 && children.every((child) => result.has(child.id))) {
      result.add(node.id);
    }
  }

  // 前序:按祖先层数升序。父的层数必然小于子,浅的排前面即可,同层保持 `nodes` 原序。
  return nodes
    .filter((node) => result.has(node.id))
    .map((node) => ({ id: node.id, depth: nodeDepth(node, byId) }))
    .sort((a, b) => a.depth - b.depth)
    .map((entry) => entry.id);
}
