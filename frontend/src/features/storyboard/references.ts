// SPDX-License-Identifier: Elastic-2.0
import type { CanvasEdge, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { nodeHasSourceHandle, nodeHasTargetHandle, isManualConnectionAllowed } from '@/features/canvas/domain/nodeRegistry';
import type { BoardCard, MediaKind } from './projection';

/** Same node registry as workflow, narrowed to media the selected editor consumes. */
export function eligibleReferenceIds(cards: BoardCard[], edges: CanvasEdge[], target: BoardCard): Set<string> {
  const accepted: Record<MediaKind, MediaKind[]> = { text: ['text', 'image', 'video'], image: ['text', 'image'], video: ['text', 'image', 'video', 'audio'], audio: ['text'] };
  const targetType = target.node.type as CanvasNodeType;
  if (!nodeHasTargetHandle(targetType)) return new Set();
  // Any descendant would close a directed cycle if connected upstream.
  const descendants = new Set([target.id]);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  const pending = [target.id];
  while (pending.length) for (const id of outgoing.get(pending.pop()!) ?? []) {
    if (!descendants.has(id)) { descendants.add(id); pending.push(id); }
  }
  return new Set(cards.filter(c => !descendants.has(c.id) && accepted[target.kind].includes(c.kind)
    && nodeHasSourceHandle(c.node.type as CanvasNodeType)
    && isManualConnectionAllowed(c.node.type as CanvasNodeType, targetType)).map(c => c.id));
}
