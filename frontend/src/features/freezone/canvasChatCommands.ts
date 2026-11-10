import {
  discoverWorkflowNodeActions, directNodeActionQueue, orderedNodeActionsByCanvasEdges,
  assertNodeActionAvailable, type PlannedNodeAction as PendingNodeAction,
} from './workflowActionPlan';
import {
  GENERATION_NODE_ACTIONS, hasGeneratedResult,
  invalidateWorkflowResultsAfterNodeUpdate,
} from '@/features/canvas/core/workflowInvalidation';
import { browserNodeDataDefaults } from "@/features/canvas/infrastructure/browserNodeDataDefaults";
import { isRecord, isFiniteNumber } from "./canvasCommandEnvelope";
import { STORY_CHOICE_EDGE_TYPE } from "@/features/canvas/story/storyTypes";
import i18next from "i18next";
import { executeWorkflowHtmlNode } from "@/features/canvas/application/workflowHtmlRuntime";
import { executeHtmlArtifactCommand } from '@/features/html-artifacts/commands';
import { executeHtmlNodeWriteAction } from '@/features/html-artifacts/nodeActions';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import {
  applyCanvasCommandsAsync,
  applyCanvasCommandsNow,
  canvasCommandLabel,
  normalizeCanvasCommandEnvelopes,
  isGeneratedCanvasClientId,
  type CanvasCommandEnvironment,
  type CanvasCommandHandlers,
} from "@/features/canvas/core/commands/executor";
import {
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  type CanvasChatCommand,
  type CanvasChatCommandApplyResult,
  type CanvasChatCommandApplyStep,
  type CanvasChatCommandEnvelope,
  type JsonRecord,
  type MainlineProjectionRequest,
} from "@/features/canvas/core/commands/types";
import { selectAndFocusNode as selectAndFocusNodeIn } from "@/features/canvas/core/selection";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import {
  clearPendingNodeAction,
  dispatchNodeAction,
} from "@/features/canvas/application/nodeActionResult";
import {
  createFreezoneWorkflowRun,
  getFreezoneWorkflowRun,
  updateFreezoneWorkflowRun,
  type FreezoneWorkflowRun,
  type WorkflowRunActionStatus,
} from "@/api/canvas";
import {
  getProjectTaskLimits,
  type ProjectTaskLimits,
} from "@/api/tasks";
import { ApiError } from "@/api/client";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import { normalizeCanvasEdgeSemanticKind } from "@/features/freezone/canvasEdgeSemantics";
import { landNodeAgentSceneEdit } from "@/features/previz/agentSceneEdit";
import { useCanvasStore } from "@/stores/canvasStore";
import { deterministicNodeOutputIssue } from "@/features/freezone/workflowQualityGate";
import {
  bindWorkflowProductOperation,
  clearWorkflowProductOperation,
  WORKFLOW_EXECUTION_ACTIVITY_EVENT,
  WORKFLOW_RUN_UPDATED_EVENT,
  type WorkflowExecutionActivityDetail,
  type WorkflowRunActionUpdate,
} from "@/features/canvas/application/workflowExecutionActivity";
import {
  captureVideoFrameToNode,
  resolveCaptureSeekSec,
} from "@/features/canvas/application/videoCaptureFrame";
import {
  attachCompletedStoryFrame,
  attachCompletedStoryAsset,
  ensureVideoContinuity,
  isFmvVideoNode,
  syncStoryVideoReferencePrompt,
} from "@/features/canvas/application/videoContinuity";

export { CANVAS_CHAT_COMMANDS_SCHEMA_VERSION, isGeneratedCanvasClientId };
export type {
  CanvasChatCommand,
  CanvasChatCommandApplyResult,
  CanvasChatCommandApplyStep,
  CanvasChatCommandEnvelope,
};
export const FREEZONE_CANVAS_COMMAND_APPROVAL_EVENT = "freezone/canvas-command-approval";
export const FREEZONE_CANVAS_COMMAND_RESULT_EVENT = "freezone/canvas-command-result";
export const FREEZONE_WORKFLOW_RUN_UPDATED_EVENT = WORKFLOW_RUN_UPDATED_EVENT;

function browserActionPlanOptions() {
  return {
    selectedNodeIds: selectedWorkflowNodeIds(), nodeDataDefaults: browserNodeDataDefaults,
    translate: browserCommandEnvironment.translate,
  };
}

function assertBrowserNodeActionAvailable(nodeId: string, action: string): void {
  assertNodeActionAvailable(useCanvasStore, browserNodeDataDefaults, nodeId, action);
}

