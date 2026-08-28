// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Canvas } from "@/features/canvas/Canvas";
import { NodeReplaceDragPreview } from "@/features/canvas/ui/NodeReplaceDragPreview";
import type { SupertaleProjectSummary } from "@/api/projects";
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
import { SuperChatPanel } from "@/features/superchat/superchat-panel";
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
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";

export { hasLegacyPresetCanvasMetadata } from "@/features/freezone/projections";

interface FreezoneShellProps {
  project: SupertaleProjectSummary;
  canvasId: string;
}

const FREEZONE_CHAT_WIDTH = "clamp(500px, 34vw, 540px)";
const PROJECTION_STATUS_REFRESH_MS = 30_000;

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
  project,
  hydratedProject,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
  /** 省略即不校验项目（旧调用方 / 单画布场景）。 */
  project?: string;
  hydratedProject?: string | null;
}): boolean {
  // 个人画布跨项目同 id，只比 canvasId 认不出「还停在上一个项目的数据上」。
  if (project !== undefined && hydratedProject !== project) return true;
  return hydratedCanvasId !== canvasId || projectionKeyCount === 0;
}

export function shouldFetchProjectionStatuses({
  canvasId,
  hydratedCanvasId,
  projectionKeyCount,
  revision,
  sessionExpired = false,
  syncStatus,
  project,
  hydratedProject,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
  revision: number | null;
  sessionExpired?: boolean;
  syncStatus: CanvasSyncStatus;
  project?: string;
  hydratedProject?: string | null;
}): boolean {
  if (sessionExpired) return false;
  if (shouldClearProjectionStatuses({
    canvasId,
    hydratedCanvasId,
    projectionKeyCount,
    project,
    hydratedProject,
  })) {
    return false;
  }
  return syncStatus === "ready" && revision != null;
}

