// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

import type { SnapAlignGuideSegment, SnapAlignGuides } from './snapAlignStore';

interface Bbox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

type XEdge = 'left' | 'centerX' | 'right';
type YEdge = 'top' | 'centerY' | 'bottom';
type SnapEdge = XEdge | YEdge;
type SnapRelation = 'align' | 'adjacent';

interface IndexedAnchor<E extends SnapEdge> {
  nodeId: string;
  edge: E;
  coordinate: number;
  rangeStart: number;
  rangeEnd: number;
}

interface AxisMatch<E extends SnapEdge> {
  draggedEdge: E;
  target: IndexedAnchor<E>;
  relation: SnapRelation;
  delta: number;
}

export interface SnapAxisLock<E extends SnapEdge = SnapEdge> {
  draggedEdge: E;
  target: IndexedAnchor<E>;
  relation: SnapRelation;
}

export interface SnapAlignLocks {
  x: SnapAxisLock<XEdge> | null;
  y: SnapAxisLock<YEdge> | null;
}

export interface SnapAlignIndex {
  x: Record<XEdge, IndexedAnchor<XEdge>[]>;
  y: Record<YEdge, IndexedAnchor<YEdge>[]>;
}

export interface SnapAlignOptions {
  /** Flow 坐标阈值；画布调用方应使用 screenPx / zoom 换算。 */
  threshold?: number;
  /** 已吸附后允许离开得更远一点，避免临界点来回跳动。 */
  releaseThreshold?: number;
  locks?: SnapAlignLocks;
}

export interface SnapAlignResult {
  position: { x: number; y: number };
  guides: SnapAlignGuides;
  locks: SnapAlignLocks;
}

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 100;
export const SNAP_ALIGN_SCREEN_THRESHOLD = 8;
export const SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD = 12;
/** 非画布调用方在 zoom=1 下的默认 Flow 阈值。 */
export const SNAP_ALIGN_FLOW_THRESHOLD = SNAP_ALIGN_SCREEN_THRESHOLD;
const EMPTY_GUIDES: SnapAlignGuides = { vertical: [], horizontal: [] };
const EMPTY_LOCKS: SnapAlignLocks = { x: null, y: null };

const X_RELATIONS: ReadonlyArray<{
  dragged: XEdge;
  target: XEdge;
  relation: SnapRelation;
  priority: number;
}> = [
  { dragged: 'left', target: 'left', relation: 'align', priority: 0 },
  { dragged: 'right', target: 'right', relation: 'align', priority: 0 },
  { dragged: 'centerX', target: 'centerX', relation: 'align', priority: 1 },
  { dragged: 'left', target: 'right', relation: 'adjacent', priority: 2 },
  { dragged: 'right', target: 'left', relation: 'adjacent', priority: 2 },
];

const Y_RELATIONS: ReadonlyArray<{
  dragged: YEdge;
  target: YEdge;
  relation: SnapRelation;
  priority: number;
}> = [
  { dragged: 'top', target: 'top', relation: 'align', priority: 0 },
  { dragged: 'bottom', target: 'bottom', relation: 'align', priority: 0 },
  { dragged: 'centerY', target: 'centerY', relation: 'align', priority: 1 },
  { dragged: 'top', target: 'bottom', relation: 'adjacent', priority: 2 },
  { dragged: 'bottom', target: 'top', relation: 'adjacent', priority: 2 },
];

function bboxAt(node: CanvasNode, position: { x: number; y: number }): Bbox {
  const width =
    typeof node.measured?.width === 'number'
      ? node.measured.width
      : typeof node.width === 'number'
        ? node.width
        : DEFAULT_NODE_WIDTH;
  const height =
    typeof node.measured?.height === 'number'
      ? node.measured.height
      : typeof node.height === 'number'
        ? node.height
        : DEFAULT_NODE_HEIGHT;
  return {
    left: position.x,
    right: position.x + width,
    top: position.y,
    bottom: position.y + height,
    centerX: position.x + width / 2,
    centerY: position.y + height / 2,
  };
}

