// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNodeData } from "./canvasNodes";
import { coerceSlotTarget } from "./mainlineNodeTypes";
import type { useCanvasStore } from "@/stores/canvasStore";
import type { DirectorWorldSource } from "@/features/viewer-kit/three-d/directorManifest";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";

/**
 * 自定义拖拽 MIME —— 侧栏素材卡片拖进画布时通过 dataTransfer 携带的 payload 类型。
 * 用专属类型而非 text/plain，避免和系统文件拖放 / 文本拖放互相误伤。
 */
export const CANVAS_ASSET_DRAG_MIME = "application/x-freezone-asset";

export type CanvasAssetDragKind = "image" | "video" | "audio" | "model";

/**
 * 侧栏素材拖进画布时序列化的最小描述。所有字段都是纯数据(可 JSON 序列化),
 * 落点后由 {@link spawnAssetNode} 还原成对应类型的画布节点。
 */
export interface CanvasAssetDragPayload {
  kind: CanvasAssetDragKind;
  label: string;
  /**
   * 生成型节点(目前仅视频)的提示词。历史「使用」流程从对应记录带过来,用于回填
   * 新节点的提示词框;侧栏拖拽 / live-canvas 复制不带此字段(label 是显示名非提示词)。
   */
  prompt?: string;
  url: string;
  aspectRatio?: string;
  /** 3GS 借用同 scene 的封面图;其余类型为空。 */
  coverUrl?: string | null;
  /** Director World source list for scene assets that aggregate pano + SOG sources. */
  modelSources?: DirectorWorldSource[];
  activeSourceId?: string | null;
  plyUrl?: string | null;
  panoUrl?: string | null;
  scene?: ThreeDSceneSnapshot | null;
  scenesBySourceId?: Record<string, ThreeDSceneSnapshot>;
  /** 3GS 源文件名(从 rel_path 推导);其余类型回落到 label。 */
  sourceFileName?: string;
  /** 透传给节点的 __freezone_source(用于 commit / 替换溯源)。 */
  source: Record<string, unknown>;
  /** mainline_context 数组(可选)。 */
  mainlineContext?: unknown[];
}

type CanvasStore = ReturnType<typeof useCanvasStore.getState>;

/**
 * 在指定坐标按 payload 类型生成画布节点,返回新节点 id。
 * 「加入」按钮(视口中心)与拖拽落点共用同一套节点构造,避免两处分叉。
 * 注意:此函数只负责建节点,聚焦 / 选中由调用方决定(按钮聚焦、拖放选中)。
 */
export function spawnAssetNode(
  store: CanvasStore,
  payload: CanvasAssetDragPayload,
  position: { x: number; y: number },
): string {
  const mainlineData =
    payload.mainlineContext && payload.mainlineContext.length
      ? { mainline_context: payload.mainlineContext }
      : {};
  const sourceMeta = { ...payload.source };
  const slotTarget = coerceSlotTarget(sourceMeta.slot_target);
  const slotData = slotTarget
    ? { slot_target: slotTarget, committed_slot_url: payload.url }
    : {};
  const directorControlBundle =
    sourceMeta.director_control_bundle && typeof sourceMeta.director_control_bundle === "object"
      ? { director_control_bundle: sourceMeta.director_control_bundle }
      : {};
  const candidateData = { user_spawned: true as const };

  switch (payload.kind) {
    case "model": {
      const modelSources = payload.modelSources?.length ? payload.modelSources : undefined;
      const activeSource =
        modelSources?.find((source) => source.id && source.id === payload.activeSourceId) ??
        modelSources?.find((source) => source.current) ??
        modelSources?.[0];
      const activePlyUrl =
        activeSource?.ply_url ??
        (activeSource?.source_type === "sog" ? activeSource.url : undefined);
      const activePanoUrl =
        activeSource?.pano_url ??
        (activeSource?.source_type === "pano360" ? activeSource.url : undefined);
      const plyUrl = payload.plyUrl ?? activePlyUrl ?? (modelSources ? null : payload.url);
      const panoUrl = payload.panoUrl ?? activePanoUrl ?? null;
      return store.addNode(
        CANVAS_NODE_TYPES.threeDWorld,
        position,
        {
          displayName: payload.label,
          plyUrl,
          panoUrl,
          sources: modelSources,
          activeSourceId: payload.activeSourceId ?? activeSource?.id ?? null,
          scene: payload.scene ?? null,
          scenesBySourceId: payload.scenesBySourceId,
          previewImageUrl: payload.coverUrl ?? null,
          sourceFileName: payload.sourceFileName ?? payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    }
    case "video":
      return store.addNode(
        CANVAS_NODE_TYPES.video,
        position,
        {
          displayName: payload.label,
          videoUrl: payload.url,
          previewImageUrl: null,
          aspectRatio: payload.aspectRatio,
          sourceFileName: payload.label,
          // 历史「使用」带来了该记录的原始提示词时,回填到视频节点的提示词框;
          // 无提示词(拖拽/live-canvas)则不写,保持占位符。
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    case "audio":
      return store.addNode(
        CANVAS_NODE_TYPES.audio,
        position,
        {
          displayName: payload.label,
          audioUrl: payload.url,
          sourceFileName: payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    case "image":
    default:
      return store.addNode(
        CANVAS_NODE_TYPES.upload,
        position,
        {
          displayName: payload.label,
          imageUrl: payload.url,
          previewImageUrl: payload.url,
          aspectRatio: payload.aspectRatio,
          sourceFileName: payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
  }
}

/** 从 dataTransfer 解析素材拖拽 payload;非素材拖拽返回 null。 */
export function readAssetDragPayload(
  dataTransfer: DataTransfer,
): CanvasAssetDragPayload | null {
  const raw = dataTransfer.getData(CANVAS_ASSET_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CanvasAssetDragPayload;
    if (!parsed || typeof parsed.url !== "string" || !parsed.url) return null;
    return parsed;
  } catch {
    return null;
  }
}
