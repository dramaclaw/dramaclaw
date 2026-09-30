import type { CanvasEdge, CanvasNode, CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES, resolveNodeSourceImageUrl } from "@/features/canvas/domain/canvasNodes";
import { nodeMainlineFlags } from "@/features/canvas/domain/mainlineNodeFlags";
import { coerceSlotTarget, type SlotTarget } from "@/features/canvas/domain/mainlineNodeTypes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { isCommitCandidateData } from "@/features/freezone/commit/commitEligibility";
import {
  deriveCanvasEdgeSemanticSpec,
  normalizeCanvasEdgeSemanticKind,
  type CanvasEdgeSemanticKind,
} from "@/features/freezone/canvasEdgeSemantics";
import {
  getCanvasNodePrimaryOutputRole,
  getCanvasNodeSemanticSpec,
  type CanvasNodeIoRole,
} from "@/features/freezone/canvasNodeSemantics";

export const CANVAS_ONTOLOGY_CONTEXT_SCHEMA_VERSION = "canvas_ontology_context.v1";
export const CANVAS_ONTOLOGY_SUMMARY_SCHEMA_VERSION = "canvas_ontology_summary.v1";

export type CanvasOntologyObjectKind =
  | "action"
  | "candidate"
  | "mainline"
  | "free"
  | "group"
  | "unknown";

export type CanvasOntologyObject = {
  node_id: string;
  node_type: CanvasNodeType | null;
  object_kind: CanvasOntologyObjectKind;
  action_id: string | null;
  execution_state: string | null;
  label: string;
  media_type: string | null;
  media_kind: string | null;
  position: { x: number; y: number };
  slot_target: SlotTarget | null;
  candidate_origin: unknown;
  pushable: boolean;
  preset_managed: boolean;
  user_spawned: boolean;
  primary_output_role: CanvasNodeIoRole | null;
  accepted_input_roles: CanvasNodeIoRole[];
};

export type CanvasOntologyLink = {
  id: string;
  source: string;
  target: string;
  link_type: CanvasEdgeSemanticKind | null;
};

export type CanvasOntologySlot = {
  node_id: string;
  slot_kind: string;
  writable: boolean;
};

export type CanvasOntologyContext = {
  schema_version: typeof CANVAS_ONTOLOGY_CONTEXT_SCHEMA_VERSION;
  canvas_id: string;
  current_selection: string[];
  objects: CanvasOntologyObject[];
  links: CanvasOntologyLink[];
  slots: CanvasOntologySlot[];
  summary: {
    object_count: number;
    link_count: number;
    candidate_count: number;
    action_count: number;
    pushable_count: number;
  };
};

export type CanvasOntologySummaryObject = Pick<
  CanvasOntologyObject,
  "node_id" | "node_type" | "label" | "media_type" | "media_kind" | "object_kind" | "pushable" | "position"
>;

export type CanvasOntologySummaryActionNode = {
  node_id: string;
  skill_id: string;
  action: "run_skill";
  command_type: "run_node_action";
  label: string;
  execution_state: string | null;
};

export type CanvasOntologySummaryPushableCandidate = {
  node_id: string;
  slot_kind: string | null;
  label: string;
  media_type: string | null;
};

export type CanvasOntologySummary = {
  schema_version: typeof CANVAS_ONTOLOGY_SUMMARY_SCHEMA_VERSION;
  canvas_id: string;
  node_count: number;
  edge_count: number;
  selected_node_ids: string[];
  top_objects: CanvasOntologySummaryObject[];
  action_nodes: CanvasOntologySummaryActionNode[];
  pushable_candidates: CanvasOntologySummaryPushableCandidate[];
  links_sample: CanvasOntologyLink[];
};

