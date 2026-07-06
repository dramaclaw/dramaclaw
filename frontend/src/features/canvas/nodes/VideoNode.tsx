// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowUp,
  Camera,
  ChevronDown,
  ChevronUp,
  Download,
  Film,
  Languages,
  Layers,
  Loader2,
  Music,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload as UploadIcon,
  Users,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X as XIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
  type Seedance2SceneOptimize,
  type VideoGenCount,
  type VideoGenMode,
  type VideoGenQuality,
  type VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import {
  VIDEO_GENERATION_ASPECT_RATIOS,
  mediaNeedsCrossOrigin,
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";
import { ensureWebSafeVideo } from "@/features/canvas/application/videoTranscode";
import { isVideoFile, VIDEO_FILE_ACCEPT } from "@/features/canvas/application/videoFileTypes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import { toast } from "sonner";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import {
  setAlbumPendingTotal,
  useAlbumPendingTotal,
} from "@/features/canvas/nodes/shared/albumPendingTotals";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import {
  extractUpstreamContent,
  joinUpstreamText,
} from "@/features/canvas/application/graphContentResolver";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";
import { ReferenceTextChip } from "@/features/canvas/nodes/shared/ReferenceTextChip";
import { ReferenceDetachButton } from "@/features/canvas/nodes/shared/ReferenceDetachButton";
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useNodeGenerationTaskState } from "@/features/canvas/application/useNodeGenerationTaskState";
import {
  resolveErrorContent,
  showErrorDialog,
} from "@/features/canvas/application/errorDialog";
import { backendErrorToastMessage } from "@/lib/api-errors";
import { extractRequestId } from "@/features/canvas/application/generationErrorReport";
import {
  PromptMentionEditor,
  type MentionCandidate,
  type PromptMentionEditorHandle,
} from "@/features/canvas/nodes/PromptMentionEditor";
import { NodeContextPromptPaletteButton } from "@/features/canvas/nodes/ContextPromptPaletteButton";
import {
  contextPromptPaletteInsertionText,
  type ContextPromptPaletteEntry,
} from "@/features/canvas/nodes/contextPromptPalette";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { PanelExpandButton } from "@/features/canvas/ui/PanelExpandButton";
import {
  NODE_OPS_PANEL_ENTER_CLASS,
  OperationPanelShell,
} from "@/features/canvas/ui/OperationPanelShell";
import { NodeGenerationOverlay } from "@/features/canvas/ui/NodeGenerationOverlay";
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  CANVAS_NODE_TOOLBAR_PILL_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import {
  hasMainlineContexts,
  NodeContextBadges,
} from "@/features/freezone/context/NodeContextBadges";
import { RegenerateButton } from "@/features/canvas/ui/RegenerateButton";
import {
  NODE_COUNT_POPOVER_CLASS,
  NODE_CONTEXT_CONTROL_TRIGGER_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from "@/features/canvas/ui/NodeSideActionRail";
import { createPortal } from "react-dom";
import { VideoClipPanel } from "@/features/canvas/nodes/VideoClipPanel";
import { CameraMovementPickerPopover } from "@/features/canvas/nodes/CameraMovementPickerPopover";
import {
  CAMERA_MOVEMENT_PRESETS,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { useFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { CharacterLibraryModal } from "@/features/canvas/ui/CharacterLibraryModal";
import { useCanvasStore, useIsBoxSelecting } from "@/stores/canvasStore";
import {
  fetchFreezoneJobResult,
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
  submitFreezoneVideoCompose,
  submitFreezoneVideoErase,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
  uploadFreezoneImage,
  uploadFreezoneVideo,
  type FreezoneJobRef,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoReferenceItem,
  type FreezoneVideoResolution,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { generationTaskDescriptor } from "@/features/canvas/application/resumeGeneration";
import { useNodeGenerationHistory } from "@/features/canvas/hooks/useNodeGenerationHistory";
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";
import { readUrl } from "@/lib/url-params";
import {
  DEFAULT_VIDEO_MODEL_ID,
  ProviderModelPicker,
} from "@/features/canvas/ui/ProviderModelPicker";
import { writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";
import {
  CreditCostPill,
  formatCreditCost,
} from "@/components/credits/credit-visual";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

type VideoNodeProps = NodeProps & {
  id: string;
  data: VideoNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 580;
const DEFAULT_HEIGHT = 380;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1000;

const OPERATIONS_PANEL_HEIGHT = 280;
const OPERATIONS_PANEL_GAP = 12;
// Extend the ops panel beyond the node's left/right edges so the textarea +
// chips have more room than the video frame itself.
const OPERATIONS_PANEL_OVERHANG = 120;
// 「放大」后用居中弹窗展示，给提示词编辑更舒适的空间。
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_WIDTH = 1040;

const MODE_TABS: ReadonlyArray<{ key: VideoGenMode; labelKey: string }> = [
  { key: "textToVideo", labelKey: "node.videoNode.tabs.textToVideo" },
  { key: "allReference", labelKey: "node.videoNode.tabs.allReference" },
  { key: "imageToVideo", labelKey: "node.videoNode.tabs.imageToVideo" },
  { key: "firstLastFrame", labelKey: "node.videoNode.tabs.firstLastFrame" },
  { key: "imageReference", labelKey: "node.videoNode.tabs.imageReference" },
];

// 各 genMode 对上游引用数量的硬上限。UI 用这张表把后端字段约束（多图 / 多模态
// 场景下）显式表达出来：超额 chip 标灰 + 从 @ 候选剔除，避免「prompt 引用了
// @图片10 但提交时被静默丢掉」。
//
// 表里没出现的模式默认不限制（textToVideo 不消费上游、imageToVideo 走
// `.slice(0, 9)` 自带兜底），各自走原有路径。
//   - allReference (omni)  ：image 1-9 / video 0-3 / audio 0-3。总时长 ≤ 15s
//                            的部分前端拿不到精确媒体元数据，延后交给服务端。
//   - firstLastFrame       ：仅图片 2 张（首帧 + 尾帧），不允许任何视频 / 音频。
//                            图片 >2 时另有自动切到 allReference 的兜底（见
//                            VideoNode 内部 effect）。
const REFERENCE_CAPS_BY_MODE: Partial<
  Record<VideoGenMode, { image: number; video: number; audio: number }>
> = {
  allReference: { image: 9, video: 3, audio: 3 },
  firstLastFrame: { image: 2, video: 0, audio: 0 },
};

const ASPECT_RATIOS: ReadonlyArray<FreezoneVideoAspectRatio> = [
  "auto",
  "16:9",
  "4:3",
  "1:1",
  "3:4",
  "9:16",
  "21:9",
];
const QUALITIES: ReadonlyArray<VideoGenQuality> = ["480P", "720P", "1080P"];
const COUNT_OPTIONS: ReadonlyArray<VideoGenCount> = [1, 2, 4];
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
const VIDEO_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[320px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const VIDEO_PARAM_LABEL_CLASS =
  "mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-dark/72";
const VIDEO_PARAM_BUTTON_BASE_CLASS =
  "inline-flex items-center justify-center rounded-md px-2 py-2 text-xs transition-colors";
const VIDEO_PARAM_ACTIVE_BUTTON_CLASS =
  "bg-white/[0.13] text-text-dark ring-1 ring-white/24";
const VIDEO_PARAM_IDLE_BUTTON_CLASS =
  "bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark";
const VIDEO_PARAM_ROW_CLASS = "mb-4 gap-2";
const VIDEO_COUNT_OPTION_BASE_CLASS =
  "block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors";
const VIDEO_MODE_POPOVER_CLASS =
  `nodrag nowheel fixed z-[10000] w-[132px] overflow-hidden p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;

function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q.toLowerCase() as FreezoneVideoResolution;
}

function resolutionToQuality(resolution: string): VideoGenQuality | null {
  const normalized = resolution.trim().toLowerCase();
  if (normalized === "480p") return "480P";
  if (normalized === "720p") return "720P";
  if (normalized === "1080p") return "1080P";
  return null;
}

function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? [])
    .map(resolutionToQuality)
    .filter((item): item is VideoGenQuality => Boolean(item));
  return options.length > 0 ? options : QUALITIES;
}

function normalizeVideoQuality(
  value: VideoGenQuality | undefined,
  options: readonly VideoGenQuality[],
): VideoGenQuality {
  const fallback = options.includes("720P") ? "720P" : options[0] ?? "720P";
  return value && options.includes(value) ? value : fallback;
}

function videoDurationBoundsForModel(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : DEFAULT_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : DEFAULT_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

function clampVideoDuration(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

// Seedance 2.0(doubao-seedance-2-0，r2v）后端硬上限：一次请求的音频总时长
// 必须 ≤ 15.2s，超了会以 InvalidParameter 报错。对用户按「15 秒」提示，实际
// 用 15.2s 作拦截阈值，避免把后端本会放行的 15.0~15.2s 音频误拦。
const MAX_AUDIO_TOTAL_DURATION_MS = 15_200;

// 音频节点的 durationMs 是懒加载的（波形播放器挂载读元数据后才写入），刚上传、
// 从未渲染过的音频节点可能为 null。提交前用一个临时 <audio> 探测真实时长兜底，
// 探测失败（CORS/网络等）返回 null，不阻断提交，交由后端兜底。
function probeAudioDurationMs(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const audio = document.createElement("audio");
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute("src");
      audio.load();
      resolve(ms);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const secs = audio.duration;
      finish(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null);
    };
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

function isSeedance2ValueModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return normalized === "newapi_seedance-2.0-value" ||
    normalized === "newapi_seedance-2.0-fast-value" ||
    normalized === "huimeng_seedance-2.0-value" ||
    normalized === "huimeng_seedance-2.0-fast-value";
}

// Seedance 1 全系列(1.0 Pro Fast / 1.5 Pro / …)。素材去掉分隔符后版本号
// `1.x` → `1x`,匹配 `seedance1` 后跟任意数字,避免误命中 2.0(`20`)。
// 引用了素材时这些模型不可用。
function isSeedance1xModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
  return /seedance1\d/.test(normalized);
}

function isGrokVideoChannelModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "")
    .replace(/[\s._-]/g, "")
    .toLowerCase();
  return normalized.includes("grokvideochannel");
}

function videoModelReferenceDisabledReason(
  modelId: string | null | undefined,
  counts: { images: number; videos: number; audios: number },
): string | null {
  if (isGrokVideoChannelModel(modelId)) {
    if (counts.videos > 0 || counts.audios > 0) {
      return "Grok Video Channel 仅支持图片素材";
    }
    if (counts.images > 8) {
      return "Grok Video Channel 最多支持 1 张首帧和 7 张参考图";
    }
    return null;
  }
  if (isSeedance1xModel(modelId)) {
    if (counts.images > 0 || counts.videos > 0 || counts.audios > 0) {
      return "该模型不支持当前接入的素材";
    }
  }
  return null;
}

function sceneOptimizeOptionsForModel(
  model: {
    id?: string;
    apiModel?: string;
    sceneOptimizeOptions?: Array<"anime" | "realistic">;
  } | null | undefined,
): readonly Seedance2SceneOptimize[] {
  if (model?.sceneOptimizeOptions?.length) {
    return model.sceneOptimizeOptions;
  }
  return isSeedance2ValueModel(model?.apiModel ?? model?.id) ? SCENE_OPTIMIZE_OPTIONS : [];
}

function defaultSceneOptimizeForModel(
  model: {
    id?: string;
    apiModel?: string;
    defaultSceneOptimize?: "anime" | "realistic" | null;
  } | null | undefined,
): Seedance2SceneOptimize {
  if (model?.defaultSceneOptimize === "anime" || model?.defaultSceneOptimize === "realistic") {
    return model.defaultSceneOptimize;
  }
  const modelId = String(model?.apiModel ?? model?.id ?? "").toLowerCase();
  return modelId.includes("fast-value") ? "realistic" : "anime";
}

function normalizeSceneOptimize(
  value: Seedance2SceneOptimize | undefined,
  options: readonly Seedance2SceneOptimize[],
  fallback: Seedance2SceneOptimize,
): Seedance2SceneOptimize | undefined {
  if (options.length === 0) return undefined;
  return value && options.includes(value) ? value : fallback;
}

// 音频引用 chip 的展示文件名：优先节点的 displayName，否则从 audioUrl 取末段文件名。
// 仅用于前端展示（音频_<文件名>），不影响序列化给后端的 @音频N。
function audioReferenceFileName(item: {
  displayName?: string | null;
  audioUrl: string;
}): string | null {
  const name = item.displayName?.trim();
  if (name) return name;
  try {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const path = new URL(item.audioUrl, origin).pathname;
    const base = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    return base || null;
  } catch {
    return null;
  }
}

function referenceImageUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    // imageGen 上传给生图用的「参考图」会写到 data.referenceImageUrl；
    // 在 imageGen 自身还没生成结果之前，它就是该节点对外呈现的图片，
    // 视频节点也应该把它当成上游图引用。
    const ref =
      typeof data.referenceImageUrl === "string" &&
      data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.previewImageUrl || data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    const data = node.data;
    return data.previewImageUrl || data.imageUrl || null;
  }
  return null;
}

function submittableImageUrl(
  node: CanvasNode | undefined | null,
): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    const ref =
      typeof data.referenceImageUrl === "string" &&
      data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return node.data.imageUrl || null;
  }
  return null;
}

function resolveDroppedVideoFile(event: DragEvent<HTMLElement>): File | null {
  const directFile = event.dataTransfer.files?.[0];
  if (directFile && isVideoFile(directFile)) {
    return directFile;
  }
  // items[].type 同样对 .mxf 为空串，先按 MIME 粗筛拿到 File 再用扩展名兜底。
  const candidates = Array.from(event.dataTransfer.items || []).filter(
    (candidate) => candidate.kind === "file",
  );
  for (const candidate of candidates) {
    const file = candidate.getAsFile();
    if (file && isVideoFile(file)) return file;
  }
  return null;
}

function resolveOutputUrl(
  result: Record<string, unknown> | null | undefined,
): string | null {
  if (!result) return null;
  for (const key of ["video_url", "output_url", "url"]) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Render a single frame from a video URL into a PNG blob using an offscreen
 * <video>. Cross-origin CDN media (absolute http(s) URL, the production case)
 * must load with CORS, otherwise drawing it to the canvas taints it and
 * `toBlob` throws. Same-origin /static (the dev vite proxy) skips crossOrigin
 * since that origin doesn't echo Access-Control-Allow-Origin and isn't tainted.
 */
async function captureVideoFrameBlob(
  src: string,
  seekSec: number,
): Promise<Blob> {
  return await new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    if (mediaNeedsCrossOrigin(src)) video.crossOrigin = "anonymous";

    const cleanup = () => {
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // ignored
      }
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };

    video.addEventListener("error", () => fail("video element error"));
    video.addEventListener(
      "loadeddata",
      () => {
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) {
          fail("invalid video duration");
          return;
        }
        const targetTime = Math.max(
          0,
          Math.min(seekSec, Math.max(0, duration - 0.05)),
        );
        video.addEventListener(
          "seeked",
          () => {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              fail("canvas context unavailable");
              return;
            }
            try {
              ctx.drawImage(video, 0, 0);
            } catch (error) {
              fail(error);
              return;
            }
            canvas.toBlob((blob) => {
              cleanup();
              if (blob) resolve(blob);
              else reject(new Error("canvas.toBlob returned null"));
            }, "image/png");
          },
          { once: true },
        );
        try {
          video.currentTime = targetTime;
        } catch (error) {
          fail(error);
        }
      },
      { once: true },
    );

    video.src = src;
    try {
      video.load();
    } catch {
      // ignored
    }
  });
}

export const VideoNode = memo(
  ({ id, data, selected, width, height }: VideoNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const isBoxSelecting = useIsBoxSelecting();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const addDerivedUploadNode = useCanvasStore(
      (state) => state.addDerivedUploadNode,
    );
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const deleteEdge = useCanvasStore((state) => state.deleteEdge);
    const setActiveOverlayNodeId = useCanvasStore(
      (state) => state.setActiveOverlayNodeId,
    );
    const inputRef = useRef<HTMLInputElement>(null);
    // 在途守卫：持到本批所有并发任务 allSettled 才释放（见 handleSubmit）。
    const submittingRef = useRef(false);
    // Mirror the actual <video> element into state so VideoPlayerControls 能
    // 在挂载/卸载时重新订阅事件（仅 ref 不会触发重渲染）。同时保留可写的
    // ref，给非 React 路径（capture frame 之类）继续用 .current。
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
    const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
      videoRef.current = el;
      setVideoEl(el);
    }, []);
    const transientUrlRef = useRef<string | null>(null);
    const [transientPreviewUrl, setTransientPreviewUrl] = useState<
      string | null
    >(null);
    const [isCapturingFrame, setIsCapturingFrame] = useState(false);
    const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
    const [isCharacterLibraryOpen, setIsCharacterLibraryOpen] = useState(false);
    const [isComposingClip, setIsComposingClip] = useState(false);
    const [clipError, setClipError] = useState<string | null>(null);

    // 每节点生成历史：仅在节点被选中时拉取，避免画布上每个视频节点都各发一次
    // 请求。生成完成后调用 refreshHistory 把新记录拉进来。
    const {
      records: historyRecords,
      isLoading: historyLoading,
      refresh: refreshHistory,
    } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

    // 生成进行中时，点击历史记录走「非破坏性预览」：不覆写 videoUrl、不打断在途
    // 任务，仅把这条历史视频临时显示在主体上（见 isGenerating 渲染分支）。新视频
    // 生成完成后由下方 effect 自动清空，回到最新结果。非生成态恢复历史时也清掉它。
    const [historyPreviewUrl, setHistoryPreviewUrl] = useState<string | null>(
      null,
    );

    const prompt = typeof data.prompt === "string" ? data.prompt : "";
    // Local draft + composition guard so IME (中文输入法) candidates stop being
    // wiped by the store-driven re-render. Same fix pattern as
    // `docs/changes/2026-05-12-image-gen-ime-fix.md`.
    const [promptDraft, setPromptDraft] = useState(prompt);
    const isComposingRef = useRef(false);
    const promptEditorRef = useRef<PromptMentionEditorHandle | null>(null);
    useEffect(() => {
      if (isComposingRef.current) return;
      setPromptDraft(prompt);
    }, [prompt]);

    // 「上下文调色盘」：与图生节点同款，把镜头里人物/道具的标记颜色快速插进提示词。
    // palette 的全量 nodes/edges 订阅下沉到 NodeContextPromptPaletteButton，避免本节点
    // 为它订阅整图、被任意节点拖动牵连重渲染。插入直接走编辑器命令式 API：弹层与编辑器
    // 同在面板里、编辑器恒已挂载，故回调无需依赖 prompt（保持稳定引用）。
    const insertContextPaletteEntry = useCallback(
      (entry: ContextPromptPaletteEntry) => {
        promptEditorRef.current?.insertTextAtCursor(
          contextPromptPaletteInsertionText(entry),
        );
      },
      [],
    );
    const genMode: VideoGenMode = data.genMode ?? "textToVideo";
    const {
      models: availableVideoModels,
      isLoading: videoModelsLoading,
      isFallback: videoModelsFallback,
    } = useFreezoneVideoModels();
    // Same fix as ImageGenNode: when no model is explicitly picked, default to
    // the FIRST live model (what ProviderModelPicker displays) rather than the
    // static DEFAULT_VIDEO_MODEL_ID, so the displayed model matches the value
    // actually sent to /freezone/video/gen.
    const selectedVideoModel = useMemo(() => {
      const persisted =
        typeof data.model === "string" && data.model.length > 0
          ? data.model
          : null;
      return (
        (persisted
          ? availableVideoModels.find((model) => model.id === persisted)
          : undefined) ?? availableVideoModels[0]
      );
    }, [availableVideoModels, data.model]);
    const modelId = selectedVideoModel?.id ?? DEFAULT_VIDEO_MODEL_ID;
    // aspectRatio 只认合法的比例预设（含 "auto"）；历史上曾被写成像素串(如
    // "1248:704")的旧节点在这里吸附到最接近的合法视频比例，保证 chip 显示干净。
    const aspectRatio: FreezoneVideoAspectRatio = (
      ASPECT_RATIOS as readonly string[]
    ).includes(String(data.aspectRatio))
      ? (data.aspectRatio as FreezoneVideoAspectRatio)
      : (snapToAllowedAspectRatio(
          String(data.aspectRatio ?? ""),
          VIDEO_GENERATION_ASPECT_RATIOS,
          "16:9",
        ) as FreezoneVideoAspectRatio);
    // 提交给后端的比例必须是 6 个合法视频比例之一、绝不发 "auto"：auto 时按节点
    // 真实像素(若有)推导最接近的比例，否则回退 16:9。
    const submitAspectRatio: FreezoneVideoAspectRatio =
      aspectRatio === "auto"
        ? (snapToAllowedAspectRatio(
            typeof data.widthPx === "number" &&
              typeof data.heightPx === "number" &&
              data.widthPx > 0 &&
              data.heightPx > 0
              ? `${data.widthPx}:${data.heightPx}`
              : "",
            VIDEO_GENERATION_ASPECT_RATIOS,
            "16:9",
          ) as FreezoneVideoAspectRatio)
        : aspectRatio;
    const qualityOptions = useMemo(
      () => videoQualityOptionsForModel(selectedVideoModel),
      [selectedVideoModel],
    );
    const quality = normalizeVideoQuality(data.quality, qualityOptions);
    const durationBounds = useMemo(
      () => videoDurationBoundsForModel(selectedVideoModel),
      [selectedVideoModel],
    );
    const durationSec = clampVideoDuration(
      typeof data.durationSec === "number" ? data.durationSec : DEFAULT_DURATION_MIN,
      durationBounds,
    );
    const sceneOptimizeOptions = useMemo(
      () => sceneOptimizeOptionsForModel(selectedVideoModel),
      [selectedVideoModel],
    );
    const sceneOptimize = normalizeSceneOptimize(
      data.sceneOptimize,
      sceneOptimizeOptions,
      defaultSceneOptimizeForModel(selectedVideoModel),
    );
    const generateAudio = Boolean(data.generateAudio);
    // 真人素材审核开关只对 Seedance 2.0 系列模型生效。归一化掉分隔符后匹配
    // `seedance2`，覆盖 `huimeng_seedance20_fast` / 未来可能的 `seedance_2_0` 等 id。
    const isSeedance20Model = /seedance2/i.test(modelId.replace(/[\s._-]/g, ""));
    const humanReview = Boolean(data.humanReview);
    const count: VideoGenCount = (data.count ?? 1) as VideoGenCount;
    useEffect(() => {
      const patch: Partial<VideoNodeData> = {};
      if (data.quality !== quality) {
        patch.quality = quality;
      }
      if (data.durationSec !== durationSec) {
        patch.durationSec = durationSec;
      }
      if (Object.keys(patch).length > 0) {
        updateNodeData(id, patch);
      }
    }, [
      data.durationSec,
      data.quality,
      durationSec,
      id,
      quality,
      updateNodeData,
    ]);
    const videoBackendForCost =
      videoModelsLoading || videoModelsFallback
        ? null
        : (selectedVideoModel?.apiModel ?? null);
    // Debounce the cost-estimate inputs: dragging the duration slider (and,
    // to a lesser degree, flipping count/quality/model) churns the query key
    // and TanStack Query aborts each in-flight request, spraying "Canceled"
    // rows across the Network tab. Coalesce to one request once the params
    // settle (~350ms). Primitives only — see useDebouncedValue's contract.
    const debouncedBackend = useDebouncedValue(videoBackendForCost, 350);
    const debouncedQuality = useDebouncedValue(quality, 350);
    const debouncedCount = useDebouncedValue(count, 350);
    const debouncedDurationSec = useDebouncedValue(durationSec, 350);
    const videoCreditCost = useGenerationCreditCost(
      "video_backend",
      debouncedBackend,
      {
        surface: "canvas",
        params: { resolution: qualityToResolution(debouncedQuality) },
        quantity: Math.min(Math.max(debouncedCount, 1), 4) * debouncedDurationSec,
      },
    );
    const totalCreditCostDisplay = useMemo(() => {
      const total = videoCreditCost.data?.data.cost;
      if (typeof total !== "number") return null;
      return formatCreditCost(total);
    }, [videoCreditCost.data?.data.cost]);
    const cameraMovementId =
      typeof data.cameraMovement === "string" ? data.cameraMovement : null;
    // Pull the camera-template catalog from `/freezone/video/camera-templates`.
    // Fall back to the bundled `CAMERA_MOVEMENT_PRESETS` while loading or if the
    // backend is unreachable so the chip never goes blank.
    const cameraTemplatesQuery = useFreezoneVideoCameraTemplates();
    const cameraTemplates = useMemo<ReadonlyArray<CameraMovementPreset>>(
      () =>
        cameraTemplatesQuery.templates.length > 0
          ? cameraTemplatesQuery.templates
          : CAMERA_MOVEMENT_PRESETS,
      [cameraTemplatesQuery.templates],
    );
    const cameraTemplatesLoading = cameraTemplatesQuery.isLoading;
    const cameraMovementPreset = useMemo(
      () => findCameraMovementPreset(cameraTemplates, cameraMovementId),
      [cameraTemplates, cameraMovementId],
    );
    const { isGenerating } = useNodeGenerationTaskState(data);
    const generationError =
      typeof data.generationError === 'string' ? data.generationError.trim() : '';
    // Only treat as a failure-state once generation has stopped and produced no
    // video — a stale error must never hide a successfully generated clip.
    const hasGenerationError =
      !isGenerating && !data.videoUrl && generationError.length > 0;
    const generationErrorRequestId =
      typeof data.generationErrorRequestId === "string" && data.generationErrorRequestId
        ? data.generationErrorRequestId
        : "";

    // 生成结束（成功/失败）后清掉临时历史预览，让主体回到最新结果。
    useEffect(() => {
      if (!isGenerating) setHistoryPreviewUrl(null);
    }, [isGenerating]);

    const handleRestoreHistory = useCallback(
      (record: FreezoneGenerationHistoryRecord) => {
        const url = historyRecordOutputUrl(record);
        if (!url) return;
        // 生成进行中：仅做非破坏性预览，绝不动 videoUrl，也不打断在途任务。
        if (isGenerating) {
          setHistoryPreviewUrl(url);
          return;
        }
        setHistoryPreviewUrl(null);
        updateNodeData(id, {
          videoUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          sourceFileName: null,
          generationError: null,
          generationErrorDetails: null,
          generationErrorRequestId: null,
          // 恢复单条历史结果时旧批次画册已与主视频脱钩——一并清掉。
          generationBatch: null,
        });
      },
      [id, isGenerating, updateNodeData],
    );

    // ------ upstream reference images ----------------------------------------
    // Anything connected via target → this video node that has an image url
    // shows up as a thumbnail chip next to the camera/role/marker chips. Ordered
    // by connection order (later-referenced after earlier), with manual
    // referenceOrder taking precedence — see sortUpstreamByReferenceOrder.
    // Subscribe to ONLY this node's one-hop upstream (not the whole nodes array)
    // so dragging unrelated nodes doesn't re-render this node. See useUpstreamGraph.
    const upstreamNodes = useUpstreamNodes(id);
    const referenceImages = useMemo(() => {
      const upstream = sortUpstreamByReferenceOrder(
        upstreamNodes,
        data.referenceOrder,
      );
      return upstream
        .map((node) => {
          const url = referenceImageUrl(node);
          if (!url) return null;
          return { nodeId: node.id, url };
        })
        .filter(
          (entry): entry is { nodeId: string; url: string } => entry != null,
        );
    }, [upstreamNodes, data.referenceOrder]);

    // 统一的「图 / 视 / 音」上游引用条目，给 chips 行用。顺序按连接顺序
    // （与 referenceImages 同步），让 chip 编号 1/2/3... 跟可视顺序一致。
    // text 上游不进这一行 —— 上面已经单独渲染了「@文本 chip」。
    const referenceMedia = useMemo<ReferenceMediaItem[]>(() => {
      const upstream = sortUpstreamByReferenceOrder(
        upstreamNodes,
        data.referenceOrder,
      );
      const items: ReferenceMediaItem[] = [];
      for (const node of upstream) {
        if (isVideoNode(node)) {
          const videoUrl =
            typeof node.data.videoUrl === "string" &&
            node.data.videoUrl.length > 0
              ? node.data.videoUrl
              : null;
          if (!videoUrl) continue;
          const thumbUrl =
            typeof node.data.previewImageUrl === "string" &&
            node.data.previewImageUrl.length > 0
              ? node.data.previewImageUrl
              : null;
          items.push({
            kind: "video",
            nodeId: node.id,
            videoUrl,
            thumbUrl,
            displayName: node.data.displayName ?? null,
          });
          continue;
        }
        if (isAudioNode(node)) {
          const audioUrl =
            typeof node.data.audioUrl === "string" &&
            node.data.audioUrl.length > 0
              ? node.data.audioUrl
              : null;
          if (!audioUrl) continue;
          items.push({
            kind: "audio",
            nodeId: node.id,
            audioUrl,
            displayName: node.data.displayName ?? null,
          });
          continue;
        }
        const url = referenceImageUrl(node);
        if (url) {
          items.push({
            kind: "image",
            nodeId: node.id,
            imageUrl: url,
            displayName:
              (node.data as { displayName?: string | null }).displayName ??
              null,
          });
        }
      }
      return items;
    }, [upstreamNodes, data.referenceOrder]);

    // 提示词里的 @图片N / @音频N 必须随「角色库」连线引用实时对应：删除 / 重排 /
    // 新增引用时角色库会重新编号（删掉图片1 后原图片2 变图片1），这里把 prompt 里的
    // mention 数字一并重写，被删引用的 mention 则移除。按「上一帧有序 id ↔ 这一帧有序
    // id」差分，覆盖所有删边路径（detach 按钮 / 双击断开 / Delete 键）与手动重排。
    const orderedImageIds = useMemo(
      () =>
        referenceMedia
          .filter((item) => item.kind === "image")
          .map((item) => item.nodeId),
      [referenceMedia],
    );
    const orderedVideoIds = useMemo(
      () =>
        referenceMedia
          .filter((item) => item.kind === "video")
          .map((item) => item.nodeId),
      [referenceMedia],
    );
    const orderedAudioIds = useMemo(
      () =>
        referenceMedia
          .filter((item) => item.kind === "audio")
          .map((item) => item.nodeId),
      [referenceMedia],
    );
    const applyPromptRemap = useCallback(
      (next: string) => updateNodeData(id, { prompt: next }),
      [id, updateNodeData],
    );
    useReferenceMentionSync(
      prompt,
      [
        { prefix: "图片", ids: orderedImageIds },
        { prefix: "视频", ids: orderedVideoIds },
        { prefix: "音频", ids: orderedAudioIds },
      ],
      applyPromptRemap,
    );

    // 给每个 referenceMedia 条目补上「同类型序号 + 是否在当前模式上限内」。
    // 当前 genMode 在 REFERENCE_CAPS_BY_MODE 里没有条目（如 textToVideo /
    // imageToVideo / imageReference），统一按 within=true 处理；下游 chip /
    // mention 候选会决定是否消费 within。
    const referenceMediaCapInfo = useMemo(() => {
      const counts = { image: 0, video: 0, audio: 0 };
      const caps = REFERENCE_CAPS_BY_MODE[genMode];
      return referenceMedia.map((item) => {
        counts[item.kind] += 1;
        const cap = caps?.[item.kind];
        const withinCap = cap == null || counts[item.kind] <= cap;
        return { item, typeIndex: counts[item.kind], withinCap };
      });
    }, [referenceMedia, genMode]);

    // @ 提及候选 —— 图片、音频都可引用，但编号按 *各自类型* 的序号走，
    // *不* 按行内混合位置。后端按上传的图片数量来对应 图片N，若用混合位置编号
    // （音频排第一时图片就成了「图片2」），后端只看到 1 张图却被要求引用图片2
    // 会报错。所以图片用图片序号、音频用音频序号，各自独立计数。
    //
    // 在 REFERENCE_CAPS_BY_MODE 表里有条目的模式（当前是 allReference /
    // firstLastFrame），超过 cap 的条目不能进 @ 候选 —— 服务端会直接丢弃，留
    // 在候选里只会让用户选了之后被静默忽略。其它模式（imageReference 等）各自
    // 已有提交时 `.slice(0, N)` 兜底，本次不动。
    const mentionCandidates = useMemo<MentionCandidate[]>(() => {
      const out: MentionCandidate[] = [];
      let imageIdx = 0;
      let videoIdx = 0;
      let audioIdx = 0;
      const enforceCap = REFERENCE_CAPS_BY_MODE[genMode] != null;
      for (const info of referenceMediaCapInfo) {
        const item = info.item;
        if (item.kind === "image") {
          imageIdx += 1;
          if (enforceCap && !info.withinCap) continue;
          out.push({
            key: item.nodeId,
            name: `图片${imageIdx}`,
            imageUrl: resolveImageDisplayUrl(item.imageUrl),
            index: imageIdx,
          });
        } else if (item.kind === "video") {
          videoIdx += 1;
          if (enforceCap && !info.withinCap) continue;
          out.push({
            key: item.nodeId,
            name: `视频${videoIdx}`,
            imageUrl: item.thumbUrl ? resolveImageDisplayUrl(item.thumbUrl) : "",
            videoUrl: resolveImageDisplayUrl(item.videoUrl),
            index: videoIdx,
          });
        } else if (item.kind === "audio") {
          audioIdx += 1;
          if (enforceCap && !info.withinCap) continue;
          out.push({
            key: item.nodeId,
            name: `音频${audioIdx}`,
            imageUrl: "",
            index: audioIdx,
            audioUrl: resolveImageDisplayUrl(item.audioUrl),
            displayName: audioReferenceFileName(item),
          });
        }
      }
      return out;
    }, [referenceMediaCapInfo, genMode]);

    // 取消关联某个上游素材：删掉「该上游节点 → 本节点」的连线。collectInputContents
    // 只走一跳，item.nodeId 就是直接相连的上游节点，可精确定位要删的边。
    const handleDetachUpstream = useCallback(
      (sourceNodeId: string) => {
        useCanvasStore
          .getState()
          .edges.filter((edge) => edge.source === sourceNodeId && edge.target === id)
          .forEach((edge) => deleteEdge(edge.id));
      },
      [id, deleteEdge],
    );

    // 通用上游遍历：拿到所有上游节点的 text/imageUrl/videoUrl/audioUrl 统一视图。
    // 视频生成只用其中的 text 字段拼接到 prompt 前面；image/video/audio 仍走
    // 各自分支已有的分类逻辑（带 backend 上限校验）。
    const upstreamContents = useMemo(
      () => upstreamNodes.map(extractUpstreamContent),
      [upstreamNodes],
    );
    const upstreamTextContents = useMemo(
      () =>
        upstreamContents.filter(
          (c) => typeof c.text === "string" && c.text.trim().length > 0,
        ),
      [upstreamContents],
    );
    const upstreamTextJoined = useMemo(
      () => joinUpstreamText(upstreamContents),
      [upstreamContents],
    );

    // Count upstream resources by media type. Drives the disable rules on the
    // tab row — e.g. 图生视频 only makes sense with images (no upstream videos),
    // 首尾帧 caps at 2 images.
    const upstreamCounts = useMemo(() => {
      let images = 0;
      let videos = 0;
      let audios = 0;
      for (const node of upstreamNodes) {
        if (isVideoNode(node)) {
          if (
            typeof node.data.videoUrl === "string" &&
            node.data.videoUrl.length > 0
          ) {
            videos += 1;
          }
        } else if (isAudioNode(node)) {
          if (
            typeof node.data.audioUrl === "string" &&
            node.data.audioUrl.length > 0
          ) {
            audios += 1;
          }
        } else if (referenceImageUrl(node)) {
          images += 1;
        }
      }
      return { images, videos, audios };
    }, [upstreamNodes]);
    const isClipMode = Boolean(data.isClipMode);
    const clipStartMs =
      typeof data.clipStartMs === "number" ? data.clipStartMs : null;
    const clipEndMs =
      typeof data.clipEndMs === "number" ? data.clipEndMs : null;
    const durationMs =
      typeof data.durationMs === "number" ? data.durationMs : null;

    const resolvedTitle = useMemo(
      () => resolveNodeDisplayName(CANVAS_NODE_TYPES.video, data),
      [data],
    );
    const resolvedWidth = Math.max(
      MIN_WIDTH,
      Math.round(width ?? DEFAULT_WIDTH),
    );
    const resolvedHeight = Math.max(
      MIN_HEIGHT,
      Math.round(height ?? DEFAULT_HEIGHT),
    );
    // 收起态浮动面板固定基础尺寸；放大用居中弹窗（见下方 OperationPanelShell）。
    const [panelExpanded, setPanelExpanded] = useState(false);
    const panelHeight = OPERATIONS_PANEL_HEIGHT;
    const panelOverhang = OPERATIONS_PANEL_OVERHANG;

    // ── 叠卡画册（count > 1 的一组生成结果，与图片节点同构）──
    // 收拢时主视频后探出 N-1 张卡片边；hover 出现右上角数量徽标，点开展开成
    // 宫格画册。展开态点视频设为主视频、可单独「应用到画布」/ 下载。
    const albumRootRef = useRef<HTMLDivElement | null>(null);
    const albumPointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
    const [albumExpanded, setAlbumExpanded] = useState(false);
    // 本次会话内"应到条数"——未完成的在画册里占位。存模块级登记表而非组件
    // state：onlyRenderVisibleElements 下平移出视口会卸载组件，state 会丢。
    const albumPendingTotal = useAlbumPendingTotal(id);
    const albumUrls = useMemo(() => {
      const raw = data.generationBatch;
      if (!Array.isArray(raw)) return [];
      return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
    }, [data.generationBatch]);
    const albumTotalSlots = Math.max(albumUrls.length, albumPendingTotal);
    const albumPendingCount = Math.max(0, albumPendingTotal - albumUrls.length);
    const hasAlbum = albumTotalSlots > 1;

    // 画册展开期间注册为本节点的 activeOverlay：外部 action 工具条 / 替换素材
    // 把手 / + 派生按钮都认它让位（拖动重新选中也压得住）。
    useEffect(() => {
      if (!albumExpanded) return;
      setActiveOverlayNodeId(id);
      return () => {
        if (useCanvasStore.getState().activeOverlayNodeId === id) {
          setActiveOverlayNodeId(null);
        }
      };
    }, [albumExpanded, id, setActiveOverlayNodeId]);

    useEffect(() => {
      if (!albumExpanded) return;
      const handlePointerDown = (event: PointerEvent) => {
        if (albumRootRef.current?.contains(event.target as Node)) return;
        setAlbumExpanded(false);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setAlbumExpanded(false);
      };
      window.addEventListener('pointerdown', handlePointerDown);
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('pointerdown', handlePointerDown);
        window.removeEventListener('keydown', handleKeyDown);
      };
    }, [albumExpanded]);

    const handleSetAlbumMainVideo = useCallback(
      (url: string) => {
        updateNodeData(id, { videoUrl: url, sourceFileName: null });
        setAlbumExpanded(false);
      },
      [id, updateNodeData],
    );

    // 展开画册时取消节点激活态；必须经 onNodesChange 清 React Flow 自身的
    // selected 标志（只清 store 的 selectedNodeId 会被选中同步 effect 写回）。
    // 副作用放在 setState updater 外面：updater 必须纯（StrictMode 会双调用）。
    const handleToggleAlbumExpanded = useCallback(() => {
      if (!albumExpanded) {
        const store = useCanvasStore.getState();
        const selectionChanges = store.nodes
          .filter((node) => node.selected)
          .map((node) => ({ id: node.id, type: 'select' as const, selected: false }));
        if (selectionChanges.length > 0) {
          store.onNodesChange(selectionChanges);
        }
        setSelectedNode(null);
        // 每次展开重置「应用到画布」的落点游标。
        albumAppliedCountRef.current = 0;
      }
      setAlbumExpanded(!albumExpanded);
    }, [albumExpanded, setSelectedNode]);

    // 「应用到画布」：把这条视频作为独立视频节点放到展开宫格右侧。连续应用
    // 的落点逐次错开，避免精确叠在同一坐标上只看得见最后一个。
    const albumAppliedCountRef = useRef(0);
    const handleApplyAlbumVideoToCanvas = useCallback(
      (url: string) => {
        const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
        if (!self) return;
        const applyIndex = albumAppliedCountRef.current;
        albumAppliedCountRef.current += 1;
        const position = {
          x: self.position.x + resolvedWidth * 2 + 12 + 48 + applyIndex * 36,
          y: self.position.y + applyIndex * 36,
        };
        const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, {
          videoUrl: url,
          aspectRatio: data.aspectRatio,
          user_spawned: true,
        } as Partial<VideoNodeData>);
        setSelectedNode(newNodeId);
      },
      [addNode, data.aspectRatio, id, resolvedWidth, setSelectedNode],
    );

    const handleDownloadAlbumVideo = useCallback(
      async (url: string, index: number) => {
        try {
          await downloadUrlAsFile(resolveImageDisplayUrl(url), `video-gen-${id}-${index + 1}.mp4`);
        } catch (error) {
          console.error('[video-node] album download failed', error);
        }
      },
      [id],
    );

    const clearTransientPreview = useCallback(() => {
      if (transientUrlRef.current) {
        URL.revokeObjectURL(transientUrlRef.current);
        transientUrlRef.current = null;
      }
      setTransientPreviewUrl(null);
    }, []);

    const processFile = useCallback(
      async (file: File) => {
        if (!isVideoFile(file)) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] no project in URL");
          return;
        }
        clearTransientPreview();
        const previewUrl = URL.createObjectURL(file);
        transientUrlRef.current = previewUrl;
        setTransientPreviewUrl(previewUrl);
        updateNodeData(id, { sourceFileName: file.name, isUploading: true });
        try {
          // HEVC（飞书录屏/iPhone）等 Web 不兼容编码先在浏览器内转成 H.264 再上传，
          // 否则 Edge 等无对应解码器的浏览器只有声音没画面。见 videoTranscode.ts。
          // 转码期间 UI 统一走「上传中」loading，不单独显示转码进度。
          const prepared = await ensureWebSafeVideo(file);
          if (prepared.transcoded) {
            // 源编码在本浏览器可能根本解不了（Edge+HEVC），本地预览也换成转码产物。
            clearTransientPreview();
            const preparedUrl = URL.createObjectURL(prepared.file);
            transientUrlRef.current = preparedUrl;
            setTransientPreviewUrl(preparedUrl);
          }
          const uploaded = await uploadFreezoneVideo(
            projectId,
            prepared.file,
            prepared.file.name,
          );
          updateNodeData(id, {
            videoUrl: uploaded.url,
            previewImageUrl: null,
            sourceFileName: file.name,
            isUploading: false,
          });
        } catch (error) {
          console.error("[video-node] upload failed", error);
          updateNodeData(id, { isUploading: false });
          clearTransientPreview();
        }
      },
      [clearTransientPreview, id, updateNodeData],
    );

    const handleFileChange = useCallback(
      async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) await processFile(file);
        event.target.value = "";
      },
      [processFile],
    );

    const handleDrop = useCallback(
      async (event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const file = resolveDroppedVideoFile(event);
        if (file) await processFile(file);
      },
      [processFile],
    );

    const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    }, []);

    const handleUploadClick = useCallback(() => {
      inputRef.current?.click();
    }, []);

    // Spawn one or two empty upload nodes to the left of this video node and
    // wire them as inputs. Used by the empty-state "首帧/首尾帧 生成视频" CTAs.
    const spawnFrameUploads = useCallback(
      (mode: "firstFrame" | "firstLastFrame") => {
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        if (!self) return;
        const UPLOAD_WIDTH = 320;
        const UPLOAD_HEIGHT = 350;
        const GAP_X = 40;
        const GAP_Y = 24;
        const baseX = self.position.x - UPLOAD_WIDTH - GAP_X;
        const stepY = UPLOAD_HEIGHT + GAP_Y;
        const nodeSize = (node: CanvasNode) => ({
          width:
            node.measured?.width ??
            (typeof node.width === "number" ? node.width : UPLOAD_WIDTH),
          height:
            node.measured?.height ??
            (typeof node.height === "number" ? node.height : UPLOAD_HEIGHT),
        });
        const overlaps = (
          a: { x: number; y: number; width: number; height: number },
          b: { x: number; y: number; width: number; height: number },
        ) => {
          const margin = 12;
          return (
            a.x < b.x + b.width + margin &&
            a.x + a.width + margin > b.x &&
            a.y < b.y + b.height + margin &&
            a.y + a.height + margin > b.y
          );
        };
        const occupiedRects = state.nodes
          .filter((node) => node.id !== self.id)
          .map((node) => {
            const size = nodeSize(node);
            return {
              x: node.position.x,
              y: node.position.y,
              width: size.width,
              height: size.height,
            };
          });
        const upstreamIds = new Set(
          state.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
        );
        const frameColumnNodes = state.nodes.filter((node) => {
          if (!upstreamIds.has(node.id)) return false;
          if (node.type !== CANVAS_NODE_TYPES.upload) return false;
          return Math.abs(node.position.x - baseX) < 8;
        });
        const lastFrameColumnY = frameColumnNodes.reduce<number | null>(
          (maxY, node) => (maxY === null ? node.position.y : Math.max(maxY, node.position.y)),
          null,
        );
        const resolveAvailableY = (preferredY: number) => {
          let y =
            lastFrameColumnY === null
              ? preferredY
              : Math.max(preferredY, lastFrameColumnY + stepY);
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const candidate = { x: baseX, y, width: UPLOAD_WIDTH, height: UPLOAD_HEIGHT };
            if (!occupiedRects.some((rect) => overlaps(candidate, rect))) {
              occupiedRects.push(candidate);
              return y;
            }
            y += stepY;
          }
          occupiedRects.push({ x: baseX, y, width: UPLOAD_WIDTH, height: UPLOAD_HEIGHT });
          return y;
        };
        if (mode === "firstFrame") {
          const baseY = resolveAvailableY(self.position.y);
          const newId = addNode(
            CANVAS_NODE_TYPES.upload,
            { x: baseX, y: baseY },
            {
              displayName: "首帧",
            },
          );
          addEdge(newId, id);
          state.autoGroupSpawn(id, [newId], { label: '首帧生成视频组' });
        } else {
          const totalH = UPLOAD_HEIGHT * 2 + GAP_Y;
          const startY =
            self.position.y + ((self.height ?? DEFAULT_HEIGHT) - totalH) / 2;
          const firstY = resolveAvailableY(startY);
          const lastY = resolveAvailableY(firstY + stepY);
          const firstId = addNode(
            CANVAS_NODE_TYPES.upload,
            { x: baseX, y: firstY },
            { displayName: "首帧" },
          );
          addEdge(firstId, id);
          const lastId = addNode(
            CANVAS_NODE_TYPES.upload,
            { x: baseX, y: lastY },
            { displayName: "尾帧" },
          );
          addEdge(lastId, id);
          state.autoGroupSpawn(id, [firstId, lastId], { label: '首尾帧生成视频组' });
        }
        // Both CTAs now route through the firstLastFrame mode — the backend
        // keyframes endpoint accepts just the first frame too. allReference
        // would have meant the omni-gen endpoint, which is a separate path.
        updateNodeData(id, { genMode: "firstLastFrame" });
      },
      [addEdge, addNode, id, updateNodeData],
    );

    // Spawn upload nodes from selected character-library entries — one per
    // selection, stacked vertically to the left of this video node, then wired
    // as upstream references so they show up in the operations panel.
    const spawnCharacterLibraryReferences = useCallback(
      (selections: ReadonlyArray<{ imageUrl: string; name: string }>) => {
        if (selections.length === 0) return;
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        if (!self) return;
        const UPLOAD_WIDTH = 320;
        const UPLOAD_HEIGHT = 240;
        const GAP_X = 40;
        const GAP_Y = 24;
        const baseX = self.position.x - UPLOAD_WIDTH - GAP_X;
        const totalH =
          UPLOAD_HEIGHT * selections.length + GAP_Y * (selections.length - 1);
        const startY =
          self.position.y + ((self.height ?? DEFAULT_HEIGHT) - totalH) / 2;
        const newIds: string[] = [];
        selections.forEach((sel, idx) => {
          const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
          const newId = addNode(
            CANVAS_NODE_TYPES.upload,
            { x: baseX, y },
            {
              imageUrl: sel.imageUrl,
              previewImageUrl: sel.imageUrl,
              displayName: sel.name || undefined,
            },
          );
          addEdge(newId, id);
          newIds.push(newId);
        });
        state.autoGroupSpawn(id, newIds, { label: '角色参考组' });
      },
      [addEdge, addNode, id],
    );

    const handleTranslatePrompt = useCallback(async () => {
      if (isTranslatingPrompt || isGenerating) return;
      const trimmed = prompt.trim();
      if (trimmed.length === 0) return;
      const project = readUrl().project;
      if (!project) {
        console.error("[video-node] translate: no project in URL");
        return;
      }
      setIsTranslatingPrompt(true);
      try {
        const ref = await submitFreezoneTextTranslate(project, {
          text: prompt,
          nodeType: "video",
          canvasId: readUrl().canvas ?? "default",
          nodeId: id,
        });
        await awaitTaskCompletion(ref.task_key, project);
        const result = await fetchFreezoneTextTranslateResult(
          project,
          ref.job_id,
        );
        if (result.translated_text) {
          updateNodeData(id, { prompt: result.translated_text });
        }
      } catch (error) {
        console.error("[video-node] translate failed", error);
      } finally {
        setIsTranslatingPrompt(false);
      }
    }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

    useEffect(() => {
      return canvasEventBus.subscribe("video-node/reupload", ({ nodeId }) => {
        if (nodeId !== id) return;
        inputRef.current?.click();
      });
    }, [id]);

    useEffect(() => {
      return canvasEventBus.subscribe(
        "video-node/external-file",
        ({ nodeId, file }) => {
          if (nodeId !== id || !isVideoFile(file)) return;
          void processFile(file);
        },
      );
    }, [id, processFile]);

    // First time an upstream image becomes available, flip the gen mode so the
    // video actually consumes it. Only fires while data.genMode is undefined —
    // once the user picks any tab (including textToVideo) we respect that.
    useEffect(() => {
      if (data.genMode != null) return;
      if (referenceImages.length === 0) return;
      updateNodeData(id, { genMode: "firstLastFrame" });
    }, [data.genMode, id, referenceImages.length, updateNodeData]);

    // Audio refs only carry meaning under the omni-gen (allReference) path —
    // textToVideo / firstLastFrame / imageToVideo discard them. So when an
    // audio upstream first appears, force the mode to `allReference`. Tracked
    // through a ref so we only fire on the 0 → ≥1 transition; once the user
    // disconnects all audio and reconnects, it fires again.
    const prevHasAudioRef = useRef(false);
    const hasAudioUpstream = useMemo(
      () => referenceMedia.some((item) => item.kind === "audio"),
      [referenceMedia],
    );
    useEffect(() => {
      const prev = prevHasAudioRef.current;
      prevHasAudioRef.current = hasAudioUpstream;
      if (!prev && hasAudioUpstream && data.genMode !== "allReference") {
        updateNodeData(id, { genMode: "allReference" });
      }
    }, [data.genMode, hasAudioUpstream, id, updateNodeData]);

    // 上游接入视频素材时，只有「全能参考」能消费视频；其它模式（文生 / 图生 /
    // 首尾帧 / 图片参考）都会把视频丢弃。所以只要上游存在视频就强制切到
    // allReference 并锁死——下面的 tab 禁用规则会把其它 tab 一并禁用。
    // 与音频的「0→≥1 transition」不同，这里每次都纠正，确保视频在场期间无法切走。
    useEffect(() => {
      if (upstreamCounts.videos === 0) return;
      if (genMode === "allReference") return;
      updateNodeData(id, { genMode: "allReference" });
    }, [upstreamCounts.videos, genMode, id, updateNodeData]);

    // 文生视频不接受任何素材引用。即便用户先手动选了 textToVideo 再接入
    // 图片/音频（此时上面两个自动切换 effect 都因 genMode 已显式而 bail），
    // 也要强制切走，否则会停在 textToVideo 把已连素材丢弃。音频优先走
    // allReference，否则按图片走 firstLastFrame。
    useEffect(() => {
      if (genMode !== "textToVideo") return;
      if (upstreamCounts.images === 0 && upstreamCounts.audios === 0) return;
      updateNodeData(id, {
        genMode: upstreamCounts.audios > 0 ? "allReference" : "firstLastFrame",
      });
    }, [
      genMode,
      upstreamCounts.images,
      upstreamCounts.audios,
      id,
      updateNodeData,
    ]);

    // 首尾帧只承载「首帧 + 尾帧」两张图。一旦上游图片数 >2，从语义上就不再是
    // 首尾帧场景（应该是多图参考 / 全能参考），自动切到 allReference 跟「视频
    // 上游强制切 allReference」是同一类兜底逻辑。每次都纠正，避免用户在 >2
    // 图状态下被卡在 firstLastFrame 触发 submit 时被静默截断成两张。
    useEffect(() => {
      if (genMode !== "firstLastFrame") return;
      if (upstreamCounts.images <= 2) return;
      updateNodeData(id, { genMode: "allReference" });
    }, [genMode, upstreamCounts.images, id, updateNodeData]);

    useEffect(
      () => () => {
        clearTransientPreview();
      },
      [clearTransientPreview],
    );

    const videoSource = useMemo(() => {
      if (data.videoUrl) return resolveImageDisplayUrl(data.videoUrl);
      if (transientPreviewUrl) return transientPreviewUrl;
      return null;
    }, [data.videoUrl, transientPreviewUrl]);

    // 预览专用 src：preload="metadata" 不会绘制任何一帧，又没有 poster，画布上
    // 就是一个纯黑框（视频本身正常，下载可看）。追加 `#t=0.1` 媒体片段，让浏览器
    // seek 到 0.1s 并把那一帧画出来当封面——与 NodeGenerationHistory /
    // CanvasHistoryAssetsModal 的缩略图用法一致。仅用于显示，不影响下载/抓帧/播放。
    const videoPosterSource = useMemo(() => {
      if (!videoSource) return null;
      return videoSource.includes("#t=") ? videoSource : `${videoSource}#t=0.1`;
    }, [videoSource]);

    useEffect(() => {
      updateNodeInternals(id);
    }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

    const [hasMetadata, setHasMetadata] = useState(false);
    const [videoLoadError, setVideoLoadError] = useState(false);
    useEffect(() => {
      setHasMetadata(false);
      setVideoLoadError(false);
    }, [videoSource]);

    // ---- subtitle erase mode (libtv-style 智能去字幕) ------------------------
    const subtitleEraseMode = data.subtitleEraseMode ?? null;
    const subtitleEraseBox = data.subtitleEraseBox ?? null;
    const [isErasing, setIsErasing] = useState(false);
    // Transient drag state — null when not currently dragging.
    const [eraseDrag, setEraseDrag] = useState<{
      x0: number;
      y0: number;
      x1: number;
      y1: number;
    } | null>(null);

    /**
     * Compute the displayed video frame rect inside its container (object-contain).
     * Returns container-pixel coords. We use this to (a) size the box overlay so
     * it sits on top of the actual video pixels (not the letterbox bars) and (b)
     * convert pointer coords ↔ normalized 0..1 source coords.
     */
    const getDisplayedVideoRect = useCallback(
      (containerW: number, containerH: number) => {
        const vw = data.widthPx ?? 0;
        const vh = data.heightPx ?? 0;
        if (!vw || !vh || containerW <= 0 || containerH <= 0) {
          return { left: 0, top: 0, width: containerW, height: containerH };
        }
        const containerRatio = containerW / containerH;
        const videoRatio = vw / vh;
        if (videoRatio > containerRatio) {
          const w = containerW;
          const h = containerW / videoRatio;
          return { left: 0, top: (containerH - h) / 2, width: w, height: h };
        }
        const h = containerH;
        const w = containerH * videoRatio;
        return { left: (containerW - w) / 2, top: 0, width: w, height: h };
      },
      [data.heightPx, data.widthPx],
    );

    const handleEraseExit = useCallback(() => {
      updateNodeData(id, { subtitleEraseMode: null, subtitleEraseBox: null });
      setEraseDrag(null);
    }, [id, updateNodeData]);

    const handleClipSubmit = useCallback(
      async (startMs: number, endMs: number) => {
        if (isComposingClip) return;
        const sourceUrl = data.videoUrl;
        if (!sourceUrl) return;
        if (endMs <= startMs) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] clip: no project in URL");
          return;
        }
        // Compose only supports 720p / 1080p — fall back to 720p for 480P sources.
        const composeResolution = quality === "1080P" ? "1080p" : "720p";
        setIsComposingClip(true);
        setClipError(null);
        try {
          const sourceStart = startMs / 1000;
          const sourceEnd = endMs / 1000;
          const ref = await submitFreezoneVideoCompose(projectId, {
            resolution: composeResolution,
            tracks: [
              {
                trackId: `track_${id}_video`,
                kind: "video",
                items: [
                  {
                    itemId: `item_${id}_${Date.now()}`,
                    sourceUrl,
                    timelineStart: 0,
                    sourceStart,
                    sourceEnd,
                  },
                ],
              },
            ],
          });
          await awaitTaskCompletion(ref.task_key, projectId);
          const result = await fetchFreezoneJobResult(
            projectId,
            "freezone_video_compose",
            ref.job_id,
          );
          if (result.url) {
            const state = useCanvasStore.getState();
            const position = state.findNodePosition(
              id,
              DEFAULT_WIDTH,
              DEFAULT_HEIGHT,
            );
            const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, {
              videoUrl: result.url,
              durationMs: Math.round((sourceEnd - sourceStart) * 1000),
              displayName: "剪辑",
            });
            addEdge(id, newNodeId);
            updateNodeData(id, {
              isClipMode: false,
              clipStartMs: null,
              clipEndMs: null,
            });
          } else {
            console.warn("[video-node] compose completed without url", result);
            setClipError("剪辑完成但未返回视频地址");
          }
        } catch (error) {
          console.error("[video-node] clip compose failed", error);
          setClipError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsComposingClip(false);
        }
      },
      [
        addEdge,
        addNode,
        data.videoUrl,
        id,
        isComposingClip,
        quality,
        updateNodeData,
      ],
    );

    const handleEraseSubmit = useCallback(async () => {
      if (isErasing) return;
      if (!data.videoUrl) return;
      if (subtitleEraseMode === "box" && !subtitleEraseBox) return;
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-node] no project in URL");
        return;
      }
      setIsErasing(true);
      try {
        const ref = await submitFreezoneVideoErase(projectId, {
          sourceUrl: data.videoUrl,
          mode: subtitleEraseMode === "box" ? "box" : "smart_subtitle",
          box: subtitleEraseMode === "box" ? subtitleEraseBox : null,
        });
        await awaitTaskCompletion(ref.task_key, projectId);
        const result = await fetchFreezoneJobResult(
          projectId,
          "freezone_video_erase",
          ref.job_id,
        );
        if (result.url) {
          updateNodeData(id, {
            videoUrl: result.url,
            subtitleEraseMode: null,
            subtitleEraseBox: null,
          });
        } else {
          console.warn("[video-node] erase completed without url", result);
        }
      } catch (error) {
        console.error("[video-node] subtitle erase failed", error);
      } finally {
        setIsErasing(false);
      }
    }, [
      data.videoUrl,
      id,
      isErasing,
      subtitleEraseBox,
      subtitleEraseMode,
      updateNodeData,
    ]);

    const submitDisabled =
      isGenerating ||
      (prompt.trim().length === 0 && upstreamTextJoined.length === 0);

    const handleSubmit = useCallback(async () => {
      if (submitDisabled) return;
      // 在途守卫（与 ImageGenNode 一致）：第 1 条完成就会清 isGenerating，
      // submitDisabled 拦不住「旧批次 N-1 个任务还在跑时重新提交」——旧闭包
      // 会用过期的 completedUrls 覆写新批次的 generationBatch。
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-node] no project in URL");
        return;
      }
      updateNodeData(id, {
        isGenerating: true,
        generationStartedAt: Date.now(),
        // Clear any prior failure so the banner reflects only this attempt.
        // 注意 generationBatch 不在这里清：下面还有多条校验失败的早退路径，
        // 在这里清会让一次失败的提交白白毁掉已有画册——批次清空挪到真正开跑前。
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      });
      // 运镜 fragment 拼接到最终 prompt 的开头；上游 text 在前、用户自己写
      // 的 prompt 在后，两段以 \n\n 隔开（与 ImageGenNode/ImageEditNode 一致）。
      const fragment = cameraMovementPreset?.promptFragment;
      const trimmedPrompt = prompt.trim();
      const userPrompt = [upstreamTextJoined, trimmedPrompt]
        .filter((s) => s.length > 0)
        .join("\n\n");
      const composedPrompt = fragment
        ? userPrompt
          ? `${fragment}，${userPrompt}`
          : fragment
        : userPrompt;
      try {
        // Walk the current edges/nodes once — used by every non-textToVideo
        // branch to collect upstream resources. 必须与 UI 编号侧（useUpstreamNodes）
        // 同源：按连线顺序收集。曾按 state.nodes 顺序（节点创建顺序）收集，先创建
        // 但后连线的节点会排到 references 前面，@图片N 在后端就指向错位的图。
        const collectUpstream = () => {
          const state = useCanvasStore.getState();
          return sortUpstreamByReferenceOrder(
            upstreamNodesInEdgeOrder(state.nodes, state.edges, id),
            data.referenceOrder,
          );
        };
        const collectUpstreamImageUrls = (): string[] => {
          const upstream = collectUpstream();
          const urls: string[] = [];
          for (const node of upstream) {
            const url = submittableImageUrl(node);
            if (typeof url === "string" && url.length > 0) urls.push(url);
          }
          return urls;
        };

        const durationClamped = clampVideoDuration(durationSec, durationBounds);
        const cameraTemplateId = cameraMovementId;
        // 后端按 canvas_id + node_id 记录每个节点的生成历史。多条生成时每个
        // 兄弟节点用各自的 targetId 作 node_id，历史才能分别落到对应节点。
        const canvasId = readUrl().canvas ?? "default";

        // 后端不再支持一次出多条，改为按「生成数量」并发调用 N 次接口。先按
        // genMode 组装出一个「调一次接口」的闭包 doSubmit，校验失败则置空提前返回。
        let doSubmit: ((targetId: string) => Promise<FreezoneJobRef>) | null = null;
        if (genMode === "firstLastFrame") {
          const imageUrls = collectUpstreamImageUrls();
          const firstFrameUrl = imageUrls[0] ?? null;
          const lastFrameUrl = imageUrls[1] ?? null;
          if (!firstFrameUrl && !lastFrameUrl) {
            console.warn(
              "[video-node] firstLastFrame submit without any frame",
            );
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          doSubmit = (targetId) =>
            submitFreezoneVideoKeyframes(projectId, {
              firstFrameUrl,
              lastFrameUrl,
              prompt: composedPrompt,
              cameraTemplateId,
              aspectRatio: submitAspectRatio,
              resolution: qualityToResolution(quality),
              durationSeconds: durationClamped,
              generateAudio,
              model: modelId,
              humanReview: isSeedance20Model && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "imageToVideo" || genMode === "imageReference") {
          // Unified i2v endpoint: 1 image = 图生视频, 2-9 images = 图片参考视频.
          const imageUrls = collectUpstreamImageUrls().slice(0, 9);
          if (imageUrls.length === 0) {
            console.warn("[video-node] i2v submit without any upstream image");
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          doSubmit = (targetId) =>
            submitFreezoneVideoI2v(projectId, {
              imageUrls,
              prompt: composedPrompt,
              cameraTemplateId,
              aspectRatio: submitAspectRatio,
              resolution: qualityToResolution(quality),
              durationSeconds: durationClamped,
              generateAudio,
              model: modelId,
              humanReview: isSeedance20Model && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "allReference") {
          // Omni-gen: classify each upstream node by its media type.
          // backend caps: image≤9, video≤3, audio≤3, total≤12.
          const upstream = collectUpstream();
          const references: FreezoneVideoReferenceItem[] = [];
          // 与 references 里 type==="audio" 的项一一对应，用于提交前校验音频总时长。
          const audioRefs: { url: string; durationMs: number | null }[] = [];
          let imageCount = 0;
          let videoCount = 0;
          let audioCount = 0;
          for (const node of upstream) {
            if (references.length >= 12) break;
            if (isVideoNode(node)) {
              const url =
                typeof node.data.videoUrl === "string"
                  ? node.data.videoUrl
                  : "";
              if (url && videoCount < 3) {
                references.push({ type: "video", url });
                videoCount += 1;
              }
            } else if (isAudioNode(node)) {
              const url =
                typeof node.data.audioUrl === "string"
                  ? node.data.audioUrl
                  : "";
              if (url && audioCount < 3) {
                // 音频引用默认走「配乐参考」语义；label 用 sourceFileName /
                // displayName 之一，方便后端日志和后续 UI 展示对得上。
                const rawLabel =
                  (typeof node.data.sourceFileName === "string"
                    ? node.data.sourceFileName
                    : "") ||
                  (typeof node.data.displayName === "string"
                    ? node.data.displayName
                    : "");
                references.push({
                  type: "audio",
                  url,
                  role: "配乐参考",
                  label: rawLabel,
                });
                audioRefs.push({
                  url,
                  durationMs:
                    typeof node.data.durationMs === "number"
                      ? node.data.durationMs
                      : null,
                });
                audioCount += 1;
              }
            } else {
              const url = submittableImageUrl(node);
              if (url && imageCount < 9) {
                references.push({ type: "image", url });
                imageCount += 1;
              }
            }
          }
          if (references.length === 0) {
            console.warn("[video-node] omni-gen submit without any reference");
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          // Seedance 2.0 后端限制音频总时长 ≤ 15.2s，超了会以 InvalidParameter
          // 报错。提交前先本地校验：durationMs 缺失时用 <audio> 探测兜底，超限就
          // 弹窗拦下，避免白跑一趟后端。仅对 seedance2 生效（其它模型上限可能不同）。
          if (isSeedance20Model && audioRefs.length > 0) {
            const resolvedDurations = await Promise.all(
              audioRefs.map((ref) =>
                typeof ref.durationMs === "number" && ref.durationMs > 0
                  ? Promise.resolve(ref.durationMs)
                  : probeAudioDurationMs(ref.url),
              ),
            );
            const totalAudioMs = resolvedDurations.reduce<number>(
              (sum, ms) => sum + (ms ?? 0),
              0,
            );
            if (totalAudioMs > MAX_AUDIO_TOTAL_DURATION_MS) {
              void showErrorDialog(
                t("node.videoNode.audio.durationExceeded", { max: 15 }),
                t("common.error"),
              );
              updateNodeData(id, {
                isGenerating: false,
                generationStartedAt: null,
              });
              return;
            }
          }
          doSubmit = (targetId) =>
            submitFreezoneVideoOmniGen(projectId, {
              prompt: composedPrompt,
              cameraTemplateId,
              references,
              aspectRatio: submitAspectRatio,
              resolution: qualityToResolution(quality),
              durationSeconds: durationClamped,
              generateAudio,
              model: modelId,
              humanReview: isSeedance20Model && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        } else {
          // textToVideo (default).
          doSubmit = (targetId) =>
            submitFreezoneVideoGen(projectId, {
              prompt: composedPrompt,
              cameraTemplateId,
              aspectRatio: submitAspectRatio,
              resolution: qualityToResolution(quality),
              durationSeconds: durationClamped,
              generateAudio,
              model: modelId,
              humanReview: isSeedance20Model && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        }

        if (!doSubmit) {
          updateNodeData(id, { isGenerating: false, generationStartedAt: null });
          return;
        }
        const submitOnce = doSubmit;

        // 多条生成不再复制兄弟节点：N 个任务并发、全部回填到当前节点的
        // generationBatch（叠卡画册，与图片节点一致）。第 1 条完成的设为主视频，
        // 其余逐条追加。
        const total = Math.min(Math.max(count, 1), 4);
        // 各并发任务完成顺序不定，本地累积已完成的 URL，整组写回（避免读改写竞态）。
        const completedUrls: string[] = [];
        // 收集每个子任务的失败，留到整批 settle 后统一决定是否弹错误框——避免
        // 「N 条里 1 条秒失败（如命中队列上限）、其余正常生成」时一边弹报错一边
        // 又冒加载动画的矛盾观感。
        const runErrors: unknown[] = [];
        const runOne = async (runIndex: number) => {
          try {
            const ref = await submitOnce(id);
            // Persist the task handle so a page refresh can resume this job.
            // N 个并发任务同节点只能存一个句柄——保留第 1 个（主视频）的。
            if (runIndex === 0) {
              updateNodeData(id, generationTaskDescriptor(ref));
            }
            const completed = await awaitTaskCompletion(ref.task_key, projectId);
            // Prefer the dedicated result endpoint — SSE `task.result` may only
            // carry metadata (same pattern as reverse_prompt + video_erase).
            let url = resolveOutputUrl(completed.result);
            if (!url) {
              try {
                const result = await fetchFreezoneJobResult(
                  projectId,
                  ref.task_type,
                  ref.job_id,
                );
                url = result.url || null;
              } catch (error) {
                console.error("[video-node] fetch job result failed", error);
              }
            }
            if (url) {
              completedUrls.push(url);
              const isFirstCompleted = completedUrls.length === 1;
              updateNodeData(id, {
                // 第 1 条完成的设为主视频并结束 loading；后续只扩充画册。
                ...(isFirstCompleted
                  ? {
                      videoUrl: url,
                      isGenerating: false,
                      generationStartedAt: null,
                      sourceFileName: null,
                      generationError: null,
                      generationErrorDetails: null,
                      generationErrorRequestId: null,
                    }
                  : {}),
                ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
              });
            } else {
              console.warn(
                "[video-node] video gen completed without output url",
                completed,
              );
              // 只有 run 0（任务句柄归属者）且尚无任何成功时才终结 loading——
              // 非首个任务先「无 URL 完成」不能把还在跑的整体 loading 掐掉。
              if (runIndex === 0 && completedUrls.length === 0) {
                updateNodeData(id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationError: "视频生成未返回结果",
                  generationErrorDetails: null,
                  generationErrorRequestId: null,
                });
              }
            }
          } catch (error) {
            console.error("[video-node] video gen failed", error);
            // 先记下错误再决定是否早退 —— settle 后的聚合分支靠 runErrors 判断
            // 「部分失败」并弹 toast；早退前不记会把首个成功之后的失败彻底吞掉。
            runErrors.push(error);
            // 已有同批其它视频完成（主视频已落）时不覆盖成功态为错误——
            // 部分失败只影响画册条数。
            if (completedUrls.length > 0) return;
            const resolved = resolveErrorContent(error, "视频生成失败");
            const displayErrorMessage = backendErrorToastMessage(error, t);
            // Persist the failure on the node so the 重新生成 entry survives after
            // the user dismisses the dialog (previously the error was dialog-only).
            // 只有 run 0 失败才终结 loading：非首 run 失败时 run 0 可能还在跑，
            // 它的成功补丁会清掉这里写的错误横幅。
            updateNodeData(id, {
              ...(runIndex === 0
                ? { isGenerating: false, generationStartedAt: null }
                : {}),
              generationError: displayErrorMessage,
              generationErrorDetails: resolved.details ?? null,
              generationErrorRequestId:
                extractRequestId(displayErrorMessage) ?? extractRequestId(resolved.details),
            });
          }
        };

        // 旧画册清空 + 占位计数都在所有校验通过、真正开跑前才动——前面有多个
        // 校验失败的早退路径，提前动会白白毁掉已有画册 / 把「生成中」占位卡死。
        updateNodeData(id, { generationBatch: null });
        setAlbumPendingTotal(id, total > 1 ? total : 0);
        await Promise.allSettled(
          Array.from({ length: total }, (_, runIndex) => runOne(runIndex)),
        );
        setAlbumPendingTotal(id, 0);
        // 整批结束后再决定错误反馈：
        //  - 一条都没成功 → 弹一次错误框（含真人素材被拦截的专用引导）；
        //  - 部分成功 → 不弹模态打断，仅用轻量 toast 告知少出了几条。
        // 这样「N 条里 1 条命中队列上限秒失败、其余正常在跑」时不会再出现
        // 「先弹上限报错、节点却又冒出加载动画」的矛盾观感。
        if (completedUrls.length === 0 && runErrors.length > 0) {
          const firstError = runErrors[0];
          const resolved = resolveErrorContent(firstError, "视频生成失败");
          const displayErrorMessage = backendErrorToastMessage(firstError, t);
          const haystack = `${displayErrorMessage}\n${resolved.details ?? ""}`;
          if (
            haystack.includes(
              "InputImageSensitiveContentDetected.PrivateInformation",
            )
          ) {
            // 素材含真实人脸被拦截：引导用户开启「真人素材审核」后重试。
            void showErrorDialog(
              "素材包含真实人脸，已被内容安全策略拦截。请在下方打开「真人素材审核」开关后重试（可能增加审核时间，不保证通过）。",
              "素材被拦截",
              resolved.details,
            );
          } else {
            void showErrorDialog(displayErrorMessage, t("common.error"), resolved.details);
          }
        } else if (runErrors.length > 0) {
          toast.error(
            t("node.videoNode.partialBatchFailed", {
              ok: completedUrls.length,
              total,
            }),
          );
        }
        // 所有任务尘埃落定后统一拉一次历史：N 条记录都落在本节点名下，run 0
        // settle 时就拉会漏掉后完成的 N-1 条（后端成功失败都会记）。
        void refreshHistory();
      } catch (error) {
        console.error("[video-node] video gen failed", error);
        updateNodeData(id, { isGenerating: false, generationStartedAt: null });
        setAlbumPendingTotal(id, 0);
      }
      } finally {
        submittingRef.current = false;
      }
    }, [
      aspectRatio,
      submitAspectRatio,
      cameraMovementId,
      cameraMovementPreset,
      count,
      durationBounds,
      durationSec,
      generateAudio,
      genMode,
      humanReview,
      id,
      isSeedance20Model,
      modelId,
      prompt,
      quality,
      refreshHistory,
      sceneOptimize,
      submitDisabled,
      updateNodeData,
      upstreamTextJoined,
    ]);

    const hasMainlineContext = hasMainlineContexts(
      (data as { mainline_context?: unknown }).mainline_context,
    );

    const cardToneClass = canvasNodeFrameClass({
      selected,
      mainline: hasMainlineContext,
    });

    const isUploading = Boolean(data.isUploading);
    const isEmptyVideoBody = !videoSource && !isUploading && !isGenerating && !hasGenerationError;
    const bodySurfaceClass = isEmptyVideoBody
      ? CANVAS_NODE_INPUT_SURFACE_CLASS
      : CANVAS_NODE_PANEL_SURFACE_CLASS;
    const bodyFrameClass = isEmptyVideoBody
      ? selected
        ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS
        : CANVAS_NODE_INPUT_BODY_FRAME_CLASS
      : cardToneClass;
    const showVideoOpsPanel =
      selected &&
      !isBoxSelecting &&
      !albumExpanded &&
      !isClipMode &&
      !subtitleEraseMode &&
      !data.referenceOnly &&
      // 视频高清节点用自己的 VideoUpscaleEditorOverlay 配置面板，不走常规生成面板。
      !data.isUpscaleNode;

    const handleCaptureFrame = useCallback(
      async (mode: "first" | "last" | "current") => {
        if (isCapturingFrame) return;
        if (!data.videoUrl) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-node] no project in URL");
          return;
        }
        const src = resolveImageDisplayUrl(data.videoUrl);
        const liveEl = videoRef.current;
        const liveDuration =
          liveEl && Number.isFinite(liveEl.duration) ? liveEl.duration : null;
        const fallbackDurationSec =
          typeof data.durationMs === "number" ? data.durationMs / 1000 : null;
        const knownDuration = liveDuration ?? fallbackDurationSec;
        let seekSec = 0;
        if (mode === "first") {
          seekSec = 0;
        } else if (mode === "last") {
          seekSec =
            knownDuration != null
              ? Math.max(0, knownDuration - 0.05)
              : Number.MAX_SAFE_INTEGER;
        } else {
          seekSec =
            liveEl && Number.isFinite(liveEl.currentTime)
              ? liveEl.currentTime
              : 0;
        }

        setIsCapturingFrame(true);
        try {
          const blob = await captureVideoFrameBlob(src, seekSec);
          const filename = `frame-${mode}-${Date.now()}.png`;
          const file = new File([blob], filename, { type: "image/png" });
          const uploaded = await uploadFreezoneImage(
            projectId,
            file,
            filename,
          );
          const widthPx = data.widthPx;
          const heightPx = data.heightPx;
          const aspectForNode =
            widthPx && heightPx && widthPx > 0 && heightPx > 0
              ? `${widthPx}:${heightPx}`
              : data.aspectRatio || "16:9";
          const createdNodeId = addDerivedUploadNode(
            id,
            uploaded.url,
            aspectForNode,
            uploaded.url,
          );
          if (createdNodeId) {
            const titleKey =
              mode === "first"
                ? "node.videoNode.frame.titleFirst"
                : mode === "last"
                  ? "node.videoNode.frame.titleLast"
                  : "node.videoNode.frame.titleCurrent";
            updateNodeData(createdNodeId, { displayName: t(titleKey) });
            addEdge(id, createdNodeId);
          }
        } catch (error) {
          console.error("[video-node] frame capture failed", error);
        } finally {
          setIsCapturingFrame(false);
        }
      },
      [
        addDerivedUploadNode,
        addEdge,
        data.aspectRatio,
        data.durationMs,
        data.heightPx,
        data.videoUrl,
        data.widthPx,
        id,
        isCapturingFrame,
        t,
        updateNodeData,
      ],
    );

    return (
      <div
        ref={albumRootRef}
        className="group relative h-full w-full overflow-visible"
        style={{ width: resolvedWidth, height: resolvedHeight }}
        onClick={() => setSelectedNode(id)}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* 叠卡画册的卡片边：从主视频右侧探出（与图片节点同款），点卡边也能展开画册。 */}
        {hasAlbum && !albumExpanded && videoSource && (
          <>
            {Array.from({ length: Math.min(albumTotalSlots - 1, 3) }, (_, index) => {
              const step = index + 1;
              return (
                <div
                  key={`album-deck-${index}`}
                  role="button"
                  tabIndex={-1}
                  title="展开画册"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleAlbumExpanded();
                  }}
                  className="absolute cursor-pointer rounded-[var(--node-radius)] border border-white/[0.18] bg-gradient-to-b from-[#48484d] to-[#2d2d31] shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
                  style={{
                    top: step * 7,
                    bottom: step * 7,
                    left: step * 6,
                    right: -step * 7,
                    transform: `rotate(${step * 1.1}deg)`,
                    transformOrigin: 'center right',
                    opacity: 1 - step * 0.18,
                  }}
                />
              );
            })}
          </>
        )}
        <Handle
          type="target"
          position={Position.Left}
          id="target"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="source"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />

        {/* 画册展开时隐藏浮动标题和分辨率角标——画册容器自带头部（与图片节点一致）。 */}
        {!albumExpanded && (
          <>
            <NodeHeader
              className={NODE_HEADER_FLOATING_POSITION_CLASS}
              icon={<VideoIcon className="h-4 w-4" />}
              titleText={resolvedTitle}
              editable
              onTitleChange={(nextTitle) =>
                updateNodeData(id, { displayName: nextTitle })
              }
            />
            {videoSource &&
            hasMetadata &&
            !videoLoadError &&
            typeof data.widthPx === "number" &&
            typeof data.heightPx === "number" &&
            data.widthPx > 0 &&
            data.heightPx > 0 ? (
              <div
                className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
                title={t("node.videoNode.resolution")}
              >
                <VideoIcon className="h-3 w-3 text-white/45" />
                {data.widthPx}×{data.heightPx}
              </div>
            ) : null}
          </>
        )}
        <NodeContextBadges
          contexts={(data as { mainline_context?: unknown }).mainline_context}
        />

        <NodeResizeHandle
          minWidth={MIN_WIDTH}
          minHeight={MIN_HEIGHT}
          maxWidth={MAX_WIDTH}
          maxHeight={MAX_HEIGHT}
          keepAspectRatio
        />

        {!videoSource && !isUploading && !isGenerating && !data.isUpscaleNode && (
          <NodeSideActionRail nodeId={id} autoHide selected={Boolean(selected)}>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleUploadClick();
              }}
              className={NODE_SIDE_ACTION_BUTTON_CLASS}
              title={t("node.videoNode.clickToUpload")}
            >
              <UploadIcon className={NODE_SIDE_ACTION_ICON_CLASS} />
              <span>{t("node.videoNode.upload")}</span>
            </button>
          </NodeSideActionRail>
        )}

        <div
          className={`relative flex h-full w-full items-center justify-center ${videoSource ? "overflow-hidden" : "overflow-visible"} rounded-[var(--node-radius)] border ${bodySurfaceClass} transition-colors ${bodyFrameClass} ${
            // 画册展开时藏起节点本体——半透明的画册容器盖不严，底下的视频会透出来。
            albumExpanded && hasAlbum ? "invisible" : ""
          }`}
        >
          {/* 生成/上传中优先显示 loading：原地重新生成时 videoUrl 仍是上一条结果，
              若不加这层 guard，旧视频会一直占位、isGenerating 分支永远到不了。
              失败时 isGenerating 归 false，旧视频自动复现（videoUrl 未被清空）。 */}
          {!isGenerating && !isUploading && videoSource ? (
            <video
              ref={setVideoRef}
              src={videoPosterSource ?? undefined}
              className="h-full w-full object-contain"
              playsInline
              preload="metadata"
              onClick={() => {
                // 点击视频本体只负责选中节点 —— 播放/暂停统一交给左下角按钮。
                setSelectedNode(id);
              }}
              onLoadedMetadata={(event) => {
                const el = event.currentTarget;
                setHasMetadata(true);
                setVideoLoadError(false);
                if (el.videoWidth && el.videoHeight) {
                  // 只把视频真实像素记到 widthPx/heightPx；不要写回 aspectRatio。
                  // aspectRatio 仅保存用户选的比例预设（16:9 / auto…），否则
                  // chip 会显示成像素串(1248:704)，且会作为非法 aspect_ratio 带进
                  // 下一次生成请求。
                  const updates: Partial<VideoNodeData> = {};
                  if (data.widthPx !== el.videoWidth)
                    updates.widthPx = el.videoWidth;
                  if (data.heightPx !== el.videoHeight)
                    updates.heightPx = el.videoHeight;
                  if (data.durationMs !== Math.round(el.duration * 1000)) {
                    updates.durationMs = Math.round(el.duration * 1000);
                  }
                  if (Object.keys(updates).length > 0) {
                    updateNodeData(id, updates);
                  }
                }
              }}
              onError={() => {
                setHasMetadata(true);
                setVideoLoadError(true);
              }}
            />
          ) : isUploading ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
              <Loader2 className="h-7 w-7 animate-spin opacity-70" />
              <span className="px-4 text-center text-[12px] leading-6">
                {t("node.videoNode.uploading")}
              </span>
            </div>
          ) : isGenerating && historyPreviewUrl ? (
            // 生成进行中，但用户点了历史记录预览：临时播放那条历史视频，新视频
            // 仍在后台生成。顶部 pill 提示「生成中」，右上「返回」回到 loading。
            <div className="relative h-full w-full">
              <video
                src={resolveImageDisplayUrl(historyPreviewUrl)}
                className="h-full w-full object-contain"
                controls
                playsInline
                preload="metadata"
                onClick={(event) => event.stopPropagation()}
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
                <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  新视频生成中…
                </span>
                <button
                  type="button"
                  className="nodrag pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur transition-colors hover:bg-black/75"
                  onClick={(event) => {
                    event.stopPropagation();
                    setHistoryPreviewUrl(null);
                  }}
                >
                  <XIcon className="h-3 w-3" />
                  返回
                </button>
              </div>
            </div>
          ) : isGenerating ? (
            <div className="relative h-full w-full">
              {data.previewImageUrl ? (
                <img
                  src={resolveImageDisplayUrl(data.previewImageUrl)}
                  alt=""
                  className="h-full w-full object-contain"
                  draggable={false}
                />
              ) : null}
              <NodeGenerationOverlay
                startedAt={data.generationStartedAt ?? null}
                durationMs={data.generationDurationMs}
                hasBackground={Boolean(data.previewImageUrl)}
              />
            </div>
          ) : hasGenerationError ? (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
              <AlertTriangle className="h-7 w-7 opacity-90" />
              <span className="text-center text-[12px] font-medium leading-5 text-red-200">
                视频生成失败
              </span>
              <span className="max-h-[64px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90 [overflow-wrap:anywhere]">
                {generationError}
              </span>
              {generationErrorRequestId && (
                <div className="flex w-full max-w-[240px] items-center gap-1 rounded bg-red-500/10 px-2 py-1">
                  <span className="shrink-0 text-[10px] text-red-300/70">请求ID</span>
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[10px] text-red-200"
                    title={generationErrorRequestId}
                  >
                    {generationErrorRequestId}
                  </code>
                </div>
              )}
              <div className="mt-1">
                <RegenerateButton
                  onClick={() => void handleSubmit()}
                  busy={isGenerating}
                  disabled={submitDisabled}
                />
              </div>
            </div>
          ) : data.isUpscaleNode ? (
            <div className="flex h-full w-full items-center justify-center px-6">
              <span className="text-center text-sm font-medium text-text-dark/78">
                {t("node.videoUpscale.placeholder")}
              </span>
            </div>
          ) : (
            <div className="flex h-full w-full items-center px-8">
              {/* 上游含视频时只能走全能参考，首尾帧/首帧这两个 CTA 会引导到被禁用的
                  firstLastFrame 模式，所以此时隐藏。 */}
              {upstreamCounts.videos === 0 && (
                <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                  <div className="text-xs text-[var(--canvas-node-input-helper)]">试试：</div>
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        spawnFrameUploads("firstLastFrame");
                      }}
                      className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                    >
                      <Layers className="h-4 w-4 text-text-muted/90" />
                      <span>首尾帧生成视频</span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        spawnFrameUploads("firstFrame");
                      }}
                      className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                    >
                      <Sparkles className="h-4 w-4 text-text-muted/90" />
                      <span>首帧生成视频</span>
                    </button>
                  </div>
                </div>
              )}
              <Play className="ml-auto mr-20 h-9 w-9 text-text-muted/46" />
            </div>
          )}

          {videoSource && videoLoadError && !isGenerating && !isUploading && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-dark/70 px-4 text-center text-red-200">
              <AlertTriangle className="h-6 w-6 text-red-300" />
              <span className="text-[12px] font-medium">视频加载失败</span>
            </div>
          )}

          {videoSource && !hasMetadata && !isUploading && !isGenerating && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-bg-dark/40">
              <Loader2 className="h-6 w-6 animate-spin text-text-muted/70" />
            </div>
          )}

          {videoSource &&
            hasMetadata &&
            !videoLoadError &&
            !isGenerating &&
            !isUploading &&
            !subtitleEraseMode && (
              <VideoPlayerControls
                videoEl={videoEl}
                isCapturingFrame={isCapturingFrame}
                onCapture={handleCaptureFrame}
              />
            )}

          {/* 画册数量徽标：hover 节点出现，hover 徽标箭头下探，点击展开画册。 */}
          {hasAlbum && !isGenerating && videoSource && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleAlbumExpanded();
              }}
              onPointerDown={(event) => event.stopPropagation()}
              title={`展开 ${albumTotalSlots} 条生成结果`}
              className="nodrag group/albumpill absolute right-2 top-2 z-10 hidden items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[12px] font-medium tabular-nums text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85 group-hover:inline-flex"
            >
              {albumPendingCount > 0
                ? `${albumUrls.length}/${albumPendingTotal}`
                : albumUrls.length}
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform duration-200 ${
                  albumExpanded
                    ? 'rotate-180 group-hover/albumpill:-translate-y-[2px]'
                    : 'group-hover/albumpill:translate-y-[2px]'
                }`}
              />
            </button>
          )}

          {videoSource && subtitleEraseMode === "box" && (
            <SubtitleEraseBoxOverlay
              box={subtitleEraseBox}
              drag={eraseDrag}
              disabled={isErasing}
              getDisplayedRect={getDisplayedVideoRect}
              onDragStart={(start) => setEraseDrag(start)}
              onDragMove={(next) =>
                setEraseDrag((prev) =>
                  prev ? { ...prev, x1: next.x1, y1: next.y1 } : prev,
                )
              }
              onDragEnd={(final) => {
                setEraseDrag(null);
                if (!final) return;
                updateNodeData(id, { subtitleEraseBox: final });
              }}
            />
          )}
        </div>

        {/* 展开的画册宫格：与图片节点同构——「组」式轮廓 + 2 列宫格；点视频设为
            主视频并收拢；hover 出现「应用到画布」+ 下载；按住可拖动整个节点。 */}
        {albumExpanded && hasAlbum && (
          <div
            className="nowheel absolute -left-3 -top-3 z-[80] cursor-grab rounded-2xl border border-white/15 bg-white/[0.045] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-[2px] active:cursor-grabbing"
            style={{ width: resolvedWidth * 2 + 12 + 24 }}
            onClick={(event) => event.stopPropagation()}
            onPointerDownCapture={(event) => {
              albumPointerDownPosRef.current = { x: event.clientX, y: event.clientY };
            }}
          >
            <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-white/60">
              <VideoIcon className="h-3.5 w-3.5 text-white/45" />
              画册 · {albumTotalSlots} 条
            </div>
            <div className="grid grid-cols-2 gap-3">
              {albumUrls.map((url, index) => {
                const isMain = url === data.videoUrl;
                return (
                  <div
                    key={`album-cell-${index}`}
                    role="button"
                    tabIndex={-1}
                    title="点击设为主视频"
                    onClick={(event) => {
                      event.stopPropagation();
                      // 拖动画册（移动节点）后松手补发的 click 不算选主视频。
                      const start = albumPointerDownPosRef.current;
                      if (
                        start
                        && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
                      ) {
                        return;
                      }
                      handleSetAlbumMainVideo(url);
                    }}
                    className={`group/albumcell relative cursor-pointer overflow-hidden rounded-[var(--node-radius)] border bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition-colors ${
                      isMain
                        ? 'border-accent/80 ring-2 ring-accent/40'
                        : 'border-white/12 hover:border-white/35'
                    }`}
                    style={{ width: resolvedWidth, height: resolvedHeight }}
                  >
                    <video
                      src={resolveImageDisplayUrl(url)}
                      muted
                      playsInline
                      preload="metadata"
                      className="h-full w-full object-cover"
                      onMouseEnter={(event) => {
                        void event.currentTarget.play().catch(() => undefined);
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.pause();
                        event.currentTarget.currentTime = 0;
                      }}
                    />
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleApplyAlbumVideoToCanvas(url);
                      }}
                      title="把这条视频作为独立视频节点放到画布上"
                      className="nodrag absolute left-2 top-2 z-10 hidden h-7 items-center gap-1 rounded-md bg-black/70 px-2.5 text-[12px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                    >
                      <UploadIcon className="h-3.5 w-3.5" />
                      应用到画布
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDownloadAlbumVideo(url, index);
                      }}
                      title="下载这条视频"
                      className="nodrag absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                    >
                      <Download className="h-3.5 w-3.5" />
                    </button>
                    {isMain && (
                      <span className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                        主视频
                      </span>
                    )}
                  </div>
                );
              })}
              {/* 还在生成中的槽位：占位骨架，完成一条替换一条。 */}
              {Array.from({ length: albumPendingCount }, (_, index) => (
                <div
                  key={`album-pending-${index}`}
                  className="relative flex items-center justify-center overflow-hidden rounded-[var(--node-radius)] border border-white/10 bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
                  style={{ width: resolvedWidth, height: resolvedHeight }}
                >
                  <div className="flex flex-col items-center gap-2 text-text-muted/70">
                    <Loader2 className="h-6 w-6 animate-spin" />
                    <span className="text-[12px]">生成中…</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {isClipMode && videoSource && (
          <div
            className="absolute left-0 right-0 z-10 flex flex-col gap-1"
            style={{ top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)` }}
          >
            <VideoClipPanel
              videoUrl={videoSource}
              durationMs={durationMs}
              clipStartMs={clipStartMs}
              clipEndMs={clipEndMs}
              isSubmitting={isComposingClip}
              onChange={(patch) => updateNodeData(id, patch)}
              onExit={() => {
                if (isComposingClip) return;
                setClipError(null);
                updateNodeData(id, { isClipMode: false });
              }}
              onSubmit={(start, end) => {
                void handleClipSubmit(start, end);
              }}
            />
            {clipError && (
              <div className="rounded-md bg-red-500/15 px-3 py-1.5 text-[11px] text-red-300 break-words [overflow-wrap:anywhere]">
                剪辑失败：{clipError}
              </div>
            )}
          </div>
        )}

        {showVideoOpsPanel && (
            <OperationPanelShell
              expanded={panelExpanded}
              onCollapse={() => setPanelExpanded(false)}
              inlineClassName={`nodrag absolute z-30 flex flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
              inlineStyle={{
                top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)`,
                left: -panelOverhang,
                right: -panelOverhang,
                height: panelHeight,
              }}
              modalStyle={{
                width: `min(${OPERATIONS_PANEL_EXPANDED_WIDTH}px, 92vw)`,
                height: `min(${OPERATIONS_PANEL_EXPANDED_HEIGHT}px, 86vh)`,
              }}
            >
              <PanelExpandButton
                expanded={panelExpanded}
                onToggle={() => setPanelExpanded((v) => !v)}
                className="absolute right-2 top-2 z-20"
              />
              <div className="flex shrink-0 items-center overflow-x-auto px-3 pb-2 pr-10 pt-3">
                <div className="flex shrink-0 items-center gap-2">
                  <CameraMovementChip
                    templates={cameraTemplates}
                    isLoading={cameraTemplatesLoading}
                    selectedId={cameraMovementId}
                    onChange={(nextId) =>
                      updateNodeData(id, { cameraMovement: nextId })
                    }
                  />
                  <CharacterLibraryChip
                    onOpen={() => setIsCharacterLibraryOpen(true)}
                  />
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-3">
                  <GenModeSelect
                    value={genMode}
                    upstreamCounts={upstreamCounts}
                    onChange={(nextMode) => updateNodeData(id, { genMode: nextMode })}
                  />
                  <NodeContextPromptPaletteButton
                    nodeId={id}
                    onInsert={insertContextPaletteEntry}
                  />
                  {upstreamTextContents.map((content) => (
                    <ReferenceTextChip
                      key={`upstream-text-${content.nodeId}`}
                      nodeId={content.nodeId}
                      text={content.text ?? ""}
                      sourceLabel={content.displayName ?? content.nodeType}
                      onDetach={handleDetachUpstream}
                    />
                  ))}
                </div>
                {referenceMedia.length > 0 && (
                  <ReferenceMediaRow
                    items={referenceMediaCapInfo}
                    enforceCap={REFERENCE_CAPS_BY_MODE[genMode] != null}
                    genMode={genMode}
                    onFocus={(nodeId) => setSelectedNode(nodeId)}
                    onDetach={handleDetachUpstream}
                    onReorder={(ids) =>
                      updateNodeData(id, { referenceOrder: ids })
                    }
                  />
                )}
              </div>

              <PromptMentionEditor
                ref={promptEditorRef}
                value={promptDraft}
                onChange={(next) => {
                  setPromptDraft(next);
                  if (!isComposingRef.current) {
                    updateNodeData(id, { prompt: next });
                  }
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(next) => {
                  isComposingRef.current = false;
                  setPromptDraft(next);
                  updateNodeData(id, { prompt: next });
                }}
                onKeyDown={(event) => event.stopPropagation()}
                candidates={mentionCandidates}
                placeholder={
                  upstreamTextJoined.length > 0
                    ? "上游内容已自动接入，可继续补充提示词…"
                    : t("node.videoNode.placeholder")
                }
                className={`nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              />

              <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <ProviderModelPicker
                    selectedModelId={modelId}
                    onChange={(nextModelId) => {
                      updateNodeData(id, { model: nextModelId });
                      // 记住这次选择，后续新建的视频节点将继承它。
                      writeLastVideoModel(nextModelId);
                    }}
                    domain="video"
                    popoverPlacement="top"
                    getOptionDisabledReason={(model) =>
                      videoModelReferenceDisabledReason(model.apiModel ?? model.id, upstreamCounts)
                    }
                  />
                  <VideoConfigChip
                    aspectRatio={aspectRatio}
                    quality={quality}
                    qualityOptions={qualityOptions}
                    durationSec={durationSec}
                    durationBounds={durationBounds}
                    sceneOptimize={sceneOptimize}
                    sceneOptimizeOptions={sceneOptimizeOptions}
                    generateAudio={generateAudio}
                    onChange={(patch) => updateNodeData(id, patch)}
                  />
                  {isSeedance20Model && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={humanReview}
                      title="素材含真实人脸时开启，可能增加审核时间，不保证通过。"
                      onClick={(event) => {
                        event.stopPropagation();
                        updateNodeData(id, { humanReview: !humanReview });
                      }}
                      className={`nodrag inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium transition-colors ${
                        humanReview
                          ? "text-text-dark"
                          : "text-text-dark/72 hover:text-text-dark"
                      }`}
                    >
                      <span>真人验证</span>
                      <span
                        className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${
                          humanReview
                            ? "bg-[rgb(var(--accent-rgb))]"
                            : "bg-white/15"
                        }`}
                      >
                        <span
                          className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
                            humanReview ? "translate-x-3" : "translate-x-0.5"
                          }`}
                        />
                      </span>
                    </button>
                  )}
                  <CountPicker
                    value={count}
                    onChange={(nextCount) =>
                      updateNodeData(id, { count: nextCount })
                    }
                  />
                  <button
                    type="button"
                    title="翻译提示词（中英文互译）"
                    disabled={
                      isTranslatingPrompt ||
                      isGenerating ||
                      prompt.trim().length === 0
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleTranslatePrompt();
                    }}
                    className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
                      isTranslatingPrompt
                        ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS
                        : ""
                    }`}
                  >
                    {isTranslatingPrompt ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Languages className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <CreditCostPill
                    display={totalCreditCostDisplay}
                    disabled={submitDisabled}
                    className={NODE_CREDIT_PILL_FLAT_CLASS}
                  />
                  <button
                    type="button"
                    disabled={submitDisabled}
                    title={
                      isGenerating
                        ? t("node.videoNode.submitBusy")
                        : t("node.videoNode.submit")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleSubmit();
                    }}
                    className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                      submitDisabled
                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                        : NODE_GENERATE_BUTTON_ENABLED_CLASS
                    }`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </OperationPanelShell>
          )}

        {selected &&
          !isBoxSelecting &&
          !albumExpanded &&
          !isClipMode &&
          !subtitleEraseMode &&
          !data.referenceOnly &&
          hasCompletedHistoryRecords(historyRecords) && (
            <div
              className={`nodrag absolute z-[300] rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} ${NODE_OPS_PANEL_ENTER_CLASS} px-3 py-2`}
              style={{
                top: `calc(100% + ${OPERATIONS_PANEL_GAP * 2 + panelHeight}px)`,
                left: -panelOverhang,
                right: -panelOverhang,
              }}
              onClick={(event) => event.stopPropagation()}
            >
              <NodeGenerationHistory
                records={historyRecords}
                isLoading={historyLoading}
                onRestore={handleRestoreHistory}
                onRefresh={() => void refreshHistory()}
                isActive={(record) => {
                  const url = historyRecordOutputUrl(record);
                  if (!url) return false;
                  // 预览态下高亮正在预览的历史条，否则高亮当前主视频。
                  if (isGenerating && historyPreviewUrl) {
                    return url === historyPreviewUrl;
                  }
                  return url === data.videoUrl;
                }}
              />
            </div>
          )}

        {subtitleEraseMode && (
          <div
            className="nodrag absolute left-0 right-0 z-10 flex justify-center"
            style={{ top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)` }}
            onClick={(event) => event.stopPropagation()}
          >
            <SubtitleEraseOpsPanel
              mode={subtitleEraseMode}
              isErasing={isErasing}
              hasBox={!!subtitleEraseBox}
              onExit={handleEraseExit}
              onResetBox={() => updateNodeData(id, { subtitleEraseBox: null })}
              onSubmit={handleEraseSubmit}
            />
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept={VIDEO_FILE_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />

        <CharacterLibraryModal
          open={isCharacterLibraryOpen}
          project={readUrl().project ?? null}
          onClose={() => setIsCharacterLibraryOpen(false)}
          onConfirm={(selections) =>
            spawnCharacterLibraryReferences(selections)
          }
        />
      </div>
    );
  },
);

