import type { CanvasEdge, CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES, type CanvasNodeData } from "@/features/canvas/domain/canvasNodes";
import {
  isPresetManagedNode,
  isSystemManagedNodeData,
} from "@/features/canvas/domain/mainlineNodeFlags";
import {
  VIDEO_UPSCALE_DENOISE_OPTIONS,
  VIDEO_UPSCALE_RESOLUTIONS,
} from "@/features/canvas/application/videoUpscale";
import { getDownstreamSpawnTypes } from "@/features/canvas/domain/nodeRegistry";
import { buildCanvasNodeActionCatalog } from "@/features/freezone/context/canvasActionCatalog";
import {
  isBeatContextAgentEditablePatch,
  normalizeCanvasCommandCreateNodeData,
  normalizeCanvasCommandNodeData,
} from "@/features/freezone/canvasCommandNodeData";
import {
  getCanvasNodePrimaryOutputRole,
  getCanvasNodeSemanticSpec,
  type CanvasNodeIoRole,
} from "@/features/freezone/canvasNodeSemantics";
import {
  allowedCanvasLinkTypesForNodes,
  canvasEdgeSemanticKindValues,
  canvasNodeLinkObjectType,
  isCanvasLinkTypeAllowed,
  normalizeCanvasEdgeSemanticKind,
} from "@/features/freezone/canvasEdgeSemantics";
import type { CanvasChatCommandEnvelope } from "@/features/freezone/canvasChatCommands";

export type CanvasCommandValidationIssue = {
  path: string;
  message: string;
};

export type CanvasCommandValidationResult = {
  ok: boolean;
  issues: CanvasCommandValidationIssue[];
};

const RESERVED_DATA_KEYS = new Set([
  "preset_managed",
  "projection_key",
  "projection_archived",
  "mainline_context",
  "slot_target",
  "committed_at",
  "committed_slot_url",
]);

const AUDIO_DOWNLOAD_FORMATS = new Set(["source", "mp3", "m4a", "wav"]);
const VIDEO_UPSCALE_RESOLUTION_VALUES = new Set<string>(VIDEO_UPSCALE_RESOLUTIONS);
const VIDEO_UPSCALE_DENOISE_VALUES = new Set<string>(VIDEO_UPSCALE_DENOISE_OPTIONS);

function hasReservedKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Partial<CanvasNodeData>).filter(
    (key) => key.startsWith("__") || RESERVED_DATA_KEYS.has(key),
  );
}

function commandPath(envelopeIndex: number, commandIndex: number): string {
  return `envelopes[${envelopeIndex}].commands[${commandIndex}]`;
}

