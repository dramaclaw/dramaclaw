// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownUp,
  Box as BoxIcon,
  Check,
  Download,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import {
  extractCanvasAssets,
  groupAssetsByDate,
  type CanvasAsset,
  type CanvasAssetBuckets,
  type CanvasAssetKind,
} from '@/features/canvas/domain/canvasAssets';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasGenerationHistory } from '@/features/canvas/hooks/useCanvasGenerationHistory';
import {
  historyRecordOutputUrl,
  historyRecordPreviewImageUrl,
  historyRecordPrompt,
  historyRecordStrictWorldUrl,
  historyRecordWorldUrl,
} from './NodeGenerationHistory';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import { resolveMediaUrl } from '@/lib/media-url';
import { readUrl } from '@/lib/url-params';
import {
  buildStandaloneWorldManifest,
  type DirectorStageManifest,
} from '@/features/viewer-kit/three-d/directorManifest';
import { ThreeDDirectorDialog } from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';

import { ImageViewerModal } from './ImageViewerModal';
import { VideoViewerModal } from './VideoViewerModal';

// Node types that record backend generation history. Used only to scope the
// per-node fallback fan-out (see useCanvasGenerationHistory); the canvas-level
// aggregate endpoint ignores this list. Pure reference / annotation / layout
// nodes never have history, so we skip them.
const GENERATIVE_HISTORY_NODE_TYPES = new Set<string>([
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.storyboardSplit,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.videoStory,
  CANVAS_NODE_TYPES.videoCompose,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.threeDWorld,
]);

// Cap how many recent records each tab shows. Records arrive newest-first
// (backend sorts by recorded_at desc), so slicing keeps the latest.
const HISTORY_DISPLAY_CAP = 20;

/**
 * Map backend generation-history records into the asset-card shape the modal
 * already renders. Only completed records that carry a usable output url for an
 * image/video/audio surface; `recorded_at` drives date grouping (fixing the
 * old "未知日期" bucketing that the live-canvas scrape produced). Deduped by
 * (kind,url) so a restored/duplicated output shows once, then each kind is
 * capped to the {@link HISTORY_DISPLAY_CAP} most recent.
 */
/**
 * 可选的「节点元信息」解析器:用一条记录的 `node_id` 回到 live 画布,取该(世界)节点
 * 的兜底封面与名字。世界记录的 `result` 往往既无预览图也无提示词,但生成它的
 * `threeDWorld` 节点把**输入源图**存在 `previewImageUrl`、并经 `sourceNodeId` 指向上游
 * 图片节点(其 displayName 即如「大学宿舍」)——拿来当封面/名字最贴切。
 */
export interface HistoryNodeMeta {
  cover: string | null;
  name: string | null;
}

