// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isGroupNode, isStoryGroupNode, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { getNodeSize } from './autoLayout';

// Match the separation between independent components in autoLayout.
const GROUP_GAP = 120;

/** Find generated root groups, including groups whose ownership lives on their children. */
function generatedGroupIds(nodes: CanvasNode[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  for (const node of nodes) {
    const data = node.data as Record<string, unknown>;
    if (!data.workflowInstanceId && !data.storyAssetTarget && !data.storyFrameTarget
      && !data.preset_managed && !data.projection_key) continue;
    let root = node;
    const visited = new Set<string>([root.id]);
    while (root.parentId && !visited.has(root.parentId)) {
      const parent = byId.get(root.parentId);
      if (!parent) break;
      visited.add(parent.id);
      root = parent;
    }
    if (!root.parentId && isGroupNode(root) && root.data.storyGroup !== true) ids.add(root.id);
  }
  return ids;
}

/** Move generated groups as units; story layout and child-relative coordinates stay intact. */
export function placeGroupsOutsideStory(
  nodes: CanvasNode[],
  groupIds: ReadonlySet<string> = generatedGroupIds(nodes),
): CanvasNode[] {
  const roots = nodes.filter((node) => !node.parentId && !node.hidden);
  if (!roots.some(isStoryGroupNode)) return nodes;
  const movable = roots.filter((node) => groupIds.has(node.id) && isGroupNode(node) && node.data.storyGroup !== true);
  const movableIds = new Set(movable.map((node) => node.id));
  const rect = (node: CanvasNode) => {
    const size = getNodeSize(node);
    // Group dimensions can grow before React Flow refreshes measured.
    const width = isGroupNode(node)
      ? Math.max(size.width, node.width ?? 0, typeof node.style?.width === 'number' ? node.style.width : 0)
      : size.width;
    const height = isGroupNode(node)
      ? Math.max(size.height, node.height ?? 0, typeof node.style?.height === 'number' ? node.style.height : 0)
      : size.height;
    return { ...node.position, width, height };
  };
  const occupied = roots.filter((node) => !movableIds.has(node.id)).map(rect);
  const positions = new Map<string, { x: number; y: number }>();
  for (const group of movable) {
    const box = rect(group);
    // Each step passes at least one obstacle's right edge, so this terminates
    // even when several stories and previously placed asset groups block the row.
    while (true) {
      const collisions = occupied.filter((other) => box.x < other.x + other.width
        && box.x + box.width > other.x && box.y < other.y + other.height
        && box.y + box.height > other.y);
      if (collisions.length === 0) break;
      box.x = Math.max(...collisions.map((other) => other.x + other.width)) + GROUP_GAP;
    }
    if (box.x !== group.position.x) positions.set(group.id, { x: box.x, y: box.y });
    occupied.push(box);
  }
  return positions.size === 0 ? nodes : nodes.map((node) => {
    const position = positions.get(node.id);
    return position ? { ...node, position } : node;
  });
}
