// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Database,
  FolderOpen,
  Package,
  RefreshCw,
  UserRound,
} from "lucide-react";

import {
  createCanvasFromPreset,
  getFreezoneCanvas,
  type FreezonePresetCanvasRequest,
} from "@/api/canvas";
import {
  listFreezoneBeatContext,
  updateBeat,
  type BeatUpdatePayload,
} from "@/api/projects";
import {
  type BeatContextNodeData,
  type CanvasEdge,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import {
  isPresetManagedEdge,
  isPresetManagedNode,
} from "@/features/canvas/domain/mainlineNodeFlags";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { useCanvasStore } from "@/stores/canvasStore";
import { NodeContextBadges } from "@/features/freezone/context/NodeContextBadges";
import { getFreezoneCanvasMetadata } from "@/features/freezone/canvasMetadataContext";
import {
  applyRemoteFreezoneCanvas,
  flushFreezoneCanvasRuntime,
} from "@/features/freezone/canvasSyncRuntime";
import { extractMainlineContextsFromNode } from "@/features/freezone/context/mainlineContext";
import { buildBeatContextNodeRefreshPatch } from "@/features/freezone/context/beatContextSnapshot";
import { syncBeatContextMainlineEdges } from "@/features/freezone/context/beatContextProjection";
import { parseBeatContextVisualMarkers } from "@/features/freezone/context/currentBeatContext";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { useEpisodeBeats, useEpisodeDetail } from "@/lib/queries/episodes";
import { queryKeys } from "@/lib/query-keys";
import { sceneNameToRef, sceneRefToName } from "@/lib/scene-ref";
import { parseColorValue } from "@/lib/sketch-colors";
import { timeOfDayLabel, timeOfDayOptions } from "@/lib/time-of-day";
import type { TFn } from "@/lib/i18n-types";
import { readUrl } from "@/lib/url-params";
import { UiSelect } from "@/components/ui";

type BeatContextNodeProps = NodeProps & {
  id: string;
  data: BeatContextNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 360;
const MAX_WIDTH = 760;
const MAX_HEIGHT = 900;

const NO_CHARACTER_MARKER = "__NO_CHARACTER__";
const NO_PROP_MARKER = "__NO_PROP__";
const NONE_SENTINEL = "__none__";
const MENTION_LIMIT = 8;
const BEAT_CONTEXT_SELECT_CLASS =
  "!h-8 !rounded-[6px] !border-white/10 !bg-black/20 !px-2 !text-xs !text-amber-50 hover:!border-amber-200/25 focus-visible:!border-amber-300/40";
const BEAT_CONTEXT_SELECT_MENU_CLASS =
  "!z-[260] !border-amber-100/12 !bg-[#17120a] text-amber-50 shadow-[0_14px_34px_rgba(0,0,0,0.5)]";

type MentionKind = "identity" | "prop";

const STANDALONE_ACTOR_COLORS = [
  "#FF00FF",
  "#00FFFF",
  "#CCFF00",
  "#FF6B00",
  "#7C4DFF",
  "#00FF66",
  "#00A2FF",
  "#FFD400",
  "#9D00FF",
  "#00FFCC",
  "#39FF14",
  "#5C6BC0",
] as const;

const STANDALONE_PROP_COLORS = [
  "#B71C1C",
  "#6D4C41",
  "#827717",
  "#1B5E20",
  "#006064",
  "#0D47A1",
  "#311B92",
  "#7B1FA2",
  "#880E4F",
  "#3E2723",
] as const;

interface MentionCandidate {
  kind: MentionKind;
  id: string;
  label: string;
  token: string;
}

interface MentionContext {
  start: number;
  end: number;
  query: string;
}

function stringList(values: unknown): string[] {
  return Array.isArray(values) ? values.map(String).filter(Boolean) : [];
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeSelection(
  current: string[],
  id: string,
  emptyMarker: string,
): string[] {
  const currentReal = current.filter((value) => value && value !== emptyMarker);
  if (id === emptyMarker) {
    return [emptyMarker];
  }
  if (current.includes(id)) {
    const next = currentReal.filter((value) => value !== id);
    return next.length > 0 ? next : [emptyMarker];
  }
  return [...currentReal, id];
}

function addSelection(
  current: string[],
  id: string,
  emptyMarker: string,
): string[] {
  const currentReal = current.filter((value) => value && value !== emptyMarker);
  return currentReal.includes(id) ? currentReal : [...currentReal, id];
}

function detectMention(text: string, caret: number): MentionContext | null {
  const prefix = text.slice(0, caret);
  const match = prefix.match(/@([^\s@{}[\]]*)$/u);
  if (!match) return null;
  const start = prefix.length - match[0].length;
  if (start > 0 && !/[\s，。、“”（）()[\]{}:：;；,]/u.test(prefix[start - 1])) {
    return null;
  }
  return { start, end: caret, query: match[1].toLowerCase() };
}

function dataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function optionalDataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const record = optionalDataRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, String(item)]),
  );
}

function hasMainlineBeatContext(data: BeatContextNodeData): boolean {
  return extractMainlineContextsFromNode({ data }).some(
    (context) => context.kind === "beat",
  );
}

function isStandaloneBeatContextData(data: BeatContextNodeData): boolean {
  if (hasMainlineBeatContext(data)) {
    return false;
  }
  const beatContext = optionalDataRecord(data.beat_context);
  return (
    data.context_scope === "standalone" || beatContext?.source === "standalone"
  );
}

function snapshotForRender(
  data: BeatContextNodeData,
): NonNullable<BeatContextNodeData["snapshot"]> {
  const snapshot = data.snapshot ?? {};
  const beatContext = optionalDataRecord(data.beat_context);
  if (!beatContext || !isStandaloneBeatContextData(data)) {
    return snapshot;
  }
  const visualDescription =
    stringValue(beatContext.visual_description) ?? snapshot.visualDescription;
  const markers = parseBeatContextVisualMarkers(visualDescription ?? "");
  const selectedIdentities = stringList(beatContext.detected_identities).filter(
    (id) => markers.identities.includes(id),
  );
  const selectedProps = stringList(beatContext.detected_props).filter((id) =>
    markers.props.includes(id),
  );
  return {
    ...snapshot,
    visualDescription,
    narrationSegment:
      stringValue(beatContext.narration_segment) ?? snapshot.narrationSegment,
    sceneId: stringValue(beatContext.scene_id) ?? snapshot.sceneId,
    timeOfDay: stringValue(beatContext.time_of_day) ?? snapshot.timeOfDay,
    detectedIdentities: selectedIdentities,
    detectedProps: selectedProps,
    sketchColors: stringMap(beatContext.sketch_colors) ?? snapshot.sketchColors,
    propMarkerColors:
      stringMap(beatContext.prop_marker_colors) ?? snapshot.propMarkerColors,
  };
}

