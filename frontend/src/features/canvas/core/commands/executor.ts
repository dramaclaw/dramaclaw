// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Canvas command executor that runs against the store it is given.
 *
 * The structural commands (create, connect, move, group, delete, select, update)
 * run here. Everything that needs a host (validation catalogs, deferred layout,
 * projection removal, previz scene landing, workflow staleness) goes through
 * `CanvasCommandEnvironment`. The four commands that start generation or open
 * UI run only when the host passes a handler for them.
 */
import { dedupeGenerationErrors } from "@/features/canvas/application/generationErrorReport";
import { placeGroupsOutsideStory } from "@/features/canvas/application/storyGroupPlacement";
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type BeatContextNodeData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  isGroupNode,
  isProtectedProjectionGroupNode,
  isStoryboardGroupNode,
} from "@/features/canvas/domain/canvasNodes";
import { inheritMainlineFields, type MainlineFieldsSource } from "@/features/canvas/domain/inheritMainlineFields";
import {
  isPresetManagedNode,
  isSystemManagedNodeData,
} from "@/features/canvas/domain/mainlineNodeFlags";
import {
  getDownstreamSpawnTypes,
  isUpstreamConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from "@/features/canvas/domain/nodeRegistry";
import {
  isBeatContextAgentEditablePatch,
  normalizeBeatContextAgentPatch,
  normalizeCanvasCommandCreateNodeData,
  normalizeCanvasCommandNodeData,
} from "@/features/freezone/canvasCommandNodeData";
import type { CanvasEdgeSemanticKind } from "@/features/freezone/canvasEdgeSemantics";
import type { CanvasStoreApi } from "../canvasStore";
import { selectAndFocusNode } from "../selection";
import { syncStoryVideoReferencePrompt } from "../storyVideoReferencePrompt";
import type {
  CanvasChatCommand,
  CanvasChatCommandApplyResult,
  CanvasChatCommandEnvelope,
} from "./types";
import { workflowExternalSourceMismatch } from "./workflowExternalSource";

/** What the executor needs from its host beyond the store. */
export interface CanvasCommandEnvironment {
  /** Resolves a localisation key, used for command receipts. */
  translate(key: string, options?: Record<string, unknown>): string;
  /** Checks every envelope against the current graph before anything is applied. */
  validate(
    envelopes: CanvasChatCommandEnvelope[],
    nodes: CanvasNode[],
    edges: CanvasEdge[],
  ): { ok: boolean; issues: Array<{ path: string; message: string }> };
  /** Runs `callback` once rendered node sizes are known; hosts without a view may skip it. */
  afterNodesMeasured(callback: () => void): void;
  /** Removes a whole mainline projection the host manages outside the store. */
  removeProjection(projectionKey: string): void;
  /** Turns a previz `sceneEdit` batch into the node data to write. */
  landSceneEdit(
    nodeId: string,
    nodeData: Record<string, unknown>,
    sceneEdit: unknown,
  ): Record<string, unknown>;
  /** Called after `update_node_data` writes a node, e.g. to mark generated results stale. */
  onNodeDataUpdated(nodeId: string, changedData: Record<string, unknown>): void;
}

/** Commands that start generation, persist artifacts or open UI, run by host handlers. */
export type HostCanvasCommandType =
  | "html_artifact"
  | "run_node_action"
  | "open_mainline_projection"
  | "run_workflow";

export type CanvasCommandHandlerContext = {
  envelope: CanvasChatCommandEnvelope;
  commandIndex: number;
  result: CanvasChatCommandApplyResult;
  clientIdMap: Map<string, string>;
};

/**
 * A host command handler. It may yield promises; the async driver awaits each
 * one and throws a rejection back into the handler, so the command still gets
 * its error receipt and later commands keep running.
 */
export type CanvasCommandHandler<T extends HostCanvasCommandType> = (
  command: Extract<CanvasChatCommand, { type: T }>,
  context: CanvasCommandHandlerContext,
) => Generator<Promise<void>, void, void>;

export type CanvasCommandHandlers = {
  [T in HostCanvasCommandType]?: CanvasCommandHandler<T>;
} & {
  /** Awaited once after every envelope ran, outside the per-command receipts. */
  finish?: (
    result: CanvasChatCommandApplyResult,
    clientIdMap: Map<string, string>,
  ) => Promise<void>;
};

export type CanvasCommandExecution = Generator<Promise<void>, CanvasChatCommandApplyResult, void>;

const WORKFLOW_LIKE_CREATE_NODE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.videoCompose,
]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nodeById(store: CanvasStoreApi, id: string): CanvasNode | null {
  return store.getState().nodes.find((node) => node.id === id) ?? null;
}

function resolveNodeId(rawId: string, clientIdMap: Map<string, string>): string {
  return clientIdMap.get(rawId) ?? rawId;
}

