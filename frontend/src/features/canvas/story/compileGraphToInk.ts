import { isVideoNode, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { knotNameForNodeId } from './inkNames';
import { resolveStartNodeId } from './resolveStart';
import {
  STORY_CHOICE_EDGE_TYPE,
  type CompiledStory,
  type StoryChoiceEdgeData,
  type StoryConditionExpr,
  type StoryVariable,
} from './storyTypes';
import { conditionLeaves, isConditionGroup, isVisitCondition } from './conditionExpr';

/** 抛给 UI 的结构化编译错误,code 供前端选择文案。 */
export class StoryCompileError extends Error {
  constructor(
    public readonly code: 'no_start' | 'empty' | 'start_unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'StoryCompileError';
  }
}

/** 把条件(叶子或 AND/OR 组)编译成 ink guard 前缀 `{expr} `;无有效叶子 → 空串。
 *  访问叶子指向未 emit(不可达/组外)的节点 → 跳过该叶子并记 warning,避免 ink 引用未定义 knot。 */
function guardFor(
  cond: StoryConditionExpr | undefined,
  emittedNodes: Set<string>,
  warnings: string[],
): string {
  const leaves = conditionLeaves(cond);
  if (leaves.length === 0) return '';
  const sep = cond && isConditionGroup(cond) && cond.join === 'or' ? ' || ' : ' && ';
  const parts: string[] = [];
  for (const leaf of leaves) {
    if (isVisitCondition(leaf)) {
      if (!emittedNodes.has(leaf.visitedNodeId)) {
        warnings.push('访问条件引用了不可达/组外片段,已忽略');
        continue;
      }
      parts.push(`${knotNameForNodeId(leaf.visitedNodeId)} ${leaf.op} ${leaf.value}`);
    } else {
      parts.push(`${leaf.var} ${leaf.op} ${leaf.value}`);
    }
  }
  if (parts.length === 0) return '';
  return `{${parts.join(sep)}} `;
}

function choiceEdgeData(edge: CanvasEdge): StoryChoiceEdgeData | null {
  if (edge.type !== STORY_CHOICE_EDGE_TYPE) return null;
  const data = edge.data as Partial<StoryChoiceEdgeData> | undefined;
  return {
    choiceText: typeof data?.choiceText === 'string' ? data.choiceText : '',
    order: Number.isFinite(data?.order) ? Number(data?.order) : 0,
    isDefault: data?.isDefault === true,
  };
}

interface ChoiceEntry {
  target: string;
  text: string;
  order: number;
  isDefault?: boolean;
  condition?: StoryChoiceEdgeData['condition'];
  effects?: StoryChoiceEdgeData['effects'];
}

/**
 * 解析故事起点(复用 {@link resolveStartNodeId});无法唯一确定时抛 no_start。
 */
function resolveStartNode(
  videoNodes: CanvasNode[],
  choiceSources: Set<string>,
  choiceTargets: Set<string>,
): CanvasNode {
  const { startId } = resolveStartNodeId(videoNodes, choiceSources, choiceTargets);
  const node = startId ? videoNodes.find((n) => n.id === startId) : undefined;
  if (!node) {
    throw new StoryCompileError('no_start', '请先设置故事起点(或确保只有一个根片段)');
  }
  return node;
}

export function compileGraphToInk(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  variables: StoryVariable[] = [],
): CompiledStory {
  const warnings: string[] = [];

  const videoNodes = nodes.filter(isVideoNode);
  if (videoNodes.length === 0) {
    throw new StoryCompileError('empty', '画布上没有视频节点');
  }

  const nodeById = new Map(videoNodes.map((node) => [node.id, node] as const));

  const validVarNames = new Set(variables.map((v) => v.name));

  function condOf(edge: CanvasEdge): StoryChoiceEdgeData['condition'] {
    const c = (edge.data as Partial<StoryChoiceEdgeData> | undefined)?.condition;
    if (!c) return undefined;
    const leaves = conditionLeaves(c);
    if (leaves.length === 0) return undefined;
    // 整组校验:任一叶子引用未注册变量 → 整条条件丢弃(与单条件「忽略无效条件」一致)。
    for (const leaf of leaves) {
      if (isVisitCondition(leaf)) continue; // 访问叶子在 guardFor 发射时按可达集校验
      if (typeof leaf.var !== 'string' || !validVarNames.has(leaf.var)) {
        warnings.push(`条件引用了未注册变量「${leaf.var}」,已忽略`);
        return undefined;
      }
    }
    return c;
  }

  function effectsOf(edge: CanvasEdge): StoryChoiceEdgeData['effects'] {
    const list = (edge.data as Partial<StoryChoiceEdgeData> | undefined)?.effects;
    if (!Array.isArray(list)) return undefined;
    const kept = list.filter((e) => {
      if (!e || typeof e.var !== 'string' || typeof e.delta !== 'number') return false;
      if (!validVarNames.has(e.var)) {
        warnings.push(`效果引用了未注册变量「${e.var}」,已忽略`);
        return false;
      }
      return true;
    });
    return kept.length > 0 ? kept : undefined;
  }

  // 源节点 -> 其出向选项边(已校验两端都是视频节点),按 order 升序。
  // 同时记录哪些节点是选项边的源 / 目标,供「无显式起点时自动推断根节点」。
  const choicesBySource = new Map<string, ChoiceEntry[]>();
  const choiceSources = new Set<string>();
  const choiceTargets = new Set<string>();
  for (const edge of edges) {
    const data = choiceEdgeData(edge);
    if (!data) continue;
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    choiceSources.add(edge.source);
    choiceTargets.add(edge.target);
    const list = choicesBySource.get(edge.source) ?? [];
    list.push({
      target: edge.target,
      text: data.choiceText,
      order: data.order,
      isDefault: data.isDefault === true,
      condition: condOf(edge),
      effects: effectsOf(edge),
    });
    choicesBySource.set(edge.source, list);
  }
  for (const list of choicesBySource.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  const startNode = resolveStartNode(videoNodes, choiceSources, choiceTargets);

  // 从起点 BFS,只收可达节点。
  const reachable: string[] = [];
  const seen = new Set<string>();
  const queue = [startNode.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    reachable.push(id);
    for (const choice of choicesBySource.get(id) ?? []) {
      if (nodeById.has(choice.target)) queue.push(choice.target);
    }
  }

  const clipByNodeId: Record<string, string> = {};
  const knotByNodeId: Record<string, string> = {};
  // 限时选项:源节点 id → 选项窗口秒数(>0)/默认选项在「按 order 排序后」的 0-based 位置
  // (= inkjs choice index)。
  const choiceTimeByNodeId: Record<string, number> = {};
  const defaultChoiceIndexByNodeId: Record<string, number> = {};
  // 叶子结局节点 → 结局页标题/标。
  const endingByNodeId: Record<string, { title: string; label?: string }> = {};

  // 生成 VAR 声明(放在 divert 之前)
  const lines: string[] = [];
  for (const v of variables) {
    lines.push(`VAR ${v.name} = ${Math.trunc(v.initial)}`);
  }
  if (variables.length > 0) lines.push('');
  lines.push(`-> ${knotNameForNodeId(startNode.id)}`, '');

  for (const id of reachable) {
    const node = nodeById.get(id)!;
    const knot = knotNameForNodeId(id);
    knotByNodeId[id] = knot;
    clipByNodeId[id] = (node.data as { videoUrl?: string | null }).videoUrl ?? '';

    const limitSec = Number((node.data as { choiceTimeLimitSec?: number }).choiceTimeLimitSec);
    if (Number.isFinite(limitSec) && limitSec > 0) choiceTimeByNodeId[id] = limitSec;
    const sortedChoices = choicesBySource.get(id) ?? [];
    const defaultPos = sortedChoices.findIndex((c) => c.isDefault);
    if (defaultPos >= 0) defaultChoiceIndexByNodeId[id] = defaultPos;

    lines.push(`=== ${knot} ===`);
    // `clip` 是占位 marker 文本,保证 ink 有内容可 Continue 且 `# clip:` tag 能浮现。
    // 播放器只读 `# clip:` tag 决定要播哪段视频,不渲染 ink 文本,玩家不会看到 "clip" 字样。
    lines.push(`clip # clip: ${id}`);
    const choices = choicesBySource.get(id) ?? [];
    if (choices.length === 0) {
      // 叶子 = 结局:记标题(旁白)与结局标。
      const data = node.data as { narration?: string; endingLabel?: string };
      const title = (data.narration ?? '').trim();
      endingByNodeId[id] = {
        title,
        ...(data.endingLabel ? { label: data.endingLabel } : {}),
      };
      lines.push('-> END');
    } else {
      for (const choice of choices) {
        const guard = guardFor(choice.condition, seen, warnings);
        lines.push(`+ ${guard}[${choice.text}]`);
        for (const eff of choice.effects ?? []) {
          lines.push(`    ~ ${eff.var} += ${Math.trunc(eff.delta)}`);
        }
        lines.push(`    -> ${knotNameForNodeId(choice.target)}`);
      }
    }
    lines.push('');
  }

  return {
    ink: lines.join('\n'),
    clipByNodeId,
    knotByNodeId,
    choiceTimeByNodeId,
    defaultChoiceIndexByNodeId,
    endingByNodeId,
    warnings,
    variables,
  };
}
