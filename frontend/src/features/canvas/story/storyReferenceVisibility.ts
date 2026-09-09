import { CANVAS_NODE_TYPES, isStoryGroupNode, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import { isExecutionDependencyEdge } from '../nodes/referenceOrdering';
import { STORY_CHOICE_EDGE_TYPE } from './storyTypes';

/** 仅派生渲染状态，不修改真实连线或持久化引用关系。 */
export function storyReferenceVisibleEdges(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  hideAll = false,
): CanvasEdge[] {
  const groups = new Set(nodes.filter(isStoryGroupNode).map((node) => node.id));
  const clips = new Set(nodes.filter((node) => node.type === CANVAS_NODE_TYPES.video && node.parentId && groups.has(node.parentId)).map((node) => node.id));
  const selected = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
  let changed = false;
  const rendered = edges.map((edge) => {
    const storyReference = clips.has(edge.target)
      && edge.type !== STORY_CHOICE_EDGE_TYPE
      && !isExecutionDependencyEdge(edge);
    const hide = hideAll || (storyReference && !selected.has(edge.source) && !selected.has(edge.target));
    if (!hide || edge.hidden) return edge;
    changed = true;
    return { ...edge, hidden: true };
  });
  return changed ? rendered : edges;
}
