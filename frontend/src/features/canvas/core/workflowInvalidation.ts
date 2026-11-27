// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasNodeType } from '../domain/canvasNodes';
import { defaultNodeDataDefaults, type NodeDataDefaults } from '../domain/nodeRegistry';
import { buildCanvasNodeActionCatalog } from '@/features/freezone/canvasNodeActionCatalog';
import { isCanvasChatRunNodeAction, isRecord } from '@/features/freezone/canvasCommandEnvelope';
import type { CanvasStoreApi } from './canvasStore';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export const GENERATION_NODE_ACTIONS = new Set([
  "generate_text",
  "generate_html",
  "generate_text_video",
  "generate_story_script",
  "generate_image",
  "generate_audio",
  "generate_video",
  "auto_compose_video",
  "generate_3gs_world",
  "run_skill",
]);

const WORKFLOW_GENERATE_ACTION_BY_NODE_TYPE: Partial<Record<CanvasNodeType, string[]>> = {
  [CANVAS_NODE_TYPES.htmlArtifact]: ["generate_html"],
  [CANVAS_NODE_TYPES.script]: ["generate_story_script"],
  [CANVAS_NODE_TYPES.imageGen]: ["generate_image"],
  [CANVAS_NODE_TYPES.audio]: ["generate_audio"],
  [CANVAS_NODE_TYPES.video]: ["generate_video"],
  [CANVAS_NODE_TYPES.threeDWorld]: ["generate_3gs_world"],
  [CANVAS_NODE_TYPES.textAnnotation]: ["generate_text", "generate_text_video"],
};

export function expandWorkflowNodeIds(
  store: CanvasStoreApi,
  seedNodeIds: string[],
  directions: Array<"upstream" | "downstream"> = ["upstream", "downstream"],
): string[] {
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const upstreamByNodeId = new Map<string, string[]>();
  const downstreamByNodeId = new Map<string, string[]>();
  for (const edge of state.edges) {
    // A Recipe consumes the existing media at this edge. Traversing back into
    // its source would also reach unrelated branches that share that media.
    if (!edge.data?.workflowExternalInputImageUrl && !edge.data?.workflowExternalInputVideoUrl) {
      const upstream = upstreamByNodeId.get(edge.target) ?? [];
      upstream.push(edge.source);
      upstreamByNodeId.set(edge.target, upstream);
    }
    const downstream = downstreamByNodeId.get(edge.source) ?? [];
    downstream.push(edge.target);
    downstreamByNodeId.set(edge.source, downstream);
  }
  const expanded = new Set<string>();
  const queue = seedNodeIds
    .filter((id) => nodeByIdMap.has(id))
    .map((id) => ({ nodeId: id, traverseGraph: nodeByIdMap.get(id)?.type !== CANVAS_NODE_TYPES.group }));

  while (queue.length > 0) {
    const { nodeId, traverseGraph } = queue.shift()!;
    if (expanded.has(nodeId)) continue;
    expanded.add(nodeId);
    const node = nodeByIdMap.get(nodeId);
    if (node?.type === CANVAS_NODE_TYPES.group) {
      for (const child of state.nodes) {
        if (child.parentId === nodeId && !expanded.has(child.id)) {
          queue.push({ nodeId: child.id, traverseGraph: false });
        }
      }
      continue;
    }
    if (!traverseGraph) continue;
    if (directions.includes("upstream")) {
      for (const upstreamId of upstreamByNodeId.get(nodeId) ?? []) {
        if (!expanded.has(upstreamId)) queue.push({ nodeId: upstreamId, traverseGraph: true });
      }
    }
    if (directions.includes("downstream")) {
      for (const downstreamId of downstreamByNodeId.get(nodeId) ?? []) {
        if (!expanded.has(downstreamId)) queue.push({ nodeId: downstreamId, traverseGraph: true });
      }
    }
  }

  return state.nodes
    .map((node) => node.id)
    .filter((id) => expanded.has(id));
}

export function defaultWorkflowActionForNode(store: CanvasStoreApi, node: CanvasNode, defaults: NodeDataDefaults = defaultNodeDataDefaults): string | null {
  if (isWorkflowUserInputNode(node)) return null;
  const preferredActions = WORKFLOW_GENERATE_ACTION_BY_NODE_TYPE[node.type] ?? [];
  if (preferredActions.length === 0) return null;
  const state = store.getState();
  const catalog = buildCanvasNodeActionCatalog(node, {
    nodeDataDefaults: defaults,
    nodes: state.nodes,
    edges: state.edges,
  });
  for (const action of preferredActions) {
    const entry = catalog.actions.find((item) => item.action === action);
    if (!entry || entry.execution !== "frontend_node") continue;
    if (!isCanvasChatRunNodeAction(action)) continue;
    return action;
  }
  return null;
}

