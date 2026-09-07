import { type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE, type StoryConditionExpr, type StoryFlag, type StoryVariable } from './storyTypes';
import { conditionLeaves, isFlagCondition, isVisitCondition } from './conditionExpr';
import { resolveStartNodeId } from './resolveStart';
import { analyzeStoryPaths, type StoryPathFindingCode } from './pathAnalysis';

export type StoryIssueSeverity = 'error' | 'warning' | 'info';
export type StoryIssueCode =
  | 'no_start'
  | 'unreachable'
  | 'missing_video'
  | 'undefined_variable'
  | 'undefined_flag'
  | 'dangling_edge'
  | 'dangling_visit'
  | 'leaf_no_ending'
  | 'needs_review'
  | 'automatic_no_fallback'
  | 'automatic_fallback_order'
  | StoryPathFindingCode;

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
  flags: StoryFlag[] = [],
): StoryIssue[] {
  const issues: StoryIssue[] = [];
  const memberIds = new Set(members.map((n) => n.id));
  const varNames = new Set(variables.map((v) => v.name));
  const flagNames = new Set(flags.map((v) => v.name));

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
      | { condition?: StoryConditionExpr; effects?: ({ var?: string } | { flag?: string })[]; needsReview?: boolean }
      | undefined;
    const refVars: string[] = [];
    for (const leaf of conditionLeaves(data?.condition)) {
      if (isVisitCondition(leaf)) {
        if (!memberIds.has(leaf.visitedNodeId)) {
          issues.push({ severity: 'error', code: 'dangling_visit', edgeId: e.id });
        }
      } else if (isFlagCondition(leaf)) {
        if (!flagNames.has(leaf.flag)) issues.push({ severity: 'error', code: 'undefined_flag', edgeId: e.id, detail: leaf.flag });
      } else if (leaf.var) {
        refVars.push(leaf.var);
      }
    }
    for (const eff of data?.effects ?? []) {
      if ('var' in eff && eff.var) refVars.push(eff.var);
      if ('flag' in eff && eff.flag && !flagNames.has(eff.flag)) {
        issues.push({ severity: 'error', code: 'undefined_flag', edgeId: e.id, detail: eff.flag });
      }
    }
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

  // 5) 自动分支必须有可解释的兜底；无条件分支按 order 排在最后，避免遮住后续规则。
  for (const source of choiceSources) {
    const sourceEdges = storyEdges
      .filter((edge) => edge.source === source)
      .sort((a, b) => Number((a.data as { order?: number } | undefined)?.order ?? 0) - Number((b.data as { order?: number } | undefined)?.order ?? 0));
    const automatic = sourceEdges.filter((edge) => (edge.data as { transitionMode?: string } | undefined)?.transitionMode === 'automatic');
    if (automatic.length === 0) continue;
    const fallbackIndexes = automatic
      .map((edge, index) => ({ edge, index }))
      .filter(({ edge }) => !(edge.data as { condition?: unknown } | undefined)?.condition);
    const visibleCount = sourceEdges.length - automatic.length;
    if (fallbackIndexes.length === 0 && visibleCount === 0) {
      issues.push({ severity: 'warning', code: 'automatic_no_fallback', nodeId: source });
    }
    for (const { edge, index } of fallbackIndexes) {
      if (index !== automatic.length - 1 || fallbackIndexes.length > 1 || visibleCount > 0) {
        issues.push({ severity: 'error', code: 'automatic_fallback_order', edgeId: edge.id });
      }
    }
  }

  const blocksPathAnalysis = issues.some((issue) =>
    ['no_start', 'undefined_variable', 'undefined_flag', 'dangling_edge', 'dangling_visit'].includes(issue.code),
  );
  if (startId && !blocksPathAnalysis) {
    const validStoryEdges = storyEdges.filter((edge) => memberIds.has(edge.target));
    for (const finding of analyzeStoryPaths(memberIds, validStoryEdges, startId, variables, flags)) {
      issues.push({
        severity: finding.code === 'automatic_cycle' || finding.code === 'variable_out_of_bounds' ? 'error' : 'warning',
        ...finding,
      });
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