type StandaloneBeatContextPatch = Partial<{
  visual_description: string;
  detected_identities: string[];
  detected_props: string[];
  sketch_colors: Record<string, string>;
  prop_marker_colors: Record<string, string>;
}>;

function standaloneBeatContextPatchFromCurrentData(
  data: BeatContextNodeData,
  patch: StandaloneBeatContextPatch,
): Partial<BeatContextNodeData> {
  const currentBeatContext = optionalDataRecord(data.beat_context) ?? {};
  const nextBeatContext = {
    ...currentBeatContext,
    ...patch,
    schema: stringValue(currentBeatContext.schema) ?? "beat_context.v1",
    source: "standalone",
    // 写进节点 data 的规范标题，界面上显示的那一份由下面的 standaloneTitle 词条给。
    title: stringValue(currentBeatContext.title) ?? "自定义镜头上下文", // i18n-exempt
  };
  const snapshot = {
    ...(data.snapshot ?? {}),
  };
  if (patch.visual_description !== undefined) {
    snapshot.visualDescription = patch.visual_description;
  }
  if (patch.detected_identities !== undefined) {
    snapshot.detectedIdentities = patch.detected_identities;
  }
  if (patch.detected_props !== undefined) {
    snapshot.detectedProps = patch.detected_props;
  }
  if (patch.sketch_colors !== undefined) {
    snapshot.sketchColors = patch.sketch_colors;
  }
  if (patch.prop_marker_colors !== undefined) {
    snapshot.propMarkerColors = patch.prop_marker_colors;
  }
  return {
    beat_context: nextBeatContext,
    content: patch.visual_description ?? data.content,
    snapshot,
    syncStatus: "fresh",
    errorMessage: "",
  };
}

