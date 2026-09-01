import type { ChatAttachment } from "@/features/superchat/types";
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasOntologySummary,
  deriveCanvasOntologyLink,
  type CanvasOntologyContext,
} from "@/features/canvas/ontology/canvasOntology";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";
import {
  buildCanvasNodeActionCatalog,
  type CanvasNodeActionCatalog,
} from "@/features/freezone/canvasNodeActionCatalog";
import {
  AGENT_CREATABLE_CANVAS_NODE_TYPES,
  isAgentCreatableCanvasNodeType,
} from "@/features/freezone/agentCreatableNodeTypes";
import {
  buildCanvasActionCatalog,
  BASE_CANVAS_ACTION_CAPABILITIES,
} from "@/features/freezone/context/canvasActionCatalog";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import {
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  normalizeCanvasChatCommandEnvelopesForValidation,
  type CanvasChatCommandEnvelope,
} from "@/features/freezone/canvasChatCommands";
import {
  fetchFreezoneAudioReferences,
  type FreezoneAudioReferenceItem,
  type FreezoneAudioVoiceRef,
} from "@/api/ops";
import type { FreezoneProjectAsset } from "@/api/projects";
import { canvasLinkTypeCatalogJson } from "@/features/freezone/canvasEdgeSemantics";
import { assetToPushTarget } from "@/features/freezone/commit/pushTarget";
import { personalCanvasIdForUsername } from "@/features/freezone/projections";
import { useAuthStore } from "@/stores/auth-store";

export const CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE = "canvas_node_reference";
export const CANVAS_NODE_REFERENCE_SCHEMA_VERSION = "canvas_node_reference.v1";
export const CANVAS_CONTEXT_REQUEST_SCHEMA_VERSION =
  "canvas_context_request.v1";

type CanvasNodeReferenceItem = {
  node_id: string;
  node_type: string | null;
  label: string;
  text_field: "content" | "prompt" | "text" | null;
  text_content: string | null;
  media_type: string | null;
  source_url: string | null;
  preview_url: string | null;
  slot_target: unknown;
  mainline_context: unknown;
  candidate_origin: unknown;
  position: { x: number; y: number };
  action_catalog: CanvasNodeActionCatalog & Record<string, unknown>;
};

type CanvasEdgeReferenceItem = {
  edge_id: string;
  source: string;
  target: string;
  source_handle: string | null;
  target_handle: string | null;
  link_type: string | null;
};

type CanvasNodeReferenceMediaItem = {
  mention: string;
  node_id: string;
  label: string;
  media_type: "image" | "video" | "audio";
  source_url: string;
  preview_url: string | null;
  link_type: string | null;
};

type CanvasNodeReferencePayload = {
  schema_version: typeof CANVAS_NODE_REFERENCE_SCHEMA_VERSION;
  project: string;
  canvas_id: string;
  display_nodes?: CanvasNodeReferenceItem[];
  nodes: CanvasNodeReferenceItem[];
  edges: CanvasEdgeReferenceItem[];
};

export type CanvasContextRequest =
  | { type: "canvas_ontology" }
  | { type: "canvas_summary" }
  | { type: "canvas_action_catalog" }
  | { type: "canvas_command_catalog" }
  | { type: "link_type_catalog" }
  | { type: "validate_canvas_commands"; payload?: unknown }
  | { type: "node_detail"; node_id?: string }
  | { type: "neighbor_graph"; node_id?: string; depth?: number }
  | { type: "node_action_catalog"; node_id?: string; action?: string }
  | { type: "action_catalog"; node_id?: string; action?: string }
  | { type: "action_catalog_by_id"; action_id?: string }
  | { type: "node_create_schema"; node_type?: CanvasNodeType }
  | { type: "audio_voice_options"; node_id?: string }
  | { type: "slot_candidates"; slot_kind?: string }
  | {
      type: "mainline_projection_assets";
      asset_kinds?: string[];
      query?: string;
      limit?: number;
    }
  | { type: "selection_detail" };