export type CanvasCommandApprovalEventDetail = {
  serverApproved?: boolean;
  restoredFromHistory?: boolean;
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
  onWorkflowRunPersisted?: (runId: string, nodeIdMap: Record<string, string>) => void;
};

type PendingVideoFrameCapture = {
  nodeId: string;
  commandIndex: number;
  action: "capture_video_first_frame" | "capture_video_last_frame";
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

export function canvasCommandEnvelopesRunInBackground(
  envelopes: CanvasChatCommandEnvelope[],
): boolean {
  return envelopes.some((envelope) => envelope.commands.some((command) =>
    command.type === "run_workflow" ||
    (command.type === "run_node_action" && GENERATION_NODE_ACTIONS.has(command.action))
  ));
}

export function canvasCommandEnvelopesRequireDurableAcceptance(
  envelopes: CanvasChatCommandEnvelope[],
): boolean {
  return envelopes.some((envelope) =>
    envelope.commands.some((command) => command.type === "run_workflow"));
}

export async function waitForImmediateCanvasCommandResult(
  execution: Promise<CanvasChatCommandApplyResult>,
  durableAcceptance?: Promise<unknown>,
): Promise<CanvasChatCommandApplyResult | null> {
  if (durableAcceptance) {
    const outcome = await Promise.race([
      execution.then((result) => ({ kind: "result" as const, result })),
      durableAcceptance.then(() => ({ kind: "accepted" as const })),
    ]);
    return outcome.kind === "result" ? outcome.result : null;
  }
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
  "run_video_breakdown",
  "open_video_crop_tool",
  "open_video_extend_tool",
  "run_video_depth_capture",
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
const WORKFLOW_LEASE_LOST_MESSAGE = "工作流执行租约已失效，已停止启动后续节点。"; // i18n-exempt
const STOPPED_WORKFLOW_RUN_STATUSES = new Set<string>([
  "failed",
  "cancelled",
  "interrupted",
]);
const workflowRunEndedMessage = (status: string) =>
  `工作流运行已结束（${status}），已停止启动后续节点；请继续工作流以完成未完成的部分。`; // i18n-exempt
const workflowPersistenceFailureMessage = (error: unknown) =>
  `工作流状态保存失败，已停止启动后续节点：${errorMessage(error)}`; // i18n-exempt
const workflowCreationFailureMessage = (error: unknown) =>
  `无法创建持久化工作流记录，未启动节点动作：${errorMessage(error)}`; // i18n-exempt
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
    .filter((edge) => edge.type !== STORY_CHOICE_EDGE_TYPE)
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

// Mirrors RECIPE_ATTEMPT_ENDED_MARKER (workflow_runs.py): the admitted Recipe
// attempt was settled failed/cancelled, so resubmitting it can only 409.
const RECIPE_ATTEMPT_ENDED_MARKER = "recipe attempt ended";

function isRecipeAttemptEndedError(error: string | null | undefined): boolean {
  return String(error ?? "").toLowerCase().includes(RECIPE_ATTEMPT_ENDED_MARKER);
}

/** Keep the raw reason (and marker) so the server still classifies it as final. */
function recipeAttemptEndedMessage(error: string): string {
  return i18next.t("freezone.chat.workflowRecipeAttemptEnded", {
    reason: error,
    interpolation: { escapeValue: false },
  });
}

function isRetryableWorkflowActionError(error: string | null | undefined): boolean {
  const normalized = String(error ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.includes(RECIPE_ATTEMPT_ENDED_MARKER) ||
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
export function canvasCommandEnvelopeMatchesCanvas(
  envelope: CanvasChatCommandEnvelope,
  canvasId: string | null | undefined,
): boolean {
  return !envelope.canvas_id || !canvasId || envelope.canvas_id === canvasId;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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
      displayName: i18next.t('canvas.story.messages.previousLastFrame'),
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

function runNodeAction(nodeId: string, action: string, parameters?: JsonRecord): void {
  assertBrowserNodeActionAvailable(nodeId, action);
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
  return discoverWorkflowNodeActions(useCanvasStore, { ...command, regenerate: false }, -1, browserActionPlanOptions()).actions
    .map(({ nodeId, action }) => ({ nodeId, action }));
}

export function directGenerationTargetsForPreflight(
  nodeId: string,
  action: string,
): WorkflowGenerationTargetPreflight[] {
  return directNodeActionQueue(useCanvasStore, nodeId, action, -1, browserActionPlanOptions())
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

export function hasCurrentWorkflowResult(nodeId: string, action: string): boolean {
  if (!GENERATION_NODE_ACTIONS.has(action)) return false;
  const data = nodeById(nodeId)?.data as Record<string, unknown> | undefined;
  return Boolean(
    data &&
    data.workflowResultStale !== true &&
    nonEmptyString(data.workflowGeneratedAt) &&
    hasGeneratedResult(useCanvasStore, nodeId, action)
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
    !hasGeneratedResult(useCanvasStore, nodeId, action) &&
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
  if (action === "generate_html") {
    return hasGeneratedResult(useCanvasStore, nodeId, action, true) ? {html_artifact:{id:data.artifactId,version:data.artifactVersion}} : null;
  }
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
  // A task completion and a user cancellation can become observable during
  // the same polling interval. Prefer the durable result that already landed
  // on the node before treating the remaining workflow as cancelled.
  const finalOutput = generatedResultOutputFromNode(nodeId, action);
  return finalOutput && JSON.stringify(finalOutput) !== initialToken
    ? finalOutput
    : null;
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
  if (action === "generate_html") {
    return isRecord(output.html_artifact) && Boolean(nonEmptyString(output.html_artifact.id)) && Number.isInteger(output.html_artifact.version) && Number(output.html_artifact.version) > 0;
  }
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
  if (hasGeneratedResult(useCanvasStore, nodeId, action, true)) return true;
  if (hasActiveGenerationHandle(nodeId)) return true;
  if (nodeGenerationError(nodeId)) return false;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (hasGeneratedResultOutput(action, output)) return true;
    if (hasGeneratedResult(useCanvasStore, nodeId, action, true)) return true;
    if (hasActiveGenerationHandle(nodeId)) return true;
    if (nodeGenerationError(nodeId)) return false;
  }
  return hasGeneratedResultOutput(action, output)
    || hasGeneratedResult(useCanvasStore, nodeId, action, true)
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

function syncCompletedStoryFrames(
  imageNodeIds: Iterable<string>,
  result: CanvasChatCommandApplyResult,
): void {
  for (const imageNodeId of imageNodeIds) {
    const attachmentError = attachCompletedStoryFrame(imageNodeId);
    const assetError = attachCompletedStoryAsset(imageNodeId);
    if (attachmentError) {
      result.warnings = [...(result.warnings ?? []), attachmentError];
    }
    if (assetError) result.warnings = [...(result.warnings ?? []), assetError];
    const state = useCanvasStore.getState();
    for (const edge of state.edges.filter((item) => item.source === imageNodeId)) {
      syncStoryVideoReferencePrompt(edge.target);
    }
  }
}

async function executeQueuedNodeActions(
  pendingActions: PendingNodeAction[],
  result: CanvasChatCommandApplyResult,
  options: ApplyCanvasChatCommandsOptions,
  clientIdMap: ReadonlyMap<string, string>,
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
      && hasGeneratedResult(useCanvasStore, action.nodeId, action.action));
    const completedImageNodeIds = new Set(
      completedWhileQueued.filter((action) => action.action === "generate_image")
        .map((action) => action.nodeId),
    );
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
    if (pendingActions.length === 0) {
      syncCompletedStoryFrames(completedImageNodeIds, result);
      return;
    }
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
    let workflowServerCompleted = false;
    let workflowServerReconciliationPending = false;
    let workflowPersistenceError: string | null = null;
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
    const enqueueWorkflowHeartbeat = (operation: () => Promise<void>): Promise<void> => {
      const queued = workflowHeartbeatQueue
        .catch(() => undefined)
        .then(operation);
      workflowHeartbeatQueue = queued.catch(() => undefined);
      return queued;
    };
    // A terminal run PATCH still returns 200 with the unchanged record, so the
    // runner must read the status back instead of treating 200 as a renewed
    // lease (issue #730).
    const observeWorkflowRunStatus = (run: FreezoneWorkflowRun) => {
      if (run.status === "completed") {
        workflowServerCompleted = true;
        return;
      }
      if (!STOPPED_WORKFLOW_RUN_STATUSES.has(run.status)) return;
      workflowLeaseLost = true;
      workflowPersistenceError = workflowRunEndedMessage(run.status);
    };
    let workflowVisibilityListener: (() => void) | null = null;
    // Renews the lease and resolves once the server's run status is observed.
    let confirmWorkflowRunActive: () => Promise<void> = async () => undefined;
    const stopWorkflowHeartbeat = () => {
      if (workflowHeartbeat !== null) clearInterval(workflowHeartbeat);
      workflowHeartbeat = null;
      if (workflowVisibilityListener && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", workflowVisibilityListener);
      }
      workflowVisibilityListener = null;
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
        options.onWorkflowRunPersisted?.(workflowRunId, Object.fromEntries(clientIdMap));
        for (const action of createdRun.actions) {
          if (action.product_operation_id) {
            bindWorkflowProductOperation(action.node_id, {
              projectId,
              operationId: action.product_operation_id,
              generationAttemptId: action.generation_attempt_id ?? undefined,
            });
          }
        }
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
        const sendWorkflowHeartbeat = async (): Promise<void> => {
          if (workflowLeaseLost) return;
          await enqueueWorkflowHeartbeat(async () => {
            const heartbeatRun = await updateFreezoneWorkflowRun(projectId, canvasId, runId, {
              status: "running",
              runner_id: workflowRunnerId,
            });
            observeWorkflowRunStatus(heartbeatRun);
          }).catch((error) => {
            if (error instanceof ApiError && error.status === 409) workflowLeaseLost = true;
            workflowPersistenceError = error instanceof ApiError && error.status === 409
              ? WORKFLOW_LEASE_LOST_MESSAGE
              : workflowPersistenceFailureMessage(error);
          });
        };
        confirmWorkflowRunActive = sendWorkflowHeartbeat;
        workflowHeartbeat = setInterval(() => void sendWorkflowHeartbeat(), 15_000);
        if (typeof document !== "undefined") {
          // Background tabs throttle or freeze timers; renew as soon as the page is back.
          workflowVisibilityListener = () => {
            if (document.visibilityState === "visible") void sendWorkflowHeartbeat();
          };
          document.addEventListener("visibilitychange", workflowVisibilityListener);
        }
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
        const message = workflowCreationFailureMessage(error);
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
            let confirmedRun = updatedRun;
            if (status === "completed" && updatedRun.status === "running") {
              // PATCH records browser progress; GET also reconciles durable task artifacts.
              confirmedRun = await getFreezoneWorkflowRun(projectId, canvasId, runId, 10);
            }
            observeWorkflowRunStatus(confirmedRun);
            if (status === "completed") {
              workflowServerReconciliationPending = confirmedRun.status === "running";
            }
            if (status && confirmedRun.status !== status
              && !(status === "completed" && confirmedRun.status === "running")
              && !workflowPersistenceError) {
              workflowPersistenceError =
                `工作流最终状态未确认（请求 ${status}，服务端返回 ${confirmedRun.status}）。`;
            }
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent(FREEZONE_WORKFLOW_RUN_UPDATED_EVENT, {
                detail: {
                  projectId,
                  canvasId,
                  runId,
                  status: confirmedRun.status,
                  run: confirmedRun,
                },
              }));
            }
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) workflowLeaseLost = true;
            workflowPersistenceError = error instanceof ApiError && error.status === 409
              ? WORKFLOW_LEASE_LOST_MESSAGE
              : workflowPersistenceFailureMessage(error);
            pendingWorkflowUpdates.clear();
            pendingWorkflowStatus = undefined;
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
      for (const update of acceptedUpdates) {
        const key = `${update.node_id}:${update.action}`;
        pendingWorkflowUpdates.set(key, {
          ...pendingWorkflowUpdates.get(key),
          ...update,
        });
      }
      if (status) pendingWorkflowStatus = status;
      await drainWorkflowPersistence();
      if (workflowPersistenceError) throw new Error(workflowPersistenceError);
    };
    const { levels, dependenciesByNodeId, cycleError } = orderedNodeActionsByCanvasEdges(useCanvasStore, pendingActions);
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
    const completedServerActionOutcome = (action: PendingNodeAction, retryCount: number) => {
      const output = generatedResultOutputFromNode(action.nodeId, action.action);
      if (
        action.action !== "run_skill" &&
        GENERATION_NODE_ACTIONS.has(action.action) &&
        (!hasGeneratedResult(useCanvasStore, action.nodeId, action.action) || !output)
      ) {
        return { action, failed: null, pending: true, retryCount };
      }
      return {
        action,
        failed: null,
        output: {
          skipped: true,
          reason: "workflow_run_already_completed",
          ...(output ?? {}),
        },
        retryCount,
      };
    };
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
      }]).catch(() => undefined);
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
        result.errors.push(workflowPersistenceError ?? WORKFLOW_LEASE_LOST_MESSAGE);
        break;
      }
      if (workflowPersistenceError) {
        runFailed = true;
        result.errors.push(workflowPersistenceError);
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
            hasGeneratedResult(useCanvasStore, nodeId, upstreamAction.action, true)
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
                () => workflowLeaseLost || workflowServerCompleted || workflowCancelled(),
                () => {
                  void persistRunUpdate([{
                    node_id: action.nodeId,
                    action: action.action,
                    status: "running",
                    phase: "waiting_capacity",
                  }]).catch(() => undefined);
                },
              );
              if (!capacityReady) {
                if (workflowServerCompleted) {
                  return completedServerActionOutcome(action, retryCount);
                }
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

            if (workflowServerCompleted) {
              return completedServerActionOutcome(action, retryCount);
            }

            if (action.action === "generate_html") {
              if (!projectId || !options.canvasId) return {action,failed:"HTML generation requires an active project and canvas"};
              markNodeActionRunning(action.nodeId, action.action);
              try {
                const output = await executeWorkflowHtmlNode(action.nodeId, projectId, options.canvasId);
                return {action,failed:null,output:{...output},retryCount};
              } catch (error) {
                // HTML persistence can have succeeded despite a lost response;
                // leave retries to the idempotent Artifact runtime, never replay
                // this entire command batch automatically.
                return {action,failed:errorMessage(error),retryCount};
              } finally {
                clearNodeActionRunning(action.nodeId, action.action);
              }
            }

            try {
              if (action.action === "generate_video") {
                const target = nodeById(action.nodeId);
                if (target && isFmvVideoNode(target, useCanvasStore.getState().edges) &&
                    (target.data.continuityMode === "auto" || target.data.continuityMode === "independent")) {
                  await ensureVideoContinuity(action.nodeId, projectId);
                } else {
                  await ensureVideoContinuityTailFrames(action, projectId);
                }
              }
            } catch (error) {
              return { action, failed: errorMessage(error), retryCount };
            }

            if (action.action === "generate_audio" && !hydrateWorkflowAudioInput(action.nodeId)) {
              return {
                action,
          failed: "旁白节点缺少上游生成的文本，已停止提交 TTS 请求；请先完成剧本/Beat 文本生成后重试。", // i18n-exempt -- workflow error payload
                retryCount,
              };
            }

            // Tail-frame capture and input hydration await, and the page may have
            // been frozen past the lease meanwhile. Wait for a server-confirmed
            // status (queued behind any in-flight heartbeat) before dispatch; a
            // failed confirmation is not a confirmation, so it blocks dispatch too.
            await confirmWorkflowRunActive();
            if (workflowServerCompleted) {
              return completedServerActionOutcome(action, retryCount);
            }
            if (workflowLeaseLost || workflowPersistenceError || workflowCancelled()) {
              return {
                action,
                failed: workflowCancelled()
                  ? WORKFLOW_STOPPED_MESSAGE
                  : workflowPersistenceError ?? WORKFLOW_LEASE_LOST_MESSAGE,
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
            let actionResult = firstSignal.kind === "result"
              ? firstSignal.actionResult
              : await Promise.race([
                  waiting,
                  ...(singleGenerationSubmission ? [singleGenerationSubmission] : []),
                  ...(changedGeneratedResult ? [changedGeneratedResult] : []),
                ]);
            if (actionResult.status === "error" && workflowCancelled()) {
              const completedOutput = generatedResultOutputFromNode(
                action.nodeId,
                action.action,
              );
              actionResult = completedOutput &&
                JSON.stringify(completedOutput) !== initialGeneratedResultToken
                ? {
                    requestId,
                    nodeId: action.nodeId,
                    action: action.action,
                    status: "success" as const,
                    output: completedOutput,
                  }
                : {
                    requestId,
                    nodeId: action.nodeId,
                    action: action.action,
                    status: "error" as const,
                    error: WORKFLOW_STOPPED_MESSAGE,
                  };
            }
            actionSettled = true;
            void taskReferencePersistence;
            clearPendingNodeAction(requestId);
            await persistRunUpdate([{
              node_id: action.nodeId,
              action: action.action,
              status: "running",
              phase: "syncing_result",
              ...workflowTaskReference(actionResult.output),
            }]);
            await requestAnimationFrameOrTimeout();
            const actionOpenedUserUi =
              isRecord(actionResult.output) &&
              (actionResult.output.openedUiAction === true ||
                actionResult.output.requires_user_action === true);
            const actionWasSkipped =
              isRecord(actionResult.output) && actionResult.output.skipped === true;
            const hasRequiredOutput =
              actionResult.status === "error" || actionOpenedUserUi || actionWasSkipped
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

            const rawFailed = actionResult.status === "error"
              ? actionResult.error || "节点动作执行失败"
              : outputIssue
                ? outputIssue
              : !actionOpenedUserUi && !actionWasSkipped && !hasRequiredOutput
                ? nodeGenerationError(action.nodeId) ??
                  `节点动作完成但未产出 ${mediaRequirementLabel(action.action)}。`
                : null;
            const failed = rawFailed && isRecipeAttemptEndedError(rawFailed)
              ? recipeAttemptEndedMessage(rawFailed)
              : rawFailed;

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
        if (!("pending" in settled && settled.pending)) {
          await persistRunUpdate([{
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
        }
        return settled;
      }));

      for (const settled of levelResults) {
        const { action, failed, output } = settled;
        if ("pending" in settled && settled.pending) {
          result.commandResults.push({
            commandIndex: action.commandIndex,
            type: "run_node_action",
            status: "pending",
            label: `${action.label}（${i18next.t("freezone.chat.workflowOutputSyncPendingLabel", {
              defaultValue: "产物待同步",
            })}）`,
            nodeId: action.nodeId,
            action: action.action,
            output: { pending: true, reason: "workflow_result_sync_pending" },
          });
          continue;
        }
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
        if (action.action === "generate_image") completedImageNodeIds.add(action.nodeId);
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
      // The image batch ends before story video generation. Connect only real
      // finished frames, then rebuild prompt references from the live edge order.
      syncCompletedStoryFrames(completedImageNodeIds, result);
      stopWorkflowHeartbeat();
      await workflowHeartbeatQueue;
      await persistRunUpdate(
        [],
        runCancelled ? "cancelled" : runFailed || blockedNodeIds.size > 0 ? "failed" : "completed",
      );
      if (workflowServerReconciliationPending) {
        for (const step of result.commandResults) {
          if (step.type !== "run_node_action" || step.status !== "success") continue;
          if (!pendingActions.some((action) => action.nodeId === step.nodeId && action.action === step.action)) continue;
          step.status = "pending";
          step.output = { pending: true, reason: "workflow_server_reconciliation_pending" };
          result.openedUiActions = Math.max(0, result.openedUiActions - 1);
        }
      }
    } catch (error) {
      if (!workflowPersistenceError) throw error;
      runFailed = true;
      if (!result.errors.includes(workflowPersistenceError)) {
        result.errors.push(workflowPersistenceError);
      }
      for (const action of pendingActions) {
        const key = `${action.nodeId}:${action.action}`;
        if (settledActionKeys.has(key)) continue;
        result.commandResults.push({
          commandIndex: action.commandIndex,
          type: "run_node_action",
          status: "error",
          label: action.label,
          nodeId: action.nodeId,
          action: action.action,
          error: workflowPersistenceError,
        });
      }
    } finally {
      if (typeof window !== "undefined") {
        window.removeEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, handleWorkflowActivity);
      }
      for (const action of pendingActions) clearWorkflowProductOperation(action.nodeId);
      stopWorkflowHeartbeat();
    }
  };
  try {
    await enqueueCanvasNodeActions(options.canvasId, execute);
  } finally {
    if (hasWorkflowRun) activeOrQueuedWorkflowRunKeys.delete(workflowRunKey);
  }
}

