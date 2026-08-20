// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import {
  AudioLines,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ImageOff,
  Video,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AssetLibraryModal } from "@/features/canvas/ui/AssetLibraryModal";
import type {
  AssetFolder,
  LibraryItem,
} from "@/features/canvas/ui/assetLibraryItems";
import { queryKeys } from "@/lib/query-keys";
import { CanvasesTab } from "./CanvasesTab";
import { AssetLibraryBrowser } from "./AssetLibraryBrowser";
import { hasLegacyPresetCanvasMetadata } from "@/features/freezone/projections";
import {
  type FreezoneBeatContextBeat,
  type FreezoneBeatContextResponse,
  type FreezoneProjectAsset,
} from "@/api/projects";
import {
  useFreezoneBeatContext,
  useFreezoneProjectAssets,
} from "@/lib/queries/freezone";
import { surfaceAccess, useProductSurfaces } from "@/lib/queries/product-surfaces";
import {
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
} from "@/features/canvas/domain/canvasNodes";
import {
  resolveImageDisplayUrl,
  withImageCacheBust,
} from "@/features/canvas/application/imageData";
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
} from "@/features/canvas/application/imageNodeSizing";
import {
  CANVAS_ASSET_DRAG_MIME,
  spawnAssetNode,
  type CanvasAssetDragPayload,
} from "@/features/canvas/domain/assetDrag";
import { hydrateAssetDragPayload } from "@/features/canvas/domain/assetDragHydrate";
import { directorSourceIdentityUrl } from "@/features/canvas/domain/directorWorldSources";
import { useCanvasStore } from "@/stores/canvasStore";
import { useAssetDropStore, type DropMediaType } from "@/stores/assetDropStore";
import { assetToPushTarget } from "@/features/freezone/commit/pushTarget";
import { promoteToAsset } from "@/features/freezone/commit/promoteToAsset";
import { commitDirectorRenderFromCanvasSource } from "@/features/freezone/commit/directorRenderCommit";
import type { PushResult, PushTarget } from "@/api/push";
import type { MainlineContext } from "@/features/freezone/context/mainlineContext";
import type { DirectorWorldSource } from "@/features/viewer-kit/three-d/directorManifest";

