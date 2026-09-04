// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  computeSnapAlign,
  SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD,
  SNAP_ALIGN_SCREEN_THRESHOLD,
} from '@/features/canvas/snap-align/computeSnapAlign';

function makeNode(
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 100,
): CanvasNode {
  return {
    id,
    position: { x, y },
    width,
    height,
    data: {},
    type: 'image',
  } as unknown as CanvasNode;
}

describe('semantic snap align', () => {
  it('snaps matching outer edges and emits local guides', () => {
    const dragged = makeNode('dragged', 400, 400, 120, 80);
    const target = makeNode('target', 100, 100, 200, 100);
    const result = computeSnapAlign(dragged, { x: 104, y: 103 }, [target]);

    expect(result.position).toEqual({ x: 100, y: 100 });
    expect(result.guides.vertical[0]).toMatchObject({
      coordinate: 100,
      start: 100,
      end: 200,
      targetNodeId: 'target',
      relation: 'align',
    });
    expect(result.guides.horizontal[0]).toMatchObject({
      coordinate: 100,
      start: 100,
      end: 300,
      targetNodeId: 'target',
      relation: 'align',
    });
  });

  it('supports horizontal and vertical edge adjacency', () => {
    const target = makeNode('target', 100, 100, 200, 100);
    const dragged = makeNode('dragged', 0, 0, 80, 60);
    const result = computeSnapAlign(dragged, { x: 304, y: 204 }, [target]);

    expect(result.position).toEqual({ x: 300, y: 200 });
    expect(result.guides.vertical[0].relation).toBe('adjacent');
    expect(result.guides.horizontal[0].relation).toBe('adjacent');
  });

  it('does not snap invalid edge-to-center combinations', () => {
    const target = makeNode('target', 100, 100, 200, 100);
    const dragged = makeNode('dragged', 0, 0, 50, 50);
    const proposed = { x: 195, y: 500 };
    const result = computeSnapAlign(dragged, proposed, [target]);

    expect(result.position).toEqual(proposed);
    expect(result.guides.vertical).toHaveLength(0);
    expect(result.guides.horizontal).toHaveLength(0);
  });

  it('keeps the interaction threshold constant in screen pixels across zoom levels', () => {
    const target = makeNode('target', 0, 300, 100, 100);
    const dragged = makeNode('dragged', 500, 0, 100, 100);
    const proposed = { x: 10, y: 0 };

    const zoomedOut = computeSnapAlign(dragged, proposed, [target], {
      threshold: SNAP_ALIGN_SCREEN_THRESHOLD / 0.5,
    });
    const zoomedIn = computeSnapAlign(dragged, proposed, [target], {
      threshold: SNAP_ALIGN_SCREEN_THRESHOLD / 2,
    });

    expect(zoomedOut.position.x).toBe(0);
    expect(zoomedIn.position.x).toBe(10);
  });

  it('retains an active snap until the wider release threshold is crossed', () => {
    const target = makeNode('target', 0, 300, 100, 100);
    const dragged = makeNode('dragged', 500, 0, 100, 100);
    const engaged = computeSnapAlign(dragged, { x: 6, y: 0 }, [target]);
    const retained = computeSnapAlign(dragged, { x: 10, y: 0 }, [target], {
      threshold: SNAP_ALIGN_SCREEN_THRESHOLD,
      releaseThreshold: SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD,
      locks: engaged.locks,
    });
    const released = computeSnapAlign(dragged, { x: 13, y: 0 }, [target], {
      threshold: SNAP_ALIGN_SCREEN_THRESHOLD,
      releaseThreshold: SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD,
      locks: retained.locks,
    });

    expect(engaged.position.x).toBe(0);
    expect(retained.position.x).toBe(0);
    expect(released.position.x).toBe(13);
    expect(released.locks.x).toBeNull();
  });

});
