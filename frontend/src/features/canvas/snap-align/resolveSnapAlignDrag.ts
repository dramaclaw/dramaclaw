// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { NodeChange } from '@xyflow/react';

import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

import {
  buildSnapAlignIndex,
  computeSnapAlignFromIndex,
  SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD,
  SNAP_ALIGN_SCREEN_THRESHOLD,
  type SnapAlignIndex,
  type SnapAlignLocks,
} from './computeSnapAlign';
import type { SnapAlignGuides } from './snapAlignStore';

type Position = { x: number; y: number };

export interface SnapAlignDragSession {
  nodeId: string;
  index: SnapAlignIndex;
  locks: SnapAlignLocks;
  positionOffset: Position;
}

interface CreateSnapAlignDragSessionOptions {
  nodes: CanvasNode[];
  draggedNode: CanvasNode;
  linkedPartnerIds?: Iterable<string>;
  getAbsolutePosition: (node: CanvasNode) => Position;
}

interface ResolveSnapAlignDragMoveOptions {
  draggedNode: CanvasNode;
  proposedPosition: Position;
  session: SnapAlignDragSession;
  zoom: number;
}

export interface SnapAlignDragMoveResult {
  position: Position;
  guides: SnapAlignGuides;
  session: SnapAlignDragSession;
}

export type SnapAlignPositionChange = Extract<
  NodeChange<CanvasNode>,
  { type: 'position' }
> & {
  position: Position;
  dragging: boolean;
};

/**
 * 拖动中的位置帧始终参与吸附；松手帧仅在已有同节点会话时参与，防止 React Flow
 * 用原始指针坐标覆盖刚刚写入的吸附坐标。
 */
export function isSnapAlignPositionChange(
  change: NodeChange<CanvasNode>,
  activeNodeId?: string,
): change is SnapAlignPositionChange {
  if (change.type !== 'position' || !change.position) return false;
  if (change.dragging === true) return true;
  return change.dragging === false && change.id === activeNodeId;
}

/**
 * 构建一次拖动会话。分组本身也是可见画布对象，应参与吸附；只排除被拖对象、
 * 联动对象及其上下级，避免节点吸附到自身容器或自己的子节点。
 */
export function createSnapAlignDragSession({
  nodes,
  draggedNode,
  linkedPartnerIds = [],
  getAbsolutePosition,
}: CreateSnapAlignDragSessionOptions): SnapAlignDragSession {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const childIds = childrenByParent.get(node.parentId) ?? [];
    childIds.push(node.id);
    childrenByParent.set(node.parentId, childIds);
  }

  const seeds = [draggedNode.id, ...linkedPartnerIds];
  const excludedNodeIds = new Set(seeds);
  const descendantQueue = [...seeds];
  while (descendantQueue.length > 0) {
    const parentId = descendantQueue.pop();
    if (!parentId) continue;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (excludedNodeIds.has(childId)) continue;
      excludedNodeIds.add(childId);
      descendantQueue.push(childId);
    }
  }

  for (const seedId of seeds) {
    let ancestorId = nodeById.get(seedId)?.parentId;
    while (ancestorId) {
      if (excludedNodeIds.has(ancestorId)) break;
      excludedNodeIds.add(ancestorId);
      ancestorId = nodeById.get(ancestorId)?.parentId;
    }
  }

  const absoluteCandidates = nodes
    .filter((node) => !excludedNodeIds.has(node.id) && !node.hidden)
    .map((node) => ({ ...node, position: getAbsolutePosition(node) }));
  const draggedAbsolutePosition = getAbsolutePosition(draggedNode);

  return {
    nodeId: draggedNode.id,
    index: buildSnapAlignIndex(absoluteCandidates),
    locks: { x: null, y: null },
    positionOffset: {
      x: draggedAbsolutePosition.x - draggedNode.position.x,
      y: draggedAbsolutePosition.y - draggedNode.position.y,
    },
  };
}

/** 将 React Flow 的相对拖动位置转换为绝对坐标吸附，再还原为节点坐标。 */
export function resolveSnapAlignDragMove({
  draggedNode,
  proposedPosition,
  session,
  zoom,
}: ResolveSnapAlignDragMoveOptions): SnapAlignDragMoveResult {
  const safeZoom = Math.max(zoom, 0.01);
  const proposedAbsolutePosition = {
    x: proposedPosition.x + session.positionOffset.x,
    y: proposedPosition.y + session.positionOffset.y,
  };
  const snap = computeSnapAlignFromIndex(
    { ...draggedNode, position: proposedAbsolutePosition },
    proposedAbsolutePosition,
    session.index,
    {
      threshold: SNAP_ALIGN_SCREEN_THRESHOLD / safeZoom,
      releaseThreshold: SNAP_ALIGN_SCREEN_RELEASE_THRESHOLD / safeZoom,
      locks: session.locks,
    },
  );

  return {
    position: {
      x: snap.position.x - session.positionOffset.x,
      y: snap.position.y - session.positionOffset.y,
    },
    guides: snap.guides,
    session: { ...session, locks: snap.locks },
  };
}
