import { type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryConditionExpr, type StoryVariable } from './storyTypes';
import { conditionLeaves, isVisitCondition } from './conditionExpr';
import { resolveStartNodeId } from './resolveStart';

export type StoryIssueSeverity = 'error' | 'warning' | 'info';
export type StoryIssueCode =
  | 'no_start'
  | 'unreachable'
  | 'missing_video'
  | 'undefined_variable'
  | 'dangling_edge'
  | 'dangling_visit'
  | 'leaf_no_ending'
  | 'needs_review';

export interface StoryIssue {
  severity: StoryIssueSeverity;
  code: StoryIssueCode;
  /** 关联节点(节点类问题)。 */
  nodeId?: string;
  /** 关联边(边类问题);点击定位时聚焦其源节点。 */
  edgeId?: string;
  /** 补充上下文(如变量名),拼进 i18n 文案。 */
  detail?: string;
}

const SEVERITY_RANK: Record<StoryIssueSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * 校验一个故事组。
 * - `members`:组内视频节点。
 * - `edges`:源在 members 内的选项边(含目标在组外的悬空边,供 dangling 检测)。
 * - `variables`:组变量。
 * 返回按 error → warning → info 稳定排序的问题列表。
 */
export function lintStory(
  members: CanvasNode[],
  edges: CanvasEdge[],
  variables: StoryVariable[],
): StoryIssue[] {
  const issues: StoryIssue[] = [];
  const memberIds = new Set(members.map((n) => n.id));
  const varNames = new Set(variables.map((v) => v.name));

  const storyEdges = edges.filter(
    (e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source),
  );

  // 选项边的源/目标集合(目标仅计组内,供起点推断 + 可达性)。
  const choiceSources = new Set<string>();
  const choiceTargets = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const sourcesWithOut = new Set<string>();
  for (const e of storyEdges) {
    choiceSources.add(e.source);
    sourcesWithOut.add(e.source);
    if (memberIds.has(e.target)) {
      choiceTargets.add(e.target);
      const list = outgoing.get(e.source) ?? [];
      list.push(e.target);
      outgoing.set(e.source, list);
    }
  }

  // 1) 起点
  const { startId, reason } = resolveStartNodeId(members, choiceSources, choiceTargets);
  if (!startId || reason === 'multiple_start') {
    issues.push({ severity: 'error', code: 'no_start' });
  }

  // 2) 不可达(有可用起点时)
  if (startId) {
    const reached = new Set<string>();
    const queue = [startId];
    while (queue.length) {
      const id = queue.shift()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const t of outgoing.get(id) ?? []) queue.push(t);
    }
    for (const n of members) {
      if (!reached.has(n.id)) {
        issues.push({ severity: 'warning', code: 'unreachable', nodeId: n.id });
      }
    }
  }

  // 3) 缺视频
  for (const n of members) {
    if (!(n.data as { videoUrl?: string | null }).videoUrl) {
      issues.push({ severity: 'warning', code: 'missing_video', nodeId: n.id });
    }
  }

  // 4/5/needs_review(边):未定义变量、悬空边、导入打标
  for (const e of storyEdges) {
    const data = e.data as
      | { condition?: StoryConditionExpr; effects?: { var?: string }[]; needsReview?: boolean }
      | undefined;
    const refVars: string[] = [];
    for (const leaf of conditionLeaves(data?.condition)) {
      if (isVisitCondition(leaf)) {
        if (!memberIds.has(leaf.visitedNodeId)) {
          issues.push({ severity: 'error', code: 'dangling_visit', edgeId: e.id });
        }
      } else if (leaf.var) {
        refVars.push(leaf.var);
      }
    }
    for (const eff of data?.effects ?? []) if (eff?.var) refVars.push(eff.var);
    for (const v of refVars) {
      if (!varNames.has(v)) {
        issues.push({ severity: 'error', code: 'undefined_variable', edgeId: e.id, detail: v });
      }
    }
    if (!memberIds.has(e.target)) {
      issues.push({ severity: 'error', code: 'dangling_edge', edgeId: e.id });
    }
    if (data?.needsReview) {
      issues.push({ severity: 'info', code: 'needs_review', edgeId: e.id });
    }
  }

  // 6) 叶子无结局标
  for (const n of members) {
    if (sourcesWithOut.has(n.id)) continue; // 有出边 = 非叶子
    if (!(n.data as { endingLabel?: string }).endingLabel) {
      issues.push({ severity: 'info', code: 'leaf_no_ending', nodeId: n.id });
    }
  }

  // 7) needs_review(节点)
  for (const n of members) {
    if ((n.data as { importNeedsReview?: boolean }).importNeedsReview) {
      issues.push({ severity: 'info', code: 'needs_review', nodeId: n.id });
    }
  }

  return issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}
