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
import {
  getDownstreamSpawnTypes,
  isUpstreamConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from "@/features/canvas/domain/nodeRegistry";
import {
  isPresetManagedNode,
  isSystemManagedNodeData,
} from "@/features/canvas/domain/mainlineNodeFlags";
import { inheritMainlineFields, type MainlineFieldsSource } from "@/features/canvas/domain/inheritMainlineFields";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import {
  clearPendingNodeAction,
  dispatchNodeAction,
} from "@/features/canvas/application/nodeActionResult";
import {
  createFreezoneWorkflowRun,
  updateFreezoneWorkflowRun,
  type FreezonePresetCanvasRequest,
  type WorkflowRunActionStatus,
} from "@/api/canvas";
import {
  getProjectTaskLimits,
  type ProjectTaskLimits,
} from "@/api/tasks";
import { ApiError } from "@/api/client";
import { isAgentCreatableCanvasNodeType } from "@/features/freezone/agentCreatableNodeTypes";
import { buildCanvasNodeActionCatalog } from "@/features/freezone/canvasNodeActionCatalog";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import {
  isBeatContextAgentEditablePatch,
  normalizeBeatContextAgentPatch,
  normalizeCanvasCommandCreateNodeData,
  normalizeCanvasCommandNodeData,
} from "@/features/freezone/canvasCommandNodeData";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import {
  normalizeCanvasEdgeSemanticKind,
  type CanvasEdgeSemanticKind,
} from "@/features/freezone/canvasEdgeSemantics";
import { useCanvasStore } from "@/stores/canvasStore";
import { deterministicNodeOutputIssue } from "@/features/freezone/workflowQualityGate";
import {
  WORKFLOW_EXECUTION_ACTIVITY_EVENT,
  WORKFLOW_RUN_UPDATED_EVENT,
  type WorkflowExecutionActivityDetail,
  type WorkflowRunActionUpdate,
} from "@/features/canvas/application/workflowExecutionActivity";
import {
  captureVideoFrameToNode,
  resolveCaptureSeekSec,
} from "@/features/canvas/application/videoCaptureFrame";
import { dedupeGenerationErrors } from "@/features/canvas/application/generationErrorReport";

export const CANVAS_CHAT_COMMANDS_SCHEMA_VERSION = "canvas_chat_commands.v1";
export const FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT = "freezone/canvas-command-approval";
export const FREEZONE_CANVAS_COMMAND_RESULT_EVENT = "freezone/canvas-command-result";
export const FREEZONE_WORKFLOW_RUN_UPDATED_EVENT = WORKFLOW_RUN_UPDATED_EVENT;

type JsonRecord = Record<string, unknown>;
type MainlineProjectionScope = "episode" | "beat" | "asset";
type MainlineProjectionRequest = Omit<
  FreezonePresetCanvasRequest,
  "canvas_id" | "overwrite_existing" | "base_revision" | "scope"
> & {
  scope: MainlineProjectionScope;
};

const VIDEO_COMPOSE_MIN_UPSTREAM_VIDEOS = 1;
const VIDEO_COMPOSE_MIN_UPSTREAM_MEDIA = 2;

export type CanvasChatCommand =
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

export type CanvasCommandApprovalEventDetail = {
  canvasId?: string | null;
  agentId?: string | null;
  turnId?: string | null;
  anchorMessageId?: string | null;
  anchorTextPrefix?: string | null;
  bridgeKey?: string | null;
  envelopes: CanvasChatCommandEnvelope[];
  receivedAt?: number;
  autoExpires?: boolean;
  externalMcpCommand?: boolean;
  /** 必须由用户在聊天卡片中明确选择，自动执行模式也不能跳过。 */
  requiresUserChoice?: boolean;
};

export type CanvasCommandResultEventDetail = {
  canvasId?: string | null;
  agentId?: string | null;
  turnId?: string | null;
  anchorMessageId?: string | null;
  anchorTextPrefix?: string | null;
  bridgeKey?: string | null;
  envelopes?: CanvasChatCommandEnvelope[];
  result: CanvasChatCommandApplyResult;
  receivedAt?: number;
};

export type CanvasChatCommandApplyResult = {
  applied: number;
  openedUiActions: number;
  createdNodeIds: string[];
  errors: string[];
  commandResults: CanvasChatCommandApplyStep[];
};

export type CanvasChatCommandApplyStep = {
  commandIndex: number;
  type: CanvasChatCommand["type"] | "validate";
  status: "success" | "error";
  label: string;
  nodeId?: string;
  action?: string;
  createdNodeId?: string;
  output?: Record<string, unknown>;
  error?: string;
};

type PendingNodeAction = {
  commandIndex: number;
  nodeId: string;
  action: string;
  executionMode?: "single" | "workflow";
  parameters?: JsonRecord;
  label: string;
  invalidationReason?: "explicit_regeneration" | "upstream_regeneration";
};

type PendingMainlineProjection = {
  commandIndex: number;
  projectId: string;
  request: MainlineProjectionRequest;
  label: string;
};

type NodeActionResult = {
  requestId: string;
  nodeId: string;
  action: string;
  status: "success" | "error";
  output?: Record<string, unknown>;
  error?: string;
};

type ApplyCanvasChatCommandsOptions = {
  projectId?: string | null;
  canvasId?: string | null;
  actionTimeoutMs?: number;
  actionAcceptTimeoutMs?: number;
  actionResultFieldTimeoutMs?: number;
  actionRetryDelayMs?: number;
};

export type CanvasChatCommandPartition = {
  immediate: CanvasChatCommandEnvelope[];
  requiresApproval: CanvasChatCommandEnvelope[];
};

type CanvasCommandApprovalSubscriber = (detail: CanvasCommandApprovalEventDetail) => boolean | void;

const queuedCanvasCommandApprovals: CanvasCommandApprovalEventDetail[] = [];
const canvasCommandApprovalSubscribers = new Set<CanvasCommandApprovalSubscriber>();

function dispatchCanvasCommandApprovalEvent(detail: CanvasCommandApprovalEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT, { detail }));
}

export function emitCanvasCommandApproval(detail: CanvasCommandApprovalEventDetail): void {
  let handled = false;
  for (const subscriber of canvasCommandApprovalSubscribers) {
    handled = subscriber(detail) === true || handled;
  }
  dispatchCanvasCommandApprovalEvent(detail);
  if (!handled) {
    queuedCanvasCommandApprovals.push(detail);
  }
}

export function subscribeCanvasCommandApprovals(
  subscriber: CanvasCommandApprovalSubscriber,
): () => void {
  canvasCommandApprovalSubscribers.add(subscriber);
  for (let index = queuedCanvasCommandApprovals.length - 1; index >= 0; index -= 1) {
    const detail = queuedCanvasCommandApprovals[index];
    if (subscriber(detail) === true) queuedCanvasCommandApprovals.splice(index, 1);
  }
  return () => {
    canvasCommandApprovalSubscribers.delete(subscriber);
  };
}

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
  "commit_node",
  "sync_beat_context_to_mainline",
]);

const GENERATION_NODE_ACTIONS = new Set([
  "generate_text",
  "generate_text_video",
  "generate_story_script",
  "generate_image",
  "generate_audio",
  "generate_video",
  "auto_compose_video",
  "generate_3gs_world",
  "run_skill",
]);

export function canvasCommandEnvelopesRunInBackground(
  envelopes: CanvasChatCommandEnvelope[],
): boolean {
  return envelopes.some((envelope) => envelope.commands.some((command) =>
    command.type === "run_workflow" ||
    (command.type === "run_node_action" && GENERATION_NODE_ACTIONS.has(command.action))
  ));
}

export async function waitForImmediateCanvasCommandResult(
  execution: Promise<CanvasChatCommandApplyResult>,
): Promise<CanvasChatCommandApplyResult | null> {
  return Promise.race([
    execution,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 0)),
  ]);
}

const UI_OPEN_NODE_ACTIONS = new Set([
  "open_video_compose_modal",
]);

const CURRENT_MEDIA_NODE_ACTIONS = new Set([
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
]);

const RESULT_SPAWNING_NODE_ACTIONS = new Set([
  "run_outpaint_tool",
  "run_scene360_tool",
  "run_grid_multi_camera",
  "run_grid_plot_four",
  "run_grid_face_three_view",
  "run_grid_product_three_view",
  "run_grid_serial_storyboard_25",
  "run_grid_cinematic_light_correction",
  "run_grid_character_three_view",
  "run_grid_scene_setting_sheet",
  "run_grid_frame_projection_3s_later",
  "run_grid_frame_projection_5s_earlier",
]);

const DEFAULT_NODE_ACTION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_NODE_ACTION_ACCEPT_TIMEOUT_MS = 3 * 1000;
const DEFAULT_NODE_ACTION_RESULT_FIELD_TIMEOUT_MS = 3 * 1000;
const NODE_ACTION_ACCEPTANCE_GRACE_MS = 25;
const canvasNodeActionQueues = new Map<string, Promise<void>>();
const activeOrQueuedWorkflowRunKeys = new Set<string>();
let nodeActionMountQueue: Promise<void> = Promise.resolve();
const WORKFLOW_ACTION_CONCURRENCY = 3;
const WORKFLOW_ACTION_MAX_RETRIES = 2;
const WORKFLOW_STOPPED_MESSAGE = "工作流已停止，未启动后续节点。";
const TERMINAL_WORKFLOW_ACTION_STATUSES = new Set<WorkflowRunActionStatus>([
  "completed",
  "failed",
  "blocked",
  "skipped",
]);
const WORKFLOW_CAPACITY_POLL_INTERVAL_MS = 2_000;
const WORKFLOW_ACTION_LANE_LIMITS = {
  default: 3,
  video: 3,
  world: 1,
  ffmpeg: 1,
} as const;
type WorkflowActionLane = keyof typeof WORKFLOW_ACTION_LANE_LIMITS;
type WorkflowActionSlotWaiter = {
  lane: WorkflowActionLane;
  laneLimit: number;
  resolve: (release: () => void) => void;
};
const workflowActionSlotWaiters: WorkflowActionSlotWaiter[] = [];
const activeWorkflowActionsByLane: Record<WorkflowActionLane, number> = {
  default: 0,
  video: 0,
  world: 0,
  ffmpeg: 0,
};
let activeWorkflowActions = 0;
const workflowCancelTokensByCanvas = new Map<string, number>();

function workflowCancelKey(canvasId: string | null | undefined): string {
  return canvasId?.trim() || "default";
}

export function cancelCanvasWorkflowExecution(canvasId?: string | null): void {
  const key = workflowCancelKey(canvasId);
  workflowCancelTokensByCanvas.set(key, (workflowCancelTokensByCanvas.get(key) ?? 0) + 1);
}

function workflowActionLane(action: string): WorkflowActionLane {
  // Stable workers consume image generation from the default lane. Keeping
  // workflow capacity checks on the same lane prevents admission against an
  // image queue that deployed workers do not consume.
  if (action === "generate_image") return "default";
  if (action === "generate_video" || action === "generate_text_video") return "video";
  if (action === "generate_3gs_world") return "world";
  if (action === "auto_compose_video") return "ffmpeg";
  return "default";
}

function drainWorkflowActionSlots(): void {
  while (activeWorkflowActions < WORKFLOW_ACTION_CONCURRENCY) {
    const waiterIndex = workflowActionSlotWaiters.findIndex(
      ({ lane, laneLimit }) =>
        activeWorkflowActionsByLane[lane] <
        Math.min(WORKFLOW_ACTION_LANE_LIMITS[lane], laneLimit),
    );
    if (waiterIndex < 0) return;
    const [waiter] = workflowActionSlotWaiters.splice(waiterIndex, 1);
    activeWorkflowActions += 1;
    activeWorkflowActionsByLane[waiter.lane] += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      activeWorkflowActions = Math.max(activeWorkflowActions - 1, 0);
      activeWorkflowActionsByLane[waiter.lane] = Math.max(
        activeWorkflowActionsByLane[waiter.lane] - 1,
        0,
      );
      drainWorkflowActionSlots();
    });
  }
}

function acquireWorkflowActionSlot(
  action: string,
  laneLimit: number = WORKFLOW_ACTION_LANE_LIMITS[workflowActionLane(action)],
): Promise<() => void> {
  return new Promise((resolve) => {
    workflowActionSlotWaiters.push({
      lane: workflowActionLane(action),
      laneLimit: Math.max(1, laneLimit),
      resolve,
    });
    drainWorkflowActionSlots();
  });
}

