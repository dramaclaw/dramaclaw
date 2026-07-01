import { type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { type StoryConditionExpr, type StoryVariable } from './storyTypes';
import { resolveStartNodeId } from './resolveStart';
import { lintStory, type StoryIssueCode } from './lintStory';

/** 一行剧情树节点(只读派生)。 */
export interface StoryTreeRow {
  nodeId: string;
  label: string;
  depth: number;
  /** 进入此节点的选项文案;根为 null。 */
  incomingChoiceText: string | null;
  /** 进入此节点的选项带条件。 */
  hasCondition: boolean;
  /** 此节点作为选项源带限时(choiceTimeLimitSec > 0)。 */
  isTimedSource: boolean;
  /** 叶子(无出向选项)= 结局。 */
  isEnding: boolean;
  endingLabel?: string;
  endingTitle?: string;
  /** DAG 汇合:已在别处展开过,这里是 ↩ 叶子,children 空。 */
  repeated: boolean;
  issues: StoryIssueCode[];
  children: StoryTreeRow[];
}

export interface StoryTreeOrphan {
  nodeId: string;
  label: string;
  issues: StoryIssueCode[];
}

export interface StoryTreeModel {
  root: StoryTreeRow | null;
  /** 无唯一起点(无 start 或多 start)。 */
  noStart: boolean;
  /** 从根访问不到的成员(按 label 稳定排序)。 */
  orphans: StoryTreeOrphan[];
  errorCount: number;
  warningCount: number;
}

function nodeLabel(node: CanvasNode): string {
  return (node.data as { displayName?: string }).displayName?.trim() || node.id;
}

/** 从故事组成员 + 选项边派生剧情树模型(只读)。 */
export function buildStoryTree(
  members: CanvasNode[],
  storyEdges: CanvasEdge[],
  variables: StoryVariable[],
): StoryTreeModel {
  const byId = new Map(members.map((n) => [n.id, n] as const));
  const memberIds = new Set(byId.keys());

  interface Choice { target: string; choiceText: string; order: number; hasCondition: boolean; }
  const choicesBySource = new Map<string, Choice[]>();
  const choiceSources = new Set<string>();
  const choiceTargets = new Set<string>();
  for (const e of storyEdges) {
    if (!memberIds.has(e.source)) continue;
    const data = e.data as { choiceText?: string; order?: number; condition?: StoryConditionExpr } | undefined;
    choiceSources.add(e.source);
    if (memberIds.has(e.target)) choiceTargets.add(e.target);
    const list = choicesBySource.get(e.source) ?? [];
    list.push({
      target: e.target,
      choiceText: typeof data?.choiceText === 'string' ? data.choiceText : '',
      order: Number.isFinite(data?.order) ? Number(data?.order) : 0,
      hasCondition: data?.condition != null,
    });
    choicesBySource.set(e.source, list);
  }
  for (const list of choicesBySource.values()) list.sort((a, b) => a.order - b.order);

  // lint → 按节点聚合 issue 码 + 计数
  const issuesByNode = new Map<string, StoryIssueCode[]>();
  let errorCount = 0;
  let warningCount = 0;
  const pushIssue = (id: string, code: StoryIssueCode) => {
    const arr = issuesByNode.get(id) ?? [];
    arr.push(code);
    issuesByNode.set(id, arr);
  };
  for (const it of lintStory(members, storyEdges, variables)) {
    if (it.severity === 'error') errorCount++;
    else warningCount++;
    if (it.nodeId) pushIssue(it.nodeId, it.code);
    else if (it.edgeId) {
      const e = storyEdges.find((x) => x.id === it.edgeId);
      if (e) pushIssue(memberIds.has(e.target) ? e.target : e.source, it.code);
    }
  }

  const visited = new Set<string>();
  function build(id: string, depth: number, incomingChoiceText: string | null, hasCondition: boolean): StoryTreeRow {
    const node = byId.get(id)!;
    const data = node.data as { choiceTimeLimitSec?: number; narration?: string; endingLabel?: string };
    const childChoices = choicesBySource.get(id) ?? [];
    // 有意为之:childChoices 含组外目标(悬空)的选项,故「只有悬空边」的节点不算结局
    // (它有选项,只是 dangling,由 lint 报 dangling_edge)。结局 = 完全无出向选项。
    const isEnding = childChoices.length === 0;
    const isTimedSource = typeof data.choiceTimeLimitSec === 'number' && data.choiceTimeLimitSec > 0;
    const base: StoryTreeRow = {
      nodeId: id, label: nodeLabel(node), depth, incomingChoiceText, hasCondition,
      isTimedSource, isEnding,
      ...(data.endingLabel ? { endingLabel: data.endingLabel } : {}),
      ...(data.narration ? { endingTitle: data.narration } : {}),
      repeated: false, issues: issuesByNode.get(id) ?? [], children: [],
    };
    if (visited.has(id)) return { ...base, repeated: true };
    visited.add(id);
    const children: StoryTreeRow[] = [];
    for (const c of childChoices) {
      if (!memberIds.has(c.target)) continue; // 组外目标(dangling)不产行,问题已由 lint 贴到本节点
      children.push(build(c.target, depth + 1, c.choiceText, c.hasCondition));
    }
    return { ...base, children };
  }

  const start = resolveStartNodeId(members, choiceSources, choiceTargets);
  const noStart = !start.startId || start.reason === 'multiple_start';
  const root = !noStart && start.startId && byId.has(start.startId) ? build(start.startId, 0, null, false) : null;

  const orphans: StoryTreeOrphan[] = members
    .filter((n) => !visited.has(n.id))
    .map((n) => ({ nodeId: n.id, label: nodeLabel(n), issues: issuesByNode.get(n.id) ?? [] }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { root, noStart, orphans, errorCount, warningCount };
}
