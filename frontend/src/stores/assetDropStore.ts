// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';
import { create } from 'zustand';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/** 拖拽节点 → 资产时用于「同类型」匹配的媒体类型。 */
export type DropMediaType = 'image' | 'video' | 'audio' | 'model';

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function sourceRecordUrl(record: Record<string, unknown>): string | null {
  for (const key of ['url', 'ply_url', 'pano_url', 'fs', 'pano_fs']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function modelSourceUrlFromNodeData(data: Record<string, unknown>): string | null {
  const str = (key: string): string | null => stringValue(data[key]);
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const records = sources.filter((source): source is Record<string, unknown> =>
    Boolean(source && typeof source === 'object'),
  );
  const activeSourceId = str('activeSourceId');
  const activeSource = activeSourceId
    ? records.find((source) => source.id === activeSourceId)
    : undefined;
  return (
    (activeSource ? sourceRecordUrl(activeSource) : null) ??
    sourceRecordUrl(records.find((source) => source.current === true) ?? {}) ??
    sourceRecordUrl(records[0] ?? {}) ??
    str('plyUrl') ??
    str('modelUrl') ??
    str('fileUrl') ??
    str('panoUrl')
  );
}

/**
 * 从画布节点推断出可用于「拖拽替换素材」的媒体类型与资源地址。
 * 仅图片/视频/音频/3GS 模型节点可参与替换,其余返回 null。
 */
export function deriveNodeDropInfo(node: CanvasNode): {
  mediaType: DropMediaType;
  sourceUrl: string | null;
  /** 用于拖拽预览浮层的缩略图地址(图片本身 / 视频或模型的封面);音频无缩略图。 */
  thumbUrl: string | null;
  label: string;
  /** 若节点仍携带完整导演 bundle,提交时优先按 bundle 写回;普通图会在 commit 层打包。 */
  directorControlBundle: Record<string, unknown> | null;
} | null {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    stringValue(data[key]);
  const label = str('displayName') ?? str('sourceFileName') ?? i18n.t('canvas.assetDrop.fallbackNodeLabel');
  const directorControlBundle =
    data.director_control_bundle && typeof data.director_control_bundle === 'object'
      ? (data.director_control_bundle as Record<string, unknown>)
      : null;

  switch (node.type) {
    case CANVAS_NODE_TYPES.video:
      return {
        mediaType: 'video',
        sourceUrl: str('videoUrl'),
        thumbUrl: str('previewImageUrl'),
        label,
        directorControlBundle,
      };
    case CANVAS_NODE_TYPES.audio:
      return { mediaType: 'audio', sourceUrl: str('audioUrl'), thumbUrl: null, label, directorControlBundle };
    case CANVAS_NODE_TYPES.threeDWorld:
      return {
        mediaType: 'model',
        sourceUrl: modelSourceUrlFromNodeData(data),
        thumbUrl: str('previewImageUrl') ?? str('coverUrl'),
        label,
        directorControlBundle,
      };
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.storyboardGen:
    case CANVAS_NODE_TYPES.pano360Viewer: {
      const imageUrl = str('imageUrl') ?? str('previewImageUrl');
      return { mediaType: 'image', sourceUrl: imageUrl, thumbUrl: imageUrl, label, directorControlBundle };
    }
    default:
      return null;
  }
}

export interface ActiveNodeDrag {
  /** 被拖拽的画布节点 id。 */
  nodeId: string;
  /** 节点的媒体类型,用于和侧栏资产做同类型匹配。 */
  mediaType: DropMediaType;
  /** 节点当前可提交的资源地址(图片/视频/音频/模型)。 */
  sourceUrl: string | null;
  /** 拖拽预览浮层用的缩略图地址;音频等无缩略图时为 null。 */
  thumbUrl: string | null;
  /** 节点显示名,用于确认文案。 */
  label: string;
  directorControlBundle: Record<string, unknown> | null;
}

/** Canvas 把节点拖到侧栏某条资产上松手后,发给侧栏的替换请求。 */
export interface PendingAssetReplace {
  assetId: string;
  nodeId: string;
  sourceUrl: string;
  label: string;
  directorControlBundle: Record<string, unknown> | null;
  /** 单调递增的信号,确保同一组合也能重复触发。 */
  token: number;
}

interface AssetDropState {
  /** 当前正在拖拽的节点信息;非拖拽时为 null。 */
  activeDrag: ActiveNodeDrag | null;
  /**
   * 「挑选态」:用户点了替换入口(把手单击 / 节点右键菜单)而不是拖拽,
   * 等他在素材库里点一条同类型素材。与 activeDrag 互斥。
   *
   * 拖拽要求用户一口气按住移动到侧栏,面板收起时更是完全没有落点;挑选态把
   * 同一件事拆成「先声明要替换谁 → 再选替换到哪」,宿主据此展开素材库。
   */
  pendingPick: ActiveNodeDrag | null;
  /** 当前悬停且类型匹配的资产 id;用于侧栏画虚线框。 */
  hoverAssetId: string | null;
  /** 松手后产生的替换请求;侧栏消费后置空。 */
  pendingReplace: PendingAssetReplace | null;

  beginDrag: (drag: ActiveNodeDrag) => void;
  setHoverAsset: (assetId: string | null) => void;
  /** 结束拖拽。若 commit=true 且当前悬停有效,则生成一个 pendingReplace。 */
  endDrag: (commit: boolean) => void;
  /** 进入挑选态(点击替换入口)。 */
  beginPick: (pick: ActiveNodeDrag) => void;
  /** 退出挑选态,不产生替换。 */
  cancelPick: () => void;
  /** 在挑选态下选中一条素材,生成与拖拽同款的 pendingReplace(仍走确认气泡)。 */
  commitPick: (assetId: string) => void;
  clearPendingReplace: () => void;
}

let replaceToken = 0;

/** 两条入口(拖拽命中 / 挑选点选)产出的 pendingReplace 完全同构。 */
function replaceRequestFrom(
  source: ActiveNodeDrag,
  assetId: string,
): PendingAssetReplace | null {
  if (!source.sourceUrl) return null;
  replaceToken += 1;
  return {
    assetId,
    nodeId: source.nodeId,
    sourceUrl: source.sourceUrl,
    label: source.label,
    directorControlBundle: source.directorControlBundle,
    token: replaceToken,
  };
}

export const useAssetDropStore = create<AssetDropState>((set, get) => ({
  activeDrag: null,
  pendingPick: null,
  hoverAssetId: null,
  pendingReplace: null,

  // 拖拽优先:从挑选态直接改用拖拽时,挑选态作废而不是两个态并存。
  beginDrag: (drag) => set({ activeDrag: drag, pendingPick: null, hoverAssetId: null }),

  setHoverAsset: (assetId) => {
    if (get().hoverAssetId === assetId) return;
    set({ hoverAssetId: assetId });
  },

  endDrag: (commit) => {
    const { activeDrag, hoverAssetId } = get();
    const request = commit && activeDrag && hoverAssetId
      ? replaceRequestFrom(activeDrag, hoverAssetId)
      : null;
    if (request) {
      set({ pendingReplace: request, activeDrag: null, hoverAssetId: null });
      return;
    }
    set({ activeDrag: null, hoverAssetId: null });
  },

  beginPick: (pick) => {
    if (!pick.sourceUrl) return;
    set({ pendingPick: pick, activeDrag: null, hoverAssetId: null, pendingReplace: null });
  },

  cancelPick: () => set({ pendingPick: null }),

  commitPick: (assetId) => {
    const { pendingPick } = get();
    if (!pendingPick) return;
    const request = replaceRequestFrom(pendingPick, assetId);
    if (!request) return;
    // 挑选态在这里结束,但替换本身仍要过侧栏卡片上的确认气泡(pendingReplace)。
    set({ pendingReplace: request, pendingPick: null });
  },

  // 确认气泡被取消/完成后,顺带确保不会残留挑选态。
  clearPendingReplace: () => set({ pendingReplace: null }),
}));
