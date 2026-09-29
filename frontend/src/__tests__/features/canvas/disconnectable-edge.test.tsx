// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PropsWithChildren } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBezierPath, Position, type EdgeProps } from '@xyflow/react';
import { DisconnectableEdge } from '@/features/canvas/edges/DisconnectableEdge';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useCanvasToolStore } from '@/features/canvas/ui/canvasToolStore';
import { setCanvasGestureActive } from '@/features/canvas/application/canvasLod';

vi.mock('@xyflow/react', async importOriginal => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  EdgeLabelRenderer: ({ children }: PropsWithChildren) => <foreignObject>{children}</foreignObject>,
}));

const props: EdgeProps = {
  id: 'native-edge', source: 'a', target: 'b',
  sourceX: 20, sourceY: 40, sourcePosition: Position.Right,
  targetX: 300, targetY: 160, targetPosition: Position.Left,
  style: { stroke: 'red', strokeWidth: 1.5, opacity: 0.5, strokeOpacity: 0.3 },
};
const flowSelector = '[data-canvas-edge-flow]';
const hitSelector = 'path.nodrag';
const originalDeleteEdge = useCanvasStore.getState().deleteEdge;
beforeEach(() => {
  vi.useFakeTimers();
  useCanvasStore.setState({ nodes: [], edges: [], selectedNodeId: null });
  useSettingsStore.setState({ canvasEdgeRoutingMode: 'spline' });
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  useCanvasStore.setState({ deleteEdge: originalDeleteEdge, nodes: [], selectedNodeId: null });
  useCanvasToolStore.getState().setTool('move'); setCanvasGestureActive(false);
});

describe('native edge meteor feedback', () => {
  it('uses opaque 1.5px reference paint, keeps geometry, marker and endpoint dots', () => {
    const { container } = render(<svg><DisconnectableEdge {...props} markerEnd="url(#arrow)" /></svg>);
    const line = container.querySelector<SVGElement>('.react-flow__edge-path')!;
    expect(line.getAttribute('d')).toBe(getBezierPath(props)[0]);
    expect(line.style.stroke).toBe('rgb(134, 144, 156)'); expect(line.style.strokeWidth).toBe('1.5');
    expect(line.style.opacity).toBe('1'); expect(line.style.strokeOpacity).toBe('1');
    expect(line.getAttribute('marker-end')).toBe('url(#arrow)');
    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('animates the same eight unfiltered trails and keeps delayed disconnect working', () => {
    const disconnect = vi.fn(); useCanvasStore.setState({ deleteEdge: disconnect });
    const { container, queryByRole, getByRole } = render(<svg><DisconnectableEdge {...props} /></svg>);
    fireEvent.pointerEnter(container.querySelector(hitSelector)!);
    const line = container.querySelector<SVGElement>('.react-flow__edge-path')!;
    expect(line.style.strokeWidth).toBe('2'); expect(line.style.stroke).toBe('rgb(192, 200, 208)');
    const flow = container.querySelector(flowSelector)!;
    expect(flow.querySelectorAll('path')).toHaveLength(8);
    expect(flow.querySelector('path:last-child')?.getAttribute('stroke-width')).toBe('2');
    expect(flow.querySelector('path')?.getAttribute('d')).toBe(line.getAttribute('d'));
    expect(flow.getAttribute('pointer-events')).toBe('none');
    expect(container.querySelector('filter, animateMotion')).toBeNull();
    act(() => vi.advanceTimersByTime(499)); expect(queryByRole('button')).toBeNull();
    act(() => vi.advanceTimersByTime(1)); fireEvent.click(getByRole('button'));
    expect(disconnect).toHaveBeenCalledWith('native-edge');
    fireEvent.pointerLeave(container.querySelector(hitSelector)!);
    act(() => vi.advanceTimersByTime(160));
    expect(container.querySelector(flowSelector)).toBeNull();
    expect(line.style.strokeWidth).toBe('1.5'); expect(queryByRole('button')).toBeNull();
  });

  it('highlights selected relationships and leaves unrelated lines fully opaque', () => {
    useCanvasStore.setState({ selectedNodeId: 'unrelated' });
    const { container } = render(<svg><DisconnectableEdge {...props} /></svg>);
    expect(container.querySelector<SVGElement>('.react-flow__edge-path')!.style.stroke).toBe('rgb(134, 144, 156)');
    act(() => useCanvasStore.setState({ selectedNodeId: 'a' }));
    expect(container.querySelector(flowSelector)).not.toBeNull();
    act(() => useCanvasStore.setState({ selectedNodeId: null }));
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('clears hover and its pending disconnect button on switching to hand', () => {
    const { container, queryByRole } = render(<svg><DisconnectableEdge {...props} /></svg>);
    fireEvent.pointerEnter(container.querySelector(hitSelector)!);
    act(() => useCanvasToolStore.getState().setTool('hand'));
    fireEvent.pointerEnter(container.querySelector(hitSelector)!);
    act(() => vi.advanceTimersByTime(600));
    expect(container.querySelector(flowSelector)).toBeNull(); expect(queryByRole('button')).toBeNull();
    act(() => useCanvasToolStore.getState().setTool('move'));
    expect(container.querySelector(flowSelector)).toBeNull();
    setCanvasGestureActive(true); fireEvent.pointerEnter(container.querySelector(hitSelector)!);
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('retains the dedicated generation feedback without overlaying a meteor', () => {
    useCanvasStore.setState({ nodes: [
      { id: 'a', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 0, y: 0 }, data: {} },
      { id: 'b', type: CANVAS_NODE_TYPES.exportImage, position: { x: 200, y: 100 }, data: { isGenerating: true } },
    ] as CanvasNode[] });
    const { container } = render(<svg><DisconnectableEdge {...props} selected /></svg>);
    expect(container.querySelector('.canvas-processing-edge__flow')).not.toBeNull();
    expect(container.querySelector(flowSelector)).toBeNull();
  });
});
