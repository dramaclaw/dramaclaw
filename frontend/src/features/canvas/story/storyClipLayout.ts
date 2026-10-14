// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  isStoryGroupNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 故事片段是「媒体 + 剧情信息」的复合卡片，整张卡不应跟着视频横竖比变形。
 * 视频在左栏内 object-contain，右栏始终保留给剧情与制作备注。
 */
export const STORY_CLIP_NODE_WIDTH = 680;
export const STORY_CLIP_NODE_HEIGHT = 380;
export const STORY_CLIP_MIN_WIDTH = 580;
export const STORY_CLIP_MIN_HEIGHT = 324;
export const STORY_CLIP_DETAILS_WIDTH_PERCENT = 40;

/**
 * 底部快捷「+」没有画布落点，只能根据当前选中上下文判断归属。
 * 单故事组画布可无歧义兜底；多故事组且未选中时返回 null，避免把片段加错组。
 */
export function resolveStoryGroupForNewVideo(
  nodes: CanvasNode[],
  selectedNodeId: string | null,
): string | null {
  const selected = selectedNodeId
    ? nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  if (isStoryGroupNode(selected)) return selected.id;

  if (selected?.type === CANVAS_NODE_TYPES.video && selected.parentId) {
    const parent = nodes.find((node) => node.id === selected.parentId);
    if (isStoryGroupNode(parent)) return parent.id;
  }

  // 已经有一个明确的普通节点选中上下文时，尊重它，不用「单故事组」兜底抢走新视频。
  if (selected) return null;

  const storyGroups = nodes.filter(isStoryGroupNode);
  return storyGroups.length === 1 ? storyGroups[0].id : null;
}

/** 同一故事组中的两个视频节点相连时，连线语义才是剧情选项。 */
export function resolveStoryGroupForChoiceConnection(
  nodes: CanvasNode[],
  sourceId: string,
  targetId: string,
): string | null {
  if (sourceId === targetId) return null;
  const source = nodes.find((node) => node.id === sourceId);
  const target = nodes.find((node) => node.id === targetId);
  if (
    source?.type !== CANVAS_NODE_TYPES.video
    || target?.type !== CANVAS_NODE_TYPES.video
    || !source.parentId
    || source.parentId !== target.parentId
  ) {
    return null;
  }
  return isStoryGroupNode(nodes.find((node) => node.id === source.parentId))
    ? source.parentId
    : null;
}

function nodeAbsolutePosition(
  node: CanvasNode,
  nodeById: Map<string, CanvasNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>([node.id]);
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodeById.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function nodeDimension(
  node: CanvasNode,
  dimension: 'width' | 'height',
): number {
  const measured = node.measured?.[dimension];
  if (typeof measured === 'number') return measured;
  const explicit = node[dimension];
  if (typeof explicit === 'number') return explicit;
  const styled = node.style?.[dimension];
  return typeof styled === 'number' ? styled : 0;
}

/** 画布定位式新增视频时，根据落点找到应接收它的故事组。 */
export function resolveStoryGroupAtCanvasPoint(
  nodes: CanvasNode[],
  point: { x: number; y: number },
): string | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const matches = nodes
    .filter(isStoryGroupNode)
    .map((group) => {
      const position = nodeAbsolutePosition(group, nodeById);
      const width = nodeDimension(group, 'width');
      const height = nodeDimension(group, 'height');
      return { group, position, width, height, area: width * height };
    })
    .filter(({ position, width, height }) =>
      width > 0
      && height > 0
      && point.x >= position.x
      && point.x <= position.x + width
      && point.y >= position.y
      && point.y <= position.y + height,
    )
    .sort((left, right) => left.area - right.area);
  return matches[0]?.group.id ?? null;
}

/** 把画布绝对落点换成故事组内的节点左上角坐标。 */
export function storySegmentPositionInGroup(
  nodes: CanvasNode[],
  groupId: string,
  center: { x: number; y: number },
): { x: number; y: number } | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const group = nodeById.get(groupId);
  if (!isStoryGroupNode(group)) return null;
  const groupPosition = nodeAbsolutePosition(group, nodeById);
  return {
    x: Math.max(20, center.x - groupPosition.x - STORY_CLIP_NODE_WIDTH / 2),
    y: Math.max(34, center.y - groupPosition.y - STORY_CLIP_NODE_HEIGHT / 2),
  };
}
