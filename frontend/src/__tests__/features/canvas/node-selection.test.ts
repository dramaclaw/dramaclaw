// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import { selectNodeExclusively } from '@/features/canvas/application/nodeSelection';
import { useCanvasStore } from '@/stores/canvasStore';

function seedNodes() {
  useCanvasStore.setState({
    nodes: [
      { id: 'a', type: 'imageGen', position: { x: 0, y: 0 }, data: {}, selected: true },
      { id: 'b', type: 'imageGen', position: { x: 0, y: 0 }, data: {}, selected: false },
    ] as never,
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