function availableWorkflowLaneCapacity(
  limits: ProjectTaskLimits,
  lane: WorkflowActionLane,
): number | null {
  const laneLimits = limits[lane];
  if (!laneLimits) return null;
  const finiteRemaining = [laneLimits.remaining, laneLimits.user_remaining]
    .filter((value): value is number => typeof value === "number");
  if (finiteRemaining.length === 0) return null;
  return Math.max(Math.min(...finiteRemaining), 0);
}

async function fetchWorkflowLaneCapacity(
  projectId: string,
  lane: WorkflowActionLane,
): Promise<number | null> {
  try {
    return availableWorkflowLaneCapacity(await getProjectTaskLimits(projectId), lane);
  } catch {
    // Older CE backends may not expose task limits. Preserve the existing scheduler.
    return null;
  }
}

async function waitForWorkflowLaneCapacity(
  projectId: string,
  lane: WorkflowActionLane,
  timeoutMs: number,
  shouldStop: () => boolean,
  onWaiting?: () => void,
): Promise<boolean> {
  const startedAt = Date.now();
  let waitingReported = false;
  while (!shouldStop()) {
    const capacity = await fetchWorkflowLaneCapacity(projectId, lane);
    if (capacity === null || capacity > 0) return true;
    if (!waitingReported) {
      waitingReported = true;
      onWaiting?.();
    }
    if (Date.now() - startedAt >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, WORKFLOW_CAPACITY_POLL_INTERVAL_MS));
  }
  return false;
}

function workflowGraphSignature(actions: PendingNodeAction[]): string {
  const actionNodeIds = new Set(actions.map((action) => action.nodeId));
  const state = useCanvasStore.getState();
  const nodes = state.nodes
    .filter((node) => actionNodeIds.has(node.id))
    .map((node) => ({ id: node.id, type: node.type ?? "" }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const edges = state.edges
    .filter((edge) => actionNodeIds.has(edge.source) && actionNodeIds.has(edge.target))
    .map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? "",
      targetHandle: edge.targetHandle ?? "",
    }))
    .sort((left, right) =>
      `${left.source}:${left.target}:${left.sourceHandle}:${left.targetHandle}`.localeCompare(
        `${right.source}:${right.target}:${right.sourceHandle}:${right.targetHandle}`,
      ));
  return JSON.stringify({ nodes, edges });
}

function isRetryableWorkflowActionError(error: string | null | undefined): boolean {
  const normalized = String(error ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes("invalid token") ||
    normalized.includes("model_not_found") ||
    normalized.includes("sensitivecontent") ||
    normalized.includes("privacyinformation") ||
    normalized.includes("quota has been exhausted") ||
    normalized.includes("audio_url is required") ||
    normalized.includes("401") ||
    normalized.includes("403")
  ) {
    return false;
  }
  return [
    "429",
    "502",
    "503",
    "504",
    "econnreset",
    "connection reset",
    "bad_response_body",
    "队列已满",
    "队列的任务已达",
    "queue is full",
    "lane is full",
  ]
    .some((marker) => normalized.includes(marker));
}

function workflowRetryDelayMs(retryCount: number): number {
  return Math.min(1_000 * (2 ** Math.max(retryCount - 1, 0)), 4_000);
}
const WORKFLOW_GENERATE_ACTION_BY_NODE_TYPE: Partial<Record<CanvasNodeType, string[]>> = {
  [CANVAS_NODE_TYPES.script]: ["generate_story_script"],
  [CANVAS_NODE_TYPES.imageGen]: ["generate_image"],
  [CANVAS_NODE_TYPES.audio]: ["generate_audio"],
  [CANVAS_NODE_TYPES.video]: ["generate_video"],
  [CANVAS_NODE_TYPES.threeDWorld]: ["generate_3gs_world"],
  [CANVAS_NODE_TYPES.textAnnotation]: ["generate_text", "generate_text_video"],
};
const WORKFLOW_LIKE_CREATE_NODE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.videoCompose,
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isFiniteNumber(value: unknown): value is number {
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

function commandRequiresApproval(command: CanvasChatCommand): boolean {
  // Creating a node changes the user's canvas and can trigger generation or
  // billing once the node is run. Keep it behind the same confirmation card
  // as other mutating workflow operations. Legacy envelopes may still contain
  // an auto-apply field, but interactive Freezone never bypasses confirmation.
  if (command.type === "create_node" || command.type === "add_next_node") return true;
  if (command.type === "clear_canvas") return true;
  if (command.type === "delete_nodes") return command.node_ids.length > 0;
  if (command.type === "delete_edges") return (command.edge_ids?.length ?? 0) > 0 || (command.pairs?.length ?? 0) > 0;
  if (command.type === "layout_nodes") return !command.node_ids || command.node_ids.length === 0 || command.node_ids.length >= 4;
  if (command.type === "open_mainline_projection") return true;
  if (command.type === "run_workflow") return true;
  return false;
}

function envelopeWithCommands(
  commands: CanvasChatCommand[],
  source?: CanvasChatCommandEnvelope,
): CanvasChatCommandEnvelope | null {
  if (commands.length === 0) return null;
  return {
    ...source,
    schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
    commands,
  };
}

export function canvasCommandEnvelopeMatchesCanvas(
  envelope: CanvasChatCommandEnvelope,
  canvasId: string | null | undefined,
): boolean {
  return !envelope.canvas_id || !canvasId || envelope.canvas_id === canvasId;
}

export function partitionCanvasChatCommandEnvelopes(
  envelopes: CanvasChatCommandEnvelope[],
): CanvasChatCommandPartition {
  const immediate: CanvasChatCommandEnvelope[] = [];
  const requiresApproval: CanvasChatCommandEnvelope[] = [];

  for (const envelope of envelopes) {
    const safeCommands: CanvasChatCommand[] = [];
    const approvalCommands: CanvasChatCommand[] = [];
    for (const command of envelope.commands) {
      if (commandRequiresApproval(command)) {
        approvalCommands.push(command);
      } else {
        safeCommands.push(command);
      }
    }
    const safeEnvelope = envelopeWithCommands(safeCommands, envelope);
    const approvalEnvelope = envelopeWithCommands(approvalCommands, envelope);
    if (safeEnvelope) immediate.push(safeEnvelope);
    if (approvalEnvelope) requiresApproval.push(approvalEnvelope);
  }

  return { immediate, requiresApproval };
}

function nodeById(id: string): CanvasNode | null {
  return useCanvasStore.getState().nodes.find((node) => node.id === id) ?? null;
}

/**
 * Resolve narration text only after an upstream text/script node has produced it.
 * Workflow plans may create the audio node before the script is materialized;
 * dispatching TTS with an empty `text` causes the backend to stop before NewAPI.
 */
function workflowNarrationTextFromNode(node: CanvasNode): string {
  const data = node.data as JsonRecord;
  const direct = nonEmptyString(data.content) ?? nonEmptyString(data.text);
  if (direct) return direct;
  const scriptResult = data.scriptResult;
  if (!isRecord(scriptResult) || !Array.isArray(scriptResult.rows)) return "";
  return scriptResult.rows
    .map((row) => {
      if (!isRecord(row)) return "";
      return (
        nonEmptyString(row.narration) ??
        nonEmptyString(row.voiceover) ??
        nonEmptyString(row.dialogue) ??
        ""
      );
    })
    .filter(Boolean)
    .join("\n");
}

function hydrateWorkflowAudioInput(nodeId: string): boolean {
  const target = nodeById(nodeId);
  if (!target) return false;
  const targetData = target.data as JsonRecord;
  if (nonEmptyString(targetData.text)) return true;
  const state = useCanvasStore.getState();
  const incoming = state.edges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => nodeById(edge.source))
    .filter((node): node is CanvasNode => node !== null);
  for (const source of incoming) {
    const text = workflowNarrationTextFromNode(source);
    if (!text) continue;
    state.updateNodeData(nodeId, { text });
    return true;
  }
  return false;
}

const VIDEO_CONTINUITY_PROMPT_NOTE =
  "上一镜尾帧已作为图片参考接入，请以它作为本镜头开场的动作、构图和角色状态连续依据。";

function continuityFrameData(sourceVideoNodeId: string, targetVideoNodeId: string): JsonRecord {
  return {
    sourceVideoNodeId,
    targetVideoNodeId,
    kind: "video_tail_frame",
  };
}

function matchesContinuityFrame(
  node: CanvasNode,
  sourceVideoNodeId: string,
  targetVideoNodeId: string,
): boolean {
  const data = node.data as JsonRecord;
  const continuity = data.workflowContinuityFrame;
  return (
    node.type === CANVAS_NODE_TYPES.exportImage &&
    isRecord(continuity) &&
    continuity.sourceVideoNodeId === sourceVideoNodeId &&
    continuity.targetVideoNodeId === targetVideoNodeId &&
    nonEmptyString(data.imageUrl) !== null
  );
}

function linkedContinuityFrameNodeId(
  sourceVideoNodeId: string,
  targetVideoNodeId: string,
): string | null {
  const state = useCanvasStore.getState();
  const candidate = state.nodes.find((node) =>
    matchesContinuityFrame(node, sourceVideoNodeId, targetVideoNodeId)
  );
  if (!candidate) return null;
  const hasMediaInput = state.edges.some((edge) =>
    edge.source === candidate.id &&
    edge.target === targetVideoNodeId &&
    normalizeCanvasEdgeSemanticKind(isRecord(edge.data) ? edge.data.link_type : undefined) ===
      "media_input_for"
  );
  return hasMediaInput ? candidate.id : null;
}

function appendVideoContinuityPromptNote(targetNodeId: string): void {
  const target = nodeById(targetNodeId);
  if (!target) return;
  const prompt = typeof target.data.prompt === "string" ? target.data.prompt.trim() : "";
  if (prompt.includes(VIDEO_CONTINUITY_PROMPT_NOTE)) return;
  const nextPrompt = prompt
    ? `${prompt}\n\n${VIDEO_CONTINUITY_PROMPT_NOTE}`
    : VIDEO_CONTINUITY_PROMPT_NOTE;
  useCanvasStore.getState().updateNodeData(targetNodeId, { prompt: nextPrompt });
}

async function ensureVideoContinuityTailFrames(
  action: PendingNodeAction,
  projectId: string | undefined,
): Promise<void> {
  if (action.action !== "generate_video") return;
  if (!projectId) return;
  const target = nodeById(action.nodeId);
  if (!target || target.type !== CANVAS_NODE_TYPES.video) return;
  const state = useCanvasStore.getState();
  const sourceVideos = state.edges
    .filter((edge) =>
      edge.target === action.nodeId &&
      normalizeCanvasEdgeSemanticKind(isRecord(edge.data) ? edge.data.link_type : undefined) ===
        "dependency_for"
    )
    .map((edge) => state.nodes.find((node) => node.id === edge.source) ?? null)
    .filter((node): node is CanvasNode =>
      Boolean(node && node.type === CANVAS_NODE_TYPES.video && nonEmptyString(node.data.videoUrl))
    );
  if (sourceVideos.length === 0) return;

  for (const source of sourceVideos) {
    if (linkedContinuityFrameNodeId(source.id, action.nodeId)) continue;
    const sourceData = source.data as JsonRecord;
    const videoUrl = nonEmptyString(sourceData.videoUrl);
    if (!videoUrl) continue;
    const durationMs = isFiniteNumber(sourceData.durationMs) ? sourceData.durationMs : null;
    const result = await captureVideoFrameToNode(source.id, {
      videoUrl,
      seekSec: resolveCaptureSeekSec("last", {
        fallbackDurationSec: durationMs !== null ? durationMs / 1000 : null,
      }),
      projectId,
      displayName: "上一镜尾帧",
    });
    if (!result.nodeId) {
      throw new Error(result.error ?? "上一镜尾帧抽取失败，已停止启动下一镜视频。");
    }
    useCanvasStore.getState().updateNodeData(result.nodeId, {
      workflowContinuityFrame: continuityFrameData(source.id, action.nodeId),
    });
    useCanvasStore.getState().addEdgeWithData(result.nodeId, action.nodeId, {
      link_type: "media_input_for",
      edgeKind: "workflow_continuity_tail_frame",
    });
    appendVideoContinuityPromptNote(action.nodeId);
  }
}

function resolveNodeId(rawId: string, clientIdMap: Map<string, string>): string {
  return clientIdMap.get(rawId) ?? rawId;
}

