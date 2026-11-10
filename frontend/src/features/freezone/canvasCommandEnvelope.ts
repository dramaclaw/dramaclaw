// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNodeData, CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { CANVAS_CHAT_COMMANDS_SCHEMA_VERSION, type CanvasChatCommand, type CanvasChatCommandEnvelope, type JsonRecord, type MainlineProjectionRequest } from '@/features/canvas/core/commands/types';
import { isAgentCreatableCanvasNodeType } from './agentCreatableNodeTypes';
import { normalizeCanvasEdgeSemanticKind } from './canvasEdgeSemantics';
import { isAgentExecutableNodeAction } from './canvasNodeActionCatalog';
import { parseHtmlArtifactCommand } from '@/features/html-artifacts/commandSchema';

const RESERVED_DATA_KEYS = new Set([
  "node_type",
  "preset_managed",
  "projection_key",
  "projection_archived",
  "mainline_context",
  "slot_target",
  "committed_at",
  "committed_slot_url",
]);
const RUN_NODE_ACTIONS = new Set([
  "translate_text",
  "reverse_prompt",
  "generate_text",
  "generate_html",
  "update_source",
  "select_version",
  "restore",
  "open",
  "export",
  "upload",
  "generate_text_video",
  "generate_story_script",
  "open_upload_picker",
  "generate_image",
  "generate_audio",
  "open_voice_picker",
  "generate_video",
  "run_skill",
  "open_video_compose_modal",
  "auto_compose_video",
  "open_director_world",
  "generate_3gs_world",
  "open_crop_tool",
  "open_annotate_tool",
  "open_split_storyboard_tool",
  "run_matting_tool",
  "run_upscale_tool",
  "open_redraw_tool",
  "open_erase_tool",
  "open_upscale_tool",
  "run_outpaint_tool",
  "open_outpaint_tool",
  "run_scene360_tool",
  "open_scene360_tool",
  "open_multi_angle_tool",
  "open_light_tool",
  "open_rotate_tool",
  "run_grid_multi_camera",
  "open_grid_multi_camera",
  "run_grid_plot_four",
  "open_grid_plot_four",
  "run_grid_face_three_view",
  "open_grid_face_three_view",
  "run_grid_product_three_view",
  "open_grid_product_three_view",
  "run_grid_serial_storyboard_25",
  "open_grid_serial_storyboard_25",
  "run_grid_cinematic_light_correction",
  "open_grid_cinematic_light_correction",
  "run_grid_character_three_view",
  "open_grid_character_three_view",
  "run_grid_scene_setting_sheet",
  "open_grid_scene_setting_sheet",
  "run_grid_frame_projection_3s_later",
  "open_grid_frame_projection_3s_later",
  "run_grid_frame_projection_5s_earlier",
  "open_grid_frame_projection_5s_earlier",
  "open_video_viewer",
  "capture_video_last_frame",
  "capture_video_first_frame",
  "download_image",
  "download_video",
  "open_video_clip_tool",
  "open_video_upscale_tool",
  "run_video_analyze_story",
  "run_audio_separate",
  "download_audio",
  "capture_pano_current_view",
  "capture_pano_2x2_views",
  "capture_pano_4x3_views",
  "set_pano_current_view_as_background",
  "reset_pano_view",
  "open_video_subtitle_erase_smart",
  "open_video_subtitle_erase_box",
  "run_video_breakdown",
  "open_video_crop_tool",
  "open_video_extend_tool",
  "run_video_depth_capture",
  "start_video_breakdown",
]);

