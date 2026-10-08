// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBezierPath, Position, type EdgeProps } from '@xyflow/react';
import { DefaultCanvasEdge } from '@/features/canvas/edges/DefaultCanvasEdge';
import { edgeTypes } from '@/features/canvas/edges';
import { useCanvasToolStore } from '@/features/canvas/ui/canvasToolStore';
import { setCanvasGestureActive } from '@/features/canvas/application/canvasLod';

vi.mock('@/features/canvas/edges/DisconnectableEdge', () => ({ DisconnectableEdge: () => null }));

const props: EdgeProps = {
  id: 'imported-edge', source: 'a', target: 'b',
  sourceX: 20, sourceY: 40, sourcePosition: Position.Right,
  targetX: 300, targetY: 160, targetPosition: Position.Left,
  style: { stroke: 'rgb(120, 130, 140)', strokeWidth: 1.5, opacity: 0.8, strokeOpacity: 0.5 },
};
const flowSelector = '[data-canvas-edge-flow]';
const edgeSelector = '[data-canvas-default-edge]';
afterEach(() => {
  cleanup(); useCanvasToolStore.getState().setTool('move'); setCanvasGestureActive(false);
  delete (SVGElement.prototype as SVGElement & { getBBox?: () => DOMRect }).getBBox;
});

describe('imported default edge feedback', () => {
  it('registers the default type without replacing the existing custom type', () => {
    expect(edgeTypes.default).toBe(DefaultCanvasEdge);
    expect(edgeTypes.disconnectableEdge).not.toBe(DefaultCanvasEdge);
  });

  it('keeps the native Bezier, opaque 1.5px paint, markers and hit width, with no idle animation', () => {
    const pathOptions = { curvature: 0.7 };
    const { container } = render(<svg><DefaultCanvasEdge {...props} pathOptions={pathOptions}
      markerStart="url(#start)" markerEnd="url(#end)" interactionWidth={26} /></svg>);
    const line = container.querySelector<SVGElement>('.react-flow__edge-path')!;
    expect(line.getAttribute('d')).toBe(getBezierPath({ ...props, curvature: 0.7 })[0]);
    expect(line.style.stroke).toBe('rgb(134, 144, 156)');
    expect(line.style.strokeWidth).toBe('1.5');
    expect(line.style.opacity).toBe('1');
    expect(line.style.strokeOpacity).toBe('1');
    expect(line.getAttribute('marker-start')).toBe('url(#start)');
    expect(line.getAttribute('marker-end')).toBe('url(#end)');
    expect(container.querySelector('.react-flow__edge-interaction')?.getAttribute('stroke-width')).toBe('26');
    expect(container.querySelectorAll('path')).toHaveLength(2);
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('thickens only the hovered edge, adds unfiltered flow, and restores paint on leave', () => {
    const { container } = render(<svg><DefaultCanvasEdge {...props} /></svg>);
    const edge = container.querySelector(edgeSelector)!;
    const line = container.querySelector<SVGElement>('.react-flow__edge-path')!;
    fireEvent.pointerEnter(edge);
    expect(line.style.strokeWidth).toBe('2');
    expect(line.style.stroke).toBe('rgb(192, 200, 208)');
    const flow = container.querySelector(flowSelector)!;
    expect(flow.getAttribute('pointer-events')).toBe('none');
    expect(flow.querySelectorAll('path')).toHaveLength(8);
    expect(flow.querySelector('path:last-child')?.getAttribute('stroke-width')).toBe('2');
    expect(flow.querySelector('path')?.getAttribute('d')).toBe(line.getAttribute('d'));
    expect(container.querySelector('filter, animateMotion')).toBeNull();
    fireEvent.pointerLeave(edge);
    expect(container.querySelector(flowSelector)).toBeNull();
    expect(line.style.strokeWidth).toBe('1.5');
    expect(line.style.stroke).toBe('rgb(134, 144, 156)');
  });

  it('keeps selected feedback after pointer leave and clears it on deselection', () => {
    const { container, rerender } = render(<svg><DefaultCanvasEdge {...props} selected /></svg>);
    fireEvent.pointerLeave(container.querySelector(edgeSelector)!);
    expect(container.querySelector(flowSelector)).not.toBeNull();
    rerender(<svg><DefaultCanvasEdge {...props} selected={false} /></svg>);
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('clears hover when switching to hand, and does not revive it on returning to move', () => {
    const { container } = render(<svg><DefaultCanvasEdge {...props} /></svg>);
    const edge = container.querySelector(edgeSelector)!;
    fireEvent.pointerEnter(edge);
    act(() => useCanvasToolStore.getState().setTool('hand'));
    fireEvent.pointerEnter(edge);
    expect(container.querySelector(flowSelector)).toBeNull();
    act(() => useCanvasToolStore.getState().setTool('move'));
    expect(container.querySelector(flowSelector)).toBeNull();
    fireEvent.pointerEnter(edge);
    expect(container.querySelector(flowSelector)).not.toBeNull();
  });

  it('does not activate while a canvas gesture is in progress', () => {
    setCanvasGestureActive(true);
    const { container } = render(<svg><DefaultCanvasEdge {...props} /></svg>);
    fireEvent.pointerEnter(container.querySelector(edgeSelector)!);
    expect(container.querySelector(flowSelector)).toBeNull();
  });

  it('retains labels and leaves click/double-click ownership with the RF wrapper', () => {
    // jsdom lacks SVG text measurement, which RF uses to place label backgrounds.
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true, value: () => ({ x: 0, y: 0, width: 80, height: 16 }),
    });
    const click = vi.fn(); const doubleClick = vi.fn();
    const { container, getByText } = render(<svg onClick={click} onDoubleClick={doubleClick}>
      <DefaultCanvasEdge {...props} label="reference" labelStyle={{ fill: 'red' }} />
    </svg>);
    expect(getByText('reference')).toBeTruthy();
    const hit = container.querySelector('.react-flow__edge-interaction')!;
    fireEvent.click(hit); fireEvent.doubleClick(hit);
    expect(click).toHaveBeenCalledOnce(); expect(doubleClick).toHaveBeenCalledOnce();
  });
});
