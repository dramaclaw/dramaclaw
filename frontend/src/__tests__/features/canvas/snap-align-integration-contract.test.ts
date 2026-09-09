// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  createSnapAlignDragSession,
  isSnapAlignPositionChange,
  resolveSnapAlignDragMove,
} from '@/features/canvas/snap-align/resolveSnapAlignDrag';

function makeNode(
  id: string,
  position: { x: number; y: number },
  options: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id,
    type: 'image',
    position,
    width: 200,
    height: 100,
    data: {},
    ...options,
  } as CanvasNode;
}

describe('canvas snap-align integration', () => {
  it('snaps a dragged node to a group edge and emits a visible guide', () => {
    const targetGroup = makeNode('target-group', { x: 100, y: 100 }, {
      type: 'groupNode',
      width: 300,
      height: 240,
    });
    const dragged = makeNode('dragged', { x: 600, y: 500 });
    const session = createSnapAlignDragSession({
      nodes: [targetGroup, dragged],
      draggedNode: dragged,
      getAbsolutePosition: (node) => node.position,
    });

    const result = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: { x: 105, y: 500 },
      session,
      zoom: 1,
    });

    expect(result.position.x).toBe(100);
    expect(result.guides.vertical[0]).toMatchObject({
      coordinate: 100,
      targetNodeId: 'target-group',
      relation: 'align',
    });
  });

  it('uses absolute coordinates for children while excluding their own parent', () => {
    const ownGroup = makeNode('own-group', { x: 100, y: 100 }, {
      type: 'groupNode',
      width: 300,
      height: 300,
    });
    const otherGroup = makeNode('other-group', { x: 500, y: 100 }, {
      type: 'groupNode',
      width: 300,
      height: 300,
    });
    const dragged = makeNode('dragged', { x: 20, y: 20 }, { parentId: 'own-group' });
    const absolutePositions: Record<string, { x: number; y: number }> = {
      'own-group': { x: 100, y: 100 },
      'other-group': { x: 500, y: 100 },
      dragged: { x: 120, y: 120 },
    };
    const session = createSnapAlignDragSession({
      nodes: [ownGroup, otherGroup, dragged],
      draggedNode: dragged,
      getAbsolutePosition: (node) => absolutePositions[node.id],
    });

    const result = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: { x: 405, y: 420 },
      session,
      zoom: 1,
    });

    expect(result.position.x).toBe(400);
    expect(result.guides.vertical[0].targetNodeId).toBe('other-group');
    expect(result.guides.vertical[0].coordinate).toBe(500);
  });

  it('keeps the snap threshold constant in screen pixels at runtime', () => {
    const target = makeNode('target', { x: 100, y: 100 });
    const dragged = makeNode('dragged', { x: 600, y: 500 });
    const session = createSnapAlignDragSession({
      nodes: [target, dragged],
      draggedNode: dragged,
      getAbsolutePosition: (node) => node.position,
    });

    const zoomedOut = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: { x: 110, y: 500 },
      session,
      zoom: 0.5,
    });
    const zoomedIn = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: { x: 110, y: 500 },
      session,
      zoom: 2,
    });

    expect(zoomedOut.position.x).toBe(100);
    expect(zoomedIn.position.x).toBe(110);
  });

  it('keeps the snapped coordinate on the final dragging:false frame', () => {
    const target = makeNode('target', { x: 100, y: 100 });
    const dragged = makeNode('dragged', { x: 600, y: 500 });
    const initialSession = createSnapAlignDragSession({
      nodes: [target, dragged],
      draggedNode: dragged,
      getAbsolutePosition: (node) => node.position,
    });
    const engaged = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: { x: 105, y: 500 },
      session: initialSession,
      zoom: 1,
    });
    const finalChange = {
      id: 'dragged',
      type: 'position' as const,
      position: { x: 108, y: 500 },
      dragging: false,
    };

    expect(isSnapAlignPositionChange(finalChange, engaged.session.nodeId)).toBe(true);
    const finalized = resolveSnapAlignDragMove({
      draggedNode: dragged,
      proposedPosition: finalChange.position,
      session: engaged.session,
      zoom: 1,
    });

    expect(engaged.position.x).toBe(100);
    expect(finalized.position.x).toBe(100);
  });
});