export function isCanvasChatRunNodeAction(action: string): boolean {
  return RUN_NODE_ACTIONS.has(action);
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCanvasNodeType(value: unknown): value is CanvasNodeType {
  return isAgentCreatableCanvasNodeType(value);
}

function readClientId(value: JsonRecord): string | undefined {
  const clientId =
    typeof value.client_id === "string"
      ? value.client_id
      : typeof value.clientId === "string"
        ? value.clientId
        : typeof value.id === "string"
          ? value.id
          : "";
  const trimmed = clientId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPosition(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function cleanNodeData(value: unknown): Partial<CanvasNodeData> {
  if (!isRecord(value)) return {};
  const data: JsonRecord = {};
  for (const [key, nextValue] of Object.entries(value)) {
    if (key.startsWith("__") || RESERVED_DATA_KEYS.has(key)) continue;
    data[key] = nextValue;
  }
  return data as Partial<CanvasNodeData>;
}

function cleanNodePositions(value: unknown): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const nodeId =
        typeof item.node_id === "string"
          ? item.node_id
          : typeof item.nodeId === "string"
            ? item.nodeId
            : typeof item.id === "string"
              ? item.id
              : "";
      if (!nodeId.trim()) continue;
      if (isPosition(item.position)) {
        positions[nodeId] = item.position;
      } else if (isPosition(item)) {
        positions[nodeId] = { x: item.x, y: item.y };
      }
    }
    return positions;
  }
  if (!isRecord(value)) return {};
  for (const [nodeId, position] of Object.entries(value)) {
    if (!nodeId.trim() || !isPosition(position)) continue;
    positions[nodeId] = position;
  }
  return positions;
}

function cleanNodeDeltas(value: unknown): Record<string, { x: number; y: number }> {
  const deltas: Record<string, { x: number; y: number }> = {};
  const readDelta = (item: JsonRecord): { x: number; y: number } | null => {
    if (isPosition(item.delta)) return item.delta;
    if (isPosition(item.offset)) return item.offset;
    const dx = isFiniteNumber(item.dx) ? item.dx : isFiniteNumber(item.x_delta) ? item.x_delta : undefined;
    const dy = isFiniteNumber(item.dy) ? item.dy : isFiniteNumber(item.y_delta) ? item.y_delta : undefined;
    if (dx === undefined && dy === undefined) return null;
    return { x: dx ?? 0, y: dy ?? 0 };
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const nodeId =
        typeof item.node_id === "string"
          ? item.node_id
          : typeof item.nodeId === "string"
            ? item.nodeId
            : typeof item.id === "string"
              ? item.id
              : "";
      if (!nodeId.trim()) continue;
      const delta = readDelta(item);
      if (delta) deltas[nodeId] = delta;
    }
    return deltas;
  }

  if (!isRecord(value)) return {};
  for (const [nodeId, deltaValue] of Object.entries(value)) {
    if (!nodeId.trim()) continue;
    if (isPosition(deltaValue)) {
      deltas[nodeId] = deltaValue;
      continue;
    }
    if (!isRecord(deltaValue)) continue;
    const delta = readDelta(deltaValue);
    if (delta) deltas[nodeId] = delta;
  }
  return deltas;
}