function edgeCoordinate(bounds: Bbox, edge: SnapEdge): number {
  return bounds[edge];
}

function lowerBound<E extends SnapEdge>(sorted: IndexedAnchor<E>[], target: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle].coordinate < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearestAnchor<E extends SnapEdge>(
  sorted: IndexedAnchor<E>[],
  target: number,
  threshold: number,
): IndexedAnchor<E> | null {
  const index = lowerBound(sorted, target);
  let best: IndexedAnchor<E> | null = null;
  for (const candidateIndex of [index - 1, index]) {
    const candidate = sorted[candidateIndex];
    if (!candidate) continue;
    const distance = Math.abs(candidate.coordinate - target);
    if (distance > threshold) continue;
    if (!best || distance < Math.abs(best.coordinate - target)) best = candidate;
  }
  return best;
}

function emptyIndex(): SnapAlignIndex {
  return {
    x: { left: [], centerX: [], right: [] },
    y: { top: [], centerY: [], bottom: [] },
  };
}

/** 输入节点的位置必须位于同一套绝对 Flow 坐标系。 */
export function buildSnapAlignIndex(otherNodes: CanvasNode[]): SnapAlignIndex {
  const index = emptyIndex();
  otherNodes.forEach((node, nodeIndex) => {
    const bounds = bboxAt(node, node.position);
    const nodeId = node.id || `snap-target-${nodeIndex}`;
    for (const edge of ['left', 'centerX', 'right'] as const) {
      index.x[edge].push({
        nodeId,
        edge,
        coordinate: bounds[edge],
        rangeStart: bounds.top,
        rangeEnd: bounds.bottom,
      });
    }
    for (const edge of ['top', 'centerY', 'bottom'] as const) {
      index.y[edge].push({
        nodeId,
        edge,
        coordinate: bounds[edge],
        rangeStart: bounds.left,
        rangeEnd: bounds.right,
      });
    }
  });
  for (const anchors of Object.values(index.x)) {
    anchors.sort((a, b) => a.coordinate - b.coordinate);
  }
  for (const anchors of Object.values(index.y)) {
    anchors.sort((a, b) => a.coordinate - b.coordinate);
  }
  return index;
}

function lockedMatch<E extends SnapEdge>(
  bounds: Bbox,
  lock: SnapAxisLock<E> | null | undefined,
  releaseThreshold: number,
): AxisMatch<E> | null {
  if (!lock) return null;
  const delta = lock.target.coordinate - edgeCoordinate(bounds, lock.draggedEdge);
  if (Math.abs(delta) > releaseThreshold) return null;
  return { ...lock, delta };
}

function chooseXMatch(
  bounds: Bbox,
  index: SnapAlignIndex,
  threshold: number,
  releaseThreshold: number,
  lock: SnapAxisLock<XEdge> | null | undefined,
): AxisMatch<XEdge> | null {
  const retained = lockedMatch(bounds, lock, releaseThreshold);
  if (retained) return retained;
  let best: (AxisMatch<XEdge> & { priority: number }) | null = null;
  for (const relation of X_RELATIONS) {
    const draggedCoordinate = edgeCoordinate(bounds, relation.dragged);
    const target = nearestAnchor(index.x[relation.target], draggedCoordinate, threshold);
    if (!target) continue;
    const match = {
      draggedEdge: relation.dragged,
      target,
      relation: relation.relation,
      priority: relation.priority,
      delta: target.coordinate - draggedCoordinate,
    };
    if (
      !best ||
      Math.abs(match.delta) < Math.abs(best.delta) ||
      (Math.abs(match.delta) === Math.abs(best.delta) && match.priority < best.priority)
    ) {
      best = match;
    }
  }
  return best;
}

