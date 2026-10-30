import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { resolveStartNodeId } from './resolveStart';
import { STORY_CHOICE_EDGE_TYPE } from './storyTypes';

export interface StoryDurationRange {
  minMs: number;
  maxMs: number;
  complete: boolean;
}

/** Structural playable-path duration. Reachable cycles have no finite estimate. */
export function storyDurationRange(
  members: CanvasNode[],
  edges: CanvasEdge[],
): StoryDurationRange | null {
  const memberIds = new Set(members.map((node) => node.id));
  const storyEdges = edges.filter(
    (edge) => edge.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(edge.source),
  );
  const choiceSources = new Set(storyEdges.map((edge) => edge.source));
  const choiceTargets = new Set(
    storyEdges.filter((edge) => memberIds.has(edge.target)).map((edge) => edge.target),
  );
  const { startId, reason } = resolveStartNodeId(members, choiceSources, choiceTargets);
  if (!startId || reason === 'multiple_start') return null;

  const byId = new Map(members.map((node) => [node.id, node] as const));
  const bySource = new Map<string, string[]>();
  for (const edge of storyEdges) {
    if (!memberIds.has(edge.target)) continue;
    const targets = bySource.get(edge.source) ?? [];
    targets.push(edge.target);
    bySource.set(edge.source, targets);
  }

  const memo = new Map<string, StoryDurationRange>();
  const visit = (nodeId: string, stack: Set<string>): StoryDurationRange | null => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const node = byId.get(nodeId);
    const durationMs = typeof (node?.data as { durationMs?: unknown } | undefined)?.durationMs === 'number'
      ? Math.max(0, Number((node!.data as { durationMs: number }).durationMs))
      : 0;
    if (stack.has(nodeId)) return null;

    const targets = bySource.get(nodeId) ?? [];
    if (targets.length === 0) {
      const leaf = { minMs: durationMs, maxMs: durationMs, complete: durationMs > 0 };
      memo.set(nodeId, leaf);
      return leaf;
    }
    const nextStack = new Set(stack).add(nodeId);
    const children: StoryDurationRange[] = [];
    for (const target of targets) {
      const child = visit(target, nextStack);
      if (!child) return null;
      children.push(child);
    }
    const result = {
      minMs: durationMs + Math.min(...children.map((child) => child.minMs)),
      maxMs: durationMs + Math.max(...children.map((child) => child.maxMs)),
      complete: durationMs > 0 && children.every((child) => child.complete),
    };
    memo.set(nodeId, result);
    return result;
  };

  return visit(startId, new Set());
}