function cleanActionParameters(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const parameters: JsonRecord = {};
  for (const [key, nextValue] of Object.entries(value)) {
    if (key.startsWith("__")) continue;
    parameters[key] = nextValue;
  }
  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

function isTruthyRegenerateValue(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "y", "重新生成", "重生成", "覆盖"].includes(value.trim().toLowerCase());
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanOptionalNumber(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return Math.trunc(value);
}

function parseMainlineProjectionRequest(value: JsonRecord): MainlineProjectionRequest | null {
  const source = isRecord(value.request) ? value.request : value;
  const scope = source.scope;
  if (scope !== "episode" && scope !== "beat" && scope !== "asset") return null;
  const request: MainlineProjectionRequest = { scope };
  const episode = cleanOptionalNumber(source.episode);
  const beat = cleanOptionalNumber(source.beat);
  const primarySlot = cleanOptionalString(source.primary_slot ?? source.primarySlot);
  const assetKind = cleanOptionalString(source.asset_kind ?? source.assetKind);
  const character = cleanOptionalString(source.character);
  const identityId = cleanOptionalString(source.identity_id ?? source.identityId);
  const assetId = cleanOptionalString(source.asset_id ?? source.assetId);

  if (episode !== undefined) request.episode = episode;
  if (beat !== undefined) request.beat = beat;
  if (primarySlot) request.primary_slot = primarySlot;
  if (assetKind) request.asset_kind = assetKind;
  if (character) request.character = character;
  if (identityId) request.identity_id = identityId;
  if (assetId) request.asset_id = assetId;
  return request;
}

function parseCommand(value: unknown): CanvasChatCommand | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "html_artifact": return parseHtmlArtifactCommand(value);
    case "create_node": {
      const rawNodeType =
        value.node_type ??
        (isRecord(value.data) ? value.data.node_type : undefined);
      if (!isCanvasNodeType(rawNodeType)) return null;
      return {
        type: "create_node",
        client_id: readClientId(value),
        node_type: rawNodeType,
        position: isPosition(value.position) ? value.position : undefined,
        data: cleanNodeData(value.data),
      };
    }
    case "add_next_node":
      if (typeof value.source_node_id !== "string" || !value.source_node_id.trim()) return null;
      if (value.node_type !== undefined && !isCanvasNodeType(value.node_type)) return null;
      return {
        type: "add_next_node",
        client_id: readClientId(value),
        source_node_id: value.source_node_id,
        node_type: value.node_type as CanvasNodeType | undefined,
        data: cleanNodeData(value.data),
        connect: value.connect !== false,
      };
    case "update_node_data":
      if (typeof value.node_id !== "string" || !value.node_id.trim()) return null;
      return {
        type: "update_node_data",
        node_id: value.node_id,
        data: cleanNodeData(value.data ?? value.patch),
      };
    case "delete_nodes":
      if (!Array.isArray(value.node_ids)) return null;
      {
        const nodeIds = value.node_ids.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        );
        // An empty delete request is not a "clear canvas" operation. Reject it
        // so the agent must first read the canvas and provide concrete ids.
        if (nodeIds.length === 0) return null;
        return {
        type: "delete_nodes",
          node_ids: nodeIds,
        };
      }
    case "clear_canvas":
      return { type: "clear_canvas" };
    case "delete_edges": {
      const edgeIds = Array.isArray(value.edge_ids)
        ? value.edge_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : undefined;
      const pairs = Array.isArray(value.pairs)
        ? value.pairs
          .filter((pair): pair is JsonRecord => isRecord(pair))
          .filter((pair) => typeof pair.source === "string" && typeof pair.target === "string")
          .map((pair) => ({ source: String(pair.source), target: String(pair.target) }))
        : undefined;
      if ((edgeIds?.length ?? 0) === 0 && (pairs?.length ?? 0) === 0) return null;
      return {
        type: "delete_edges",
        edge_ids: edgeIds,
        pairs,
      };
    }
    case "create_edge":
      if (typeof value.source !== "string" || typeof value.target !== "string") return null;
      {
        const linkType = normalizeCanvasEdgeSemanticKind(value.link_type);
        if (!linkType) return null;
        return {
          type: "create_edge",
          source: value.source,
          target: value.target,
          link_type: linkType,
          expected_source_image_url: typeof value.expected_source_image_url === "string"
            ? value.expected_source_image_url : undefined,
          expected_source_video_url: typeof value.expected_source_video_url === "string"
            ? value.expected_source_video_url : undefined,
        };
      }
    case "layout_nodes":
      if (value.mode !== "horizontal" && value.mode !== "vertical" && value.mode !== "grid") return null;
      return {
        type: "layout_nodes",
        node_ids: Array.isArray(value.node_ids)
          ? value.node_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          : undefined,
        mode: value.mode,
      };
    case "group_nodes":
      if (!Array.isArray(value.node_ids)) return null;
      return {
        type: "group_nodes",
        node_ids: value.node_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        label: typeof value.label === "string" && value.label.trim().length > 0
          ? value.label.trim()
          : undefined,
      };
    case "move_nodes": {
      let positions = cleanNodePositions(value.positions ?? value.nodes ?? value.moves);
      let deltas = cleanNodeDeltas(value.deltas ?? value.delta_positions ?? value.nodes ?? value.moves);
      if (
        Object.keys(positions).length === 0 &&
        (typeof value.node_id === "string" || typeof value.nodeId === "string") &&
        isPosition(value.position)
      ) {
        positions = {
          [typeof value.node_id === "string" ? value.node_id : String(value.nodeId)]: value.position,
        };
      }
      if (
        Object.keys(deltas).length === 0 &&
        (typeof value.node_id === "string" || typeof value.nodeId === "string") &&
        isRecord(value.delta)
      ) {
        deltas = cleanNodeDeltas([
          {
            node_id: typeof value.node_id === "string" ? value.node_id : String(value.nodeId),
            delta: value.delta,
          },
        ]);
      }
      if (
        Object.keys(deltas).length === 0 &&
        (typeof value.node_id === "string" || typeof value.nodeId === "string") &&
        (isFiniteNumber(value.dx) || isFiniteNumber(value.dy))
      ) {
        deltas = {
          [typeof value.node_id === "string" ? value.node_id : String(value.nodeId)]: {
            x: isFiniteNumber(value.dx) ? value.dx : 0,
            y: isFiniteNumber(value.dy) ? value.dy : 0,
          },
        };
      }
      if (
        Object.keys(deltas).length === 0 &&
        Array.isArray(value.node_ids) &&
        (isFiniteNumber(value.dx) || isFiniteNumber(value.dy))
      ) {
        deltas = Object.fromEntries(
          value.node_ids
            .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            .map((id) => [
              id,
              {
                x: isFiniteNumber(value.dx) ? value.dx : 0,
                y: isFiniteNumber(value.dy) ? value.dy : 0,
              },
            ]),
        );
      }
      if (Object.keys(positions).length === 0 && Object.keys(deltas).length === 0) return null;
      return {
        type: "move_nodes",
        positions: Object.keys(positions).length > 0 ? positions : undefined,
        deltas: Object.keys(deltas).length > 0 ? deltas : undefined,
      };
    }
    case "select_nodes":
      if (!Array.isArray(value.node_ids)) return null;
      return {
        type: "select_nodes",
        node_ids: value.node_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0),
        focus: value.focus !== false,
      };
    case "run_node_action":
      if (typeof value.node_id !== "string" || !value.node_id.trim()) return null;
      if (typeof value.action !== "string" || !value.action.trim()) return null;
      if (!isAgentExecutableNodeAction(value.action.trim())) return null;
      if (!RUN_NODE_ACTIONS.has(value.action.trim())) return null;
      return {
        type: "run_node_action",
        node_id: value.node_id,
        action: value.action.trim(),
        parameters: cleanActionParameters(value.parameters ?? value.params),
      };
    case "open_mainline_projection": {
      const request = parseMainlineProjectionRequest(value);
      if (!request) return null;
      return {
        type: "open_mainline_projection",
        project_id: cleanOptionalString(value.project_id ?? value.projectId),
        request,
      };
    }
    case "run_workflow": {
      const nodeIds = Array.isArray(value.node_ids)
        ? value.node_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : undefined;
      const scope = value.scope === "canvas" || value.scope === "selection" ? value.scope : undefined;
      const direction =
        value.direction === "node" || value.direction === "downstream" || value.direction === "connected"
          ? value.direction
          : undefined;
      const regenerate = isTruthyRegenerateValue(value.regenerate ?? value.force_regenerate ?? value.forceRegenerate);
      return {
        type: "run_workflow",
        node_ids: nodeIds && nodeIds.length > 0 ? nodeIds : undefined,
        scope,
        direction,
        regenerate: regenerate || undefined,
      };
    }
    default:
      return null;
  }
}