function chooseYMatch(
  bounds: Bbox,
  index: SnapAlignIndex,
  threshold: number,
  releaseThreshold: number,
  lock: SnapAxisLock<YEdge> | null | undefined,
): AxisMatch<YEdge> | null {
  const retained = lockedMatch(bounds, lock, releaseThreshold);
  if (retained) return retained;
  let best: (AxisMatch<YEdge> & { priority: number }) | null = null;
  for (const relation of Y_RELATIONS) {
    const draggedCoordinate = edgeCoordinate(bounds, relation.dragged);
    const target = nearestAnchor(index.y[relation.target], draggedCoordinate, threshold);
    if (!target) continue;
    const match = {
      draggedEdge: relation.dragged,
      target,
      relation: relation.relation,
      priority: relation.priority,
      delta: target.coordinate - draggedCoordinate,
    };
    if (
      !best ||
      Math.abs(match.delta) < Math.abs(best.delta) ||
      (Math.abs(match.delta) === Math.abs(best.delta) && match.priority < best.priority)
    ) {
      best = match;
    }
  }
  return best;
}

function verticalGuide(match: AxisMatch<XEdge>, bounds: Bbox): SnapAlignGuideSegment {
  return {
    coordinate: match.target.coordinate,
    start: Math.min(bounds.top, match.target.rangeStart),
    end: Math.max(bounds.bottom, match.target.rangeEnd),
    targetNodeId: match.target.nodeId,
    relation: match.relation,
  };
}

function horizontalGuide(match: AxisMatch<YEdge>, bounds: Bbox): SnapAlignGuideSegment {
  return {
    coordinate: match.target.coordinate,
    start: Math.min(bounds.left, match.target.rangeStart),
    end: Math.max(bounds.right, match.target.rangeEnd),
    targetNodeId: match.target.nodeId,
    relation: match.relation,
  };
}

export function computeSnapAlignFromIndex(
  draggedNode: CanvasNode,
  proposedPosition: { x: number; y: number },
  index: SnapAlignIndex,
  options: SnapAlignOptions | number = {},
): SnapAlignResult {
  const normalizedOptions = typeof options === 'number' ? { threshold: options } : options;
  const threshold = normalizedOptions.threshold ?? SNAP_ALIGN_FLOW_THRESHOLD;
  const releaseThreshold = normalizedOptions.releaseThreshold ?? threshold * 1.5;
  const proposedBounds = bboxAt(draggedNode, proposedPosition);
  const xMatch = chooseXMatch(
    proposedBounds,
    index,
    threshold,
    releaseThreshold,
    normalizedOptions.locks?.x,
  );
  const yMatch = chooseYMatch(
    proposedBounds,
    index,
    threshold,
    releaseThreshold,
    normalizedOptions.locks?.y,
  );
  const position = {
    x: proposedPosition.x + (xMatch?.delta ?? 0),
    y: proposedPosition.y + (yMatch?.delta ?? 0),
  };
  const snappedBounds = bboxAt(draggedNode, position);
  const locks: SnapAlignLocks = {
    x: xMatch
      ? { draggedEdge: xMatch.draggedEdge, target: xMatch.target, relation: xMatch.relation }
      : null,
    y: yMatch
      ? { draggedEdge: yMatch.draggedEdge, target: yMatch.target, relation: yMatch.relation }
      : null,
  };
  return {
    position,
    locks,
    guides: {
      vertical: xMatch ? [verticalGuide(xMatch, snappedBounds)] : [],
      horizontal: yMatch ? [horizontalGuide(yMatch, snappedBounds)] : [],
    },
  };
}

export function computeSnapAlign(
  draggedNode: CanvasNode,
  proposedPosition: { x: number; y: number },
  otherNodes: CanvasNode[],
  options: SnapAlignOptions | number = {},
): SnapAlignResult {
  if (otherNodes.length === 0) {
    return { position: proposedPosition, guides: EMPTY_GUIDES, locks: EMPTY_LOCKS };
  }
  return computeSnapAlignFromIndex(
    draggedNode,
    proposedPosition,
    buildSnapAlignIndex(otherNodes),
    options,
  );
}