/** 把侧栏资产映射成可与画布节点匹配的拖拽媒体类型。 */
function assetDropMediaType(asset: LibraryAsset): DropMediaType | null {
  if (isThreeDAsset(asset)) return "model";
  if (asset.mediaType === "image") return "image";
  if (asset.mediaType === "video") return "video";
  if (asset.mediaType === "audio") return "audio";
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function directorControlBundleFromAssetSource(
  source: Record<string, unknown>,
): Record<string, unknown> | null {
  const explicit = recordValue(source.director_control_bundle);
  if (explicit) return explicit;

  const role = stringValue(source.role);
  const relPath = stringValue(source.rel_path);
  const url = stringValue(source.url);
  if (role !== "director_combined" || !relPath.endsWith("/combined.png") || !url) {
    return null;
  }
  const relBase = relPath.slice(0, -"/combined.png".length);
  const urlBase = url.endsWith("/combined.png")
    ? url.slice(0, -"/combined.png".length)
    : "";
  if (!urlBase) return null;
  return {
    schema_version: "director_control_bundle_v1",
    rel_paths: {
      combined: `${relBase}/combined.png`,
      env_only: `${relBase}/env_only.png`,
      frame_meta: `${relBase}/frame_meta.json`,
    },
    urls: {
      combined: `${urlBase}/combined.png`,
      env_only: `${urlBase}/env_only.png`,
      frame_meta: `${urlBase}/frame_meta.json`,
    },
  };
}

/** 拖拽替换的协调上下文,供深层 AssetCard 消费(避免逐层透传)。 */
interface AssetReplaceContextValue {
  confirmingAssetId: string | null;
  busyAssetId: string | null;
  onConfirm: (asset: LibraryAsset) => void;
  onCancel: () => void;
}
const AssetReplaceContext = createContext<AssetReplaceContextValue | null>(null);

type AssetTab = "beat" | "characters" | "scenes" | "props";

type CanvasKind = "default" | "episode" | "beat" | "asset" | "blank";

type AssetMediaType = "image" | "video" | "audio" | "text" | "file" | "unknown";

interface PresetReference {
  kind?: string;
  role?: string;
  label?: string;
  rel_path?: string | null;
  url?: string | null;
  exists?: boolean;
  media_type?: string;
  aspect_ratio?: string;
  meta?: Record<string, unknown>;
  mainline_context?: MainlineContext[];
}

interface LibraryAsset {
  id: string;
  tab: AssetTab;
  kind: string;
  role: string;
  label: string;
  sublabel?: string;
  url: string;
  aspectRatio: string;
  mediaType: AssetMediaType;
  source: Record<string, unknown>;
  mainlineContext?: MainlineContext[];
  beatContext?: MainlineContext & { episode: number; beat: number };
  /** 缩略图。3GS 包本身没法直接渲染，借用同 scene_id 的 scene 图当封面。 */
  coverUrl?: string;
}

const SCENE_DIRECTOR_WORLD_ROLE = "scene_director_world";

const BEAT_SCOPED_LIBRARY_ASSET_ROLES = new Set([
  "current_sketch",
  "current_frame",
  "current_video",
  "current_audio",
  "selected_background",
  "director_combined",
]);

const BEAT_SCOPED_LIBRARY_ASSET_KINDS = new Set(["video", "audio"]);

/** library = 主线资产，canvases = 项目画布，assets = 项目级资产库（只读浏览）。 */
type PanelTab = "library" | "canvases" | "assets";

interface AssetLibraryPanelProps {
  project: string;
  metadata: Record<string, unknown> | null;
  collapsed?: boolean;
  onCollapsedChange?: (next: boolean) => void;
  /** 拖拽节点替换某条素材完成(或失败)后回调:成功时携带 target/result。 */
  onReplaced?: (
    payload: { target: PushTarget; result: PushResult } | null,
    message: string,
  ) => void;
  /** 当前画布 id —— 用于「画布」tab 高亮当前项。 */
  currentCanvasId: string;
  /** 主线 preset 画布的「同步主线视图」回调；只在 preset 画布下显示按钮。 */
  onRestoreMainlineDefault?: () => Promise<void> | void;
  /** 外部提交成功后自增，通知素材库重拉项目资产。 */
  reloadToken?: number;
}

/* ─────────────────── 资产缩略图卡片 ─────────────────── */

function MiniThumb({
  asset,
  index,
  onAdd,
  cacheToken,
}: {
  asset: LibraryAsset;
  index: number;
  onAdd: () => void;
  cacheToken: string;
}) {
  const isThreeD = isThreeDAsset(asset);
  const isAudio = asset.mediaType === "audio";
  const isVideo = asset.mediaType === "video";
  const [imageFailed, setImageFailed] = useState(false);
  const thumbUrl = isThreeD || isVideo ? asset.coverUrl : asset.url;
  const displayThumbUrl = thumbUrl ? withImageCacheBust(thumbUrl, cacheToken) : null;
  const showImage =
    !imageFailed &&
    !isAudio &&
    Boolean(thumbUrl) &&
    (!isThreeD || Boolean(asset.coverUrl)) &&
    (!isVideo || Boolean(asset.coverUrl));
  // 视频没有后端封面时，用 <video> 抓首帧当缩略图（#t 强制浏览器渲染一帧）。
  const videoPosterUrl =
    isVideo && !imageFailed && !asset.coverUrl && asset.url
      ? `${withImageCacheBust(asset.url, cacheToken)}#t=0.1`
      : null;
  const disabled = !isThreeD && (asset.mediaType === "text" || asset.mediaType === "file");
  const dragPayload = disabled ? null : assetToDragPayload(asset);

  useEffect(() => {
    setImageFailed(false);
  }, [asset.id, thumbUrl]);

  const handleDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragPayload) return;
    event.dataTransfer.setData(CANVAS_ASSET_DRAG_MIME, JSON.stringify(dragPayload));
    event.dataTransfer.effectAllowed = "copy";
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onAdd();
  };

  return (
    <div
      draggable={Boolean(dragPayload)}
      onDragStart={handleDragStart}
      onContextMenu={handleContextMenu}
      onClick={onAdd}
      className="group relative aspect-[4/3] cursor-pointer overflow-hidden rounded bg-black/40 border border-white/[0.06] hover:border-white/[0.15] hover:bg-white/[0.04] hover:scale-[1.02] transition-all duration-350"
      title={asset.label}
    >
      {showImage ? (
        <img
          src={displayThumbUrl ?? ""}
          alt={asset.label}
          className="h-full w-full rounded object-contain"
          loading={index < 20 ? "eager" : "lazy"}
          draggable={false}
          onError={() => setImageFailed(true)}
        />
      ) : isAudio ? (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[rgba(21,215,232,0.15)] to-transparent rounded">
          <AudioLines className="h-5 w-5 text-white/50" />
        </div>
      ) : videoPosterUrl ? (
        <div className="relative h-full w-full">
          <video
            src={videoPosterUrl}
            className="h-full w-full rounded object-contain bg-black"
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            onError={() => setImageFailed(true)}
          />
          <div className="pointer-events-none absolute bottom-1 right-1 flex h-4 w-4 items-center justify-center rounded bg-black/65 ring-1 ring-white/15">
            <Video className="h-2.5 w-2.5 text-white/90" />
          </div>
        </div>
      ) : isVideo ? (
        <div className="flex h-full w-full items-center justify-center rounded bg-gradient-to-br from-white/[0.08] to-transparent">
          <Video className="h-5 w-5 text-white/45" />
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center rounded">
          {imageFailed ? (
            <ImageOff className="h-5 w-5 text-white/35" />
          ) : (
            <span className="text-[9px] uppercase tracking-wide text-white/30">
              {isThreeD ? "3gs" : asset.mediaType}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── Beat 行（可折叠） ─────────────────── */

const ROLE_LABELS: Record<string, string> = {
  current_sketch: "草图",
  current_frame: "分镜",
  current_video: "视频",
  current_audio: "音频",
  selected_background: "背景",
  director_combined: "导演合成图",
};

const ROLE_ORDER = [
  "current_sketch",
  "current_frame",
  "current_video",
  "director_combined",
  "selected_background",
];

function BeatSectionHeader({
  primary,
  secondary,
  action,
}: {
  primary: string;
  secondary: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center justify-between py-2">
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="text-[13px] font-semibold text-white/60">{primary}</span>
        <span className="text-[12px] font-medium text-white/35">{secondary}</span>
      </span>
      {action}
    </div>
  );
}

function beatAssetItems(assets: LibraryAsset[]): { role: string; label: string; asset: LibraryAsset }[] {
  const map = new Map<string, LibraryAsset>();
  for (const a of assets) {
    if (ROLE_LABELS[a.role]) map.set(a.role, a);
  }
  return ROLE_ORDER
    .filter((role) => map.has(role))
    .map((role) => ({ role, label: ROLE_LABELS[role], asset: map.get(role)! }));
}

function BeatRow({
  beat,
  assets,
  allAssets,
  cacheToken,
}: {
  beat: number;
  assets: LibraryAsset[];
  allAssets: LibraryAsset[];
  cacheToken: string;
}) {
  const [open, setOpen] = useState(false);
  const items = beatAssetItems(assets);

  if (items.length === 0) return null;

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 py-1 text-[11px] text-white/60 hover:text-white/90 transition-colors"
      >
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
        />
        <span className="font-medium">
          Beat {beat}
        </span>
        <span className="text-[10px] text-white/30">({items.length})</span>
      </button>
      {open && (
        <div className="grid grid-cols-3 gap-1.5 pt-1.5">
          {items.map(({ role, label, asset }) => (
            <div key={role} className="space-y-1.5">
              <MiniThumb
                asset={asset}
                index={allAssets.indexOf(asset)}
                onAdd={() => addAssetToCanvas(asset, allAssets.indexOf(asset))}
                cacheToken={cacheToken}
              />
              <span className="block text-left text-[12px] text-white/70">{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── 剧集（可折叠） ─────────────────── */

function EpisodeSection({
  episode,
  assets,
  allAssets,
  cacheToken,
}: {
  episode: number;
  assets: LibraryAsset[];
  allAssets: LibraryAsset[];
  cacheToken: string;
}) {
  const [open, setOpen] = useState(true);

  // Group by beat
  const beatMap = new Map<number, LibraryAsset[]>();
  for (const a of assets) {
    const ep = a.source.episode as number | undefined;
    const b = a.source.beat as number | undefined;
    if (ep === episode && typeof b === "number") {
      const list = beatMap.get(b) ?? [];
      list.push(a);
      beatMap.set(b, list);
    }
  }

  const beats = [...beatMap.entries()].sort(([a], [b]) => a - b);
  if (beats.length === 0) return null;

  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left transition-colors hover:[&_span:first-child]:text-white/75"
      >
        <BeatSectionHeader
          primary={`第${episode}集`}
          secondary={`${beats.length} Beat`}
          action={(
            <ChevronDown
              className={`h-3.5 w-3.5 text-white/45 transition-transform duration-200 ${open ? "rotate-0" : "-rotate-90"}`}
            />
          )}
        />
      </button>
      {open && (
        <div className="pb-2">
          {beats.map(([beatNum, beatAssets]) => (
            <BeatRow
              key={beatNum}
              beat={beatNum}
              assets={beatAssets}
              allAssets={allAssets}
              cacheToken={cacheToken}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── Beat 面板（新设计） ─────────────────── */

function DefaultCanvasBeatPanel({
  beatContext,
  assets,
  cacheToken,
}: {
  beatContext: FreezoneBeatContextResponse | null;
  assets: LibraryAsset[];
  cacheToken: string;
}) {
  const episodes = beatContext?.episodes ?? [];

  if (assets.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-xs text-white/25">
        暂无镜头上下文素材
      </div>
    );
  }

  return (
    <div className="min-h-0 overflow-y-auto px-3 pt-1">
      {episodes.map((ep) => {
        const epAssets = assets.filter(
          (a) => (a.source.episode as number | undefined) === ep.episode,
        );
        if (epAssets.length === 0) return null;
        return (
          <EpisodeSection
            key={ep.episode}
            episode={ep.episode}
            assets={epAssets}
            allAssets={assets}
            cacheToken={cacheToken}
          />
        );
      })}
    </div>
  );
}

/* ─────────────────── 主面板 ─────────────────── */

export function AssetLibraryPanel({
  project,
  metadata,
  collapsed: collapsedProp,
  onCollapsedChange,
  onReplaced,
  currentCanvasId,
  onRestoreMainlineDefault,
  reloadToken,
}: AssetLibraryPanelProps) {
  const canvasKind = resolveCanvasKind(metadata);
  const beatTabLabel =
    canvasKind === "default" || canvasKind === "blank"
      ? "全部Beat"
      : canvasKind === "episode"
        ? "本集Beat"
        : "当前Beat";
  const tabs: Array<{ id: AssetTab; label: string }> = [
    { id: "beat", label: beatTabLabel },
    { id: "characters", label: "人物" },
    { id: "scenes", label: "场景" },
    { id: "props", label: "道具" },
  ];

  const [panelTab, setPanelTab] = useState<PanelTab>("canvases");
  // 后台可以按用户组关掉「虾集(主线)」;关掉后左侧的「主线资产」tab 也要一起隐藏
  //(「项目画布」保留),否则顶部导航没了虾集、这里却还能翻出主线的资产。
  // 加载中先按可用处理,与顶部导航一致。
  const productSurfaces = useProductSurfaces();
  const mainlineAvailable =
    surfaceAccess(productSurfaces.data, "mainline")?.available ?? productSurfaces.isPending;
  useEffect(() => {
    if (!mainlineAvailable) setPanelTab("canvases");
  }, [mainlineAvailable]);
  const panelTabItems: Array<{ id: PanelTab; label: string }> = [
    { id: "canvases", label: "项目画布" },
    ...(mainlineAvailable ? [{ id: "library" as const, label: "主线资产" }] : []),
    { id: "assets", label: "资产库" },
  ];
  const [tab, setTab] = useState<AssetTab>("beat");
  const [query, setQuery] = useState("");
  // 侧栏的「资产库」只读，写操作都在弹窗里；tab 条右端常驻一个入口，不管当前停在
  // 哪个 tab 都能打开。
  const [assetManagerOpen, setAssetManagerOpen] = useState(false);
  const queryClient = useQueryClient();
  const hasPresetLabel = hasLegacyPresetCanvasMetadata(metadata);
  // 替换/提交成功后自增,用于强制重新拉取素材列表。
  const [internalReloadToken, setInternalReloadToken] = useState(0);
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = collapsedProp ?? internalCollapsed;
  const setCollapsed = (next: boolean) => {
    if (onCollapsedChange) {
      onCollapsedChange(next);
    } else {
      setInternalCollapsed(next);
    }
  };

  const projectAssetsQuery = useFreezoneProjectAssets(project);
  const projectAssets = projectAssetsQuery.data ?? [];
  const projectAssetsReloadKey = `${internalReloadToken}:${reloadToken ?? 0}`;
  const previousProjectAssetsReloadKeyRef = useRef(projectAssetsReloadKey);

  useEffect(() => {
    if (previousProjectAssetsReloadKeyRef.current === projectAssetsReloadKey) return;
    previousProjectAssetsReloadKeyRef.current = projectAssetsReloadKey;
    void projectAssetsQuery.refetch();
  }, [projectAssetsQuery, projectAssetsReloadKey]);

  const currentEpisode = useMemo(
    () => resolveCurrentEpisode(metadata),
    [metadata],
  );
  const currentBeat = useMemo(
    () => resolveCurrentBeat(metadata),
    [metadata],
  );

  const beatContextEnabled =
    canvasKind !== "asset" &&
    !(canvasKind === "episode" && currentEpisode === null) &&
    !(canvasKind === "beat" && (currentEpisode === null || currentBeat === null));
  const beatContextQuery = useFreezoneBeatContext(
    project,
    {
      episode: typeof currentEpisode === "number" ? currentEpisode : null,
      beat: canvasKind === "beat" && typeof currentBeat === "number" ? currentBeat : null,
    },
    beatContextEnabled,
  );
  const beatContext = beatContextEnabled ? (beatContextQuery.data ?? null) : null;
  const beatContextReloadKey = `${internalReloadToken}:${reloadToken ?? 0}`;
  const previousBeatContextReloadKeyRef = useRef(beatContextReloadKey);

  useEffect(() => {
    if (previousBeatContextReloadKeyRef.current === beatContextReloadKey) return;
    previousBeatContextReloadKeyRef.current = beatContextReloadKey;
    if (!beatContextEnabled) return;
    void beatContextQuery.refetch();
  }, [beatContextEnabled, beatContextQuery, beatContextReloadKey]);

  const projectAssetsError =
    projectAssetsQuery.error instanceof Error
      ? projectAssetsQuery.error.message
      : projectAssetsQuery.error
        ? String(projectAssetsQuery.error)
        : null;
  const beatContextError =
    beatContextQuery.error instanceof Error
      ? beatContextQuery.error.message
      : beatContextQuery.error
        ? String(beatContextQuery.error)
        : null;
  const error = projectAssetsError ?? beatContextError;

  const assets = useMemo(
    () => buildLibraryAssets({ project, metadata, projectAssets, beatContext, canvasKind }),
    [project, metadata, projectAssets, beatContext, canvasKind],
  );
  const assetPreviewCacheToken = `${internalReloadToken}:${reloadToken ?? 0}`;
  const assetImageCacheToken = assetPreviewCacheToken;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (tab === "beat") {
        if (!asset.source.from_beat_context) return false;
      } else if (asset.tab !== tab) {
        return false;
      }
      if (!q) return true;
      return `${asset.label} ${asset.sublabel ?? ""} ${asset.kind} ${asset.role}`
        .toLowerCase()
        .includes(q);
    });
  }, [assets, query, tab]);

  // —— 拖拽节点替换素材 ——
  const pendingReplace = useAssetDropStore((s) => s.pendingReplace);
  const clearPendingReplace = useAssetDropStore((s) => s.clearPendingReplace);
  const [replaceBusyId, setReplaceBusyId] = useState<string | null>(null);
  const confirmingAssetId = pendingReplace?.assetId ?? null;

  const handleCancelReplace = useCallback(() => {
    clearPendingReplace();
  }, [clearPendingReplace]);

  const handleConfirmReplace = useCallback(
    (asset: LibraryAsset) => {
      const replace = useAssetDropStore.getState().pendingReplace;
      if (!replace || replace.assetId !== asset.id) return;
      const target = assetToPushTarget(asset.source);
      if (!target) {
        const src = asset.source as Record<string, unknown>;
        console.warn("[freezone] 无法推断替换目标", asset.label, asset.source);
        onReplaced?.(
          null,
          `无法识别「${asset.label}」的提交目标（kind=${String(src.kind)} / role=${String(src.role)}）`,
        );
        clearPendingReplace();
        return;
      }
      if (target.kind === "director_render") {
        setReplaceBusyId(asset.id);
        commitDirectorRenderFromCanvasSource(project, target, {
          sourceUrl: replace.sourceUrl,
          bundle: replace.directorControlBundle,
          sourceNodeId: replace.nodeId,
          label: replace.label,
        })
          .then((result) => {
            setInternalReloadToken((t) => t + 1);
            onReplaced?.({ target, result }, `已提交到「${asset.label}」`);
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            onReplaced?.(null, `替换「${asset.label}」失败：${msg}`);
          })
          .finally(() => {
            setReplaceBusyId(null);
            clearPendingReplace();
          });
        return;
      }
      const sourceUrl = replace.sourceUrl;
      setReplaceBusyId(asset.id);
      promoteToAsset(project, sourceUrl, target, { mark_stale: false })
        .then((result) => {
          // 重新拉取素材列表,让左侧缩略图同步成最新资产。
          setInternalReloadToken((t) => t + 1);
          onReplaced?.({ target, result }, `已用画布节点替换「${asset.label}」`);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          onReplaced?.(null, `替换「${asset.label}」失败：${msg}`);
        })
        .finally(() => {
          setReplaceBusyId(null);
          clearPendingReplace();
        });
    },
    [clearPendingReplace, onReplaced, project],
  );

  const replaceContextValue = useMemo<AssetReplaceContextValue>(
    () => ({
      confirmingAssetId,
      busyAssetId: replaceBusyId,
      onConfirm: handleConfirmReplace,
      onCancel: handleCancelReplace,
    }),
    [confirmingAssetId, replaceBusyId, handleConfirmReplace, handleCancelReplace],
  );

  const tabCounts = useMemo(
    () => tabs.map((t) => ({ ...t, count: countAssetsForTab(assets, t.id) })),
    [assets],
  );

  return (
    <AssetReplaceContext.Provider value={replaceContextValue}>
      <aside
        className="pointer-events-none absolute inset-y-0 left-0 z-30 overflow-visible"
      >
        {/* 折叠/展开胶囊 — 停在卡片右侧的画布上 */}
        <div
          className="group/handle pointer-events-auto absolute top-3 z-30 flex h-10 w-10 items-center justify-center transition-[left] duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ left: collapsed ? 16 : 312 }}
        >
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开素材抽屉" : "收起素材抽屉"}
            aria-expanded={!collapsed}
            className={`group/btn relative flex h-10 w-10 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 ${
              collapsed
                ? "text-white/82 hover:text-white"
                : "text-white/68 hover:text-white/92"
            }`}
          >
            <span
              className={`flex h-9 w-9 items-center justify-center rounded-[10px] border shadow-[0_10px_28px_rgba(0,0,0,0.30)] backdrop-blur-xl transition-[background-color,border-color,box-shadow] duration-200 ${
                collapsed
                  ? "border-white/18 bg-white/[0.09] group-hover/btn:border-white/26 group-hover/btn:bg-white/[0.13]"
                  : "border-white/10 bg-white/[0.05] group-hover/btn:border-white/15 group-hover/btn:bg-white/[0.08]"
              }`}
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <ChevronLeft className="h-4 w-4" />
              )}
            </span>
          </button>
          <span
            className="pointer-events-none absolute left-11 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#101116]/95 px-2 py-1 text-[11px] font-medium text-white/75 opacity-0 shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition-opacity duration-150 group-hover/handle:opacity-100"
          >
            {collapsed ? "展开" : "收起"}
          </span>
        </div>

        {/* 贴左边直出的抽屉：满高、不留外边距，收起时整块滑到屏幕外 */}
        <div
          className={`flex h-full flex-col min-h-0 overflow-hidden rounded-r-2xl border-r border-[rgb(var(--border-rgb))] bg-[rgb(var(--surface-rgb))] transition-transform duration-[360ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
            collapsed
              ? "pointer-events-none -translate-x-full"
              : "pointer-events-auto translate-x-0"
          }`}
          style={{ width: 300 }}
        >
          {/* ─ 面板 Tab 栏 ── 与下面的画布条同一种下划线 tab，后续加新 tab 只往
              panelTabItems 里塞一项即可 */}
          <Tabs
            value={panelTab}
            onValueChange={(value) => setPanelTab(value as PanelTab)}
            className="shrink-0 gap-0 px-3 pt-3"
          >
            {/* 整行共用一条基线，选中 tab 的下划线正好压在上面 */}
            <div className="flex items-center gap-1 border-b border-white/[0.07]">
              <TabsList variant="line" className="gap-0 p-0">
                {panelTabItems.map((item) => (
                  <TabsTrigger
                    key={item.id}
                    value={item.id}
                    // after:bottom-0 让下划线落在整行的基线上，而不是浮在下面 5px。
                    // 文字一律纯白（组件默认给未选中 tab 压了透明度），选中与否只靠
                    // 下划线区分——300px 的侧栏里三个 tab 挨着，灰字读起来太吃力。
                    // 下划线用 accent 而不是白：全白标签 + 白下划线，选中态几乎不成立；
                    // 顺便这也是整块侧栏里唯一的品牌色落点。
                    className="h-full flex-none rounded-none px-2.5 text-xs text-white after:bg-[rgb(var(--accent-rgb))] hover:text-white data-active:text-white dark:text-white dark:hover:text-white dark:data-active:text-white group-data-horizontal/tabs:after:bottom-0"
                  >
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <button
                type="button"
                onClick={() => setAssetManagerOpen(true)}
                aria-label="资产管理"
                title="资产管理"
                className="group/assets relative ml-auto mb-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] border border-white/[0.10] text-white/60 transition-colors hover:border-white/[0.22] hover:bg-white/[0.06] hover:text-white/90"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span className="pointer-events-none absolute right-0 top-8 z-20 whitespace-nowrap rounded-[6px] border border-white/10 bg-[#101116]/95 px-2 py-1 text-[11px] font-medium text-white/75 opacity-0 shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition-opacity duration-150 group-hover/assets:opacity-100">
                  资产管理
                </span>
              </button>
            </div>
          </Tabs>

          {panelTab === "library" && mainlineAvailable ? (
            <>
              {/* ── 分类标签 + 搜索（固定头部） ── */}
              <div className="sticky top-0 z-10">
                <div className="ui-scrollbar-hidden flex items-center gap-1 overflow-x-auto px-3 pt-2.5 pb-2">
                  {tabCounts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                        tab === item.id
                          ? "text-white"
                          : "text-white/35 hover:text-white/60"
                      }`}
                    >
                      {item.label}
                      {item.count > 0 ? (
                        <span className="ml-0.5 text-[10px] opacity-60">({item.count})</span>
                      ) : null}
                    </button>
                  ))}
                </div>
                <div className="px-3 pt-1.5 pb-2">
                  <div className="relative">
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索素材..."
                      className="w-full h-7 rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 text-[11px] text-white/80 placeholder:text-white/40 focus:outline-none focus:border-white/[0.12] transition-colors"
                    />
                  </div>
                </div>
              </div>

              {/* ─ 列表内容 ── */}
              {error ? (
                <div className="mx-3 mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
                  项目素材加载失败：{error}
                </div>
              ) : tab === "beat" ? (
                <BeatContextPanel
                  metadata={metadata}
                  assets={filtered}
                  canvasKind={canvasKind}
                  beatContext={beatContext}
                  cacheToken={assetImageCacheToken}
                />
              ) : filtered.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-xs text-white/25">
                  当前分类没有可用素材
                </div>
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-1.5">
                  {filtered.map((asset, index) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      index={index}
                      cacheToken={assetImageCacheToken}
                      onAdd={() => addAssetToCanvas(asset, index)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : panelTab === "assets" ? (
            <AssetLibraryBrowser
              project={project}
              onSendToCanvas={(entry) => void sendLibraryItemToCanvas(entry)}
            />
          ) : (
            <CanvasesTab
              project={project}
              currentCanvasId={currentCanvasId}
              onRestoreMainlineDefault={onRestoreMainlineDefault}
              hasPresetLabel={hasPresetLabel}
              reloadToken={reloadToken}
              collapsed={collapsed}
            />
          )}
        </div>
      </aside>

      {/* 纯管理态：不传 onConfirm，弹窗里选中只是浏览，「确定」等同关闭。关掉后把
          资产库的两个查询作废，新建的文件夹/上传的素材立刻反映到侧栏。 */}
      <AssetLibraryModal
        open={assetManagerOpen}
        project={project}
        onSendFolderToCanvas={(folder) => void sendAssetFolderToCanvas(folder)}
        onClose={() => {
          setAssetManagerOpen(false);
          void queryClient.invalidateQueries({
            queryKey: queryKeys.freezoneAssetLibrary(project),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.freezoneAssetLibraryFolders(project),
          });
        }}
      />
    </AssetReplaceContext.Provider>
  );
}

/* ─────────────────── 辅助组件 ─────────────────── */

function BeatContextPanel({
  metadata,
  assets,
  canvasKind,
  beatContext,
  cacheToken,
}: {
  metadata: Record<string, unknown> | null;
  assets: LibraryAsset[];
  canvasKind: CanvasKind;
  beatContext: FreezoneBeatContextResponse | null;
  cacheToken: string;
}) {
  if (canvasKind === "default" || canvasKind === "blank" || canvasKind === "episode") {
    return (
      <DefaultCanvasBeatPanel beatContext={beatContext} assets={assets} cacheToken={cacheToken} />
    );
  }
  if (canvasKind !== "beat") {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-xs text-white/25">
        当前画布没有镜头上下文
      </div>
    );
  }
  return <PresetBeatPanel metadata={metadata} assets={assets} cacheToken={cacheToken} />;
}

function PresetBeatPanel({
  metadata,
  assets,
  cacheToken,
}: {
  metadata: Record<string, unknown> | null;
  assets: LibraryAsset[];
  cacheToken: string;
}) {
  const groups = groupBeatAssets(assets);
  const preset = (metadata?.preset ?? {}) as Record<string, unknown>;
  const defaultTarget = (metadata?.default_push_target ?? null) as
    | Record<string, unknown>
    | null;
  const episode =
    typeof preset.episode === "number"
      ? preset.episode
      : typeof defaultTarget?.episode === "number"
        ? defaultTarget.episode
        : null;
  const beatNum =
    typeof preset.beat === "number"
      ? preset.beat
      : typeof defaultTarget?.beat === "number"
        ? defaultTarget.beat
        : null;

  return (
    <div className="min-h-0 overflow-y-auto px-3 pt-1 pb-3 space-y-3">
      <BeatSectionHeader
        primary={episode !== null ? `第${episode}集` : "第?集"}
        secondary={beatNum !== null ? `Beat ${beatNum}` : "Beat ?"}
      />

      {assets.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-xs text-white/25">
          当前镜头没有可用上下文素材
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.id}>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white/30 mb-1.5">
              {group.label}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {group.assets.map((asset) => (
                <MiniThumb
                  key={asset.id}
                  asset={asset}
                  index={assets.indexOf(asset)}
                  onAdd={() => addAssetToCanvas(asset, assets.indexOf(asset))}
                  cacheToken={cacheToken}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ─────────────────── AssetCard（非 beat tab 用） ─────────────────── */

function AssetCard({
  asset,
  index,
  onAdd,
  cacheToken,
}: {
  asset: LibraryAsset;
  index: number;
  cacheToken: string;
  onAdd: () => void;
}) {
  const isThreeD = isThreeDAsset(asset);
  const isAudio = asset.mediaType === "audio";
  const isVideo = asset.mediaType === "video";
  const thumbUrl = isThreeD || isVideo ? asset.coverUrl : asset.url;
  const displayThumbUrl = thumbUrl ? withImageCacheBust(thumbUrl, cacheToken) : null;
  const showImage =
    !isAudio &&
    Boolean(thumbUrl) &&
    (!isThreeD || Boolean(asset.coverUrl)) &&
    (!isVideo || Boolean(asset.coverUrl));
  // 视频没有后端封面时，用 <video> 抓首帧当缩略图。
  const videoPosterUrl =
    isVideo && !asset.coverUrl && asset.url
      ? `${withImageCacheBust(asset.url, cacheToken)}#t=0.1`
      : null;
  const disabled = !isThreeD && (asset.mediaType === "text" || asset.mediaType === "file");
  const dropMediaType = assetDropMediaType(asset);
  const activeDrag = useAssetDropStore((s) => s.activeDrag);
  const target = assetToPushTarget(asset.source);
  const replaceable =
    asset.source.pushable !== false &&
    Boolean(dropMediaType) &&
    target !== null &&
    (target.kind !== "director_render" || activeDrag?.mediaType === "image");
  const hoverAssetId = useAssetDropStore((s) => s.hoverAssetId);
  const isDropHover = replaceable && hoverAssetId === asset.id;
  const replaceCtx = useContext(AssetReplaceContext);
  const isConfirming = replaceCtx?.confirmingAssetId === asset.id;
  const isReplacing = replaceCtx?.busyAssetId === asset.id;
  const dragPayload = disabled ? null : assetToDragPayload(asset);
  const typeBadge = sceneAssetTypeBadge(asset);

  const handleDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragPayload) return;
    event.dataTransfer.setData(CANVAS_ASSET_DRAG_MIME, JSON.stringify(dragPayload));
    event.dataTransfer.effectAllowed = "copy";
    const preview = createAssetDragImage(event.currentTarget, asset);
    if (preview) {
      event.dataTransfer.setDragImage(preview, 24, 24);
      window.setTimeout(() => preview.remove(), 0);
    }
  };

  return (
    <div
      data-asset-id={replaceable ? asset.id : undefined}
      data-asset-media-type={replaceable ? dropMediaType ?? undefined : undefined}
      draggable={Boolean(dragPayload)}
      onDragStart={handleDragStart}
      className={`group relative flex items-center gap-3 rounded-[8px] border border-transparent px-1.5 py-2 cursor-pointer transition-all duration-200 hover:border-white/[0.08] hover:bg-white/[0.04] ${
        dragPayload ? "active:cursor-grabbing" : ""
      } ${isDropHover ? "opacity-70" : ""}`}
      onClick={onAdd}
    >
      <div
        data-drag-thumb
        className="relative h-[80px] w-[60px] shrink-0 overflow-hidden rounded-[6px] bg-black/30 border border-white/[0.06] flex items-center justify-center transition-colors duration-200 group-hover:border-white/[0.14]"
      >
        {showImage ? (
          <img
            src={displayThumbUrl ?? ""}
            alt={asset.label}
            className="h-full w-full object-cover"
            loading={index < 8 ? "eager" : "lazy"}
            draggable={false}
          />
        ) : isAudio ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[rgba(21,215,232,0.15)] to-transparent">
            <AudioLines className="h-5 w-5 text-white/40" />
          </div>
        ) : videoPosterUrl ? (
          <div className="relative h-full w-full">
            <video
              src={videoPosterUrl}
              className="h-full w-full object-cover bg-black"
              preload="metadata"
              muted
              playsInline
              tabIndex={-1}
            />
            <div className="pointer-events-none absolute bottom-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/65 ring-1 ring-white/15">
              <Video className="h-2.5 w-2.5 text-white/90" />
            </div>
          </div>
        ) : isVideo ? (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/[0.08] to-transparent">
            <Video className="h-5 w-5 text-white/40" />
          </div>
        ) : (
          <span className="text-[10px] uppercase tracking-wide text-white/25">
            {isThreeD ? "3gs" : asset.mediaType}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="truncate text-sm font-medium text-white/80" title={asset.label}>
            {asset.label}
          </div>
          {typeBadge ? (
            <span
              className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${typeBadge.className}`}
              title={typeBadge.title}
            >
              {typeBadge.label}
            </span>
          ) : null}
        </div>
        <div
          className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/35"
          title={asset.sublabel}
        >
          {asset.sublabel || asset.role}
        </div>
      </div>
      <button
        type="button"
        className="tap-button h-6 px-2 text-[11px] opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 hover:border-white/20 hover:text-white/90 disabled:opacity-40 text-white/50 border border-white/10 rounded"
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        title="加入画布"
        disabled={disabled}
      >
        加入
      </button>
      {isConfirming && (
        <div className="absolute inset-0 z-10 flex flex-col justify-center gap-1.5 rounded-lg bg-[#0c0c0e]/95 px-2.5 backdrop-blur-sm">
          <div className="line-clamp-2 text-[11px] leading-snug text-white/80">
            用画布节点替换「{asset.label}」？
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              className="h-6 flex-1 text-[11px] border border-white/15 text-white/80 hover:bg-white/[0.06] disabled:opacity-50 rounded-md"
              onClick={() => replaceCtx?.onConfirm(asset)}
              disabled={isReplacing}
            >
              {isReplacing ? "替换中…" : "替换"}
            </button>
            <button
              type="button"
              className="h-6 flex-1 text-[11px] text-white/40 hover:text-white/70 disabled:opacity-50 rounded-md"
              onClick={() => replaceCtx?.onCancel()}
              disabled={isReplacing}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function createAssetDragImage(source: HTMLElement, asset: LibraryAsset): HTMLElement | null {
  if (typeof document === "undefined") return null;

  const thumb = source.querySelector<HTMLElement>("[data-drag-thumb]");
  const preview = document.createElement("div");
  preview.style.position = "fixed";
  preview.style.left = "-1000px";
  preview.style.top = "-1000px";
  preview.style.zIndex = "2147483647";
  preview.style.display = "flex";
  preview.style.alignItems = "center";
  preview.style.gap = "10px";
  preview.style.width = "210px";
  preview.style.minHeight = "72px";
  preview.style.padding = "8px";
  preview.style.borderRadius = "10px";
  preview.style.border = "1px solid rgba(255,255,255,0.12)";
  preview.style.background = "rgba(24,25,30,0.92)";
  preview.style.boxShadow = "0 14px 34px rgba(0,0,0,0.38)";
  preview.style.backdropFilter = "blur(12px)";
  preview.style.pointerEvents = "none";

  if (thumb) {
    const thumbClone = thumb.cloneNode(true) as HTMLElement;
    thumbClone.removeAttribute("data-drag-thumb");
    thumbClone.style.width = "48px";
    thumbClone.style.height = "64px";
    thumbClone.style.flexShrink = "0";
    thumbClone.style.borderRadius = "7px";
    thumbClone.style.transform = "none";
    preview.appendChild(thumbClone);
  }

  const textWrap = document.createElement("div");
  textWrap.style.minWidth = "0";
  textWrap.style.flex = "1";

  const title = document.createElement("div");
  title.textContent = asset.label;
  title.style.overflow = "hidden";
  title.style.textOverflow = "ellipsis";
  title.style.whiteSpace = "nowrap";
  title.style.fontSize = "13px";
  title.style.fontWeight = "600";
  title.style.color = "rgba(255,255,255,0.88)";

  const subtitle = document.createElement("div");
  subtitle.textContent = asset.sublabel || asset.role;
  subtitle.style.marginTop = "5px";
  subtitle.style.overflow = "hidden";
  subtitle.style.textOverflow = "ellipsis";
  subtitle.style.whiteSpace = "nowrap";
  subtitle.style.fontSize = "11px";
  subtitle.style.color = "rgba(255,255,255,0.42)";

  textWrap.append(title, subtitle);
  preview.appendChild(textWrap);
  document.body.appendChild(preview);
  return preview;
}

/* ─────────────────── 纯逻辑函数（与原版一致） ─────────────────── */

function buildLibraryAssets({
  project,
  metadata,
  projectAssets,
  beatContext,
  canvasKind,
}: {
  project: string;
  metadata: Record<string, unknown> | null;
  projectAssets: FreezoneProjectAsset[];
  beatContext: FreezoneBeatContextResponse | null;
  canvasKind: CanvasKind;
}): LibraryAsset[] {
  const out: LibraryAsset[] = [];
  const seen = new Set<string>();

  const groupedBeatAssets = beatContext?.episodes.flatMap((episode) =>
    episode.beats.flatMap((beat) =>
      beat.assets.map((asset) => ({ asset, beat })),
    ),
  ) ?? [];
  if (groupedBeatAssets.length > 0) {
    for (const { asset, beat } of groupedBeatAssets) {
      if (!isUsableAsset(asset)) continue;
      addUnique(
        out,
        seen,
        fromFreezoneAsset(asset, {
          fromBeatContext: true,
          projectId: project,
          beatContext: beatContextFromBeat(project, beat),
        }),
      );
    }
  } else {
    for (const asset of beatContext?.assets ?? []) {
      if (!isUsableAsset(asset)) continue;
      addUnique(out, seen, fromFreezoneAsset(asset, { fromBeatContext: true, projectId: project }));
    }
  }
  if (canvasKind !== "default") {
    const refs = Array.isArray(metadata?.references)
      ? (metadata?.references as PresetReference[])
      : [];
    for (const ref of refs) {
      if (!ref?.url || ref.exists === false) continue;
      if (!isMainlinePresetReference(ref)) continue;
      if (isSceneAuxiliaryRole(ref.role)) continue;
      if (refIsFreezonePath(ref)) continue;
      addUnique(out, seen, fromPresetReference(ref));
    }
  }

  for (const asset of projectAssets) {
    if (!isUsableAsset(asset)) continue;
    addUnique(out, seen, fromFreezoneAsset(asset, { fromBeatContext: false, projectId: project }));
  }
  attachThreeDCovers(out);
  return coalesceSceneDirectorWorldAssets(out);
}

function attachThreeDCovers(assets: LibraryAsset[]): void {
  const SCENE_ROLE_PRIORITY: Record<string, number> = {
    scene_master: 0,
    scene_reverse_master: 1,
    scene_director_pano_360: 2,
  };
  const bySceneId = new Map<string, { url: string; priority: number }>();
  for (const asset of assets) {
    if (asset.mediaType !== "image") continue;
    const sceneId =
      typeof asset.source.meta === "object" && asset.source.meta !== null
        ? ((asset.source.meta as Record<string, unknown>).scene_id as string | undefined)
        : undefined;
    if (!sceneId) continue;
    const priority = SCENE_ROLE_PRIORITY[asset.role] ?? 99;
    const existing = bySceneId.get(sceneId);
    if (!existing || priority < existing.priority) {
      bySceneId.set(sceneId, { url: asset.url, priority });
    }
  }
  for (const asset of assets) {
    if (asset.coverUrl) continue;
    if (!isThreeDAsset(asset)) continue;
    const sceneId =
      typeof asset.source.meta === "object" && asset.source.meta !== null
        ? ((asset.source.meta as Record<string, unknown>).scene_id as string | undefined)
        : undefined;
    if (!sceneId) continue;
    const cover = bySceneId.get(sceneId);
    if (cover) asset.coverUrl = cover.url;
  }
}

function coalesceSceneDirectorWorldAssets(assets: LibraryAsset[]): LibraryAsset[] {
  const grouped = new Map<string, LibraryAsset[]>();
  for (const asset of assets) {
    if (!isSceneDirectorWorldSourceRole(asset.role)) continue;
    const sceneId = sceneIdForLibraryAsset(asset);
    if (!sceneId) continue;
    const group = grouped.get(sceneId) ?? [];
    group.push(asset);
    grouped.set(sceneId, group);
  }
  if (grouped.size === 0) return assets;

  const emittedScenes = new Set<string>();
  const next: LibraryAsset[] = [];
  for (const asset of assets) {
    const sceneId = sceneIdForLibraryAsset(asset);
    if (sceneId && grouped.has(sceneId) && isSceneDirectorWorldSourceRole(asset.role)) {
      if (!emittedScenes.has(sceneId)) {
        emittedScenes.add(sceneId);
        const bundled = createSceneDirectorWorldAsset(
          sceneId,
          grouped.get(sceneId) ?? [],
          assets.filter((candidate) => sceneIdForLibraryAsset(candidate) === sceneId),
        );
        if (bundled) next.push(bundled);
      }
      continue;
    }
    next.push(asset);
  }
  return next;
}

function createSceneDirectorWorldAsset(
  sceneId: string,
  sourceAssets: LibraryAsset[],
  sceneAssets: LibraryAsset[],
): LibraryAsset | null {
  const rawSources = sourceAssets
    .map((asset) => directorWorldSourceFromSceneAsset(sceneId, asset))
    .filter((source): source is DirectorWorldSource => source !== null);
  if (rawSources.length === 0) return null;

  const activeSource =
    rawSources.find((source) => source.current) ??
    rawSources.find((source) => source.source_type === "sog") ??
    rawSources[0];
  const sources = rawSources.map((source) => ({
    ...source,
    current: rawSources.some((candidate) => candidate.current)
      ? source.current
      : source.id === activeSource?.id,
  }));
  const cover =
    sceneCoverAsset(sceneAssets)?.url ??
    sourceAssets.find((asset) => asset.coverUrl)?.coverUrl ??
    sourceAssets.find((asset) => asset.mediaType === "image")?.url;
  const representative =
    sourceAssets.find((asset) => asset.url === directorWorldSourceUrl(activeSource)) ??
    sourceAssets[0];
  const sceneLabel = sceneLabelForLibraryAsset(representative, sceneId);
  const meta = {
    ...(recordValue(representative.source.meta) ?? {}),
    scene_id: sceneId,
    scene: sceneLabel,
    source_count: sources.length,
  };

  return {
    id: `scene-director-world:${sceneId}`,
    tab: "scenes",
    kind: "director",
    role: SCENE_DIRECTOR_WORLD_ROLE,
    label: `${sceneLabel} / 导演世界`,
    sublabel: `包含 ${sources.length} 个导演源`,
    url: directorWorldSourceUrl(activeSource) ?? representative.url,
    aspectRatio: "1:1",
    mediaType: "file",
    coverUrl: cover,
    mainlineContext: sceneMainlineContext(sceneAssets, representative, sceneId),
    source: {
      ...representative.source,
      kind: "director",
      role: SCENE_DIRECTOR_WORLD_ROLE,
      label: `${sceneLabel} / 导演世界`,
      meta,
      media_type: "file",
      rel_path: undefined,
      slot_target: undefined,
      pushable: false,
      director_world_sources: sources,
      active_source_id: activeSource?.id,
      mainline_context: sceneMainlineContext(sceneAssets, representative, sceneId),
    },
  };
}

function isSceneDirectorWorldSourceRole(role: string | undefined): boolean {
  return (
    role === "scene_director_pano_360" ||
    role === "scene_3gs_master_ply" ||
    role === "scene_3gs_reverse_ply" ||
    role === "scene_3gs_pano_ply" ||
    role === "scene_3gs_custom_scene"
  );
}

function sceneIdForLibraryAsset(asset: LibraryAsset): string | null {
  const meta = recordValue(asset.source.meta);
  const sceneId = stringValue(meta?.scene_id) || stringValue(asset.source.scene_id);
  return sceneId || null;
}

function sceneLabelForLibraryAsset(asset: LibraryAsset, sceneId: string): string {
  const meta = recordValue(asset.source.meta);
  return stringValue(meta?.scene) || stringValue(meta?.scene_name) || sceneId;
}

function sceneMainlineContext(
  sceneAssets: LibraryAsset[],
  representative: LibraryAsset,
  sceneId: string,
): MainlineContext[] {
  const existing =
    sceneAssets.find((asset) => asset.mainlineContext?.length)?.mainlineContext ??
    representative.mainlineContext;
  const sceneContext = existing?.find((ctx) => ctx.kind === "scene" && ctx.sceneId === sceneId);
  if (sceneContext) return [sceneContext];
  return [{
    kind: "scene",
    projectId: stringValue(representative.source.projectId),
    sceneId,
    role: SCENE_DIRECTOR_WORLD_ROLE,
    label: sceneLabelForLibraryAsset(representative, sceneId),
    sourceUrl: representative.url,
  }];
}

function sceneCoverAsset(sceneAssets: LibraryAsset[]): LibraryAsset | null {
  return (
    sceneAssets.find((asset) => asset.role === "scene_master" && asset.mediaType === "image") ??
    sceneAssets.find((asset) => asset.role === "scene_reverse_master" && asset.mediaType === "image") ??
    sceneAssets.find((asset) => asset.role === "scene_director_pano_360" && asset.mediaType === "image") ??
    null
  );
}

function directorWorldSourceFromSceneAsset(
  sceneId: string,
  asset: LibraryAsset,
): DirectorWorldSource | null {
  const sourceType = asset.role === "scene_director_pano_360" ? "pano360" : "sog";
  const sourceKind = sceneDirectorSourceKind(asset.role);
  const url = asset.url;
  if (!sourceKind || !url) return null;
  const id = sourceType === "pano360"
    ? `scene-pano:${sceneId}`
    : `legacy:${sourceKind}:${sourceType}:${directorSourceIdentityUrl(url)}`;
  return {
    id,
    source_type: sourceType,
    source_kind: sourceKind,
    label: sourceKindLabel({ source_kind: sourceKind, source_type: sourceType }),
    url,
    ply_url: sourceType === "sog" ? url : undefined,
    pano_url: sourceType === "pano360" ? url : undefined,
    slot_kind: sourceType === "pano360" ? "scene_director_pano_360" : undefined,
    current: Boolean(recordValue(asset.source.meta)?.current),
  };
}

function sceneDirectorSourceKind(
  role: string,
): NonNullable<DirectorWorldSource["source_kind"]> | null {
  if (role === "scene_3gs_master_ply") return "master";
  if (role === "scene_3gs_reverse_ply") return "reverse";
  if (role === "scene_3gs_pano_ply") return "pano";
  if (role === "scene_3gs_custom_scene") return "custom";
  if (role === "scene_director_pano_360") return "pano";
  return null;
}

function directorWorldSourceUrl(source: DirectorWorldSource | undefined): string | null {
  return source?.ply_url ?? source?.pano_url ?? source?.url ?? null;
}

function sourceKindLabel(source: Pick<DirectorWorldSource, "source_kind" | "source_type">): string {
  if (source.source_type === "pano360") return "360图";
  if (source.source_kind === "master") return "正面世界";
  if (source.source_kind === "reverse") return "背面世界";
  if (source.source_kind === "pano") return "360世界";
  if (source.source_kind === "custom") return "自定义世界";
  return "导演世界";
}

function isUsableAsset(asset: FreezoneProjectAsset): boolean {
  if (!asset.url) return false;
  if (asset.exists === false) return false;
  if (isSceneAuxiliaryRole(asset.role)) return false;
  if (typeof asset.rel_path === "string" && asset.rel_path.startsWith("freezone/")) {
    return isDirectorControlRef(asset.role, asset.rel_path);
  }
  return true;
}

function isSceneAuxiliaryRole(role: string | undefined): boolean {
  // scene_360 is the direct-pano slot. Assets > Scenes surfaces the canonical
  // director-world pano as scene_director_pano_360 instead.
  return (
    role === "scene_360" ||
    role === "scene_3gs_active_ply" ||
    role === "scene_3gs_collision_glb"
  );
}

function refIsFreezonePath(ref: PresetReference): boolean {
  const relPath = typeof ref.rel_path === "string" ? ref.rel_path : "";
  return relPath.startsWith("freezone/") && !isDirectorControlRef(ref.role, relPath);
}

function isDirectorControlRef(
  role: string | undefined,
  relPath: string | undefined | null,
): boolean {
  if (typeof relPath !== "string") return false;
  const validPath =
    relPath.startsWith("director_control_frames/ep") ||
    relPath.startsWith("freezone/director_control_frames/ep");
  if (!validPath) return false;
  if (role === "director_combined") return relPath.endsWith("/combined.png");
  return role === "selected_background" && relPath.endsWith("/selected_background.png");
}

function isBeatOutputRole(role: string | undefined): boolean {
  return (
    role === "director_combined" ||
    role === "selected_background" ||
    role === "current_sketch" ||
    role === "current_frame" ||
    role === "current_video" ||
    role === "current_audio"
  );
}

function isSceneAssetRole(role: string | undefined): boolean {
  const normalized = role || "";
  return (
    normalized === "scene_master" ||
    normalized === "scene_reverse_master" ||
    normalized === "scene_spatial_layout" ||
    normalized === SCENE_DIRECTOR_WORLD_ROLE ||
    normalized === "scene_director_pano_360" ||
    (normalized.startsWith("scene_3gs_") && !isSceneAuxiliaryRole(normalized))
  );
}

function sceneAssetTypeBadge(
  asset: LibraryAsset,
): { label: string; title: string; className: string } | null {
  if (asset.tab !== "scenes") return null;
  if (asset.role === "scene_master") {
    return {
      label: "正面图",
      title: "场景正面图",
      className: "border-sky-300/25 bg-sky-300/10 text-sky-100/90",
    };
  }
  if (asset.role === "scene_reverse_master") {
    return {
      label: "背面图",
      title: "场景背面图",
      className: "border-cyan-300/25 bg-cyan-300/10 text-cyan-100/90",
    };
  }
  if (asset.role === "scene_director_pano_360") {
    return {
      label: "360图",
      title: "360 全景图",
      className: "border-amber-300/30 bg-amber-300/10 text-amber-100/90",
    };
  }
  if (asset.role === SCENE_DIRECTOR_WORLD_ROLE) {
    return {
      label: "导演世界",
      title: "场景导演世界",
      className: "border-violet-300/30 bg-violet-300/10 text-violet-100/90",
    };
  }
  if (asset.role === "scene_3gs_master_ply") {
    return {
      label: "正面世界",
      title: "3D 导演世界（正面）",
      className: "border-violet-300/30 bg-violet-300/10 text-violet-100/90",
    };
  }
  if (asset.role === "scene_3gs_reverse_ply") {
    return {
      label: "背面世界",
      title: "3D 导演世界（背面）",
      className: "border-fuchsia-300/30 bg-fuchsia-300/10 text-fuchsia-100/90",
    };
  }
  if (asset.role === "scene_3gs_pano_ply") {
    return {
      label: "360世界",
      title: "3D 导演世界（360）",
      className: "border-violet-300/30 bg-violet-300/10 text-violet-100/90",
    };
  }
  if (asset.role === "scene_3gs_custom_scene") {
    return {
      label: "自定义世界",
      title: "3D 导演世界（自定义）",
      className: "border-rose-300/30 bg-rose-300/10 text-rose-100/90",
    };
  }
  return null;
}

function isMainlinePresetReference(ref: PresetReference): boolean {
  const role = ref.role || "";
  const kind = ref.kind || "";
  const relPath = ref.rel_path || "";
  if (kind === "director") {
    return isDirectorControlRef(role, relPath);
  }
  return (
    role === "current_sketch" ||
    role === "current_frame" ||
    role === "current_video" ||
    role === "current_audio"
  );
}

function tabForFreezoneAsset(asset: FreezoneProjectAsset): AssetTab {
  if (isBeatOutputRole(asset.role)) return "beat";
  if (asset.kind === "director" || asset.tab === "director") {
    return isSceneAssetRole(asset.role) ? "scenes" : "beat";
  }
  return asset.tab;
}

function fromFreezoneAsset(
  asset: FreezoneProjectAsset,
  flags: {
    fromBeatContext: boolean;
    projectId: string;
    beatContext?: MainlineContext & { episode: number; beat: number };
  },
): LibraryAsset {
  const meta = (asset.meta ?? {}) as Record<string, unknown>;
  const directorControlBundle = directorControlBundleFromAssetSource({
    kind: asset.kind,
    role: asset.role,
    rel_path: asset.rel_path,
    url: asset.url,
    director_control_bundle: asset.director_control_bundle ?? meta.director_control_bundle,
  });
  // 后端在 v2 把 3GS 归到 scenes，但 FreezoneProjectAsset.tab 仍保留 "director" 以兼容旧
  // payload —— 这里前端兜底归一化，避免遗留路径塞进已删除的 tab。
  const normalizedTab = tabForFreezoneAsset(asset);
  return {
    id: asset.id || asset.rel_path || (asset.url as string),
    tab: normalizedTab,
    kind: asset.kind,
    role: asset.role,
    label: normalizeMainlineAssetLabel(asset.label, asset.role),
    sublabel: asset.sublabel || asset.rel_path,
    url: asset.url as string,
    aspectRatio: asset.aspect_ratio || "1:1",
    mediaType: normalizeMediaType(asset.media_type, asset.kind),
    mainlineContext: asset.mainline_context,
    beatContext: flags.beatContext,
    source: {
      kind: asset.kind,
      role: asset.role,
      label: normalizeMainlineAssetLabel(asset.label, asset.role),
      rel_path: asset.rel_path,
      media_type: asset.media_type,
      meta,
      projectId: flags.projectId,
      episode: typeof meta.episode === "number" ? meta.episode : undefined,
      beat: typeof meta.beat === "number" ? meta.beat : undefined,
      beat_context: flags.beatContext,
      from_beat_context: flags.fromBeatContext,
      mainline_context: asset.mainline_context,
      ...(directorControlBundle ? { director_control_bundle: directorControlBundle } : {}),
      // 后端给出的 canonical 提交目标与可推送标记;assetToPushTarget 优先用 slot_target。
      slot_target: asset.slot_target ?? undefined,
      pushable: asset.pushable,
    },
  };
}

function beatContextFromBeat(
  project: string,
  beat: FreezoneBeatContextBeat,
): MainlineContext & { episode: number; beat: number } {
  return {
    kind: "beat",
    projectId: project,
    episode: beat.episode,
    beat: beat.beat,
    role: "beat_context",
    label: beat.label || `EP${beat.episode} / Beat ${beat.beat}`,
    visualDescription: beat.visual_description ?? "",
    narrationSegment: beat.narration_segment ?? "",
    sceneId: beat.scene_id ?? "",
    detectedIdentities: beat.detected_identities ?? [],
    detectedProps: beat.detected_props ?? [],
    sketchColors: beat.sketch_colors ?? {},
    propMarkerColors: beat.prop_marker_colors ?? {},
  };
}

function fromPresetReference(ref: PresetReference): LibraryAsset {
  const tab = tabForRef(ref);
  return {
    id: ref.rel_path || (ref.url as string),
    tab,
    kind: ref.kind || "reference",
    role: ref.role || "reference",
    label: normalizeMainlineAssetLabel(
      ref.label || ref.role || ref.kind || "reference",
      ref.role || "",
    ),
    sublabel: ref.rel_path || undefined,
    url: ref.url as string,
    aspectRatio: ref.aspect_ratio || aspectForRef(ref),
    mediaType: normalizeMediaType(ref.media_type, ref.kind),
    mainlineContext: ref.mainline_context,
    source: {
      kind: ref.kind || "reference",
      role: ref.role || "reference",
      label: normalizeMainlineAssetLabel(ref.label || "", ref.role || ""),
      rel_path: ref.rel_path || undefined,
      media_type: ref.media_type,
      meta: ref.meta || {},
      from_beat_context: tab === "beat",
      from_preset_reference: true,
      mainline_context: ref.mainline_context,
    },
  };
}

function normalizeMainlineAssetLabel(label: string, role: string | undefined): string {
  if (role === "current_frame") return "当前分镜";
  return replaceText(
    replaceText(
      replaceText(
        replaceText(
          replaceText(String(label || ""), "成图/首帧", "分镜"),
          "成图/分镜",
          "分镜",
        ),
        "成图首帧",
        "分镜",
      ),
      "当前成图",
      "当前分镜",
    ),
    "成图候选",
    "分镜候选",
  );
}

function replaceText(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement);
}

function normalizeMediaType(
  mediaType: string | undefined,
  kind: string | undefined,
): AssetMediaType {
  if (mediaType === "image" || mediaType === "video" || mediaType === "audio") {
    return mediaType;
  }
  if (mediaType === "text" || mediaType === "file") return mediaType;
  const k = (kind || "").toLowerCase();
  if (k.includes("video")) return "video";
  if (k.includes("audio")) return "audio";
  if (
    k.includes("frame") ||
    k.includes("sketch") ||
    k.includes("render") ||
    k.includes("portrait") ||
    k.includes("identity") ||
    k.includes("scene") ||
    k.includes("prop") ||
    k.includes("director") ||
    k.includes("control")
  ) {
    return "image";
  }
  return "unknown";
}

function addUnique(
  out: LibraryAsset[],
  seen: Set<string>,
  asset: LibraryAsset,
): void {
  const key = libraryAssetDedupKey(asset);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(asset);
}

function libraryAssetDedupKey(asset: LibraryAsset): string {
  const base = asset.url || asset.id;
  if (!isBeatScopedLibraryAsset(asset)) {
    return base;
  }
  const beatContext = asset.beatContext;
  const sourceProjectId =
    typeof asset.source.projectId === "string" ? asset.source.projectId : beatContext?.projectId;
  const sourceEpisode =
    typeof asset.source.episode === "number" ? asset.source.episode : beatContext?.episode;
  const sourceBeat = typeof asset.source.beat === "number" ? asset.source.beat : beatContext?.beat;
  if (!sourceProjectId || typeof sourceEpisode !== "number" || typeof sourceBeat !== "number") {
    return base;
  }
  return `${base}:beat:${sourceProjectId}:${sourceEpisode}:${sourceBeat}:${asset.role || asset.kind}`;
}

function tabForRef(ref: PresetReference): AssetTab {
  const kind = ref.kind || "";
  const role = ref.role || "";
  if (
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait" ||
    role.startsWith("character_")
  ) {
    return "characters";
  }
  if (kind === "scene") return "scenes";
  if (kind === "prop") return "props";
  if (isBeatOutputRole(role)) return "beat";
  if (kind === "director") return isSceneAssetRole(role) ? "scenes" : "beat";
  return "beat";
}

function aspectForRef(ref: PresetReference): string {
  const role = ref.role || "";
  if (
    role.includes("combined") ||
    role.includes("env") ||
    role.includes("sketch") ||
    role.includes("render") ||
    role.includes("frame")
  ) {
    return "16:9";
  }
  return "1:1";
}

function groupBeatAssets(assets: LibraryAsset[]): Array<{
  id: string;
  label: string;
  assets: LibraryAsset[];
}> {
  const order = ["outputs", "director", "characters", "scenes", "props", "other"];
  const labels: Record<string, string> = {
    outputs: "当前产物",
    director: "3GS / 控制图",
    characters: "角色参考",
    scenes: "场景参考",
    props: "道具参考",
    other: "其他上下文",
  };
  const buckets = new Map<string, LibraryAsset[]>();
  for (const asset of assets) {
    const group = beatGroupForAsset(asset);
    buckets.set(group, [...(buckets.get(group) ?? []), asset]);
  }
  return order
    .map((id) => ({ id, label: labels[id], assets: buckets.get(id) ?? [] }))
    .filter((group) => group.assets.length > 0);
}

function beatGroupForAsset(asset: LibraryAsset): string {
  const kind = asset.kind;
  const role = asset.role;
  if (
    kind === "frame" ||
    kind === "sketch" ||
    kind === "director_render" ||
    kind === "video" ||
    kind === "audio" ||
    role.includes("frame") ||
    role.includes("sketch") ||
    role.includes("render") ||
    role.includes("video") ||
    role.includes("audio")
  ) {
    return "outputs";
  }
  if (
    kind === "director" ||
    role.includes("3gs") ||
    role.includes("control") ||
    role.includes("combined") ||
    role.includes("env") ||
    role.includes("mask")
  ) {
    return "director";
  }
  if (
    kind === "identity" ||
    kind === "identity_costume" ||
    kind === "identity_portrait" ||
    kind === "portrait" ||
    role.startsWith("character_")
  ) {
    return "characters";
  }
  if (kind === "scene" || kind === "scene_master" || kind === "scene_360") {
    return "scenes";
  }
  if (kind === "prop" || kind === "prop_ref") {
    return "props";
  }
  return "other";
}

function countAssetsForTab(assets: LibraryAsset[], tab: AssetTab): number {
  if (tab === "beat") {
    return assets.filter((asset) => asset.source.from_beat_context).length;
  }
  return assets.filter((asset) => asset.tab === tab).length;
}

function resolveCanvasKind(metadata: Record<string, unknown> | null): CanvasKind {
  const preset = metadata?.preset as { scope?: unknown } | undefined;
  const scope = typeof preset?.scope === "string" ? preset.scope : "";
  if (scope === "episode") return "episode";
  if (scope === "beat") return "beat";
  if (scope === "asset") return "asset";
  if (scope === "blank") return "blank";
  return "default";
}

function resolveCurrentEpisode(
  metadata: Record<string, unknown> | null,
): number | null {
  const preset = metadata?.preset as { episode?: unknown } | undefined;
  if (typeof preset?.episode === "number") return preset.episode;
  const defaultTarget = metadata?.default_push_target as
    | { episode?: unknown }
    | null
    | undefined;
  if (typeof defaultTarget?.episode === "number") return defaultTarget.episode;
  return null;
}

function resolveCurrentBeat(
  metadata: Record<string, unknown> | null,
): number | null {
  const preset = metadata?.preset as { beat?: unknown } | undefined;
  if (typeof preset?.beat === "number") return preset.beat;
  const defaultTarget = metadata?.default_push_target as
    | { beat?: unknown }
    | null
    | undefined;
  if (typeof defaultTarget?.beat === "number") return defaultTarget.beat;
  return null;
}

function isThreeDAsset(asset: LibraryAsset): boolean {
  const role = asset.role || "";
  const kind = asset.kind || "";
  if (role === SCENE_DIRECTOR_WORLD_ROLE) return true;
  if (role.startsWith("scene_3gs_")) return true;
  const relPath = typeof asset.source.rel_path === "string" ? asset.source.rel_path : "";
  if (asset.mediaType === "file" && /\.(ply|glb)$/i.test(relPath)) return true;
  if (kind === "director" && /\.(ply|glb)$/i.test(asset.url || "")) return true;
  return false;
}

/** 视口中心在画布坐标系里的位置；拿不到视口尺寸时退回原点附近的固定点。 */
function viewportCenter(
  store: ReturnType<typeof useCanvasStore.getState>,
): { x: number; y: number } {
  const { width, height } = store.canvasViewportSize;
  if (width <= 0 || height <= 0) return { x: -720, y: 120 };
  const zoom = Math.max(0.01, store.currentViewport.zoom || 1);
  return {
    x: -store.currentViewport.x / zoom + width / (2 * zoom),
    y: -store.currentViewport.y / zoom + height / (2 * zoom),
  };
}

function viewportCenteredPosition(
  store: ReturnType<typeof useCanvasStore.getState>,
  index: number,
  nodeWidth: number,
  nodeHeight: number,
): { x: number; y: number } {
  const { width: viewportWidth, height: viewportHeight } = store.canvasViewportSize;
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    const fallbackCol = index % 2;
    const fallbackRow = Math.floor(index / 2);
    return {
      x: -720 + fallbackCol * (nodeWidth + 28),
      y: 120 + fallbackRow * 260,
    };
  }
  const zoom = Math.max(0.01, store.currentViewport.zoom || 1);
  const cx = -store.currentViewport.x / zoom + viewportWidth / (2 * zoom);
  const cy = -store.currentViewport.y / zoom + viewportHeight / (2 * zoom);
  const col = index % 4;
  const row = Math.floor(index / 4) % 4;
  const offsetX = (col - 1.5) * 24;
  const offsetY = (row - 1.5) * 24;
  const baseX = cx - nodeWidth / 2 + offsetX;
  const baseY = cy - nodeHeight / 2 + offsetY;
  const collides = (x: number, y: number): boolean => {
    const margin = 8;
    return store.nodes.some((node) => {
      const nw = node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const nh = node.measured?.height ?? 200;
      return (
        x < node.position.x + nw + margin &&
        x + nodeWidth + margin > node.position.x &&
        y < node.position.y + nh + margin &&
        y + nodeHeight + margin > node.position.y
      );
    });
  };
  if (!collides(baseX, baseY)) {
    return { x: baseX, y: baseY };
  }
  const stepX = Math.max(nodeWidth + 16, 120);
  const stepY = Math.max(Math.round(nodeHeight * 0.35), 60);
  for (let ring = 1; ring <= 10; ring += 1) {
    const ringOffsets = [
      [ring, 0], [-ring, 0], [0, ring], [0, -ring],
      [ring, 1], [ring, -1], [-ring, 1], [-ring, -1],
      [1, ring], [-1, ring], [1, -ring], [-1, -ring],
      [ring, ring], [-ring, -ring], [ring, -ring], [-ring, ring],
    ];
    for (const [dx, dy] of ringOffsets) {
      const x = baseX + dx * stepX;
      const y = baseY + dy * stepY;
      if (!collides(x, y)) return { x, y };
    }
  }
  return { x: baseX, y: baseY };
}

function assetToDragPayload(asset: LibraryAsset): CanvasAssetDragPayload | null {
  const sourceMeta = { ...asset.source } as Record<string, unknown>;
  const mainline = asset.mainlineContext?.length ? asset.mainlineContext : undefined;
  if (isThreeDAsset(asset)) {
    const relPath = typeof asset.source.rel_path === "string" ? asset.source.rel_path : "";
    const modelSources = Array.isArray(sourceMeta.director_world_sources)
      ? (sourceMeta.director_world_sources as DirectorWorldSource[])
      : undefined;
    const activeSourceId =
      typeof sourceMeta.active_source_id === "string" ? sourceMeta.active_source_id : undefined;
    const activeSource =
      modelSources?.find((source) => source.id && source.id === activeSourceId) ??
      modelSources?.find((source) => source.current) ??
      modelSources?.[0];
    return {
      kind: "model",
      label: asset.label,
      url: asset.url,
      coverUrl: asset.coverUrl ?? null,
      modelSources,
      activeSourceId,
      plyUrl:
        activeSource?.ply_url ??
        (activeSource?.source_type === "sog" ? activeSource.url : undefined) ??
        (modelSources ? null : asset.url),
      panoUrl:
        activeSource?.pano_url ??
        (activeSource?.source_type === "pano360" ? activeSource.url : undefined) ??
        null,
      sourceFileName: relPath.split("/").pop() || asset.label,
      source: sourceMeta,
      mainlineContext: mainline,
    };
  }
  if (asset.mediaType === "video") {
    return { kind: "video", label: asset.label, url: asset.url, aspectRatio: asset.aspectRatio, source: sourceMeta, mainlineContext: mainline };
  }
  if (asset.mediaType === "audio") {
    return { kind: "audio", label: asset.label, url: asset.url, source: sourceMeta, mainlineContext: mainline };
  }
  if (asset.mediaType === "text" || asset.mediaType === "file") return null;
  return { kind: "image", label: asset.label, url: asset.url, aspectRatio: asset.aspectRatio, source: sourceMeta, mainlineContext: mainline };
}

/** 资产库条目 → 画布节点 payload。库里只有图/视频/音频三种，没有 3D。 */
function libraryItemToDragPayload(entry: LibraryItem): CanvasAssetDragPayload | null {
  if (!entry.url) return null;
  return {
    kind: entry.media,
    label: entry.name,
    url: entry.url,
    // 溯源信息按需最小化：够 commit / 替换时认出「这是资产库来的」即可，不把整条
    // 库记录塞进节点(里面还带着 image_urls 之类会过期的字段)。
    source: {
      origin: "asset_library",
      asset_library_id: entry.id,
      asset_library_folder: entry.folder,
    },
  };
}

/**
 * 量素材的真实宽高比，给不出就返回 null。
 *
 * 资产库的条目只存了 URL，没有尺寸；不带 aspectRatio 建出来的图片/视频节点一律
 * 按 1:1 铺开，宽图就会上下留两条黑边（节点内是 object-contain）。
 *
 * 加载失败或太慢都当量不出来处理——发到画布不该被一张坏图卡住。
 */
function measureAspectRatio(payload: CanvasAssetDragPayload): Promise<string | null> {
  if (payload.kind !== "image" && payload.kind !== "video") return Promise.resolve(null);
  if (typeof document === "undefined") return Promise.resolve(null);
  const src = resolveImageDisplayUrl(payload.url);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), 4000);

    if (payload.kind === "image") {
      const image = new Image();
      image.onload = () =>
        done(aspectRatioFromImageDimensions(image.naturalWidth, image.naturalHeight));
      image.onerror = () => done(null);
      image.src = src;
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      done(aspectRatioFromImageDimensions(video.videoWidth, video.videoHeight));
    video.onerror = () => done(null);
    video.src = src;
  });
}

/**
 * 节点建出来大概多大——只用来排网格，不写进节点。
 *
 * 图片节点的尺寸跟着比例走（最小短边 300），视频和音频节点是各自组件里的固定
 * 尺寸，这里跟着写一份常量即可：排版差几像素没关系，别让节点压在一起就行。
 */
function spawnedNodeSize(payload: CanvasAssetDragPayload): { width: number; height: number } {
  if (payload.kind === "audio") return { width: 480, height: 210 };
  if (payload.kind === "video") return { width: 580, height: 380 };
  return resolveMinEdgeFittedSize(payload.aspectRatio || "1:1", {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
}

/**
 * 把整个文件夹发到画布：素材在视口中心铺成网格，再编成一个组，组名 = 文件夹名。
 *
 * 不复用 addAssetToCanvas 的逐个落位——那个函数每次都拿同一份 store 快照做碰撞
 * 检测，连发多个时新节点互相看不见，会叠在一起。这里一次算好整块网格。
 *
 * 网格按每个节点的实际尺寸排（列宽取该列最宽、行高取该行最高），因为节点大小是
 * 跟着图片比例走的，用一个固定格子会让竖图互相压住。
 */
async function sendAssetFolderToCanvas(folder: AssetFolder): Promise<void> {
  const payloads = folder.items
    .map(libraryItemToDragPayload)
    .filter((payload): payload is CanvasAssetDragPayload => payload !== null);
  if (payloads.length === 0) return;

  const ratios = await Promise.all(payloads.map(measureAspectRatio));
  const sized = payloads.map((payload, index) => {
    const withRatio = ratios[index] ? { ...payload, aspectRatio: ratios[index] } : payload;
    return { payload: withRatio, size: spawnedNodeSize(withRatio) };
  });

  const GAP = 32;
  const cols = Math.min(4, Math.ceil(Math.sqrt(sized.length)));
  const rows = Math.ceil(sized.length / cols);
  const colWidths = Array.from({ length: cols }, (_, c) =>
    Math.max(...sized.filter((_, i) => i % cols === c).map((it) => it.size.width)),
  );
  const rowHeights = Array.from({ length: rows }, (_, r) =>
    Math.max(
      ...sized
        .filter((_, i) => Math.floor(i / cols) === r)
        .map((it) => it.size.height),
    ),
  );
  const blockWidth =
    colWidths.reduce((sum, w) => sum + w, 0) + GAP * (cols - 1);
  const blockHeight =
    rowHeights.reduce((sum, h) => sum + h, 0) + GAP * (rows - 1);

  const store = useCanvasStore.getState();
  const { x: cx, y: cy } = viewportCenter(store);
  const startX = cx - blockWidth / 2;
  const startY = cy - blockHeight / 2;

  const ids = sized.map(({ payload }, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x =
      startX + colWidths.slice(0, col).reduce((sum, w) => sum + w + GAP, 0);
    const y =
      startY + rowHeights.slice(0, row).reduce((sum, h) => sum + h + GAP, 0);
    return spawnAssetNode(store, payload, { x, y });
  });

  // groupNodes 要求 ≥2 个成员，单个素材成不了组、保持独立节点即可。
  const groupId =
    ids.length >= 2 ? store.groupNodes(ids, { label: folder.label }) : null;
  store.requestFocusNode(groupId ?? ids[0]);
  toast.success(`已发送到画布：${folder.label}`);
}

/**
 * 把单条资产库素材发到画布：量一次真实比例，落在视口中心（带碰撞避让），然后聚焦。
 *
 * 不复用 sendAssetFolderToCanvas —— 那个是整柜铺网格再编组，单条走同一条路会得到
 * 一个只有一个成员的组。
 */
async function sendLibraryItemToCanvas(entry: LibraryItem): Promise<void> {
  const payload = libraryItemToDragPayload(entry);
  if (!payload) return;
  const ratio = await measureAspectRatio(payload);
  const sized = ratio ? { ...payload, aspectRatio: ratio } : payload;
  const { width, height } = spawnedNodeSize(sized);
  const store = useCanvasStore.getState();
  const newId = spawnAssetNode(store, sized, viewportCenteredPosition(store, 0, width, height));
  store.requestFocusNode(newId);
  toast.success(`已发送到画布：${entry.name || "素材"}`);
}

function addAssetToCanvas(asset: LibraryAsset, index: number): void {
  const payload = assetToDragPayload(asset);
  if (!payload) return;
  const store = useCanvasStore.getState();
  const APPROX_NODE_HEIGHT = 360;
  const position = viewportCenteredPosition(store, index, DEFAULT_NODE_WIDTH, APPROX_NODE_HEIGHT);
  void (async () => {
    let hydratedPayload = payload;
    try {
      hydratedPayload = await hydrateAssetDragPayload(payload);
    } catch (error) {
      console.warn("[freezone] scene director world manifest unavailable during import", error);
    }
    const newId = spawnAssetNode(store, hydratedPayload, position);
    store.requestFocusNode(newId);
  })();
}

function isBeatScopedLibraryAsset(asset: LibraryAsset): boolean {
  const role =
    typeof asset.role === "string" && asset.role
      ? asset.role
      : typeof asset.source.role === "string"
        ? asset.source.role
        : "";
  const kind =
    typeof asset.kind === "string" && asset.kind
      ? asset.kind
      : typeof asset.source.kind === "string"
        ? asset.source.kind
        : "";
  return (
    BEAT_SCOPED_LIBRARY_ASSET_ROLES.has(role) ||
    BEAT_SCOPED_LIBRARY_ASSET_KINDS.has(kind)
  );
}