/** Receipt label for a command. */
export function canvasCommandLabel(
  command: CanvasChatCommand,
  translate: (key: string) => string,
): string {
  switch (command.type) {
    case "html_artifact": return translate("htmlArtifact.saveCommand");
    case "create_node":
      return "创建节点";
    case "add_next_node":
      return "添加下游节点";
    case "update_node_data":
      return "更新节点";
    case "delete_nodes":
      return "删除节点";
    case "clear_canvas":
      return "清空画布";
    case "delete_edges":
      return "断开连接";
    case "create_edge":
      return "创建连接";
    case "layout_nodes":
      return "整理布局";
    case "group_nodes":
      return "创建普通组";
    case "move_nodes":
      return "移动节点";
    case "select_nodes":
      return "选中节点";
    case "run_node_action":
      if (command.action === "translate_text") return "翻译文本";
      if (command.action === "reverse_prompt") return "图片反推提示词";
      if (command.action === "generate_text_video") return "文生视频";
      if (command.action === "generate_story_script") return "生成故事脚本";
      if (command.action === "open_upload_picker") return "打开上传选择";
      if (command.action === "generate_image") return "生成图片";
      if (command.action === "generate_audio") return "生成音频";
      if (command.action === "open_voice_picker") return "打开音色选择";
      if (command.action === "generate_video") return "生成视频";
      if (command.action === "run_skill") return "运行技能";
      if (command.action === "open_video_compose_modal") return "打开视频合成与剪辑";
      if (command.action === "auto_compose_video") return "自动合成视频";
      if (command.action === "open_director_world") return "打开导演世界";
      if (command.action === "generate_3gs_world") return "生成 3GS 世界";
      if (command.action === "open_split_storyboard_tool") return "打开分格抽取";
      if (command.action === "run_matting_tool") return "抠图";
      if (command.action === "run_upscale_tool") return "高清放大";
      if (command.action === "run_outpaint_tool") return "扩图";
      if (command.action === "run_scene360_tool") return "生成 360 全景";
      if (command.action === "run_grid_multi_camera") return "生成多机位九宫格";
      if (command.action === "run_grid_plot_four") return "生成剧情四宫格";
      if (command.action === "run_grid_face_three_view") return "生成面部三视图";
      if (command.action === "run_grid_product_three_view") return "生成产品三视图";
      if (command.action === "run_grid_serial_storyboard_25") return "生成连续分镜 25 格";
      if (command.action === "run_grid_cinematic_light_correction") return "生成电影感光影修正";
      if (command.action === "run_grid_character_three_view") return "生成角色三视图";
      if (command.action === "run_grid_scene_setting_sheet") return "生成场景设定图";
      if (command.action === "run_grid_frame_projection_3s_later") return "推演 3 秒后画面";
      if (command.action === "run_grid_frame_projection_5s_earlier") return "推演 5 秒前画面";
      if (command.action === "open_video_viewer") return "打开视频";
      if (command.action === "download_video") return "下载视频";
      if (command.action === "open_video_clip_tool") return "打开视频剪辑";
      if (command.action === "open_video_upscale_tool") return "打开视频高清";
      if (command.action === "run_video_analyze_story") return "解析视频";
      if (command.action === "run_audio_separate") return "分离音视频";
      if (command.action === "download_audio") return "下载音频";
      if (command.action === "open_video_subtitle_erase_smart") return "智能去字幕";
      if (command.action === "open_video_subtitle_erase_box") return "框选去字幕";
      if (command.action === "run_video_breakdown") return translate("nodeToolbar.video.frameAnalysis");
      if (command.action === "start_video_breakdown") return translate("videoBreakdown.start");
      if (command.action === "open_video_crop_tool") return translate("nodeToolbar.video.frameCrop");
      if (command.action === "open_video_extend_tool") return translate("nodeToolbar.video.extend");
      if (command.action === "run_video_depth_capture") return translate("nodeToolbar.video.motionCapture");
      if (command.action === "capture_pano_current_view") return "截取当前 360 视角";
      if (command.action === "capture_pano_2x2_views") return "截取 360 四视角";
      if (command.action === "capture_pano_4x3_views") return "截取 360 十二视角";
      if (command.action === "download_image") return "下载图片";
      if (command.action === "generate_html") return translate("htmlArtifact.actionGenerate");
      if (command.action === "update_source") return translate("htmlArtifact.actionSaveSource");
      if (command.action === "select_version") return translate("htmlArtifact.actionSelectVersion");
      if (command.action === "restore") return translate("htmlArtifact.actionRestoreVersion");
      if (command.action === "open") return translate("htmlArtifact.actionOpen");
      if (command.action === "export") return translate("htmlArtifact.actionExport");
      if (command.action === "upload") return translate("htmlArtifact.actionUpload");
      if (command.action === "set_pano_current_view_as_background") return "设为当前背景";
      if (command.action === "reset_pano_view") return "复位 360 视角";
      if (command.action === "sync_beat_context_to_mainline") return "同步镜头上下文";
      return "打开节点动作";
    case "open_mainline_projection":
      return "打开主线虾画";
    case "run_workflow":
      return "运行工作流";
    default:
      return "画布操作";
  }
}

function fallbackCreatePosition(store: CanvasStoreApi): { x: number; y: number } {
  const nodes = store.getState().nodes;
  if (nodes.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...nodes.map((node) => node.position.x));
  const minY = Math.min(...nodes.map((node) => node.position.y));
  return { x: maxX + DEFAULT_NODE_WIDTH + 120, y: minY };
}

function chooseNextNodeType(sourceNode: CanvasNode, requestedType?: CanvasNodeType): CanvasNodeType {
  const allowedTypes = getDownstreamSpawnTypes(sourceNode.type);
  if (requestedType) {
    if (!allowedTypes.includes(requestedType)) {
      throw new Error(
        `${sourceNode.type ?? "source node"} cannot directly connect to ${requestedType}. ` +
        `Allowed downstream types: ${allowedTypes.join(", ") || "none"}. ` +
        "Request neighbor_graph and attach to a compatible upstream text/script/beat context source, or create the node standalone.",
      );
    }
    return requestedType;
  }
  return allowedTypes[0] ?? CANVAS_NODE_TYPES.textAnnotation;
}

function connectNodes(
  store: CanvasStoreApi,
  source: string,
  target: string,
  options: {
    link_type?: CanvasEdgeSemanticKind;
    external_input_image_url?: string;
    external_input_video_url?: string;
  } = {},
): string | null {
  if (source === target) throw new Error("connection requires two different nodes");
  const state = store.getState();
  const data: Record<string, unknown> = {};
  if (options.link_type) {
    data.link_type = options.link_type;
  }
  if (options.external_input_image_url) {
    data.workflowExternalInputImageUrl = options.external_input_image_url;
  }
  if (options.external_input_video_url) {
    data.workflowExternalInputVideoUrl = options.external_input_video_url;
  }
  if (Object.keys(data).length > 0) {
    return state.addEdgeWithData(source, target, {
      ...data,
    });
  }
  return state.addEdge(source, target);
}