export type CanvasContextRequestEnvelope = {
  schema_version: typeof CANVAS_CONTEXT_REQUEST_SCHEMA_VERSION;
  requests: CanvasContextRequest[];
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nodeMediaType(node: CanvasNode): string | null {
  if (node.type === CANVAS_NODE_TYPES.video) return "video";
  if (node.type === CANVAS_NODE_TYPES.audio) return "audio";
  if (node.type === CANVAS_NODE_TYPES.threeDWorld) return "model";
  if (
    node.type === CANVAS_NODE_TYPES.upload ||
    node.type === CANVAS_NODE_TYPES.imageEdit ||
    node.type === CANVAS_NODE_TYPES.imageGen ||
    node.type === CANVAS_NODE_TYPES.exportImage ||
    node.type === CANVAS_NODE_TYPES.pano360Viewer
  ) {
    return "image";
  }
  return stringOrNull((node.data as { media_kind?: unknown }).media_kind);
}

function nodeSourceUrl(node: CanvasNode): string | null {
  const data = node.data as {
    imageUrl?: unknown;
    previewImageUrl?: unknown;
    referenceImageUrl?: unknown;
    videoUrl?: unknown;
    audioUrl?: unknown;
    sourceUrl?: unknown;
  };
  if (node.type === CANVAS_NODE_TYPES.video) {
    return (
      stringOrNull(data.videoUrl) ||
      stringOrNull(data.sourceUrl) ||
      stringOrNull(data.previewImageUrl)
    );
  }
  if (node.type === CANVAS_NODE_TYPES.audio) {
    return stringOrNull(data.audioUrl) || stringOrNull(data.sourceUrl);
  }
  return (
    stringOrNull(data.imageUrl) ||
    stringOrNull(data.previewImageUrl) ||
    stringOrNull(data.referenceImageUrl) ||
    stringOrNull(data.videoUrl) ||
    stringOrNull(data.audioUrl) ||
    stringOrNull(data.sourceUrl)
  );
}

function nodePreviewUrl(node: CanvasNode): string | null {
  const data = node.data as {
    imageUrl?: unknown;
    previewImageUrl?: unknown;
    referenceImageUrl?: unknown;
    videoUrl?: unknown;
  };
  if (node.type === CANVAS_NODE_TYPES.video) {
    return stringOrNull(data.previewImageUrl) || stringOrNull(data.videoUrl);
  }
  return (
    stringOrNull(data.previewImageUrl) ||
    stringOrNull(data.imageUrl) ||
    stringOrNull(data.referenceImageUrl)
  );
}

function textValueFromField(
  node: CanvasNode,
  field: "content" | "prompt" | "text",
): string | null {
  const value = (node.data as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function buildAgentCanvasNodeActionCatalog(
  node: CanvasNode,
  context?: { nodes?: readonly CanvasNode[]; edges?: readonly CanvasEdge[] },
): CanvasNodeActionCatalog & Record<string, unknown> {
  const catalog = buildCanvasNodeActionCatalog(node, context);
  if (node.type !== CANVAS_NODE_TYPES.beatContext) return catalog;
  return {
    ...catalog,
    downstream_spawn_types: [],
    actions: catalog.actions.filter(
      (action) => action.action !== "add_next_node",
    ),
    instruction:
      "这是镜头上下文节点。agent 可以修改的参数只有 node_detail.parameters 中的 visual_description、scene_ref、time_of_day；不要修改出场身份或出场道具。修改这些字段时使用 update_node_data。需要写回主线时，先更新草稿字段，再使用 run_node_action，action 必须是 sync_beat_context_to_mainline。",
  };
}

function buildAgentNodeActionCatalogResponse(
  node: CanvasNode,
  context?: { nodes?: readonly CanvasNode[]; edges?: readonly CanvasEdge[] },
  requestedAction?: string,
): Record<string, unknown> {
  const catalog = buildAgentCanvasNodeActionCatalog(node, context);
  const actions = requestedAction
    ? catalog.actions.filter((action) => action.action === requestedAction)
    : catalog.actions;
  return {
    node_id: catalog.node_id,
    node_type: catalog.node_type,
    ...(typeof catalog.skill_id === "string" && catalog.skill_id.trim()
      ? { skill_id: catalog.skill_id.trim() }
      : {}),
    downstream_spawn_types: catalog.downstream_spawn_types,
    actions,
    ...(requestedAction
      ? {
          requested_action: requestedAction,
          action_found: actions.length > 0,
          instruction:
            actions.length > 0
              ? "Use this action entry's parameters when emitting run_node_action or the listed command_type. These are action/tool parameters, not node editable data. If the action opens or creates a downstream UI/node, do not answer from the source node parameters; follow result_effect and inspect the selected/new node detail when needed."
              : "No action with this name exists on the node. Use freezone_get_node_detail to inspect available action names.",
        }
      : {
          instruction:
            "This response lists executable node actions only. For node editable parameters, call freezone_get_node_detail. For toolbar/tool/action questions, pass action to this tool before answering exact action behavior or parameters.",
        }),
  };
}

function buildAgentCanvasActionCatalog(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
): ReturnType<typeof buildCanvasActionCatalog> {
  const catalog = buildCanvasActionCatalog([...nodes], [...edges]);
  return {
    ...catalog,
    node_action_catalogs: nodes.map((node) =>
      buildAgentCanvasNodeActionCatalog(node, { nodes, edges }),
    ),
  };
}

function nodeTextReference(
  node: CanvasNode,
): Pick<CanvasNodeReferenceItem, "text_field" | "text_content"> {
  let field: "content" | "prompt" | "text" | null = null;
  if (
    node.type === CANVAS_NODE_TYPES.textAnnotation ||
    node.type === CANVAS_NODE_TYPES.beatContext
  ) {
    field = "content";
  } else if (
    node.type === CANVAS_NODE_TYPES.imageGen ||
    node.type === CANVAS_NODE_TYPES.imageEdit ||
    node.type === CANVAS_NODE_TYPES.video ||
    node.type === CANVAS_NODE_TYPES.script
  ) {
    field = "prompt";
  } else if (node.type === CANVAS_NODE_TYPES.audio) {
    field = "text";
  }
  if (!field) return { text_field: null, text_content: null };
  return { text_field: field, text_content: textValueFromField(node, field) };
}

function nodeReferenceItem(
  node: CanvasNode,
  context?: { nodes?: readonly CanvasNode[]; edges?: readonly CanvasEdge[] },
): CanvasNodeReferenceItem {
  const textReference = nodeTextReference(node);
  return {
    node_id: node.id,
    node_type: node.type ?? null,
    label: resolveNodeDisplayName(node.type, node.data),
    ...textReference,
    media_type: nodeMediaType(node),
    source_url: nodeSourceUrl(node),
    preview_url: nodePreviewUrl(node),
    slot_target: (node.data as { slot_target?: unknown }).slot_target ?? null,
    mainline_context:
      (node.data as { mainline_context?: unknown }).mainline_context ?? null,
    candidate_origin:
      (node.data as { candidate_origin?: unknown }).candidate_origin ?? null,
    position: { x: node.position.x, y: node.position.y },
    action_catalog: buildAgentCanvasNodeActionCatalog(node, context),
  };
}

function edgeReferenceItem(
  edge: CanvasEdge,
  nodeById: ReadonlyMap<string, CanvasNode>,
): CanvasEdgeReferenceItem {
  const ontologyLink = deriveCanvasOntologyLink(edge, nodeById);
  return {
    edge_id: edge.id,
    source: edge.source,
    target: edge.target,
    source_handle: edge.sourceHandle ?? null,
    target_handle: edge.targetHandle ?? null,
    link_type: ontologyLink.link_type,
  };
}

function referenceMentionForMediaType(
  mediaType: CanvasNodeReferenceMediaItem["media_type"],
  index: number,
): string {
  if (mediaType === "video") return `@视频${index}`;
  if (mediaType === "audio") return `@音频${index}`;
  return `@图片${index}`;
}

function nodeReferenceMedia(
  node: CanvasNode,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasNodeReferenceMediaItem[] {
  if (
    node.type !== CANVAS_NODE_TYPES.imageGen &&
    node.type !== CANVAS_NODE_TYPES.imageEdit &&
    node.type !== CANVAS_NODE_TYPES.video &&
    node.type !== CANVAS_NODE_TYPES.script
  ) {
    return [];
  }
  const upstream = sortUpstreamByReferenceOrder(
    upstreamNodesInEdgeOrder(nodes, edges, node.id),
    (node.data as { referenceOrder?: string[] }).referenceOrder,
  );
  const edgeBySource = new Map(
    edges
      .filter((edge) => edge.target === node.id)
      .map((edge) => [edge.source, edge] as const),
  );
  const nodeById = new Map(nodes.map((item) => [item.id, item] as const));
  const mediaCounts: Record<CanvasNodeReferenceMediaItem["media_type"], number> =
    {
      image: 0,
      video: 0,
      audio: 0,
    };
  const seenByTypeAndUrl = new Set<string>();
  const items: CanvasNodeReferenceMediaItem[] = [];

  for (const upstreamNode of upstream) {
    const mediaType = nodeMediaType(upstreamNode);
    if (
      mediaType !== "image" &&
      mediaType !== "video" &&
      mediaType !== "audio"
    ) {
      continue;
    }
    const sourceUrl = nodeSourceUrl(upstreamNode);
    if (!sourceUrl) continue;
    const dedupeKey = `${mediaType}:${sourceUrl}`;
    if (seenByTypeAndUrl.has(dedupeKey)) continue;
    seenByTypeAndUrl.add(dedupeKey);
    mediaCounts[mediaType] += 1;
    const edge = edgeBySource.get(upstreamNode.id);
    items.push({
      mention: referenceMentionForMediaType(mediaType, mediaCounts[mediaType]),
      node_id: upstreamNode.id,
      label: resolveNodeDisplayName(upstreamNode.type, upstreamNode.data),
      media_type: mediaType,
      source_url: sourceUrl,
      preview_url: nodePreviewUrl(upstreamNode),
      link_type: edge ? deriveCanvasOntologyLink(edge, nodeById).link_type : null,
    });
  }

  return items;
}

export function isCanvasNodeReferenceAttachment(
  attachment: ChatAttachment,
): boolean {
  return (
    attachment.type === CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE ||
    attachment.kind === CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE
  );
}

function parseCanvasNodeReferencePayload(
  attachment: ChatAttachment,
): CanvasNodeReferencePayload | null {
  if (!isCanvasNodeReferenceAttachment(attachment)) return null;
  try {
    const payload = JSON.parse(
      attachment.content || "null",
    ) as CanvasNodeReferencePayload | null;
    if (
      !payload ||
      payload.schema_version !== CANVAS_NODE_REFERENCE_SCHEMA_VERSION
    )
      return null;
    if (!Array.isArray(payload.nodes)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCanvasNodeType(value: unknown): value is CanvasNodeType {
  return (
    typeof value === "string" &&
    Object.values(CANVAS_NODE_TYPES).includes(value as CanvasNodeType)
  );
}

function normalizeCanvasNodeType(value: unknown): CanvasNodeType | undefined {
  if (value === "directorWorldNode") return CANVAS_NODE_TYPES.threeDWorld;
  return isCanvasNodeType(value) ? value : undefined;
}

function parseCanvasContextRequest(
  value: unknown,
): CanvasContextRequest | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "canvas_ontology":
    case "canvas_summary":
    case "canvas_action_catalog":
    case "canvas_command_catalog":
    case "link_type_catalog":
    case "selection_detail":
      return { type: value.type };
    case "validate_canvas_commands":
      return {
        type: "validate_canvas_commands",
        payload:
          "payload" in value
            ? value.payload
            : "body" in value
              ? value.body
              : "envelope" in value
                ? value.envelope
                : Array.isArray(value.commands)
                  ? { commands: value.commands }
                  : undefined,
      };
    case "node_detail":
    case "node_action_catalog":
    case "action_catalog":
    case "audio_voice_options":
      return {
        type: value.type,
        node_id: typeof value.node_id === "string" ? value.node_id : undefined,
        ...((value.type === "node_action_catalog" || value.type === "action_catalog") &&
        typeof value.action === "string" &&
        value.action.trim()
          ? { action: value.action.trim() }
          : {}),
      };
    case "neighbor_graph":
      return {
        type: "neighbor_graph",
        node_id: typeof value.node_id === "string" ? value.node_id : undefined,
        depth:
          typeof value.depth === "number" && Number.isFinite(value.depth)
            ? value.depth
            : undefined,
      };
    case "action_catalog_by_id":
      return {
        type: "action_catalog_by_id",
        action_id:
          typeof value.action_id === "string" ? value.action_id : undefined,
      };
    case "node_create_schema":
      return {
        type: "node_create_schema",
        node_type: normalizeCanvasNodeType(value.node_type),
      };
    case "slot_candidates":
      return {
        type: "slot_candidates",
        slot_kind:
          typeof value.slot_kind === "string" ? value.slot_kind : undefined,
      };
    case "mainline_projection_assets":
      return {
        type: "mainline_projection_assets",
        asset_kinds: Array.isArray(value.asset_kinds)
          ? value.asset_kinds.filter(
              (item): item is string =>
                typeof item === "string" && item.trim().length > 0,
            )
          : undefined,
        query:
          typeof value.query === "string" && value.query.trim()
            ? value.query.trim()
            : undefined,
        limit:
          typeof value.limit === "number" && Number.isFinite(value.limit)
            ? value.limit
            : undefined,
      };
    default:
      return null;
  }
}

function parseCanvasContextRequestEnvelope(
  value: unknown,
): CanvasContextRequestEnvelope | null {
  if (
    !isRecord(value) ||
    value.schema_version !== CANVAS_CONTEXT_REQUEST_SCHEMA_VERSION
  )
    return null;
  if (!Array.isArray(value.requests)) return null;
  const requests = value.requests
    .map(parseCanvasContextRequest)
    .filter((request): request is CanvasContextRequest => Boolean(request));
  if (requests.length === 0) return null;
  return {
    schema_version: CANVAS_CONTEXT_REQUEST_SCHEMA_VERSION,
    requests,
  };
}

export function extractCanvasContextRequestEnvelopes(
  values: unknown[],
): CanvasContextRequestEnvelope[] {
  return values
    .map(parseCanvasContextRequestEnvelope)
    .filter((envelope): envelope is CanvasContextRequestEnvelope =>
      Boolean(envelope),
    );
}

function canvasCommandEnvelopeFromValue(
  value: unknown,
  canvasId: string,
): CanvasChatCommandEnvelope | null {
  if (!isRecord(value) || !Array.isArray(value.commands)) return null;
  return {
    schema_version: "canvas_chat_commands.v1",
    canvas_id: typeof value.canvas_id === "string" ? value.canvas_id : canvasId,
    commands: value.commands as CanvasChatCommandEnvelope["commands"],
  };
}

function normalizeCanvasCommandValidationEnvelopes(
  payload: unknown,
  canvasId: string,
): CanvasChatCommandEnvelope[] {
  if (Array.isArray(payload)) {
    if (
      payload.some((item) => isRecord(item) && Array.isArray(item.commands))
    ) {
      return payload
        .map((item) => canvasCommandEnvelopeFromValue(item, canvasId))
        .filter((item): item is CanvasChatCommandEnvelope => Boolean(item));
    }
    return [
      {
        schema_version: "canvas_chat_commands.v1",
        canvas_id: canvasId,
        commands: payload as CanvasChatCommandEnvelope["commands"],
      },
    ];
  }
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.envelopes)) {
    return payload.envelopes
      .map((item) => canvasCommandEnvelopeFromValue(item, canvasId))
      .filter((item): item is CanvasChatCommandEnvelope => Boolean(item));
  }
  const envelope = canvasCommandEnvelopeFromValue(payload, canvasId);
  return envelope ? [envelope] : [];
}

export function shouldIncludeCanvasSummary(
  text: string,
  options: { hasFocusedNodeContext?: boolean } = {},
): boolean {
  void options;
  const trimmed = text.trim();
  if (!trimmed) return false;
  return true;
}

export function canvasNodeReferenceAttachmentNodeIds(
  attachment: ChatAttachment,
): string[] {
  const payload = parseCanvasNodeReferencePayload(attachment);
  if (!payload) return [];
  return payload.nodes
    .map((node) => node.node_id)
    .filter((nodeId) => nodeId.trim().length > 0);
}

export function canvasNodeReferenceAttachmentNodes(
  attachment: ChatAttachment,
): Array<{
  nodeId: string;
  label: string;
  nodeType: string | null;
  mediaType: string | null;
  sourceUrl: string | null;
  previewUrl: string | null;
}> {
  const payload = parseCanvasNodeReferencePayload(attachment);
  if (!payload) return [];
  const displayNodes =
    Array.isArray(payload.display_nodes) && payload.display_nodes.length > 0
      ? payload.display_nodes
      : payload.nodes;
  return displayNodes
    .filter((node) => node.node_id.trim().length > 0)
    .map((node) => ({
      nodeId: node.node_id,
      label: node.label || node.node_id,
      nodeType: node.node_type,
      mediaType: node.media_type,
      sourceUrl: node.source_url,
      previewUrl:
        typeof node.preview_url === "string" ? node.preview_url : null,
    }));
}

function buildAttachmentFromPayload(
  payload: CanvasNodeReferencePayload,
): ChatAttachment | null {
  const nodes = payload.nodes.filter((node) => node.node_id);
  if (nodes.length === 0) return null;
  const displayNodes = (payload.display_nodes ?? nodes).filter(
    (node) => node.node_id,
  );
  const normalizedPayload: CanvasNodeReferencePayload = {
    ...payload,
    display_nodes: displayNodes.length > 0 ? displayNodes : undefined,
    nodes,
    edges: Array.isArray(payload.edges) ? payload.edges : [],
  };
  const labelNodes = displayNodes.length > 0 ? displayNodes : nodes;
  const label =
    labelNodes.length === 1
      ? labelNodes[0]?.label || labelNodes[0]?.node_id || "Canvas node"
      : `${labelNodes.length} canvas nodes`;
  return {
    id: `canvas-ref:${payload.canvas_id}`,
    type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    mimeType: "application/vnd.supertale.canvas-node-reference+json",
    fileName: label,
    label,
    content: JSON.stringify(normalizedPayload),
  };
}

export function removeCanvasNodeFromReferenceAttachment(
  attachment: ChatAttachment,
  nodeId: string,
): ChatAttachment | null {
  const payload = parseCanvasNodeReferencePayload(attachment);
  if (!payload) return attachment;
  const nodes = payload.nodes.filter((node) => node.node_id !== nodeId);
  const hasDisplayNodes =
    Array.isArray(payload.display_nodes) && payload.display_nodes.length > 0;
  const displayNodes = hasDisplayNodes
    ? (payload.display_nodes?.filter((node) => node.node_id !== nodeId) ?? [])
    : undefined;
  if (
    nodes.length === payload.nodes.length &&
    (!hasDisplayNodes || displayNodes?.length === payload.display_nodes?.length)
  ) {
    return attachment;
  }
  if (hasDisplayNodes && displayNodes?.length === 0) return null;
  if (nodes.length === 0) return null;
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const edges = (payload.edges ?? []).filter(
    (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
  );
  return buildAttachmentFromPayload({
    ...payload,
    display_nodes: displayNodes,
    nodes,
    edges,
  });
}

export function pruneCanvasNodeReferenceAttachments(
  attachments: ChatAttachment[],
  existingNodeIds: ReadonlySet<string>,
): ChatAttachment[] {
  return attachments
    .map((attachment) => {
      const payload = parseCanvasNodeReferencePayload(attachment);
      if (!payload) return attachment;

      const nodes = payload.nodes.filter((node) =>
        existingNodeIds.has(node.node_id),
      );
      if (nodes.length === 0) return null;
      const displayNodes = payload.display_nodes?.filter((node) =>
        existingNodeIds.has(node.node_id),
      );
      const nodeIds = new Set(nodes.map((node) => node.node_id));
      const edges = (payload.edges ?? []).filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      );
      return buildAttachmentFromPayload({
        ...payload,
        display_nodes: displayNodes,
        nodes,
        edges,
      });
    })
    .filter((attachment): attachment is ChatAttachment => Boolean(attachment));
}

export function buildCanvasNodeReferenceAttachment(
  project: string,
  canvasId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[] = [],
  allNodes: CanvasNode[] = nodes,
  options: { displayNodes?: CanvasNode[] } = {},
): ChatAttachment | null {
  const referencedNodes = nodes.filter((node) => node.id);
  if (referencedNodes.length === 0) return null;
  const displayNodes = (options.displayNodes ?? referencedNodes).filter(
    (node) => node.id,
  );
  const referencedNodeIds = new Set(referencedNodes.map((node) => node.id));
  const nodeById = new Map(
    referencedNodes.map((node) => [node.id, node] as const),
  );
  const referencedEdges = edges.filter(
    (edge) =>
      referencedNodeIds.has(edge.source) && referencedNodeIds.has(edge.target),
  );
  const actionContext = { nodes: allNodes, edges };

  const payload: CanvasNodeReferencePayload = {
    schema_version: CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
    project,
    canvas_id: canvasId,
    display_nodes: displayNodes.map((node) =>
      nodeReferenceItem(node, actionContext),
    ),
    nodes: referencedNodes.map((node) =>
      nodeReferenceItem(node, actionContext),
    ),
    edges: referencedEdges.map((edge) => edgeReferenceItem(edge, nodeById)),
  };
  return buildAttachmentFromPayload(payload);
}

export function mergeCanvasNodeReferenceAttachments(
  attachments: ChatAttachment[],
): ChatAttachment[] {
  const ordinaryAttachments: ChatAttachment[] = [];
  const canvasPayloads = new Map<string, CanvasNodeReferencePayload>();

  for (const attachment of attachments) {
    const payload = parseCanvasNodeReferencePayload(attachment);
    if (!payload) {
      ordinaryAttachments.push(attachment);
      continue;
    }

    const existing = canvasPayloads.get(payload.canvas_id);
    if (!existing) {
      canvasPayloads.set(payload.canvas_id, {
        ...payload,
        display_nodes: payload.display_nodes
          ? [...payload.display_nodes]
          : undefined,
        nodes: [...payload.nodes],
        edges: Array.isArray(payload.edges) ? [...payload.edges] : [],
      });
      continue;
    }

    const byNodeId = new Map(
      existing.nodes.map((node) => [node.node_id, node] as const),
    );
    for (const node of payload.nodes) {
      if (!node.node_id) continue;
      byNodeId.set(node.node_id, node);
    }
    existing.nodes = [...byNodeId.values()];

    const byDisplayNodeId = new Map(
      (existing.display_nodes ?? []).map(
        (node) => [node.node_id, node] as const,
      ),
    );
    for (const node of payload.display_nodes ?? payload.nodes) {
      if (!node.node_id) continue;
      byDisplayNodeId.set(node.node_id, node);
    }
    existing.display_nodes = [...byDisplayNodeId.values()];

    const byEdgeId = new Map(
      (existing.edges ?? []).map((edge) => [edge.edge_id, edge] as const),
    );
    for (const edge of payload.edges ?? []) {
      if (!edge.edge_id) continue;
      byEdgeId.set(edge.edge_id, edge);
    }
    existing.edges = [...byEdgeId.values()];
  }

  return [
    ...ordinaryAttachments,
    ...[...canvasPayloads.values()]
      .map(buildAttachmentFromPayload)
      .filter((attachment): attachment is ChatAttachment =>
        Boolean(attachment),
      ),
  ];
}

function buildCanvasOntologySummaryBlock(
  context: CanvasOntologyContext | null | undefined,
): string[] {
  if (!context) return [];
  const summary = buildCanvasOntologySummary(context);
  return [
    "[SUPERTALE_CANVAS_ONTOLOGY_SUMMARY]",
    "Read-only Freezone canvas summary: existing nodes, links, candidates, slots, and selection. It is not an edit request. Request detail with Freezone get_* tools if needed.",
    JSON.stringify(summary),
    "[/SUPERTALE_CANVAS_ONTOLOGY_SUMMARY]",
  ];
}

export function buildCanvasChatCommandContext(
  ontologyContext?: CanvasOntologyContext | null,
  options: { includeCanvasSummary?: boolean } = {},
): string {
  return [
    "[SUPERTALE_CANVAS_ROUTING]",
    "Current surface is Freezone canvas. Follow the backend FREEZONE_CANVAS_ASSISTANT contract.",
    "[/SUPERTALE_CANVAS_ROUTING]",
    ...(options.includeCanvasSummary
      ? buildCanvasOntologySummaryBlock(ontologyContext)
      : []),
    "[SUPERTALE_CANVAS_CHAT_COMMANDS]",
    "Ontology summaries and node references are read-only grounding, not proof that a canvas write succeeded.",
    "Request only the missing catalog, schema, node, or action detail needed for the current operation.",
    "[/SUPERTALE_CANVAS_CHAT_COMMANDS]",
  ].join("\n");
}

function isCurrentUserPersonalCanvas(canvasId: string): boolean {
  const username = useAuthStore.getState().username?.trim();
  if (!username) return true;
  return canvasId === personalCanvasIdForUsername(username);
}

function buildCanvasCommandCatalog(canvasId: string): Record<string, unknown> {
  const exposeMainlineProjection = isCurrentUserPersonalCanvas(canvasId);
  const commands = [
    {
      type: "create_node",
      typed_tool: "freezone_create_node",
      required: ["type", "node_type"],
      optional: ["client_id", "data", "position"],
      field_notes: {
        client_id:
          "Batch-only alias for later commands before the frontend creates the real node id.",
        node_type:
          "Choose exactly from this command's allowed_node_types. For a user request to add a picture/image node, create imageGenNode unless the user explicitly asks to upload or import an existing file.",
        data: "Node data. For textAnnotationNode, use displayName for the node title/header and content for the body; title is accepted as a displayName alias. For imageGenNode model and all complex/dynamic/enum fields, call freezone_get_node_create_schema first and use exact options. Do not invent model ids such as flux, midjourney, or raw provider/api names; omit model if no schema option is available.",
        position: "Optional canvas position {x, y}.",
      },
      allowed_node_types: AGENT_CREATABLE_CANVAS_NODE_TYPES,
      invalid_example: {
        command: "create_node",
        data: { nodeType: "textAnnotationNode", title: "旧格式" },
      },
      example: {
        type: "create_node",
        client_id: "brief_1",
        node_type: CANVAS_NODE_TYPES.textAnnotation,
        data: { displayName: "Brief", content: "广告创意方向" },
        position: { x: 120, y: 160 },
      },
      image_node_example: {
        type: "create_node",
        client_id: "poster_1",
        node_type: CANVAS_NODE_TYPES.imageGen,
        data: {
          displayName: "海报图",
          prompt: "成都文化主题海报，国潮水墨风",
          quality: "high",
          aspectRatio: "2:3",
        },
      },
    },
    {
      type: "add_next_node",
      typed_tool: "freezone_add_next_node",
      required: ["type", "source_node_id"],
      optional: ["client_id", "node_type", "data"],
      field_notes: {
        source_node_id:
          "Existing node id or same-batch client_id to create downstream from.",
        node_type:
          "Choose from the source node action_summary_json.downstream_spawn_types and this command's allowed_node_types. Request node_create_schema for the selected node_type before filling data.",
        data: "Initial data for the new node. For dynamic/enum fields, request node_create_schema first.",
      },
      allowed_node_types: AGENT_CREATABLE_CANVAS_NODE_TYPES,
      example: {
        type: "add_next_node",
        source_node_id: "brief_1",
        client_id: "image_1",
        node_type: CANVAS_NODE_TYPES.imageGen,
        data: { prompt: "公益短片海报" },
      },
    },
    {
      type: "update_node_data",
      typed_tool: "freezone_update_node_data",
      required: ["type", "node_id", "data"],
      optional: [],
      field_notes: {
        node_id: "Existing node id or same-batch client_id.",
        data: "Only editable node parameters to change. Inspect freezone_get_node_detail and use node.parameters when unsure.",
      },
      example: {
        type: "update_node_data",
        node_id: "brief_1",
        data: { title: "公益广告简报" },
      },
    },
    {
      type: "create_edge",
      typed_tool: "freezone_create_edge",
      required: ["type", "source", "target", "link_type"],
      optional: [],
      field_notes: {
        source: "Existing node id or same-batch client_id.",
        target: "Existing node id or same-batch client_id.",
        link_type:
          "Required. Choose from freezone_get_link_type_catalog before creating an edge unless the source/target pair is already covered by the catalog in this prompt. Do not guess from natural language. Do not use role/link_kind/semantic_kind.",
      },
      example: {
        type: "create_edge",
        source: "brief_1",
        target: "image_1",
        link_type: "prompt_for",
      },
    },
    {
      type: "delete_nodes",
      typed_tool: "freezone_delete_nodes",
      required: ["type", "node_ids"],
      optional: [],
      field_notes: {
        node_ids:
          "必须先读取当前画布节点并填写实际节点 id；不能为空。删除全部节点时逐个列出可删除节点，不能用空数组代替清空画布。",
      },
      example: { type: "delete_nodes", node_ids: ["node_a", "node_b"] },
    },
    {
      type: "clear_canvas",
      typed_tool: "freezone_clear_canvas",
      required: ["type"],
      optional: [],
      description:
        "清空当前画布中的普通节点和连接。必须走审批；不要把‘清空画布’转换为空的 delete_nodes。主线投影/系统管理节点会保留并明确报告。",
      example: { type: "clear_canvas" },
    },
    {
      type: "delete_edges",
      typed_tool: "freezone_delete_edges",
      required_one_of: [["edge_ids"], ["pairs"]],
      optional: ["edge_ids", "pairs"],
      example: {
        type: "delete_edges",
        pairs: [{ source: "node_a", target: "node_b" }],
      },
    },
    {
      type: "move_nodes",
      typed_tool: "freezone_move_nodes",
      required_one_of: [["positions"], ["deltas"]],
      optional: ["positions", "deltas"],
      field_notes: {
        positions:
          "Absolute positions keyed by node id or same-batch client_id.",
        deltas: "Relative movement keyed by node id or same-batch client_id.",
      },
      example: {
        type: "move_nodes",
        positions: { brief_1: { x: 120, y: 160 } },
      },
    },
    {
      type: "layout_nodes",
      typed_tool: "freezone_layout_nodes",
      required: ["type", "mode"],
      optional: ["node_ids"],
      field_notes: { mode: "horizontal, vertical, or grid." },
      example: {
        type: "layout_nodes",
        node_ids: ["brief_1", "image_1"],
        mode: "horizontal",
      },
    },
    {
      type: "group_nodes",
      typed_tool: "freezone_group_nodes",
      required: ["type", "node_ids"],
      optional: ["label"],
      example: {
        type: "group_nodes",
        node_ids: ["brief_1", "image_1"],
        label: "海报生成流程",
      },
    },
    {
      type: "select_nodes",
      typed_tool: "freezone_select_nodes",
      required: ["type", "node_ids"],
      optional: ["focus"],
      example: { type: "select_nodes", node_ids: ["image_1"], focus: true },
    },
    {
      type: "run_node_action",
      typed_tool: "freezone_run_node_action",
      required: ["type", "node_id", "action"],
      optional: ["parameters"],
      field_notes: {
        action: "Exact action id from node_detail.action_summary.actions. Inspect freezone_get_node_action_catalog with this action before using non-default parameters.",
        parameters:
          "Optional action parameters. Only use fields shown by that action's parameters schema.",
      },
      example: {
        type: "run_node_action",
        node_id: "image_1",
        action: "generate_image",
      },
    },
    ...(exposeMainlineProjection
      ? [
          {
            type: "open_mainline_projection",
            typed_tool: "freezone_open_mainline_projection",
            required: ["type", "request"],
            optional: ["project_id"],
            field_notes: {
              request:
                "Open an episode/beat/asset mainline preset in the user's personal Freezone canvas through the same frontend path as the 虾画 toolbar button. Requires user confirmation before execution.",
              "request.scope": "episode, beat, or asset.",
              "request.episode": "Required for episode and beat scopes.",
              "request.beat": "Required for beat scope.",
              "request.primary_slot":
                "For beat scope, use sketch or frame when the user specifies 草图 or 分镜.",
              "request.asset_kind":
                "Required for asset scope. Examples: character, identity, portrait, scene, prop.",
              "request.character":
                "Character name for character/identity/portrait asset scopes.",
              "request.identity_id": "Identity id for identity asset scope.",
              "request.asset_id":
                "Scene or prop id for scene/prop asset scopes.",
            },
            examples: [
              {
                type: "open_mainline_projection",
                request: {
                  scope: "beat",
                  episode: 1,
                  beat: 2,
                  primary_slot: "frame",
                },
              },
              {
                type: "open_mainline_projection",
                request: { scope: "episode", episode: 1 },
              },
              {
                type: "open_mainline_projection",
                request: {
                  scope: "asset",
                  asset_kind: "character",
                  character: "陈默",
                },
              },
            ],
          },
        ]
      : []),
  ];
  return {
    schema_version: "canvas_command_catalog.v1",
    envelope_schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
    batch_tool: "freezone_emit_canvas_command",
    guidance: [
      "Default write path is freezone_emit_canvas_command with one canvas_chat_commands.v1 commands[] batch.",
      "Use typed Freezone write tools only when the user explicitly asks for exactly one canvas operation.",
      "Use freezone_emit_canvas_command whenever the request creates several nodes, several edges, or combines create/update/link/layout/group/select/run actions.",
      "commands[] objects require snake_case fields. Use type and node_type; never use legacy command, nodeType, or imageGenerationParams.",
      "Use client_id on create_node/add_next_node when later commands in the same batch reference a newly created node.",
      "create_edge requires link_type; choose it from freezone_get_link_type_catalog when unsure.",
    ],
    invalid_aliases: {
      command: "Use type.",
      nodeType: "Use node_type at the command top level.",
      "data.nodeType": "Use node_type at the command top level.",
      imageGenerationParams:
        "Flatten supported fields into data, e.g. data.prompt, data.model, data.quality, data.aspectRatio.",
      "data.imageGenerationParams":
        "Flatten supported fields into data, e.g. data.prompt, data.model, data.quality, data.aspectRatio.",
    },
    commands,
  };
}

function collectNeighborNodeIds(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  seedId: string,
  depth: number,
): Set<string> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const included = new Set<string>();
  if (!nodeIds.has(seedId)) return included;
  included.add(seedId);
  let frontier = new Set([seedId]);
  const maxDepth = Math.max(0, Math.min(3, Math.floor(depth)));
  for (let step = 0; step < maxDepth; step += 1) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (
        frontier.has(edge.source) &&
        nodeIds.has(edge.target) &&
        !included.has(edge.target)
      ) {
        next.add(edge.target);
      }
      if (
        frontier.has(edge.target) &&
        nodeIds.has(edge.source) &&
        !included.has(edge.source)
      ) {
        next.add(edge.source);
      }
    }
    for (const nodeId of next) included.add(nodeId);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return included;
}

function expandSelectedCanvasNodes(
  nodes: CanvasNode[],
  selectedNodeIds: string[] | undefined,
): CanvasNode[] {
  const selected = new Set(selectedNodeIds ?? []);
  if (selected.size === 0) return [];
  const expanded = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (
        !node.parentId ||
        !expanded.has(node.parentId) ||
        expanded.has(node.id)
      )
        continue;
      expanded.add(node.id);
      changed = true;
    }
  }
  return nodes.filter((node) => expanded.has(node.id));
}

