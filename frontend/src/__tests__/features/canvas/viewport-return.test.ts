// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  focusReferenceNode,
  useViewportReturnStore,
} from '@/features/canvas/application/viewportReturnStore';
import { useCanvasStore } from '@/stores/canvasStore';

describe('focusReferenceNode', () => {
  beforeEach(() => {
    useViewportReturnStore.getState().stop();
    useCanvasStore.setState({
      currentViewport: { x: 120, y: -40, zoom: 0.75 },
      pendingFocusNodeId: null,
    });
  });

  it('聚焦被引用节点，并记下回到起点节点的退路', () => {
    focusReferenceNode('ref-node', 'origin-node');

    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('ref-node');
    expect(useViewportReturnStore.getState().request).toEqual({
      originViewport: { x: 120, y: -40, zoom: 0.75 },
      originNodeId: 'origin-node',
    });
  });

  it('存的是视口快照而不是 store 里的活对象', () => {
    focusReferenceNode('ref-node', 'origin-node');
    // 跳转本身会把 currentViewport 改掉；「原视口」不能跟着一起变，
    // 否则「返回节点」回到的是跳转之后的位置，等于没返回。
    useCanvasStore.setState({ currentViewport: { x: 999, y: 999, zoom: 2 } });

    expect(useViewportReturnStore.getState().request?.originViewport).toEqual({
      x: 120,
      y: -40,
      zoom: 0.75,
    });
  });

  it('stop 幂等：已经收起来时不产生新的 state 对象', () => {
    const before = useViewportReturnStore.getState();
    useViewportReturnStore.getState().stop();
    expect(useViewportReturnStore.getState()).toBe(before);
  });
});
