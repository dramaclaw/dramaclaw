// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezonePresetCanvasRequest } from "@/api/canvas";
import type { CanvasNodeData, CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import type { CanvasEdgeSemanticKind } from "@/features/freezone/canvasEdgeSemantics";
import type { HtmlArtifactCommand } from "@/features/html-artifacts/commandSchema";

export const CANVAS_CHAT_COMMANDS_SCHEMA_VERSION = "canvas_chat_commands.v1";

export type JsonRecord = Record<string, unknown>;
type MainlineProjectionScope = "episode" | "beat" | "asset";
export type MainlineProjectionRequest = Omit<
  FreezonePresetCanvasRequest,
  "canvas_id" | "overwrite_existing" | "base_revision" | "scope"
> & {
  scope: MainlineProjectionScope;
};

export type CanvasChatCommand =
  | HtmlArtifactCommand
  | {
      type: "create_node";
      client_id?: string;
      node_type: CanvasNodeType;
      position?: { x: number; y: number };
      data?: Partial<CanvasNodeData>;
    }
  | {
      type: "add_next_node";
      client_id?: string;
      source_node_id: string;
      node_type?: CanvasNodeType;
      data?: Partial<CanvasNodeData>;
      connect?: boolean;
    }
  | {
      type: "update_node_data";
      node_id: string;
      data: Partial<CanvasNodeData>;
    }
  | {
      type: "delete_nodes";
      node_ids: string[];
    }
  | {
      type: "clear_canvas";
    }
  | {
      type: "delete_edges";
      edge_ids?: string[];
      pairs?: Array<{ source: string; target: string }>;
    }
  | {
      type: "create_edge";
      source: string;
      target: string;
      link_type: CanvasEdgeSemanticKind;
      expected_source_image_url?: string;
      expected_source_video_url?: string;
    }
  | {
      type: "layout_nodes";
      node_ids?: string[];
      mode: "horizontal" | "vertical" | "grid";
    }
  | {
      type: "group_nodes";
      node_ids: string[];
      label?: string;
    }
  | {
      type: "move_nodes";
      positions?: Record<string, { x: number; y: number }>;
      deltas?: Record<string, { x: number; y: number }>;
    }
  | {
      type: "select_nodes";
      node_ids: string[];
      focus?: boolean;
    }
  | {
      type: "run_node_action";
      node_id: string;
      action: string;
      parameters?: JsonRecord;
    }
  | {
      type: "open_mainline_projection";
      project_id?: string;
      request: MainlineProjectionRequest;
    }
  | {
      type: "run_workflow";
      node_ids?: string[];
      scope?: "selection" | "canvas";
      direction?: "connected" | "node" | "downstream";
      regenerate?: boolean;
    };

export type CanvasChatCommandEnvelope = {
  schema_version: typeof CANVAS_CHAT_COMMANDS_SCHEMA_VERSION;
  project_id?: string;
  canvas_id?: string;
  external_mcp_command?: boolean;
  auto_apply_after_mcp_approval?: boolean;
  autoApplyAfterMcpApproval?: boolean;
  commands: CanvasChatCommand[];
};

export type CanvasChatCommandApplyResult = {
  applied: number;
  openedUiActions: number;
  createdNodeIds: string[];
  errors: string[];
  warnings?: string[];
  commandResults: CanvasChatCommandApplyStep[];
};

export type CanvasChatCommandApplyStep = {
  commandIndex: number;
  type: CanvasChatCommand["type"] | "validate";
  status: "success" | "pending" | "error" | "unverified";
  label: string;
  nodeId?: string;
  action?: string;
  createdNodeId?: string;
  output?: Record<string, unknown>;
  error?: string;
};