function invalidConnectionReason(store: CanvasStoreApi, source: string, target: string): string | null {
  if (source === target) return "connection requires two different nodes";
  const sourceNode = nodeById(store, source);
  if (!sourceNode) return `source node not found: ${source}`;
  const targetNode = nodeById(store, target);
  if (!targetNode) return `target node not found: ${target}`;
  if (!nodeHasSourceHandle(sourceNode.type)) {
    return `source node cannot start connections: ${sourceNode.type}`;
  }
  if (!nodeHasTargetHandle(targetNode.type)) {
    return `target node cannot receive connections: ${targetNode.type}`;
  }
  if (!isUpstreamConnectionAllowed(sourceNode.type, targetNode.type)) {
    return `${sourceNode.type} cannot directly connect to ${targetNode.type}`;
  }
  const binding = (sourceNode.data as { storyAssetTarget?: {
    storyId?: unknown; kind?: unknown; entityId?: unknown; segmentIds?: unknown;
  } }).storyAssetTarget;
  if (binding && targetNode.type === CANVAS_NODE_TYPES.video && targetNode.data.storySegmentId) {
    const group = store.getState().nodes.find((node) => node.id === targetNode.parentId);
    const segmentId = targetNode.data.storySegmentId;
    const planned = binding.kind === 'subject'
      ? Array.isArray(targetNode.data.storyCharacterIds) &&
        targetNode.data.storyCharacterIds.includes(binding.entityId as string)
      : binding.kind === 'scene' &&
        Array.isArray((targetNode.data as { storySceneRefs?: unknown }).storySceneRefs) &&
        ((targetNode.data as { storySceneRefs?: Array<{ scene_id?: string }> }).storySceneRefs ?? [])
          .some((ref) => ref.scene_id === binding.entityId);
    if (group?.data.interactiveStoryId !== binding.storyId ||
        !Array.isArray(binding.segmentIds) || !binding.segmentIds.includes(segmentId) || !planned) {
      return `story asset ${source} is not planned for segment ${segmentId}`;
    }
  }
  return null;
}

function isMissingOrFatalConnectionReason(reason: string | null): boolean {
  return Boolean(
    reason?.startsWith("source node not found:") ||
    reason?.startsWith("target node not found:") ||
    reason?.startsWith("story asset ") ||
    reason === "connection requires two different nodes",
  );
}

function deleteEdges(
  store: CanvasStoreApi,
  command: Extract<CanvasChatCommand, { type: "delete_edges" }>,
  clientIdMap: Map<string, string>,
): void {
  const state = store.getState();
  const edgeIds = new Set(command.edge_ids ?? []);
  for (const pair of command.pairs ?? []) {
    const source = resolveNodeId(pair.source, clientIdMap);
    const target = resolveNodeId(pair.target, clientIdMap);
    if (source === target) throw new Error("disconnect requires two different nodes");
    for (const edge of state.edges) {
      if (
        (edge.source === source && edge.target === target) ||
        (edge.source === target && edge.target === source)
      ) {
        edgeIds.add(edge.id);
      }
    }
  }
  if (edgeIds.size === 0) throw new Error("edge not found");
  for (const edgeId of edgeIds) {
    store.getState().deleteEdge(edgeId);
  }
}

function isMainlineProjectionManagedNode(node: CanvasNode): boolean {
  return isPresetManagedNode(node) || isSystemManagedNodeData(node.data);
}

function projectionKeyFromNode(node: CanvasNode): string | null {
  const data = node.data as { projection_key?: unknown } | undefined;
  return typeof data?.projection_key === "string" && data.projection_key.trim()
    ? data.projection_key.trim()
    : null;
}

function deleteNodesOrEdges(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  rawIds: string[],
  clientIdMap: Map<string, string>,
): { removedNodeCount: number; removedEdgeCount: number; projectionRemovalCount: number } {
  const state = store.getState();
  if (rawIds.length === 0) throw new Error("delete_nodes requires at least one node or edge id");
  const beforeNodeIds = new Set(state.nodes.map((node) => node.id));
  const beforeEdgeIds = new Set(state.edges.map((edge) => edge.id));
  const edgeIds = new Set(state.edges.map((edge) => edge.id));
  const nodesById = new Map(state.nodes.map((node) => [node.id, node] as const));
  const nodeIds: string[] = [];
  const edgeIdsToDelete: string[] = [];
  const projectionNodeIdsByKey = new Map<string, Set<string>>();
  for (const rawId of rawIds) {
    const id = resolveNodeId(rawId, clientIdMap);
    if (edgeIds.has(id)) {
      edgeIdsToDelete.push(id);
    } else {
      const node = nodesById.get(id);
      if (node && isMainlineProjectionManagedNode(node)) {
        const projectionKey = projectionKeyFromNode(node);
        if (!projectionKey) {
          throw new Error(`node is mainline projection managed and cannot be deleted directly: ${id}`);
        }
        let ids = projectionNodeIdsByKey.get(projectionKey);
        if (!ids) {
          ids = new Set<string>();
          projectionNodeIdsByKey.set(projectionKey, ids);
        }
        ids.add(id);
        continue;
      }
      nodeIds.push(id);
    }
  }
  for (const [projectionKey, requestedIds] of projectionNodeIdsByKey) {
    const allProjectionNodeIds = state.nodes
      .filter((node) => projectionKeyFromNode(node) === projectionKey)
      .map((node) => node.id);
    const hasWholeProjection = allProjectionNodeIds.every((id) => requestedIds.has(id));
    if (!hasWholeProjection) {
      const firstRequestedId = requestedIds.values().next().value ?? projectionKey;
      throw new Error(`node is mainline projection managed and cannot be deleted directly: ${firstRequestedId}`);
    }
  }
  if (nodeIds.length > 0) {
    store.getState().deleteNodes(nodeIds);
  }
  for (const edgeId of edgeIdsToDelete) {
    store.getState().deleteEdge(edgeId);
  }
  for (const projectionKey of projectionNodeIdsByKey.keys()) {
    env.removeProjection(projectionKey);
  }

  const after = store.getState();
  const removedNode = [...beforeNodeIds].some(
    (id) => !after.nodes.some((node) => node.id === id),
  );
  const removedEdge = [...beforeEdgeIds].some(
    (id) => !after.edges.some((edge) => edge.id === id),
  );
  if (!removedNode && !removedEdge && projectionNodeIdsByKey.size === 0) {
    throw new Error("没有删除任何节点或连接；请确认节点 id 正确且节点允许删除");
  }
  return {
    removedNodeCount: [...beforeNodeIds].filter(
      (id) => !after.nodes.some((node) => node.id === id),
    ).length,
    removedEdgeCount: [...beforeEdgeIds].filter(
      (id) => !after.edges.some((edge) => edge.id === id),
    ).length,
    projectionRemovalCount: projectionNodeIdsByKey.size,
  };
}