VideoNode.displayName = "VideoNode";

interface GenModeSelectProps {
  value: VideoGenMode;
  upstreamCounts: { videos: number; images: number; audios: number };
  onChange: (next: VideoGenMode) => void;
}

function videoModeDisabledReason(
  mode: VideoGenMode,
  upstreamCounts: { videos: number; images: number; audios: number },
): string | null {
  if (upstreamCounts.videos > 0 && mode !== "allReference") {
    return "上游含视频素材时只能用「全能参考」";
  }
  if (
    mode === "textToVideo" &&
    (upstreamCounts.images > 0 || upstreamCounts.audios > 0)
  ) {
    return "已引用图片/音频素材时不可用";
  }
  if (mode === "imageToVideo" && upstreamCounts.videos >= 2) {
    return "上游有多个视频时不可用";
  }
  if (mode === "firstLastFrame" && upstreamCounts.images > 2) {
    return "上游图片超过 2 张时不可用";
  }
  return null;
}

function GenModeSelect({ value, upstreamCounts, onChange }: GenModeSelectProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const activeTab = MODE_TABS.find((tab) => tab.key === value) ?? MODE_TABS[0];

  const syncPopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    setPopoverPosition({
      left: Math.min(Math.max(margin, rect.left), window.innerWidth - 132 - margin),
      top: rect.bottom + 8,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    syncPopoverPosition();
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onViewportChange = () => syncPopoverPosition();
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [isOpen, syncPopoverPosition]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_CONTEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t(activeTab.labelKey)}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className={VIDEO_MODE_POPOVER_CLASS}
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {MODE_TABS.map((tab) => {
            const isActive = tab.key === value;
            const disabledReason = videoModeDisabledReason(tab.key, upstreamCounts);
            const isDisabled = disabledReason != null && !isActive;
            return (
              <button
                key={tab.key}
                type="button"
                disabled={isDisabled}
                title={disabledReason ?? undefined}
                onClick={() => {
                  if (isDisabled) return;
                  onChange(tab.key);
                  setIsOpen(false);
                }}
                className={`block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors ${
                  isActive
                    ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                    : isDisabled
                      ? "cursor-not-allowed text-text-muted/40"
                      : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                }`}
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface VideoConfigChipProps {
  aspectRatio: FreezoneVideoAspectRatio;
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  generateAudio: boolean;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function VideoConfigChip({
  aspectRatio,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  generateAudio,
  onChange,
}: VideoConfigChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>
          {aspectRatio === "auto"
            ? t("node.videoNode.aspect.auto")
            : aspectRatio}
        </span>
        <span className="text-text-muted/80">·</span>
        <span>{quality}</span>
        <span className="text-text-muted/80">·</span>
        <span>{durationSec}s</span>
        {generateAudio ? (
          <Volume2 className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
        ) : (
          <VolumeX className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
        )}
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={VIDEO_PARAM_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.aspect.title")}
          </div>
          <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
            {ASPECT_RATIOS.map((ratio) => {
              const isActive = aspectRatio === ratio;
              return (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => onChange({ aspectRatio: ratio })}
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : VIDEO_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {ratio === "auto" ? t("node.videoNode.aspect.auto") : ratio}
                </button>
              );
            })}
          </div>

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.quality.title")}
          </div>
          <div className={`grid grid-cols-3 ${VIDEO_PARAM_ROW_CLASS}`}>
            {qualityOptions.map((q) => {
              const isActive = quality === q;
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => onChange({ quality: q })}
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : VIDEO_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {q}
                </button>
              );
            })}
          </div>

          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-text-dark/72">
            <span>{t("node.videoNode.duration.title")}</span>
            <span className="normal-case text-text-dark">{durationSec}s</span>
          </div>
          <input
            type="range"
            min={durationBounds.min}
            max={durationBounds.max}
            step={1}
            value={durationSec}
            onChange={(event) =>
              onChange({
                durationSec: clampVideoDuration(Number(event.target.value), durationBounds),
              })
            }
            className="video-duration-slider mb-4 w-full"
          />

          {sceneOptimizeOptions.length > 0 && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.sceneOptimize.title")}
              </div>
              <div className={`grid grid-cols-2 ${VIDEO_PARAM_ROW_CLASS}`}>
                {sceneOptimizeOptions.map((option) => {
                  const isActive = sceneOptimize === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onChange({ sceneOptimize: option })}
                      className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                        isActive
                          ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                          : VIDEO_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {t(`node.videoNode.sceneOptimize.options.${option}`)}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.audio.title")}
          </div>
          <div className="flex items-center justify-between rounded-[8px] bg-white/[0.045] px-2.5 py-1.5">
            <span className="text-xs font-medium text-text-dark/88">
              {generateAudio
                ? t("node.videoNode.audio.on")
                : t("node.videoNode.audio.off")}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={generateAudio}
              aria-label={t("node.videoNode.audio.title")}
              onClick={() => onChange({ generateAudio: !generateAudio })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                generateAudio
                  ? "border-white/24 bg-white/[0.18]"
                  : "border-white/10 bg-white/[0.08]"
              }`}
            >
              <span
                className={`h-4 w-4 rounded-full bg-text-dark shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform ${
                  generateAudio ? "translate-x-[18px]" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface CameraMovementChipProps {
  templates: ReadonlyArray<CameraMovementPreset>;
  isLoading: boolean;
  selectedId: string | null;
  onChange: (next: string | null) => void;
}

const CAMERA_MOVEMENT_POPOVER_WIDTH = 640;
const CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT = 560;
const CAMERA_MOVEMENT_POPOVER_GAP = 8;

function CameraMovementChip({
  templates,
  isLoading,
  selectedId,
  onChange,
}: CameraMovementChipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Position above the chip whenever it opens or the viewport changes. We
  // render the popover into <body> via portal so it can sit above the
  // react-flow NodeToolbar (z-[120]) — without portal it lives inside the
  // video node's transformed stacking context and gets covered.
  useEffect(() => {
    if (!isOpen) return;
    const updateAnchor = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popHeight = Math.min(
        CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT,
        rect.top - CAMERA_MOVEMENT_POPOVER_GAP - 8,
      );
      const wantTop = rect.top - popHeight - CAMERA_MOVEMENT_POPOVER_GAP;
      // If we can't fit above, fall back to below.
      const top =
        wantTop < 8 ? rect.bottom + CAMERA_MOVEMENT_POPOVER_GAP : wantTop;
      const wantLeft = rect.left;
      const left = Math.max(
        8,
        Math.min(
          wantLeft,
          window.innerWidth - CAMERA_MOVEMENT_POPOVER_WIDTH - 8,
        ),
      );
      setAnchor({ left, top });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  const selectedPreset = findCameraMovementPreset(templates, selectedId);
  const label = selectedPreset?.label ?? "运镜";
  const isActive = Boolean(selectedPreset);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/camera px-1.5 ${isActive ? "text-text-dark" : ""}`}
      >
        <Film className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/camera:text-text-dark`} />
        <span>{label}</span>
      </button>
      {isOpen &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[10000]"
            style={{ left: anchor.left, top: anchor.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <CameraMovementPickerPopover
              templates={templates}
              isLoading={isLoading}
              selectedId={selectedId}
              onConfirm={(nextId) => {
                onChange(nextId);
                setIsOpen(false);
              }}
              onClose={() => setIsOpen(false)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

interface CharacterLibraryChipProps {
  onOpen: () => void;
}

function CharacterLibraryChip({ onOpen }: CharacterLibraryChipProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/character px-1.5`}
    >
      <Users className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/character:text-text-dark`} />
      <span>角色库</span>
    </button>
  );
}

interface CountPickerProps {
  value: VideoGenCount;
  onChange: (next: VideoGenCount) => void;
}

function CountPicker({ value, onChange }: CountPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t("node.videoNode.count.format", { count: value })}</span>
        <ChevronUp className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={NODE_COUNT_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {COUNT_OPTIONS.map((option) => {
            const isActive = option === value;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`${VIDEO_COUNT_OPTION_BASE_CLASS} ${
                  isActive
                    ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                    : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                }`}
              >
                {t("node.videoNode.count.format", { count: option })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type ReferenceMediaItem =
  | {
      kind: "image";
      nodeId: string;
      imageUrl: string;
      displayName?: string | null;
    }
  | {
      kind: "video";
      nodeId: string;
      videoUrl: string;
      thumbUrl?: string | null;
      displayName?: string | null;
    }
  | {
      kind: "audio";
      nodeId: string;
      audioUrl: string;
      displayName?: string | null;
    };

interface ReferenceMediaCapEntry {
  item: ReferenceMediaItem;
  /** 1-based 同类型序号（图片/视频/音频 各自累加），与 chip 角标 + @ 提及对齐。 */
  typeIndex: number;
  /** 是否在当前模式的引用上限内；表里没有的模式默认 true。 */
  withinCap: boolean;
}

interface ReferenceMediaRowProps {
  items: ReadonlyArray<ReferenceMediaCapEntry>;
  /** 当前 genMode 是否在 REFERENCE_CAPS_BY_MODE 表里 —— 只有有 cap 的模式
   *  才把超额 chip 标灰。 */
  enforceCap: boolean;
  /** 当前 genMode；用来决定 firstLastFrame 模式下给前两张图片打 首帧/尾帧 角标。 */
  genMode: VideoGenMode;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
  // 拖动 chip 换位后，回传新的「按可视顺序排列的上游节点 id 列表」。
  onReorder: (orderedNodeIds: string[]) => void;
}

function ReferenceMediaRow({
  items,
  enforceCap,
  genMode,
  onFocus,
  onDetach,
  onReorder,
}: ReferenceMediaRowProps) {
  // 同时管理整行音频的「当前播放节点」—— 同一时间只允许一个 audio chip 在
  // 播放。点击另一个会切换；再点同一个会暂停。
  const [playingAudioNodeId, setPlayingAudioNodeId] = useState<string | null>(
    null,
  );
  // 拖拽换位的临时状态：正在被拖的 chip / 当前悬停落点 chip。
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [overNodeId, setOverNodeId] = useState<string | null>(null);

  const clearDrag = useCallback(() => {
    setDragNodeId(null);
    setOverNodeId(null);
  }, []);

  const handleDrop = useCallback(
    (targetNodeId: string) => {
      const sourceId = dragNodeId;
      clearDrag();
      if (!sourceId || sourceId === targetNodeId) return;
      const ids = items.map((entry) => entry.item.nodeId);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetNodeId);
      if (from === -1 || to === -1) return;
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      onReorder(ids);
    },
    [dragNodeId, items, onReorder, clearDrag],
  );

  return (
    <div className="ml-4 flex shrink-0 items-center gap-1.5">
      {items.map((entry) => {
        const { item, typeIndex, withinCap } = entry;
        // 「超出当前模式上限」只在 REFERENCE_CAPS_BY_MODE 里登记过的模式生效
        // （目前是 allReference / firstLastFrame）；其它模式即便挂了 12 张图，
        // imageReference / firstLastFrame 自己有 slice 兜底，不在 chip 行额
        // 外标记。
        const overCap = enforceCap && !withinCap;
        const modeCap = REFERENCE_CAPS_BY_MODE[genMode]?.[item.kind] ?? 0;
        const modeLabel =
          genMode === "firstLastFrame" ? "首尾帧" : "全能参考";
        const overCapTitle = overCap
          ? `${
              item.kind === "image"
                ? "图片"
                : item.kind === "video"
                  ? "视频"
                  : "音频"
            }引用超出${modeLabel}上限（${modeCap}${
              item.kind === "image" ? "张" : "段"
            }），本次生成不会使用该素材`
          : undefined;
        // 首尾帧模式下，前两张图片打 首帧/尾帧 角标；超出 cap 的图片就回退到
        // 数字角标，让用户看到「这张图被忽略」的同时仍能在 prompt 里通过原序号
        // 对照——不过那种状态主要靠自动切换到 allReference 兜底，正常不会发生。
        const slotLabel =
          genMode === "firstLastFrame" &&
          item.kind === "image" &&
          withinCap
            ? typeIndex === 1
              ? "首帧"
              : typeIndex === 2
                ? "尾帧"
                : undefined
            : undefined;
        let chip: ReactNode;
        if (item.kind === "image") {
          chip = (
            <ReferenceImageChip
              item={item}
              index={typeIndex - 1}
              slotLabel={slotLabel}
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        } else if (item.kind === "video") {
          chip = (
            <ReferenceVideoChip
              item={item}
              index={typeIndex - 1}
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        } else {
          chip = (
            <ReferenceAudioChip
              item={item}
              index={typeIndex - 1}
              isPlaying={playingAudioNodeId === item.nodeId}
              onToggle={(playing) =>
                setPlayingAudioNodeId(playing ? item.nodeId : null)
              }
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        }

        const isDragging = dragNodeId === item.nodeId;
        const isDropTarget =
          overNodeId === item.nodeId && dragNodeId !== null && !isDragging;

        return (
          <div
            key={item.nodeId}
            title={overCapTitle}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.nodeId);
              setDragNodeId(item.nodeId);
            }}
            onDragOver={(event) => {
              if (!dragNodeId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overNodeId !== item.nodeId) setOverNodeId(item.nodeId);
            }}
            onDragLeave={() => {
              setOverNodeId((cur) => (cur === item.nodeId ? null : cur));
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleDrop(item.nodeId);
            }}
            onDragEnd={clearDrag}
            className={`nodrag relative cursor-grab rounded-md transition active:cursor-grabbing ${
              isDragging ? "opacity-40" : ""
            } ${
              isDropTarget
                ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-dark"
                : ""
            } ${
              // omni 上限外的 chip：去饱和 + 半透明 + 琥珀色描边；hover 时通过
              // 父层 title 显示「超出上限不会使用」。配 detach 按钮提示用户主动
              // 移除超额素材。
              overCap
                ? "opacity-50 grayscale ring-1 ring-amber-400/45 ring-offset-1 ring-offset-surface-dark"
                : ""
            }`}
          >
            {chip}
            {overCap && (
              <span className="pointer-events-none absolute -bottom-1 -left-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/90 text-[10px] font-bold leading-none text-surface-dark shadow ring-1 ring-surface-dark">
                !
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useHoverPreviewPos(
  buttonRef: React.RefObject<HTMLElement | null>,
  width: number,
) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const PREVIEW_OFFSET = 10;
  const show = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - width - 8,
        rect.left + rect.width / 2 - width / 2,
      ),
    );
    const top = rect.top - PREVIEW_OFFSET;
    setPos({ left, top });
  }, [buttonRef, width]);
  const hide = useCallback(() => setPos(null), []);
  return { pos, show, hide };
}

interface ReferenceImageChipProps {
  item: Extract<ReferenceMediaItem, { kind: "image" }>;
  index: number;
  /** 给角标显示自定义文案（如「首帧」「尾帧」）。未设置时使用数字角标。 */
  slotLabel?: string;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceImageChip({
  item,
  index,
  slotLabel,
  onFocus,
  onDetach,
}: ReferenceImageChipProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label =
    item.displayName?.trim() || slotLabel || `引用 ${index + 1}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        <img
          src={resolveImageDisplayUrl(item.imageUrl)}
          alt={label}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {slotLabel ? (
          // 首尾帧角标：结构信息（不是序号），保留。前端按产品要求不再显示
          // 「图片N」的数字角标——引用统一呈现为「图片」，序号只存在于提交给
          // 后端的 prompt（@图片N）里，不在引用缩略图上暴露。
          <span
            className="pointer-events-none absolute bottom-1 left-1 z-10 text-[9px] font-medium leading-none text-white"
            style={{ textShadow: "0 0 2px rgba(0,0,0,0.65), 0 1px 1px rgba(0,0,0,0.55)" }}
          >
            {slotLabel}
          </span>
        ) : null}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              <img
                src={resolveImageDisplayUrl(item.imageUrl)}
                alt={label}
                className="block h-auto w-full object-contain"
                draggable={false}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceVideoChipProps {
  item: Extract<ReferenceMediaItem, { kind: "video" }>;
  index: number;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceVideoChip({ item, index, onFocus, onDetach }: ReferenceVideoChipProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label = item.displayName?.trim() || `视频引用 ${index + 1}`;

  // chip 缩略图：有 previewImageUrl 用静态图；否则用一个 muted 静止 <video>
  // 显示首帧。preload=metadata 让 Safari/Chrome 自动定位到首帧。
  const thumb = item.thumbUrl ? (
    <img
      src={resolveImageDisplayUrl(item.thumbUrl)}
      alt={label}
      className="h-full w-full object-cover"
      draggable={false}
    />
  ) : (
    <video
      src={resolveImageDisplayUrl(item.videoUrl)}
      className="h-full w-full object-cover"
      muted
      playsInline
      preload="metadata"
      draggable={false}
    />
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        {thumb}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              {/* hover 时 autoplay + loop + muted —— 不弹声音不打扰其它正在
                  播放的 audio chip。 */}
              <video
                src={resolveImageDisplayUrl(item.videoUrl)}
                autoPlay
                loop
                muted
                playsInline
                className="block h-auto w-full object-contain"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceAudioChipProps {
  item: Extract<ReferenceMediaItem, { kind: "audio" }>;
  index: number;
  isPlaying: boolean;
  onToggle: (playing: boolean) => void;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceAudioChip({
  item,
  index,
  isPlaying,
  onToggle,
  onFocus,
  onDetach,
}: ReferenceAudioChipProps) {
  // 用 ref 持有一个 HTMLAudioElement —— 比挂在 DOM 上的 <audio> 简单：可以
  // 直接 .play()/.pause()，也方便处理同时只放一个的逻辑（父层告诉这个
  // chip 它不再是当前正在播的）。
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null && typeof Audio !== "undefined") {
    audioRef.current = new Audio();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const src = resolveImageDisplayUrl(item.audioUrl);
    if (audio.src !== src) {
      audio.src = src;
    }
  }, [item.audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      void audio.play().catch(() => {
        // 自动播放被浏览器拦或资源加载失败 —— 回滚父层状态。
        onToggle(false);
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, onToggle]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleEnded = () => onToggle(false);
    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, [onToggle]);

  // 卸载时停掉播放，避免脏状态留在浏览器。
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.src = "";
    };
  }, []);

  const label = item.displayName?.trim() || `音频引用 ${index + 1}`;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        // 单击：切换播放；同时把焦点切到上游节点（方便用户跳过去看）。
        onFocus(item.nodeId);
        onToggle(!isPlaying);
      }}
      className={`group/refmedia nodrag relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border transition-colors ${
        isPlaying
          ? "border-accent/60 bg-[rgb(var(--accent-rgb)/0.15)]"
          : "border-white/10 bg-white/[0.04] hover:border-white/30"
      }`}
      title={label}
    >
      {isPlaying ? (
        <Pause className="h-4 w-4 text-accent" />
      ) : (
        <Music className="h-4 w-4 text-text-dark/90" />
      )}
      <ReferenceDetachButton
        nodeId={item.nodeId}
        onDetach={onDetach}
        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
      />
    </button>
  );
}

// --- custom video player controls ------------------------------------------ //
//
// 替代 <video controls>：libtv 风格的浮层（底部一条）。订阅原生 <video>
// 的 play/pause/timeupdate/durationchange/volumechange，写回时直接操作元素，
// 由事件驱动 state 单向同步。隐藏时机：默认显示 0.85 透明度 + hover 加深，
// 不做自动隐藏，避免画布上看不到「这个视频还能控制」。

interface VideoPlayerControlsProps {
  videoEl: HTMLVideoElement | null;
  isCapturingFrame: boolean;
  onCapture: (mode: "first" | "last" | "current") => void;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoPlayerControls({
  videoEl,
  isCapturingFrame,
  onCapture,
}: VideoPlayerControlsProps) {
  const { t } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isHoveringFrame, setIsHoveringFrame] = useState(false);

  useEffect(() => {
    if (!videoEl) return;
    const syncAll = () => {
      setIsPlaying(!videoEl.paused);
      setCurrentTime(videoEl.currentTime);
      setDuration(Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
      setIsMuted(videoEl.muted);
    };
    syncAll();
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onTime = () => setCurrentTime(videoEl.currentTime);
    const onDur = () => {
      setDuration(Number.isFinite(videoEl.duration) ? videoEl.duration : 0);
    };
    const onVol = () => setIsMuted(videoEl.muted);
    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("durationchange", onDur);
    videoEl.addEventListener("loadedmetadata", onDur);
    videoEl.addEventListener("volumechange", onVol);
    return () => {
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("durationchange", onDur);
      videoEl.removeEventListener("loadedmetadata", onDur);
      videoEl.removeEventListener("volumechange", onVol);
    };
  }, [videoEl]);

  const togglePlay = useCallback(() => {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play().catch(() => undefined);
    } else {
      videoEl.pause();
    }
  }, [videoEl]);

  const toggleMute = useCallback(() => {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
  }, [videoEl]);

  const onSeek = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!videoEl) return;
      const next = Number(event.target.value);
      if (!Number.isFinite(next)) return;
      videoEl.currentTime = next;
      setCurrentTime(next);
    },
    [videoEl],
  );

  // 进度百分比（用作 range 背景的渐变锚点）。
  const progressPct =
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const sliderBg = `linear-gradient(to right, rgb(var(--accent-rgb)) 0%, rgb(var(--accent-rgb)) ${progressPct}%, rgba(255,255,255,0.18) ${progressPct}%, rgba(255,255,255,0.18) 100%)`;

  return (
    <div className="nodrag absolute inset-x-0 bottom-0 z-20 flex items-center gap-2.5 bg-gradient-to-t from-black/75 via-black/45 to-transparent px-3 pb-2 pt-6 text-text-dark">
      <button
        type="button"
        onClick={(event) => {
          // 唯一的播放/暂停入口:阻止冒泡,避免点它时把节点也选中。
          event.stopPropagation();
          togglePlay();
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dark/90 transition-colors hover:bg-white/[0.12] hover:text-text-dark"
        title={
          isPlaying
            ? t("node.videoNode.player.pause", { defaultValue: "暂停" })
            : t("node.videoNode.player.play", { defaultValue: "播放" })
        }
      >
        {isPlaying ? (
          <Pause className="h-4 w-4" />
        ) : (
          <Play className="h-4 w-4" fill="currentColor" />
        )}
      </button>

      <span className="shrink-0 text-[11px] tabular-nums text-text-dark/85">
        {formatTime(currentTime)}
      </span>

      <input
        type="range"
        min={0}
        max={duration > 0 ? duration : 0}
        step={0.05}
        value={currentTime}
        onChange={onSeek}
        onMouseDown={(event) => event.stopPropagation()}
        className="video-player-scrubber h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full"
        style={{ background: sliderBg }}
      />

      <span className="shrink-0 text-[11px] tabular-nums text-text-dark/85">
        {formatTime(duration)}
      </span>

      <button
        type="button"
        onClick={toggleMute}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-dark/90 transition-colors hover:bg-white/[0.12] hover:text-text-dark"
        title={
          isMuted
            ? t("node.videoNode.player.unmute", { defaultValue: "取消静音" })
            : t("node.videoNode.player.mute", { defaultValue: "静音" })
        }
      >
        {isMuted ? (
          <VolumeX className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>

      <div
        className="relative shrink-0"
        onMouseEnter={() => setIsHoveringFrame(true)}
        onMouseLeave={() => setIsHoveringFrame(false)}
      >
        <button
          type="button"
          disabled={isCapturingFrame}
          onClick={() => onCapture("current")}
          title={t("node.videoNode.frame.captureCurrent")}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
            isCapturingFrame
              ? "cursor-not-allowed text-text-muted/60"
              : "text-text-dark/90 hover:bg-white/[0.12] hover:text-text-dark"
          }`}
        >
          {isCapturingFrame ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
        </button>

        {isHoveringFrame && !isCapturingFrame && (
          <div className="absolute bottom-full right-0 flex flex-col gap-1 rounded-lg border border-white/10 bg-surface-dark/95 p-1 text-xs shadow-2xl backdrop-blur-md">
            <button
              type="button"
              onClick={() => onCapture("first")}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-text-dark transition-colors hover:bg-white/[0.08]"
            >
              {t("node.videoNode.frame.captureFirst")}
            </button>
            <button
              type="button"
              onClick={() => onCapture("last")}
              className="whitespace-nowrap rounded-md px-3 py-1.5 text-left text-text-dark transition-colors hover:bg-white/[0.08]"
            >
              {t("node.videoNode.frame.captureLast")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- subtitle erase: box overlay ------------------------------------------- //

interface DisplayedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SubtitleEraseBoxOverlayProps {
  box: { x: number; y: number; width: number; height: number } | null;
  drag: { x0: number; y0: number; x1: number; y1: number } | null;
  disabled: boolean;
  getDisplayedRect: (containerW: number, containerH: number) => DisplayedRect;
  onDragStart: (start: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }) => void;
  onDragMove: (next: { x1: number; y1: number }) => void;
  onDragEnd: (
    final: { x: number; y: number; width: number; height: number } | null,
  ) => void;
}

function SubtitleEraseBoxOverlay({
  box,
  drag,
  disabled,
  getDisplayedRect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: SubtitleEraseBoxOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const displayed = getDisplayedRect(containerSize.w, containerSize.h);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { nx: 0, ny: 0 };
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left - displayed.left;
      const localY = clientY - rect.top - displayed.top;
      const nx = displayed.width > 0 ? localX / displayed.width : 0;
      const ny = displayed.height > 0 ? localY / displayed.height : 0;
      return {
        nx: Math.max(0, Math.min(1, nx)),
        ny: Math.max(0, Math.min(1, ny)),
      };
    },
    [displayed.height, displayed.left, displayed.top, displayed.width],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragStart({ x0: nx, y0: ny, x1: nx, y1: ny });
    },
    [disabled, onDragStart, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragMove({ x1: nx, y1: ny });
    },
    [disabled, drag, onDragMove, toNormalized],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer may not have been captured
      }
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const width = Math.abs(drag.x1 - drag.x0);
      const height = Math.abs(drag.y1 - drag.y0);
      if (width < 0.01 || height < 0.01) {
        onDragEnd(null);
        return;
      }
      onDragEnd({ x, y, width, height });
    },
    [disabled, drag, onDragEnd],
  );

  const effective = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : box;

  return (
    <div
      ref={containerRef}
      className="nodrag absolute inset-0 z-30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(event) => event.stopPropagation()}
      style={{ cursor: disabled ? "not-allowed" : "crosshair" }}
    >
      {effective && effective.width > 0 && effective.height > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.15)]"
          style={{
            left: displayed.left + effective.x * displayed.width,
            top: displayed.top + effective.y * displayed.height,
            width: effective.width * displayed.width,
            height: effective.height * displayed.height,
          }}
        />
      )}
    </div>
  );
}

// --- subtitle erase: ops panel --------------------------------------------- //

interface SubtitleEraseOpsPanelProps {
  mode: "smart" | "box";
  isErasing: boolean;
  hasBox: boolean;
  onExit: () => void;
  onResetBox: () => void;
  onSubmit: () => void;
}

function SubtitleEraseOpsPanel({
  mode,
  isErasing,
  hasBox,
  onExit,
  onResetBox,
  onSubmit,
}: SubtitleEraseOpsPanelProps) {
  const { t } = useTranslation();
  const submitDisabled = isErasing || (mode === "box" && !hasBox);
  const labelKey =
    mode === "box"
      ? "nodeToolbar.video.subtitleRemovalBox"
      : "nodeToolbar.video.subtitleRemovalSmart";
  const icon =
    mode === "box" ? (
      <Square className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    ) : (
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    );

  return (
    <div className={`flex min-w-[420px] max-w-[calc(100vw-32px)] items-center gap-2 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}>
      <button
        type="button"
        onClick={onExit}
        title={t("node.videoNode.subtitleErase.exit")}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
      >
        <XIcon className="h-4 w-4" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark">
        {icon}
        <span className="truncate font-medium">{t(labelKey)}</span>
      </div>

      {mode === "box" && (
        <button
          type="button"
          onClick={onResetBox}
          title={t("node.videoNode.subtitleErase.tools.reset")}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded px-1 text-text-dark/72 transition-colors hover:text-text-dark"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
      )}

      <CreditCostPill
        display="0"
        disabled={submitDisabled}
        className={NODE_CREDIT_PILL_FLAT_CLASS}
      />

      <button
        type="button"
        disabled={submitDisabled}
        onClick={onSubmit}
        title={t("node.videoNode.subtitleErase.submit")}
        className={`${NODE_GENERATE_BUTTON_BASE_CLASS} shrink-0 ${
          submitDisabled
            ? NODE_GENERATE_BUTTON_DISABLED_CLASS
            : NODE_GENERATE_BUTTON_ENABLED_CLASS
        }`}
      >
        {isErasing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
