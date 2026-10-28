import {
  CANVAS_NODE_TYPES,
  isStoryGroupNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 该节点是否为「故事片段」:父组是故事组(storyGroup)的视频节点。
 * 用于把故事组内的视频节点渲染成「播放器形态」(隐藏画布编辑 chrome)。
 * 不给节点加持久标记,纯从父子关系派生,拖进/拖出故事组即时生效。
 */
export function isNodeStoryClip(
  nodes: CanvasNode[],
  nodeId: string | null | undefined,
): boolean {
  if (!nodeId) return false;
  const self = nodes.find((n) => n.id === nodeId);
  if (!self || self.type !== CANVAS_NODE_TYPES.video || !self.parentId) return false;
  const parent = nodes.find((n) => n.id === self.parentId);
  return isStoryGroupNode(parent);
}