function parseEnvelope(value: unknown): CanvasChatCommandEnvelope | null {
  if (!isRecord(value)) return null;
  const schema = value.schema_version ?? value.schemaVersion;
  if (schema !== CANVAS_CHAT_COMMANDS_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.commands)) return null;
  const commands = value.commands
    .map(parseCommand)
    .filter((command): command is CanvasChatCommand => Boolean(command));
  if (commands.length === 0) return null;
  return {
    schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
    project_id:
      typeof value.project_id === "string"
        ? value.project_id
        : typeof value.projectId === "string"
          ? value.projectId
          : undefined,
    canvas_id:
      typeof value.canvas_id === "string"
        ? value.canvas_id
        : typeof value.canvasId === "string"
          ? value.canvasId
          : undefined,
    external_mcp_command:
      value.external_mcp_command === true || value.externalMcpCommand === true,
    auto_apply_after_mcp_approval: value.auto_apply_after_mcp_approval === true,
    autoApplyAfterMcpApproval: value.autoApplyAfterMcpApproval === true,
    commands,
  };
}

export function extractCanvasChatCommandEnvelopes(values: unknown[]): CanvasChatCommandEnvelope[] {
  const seen = new Set<string>();
  return values
    .map(parseEnvelope)
    .filter((envelope): envelope is CanvasChatCommandEnvelope => {
      if (!envelope) return false;
      const signature = JSON.stringify(envelope);
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
}