function fallbackCreatePosition(): { x: number; y: number } {
  const nodes = useCanvasStore.getState().nodes;
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
  source: string,
  target: string,
  options: { link_type?: CanvasEdgeSemanticKind } = {},
): string | null {
  if (source === target) throw new Error("connection requires two different nodes");
  const store = useCanvasStore.getState();
  const data: Record<string, unknown> = {};
  if (options.link_type) {
    data.link_type = options.link_type;
  }
  if (Object.keys(data).length > 0) {
    return store.addEdgeWithData(source, target, {
      ...data,
    });
  }
  return store.addEdge(source, target);
}

function invalidConnectionReason(source: string, target: string): string | null {
  if (source === target) return "connection requires two different nodes";
  const sourceNode = nodeById(source);
  if (!sourceNode) return `source node not found: ${source}`;
  const targetNode = nodeById(target);
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
  return null;
}

function isMissingOrFatalConnectionReason(reason: string | null): boolean {
  return Boolean(
    reason?.startsWith("source node not found:") ||
    reason?.startsWith("target node not found:") ||
    reason === "connection requires two different nodes",
  );
}
function deleteEdges(
  command: Extract<CanvasChatCommand, { type: "delete_edges" }>,
  clientIdMap: Map<string, string>,
): void {
  const store = useCanvasStore.getState();
  const edgeIds = new Set(command.edge_ids ?? []);
  for (const pair of command.pairs ?? []) {
    const source = resolveNodeId(pair.source, clientIdMap);
    const target = resolveNodeId(pair.target, clientIdMap);
    if (source === target) throw new Error("disconnect requires two different nodes");
    for (const edge of store.edges) {
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
    useCanvasStore.getState().deleteEdge(edgeId);
  }
}

function deleteNodesOrEdges(
  rawIds: string[],
  clientIdMap: Map<string, string>,
): { removedNodeCount: number; removedEdgeCount: number; projectionRemovalCount: number } {
  const store = useCanvasStore.getState();
  if (rawIds.length === 0) throw new Error("delete_nodes requires at least one node or edge id");
  const beforeNodeIds = new Set(store.nodes.map((node) => node.id));
  const beforeEdgeIds = new Set(store.edges.map((edge) => edge.id));
  const edgeIds = new Set(store.edges.map((edge) => edge.id));
  const nodesById = new Map(store.nodes.map((node) => [node.id, node] as const));
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
    const allProjectionNodeIds = store.nodes
      .filter((node) => projectionKeyFromNode(node) === projectionKey)
      .map((node) => node.id);
    const hasWholeProjection = allProjectionNodeIds.every((id) => requestedIds.has(id));
    if (!hasWholeProjection) {
      const firstRequestedId = requestedIds.values().next().value ?? projectionKey;
      throw new Error(`node is mainline projection managed and cannot be deleted directly: ${firstRequestedId}`);
    }
  }
  if (nodeIds.length > 0) {
    useCanvasStore.getState().deleteNodes(nodeIds);
  }
  for (const edgeId of edgeIdsToDelete) {
    useCanvasStore.getState().deleteEdge(edgeId);
  }
  for (const projectionKey of projectionNodeIdsByKey.keys()) {
    canvasEventBus.publish("freezone/projection-remove", { projectionKey });
  }

  const after = useCanvasStore.getState();
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

function isMainlineProjectionManagedNode(node: CanvasNode): boolean {
  return isPresetManagedNode(node) || isSystemManagedNodeData(node.data);
}

function projectionKeyFromNode(node: CanvasNode): string | null {
  const data = node.data as { projection_key?: unknown } | undefined;
  return typeof data?.projection_key === "string" && data.projection_key.trim()
    ? data.projection_key.trim()
    : null;
}

function scheduleMeasuredLayout(
  nodeIds: string[],
  mode: "horizontal" | "vertical" | "grid",
  hermesLegacy = false,
): void {
  if (typeof window === "undefined") return;
  const schedule = typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(callback, 16);
  schedule(() => {
    schedule(() => {
      layoutNodes(nodeIds, mode, false, hermesLegacy);
    });
  });
}

function layoutNodes(
  nodeIds: string[],
  mode: "horizontal" | "vertical" | "grid",
  refineAfterMeasurement = true,
  hermesLegacy = false,
): void {
  const store = useCanvasStore.getState();
  const nodesById = new Map(store.nodes.map((node) => [node.id, node] as const));
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

  // External MCP workflows use the exact legacy Hermes geometry and preserve
  // the node_ids command order. Hermes websocket commands keep the existing
  // adaptive frontend layout path below.
  if (hermesLegacy) {
    const minX = Math.min(...nodes.map((node) => node.position.x));
    const minY = Math.min(...nodes.map((node) => node.position.y));
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    store.setNodePositions(Object.fromEntries(nodes.map((node, index) => {
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
    const groupChildren = store.nodes.filter((node) => node.parentId === groupId);
    const targetsWholePlainGroup =
      isGroupNode(group) &&
      !isProtectedProjectionGroupNode(group) &&
      !isStoryboardGroupNode(group) &&
      groupChildren.length === targetIds.size &&
      groupChildren.every((node) => targetIds.has(node.id));
    if (targetsWholePlainGroup) {
      store.arrangeGroupChildren(groupId, mode);
      if (needsMeasuredRefinement) {
        scheduleMeasuredLayout(nodeIds, mode, hermesLegacy);
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
  store.setNodePositions(positions);
  if (needsMeasuredRefinement) {
    scheduleMeasuredLayout(nodeIds, mode, hermesLegacy);
  }
}

function moveNodes(
  command: Extract<CanvasChatCommand, { type: "move_nodes" }>,
  clientIdMap: Map<string, string>,
): void {
  const nodes = useCanvasStore.getState().nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const existingNodeIds = new Set(nodeById.keys());
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
    const node = nodeById.get(nodeId);
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
  useCanvasStore.getState().setNodePositions(positions);
}

function selectNodes(rawNodeIds: string[], clientIdMap: Map<string, string>, focus = true): void {
  const store = useCanvasStore.getState();
  const existingNodeIds = new Set(store.nodes.map((node) => node.id));
  const nodeIds = rawNodeIds.map((nodeId) => resolveNodeId(nodeId, clientIdMap));
  for (const nodeId of nodeIds) {
    if (!existingNodeIds.has(nodeId)) throw new Error(`node not found: ${nodeId}`);
  }

  const selectedSet = new Set(nodeIds);
  store.onNodesChange(
    store.nodes.map((node) => ({
      id: node.id,
      type: "select" as const,
      selected: selectedSet.has(node.id),
    })),
  );
  store.setSelectedNode(nodeIds.length === 1 ? nodeIds[0] ?? null : null);
  if (focus && nodeIds[0]) {
    store.requestFocusNode(nodeIds[0]);
  }
}

function assertNodeActionAvailable(nodeId: string, action: string): void {
  const targetNode = nodeById(nodeId);
  if (!targetNode) throw new Error(`node not found: ${nodeId}`);
  const state = useCanvasStore.getState();
  const catalog = buildCanvasNodeActionCatalog(targetNode, {
    nodes: state.nodes,
    edges: state.edges,
  });
  const catalogAction = catalog.actions.find((item) => item.action === action);
  if (!catalogAction) throw new Error(`action not available on node: ${action}`);
  if (!RUN_NODE_ACTIONS.has(action)) throw new Error(`action is not executable from chat: ${action}`);
  if (catalogAction.execution === "chat_command") {
    throw new Error(`action must be expressed as a canvas chat command: ${action}`);
  }
}

function runNodeAction(nodeId: string, action: string, parameters?: JsonRecord): void {
  assertNodeActionAvailable(nodeId, action);
  canvasEventBus.publish("freezone/run-node-action", {
    nodeId,
    action,
    executionMode: "single",
    ...(parameters ? { parameters } : {}),
  });
}

function selectedWorkflowNodeIds(): string[] {
  const state = useCanvasStore.getState();
  const selected = state.nodes
    .filter((node) => node.selected)
    .map((node) => node.id);
  if (selected.length > 0) return selected;
  return state.selectedNodeId ? [state.selectedNodeId] : [];
}

function expandWorkflowNodeIds(
  seedNodeIds: string[],
  directions: Array<"upstream" | "downstream"> = ["upstream", "downstream"],
): string[] {
  const state = useCanvasStore.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const upstreamByNodeId = new Map<string, string[]>();
  const downstreamByNodeId = new Map<string, string[]>();
  for (const edge of state.edges) {
    const upstream = upstreamByNodeId.get(edge.target) ?? [];
    upstream.push(edge.source);
    upstreamByNodeId.set(edge.target, upstream);
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

function defaultWorkflowActionForNode(node: CanvasNode): string | null {
  if (isWorkflowUserInputNode(node)) return null;
  const preferredActions = WORKFLOW_GENERATE_ACTION_BY_NODE_TYPE[node.type] ?? [];
  if (preferredActions.length === 0) return null;
  const state = useCanvasStore.getState();
  const catalog = buildCanvasNodeActionCatalog(node, {
    nodes: state.nodes,
    edges: state.edges,
  });
  for (const action of preferredActions) {
    const entry = catalog.actions.find((item) => item.action === action);
    if (!entry || entry.execution !== "frontend_node") continue;
    if (!RUN_NODE_ACTIONS.has(action)) continue;
    return action;
  }
  return null;
}

function isWorkflowUserInputNode(node: CanvasNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as Record<string, unknown>;
  if (data.workflowCatalogRole === "user_input") return true;
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
    || ["最终合成", "成片合成", "最终成片合成", "final compose", "final composition"].includes(label);
  if (!hasComposeIdentity) return false;
  const nodeByIdMap = new Map(nodes.map((candidate) => [candidate.id, candidate] as const));
  return edges.some(
    (edge) =>
      edge.source === node.id
      && nodeByIdMap.get(edge.target)?.type === CANVAS_NODE_TYPES.videoCompose,
  );
}

function hasVideoComposeMinimumInputs(nodeId: string, allowedSourceNodeIds?: Set<string>): boolean {
  const state = useCanvasStore.getState();
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

function satisfiedVideoComposeUpstreamNodeIds(
  nodeIds: string[],
  explicitlyRequestedNodeIds: Iterable<string>,
): Set<string> {
  const state = useCanvasStore.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const scopedNodeIds = new Set(nodeIds);
  const explicitlyRequested = new Set(explicitlyRequestedNodeIds);
  const protectedNodeIds = new Set<string>();
  for (const nodeId of relatedSatisfiedVideoComposeNodeIds(nodeIds, scopedNodeIds)) {
    const node = nodeByIdMap.get(nodeId);
    if (node?.type !== CANVAS_NODE_TYPES.videoCompose) continue;
    for (const upstreamId of expandWorkflowNodeIds([nodeId], ["upstream"])) {
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

function relatedSatisfiedVideoComposeNodeIds(
  nodeIds: string[],
  allowedSourceNodeIds?: Set<string>,
): string[] {
  const state = useCanvasStore.getState();
  const expandedSet = new Set(nodeIds);
  const composeIds: string[] = [];
  for (const node of state.nodes) {
    if (node.type !== CANVAS_NODE_TYPES.videoCompose) continue;
    if (!hasVideoComposeMinimumInputs(node.id, allowedSourceNodeIds)) continue;
    if (expandedSet.has(node.id) || state.edges.some((edge) => edge.target === node.id && expandedSet.has(edge.source))) {
      composeIds.push(node.id);
    }
  }
  return composeIds;
}

function normalizeWorkflowStartNodeIds(nodeIds: string[]): string[] {
  const state = useCanvasStore.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  return [...new Set(nodeIds.map((nodeId) => {
    const node = nodeByIdMap.get(nodeId);
    if (!isWorkflowUserInputNode(node) || !node?.parentId) return nodeId;
    return nodeByIdMap.get(node.parentId)?.type === CANVAS_NODE_TYPES.group
      ? node.parentId
      : nodeId;
  }))];
}

function workflowNodeActions(
  command: Extract<CanvasChatCommand, { type: "run_workflow" }>,
  commandIndex: number,
  options: { skipCompleted?: boolean } = {},
): PendingNodeAction[] {
  const state = useCanvasStore.getState();
  const initialNodeIds = command.node_ids && command.node_ids.length > 0
    ? normalizeWorkflowStartNodeIds(command.node_ids)
    : command.scope === "canvas"
      ? state.nodes.map((node) => node.id)
      : selectedWorkflowNodeIds();
  const directions: Array<"upstream" | "downstream"> = command.direction === "node"
    ? []
    : command.direction === "downstream"
      ? ["downstream"]
      : ["upstream", "downstream"];
  const expandedNodeIds = expandWorkflowNodeIds(initialNodeIds, directions);
  const nodeByIdMap = new Map(useCanvasStore.getState().nodes.map((node) => [node.id, node] as const));
  const scopedNodeIds = new Set(expandedNodeIds);
  const protectedUpstreamNodeIds = satisfiedVideoComposeUpstreamNodeIds(
    expandedNodeIds,
    initialNodeIds,
  );
  const composeNodeIdsToOpen = relatedSatisfiedVideoComposeNodeIds(expandedNodeIds, scopedNodeIds)
    .filter((nodeId) => !expandedNodeIds.includes(nodeId));

  return [
    ...expandedNodeIds,
    ...composeNodeIdsToOpen,
  ].flatMap((nodeId) => {
    const node = nodeByIdMap.get(nodeId);
    if (!node || node.type === CANVAS_NODE_TYPES.group) return [];
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
    const action = defaultWorkflowActionForNode(node);
    if (!action) return [];
    if (options.skipCompleted !== false && hasGeneratedResult(nodeId, action)) return [];
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

function directNodeActionQueue(
  nodeId: string,
  action: string,
  commandIndex: number,
  parameters?: JsonRecord,
): PendingNodeAction[] {
  const state = useCanvasStore.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const includeUpstream = (
    GENERATION_NODE_ACTIONS.has(action)
    || (
      action === "open_video_compose_modal"
      && !hasVideoComposeMinimumInputs(nodeId)
    )
  );
  const upstreamActions = (includeUpstream
    ? expandWorkflowNodeIds([nodeId], ["upstream"])
    : [nodeId])
    .filter((upstreamId) => upstreamId !== nodeId)
    .flatMap((upstreamId): PendingNodeAction[] => {
      const node = nodeByIdMap.get(upstreamId);
      if (!node || node.type === CANVAS_NODE_TYPES.group) return [];
      if (isRedundantLegacyComposeGenerator(node, state.nodes, state.edges)) return [];
      const upstreamAction = defaultWorkflowActionForNode(node);
      if (!upstreamAction || hasGeneratedResult(upstreamId, upstreamAction)) return [];
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

export function workflowVideoNodeIdsForPreflight(
  command: Extract<CanvasChatCommand, { type: "run_workflow" }>,
): string[] {
  return workflowGenerationTargetsForPreflight(command)
    .filter((action) => action.action === "generate_video")
    .map((action) => action.nodeId);
}

export type WorkflowGenerationTargetPreflight = {
  nodeId: string;
  action: string;
};

/**
 * Resolve the still-pending generation actions of an existing workflow before
 * the user approves it. The approval UI uses this read-only view to expose the
 * same parameters that the node panels will consume after confirmation.
 */
export function workflowGenerationTargetsForPreflight(
  command: Extract<CanvasChatCommand, { type: "run_workflow" }>,
): WorkflowGenerationTargetPreflight[] {
  return workflowNodeActions(command, -1, { skipCompleted: true })
    .map(({ nodeId, action }) => ({ nodeId, action }));
}

export function directGenerationTargetsForPreflight(
  nodeId: string,
  action: string,
): WorkflowGenerationTargetPreflight[] {
  return directNodeActionQueue(nodeId, action, -1)
    .filter((target) => GENERATION_NODE_ACTIONS.has(target.action))
    .map(({ nodeId: targetNodeId, action: targetAction }) => ({
      nodeId: targetNodeId,
      action: targetAction,
    }));
}

function requestAnimationFrameOrTimeout(): Promise<void> {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const NODE_FOCUS_ANIMATION_SETTLE_MS = 360;

function mountNodeForPendingAction(nodeId: string): Promise<void> {
  const next = nodeActionMountQueue.catch(() => undefined).then(async () => {
    selectAndFocusNode(nodeId);
    // Canvas focus animates for 320 ms. Advancing the mount queue after only
    // two frames lets the next off-screen action interrupt that animation, so
    // the previous node never mounts and cannot accept its pending action.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, NODE_FOCUS_ANIMATION_SETTLE_MS);
    });
    await requestAnimationFrameOrTimeout();
    await requestAnimationFrameOrTimeout();
  });
  nodeActionMountQueue = next.catch(() => undefined);
  return next;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForNodeActionResult(
  requestId: string,
  timeoutMs: number,
  timeoutFallback?: NodeActionResult,
): Promise<NodeActionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(timeoutFallback ?? {
        requestId,
        nodeId: "",
        action: "",
        status: "error",
        error: "节点动作执行超时",
      });
    }, timeoutMs);

    unsubscribe = canvasEventBus.subscribe("freezone/node-action-result", (payload) => {
      if (payload.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(payload);
    });
  });
}

function waitForNodeActionAccepted(
  requestId: string,
  timeoutMs = DEFAULT_NODE_ACTION_ACCEPT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(false);
    }, timeoutMs);

    unsubscribe = canvasEventBus.subscribe("freezone/node-action-accepted", (payload) => {
      if (payload.requestId !== requestId || settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(true);
    });
  });
}

export function hasGeneratedResult(
  nodeId: string,
  action: string,
  includeInvalidatedResult = false,
): boolean {
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  if (!data) return false;
  if (
    !includeInvalidatedResult &&
    GENERATION_NODE_ACTIONS.has(action) &&
    data.workflowResultStale === true
  ) {
    return false;
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

export function hasCurrentWorkflowResult(nodeId: string, action: string): boolean {
  if (!GENERATION_NODE_ACTIONS.has(action)) return false;
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  return Boolean(
    data &&
    data.workflowResultStale !== true &&
    nonEmptyString(data.workflowGeneratedAt) &&
    hasGeneratedResult(nodeId, action)
  );
}

function hasActiveGenerationHandle(nodeId: string): boolean {
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  if (!data || data.isGenerating !== true) return false;
  return Boolean(
    nonEmptyString(data.generationTaskKey) ??
    nonEmptyString(data.generationTaskJobId) ??
    nonEmptyString(data.generationJobId) ??
    nonEmptyString(data.taskKey) ??
    nonEmptyString(data.task_key) ??
    nonEmptyString(data.job_id) ??
    nonEmptyString(data.jobId) ??
    nonEmptyString(data.skillRunId)
  );
}

export function isNodeActionGenerationPending(nodeId: string, action: string): boolean {
  return (
    GENERATION_NODE_ACTIONS.has(action) &&
    !hasGeneratedResult(nodeId, action) &&
    hasActiveGenerationHandle(nodeId) &&
    nodeGenerationError(nodeId) === null
  );
}

function submittedGenerationOutputFromNode(nodeId: string): Record<string, unknown> | null {
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const taskKey =
    nonEmptyString(data.generationTaskKey) ??
    nonEmptyString(data.taskKey) ??
    nonEmptyString(data.task_key);
  const jobId =
    nonEmptyString(data.generationTaskJobId) ??
    nonEmptyString(data.generationJobId) ??
    nonEmptyString(data.jobId) ??
    nonEmptyString(data.job_id);
  const taskType =
    nonEmptyString(data.generationTaskType) ??
    nonEmptyString(data.taskType) ??
    nonEmptyString(data.task_type);
  if (!taskKey && !jobId) return null;
  return {
    submitted: true,
    ...(taskKey ? { task_key: taskKey, taskKey } : {}),
    ...(taskType ? { task_type: taskType, taskType } : {}),
    ...(jobId ? { job_id: jobId, jobId } : {}),
  };
}

function generatedResultOutputFromNode(
  nodeId: string,
  action: string,
): Record<string, unknown> | null {
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  if (!data) return null;
  if (action === "generate_text") {
    const content = nonEmptyString(data.content);
    return content ? { content } : null;
  }
  if (action === "generate_story_script") {
    return isRecord(data.scriptResult) && Array.isArray(data.scriptResult.rows)
      ? { scriptResult: data.scriptResult }
      : null;
  }
  if (action === "generate_image") {
    const imageUrl = nonEmptyString(data.imageUrl) ?? nonEmptyString(data.image_url);
    return imageUrl ? { imageUrl } : null;
  }
  if (action === "generate_video" || action === "generate_text_video") {
    const videoUrl = nonEmptyString(data.videoUrl) ?? nonEmptyString(data.video_url);
    return videoUrl ? { videoUrl } : null;
  }
  if (action === "auto_compose_video") {
    const videoUrl = nonEmptyString(data.resultVideoUrl);
    return videoUrl ? { videoUrl, output_url: videoUrl } : null;
  }
  if (action === "generate_audio") {
    const audioUrl = nonEmptyString(data.audioUrl) ?? nonEmptyString(data.audio_url);
    return audioUrl ? { audioUrl } : null;
  }
  if (action === "generate_3gs_world") {
    const plyUrl = nonEmptyString(data.plyUrl);
    if (plyUrl) return { plyUrl };
    return Array.isArray(data.sources) && data.sources.length > 0
      ? { sources: data.sources }
      : null;
  }
  return null;
}

function generatedResultToken(
  nodeId: string,
  action: string,
): string | null {
  const output = generatedResultOutputFromNode(nodeId, action);
  return output ? JSON.stringify(output) : null;
}

async function waitForChangedGeneratedResultFromNode(
  nodeId: string,
  action: string,
  initialToken: string | null,
  timeoutMs: number,
  shouldStop?: () => boolean,
): Promise<Record<string, unknown> | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs && !shouldStop?.()) {
    const output = generatedResultOutputFromNode(nodeId, action);
    if (output && JSON.stringify(output) !== initialToken) return output;
    if (nodeGenerationError(nodeId)) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function workflowTaskReference(
  output: Record<string, unknown> | null | undefined,
): { task_key?: string; task_type?: string; job_id?: string } {
  if (!output) return {};
  const taskKey =
    nonEmptyString(output.task_key) ??
    nonEmptyString(output.taskKey) ??
    nonEmptyString(output.generationTaskKey);
  const taskType =
    nonEmptyString(output.task_type) ??
    nonEmptyString(output.taskType) ??
    nonEmptyString(output.generationTaskType);
  const jobId =
    nonEmptyString(output.job_id) ??
    nonEmptyString(output.jobId) ??
    nonEmptyString(output.generationTaskJobId) ??
    nonEmptyString(output.generationJobId);
  return {
    ...(taskKey ? { task_key: taskKey } : {}),
    ...(taskType ? { task_type: taskType } : {}),
    ...(jobId ? { job_id: jobId } : {}),
  };
}

async function waitForSubmittedGenerationOutputFromNode(
  nodeId: string,
  timeoutMs: number,
  shouldStop?: () => boolean,
): Promise<Record<string, unknown> | null> {
  const immediate = submittedGenerationOutputFromNode(nodeId);
  if (immediate) return immediate;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs && !shouldStop?.()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const output = submittedGenerationOutputFromNode(nodeId);
    if (output) return output;
  }
  return null;
}

function nodeGenerationError(nodeId: string): string | null {
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  return nonEmptyString(data?.generationError) ?? null;
}

function isSubmittedGenerationOutput(output: unknown): boolean {
  if (!isRecord(output)) return false;
  if (output.submitted === true || output.status === "submitted") return true;
  return Boolean(
    nonEmptyString(output.task_key) ??
    nonEmptyString(output.taskKey) ??
    nonEmptyString(output.generationTaskKey) ??
    nonEmptyString(output.job_id) ??
    nonEmptyString(output.jobId) ??
    nonEmptyString(output.generationTaskJobId)
  );
}

function hasGeneratedResultOutput(action: string, output: unknown): boolean {
  if (!GENERATION_NODE_ACTIONS.has(action)) return true;
  if (!isRecord(output)) return false;
  if (isSubmittedGenerationOutput(output)) return true;
  if (action === "generate_text") {
    return Boolean(nonEmptyString(output.content));
  }
  if (action === "generate_story_script") {
    const scriptResult = output.scriptResult;
    return isRecord(scriptResult) && Array.isArray(scriptResult.rows) && scriptResult.rows.length > 0;
  }
  if (action === "generate_image") {
    return Boolean(
      nonEmptyString(output.imageUrl) ??
      nonEmptyString(output.image_url) ??
      nonEmptyString(output.output_url) ??
      nonEmptyString(output.url)
    );
  }
  if (
    action === "generate_video" ||
    action === "generate_text_video" ||
    action === "auto_compose_video"
  ) {
    return Boolean(
      nonEmptyString(output.videoUrl) ??
      nonEmptyString(output.video_url) ??
      nonEmptyString(output.output_url) ??
      nonEmptyString(output.url)
    );
  }
  if (action === "generate_audio") {
    return Boolean(
      nonEmptyString(output.audioUrl) ??
      nonEmptyString(output.audio_url) ??
      nonEmptyString(output.output_url) ??
      nonEmptyString(output.url)
    );
  }
  if (action === "generate_3gs_world") {
    if (typeof output.plyUrl === "string" && output.plyUrl.trim().length > 0) return true;
    if (!Array.isArray(output.sources)) return false;
    return output.sources.some((source) => {
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

async function waitForGeneratedResultField(
  nodeId: string,
  action: string,
  output?: unknown,
  timeoutMs = DEFAULT_NODE_ACTION_RESULT_FIELD_TIMEOUT_MS,
): Promise<boolean> {
  if (!GENERATION_NODE_ACTIONS.has(action)) return true;
  if (hasGeneratedResultOutput(action, output)) return true;
  if (hasGeneratedResult(nodeId, action, true)) return true;
  if (hasActiveGenerationHandle(nodeId)) return true;
  if (nodeGenerationError(nodeId)) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (hasGeneratedResultOutput(action, output)) return true;
    if (hasGeneratedResult(nodeId, action, true)) return true;
    if (hasActiveGenerationHandle(nodeId)) return true;
    if (nodeGenerationError(nodeId)) return false;
  }
  return hasGeneratedResultOutput(action, output)
    || hasGeneratedResult(nodeId, action, true)
    || hasActiveGenerationHandle(nodeId);
}

function markNodeActionRunning(nodeId: string, action: string): void {
  if (!GENERATION_NODE_ACTIONS.has(action)) return;
  const node = nodeById(nodeId);
  if (!node) return;
  useCanvasStore.getState().updateNodeData(nodeId, {
    workflowActionRunning: true,
    workflowActionStartedAt: Date.now(),
  });
}

function invalidateWorkflowActionResults(
  actions: PendingNodeAction[],
): void {
  const timestamp = new Date().toISOString();
  const store = useCanvasStore.getState();
  for (const action of actions) {
    if (!GENERATION_NODE_ACTIONS.has(action.action) || !action.invalidationReason) continue;
    store.updateNodeData(action.nodeId, {
      workflowResultStale: true,
      workflowInvalidatedAt: timestamp,
      workflowInvalidationReason: action.invalidationReason,
    });
  }
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

function invalidateWorkflowResultsAfterNodeUpdate(
  nodeId: string,
  changedData: Record<string, unknown>,
): void {
  const changedKeys = Object.keys(changedData).filter(
    (key) =>
      !WORKFLOW_PRESENTATION_DATA_KEYS.has(key) &&
      !key.startsWith("workflow"),
  );
  if (changedKeys.length === 0) return;
  const hasInputChange = changedKeys.some((key) => !WORKFLOW_OUTPUT_DATA_KEYS.has(key));
  const affectedNodeIds = expandWorkflowNodeIds([nodeId], ["downstream"])
    .filter((affectedNodeId) => hasInputChange || affectedNodeId !== nodeId);
  const state = useCanvasStore.getState();
  const nodeByIdMap = new Map(state.nodes.map((node) => [node.id, node] as const));
  const timestamp = new Date().toISOString();
  for (const affectedNodeId of affectedNodeIds) {
    const affectedNode = nodeByIdMap.get(affectedNodeId);
    if (!affectedNode || affectedNode.type === CANVAS_NODE_TYPES.group) continue;
    const action = affectedNode.type === CANVAS_NODE_TYPES.videoCompose
      ? "auto_compose_video"
      : defaultWorkflowActionForNode(affectedNode);
    if (!action || !hasGeneratedResult(affectedNodeId, action, true)) continue;
    state.updateNodeData(affectedNodeId, {
      workflowResultStale: true,
      workflowInvalidatedAt: timestamp,
      workflowInvalidationReason: affectedNodeId === nodeId
        ? "node_input_changed"
        : "upstream_input_changed",
    });
  }
}

function markWorkflowActionResultCurrent(nodeId: string, action: string): void {
  if (!GENERATION_NODE_ACTIONS.has(action)) return;
  useCanvasStore.getState().updateNodeData(nodeId, {
    workflowResultStale: false,
    workflowInvalidatedAt: null,
    workflowInvalidationReason: null,
    workflowGeneratedAt: new Date().toISOString(),
  });
}

function clearNodeActionRunning(nodeId: string, action: string): void {
  if (!GENERATION_NODE_ACTIONS.has(action)) return;
  const node = nodeById(nodeId);
  if (!node) return;
  useCanvasStore.getState().updateNodeData(nodeId, {
    workflowActionRunning: false,
    workflowActionStartedAt: null,
  });
}

function mediaRequirementLabel(action: string): string {
  if (action === "generate_text") return "content";
  if (action === "generate_image") return "imageUrl";
  if (
    action === "generate_video" ||
    action === "generate_text_video" ||
    action === "auto_compose_video"
  ) return "videoUrl";
  if (action === "generate_audio") return "audioUrl";
  return "生成结果";
}

function orderedNodeActionsByCanvasEdges(actions: PendingNodeAction[]): {
  ordered: PendingNodeAction[];
  levels: PendingNodeAction[][];
  dependenciesByNodeId: Map<string, Set<string>>;
  cycleError?: string;
} {
  const state = useCanvasStore.getState();
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
      cycleError: "画布连接线存在环形依赖，已取消本批节点动作。",
    };
  }

  return {
    ordered: orderedIds.map((id) => actions[Number(id)]!),
    levels: levelIds.map((level) => level.map((id) => actions[Number(id)]!)),
    dependenciesByNodeId,
  };
}

function enqueueCanvasNodeActions<T>(canvasId: string | null | undefined, run: () => Promise<T>): Promise<T> {
  const key = canvasId || "default";
  const previous = canvasNodeActionQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => run());
  canvasNodeActionQueues.set(key, next.then(
    () => undefined,
    () => undefined,
  ));
  return next;
}

function workflowRunDedupKey(
  canvasId: string | null | undefined,
  pendingActions: PendingNodeAction[],
): string {
  const actionFingerprint = pendingActions
    .map((action) => [
      action.nodeId,
      action.action,
      action.executionMode ?? "single",
      action.invalidationReason ?? "",
    ].join(":"))
    .sort()
    .join("|");
  return `${canvasId || "default"}::${actionFingerprint}`;
}

async function executeQueuedNodeActions(
  pendingActions: PendingNodeAction[],
  result: CanvasChatCommandApplyResult,
  options: ApplyCanvasChatCommandsOptions,
): Promise<void> {
  if (pendingActions.length === 0) return;
  const hasWorkflowRun = pendingActions.some((action) => action.executionMode === "workflow");
  const workflowRunKey = workflowRunDedupKey(options.canvasId, pendingActions);
  if (hasWorkflowRun && activeOrQueuedWorkflowRunKeys.has(workflowRunKey)) {
    const commandIndexes = new Set(
      pendingActions
        .filter((action) => action.executionMode === "workflow")
        .map((action) => action.commandIndex),
    );
    for (const commandIndex of commandIndexes) {
      result.commandResults.push({
        commandIndex,
        type: "run_workflow",
        status: "success",
        label: "工作流正在运行，已忽略重复启动",
        output: {
          skipped: true,
          reason: "workflow_already_running",
        },
      });
    }
    return;
  }
  if (hasWorkflowRun) activeOrQueuedWorkflowRunKeys.add(workflowRunKey);
  const execute = async (): Promise<void> => {
    // A workflow may wait behind an earlier canvas action. Re-check outputs
    // after it reaches the head of the queue so results produced while waiting
    // are not regenerated by a stale action plan. Explicit regeneration keeps
    // its invalidation marker and is intentionally exempt from this filter.
    const completedWhileQueued = pendingActions.filter((action) =>
      action.executionMode === "workflow"
      && !action.invalidationReason
      && hasGeneratedResult(action.nodeId, action.action));
    if (completedWhileQueued.length > 0) {
      const completedKeys = new Set(
        completedWhileQueued.map((action) => `${action.nodeId}:${action.action}`),
      );
      pendingActions = pendingActions.filter(
        (action) => !completedKeys.has(`${action.nodeId}:${action.action}`),
      );
      for (const action of completedWhileQueued) {
        result.commandResults.push({
          commandIndex: action.commandIndex,
          type: "run_node_action",
          status: "success",
          label: `${action.label}（已有结果，已跳过）`,
          nodeId: action.nodeId,
          action: action.action,
          output: {
            skipped: true,
            reason: "workflow_action_already_completed",
          },
        });
      }
    }
    if (pendingActions.length === 0) return;
    const projectId = options.projectId?.trim();
    const canvasId = options.canvasId?.trim();
    let workflowRunId: string | null = null;
    const workflowCancelKeyForRun = workflowCancelKey(canvasId);
    const workflowCancelToken = workflowCancelTokensByCanvas.get(workflowCancelKeyForRun) ?? 0;
    const workflowCancelled = () =>
      (workflowCancelTokensByCanvas.get(workflowCancelKeyForRun) ?? 0) !== workflowCancelToken;
    const workflowRunnerId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `canvas-runner:${crypto.randomUUID()}`
        : `canvas-runner:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
    let workflowLeaseLost = false;
    let workflowHeartbeat: ReturnType<typeof setInterval> | null = null;
    let workflowHeartbeatQueue: Promise<void> = Promise.resolve();
    let workflowPersistenceDrain: Promise<void> | null = null;
    const pendingWorkflowUpdates = new Map<string, WorkflowRunActionUpdate>();
    let pendingWorkflowStatus: "completed" | "failed" | "cancelled" | undefined;
    const workflowActionStatuses = new Map(
      pendingActions.map((action) => [
        `${action.nodeId}:${action.action}`,
        "pending" as WorkflowRunActionStatus,
      ]),
    );
    let workflowCompletionPresented = false;
    const enqueueWorkflowHeartbeat = (operation: () => Promise<void>): Promise<void> => {
      const queued = workflowHeartbeatQueue
        .catch(() => undefined)
        .then(operation);
      workflowHeartbeatQueue = queued.catch(() => undefined);
      return queued;
    };
    const stopWorkflowHeartbeat = () => {
      if (workflowHeartbeat !== null) clearInterval(workflowHeartbeat);
      workflowHeartbeat = null;
    };
    if (projectId && canvasId) {
      try {
        const workflowRunIdempotencyKey =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? `canvas-run:${crypto.randomUUID()}`
            : `canvas-run:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
        const createdRun = await createFreezoneWorkflowRun(
          projectId,
          canvasId,
          pendingActions.map((action) => {
            const node = nodeById(action.nodeId);
            const catalog = node?.data?.workflowCatalog;
            const recipeId = catalog && typeof catalog === "object"
              ? String((catalog as Record<string, unknown>).recipeId ?? "").trim()
              : "";
            const recipeVersion = catalog && typeof catalog === "object"
              ? String((catalog as Record<string, unknown>).recipeVersion ?? "").trim()
              : "";
            return {
              node_id: action.nodeId,
              action: action.action,
              ...(recipeId ? { recipe_id: recipeId } : {}),
              ...(recipeVersion ? { recipe_version: recipeVersion } : {}),
              ...(GENERATION_NODE_ACTIONS.has(action.action)
                ? {
                    generation_attempt_id:
                      `${workflowRunIdempotencyKey}:${action.nodeId}:${action.action}`,
                  }
                : {}),
            };
          }),
          workflowRunIdempotencyKey,
          workflowRunnerId,
        );
        workflowRunId = createdRun.run_id;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, {
            detail: {
              projectId,
              canvasId,
              runId: workflowRunId,
              status: "running",
              run: createdRun,
            },
          }));
        }
        const runId = workflowRunId;
        workflowHeartbeat = setInterval(() => {
          void enqueueWorkflowHeartbeat(async () => {
            await updateFreezoneWorkflowRun(projectId, canvasId, runId, {
              status: "running",
              runner_id: workflowRunnerId,
            });
          }).catch((error) => {
            if (error instanceof ApiError && error.status === 409) workflowLeaseLost = true;
          });
        }, 15_000);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          const message = "当前画布已有工作流正在执行，请等待其完成后再试。";
          result.errors.push(message);
          for (const action of pendingActions) {
            result.commandResults.push({
              commandIndex: action.commandIndex,
              type: "run_node_action",
              status: "error",
              label: action.label,
              nodeId: action.nodeId,
              action: action.action,
              error: message,
            });
          }
          return;
        }
        // Execution records are additive. A persistence outage must not block generation.
      }
    }
    const drainWorkflowPersistence = (): Promise<void> => {
      if (workflowPersistenceDrain) return workflowPersistenceDrain;
      if (!projectId || !canvasId || !workflowRunId) return Promise.resolve();
      const runId = workflowRunId;
      workflowPersistenceDrain = (async () => {
        while (pendingWorkflowUpdates.size > 0 || pendingWorkflowStatus) {
          const actionUpdates = [...pendingWorkflowUpdates.values()];
          const status = pendingWorkflowStatus;
          pendingWorkflowUpdates.clear();
          pendingWorkflowStatus = undefined;
          try {
            const updatedRun = await updateFreezoneWorkflowRun(projectId, canvasId, runId, {
              ...(actionUpdates.length > 0 ? { action_updates: actionUpdates } : {}),
              ...(status ? { status } : {}),
              runner_id: workflowRunnerId,
            });
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, {
                detail: {
                  projectId,
                  canvasId,
                  runId,
                  ...(status ? { status } : {}),
                  run: updatedRun,
                },
              }));
            }
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) workflowLeaseLost = true;
            // Keep the established in-browser runner available when persistence is unavailable.
          }
        }
      })().finally(() => {
        workflowPersistenceDrain = null;
      });
      return workflowPersistenceDrain;
    };
    const persistRunUpdate = async (
      updates: WorkflowRunActionUpdate[],
      status?: "completed" | "failed" | "cancelled",
    ): Promise<void> => {
      if (!projectId || !canvasId || !workflowRunId) return;
      const acceptedUpdates = updates.filter((update) => {
        const key = `${update.node_id}:${update.action}`;
        const current = workflowActionStatuses.get(key);
        if (
          current &&
          TERMINAL_WORKFLOW_ACTION_STATUSES.has(current) &&
          update.status !== current &&
          !(
            update.status === "completed" &&
            (current === "failed" || current === "blocked")
          )
        ) {
          return false;
        }
        workflowActionStatuses.set(key, update.status);
        return true;
      });
      if (acceptedUpdates.length === 0 && !status) return;
      const runId = workflowRunId;
      for (const update of acceptedUpdates) {
        const key = `${update.node_id}:${update.action}`;
        pendingWorkflowUpdates.set(key, {
          ...pendingWorkflowUpdates.get(key),
          ...update,
        });
      }
      if (status) pendingWorkflowStatus = status;
      const allActionsCompleted =
        workflowActionStatuses.size > 0 &&
        [...workflowActionStatuses.values()].every(
          (actionStatus) => actionStatus === "completed" || actionStatus === "skipped",
        );
      const presentedStatus =
        status ??
        (allActionsCompleted && !workflowCompletionPresented ? "completed" : undefined);
      if (presentedStatus === "completed") workflowCompletionPresented = true;
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, {
          detail: {
            projectId,
            canvasId,
            runId,
            ...(presentedStatus ? { status: presentedStatus } : {}),
            ...(acceptedUpdates.length > 0 ? { actionUpdates: acceptedUpdates } : {}),
          },
        }));
      }
      await drainWorkflowPersistence();
    };
    const { levels, dependenciesByNodeId, cycleError } = orderedNodeActionsByCanvasEdges(pendingActions);
    if (cycleError) {
      result.errors.push(cycleError);
      for (const action of pendingActions) {
        result.commandResults.push({
          commandIndex: action.commandIndex,
          type: "run_node_action",
          status: "error",
          label: action.label,
          nodeId: action.nodeId,
          action: action.action,
          error: cycleError,
        });
      }
      stopWorkflowHeartbeat();
      await workflowHeartbeatQueue;
      await persistRunUpdate(
        pendingActions.map((action) => ({
          node_id: action.nodeId,
          action: action.action,
          status: "blocked",
          error: cycleError,
        })),
        "failed",
      );
      return;
    }
    invalidateWorkflowActionResults(pendingActions);

    const initialGraphSignature = workflowGraphSignature(pendingActions);
    const settledActionKeys = new Set<string>();
    const blockedNodeIds = new Set<string>();
    const recoverableFailures = new Map<
      string,
      { action: PendingNodeAction; error: string }
    >();
    const workflowLaneLimits: Record<WorkflowActionLane, number> = {
      ...WORKFLOW_ACTION_LANE_LIMITS,
    };
    if (projectId) {
      try {
        const backendLimits = await getProjectTaskLimits(projectId);
        for (const lane of Object.keys(workflowLaneLimits) as WorkflowActionLane[]) {
          const available = availableWorkflowLaneCapacity(backendLimits, lane);
          if (available !== null) {
            workflowLaneLimits[lane] = Math.max(
              1,
              Math.min(workflowLaneLimits[lane], available),
            );
          }
        }
      } catch {
        // Keep CE compatibility when task admission reporting is unavailable.
      }
    }
    const generationActions = pendingActions.filter((action) =>
      GENERATION_NODE_ACTIONS.has(action.action));
    const generationCountByLane = generationActions.reduce<Record<WorkflowActionLane, number>>(
      (counts, action) => {
        const lane = workflowActionLane(action.action);
        counts[lane] += 1;
        return counts;
      },
      { default: 0, video: 0, world: 0, ffmpeg: 0 },
    );
    const actionByNodeId = new Map(
      pendingActions.map((action) => [action.nodeId, action]),
    );
    const handleWorkflowActivity = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowExecutionActivityDetail>).detail;
      const action = actionByNodeId.get(detail?.nodeId);
      if (!action || !detail?.phase) return;
      void persistRunUpdate([{
        node_id: action.nodeId,
        action: action.action,
        status: "running",
        phase: detail.phase,
      }]);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, handleWorkflowActivity);
    }
    let runFailed = false;
    let runCancelled = false;
    try {
      for (const level of levels) {
      if (workflowCancelled()) {
        runCancelled = true;
        const unsettledActions = pendingActions.filter(
          (action) => !settledActionKeys.has(`${action.nodeId}:${action.action}`),
        );
        await persistRunUpdate(unsettledActions.map((action) => ({
          node_id: action.nodeId,
          action: action.action,
          status: "skipped",
          error: WORKFLOW_STOPPED_MESSAGE,
        })), "cancelled");
        break;
      }
      if (workflowLeaseLost) {
        runFailed = true;
        result.errors.push("工作流执行租约已失效，已停止启动后续节点。");
        break;
      }
      if (workflowGraphSignature(pendingActions) !== initialGraphSignature) {
        const message = "画布节点或连线已发生变化，已停止执行旧工作流的后续节点。";
        runFailed = true;
        result.errors.push(message);
        const unsettledActions = pendingActions.filter(
          (action) => !settledActionKeys.has(`${action.nodeId}:${action.action}`),
        );
        for (const action of unsettledActions) {
          result.commandResults.push({
            commandIndex: action.commandIndex,
            type: "run_node_action",
            status: "error",
            label: action.label,
            nodeId: action.nodeId,
            action: action.action,
            error: message,
          });
        }
        await persistRunUpdate(unsettledActions.map((action) => ({
          node_id: action.nodeId,
          action: action.action,
          status: "blocked",
          error: message,
        })));
        break;
      }
      await persistRunUpdate(level.map((action) => ({
        node_id: action.nodeId,
        action: action.action,
        status: "pending",
        phase: "waiting_slot",
      })));
      const levelResults = await Promise.all(level.map(async (action) => {
        const settled = await (async () => {
        let blockedUpstream: string | undefined;
        for (const nodeId of dependenciesByNodeId.get(action.nodeId) ?? []) {
          if (!blockedNodeIds.has(nodeId)) continue;
          const upstreamAction = actionByNodeId.get(nodeId);
          if (
            upstreamAction &&
            hasGeneratedResult(nodeId, upstreamAction.action, true)
          ) {
            blockedNodeIds.delete(nodeId);
            recoverableFailures.delete(nodeId);
            markWorkflowActionResultCurrent(nodeId, upstreamAction.action);
            await persistRunUpdate([{
              node_id: nodeId,
              action: upstreamAction.action,
              status: "completed",
              phase: "syncing_result",
            }]);
            continue;
          }
          blockedUpstream = nodeId;
          break;
        }
        if (blockedUpstream) {
          return {
            action,
            failed: `跳过 ${action.action}：上游节点 ${blockedUpstream} 未成功完成。`,
          };
        }

            const lane = workflowActionLane(action.action);
            const releaseActionSlot = await acquireWorkflowActionSlot(
              action.action,
              workflowLaneLimits[lane],
            );
            try {
              for (
                let retryCount = 0;
                retryCount <= WORKFLOW_ACTION_MAX_RETRIES;
                retryCount += 1
              ) {
            if (workflowCancelled()) {
              return {
                action,
                failed: "工作流已停止，未启动后续节点。",
                retryCount,
              };
            }
            const mustHoldCapacityUntilCompleted = GENERATION_NODE_ACTIONS.has(action.action) && (
              generationActions.length > WORKFLOW_ACTION_CONCURRENCY ||
              generationCountByLane[lane] > workflowLaneLimits[lane]
            );
            const executionMode = mustHoldCapacityUntilCompleted
              ? "workflow"
              : action.executionMode;
            if (projectId && GENERATION_NODE_ACTIONS.has(action.action)) {
              const capacityReady = await waitForWorkflowLaneCapacity(
                projectId,
                lane,
                options.actionTimeoutMs ?? DEFAULT_NODE_ACTION_TIMEOUT_MS,
                () => workflowLeaseLost || workflowCancelled(),
                () => {
                  void persistRunUpdate([{
                    node_id: action.nodeId,
                    action: action.action,
                    status: "running",
                    phase: "waiting_capacity",
                  }]);
                },
              );
              if (!capacityReady) {
                return {
                  action,
                  failed: workflowCancelled()
                    ? WORKFLOW_STOPPED_MESSAGE
                    : workflowLeaseLost
                      ? "工作流执行租约已失效，已停止等待任务队列。"
                      : `${lane} 任务队列长时间没有可用容量，请稍后继续工作流。`,
                  retryCount,
                };
              }
            }
            if (workflowCancelled()) {
              return {
                action,
                failed: WORKFLOW_STOPPED_MESSAGE,
                retryCount,
              };
            }
            await persistRunUpdate([{
              node_id: action.nodeId,
              action: action.action,
              status: "running",
              phase: "preparing",
              retry_count: retryCount,
            }]);

            await ensureVideoContinuityTailFrames(action, projectId);

            if (action.action === "generate_audio" && !hydrateWorkflowAudioInput(action.nodeId)) {
              return {
                action,
          failed: "旁白节点缺少上游生成的文本，已停止提交 TTS 请求；请先完成剧本/Beat 文本生成后重试。", // i18n-exempt -- workflow error payload
                retryCount,
              };
            }

            const requestId = `node-action:${Date.now()}:${Math.random().toString(36).slice(2)}`;
            const uiOpenAction = UI_OPEN_NODE_ACTIONS.has(action.action);
            const waiting = waitForNodeActionResult(
              requestId,
              uiOpenAction ? 300 : options.actionTimeoutMs ?? DEFAULT_NODE_ACTION_TIMEOUT_MS,
              uiOpenAction
                ? {
                  requestId,
                  nodeId: action.nodeId,
                  action: action.action,
                  status: "success",
                  output: { openedUiAction: true, fallback: true },
                }
                : undefined,
            );
            const requiresAcceptedSignal = GENERATION_NODE_ACTIONS.has(action.action);
            const acceptTimeoutMs =
              options.actionAcceptTimeoutMs ?? DEFAULT_NODE_ACTION_ACCEPT_TIMEOUT_MS;
            const publishNodeAction = () => dispatchNodeAction({
              nodeId: action.nodeId,
              action: action.action,
              executionMode,
              ...(action.parameters ? { parameters: action.parameters } : {}),
              requestId,
            });
            const initialGeneratedResultToken = generatedResultToken(
              action.nodeId,
              action.action,
            );
            markNodeActionRunning(action.nodeId, action.action);
            let handlerCount = 0;
            const accepted = requiresAcceptedSignal
              ? waitForNodeActionAccepted(requestId, acceptTimeoutMs)
              : Promise.resolve(true);
            try {
              handlerCount = publishNodeAction();
              if (requiresAcceptedSignal) {
                // The event-bus subscriber count is global, not target-specific. Other
                // visible nodes can make handlerCount non-zero while this target is
                // still virtualized off-screen. Give the target a brief chance to
                // accept, then mount it regardless of unrelated subscribers.
                const preMountSignal = await Promise.race([
                  accepted.then((ok) => ok ? "accepted" as const : "rejected" as const),
                  waiting.then(() => "result" as const),
                  new Promise<"pending">((resolve) => {
                    setTimeout(() => resolve("pending"), NODE_ACTION_ACCEPTANCE_GRACE_MS);
                  }),
                ]);
                if (preMountSignal === "pending") {
                  // Focusing mounts the target, whose subscription replays the
                  // already-pending action.
                  await mountNodeForPendingAction(action.nodeId);
                }
              } else if (handlerCount === 0) {
                clearPendingNodeAction(requestId);
                clearNodeActionRunning(action.nodeId, action.action);
                return {
                  action,
                  failed: `节点动作没有处理器：${action.action} (${action.nodeId})。`,
                };
              }
            } catch (error) {
              clearPendingNodeAction(requestId);
              clearNodeActionRunning(action.nodeId, action.action);
              return {
                action,
                failed: `节点动作执行异常：${errorMessage(error)}`,
              };
            }
            const firstSignal = await Promise.race([
              accepted.then((ok) => ({ kind: "accepted" as const, ok })),
              waiting.then((actionResult) => ({ kind: "result" as const, actionResult })),
            ]);
            if (firstSignal.kind === "accepted" && !firstSignal.ok) {
              clearPendingNodeAction(requestId);
              clearNodeActionRunning(action.nodeId, action.action);
              return {
                action,
                failed: `节点动作未被目标节点接手：${action.action} (${action.nodeId})。请确认该节点已在画布中渲染后重试。`,
              };
            }
            let actionSettled = false;
            const taskReferencePersistence =
              firstSignal.kind === "accepted" && GENERATION_NODE_ACTIONS.has(action.action)
                ? waitForSubmittedGenerationOutputFromNode(
                  action.nodeId,
                  Math.min(options.actionTimeoutMs ?? DEFAULT_NODE_ACTION_TIMEOUT_MS, 5_000),
                  () => actionSettled,
                ).then(async (submittedOutput) => {
                  const taskReference = workflowTaskReference(submittedOutput);
                  if (Object.keys(taskReference).length === 0) return;
                  await persistRunUpdate([{
                    node_id: action.nodeId,
                    action: action.action,
                    status: "running",
                    phase: "generating",
                    ...taskReference,
                  }]);
                })
                : Promise.resolve();
            clearPendingNodeAction(requestId);
            const singleGenerationSubmission =
              executionMode === "single" && GENERATION_NODE_ACTIONS.has(action.action)
                ? waitForSubmittedGenerationOutputFromNode(
                  action.nodeId,
                  options.actionTimeoutMs ?? DEFAULT_NODE_ACTION_TIMEOUT_MS,
                ).then((output): NodeActionResult | Promise<NodeActionResult> => {
                  if (output) {
                    return {
                      requestId,
                      nodeId: action.nodeId,
                      action: action.action,
                      status: "success" as const,
                      output,
                    };
                  }
                  return waiting;
                })
                : null;
            const changedGeneratedResult =
              firstSignal.kind === "accepted" && GENERATION_NODE_ACTIONS.has(action.action)
                ? waitForChangedGeneratedResultFromNode(
                  action.nodeId,
                  action.action,
                  initialGeneratedResultToken,
                  options.actionTimeoutMs ?? DEFAULT_NODE_ACTION_TIMEOUT_MS,
                  () => actionSettled || workflowLeaseLost || workflowCancelled(),
                ).then((output): NodeActionResult | Promise<NodeActionResult> => {
                  if (output) {
                    return {
                      requestId,
                      nodeId: action.nodeId,
                      action: action.action,
                      status: "success" as const,
                      output,
                    };
                  }
                  return waiting;
                })
                : null;
            const actionResult = firstSignal.kind === "result"
              ? firstSignal.actionResult
              : await Promise.race([
                  waiting,
                  ...(singleGenerationSubmission ? [singleGenerationSubmission] : []),
                  ...(changedGeneratedResult ? [changedGeneratedResult] : []),
                ]);
            actionSettled = true;
            void taskReferencePersistence;
            clearPendingNodeAction(requestId);
            await persistRunUpdate([{
              node_id: action.nodeId,
              action: action.action,
              status: "running",
              phase: "syncing_result",
            }]);
            await requestAnimationFrameOrTimeout();
            const hasRequiredOutput = actionResult.status === "error"
              ? false
              : await waitForGeneratedResultField(
                action.nodeId,
                action.action,
                actionResult.output,
                options.actionResultFieldTimeoutMs ?? DEFAULT_NODE_ACTION_RESULT_FIELD_TIMEOUT_MS,
              );
            const outputIssue = hasRequiredOutput
              ? deterministicNodeOutputIssue(
                action.action,
                nodeById(action.nodeId)?.data,
                actionResult.output,
              )
              : null;

            const actionOpenedUserUi =
              isRecord(actionResult.output) &&
              (actionResult.output.openedUiAction === true ||
                actionResult.output.requires_user_action === true);
            const actionWasSkipped =
              isRecord(actionResult.output) && actionResult.output.skipped === true;
            const failed = actionResult.status === "error"
              ? actionResult.error || "节点动作执行失败"
              : outputIssue
                ? outputIssue
              : !actionOpenedUserUi && !actionWasSkipped && !hasRequiredOutput
                ? nodeGenerationError(action.nodeId) ??
                  `节点动作完成但未产出 ${mediaRequirementLabel(action.action)}。`
                : null;

            clearNodeActionRunning(action.nodeId, action.action);
            if (
              failed &&
              retryCount < WORKFLOW_ACTION_MAX_RETRIES &&
              isRetryableWorkflowActionError(failed)
            ) {
              await persistRunUpdate([{
                node_id: action.nodeId,
                action: action.action,
                status: "running",
                phase: "retrying",
                retry_count: retryCount + 1,
              }]);
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  options.actionRetryDelayMs ?? workflowRetryDelayMs(retryCount + 1),
                ));
              continue;
            }
            return { action, failed, output: actionResult.output, retryCount };
          }
          return {
            action,
            failed: "节点动作重试次数已耗尽",
            retryCount: WORKFLOW_ACTION_MAX_RETRIES,
          };
        } finally {
          releaseActionSlot();
        }
        })();
        void persistRunUpdate([{
          node_id: settled.action.nodeId,
          action: settled.action.action,
          status: settled.failed
            ? settled.failed === WORKFLOW_STOPPED_MESSAGE
              ? "skipped"
              : settled.failed.startsWith("跳过 ") ? "blocked" : "failed"
            : isRecord(settled.output) && settled.output.skipped === true
              ? "skipped"
              : "completed",
          ...(settled.failed ? { error: settled.failed } : {}),
          retry_count: settled.retryCount ?? 0,
          ...workflowTaskReference(settled.output),
        }]);
        return settled;
      }));

      for (const { action, failed, output } of levelResults) {
        if (failed === WORKFLOW_STOPPED_MESSAGE) {
          runCancelled = true;
          continue;
        }
        if (failed) {
          blockedNodeIds.add(action.nodeId);
          recoverableFailures.set(action.nodeId, { action, error: failed });
          continue;
        }

        selectAndFocusNode(action.nodeId);
        markWorkflowActionResultCurrent(action.nodeId, action.action);
        result.openedUiActions += 1;
        result.commandResults.push({
          commandIndex: action.commandIndex,
          type: "run_node_action",
          status: "success",
          label: action.label,
          nodeId: action.nodeId,
          action: action.action,
          ...(output ? { output } : {}),
        });
      }
      for (const { action } of levelResults) {
        settledActionKeys.add(`${action.nodeId}:${action.action}`);
      }
      }
      for (const { action, error } of recoverableFailures.values()) {
        result.errors.push(error);
        result.commandResults.push({
          commandIndex: action.commandIndex,
          type: "run_node_action",
          status: "error",
          label: action.label,
          nodeId: action.nodeId,
          action: action.action,
          error,
        });
      }
      stopWorkflowHeartbeat();
      await workflowHeartbeatQueue;
      await persistRunUpdate(
        [],
        runCancelled ? "cancelled" : runFailed || blockedNodeIds.size > 0 ? "failed" : "completed",
      );
    } finally {
      if (typeof window !== "undefined") {
        window.removeEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, handleWorkflowActivity);
      }
      stopWorkflowHeartbeat();
    }
  };
  try {
    await enqueueCanvasNodeActions(options.canvasId, execute);
  } finally {
    if (hasWorkflowRun) activeOrQueuedWorkflowRunKeys.delete(workflowRunKey);
  }
}

