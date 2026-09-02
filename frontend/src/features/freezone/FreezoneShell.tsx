// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Clapperboard,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Canvas } from "@/features/canvas/Canvas";
import { NodeReplaceDragPreview } from "@/features/canvas/ui/NodeReplaceDragPreview";
import { AssetBoardView } from "@/features/canvas/ui/asset-board/AssetBoardView";
import {
  listCharacters,
  listFreezoneProjectAssets,
  type FreezoneProjectAsset,
  type SupertaleProjectSummary,
} from "@/api/projects";
import {
  buildProjectionFromPreset,
  getProjectionStatuses,
  type FreezonePresetCanvasRequest,
} from "@/api/canvas";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { currentCanvasParam } from "@/lib/app-router";
import { rememberLastCanvas, writeUrl } from "@/lib/url-params";
import { cn } from "@/lib/utils";
import { surfaceAccess, useProductSurfaces } from "@/lib/queries/product-surfaces";
import { api } from "@/lib/api";
import {
  SUPERCHAT_CANVAS_COMMAND_EVENT,
  SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT,
} from "@/features/superchat/use-superchat";
import { mcpDirectCanvasApplyEnabled } from "@/lib/runtime-config";
import { SuperChatPanel } from "@/features/superchat/superchat-panel";
import type { ChatAttachment } from "@/features/superchat/types";
import { CommitDialog } from "./commit/CommitDialog";
import { promoteToAsset } from "./commit/promoteToAsset";
import { commitDirectorRenderFromCanvasSource } from "./commit/directorRenderCommit";
import {
  commitSceneDirectorWorldFromCanvasNode,
  hasDirectorWorldSceneState,
  isDirectorWorldSourceSlotTarget,
} from "./commit/sceneDirectorWorldCommit";
import { nodeDataAfterCommittedSlot } from "./commit/committedNodePatch";
import { isCommitCandidateData } from "./commit/commitEligibility";
import { CreateIdentityDialog } from "@/pipeline-import/CreateIdentityDialog";
import { CompareDialog } from "@/pipeline-import/CompareDialog";
import { MaskEditor } from "@/pipeline-import/MaskEditor";
import { AssetLibraryPanel } from "./AssetLibraryPanel";
import { CanvasDebugPanel } from "./CanvasDebugPanel";
import {
  FREEZONE_DOCK_TRANSITION_VAR,
  FREEZONE_DOCK_WIDTH_VAR,
  freezoneDockOffsetCss,
} from "./dockOffset";
import type { PushResult, PushTarget, PushTargetKind } from "@/api/push";
import { coerceSlotTarget } from "@/features/canvas/domain/mainlineNodeTypes";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { saveOpenDirectorWorldScene } from "@/features/canvas/domain/directorWorldSceneSaveRegistry";
import {
  assetToPushTarget,
  inferDefaultTarget,
  isPlyOrGlbPushTargetKind,
  isScenePushTargetKind,
} from "@/features/freezone/commit/pushTarget";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  deriveNodeDropInfo,
  modelSourceUrlFromNodeData,
  type DropMediaType,
} from "@/stores/assetDropStore";
import { withImageCacheBust } from "@/features/canvas/application/imageData";
import { queryKeys } from "@/lib/query-keys";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { useCanvasSync, type CanvasSyncStatus, type ConflictSnapshot } from "./useCanvasSync";
import { prefetchFreezoneImageModels } from "@/features/canvas/hooks/useFreezoneImageModels";
import { prefetchFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { prefetchFreezoneCameraOptions } from "@/features/canvas/hooks/useFreezoneCameraOptions";
import { prefetchFreezoneStyleTemplates } from "@/features/canvas/hooks/useFreezoneStyleTemplates";
import { prefetchFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { claimExternalCanvasCommand } from "./externalCanvasCommandDedupe";
import {
  normalizePresetProjectionRequest,
  projectionMetadataWithRequest,
  projectionTargetForCanvasPanel,
} from "@/features/freezone/projections";
import {
  clearCanvasProjectionStatuses,
  markCanvasProjectionFresh,
  setCanvasProjectionStatuses,
} from "@/features/freezone/projectionStatusStore";
import {
  consumeQueuedLocalFreezoneProjections,
  queueLocalFreezoneProjection,
  removeLocalFreezoneProjection,
} from "@/features/freezone/canvasSyncRuntime";
import {
  useFreezoneViewMode,
  type FreezoneViewMode,
} from "@/features/freezone/useFreezoneViewMode";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  canvasCommandEnvelopeMatchesCanvas,
  emitCanvasCommandApproval,
  extractCanvasChatCommandEnvelopes,
  FREEZONE_CANVAS_COMMAND_RESULT_EVENT,
  normalizeCanvasChatCommandEnvelopesForValidation,
  type CanvasChatCommandApplyResult,
} from "@/features/freezone/canvasChatCommands";
import {
  addFreezoneCanvasAgent,
  DEFAULT_FREEZONE_AGENT_ID,
  loadFreezoneCanvasAgentsWithSource,
  mergeFreezoneCanvasAgentsFromServer,
  readFreezoneAgentIdFromUrl,
  selectFreezoneCanvasAgent,
  shouldConnectFreezoneCanvasAgent,
  shouldKeepFreezoneChatPanelMounted,
  updateFreezoneCanvasAgentFromUserMessage,
  type FreezoneCanvasAgent,
  type FreezoneCanvasAgentState,
} from "@/features/freezone/canvasAgents";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import { reportCanvasCommandToolResult } from "@/features/freezone/canvasCommandToolResult";
import {
  emitCanvasContextActivity,
  reportCanvasContextToolResult,
} from "@/features/freezone/canvasContextToolResult";
import {
  buildCanvasNodeReferenceAttachment,
  buildCanvasContextRequestResponses,
  extractCanvasContextRequestEnvelopes,
} from "@/features/freezone/chatNodeReferences";
import {
  buildCanvasOntologyContext,
  type CanvasOntologyContext,
} from "@/features/canvas/ontology/canvasOntology";
import type { ServerFrame } from "@/features/superchat/types";
import { initializeEmptyFreezoneAgentChat } from "@/features/superchat/freezoneChatScopeCache";
import { WorkflowRunRecoveryBar } from "./WorkflowRunRecoveryBar";

export { hasLegacyPresetCanvasMetadata } from "@/features/freezone/projections";

interface FreezoneShellProps {
  project: SupertaleProjectSummary;
  canvasId: string;
  /**
   * 画布是否是当前正在看的页面。顶栏切到「虾集」时宿主不再卸载本组件，只把
   * active 置 false（见 FreezoneCanvasHost）——保活换来的是切换不掉帧，代价是
   * 得手动交出那些「只有前台该做」的事：全局快捷键（透传成 Canvas 的
   * suspended）和两条轮询。默认 true，让直接挂载 FreezoneShell 的调用方
   * （测试、未来的独立入口）保持原来的行为。
   */
  active?: boolean;
}

type CurrentCanvasSelectionItem = {
  nodeId: string;
  nodeType: string | null;
  label: string;
};

const PROJECTION_STATUS_REFRESH_MS = 30_000;
const FREEZONE_CHAT_WIDTH_STORAGE_KEY = "freezone.chatDock.chatWidth";
const FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY = "freezone.chatDock.agentHistoryWidth";
const FREEZONE_CHAT_WIDTH_DEFAULT = 540;
const FREEZONE_CHAT_WIDTH_MIN = 420;
const FREEZONE_CHAT_WIDTH_MAX = 760;
const FREEZONE_AGENT_HISTORY_WIDTH_DEFAULT = 220;
const FREEZONE_AGENT_HISTORY_WIDTH_MIN = 180;
const FREEZONE_AGENT_HISTORY_WIDTH_MAX = 360;
// Keep the multi-session implementation available for a future product mode,
// but Freezone currently defines one Agent session per canvas.
const FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED = false;
/**
 * 抽屉最多能挤到只剩这么宽的左侧内容。
 * - 工作流（浮层）：画布可以任意窄，360 只是别让它彻底消失。
 * - 故事板（挤占）：三栏各有 200px 下限 + 两条 12px 分隔 + 容器 px-4，
 *   低于 680 三栏就会被 min-width 顶出容器、右栏被裁掉。
 */
const FREEZONE_CHAT_MIN_CONTENT_WIDTH = 360;
const FREEZONE_CHAT_MIN_BOARD_CONTENT_WIDTH = 680;
/**
 * 抽屉内两栏的宽度走 CSS 变量（挂在 <aside> 上，两栏继承着读）。
 * 这样拖拽时只需要改外壳这一个元素的 style，就能同时驱动外壳与内部两栏，
 * 全程不碰 React —— 见 startPaneResize 里的 paint()。
 */
const CHAT_PANE_WIDTH_VAR = "--freezone-chat-pane-width";
const AGENT_HISTORY_PANE_WIDTH_VAR = "--freezone-agent-history-pane-width";
const EXTERNAL_CANVAS_COMMAND_POLL_MS = 800;
const EXTERNAL_CANVAS_REVISION_POLL_MS = 2_000;

/**
 * 左上角「工作流 / 故事板」切换开关的两颗键。
 * 只画图标，文案走 hover 提示 + aria-label（用户要求：文字胶囊太占画布）。
 * 顺序即视觉顺序——滑块位移按下标算（第 2 颗 translate-x-7）。
 */
const FREEZONE_VIEW_MODE_TABS: ReadonlyArray<{
  mode: FreezoneViewMode;
  icon: LucideIcon;
  label: string;
}> = [
  { mode: "workflow", icon: Workflow, label: "工作流" },
  { mode: "board", icon: Clapperboard, label: "故事板" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadStoredPanelWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const parsed = Number(window.localStorage.getItem(key));
  return Number.isFinite(parsed) ? clampNumber(parsed, min, max) : fallback;
}

function storePanelWidth(key: string, value: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(Math.round(value)));
}

/**
 * 虾画 agent 的开合状态：持久化到 localStorage，刷新/重进画布后恢复，避免工作流中
 * 一刷新就丢掉已打开的对话。key 同样避开 `supertale-` 前缀（会被 reset-region-state
 * 的清扫误删）——开合只是 UI 偏好，跨区域保留没问题。
 */
const CHAT_OPEN_STORAGE_KEY = "st.freezone.chatOpen";

function loadChatOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeChatOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // storage full / unavailable — 开合状态就不持久化
  }
}

async function listServerFreezoneCanvasAgents(
  projectId: string,
  canvasId: string,
): Promise<FreezoneCanvasAgent[]> {
  const response = await api.post("api/v1/chat/freezone-canvas-agents", {
    json: { project_id: projectId, canvas_id: canvasId },
  }).json<{
    ok?: boolean;
    data?: { agents?: FreezoneCanvasAgent[] };
  }>();
  return Array.isArray(response.data?.agents) ? response.data.agents : [];
}

async function listPendingCanvasCommandFrames({
  projectId,
  canvasId,
  agentIds,
  seenKeys,
}: {
  projectId: string;
  canvasId: string;
  agentIds: string[];
  seenKeys: string[];
}): Promise<ServerFrame[]> {
  const response = await api.post("api/v1/chat/pending-canvas-commands", {
    json: {
      project_id: projectId,
      canvas_id: canvasId,
      agent_ids: agentIds,
      seen_keys: seenKeys,
    },
  }).json<{
    ok?: boolean;
    data?: { frames?: ServerFrame[] };
  }>();
  return Array.isArray(response.data?.frames) ? response.data.frames : [];
}

function pushJsonTextCanvasCommandCandidate(candidates: unknown[], text: unknown): void {
  if (typeof text !== "string" || !text.trim()) return;
  try {
    candidates.push(JSON.parse(text));
  } catch {
    // Non-JSON text can appear in tool display messages.
  }
}

function pushCanvasCommandCandidate(candidates: unknown[], value: unknown): void {
  if (!isRecord(value)) return;
  candidates.push(value);
  if (Array.isArray(value.commands) && value.schema_version !== CANVAS_CHAT_COMMANDS_SCHEMA_VERSION) {
    candidates.push({
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      canvas_id: typeof value.canvas_id === "string" ? value.canvas_id : undefined,
      commands: value.commands,
    });
  }
  if (value.envelope) pushCanvasCommandCandidate(candidates, value.envelope);
  if (value.rawInput) pushCanvasCommandCandidate(candidates, value.rawInput);
  if (value.raw_input) pushCanvasCommandCandidate(candidates, value.raw_input);
  pushJsonTextCanvasCommandCandidate(candidates, value.text);
}

function canvasCommandCandidatesFromFrame(frame: ServerFrame): unknown[] {
  const candidates: unknown[] = [];
  const record = frame as Record<string, unknown>;
  pushCanvasCommandCandidate(candidates, record.envelope);
  pushCanvasCommandCandidate(candidates, record.input);
  pushCanvasCommandCandidate(candidates, record.raw);
  pushJsonTextCanvasCommandCandidate(candidates, record.text);
  return candidates;
}

function canvasContextRequestCandidatesFromDetail(detail: Record<string, unknown>): unknown[] {
  return [
    detail.envelope,
    detail.request,
    detail.requests,
    detail.input,
    detail.raw,
    detail,
  ];
}