type LayoutMode = "horizontal" | "vertical" | "grid";

function layoutNodesInternal(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  nodeIds: string[],
  mode: LayoutMode,
  refineAfterMeasurement = true,
  hermesLegacy = false,
): void {
  const state = store.getState();
  const nodesById = new Map(state.nodes.map((node) => [node.id, node] as const));
  const nodes = nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is CanvasNode => Boolean(node));
  if (nodes.length < 2) return;
  const needsMeasuredRefinement =
    !hermesLegacy &&
    refineAfterMeasurement &&
    nodes.some(
      (node) =>
        typeof node.measured?.width !== "number" ||
        typeof node.measured?.height !== "number",
    );
  const refineAfterMeasure = () => env.afterNodesMeasured(() => {
    layoutNodes(store, env, nodeIds, mode, false, hermesLegacy);
  });

  // External MCP workflows use the exact legacy Hermes geometry and preserve
  // the node_ids command order. Hermes websocket commands keep the existing
  // adaptive frontend layout path below.
  if (hermesLegacy) {
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    state.setNodePositions(Object.fromEntries(nodes.map((node, index) => {
      if (mode === "vertical") {
        return [node.id, { x: minX, y: minY + index * 320 }];
      }
      if (mode === "grid") {
        return [node.id, {
          x: minX + (index % columns) * 520,
          y: minY + Math.floor(index / columns) * 360,
        }];
      }
      return [node.id, { x: minX + index * 520, y: minY }];
    })));
    return;
  }

  const parentIds = new Set(nodes.map((node) => node.parentId).filter(Boolean));
  if (parentIds.size === 1) {
    const groupId = [...parentIds][0] as string;
    const group = nodesById.get(groupId);
    const targetIds = new Set(nodes.map((node) => node.id));
    const groupChildren = state.nodes.filter((node) => node.parentId === groupId);
    const targetsWholePlainGroup =
      isGroupNode(group) &&
      !isProtectedProjectionGroupNode(group) &&
      !isStoryboardGroupNode(group) &&
      groupChildren.length === targetIds.size &&
      groupChildren.every((node) => targetIds.has(node.id));
    if (targetsWholePlainGroup) {
      state.arrangeGroupChildren(groupId, mode);
      if (needsMeasuredRefinement) {
        refineAfterMeasure();
      }
      return;
    }
  }

  const ordered = nodes;
  const minX = Math.min(...ordered.map((node) => node.position.x));
  const minY = Math.min(...ordered.map((node) => node.position.y));
  const positions: Record<string, { x: number; y: number }> = {};
  const gap = 48;
  if (mode === "horizontal") {
    ordered.forEach((node, index) => {
      positions[node.id] = { x: minX + index * (DEFAULT_NODE_WIDTH + gap), y: minY };
    });
  } else if (mode === "vertical") {
    ordered.forEach((node, index) => {
      positions[node.id] = { x: minX, y: minY + index * 360 };
    });
  } else {
    const cols = Math.ceil(Math.sqrt(ordered.length));
    ordered.forEach((node, index) => {
      positions[node.id] = {
        x: minX + (index % cols) * (DEFAULT_NODE_WIDTH + gap),
        y: minY + Math.floor(index / cols) * 360,
      };
    });
  }
  state.setNodePositions(positions);
  if (needsMeasuredRefinement) {
    refineAfterMeasure();
  }
}

function placeWorkflowGroups(store: CanvasStoreApi, groupIds: ReadonlySet<string>): void {
  const state = store.getState();
  const placed = placeGroupsOutsideStory(state.nodes, groupIds);
  if (placed === state.nodes) return;
  const positions: Record<string, { x: number; y: number }> = {};
  placed.forEach((node, index) => {
    if (node.position !== state.nodes[index].position) positions[node.id] = node.position;
  });
  state.setNodePositions(positions);
}

function layoutNodes(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  nodeIds: string[],
  mode: LayoutMode,
  refineAfterMeasurement = true,
  hermesLegacy = false,
): void {
  layoutNodesInternal(store, env, nodeIds, mode, refineAfterMeasurement, hermesLegacy);
  const nodesById = new Map(store.getState().nodes.map((node) => [node.id, node]));
  const rootIds = new Set<string>();
  for (const nodeId of nodeIds) {
    let node = nodesById.get(nodeId);
    const visited = new Set<string>();
    while (node?.parentId && !visited.has(node.id)) {
      visited.add(node.id);
      node = nodesById.get(node.parentId);
    }
    if (node && !node.parentId) rootIds.add(node.id);
  }
  placeWorkflowGroups(store, rootIds);
}

function moveNodes(
  store: CanvasStoreApi,
  command: Extract<CanvasChatCommand, { type: "move_nodes" }>,
  clientIdMap: Map<string, string>,
): void {
  const nodes = store.getState().nodes;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const existingNodeIds = new Set(nodesById.keys());
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [rawNodeId, position] of Object.entries(command.positions ?? {})) {
    const nodeId = resolveNodeId(rawNodeId, clientIdMap);
    if (!existingNodeIds.has(nodeId)) {
      throw new Error(`node not found: ${rawNodeId}`);
    }
    positions[nodeId] = position;
  }
  for (const [rawNodeId, delta] of Object.entries(command.deltas ?? {})) {
    const nodeId = resolveNodeId(rawNodeId, clientIdMap);
    const node = nodesById.get(nodeId);
    if (!node) {
      throw new Error(`node not found: ${rawNodeId}`);
    }
    const base = positions[nodeId] ?? node.position;
    positions[nodeId] = {
      x: base.x + delta.x,
      y: base.y + delta.y,
    };
  }
  if (Object.keys(positions).length === 0) {
    return;
  }
  store.getState().setNodePositions(positions);
}