export type BuildCanvasOntologyContextOptions = {
  canvasId: string;
  selectedNodeIds?: string[];
  maxObjects?: number;
  maxLinks?: number;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nodeOntologyMediaType(node: CanvasNode): string | null {
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
  const data = objectValue(node.data);
  return stringOrNull(data.media_kind);
}

export function nodeOntologySourceUrl(node: CanvasNode): string | null {
  const data = objectValue(node.data);
  return (
    resolveNodeSourceImageUrl(node) ||
    stringOrNull(data.previewImageUrl) ||
    stringOrNull(data.referenceImageUrl) ||
    stringOrNull(data.videoUrl) ||
    stringOrNull(data.audioUrl) ||
    stringOrNull(data.sourceUrl) ||
    stringOrNull(data.fileUrl) ||
    stringOrNull(data.modelUrl) ||
    stringOrNull(data.plyUrl) ||
    null
  );
}

function nodeActionId(node: CanvasNode): string | null {
  const data = objectValue(node.data);
  if (node.type === CANVAS_NODE_TYPES.skill) return stringOrNull(data.skill_id);
  return stringOrNull(data.action_id) ?? stringOrNull(data.capabilityId);
}

function nodeExecutionState(node: CanvasNode): string | null {
  const data = objectValue(node.data);
  return stringOrNull(data.execution_state) ?? (data.isGenerating === true ? "running" : null);
}

function nodeObjectKind(node: CanvasNode, actionId: string | null, pushable: boolean): CanvasOntologyObjectKind {
  if (actionId) return "action";
  if (node.type === CANVAS_NODE_TYPES.group) return "group";
  const flags = nodeMainlineFlags(node);
  if (pushable || (flags.isUserSpawned && flags.hasSlotTarget)) return "candidate";
  if (flags.isPresetManaged || flags.hasMainlineContext || flags.hasSlotTarget || flags.hasCommittedSlot) {
    return "mainline";
  }
  return node.type ? "free" : "unknown";
}

export function deriveCanvasOntologyObject(node: CanvasNode): CanvasOntologyObject {
  const data = objectValue(node.data);
  const flags = nodeMainlineFlags(node);
  const actionId = nodeActionId(node);
  const slotTarget = coerceSlotTarget(data.slot_target);
  const pushable = isCommitCandidateData(node.data);
  const semanticSpec = getCanvasNodeSemanticSpec(node.type);
  return {
    node_id: node.id,
    node_type: node.type ?? null,
    object_kind: nodeObjectKind(node, actionId, pushable),
    action_id: actionId,
    execution_state: nodeExecutionState(node),
    label: resolveNodeDisplayName(node.type, node.data),
    media_type: nodeOntologyMediaType(node),
    media_kind: stringOrNull(data.media_kind),
    position: { x: node.position.x, y: node.position.y },
    slot_target: slotTarget,
    candidate_origin: data.candidate_origin ?? null,
    pushable,
    preset_managed: flags.isPresetManaged,
    user_spawned: flags.isUserSpawned,
    primary_output_role: getCanvasNodePrimaryOutputRole({
      nodeType: node.type,
      data: node.data,
    }),
    accepted_input_roles: semanticSpec?.acceptedInputRoles ?? [],
  };
}

export function deriveCanvasOntologyLink(
  edge: CanvasEdge,
  nodeById?: ReadonlyMap<string, CanvasNode>,
): CanvasOntologyLink {
  const data = objectValue(edge.data);
  const rawExplicitLinkType = stringOrNull(data.link_type);
  const explicitLinkType = normalizeCanvasEdgeSemanticKind(rawExplicitLinkType);
  const semantics = deriveCanvasEdgeSemanticSpec({
    edge,
    sourceNode: nodeById?.get(edge.source),
    targetNode: nodeById?.get(edge.target),
  });
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    link_type: explicitLinkType ?? semantics?.kind ?? null,
  };
}

function deriveSlot(object: CanvasOntologyObject): CanvasOntologySlot | null {
  if (!object.slot_target?.kind) return null;
  return {
    node_id: object.node_id,
    slot_kind: object.slot_target.kind,
    writable: object.pushable || object.user_spawned || !object.preset_managed,
  };
}

