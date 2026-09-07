import type { CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { conditionLeaves, isConditionGroup, isFlagCondition, isVisitCondition } from './conditionExpr';
import type { StoryChoiceEdgeData, StoryConditionExpr, StoryFlag, StoryVariable } from './storyTypes';

const MAX_ANALYSIS_STATES = 2_000;
const MAX_AUTOMATIC_CHAIN = 100;

export type StoryPathFindingCode =
  | 'runtime_unreachable'
  | 'condition_unreachable'
  | 'variable_out_of_bounds'
  | 'automatic_cycle'
  | 'path_analysis_incomplete';

export interface StoryPathFinding {
  code: StoryPathFindingCode;
  nodeId?: string;
  edgeId?: string;
  detail?: string;
}

interface RuntimeState {
  nodeId: string;
  variables: Record<string, number>;
  flags: Record<string, boolean>;
  visits: Record<string, number>;
}

interface QueueItem {
  state: RuntimeState;
  automaticChain: Set<string>;
  automaticDepth: number;
}

export function analyzeStoryPaths(
  memberIds: Set<string>,
  edges: CanvasEdge[],
  startId: string,
  variables: StoryVariable[],
  flags: StoryFlag[],
): StoryPathFinding[] {
  const variableByName = new Map(variables.map((variable) => [variable.name, variable] as const));
  const visitCaps = new Map([...memberIds].map((id) => [id, 1]));
  for (const edge of edges) {
    const condition = (edge.data as Partial<StoryChoiceEdgeData> | undefined)?.condition;
    for (const leaf of conditionLeaves(condition)) {
      if (isVisitCondition(leaf) && memberIds.has(leaf.visitedNodeId)) {
        visitCaps.set(leaf.visitedNodeId, Math.max(visitCaps.get(leaf.visitedNodeId) ?? 1, leaf.value + 1));
      }
    }
  }

  const bySource = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    if (!memberIds.has(edge.source) || !memberIds.has(edge.target)) continue;
    const list = bySource.get(edge.source) ?? [];
    list.push(edge);
    bySource.set(edge.source, list);
  }
  for (const list of bySource.values()) {
    list.sort((a, b) => edgeOrder(a) - edgeOrder(b));
  }

  const initial: RuntimeState = {
    nodeId: startId,
    variables: Object.fromEntries(variables.map((variable) => [variable.name, variable.initial])),
    flags: Object.fromEntries(flags.map((flag) => [flag.name, flag.initial])),
    visits: Object.fromEntries([...memberIds].map((id) => [id, id === startId ? 1 : 0])),
  };
  const queue: QueueItem[] = [{ state: initial, automaticChain: new Set(), automaticDepth: 0 }];
  const seen = new Set<string>();
  const reachedNodes = new Set<string>();
  const reachedEdges = new Set<string>();
  const findings: StoryPathFinding[] = [];
  const findingKeys = new Set<string>();
  let complete = true;

  const addFinding = (finding: StoryPathFinding) => {
    const key = `${finding.code}:${finding.edgeId ?? finding.nodeId ?? ''}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(finding);
  };

  while (queue.length > 0) {
    if (seen.size >= MAX_ANALYSIS_STATES) {
      complete = false;
      break;
    }
    const item = queue.shift()!;
    const currentKey = stateKey(item.state, variables, flags, memberIds);
    if (seen.has(currentKey)) continue;
    seen.add(currentKey);
    reachedNodes.add(item.state.nodeId);
    const sourceEdges = bySource.get(item.state.nodeId) ?? [];
    const automatic = sourceEdges.filter((edge) => edgeMode(edge) === 'automatic');
    const visible = sourceEdges.filter((edge) => edgeMode(edge) === 'visible');
    const selectedAutomatic = automatic.find((edge) => conditionMatches(edgeCondition(edge), item.state));
    const transitions = selectedAutomatic
      ? [selectedAutomatic]
      : visible.filter((edge) => conditionMatches(edgeCondition(edge), item.state));

    for (const edge of transitions) {
      reachedEdges.add(edge.id);
      const next = applyEdge(edge, item.state, visitCaps, variableByName, addFinding);
      if (!next) continue;
      const nextKey = stateKey(next, variables, flags, memberIds);
      if (edgeMode(edge) === 'automatic') {
        const nextDepth = item.automaticDepth + 1;
        if (item.automaticChain.has(nextKey) || nextKey === currentKey) {
          addFinding({ code: 'automatic_cycle', edgeId: edge.id });
          continue;
        }
        if (nextDepth > MAX_AUTOMATIC_CHAIN) {
          complete = false;
          continue;
        }
        queue.push({
          state: next,
          automaticChain: new Set([...item.automaticChain, currentKey]),
          automaticDepth: nextDepth,
        });
      } else {
        queue.push({ state: next, automaticChain: new Set(), automaticDepth: 0 });
      }
    }
  }

  if (!complete) {
    addFinding({ code: 'path_analysis_incomplete' });
    return findings;
  }

  for (const nodeId of structurallyReachable(startId, bySource)) {
    if (!reachedNodes.has(nodeId)) addFinding({ code: 'runtime_unreachable', nodeId });
  }
  for (const edge of edges) {
    if (reachedNodes.has(edge.source) && !reachedEdges.has(edge.id)) {
      addFinding({ code: 'condition_unreachable', edgeId: edge.id });
    }
  }
  return findings;
}

function applyEdge(
  edge: CanvasEdge,
  state: RuntimeState,
  visitCaps: Map<string, number>,
  variableByName: Map<string, StoryVariable>,
  addFinding: (finding: StoryPathFinding) => void,
): RuntimeState | null {
  const variables = { ...state.variables };
  const flags = { ...state.flags };
  for (const effect of (edge.data as Partial<StoryChoiceEdgeData> | undefined)?.effects ?? []) {
    if ('flag' in effect) {
      flags[effect.flag] = effect.value;
      continue;
    }
    const variable = variableByName.get(effect.var);
    if (!variable) continue;
    const nextValue = variables[effect.var] + effect.delta;
    if (
      variable.minimum != null && nextValue < variable.minimum
      || variable.maximum != null && nextValue > variable.maximum
    ) {
      addFinding({ code: 'variable_out_of_bounds', edgeId: edge.id, detail: variable.label });
      return null;
    }
    variables[effect.var] = nextValue;
  }
  const visits = { ...state.visits };
  visits[edge.target] = Math.min(visitCaps.get(edge.target) ?? 1, (visits[edge.target] ?? 0) + 1);
  return { nodeId: edge.target, variables, flags, visits };
}

function conditionMatches(condition: StoryConditionExpr | undefined, state: RuntimeState): boolean {
  if (!condition) return true;
  if (isConditionGroup(condition)) {
    const results = condition.items.map((leaf) => leafMatches(leaf, state));
    return condition.join === 'and' ? results.every(Boolean) : results.some(Boolean);
  }
  return leafMatches(condition, state);
}

function leafMatches(leaf: ReturnType<typeof conditionLeaves>[number], state: RuntimeState): boolean {
  if (isVisitCondition(leaf)) return compare(state.visits[leaf.visitedNodeId] ?? 0, leaf.op, leaf.value);
  if (isFlagCondition(leaf)) return state.flags[leaf.flag] === leaf.value;
  return compare(state.variables[leaf.var], leaf.op, leaf.value);
}

function compare(left: number, op: '>=' | '<=' | '==' | '>' | '<', right: number): boolean {
  if (op === '>=') return left >= right;
  if (op === '<=') return left <= right;
  if (op === '==') return left === right;
  if (op === '>') return left > right;
  return left < right;
}

function edgeData(edge: CanvasEdge): Partial<StoryChoiceEdgeData> {
  return (edge.data as Partial<StoryChoiceEdgeData> | undefined) ?? {};
}

function edgeMode(edge: CanvasEdge): 'visible' | 'automatic' {
  return edgeData(edge).transitionMode === 'automatic' ? 'automatic' : 'visible';
}

function edgeOrder(edge: CanvasEdge): number {
  return Number(edgeData(edge).order ?? 0);
}

function edgeCondition(edge: CanvasEdge): StoryConditionExpr | undefined {
  return edgeData(edge).condition;
}

function stateKey(
  state: RuntimeState,
  variables: StoryVariable[],
  flags: StoryFlag[],
  memberIds: Set<string>,
): string {
  return JSON.stringify([
    state.nodeId,
    variables.map((variable) => state.variables[variable.name]),
    flags.map((flag) => state.flags[flag.name]),
    [...memberIds].sort().map((id) => state.visits[id] ?? 0),
  ]);
}

function structurallyReachable(startId: string, bySource: Map<string, CanvasEdge[]>): Set<string> {
  const reached = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (reached.has(nodeId)) continue;
    reached.add(nodeId);
    for (const edge of bySource.get(nodeId) ?? []) queue.push(edge.target);
  }
  return reached;
}