function buildNodeCreateSchema(
  nodeType: CanvasNodeType | undefined,
): Record<string, unknown> | null {
  if (!nodeType) return null;
  const schemaNodeType =
    nodeType === CANVAS_NODE_TYPES.imageEdit
      ? CANVAS_NODE_TYPES.imageGen
      : nodeType;
  if (!isAgentCreatableCanvasNodeType(schemaNodeType)) return null;
  const node: CanvasNode = {
    id: `__create_schema__:${schemaNodeType}`,
    type: schemaNodeType,
    position: { x: 0, y: 0 },
    data: {} as CanvasNodeData,
  };
  const catalog = buildCanvasNodeActionCatalog(node);
  return {
    node_type: schemaNodeType,
    editable_fields: catalog.editable_fields,
    create_schema: catalog.editable_schema,
    stable_create_fields: catalog.editable_fields.filter((field) =>
      [
        "displayName",
        "prompt",
        "negativePrompt",
        "content",
        "text",
        "title",
      ].includes(field),
    ),
    dynamic_or_enum_fields: Object.entries(catalog.editable_schema)
      .filter(([, schema]) => schema.type === "enum" || Boolean(schema.source))
      .map(([field, schema]) => ({
        field,
        type: schema.type,
        source: schema.source ?? null,
        options: schema.options ?? [],
        option_labels: schema.option_labels ?? {},
        loading: schema.loading ?? false,
        fallback: schema.fallback ?? false,
        description: schema.description ?? null,
      })),
    instruction:
      "Use only fields declared in create_schema. Enum fields must use exact options. If options are empty/loading or no suitable option exists, omit the field and let the frontend default apply.",
  };
}

