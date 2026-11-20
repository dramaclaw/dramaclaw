// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Node and edge change reducers with the flow renderer's semantics, written here so
 * the canvas store does not load the renderer (and React with it) to apply them.
 * `graph-changes.test.ts` checks them against the renderer's own reducers.
 */
import type { Connection, Edge, EdgeChange, Node, NodeChange } from '@xyflow/react';

type GraphChange<T> = NodeChange<T & Node> | EdgeChange<T & Edge>;

type MutableElement = {
  selected?: boolean;
  position?: unknown;
  dragging?: boolean;
  measured?: unknown;
  width?: number;
  height?: number;
  resizing?: boolean;
};

function applyChange(change: GraphChange<unknown>, element: MutableElement): void {
  switch (change.type) {
    case 'select':
      element.selected = change.selected;
      break;
    case 'position':
      if (typeof change.position !== 'undefined') element.position = change.position;
      if (typeof change.dragging !== 'undefined') element.dragging = change.dragging;
      break;
    case 'dimensions':
      if (typeof change.dimensions !== 'undefined') {
        element.measured = { ...change.dimensions };
        if (change.setAttributes === true || change.setAttributes === 'width') {
          element.width = change.dimensions.width;
        }
        if (change.setAttributes === true || change.setAttributes === 'height') {
          element.height = change.dimensions.height;
        }
      }
      if (typeof change.resizing === 'boolean') element.resizing = change.resizing;
      break;
  }
}

function applyChanges<T extends { id: string }>(
  changes: readonly GraphChange<T>[],
  elements: readonly T[],
): T[] {
  const byId = new Map<string, GraphChange<T>[]>();
  const additions: Extract<GraphChange<T>, { type: 'add' }>[] = [];
  for (const change of changes) {
    if (change.type === 'add') {
      additions.push(change);
    } else if (change.type === 'remove' || change.type === 'replace') {
      // Removal or replacement makes any other change to that element moot.
      byId.set(change.id, [change]);
    } else {
      const queued = byId.get(change.id);
      if (queued) queued.push(change);
      else byId.set(change.id, [change]);
    }
  }

  const updated: T[] = [];
  for (const element of elements) {
    const queued = byId.get(element.id);
    if (!queued) {
      updated.push(element);
      continue;
    }
    const [first] = queued;
    if (first.type === 'remove') continue;
    if (first.type === 'replace') {
      updated.push({ ...first.item });
      continue;
    }
    const copy = { ...element };
    for (const change of queued) applyChange(change, copy as MutableElement);
    updated.push(copy);
  }

  // Additions go in last so their indexes refer to the updated list.
  for (const addition of additions) {
    if (addition.index !== undefined) updated.splice(addition.index, 0, { ...addition.item });
    else updated.push({ ...addition.item });
  }
  return updated;
}

export function applyNodeChanges<N extends Node>(changes: NodeChange<N>[], nodes: N[]): N[] {
  return applyChanges<N>(changes as GraphChange<N>[], nodes);
}

export function applyEdgeChanges<E extends Edge>(changes: EdgeChange<E>[], edges: E[]): E[] {
  return applyChanges<E>(changes as GraphChange<E>[], edges);
}

function sameHandle(a: string | null | undefined, b: string | null | undefined): boolean {
  return a === b || (!a && !b);
}

/**
 * Appends the edge unless one already joins the same handles of the same nodes.
 * Connections without an id get the renderer's default id.
 */
export function addEdge<E extends Edge>(params: E | Connection, edges: E[]): E[] {
  if (!params.source || !params.target) return edges;
  const edge: Partial<Edge> & Pick<Edge, 'id' | 'source' | 'target'> =
    'id' in params
      ? { ...params }
      : {
          ...params,
          id: `xy-edge__${params.source}${params.sourceHandle || ''}-${params.target}${
            params.targetHandle || ''
          }`,
        };
  const exists = edges.some(
    (existing) =>
      existing.source === edge.source &&
      existing.target === edge.target &&
      sameHandle(existing.sourceHandle, edge.sourceHandle) &&
      sameHandle(existing.targetHandle, edge.targetHandle),
  );
  if (exists) return edges;
  if (edge.sourceHandle === null) delete edge.sourceHandle;
  if (edge.targetHandle === null) delete edge.targetHandle;
  return edges.concat(edge as E);
}