export function isWorkflowUserInputNode(node: CanvasNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as Record<string, unknown>;
  if (data.workflowCatalogRole === "user_input") return true;
  // An image node containing only an uploaded reference already supplies media to
  // downstream nodes. It has no generated output to wait for and no prompt to run.
  if (
    node.type === CANVAS_NODE_TYPES.imageGen
    && Boolean(nonEmptyString(data.referenceImageUrl))
    && !nonEmptyString(data.imageUrl)
    && !nonEmptyString(data.prompt)
  ) return true;
  const catalog = data.workflowCatalog && typeof data.workflowCatalog === "object"
    && !Array.isArray(data.workflowCatalog)
    ? data.workflowCatalog as Record<string, unknown>
    : null;
  const stepId = String(catalog?.stepId ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  return ["workflow_input", "user_input", "user_requirement"].includes(stepId);
}
export function hasGeneratedResult(
  store: CanvasStoreApi,
  nodeId: string,
  action: string,
  includeInvalidatedResult = false,
): boolean {
  const data = store.getState().nodes.find(node => node.id === nodeId)?.data as Record<string, unknown> | undefined;
  if (!data) return false;
  if (
    !includeInvalidatedResult &&
    GENERATION_NODE_ACTIONS.has(action) &&
    data.workflowResultStale === true
  ) {
    return false;
  }
  if (action === "generate_html") {
    return Boolean(nonEmptyString(data.artifactId)) && Number.isInteger(data.artifactVersion) && Number(data.artifactVersion) > 0;
  }
  if (action === "generate_text") {
    return data.workflowTextGenerated === true && Boolean(nonEmptyString(data.content));
  }
  if (action === "generate_story_script") {
    const scriptResult = data.scriptResult as { rows?: unknown } | undefined;
    return Array.isArray(scriptResult?.rows) && scriptResult.rows.length > 0;
  }
  if (action === "generate_image") {
    return Boolean(nonEmptyString(data.imageUrl) ?? nonEmptyString(data.image_url));
  }
  if (action === "generate_video" || action === "generate_text_video") {
    return Boolean(nonEmptyString(data.videoUrl) ?? nonEmptyString(data.video_url));
  }
  if (action === "auto_compose_video") {
    return Boolean(nonEmptyString(data.resultVideoUrl));
  }
  if (action === "generate_audio") {
    return Boolean(nonEmptyString(data.audioUrl) ?? nonEmptyString(data.audio_url));
  }
  if (action === "generate_3gs_world") {
    if (typeof data.plyUrl === "string" && data.plyUrl.trim().length > 0) return true;
    if (!Array.isArray(data.sources)) return false;
    return data.sources.some((source) => {
      if (!isRecord(source)) return false;
      const url = typeof source.ply_url === "string"
        ? source.ply_url
        : typeof source.url === "string"
          ? source.url
          : "";
      return url.trim().length > 0;
    });
  }
  return true;
}

const WORKFLOW_OUTPUT_DATA_KEYS = new Set([
  "audioUrl",
  "audio_url",
  "content",
  "imageUrl",
  "image_url",
  "plyUrl",
  "resultVideoUrl",
  "scriptResult",
  "sources",
  "videoUrl",
  "video_url",
]);

const WORKFLOW_PRESENTATION_DATA_KEYS = new Set([
  "autoTitleIndex",
  "displayName",
  "height",
  "isSizeManuallyAdjusted",
  "previewImageUrl",
  "selected",
  "width",
]);

export function invalidateWorkflowResultsAfterNodeUpdate(
  store: CanvasStoreApi,
  nodeId: string,
  changedData: Record<string, unknown>,
  now: () => number = Date.now,
  defaults: NodeDataDefaults = defaultNodeDataDefaults,
): void {
  const changedKeys = Object.keys(changedData).filter(
    (key) =>
      !WORKFLOW_PRESENTATION_DATA_KEYS.has(key) &&
      !key.startsWith("workflow"),
  );
  if (changedKeys.length === 0) return;
  const hasInputChange = changedKeys.some((key) => !WORKFLOW_OUTPUT_DATA_KEYS.has(key));
  const affectedNodeIds = expandWorkflowNodeIds(store, [nodeId], ["downstream"])
    .filter((affectedNodeId) => hasInputChange || affectedNodeId !== nodeId);
  const state = store.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const timestamp = new Date(now()).toISOString();
  for (const affectedNodeId of affectedNodeIds) {
    const affectedNode = nodeByIdMap.get(affectedNodeId);
    if (!affectedNode || affectedNode.type === CANVAS_NODE_TYPES.group) continue;
    const action = affectedNode.type === CANVAS_NODE_TYPES.videoCompose
      ? "auto_compose_video"
      : defaultWorkflowActionForNode(store, affectedNode, defaults);
    if (!action || !hasGeneratedResult(store, affectedNodeId, action, true)) continue;
    state.updateNodeData(affectedNodeId, {
      workflowResultStale: true,
      workflowInvalidatedAt: timestamp,
      workflowInvalidationReason: affectedNodeId === nodeId
        ? "node_input_changed"
        : "upstream_input_changed",
    });
  }
}