async function loadMainlineProjectionAssets(project: string): Promise<FreezoneProjectAsset[]> {
  const [assets, characters] = await Promise.all([
    listFreezoneProjectAssets(project),
    listCharacters(project),
  ]);
  const characterAssets: FreezoneProjectAsset[] = characters
    .map((character): FreezoneProjectAsset | null => {
      const name = typeof character.name === "string" ? character.name.trim() : "";
      if (!name) return null;
      const displayName =
        typeof character.display_name === "string" && character.display_name.trim()
          ? character.display_name.trim()
          : name;
      return {
        id: `character:${name}`,
        tab: "characters",
        kind: "character",
        role: "character_profile",
        label: displayName,
        sublabel: typeof character.role === "string" && character.role.trim() ? character.role.trim() : undefined,
        url: typeof character.portrait_url === "string" && character.portrait_url.trim()
          ? character.portrait_url.trim()
          : null,
        exists: true,
        media_type: character.portrait_url ? "image" : "text",
        meta: { character: name },
      };
    })
    .filter((asset): asset is FreezoneProjectAsset => Boolean(asset));
  return [...assets, ...characterAssets];
}

function canvasCommandValidationFailureResult(errors: string[]): CanvasChatCommandApplyResult {
  return {
    applied: 0,
    openedUiActions: 0,
    createdNodeIds: [],
    errors,
    commandResults: [
      {
        commandIndex: -1,
        type: "validate",
        status: "error",
        label: "校验画布命令",
        error: errors.join("; "),
      },
    ],
  };
}

function persistCanvasCommandResult({
  projectId,
  canvasId,
  turnId,
  envelopes,
  result,
  anchorTextPrefix,
  receivedAt,
  bridgeKey,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  envelopes: ReturnType<typeof extractCanvasChatCommandEnvelopes>;
  result: CanvasChatCommandApplyResult;
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  bridgeKey?: string | null;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_command_result.v1",
        type: "canvas_command_result",
        canvas_id: canvasId,
        bridge_key: bridgeKey ?? null,
        envelopes,
        result,
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command result", {
      canvasId,
      turnId,
      error,
    });
  });
}

function persistCanvasCommandApproval({
  projectId,
  canvasId,
  turnId,
  envelopes,
  anchorTextPrefix,
  receivedAt,
  externalMcpCommand,
  bridgeKey,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  envelopes: ReturnType<typeof extractCanvasChatCommandEnvelopes>;
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  externalMcpCommand?: boolean;
  bridgeKey?: string | null;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_command_approval.v1",
        type: "canvas_command_approval",
        canvas_id: canvasId,
        bridge_key: bridgeKey ?? null,
        envelopes,
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
        ...(externalMcpCommand === true ? { external_mcp_command: true } : {}),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command approval", {
      canvasId,
      turnId,
      error,
    });
  });
}

function persistCanvasCommandValidationActivity({
  projectId,
  canvasId,
  turnId,
  bridgeKey,
  ok,
  errors,
  anchorTextPrefix,
  receivedAt,
  externalMcpCommand,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  bridgeKey: string;
  ok: boolean;
  errors: string[];
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  externalMcpCommand?: boolean;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_context_result.v1",
        type: "canvas_context_result",
        canvas_id: canvasId,
        bridge_key: bridgeKey,
        result: {
          ok,
          responses: [{ type: "validate_canvas_commands" }],
          errors,
        },
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
        ...(externalMcpCommand === true ? { external_mcp_command: true } : {}),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command validation activity", {
      canvasId,
      turnId,
      error,
    });
  });
}

/**
 * Register every trigger that refreshes projection status and tear them all
 * down synchronously when the shared API layer confirms session expiry.
 */
export function startProjectionStatusRefresh(
  refresh: () => void,
  onSessionExpired: () => void,
): () => void {
  let stopped = false;
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") refresh();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    window.clearInterval(timer);
  };
  const handleSessionExpired = () => {
    stop();
    onSessionExpired();
  };

  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  const timer = window.setInterval(refresh, PROJECTION_STATUS_REFRESH_MS);
  return stop;
}

function renderCommitSuccessMessage(target: PushTarget, result: PushResult): string {
  if (target.kind === "director_render") {
    return `已提交导演合成资产：${result.target_path}（含纯背景和元数据）`;
  }
  if (target.kind === "scene_director_world") {
    return `已提交导演世界：${result.target_path}`;
  }
  return `已提交到 ${result.target_path}`;
}

function sceneDirectorWorldDataForManifest(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId?: string,
): Record<string, unknown> | null {
  const manifestNodeData = nodeDataPatchAfterCommittedSourceSlot(nodeData, target, result, projectId);
  return hasDirectorWorldSceneState(manifestNodeData) ? manifestNodeData : null;
}

export function nodeDataPatchAfterCommittedSourceSlot(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId?: string,
): Record<string, unknown> | null {
  if (!isDirectorWorldSourceSlotTarget(target)) return null;
  return nodeDataAfterCommittedSlot(nodeData, target, result, projectId);
}

export function nodeDataPatchAfterCommittedTarget(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId?: string,
): Record<string, unknown> | null {
  if (isDirectorWorldSourceSlotTarget(target)) return null;
  return nodeDataAfterCommittedSlot(nodeData, target, result, projectId);
}

function latestCanvasNodeData(nodeId: string): Record<string, unknown> | null {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return node?.data && typeof node.data === "object"
    ? node.data as Record<string, unknown>
    : null;
}

export function resolveSubmitNodeData(
  latest: Record<string, unknown> | null | undefined,
  fallback: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return latest ?? fallback ?? null;
}

export function shouldRefreshCommittedTargetNodes(target: PushTarget): boolean {
  // scene_director_world is a structured manifest/state commit, not a media file
  // replacement. Refreshing canvas node URLs with its result corrupts the visual
  // node into a broken image/manifest preview.
  return target.kind !== "scene_director_world";
}

export function shouldClearProjectionStatuses({
  canvasId,
  hydratedCanvasId,
  projectionKeyCount,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
}): boolean {
  return hydratedCanvasId !== canvasId || projectionKeyCount === 0;
}

export function shouldFetchProjectionStatuses({
  canvasId,
  hydratedCanvasId,
  projectionKeyCount,
  revision,
  sessionExpired = false,
  syncStatus,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
  revision: number | null;
  sessionExpired?: boolean;
  syncStatus: CanvasSyncStatus;
}): boolean {
  if (sessionExpired) return false;
  if (shouldClearProjectionStatuses({ canvasId, hydratedCanvasId, projectionKeyCount })) {
    return false;
  }
  return syncStatus === "ready" && revision != null;
}

export function shouldSkipProjectionStatusRevision({
  canvasId,
  revision,
  refreshToken,
  lastChecked,
}: {
  canvasId: string;
  revision: number;
  refreshToken: number;
  lastChecked: { canvasId: string; revision: number; refreshToken: number } | null;
}): boolean {
  if (lastChecked?.canvasId !== canvasId) return false;
  return lastChecked.revision === revision && lastChecked.refreshToken === refreshToken;
}

function projectionKeysFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] {
  const projections = metadata?.projections;
  if (!projections || typeof projections !== "object") return [];
  return Object.keys(projections).filter((key) => key.trim());
}

export function requestFromProjectionMetadata(
  metadata: Record<string, unknown> | null | undefined,
  projectionKey: string,
): Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing" | "base_revision"> | null {
  const projections = metadata?.projections;
  if (!projections || typeof projections !== "object") return null;
  const projection = (projections as Record<string, unknown>)[projectionKey];
  if (!projection || typeof projection !== "object") return null;
  const projectionRecord = projection as Record<string, unknown>;
  const request = projectionRecord.request && typeof projectionRecord.request === "object"
    ? projectionRecord.request as Record<string, unknown>
    : fallbackProjectionRequest(projectionRecord, projectionKey);
  if (!request) return null;
  const scope = (request as { scope?: unknown }).scope;
  if (scope !== "episode" && scope !== "beat" && scope !== "asset" && scope !== "blank") {
    return null;
  }
  return normalizePresetProjectionRequest({
    scope,
    episode: typeof (request as { episode?: unknown }).episode === "number"
      ? (request as { episode: number }).episode
      : undefined,
    beat: typeof (request as { beat?: unknown }).beat === "number"
      ? (request as { beat: number }).beat
      : undefined,
    primary_slot: typeof (request as { primary_slot?: unknown }).primary_slot === "string"
      ? (request as { primary_slot: string }).primary_slot
      : undefined,
    asset_kind: typeof (request as { asset_kind?: unknown }).asset_kind === "string"
      ? (request as { asset_kind: string }).asset_kind
      : undefined,
    character: typeof (request as { character?: unknown }).character === "string"
      ? (request as { character: string }).character
      : undefined,
    identity_id: typeof (request as { identity_id?: unknown }).identity_id === "string"
      ? (request as { identity_id: string }).identity_id
      : undefined,
    asset_id: typeof (request as { asset_id?: unknown }).asset_id === "string"
      ? (request as { asset_id: string }).asset_id
      : undefined,
  });
}

function fallbackProjectionRequest(
  projection: Record<string, unknown>,
  projectionKey: string,
): Record<string, unknown> | null {
  const scope = typeof projection.scope === "string"
    ? projection.scope
    : scopeFromProjectionKey(projectionKey);
  if (scope === "beat") {
    const parsed = parseBeatProjectionKey(projectionKey);
    return {
      scope,
      episode: numberOrUndefined(projection.episode) ?? parsed?.episode,
      beat: numberOrUndefined(projection.beat) ?? parsed?.beat,
      primary_slot: typeof projection.primary_slot === "string"
        ? projection.primary_slot
        : "render",
    };
  }
  if (scope === "episode") {
    return {
      scope,
      episode: numberOrUndefined(projection.episode) ?? parseEpisodeProjectionKey(projectionKey),
    };
  }
  if (scope === "asset") {
    const parsed = parseAssetProjectionKey(projectionKey);
    return {
      scope,
      asset_kind: stringOrUndefined(projection.asset_kind) ?? parsed?.asset_kind,
      asset_id: stringOrUndefined(projection.asset_id) ?? parsed?.asset_id,
      character: stringOrUndefined(projection.character),
      identity_id: stringOrUndefined(projection.identity_id),
    };
  }
  if (scope === "blank") {
    return { scope };
  }
  return null;
}

function scopeFromProjectionKey(projectionKey: string): string | null {
  if (projectionKey.startsWith("beat:")) return "beat";
  if (projectionKey.startsWith("episode:")) return "episode";
  if (projectionKey.startsWith("asset:")) return "asset";
  if (projectionKey.startsWith("blank:")) return "blank";
  return null;
}

function parseBeatProjectionKey(projectionKey: string): { episode: number; beat: number } | null {
  const [, episodeRaw, beatRaw] = projectionKey.split(":");
  const episode = Number(episodeRaw);
  const beat = Number(beatRaw);
  if (!Number.isFinite(episode) || !Number.isFinite(beat)) return null;
  return { episode, beat };
}

function parseEpisodeProjectionKey(projectionKey: string): number | undefined {
  const [, episodeRaw] = projectionKey.split(":");
  const episode = Number(episodeRaw);
  return Number.isFinite(episode) ? episode : undefined;
}

