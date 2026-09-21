// SPDX-License-Identifier: Elastic-2.0
// Pure FMV shot-continuity helpers. Lives in the domain layer so canvasStore can
// apply switch-time cleanup without importing the application-layer videoContinuity
// module (which imports the store itself and would form a cycle).
import {
  CANVAS_NODE_TYPES,
  STORY_CHOICE_EDGE_TYPE,
  type CanvasEdge,
  type CanvasNode,
} from './canvasNodes';

/** Internal prompt marker injected at generation time by auto continuity (UI 名称：自动承接). */
export const FMV_CONTINUITY_NOTE = /\n?\[FMV自动承接\][\s\S]*?\[\/FMV自动承接\]/g;

export const WORKFLOW_CONTINUITY_TAIL_FRAME = 'workflow_continuity_tail_frame';

export function withoutFmvContinuityNote(prompt: unknown): string {
  return String(prompt || '').replace(FMV_CONTINUITY_NOTE, '').trim();
}

/** Edges that the auto-continuity pipeline owns; manual references use other kinds. */
export function isWorkflowContinuityTailFrameEdge(edge: CanvasEdge): boolean {
  const data = edge.data;
  return (
    typeof data === 'object'
    && data !== null
    && !Array.isArray(data)
    && (data as { edgeKind?: unknown }).edgeKind === WORKFLOW_CONTINUITY_TAIL_FRAME
  );
}

/** Story clips use FMV continuity; dependency-only workflow nodes keep their original path. */
export function isFmvVideoNode(node: CanvasNode, edges: CanvasEdge[]): boolean {
  return node.type === CANVAS_NODE_TYPES.video && (
    Boolean(node.data.storySegmentId) ||
    node.data.storyRole === 'start' ||
    edges.some((edge) => edge.type === STORY_CHOICE_EDGE_TYPE &&
      (edge.source === node.id || edge.target === node.id))
  );
}

/**
 * Switching a story clip to 「独立开场」 takes effect immediately: drop the
 * automatically bound tail-frame references and strip the generated
 * [FMV自动承接] prompt block, instead of waiting for the next generation run.
 * Manual references and the captured frame node itself are preserved.
 */
export function fmvIndependentCleanup(
  node: CanvasNode,
  previousMode: unknown,
  nextMode: unknown,
  edges: CanvasEdge[],
): boolean {
  return nextMode === 'independent'
    && previousMode !== 'independent'
    && isFmvVideoNode(node, edges);
}