function addIssue(issues: CanvasCommandValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function makeVirtualNode(command: {
  client_id?: string;
  node_type: CanvasNode["type"];
  data?: Partial<CanvasNodeData>;
}): CanvasNode | null {
  if (!command.client_id) return null;
  return {
    id: command.client_id,
    type: command.node_type,
    position: { x: 0, y: 0 },
    data: command.data ?? {},
  } as CanvasNode;
}

function validateModelEnumField(
  issues: CanvasCommandValidationIssue[],
  path: string,
  node: CanvasNode,
  data: Partial<CanvasNodeData>,
): void {
  const schema = buildCanvasNodeActionCatalog(node).editable_schema;
  for (const [field, value] of Object.entries(data)) {
    if (field !== "model") continue;
    if (value === undefined || value === null || value === "") continue;
    const fieldSchema = schema[field];
    if (fieldSchema?.type !== "enum") continue;
    const options = fieldSchema.options ?? [];
    if (options.length === 0) continue;
    if (options.some((option) => Object.is(option, value))) continue;
    addIssue(
      issues,
      path,
      `field ${field} value ${JSON.stringify(value)} is not a valid option for ${node.type}. ` +
        `Allowed values: ${options.map((option) => JSON.stringify(option)).join(", ")}. ` +
        "Request freezone_get_node_create_schema for this node_type and use exact options, or omit the field to use the frontend default.",
    );
  }
}

function expectedSourceRolesForLinkType(linkType: string): CanvasNodeIoRole[] {
  if (linkType === "context_for") return ["planning_text", "context_text"];
  if (linkType === "prompt_for") return ["input_text"];
  return [];
}

function inferredSourceRoleForBlankText(
  linkType: string,
  sourceNode: CanvasNode,
  targetNode: CanvasNode,
): CanvasNodeIoRole | null {
  if (sourceNode.type !== CANVAS_NODE_TYPES.textAnnotation) return null;
  const acceptedTargetRoles = getCanvasNodeSemanticSpec(targetNode.type)?.acceptedInputRoles ?? [];
  if (linkType === "prompt_for" && acceptedTargetRoles.includes("input_text")) {
    return "input_text";
  }
  if (linkType === "context_for") {
    if (acceptedTargetRoles.includes("context_text")) return "context_text";
    if (acceptedTargetRoles.includes("planning_text")) return "planning_text";
  }
  return null;
}

function validateEdgeIoRole(
  issues: CanvasCommandValidationIssue[],
  path: string,
  linkType: string,
  sourceNode: CanvasNode,
  targetNode: CanvasNode,
): void {
  const expectedSourceRoles = expectedSourceRolesForLinkType(linkType);
  if (expectedSourceRoles.length === 0) return;

  const sourceRole = getCanvasNodePrimaryOutputRole({
    nodeType: sourceNode.type,
    data: sourceNode.data,
  }) ?? inferredSourceRoleForBlankText(linkType, sourceNode, targetNode);
  const acceptedTargetRoles = getCanvasNodeSemanticSpec(targetNode.type)?.acceptedInputRoles ?? [];
  if (!sourceRole || !expectedSourceRoles.includes(sourceRole) || !acceptedTargetRoles.includes(sourceRole)) {
    addIssue(
      issues,
      path,
      `edge output role ${sourceRole || "none"} is not accepted by target ${targetNode.type} for link_type ${linkType}. ` +
      `Expected source role ${expectedSourceRoles.join(" or ")}; target accepts ${acceptedTargetRoles.join(", ") || "none"}. ` +
      `For prompt_for from textAnnotationNode to a generator, the source text must be direct input text. ` +
      `If the text node has no semanticOutputRole, prompt_for may infer input_text automatically. ` +
      `If the source is currently planning_text, do not change that existing brief/planning node to input_text merely to satisfy prompt_for. ` +
      `Use one of two fixes: if it is only documentation, remove the edge and group it with the generator instead of connecting it directly; ` +
      `if generation should use the planning content, create a separate textAnnotationNode with semanticOutputRole="input_text" for the actual prompt, optionally connect planning_text -> input_text with context_for, then connect input_text -> generator with prompt_for.`,
    );
  }
}

function missingNodeMessage(id: string, role: "source" | "target" | "node" = "node"): string {
  const prefix = role === "source"
    ? "source node not found"
    : role === "target"
      ? "target node not found"
      : "node not found";
  const temporaryIdHint = /^auto:\d+$/i.test(id)
    ? " auto:* ids are temporary client_id aliases and can only be referenced later in the same command envelope; use an existing canvas node id from current context or call the relevant Freezone context tool."
    : "";
  return `${prefix}: ${id}${temporaryIdHint ? `.${temporaryIdHint}` : ""}`;
}

export function validateCanvasChatCommandEnvelopes(
  envelopes: CanvasChatCommandEnvelope[],
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasCommandValidationResult {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const nodeById = new Map<string, CanvasNode>(nodes.map((node) => [node.id, node] as const));
  const clientIds = new Set<string>();
  const issues: CanvasCommandValidationIssue[] = [];

  const isKnownNodeRef = (id: string): boolean => nodeIds.has(id) || clientIds.has(id);
  const isKnownDeleteRef = (id: string): boolean => isKnownNodeRef(id) || edgeIds.has(id);

  envelopes.forEach((envelope, envelopeIndex) => {
    envelope.commands.forEach((command, commandIndex) => {
      const path = commandPath(envelopeIndex, commandIndex);
      switch (command.type) {
        case "clear_canvas":
          // The executor resolves the current canvas contents at approval
          // time, so there are no ids to validate in the command payload.
          break;
        case "create_node": {
          const data = normalizeCanvasCommandCreateNodeData(command.node_type, command.data);
          const virtualNode = makeVirtualNode({
            client_id: command.client_id,
            node_type: command.node_type,
            data,
          });
          if (virtualNode) {
            clientIds.add(virtualNode.id);
            nodeById.set(virtualNode.id, virtualNode);
          } else if (command.client_id) {
            clientIds.add(command.client_id);
          }
          const reserved = hasReservedKeys(data);
          if (reserved.length > 0) {
            addIssue(issues, path, `reserved data fields are not allowed: ${reserved.join(", ")}`);
          }
          validateModelEnumField(
            issues,
            path,
            virtualNode ?? ({
              id: `__validate__:${command.node_type}`,
              type: command.node_type,
              position: { x: 0, y: 0 },
              data,
            } as CanvasNode),
            data,
          );
          break;
        }
        case "add_next_node": {
          if (!isKnownNodeRef(command.source_node_id)) {
            addIssue(issues, path, missingNodeMessage(command.source_node_id, "source"));
          }
          const sourceNode = nodeById.get(command.source_node_id);
          let nodeType = command.node_type;
          if (sourceNode && command.node_type) {
            const allowed = getDownstreamSpawnTypes(sourceNode.type);
            if (!allowed.includes(command.node_type)) {
              addIssue(
                issues,
                path,
                `node_type ${command.node_type} is not allowed downstream of ${sourceNode.type}. ` +
                `Allowed downstream types: ${allowed.join(", ") || "none"}. ` +
                "Request neighbor_graph and attach to a compatible upstream text/script/beat context source, or create the node standalone.",
              );
            }
          } else if (sourceNode && !nodeType) {
            nodeType = getDownstreamSpawnTypes(sourceNode.type)[0];
          }
          const data = normalizeCanvasCommandCreateNodeData(nodeType, command.data);
          if (command.client_id && nodeType) {
            const virtualNode = makeVirtualNode({
              client_id: command.client_id,
              node_type: nodeType,
              data,
            });
            if (virtualNode) {
              clientIds.add(virtualNode.id);
              nodeById.set(virtualNode.id, virtualNode);
            }
          } else if (command.client_id) {
            clientIds.add(command.client_id);
          }
          const reserved = hasReservedKeys(data);
          if (reserved.length > 0) {
            addIssue(issues, path, `reserved data fields are not allowed: ${reserved.join(", ")}`);
          }
          if (nodeType) {
            validateModelEnumField(
              issues,
              path,
              {
                id: command.client_id ?? `__validate__:${nodeType}`,
                type: nodeType,
                position: { x: 0, y: 0 },
                data,
              } as CanvasNode,
              data,
            );
          }
          break;
        }
        case "update_node_data": {
          if (!isKnownNodeRef(command.node_id)) {
            addIssue(issues, path, missingNodeMessage(command.node_id));
            break;
          }
          const target = nodeById.get(command.node_id);
          const data = normalizeCanvasCommandNodeData(target?.type, command.data);
          const isAllowedPresetBeatContextPatch =
            target?.type === CANVAS_NODE_TYPES.beatContext && isBeatContextAgentEditablePatch(data);
          if (target && isPresetManagedNode(target) && !isAllowedPresetBeatContextPatch) {
            addIssue(issues, path, `node is preset managed: ${command.node_id}`);
          }
          const reserved = hasReservedKeys(data);
          if (reserved.length > 0) {
            addIssue(issues, path, `reserved data fields are not allowed: ${reserved.join(", ")}`);
          }
          if (target) {
            const editable = new Set(buildCanvasNodeActionCatalog(target).editable_fields);
            const invalid = Object.keys(data).filter((key) => !editable.has(key));
            if (invalid.length > 0) {
              addIssue(issues, path, `fields are not editable on this node: ${invalid.join(", ")}`);
            }
            validateModelEnumField(
              issues,
              path,
              { ...target, data: { ...target.data, ...data } as CanvasNodeData },
              data,
            );
          }
          break;
        }
        case "delete_nodes": {
          const projectionNodeIdsByKey = new Map<string, Set<string>>();
          for (const id of command.node_ids) {
            if (!isKnownDeleteRef(id)) addIssue(issues, path, `node or edge not found: ${id}`);
            const target = nodeById.get(id);
            if (target && isSystemManagedNodeData(target.data)) {
              const projectionKey = projectionKeyFromNode(target);
              if (!projectionKey) {
                addIssue(issues, path, `node is mainline projection managed and cannot be deleted directly: ${id}`);
                continue;
              }
              let ids = projectionNodeIdsByKey.get(projectionKey);
              if (!ids) {
                ids = new Set<string>();
                projectionNodeIdsByKey.set(projectionKey, ids);
              }
              ids.add(id);
            }
          }
          for (const [projectionKey, requestedIds] of projectionNodeIdsByKey) {
            const allProjectionNodeIds = [...nodeById.values()]
              .filter((node) => projectionKeyFromNode(node) === projectionKey)
              .map((node) => node.id);
            const hasWholeProjection = allProjectionNodeIds.every((id) => requestedIds.has(id));
            if (!hasWholeProjection) {
              const firstRequestedId = requestedIds.values().next().value ?? projectionKey;
              addIssue(
                issues,
                path,
                `node is mainline projection managed and cannot be deleted directly: ${firstRequestedId}`,
              );
            }
          }
          break;
        }
        case "delete_edges": {
          for (const id of command.edge_ids ?? []) {
            if (!edgeIds.has(id)) addIssue(issues, path, `edge not found: ${id}`);
          }
          for (const pair of command.pairs ?? []) {
            if (!isKnownNodeRef(pair.source)) addIssue(issues, path, missingNodeMessage(pair.source, "source"));
            if (!isKnownNodeRef(pair.target)) addIssue(issues, path, missingNodeMessage(pair.target, "target"));
          }
          break;
        }
        case "create_edge": {
          if (!isKnownNodeRef(command.source)) addIssue(issues, path, missingNodeMessage(command.source, "source"));
          if (!isKnownNodeRef(command.target)) addIssue(issues, path, missingNodeMessage(command.target, "target"));
          const linkType = normalizeCanvasEdgeSemanticKind(command.link_type);
          if (!linkType) {
            addIssue(
              issues,
              path,
              `create_edge.link_type is required and must be one of: ${canvasEdgeSemanticKindValues().join(", ")}`,
            );
          } else {
            const sourceNode = nodeById.get(command.source);
            const targetNode = nodeById.get(command.target);
            if (sourceNode && targetNode && !isCanvasLinkTypeAllowed(linkType, sourceNode, targetNode)) {
              const sourceType = canvasNodeLinkObjectType(sourceNode) ?? sourceNode.type;
              const targetType = canvasNodeLinkObjectType(targetNode) ?? targetNode.type;
              const allowed = allowedCanvasLinkTypesForNodes(sourceNode, targetNode);
              addIssue(
                issues,
                path,
                `link_type ${linkType} is not valid for ${sourceType} -> ${targetType}. ` +
                `Allowed link_type values: ${allowed.join(", ") || "none"}. Request link_type_catalog before creating the edge.`,
              );
            }
            if (sourceNode && targetNode) {
              validateEdgeIoRole(issues, path, linkType, sourceNode, targetNode);
            }
          }
          break;
        }
        case "layout_nodes": {
          for (const id of command.node_ids ?? []) {
            if (!isKnownNodeRef(id)) addIssue(issues, path, missingNodeMessage(id));
          }
          break;
        }
        case "group_nodes": {
          if (command.node_ids.length < 2) {
            addIssue(issues, path, "group requires at least two nodes");
          }
          for (const id of command.node_ids) {
            if (!isKnownNodeRef(id)) addIssue(issues, path, missingNodeMessage(id));
          }
          break;
        }
        case "move_nodes": {
          const ids = [
            ...Object.keys(command.positions ?? {}),
            ...Object.keys(command.deltas ?? {}),
          ];
          for (const id of ids) {
            if (!isKnownNodeRef(id)) addIssue(issues, path, missingNodeMessage(id));
          }
          break;
        }
        case "select_nodes": {
          for (const id of command.node_ids) {
            if (!isKnownNodeRef(id)) addIssue(issues, path, missingNodeMessage(id));
          }
          break;
        }
        case "run_node_action": {
          const target = nodeById.get(command.node_id);
          if (!target) {
            addIssue(issues, path, `node not found: ${command.node_id}`);
            break;
          }
          const action = buildCanvasNodeActionCatalog(target, { nodes, edges }).actions.find(
            (item) => item.action === command.action,
          );
          if (!action) {
            addIssue(issues, path, `action not available on node: ${command.action}`);
          } else if (action.execution === "chat_command") {
            addIssue(issues, path, `action must be expressed as a canvas chat command: ${command.action}`);
          } else if (action.can_run_now === false) {
            const reasons = Array.isArray(action.blocked_reasons) && action.blocked_reasons.length > 0
              ? action.blocked_reasons.join("; ")
              : `action is blocked: ${command.action}`;
            addIssue(issues, path, `action preconditions are not satisfied: ${reasons}`);
          }
          if (target.type === CANVAS_NODE_TYPES.audio && command.action === "download_audio") {
            const format =
              command.parameters &&
              typeof command.parameters === "object" &&
              !Array.isArray(command.parameters)
                ? (command.parameters as Record<string, unknown>).format
                : undefined;
            if (format !== undefined && (typeof format !== "string" || !AUDIO_DOWNLOAD_FORMATS.has(format))) {
              addIssue(issues, path, `unsupported audio download format: ${String(format)}`);
            }
          }
          if (target.type === CANVAS_NODE_TYPES.video && command.action === "open_video_upscale_tool") {
            const params =
              command.parameters &&
              typeof command.parameters === "object" &&
              !Array.isArray(command.parameters)
                ? (command.parameters as Record<string, unknown>)
                : {};
            const resolution = params.resolution;
            if (
              resolution !== undefined &&
              (typeof resolution !== "string" || !VIDEO_UPSCALE_RESOLUTION_VALUES.has(resolution))
            ) {
              addIssue(issues, path, `unsupported video upscale resolution: ${String(resolution)}`);
            }
            const denoise = params.denoise;
            if (
              denoise !== undefined &&
              (typeof denoise !== "string" || !VIDEO_UPSCALE_DENOISE_VALUES.has(denoise))
            ) {
              addIssue(issues, path, `unsupported video upscale denoise: ${String(denoise)}`);
            }
          }
          break;
        }
        case "open_mainline_projection": {
          const request = command.request;
          if (request.scope === "episode" && typeof request.episode !== "number") {
            addIssue(issues, path, "open_mainline_projection episode scope requires episode");
          }
          if (request.scope === "beat") {
            if (typeof request.episode !== "number") {
              addIssue(issues, path, "open_mainline_projection beat scope requires episode");
            }
            if (typeof request.beat !== "number") {
              addIssue(issues, path, "open_mainline_projection beat scope requires beat");
            }
          }
          if (request.scope === "asset") {
            if (typeof request.asset_kind !== "string" || !request.asset_kind.trim()) {
              addIssue(issues, path, "open_mainline_projection asset scope requires asset_kind");
            }
            if (
              !(typeof request.character === "string" && request.character.trim()) &&
              !(typeof request.identity_id === "string" && request.identity_id.trim()) &&
              !(typeof request.asset_id === "string" && request.asset_id.trim())
            ) {
              addIssue(
                issues,
                path,
                "open_mainline_projection asset scope requires character, identity_id, or asset_id",
              );
            }
          }
          break;
        }
        case "run_workflow": {
          for (const id of command.node_ids ?? []) {
            if (!isKnownNodeRef(id)) addIssue(issues, path, missingNodeMessage(id));
          }
          break;
        }
        default:
          break;
      }
    });
  });

  return {
    ok: issues.length === 0,
    issues,
  };
}

function projectionKeyFromNode(node: CanvasNode): string | null {
  const data = node.data as { projection_key?: unknown } | undefined;
  return typeof data?.projection_key === "string" && data.projection_key.trim()
    ? data.projection_key.trim()
    : null;
}
