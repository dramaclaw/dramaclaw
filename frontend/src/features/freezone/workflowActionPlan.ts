// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasStoreApi } from '@/features/canvas/core/canvasStore';
import type { NodeDataDefaults } from '@/features/canvas/domain/nodeRegistry';
import { CANVAS_NODE_TYPES, STORY_CHOICE_EDGE_TYPE, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import type { CanvasChatCommand, JsonRecord } from '@/features/canvas/core/commands/types';
import { canvasCommandLabel } from '@/features/canvas/core/commands/executor';
import { GENERATION_NODE_ACTIONS, expandWorkflowNodeIds, defaultWorkflowActionForNode, isWorkflowUserInputNode, hasGeneratedResult } from '@/features/canvas/core/workflowInvalidation';
import { workflowExternalSourceMismatch } from '@/features/canvas/core/commands/workflowExternalSource';
import { isCanvasChatRunNodeAction } from './canvasCommandEnvelope';
import { buildCanvasNodeActionCatalog, isAgentExecutableNodeAction } from './canvasNodeActionCatalog';

const VIDEO_COMPOSE_MIN_UPSTREAM_VIDEOS = 1;
const VIDEO_COMPOSE_MIN_UPSTREAM_MEDIA = 2;
type PlanOptions = {
  selectedNodeIds: string[];
  nodeDataDefaults: NodeDataDefaults;
  translate?: Parameters<typeof canvasCommandLabel>[1];
};
type PlanCommand = Extract<CanvasChatCommand, { type: 'run_workflow' | 'run_node_action' }>;


export type PlannedNodeAction = {
  commandIndex: number;
  nodeId: string;
  action: string;
  executionMode: "single" | "workflow";
  parameters?: JsonRecord;
  label: string;
  invalidationReason?: "explicit_regeneration" | "upstream_regeneration";
};

export function assertNodeActionAvailable(store: CanvasStoreApi, nodeDataDefaults: NodeDataDefaults, nodeId: string, action: string): void {
  if (!isAgentExecutableNodeAction(action)) {
    throw new Error(`mainline write action is manual-only: ${action}`);
  }
  const targetNode = store.getState().nodes.find(node => node.id === nodeId);
  if (!targetNode) throw new Error(`node not found: ${nodeId}`);
  const state = store.getState();
  const catalog = buildCanvasNodeActionCatalog(targetNode, {
    nodeDataDefaults,
    nodes: state.nodes,
    edges: state.edges,
  });
  const catalogAction = catalog.actions.find((item) => item.action === action);
  if (!catalogAction) throw new Error(`action not available on node: ${action}`);
  if (!isCanvasChatRunNodeAction(action)) throw new Error(`action is not executable from chat: ${action}`);
  if (catalogAction.execution === "chat_command") {
    throw new Error(`action must be expressed as a canvas chat command: ${action}`);
  }
}

function workflowExternalSourceIds(
  edges: CanvasEdge[],
  scopedNodeIds: Set<string>,
  nodes: CanvasNode[],
): Set<string> {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const scopedEdges = edges.filter((edge) => scopedNodeIds.has(edge.target));
  const externalSources = new Set<string>();
  const ordinarySources = new Set<string>();
  for (const edge of scopedEdges) {
    const expected = {
      imageUrl: edge.data?.workflowExternalInputImageUrl,
      videoUrl: edge.data?.workflowExternalInputVideoUrl,
    };
    if (![expected.imageUrl, expected.videoUrl].some((url) => typeof url === "string" && url.trim())) {
      ordinarySources.add(edge.source);
      continue;
    }
    const mismatch = workflowExternalSourceMismatch(nodeById.get(edge.source), edge.source, expected);
    if (mismatch) throw new Error(mismatch);
    externalSources.add(edge.source);
  }
  return new Set([...externalSources].filter((sourceId) => !ordinarySources.has(sourceId)));
}

function isRedundantLegacyComposeGenerator(
  node: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): boolean {
  if (node.type !== CANVAS_NODE_TYPES.video) return false;
  const data = node.data as Record<string, unknown>;
  const catalog =
    data.workflowCatalog && typeof data.workflowCatalog === "object"
      ? data.workflowCatalog as Record<string, unknown>
      : null;
  const stepId = String(catalog?.stepId ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const label = String(data.displayName ?? data.title ?? "").trim().toLowerCase();
  const hasComposeIdentity =
    ["compose", "final_compose", "final_composition", "video_compose"].includes(stepId)
    || ["最终合成", "成片合成", "最终成片合成", "final compose", "final composition"].includes(label); // i18n-exempt: Saved legacy compose identities.
  if (!hasComposeIdentity) return false;
  const nodeByIdMap = new Map(nodes.map((candidate) => [candidate.id, candidate] as const));
  return edges.some(
    (edge) =>
      edge.source === node.id
      && nodeByIdMap.get(edge.target)?.type === CANVAS_NODE_TYPES.videoCompose,
  );
}

function hasVideoComposeMinimumInputs(store: CanvasStoreApi, nodeId: string, allowedSourceNodeIds?: Set<string>): boolean {
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  let videoCount = 0;
  let audioCount = 0;
  for (const edge of state.edges) {
    if (edge.target !== nodeId) continue;
    if (allowedSourceNodeIds && !allowedSourceNodeIds.has(edge.source)) continue;
    const source = nodeByIdMap.get(edge.source);
    if (!source) continue;
    const data = source.data as Record<string, unknown>;
    if (
      source.type === CANVAS_NODE_TYPES.video
      && typeof data.videoUrl === "string"
      && data.videoUrl.trim().length > 0
    ) {
      videoCount += 1;
    }
    if (
      source.type === CANVAS_NODE_TYPES.audio
      && typeof data.audioUrl === "string"
      && data.audioUrl.trim().length > 0
    ) {
      audioCount += 1;
    }
  }
  return (
    videoCount >= VIDEO_COMPOSE_MIN_UPSTREAM_VIDEOS
    && videoCount + audioCount >= VIDEO_COMPOSE_MIN_UPSTREAM_MEDIA
  );
}

function satisfiedVideoComposeUpstreamNodeIds(store: CanvasStoreApi,
  nodeIds: string[],
  explicitlyRequestedNodeIds: Iterable<string>,
): Set<string> {
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const scopedNodeIds = new Set(nodeIds);
  const explicitlyRequested = new Set(explicitlyRequestedNodeIds);
  const protectedNodeIds = new Set<string>();
  for (const nodeId of relatedSatisfiedVideoComposeNodeIds(store, nodeIds, scopedNodeIds)) {
    const node = nodeByIdMap.get(nodeId);
    if (node?.type !== CANVAS_NODE_TYPES.videoCompose) continue;
    for (const upstreamId of expandWorkflowNodeIds(store, [nodeId], ["upstream"])) {
      if (
        upstreamId !== nodeId
        && scopedNodeIds.has(upstreamId)
        && !explicitlyRequested.has(upstreamId)
      ) {
        protectedNodeIds.add(upstreamId);
      }
    }
  }
  return protectedNodeIds;
}

function relatedSatisfiedVideoComposeNodeIds(store: CanvasStoreApi,
  nodeIds: string[],
  allowedSourceNodeIds?: Set<string>,
): string[] {
  const state = store.getState();
  const expandedSet = new Set(nodeIds);
  const composeIds: string[] = [];
  for (const node of state.nodes) {
    if (node.type !== CANVAS_NODE_TYPES.videoCompose) continue;
    if (!hasVideoComposeMinimumInputs(store, node.id, allowedSourceNodeIds)) continue;
    if (expandedSet.has(node.id) || state.edges.some((edge) => edge.target === node.id && expandedSet.has(edge.source))) {
      composeIds.push(node.id);
    }
  }
  return composeIds;
}

function normalizeWorkflowStartNodeIds(store: CanvasStoreApi, nodeIds: string[]): string[] {
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  return [...new Set(nodeIds.map((nodeId) => {
    const node = nodeByIdMap.get(nodeId);
    if (!isWorkflowUserInputNode(node) || !node?.parentId) return nodeId;
    return nodeByIdMap.get(node.parentId)?.type === CANVAS_NODE_TYPES.group
      ? node.parentId
      : nodeId;
  }))];
}

function workflowNodeActions(store: CanvasStoreApi,
  command: Extract<CanvasChatCommand, { type: "run_workflow" }>,
  commandIndex: number,
  options: PlanOptions & { skipCompleted?: boolean },
): PlannedNodeAction[] {
  const commandLabel = (command: CanvasChatCommand) => canvasCommandLabel(command, options.translate ?? (key => key));
  const state = store.getState();
  const initialNodeIds = command.node_ids && command.node_ids.length > 0
    ? normalizeWorkflowStartNodeIds(store, command.node_ids)
    : command.scope === "canvas"
      ? state.nodes.map((node) => node.id)
      : options.selectedNodeIds;
  const directions: Array<"upstream" | "downstream"> = command.direction === "node"
    ? []
    : command.direction === "downstream"
      ? ["downstream"]
      : ["upstream", "downstream"];
  const expandedNodeIds = expandWorkflowNodeIds(store, initialNodeIds, directions);
  const nodeByIdMap = new Map(store.getState().nodes.map((node) => [node.id, node] as const));
  const scopedNodeIds = new Set(expandedNodeIds);
  const externalImageSourceIds = workflowExternalSourceIds(
    state.edges, scopedNodeIds, state.nodes,
  );
  const protectedUpstreamNodeIds = satisfiedVideoComposeUpstreamNodeIds(store,
    expandedNodeIds,
    initialNodeIds,
  );
  const composeNodeIdsToOpen = command.direction === "node"
    ? []
    : relatedSatisfiedVideoComposeNodeIds(store, expandedNodeIds, scopedNodeIds)
      .filter((nodeId) => !expandedNodeIds.includes(nodeId));

  return [
    ...expandedNodeIds,
    ...composeNodeIdsToOpen,
  ].flatMap((nodeId) => {
    const node = nodeByIdMap.get(nodeId);
    if (!node || node.type === CANVAS_NODE_TYPES.group) return [];
    if (externalImageSourceIds.has(nodeId)) return [];
    if (isRedundantLegacyComposeGenerator(node, state.nodes, state.edges)) return [];
    if (node.type === CANVAS_NODE_TYPES.videoCompose) {
      return [{
        commandIndex,
        nodeId,
        action: "auto_compose_video",
        executionMode: "workflow",
        parameters: undefined,
        label: commandLabel({
          type: "run_node_action",
          node_id: nodeId,
          action: "auto_compose_video",
        }),
      }];
    }
    if (protectedUpstreamNodeIds.has(nodeId)) return [];
    const action = defaultWorkflowActionForNode(store, node, options.nodeDataDefaults);
    if (!action) return [];
    if (options.skipCompleted !== false && hasGeneratedResult(store, nodeId, action)) return [];
    return [{
      commandIndex,
      nodeId,
      action,
      executionMode: "workflow",
      parameters: undefined,
      label: commandLabel({ type: "run_node_action", node_id: nodeId, action }),
    }];
  });
}

export function directNodeActionQueue(store: CanvasStoreApi,
  nodeId: string,
  action: string,
  commandIndex: number,
  options: PlanOptions,
  parameters?: JsonRecord,
): PlannedNodeAction[] {
  const commandLabel = (command: CanvasChatCommand) => canvasCommandLabel(command, options.translate ?? (key => key));
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const includeUpstream = (
    GENERATION_NODE_ACTIONS.has(action)
    || (
      action === "open_video_compose_modal"
      && !hasVideoComposeMinimumInputs(store, nodeId)
    )
  );
  const upstreamNodeIds = includeUpstream
    ? expandWorkflowNodeIds(store, [nodeId], ["upstream"])
    : [nodeId];
  const externalImageSourceIds = workflowExternalSourceIds(
    state.edges, new Set(upstreamNodeIds), state.nodes,
  );
  const upstreamActions = upstreamNodeIds
    .filter((upstreamId) => upstreamId !== nodeId)
    .flatMap((upstreamId): PlannedNodeAction[] => {
      const node = nodeByIdMap.get(upstreamId);
      if (!node || node.type === CANVAS_NODE_TYPES.group) return [];
      if (externalImageSourceIds.has(upstreamId)) return [];
      if (isRedundantLegacyComposeGenerator(node, state.nodes, state.edges)) return [];
      const upstreamAction = defaultWorkflowActionForNode(store, node, options.nodeDataDefaults);
      if (!upstreamAction || hasGeneratedResult(store, upstreamId, upstreamAction)) return [];
      return [{
        commandIndex,
        nodeId: upstreamId,
        action: upstreamAction,
        executionMode: "workflow",
        parameters: undefined,
        label: commandLabel({
          type: "run_node_action",
          node_id: upstreamId,
          action: upstreamAction,
        }),
      }];
    });
  return [
    ...upstreamActions,
    {
      commandIndex,
      nodeId,
      action,
      executionMode: "single",
      parameters,
      label: commandLabel({ type: "run_node_action", node_id: nodeId, action }),
    },
  ];
}

export function orderedNodeActionsByCanvasEdges(store: CanvasStoreApi, actions: PlannedNodeAction[]): {
  ordered: PlannedNodeAction[];
  levels: PlannedNodeAction[][];
  dependenciesByNodeId: Map<string, Set<string>>;
  cycleError?: string;
} {
  const state = store.getState();
  const itemIds = actions.map((_, index) => String(index));
  const itemIdByNodeId = new Map<string, string[]>();
  actions.forEach((action, index) => {
    const ids = itemIdByNodeId.get(action.nodeId) ?? [];
    ids.push(String(index));
    itemIdByNodeId.set(action.nodeId, ids);
  });

  const indegree = new Map<string, number>(itemIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  const dependenciesByNodeId = new Map<string, Set<string>>();
  const graph = new Map<string, string[]>();
  for (const edge of state.edges) {
    // Only explicitly continuous story shots impose generation dependencies.
    if (edge.type === STORY_CHOICE_EDGE_TYPE) {
      const target = state.nodes.find(node => node.id === edge.target);
      const source = state.nodes.find(node => node.id === edge.source);
      if (target?.type !== CANVAS_NODE_TYPES.video || source?.type !== CANVAS_NODE_TYPES.video ||
          target.data.continuityMode !== 'auto' || target.data.storyRole === 'start' ||
          (typeof target.data.continuitySourceNodeId === 'string' && target.data.continuitySourceNodeId &&
            target.data.continuitySourceNodeId !== edge.source)) continue;
    }
    const targets = graph.get(edge.source) ?? [];
    targets.push(edge.target);
    graph.set(edge.source, targets);
  }

  const hasDirectedPath = (sourceNodeId: string, targetNodeId: string): boolean => {
    if (sourceNodeId === targetNodeId) return false;
    const visited = new Set<string>();
    const queue = [...(graph.get(sourceNodeId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next === targetNodeId) return true;
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(...(graph.get(next) ?? []));
    }
    return false;
  };

  const addDependency = (sourceNodeId: string, targetNodeId: string): void => {
    const sourceItems = itemIdByNodeId.get(sourceNodeId) ?? [];
    const targetItems = itemIdByNodeId.get(targetNodeId) ?? [];
    if (sourceItems.length === 0 || targetItems.length === 0) return;
    const deps = dependenciesByNodeId.get(targetNodeId) ?? new Set<string>();
    deps.add(sourceNodeId);
    dependenciesByNodeId.set(targetNodeId, deps);
    for (const sourceItem of sourceItems) {
      for (const targetItem of targetItems) {
        if (sourceItem === targetItem) continue;
        const next = outgoing.get(sourceItem) ?? [];
        if (next.includes(targetItem)) continue;
        next.push(targetItem);
        outgoing.set(sourceItem, next);
        indegree.set(targetItem, (indegree.get(targetItem) ?? 0) + 1);
      }
    }
  };

  for (const sourceAction of actions) {
    for (const targetAction of actions) {
      if (sourceAction.nodeId === targetAction.nodeId) continue;
      if (!hasDirectedPath(sourceAction.nodeId, targetAction.nodeId)) continue;
      addDependency(sourceAction.nodeId, targetAction.nodeId);
    }
  }

  let ready = itemIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const orderedIds: string[] = [];
  const levelIds: string[][] = [];
  while (ready.length > 0) {
    const currentLevel = ready.sort((left, right) => Number(left) - Number(right));
    ready = [];
    levelIds.push(currentLevel);
    orderedIds.push(...currentLevel);
    for (const id of currentLevel) {
      for (const target of outgoing.get(id) ?? []) {
        const next = (indegree.get(target) ?? 0) - 1;
        indegree.set(target, next);
        if (next === 0) ready.push(target);
      }
    }
  }

  if (orderedIds.length !== actions.length) {
    return {
      ordered: [],
      levels: [],
      dependenciesByNodeId,
      cycleError: "画布连接线存在环形依赖，已取消本批节点动作。", // i18n-exempt: Existing workflow error contract.
    };
  }

  return {
    ordered: orderedIds.map((id) => actions[Number(id)]!),
    levels: levelIds.map((level) => level.map((id) => actions[Number(id)]!)),
    dependenciesByNodeId,
  };
}

/** Discovery stays in canvas order; the browser orders the combined queue after all commands. */
export function discoverWorkflowNodeActions(
  store: CanvasStoreApi,
  command: Extract<CanvasChatCommand, { type: 'run_workflow' }>,
  commandIndex: number,
  options: PlanOptions,
) {
  const allActions = workflowNodeActions(store, command, commandIndex, { ...options, skipCompleted: false });
  let actions = workflowNodeActions(store, command, commandIndex, {
    ...options, skipCompleted: command.regenerate !== true,
  });
  if (command.regenerate === true) {
    const seeds = new Set(command.node_ids ?? options.selectedNodeIds);
    actions = actions.map(action => ({
      ...action,
      invalidationReason: seeds.has(action.nodeId) ? 'explicit_regeneration' : 'upstream_regeneration',
    }));
  }
  return { allActions, actions, alreadyCompleted: allActions.length > 0 && actions.length === 0 };
}

export type WorkflowActionPlan = {
  ok: true;
  actions: PlannedNodeAction[];
  levels: number[][];
  dependencies: Record<string, string[]>;
  alreadyCompleted: boolean;
} | {
  ok: false;
  code: 'workflow_cycle' | 'workflow_empty' | 'action_unavailable';
  message: string;
};

export function planCanvasNodeActions(
  store: CanvasStoreApi,
  commands: PlanCommand[],
  options: PlanOptions,
): WorkflowActionPlan {
  const actions: PlannedNodeAction[] = [];
  const keys = new Set<string>();
  let completedWorkflow = false;
  try {
    for (const [commandIndex, command] of commands.entries()) {
      let queued: PlannedNodeAction[];
      if (command.type === 'run_workflow') {
        const workflow = discoverWorkflowNodeActions(store, command, commandIndex, options);
        if (workflow.allActions.length === 0) {
          return { ok: false, code: 'workflow_empty', message: '工作流中没有可执行的生成节点。' }; // i18n-exempt: Existing workflow error contract.
        }
        queued = workflow.actions;
        if (workflow.alreadyCompleted) completedWorkflow = true;
      } else {
        assertNodeActionAvailable(store, options.nodeDataDefaults, command.node_id, command.action);
        queued = directNodeActionQueue(store, command.node_id, command.action, commandIndex, options, command.parameters);
      }
      for (const action of queued) {
        const key = `${action.nodeId}:${action.action}`;
        if (keys.has(key)) continue;
        assertNodeActionAvailable(store, options.nodeDataDefaults, action.nodeId, action.action);
        keys.add(key);
        actions.push(action);
      }
    }
  } catch (error) {
    return { ok: false, code: 'action_unavailable', message: error instanceof Error ? error.message : String(error) };
  }
  const { ordered, levels, dependenciesByNodeId, cycleError } = orderedNodeActionsByCanvasEdges(store, actions);
  if (cycleError) return { ok: false, code: 'workflow_cycle', message: cycleError };
  const dependencies: Record<string, string[]> = {};
  for (const action of ordered) {
    const upstream = ordered.filter(candidate => dependenciesByNodeId.get(action.nodeId)?.has(candidate.nodeId));
    const nearest = upstream.filter(candidate => !upstream.some(other =>
      other.nodeId !== candidate.nodeId && dependenciesByNodeId.get(other.nodeId)?.has(candidate.nodeId)));
    if (nearest.length) dependencies[action.nodeId] = [...new Set(nearest.map(candidate => candidate.nodeId))];
  }
  return {
    ok: true, actions: ordered,
    levels: levels.map(level => level.map(action => ordered.indexOf(action))),
    dependencies, alreadyCompleted: ordered.length === 0 && completedWorkflow,
  };
}