// Stop on the first capture failure so dependent actions are not executed.
async function executePendingVideoFrameCaptures(
  pendingCaptures: PendingVideoFrameCapture[],
  result: CanvasChatCommandApplyResult,
  options: ApplyCanvasChatCommandsOptions,
): Promise<boolean> {
  for (const capture of pendingCaptures) {
    const mode = capture.action === "capture_video_first_frame" ? "first" : "last";
    const frameName = mode === "first" ? i18next.t('canvas.story.messages.firstFrame') : i18next.t('canvas.story.messages.lastFrame');
    const label = i18next.t('canvas.story.messages.captureFrame', { frameName });
    const source = nodeById(capture.nodeId);
    const data = source?.data as JsonRecord | undefined;
    const videoUrl = nonEmptyString(data?.videoUrl);
    try {
      if (!videoUrl) throw new Error(i18next.t('canvas.story.messages.sourceVideoMissing', { frameName }));
      const seekSec = resolveCaptureSeekSec(mode, {
        fallbackDurationSec: isFiniteNumber(data?.durationMs) ? data.durationMs / 1000 : null,
      });
      const captured = await captureVideoFrameToNode(capture.nodeId, {
        videoUrl,
        seekSec,
        projectId: options.projectId,
        displayName: i18next.t('canvas.story.messages.videoFrame', { frameName }),
      });
      if (!captured.nodeId) throw new Error(captured.error ?? i18next.t('canvas.story.messages.captureFailed', { frameName }));
      const provenance = {
        sourceVideoNodeId: capture.nodeId,
        sourceVideoUrl: videoUrl,
        sourceMediaVersion: isRecord(data?.storyMedia) ? data.storyMedia.version ?? null : null,
        sourceTaskJobId: data?.generationTaskJobId ?? null,
        captureMode: mode,
        seekSec,
        capturedAt: new Date().toISOString(),
      };
      useCanvasStore.getState().updateNodeData(captured.nodeId, { videoFrameSource: provenance });
      result.createdNodeIds.push(captured.nodeId);
      result.applied += 1;
      result.commandResults.push({
        commandIndex: capture.commandIndex,
        type: "run_node_action",
        status: "success",
        label,
        nodeId: capture.nodeId,
        action: capture.action,
        createdNodeId: captured.nodeId,
        output: { imageUrl: nodeById(captured.nodeId)?.data.imageUrl, ...provenance },
      });
    } catch (error) {
      const message = errorMessage(error);
      result.errors.push(message);
      result.commandResults.push({
        commandIndex: capture.commandIndex,
        type: "run_node_action",
        status: "error",
        label,
        nodeId: capture.nodeId,
        action: capture.action,
        error: message,
      });
      return false;
    }
  }
  return true;
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
  return canvasCommandLabel(command, browserCommandEnvironment.translate);
}

