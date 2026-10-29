import { CANVAS_NODE_TYPES, isStoryGroupNode, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import { isExecutionDependencyEdge } from '../nodes/referenceOrdering';
import { STORY_CHOICE_EDGE_TYPE } from './storyTypes';

/** 派生标记：参考线常显但减弱，避免“取消选中就突然消失”的怪异感。 */
export function isReferenceDimmedEdge(edge: CanvasEdge): boolean {
  const data = edge.data;
  return (
    typeof data === 'object'
    && data !== null
    && (data as { referenceDimmed?: unknown }).referenceDimmed === true
  );
}

/** 仅派生渲染状态（dimmed／hidden 标记），不修改真实连线或持久化引用关系。 */
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
    // 本来就隐藏的边（全局折叠等）不参与派生，也不被强行显示。
    if (edge.hidden) return edge;
    if (hideAll) {
      changed = true;
      return { ...edge, hidden: true };
    }
    // Shared character/scene assets often feed many story clips. Expanding every use when the
    // asset itself is selected creates a fan of duplicate-looking lines, so unselected
    // references stay visible but dimmed; the selected target clip reveals them normally.
    const storyReference = clips.has(edge.target)
      && edge.type !== STORY_CHOICE_EDGE_TYPE
      && !isExecutionDependencyEdge(edge);
    const dimmed = storyReference && !selected.has(edge.target);
    if (dimmed === isReferenceDimmedEdge(edge)) return edge;
    changed = true;
    return { ...edge, data: { ...edge.data, referenceDimmed: dimmed } };
  });
  return changed ? rendered : edges;
}
