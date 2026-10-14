// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { clearCanvasSelection, selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

function seedNodes() {
  useCanvasStore.setState({
    nodes: [
      { id: 'a', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: {}, selected: true },
      { id: 'b', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: {}, selected: false },
    ] as never,
    edges: [],
    selectedNodeId: 'a',
  });
}

describe('selectNodeExclusively', () => {
  beforeEach(seedNodes);

  it('同时写 React Flow 的 selected 和 store 的 selectedNodeId', () => {
    selectNodeExclusively('b');

    const state = useCanvasStore.getState();
    // 只写 selectedNodeId 是不够的：节点操作面板门控的是 selected，而 Canvas 的
    // 「RF → store」同步 effect 会立刻把没人 selected 的 selectedNodeId 抹成 null。
    expect(state.nodes.map((node) => [node.id, Boolean(node.selected)])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(state.selectedNodeId).toBe('b');
  });

  it('节点已经不在画布上就什么都不做', () => {
    selectNodeExclusively('gone');

    const state = useCanvasStore.getState();
    expect(state.selectedNodeId).toBe('a');
    expect(state.nodes.find((node) => node.id === 'a')?.selected).toBe(true);
  });
});

it('清除节点和连线选中态时不修改内容或撤销历史', () => {
  seedNodes();
  useCanvasStore.setState({ edges: [{ id: 'edge', source: 'a', target: 'b', selected: true }] });
  useCanvasStore.getState().updateNodeData('a', { prompt: '保留已有编辑和撤销历史' });
  const before = useCanvasStore.getState();
  expect(before.userEditsSinceHydrate).toBeGreaterThan(0);
  expect(before.history.past.length).toBeGreaterThan(0);

  clearCanvasSelection();

  const after = useCanvasStore.getState();
  expect(after.selectedNodeId).toBeNull();
  expect(after.nodes.every((node) => !node.selected)).toBe(true);
  expect(after.edges.every((edge) => !edge.selected)).toBe(true);
  expect(after.nodes[0].position).toBe(before.nodes[0].position);
  expect(after.nodes[0].data).toBe(before.nodes[0].data);
  expect(after.nodes[1]).toBe(before.nodes[1]);
  expect(after.history).toBe(before.history);
  expect(after.userEditsSinceHydrate).toBe(before.userEditsSinceHydrate);
});

it('没有选中内容时不产生额外 store 更新', () => {
  seedNodes();
  clearCanvasSelection();
  const before = useCanvasStore.getState();
  clearCanvasSelection();
  expect(useCanvasStore.getState()).toBe(before);
});