function selectAndFocusNode(nodeId: string): void {
  selectAndFocusNodeIn(useCanvasStore, nodeId);
}

/** Normalizes against the open canvas unless the caller names the existing node ids. */
export function normalizeCanvasChatCommandEnvelopesForValidation(
  envelopes: CanvasChatCommandEnvelope[],
  initialNodeIds?: Iterable<string>,
): CanvasChatCommandEnvelope[] {
  return normalizeCanvasCommandEnvelopes(
    envelopes,
    initialNodeIds ?? useCanvasStore.getState().nodes.map((node) => node.id),
  );
}

const browserCommandEnvironment: CanvasCommandEnvironment = {
  translate: (key, options) => i18next.t(key, options),
  validate: (envelopes, nodes, edges) => validateCanvasChatCommandEnvelopes(envelopes, nodes, edges, browserNodeDataDefaults),
  afterNodesMeasured: (callback) => {
    if (typeof window === "undefined") return;
    const schedule = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (frame: FrameRequestCallback) => window.setTimeout(frame, 16);
    schedule(() => {
      schedule(() => {
        callback();
      });
    });
  },
  removeProjection: (projectionKey) => {
    canvasEventBus.publish("freezone/projection-remove", { projectionKey });
  },
  landSceneEdit: (nodeId, nodeData, sceneEdit) => landNodeAgentSceneEdit(nodeId, nodeData, sceneEdit),
  onNodeDataUpdated: (nodeId, changedData) => {
    invalidateWorkflowResultsAfterNodeUpdate(useCanvasStore, nodeId, changedData, Date.now, browserNodeDataDefaults);
  },
};

