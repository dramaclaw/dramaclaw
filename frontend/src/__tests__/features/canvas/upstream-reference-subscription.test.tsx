// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { useUpstreamNodes, useUpstreamReferenceNodes } from '@/features/canvas/application/useUpstreamGraph';
import { upstreamNodesInEdgeOrder } from '@/features/canvas/nodes/referenceOrdering';

const makeNode = (id: string): CanvasNode => ({ id, type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: id } });
const edge = (source: string): CanvasEdge => ({ id: source, source, target: 'target' });
beforeEach(() => useCanvasStore.setState({ nodes: [makeNode('a'), makeNode('b')], edges: [edge('b'), edge('a')] }));

describe('reference content subscriptions', () => {
  it('does not render for upstream movement, size measurement or selection', () => {
    const rendered = vi.fn();
    const { result } = renderHook(() => { rendered(); return useUpstreamReferenceNodes('target'); });
    const original = result.current;
    const count = rendered.mock.calls.length;
    act(() => {
      for (let i = 0; i < 20; i++) useCanvasStore.setState(({ nodes }) => ({
        nodes: nodes.map((n) => ({ ...n, position: { x: i, y: i }, selected: true, measured: { width: 500, height: 300 } })),
      }));
    });
    expect(result.current).toBe(original);
    expect(rendered).toHaveBeenCalledTimes(count);
  });

  it('publishes content edits and preserves connection order', () => {
    const { result } = renderHook(() => useUpstreamReferenceNodes('target'));
    expect(result.current.map(n => n.id)).toEqual(['b', 'a']);
    const original = result.current;
    act(() => useCanvasStore.setState(({ nodes }) => ({ nodes: nodes.map(n => n.id === 'b' ? { ...n, data: { ...n.data, content: 'updated' } } : n) })));
    expect(result.current).not.toBe(original);
    expect(result.current[0].data.content).toBe('updated');
    act(() => useCanvasStore.setState({ edges: [edge('a'), edge('b')] }));
    expect(result.current.map(n => n.id)).toEqual(['a', 'b']);
  });

  it('retains live geometry in the original hook', () => {
    const { result } = renderHook(() => useUpstreamNodes('target'));
    act(() => useCanvasStore.setState(({ nodes }) => ({ nodes: nodes.map(n => ({ ...n, position: { x: 55, y: 77 } })) })));
    expect(result.current[0].position).toEqual({ x: 55, y: 77 });
  });

  it('matches submission ordering for missing and duplicate sources, deletion and retargeting', () => {
    const { result, rerender } = renderHook(({ id }) => useUpstreamReferenceNodes(id), { initialProps: { id: 'target' } });
    act(() => useCanvasStore.setState({ edges: [edge('missing'), edge('a'), { ...edge('a'), id: 'duplicate' }, edge('b')] }));
    const state = useCanvasStore.getState();
    expect(result.current).toEqual(upstreamNodesInEdgeOrder(state.nodes, state.edges, 'target'));
    act(() => useCanvasStore.setState(({ nodes }) => ({ nodes: nodes.filter(n => n.id !== 'a') })));
    expect(result.current.map(n => n.id)).toEqual(['b']);
    rerender({ id: 'other' });
    expect(result.current).toEqual([]);
  });
});