export function buildCanvasOntologyContext(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: BuildCanvasOntologyContextOptions,
): CanvasOntologyContext {
  const selectedNodeIds = options.selectedNodeIds ?? [];
  const maxObjects = Math.max(1, options.maxObjects ?? 60);
  const maxLinks = Math.max(0, options.maxLinks ?? 120);
  const objects = nodes.map(deriveCanvasOntologyObject);
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const selected = new Set(selectedNodeIds);
  const sortedObjects = [...objects].sort((left, right) => {
    const selectedDelta = Number(selected.has(right.node_id)) - Number(selected.has(left.node_id));
    if (selectedDelta !== 0) return selectedDelta;
    const kindDelta = Number(right.pushable) - Number(left.pushable);
    if (kindDelta !== 0) return kindDelta;
    return left.position.y - right.position.y || left.position.x - right.position.x;
  });
  const limitedObjects = sortedObjects.slice(0, maxObjects);
  const includedIds = new Set(limitedObjects.map((object) => object.node_id));
  const links = edges
    .map((edge) => deriveCanvasOntologyLink(edge, nodeById))
    .filter((link) => includedIds.has(link.source) && includedIds.has(link.target))
    .slice(0, maxLinks);
  const slots = limitedObjects
    .map(deriveSlot)
    .filter((slot): slot is CanvasOntologySlot => Boolean(slot));

  return {
    schema_version: CANVAS_ONTOLOGY_CONTEXT_SCHEMA_VERSION,
    canvas_id: options.canvasId,
    current_selection: selectedNodeIds,
    objects: limitedObjects,
    links,
    slots,
    summary: {
      object_count: nodes.length,
      link_count: edges.length,
      candidate_count: objects.filter((object) => object.object_kind === "candidate").length,
      action_count: objects.filter((object) => object.object_kind === "action").length,
      pushable_count: objects.filter((object) => object.pushable).length,
    },
  };
}

function summaryPriority(object: CanvasOntologyObject, selected: ReadonlySet<string>): number {
  if (selected.has(object.node_id)) return 0;
  if (object.pushable) return 1;
  if (object.object_kind === "action") return 2;
  if (object.media_type) return 3;
  if (object.object_kind === "mainline") return 4;
  return 5;
}

export function buildCanvasOntologySummary(
  context: CanvasOntologyContext,
  options: { maxObjects?: number; maxLinks?: number } = {},
): CanvasOntologySummary {
  const maxObjects = Math.max(1, options.maxObjects ?? 30);
  const maxLinks = Math.max(0, options.maxLinks ?? 40);
  const selected = new Set(context.current_selection);
  const topObjects = [...context.objects]
    .sort((left, right) => {
      const priorityDelta = summaryPriority(left, selected) - summaryPriority(right, selected);
      if (priorityDelta !== 0) return priorityDelta;
      return left.position.y - right.position.y || left.position.x - right.position.x;
    })
    .slice(0, maxObjects)
    .map((object) => ({
      node_id: object.node_id,
      node_type: object.node_type,
      label: object.label,
      media_type: object.media_type,
      media_kind: object.media_kind,
      object_kind: object.object_kind,
      pushable: object.pushable,
      position: object.position,
    }));
  const includedIds = new Set(topObjects.map((object) => object.node_id));
  const slotByNodeId = new Map(context.slots.map((slot) => [slot.node_id, slot] as const));
  return {
    schema_version: CANVAS_ONTOLOGY_SUMMARY_SCHEMA_VERSION,
    canvas_id: context.canvas_id,
    node_count: context.summary.object_count,
    edge_count: context.summary.link_count,
    selected_node_ids: context.current_selection,
    top_objects: topObjects,
    action_nodes: context.objects
      .filter((object) => object.object_kind === "action" && object.action_id)
      .slice(0, 20)
      .map((object) => ({
        node_id: object.node_id,
        skill_id: object.action_id ?? "",
        action: "run_skill" as const,
        command_type: "run_node_action" as const,
        label: object.label,
        execution_state: object.execution_state,
      })),
    pushable_candidates: context.objects
      .filter((object) => object.pushable)
      .slice(0, 20)
      .map((object) => ({
        node_id: object.node_id,
        slot_kind: slotByNodeId.get(object.node_id)?.slot_kind ?? object.slot_target?.kind ?? null,
        label: object.label,
        media_type: object.media_type,
      })),
    links_sample: context.links
      .filter((link) => includedIds.has(link.source) && includedIds.has(link.target))
      .slice(0, maxLinks),
  };
}
