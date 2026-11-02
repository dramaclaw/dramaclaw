import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

export type StartResolveReason = 'ok' | 'none' | 'multiple_start' | 'ambiguous_root';

export interface StartResolution {
  /** 解析出的起点节点 id;无法唯一确定时为 null。 */
  startId: string | null;
  reason: StartResolveReason;
}

/**
 * 解析故事起点(不抛错版,compile 与 lint 共用)。
 * - 显式 `storyRole==='start'`:恰好一个 → ok;多个 → 取第一个 + reason='multiple_start'。
 * - 无显式:推断「树根」(有出边、无入边的唯一节点)→ ok;0 个 → 'none';多个 → 'ambiguous_root'。
 *
 * `choiceSources` / `choiceTargets` 为选项边的源/目标 id 集合(调用方按需构建)。
 */
export function resolveStartNodeId(
  videoNodes: CanvasNode[],
  choiceSources: Set<string>,
  choiceTargets: Set<string>,
): StartResolution {
  const explicit = videoNodes.filter(
    (node) => (node.data as { storyRole?: string }).storyRole === 'start',
  );
  if (explicit.length === 1) return { startId: explicit[0].id, reason: 'ok' };
  if (explicit.length > 1) return { startId: explicit[0].id, reason: 'multiple_start' };

  const roots = videoNodes.filter(
    (node) => choiceSources.has(node.id) && !choiceTargets.has(node.id),
  );
  if (roots.length === 1) return { startId: roots[0].id, reason: 'ok' };
  return { startId: null, reason: roots.length === 0 ? 'none' : 'ambiguous_root' };
}