async function executePendingMainlineProjections(
  pendingProjections: PendingMainlineProjection[],
  result: CanvasChatCommandApplyResult,
): Promise<void> {
  for (const projection of pendingProjections) {
    try {
      const canvasId = await openPresetProjectionInMyCanvas(projection.projectId, projection.request);
      result.openedUiActions += 1;
      result.commandResults.push({
        commandIndex: projection.commandIndex,
        type: "open_mainline_projection",
        status: "success",
        label: projection.label,
        output: {
          opened: true,
          canvas_id: canvasId,
          request: projection.request,
        },
      });
    } catch (error) {
      const message = errorMessage(error);
      result.errors.push(message);
      result.commandResults.push({
        commandIndex: projection.commandIndex,
        type: "open_mainline_projection",
        status: "error",
        label: projection.label,
        error: message,
      });
    }
  }
}

function commandLabel(command: CanvasChatCommand): string {
  switch (command.type) {
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
      if (command.action === "open_video_compose_modal") return "打开视频合成";
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
      if (command.action === "capture_pano_current_view") return "截取当前 360 视角";
      if (command.action === "capture_pano_2x2_views") return "截取 360 四视角";
      if (command.action === "capture_pano_4x3_views") return "截取 360 十二视角";
      if (command.action === "download_image") return "下载图片";
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

function selectAndFocusNode(nodeId: string): void {
  const store = useCanvasStore.getState();
  store.onNodesChange(
    store.nodes.map((node) => ({
      id: node.id,
      type: "select" as const,
      selected: node.id === nodeId,
    })),
  );
  store.setSelectedNode(nodeId);
  store.requestFocusNode(nodeId);
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

export function normalizeCanvasChatCommandEnvelopesForValidation(
  envelopes: CanvasChatCommandEnvelope[],
  initialNodeIds?: Iterable<string>,
): CanvasChatCommandEnvelope[] {
  const baseNodeIds = new Set(initialNodeIds ?? useCanvasStore.getState().nodes.map((node) => node.id));

  return envelopes.map((envelope) => {
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
      if (nextUnknownRefs.length !== 1) return command;

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
  command: Extract<CanvasChatCommand, { type: "create_node" }>,
): CanvasNode | null {
  const identity = workflowNodeIdentity(command.data);
  if (!identity) return null;
  return useCanvasStore.getState().nodes.find((node) => {
    const current = workflowNodeIdentity(node.data);
    return (
      current?.instanceId === identity.instanceId &&
      current.planNodeId === identity.planNodeId
    );
  }) ?? null;
}

function workflowEnvelopeAlreadyApplied(envelope: CanvasChatCommandEnvelope): boolean {
  const createCommands = envelope.commands.filter(
    (command): command is Extract<CanvasChatCommand, { type: "create_node" }> =>
      command.type === "create_node" && workflowNodeIdentity(command.data) !== null,
  );
  return (
    createCommands.length > 0 &&
    createCommands.every((command) => existingWorkflowNodeForCommand(command) !== null)
  );
}

function applyCanvasChatCommandsInternal(
  envelopes: CanvasChatCommandEnvelope[],
  options: ApplyCanvasChatCommandsOptions & { queueNodeActions: boolean },
): CanvasChatCommandApplyResult | Promise<CanvasChatCommandApplyResult> {
  const result: CanvasChatCommandApplyResult = {
    applied: 0,
    openedUiActions: 0,
    createdNodeIds: [],
    errors: [],
    commandResults: [],
  };
  const pendingNodeActions: PendingNodeAction[] = [];
  const pendingMainlineProjections: PendingMainlineProjection[] = [];
  const queuedNodeActionKeys = new Set<string>();
  const normalizedEnvelopes = normalizeCanvasChatCommandEnvelopesForValidation(envelopes);
  const validation = validateCanvasChatCommandEnvelopes(
    normalizedEnvelopes,
    useCanvasStore.getState().nodes,
    useCanvasStore.getState().edges,
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
    if (workflowEnvelopeAlreadyApplied(envelope)) {
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
    const envelopeCreatedNodeIds: string[] = [];
    const envelopeSourceNodeIds = new Set<string>();
    const envelopeErrorStart = result.errors.length;
    let envelopeHasAddNextNode = false;
    let envelopeAddNextCreatedCount = 0;
    let envelopeHasExplicitGroupNodes = false;
    let envelopeConnectionCount = 0;

    for (const command of envelope.commands) {
      const currentCommandIndex = commandIndex;
      commandIndex += 1;
      try {
        switch (command.type) {
          case "create_node": {
            const existingWorkflowNode = existingWorkflowNodeForCommand(command);
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
            const nodeId = useCanvasStore.getState().addNode(
              command.node_type,
              command.position ?? fallbackCreatePosition(),
              data,
            );
            if (command.client_id) clientIdMap.set(command.client_id, nodeId);
            result.createdNodeIds.push(nodeId);
            envelopeCreatedNodeIds.push(nodeId);
            selectAndFocusNode(nodeId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: command.client_id,
              createdNodeId: nodeId,
            });
            break;
          }
          case "add_next_node": {
            const sourceId = resolveNodeId(command.source_node_id, clientIdMap);
            const sourceNode = nodeById(sourceId);
            if (!sourceNode) throw new Error(`source node not found: ${command.source_node_id}`);
            const nodeType = chooseNextNodeType(sourceNode, command.node_type);
            const position = useCanvasStore.getState().findNodePosition(sourceId, DEFAULT_NODE_WIDTH, 320);
            const data = inheritMainlineFields(
              sourceNode as { data: MainlineFieldsSource },
              normalizeCanvasCommandCreateNodeData(nodeType, command.data),
            );
            const nodeId = useCanvasStore.getState().addNode(nodeType, position, data);
            if (command.client_id) clientIdMap.set(command.client_id, nodeId);
            if (command.connect) {
              const edgeId = connectNodes(sourceId, nodeId);
              if (edgeId) envelopeConnectionCount += 1;
            }
            result.createdNodeIds.push(nodeId);
            envelopeCreatedNodeIds.push(nodeId);
            envelopeSourceNodeIds.add(sourceId);
            envelopeHasAddNextNode = true;
            envelopeAddNextCreatedCount += 1;
            selectAndFocusNode(nodeId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: command.source_node_id,
              createdNodeId: nodeId,
            });
            break;
          }
          case "update_node_data": {
            const targetId = resolveNodeId(command.node_id, clientIdMap);
            const targetNode = nodeById(targetId);
            if (!targetNode) throw new Error(`node not found: ${command.node_id}`);
            const data = normalizeCanvasCommandNodeData(targetNode.type, command.data);
            if (isPresetManagedNode(targetNode)) {
              if (targetNode.type !== CANVAS_NODE_TYPES.beatContext || !isBeatContextAgentEditablePatch(data)) {
                throw new Error(`node is preset managed: ${command.node_id}`);
              }
              useCanvasStore.getState().updateNodeData(
                targetId,
                normalizeBeatContextAgentPatch(targetNode.data as BeatContextNodeData, data),
              );
            } else {
              useCanvasStore.getState().updateNodeData(targetId, data);
            }
            invalidateWorkflowResultsAfterNodeUpdate(targetId, data);
            selectAndFocusNode(targetId);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: targetId,
            });
            break;
          }
          case "delete_nodes": {
            const deletion = deleteNodesOrEdges(
              command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap)),
              clientIdMap,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: command.node_ids[0],
              output: deletion,
            });
            break;
          }
          case "clear_canvas": {
            const store = useCanvasStore.getState();
            const deletableNodeIds = store.nodes
              .filter((node) => !isMainlineProjectionManagedNode(node))
              .map((node) => node.id);
            const edgeIds = store.edges.map((edge) => edge.id);
            if (deletableNodeIds.length === 0 && edgeIds.length === 0) {
              throw new Error("画布中没有可清空的普通节点或连接");
            }
            const deletion = deleteNodesOrEdges(
              [...deletableNodeIds, ...edgeIds],
              clientIdMap,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              output: deletion,
            });
            break;
          }
          case "delete_edges": {
            deleteEdges(command, clientIdMap);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: commandPrimaryNodeId(command),
            });
            break;
          }
          case "create_edge": {
            const source = resolveNodeId(command.source, clientIdMap);
            const target = resolveNodeId(command.target, clientIdMap);
            const invalidReason = invalidConnectionReason(source, target);
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
            const edgeId = connectNodes(source, target, { link_type: command.link_type });
            if (!edgeId) throw new Error(`edge rejected: ${command.source} -> ${command.target}`);
            envelopeConnectionCount += 1;
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: source,
            });
            break;
          }
          case "layout_nodes": {
            const targetNodeIds = (command.node_ids && command.node_ids.length > 0)
              ? command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap))
              : useCanvasStore.getState().nodes.map((node) => node.id);
            layoutNodes(
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
              label: commandLabel(command),
              nodeId: targetNodeIds[0],
            });
            break;
          }
          case "group_nodes": {
            envelopeHasExplicitGroupNodes = true;
            const targetNodeIds = command.node_ids.map((nodeId) => resolveNodeId(nodeId, clientIdMap));
            const groupId = useCanvasStore.getState().groupNodes(targetNodeIds, {
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
              label: commandLabel(command),
              nodeId: targetNodeIds[0],
              createdNodeId: groupId,
            });
            break;
          }
          case "move_nodes": {
            moveNodes(command, clientIdMap);
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: commandPrimaryNodeId(command),
            });
            break;
          }
          case "select_nodes": {
            selectNodes(
              command.node_ids,
              clientIdMap,
              command.focus,
            );
            result.applied += 1;
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: command.node_ids[0],
            });
            break;
          }
          case "run_node_action": {
            const targetId = resolveNodeId(command.node_id, clientIdMap);
            assertNodeActionAvailable(targetId, command.action);
            if (!RESULT_SPAWNING_NODE_ACTIONS.has(command.action)) {
              selectAndFocusNode(targetId);
            }
            if (options.queueNodeActions && CURRENT_MEDIA_NODE_ACTIONS.has(command.action)) {
              setTimeout(() => {
                try {
                  runNodeAction(targetId, command.action, command.parameters);
                } catch (error) {
                  console.error("[freezone] run node action failed", error);
                }
              }, 0);
              result.openedUiActions += 1;
              result.commandResults.push({
                commandIndex: currentCommandIndex,
                type: command.type,
                status: "success",
                label: commandLabel(command),
                nodeId: targetId,
                action: command.action,
              });
              break;
            }
            const queuedActions = options.queueNodeActions
              ? directNodeActionQueue(
                targetId,
                command.action,
                currentCommandIndex,
                command.parameters,
              )
              : [];
            const shouldQueue = (
              options.queueNodeActions
              && (
                GENERATION_NODE_ACTIONS.has(command.action)
                || queuedActions.length > 1
              )
            );
            if (shouldQueue) {
              for (const queuedAction of queuedActions) {
                const actionKey = `${queuedAction.nodeId}:${queuedAction.action}`;
                if (queuedNodeActionKeys.has(actionKey)) continue;
                assertNodeActionAvailable(queuedAction.nodeId, queuedAction.action);
                queuedNodeActionKeys.add(actionKey);
                pendingNodeActions.push(queuedAction);
              }
              result.applied += 1;
            } else {
              runNodeAction(targetId, command.action, command.parameters);
              result.openedUiActions += 1;
              result.commandResults.push({
                commandIndex: currentCommandIndex,
                type: command.type,
                status: "success",
                label: commandLabel(command),
                nodeId: targetId,
                action: command.action,
              });
            }
            break;
          }
          case "open_mainline_projection": {
            if (!options.queueNodeActions) {
              throw new Error("open_mainline_projection requires async frontend execution");
            }
            const projectId = command.project_id ?? envelope.project_id ?? options.projectId ?? undefined;
            if (!projectId?.trim()) {
              throw new Error("project_id is required to open a mainline projection");
            }
            pendingMainlineProjections.push({
              commandIndex: currentCommandIndex,
              projectId: projectId.trim(),
              request: command.request,
              label: commandLabel(command),
            });
            break;
          }
          case "run_workflow": {
            const resolvedCommand: Extract<CanvasChatCommand, { type: "run_workflow" }> = {
              ...command,
              node_ids: command.node_ids?.map((nodeId) => resolveNodeId(nodeId, clientIdMap)),
            };
            const allActions = workflowNodeActions(resolvedCommand, currentCommandIndex, { skipCompleted: false });
            const actions = workflowNodeActions(
              resolvedCommand,
              currentCommandIndex,
              { skipCompleted: command.regenerate !== true },
            );
            if (actions.length === 0) {
              if (allActions.length === 0) {
                throw new Error("工作流中没有可执行的生成节点。");
              }
              result.commandResults.push({
                commandIndex: currentCommandIndex,
                type: command.type,
                status: "success",
                label: "工作流已完成，未重新生成",
                nodeId: allActions[0]?.nodeId,
                output: {
                  skipped: true,
                  reason: "workflow_already_completed",
                  requires_regenerate_confirmation: true,
                },
              });
              result.applied += 1;
              break;
            }
            if (options.queueNodeActions) {
              const regenerateSeedNodeIds = new Set(
                resolvedCommand.node_ids ?? selectedWorkflowNodeIds(),
              );
              for (const action of actions) {
                const actionKey = `${action.nodeId}:${action.action}`;
                if (queuedNodeActionKeys.has(actionKey)) continue;
                assertNodeActionAvailable(action.nodeId, action.action);
                queuedNodeActionKeys.add(actionKey);
                pendingNodeActions.push({
                  ...action,
                  ...(command.regenerate === true
                    ? {
                      invalidationReason: regenerateSeedNodeIds.has(action.nodeId)
                        ? "explicit_regeneration" as const
                        : "upstream_regeneration" as const,
                    }
                    : {}),
                });
              }
            } else {
              const { ordered, cycleError } = orderedNodeActionsByCanvasEdges(actions);
              if (cycleError) throw new Error(cycleError);
              for (const action of ordered) {
                runNodeAction(action.nodeId, action.action);
                result.openedUiActions += 1;
                result.commandResults.push({
                  commandIndex: currentCommandIndex,
                  type: "run_node_action",
                  status: "success",
                  label: action.label,
                  nodeId: action.nodeId,
                  action: action.action,
                });
              }
            }
            result.applied += 1;
            const firstNodeId = actions[0]?.nodeId;
            if (firstNodeId) selectAndFocusNode(firstNodeId);
            result.commandResults.push({
              commandIndex: currentCommandIndex,
              type: command.type,
              status: "success",
              label: commandLabel(command),
              nodeId: firstNodeId,
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
          label: commandLabel(command),
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
      const groupId = useCanvasStore.getState().groupNodes(targetNodeIds, {
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
      result.errors.length === envelopeErrorStart &&
      envelopeCreatedNodeIds.length >= 2 &&
      envelope.commands.some((command) =>
        command.type === "create_node" && WORKFLOW_LIKE_CREATE_NODE_TYPES.has(command.node_type),
      )
    ) {
      const targetNodeIds = [...new Set(envelopeCreatedNodeIds)];
      const groupId = useCanvasStore.getState().groupNodes(targetNodeIds, {
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
  }

  if (options.queueNodeActions) {
    return (async () => {
      await executePendingMainlineProjections(pendingMainlineProjections, result);
      await executeQueuedNodeActions(pendingNodeActions, result, options);
      result.errors = dedupeGenerationErrors(result.errors);
      return result;
    })();
  }

  result.errors = dedupeGenerationErrors(result.errors);
  return result;
}

export function applyCanvasChatCommands(envelopes: CanvasChatCommandEnvelope[]): CanvasChatCommandApplyResult {
  return applyCanvasChatCommandsInternal(envelopes, { queueNodeActions: false }) as CanvasChatCommandApplyResult;
}

export function applyCanvasChatCommandsAsync(
  envelopes: CanvasChatCommandEnvelope[],
  options: ApplyCanvasChatCommandsOptions = {},
): Promise<CanvasChatCommandApplyResult> {
  return Promise.resolve(applyCanvasChatCommandsInternal(envelopes, {
    ...options,
    queueNodeActions: true,
  }));
}
