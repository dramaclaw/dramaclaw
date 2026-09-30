// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { computeAutoLayout } from '@/features/canvas/application/autoLayout';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

const NODE_W = 320;
const NODE_H = 200;

function node(id: string, x: number, y: number): CanvasNode {
  return {
    id,
    type: 'image_gen',
    position: { x, y },
    data: {},
    measured: { width: NODE_W, height: NODE_H },
  } as unknown as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return { id: `${source}->${target}`, source, target } as CanvasEdge;
}

function centerY(pos: { x: number; y: number }): number {
  return pos.y + NODE_H / 2;
}

describe('computeAutoLayout', () => {
  it('lays a linear chain out left-to-right following edge direction', () => {
    const nodes = [node('a', 0, 0), node('b', 0, 500), node('c', 0, 50), node('d', 0, 900)];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

    const { positions } = computeAutoLayout(nodes, edges);

    // Columns advance with the edge order regardless of messy initial Y.
    expect(positions.a.x).toBeLessThan(positions.b.x);
    expect(positions.b.x).toBeLessThan(positions.c.x);
    expect(positions.c.x).toBeLessThan(positions.d.x);

    // A pure chain should align vertically (barycenter pulls every node to one row).
    const ys = [positions.a, positions.b, positions.c, positions.d].map(centerY);
    for (const y of ys) {
      expect(Math.abs(y - ys[0])).toBeLessThan(1);
    }
  });

  it('orders a layer to match parent order, avoiding crossed edges', () => {
    // Parents p1 (top) / p2 (bottom). Children seeded in the *crossed* order
    // (c1 below, c2 above) but edges are p1->c1, p2->c2.
    const nodes = [
      node('p1', 0, 0),
      node('p2', 0, 600),
      node('c1', 600, 600),
      node('c2', 600, 0),
    ];
    const edges = [edge('p1', 'c1'), edge('p2', 'c2')];

    const { positions } = computeAutoLayout(nodes, edges);

    // Child of the upper parent ends up above the child of the lower parent.
    expect(centerY(positions.c1)).toBeLessThan(centerY(positions.c2));
    // And each child sits roughly level with its own parent (aligned, not stacked from top).
    expect(Math.abs(centerY(positions.c1) - centerY(positions.p1))).toBeLessThan(NODE_H);
    expect(Math.abs(centerY(positions.c2) - centerY(positions.p2))).toBeLessThan(NODE_H);
  });

  it('returns no positions when there are no top-level nodes', () => {
    expect(computeAutoLayout([], []).positions).toEqual({});
  });

  it('uses media-card design sizes before React Flow measures new nodes', () => {
    const nodes = [
      {
        id: 'video-a',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: 'video-b',
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 100 },
        data: {},
      },
    ] as unknown as CanvasNode[];

    const { positions } = computeAutoLayout(nodes, []);
    const firstBottom = positions['video-a'].y + 380;
    const secondTop = positions['video-b'].y;

    expect(secondTop - firstBottom).toBeGreaterThanOrEqual(96);
  });

  it('terminates on a cyclic graph reachable from a root (no infinite loop)', () => {
    // R -> A -> B -> A : the longest-path leveling must not loop forever.
    const nodes = [node('R', 0, 0), node('A', 0, 100), node('B', 0, 200)];
    const edges = [edge('R', 'A'), edge('A', 'B'), edge('B', 'A')];

    const { positions } = computeAutoLayout(nodes, edges);

    // Every node still gets a finite position.
    for (const id of ['R', 'A', 'B']) {
      expect(Number.isFinite(positions[id].x)).toBe(true);
      expect(Number.isFinite(positions[id].y)).toBe(true);
    }
  });
});