export function shouldSkipProjectionStatusRevision({
  canvasId,
  revision,
  refreshToken,
  lastChecked,
  project,
}: {
  canvasId: string;
  revision: number;
  refreshToken: number;
  lastChecked: {
    canvasId: string;
    revision: number;
    refreshToken: number;
    project?: string;
  } | null;
  project?: string;
}): boolean {
  if (lastChecked?.canvasId !== canvasId) return false;
  // revision 是每张画布自己的小整数，跨项目撞号是常事；不比项目就会把「上一个
  // 项目已经查过 rev 5」当成「这个项目的 rev 5 也查过」，真正的拉取被跳掉。
  if (project !== undefined && lastChecked.project !== project) return false;
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

export function FreezoneShell({ project, canvasId }: FreezoneShellProps) {
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
  const [chatOpen, setChatOpen] = useState(false);
  const productSurfaces = useProductSurfaces();
  const showChatDock = Boolean(
    surfaceAccess(productSurfaces.data, "freezone_assistant")?.available,
  );
  // Re-entrancy guard for in-flight projection sync/remove lives in the refs;
  // there is no UI bound to a syncing/removing value, so no state is kept.
  const syncingProjectionRef = useRef<string | null>(null);
  const removingProjectionRef = useRef<string | null>(null);
  // 顶栏在「虾画 / 虾集」之间切换会整体卸载再挂载本组件，但画布数据留在全局 store 里。
  // 如果这里从 false 起步，回到虾画就会先把画面换成「正在加载画布…」，等 hydrate 回来
  // 才重新画出来 —— 看着就是卡。同一个画布重进时直接渲染 store 里的既有内容，
  // hydrate 期间只叠一层轻量 overlay。
  //
  // 存的是「已经画出来的是哪一张」而不是一个 boolean：本组件没有 key，换画布走的是
  // 同一个实例重跑 effect，用 boolean 的话它一旦为 true 就再也回不去，于是切到新画布
  // 时旧画布的几百个节点会一直挂在屏幕上（只蒙一层半透明遮罩），直到新内容替换上来
  // ——「卸旧的」和「挂新的」并进同一次提交，这正是切换卡顿的主因。按画布记之后，
  // 换画布这一帧立刻回到全屏 loading，卸载与挂载被拆成两次提交。
  const currentCanvasKey = canvasKey(projectId, canvasId);
  const [renderedCanvasKey, setRenderedCanvasKey] = useState<string | null>(() =>
    lastRenderedCanvasKey === currentCanvasKey &&
    useCanvasStore.getState().nodes.length > 0
      ? currentCanvasKey
      : null,
  );
  if (renderedCanvasKey !== null && renderedCanvasKey !== currentCanvasKey) {
    // render 阶段同组件 setState 是 React 认可的「派生状态」写法，本次提交即生效。
    setRenderedCanvasKey(null);
  }
  const hasRenderedCanvas = renderedCanvasKey === currentCanvasKey;
  const [projectionStatusRefreshToken, setProjectionStatusRefreshToken] = useState(0);
  const [projectionMonitoringExpired, setProjectionMonitoringExpired] = useState(false);
  const lastProjectionStatusRevisionRef = useRef<{
    canvasId: string;
    revision: number;
    refreshToken: number;
    project: string;
  } | null>(null);
  // 这三处 projection 状态本来靠「换项目必然 remount」复位；_app.tsx 把项目 id 从
  // routeTransitionKey 里摘掉之后 freezone 不再重挂，只能自己按 项目+画布 复位。
  const [projectionScopeKey, setProjectionScopeKey] = useState(currentCanvasKey);
  if (projectionScopeKey !== currentCanvasKey) {
    setProjectionScopeKey(currentCanvasKey);
    setProjectionStatusRefreshToken(0);
    setProjectionMonitoringExpired(false);
    lastProjectionStatusRevisionRef.current = null;
  }
  // 上面这些弹窗/浮层状态装的是「项目 A 的某个素材」，同样靠 remount 复位。不再
  // 重挂之后，如果开着提交 / 建身份 / 蒙版面板用浏览器前进后退切到项目 B，面板
  // 会继续摆着 A 的素材，可提交按钮拿到的却是新的 projectId —— 等于把 A 的资源
  // 写进 B。换项目就一律关掉，换画布不动（换画布本来就不重挂，行为没变）。
  const [projectScopeId, setProjectScopeId] = useState(projectId);
  if (projectScopeId !== projectId) {
    setProjectScopeId(projectId);
    setPushState(null);
    setComparePair(null);
    setCreateIdentitySource(null);
    setMaskTarget(null);
    setToast(null);
  }

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

  const handleBlankPaneClick = useCallback(() => {
    setAssetPanelCollapsed(true);
    setDebugPanelOpen(false);
    setChatOpen(false);
  }, []);

  // Warm the shared image-model store the moment we enter a project, so the
  // request is in-flight before any picker / panel mounts.
  useEffect(() => {
    if (!showChatDock) {
      setChatOpen(false);
    }
  }, [showChatDock]);

  useEffect(() => {
    prefetchFreezoneImageModels(projectId);
    prefetchFreezoneVideoModels(projectId);
    prefetchFreezoneCameraOptions(projectId);
    prefetchFreezoneStyleTemplates(projectId);
    prefetchFreezoneVideoCameraTemplates(projectId);
  }, [projectId]);

  useEffect(() => {
    rememberLastCanvas(projectId, canvasId);
    if (canvasId !== "default" && currentCanvasParam() !== canvasId) {
      writeUrl({ canvas: canvasId }, { replace: true, notify: false });
    }
  }, [canvasId, projectId]);

  useEffect(() => {
    // 必须连 hydratedProject 一起比：个人画布 id 由用户名推出，跨项目是同一个
    // canvasId，而换项目那一次提交里 sync.* 还是上一个项目的值（useCanvasSync 的
    // hydrate effect 只是「排队」把 status 改成 loading，闭包里读到的仍是 ready）。
    // 少比这一项，换项目时会被当成「新画布已经画出来了」，全屏 loading 直接不出现，
    // 露给用户的是刚被清空的画布加一层半透明遮罩。
    if (
      sync.status === "ready" &&
      sync.hydratedCanvasId === canvasId &&
      sync.hydratedProject === projectId
    ) {
      lastRenderedCanvasKey = canvasKey(projectId, canvasId);
      setRenderedCanvasKey(lastRenderedCanvasKey);
    }
  }, [canvasId, projectId, sync.hydratedCanvasId, sync.hydratedProject, sync.status]);

  const projectionKeys = useMemo(
    () => projectionKeysFromMetadata(sync.metadata),
    [sync.metadata],
  );
  useEffect(() => {
    if (projectionMonitoringExpired) return;
    if (!shouldFetchProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      revision: sync.revision,
      sessionExpired: projectionMonitoringExpired,
      syncStatus: sync.status,
      project: projectId,
      hydratedProject: sync.hydratedProject,
    })) {
      return;
    }
    const bump = () => setProjectionStatusRefreshToken((value) => value + 1);
    return startProjectionStatusRefresh(bump, () => {
      setProjectionMonitoringExpired(true);
    });
  }, [
    canvasId,
    projectId,
    projectionMonitoringExpired,
    projectionKeys.length,
    sync.hydratedCanvasId,
    sync.hydratedProject,
    sync.revision,
    sync.status,
  ]);
  useEffect(() => {
    if (projectionMonitoringExpired) return;
    if (shouldClearProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      project: projectId,
      hydratedProject: sync.hydratedProject,
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
      project: projectId,
      hydratedProject: sync.hydratedProject,
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
      project: projectId,
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
            project: projectId,
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
    sync.hydratedProject,
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

  // 不用 status === "loading" 判定：换画布那一帧 status 还停在旧画布的 "ready"，
  // 等 hydrate effect 跑完才翻成 loading，中间那一帧会露出旧画布。改成「只要还没画
  // 出当前这张就挡着」，失败态除外——那两层遮罩要能被看见和点。
  const showBlockingLoading =
    !hasRenderedCanvas && sync.status !== "error" && sync.status !== "conflict";
  const showLoadingOverlay = sync.status === "loading" && hasRenderedCanvas;

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden">
      <div className="relative flex flex-1 min-h-0">
        <main className="relative h-full min-w-0 flex-1">
          <Canvas
            onBlankPaneClick={handleBlankPaneClick}
            controlsPlacement="bottom-right"
          />
          {showBlockingLoading && <CanvasLoadingScreen />}
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
        </main>
        {showChatDock && (
          <FreezoneChatDock
            open={chatOpen}
            onOpenChange={setChatOpen}
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
  open,
  onOpenChange,
  title,
  description,
  toggleLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  toggleLabel: string;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [shouldRenderPanel, setShouldRenderPanel] = useState(open);
  const [panelVisible, setPanelVisible] = useState(open);

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
    setPanelVisible(false);
    const timeout = window.setTimeout(() => setShouldRenderPanel(false), 320);
    return () => window.clearTimeout(timeout);
  }, [isDesktop, open]);

  if (!isDesktop) {
    return (
      <>
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={open}
          onClick={() => onOpenChange(true)}
        />
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:!max-w-[560px]">
            <SheetHeader className="sr-only">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <SuperChatPanel variant="freezone" onRequestClose={() => onOpenChange(false)} />
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

  return (
    <>
      {!open && (
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={false}
          onClick={() => onOpenChange(true)}
        />
      )}
      <aside
        className={cn(
          "absolute bottom-4 right-4 top-4 z-40 hidden origin-right flex-col overflow-hidden rounded-[14px] border border-white/[0.12] bg-zinc-950/55 shadow-none backdrop-blur-2xl transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:flex",
          panelVisible ? "translate-x-0 scale-100 opacity-100" : "translate-x-10 scale-[0.985] opacity-0",
        )}
        style={{
          width: FREEZONE_CHAT_WIDTH,
          maxWidth: "calc(100vw - 360px)",
        }}
        aria-label={title}
      >
        <SuperChatPanel variant="freezone" onRequestClose={() => onOpenChange(false)} />
      </aside>
    </>
  );
}

/**
 * 虾导入口的位置（相对容器右下角的 right/bottom 偏移，px）。
 * 注意 key 不用 `supertale-` 前缀——那个前缀会被 reset-region-state 的
 * localStorage 清扫误删；这只是个 UI 位置偏好，跨区域保留没问题。
 */
const CHAT_LAUNCHER_POS_STORAGE_KEY = "st.freezone.chatLauncherPos";
const CHAT_LAUNCHER_VISUAL_WIDTH = 96;
const CHAT_LAUNCHER_VISUAL_HEIGHT = 35;
const CHAT_LAUNCHER_HIT_HEIGHT = 44;
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
    const maxRight = Math.max(
      CHAT_LAUNCHER_MARGIN,
      rect.width - CHAT_LAUNCHER_VISUAL_WIDTH - CHAT_LAUNCHER_MARGIN,
    );
    const maxBottom = Math.max(
      CHAT_LAUNCHER_MARGIN,
      rect.height - CHAT_LAUNCHER_HIT_HEIGHT - CHAT_LAUNCHER_MARGIN,
    );
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
          ? Math.max(
              CHAT_LAUNCHER_MARGIN,
              parentRect.width - CHAT_LAUNCHER_VISUAL_WIDTH - CHAT_LAUNCHER_MARGIN,
            )
          : Number.MAX_SAFE_INTEGER;
        const maxBottom = parentRect
          ? Math.max(
              CHAT_LAUNCHER_MARGIN,
              parentRect.height - CHAT_LAUNCHER_HIT_HEIGHT - CHAT_LAUNCHER_MARGIN,
            )
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
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  }, []);

  const stopMotion = useCallback(() => {
    const video = videoRef.current;
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
        "group/xia-dao absolute z-50 cursor-grab touch-none overflow-visible border-0 bg-transparent p-0 transition-opacity duration-200 ease-out hover:bg-transparent active:cursor-grabbing",
        entered ? "opacity-100" : "opacity-0",
      )}
      style={{
        right: pos.right,
        bottom: pos.bottom,
        width: CHAT_LAUNCHER_VISUAL_WIDTH,
        height: CHAT_LAUNCHER_HIT_HEIGHT,
      }}
      aria-label={label}
      aria-expanded={expanded}
      onMouseEnter={playMotion}
      onMouseLeave={stopMotion}
      onFocus={playMotion}
      onBlur={stopMotion}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <video
        ref={videoRef}
        src="/images/xia-dao-launcher.mp4"
        muted
        loop
        playsInline
        preload="auto"
        className="pointer-events-none absolute left-0 top-1/2 w-full -translate-y-1/2 rounded-[6px] object-cover brightness-[1.08] saturate-[1.02] shadow-[0_4px_10px_rgba(0,0,0,0.2)] transition-[filter] duration-200 ease-out group-hover/xia-dao:brightness-[1.16] group-focus-visible/xia-dao:brightness-[1.16]"
        style={{ height: CHAT_LAUNCHER_VISUAL_HEIGHT }}
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
    <div className="absolute left-1/2 top-6 z-40 max-w-md -translate-x-1/2 rounded-lg border border-border-default bg-surface/95 px-4 py-2 text-sm text-text shadow-xl backdrop-blur">
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
    <div className="absolute inset-0 bg-bg-dark/60 flex items-center justify-center">
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

/**
 * 换画布期间的全屏遮挡层。
 *
 * 刻意做成盖在 Canvas 之上的不透明层，而不是把 Canvas 换掉：ReactFlow 实例必须
 * 一直活着，hydrate 才能在挂节点之前先把相机摆到新画布的位置（见 useCanvasSync
 * 的 savedViewport 一段）。同时它也吃掉指针事件——底下的画布这会儿是空的，任何
 * 落到它身上的操作都会被随后的 setCanvasData 盖掉。
 */
function CanvasLoadingScreen() {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-dark cursor-wait text-text-muted text-sm">
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
    <div className="absolute inset-0 flex items-center justify-center bg-bg-dark/45 px-6">
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
