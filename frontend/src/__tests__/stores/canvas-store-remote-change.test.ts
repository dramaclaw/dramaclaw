// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCanvasStore, useCanvasStore, type CanvasEdge, type CanvasNode } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { createNodeCanvasEnvironment } from '@/features/canvas/infrastructure/nodeCanvasEnvironment';
import {
  mergeCanvas,
  prepareRemoteCanvasChange,
  replayRemoteChangeOnSnapshot,
  type Canvas,
} from '@/features/freezone/canvasMerge';

const node = (id: string, label = 'old'): CanvasNode => ({
  id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { label },
});
const state = () => useCanvasStore.getState();
const findNode = (id: string) => state().nodes.find((item) => item.id === id);
const moveA = (x: number, dragging?: boolean) => state().onNodesChange([
  { id: 'A', type: 'position', position: { x, y: 0 }, dragging },
]);
const applyRemote = (base: Canvas, remote: Canvas) => {
  const prepared = prepareRemoteCanvasChange(base, remote);
  const merged = mergeCanvas(state(), prepared, state().editingNodeFields);
  state().applyRemoteCanvasChange(merged.nodes, merged.edges,
    (snapshot) => replayRemoteChangeOnSnapshot(snapshot, prepared));
};

describe('canvas store remote changes', () => {
  beforeEach(() => {
    state().setCanvasData([node('A'), node('B'), node('C')], []);
  });

  it('tracks text fields once per pair without recording a user edit or undo step', () => {
    expect(state().editingNodeFields).toEqual([]);
    state().beginNodeFieldEdit('A', 'data.content');
    state().beginNodeFieldEdit('A', 'data.content');
    state().beginNodeFieldEdit('A', 'data.label');
    state().beginNodeFieldEdit('B', 'data.content');
    expect(state().editingNodeFields).toEqual([
      { nodeId: 'A', field: 'data.content' },
      { nodeId: 'A', field: 'data.label' },
      { nodeId: 'B', field: 'data.content' },
    ]);

    state().endNodeFieldEdit('A', 'data.content');
    state().endNodeFieldEdit('A', 'data.content');
    expect(state().editingNodeFields).toEqual([
      { nodeId: 'A', field: 'data.label' },
      { nodeId: 'B', field: 'data.content' },
    ]);
    expect(state().history).toEqual({ past: [], future: [] });
    expect(state().userEditsSinceHydrate).toBe(0);
    expect(state().lastMutationSource).toBeNull();
    expect(state().pendingClearIntent).toBe(false);

    state().updateNodeData('A', { label: 'user' });
    state().undo();
    expect(state().editingNodeFields).toEqual([
      { nodeId: 'A', field: 'data.label' },
      { nodeId: 'B', field: 'data.content' },
    ]);
    state().setCanvasData([node('A')], []);
    expect(state().editingNodeFields).toEqual([]);
  });

  it('keeps selection, dialogs and text editing only for nodes that remain', () => {
    state().setSelectedNode('A');
    state().openToolDialog({ nodeId: 'B', toolType: 'crop' });
    state().beginNodeFieldEdit('A', 'data.content');
    state().beginNodeFieldEdit('B', 'data.label');
    state().beginNodeFieldEdit('C', 'data.content');
    state().applyRemoteCanvasChange([node('A'), node('B')], [], (snapshot) => snapshot);
    expect(state().selectedNodeId).toBe('A');
    expect(state().activeToolDialog).toEqual({ nodeId: 'B', toolType: 'crop' });
    expect(state().editingNodeFields).toEqual([
      { nodeId: 'A', field: 'data.content' },
      { nodeId: 'B', field: 'data.label' },
    ]);

    state().setActiveOverlayNodeId('A');
    state().setActiveLightEditorNodeId('B');
    state().setStoryEditNode('A');
    state().applyRemoteCanvasChange([], [], (snapshot) => snapshot);
    expect(state().selectedNodeId).toBeNull();
    expect(state().activeToolDialog).toBeNull();
    expect(state().editingNodeFields).toEqual([]);
    expect(state().activeOverlayNodeId).toBe('A');
    expect(state().activeLightEditorNodeId).toBe('B');
    expect(state().storyEditNodeId).toBe('A');
  });

  it('uses the supplied arrays and node objects without replacing the canvas', () => {
    const onCanvasReplaced = vi.fn();
    const store = createCanvasStore({
      ...createNodeCanvasEnvironment({ translate: (key) => key }),
      onCanvasReplaced,
    });
    store.getState().setCanvasData([node('A')], []);
    onCanvasReplaced.mockClear();
    const supplied = node('A');
    const nodes = [supplied, node('B')];
    const edges: CanvasEdge[] = [{ id: 'AB', source: 'A', target: 'B', selected: true }];
    store.getState().applyRemoteCanvasChange(nodes, edges, (snapshot) => snapshot);
    expect(store.getState().nodes).toBe(nodes);
    expect(store.getState().nodes[0]).toBe(supplied);
    expect(store.getState().edges).toBe(edges);
    expect(store.getState().history.past).toHaveLength(0);
    expect(onCanvasReplaced).not.toHaveBeenCalled();
  });

  it('does not add an undo step or change user mutation bookkeeping', () => {
    state().clearCanvas();
    expect(state().history.past).toHaveLength(1);
    state().applyRemoteCanvasChange([node('B', 'agent')], [], (snapshot) => snapshot);
    expect(state().history.past).toHaveLength(1);
    expect(state().userEditsSinceHydrate).toBe(1);
    expect(state().lastMutationSource).toBe('manual_clear');
    expect(state().pendingClearIntent).toBe(true);
  });

  it('undoes and redoes a local move while keeping a remote label', () => {
    const base = state();
    moveA(100);
    expect(state().history.past).toHaveLength(1);
    applyRemote(base, { nodes: [node('A'), node('B', 'agent'), node('C')], edges: [] });
    expect(state().history.past).toHaveLength(1);
    expect(state().userEditsSinceHydrate).toBe(1);
    expect(state().lastMutationSource).toBe('user_edit');
    expect(state().pendingClearIntent).toBe(false);
    expect(findNode('A')?.position).toEqual({ x: 100, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');

    expect(state().undo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 0, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');
    expect(state().undo()).toBe(false);
    expect(state().redo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 100, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');
  });

  it('keeps a remote new node and its edge after undo', () => {
    const base = state();
    moveA(100);
    applyRemote(base, {
      nodes: [...base.nodes, node('D', 'new')],
      edges: [{ id: 'BD', source: 'B', target: 'D' }],
    });
    expect(findNode('D')?.data.label).toBe('new');
    expect(state().undo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 0, y: 0 });
    expect(findNode('D')?.data.label).toBe('new');
    expect(state().edges).toEqual([{ id: 'BD', source: 'B', target: 'D' }]);
  });

  it('drops a conflicting past snapshot and all older steps, keeping the recent safe step', () => {
    state().updateNodeData('B', { label: 'earlier' });
    state().updateNodeData('C', { label: 'user' });
    state().updateNodeData('A', { label: 'user' });
    expect(state().history.past).toHaveLength(3);
    const base = state();
    applyRemote(base, { nodes: base.nodes.filter((item) => item.id !== 'C'), edges: [] });
    expect(state().history.past).toHaveLength(1);
    expect(state().undo()).toBe(true);
    expect(findNode('A')?.data.label).toBe('old');
    expect(findNode('B')?.data.label).toBe('earlier');
    expect(findNode('C')).toBeUndefined();
    expect(state().undo()).toBe(false);
    expect(findNode('C')).toBeUndefined();
  });

  it('replays all future snapshots without clearing redo or changing their order', () => {
    moveA(100);
    moveA(200);
    moveA(300);
    state().undo();
    state().undo();
    const base = state();
    applyRemote(base, { nodes: base.nodes.map((item) => item.id === 'B'
      ? { ...item, data: { ...item.data, label: 'agent' } } : item), edges: [] });
    expect(state().history.future).toHaveLength(2);
    expect(state().redo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 200, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');
    expect(state().redo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 300, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');
    expect(state().redo()).toBe(false);
  });

  it('keeps the next safe redo step and drops a conflict and all later redo steps', () => {
    state().updateNodeData('A', { label: 'first' });
    state().updateNodeData('C', { label: 'user' });
    state().updateNodeData('A', { label: 'second' });
    state().updateNodeData('B', { label: 'latest' });
    state().undo();
    state().undo();
    state().undo();
    state().undo();
    expect(state().history.future).toHaveLength(4);
    const base = state();
    applyRemote(base, { nodes: base.nodes.filter((item) => item.id !== 'C'), edges: [] });
    expect(state().history.future).toHaveLength(1);
    expect(state().redo()).toBe(true);
    expect(findNode('A')?.data.label).toBe('first');
    expect(findNode('B')?.data.label).toBe('old');
    expect(findNode('C')).toBeUndefined();
    expect(state().redo()).toBe(false);
    expect(findNode('C')).toBeUndefined();
  });

  it('clears redo when the next redo snapshot conflicts', () => {
    state().updateNodeData('C', { label: 'user' });
    state().updateNodeData('A', { label: 'user' });
    state().undo();
    state().undo();
    const base = state();
    applyRemote(base, { nodes: base.nodes.filter((item) => item.id !== 'C'), edges: [] });
    expect(state().history.future).toHaveLength(0);
    expect(state().redo()).toBe(false);
    expect(findNode('A')?.data.label).toBe('old');
    expect(findNode('C')).toBeUndefined();
  });

  it('replays the drag start snapshot so undo keeps the remote value', () => {
    const base = state();
    moveA(40, true);
    expect(state().history.past).toHaveLength(0);
    applyRemote(base, { nodes: [node('A'), node('B', 'agent'), node('C')], edges: [] });
    expect(findNode('A')?.position).toEqual({ x: 40, y: 0 });
    moveA(100, false);
    expect(state().history.past).toHaveLength(1);
    expect(state().undo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 0, y: 0 });
    expect(findNode('B')?.data.label).toBe('agent');
  });

  it('discards a conflicting drag start snapshot', () => {
    moveA(40, true);
    state().updateNodeData('C', { label: 'user' }, { recordHistory: false });
    const base = state();
    applyRemote(base, { nodes: base.nodes.filter((item) => item.id !== 'C'), edges: [] });
    expect(state().dragHistorySnapshot).toBeNull();
    moveA(100, false);
    expect(state().undo()).toBe(true);
    expect(findNode('A')?.position).toEqual({ x: 40, y: 0 });
    expect(findNode('C')).toBeUndefined();
  });
});