function audioVoiceRefFromReference(
  item: FreezoneAudioReferenceItem,
): FreezoneAudioVoiceRef {
  return {
    scope: item.scope,
    characterName: item.character_name ?? undefined,
    identityId: item.identity_id ?? undefined,
    slot: item.slot ?? undefined,
    voiceId: item.voice_id ?? undefined,
  };
}

function audioVoiceOptionLabel(
  item: FreezoneAudioReferenceItem,
  ref: FreezoneAudioVoiceRef,
): string {
  if (typeof item.label === "string" && item.label.trim())
    return item.label.trim();
  switch (ref.scope) {
    case "project_narrator":
      return "项目解说人";
    case "user_custom":
      return ref.voiceId ?? "自定义音色";
    case "character_default":
      return `${ref.characterName ?? "角色"}（默认声线）`;
    case "character_age_group":
      return `${ref.characterName ?? "角色"}（${ref.slot ?? "年龄段"}）`;
    case "identity":
      return `${ref.identityId ?? "身份"}（自有声线）`;
    case "identity_resolved":
      return `${ref.identityId ?? ref.characterName ?? "身份"}（已解析声线）`;
    default:
      return "音色";
  }
}

async function buildAudioVoiceOptions(
  project: string,
  node: CanvasNode | undefined,
): Promise<Record<string, unknown>> {
  try {
    const references = await fetchFreezoneAudioReferences(project);
    const currentData = node?.data as
      | { voiceRef?: unknown; voiceLabel?: unknown; voiceLanguage?: unknown }
      | undefined;
    const options = (references.available ?? []).map((item) => {
      const voiceRef = audioVoiceRefFromReference(item);
      const voiceLabel = audioVoiceOptionLabel(item, voiceRef);
      const voiceLanguage =
        typeof item.language === "string" ? item.language : "";
      return {
        label: voiceLabel,
        language: voiceLanguage || null,
        gender: typeof item.gender === "string" ? item.gender : null,
        preview_url:
          typeof item.preview_url === "string" ? item.preview_url : null,
        voiceRef,
        data: {
          voiceRef,
          voiceLabel,
          voiceLanguage,
        },
      };
    });
    return {
      current: {
        voiceRef: currentData?.voiceRef ?? null,
        voiceLabel: currentData?.voiceLabel ?? null,
        voiceLanguage: currentData?.voiceLanguage ?? null,
      },
      options,
      instruction:
        "To change an audio node voice/timbre, choose one option and use update_node_data with that option's data object. Do not write voiceId directly.",
    };
  } catch (error) {
    return {
      current: null,
      options: [],
      error:
        error instanceof Error
          ? error.message
          : "load audio voice options failed",
      instruction:
        "Audio voice options failed to load. Ask the user to retry or open the voice picker; do not guess voiceRef/voiceId.",
    };
  }
}