function selectNodes(
  store: CanvasStoreApi,
  rawNodeIds: string[],
  clientIdMap: Map<string, string>,
  focus = true,
): void {
  const state = store.getState();
  const nodesById = new Map(state.nodes.map((node) => [node.id, node] as const));
  const existingNodeIds = new Set(nodesById.keys());
  const nodeIds = rawNodeIds.map((nodeId) => resolveNodeId(nodeId, clientIdMap));
  for (const nodeId of nodeIds) {
    if (!existingNodeIds.has(nodeId)) throw new Error(`node not found: ${nodeId}`);
  }

  const selectedSet = new Set(nodeIds);
  state.onNodesChange(
    state.nodes.map((node) => ({
      id: node.id,
      type: "select" as const,
      selected: selectedSet.has(node.id),
    })),
  );
  state.setSelectedNode(nodeIds.length === 1 ? nodeIds[0] ?? null : null);
  if (focus && nodeIds[0]) {
    // Group members store positions relative to their parent. Immediately after
    // a workflow batch, React Flow may not have mounted the child yet, so its
    // absolute position is unavailable and focusing it can pan to empty space.
    // Focus the outermost group instead; its position is always canvas-absolute.
    let focusNodeId = nodeIds[0];
    const visited = new Set<string>();
    while (!visited.has(focusNodeId)) {
      visited.add(focusNodeId);
      const parentId = nodesById.get(focusNodeId)?.parentId;
      if (!parentId || !nodesById.has(parentId)) break;
      focusNodeId = parentId;
    }
    state.requestFocusNode(focusNodeId);
  }
}

function commandPrimaryNodeId(command: CanvasChatCommand): string | undefined {
  switch (command.type) {
    case "update_node_data":
    case "run_node_action":
      return command.node_id;
    case "run_workflow":
      return command.node_ids?.[0];
    case "clear_canvas":
      return undefined;
    case "add_next_node":
      return command.source_node_id;
    case "delete_nodes":
    case "layout_nodes":
    case "group_nodes":
    case "select_nodes":
      return command.node_ids?.[0];
    case "create_edge":
      return command.source;
    case "delete_edges":
      return command.pairs?.[0]?.source ?? command.edge_ids?.[0];
    case "move_nodes":
      return Object.keys(command.positions ?? {})[0] ?? Object.keys(command.deltas ?? {})[0];
    case "create_node":
      return command.client_id;
    default:
      return undefined;
  }
}

function commandNodeRefs(command: CanvasChatCommand): string[] {
  switch (command.type) {
    case "update_node_data":
    case "run_node_action":
      return [command.node_id];
    case "run_workflow":
      return command.node_ids ?? [];
    case "clear_canvas":
      return [];
    case "delete_nodes":
    case "layout_nodes":
    case "group_nodes":
    case "select_nodes":
      return command.node_ids ?? [];
    case "delete_edges":
      return (command.pairs ?? []).flatMap((pair) => [pair.source, pair.target]);
    case "create_edge":
      return [command.source, command.target];
    case "move_nodes":
      return [
        ...Object.keys(command.positions ?? {}),
        ...Object.keys(command.deltas ?? {}),
      ];
    case "add_next_node":
      return [command.source_node_id];
    case "create_node":
      return [];
    default:
      return [];
  }
}

/**
 * 规范化时给未带 client_id 的新建命令补的合成 id 前缀。审批卡按 client_id 收集并改写
 * 新节点的生成参数，执行器再用同一个 id 找回建出的节点；没有它，这类节点在审批阶段
 * 无法被识别（#685）。格式不匹配 Agent 可引用的 `auto:N`，不会与其混淆。
 */
const GENERATED_CLIENT_ID_PREFIX = "auto:new:";

export function isGeneratedCanvasClientId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith(GENERATED_CLIENT_ID_PREFIX);
}

/**
 * Gives every create command a `client_id` so later commands, the approval card
 * and the validator can refer to the node before it exists.
 */
export function normalizeCanvasCommandEnvelopes(
  envelopes: CanvasChatCommandEnvelope[],
  existingNodeIds: Iterable<string>,
): CanvasChatCommandEnvelope[] {
  const baseNodeIds = new Set(existingNodeIds);

  return envelopes.map((envelope, envelopeIndex) => {
    const knownRefs = new Set(baseNodeIds);
    const referencedAutoClientIds = new Set(
      envelope.commands
        .flatMap((command) => commandNodeRefs(command))
        .filter((ref) => /^auto:\d+$/i.test(ref.trim())),
    );
    let nextAutoClientIndex = 0;

    const nextReferencedAutoClientId = (): string | null => {
      while (referencedAutoClientIds.has(`auto:${nextAutoClientIndex}`)) {
        const clientId = `auto:${nextAutoClientIndex}`;
        nextAutoClientIndex += 1;
        if (!knownRefs.has(clientId)) return clientId;
      }
      return null;
    };
    const commands = envelope.commands.map((command, index) => {
      if (command.type !== "create_node" && command.type !== "add_next_node") {
        for (const ref of commandNodeRefs(command)) knownRefs.add(ref);
        return command;
      }

      if (command.client_id) {
        knownRefs.add(command.client_id);
        return command;
      }

      const autoClientId = nextReferencedAutoClientId();
      if (autoClientId) {
        knownRefs.add(autoClientId);
        return {
          ...command,
          client_id: autoClientId,
        };
      }

      const nextCommand = envelope.commands[index + 1];
      const nextUnknownRefs = nextCommand
        ? [...new Set(commandNodeRefs(nextCommand))]
          .filter((ref) => ref.trim().length > 0 && !knownRefs.has(ref))
        : [];
      if (nextUnknownRefs.length !== 1) {
        const generatedClientId = `${GENERATED_CLIENT_ID_PREFIX}${envelopeIndex}:${index}`;
        knownRefs.add(generatedClientId);
        return {
          ...command,
          client_id: generatedClientId,
        };
      }

      const clientId = nextUnknownRefs[0];
      knownRefs.add(clientId);
      return {
        ...command,
        client_id: clientId,
      };
    });

    return {
      ...envelope,
      commands,
    };
  });
}