function parseAssetProjectionKey(
  projectionKey: string,
): { asset_kind: string; asset_id: string } | null {
  const [, assetKind, ...assetParts] = projectionKey.split(":");
  const assetId = assetParts.join(":");
  if (!assetKind || !assetId) return null;
  return { asset_kind: assetKind, asset_id: assetId };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Mounts the shared xyflow canvas inside the SuperTale Beat Workbench shell.
 * Canvas switching lives inside the left AssetLibraryPanel (主线资产 / 画布 tabs).
 * Commit still lives on eligible canvas nodes. Sync status is
 * intentionally not shown — `useCanvasSync` still loads + persists via
 * /api/v1/projects/<project_id>/freezone/canvases and surfaces conflict /
 * error states via the overlays below; ready/saving states are silent.
 * The outer SPA sidebar already exposes project switching and the task center,
 * so this shell omits the back button, project picker, import/extract/
 * video-ref/3GS triggers, and the top-right Beat Workbench task entry.
 */
const canvasKey = (projectId: string, canvasId: string) => `${projectId}::${canvasId}`;
/** 上一次真正画出来的画布；跨挂载保留，用来判断重进时能否直接复用 store 里的内容。 */
let lastRenderedCanvasKey: string | null = null;

export function FreezoneShell({
  project,
  canvasId,
  active = true,
}: FreezoneShellProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectId = project.id;
  const [pushState, setPushState] = useState<PushPrompt | null>(null);
  const [comparePair, setComparePair] = useState<
    | {
        left: { url: string; label: string };
        right: { url: string; label: string };
      }
    | null
  >(null);
  const [createIdentitySource, setCreateIdentitySource] =
    useState<SelectedImageSummary | null>(null);
  const [maskTarget, setMaskTarget] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [assetLibraryReloadToken, setAssetLibraryReloadToken] = useState(0);
  const [assetPanelCollapsed, setAssetPanelCollapsed] = useState(true);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(loadChatOpen);
  const [pendingChatAttachments, setPendingChatAttachments] = useState<ChatAttachment[]>([]);
  const [pendingChatNodeMentions, setPendingChatNodeMentions] = useState<string[]>([]);
  const handlePendingChatAttachmentsConsumed = useCallback(() => {
    setPendingChatAttachments([]);
  }, []);
  const handlePendingChatNodeMentionsConsumed = useCallback(() => {
    setPendingChatNodeMentions([]);
  }, []);
  const productSurfaces = useProductSurfaces();
  const showChatDock = Boolean(
    surfaceAccess(productSurfaces.data, "freezone_assistant")?.available,
  );
  // Re-entrancy guard for in-flight projection sync/remove lives in the refs;
  // there is no UI bound to a syncing/removing value, so no state is kept.
  const syncingProjectionRef = useRef<string | null>(null);
  const removingProjectionRef = useRef<string | null>(null);
  const emittedExternalCanvasCommandKeysRef = useRef<Set<string>>(new Set());
  // 顶栏在「虾画 / 虾集」之间切换会整体卸载再挂载本组件，但画布数据留在全局 store 里。
  // 如果这里从 false 起步，回到虾画就会先把画面换成「正在加载画布…」，等 hydrate 回来
  // 才重新画出来 —— 看着就是卡。同一个画布重进时直接渲染 store 里的既有内容，
  // hydrate 期间只叠一层轻量 overlay。
  const [hasRenderedCanvas, setHasRenderedCanvas] = useState(
    () =>
      lastRenderedCanvasKey === canvasKey(projectId, canvasId) &&
      useCanvasStore.getState().nodes.length > 0,
  );
  const [projectionStatusRefreshToken, setProjectionStatusRefreshToken] = useState(0);
  const [projectionMonitoringExpired, setProjectionMonitoringExpired] = useState(false);
  const lastProjectionStatusRevisionRef = useRef<{
    canvasId: string;
    revision: number;
    refreshToken: number;
  } | null>(null);

  const [viewMode, setViewMode] = useFreezoneViewMode();
  // 懒挂载：首次切到故事板才 mount AssetBoardView，之后保活（visible 切 visibility）。
  const [boardMounted, setBoardMounted] = useState(viewMode === "board");
  const handleViewModeChange = useCallback(
    (mode: FreezoneViewMode) => {
      if (mode === "board") {
        setBoardMounted(true);
        // 进入故事板默认展开虾导，便于直接对着素材开聊。
        setChatOpen(true);
      }
      setViewMode(mode);
    },
    [setViewMode],
  );
  const handleLocateNode = useCallback(
    (nodeId: string) => {
      setViewMode("workflow");
      useCanvasStore.getState().requestFocusNode(nodeId);
    },
    [setViewMode],
  );

  const invalidateCommittedTargetQueries = useCallback((target: PushTarget) => {
    if (isDirectorWorldSourceSlotTarget(target) || target.kind === "scene_director_world") {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sceneDirectorStageManifest(projectId, target.scene_id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.scenes(projectId) });
      return;
    }
    if (isScenePushTargetKind(target.kind) && "scene_id" in target) {
      queryClient.invalidateQueries({ queryKey: queryKeys.scenes(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.scene(projectId, target.scene_id) });
    }
  }, [projectId, queryClient]);
  const sync = useCanvasSync(projectId, canvasId);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const canvasEdges = useCanvasStore((state) => state.edges);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const syncRetryRef = useRef(sync.retry);
  useEffect(() => {
    syncRetryRef.current = sync.retry;
  }, [sync.retry]);
  const visibleSelectedCanvasNodes = useMemo(() => {
    const selectedNodes = canvasNodes.filter((node) => node.selected);
    return selectedNodes.length > 0
      ? selectedNodes
      : selectedNodeId
        ? canvasNodes.filter((node) => node.id === selectedNodeId)
        : [];
  }, [canvasNodes, selectedNodeId]);
  const chatReferenceCanvasNodes = useMemo(() => {
    if (visibleSelectedCanvasNodes.length === 0) return [];
    const selectedIds = new Set(visibleSelectedCanvasNodes.map((node) => node.id));
    const expandedIds = new Set(selectedIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of canvasNodes) {
        if (!node.parentId || !expandedIds.has(node.parentId) || expandedIds.has(node.id)) continue;
        expandedIds.add(node.id);
        changed = true;
      }
    }
    return canvasNodes.filter((node) => expandedIds.has(node.id));
  }, [canvasNodes, visibleSelectedCanvasNodes]);
  const currentCanvasSelection = useMemo<CurrentCanvasSelectionItem[]>(
    () =>
      visibleSelectedCanvasNodes.map((node) => ({
        nodeId: node.id,
        nodeType: node.type ?? null,
        label: resolveNodeDisplayName(node.type, node.data),
      })),
    [visibleSelectedCanvasNodes],
  );
  const currentCanvasSelectionAttachment = useMemo(
    () =>
      buildCanvasNodeReferenceAttachment(
        projectId,
        canvasId,
        chatReferenceCanvasNodes,
        canvasEdges,
        canvasNodes,
        { displayNodes: visibleSelectedCanvasNodes },
      ),
    [canvasEdges, canvasId, canvasNodes, chatReferenceCanvasNodes, projectId, visibleSelectedCanvasNodes],
  );
  const attachCurrentSelectionToChat = useCallback(() => {
    if (!currentCanvasSelectionAttachment) return false;
    setPendingChatAttachments([currentCanvasSelectionAttachment]);
    return true;
  }, [currentCanvasSelectionAttachment]);
  const handleChatOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        attachCurrentSelectionToChat();
      }
      setChatOpen(nextOpen);
    },
    [attachCurrentSelectionToChat],
  );
  const currentCanvasOntologyContext = useMemo(
    () =>
      buildCanvasOntologyContext(canvasNodes, canvasEdges, {
        canvasId,
        selectedNodeIds: chatReferenceCanvasNodes.map((node) => node.id),
      }),
    [canvasEdges, canvasId, canvasNodes, chatReferenceCanvasNodes],
  );
  useEffect(() => {
    if (!chatOpen || !currentCanvasSelectionAttachment) return;
    setPendingChatAttachments([currentCanvasSelectionAttachment]);
  }, [chatOpen, currentCanvasSelectionAttachment]);
  // 开合状态落盘：刷新/重进画布后由 useState(loadChatOpen) 恢复。所有开关路径
  // （手动按钮、命令自动展开、空白点击）都经由 chatOpen，故一个 effect 全覆盖。
  useEffect(() => {
    storeChatOpen(chatOpen);
  }, [chatOpen]);

  useEffect(() => {
    if (!showChatDock) {
      setChatOpen(false);
    }
  }, [showChatDock]);

  const handleBlankPaneClick = useCallback(() => {
    setAssetPanelCollapsed(true);
    setDebugPanelOpen(false);
    // 点画布空白不再自动关闭虾画 agent：用户要求它只能靠面板右上角的关闭按钮
    // （onOpenChange(false)）手动关，避免工作流中误点空白就丢掉对话。
  }, []);

  useEffect(() => {
    prefetchFreezoneImageModels(projectId);
    prefetchFreezoneVideoModels(projectId);
    prefetchFreezoneCameraOptions(projectId);
    prefetchFreezoneStyleTemplates(projectId);
    prefetchFreezoneVideoCameraTemplates(projectId);
  }, [projectId]);

  // 依赖里带 active，是因为离开虾画时地址栏的 ?canvas= 会跟着路由一起没掉，而
  // 保活之后 canvasId / projectId 都是钉住不变的 —— 切回来这个 effect 不会重跑，
  // 结果就是屏幕上开着某张画布，地址栏却是光秃秃的 /freezone，复制出去的链接
  // 打不开这张画布。非激活时直接跳过：那会儿地址栏归虾集管。
  useEffect(() => {
    if (!active) return;
    rememberLastCanvas(projectId, canvasId);
    if (canvasId !== "default" && currentCanvasParam() !== canvasId) {
      writeUrl({ canvas: canvasId }, { replace: true, notify: false });
    }
  }, [active, canvasId, projectId]);

  useEffect(() => {
    if (sync.status === "ready" && sync.hydratedCanvasId === canvasId) {
      lastRenderedCanvasKey = canvasKey(projectId, canvasId);
      setHasRenderedCanvas(true);
    }
  }, [canvasId, projectId, sync.hydratedCanvasId, sync.status]);

  useEffect(() => {
    if (!mcpDirectCanvasApplyEnabled()) return;
    // 在虾集时不轮询：保活期间画布没人看，没必要为它占着请求配额。
    // `active` 在依赖里，切回虾画会重跑本 effect —— 末尾那次立即调用就顺带
    // 补上了「离开这段时间里画布有没有被别处改过」的新鲜度检查。以前靠整体
    // 重新挂载触发 hydrate 来保证这件事，保活之后这里是唯一的补偿点。
    if (!active) return;
    if (
      sync.status !== "ready" ||
      sync.hydratedCanvasId !== canvasId ||
      sync.revision == null
    ) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const pollRemoteRevision = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await api
          .get(
            `api/v1/projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/revision`,
          )
          .json<{ data?: { revision?: number } }>();
        const remoteRevision = response.data?.revision;
        if (
          !cancelled &&
          typeof remoteRevision === "number" &&
          sync.revision != null &&
          remoteRevision > sync.revision
        ) {
          syncRetryRef.current();
        }
      } catch {
        // Best effort: missing a poll is fine; the next tick or page refresh catches up.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(pollRemoteRevision, EXTERNAL_CANVAS_REVISION_POLL_MS);
    const handleFocus = () => {
      void pollRemoteRevision();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void pollRemoteRevision();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void pollRemoteRevision();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    active,
    canvasId,
    projectId,
    sync.hydratedCanvasId,
    sync.revision,
    sync.status,
  ]);

  const projectionKeys = useMemo(
    () => projectionKeysFromMetadata(sync.metadata),
    [sync.metadata],
  );
  useEffect(() => {
    // 同上：保活期间停掉 30s 一次的投影状态刷新。它只负责踩节拍（本身不发请求，
    // 是 bump token 让下面那个 effect 去拉），所以切回来的即时补拉由后面专门的
    // 「重新激活」effect 负责——这里重启定时器只保证之后的节拍继续。
    if (!active) return;
    if (projectionMonitoringExpired) return;
    if (!shouldFetchProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      revision: sync.revision,
      sessionExpired: projectionMonitoringExpired,
      syncStatus: sync.status,
    })) {
      return;
    }
    const bump = () => setProjectionStatusRefreshToken((value) => value + 1);
    return startProjectionStatusRefresh(bump, () => {
      setProjectionMonitoringExpired(true);
    });
  }, [
    active,
    canvasId,
    projectionMonitoringExpired,
    projectionKeys.length,
    sync.hydratedCanvasId,
    sync.revision,
    sync.status,
  ]);
  // 从虾集切回虾画时补一次投影状态。下面那个拉取 effect 用
  // (canvasId, revision, refreshToken) 去重，光把 `active` 加进它的依赖并不会
  // 真的重新拉；推一下 token 才是它认的信号。只在 false → true 这一沿触发，
  // 避免每次依赖变化都多打一发请求。
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const reactivated = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (reactivated) {
      setProjectionStatusRefreshToken((value) => value + 1);
    }
  }, [active]);
  useEffect(() => {
    if (projectionMonitoringExpired) return;
    if (shouldClearProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
    })) {
      clearCanvasProjectionStatuses();
      return;
    }
    const revision = sync.revision;
    if (!shouldFetchProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      revision,
      sessionExpired: projectionMonitoringExpired,
      syncStatus: sync.status,
    })) {
      return;
    }
    // shouldFetchProjectionStatuses already returns false when revision is null;
    // this redundant guard narrows the type for the non-null usages below.
    if (revision == null) {
      return;
    }
    if (shouldSkipProjectionStatusRevision({
      canvasId,
      revision,
      refreshToken: projectionStatusRefreshToken,
      lastChecked: lastProjectionStatusRevisionRef.current,
    })) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await getProjectionStatuses(projectId, canvasId, projectionKeys);
        if (!cancelled) {
          lastProjectionStatusRevisionRef.current = {
            canvasId,
            revision,
            refreshToken: projectionStatusRefreshToken,
          };
          setCanvasProjectionStatuses(result.projections);
        }
      } catch {
        if (!cancelled) {
          clearCanvasProjectionStatuses();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    canvasId,
    projectId,
    projectionMonitoringExpired,
    projectionKeys,
    projectionStatusRefreshToken,
    sync.hydratedCanvasId,
    sync.revision,
    sync.status,
  ]);

  const handleSyncProjection = useCallback(async (projectionKey: string) => {
    if (syncingProjectionRef.current) return;
    const request = requestFromProjectionMetadata(sync.metadata, projectionKey);
    if (!request) {
      setToast(t("freezone.projections.syncMissingRequest"));
      return;
    }
    syncingProjectionRef.current = projectionKey;
    try {
      const target = projectionTargetForCanvasPanel({ currentCanvasId: canvasId, request });
      const projection = await buildProjectionFromPreset(projectId, {
        ...request,
        projection_key: target.projectionKey,
        base_revision: 0,
        force_refresh: true,
      });
      queueLocalFreezoneProjection(projectId, target.targetCanvasId, {
        projectionKey: target.projectionKey,
        nodes: (projection.nodes ?? []) as CanvasNode[],
        edges: (projection.edges ?? []) as CanvasEdge[],
        metadata: projectionMetadataWithRequest(
          projection.metadata ?? null,
          target.projectionKey,
          request,
          projection.facts_signature,
        ),
      });
      consumeQueuedLocalFreezoneProjections(projectId, target.targetCanvasId);
      markCanvasProjectionFresh(target.projectionKey);
      setToast(t("freezone.projections.syncSuccess"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      syncingProjectionRef.current = null;
    }
  }, [canvasId, projectId, sync.metadata, t]);

  const handleRemoveProjection = useCallback(async (projectionKey: string) => {
    if (removingProjectionRef.current) return;
    removingProjectionRef.current = projectionKey;
    try {
      const removed = removeLocalFreezoneProjection(projectId, canvasId, projectionKey);
      if (!removed) {
        throw new Error(t("freezone.projections.removeBlocked"));
      }
      setToast(t("freezone.projections.removeSuccess"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      removingProjectionRef.current = null;
    }
  }, [canvasId, projectId, sync, t]);

  // 节点 toolbar 上的 Commit 按钮通过 canvasEventBus 触发；这里订阅、查节点、
  // 推 CommitDialog。比 AssetLibraryPanel 的 Commit 宽松：任何带 imageUrl 的
  // 节点都允许提交，slot_target 只是给 dialog 一个 default，缺失也能让用户手选目标。
  useEffect(() => {
    return canvasEventBus.subscribe("freezone/commit-node", ({ nodeId, auto, successMessage }) => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) {
        setToast("当前节点没有可提交的内容");
        return;
      }
      // 泛化:不再只认 imageUrl,而是按节点类型推断媒体 url(图像/视频/音频/3GS)。
      const info = deriveNodeDropInfo(node);
      if (!info?.sourceUrl) {
        setToast("当前节点没有可提交的内容");
        return;
      }
      const sourceUrl = info.sourceUrl;
      const data = (node.data ?? {}) as Record<string, unknown>;
      const preview =
        typeof data.previewImageUrl === "string" && data.previewImageUrl
          ? data.previewImageUrl
          : info.mediaType === "image"
            ? sourceUrl
            : null;
      const sourceMeta = data.__freezone_source as Record<string, unknown> | undefined;
      const defaultTarget =
        coerceSlotTarget(data.slot_target) ??
        coerceSlotTarget(data.capabilityDefaultPushTarget) ??
        assetToPushTarget(sourceMeta) ??
        undefined;
      if (!auto) {
        void (async () => {
          try {
            const savedOpenScene = await saveOpenDirectorWorldScene(nodeId);
            if (savedOpenScene) {
              const flushed = await sync.flush();
              if (!flushed) {
                throw new Error("当前画布未保存成功，处理冲突后再提交");
              }
            }
            const latestNode = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
            if (!latestNode) {
              setToast("当前节点没有可提交的内容");
              return;
            }
            const latestInfo = deriveNodeDropInfo(latestNode);
            if (!latestInfo?.sourceUrl) {
              setToast("当前节点没有可提交的内容");
              return;
            }
            const latestData = (latestNode.data ?? {}) as Record<string, unknown>;
            const latestPreview =
              typeof latestData.previewImageUrl === "string" && latestData.previewImageUrl
                ? latestData.previewImageUrl
                : latestInfo.mediaType === "image"
                  ? latestInfo.sourceUrl
                  : null;
            const latestSourceMeta = latestData.__freezone_source as Record<string, unknown> | undefined;
            setPushState({
              nodeId,
              sourceUrl: latestInfo.sourceUrl,
              previewUrl: latestPreview,
              mediaType: latestInfo.mediaType,
              defaultTarget:
                coerceSlotTarget(latestData.slot_target) ??
                coerceSlotTarget(latestData.capabilityDefaultPushTarget) ??
                assetToPushTarget(latestSourceMeta) ??
                defaultTarget,
              sourceLabel: latestInfo.label,
              directorControlBundle: latestInfo.directorControlBundle,
              nodeData: latestData,
            });
          } catch (err) {
            setToast(err instanceof Error ? err.message : String(err));
          }
        })();
        return;
      }
      if (!defaultTarget) {
        setToast("当前节点没有可自动提交的主线目标");
        return;
      }
      void (async () => {
        setToast("正在写入当前背景…");
        try {
          const flushed = await sync.flush();
          if (!flushed) {
            throw new Error("当前画布未保存成功，处理冲突后再提交");
          }
          const latestData = resolveSubmitNodeData(latestCanvasNodeData(nodeId), data) ?? data;
          const latestSourceUrl =
            info.mediaType === "model"
              ? modelSourceUrlFromNodeData(latestData) ?? sourceUrl
              : sourceUrl;
          const target = defaultTarget as PushTarget;
          const result = target.kind === "director_render"
            ? await commitDirectorRenderFromCanvasSource(projectId, target, {
                sourceUrl: latestSourceUrl,
                previewUrl: preview,
                bundle: info.directorControlBundle,
                sourceNodeId: nodeId,
                label: typeof latestData.displayName === "string" ? latestData.displayName : undefined,
              })
            : target.kind === "scene_director_world"
              ? await commitSceneDirectorWorldFromCanvasNode(projectId, target, latestData)
              : await promoteToAsset(projectId, latestSourceUrl, target, {
                mark_stale: false,
              });
          const nodeDataPatch = nodeDataPatchAfterCommittedTarget(latestData, target, result, projectId);
          if (nodeDataPatch) {
            useCanvasStore.getState().updateNodeData(nodeId, nodeDataPatch);
          }
          const manifestNodeData = nodeDataPatch && hasDirectorWorldSceneState(nodeDataPatch)
            ? nodeDataPatch
            : sceneDirectorWorldDataForManifest(latestData, target, result, projectId);
          if (manifestNodeData && isDirectorWorldSourceSlotTarget(target)) {
            await commitSceneDirectorWorldFromCanvasNode(projectId, {
              kind: "scene_director_world",
              scene_id: target.scene_id,
            }, manifestNodeData, { pruneStale: false });
          }
          refreshCommittedTargetNodes(target, result);
          invalidateCommittedTargetQueries(target);
          markCommitCandidatePushed(nodeId, target, result);
          setAssetLibraryReloadToken((token) => token + 1);
          setToast(
            successMessage ??
              `${renderCommitSuccessMessage(target, result)}${
                manifestNodeData ? "；已同步导演世界状态" : ""
              }`,
          );
          void sync.flush();
        } catch (err) {
          setToast(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  }, [projectId, sync]);

  useEffect(() => {
    const unsubscribeSync = canvasEventBus.subscribe(
      "freezone/projection-sync",
      ({ projectionKey }) => {
        void handleSyncProjection(projectionKey);
      },
    );
    const unsubscribeRemove = canvasEventBus.subscribe(
      "freezone/projection-remove",
      ({ projectionKey }) => {
        void handleRemoveProjection(projectionKey);
      },
    );

    return () => {
      unsubscribeSync();
      unsubscribeRemove();
    };
  }, [handleRemoveProjection, handleSyncProjection]);

  useEffect(() => {
    return canvasEventBus.subscribe("freezone/assets-updated", () => {
      setAssetLibraryReloadToken((token) => token + 1);
    });
  }, []);

  // 画布节点 / 故事板卡片、详情头部的「添加到对话」——两个视图是同一份节点数据的
  // 两种投影，所以入口只发事件，落地统一收在这里（追加行内 mention + 展开聊天），
  // 避免两边各写一套后行为漂移。和 @ 菜单同一套模型：不选中画布节点、不出引用条，
  // 而是把 @[节点名](id) 行内 chip 插进虾导 draft（drain 见 SuperChatPanel）。
  // 过滤画布上已不存在的 id：全是幽灵就不展开聊天。
  useEffect(() => {
    return canvasEventBus.subscribe("freezone/add-nodes-to-chat", ({ nodeIds }) => {
      const onCanvas = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
      const valid = nodeIds.filter((id) => onCanvas.has(id));
      if (valid.length === 0) return;
      setPendingChatNodeMentions(valid);
      setChatOpen(true);
    });
  }, []);

  useEffect(() => {
    const handleCanvasCommand = (event: Event) => {
      const detail = (event as CustomEvent<{
        frame?: ServerFrame;
        anchorTextPrefix?: string | null;
        receivedAt?: number;
        externalMcpCommand?: boolean;
      }>).detail;
      const frame = detail?.frame;
      if (!frame || frame.type !== "canvas.command") return;
      const claim = claimExternalCanvasCommand(
        emittedExternalCanvasCommandKeysRef.current,
        frame,
        detail?.externalMcpCommand === true,
      );
      if (!claim.accepted) return;
      const isExternalMcpCommand = claim.externalMcpCommand;
      const turnId = typeof frame.turn_id === "string" ? frame.turn_id : null;
      const bridgeKey = claim.bridgeKey;
      const agentId =
        typeof frame.agent_id === "string"
          ? frame.agent_id
          : typeof frame.agentId === "string"
            ? frame.agentId
            : null;
      const eventReceivedAt = detail?.receivedAt ?? Date.now();
      const validationBridgeKey = bridgeKey
        ? `${bridgeKey}:validation`
        : `validation:${turnId ?? canvasId}:${eventReceivedAt}`;
      emitCanvasContextActivity({
        turnId,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey: validationBridgeKey,
        canvasId,
        agentId,
        status: "running",
        labels: ["命令校验"],
        receivedAt: eventReceivedAt,
        surfaceOrder: eventReceivedAt,
        externalMcpCommand: isExternalMcpCommand,
      });
      const candidates = canvasCommandCandidatesFromFrame(frame);
      const envelopes = extractCanvasChatCommandEnvelopes(candidates)
        .filter((envelope) => canvasCommandEnvelopeMatchesCanvas(envelope, canvasId));

      console.info("[freezone-canvas-command] frame received", {
        bridgeKey,
        turnId,
        externalMcpCommand: isExternalMcpCommand,
        candidateCount: candidates.length,
        envelopeCount: envelopes.length,
      });

      if (envelopes.length === 0) {
        const errors = [
          "画布命令格式无效或不属于当前画布，前端未执行。",
          "无法解析 canvas_chat_commands.v1 命令；请检查 command 字段是否在正确层级。",
        ];
        console.warn("[freezone-canvas-command] frame rejected: no valid envelope", {
          bridgeKey,
          turnId,
          candidateCount: candidates.length,
        });
        emitCanvasContextActivity({
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          bridgeKey: validationBridgeKey,
          canvasId,
          agentId,
          status: "failed",
          labels: ["命令校验"],
          errors,
          receivedAt: eventReceivedAt + 1,
          surfaceOrder: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        persistCanvasCommandValidationActivity({
          projectId,
          canvasId,
          turnId,
          bridgeKey: validationBridgeKey,
          ok: false,
          errors,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        const result: CanvasChatCommandApplyResult = {
          applied: 0,
          openedUiActions: 0,
          createdNodeIds: [],
          errors,
          commandResults: [
            {
              commandIndex: -1,
              type: "validate",
              status: "error",
              label: "画布命令无效",
              error: "无法解析 canvas_chat_commands.v1 命令；请检查 command 字段是否在正确层级。",
            },
          ],
        };
        reportCanvasCommandToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          projectId,
          canvasId,
          agentId,
          result,
        });
        persistCanvasCommandResult({
          projectId,
          canvasId,
          turnId,
          envelopes: [],
          result,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: detail?.receivedAt,
          bridgeKey,
        });
        window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, {
          detail: {
            canvasId,
            agentId,
            turnId,
            bridgeKey,
            anchorMessageId: null,
            envelopes: [],
            result,
            anchorTextPrefix: detail?.anchorTextPrefix ?? null,
            receivedAt: eventReceivedAt + 2,
          },
        }));
        if (!isExternalMcpCommand) setChatOpen(true);
        return;
      }

      const currentState = useCanvasStore.getState();
      const normalizedEnvelopes = normalizeCanvasChatCommandEnvelopesForValidation(
        envelopes,
        currentState.nodes.map((node) => node.id),
      );
      const validation = validateCanvasChatCommandEnvelopes(
        normalizedEnvelopes,
        currentState.nodes,
        currentState.edges,
      );
      if (!validation.ok) {
        const errors = [
          "画布命令预校验失败，前端未展示确认卡，也未执行。",
          ...validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
        ];
        console.warn("[freezone-canvas-command] validation failed", {
          bridgeKey,
          turnId,
          envelopeCount: normalizedEnvelopes.length,
          issueCount: validation.issues.length,
          issues: validation.issues.slice(0, 12).map((issue) => `${issue.path}: ${issue.message}`),
        });
        emitCanvasContextActivity({
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          bridgeKey: validationBridgeKey,
          canvasId,
          agentId,
          status: "failed",
          labels: ["命令校验"],
          errors,
          receivedAt: eventReceivedAt + 1,
          surfaceOrder: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        persistCanvasCommandValidationActivity({
          projectId,
          canvasId,
          turnId,
          bridgeKey: validationBridgeKey,
          ok: false,
          errors,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        const result = canvasCommandValidationFailureResult(errors);
        reportCanvasCommandToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          projectId,
          canvasId,
          agentId,
          result,
        });
        persistCanvasCommandResult({
          projectId,
          canvasId,
          turnId,
          envelopes: normalizedEnvelopes,
          result,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: detail?.receivedAt,
          bridgeKey,
        });
        window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, {
          detail: {
            canvasId,
            agentId,
            turnId,
            bridgeKey,
            anchorMessageId: null,
            envelopes: normalizedEnvelopes,
            result,
            anchorTextPrefix: detail?.anchorTextPrefix ?? null,
            receivedAt: eventReceivedAt + 2,
          },
        }));
        if (!isExternalMcpCommand) setChatOpen(true);
        return;
      }

      emitCanvasContextActivity({
        turnId,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey: validationBridgeKey,
        canvasId,
        agentId,
        status: "done",
        labels: ["命令校验"],
        receivedAt: eventReceivedAt + 1,
        surfaceOrder: eventReceivedAt + 1,
        externalMcpCommand: isExternalMcpCommand,
      });
      persistCanvasCommandValidationActivity({
        projectId,
        canvasId,
        turnId,
        bridgeKey: validationBridgeKey,
        ok: true,
        errors: [],
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        receivedAt: eventReceivedAt + 1,
        externalMcpCommand: isExternalMcpCommand,
      });
      persistCanvasCommandApproval({
        projectId,
        canvasId,
        turnId,
        envelopes: normalizedEnvelopes,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        receivedAt: eventReceivedAt + 2,
        bridgeKey,
        externalMcpCommand: isExternalMcpCommand,
      });
      console.info("[freezone-canvas-command] approval emitted", {
        bridgeKey,
        turnId,
        envelopeCount: normalizedEnvelopes.length,
        commandCount: normalizedEnvelopes.reduce((sum, envelope) => sum + envelope.commands.length, 0),
        externalMcpCommand: isExternalMcpCommand,
      });
      setChatOpen(true);
      window.setTimeout(() => emitCanvasCommandApproval({
        canvasId,
        agentId,
        turnId,
        anchorMessageId: null,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey,
        envelopes: normalizedEnvelopes,
        receivedAt: eventReceivedAt + 2,
        externalMcpCommand: isExternalMcpCommand,
      }), 0);
    };

    window.addEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleCanvasCommand);
    return () => {
      window.removeEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleCanvasCommand);
    };
  }, [canvasId, projectId]);

  useEffect(() => {
    emittedExternalCanvasCommandKeysRef.current.clear();
  }, [canvasId, projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const seenKeys = Array.from(emittedExternalCanvasCommandKeysRef.current).slice(-200);
        const agentIds = loadFreezoneCanvasAgentsWithSource(projectId, canvasId).state.agents
          .map((agent) => agent.id);
        const frames = await listPendingCanvasCommandFrames({
          projectId,
          canvasId,
          agentIds,
          seenKeys,
        });
        if (frames.length > 0) {
          console.info("[freezone-canvas-command] pending frames polled", {
            count: frames.length,
            bridgeKeys: frames
              .map((frame) => {
                const record = frame as Record<string, unknown>;
                return typeof record.bridge_key === "string" ? record.bridge_key : null;
              })
              .filter((key): key is string => Boolean(key)),
          });
        }
        const now = Date.now();
        frames.forEach((frame, index) => {
          const frameRecord = frame as Record<string, unknown>;
          const bridgeKey =
            typeof frameRecord.bridge_key === "string"
              ? frameRecord.bridge_key
              : typeof frameRecord.bridgeKey === "string"
                ? frameRecord.bridgeKey
                : null;
          if (!bridgeKey || emittedExternalCanvasCommandKeysRef.current.has(bridgeKey)) return;
          window.dispatchEvent(new CustomEvent(SUPERCHAT_CANVAS_COMMAND_EVENT, {
            detail: {
              frame,
              anchorTextPrefix: "外部 Agent",
              receivedAt: now + index,
              externalMcpCommand: true,
            },
          }));
        });
      } catch {
        // The page can be open before auth/API is ready. Retry quietly.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, EXTERNAL_CANVAS_COMMAND_POLL_MS);
        }
      }
    };

    timer = window.setTimeout(tick, EXTERNAL_CANVAS_COMMAND_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [canvasId, projectId]);

  useEffect(() => {
    const handleCanvasContextRequest = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!detail) return;
      const requestedCanvasId =
        typeof detail.canvas_id === "string"
          ? detail.canvas_id
          : typeof detail.canvasId === "string"
            ? detail.canvasId
            : null;
      if (requestedCanvasId && requestedCanvasId !== canvasId) return;

      const bridgeKey = typeof detail.bridge_key === "string" ? detail.bridge_key : null;
      const agentId =
        typeof detail.agent_id === "string"
          ? detail.agent_id
          : typeof detail.agentId === "string"
            ? detail.agentId
            : null;
      const turnId = typeof detail.turn_id === "string" ? detail.turn_id : null;
      const anchorTextPrefix =
        typeof detail.anchorTextPrefix === "string"
          ? detail.anchorTextPrefix
          : typeof detail.anchor_text_prefix === "string"
            ? detail.anchor_text_prefix
            : null;
      const envelopes = extractCanvasContextRequestEnvelopes(
        canvasContextRequestCandidatesFromDetail(detail),
      );
      if (envelopes.length === 0) {
        reportCanvasContextToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix,
          projectId,
          canvasId,
          agentId,
          responses: [],
          errors: ["无法解析 canvas_context_request.v1 请求。"],
        });
        setChatOpen(true);
        return;
      }

      void (async () => {
        const currentState = useCanvasStore.getState();
        const selectedNodeIds = currentState.nodes
          .filter((node) => node.selected || currentState.selectedNodeId === node.id)
          .map((node) => node.id);
        try {
          const responses = await buildCanvasContextRequestResponses({
            project: projectId,
            canvasId,
            nodes: currentState.nodes,
            edges: currentState.edges,
            ontologyContext: buildCanvasOntologyContext(currentState.nodes, currentState.edges, {
              canvasId,
              selectedNodeIds,
            }),
            selectedNodeIds,
            envelopes,
            canvasMetadata: sync.metadata as Record<string, unknown> | null,
            loadMainlineProjectionAssets: () => loadMainlineProjectionAssets(projectId),
          });
          reportCanvasContextToolResult({
            bridgeKey,
            turnId,
            anchorTextPrefix,
            projectId,
            canvasId,
            agentId,
            responses: responses ?? [],
            errors: [],
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "unknown error");
          const errors = [`读取画布上下文失败：${message}`];
          emitCanvasContextActivity({
            turnId,
            anchorTextPrefix,
            bridgeKey: bridgeKey ?? `context:${turnId ?? canvasId}:${Date.now()}`,
            canvasId,
            agentId,
            status: "failed",
            labels: ["画布上下文"],
            errors,
            receivedAt: Date.now(),
          });
          reportCanvasContextToolResult({
            bridgeKey,
            turnId,
            anchorTextPrefix,
            projectId,
            canvasId,
            agentId,
            responses: [],
            errors,
          });
        } finally {
          setChatOpen(true);
        }
      })();
    };

    window.addEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    return () => {
      window.removeEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    };
  }, [canvasId, projectId, sync.metadata]);

  const canvasDefaultTarget = normalizePushTarget(
    (sync.metadata?.default_push_target ?? null) as
      | (Partial<PushTarget> & { kind?: PushTargetKind })
      | null,
  );
  const presetDefaultCharacter =
    defaultCharacterFromMetadata(sync.metadata) ??
    (
      canvasDefaultTarget?.kind === "identity" ||
      canvasDefaultTarget?.kind === "identity_costume" ||
      canvasDefaultTarget?.kind === "identity_portrait" ||
      canvasDefaultTarget?.kind === "portrait"
        ? canvasDefaultTarget.character
        : null
    );

  const handleMaskEditResult = async (newUrl: string) => {
    const { CANVAS_NODE_TYPES, DEFAULT_NODE_WIDTH } = await import(
      "@/features/canvas/domain/canvasNodes"
    );
    const addNode = useCanvasStore.getState().addNode;
    const baseLabel = maskTarget?.label ?? "edit";
    addNode(
      CANVAS_NODE_TYPES.upload,
      { x: 100, y: 1100 },
      {
        displayName: `${baseLabel} (mask)`,
        imageUrl: newUrl,
        previewImageUrl: newUrl,
        aspectRatio: "1:1",
        sourceFileName: `${baseLabel}-mask`,
      } as Record<string, unknown>,
    );
    setToast(`Mask edit 完成 — 新图已入画布`);
    void DEFAULT_NODE_WIDTH; // unused but keep import alive
  };

  const showBlockingLoading = sync.status === "loading" && !hasRenderedCanvas;
  const showLoadingOverlay = sync.status === "loading" && hasRenderedCanvas;

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden">
      <div className="relative flex flex-1 min-h-0">
        <main className="relative h-full min-w-0 flex-1">
          {showBlockingLoading ? (
            <CanvasLoadingScreen />
          ) : (
            <Canvas
              projectId={projectId}
              canvasId={canvasId}
              onBlankPaneClick={handleBlankPaneClick}
              controlsPlacement="bottom-right"
              // 保活到虾集时也算 suspended：Canvas 的 6 处 window/document 键盘
              // 监听（含 capture 阶段）都读这个开关，否则在虾集的输入框里打字会
              // 被画布快捷键截走。
              suspended={!active || viewMode === "board"}
            />
          )}
          {showLoadingOverlay && <CanvasLoadingOverlay />}
          {sync.status === "error" && (
            <CanvasErrorOverlay error={sync.error} onRetry={sync.retry} />
          )}
          {sync.status === "conflict" && (
            <CanvasConflictOverlay
              error={sync.error}
              canvasId={canvasId}
              onRefresh={sync.retry}
              onSaveCopy={async () => {
                const copyCanvasId = await sync.saveCopy();
                setAssetLibraryReloadToken((token) => token + 1);
                writeUrl({ canvas: copyCanvasId });
              }}
              readConflictSnapshot={sync.readConflictSnapshot}
            />
          )}
          <BackupStatusIndicator status={sync.backupStatus} />
          {active && sync.status === "ready" && sync.hydratedCanvasId === canvasId && (
            // 自带 15s 轮询，保活期间不挂载。
            <WorkflowRunRecoveryBar projectId={projectId} canvasId={canvasId} />
          )}
          {/* 调试面板暂时隐藏，恢复时去掉 `false &&` 即可 */}
          {false && import.meta.env.DEV && (
            <CanvasDebugPanel
              project={projectId}
              canvasId={canvasId}
              open={debugPanelOpen}
              onOpenChange={setDebugPanelOpen}
              placement="top-right"
              status={sync.status}
              backupStatus={sync.backupStatus}
              error={sync.error}
              onRehydrate={sync.retry}
            />
          )}
          <AssetLibraryPanel
            project={projectId}
            metadata={sync.metadata}
            collapsed={assetPanelCollapsed}
            onCollapsedChange={setAssetPanelCollapsed}
            currentCanvasId={canvasId}
            reloadToken={assetLibraryReloadToken}
            onRestoreMainlineDefault={async () => {
              try {
                await sync.restoreMainlineDefault();
                setToast("已按当前主流程事实同步主线视图");
              } catch (err) {
                setToast(err instanceof Error ? err.message : String(err));
              }
            }}
            onReplaced={(payload, message) => {
              if (payload) {
                refreshCommittedTargetNodes(payload.target, payload.result);
                setAssetLibraryReloadToken((token) => token + 1);
              }
              setToast(message);
            }}
          />
          {/* 故事板视图：懒挂载 + 保活（对标 liblib，秒切且滚动/筛选状态保留）。 */}
          {!showBlockingLoading && boardMounted && (
            <AssetBoardView
              // 必须带上 active：故事板保活用的是 `visibility: visible`
              // （AssetBoardView.tsx:435），会穿透宿主容器上的 invisible ——
              // 不接这个开关，故事板视图下切到虾集，它会浮在虾集页面上。
              // 顺带也停掉它对 canvas store 的订阅和媒体播放（paused={!visible}）。
              visible={active && viewMode === "board"}
              onLocateNode={handleLocateNode}
            />
          )}
          {/* 工作流/故事板 切换开关：左上角悬浮，压在故事板 overlay(z-30) 之上。
              只留图标、不带文字（用户要求）——原来是两颗 88px 宽的文字胶囊悬在画布
              正上方，把画面正中那一条压掉了；文案改由 hover 提示给出，读屏走
              aria-label。提示用 shadcn Tooltip 而不是原生 title：原生要悬停约一秒才
              出，样式也和产品其它悬浮说明不统一（同 AddNodeToChatButton 的取舍）。

              left-4：对齐故事板内容区的 px-4 左内边距，两个视图切来切去开关不跳位；
              工作流态那侧素材抽屉的把手/卡片已下移让开这条顶部窄带（AssetLibraryPanel）。
              选中态样式仍对齐头部「虾画/虾集」产品切换（project-header-navigation.tsx
              的 ProjectHeaderNavigation）：手写胶囊 + 滑块，滑块宽度跟着按钮收成 44px。
              容器底色沿用硬编码 #262626（与故事板背景同色），圆角按 10px 走圆角矩形。 */}
          {!showBlockingLoading && (
            <div className="absolute left-4 top-1.5 z-40">
              <TooltipProvider delay={80}>
                <nav
                  aria-label="画布视图切换"
                  className="relative flex h-8 items-center rounded-[10px] bg-[#262626] p-0.5 shadow-lg"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute left-0.5 top-1/2 h-7 w-11 -translate-y-1/2 rounded-[8px] bg-foreground transition-transform duration-300 ease-[var(--ease-out-quint)]",
                      viewMode === "board" && "translate-x-11",
                    )}
                  />
                  {FREEZONE_VIEW_MODE_TABS.map(({ mode, icon: Icon, label }) => (
                    <Tooltip key={mode}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-testid={`freezone-view-${mode}`}
                            onClick={() => handleViewModeChange(mode)}
                            aria-label={label}
                            aria-pressed={viewMode === mode}
                            className={cn(
                              // w-11：只有图标不代表要挤成 28px 方块——键位宽一点更好点、
                              // 也更像一条分段控件（用户反馈「胶囊宽度要宽一点」）。
                              "relative z-10 inline-flex h-7 w-11 items-center justify-center rounded-[8px] transition-colors",
                              viewMode === mode
                                ? "text-background"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          />
                        }
                      >
                        <Icon className="size-4" />
                      </TooltipTrigger>
                      {/* side=bottom：开关贴着内容区顶边，提示朝上会被顶栏盖住。 */}
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  ))}
                </nav>
              </TooltipProvider>
            </div>
          )}
        </main>
        {showChatDock && (
          <FreezoneChatDock
            projectId={projectId}
            canvasId={canvasId}
            currentCanvasMetadata={sync.metadata}
            currentCanvasSelection={currentCanvasSelection}
            currentCanvasOntologyContext={currentCanvasOntologyContext}
            pendingAttachments={pendingChatAttachments}
            onPendingAttachmentsConsumed={handlePendingChatAttachmentsConsumed}
            pendingNodeMentions={pendingChatNodeMentions}
            onPendingNodeMentionsConsumed={handlePendingChatNodeMentionsConsumed}
            open={chatOpen}
            onOpenChange={handleChatOpenChange}
            // 抽屉会往 <html> 上广播 --freezone-dock-width，顶栏 / 任务状态条 / 任务
            // 面板据此整条往左收。以前离开虾画会整棵卸载、effect 清理顺手把变量删掉；
            // 保活之后没人卸载，虾集的顶栏就一直挂着虾导抽屉的让位量（顶栏被挤窄、
            // 虾画·虾集 与右上角那组入口整体左移）。所以非激活时按「抽屉没开」广播。
            hostActive={active}
            // 故事板：抽屉挤占左侧内容宽度（对标 liblib）；工作流：浮在画布上，
            // 画布视口不受影响（否则每次开合聊天都会让 ReactFlow 重排一次视口）。
            pushesContent={viewMode === "board"}
            title={t("freezone.chat.title")}
            description={t("freezone.chat.description")}
            toggleLabel={t("freezone.chat.toggle")}
          />
        )}
      </div>
      <NodeReplaceDragPreview />
      {pushState && (
        <CommitDialog
          project={projectId}
          sourceUrl={pushState.sourceUrl}
          previewUrl={pushState.previewUrl ?? undefined}
          sourceLabelOverride={pushState.sourceLabel}
          mediaType={pushState.mediaType}
          defaultTarget={pushState.defaultTarget}
          directorControlBundle={pushState.directorControlBundle}
          nodeData={pushState.nodeData}
          getNodeData={() => resolveSubmitNodeData(latestCanvasNodeData(pushState.nodeId), pushState.nodeData)}
          onClose={() => setPushState(null)}
          onSuccess={(msg, result, target, nodeDataPatch) => {
            if (nodeDataPatch) {
              useCanvasStore.getState().updateNodeData(pushState.nodeId, nodeDataPatch);
            }
            refreshCommittedTargetNodes(target, result);
            invalidateCommittedTargetQueries(target);
            markCommitCandidatePushed(pushState.nodeId, target, result);
            setAssetLibraryReloadToken((token) => token + 1);
            setPushState(null);
            setToast(msg);
          }}
        />
      )}
      {createIdentitySource && (
        <CreateIdentityDialog
          project={projectId}
          sourceUrl={createIdentitySource.imageUrl}
          previewUrl={createIdentitySource.previewUrl ?? undefined}
          defaultCharacter={presetDefaultCharacter}
          onClose={() => setCreateIdentitySource(null)}
          onSuccess={(msg) => {
            setCreateIdentitySource(null);
            setToast(msg);
          }}
        />
      )}
      {comparePair && (
        <CompareDialog
          left={comparePair.left}
          right={comparePair.right}
          onClose={() => setComparePair(null)}
        />
      )}
      {maskTarget && (
        <MaskEditor
          project={projectId}
          baseUrl={maskTarget.url}
          baseLabel={maskTarget.label}
          onClose={() => setMaskTarget(null)}
          onResult={handleMaskEditResult}
        />
      )}
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function FreezoneChatDock({
  projectId,
  canvasId,
  currentCanvasMetadata,
  currentCanvasSelection,
  currentCanvasOntologyContext,
  pendingAttachments,
  onPendingAttachmentsConsumed,
  pendingNodeMentions,
  onPendingNodeMentionsConsumed,
  open,
  onOpenChange,
  pushesContent,
  title,
  description,
  toggleLabel,
  hostActive,
}: {
  projectId: string;
  canvasId: string;
  currentCanvasMetadata: Record<string, unknown> | null;
  currentCanvasSelection: CurrentCanvasSelectionItem[];
  currentCanvasOntologyContext: CanvasOntologyContext;
  pendingAttachments: ChatAttachment[];
  onPendingAttachmentsConsumed: () => void;
  pendingNodeMentions: string[];
  onPendingNodeMentionsConsumed: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** true=抽屉在 flex 行里占位（左侧内容被挤窄）；false=纯浮层，左侧内容不动。 */
  pushesContent: boolean;
  title: string;
  description: string;
  toggleLabel: string;
  /** 画布是否在前台。false 时抽屉不再向全局广播让位宽度（见下方 effect）。 */
  hostActive: boolean;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [shouldRenderPanel, setShouldRenderPanel] = useState(open);
  const [panelVisible, setPanelVisible] = useState(open);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [chatWidth, setChatWidth] = useState(() =>
    loadStoredPanelWidth(
      FREEZONE_CHAT_WIDTH_STORAGE_KEY,
      FREEZONE_CHAT_WIDTH_DEFAULT,
      FREEZONE_CHAT_WIDTH_MIN,
      FREEZONE_CHAT_WIDTH_MAX,
    ),
  );
  const [agentHistoryWidth, setAgentHistoryWidth] = useState(() =>
    loadStoredPanelWidth(
      FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY,
      FREEZONE_AGENT_HISTORY_WIDTH_DEFAULT,
      FREEZONE_AGENT_HISTORY_WIDTH_MIN,
      FREEZONE_AGENT_HISTORY_WIDTH_MAX,
    ),
  );
  const [resizingPane, setResizingPane] = useState<"chat" | "history" | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const localAgentSelectionRef = useRef(false);
  const [agentState, setAgentState] = useState<FreezoneCanvasAgentState>(() => {
    const loaded = loadFreezoneCanvasAgentsWithSource(projectId, canvasId);
    localAgentSelectionRef.current = loaded.hadStoredState;
    return FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
      ? loaded.state
      : selectFreezoneCanvasAgent(projectId, canvasId, DEFAULT_FREEZONE_AGENT_ID);
  });
  const [busyAgentIds, setBusyAgentIds] = useState<Set<string>>(() => new Set());
  const activeAgentId = agentState.activeAgentId;

  useEffect(() => {
    const loaded = loadFreezoneCanvasAgentsWithSource(projectId, canvasId);
    localAgentSelectionRef.current = loaded.hadStoredState;
    setAgentState(
      FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
        ? loaded.state
        : selectFreezoneCanvasAgent(projectId, canvasId, DEFAULT_FREEZONE_AGENT_ID),
    );
  }, [canvasId, projectId]);

  useEffect(() => {
    let cancelled = false;
    const hadLocalSelection = localAgentSelectionRef.current;
    const explicitAgentId = FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
      ? readFreezoneAgentIdFromUrl()
      : null;
    void listServerFreezoneCanvasAgents(projectId, canvasId)
      .then((serverAgents) => {
        if (cancelled || serverAgents.length === 0) return;
        setAgentState(
          mergeFreezoneCanvasAgentsFromServer(projectId, canvasId, serverAgents, {
            explicitAgentId,
            preferServerActive:
              FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
              && !hadLocalSelection
              && !explicitAgentId,
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canvasId, projectId]);

  const handleSelectAgent = useCallback((agentId: string) => {
    localAgentSelectionRef.current = true;
    setAgentState(selectFreezoneCanvasAgent(projectId, canvasId, agentId));
  }, [canvasId, projectId]);

  const handleAddAgent = useCallback(() => {
    localAgentSelectionRef.current = true;
    const result = addFreezoneCanvasAgent(projectId, canvasId);
    initializeEmptyFreezoneAgentChat(projectId, canvasId, result.agent.id, result.agent.createdAt);
    setAgentState(result.state);
  }, [canvasId, projectId]);

  const handleHeaderAddAgent = useCallback(() => {
    localAgentSelectionRef.current = true;
    const result = addFreezoneCanvasAgent(projectId, canvasId);
    initializeEmptyFreezoneAgentChat(projectId, canvasId, result.agent.id, result.agent.createdAt);
    setAgentState(result.state);
  }, [canvasId, projectId]);

  const handleAgentUserMessage = useCallback((agentId: string, message: string, timestamp: number) => {
    localAgentSelectionRef.current = true;
    setAgentState(updateFreezoneCanvasAgentFromUserMessage(projectId, canvasId, agentId, message, timestamp));
  }, [canvasId, projectId]);

  const handleAgentConnectionState = useCallback((agentId: string, state: { busy: boolean }) => {
    setBusyAgentIds((current) => {
      const hasAgent = current.has(agentId);
      if (state.busy === hasAgent) return current;
      const next = new Set(current);
      if (state.busy) {
        next.add(agentId);
      } else {
        next.delete(agentId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const validAgentIds = new Set(agentState.agents.map((agent) => agent.id));
    setBusyAgentIds((current) => {
      const next = new Set([...current].filter((agentId) => validAgentIds.has(agentId)));
      return next.size === current.size ? current : next;
    });
  }, [agentState.agents]);

  const minContentWidth = pushesContent
    ? FREEZONE_CHAT_MIN_BOARD_CONTENT_WIDTH
    : FREEZONE_CHAT_MIN_CONTENT_WIDTH;

  const startPaneResize = useCallback((
    pane: "chat" | "history",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startChatWidth = chatWidth;
    const startHistoryWidth = agentHistoryWidth;
    let cleaned = false;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingPane(pane);

    const clampChatWidth = (value: number) => {
      const maxByViewport = Math.max(
        FREEZONE_CHAT_WIDTH_MIN,
        window.innerWidth - minContentWidth - (agentHistoryOpen ? agentHistoryWidth : 0),
      );
      return clampNumber(
        value,
        FREEZONE_CHAT_WIDTH_MIN,
        Math.min(FREEZONE_CHAT_WIDTH_MAX, maxByViewport),
      );
    };
    const clampHistoryWidth = (value: number) => {
      const maxByViewport = Math.max(
        FREEZONE_AGENT_HISTORY_WIDTH_MIN,
        window.innerWidth - minContentWidth - chatWidth,
      );
      return clampNumber(
        value,
        FREEZONE_AGENT_HISTORY_WIDTH_MIN,
        Math.min(FREEZONE_AGENT_HISTORY_WIDTH_MAX, maxByViewport),
      );
    };

    // 拖拽期绕开 React：只改 DOM 宽度（外壳 width + 两条内栏读的 CSS 变量），
    // 松手才回写 state / 落库。每动一下就 setState 的话，整棵 SuperChatPanel
    // （消息列表 + 输入区）都要重渲染，一帧根本画不完，手感就是拖不动、跟不上手。
    let nextChatWidth = startChatWidth;
    let nextHistoryWidth = startHistoryWidth;
    let pointerX = startX;
    let frame = 0;

    const measure = () => {
      const delta = startX - pointerX;
      if (pane === "chat") {
        nextChatWidth = clampChatWidth(startChatWidth + delta);
      } else {
        nextHistoryWidth = clampHistoryWidth(startHistoryWidth + delta);
      }
    };

    const paint = () => {
      frame = 0;
      measure();
      const dockWidth = agentHistoryOpen ? nextChatWidth + nextHistoryWidth + 8 : nextChatWidth;
      const aside = asideRef.current;
      if (aside) {
        aside.style.width = `${dockWidth}px`;
        aside.style.setProperty(CHAT_PANE_WIDTH_VAR, `${nextChatWidth}px`);
        aside.style.setProperty(AGENT_HISTORY_PANE_WIDTH_VAR, `${nextHistoryWidth}px`);
      }
      if (spacerRef.current) spacerRef.current.style.width = `${dockWidth}px`;
      // 顶栏 / 底部状态条也在同一帧让位（过渡已被压成 0ms），否则它们会拖在手后面。
      document.documentElement.style.setProperty(
        FREEZONE_DOCK_WIDTH_VAR,
        freezoneDockOffsetCss(dockWidth, minContentWidth),
      );
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pointerX = moveEvent.clientX;
      // 一帧只画一次：高刷鼠标/触控板一帧能推十几个 pointermove，逐个改宽度
      // 等于一帧做十几次布局，白烧的那部分永远不会被显示出来。
      if (frame === 0) frame = window.requestAnimationFrame(paint);
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      target.removeEventListener("lostpointercapture", cleanup);
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture can already be released by the browser.
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // 取消掉的那帧里还压着最后一次 pointermove，先补算再落库，
      // 否则松手瞬间宽度会回跳一帧。
      measure();
      setChatWidth(nextChatWidth);
      setAgentHistoryWidth(nextHistoryWidth);
      storePanelWidth(FREEZONE_CHAT_WIDTH_STORAGE_KEY, nextChatWidth);
      storePanelWidth(FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY, nextHistoryWidth);
      setResizingPane(null);
    };

    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some browsers may reject capture for non-primary pointers.
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
    target.addEventListener("lostpointercapture", cleanup);
  }, [agentHistoryOpen, agentHistoryWidth, chatWidth, minContentWidth]);

  const agentHeaderActions = (
    <>
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleHeaderAddAgent}
          aria-label="新建 Agent"
          title="新建 Agent"
          className="text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
      )}
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setAgentHistoryOpen((value) => !value)}
          aria-pressed={agentHistoryOpen}
          aria-label={agentHistoryOpen ? "收起历史 Agent" : "打开历史 Agent"}
          title={agentHistoryOpen ? "收起历史 Agent" : "打开历史 Agent"}
          className={cn(
            "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground",
            agentHistoryOpen && "bg-white/[0.08] text-foreground",
          )}
        >
          {agentHistoryOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
        </Button>
      )}
    </>
  );

  const agentHistoryPanel = (
    <FreezoneAgentHistoryPanel
      agents={agentState.agents}
      activeAgentId={activeAgentId}
      search={agentSearch}
      onSearchChange={setAgentSearch}
      onSelect={handleSelectAgent}
      onAdd={handleAddAgent}
    />
  );
  const agentPanels = agentState.agents.map((agent) => {
    const active = agent.id === activeAgentId;
    const busy = busyAgentIds.has(agent.id);
    const connectionEnabled = shouldConnectFreezoneCanvasAgent({ active, busy });
    return (
      <div
        key={`${projectId}:${canvasId}:${agent.id}`}
        className={cn("h-full min-h-0 w-full", !active && "hidden")}
        aria-hidden={!active}
      >
        <SuperChatPanel
          variant="freezone"
          freezoneCanvasId={canvasId}
          freezoneAgentId={agent.id}
          connectionEnabled={connectionEnabled}
          workflowStatusEnabled={active}
          currentCanvasMetadata={currentCanvasMetadata}
          currentCanvasSelection={currentCanvasSelection}
          currentCanvasOntologyContext={currentCanvasOntologyContext}
          pendingAttachments={active ? pendingAttachments : []}
          onPendingAttachmentsConsumed={active ? onPendingAttachmentsConsumed : undefined}
          pendingNodeMentions={active ? pendingNodeMentions : []}
          onPendingNodeMentionsConsumed={active ? onPendingNodeMentionsConsumed : undefined}
          onRequestClose={() => onOpenChange(false)}
          freezoneHeaderActions={agentHeaderActions}
          onFreezoneUserMessage={(message, timestamp) => handleAgentUserMessage(agent.id, message, timestamp)}
          onConnectionStateChange={(state) => handleAgentConnectionState(agent.id, state)}
        />
      </div>
    );
  });
  const shouldKeepPanelMounted = shouldKeepFreezoneChatPanelMounted({
    open,
    busy: busyAgentIds.size > 0,
  });

  useEffect(() => {
    if (!isDesktop) {
      setShouldRenderPanel(open);
      setPanelVisible(open);
      return;
    }
    if (open) {
      setShouldRenderPanel(true);
      const frame = window.requestAnimationFrame(() => setPanelVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    if (shouldKeepPanelMounted) {
      setShouldRenderPanel(true);
      setPanelVisible(false);
      return;
    }
    setPanelVisible(false);
    const timeout = window.setTimeout(() => setShouldRenderPanel(false), 320);
    return () => window.clearTimeout(timeout);
  }, [isDesktop, open, shouldKeepPanelMounted]);

  // 抽屉总宽（聊天 + 可选的历史 Agent 栏，中间 8px 分隔条）。占位块用同一个值，
  // 保证被挤窄的左侧内容与抽屉严丝合缝。
  const dockWidth = agentHistoryOpen ? chatWidth + agentHistoryWidth + 8 : chatWidth;
  const resizing = resizingPane !== null;

  // 抽屉是通高浮层（压在顶栏之上），挤不动任何人，只能广播「右边被我占了多少」，
  // 让横贯整屏的顶栏 / 底部状态条 / 任务面板自己往左收——右上角那组入口就跟着
  // 让位。协议与消费方见 ./dockOffset。
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      FREEZONE_DOCK_WIDTH_VAR,
      isDesktop && panelVisible && hostActive
        ? freezoneDockOffsetCss(dockWidth, minContentWidth)
        : "0px",
    );
    return () => {
      root.style.removeProperty(FREEZONE_DOCK_WIDTH_VAR);
    };
  }, [dockWidth, hostActive, isDesktop, minContentWidth, panelVisible]);

  // 拖宽期间把让位动画压成 0ms：留着 300ms 缓动的话，每一帧都会重排一段新的缓动，
  // 顶栏边缘会像橡皮筋一样吊在抽屉后面。
  useEffect(() => {
    if (!resizing) return;
    const root = document.documentElement;
    root.style.setProperty(FREEZONE_DOCK_TRANSITION_VAR, "0ms");
    return () => {
      root.style.removeProperty(FREEZONE_DOCK_TRANSITION_VAR);
    };
  }, [resizing]);

  if (!isDesktop) {
    return (
      <>
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={open}
          onClick={() => onOpenChange(true)}
        />
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="right"
            className="flex w-full flex-col gap-0 bg-[#212121] p-0 sm:!max-w-[560px]"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              <div className="min-h-0 flex-1">{agentPanels}</div>
              {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
                <div
                  className={cn(
                    "absolute inset-y-0 right-0 z-20 w-[220px] border-l border-white/[0.08] bg-[#212121] shadow-[-16px_0_32px_rgba(0,0,0,0.18)] transition-transform duration-200",
                    agentHistoryOpen ? "translate-x-0" : "translate-x-full",
                  )}
                >
                  {agentHistoryPanel}
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  if (!shouldRenderPanel) {
    return (
      <FreezoneChatToggleButton
        label={toggleLabel}
        expanded={false}
        onClick={() => onOpenChange(true)}
      />
    );
  }

  // CSS 侧再兜一层：换窗口尺寸、或带着一个宽抽屉从工作流切到故事板时，存下来的
  // 宽度可能已经超额——这里直接压回去，而不是改写用户的宽度偏好。
  const dockMaxWidth = `calc(100vw - ${minContentWidth}px)`;
  // 开合 / 收起历史栏时宽度平滑过渡；拖拽期必须整条关掉——拖的是同一个 width，
  // 留着过渡就等于给每一帧都排一段 300ms 缓动，手感变成「橡皮筋拖后腿」。
  const dockTransition = resizing
    ? "transition-none"
    : "transition-[opacity,transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]";
  const dockStyle = {
    width: dockWidth,
    maxWidth: dockMaxWidth,
    [CHAT_PANE_WIDTH_VAR]: `${chatWidth}px`,
    [AGENT_HISTORY_PANE_WIDTH_VAR]: `${agentHistoryWidth}px`,
  } as CSSProperties;

  return (
    <>
      {!open && (
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={false}
          onClick={() => onOpenChange(true)}
        />
      )}
      {/* 故事板：在 flex 行里占一格，把 <main>(flex-1) 挤窄——抽屉本身仍是绝对定位
          的浮层，正好盖住这一格。这样开合/拖宽只动这个占位块，抽屉内部布局与工作流
          态共用同一份代码。拖拽中关掉宽度过渡，否则跟手会有一帧延迟。 */}
      {pushesContent && (
        <div
          ref={spacerRef}
          aria-hidden="true"
          className={cn(
            "hidden shrink-0 lg:block",
            resizing
              ? "transition-none"
              : "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          )}
          style={{ width: panelVisible ? dockWidth : 0, maxWidth: dockMaxWidth }}
        />
      )}
      <aside
        ref={asideRef}
        className={cn(
          // 贴右边、通屏高（对标 liblib）：fixed 而不是 absolute——抽屉要从屏幕
          // 最顶铺到最底，而不是只占内容区那一段。顶栏/任务面板/底部状态条不靠 z 压，
          // 是靠 --freezone-dock-width 自己整条往左收（见 dockOffset），两边宽度用同一个
          // clamp，稳态下压根不重叠。
          // z 必须 <50：shadcn 的浮层（下拉/选择/气泡/提示/弹窗）都 portal 到 body 且
          // 定位层是 isolate z-50，抽屉一旦到 50 以上，抽屉内所有菜单都会被自己的实底
          // 盖住 —— 表现就是「点了没反应」。45 只要高过任务面板(z-40)与其遮罩(z-30)即可。
          "fixed inset-y-0 right-0 z-[45] hidden flex-col overflow-hidden border-l border-white/[0.12] shadow-none lg:flex",
          // 实底 #212121（用户指定）：比故事板面板的 #262626 再深一档，agent 抽屉不再是半透明
          // 毛玻璃。顺带把 backdrop-blur-2xl 一起去掉——通高的大半径模糊每帧都要
          // 重新光栅化，是拖宽「跟不上手」的主因，实底之后它也没有可模糊的东西了。
          "bg-[#212121]",
          dockTransition,
          panelVisible ? "translate-x-0 opacity-100" : "translate-x-10 opacity-0",
          !panelVisible && "pointer-events-none",
        )}
        style={dockStyle}
        aria-label={title}
      >
        {/* 命中区整条压在面板内侧（12px）：外壳是 overflow-hidden，把手往画布那侧
            平移出去的部分会被裁掉——连同命中区一起裁，原来 -translate-x-1 的写法
            实际只剩 4px 能抓，这也是「拖起来别扭」的一半原因。
            视觉只是贴着左描边的一条细线：hover 加粗提亮、拖拽中保持高亮。 */}
        <div
          className="group absolute inset-y-0 left-0 z-30 flex w-3 cursor-col-resize touch-none items-stretch justify-start"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整聊天宽度"
          title="调整聊天宽度"
          onPointerDown={(event) => startPaneResize("chat", event)}
        >
          <span
            className={cn(
              "h-full w-px transition-[width,background-color,opacity] duration-150 ease-out",
              resizingPane === "chat"
                ? "w-[3px] bg-white/45 opacity-100"
                : "bg-white/25 opacity-0 group-hover:w-[3px] group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          />
        </div>
        {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" />}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 shrink-0" style={{ width: `var(${CHAT_PANE_WIDTH_VAR})` }}>
            {agentPanels}
          </div>
          {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && agentHistoryOpen && (
            <div
              className="group relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-white/[0.03] transition-colors hover:bg-white/[0.08]"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整历史 Agent 宽度"
              title="调整历史 Agent 宽度"
              onPointerDown={(event) => startPaneResize("history", event)}
            >
              <span
                className={cn(
                  "h-full w-px transition-colors",
                  resizingPane === "history" ? "bg-white/45" : "bg-white/14 group-hover:bg-white/35",
                )}
              />
            </div>
          )}
          <div
            className={cn(
              // 与聊天区同底色：靠那条左描边分栏就够了。旧的 zinc-950/45 是叠在
              // 半透明抽屉上的一层压暗，抽屉换实底后它会变成一块明显更黑的侧栏。
              "min-h-0 overflow-hidden border-l border-white/[0.08] bg-[#212121]",
              // 与外壳同一条时间线：收起/展开一起走 300ms，拖拽期一起关掉。
              resizing
                ? "transition-none"
                : "transition-[width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              agentHistoryOpen ? "opacity-100" : "w-0 opacity-0",
            )}
            style={{ width: agentHistoryOpen ? `var(${AGENT_HISTORY_PANE_WIDTH_VAR})` : 0 }}
            aria-hidden={!agentHistoryOpen}
          >
            {agentHistoryPanel}
          </div>
        </div>
      </aside>
    </>
  );
}

function FreezoneAgentHistoryPanel({
  agents,
  activeAgentId,
  search,
  onSearchChange,
  onSelect,
  onAdd,
}: {
  agents: FreezoneCanvasAgentState["agents"];
  activeAgentId: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (agentId: string) => void;
  onAdd: () => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const visibleAgents = agents
    .filter((agent) => {
      if (!normalizedSearch) return true;
      return agent.name.toLowerCase().includes(normalizedSearch) || agent.id.toLowerCase().includes(normalizedSearch);
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-zinc-950/35 p-3">
      <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-white/[0.07] px-3 text-zinc-400">
        <Search className="size-4 shrink-0" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="搜索会话..."
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </label>
      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleAgents.map((agent) => {
          const active = agent.id === activeAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              className={cn(
                // 列表行不是卡片:圆角压到 6px、行高收一档,底色也别拉太亮 —— 0.14 的
                // 填充在近黑面板上是一整块灰,选中态靠左侧竖条认就够了。
                "relative flex min-h-[44px] w-full flex-col items-start justify-center rounded-md px-3 py-2 text-left transition-colors",
                active
                  ? "bg-white/[0.08] text-white before:absolute before:inset-y-2 before:left-0 before:w-px before:rounded-full before:bg-white/70"
                  : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100",
              )}
              title={agent.name}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    active ? "bg-emerald-400" : "bg-zinc-600",
                  )}
                />
                <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
              </span>
              <span className="ml-4 mt-0.5 text-[11px] leading-none text-zinc-500">
                {formatAgentHistoryTime(agent.createdAt)}
              </span>
            </button>
          );
        })}
        {visibleAgents.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-zinc-500">
            没有匹配的 Agent
          </div>
        )}
      </div>
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3 h-9 shrink-0 rounded-lg bg-white/[0.10] text-sm text-zinc-100 hover:bg-white/[0.16]"
          onClick={onAdd}
        >
          <Plus className="mr-1.5 size-4" />
          新建 Agent
        </Button>
      )}
    </div>
  );
}

function formatAgentHistoryTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

/**
 * 虾导入口的位置（相对容器右下角的 right/bottom 偏移，px）。
 * 注意 key 不用 `supertale-` 前缀——那个前缀会被 reset-region-state 的
 * localStorage 清扫误删；这只是个 UI 位置偏好，跨区域保留没问题。
 */
const CHAT_LAUNCHER_POS_STORAGE_KEY = "st.freezone.chatLauncherPos";
const CHAT_LAUNCHER_SIZE = 58;
const CHAT_LAUNCHER_MARGIN = 8;
/** 默认抬到 MiniMap（约 150px 高 + 15px 边距）上方，避免挡住画布缩略图。 */
const CHAT_LAUNCHER_DEFAULT_POS = { right: 16, bottom: 180 };
const CHAT_LAUNCHER_DRAG_THRESHOLD = 4;

function loadChatLauncherPos(): { right: number; bottom: number } {
  try {
    const raw = window.localStorage.getItem(CHAT_LAUNCHER_POS_STORAGE_KEY);
    if (!raw) return CHAT_LAUNCHER_DEFAULT_POS;
    const parsed = JSON.parse(raw) as { right?: unknown; bottom?: unknown };
    if (typeof parsed.right === "number" && typeof parsed.bottom === "number") {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // ignore malformed storage
  }
  return CHAT_LAUNCHER_DEFAULT_POS;
}

function FreezoneChatToggleButton({
  label,
  expanded,
  onClick,
}: {
  label: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [motionActive, setMotionActive] = useState(false);
  const [entered, setEntered] = useState(false);
  const [pos, setPos] = useState(loadChatLauncherPos);
  // 拖拽后抑制紧随 pointerup 的 click，避免拖完顺手把面板打开。
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // 挂载时把存下来的位置钳回容器内——窗口缩小后旧坐标可能在可视区外，
  // 按钮一旦飞出去就再也拖不回来了。
  useEffect(() => {
    const parent = buttonRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const maxRight = rect.width - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN;
    const maxBottom = rect.height - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN;
    setPos((current) => {
      const clamped = {
        right: Math.min(Math.max(current.right, CHAT_LAUNCHER_MARGIN), maxRight),
        bottom: Math.min(Math.max(current.bottom, CHAT_LAUNCHER_MARGIN), maxBottom),
      };
      return clamped.right === current.right && clamped.bottom === current.bottom
        ? current
        : clamped;
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const parent = buttonRef.current?.offsetParent as HTMLElement | null;
      const parentRect = parent?.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        right: pos.right,
        bottom: pos.bottom,
      };
      let dragged = false;
      let latest = { right: pos.right, bottom: pos.bottom };

      const clamp = (value: number, max: number) =>
        Math.min(Math.max(value, CHAT_LAUNCHER_MARGIN), max);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!dragged && Math.hypot(dx, dy) < CHAT_LAUNCHER_DRAG_THRESHOLD) return;
        dragged = true;
        const maxRight = parentRect
          ? parentRect.width - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN
          : Number.MAX_SAFE_INTEGER;
        const maxBottom = parentRect
          ? parentRect.height - CHAT_LAUNCHER_SIZE - CHAT_LAUNCHER_MARGIN
          : Number.MAX_SAFE_INTEGER;
        latest = {
          right: clamp(start.right - dx, maxRight),
          bottom: clamp(start.bottom - dy, maxBottom),
        };
        setPos(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (dragged) {
          suppressClickRef.current = true;
          try {
            window.localStorage.setItem(
              CHAT_LAUNCHER_POS_STORAGE_KEY,
              JSON.stringify(latest),
            );
          } catch {
            // storage full / unavailable — position just won't persist
          }
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pos.bottom, pos.right],
  );

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick();
  }, [onClick]);

  const playMotion = useCallback(() => {
    const video = videoRef.current;
    setMotionActive(true);
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  }, []);

  const stopMotion = useCallback(() => {
    const video = videoRef.current;
    setMotionActive(false);
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, []);

  return (
    <Button
      ref={buttonRef}
      type="button"
      size="icon-lg"
      variant="secondary"
      className={cn(
        "absolute z-50 size-[58px] cursor-grab touch-none overflow-hidden rounded-full border-0 bg-transparent p-0 shadow-lg brightness-110 transition-[opacity,transform] duration-200 ease-out hover:scale-[1.03] active:cursor-grabbing",
        entered ? "opacity-100" : "opacity-0",
      )}
      style={{ right: pos.right, bottom: pos.bottom }}
      aria-label={label}
      aria-expanded={expanded}
      onMouseEnter={playMotion}
      onMouseLeave={stopMotion}
      onFocus={playMotion}
      onBlur={stopMotion}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <img
        src="/images/avatar-claw.png"
        alt=""
        className={cn(
          "absolute inset-0 size-full rounded-full object-cover transition-opacity duration-[350ms] ease-out",
          motionActive ? "opacity-0" : "opacity-100",
        )}
        aria-hidden="true"
      />
      <video
        ref={videoRef}
        src="/images/avatar-motion.mp4"
        muted
        loop
        playsInline
        preload="metadata"
        className={cn(
          "absolute inset-0 size-full rounded-full object-cover brightness-90 saturate-95 transition-opacity duration-[350ms] ease-out",
          motionActive ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
    </Button>
  );
}

function normalizePushTarget(
  target: (Partial<PushTarget> & { kind?: PushTargetKind }) | null,
): (Partial<PushTarget> & { kind: PushTargetKind }) | null {
  if (!target?.kind) return null;
  return target as Partial<PushTarget> & { kind: PushTargetKind };
}

function refreshCommittedTargetNodes(
  target: PushTarget,
  result: PushResult,
): void {
  if (!shouldRefreshCommittedTargetNodes(target)) return;
  const targetUrl = result.target_url;
  if (!targetUrl) return;
  const previewUrl = withImageCacheBust(targetUrl, Date.now());

  const store = useCanvasStore.getState();
  for (const node of store.nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>;
    if (data.user_spawned === true) continue;
    const sourceMeta = data.__freezone_source as
      | { kind?: string; role?: string; meta?: Record<string, unknown> }
      | undefined;
    const nodeTarget =
      coerceSlotTarget(data.slot_target) ??
      inferCanonicalRefreshTarget(sourceMeta);
    if (!nodeTarget || !pushTargetsEqual(nodeTarget, target)) continue;

    const baseUpdate =
      target.kind === "video"
        ? { videoUrl: targetUrl, previewImageUrl: previewUrl }
        : target.kind === "beat_audio"
          ? { audioUrl: targetUrl, url: targetUrl }
          : isPlyOrGlbPushTargetKind(target.kind)
            ? { fileUrl: targetUrl, modelUrl: targetUrl, plyUrl: targetUrl, url: targetUrl }
            : { imageUrl: targetUrl, previewImageUrl: previewUrl };
    store.updateNodeData(node.id, {
      ...baseUpdate,
      committed_slot_url: targetUrl,
    } as Record<string, unknown>);
  }
}

function markCommitCandidatePushed(
  nodeId: string,
  target: PushTarget,
  result: PushResult,
): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  const data = (node?.data ?? {}) as Record<string, unknown>;
  if (!isCommitCandidateData(data)) return;
  const slot = coerceSlotTarget(data.slot_target);
  if (!slot || !pushTargetsEqual(slot, target)) return;

  const update: Record<string, unknown> = {
    committed_at: new Date().toISOString(),
  };
  if (typeof result.target_url === "string" && result.target_url.length > 0) {
    update.committed_slot_url = result.target_url;
  }
  store.updateNodeData(nodeId, update);
}

function inferCanonicalRefreshTarget(
  source:
    | { kind?: string; role?: string; meta?: Record<string, unknown> }
    | undefined,
): (Partial<PushTarget> & { kind: PushTargetKind }) | undefined {
  if (!source?.kind) return undefined;
  return inferDefaultTarget(source);
}

function pushTargetsEqual(
  a: Partial<PushTarget> & { kind: PushTargetKind },
  b: PushTarget,
): boolean {
  if (a.kind !== b.kind) return false;
  const av = a as Record<string, unknown>;
  if (
    b.kind === "frame" ||
    b.kind === "sketch" ||
    b.kind === "director_render" ||
    b.kind === "selected_background" ||
    b.kind === "video" ||
    b.kind === "beat_audio"
  ) {
    return av.episode === b.episode && av.beat === b.beat;
  }
  if (
    b.kind === "identity" ||
    b.kind === "identity_costume" ||
    b.kind === "identity_portrait"
  ) {
    return av.character === b.character && av.identity_id === b.identity_id;
  }
  if (b.kind === "portrait") {
    return av.character === b.character;
  }
  if (isScenePushTargetKind(b.kind)) {
    return av.scene_id === (b as unknown as Record<string, unknown>).scene_id;
  }
  if (b.kind === "prop_ref") {
    return av.prop_id === b.prop_id;
  }
  return false;
}

function defaultCharacterFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const preset = metadata?.preset as { character?: unknown } | undefined;
  return typeof preset?.character === "string" && preset.character ? preset.character : null;
}

interface PushPrompt {
  nodeId: string;
  sourceUrl: string;
  previewUrl: string | null;
  sourceLabel: string;
  mediaType: DropMediaType;
  defaultTarget?: Partial<PushTarget> & { kind: PushTargetKind };
  directorControlBundle?: Record<string, unknown> | null;
  nodeData?: Record<string, unknown> | null;
}

interface SelectedImageSummary {
  nodeId: string;
  imageUrl: string;
  previewUrl: string | null;
  defaultTarget?: Partial<PushTarget> & { kind: PushTargetKind };
  label: string;
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="absolute left-1/2 top-16 z-40 max-w-md -translate-x-1/2 rounded-lg border border-border-default bg-surface/95 px-4 py-2 text-sm text-text shadow-xl backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="break-words flex-1 min-w-0">{text}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-text-muted hover:text-text text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function CanvasConflictOverlay({
  error,
  canvasId,
  onRefresh,
  onSaveCopy,
  readConflictSnapshot,
}: {
  error: string | null;
  canvasId: string;
  onRefresh: () => void;
  onSaveCopy: () => Promise<void>;
  readConflictSnapshot: () => ConflictSnapshot | null;
}) {
  const { t } = useTranslation();
  const [savingCopy, setSavingCopy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Read once on mount so the "下载本地 JSON" button always renders against
  // the snapshot captured at the moment the 409 fired, even if a later save
  // would have rewritten it.
  const snapshot = useMemo(() => readConflictSnapshot(), [readConflictSnapshot]);

  const handleDownload = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = snapshot.timestamp
      ? snapshot.timestamp.replace(/[:.]/g, "-")
      : new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `freezone-${canvasId}-conflict-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="absolute inset-0 z-50 bg-bg-dark/60 flex items-center justify-center">
      <div className="px-4 py-3 rounded-lg bg-surface border border-amber-400/50 text-sm text-amber-100 max-w-md flex flex-col gap-3">
        <div className="font-medium">画布保存冲突</div>
        <div className="text-text-muted">
          {error ?? "画布已被其他窗口或用户修改。刷新会丢弃当前本地未保存修改，另存为副本会保留当前画布。"}
        </div>
        {snapshot && (
          <div className="text-[11px] text-text-muted/80">
            本地未保存修改已暂存到浏览器，可下载备份后再决定是否刷新。
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="px-3 py-1 rounded-md border border-amber-400/40 text-amber-100 hover:bg-amber-400/10 transition-colors"
          >
            刷新
          </button>
          <button
            type="button"
            disabled={savingCopy || !snapshot}
            onClick={() => {
              setSavingCopy(true);
              setCopyError(null);
              onSaveCopy()
                .catch((err) => {
                  setCopyError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setSavingCopy(false));
            }}
            className="px-3 py-1 rounded-md border border-cyan-300/45 bg-cyan-400/18 text-cyan-50 shadow-[0_0_18px_rgba(34,211,238,0.12)] transition-colors hover:border-cyan-200/70 hover:bg-cyan-400/28 disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-white/30 disabled:shadow-none"
            title={snapshot ? undefined : t("freezone.canvases.noConflictSnapshot")}
          >
            {savingCopy ? "保存中..." : "另存为副本"}
          </button>
          {snapshot && (
            <button
              type="button"
              onClick={handleDownload}
              className="px-3 py-1 rounded-md border border-[var(--ui-border-soft)] text-text hover:bg-bg-dark/50 transition-colors"
              title={`下载本地修改快照（${snapshot.nodes.length} 节点 · ${snapshot.edges.length} 连线）`}
            >
              下载本地 JSON
            </button>
          )}
        </div>
        {copyError && (
          <div className="text-[11px] text-red-300">
            {copyError}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Lightweight indicator for the backend's `backup_status` channel. Only
 * renders for `pending` (still uploading to OSS) and `failed` (local save is
 * durable but OSS replication did not stick); `synced` / `disabled` / `null`
 * stay silent so the canvas does not gain chrome for the happy path.
 *
 * The badge floats above ReactFlow's bottom-right zoom controls
 * (`bottom-3 right-3` is taken by `MiniMap`; the offset puts us just
 * above it without overlapping).
 */
function BackupStatusIndicator({
  status,
}: {
  status: import("@/api/canvas").CanvasBackupStatus | null;
}) {
  if (status !== "pending" && status !== "failed") {
    return null;
  }
  const isFailed = status === "failed";
  const label = isFailed ? "云端备份失败" : "云端备份中";
  const detail = isFailed
    ? "本地修改已保存，但云端备份未完成。请保留页面，稍后会自动重试。"
    : "本地修改已保存，云端备份还在同步中。可以继续编辑。";
  const palette = isFailed
    ? "border-red-500/45 bg-red-500/10 text-red-200"
    : "border-amber-300/40 bg-amber-300/10 text-amber-100";
  const dot = isFailed ? "bg-red-400" : "bg-amber-300 animate-pulse";
  return (
    <div
      role={isFailed ? "alert" : "status"}
      className={`absolute bottom-16 right-3 z-30 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-none shadow-sm ${palette}`}
      title={detail}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </div>
  );
}

function CanvasLoadingScreen() {
  return (
    <div className="w-full h-full flex items-center justify-center text-text-muted text-sm">
      正在加载画布...
    </div>
  );
}

function CanvasLoadingOverlay() {
  // hydrate 还在飞时画布上的编辑既不会入队保存，也会被随后的 setCanvasData(remote)
  // 整个盖掉。所以这层遮罩必须真的吃掉指针事件，不能只是视觉上蒙一层。
  return (
    <div
      className="absolute inset-0 z-20 cursor-wait bg-bg-dark/10 backdrop-blur-[1px]"
      aria-hidden="true"
    />
  );
}

function CanvasErrorOverlay({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-bg-dark/45 px-6">
      <div className="flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-red-400/25 bg-red-950/[0.14] px-4 py-3 text-sm shadow-[0_18px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="font-medium text-red-200">画布同步失败</div>
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs leading-5 text-red-100/75">
          {error}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-red-300/25 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-100/80 transition-colors hover:border-red-200/40 hover:bg-red-500/10 hover:text-red-50"
        >
          重试
        </button>
      </div>
    </div>
  );
}