type MainlineProjectionAssetCandidate = {
  asset_kind: string;
  label: string;
  sublabel: string | null;
  media_type: string | null;
  exists: boolean | null;
  projection_request: Record<string, unknown>;
};

type MainlineProjectionAssetSource = {
  id?: string;
  kind?: string;
  role?: string;
  label?: string;
  sublabel?: string;
  rel_path?: string | null;
  url?: string | null;
  exists?: boolean;
  media_type?: string;
  meta?: Record<string, unknown>;
  slot_target?: unknown;
};

function normalizeProjectionAssetKind(
  asset: MainlineProjectionAssetSource,
): string | null {
  const role = asset.role || "";
  const kind = asset.kind || "";
  if (
    role === "character_reference" ||
    role === "character_profile" ||
    role === "character_identity" ||
    role === "character_portrait" ||
    role === "identity_portrait" ||
    kind === "character" ||
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait" ||
    kind === "portrait"
  ) {
    return "character";
  }
  if (role === "prop_reference" || kind === "prop" || kind === "prop_ref")
    return "prop";
  if (role === "scene_master" || kind === "scene_master") return "scene_master";
  if (role === "scene_reverse_master" || kind === "scene_reverse_master")
    return "scene_reverse_master";
  if (role === "scene_director_pano_360" || kind === "scene_director_pano_360")
    return "scene_360";
  if (role === "scene_spatial_layout" || kind === "scene_spatial_layout")
    return "scene_spatial_layout";
  if (kind === "scene") return "scene";
  return null;
}

function normalizeRequestedProjectionAssetKind(kind: string): string | null {
  const value = kind.trim();
  if (!value) return null;
  if (value === "prop_ref" || value === "prop_reference") return "prop";
  if (
    value === "identity" ||
    value === "portrait" ||
    value === "character_identity" ||
    value === "character_portrait" ||
    value === "identity_portrait"
  ) {
    return "character";
  }
  if (value === "scene_director_pano_360") return "scene_360";
  return value;
}

function projectionRequestFromPushTarget(
  target: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!target || typeof target.kind !== "string") return null;
  const kind = target.kind;
  if (
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait"
  ) {
    const character = stringOrNull(target.character);
    const identityId = stringOrNull(target.identity_id);
    if (!character || !identityId) return null;
    return {
      scope: "asset",
      asset_kind: "identity",
      character,
      identity_id: identityId,
    };
  }
  if (kind === "portrait") {
    const character = stringOrNull(target.character);
    if (!character) return null;
    return { scope: "asset", asset_kind: "portrait", character };
  }
  if (kind === "prop_ref") {
    const propId = stringOrNull(target.prop_id);
    if (!propId) return null;
    return { scope: "asset", asset_kind: "prop", asset_id: propId };
  }
  if (kind.startsWith("scene")) {
    const sceneId = stringOrNull(target.scene_id);
    if (!sceneId) return null;
    return { scope: "asset", asset_kind: kind, asset_id: sceneId };
  }
  return null;
}