function workflowNodeIdentity(
  data: Partial<CanvasNodeData> | undefined,
): { instanceId: string; planNodeId: string } | null {
  const instanceId = nonEmptyString(data?.workflowInstanceId);
  const planNodeId = nonEmptyString(data?.workflowPlanNodeId);
  return instanceId && planNodeId ? { instanceId, planNodeId } : null;
}

function existingWorkflowNodeForCommand(
  store: CanvasStoreApi,
  command: Extract<CanvasChatCommand, { type: "create_node" }>,
): CanvasNode | null {
  const identity = workflowNodeIdentity(command.data);
  if (!identity) return null;
  return store.getState().nodes.find((node) => {
    const current = workflowNodeIdentity(node.data);
    return (
      current?.instanceId === identity.instanceId &&
      current.planNodeId === identity.planNodeId
    );
  }) ?? null;
}

function workflowEnvelopeAlreadyApplied(
  store: CanvasStoreApi,
  envelope: CanvasChatCommandEnvelope,
): boolean {
  const createCommands = envelope.commands.filter(
    (command): command is Extract<CanvasChatCommand, { type: "create_node" }> =>
      command.type === "create_node" && workflowNodeIdentity(command.data) !== null,
  );
  return (
    createCommands.length > 0 &&
    createCommands.every((command) => existingWorkflowNodeForCommand(store, command) !== null) &&
    envelope.commands.every((command) => {
      if (command.type !== "html_artifact" || command.action !== "prepare") return true;
      const identity = workflowNodeIdentity(command.workflow_data);
      return identity !== null && store.getState().nodes.some((node) => (
        node.type === CANVAS_NODE_TYPES.htmlArtifact &&
        node.data.workflowInstanceId === identity.instanceId &&
        node.data.workflowPlanNodeId === identity.planNodeId
      ));
    })
  );
}

function isStoryImageReferenceEnvelope(
  store: CanvasStoreApi,
  envelope: CanvasChatCommandEnvelope,
): boolean {
  const creates = envelope.commands.filter((command) => command.type === "create_node");
  const edges = envelope.commands.filter((command) => command.type === "create_edge");
  if (!creates.length || !edges.length || creates.some((command) =>
    command.node_type !== CANVAS_NODE_TYPES.imageGen || !command.client_id
  )) return false;
  const aliases = new Set(creates.map((command) => command.client_id));
  if (aliases.size !== creates.length) return false;
  const nodes = store.getState().nodes;
  const storyIds = new Set<string>();
  for (const edge of edges) {
    if (edge.link_type !== "media_input_for" || !aliases.has(edge.source)) return false;
    const target = nodes.find((node) => node.id === edge.target);
    if (target?.type !== CANVAS_NODE_TYPES.video ||
      typeof target.data.storySegmentId !== "string" || !target.data.storySegmentId.trim()
    ) return false;
    const group = nodes.find((node) => node.id === target.parentId);
    if (group?.data.storyGroup !== true ||
      typeof group.data.interactiveStoryId !== "string" || !group.data.interactiveStoryId.trim()
    ) return false;
    storyIds.add(group.data.interactiveStoryId);
  }
  for (const command of envelope.commands) {
    if (command.type !== "update_node_data") continue;
    const target = nodes.find((node) => node.id === command.node_id);
    const group = nodes.find((node) => node.id === target?.parentId);
    if (target?.type !== CANVAS_NODE_TYPES.video ||
      typeof target.data.storySegmentId !== "string" ||
      group?.data.storyGroup !== true ||
      !storyIds.has(String(group.data.interactiveStoryId ?? ""))
    ) return false;
  }
  return storyIds.size === 1 && creates.every((command) =>
    edges.some((edge) => edge.source === command.client_id)
  );
}

function syncReferencePromptsAfterEdgeRemoval(
  store: CanvasStoreApi,
  previousEdges: CanvasEdge[],
): void {
  const remainingIds = new Set(store.getState().edges.map((edge) => edge.id));
  for (const targetId of new Set(previousEdges
    .filter((edge) => !remainingIds.has(edge.id)).map((edge) => edge.target))) {
    syncStoryVideoReferencePrompt(store, targetId);
  }
}

/**
 * Validates and applies command envelopes to `store`.
 *
 * The generator yields only from host handlers. Drive it with
 * `applyCanvasCommandsNow` when no handler can wait, or await each yielded
 * promise and throw rejections back in with `execution.throw(error)`.
 */
