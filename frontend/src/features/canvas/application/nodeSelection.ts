// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 程序化「只选中这一个节点」。
 *
 * 单独调 setSelectedNode 是不够的：它只写 store 里的 selectedNodeId，而节点的操作
 * 面板门控的是 React Flow 传下来的 `selected` prop；更要命的是 Canvas 里那个
 * 「React Flow 选中态 → store」的单向同步 effect 会在下一次渲染把 selectedNodeId
 * 写回 null（因为真的没有节点是 selected 的）。所以必须先经 onNodesChange 派发
 * select 变更，再同步 store——两处都要，缺一处就等于没选中。
 */
import { useCanvasStore } from '@/stores/canvasStore';

export function selectNodeExclusively(nodeId: string): void {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) return;
  const changes = store.nodes
    .filter((node) => Boolean(node.selected) !== (node.id === nodeId))
    .map((node) => ({
      id: node.id,
      type: 'select' as const,
      selected: node.id === nodeId,
    }));
  if (changes.length > 0) store.onNodesChange(changes);
  store.setSelectedNode(nodeId);
}