export function recordsToAssetBuckets(
  records: FreezoneGenerationHistoryRecord[],
  resolveNodeMeta?: (nodeId: string) => HistoryNodeMeta,
): CanvasAssetBuckets {
  const buckets: CanvasAssetBuckets = { image: [], video: [], audio: [], model: [] };
  const seen = new Set<string>();
  for (const record of records) {
    if (record.status !== 'completed' && record.status !== 'succeeded') continue;
    // 世界(3GS / 360→3GS)记录判定:**先看产物结构**(result 里有没有真正的
    // .sog/.ply/3GS url),再退而看 media_type。image-to-3gs 记录的 media_type 后端
    // 标得并不可靠(常是 `image` 而非 `3d`),只认 media_type 会漏掉整个世界历史——
    // 节点侧历史 strip 一向靠嗅探产物 url 判世界,这里与之对齐。
    const worldUrl = historyRecordStrictWorldUrl(record);
    const isWorld =
      worldUrl !== null ||
      record.media_type === '3d' ||
      record.media_type === '3gs' ||
      record.media_type === 'ply';
    const kind: CanvasAssetKind | null = isWorld
      ? 'model'
      : record.media_type === 'image' ||
          record.media_type === 'video' ||
          record.media_type === 'audio'
        ? record.media_type
        : null;
    if (!kind) continue;
    // 世界模型产物 url 可能藏在 sog_url/scene_3gs_ply_fs 等键下,用专用提取器;
    // 其余类型走通用 output url。
    const url = resolveMediaUrl(
      kind === 'model'
        ? (worldUrl ?? historyRecordWorldUrl(record))
        : historyRecordOutputUrl(record),
    );
    if (!url) continue;
    const dedupeKey = `${kind}:${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const ts = new Date(record.recorded_at).getTime();
    // 世界记录用 host 节点兜底封面/名字(见 HistoryNodeMeta);其余类型不兜底,沿用
    // 各自既有取值。
    const nodeMeta =
      kind === 'model' ? resolveNodeMeta?.(record.node_id) : undefined;
    // Show only the prompt the backend stored on this record, so the prompt
    // always matches the video. Legacy records that never stored a prompt show
    // nothing (no node-prompt fallback — it misattributed the node's current
    // prompt to old versions). 世界记录例外:无提示词时回退到上游源图节点的名字。
    const prompt = historyRecordPrompt(record);
    const label = prompt ?? nodeMeta?.name ?? null;
    buckets[kind].push({
      id: record.id,
      kind,
      url,
      previewUrl: resolveMediaUrl(
        historyRecordPreviewImageUrl(record) ?? nodeMeta?.cover ?? null,
      ),
      nodeId: record.node_id,
      label,
      // 用「使用」建节点时把这条记录原始提示词灌进新节点的提示词框；label 对世界
      // 记录可能回退成节点名,所以这里单独存 prompt（仅后端存过提示词时才有值）。
      prompt: prompt ?? null,
      // 原始生成的注册表模型 id / 生成模式，透传给「使用」还原节点（旧记录为 undefined）。
      model: record.model,
      genMode: record.gen_mode,
      timestamp: Number.isNaN(ts) ? null : ts,
    });
  }
  return {
    image: buckets.image.slice(0, HISTORY_DISPLAY_CAP),
    video: buckets.video.slice(0, HISTORY_DISPLAY_CAP),
    audio: buckets.audio.slice(0, HISTORY_DISPLAY_CAP),
    model: buckets.model.slice(0, HISTORY_DISPLAY_CAP),
  };
}

const TAB_ORDER: CanvasAssetKind[] = ['image', 'video', 'audio', 'model'];
const TAB_LABEL_KEY: Record<CanvasAssetKind, string> = {
  image: 'canvas.history.tabs.image',
  video: 'canvas.history.tabs.video',
  audio: 'canvas.history.tabs.audio',
  model: 'canvas.history.tabs.world',
};

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 25;
const THUMB_BASE_PX = 256;

interface CanvasHistoryAssetsModalProps {
  onClose: () => void;
  /**
   * 「使用」：把该资产作为一个新节点加入画布（落在视口中心）。批量使用时传 placement，
   * 由外层把多个节点在视口中心附近铺成网格。
   */
  onUseAsset: (asset: CanvasAsset, placement?: { index: number; total: number }) => void;
  /** 「删除」：从画布移除该资产对应的源节点。 */
  onDeleteNode: (nodeId: string) => void;
  /** 仅展示图片 tab（用于分镜组只接受图片的取图场景）。 */
  imageOnly?: boolean;
  /**
   * 资产来源：
   * - `'generation-history'`（默认）：拉后端「整画布生成历史记录」，按 recorded_at
   *   分组——这是全局「历史资产」弹窗要的语义（节点的历次生成产物）。
   * - `'live-canvas'`：抓当前画布上所有节点现存的资产（含上传/参考图）。分镜组取图
   *   走这条，需要能选到未经生成的上传图。
   */
  assetSource?: 'generation-history' | 'live-canvas';
}

export function CanvasHistoryAssetsModal({
  onClose,
  onUseAsset,
  onDeleteNode,
  imageOnly = false,
  assetSource = 'generation-history',
}: CanvasHistoryAssetsModalProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const useHistory = assetSource === 'generation-history';

  // Live-node ids feed the per-node fallback fan-out for backends that don't yet
  // expose the canvas-level aggregate endpoint. When the aggregate route is
  // present it ignores these and returns history for deleted nodes too.
  const fallbackNodeIds = useMemo(
    () =>
      nodes
        .filter((node) => GENERATIVE_HISTORY_NODE_TYPES.has(node.type))
        .map((node) => node.id),
    [nodes],
  );
  const { records, isLoading } = useCanvasGenerationHistory(fallbackNodeIds, {
    enabled: useHistory,
  });

  const [activeTab, setActiveTab] = useState<CanvasAssetKind>('image');
  const tabOrder = imageOnly ? (['image'] as CanvasAssetKind[]) : TAB_ORDER;
  const [direction, setDirection] = useState<'desc' | 'asc'>('desc');
  const [zoom, setZoom] = useState(100);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Image lightbox state (drives the shared ImageViewerModal nav list).
  const [imageViewerIndex, setImageViewerIndex] = useState<number | null>(null);
  const [videoViewerUrl, setVideoViewerUrl] = useState<string | null>(null);
  // 世界模型「查看」：用产物 url 现搭一个最小 manifest，直接开虾境（导演台）。
  const [worldManifest, setWorldManifest] = useState<DirectorStageManifest | null>(null);
  // Full-prompt dialog (opened by double-clicking a card's prompt caption).
  const [promptDialogText, setPromptDialogText] = useState<string | null>(null);

  // 世界记录兜底封面/名字:用记录的 node_id 回到 live 画布,取该 threeDWorld 节点的
  // previewImageUrl(=输入源图)当封面、上游源图节点的 displayName(如「大学宿舍」)当名字。
  const resolveNodeMeta = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const trimmed = (value: unknown): string | null =>
      typeof value === 'string' && value.trim().length > 0 ? value : null;
    return (nodeId: string): HistoryNodeMeta => {
      const node = byId.get(nodeId);
      if (!node) return { cover: null, name: null };
      const data = node.data as Record<string, unknown>;
      const cover = trimmed(data.previewImageUrl);
      const sourceNodeId = trimmed(data.sourceNodeId);
      const sourceData = (sourceNodeId ? byId.get(sourceNodeId)?.data : undefined) as
        | Record<string, unknown>
        | undefined;
      const name =
        trimmed(sourceData?.displayName) ??
        trimmed(sourceData?.sourceFileName) ??
        trimmed(data.displayName);
      return { cover, name };
    };
  }, [nodes]);

  const buckets = useMemo(
    () =>
      useHistory
        ? recordsToAssetBuckets(records, resolveNodeMeta)
        : extractCanvasAssets(nodes),
    [useHistory, records, nodes, resolveNodeMeta],
  );
  const activeAssets = buckets[activeTab];
  const groups = useMemo(
    () => groupAssetsByDate(activeAssets, direction),
    [activeAssets, direction],
  );
  const orderedImageUrls = useMemo(
    () => groups.flatMap((group) => group.assets).map((asset) => asset.url),
    [groups],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Inner overlays own Escape while open: prompt dialog first, then the
        // modal itself once viewers/prompt are all closed.
        if (promptDialogText !== null) {
          setPromptDialogText(null);
        } else if (imageViewerIndex === null && !videoViewerUrl && !worldManifest) {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, imageViewerIndex, videoViewerUrl, worldManifest, promptDialogText]);

  useEffect(() => {
    // Reset selection when switching tab so counts can't leak across kinds.
    setSelectedIds(new Set());
  }, [activeTab]);

  const toggleSelect = (asset: CanvasAsset) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else {
        next.add(asset.id);
      }
      return next;
    });
  };

  // 查看：图片 / 视频放大查看。音频不走这里 —— 直接在卡片上内联播放（见 AssetCard）。
  const handleView = (asset: CanvasAsset) => {
    if (asset.kind === 'image') {
      const index = orderedImageUrls.indexOf(asset.url);
      setImageViewerIndex(index >= 0 ? index : 0);
    } else if (asset.kind === 'video') {
      setVideoViewerUrl(asset.url);
    } else if (asset.kind === 'model') {
      // 直接进虾境：历史记录只有产物 url，没有节点的 sources/场景编辑，临时搭一个
      // 最小 scene-mode manifest 打开导演台（仅看裸 3GS / 360 全景）。
      const project = readUrl().project;
      if (!project) return;
      const manifest = buildStandaloneWorldManifest({
        project,
        url: asset.url,
        displayName: asset.label ?? t('viewer.threeD.directorWorld'),
      });
      if (manifest) setWorldManifest(manifest);
    }
  };

  const handleUse = (asset: CanvasAsset) => {
    onUseAsset(asset);
    onClose();
  };

  // 批量操作：当前 tab 里被选中的资产（保持展示顺序）。切 tab 会清空 selectedIds，
  // 所以只需在 activeAssets 里过滤即可，不会跨类型串味。
  const selectedAssets = useMemo(
    () => activeAssets.filter((asset) => selectedIds.has(asset.id)),
    [activeAssets, selectedIds],
  );
  const allSelected =
    activeAssets.length > 0 && selectedAssets.length === activeAssets.length;
  const [isDownloading, setIsDownloading] = useState(false);

  const handleToggleSelectAll = () => {
    setSelectedIds((current) =>
      current.size === activeAssets.length
        ? new Set()
        : new Set(activeAssets.map((asset) => asset.id)),
    );
  };

  // 批量下载：逐个触发浏览器下载，之间留一点间隔，避免浏览器把并发下载判为弹窗滥用而拦截。
  const handleBatchDownload = async () => {
    if (isDownloading || selectedAssets.length === 0) return;
    setIsDownloading(true);
    try {
      for (const asset of selectedAssets) {
        // 不用 label 当文件名：图片/视频的 label 是整段提示词，做文件名很糟；
        // 交给 downloadUrlAsFile 从 url 推断更合适。
        await downloadUrlAsFile(asset.url);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      setIsDownloading(false);
    }
  };

  // 批量使用：把选中的资产逐个作为新节点加入画布（网格铺开），完成后关闭弹窗。
  const handleBatchUse = () => {
    if (selectedAssets.length === 0) return;
    selectedAssets.forEach((asset, index) => {
      onUseAsset(asset, { index, total: selectedAssets.length });
    });
    onClose();
  };

  const thumbPx = Math.round((THUMB_BASE_PX * zoom) / 100);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-3 sm:p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 flex h-[88vh] w-[92vw] max-w-[1440px] flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0d0f14] shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 px-6 py-4">
        <h2 className="text-[20px] font-semibold leading-none text-white">
          {t('canvas.history.title')}
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-full border border-white/[0.12] bg-white/[0.04] px-1 py-0.5">
            <button
              type="button"
              aria-label={t('canvas.toolbar.zoomOut')}
              onClick={() => setZoom((value) => Math.max(ZOOM_MIN, value - ZOOM_STEP))}
              className="flex h-6 w-6 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-[44px] text-center text-[12px] tabular-nums text-white/82">
              {zoom}%
            </span>
            <button
              type="button"
              aria-label={t('canvas.toolbar.zoomIn')}
              onClick={() => setZoom((value) => Math.min(ZOOM_MAX, value + ZOOM_STEP))}
              className="flex h-6 w-6 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Tabs + tools */}
      <div className="flex items-center justify-between gap-4 px-6 pb-3">
        <div className="flex items-center gap-5">
          {tabOrder.map((tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`text-[14px] font-medium leading-none transition-colors ${
                  active ? 'text-white' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {t(TAB_LABEL_KEY[tab])}({buckets[tab].length})
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setDirection((value) => (value === 'desc' ? 'asc' : 'desc'))}
            className="flex items-center gap-1.5 text-[13px] text-white/60 transition-colors hover:text-white"
          >
            <ArrowDownUp className="h-3.5 w-3.5" />
            {t(direction === 'desc' ? 'canvas.history.sortDesc' : 'canvas.history.sortAsc')}
          </button>
          {selectionMode && activeAssets.length > 0 && (
            <button
              type="button"
              onClick={handleToggleSelectAll}
              className="text-[13px] text-white/60 transition-colors hover:text-white"
            >
              {t(allSelected ? 'canvas.history.deselectAll' : 'canvas.history.selectAll')}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setSelectionMode((value) => !value);
              setSelectedIds(new Set());
            }}
            className={`flex items-center gap-1.5 text-[13px] transition-colors ${
              selectionMode ? 'text-cyan-300' : 'text-white/60 hover:text-white'
            }`}
          >
            <Check className="h-3.5 w-3.5" />
            {selectionMode
              ? t('canvas.history.selectedCount', { n: selectedIds.size })
              : t('canvas.history.batch')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {useHistory && isLoading && activeAssets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/40">
            {t('common.loading')}
          </div>
        ) : activeAssets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/40">
            {t('canvas.history.empty')}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.date ?? 'undated'} className="mb-7">
              <div className="mb-3 text-[13px] text-white/45">
                {group.date ?? t('canvas.history.unknownDate')}
              </div>
              <div className="flex flex-wrap items-start gap-3">
                {group.assets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    sizePx={thumbPx}
                    selectionMode={selectionMode}
                    selected={selectedIds.has(asset.id)}
                    onToggleSelect={() => toggleSelect(asset)}
                    onView={() => handleView(asset)}
                    onUse={() => handleUse(asset)}
                    onDelete={() => onDeleteNode(asset.nodeId)}
                    onOpenPrompt={
                      asset.label ? () => setPromptDialogText(asset.label!) : undefined
                    }
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 批量操作栏：进入选择模式且至少选中一项时，从底部浮出。下载 / 使用 / 删除。 */}
      {selectionMode && selectedAssets.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/[0.12] bg-[#161922]/95 px-2.5 py-2 shadow-2xl backdrop-blur">
            <span className="px-2 text-[13px] text-white/70">
              {t('canvas.history.selectedCount', { n: selectedAssets.length })}
            </span>
            <span className="h-4 w-px bg-white/15" aria-hidden />
            <button
              type="button"
              onClick={handleBatchDownload}
              disabled={isDownloading}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDownloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t(isDownloading ? 'canvas.history.downloading' : 'canvas.history.batchDownload')}
            </button>
            <button
              type="button"
              onClick={handleBatchUse}
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium text-white/85 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('canvas.history.batchUse')}
            </button>
          </div>
        </div>
      )}
      </div>

      {/* Viewers */}
      <ImageViewerModal
        open={imageViewerIndex !== null}
        imageUrl={imageViewerIndex !== null ? (orderedImageUrls[imageViewerIndex] ?? '') : ''}
        imageList={orderedImageUrls}
        currentIndex={imageViewerIndex ?? 0}
        onClose={() => setImageViewerIndex(null)}
        onNavigate={(dir) =>
          setImageViewerIndex((index) => {
            if (index === null) {
              return index;
            }
            const next = dir === 'next' ? index + 1 : index - 1;
            if (next < 0 || next >= orderedImageUrls.length) {
              return index;
            }
            return next;
          })
        }
      />
      <VideoViewerModal
        open={Boolean(videoViewerUrl)}
        videoUrl={videoViewerUrl ?? ''}
        onClose={() => setVideoViewerUrl(null)}
      />

      {/* 世界模型「查看」：进虾境（导演台）只读浏览。历史产物没有可保存的源节点，
          故不接 onSaveScene / onCapture* 回调（纯查看）。 */}
      <ThreeDDirectorDialog
        open={Boolean(worldManifest)}
        onOpenChange={(open) => {
          if (!open) setWorldManifest(null);
        }}
        manifest={worldManifest}
        title={t('viewer.threeD.directorWorld')}
        viewerPurpose="freezone"
      />

      {/* 提示词完整查看：双击卡片提示词打开，完整滚动展示。 */}
      {promptDialogText !== null && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setPromptDialogText(null)}
            aria-hidden
          />
          <div className="relative z-10 flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0d0f14] shadow-2xl">
            <div className="flex items-center justify-between gap-4 border-b border-white/[0.08] px-5 py-3.5">
              <h3 className="text-[15px] font-semibold text-white">
                {t('canvas.history.promptTitle')}
              </h3>
              <button
                type="button"
                onClick={() => setPromptDialogText(null)}
                aria-label={t('common.close')}
                className="flex h-8 w-8 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="ui-scrollbar overflow-y-auto whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed text-white/85">
              {promptDialogText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AssetCardProps {
  asset: CanvasAsset;
  sizePx: number;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onView: () => void;
  onUse: () => void;
  onDelete: () => void;
  /** Double-click the prompt caption to open the full-prompt dialog. */
  onOpenPrompt?: () => void;
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const m = Math.floor(total / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function AssetCard({
  asset,
  sizePx,
  selectionMode,
  selected,
  onToggleSelect,
  onView,
  onUse,
  onDelete,
  onOpenPrompt,
}: AssetCardProps) {
  const { t } = useTranslation();
  const isAudio = asset.kind === 'audio';
  // 音频：在卡片上做一个轻量自定义播放器（居中播放/暂停 + 底部进度），就地播放，
  // 不弹独立 modal，也不用难看的原生 <audio controls>。
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  // 播放中用 rAF 平滑驱动进度条。
  useEffect(() => {
    if (!audioPlaying) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setAudioTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioPlaying]);

  const toggleAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  };

  const seekToClientX = (clientX: number, bar: HTMLElement) => {
    const el = audioRef.current;
    if (!el || !audioDuration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const next = ratio * audioDuration;
    el.currentTime = next;
    setAudioTime(next);
  };

  const progressPct =
    audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0;
  const showProgress = isAudio && !selectionMode && (audioPlaying || audioTime > 0);

  return (
    <div
      style={{ width: sizePx, height: sizePx }}
      className={`group flex flex-col overflow-hidden rounded-lg border bg-white/[0.03] transition-colors ${
        selected ? 'border-cyan-400' : 'border-white/[0.08] hover:border-white/[0.2]'
      }`}
    >
      {/* Thumbnail fills the space left over by the prompt caption, so all cards
          stay the same total height and short prompts get a bigger video. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
      {isAudio ? (
        <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-cyan-500/15 to-purple-500/15">
          <Volume2 className="h-7 w-7 text-cyan-200/35" />
          <audio
            ref={audioRef}
            src={asset.url}
            preload="none"
            onLoadedMetadata={(event) => {
              const d = event.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setAudioDuration(d);
            }}
            onPlay={() => setAudioPlaying(true)}
            onPause={() => setAudioPlaying(false)}
            onEnded={() => {
              setAudioPlaying(false);
              setAudioTime(0);
            }}
          />
        </div>
      ) : asset.kind === 'model' ? (
        // 世界模型（3GS / 360 全景）：产物本身不是图片，用封面缩略图；没有封面则
        // 画一个 3D 盒子占位，避免把 .sog 当 <img> 渲染导致裂图。
        asset.previewUrl ? (
          <img
            src={asset.previewUrl}
            alt={asset.label ?? ''}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-cyan-500/15 to-purple-500/15">
            <BoxIcon className="h-7 w-7 text-cyan-200/35" />
          </div>
        )
      ) : asset.kind === 'video' && !asset.previewUrl ? (
        // 视频节点大多没有存封面帧（previewImageUrl 为空），过去只画一个空的播放
        // 占位图标。这里直接用 <video> 渲染视频本身的首帧当封面：`#t=0.1` 让浏览器
        // seek 到 0.1s 并绘制该帧（t=0 在部分浏览器是黑帧/不绘制），preload=metadata
        // 保证只拉首帧元数据、不下载整段。静音 + 无 controls，纯静态封面，点击交给
        // 卡片的 hover 蒙层。
        <video
          src={asset.url.includes('#') ? asset.url : `${asset.url}#t=0.1`}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
        />
      ) : (
        <img
          src={asset.previewUrl ?? asset.url}
          alt={asset.label ?? ''}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      )}

      {selectionMode ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          className="absolute inset-0"
        >
          <span
            className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border ${
              selected
                ? 'border-cyan-400 bg-cyan-400 text-[#101217]'
                : 'border-white/60 bg-black/40'
            }`}
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        </button>
      ) : isAudio ? (
        // 音频卡片：左上「使用」、右上「删除」角标悬停浮现；播放/进度交给下方控件层，
        // 不用整片 hover 蒙层去盖播放按钮。
        <>
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('canvas.history.delete')}
            title={t('canvas.history.delete')}
            className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white/85 opacity-0 transition group-hover:opacity-100 hover:bg-red-500/80 hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onUse}
            className="absolute left-2 top-2 z-30 rounded-md bg-black/50 px-2 py-1 text-[12px] font-medium text-white/90 opacity-0 transition group-hover:opacity-100 hover:bg-black/70 hover:text-white"
          >
            {t('canvas.history.use')}
          </button>
        </>
      ) : (
        // 图片 / 视频 hover 蒙层：右上删除，居中查看 / 使用。
        <div className="absolute inset-0 flex items-center justify-center bg-black/55 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <button
            type="button"
            onClick={onDelete}
            aria-label={t('canvas.history.delete')}
            title={t('canvas.history.delete')}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/45 text-white/85 transition-colors hover:bg-red-500/80 hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onView}
              className="text-[13px] font-medium text-white/90 transition-colors hover:text-white"
            >
              {t('canvas.history.view')}
            </button>
            <span className="h-3 w-px bg-white/25" aria-hidden />
            <button
              type="button"
              onClick={onUse}
              className="text-[13px] font-medium text-white/90 transition-colors hover:text-white"
            >
              {t('canvas.history.use')}
            </button>
          </div>
        </div>
      )}

      {/* 音频自定义控件：居中播放/暂停按钮 + 底部进度条（始终可点）。 */}
      {isAudio && !selectionMode && (
        <button
          type="button"
          onClick={toggleAudio}
          aria-label={audioPlaying ? t('canvas.history.pause') : t('canvas.history.play')}
          className="absolute left-1/2 top-1/2 z-20 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/92 text-[#0d0f14] shadow-lg ring-1 ring-black/10 transition hover:scale-105 hover:bg-white"
        >
          {audioPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="ml-0.5 h-5 w-5" />
          )}
        </button>
      )}
      {showProgress && (
        <div className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-1.5">
          <div
            role="slider"
            aria-label={t('canvas.history.play')}
            aria-valuemin={0}
            aria-valuemax={Math.round(audioDuration)}
            aria-valuenow={Math.round(audioTime)}
            tabIndex={0}
            onClick={(event) => seekToClientX(event.clientX, event.currentTarget)}
            className="relative h-1.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-white/25"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-cyan-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-[10px] font-medium tabular-nums text-white/75">
            {formatClock(audioTime)}
          </span>
        </div>
      )}
      </div>

      {/* 提示词：图片 / 视频卡片在缩略图下方以卡片形式常显该版本提示词（多行截断，
          title 悬停看全文，双击开完整弹窗）。历史资产里即「产物 + 提示词」一张卡片。
          用 asset.prompt 作为显示条件（仅生成历史记录才有值）：分镜取图（live-canvas）
          的 label 是文件名而非提示词、prompt 为空，故那里不会误显文件名。 */}
      {(asset.kind === 'image' || asset.kind === 'video') &&
        !selectionMode &&
        asset.prompt && (
          <div
            title={asset.prompt}
            onDoubleClick={onOpenPrompt}
            className="line-clamp-[6] flex-none cursor-pointer select-none px-2.5 py-2 text-[12px] leading-snug text-white/75 transition-colors hover:text-white/90"
          >
            {asset.prompt}
          </div>
        )}

      {/* 世界模型：缩略图下方常显名字（提示词缺失时回退到「导演世界」默认名），
          让没有封面的世界卡片至少能认出是什么。双击看全文（有提示词时）。 */}
      {asset.kind === 'model' && !selectionMode && (
        <div
          title={asset.label ?? t('viewer.threeD.directorWorld')}
          onDoubleClick={asset.label ? onOpenPrompt : undefined}
          className="line-clamp-2 flex-none cursor-pointer select-none px-2.5 py-2 text-[12px] leading-snug text-white/75 transition-colors hover:text-white/90"
        >
          {asset.label ?? t('viewer.threeD.directorWorld')}
        </div>
      )}
    </div>
  );
}