function projectionRequestForMainlineAsset(
  asset: MainlineProjectionAssetSource,
): Record<string, unknown> | null {
  const assetKind = normalizeProjectionAssetKind(asset);
  if (!assetKind) return null;
  const meta = asset.meta ?? {};
  const character = stringOrNull(meta.character);
  if (assetKind === "character") {
    if (!character) return null;
    return { scope: "asset", asset_kind: "character", character };
  }

  const target = assetToPushTarget({
    kind: asset.kind,
    role: asset.role,
    meta: asset.meta ?? {},
    slot_target: asset.slot_target,
  });
  const targetRequest = projectionRequestFromPushTarget(
    target as Record<string, unknown> | null,
  );
  if (targetRequest) return targetRequest;

  const identityId =
    stringOrNull(meta.identity_id) ?? stringOrNull(meta.identityId);
  void identityId;
  const sceneId = stringOrNull(meta.scene_id) ?? stringOrNull(meta.scene);
  const propId = stringOrNull(meta.prop_id) ?? stringOrNull(meta.propId);

  if (assetKind === "prop" || assetKind === "prop_ref") {
    if (!propId) return null;
    return { scope: "asset", asset_kind: "prop", asset_id: propId };
  }
  if (assetKind.startsWith("scene")) {
    if (!sceneId) return null;
    return { scope: "asset", asset_kind: assetKind, asset_id: sceneId };
  }
  return null;
}

function projectionAssetSourceFromSlotTarget(
  slotTarget: unknown,
  fallback: Pick<
    MainlineProjectionAssetSource,
    "id" | "label" | "sublabel" | "url" | "media_type"
  >,
): MainlineProjectionAssetSource | null {
  const target = recordOrNull(slotTarget);
  const kind = stringOrNull(target?.kind);
  if (!kind) return null;
  const targetRecord = target as Record<string, unknown>;
  return {
    ...fallback,
    kind,
    role: kind,
    exists: true,
    meta: {
      character: stringOrNull(targetRecord.character) ?? undefined,
      identity_id: stringOrNull(targetRecord.identity_id) ?? undefined,
      scene_id: stringOrNull(targetRecord.scene_id) ?? undefined,
      prop_id: stringOrNull(targetRecord.prop_id) ?? undefined,
    },
    slot_target: targetRecord,
  };
}

function projectionAssetSourcesFromMainlineContext(
  context: Record<string, unknown>,
  fallback: Pick<
    MainlineProjectionAssetSource,
    "id" | "label" | "sublabel" | "url" | "media_type"
  >,
): MainlineProjectionAssetSource | null {
  const kind = stringOrNull(context.kind);
  if (!kind) return null;
  const role = stringOrNull(context.role);
  const character = stringOrNull(context.character);
  const identityId =
    stringOrNull(context.identityId) ?? stringOrNull(context.identity_id);
  const sceneId =
    stringOrNull(context.sceneId) ?? stringOrNull(context.scene_id);
  const propId = stringOrNull(context.propId) ?? stringOrNull(context.prop_id);
  const label = stringOrNull(context.label) ?? fallback.label;
  if (kind === "identity") {
    return {
      ...fallback,
      kind: "identity",
      role: role ?? "character_identity",
      label: label ?? identityId ?? character ?? fallback.label,
      exists: true,
      meta: {
        character: character ?? identityId ?? undefined,
        identity_id: identityId ?? undefined,
      },
    };
  }
  if (kind === "prop") {
    return {
      ...fallback,
      kind: "prop",
      role: role ?? "prop_reference",
      label: label ?? propId ?? fallback.label,
      exists: true,
      meta: { prop_id: propId ?? label ?? undefined },
    };
  }
  if (kind === "scene") {
    return {
      ...fallback,
      kind: "scene",
      role: role ?? "scene_master",
      label: label ?? sceneId ?? fallback.label,
      exists: true,
      meta: { scene_id: sceneId ?? label ?? undefined },
    };
  }
  return null;
}

function projectionAssetSourcesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): MainlineProjectionAssetSource[] {
  const references = metadata?.references;
  if (!Array.isArray(references)) return [];
  return references
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object",
    )
    .map((item, index) => ({
      id:
        stringOrNull(item.id) ??
        stringOrNull(item.rel_path) ??
        `metadata-reference-${index}`,
      kind: stringOrNull(item.kind) ?? undefined,
      role: stringOrNull(item.role) ?? undefined,
      label: stringOrNull(item.label) ?? undefined,
      sublabel:
        stringOrNull(item.sublabel) ?? stringOrNull(item.rel_path) ?? undefined,
      rel_path: stringOrNull(item.rel_path),
      url: stringOrNull(item.url),
      exists: typeof item.exists === "boolean" ? item.exists : undefined,
      media_type: stringOrNull(item.media_type) ?? undefined,
      meta:
        item.meta && typeof item.meta === "object"
          ? (item.meta as Record<string, unknown>)
          : undefined,
      slot_target: item.slot_target,
    }));
}

function projectionAssetSourcesFromNodes(
  nodes: CanvasNode[],
): MainlineProjectionAssetSource[] {
  const sources: MainlineProjectionAssetSource[] = [];
  nodes.forEach((node) => {
    const data = recordOrNull(node.data) ?? {};
    const label = resolveNodeDisplayName(node.type, node.data);
    const fallback = {
      id: node.id,
      label,
      sublabel: node.id,
      url: nodeSourceUrl(node) ?? nodePreviewUrl(node),
      media_type: nodeMediaType(node) ?? undefined,
    };
    const source = recordOrNull(data.__freezone_source);
    if (source) {
      sources.push({
        ...fallback,
        kind: stringOrNull(source.kind) ?? undefined,
        role: stringOrNull(source.role) ?? undefined,
        label: stringOrNull(source.label) ?? label,
        sublabel:
          stringOrNull(source.sublabel) ??
          stringOrNull(source.rel_path) ??
          node.id,
        rel_path: stringOrNull(source.rel_path),
        url: stringOrNull(source.url) ?? fallback.url,
        exists: typeof source.exists === "boolean" ? source.exists : true,
        media_type: stringOrNull(source.media_type) ?? fallback.media_type,
        meta: recordOrNull(source.meta) ?? undefined,
        slot_target: source.slot_target ?? data.slot_target,
      });
    }
    const slotSource = projectionAssetSourceFromSlotTarget(
      data.slot_target,
      fallback,
    );
    if (slotSource) sources.push(slotSource);
    if (Array.isArray(data.mainline_context)) {
      data.mainline_context
        .map(recordOrNull)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .forEach((context) => {
          const contextSource = projectionAssetSourcesFromMainlineContext(
            context,
            fallback,
          );
          if (contextSource) sources.push(contextSource);
        });
    }
  });
  return sources;
}

function mainlineProjectionAssetCandidates(
  assets: MainlineProjectionAssetSource[],
  request: Extract<
    CanvasContextRequest,
    { type: "mainline_projection_assets" }
  >,
): MainlineProjectionAssetCandidate[] {
  const allowedKinds = new Set(
    (request.asset_kinds ?? [])
      .map(normalizeRequestedProjectionAssetKind)
      .filter((kind): kind is string => Boolean(kind)),
  );
  const query = request.query?.trim().toLowerCase() ?? "";
  const limit = Math.max(1, Math.min(50, Math.floor(request.limit ?? 20)));
  const output: MainlineProjectionAssetCandidate[] = [];
  const seenProjectionRequests = new Set<string>();

  for (const asset of assets) {
    if (asset.exists === false) continue;
    const assetKind = normalizeProjectionAssetKind(asset);
    if (!assetKind) continue;
    if (allowedKinds.size > 0 && !allowedKinds.has(assetKind)) continue;
    const projectionRequest = projectionRequestForMainlineAsset(asset);
    if (!projectionRequest) continue;
    const projectionRequestKey = JSON.stringify(projectionRequest);
    if (seenProjectionRequests.has(projectionRequestKey)) continue;
    const searchable =
      `${asset.label} ${asset.sublabel ?? ""} ${asset.kind} ${asset.role}`.toLowerCase();
    if (query && !searchable.includes(query)) continue;
    seenProjectionRequests.add(projectionRequestKey);
    output.push({
      asset_kind: assetKind,
      label: asset.label || asset.id || asset.rel_path || assetKind,
      sublabel: asset.sublabel ?? null,
      media_type:
        typeof asset.media_type === "string" ? asset.media_type : null,
      exists: typeof asset.exists === "boolean" ? asset.exists : null,
      projection_request: projectionRequest,
    });
    if (output.length >= limit) break;
  }

  return output;
}