function syncBeatContextMainlineLinks(
  beatContextNodeId: string,
  identities: string[],
  props: string[],
): void {
  const store = useCanvasStore.getState();
  const nextEdges = syncBeatContextMainlineEdges(
    beatContextNodeId,
    identities,
    props,
    store.nodes,
    store.edges,
  );
  if (nextEdges !== store.edges) {
    store.replaceEdges(nextEdges);
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function presetRequestFromMetadata(
  preset: unknown,
): Omit<
  FreezonePresetCanvasRequest,
  "canvas_id" | "overwrite_existing"
> | null {
  if (!preset || typeof preset !== "object") return null;
  const data = preset as Record<string, unknown>;
  const scope = typeof data.scope === "string" ? data.scope : "";
  if (scope !== "episode" && scope !== "beat" && scope !== "asset") return null;
  return {
    scope,
    episode: numberOrNull(data.episode),
    beat: numberOrNull(data.beat),
    primary_slot:
      typeof data.primary_slot === "string" ? data.primary_slot : "render",
    asset_kind: stringOrNull(data.asset_kind),
    character: stringOrNull(data.character),
    identity_id: stringOrNull(data.identity_id),
    asset_id: stringOrNull(data.asset_id),
  };
}

async function restoreCurrentMainlinePresetCanvas(
  projectId: string,
  t: TFn,
): Promise<boolean> {
  const canvasId = readUrl().canvas ?? "default";
  const metadata = getFreezoneCanvasMetadata();
  const request = presetRequestFromMetadata(metadata?.preset);
  if (!request) {
    return false;
  }
  const flushed = await flushFreezoneCanvasRuntime(projectId, canvasId);
  if (flushed === false) {
    throw new Error(t("freezone.canvasSync.unsavedConflictBeforeSync"));
  }
  const localStateBeforeRestore = useCanvasStore.getState();
  const localNodes = localStateBeforeRestore.nodes;
  const localEdges = localStateBeforeRestore.edges;
  const baseline = await getFreezoneCanvas(projectId, canvasId);
  await createCanvasFromPreset(projectId, {
    ...request,
    canvas_id: canvasId,
    overwrite_existing: true,
    base_revision: baseline.revision ?? undefined,
  });
  const remote = await getFreezoneCanvas(projectId, canvasId);
  const appliedBySyncRuntime = applyRemoteFreezoneCanvas(
    projectId,
    canvasId,
    remote,
    (remoteNodes, remoteEdges) =>
      mergeRestoredCanvasWithLocalUserWork(
        remoteNodes,
        remoteEdges,
        localNodes,
        localEdges,
      ),
  );
  if (!appliedBySyncRuntime) {
    const setCanvasData = useCanvasStore.getState().setCanvasData;
    const merged = mergeRestoredCanvasWithLocalUserWork(
      (remote.nodes ?? []) as CanvasNode[],
      (remote.edges ?? []) as CanvasEdge[],
      localNodes,
      localEdges,
    );
    setCanvasData(merged.nodes, merged.edges);
  }
  return true;
}

function isBadAutoProjectionNode(node: CanvasNode): boolean {
  const data = dataRecord(node.data);
  return data.autoBeatContextProjection === true;
}

function isBadAutoProjectionEdge(edge: CanvasEdge): boolean {
  const data = dataRecord(edge.data);
  return data.autoBeatContextProjection === true;
}

function mergeRestoredCanvasWithLocalUserWork(
  remoteNodes: CanvasNode[],
  remoteEdges: CanvasEdge[],
  localNodes: CanvasNode[],
  localEdges: CanvasEdge[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const remoteNodeIds = new Set(remoteNodes.map((node) => node.id));
  const remoteEdgeIds = new Set(remoteEdges.map((edge) => edge.id));
  const preservedNodes = localNodes.filter(
    (node) =>
      !remoteNodeIds.has(node.id) &&
      !isPresetManagedNode(node) &&
      !isBadAutoProjectionNode(node),
  );
  const finalNodeIds = new Set([
    ...remoteNodes.map((node) => node.id),
    ...preservedNodes.map((node) => node.id),
  ]);
  const preservedEdges = localEdges.filter((edge) => {
    if (remoteEdgeIds.has(edge.id)) return false;
    if (isPresetManagedEdge(edge) || isBadAutoProjectionEdge(edge))
      return false;
    return finalNodeIds.has(edge.source) && finalNodeIds.has(edge.target);
  });
  return {
    nodes: [...remoteNodes, ...preservedNodes],
    edges: [...remoteEdges, ...preservedEdges],
  };
}

function mergeBeatRefreshPatch(
  refreshPatch: Partial<BeatContextNodeData>,
  localPatch?: BeatUpdatePayload,
): Partial<BeatContextNodeData> {
  if (!localPatch) return refreshPatch;
  const snapshot = {
    ...(refreshPatch.snapshot ?? {}),
  };
  const beatEditFields = {
    ...(refreshPatch.beat_edit_fields ?? {}),
  };

  if (localPatch.visual_description !== undefined) {
    snapshot.visualDescription = localPatch.visual_description ?? "";
    refreshPatch.content = localPatch.visual_description ?? "";
    beatEditFields.visual_description = localPatch.visual_description ?? "";
  }
  if (localPatch.scene_ref !== undefined) {
    const sceneId = localPatch.scene_ref?.scene_id ?? "";
    const sceneVariantId = localPatch.scene_ref?.variant_id ?? "";
    snapshot.sceneId = sceneId;
    snapshot.sceneVariantId = sceneVariantId;
    beatEditFields.scene_id = sceneId;
    beatEditFields.scene_variant_id = sceneVariantId;
  }
  if (localPatch.time_of_day !== undefined) {
    snapshot.timeOfDay = localPatch.time_of_day ?? "";
    beatEditFields.time_of_day = localPatch.time_of_day ?? "";
  }
  if (localPatch.detected_identities !== undefined) {
    snapshot.detectedIdentities = localPatch.detected_identities ?? [];
    beatEditFields.detected_identities = localPatch.detected_identities ?? [];
  }
  if (localPatch.detected_props !== undefined) {
    snapshot.detectedProps = localPatch.detected_props ?? [];
    beatEditFields.detected_props = localPatch.detected_props ?? [];
  }

  return {
    ...refreshPatch,
    snapshot,
    beat_edit_fields: beatEditFields,
  };
}

function localBeatPatchFromCurrentData(
  data: BeatContextNodeData,
  localPatch: BeatUpdatePayload,
): Partial<BeatContextNodeData> {
  return mergeBeatRefreshPatch(
    {
      content: data.content,
      snapshot: {
        ...(data.snapshot ?? {}),
      },
      beat_edit_fields: {
        ...(data.beat_edit_fields ?? {}),
      },
      syncStatus: "stale",
      errorMessage: "",
    },
    localPatch,
  );
}

function beatUpdatePayloadFromNodeData(
  data: BeatContextNodeData,
): BeatUpdatePayload {
  const snapshot = data.snapshot ?? {};
  const editFields = data.beat_edit_fields ?? {};
  const visualDescription = String(
    editFields.visual_description ??
      snapshot.visualDescription ??
      data.content ??
      "",
  );
  const rawSceneId = String(editFields.scene_id ?? snapshot.sceneId ?? "");
  const sceneVariantId = String(
    editFields.scene_variant_id ??
      snapshot.sceneVariantId ??
      "",
  );
  const sceneRef = sceneVariantId
    ? { scene_id: rawSceneId, variant_id: sceneVariantId }
    : sceneNameToRef(rawSceneId);
  const timeOfDay = String(editFields.time_of_day ?? snapshot.timeOfDay ?? "");
  return {
    visual_description: visualDescription,
    scene_ref: sceneRef,
    time_of_day: timeOfDay,
    detected_identities: stringList(
      editFields.detected_identities ?? snapshot.detectedIdentities ?? [],
    ),
    detected_props: stringList(
      editFields.detected_props ?? snapshot.detectedProps ?? [],
    ),
  };
}

function looksLikeEpBeatTitle(value: string): boolean {
  return /^EP(?:\d+|\?)\s*\/\s*Beat\s*(?:\d+|\?)$/iu.test(value);
}

function resolveBeatContextTitle(data: BeatContextNodeData): string {
  const customTitle =
    typeof data.displayName === "string" ? data.displayName.trim() : "";
  if (isStandaloneBeatContextData(data)) {
    const beatContext = optionalDataRecord(data.beat_context);
    const beatContextTitle = stringValue(beatContext?.title)?.trim();
    if (beatContextTitle) {
      return beatContextTitle;
    }
    if (
      customTitle &&
      customTitle !== "Beat Context" &&
      !looksLikeEpBeatTitle(customTitle)
    ) {
      return customTitle;
    }
    return "自定义镜头上下文"; // i18n-exempt —— 规范值，渲染时会被 standaloneTitle 词条顶掉
  }
  if (customTitle && customTitle !== "Beat Context") {
    return customTitle;
  }
  const contexts = extractMainlineContextsFromNode({ data });
  const beatContext = contexts.find((ctx) => ctx.kind === "beat");
  const episode =
    typeof data.episode === "number" ? data.episode : beatContext?.episode;
  const beat = typeof data.beat === "number" ? data.beat : beatContext?.beat;
  const epLabel = typeof episode === "number" ? `EP${episode}` : "EP?";
  const beatLabel = typeof beat === "number" ? `Beat ${beat}` : "Beat ?";
  return `${epLabel} / ${beatLabel}`;
}

function resolveWorkbenchTarget(
  data: BeatContextNodeData,
): { scope: "beat"; episode: number; beat: number } | null {
  const raw = data.workbench_target;
  if (raw && typeof raw === "object") {
    const target = raw as {
      scope?: unknown;
      episode?: unknown;
      beat?: unknown;
    };
    if (
      target.scope === "beat" &&
      typeof target.episode === "number" &&
      typeof target.beat === "number"
    ) {
      return { scope: "beat", episode: target.episode, beat: target.beat };
    }
  }
  return null;
}

export const BeatContextNode = memo(
  ({ id, data, width, height, selected }: BeatContextNodeProps) => {
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const queryClient = useQueryClient();
    const { t } = useTranslation();
    const resolvedWidth = typeof width === "number" ? width : DEFAULT_WIDTH;
    const resolvedHeight = typeof height === "number" ? height : DEFAULT_HEIGHT;
    const isStandaloneContext = isStandaloneBeatContextData(data);
    const snapshot = useMemo(() => snapshotForRender(data), [data]);
    const contexts = extractMainlineContextsFromNode({ data });
    const titleFromData = resolveBeatContextTitle(data);
    const title =
      isStandaloneContext &&
      // 历史上写进过节点 data 的几种规范标题，认出来就换成当前语言的那一份。
      // i18n-exempt-start
      ["自定义 Beat Context", "自定义 Beat 上下文", "Beat Context", "自定义镜头上下文"].includes(titleFromData)
      // i18n-exempt-end
        ? t("node.beatContextNode.standaloneTitle", { defaultValue: "自定义镜头上下文" })
        : titleFromData;
    const episode =
      typeof data.episode === "number" ? data.episode : contexts[0]?.episode;
    const beat = typeof data.beat === "number" ? data.beat : contexts[0]?.beat;
    const beatContext = contexts.find((ctx) => ctx.kind === "beat");
    const projectId =
      typeof data.projectId === "string"
        ? data.projectId
        : beatContext?.projectId;
    const workbenchTarget = useMemo(() => resolveWorkbenchTarget(data), [data]);
    const persistedSyncStatus =
      data.syncStatus === "syncing" ? "fresh" : (data.syncStatus ?? "fresh");
    const [isSyncing, setIsSyncing] = useState(false);
    const syncStatus = isSyncing ? "syncing" : persistedSyncStatus;
    const [openingWorkbench, setOpeningWorkbench] = useState(false);
    // 每次同步到主线完成后 bump,用于 force-remount 可编辑输入框使其拿到
    // 后端归一后的最新值。
    const [editVersion, setEditVersion] = useState(0);
    const visualInitial = String(
      snapshot.visualDescription || data.content || "",
    );
    const snapshotIdentities = useMemo(
      () => stringList(snapshot.detectedIdentities),
      [snapshot.detectedIdentities],
    );
    const snapshotProps = useMemo(
      () => stringList(snapshot.detectedProps),
      [snapshot.detectedProps],
    );
    const [visualDraft, setVisualDraft] = useState(visualInitial);
    const [identityDraft, setIdentityDraft] =
      useState<string[]>(snapshotIdentities);
    const [propDraft, setPropDraft] = useState<string[]>(snapshotProps);
    const identityColorKey = JSON.stringify(snapshot.sketchColors ?? {});
    const propColorKey = JSON.stringify(snapshot.propMarkerColors ?? {});
    const [identityColorDraft, setIdentityColorDraft] = useState<
      Record<string, string>
    >(() => ({ ...(snapshot.sketchColors ?? {}) }));
    const [propColorDraft, setPropColorDraft] = useState<
      Record<string, string>
    >(() => ({ ...(snapshot.propMarkerColors ?? {}) }));
    const [mentionContext, setMentionContext] = useState<MentionContext | null>(
      null,
    );
    const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
    const sceneInitial = sceneRefToName({
      scene_id: snapshot.sceneId,
      variant_id: snapshot.sceneVariantId,
    });
    const timeInitial = String(snapshot.timeOfDay || "");
    const [sceneDraft, setSceneDraft] = useState(sceneInitial);
    const [timeDraft, setTimeDraft] = useState(timeInitial);
    const visualTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    // episodeQuery 同样只喂编辑面板(identity/prop/scene 菜单),与 beats 一起门控:
    // 未选中不查询,避免视口虚拟化下挂载即请求、卸载即被取消的 499。缓存由画布预取焐热。
    const episodeQuery = useEpisodeDetail(
      projectId ?? "",
      typeof episode === "number" ? episode : 0,
      { enabled: selected === true && !isStandaloneContext },
    );
    // beats 仅用于编辑面板的 scene/time 下拉选项,且只有非 standalone 节点用到。
    // 只在节点被选中(进入编辑)时才拉,避免每个节点在视口虚拟化(onlyRenderVisibleElements)
    // 下挂载即请求、卸载即被取消的 499 循环。缓存由画布挂载时的 prefetch 焐热。
    const beatsQuery = useEpisodeBeats(
      projectId ?? "",
      typeof episode === "number" ? episode : 0,
      { enabled: selected === true && !isStandaloneContext },
    );
    const episodeIdentityIds = useMemo(
      () => stringList(episodeQuery.data?.data?.identity_ids),
      [episodeQuery.data],
    );
    const episodePropIds = useMemo(
      () =>
        (episodeQuery.data?.data?.prop_menu ?? [])
          .map((item) => item.prop_id)
          .filter(Boolean),
      [episodeQuery.data],
    );
    const identityOptions = useMemo(
      () => {
        if (!isStandaloneContext) {
          return [NO_CHARACTER_MARKER, ...episodeIdentityIds];
        }
        const markers = parseBeatContextVisualMarkers(visualDraft.trim());
        return [NO_CHARACTER_MARKER, ...markers.identities];
      },
      [episodeIdentityIds, isStandaloneContext, visualDraft],
    );
    const propOptions = useMemo(
      () => {
        if (!isStandaloneContext) {
          return [NO_PROP_MARKER, ...episodePropIds];
        }
        const markers = parseBeatContextVisualMarkers(visualDraft.trim());
        return [NO_PROP_MARKER, ...markers.props];
      },
      [episodePropIds, isStandaloneContext, visualDraft],
    );
    const sceneOptions = useMemo(() => {
      const options = new Set<string>();
      for (const item of episodeQuery.data?.data?.scene_menu ?? []) {
        if (item.time_of_day?.trim()) continue;
        const sceneId = item.scene_id?.trim();
        if (sceneId) options.add(sceneId);
      }
      for (const beatItem of beatsQuery.data?.data ?? []) {
        const sceneId = (
          sceneRefToName(beatItem.scene_ref) || beatItem.location || ""
        ).trim();
        if (sceneId) options.add(sceneId);
      }
      if (sceneInitial) options.add(sceneInitial);
      return Array.from(options);
    }, [beatsQuery.data, episodeQuery.data, sceneInitial]);
    const sceneRefRecords = useMemo(
      () =>
        (episodeQuery.data?.data?.scene_menu ?? []).map((item) => ({
          scene_id: item.scene_id,
          base_scene_id: item.base_scene_id,
          variant_id: item.variant_id,
          time_of_day: item.time_of_day,
        })),
      [episodeQuery.data],
    );
    const timeOptions = useMemo(() => {
      const beatTimes = (beatsQuery.data?.data ?? []).map(
        (beatItem) => beatItem.time_of_day ?? "",
      );
      return timeOfDayOptions(timeInitial, timeDraft, ...beatTimes);
    }, [beatsQuery.data, timeDraft, timeInitial]);
    const mentionCandidates = useMemo<MentionCandidate[]>(() => {
      if (isStandaloneContext) {
        return [
          {
            kind: "identity" as const,
            id: "identity-template",
            label: t("node.beatContextNode.mention.identity"),
            token: "{{}}",
          },
          {
            kind: "prop" as const,
            id: "prop-template",
            label: t("node.beatContextNode.mention.prop"),
            token: "[[]]",
          },
        ];
      }
      return [
        ...episodeIdentityIds.map((identityId) => ({
          kind: "identity" as const,
          id: identityId,
          label: identityId,
          token: `{{${identityId}}}`,
        })),
        ...episodePropIds.map((propId) => ({
          kind: "prop" as const,
          id: propId,
          label: propId,
          token: `[[${propId}]]`,
        })),
      ];
    }, [episodeIdentityIds, episodePropIds, isStandaloneContext]);
    const filteredMentionCandidates = useMemo(() => {
      if (!mentionContext) return [];
      const query = mentionContext.query;
      return mentionCandidates
        .filter((candidate) => {
          if (!query) return true;
          const haystack = `${candidate.id} ${candidate.label}`.toLowerCase();
          return haystack.includes(query);
        })
        .slice(0, MENTION_LIMIT);
    }, [mentionCandidates, mentionContext]);
    const stopCanvasWheel = useCallback(
      (event: ReactWheelEvent<HTMLDivElement>) => {
        event.stopPropagation();
      },
      [],
    );

    useEffect(() => {
      setVisualDraft(visualInitial);
      setIdentityDraft(snapshotIdentities);
      setPropDraft(snapshotProps);
      setSceneDraft(sceneInitial);
      setTimeDraft(timeInitial);
      setIdentityColorDraft({ ...(snapshot.sketchColors ?? {}) });
      setPropColorDraft({ ...(snapshot.propMarkerColors ?? {}) });
      setMentionContext(null);
    }, [
      editVersion,
      identityColorKey,
      propColorKey,
      sceneInitial,
      snapshotIdentities,
      snapshotProps,
      timeInitial,
      visualInitial,
    ]);

    useEffect(() => {
      if (data.syncStatus === "syncing") {
        updateNodeData(id, { syncStatus: "fresh", errorMessage: "" });
      }
    }, [data.syncStatus, id, updateNodeData]);

    const syncToMainline = useCallback(async () => {
      if (
        !projectId ||
        typeof episode !== "number" ||
        typeof beat !== "number"
      ) {
        updateNodeData(id, {
          syncStatus: "error",
          errorMessage: t("node.beatContextNode.status.missingTargetForSync"),
        });
        return;
      }
      setIsSyncing(true);
      updateNodeData(id, { syncStatus: "fresh", errorMessage: "" });
      try {
        const latestState = useCanvasStore.getState();
        const latestNode = latestState.nodes.find((node) => node.id === id);
        const latestData =
          latestNode?.data && typeof latestNode.data === "object"
            ? (latestNode.data as BeatContextNodeData)
            : data;
        await updateBeat(
          projectId,
          episode,
          beat,
          beatUpdatePayloadFromNodeData(latestData),
        );
        const response = await queryClient.fetchQuery({
          queryKey: queryKeys.freezoneBeatContext(projectId, episode, beat),
          queryFn: ({ signal }) =>
            listFreezoneBeatContext(projectId, { episode, beat, signal }),
          staleTime: 0,
        });
        const latestBeat =
          response.episodes
            .find((ep) => ep.episode === episode)
            ?.beats.find((item) => item.beat === beat) ?? null;
        if (!latestBeat) {
          throw new Error(`EP${episode} Beat ${beat} not found`);
        }
        const refreshPatch = buildBeatContextNodeRefreshPatch(
          projectId,
          latestBeat,
          latestData,
        );
        updateNodeData(id, refreshPatch);
        syncBeatContextMainlineLinks(
          id,
          stringList(refreshPatch.snapshot?.detectedIdentities),
          stringList(refreshPatch.snapshot?.detectedProps),
        );
        await restoreCurrentMainlinePresetCanvas(projectId, t);
        setEditVersion((v) => v + 1);
      } catch (error) {
        updateNodeData(id, {
          syncStatus: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsSyncing(false);
      }
    }, [beat, data, episode, id, projectId, queryClient, updateNodeData]);

    // 编辑 BeatContextNode 字段只更新画布节点草稿；主线技能消费这个草稿。
    // 只有点击“同步到主线”时才写回 DB。
    const handleBeatFieldUpdate = useCallback(
      (patch: BeatUpdatePayload) => {
        if (
          !projectId ||
          typeof episode !== "number" ||
          typeof beat !== "number"
        ) {
          updateNodeData(id, {
            syncStatus: "error",
            errorMessage: t("node.beatContextNode.status.missingTargetForLocal"),
          });
          return;
        }
        const localPatch = localBeatPatchFromCurrentData(data, patch);
        updateNodeData(id, localPatch);
        syncBeatContextMainlineLinks(
          id,
          stringList(localPatch.snapshot?.detectedIdentities),
          stringList(localPatch.snapshot?.detectedProps),
        );
      },
      [beat, data, episode, id, projectId, updateNodeData],
    );

    const patchStandaloneBeatContext = useCallback(
      (patch: StandaloneBeatContextPatch) => {
        updateNodeData(
          id,
          standaloneBeatContextPatchFromCurrentData(data, patch),
        );
      },
      [data, id, updateNodeData],
    );

    const updateMentionContext = useCallback(
      (textarea: HTMLTextAreaElement) => {
        setMentionContext(
          detectMention(
            textarea.value,
            textarea.selectionStart ?? textarea.value.length,
          ),
        );
        setMentionActiveIndex(0);
      },
      [],
    );

    const saveVisualDraft = useCallback(() => {
      const next = visualDraft.trim();
      if (isStandaloneContext) {
        const parsed = parseBeatContextVisualMarkers(next);
        const nextIdentities = parsed.identities.length === 0 || identityDraft.includes(NO_CHARACTER_MARKER)
          ? [NO_CHARACTER_MARKER]
          : identityDraft.filter((value) => parsed.identities.includes(value));
        const nextProps = parsed.props.length === 0 || propDraft.includes(NO_PROP_MARKER)
          ? [NO_PROP_MARKER]
          : propDraft.filter((value) => parsed.props.includes(value));
        setIdentityDraft(nextIdentities);
        setPropDraft(nextProps);
        patchStandaloneBeatContext({
          visual_description: next,
          detected_identities: nextIdentities,
          detected_props: nextProps,
        });
        return;
      }
      if (next !== visualInitial.trim()) {
        void handleBeatFieldUpdate({ visual_description: next });
      }
    }, [
      handleBeatFieldUpdate,
      identityDraft,
      isStandaloneContext,
      patchStandaloneBeatContext,
      propDraft,
      visualDraft,
      visualInitial,
    ]);

    const toggleIdentity = useCallback(
      (identityId: string) => {
        const next = normalizeSelection(
          identityDraft,
          identityId,
          NO_CHARACTER_MARKER,
        );
        setIdentityDraft(next);
        if (isStandaloneContext) {
          patchStandaloneBeatContext({ detected_identities: next });
          return;
        }
        if (!sameList(next, snapshotIdentities)) {
          void handleBeatFieldUpdate({ detected_identities: next });
        }
      },
      [
        handleBeatFieldUpdate,
        identityDraft,
        isStandaloneContext,
        patchStandaloneBeatContext,
        snapshotIdentities,
      ],
    );

    const toggleProp = useCallback(
      (propId: string) => {
        const next = normalizeSelection(propDraft, propId, NO_PROP_MARKER);
        setPropDraft(next);
        if (isStandaloneContext) {
          patchStandaloneBeatContext({ detected_props: next });
          return;
        }
        if (!sameList(next, snapshotProps)) {
          void handleBeatFieldUpdate({ detected_props: next });
        }
      },
      [
        handleBeatFieldUpdate,
        isStandaloneContext,
        patchStandaloneBeatContext,
        propDraft,
        snapshotProps,
      ],
    );

    const updateIdentityColor = useCallback(
      (identityId: string, color: string) => {
        const next = { ...identityColorDraft, [identityId]: color };
        setIdentityColorDraft(next);
        patchStandaloneBeatContext({ sketch_colors: next });
      },
      [identityColorDraft, patchStandaloneBeatContext],
    );

    const updatePropColor = useCallback(
      (propId: string, color: string) => {
        const next = { ...propColorDraft, [propId]: color };
        setPropColorDraft(next);
        patchStandaloneBeatContext({ prop_marker_colors: next });
      },
      [patchStandaloneBeatContext, propColorDraft],
    );

    const insertMention = useCallback(
      (candidate: MentionCandidate) => {
        const textarea = visualTextareaRef.current;
        const caret = textarea?.selectionStart ?? visualDraft.length;
        const context = mentionContext ?? detectMention(visualDraft, caret);
        if (!context) return;

        const before = visualDraft.slice(0, context.start);
        const after = visualDraft.slice(context.end);
        const spacer = after.length > 0 && !after.startsWith(" ") ? " " : "";
        const nextText = `${before}${candidate.token}${spacer}${after}`;
        const nextCaret = isStandaloneContext
          ? before.length + 2
          : before.length + candidate.token.length + spacer.length;
        const patch: BeatUpdatePayload = {
          visual_description: nextText.trim(),
        };

        setVisualDraft(nextText);
        setMentionContext(null);

        if (isStandaloneContext) {
          window.requestAnimationFrame(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextCaret, nextCaret);
          });
          patchStandaloneBeatContext({ visual_description: nextText.trim() });
          return;
        }

        if (candidate.kind === "identity") {
          const nextIdentities = addSelection(
            identityDraft,
            candidate.id,
            NO_CHARACTER_MARKER,
          );
          setIdentityDraft(nextIdentities);
          patch.detected_identities = nextIdentities;
        } else {
          const nextProps = addSelection(
            propDraft,
            candidate.id,
            NO_PROP_MARKER,
          );
          setPropDraft(nextProps);
          patch.detected_props = nextProps;
        }

        window.requestAnimationFrame(() => {
          textarea?.focus();
          textarea?.setSelectionRange(nextCaret, nextCaret);
        });
        void handleBeatFieldUpdate(patch);
      },
      [
        handleBeatFieldUpdate,
        identityDraft,
        isStandaloneContext,
        mentionContext,
        patchStandaloneBeatContext,
        propDraft,
        visualDraft,
      ],
    );

    const openWorkbench = useCallback(async () => {
      if (!workbenchTarget || openingWorkbench) return;
      const urlProject = readUrl().project;
      const targetProjectId = urlProject || projectId;
      if (!targetProjectId) return;
      setOpeningWorkbench(true);
      try {
        await openPresetProjectionInMyCanvas(targetProjectId, {
          scope: workbenchTarget.scope,
          episode: workbenchTarget.episode,
          beat: workbenchTarget.beat,
          primary_slot: "render",
        });
      } finally {
        setOpeningWorkbench(false);
      }
    }, [openingWorkbench, projectId, workbenchTarget]);

    return (
      <div
        className="group relative h-full w-full overflow-visible"
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
      >
        <Handle
          type="source"
          position={Position.Right}
          id="source"
          className="!h-2.5 !w-2.5 !border-0 !bg-amber-300"
        />

        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Database className="h-4 w-4" />}
          titleText={title}
          editable
          onTitleChange={(nextTitle) =>
            updateNodeData(id, { displayName: nextTitle })
          }
        />

        <NodeResizeHandle
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          maxWidth={MAX_WIDTH}
          maxHeight={MAX_HEIGHT}
        />

        <div
          className="flex h-full flex-col overflow-hidden rounded-[var(--node-radius)] border border-amber-300/20 bg-[rgba(27,23,17,0.72)] text-amber-50 shadow-[0_14px_40px_rgba(0,0,0,0.28)] backdrop-blur-[1px]"
          onWheel={stopCanvasWheel}
        >
          <div className="border-b border-amber-200/10 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200/80">
                  {t("node.beatContextNode.heading", { defaultValue: "镜头上下文" })}
                </div>
                {!isStandaloneContext && (
                  <div className="mt-1 text-sm font-semibold text-amber-50">
                    EP{episode ?? "?"} / Beat {beat ?? "?"}
                  </div>
                )}
              </div>
              <NodeContextBadges contexts={contexts} variant="subtle" />
            </div>
            {workbenchTarget && (
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-1 rounded-full border border-cyan-200/25 bg-cyan-300/10 px-3 py-1.5 text-xs font-medium text-cyan-50 hover:bg-cyan-300/20 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={openingWorkbench}
                onClick={(event) => {
                  event.stopPropagation();
                  void openWorkbench();
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {openingWorkbench
                  ? t("node.beatContextNode.openingWorkbench", { defaultValue: "打开中..." })
                  : t("node.beatContextNode.openWorkbench", {
                      defaultValue: "打开工作台",
                    })}
              </button>
            )}
          </div>

          <div
            key={`snapshot-${editVersion}`}
            className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-xs leading-relaxed"
          >
            {/*
            Editable beat snapshot. onBlur 只更新当前画布节点草稿。
            技能消费这个节点草稿；点击“同步到主线”才写回主线 DB。
            stopPropagation 防止点击/拖拽 input 触发节点拖拽。
          */}
            <section>
              <div className="mb-2 font-semibold text-amber-100">
                {t("node.beatContextNode.fields.visual", { defaultValue: "起始画面" })}
              </div>
              <div className="relative">
                <textarea
                  ref={visualTextareaRef}
                  value={visualDraft}
                  placeholder={t("node.beatContextNode.placeholders.visual", {
                    defaultValue: "未设置;点击输入起始画面描述",
                  })}
                  rows={3}
                  onChange={(event) => {
                    setVisualDraft(event.target.value);
                    updateMentionContext(event.target);
                  }}
                  onSelect={(event) =>
                    updateMentionContext(event.currentTarget)
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    updateMentionContext(event.currentTarget);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (
                      mentionContext &&
                      filteredMentionCandidates.length > 0
                    ) {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setMentionActiveIndex(
                          (index) =>
                            (index + 1) % filteredMentionCandidates.length,
                        );
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setMentionActiveIndex(
                          (index) =>
                            (index - 1 + filteredMentionCandidates.length) %
                            filteredMentionCandidates.length,
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === "Tab") {
                        event.preventDefault();
                        insertMention(
                          filteredMentionCandidates[mentionActiveIndex] ??
                            filteredMentionCandidates[0],
                        );
                        return;
                      }
                    }
                    if (event.key === "Escape") {
                      setMentionContext(null);
                    }
                  }}
                  onBlur={() => {
                    setMentionContext(null);
                    saveVisualDraft();
                  }}
                  className="w-full resize-y rounded-[8px] border border-white/10 bg-black/30 p-2 text-amber-50/90 outline-none focus:border-amber-300/40 focus:bg-black/40"
                />
                {mentionContext && filteredMentionCandidates.length > 0 && (
                  <div
                    className="absolute left-2 top-full z-50 mt-1 max-h-56 min-w-[240px] overflow-auto rounded-lg border border-amber-100/15 bg-[#17120a]/95 p-1 shadow-xl backdrop-blur"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    {filteredMentionCandidates.map((candidate, index) => {
                      const Icon =
                        candidate.kind === "identity" ? UserRound : Package;
                      return (
                        <button
                          key={`${candidate.kind}:${candidate.id}`}
                          type="button"
                          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                            index === mentionActiveIndex
                              ? "bg-amber-300/15 text-amber-50"
                              : "text-amber-100/75 hover:bg-white/10 hover:text-amber-50"
                          }`}
                          onMouseEnter={() => setMentionActiveIndex(index)}
                          onClick={() => insertMention(candidate)}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {candidate.label}
                          </span>
                          <span className="shrink-0 rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-amber-100/55">
                            {candidate.token}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
            {!isStandaloneContext && (
              <section className="grid grid-cols-2 gap-2">
                <div className="rounded-[8px] border border-white/10 bg-black/15 p-2">
                  <div className="mb-1.5 text-amber-100/70">
                    {t("node.beatContextNode.fields.scene", { defaultValue: "场景" })}
                  </div>
                  <div
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <UiSelect
                      aria-label={t("node.beatContextNode.fields.scene", { defaultValue: "场景" })}
                      value={sceneDraft || NONE_SENTINEL}
                      className={BEAT_CONTEXT_SELECT_CLASS}
                      menuClassName={BEAT_CONTEXT_SELECT_MENU_CLASS}
                      onChange={(event) => {
                        const value = event.target.value;
                        const next = value === NONE_SENTINEL ? "" : (value ?? "");
                        setSceneDraft(next);
                        if (next !== sceneInitial) {
                          const nextRef = sceneNameToRef(next, sceneRefRecords);
                          void handleBeatFieldUpdate({
                            scene_ref: {
                              scene_id: nextRef.scene_id,
                              variant_id: nextRef.variant_id,
                            },
                          });
                        }
                      }}
                    >
                      <option value={NONE_SENTINEL}>
                        {t("node.beatContextNode.unset", { defaultValue: "未设置" })}
                      </option>
                      {sceneOptions.map((sceneId) => (
                        <option key={sceneId} value={sceneId}>
                          {sceneId}
                        </option>
                      ))}
                    </UiSelect>
                  </div>
                </div>
                <div className="rounded-[8px] border border-white/10 bg-black/15 p-2">
                  <div className="mb-1.5 text-amber-100/70">
                    {t("node.beatContextNode.fields.time", { defaultValue: "时间" })}
                  </div>
                  <div
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <UiSelect
                      aria-label={t("node.beatContextNode.fields.time", { defaultValue: "时间" })}
                      value={timeDraft || NONE_SENTINEL}
                      className={BEAT_CONTEXT_SELECT_CLASS}
                      menuClassName={BEAT_CONTEXT_SELECT_MENU_CLASS}
                      onChange={(event) => {
                        const value = event.target.value;
                        const next = value === NONE_SENTINEL ? "" : (value ?? "");
                        setTimeDraft(next);
                        if (next !== timeInitial) {
                          void handleBeatFieldUpdate({ time_of_day: next });
                        }
                      }}
                    >
                      <option value={NONE_SENTINEL}>
                        {timeOfDayLabel("", t)}
                      </option>
                      {timeOptions.map((timeOfDay) => (
                        <option key={timeOfDay} value={timeOfDay}>
                          {timeOfDayLabel(timeOfDay, t)}
                        </option>
                      ))}
                    </UiSelect>
                  </div>
                </div>
              </section>
            )}
            <section className="grid grid-cols-2 gap-2">
              <div className="rounded-[8px] border border-white/10 bg-black/15 p-2">
                <div className="mb-1.5 text-amber-100/70">
                  {t("node.beatContextNode.fields.identities", { defaultValue: "出场身份" })}
                </div>
                <SelectableTokenGroup
                  options={identityOptions}
                  selected={identityDraft}
                  colorMap={identityColorDraft}
                  editableColors={isStandaloneContext}
                  onColorChange={updateIdentityColor}
                  emptyLabel={NO_CHARACTER_MARKER}
                  emptyText={t("node.beatContextNode.empty.noCharacter", {
                    defaultValue: "无角色出场",
                  })}
                  staleText={t("node.beatContextNode.stale", {
                    defaultValue: "已移除",
                  })}
                  icon="identity"
                  onToggle={toggleIdentity}
                />
              </div>
              <div className="rounded-[8px] border border-white/10 bg-black/15 p-2">
                <div className="mb-1.5 text-amber-100/70">
                  {t("node.beatContextNode.fields.props", { defaultValue: "出场道具" })}
                </div>
                <SelectableTokenGroup
                  options={propOptions}
                  selected={propDraft}
                  colorMap={propColorDraft}
                  editableColors={isStandaloneContext}
                  onColorChange={updatePropColor}
                  emptyLabel={NO_PROP_MARKER}
                  emptyText={t("node.beatContextNode.empty.noProp", {
                    defaultValue: "无道具出场",
                  })}
                  staleText={t("node.beatContextNode.stale", {
                    defaultValue: "已移除",
                  })}
                  icon="prop"
                  onToggle={toggleProp}
                />
              </div>
            </section>
            <section className="flex flex-wrap gap-1.5 text-[10px] text-amber-100/80">
              <span className="rounded-full bg-white/10 px-2 py-1">
                {t("node.beatContextNode.assets.background", { defaultValue: "背景" })} {snapshot.selectedBackgroundExists ? t("node.beatContextNode.assets.selected", { defaultValue: "已选" }) : t("node.beatContextNode.assets.unselected", { defaultValue: "未选" })}
              </span>
              <span className="rounded-full bg-white/10 px-2 py-1">
                {t("node.beatContextNode.assets.sketch", { defaultValue: "草图" })} {snapshot.currentSketchExists ? t("node.beatContextNode.assets.exists", { defaultValue: "已有" }) : t("node.beatContextNode.assets.missing", { defaultValue: "缺失" })}
              </span>
              <span className="rounded-full bg-white/10 px-2 py-1">
                {t("node.beatContextNode.assets.frame", { defaultValue: "分镜" })} {snapshot.currentFrameExists ? t("node.beatContextNode.assets.exists", { defaultValue: "已有" }) : t("node.beatContextNode.assets.missing", { defaultValue: "缺失" })}
              </span>
            </section>
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-amber-200/15 px-4 py-2 text-[10px] text-amber-100/65">
            <div className="flex min-w-0 items-center gap-2">
              <RefreshCw
                className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`}
              />
              <span className="truncate">
                {isStandaloneContext
                  ? t("node.beatContextNode.status.standaloneLocalOnly", {
                      defaultValue: "自定义上下文；仅当前画布使用。",
                    })
                  : syncStatus === "error"
                    ? t("node.beatContextNode.status.syncError", {
                        defaultValue: "同步失败：{{message}}",
                        message: data.errorMessage || t("node.beatContextNode.status.unknownError", { defaultValue: "未知错误" }),
                      })
                    : isSyncing
                      ? t("node.beatContextNode.status.syncing", {
                          defaultValue: "正在同步到主线...",
                        })
                      : syncStatus === "stale"
                        ? t("node.beatContextNode.status.stale", {
                            defaultValue: "本地已修改，未同步主线；技能会使用当前节点。",
                          })
                        : t("node.beatContextNode.status.fresh", {
                            defaultValue: "上下文已同步；技能会使用当前节点。",
                          })}
              </span>
            </div>
            {!isStandaloneContext && (
              <button
                type="button"
                className="shrink-0 rounded-full border border-amber-200/20 bg-amber-200/10 px-2 py-1 text-[10px] text-amber-50 hover:bg-amber-200/20 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={isSyncing}
                onClick={(event) => {
                  event.stopPropagation();
                  void syncToMainline();
                }}
              >
                {t("node.beatContextNode.syncToMainline", { defaultValue: "同步到主线" })}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  },
);

function SelectableTokenGroup({
  options,
  selected,
  colorMap,
  emptyLabel,
  emptyText,
  staleText,
  icon,
  onToggle,
  editableColors = false,
  onColorChange,
}: {
  options: string[];
  selected: string[];
  colorMap?: Record<string, string>;
  emptyLabel: string;
  emptyText: string;
  staleText: string;
  icon: MentionKind;
  onToggle: (id: string) => void;
  editableColors?: boolean;
  onColorChange?: (id: string, color: string) => void;
}) {
  const { t } = useTranslation();
  const [activePaletteId, setActivePaletteId] = useState<string | null>(null);
  const selectedForRender =
    selected.includes(emptyLabel) ||
    selected.some((id) => id && id !== emptyLabel)
      ? selected
      : [emptyLabel];
  const seen = new Set<string>();
  const ordered: { id: string; stale: boolean }[] = [];
  for (const id of options) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push({ id, stale: false });
    }
  }
  for (const id of selectedForRender) {
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push({ id, stale: true });
    }
  }

  const activeToken = activePaletteId
    ? ordered.find(({ id }) => id === activePaletteId)
    : null;

  const renderToken = ({ id, stale }: { id: string; stale: boolean }) => {
    const isSelected = selectedForRender.includes(id);
    const label = id === emptyLabel ? emptyText : id;
    const Icon = icon === "identity" ? UserRound : Package;
    const rawColor = id === emptyLabel ? "" : colorMap?.[id]?.trim();
    const color = rawColor ? parseColorValue(rawColor).hex : null;
    const colorLabel =
      icon === "identity"
        ? t("node.beatContextNode.palette.identityColor", { defaultValue: "身份颜色" })
        : t("node.beatContextNode.palette.propColor", {
            defaultValue: "道具颜色",
          });
    const chipClassName = `inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] transition-colors ${isSelected ? (stale ? "border-red-300/35 bg-red-400/10 text-red-100" : "border-cyan-200/45 bg-cyan-300/12 text-cyan-50") : "border-white/10 bg-white/[0.03] text-amber-100/65 hover:border-white/20 hover:text-amber-50"}`;
    return (
      <button
        key={id}
        type="button"
        aria-pressed={isSelected}
        className={chipClassName}
        onClick={(event) => {
          event.stopPropagation();
          onToggle(id);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        title={label}
      >
        <Icon className="h-3 w-3 shrink-0" />
        {editableColors && isSelected && id !== emptyLabel ? (
          <span className="relative shrink-0">
            <span
              aria-label={`${colorLabel} ${id}`}
              className="inline-flex h-4 w-4 cursor-pointer rounded-full border border-white/65 bg-black/20 align-middle shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/70"
              style={{ backgroundColor: color ?? "transparent" }}
              onClick={(event) => {
                event.stopPropagation();
                setActivePaletteId((current) => (current === id ? null : id));
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          </span>
        ) : (
          color && (
            <span
              data-testid={`beat-context-color-${icon}-${id}`}
              className="h-3 w-3 shrink-0 rounded-full border border-white/65 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
              style={{ backgroundColor: color }}
            />
          )
        )}
        <span className="truncate">{label}</span>
        {stale && (
          <span className="shrink-0 text-[10px] opacity-70">{staleText}</span>
        )}
      </button>
    );
  };

  return (
    <div className="relative overflow-visible">
      <div className="flex max-h-56 flex-wrap gap-1.5 overflow-auto">
        {ordered.map(renderToken)}
      </div>
      {activeToken &&
        selectedForRender.includes(activeToken.id) &&
        activeToken.id !== emptyLabel && (
          <ContextColorPalette
            onSelect={(nextColor) => {
              onColorChange?.(activeToken.id, nextColor);
              setActivePaletteId(null);
            }}
          />
        )}
    </div>
  );
}

function ContextColorPalette({
  onSelect,
}: {
  onSelect: (color: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <span
      className="absolute left-0 top-full z-50 mt-2 block w-[310px] rounded-2xl border border-white/12 bg-[#111419]/95 p-4 text-xs text-white/70 shadow-2xl backdrop-blur-xl"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <PaletteSection
        title={t("node.beatContextNode.palette.actorColors", { defaultValue: "人物颜色" })}
        labelPrefix={t("node.beatContextNode.palette.actorColors", { defaultValue: "人物颜色" })}
        colors={STANDALONE_ACTOR_COLORS}
        onSelect={onSelect}
      />
      <PaletteSection
        title={t("node.beatContextNode.palette.propColors", { defaultValue: "道具颜色" })}
        labelPrefix={t("node.beatContextNode.palette.propColors", { defaultValue: "道具颜色" })}
        colors={STANDALONE_PROP_COLORS}
        onSelect={onSelect}
        className="mt-4"
      />
    </span>
  );
}

function PaletteSection({
  title,
  labelPrefix,
  colors,
  className = "",
  onSelect,
}: {
  title: string;
  labelPrefix: string;
  colors: readonly string[];
  className?: string;
  onSelect: (color: string) => void;
}) {
  return (
    <span className={`block ${className}`}>
      <span className="mb-2 block font-semibold text-white/55">{title}</span>
      <span className="flex flex-wrap gap-3">
        {colors.map((color) => (
          <span
            key={`${labelPrefix}:${color}`}
            role="button"
            tabIndex={0}
            aria-label={`${labelPrefix} ${color}`}
            className="inline-flex h-9 w-9 cursor-pointer rounded-full border border-white/15 bg-[#20242b] p-1 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/70"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(color);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              event.stopPropagation();
              onSelect(color);
            }}
          >
            <span
              className="block h-full w-full rounded-full border border-white/55"
              style={{ backgroundColor: color }}
            />
          </span>
        ))}
      </span>
    </span>
  );
}

BeatContextNode.displayName = "BeatContextNode";