export function* applyCanvasCommands(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  envelopes: CanvasChatCommandEnvelope[],
  handlers: CanvasCommandHandlers = {},
): CanvasCommandExecution {
  const result: CanvasChatCommandApplyResult = {
    applied: 0,
    openedUiActions: 0,
    createdNodeIds: [],
    errors: [],
    commandResults: [],
  };
  const label = (command: CanvasChatCommand) => canvasCommandLabel(command, env.translate);
  const normalizedEnvelopes = normalizeCanvasCommandEnvelopes(
    envelopes,
    store.getState().nodes.map((node) => node.id),
  );
  const validation = env.validate(
    normalizedEnvelopes,
    store.getState().nodes,
    store.getState().edges,
  );
  if (!validation.ok) {
    result.errors.push(...validation.issues.map((issue) => `${issue.path}: ${issue.message}`));
    result.commandResults.push({
      commandIndex: -1,
      type: "validate",
      status: "error",
      label: "校验画布命令",
      error: result.errors.join("; "),
    });
    return result;
  }
  const clientIdMap = new Map<string, string>();
  let commandIndex = 0;

  for (const envelope of normalizedEnvelopes) {
    if (workflowEnvelopeAlreadyApplied(store, envelope)) {
      for (const command of envelope.commands) {
        result.applied += 1;
        result.commandResults.push({
          commandIndex,
          type: command.type,
          status: "success",
          label: "工作流已存在，跳过重复创建",
          nodeId: commandPrimaryNodeId(command),
          output: {
            skipped: true,
            reason: "workflow_instance_already_applied",
          },
        });
        commandIndex += 1;
      }
      continue;
    }
    const existingEnvelopeNodeIds = new Set(store.getState().nodes.map((node) => node.id));
    const envelopeCreatedNodeIds: string[] = [];
    const storyImageReferenceEnvelope = isStoryImageReferenceEnvelope(store, envelope);
    const envelopeSourceNodeIds = new Set<string>();
    const envelopeErrorStart = result.errors.length;
    let envelopeHasAddNextNode = false;
    let envelopeAddNextCreatedCount = 0;
    let envelopeHasExplicitGroupNodes = false;

    for (const command of envelope.commands) {
      const currentCommandIndex = commandIndex;
      commandIndex += 1;
      try {
        switch (command.type) {
          case "html_artifact":
          case "run_node_action":
          case "open_mainline_projection":
          case "run_workflow": {
            const handler = handlers[command.type] as
              | CanvasCommandHandler<typeof command.type>
              | undefined;
            if (!handler) throw new Error(`${command.type} is not available in this environment`);
            yield* handler(command, {
              envelope,
              commandIndex: currentCommandIndex,
              result,
              clientIdMap,
            });
            break;
          }
          case "create_node": {
            const existingWorkflowNode = existingWorkflowNodeForCommand(store, command);
            if (existingWorkflowNode) {
              if (command.client_id) {
                clientIdMap.set(command.client_id, existingWorkflowNode.id);
              }
              result.applied += 1;
              result.commandResults.push({
                commandIndex: currentCommandIndex,
                type: command.type,
                status: "success",
                label: "复用已有工作流节点",
                nodeId: command.client_id,
                createdNodeId: existingWorkflowNode.id,
                output: {
                  skipped: true,
                  reason: "workflow_node_already_applied",
                },
              });
              break;
            }
            const data = normalizeCanvasCommandCreateNodeData(command.node_type, command.data);
            const nodeId = store.getState().addNode(
              command.node_type,
              command.position ?? fallbackCreatePosition(store),
              data,
            );
            if (command.client_id) clientIdMap.set(command.client_id, nodeId);
            result.createdNodeIds.push(nodeId);
            envelopeCreatedNodeIds.push(nodeId);
            selectAndFocusNode(store, nodeId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: command.client_id,
              createdNodeId: nodeId,
            });
            break;
          }
          case "add_next_node": {
            const sourceId = resolveNodeId(command.source_node_id, clientIdMap);
            const sourceNode = nodeById(store, sourceId);
            if (!sourceNode) throw new Error(`source node not found: ${command.source_node_id}`);
            const nodeType = chooseNextNodeType(sourceNode, command.node_type);
            const position = store.getState().findNodePosition(sourceId, DEFAULT_NODE_WIDTH, 320);
            const data = inheritMainlineFields(
              sourceNode as { data: MainlineFieldsSource },
              normalizeCanvasCommandCreateNodeData(nodeType, command.data),
            );
            const nodeId = store.getState().addNode(nodeType, position, data);
            if (command.client_id) clientIdMap.set(command.client_id, nodeId);
            if (command.connect) {
              connectNodes(store, sourceId, nodeId);
            }
            result.createdNodeIds.push(nodeId);
            envelopeCreatedNodeIds.push(nodeId);
            envelopeSourceNodeIds.add(sourceId);
            envelopeHasAddNextNode = true;
            envelopeAddNextCreatedCount += 1;
            selectAndFocusNode(store, nodeId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: command.source_node_id,
              createdNodeId: nodeId,
            });
            break;
          }
          case "update_node_data": {
            const targetId = resolveNodeId(command.node_id, clientIdMap);
            const targetNode = nodeById(store, targetId);
            if (!targetNode) throw new Error(`node not found: ${command.node_id}`);
            const data = normalizeCanvasCommandNodeData(targetNode.type, command.data);
            if (isPresetManagedNode(targetNode)) {
              if (targetNode.type !== CANVAS_NODE_TYPES.beatContext || !isBeatContextAgentEditablePatch(data)) {
                throw new Error(`node is preset managed: ${command.node_id}`);
              }
              store.getState().updateNodeData(
                targetId,
                normalizeBeatContextAgentPatch(targetNode.data as BeatContextNodeData, data),
              );
            } else if (targetNode.type === CANVAS_NODE_TYPES.previz && "sceneEdit" in data) {
              // sceneEdit 是一批操作而不是一个字段：换算成新场景再写，不把它本身存进节点。
              const { sceneEdit, ...rest } = data as Record<string, unknown>;
              store.getState().updateNodeData(targetId, {
                ...rest,
                ...env.landSceneEdit(targetId, targetNode.data as Record<string, unknown>, sceneEdit),
              } as Partial<CanvasNodeData>);
            } else {
              store.getState().updateNodeData(targetId, data);
            }
            if (targetNode.type === CANVAS_NODE_TYPES.video) {
              syncStoryVideoReferencePrompt(store, targetId);
            }
            env.onNodeDataUpdated(targetId, data);
            selectAndFocusNode(store, targetId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: targetId,
            });
            break;
          }
          case "delete_nodes": {
            const previousEdges = store.getState().edges;
            const deletion = deleteNodesOrEdges(
              store,
              env,
              command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap)),
              clientIdMap,
            );
            syncReferencePromptsAfterEdgeRemoval(store, previousEdges);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: command.node_ids[0],
              output: deletion,
            });
            break;
          }
          case "clear_canvas": {
            const state = store.getState();
            const deletableNodeIds = state.nodes
              .filter((node) => !isMainlineProjectionManagedNode(node))
              .map((node) => node.id);
            const edgeIds = state.edges.map((edge) => edge.id);
            if (deletableNodeIds.length === 0 && edgeIds.length === 0) {
              throw new Error("画布中没有可清空的普通节点或连接");
            }
            const deletion = deleteNodesOrEdges(
              store,
              env,
              [...deletableNodeIds, ...edgeIds],
              clientIdMap,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              output: deletion,
            });
            break;
          }
          case "delete_edges": {
            const previousEdges = store.getState().edges;
            deleteEdges(store, command, clientIdMap);
            syncReferencePromptsAfterEdgeRemoval(store, previousEdges);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: commandPrimaryNodeId(command),
            });
            break;
          }
          case "create_edge": {
            const source = resolveNodeId(command.source, clientIdMap);
            const target = resolveNodeId(command.target, clientIdMap);
            const sourceMismatch = workflowExternalSourceMismatch(
              store.getState().nodes.find((node) => node.id === source),
              source,
              { imageUrl: command.expected_source_image_url, videoUrl: command.expected_source_video_url },
            );
            if (sourceMismatch) throw new Error(sourceMismatch);
            const invalidReason = invalidConnectionReason(store, source, target);
            if (invalidReason) {
              if (isMissingOrFatalConnectionReason(invalidReason)) throw new Error(invalidReason);
              result.commandResults.push({
                commandIndex: currentCommandIndex,
                type: command.type,
                status: "success",
                label: "跳过无效连接",
                nodeId: source,
                error: invalidReason,
              });
              break;
            }
            const edgeId = connectNodes(store, source, target, {
              link_type: command.link_type,
              external_input_image_url: command.expected_source_image_url,
              external_input_video_url: command.expected_source_video_url,
            });
            if (!edgeId) throw new Error(`edge rejected: ${command.source} -> ${command.target}`);
            syncStoryVideoReferencePrompt(store, target);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: source,
            });
            break;
          }
          case "layout_nodes": {
            const targetNodeIds = (command.node_ids && command.node_ids.length > 0)
              ? command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap))
              : store.getState().nodes.map((node) => node.id);
            layoutNodes(
              store,
              env,
              targetNodeIds,
              command.mode,
              true,
              envelope.external_mcp_command === true,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: targetNodeIds[0],
            });
            break;
          }
          case "group_nodes": {
            envelopeHasExplicitGroupNodes = true;
            const targetNodeIds = command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap));
            const groupId = store.getState().groupNodes(targetNodeIds, {
              label: command.label,
              ...(envelope.external_mcp_command === true
                ? { padding: { side: 60, top: 80, bottom: 80 } }
                : { extraPadding: 20 }),
            });
            if (!groupId) throw new Error("group requires at least two existing nodes");
            result.applied += 1;
            result.createdNodeIds.push(groupId);
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: targetNodeIds[0],
              createdNodeId: groupId,
            });
            break;
          }
          case "move_nodes": {
            moveNodes(store, command, clientIdMap);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: commandPrimaryNodeId(command),
            });
            break;
          }
          case "select_nodes": {
            selectNodes(
              store,
              command.node_ids,
              clientIdMap,
              command.focus,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: label(command),
              nodeId: command.node_ids[0],
            });
            break;
          }
          default:
            break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(message);
        result.commandResults.push({
          commandIndex: currentCommandIndex,
          type: command.type,
          status: "error",
          label: label(command),
          nodeId: commandPrimaryNodeId(command),
          action: command.type === "run_node_action" ? command.action : undefined,
          error: message,
        });
      }
    }

    if (
      !envelopeHasExplicitGroupNodes &&
      envelopeHasAddNextNode &&
      result.errors.length === envelopeErrorStart &&
      envelopeAddNextCreatedCount >= 2
    ) {
      const targetNodeIds = [...new Set([...envelopeSourceNodeIds, ...envelopeCreatedNodeIds])];
      const groupId = store.getState().groupNodes(targetNodeIds, {
        label: "工作流组",
        extraPadding: 20,
      });
      if (groupId) {
        result.applied += 1;
        result.createdNodeIds.push(groupId);
        result.commandResults.push({
          commandIndex,
          type: "group_nodes",
          status: "success",
          label: "创建普通组",
          nodeId: targetNodeIds[0],
          createdNodeId: groupId,
        });
        commandIndex += 1;
      }
    }
    if (
      !envelopeHasExplicitGroupNodes &&
      !envelopeHasAddNextNode &&
      !storyImageReferenceEnvelope &&
      result.errors.length === envelopeErrorStart &&
      envelopeCreatedNodeIds.length >= 2 &&
      envelope.commands.some((command) =>
        command.type === "create_node" && WORKFLOW_LIKE_CREATE_NODE_TYPES.has(command.node_type),
      )
    ) {
      const targetNodeIds = [...new Set(envelopeCreatedNodeIds)];
      const groupId = store.getState().groupNodes(targetNodeIds, {
        label: "工作流组",
        extraPadding: 20,
      });
      if (groupId) {
        result.applied += 1;
        result.createdNodeIds.push(groupId);
        result.commandResults.push({
          commandIndex,
          type: "group_nodes",
          status: "success",
          label: "创建普通组",
          nodeId: targetNodeIds[0],
          createdNodeId: groupId,
        });
        commandIndex += 1;
      }
    }
    // Grouping and layout can enlarge a workflow far beyond its initial node
    // positions. Reserve space using the final group bounds before generation.
    placeWorkflowGroups(store, new Set(store.getState().nodes
      .filter((node) => !existingEnvelopeNodeIds.has(node.id) && isGroupNode(node))
      .map((node) => node.id)));
  }

  if (handlers.finish) {
    yield handlers.finish(result, clientIdMap);
  }

  result.errors = dedupeGenerationErrors(result.errors);
  return result;
}

/** Runs `applyCanvasCommands` to completion; fails if a handler needs to wait. */
export function applyCanvasCommandsNow(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  envelopes: CanvasChatCommandEnvelope[],
  handlers: CanvasCommandHandlers = {},
): CanvasChatCommandApplyResult {
  const step = applyCanvasCommands(store, env, envelopes, handlers).next();
  if (!step.done) throw new Error("Synchronous canvas execution cannot await commands");
  return step.value;
}

/** Runs `applyCanvasCommands`, awaiting each handler promise in command order. */
export async function applyCanvasCommandsAsync(
  store: CanvasStoreApi,
  env: CanvasCommandEnvironment,
  envelopes: CanvasChatCommandEnvelope[],
  handlers: CanvasCommandHandlers = {},
): Promise<CanvasChatCommandApplyResult> {
  const execution = applyCanvasCommands(store, env, envelopes, handlers);
  let step = execution.next();
  while (!step.done) {
    try {
      await step.value;
    } catch (error) {
      // Re-enter the original command's catch to retain its error receipt and
      // continue independent commands without replaying successful mutations.
      step = execution.throw(error);
      continue;
    }
    step = execution.next();
  }
  return step.value;
}