export async function buildCanvasContextRequestResponses(params: {
  project: string;
  canvasId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  ontologyContext: CanvasOntologyContext | null | undefined;
  selectedNodeIds?: string[];
  envelopes: CanvasContextRequestEnvelope[];
  loadMainlineProjectionAssets?: () => Promise<FreezoneProjectAsset[]>;
  canvasMetadata?: Record<string, unknown> | null;
}): Promise<Record<string, unknown>[] | null> {
  if (params.envelopes.length === 0) return null;
  const response: Record<string, unknown>[] = [];
  const nodeById = new Map(
    params.nodes.map((node) => [node.id, node] as const),
  );
  for (const envelope of params.envelopes) {
    for (const request of envelope.requests) {
      switch (request.type) {
        case "canvas_ontology":
          if (params.ontologyContext) {
            response.push({
              type: "canvas_ontology",
              data: params.ontologyContext,
            });
          }
          break;
        case "canvas_summary":
          if (params.ontologyContext) {
            response.push({
              type: "canvas_summary",
              data: buildCanvasOntologySummary(params.ontologyContext),
            });
          }
          break;
        case "canvas_action_catalog":
          response.push({
            type: "canvas_action_catalog",
            data: buildAgentCanvasActionCatalog(params.nodes, params.edges),
          });
          break;
        case "canvas_command_catalog":
          response.push({
            type: "canvas_command_catalog",
            data: buildCanvasCommandCatalog(params.canvasId),
            instruction:
              "Use this catalog to build one freezone_emit_canvas_command.commands[] batch. Use typed tools only for explicit exactly-one-operation requests; use client_id for same-batch references.",
          });
          break;
        case "link_type_catalog":
          response.push({
            type: "link_type_catalog",
            data: canvasLinkTypeCatalogJson(),
            instruction:
              "Choose one link_type whose source_object_types include the source node object type and whose target_object_types include the target node object type. Then emit create_edge with source, target, and link_type.",
          });
          break;
        case "validate_canvas_commands": {
          const envelopes = normalizeCanvasCommandValidationEnvelopes(
            request.payload,
            params.canvasId,
          );
          if (envelopes.length === 0) {
            response.push({
              type: "validate_canvas_commands",
              data: {
                schema_version: "canvas_command_validation.v1",
                ok: false,
                envelope_count: 0,
                issues: [
                  {
                    path: "payload",
                    message:
                      "validate_canvas_commands requires a canvas_chat_commands.v1 envelope or a commands array.",
                  },
                ],
              },
              instruction:
                "Fix the validation payload and validate again before emitting the final canvas write tool.",
            });
            break;
          }
          const normalizedEnvelopes =
            normalizeCanvasChatCommandEnvelopesForValidation(
              envelopes,
              params.nodes.map((node) => node.id),
            );
          const validation = validateCanvasChatCommandEnvelopes(
            normalizedEnvelopes,
            params.nodes,
            params.edges,
          );
          response.push({
            type: "validate_canvas_commands",
            data: {
              schema_version: "canvas_command_validation.v1",
              ok: validation.ok,
              envelope_count: normalizedEnvelopes.length,
              issues: validation.issues,
            },
            instruction: validation.ok
              ? "Validation passed. Emit the same canvas_chat_commands.v1 envelope for user confirmation. Use a typed write tool only for an explicit exactly-one-operation request."
              : "Fix these issues and validate again before emitting the final canvas write tool.",
          });
          break;
        }
        case "selection_detail": {
          const selected = expandSelectedCanvasNodes(
            params.nodes,
            params.selectedNodeIds,
          );
          const attachment = buildCanvasNodeReferenceAttachment(
            params.project,
            params.canvasId,
            selected,
            params.edges,
            params.nodes,
          );
          response.push({
            type: "selection_detail",
            data: attachment ? JSON.parse(attachment.content || "null") : null,
          });
          break;
        }
        case "node_detail":
        case "node_action_catalog":
        case "action_catalog": {
          const node = request.node_id
            ? nodeById.get(request.node_id)
            : undefined;
          response.push({
            type: request.type,
            node_id: request.node_id ?? null,
            data: node
              ? request.type === "action_catalog" ||
                request.type === "node_action_catalog"
                ? buildAgentNodeActionCatalogResponse(
                    node,
                    {
                      nodes: params.nodes,
                      edges: params.edges,
                    },
                    request.action,
                  )
                : (() => {
                    const detailNodes =
                      node.type === CANVAS_NODE_TYPES.group
                        ? [
                            node,
                            ...params.nodes.filter(
                              (item) => item.parentId === node.id,
                            ),
                          ]
                        : [node];
                    return buildCompactCanvasNodeDetailPayload(
                      params.project,
                      params.canvasId,
                      detailNodes,
                      params.edges,
                      params.nodes,
                    );
                  })()
              : null,
          });
          break;
        }
        case "neighbor_graph": {
          const nodeIds = request.node_id
            ? collectNeighborNodeIds(
                params.nodes,
                params.edges,
                request.node_id,
                request.depth ?? 1,
              )
            : new Set<string>();
          const selected = params.nodes.filter((node) => nodeIds.has(node.id));
          const attachment = buildCanvasNodeReferenceAttachment(
            params.project,
            params.canvasId,
            selected,
            params.edges,
            params.nodes,
          );
          response.push({
            type: "neighbor_graph",
            node_id: request.node_id ?? null,
            depth: request.depth ?? 1,
            data: attachment ? JSON.parse(attachment.content || "null") : null,
          });
          break;
        }
        case "slot_candidates": {
          const objects = params.ontologyContext?.objects ?? [];
          response.push({
            type: "slot_candidates",
            slot_kind: request.slot_kind ?? null,
            data: objects
              .filter((object) => object.pushable)
              .filter(
                (object) =>
                  !request.slot_kind ||
                  object.slot_target?.kind === request.slot_kind,
              )
              .map((object) => ({
                node_id: object.node_id,
                label: object.label,
                media_type: object.media_type,
                slot_target: object.slot_target,
              })),
          });
          break;
        }
        case "mainline_projection_assets": {
          if (!params.loadMainlineProjectionAssets) {
            response.push({
              type: "mainline_projection_assets",
              asset_kinds: request.asset_kinds ?? [],
              query: request.query ?? null,
              data: [],
              error: "mainline projection asset loader is not available",
            });
            break;
          }
          const assets = [
            ...projectionAssetSourcesFromNodes(params.nodes),
            ...projectionAssetSourcesFromMetadata(params.canvasMetadata),
            ...(await params.loadMainlineProjectionAssets()),
          ];
          response.push({
            type: "mainline_projection_assets",
            asset_kinds: request.asset_kinds ?? [],
            query: request.query ?? null,
            data: mainlineProjectionAssetCandidates(assets, request),
            instruction: isCurrentUserPersonalCanvas(params.canvasId)
              ? "Use one candidate's projection_request with freezone_open_mainline_projection to map/open that mainline asset into the Freezone canvas. If no candidate matches, ask the user to choose a more specific mainline asset."
              : "These are read-only mainline asset candidates for context. If no candidate matches, ask the user to choose a more specific mainline asset.",
          });
          break;
        }
        case "action_catalog_by_id":
          response.push({
            type: "action_catalog_by_id",
            action_id: request.action_id ?? null,
            data:
              BASE_CANVAS_ACTION_CAPABILITIES.find(
                (action) => action.id === request.action_id,
              ) ?? null,
          });
          break;
        case "node_create_schema":
          {
            const schema = buildNodeCreateSchema(request.node_type);
            response.push({
              type: "node_create_schema",
              node_type:
                (schema?.node_type as CanvasNodeType | undefined) ??
                request.node_type ??
                null,
              data: schema,
            });
          }
          break;
        case "audio_voice_options": {
          const node = request.node_id
            ? nodeById.get(request.node_id)
            : undefined;
          response.push({
            type: "audio_voice_options",
            node_id: request.node_id ?? null,
            data: await buildAudioVoiceOptions(params.project, node),
          });
          break;
        }
      }
    }
  }
  return response;
}

export async function buildCanvasContextRequestResponse(params: {
  project: string;
  canvasId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  ontologyContext: CanvasOntologyContext | null | undefined;
  selectedNodeIds?: string[];
  envelopes: CanvasContextRequestEnvelope[];
}): Promise<string | null> {
  const response = await buildCanvasContextRequestResponses(params);
  if (!response) return null;
  return [
    "[SUPERTALE_CANVAS_CONTEXT_RESPONSE]",
    "This is additional read-only Freezone canvas context requested by the assistant. Use it to answer or emit canvas_chat_commands.v1.",
    JSON.stringify({
      schema_version: "canvas_context_response.v1",
      canvas_id: params.canvasId,
      responses: response,
    }),
    "[/SUPERTALE_CANVAS_CONTEXT_RESPONSE]",
  ].join("\n");
}

const NODE_REFERENCE_TEXT_PREVIEW_LIMIT = 240;

function compactTextPreview(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= NODE_REFERENCE_TEXT_PREVIEW_LIMIT) return normalized;
  return `${normalized.slice(0, NODE_REFERENCE_TEXT_PREVIEW_LIMIT)}...`;
}

function compactActionSummary(
  catalog:
    | (CanvasNodeActionCatalog & Record<string, unknown>)
    | null
    | undefined,
): Record<string, unknown> | null {
  if (!catalog) return null;
  const actions = Array.isArray(catalog.actions)
    ? catalog.actions.map((action) => ({
        action: action.action,
        execution: action.execution,
        command_type: action.command_type ?? null,
      }))
    : [];
  return {
    ...(typeof catalog.skill_id === "string" && catalog.skill_id.trim()
      ? { skill_id: catalog.skill_id.trim() }
      : {}),
    downstream_spawn_types: Array.isArray(catalog.downstream_spawn_types)
      ? catalog.downstream_spawn_types
      : [],
    actions,
    action_parameter_tool: "freezone_get_node_action_catalog(node_id, action)",
    detail_tools: [
      "freezone_get_node_detail",
      "freezone_get_node_action_catalog",
    ],
  };
}