/**
 * Generation, artifact and UI commands for the open canvas. Node actions,
 * frame captures and projections queue up per call and run in `finish`, after
 * every structural command of the batch has landed.
 */
function browserCommandHandlers(
  options: ApplyCanvasChatCommandsOptions & { queueNodeActions: boolean },
): CanvasCommandHandlers {
  const pendingNodeActions: PendingNodeAction[] = [];
  const pendingVideoFrameCaptures: PendingVideoFrameCapture[] = [];
  const pendingMainlineProjections: PendingMainlineProjection[] = [];
  const queuedNodeActionKeys = new Set<string>();
  const handlers: CanvasCommandHandlers = {
    *html_artifact(command, { envelope, commandIndex: currentCommandIndex, result, clientIdMap }) {
      if (!options.queueNodeActions) throw new Error("HTML artifacts require the authenticated async executor");
      const projectId = options.projectId;
      if (!projectId || (envelope.project_id && envelope.project_id !== projectId) || !options.canvasId || (envelope.canvas_id && envelope.canvas_id !== options.canvasId)) throw new Error("HTML artifact project/canvas scope does not match the active canvas");
      // Pause the command loop until persistence and attachment finish so
      // later commands can resolve this create's alias in original order.
      yield executeHtmlArtifactCommand({
        ...command,
        reference_node_ids: command.reference_node_ids?.map((id) => resolveNodeId(id, clientIdMap)),
      }, projectId, options.canvasId).then((saved) => {
        if (saved.output.warnings) result.errors.push(...saved.output.warnings);
        result.applied += 1;
        if (saved.createdNodeId) {
          result.createdNodeIds.push(saved.createdNodeId);
        }
        if (command.client_id && saved.nodeId) clientIdMap.set(command.client_id, saved.nodeId);
        result.commandResults.push({commandIndex:currentCommandIndex,type:'html_artifact',status:'success',label:commandLabel(command),...saved});
      });
    },
    *run_node_action(command, { commandIndex: currentCommandIndex, result, clientIdMap }) {
      const targetId = resolveNodeId(command.node_id, clientIdMap);
      assertBrowserNodeActionAvailable(targetId, command.action);
      if (command.action === "capture_video_last_frame" || command.action === "capture_video_first_frame") {
        if (!options.queueNodeActions) throw new Error("截取视频帧需要异步执行入口。");
        pendingVideoFrameCaptures.push({ nodeId: targetId, commandIndex: currentCommandIndex, action: command.action });
        return;
      }
      const targetNode = nodeById(targetId);
      if (
        targetNode?.type === CANVAS_NODE_TYPES.htmlArtifact &&
        (command.action === "update_source" || command.action === "restore" || command.action === "select_version")
      ) {
        if (!options.queueNodeActions || !options.projectId || !options.canvasId) {
          throw new Error("HTML source actions require the authenticated async executor");
        }
        yield executeHtmlNodeWriteAction({
          projectId: options.projectId,
          canvasId: options.canvasId,
          node: targetNode,
          action: command.action,
          parameters: command.parameters,
        }).then((saved) => {
          if (saved.output.warnings) result.errors.push(...saved.output.warnings);
          result.applied += 1;
          result.commandResults.push({
            commandIndex: currentCommandIndex,
            type: command.type,
            status: "success",
            label: commandLabel(command),
            nodeId: targetId,
            action: command.action,
            output: saved.output,
          });
        });
        return;
      }
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
        return;
      }
      const queuedActions = options.queueNodeActions
        ? directNodeActionQueue(
          useCanvasStore, targetId, command.action, currentCommandIndex,
          browserActionPlanOptions(), command.parameters,
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
          assertBrowserNodeActionAvailable(queuedAction.nodeId, queuedAction.action);
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
    },
    *open_mainline_projection(command, { envelope, commandIndex: currentCommandIndex }) {
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
    },
    *run_workflow(command, { commandIndex: currentCommandIndex, result, clientIdMap }) {
      const resolvedCommand: Extract<CanvasChatCommand, { type: "run_workflow" }> = {
        ...command,
        node_ids: command.node_ids?.map((nodeId) => resolveNodeId(nodeId, clientIdMap)),
      };
      const { allActions, actions, alreadyCompleted } = discoverWorkflowNodeActions(
        useCanvasStore, resolvedCommand, currentCommandIndex, browserActionPlanOptions(),
      );
      if (allActions.length === 0) throw new Error("工作流中没有可执行的生成节点。");
      if (alreadyCompleted) {
        syncCompletedStoryFrames(
          allActions.filter((action) => action.action === "generate_image" &&
            hasGeneratedResult(useCanvasStore, action.nodeId, action.action)).map((action) => action.nodeId),
          result,
        );
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
        return;
      }
      if (options.queueNodeActions) {
        for (const action of actions) {
          const actionKey = `${action.nodeId}:${action.action}`;
          if (queuedNodeActionKeys.has(actionKey)) continue;
          assertBrowserNodeActionAvailable(action.nodeId, action.action);
          queuedNodeActionKeys.add(actionKey);
          pendingNodeActions.push(action);
        }
      } else {
        const { ordered, cycleError } = orderedNodeActionsByCanvasEdges(useCanvasStore, actions);
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
    },
  };
  if (options.queueNodeActions) {
    handlers.finish = async (result, clientIdMap) => {
      if (!(await executePendingVideoFrameCaptures(pendingVideoFrameCaptures, result, options))) return;
      await executePendingMainlineProjections(pendingMainlineProjections, result);
      await executeQueuedNodeActions(pendingNodeActions, result, options, clientIdMap);
    };
  }
  return handlers;
}

export function applyCanvasChatCommands(envelopes: CanvasChatCommandEnvelope[]): CanvasChatCommandApplyResult {
  return applyCanvasCommandsNow(
    useCanvasStore,
    browserCommandEnvironment,
    envelopes,
    browserCommandHandlers({ queueNodeActions: false }),
  );
}

export function applyCanvasChatCommandsAsync(
  envelopes: CanvasChatCommandEnvelope[],
  options: ApplyCanvasChatCommandsOptions = {},
): Promise<CanvasChatCommandApplyResult> {
  return applyCanvasCommandsAsync(
    useCanvasStore,
    browserCommandEnvironment,
    envelopes,
    browserCommandHandlers({ ...options, queueNodeActions: true }),
  );
}