function fallbackParameterValue(
  node: CanvasNodeReferenceItem,
  field: string,
): unknown {
  if (field === node.text_field) return node.text_content;
  if (field === "displayName") return node.label;
  return undefined;
}

function compactParameterCurrentValue(value: unknown): unknown {
  return typeof value === "string" ? compactTextPreview(value) : value;
}

function compactEditableParameters(
  node: CanvasNodeReferenceItem,
): Record<string, unknown> | null {
  const schema = recordOrNull(node.action_catalog.editable_schema);
  if (!schema) return null;
  const parameters: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(schema)) {
    const fieldSchema = recordOrNull(value);
    if (!fieldSchema) continue;
    const parameter: Record<string, unknown> = {
      ...fieldSchema,
      editable: true,
    };
    if ("current_value" in parameter) {
      parameter.current_value = compactParameterCurrentValue(
        parameter.current_value,
      );
    }
    if (!("current_value" in parameter)) {
      const fallbackValue = fallbackParameterValue(node, field);
      if (fallbackValue !== undefined)
        parameter.current_value = compactParameterCurrentValue(fallbackValue);
    }
    parameters[field] = parameter;
  }
  return Object.keys(parameters).length > 0 ? parameters : null;
}

function nodeTypeCounts(
  nodes: CanvasNodeReferenceItem[],
): Record<string, number> {
  return nodes.reduce<Record<string, number>>((acc, node) => {
    const type = node.node_type || "unknown";
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});
}

function compactMainlineContext(value: unknown): unknown {
  const compactOne = (item: unknown): unknown => {
    if (!isRecord(item)) return item;
    const result: Record<string, unknown> = {};
    for (const key of [
      "kind",
      "episode",
      "beat",
      "role",
      "label",
      "visualDescription",
      "narrationSegment",
      "sceneId",
      "timeOfDay",
      "projectId",
    ]) {
      if (key in item) result[key] = item[key];
    }
    if (Array.isArray(item.detectedIdentities)) {
      result.detectedIdentityCount = item.detectedIdentities.length;
    }
    if (Array.isArray(item.detectedProps)) {
      result.detectedPropCount = item.detectedProps.length;
    }
    return result;
  };

  if (Array.isArray(value)) return value.map(compactOne);
  return compactOne(value);
}

function compactNodeDetailItem(
  node: CanvasNodeReferenceItem,
  referenceMedia?: CanvasNodeReferenceMediaItem[],
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    node_id: node.node_id,
    node_type: node.node_type,
    label: node.label,
    position: node.position,
  };
  if (node.text_field) item.text_field = node.text_field;
  const textPreview = compactTextPreview(node.text_content);
  if (textPreview) item.text_preview = textPreview;
  if (node.media_type) item.media_type = node.media_type;
  if (node.source_url) item.source_url = node.source_url;
  if (node.preview_url) item.preview_url = node.preview_url;
  if (node.slot_target) item.slot_target = node.slot_target;
  if (node.mainline_context)
    item.mainline_context = compactMainlineContext(node.mainline_context);
  if (node.candidate_origin) item.candidate_origin = node.candidate_origin;
  if (referenceMedia && referenceMedia.length > 0)
    item.reference_media = referenceMedia;
  const parameters = compactEditableParameters(node);
  if (parameters) item.parameters = parameters;
  const actionSummary = compactActionSummary(node.action_catalog);
  if (actionSummary) item.action_summary = actionSummary;
  return item;
}

function buildCompactCanvasNodeDetailPayload(
  project: string,
  canvasId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  allNodes: CanvasNode[],
): Record<string, unknown> | null {
  const attachment = buildCanvasNodeReferenceAttachment(
    project,
    canvasId,
    nodes,
    edges,
    allNodes,
  );
  const payload = attachment ? JSON.parse(attachment.content || "null") : null;
  if (!isRecord(payload) || !Array.isArray(payload.nodes)) return null;
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  return {
    schema_version: "canvas_node_detail.v1",
    project,
    canvas_id: canvasId,
    detail_mode: "compact",
    nodes: payload.nodes.map((node) => {
      const item = node as CanvasNodeReferenceItem;
      const sourceNode = nodeById.get(item.node_id);
      return compactNodeDetailItem(
        item,
        sourceNode ? nodeReferenceMedia(sourceNode, allNodes, edges) : [],
      );
    }),
    edges: Array.isArray(payload.edges) ? payload.edges : [],
    instruction:
      "This is compact node detail. Use node.parameters only for editable node data fields, current values, and enum options. Node parameters are not toolbar/action/tool parameters. If the user asks about an action or panel such as HD/upscale, crop, matting, split, lighting, rotate, or download, call freezone_get_node_action_catalog with node_id and action before answering. If a node includes reference_media, use mention values such as @图片1 in prompt edits; numbering matches the node's top reference thumbnails from left to right. For a group child that needs inspection, call freezone_get_node_detail with that child node_id.",
  };
}

export function buildCanvasNodeReferenceContext(
  attachments: ChatAttachment[],
): string | null {
  const payloads = attachments
    .map(parseCanvasNodeReferencePayload)
    .filter((payload): payload is CanvasNodeReferencePayload =>
      Boolean(
        payload &&
        payload.schema_version === CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
      ),
    );

  if (payloads.length === 0) return null;

  const lines = [
    "[SUPERTALE_CANVAS_NODE_REFERENCES]",
    "These are compact references for the current user turn. Treat display nodes as the user's visible target; child summaries provide orientation only.",
    "Use action_summary_json for quick routing. Request freezone_get_node_detail for node parameters and dynamic options. Node parameters are not toolbar/action/tool parameters; for questions about an action or panel, request freezone_get_node_action_catalog with action before answering.",
    "Referenced edges are only for unlink, disconnect, or remove-connection requests.",
    "Keep user-visible replies concise and non-technical. Do not mention raw JSON, schema names, field ids, action ids, command ids, or node_id unless the user asks for implementation details.",
  ];

  payloads.forEach((payload, payloadIndex) => {
    lines.push("");
    lines.push(`reference_${payloadIndex + 1}_project: ${payload.project}`);
    lines.push(`reference_${payloadIndex + 1}_canvas_id: ${payload.canvas_id}`);
    const displayNodes =
      payload.display_nodes && payload.display_nodes.length > 0
        ? payload.display_nodes
        : payload.nodes;
    const displayNodeIds = new Set(displayNodes.map((node) => node.node_id));
    const childNodes = payload.nodes.filter(
      (node) => !displayNodeIds.has(node.node_id),
    );
    if (childNodes.length > 0) {
      lines.push(
        `reference_${payloadIndex + 1}_group_children_count: ${childNodes.length}`,
      );
      lines.push(
        `reference_${payloadIndex + 1}_child_type_counts_json: ${JSON.stringify(nodeTypeCounts(childNodes))}`,
      );
    }

    displayNodes.forEach((node, nodeIndex) => {
      const prefix = `reference_${payloadIndex + 1}_node_${nodeIndex + 1}`;
      lines.push(`${prefix}_id: ${node.node_id}`);
      lines.push(`${prefix}_type: ${node.node_type ?? ""}`);
      lines.push(`${prefix}_label: ${node.label}`);
      lines.push(`${prefix}_position_json: ${JSON.stringify(node.position)}`);
      if (node.text_field)
        lines.push(`${prefix}_text_field: ${node.text_field}`);
      const textPreview = compactTextPreview(node.text_content);
      if (textPreview)
        lines.push(`${prefix}_text_preview: ${JSON.stringify(textPreview)}`);
      if (node.media_type)
        lines.push(`${prefix}_media_type: ${node.media_type}`);
      if (node.source_url)
        lines.push(`${prefix}_source_url: ${node.source_url}`);
      if (node.slot_target)
        lines.push(
          `${prefix}_slot_target_json: ${JSON.stringify(node.slot_target)}`,
        );
      if (node.mainline_context)
        lines.push(
          `${prefix}_mainline_context_json: ${JSON.stringify(node.mainline_context)}`,
        );
      if (node.candidate_origin)
        lines.push(
          `${prefix}_candidate_origin_json: ${JSON.stringify(node.candidate_origin)}`,
        );
      const actionSummary = compactActionSummary(node.action_catalog);
      if (actionSummary)
        lines.push(
          `${prefix}_action_summary_json: ${JSON.stringify(actionSummary)}`,
        );
    });
    (payload.edges ?? []).forEach((edge, edgeIndex) => {
      const prefix = `reference_${payloadIndex + 1}_edge_${edgeIndex + 1}`;
      lines.push(`${prefix}_id: ${edge.edge_id}`);
      lines.push(`${prefix}_source: ${edge.source}`);
      lines.push(`${prefix}_target: ${edge.target}`);
      if (edge.source_handle)
        lines.push(`${prefix}_source_handle: ${edge.source_handle}`);
      if (edge.target_handle)
        lines.push(`${prefix}_target_handle: ${edge.target_handle}`);
      if (edge.link_type) lines.push(`${prefix}_link_type: ${edge.link_type}`);
    });
  });

  lines.push("[/SUPERTALE_CANVAS_NODE_REFERENCES]");
  return lines.join("\n");
}
