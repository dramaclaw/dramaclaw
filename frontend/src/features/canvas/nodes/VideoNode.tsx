// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import {
  isLowDetailZoom,
  setNodeMediaActive,
} from "@/features/canvas/application/canvasLod";
import {
  AlertTriangle,
  ArrowUp,
  Camera,
  ChevronDown,
  Download,
  Film,
  Images,
  Layers,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Upload as UploadIcon,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X as XIcon,
  type LucideIcon,
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
  audioReferenceDurationRejection,
  audioReferenceTotalDurationLimitMs,
  formatAudioDurationClips,
  formatAudioDurationSeconds,
  MAX_AUDIO_REFERENCE_DURATION_MS,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  MIN_AUDIO_REFERENCE_DURATION_MS,
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  resolveVideoKeyframeUrls,
  videoEmptyStateCtaModes,
  videoModeRequiresPrompt,
  videoModelReferenceDisabledReason,
  videoMultiImageAutoSwitchMode,
  videoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
  type VideoEmptyStateCtaMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import {
  VIDEO_GENERATION_ASPECT_RATIOS,
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";
import {
  captureVideoFrameBlob,
  getLodStill,
  requestLodStill,
  subscribeLodStills,
} from "@/features/canvas/application/videoFrameCapture";
import {
  FALLBACK_VIDEO_ASPECT_OPTIONS,
  FALLBACK_VIDEO_RESOLUTION_OPTIONS,
} from "@/features/canvas/domain/mediaModelOptions";
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
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useNodeGenerationTaskState } from "@/features/canvas/application/useNodeGenerationTaskState";
import {
  resolveErrorContent,
  showErrorDialog,
  notifyTaskStillRunning,
} from "@/features/canvas/application/errorDialog";
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { resolveGenerationErrorDiagnostics } from "@/features/canvas/application/generationErrorReport";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import { NodeResizeHandle } from "@/features/canvas/ui/NodeResizeHandle";
import { NODE_OPS_PANEL_ENTER_CLASS } from "@/features/canvas/ui/OperationPanelShell";
import { NodeGenerationOverlay } from "@/features/canvas/ui/NodeGenerationOverlay";
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
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
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from "@/features/canvas/ui/NodeSideActionRail";
import { VideoClipPanel } from "@/features/canvas/nodes/VideoClipPanel";
import {
  CAMERA_MOVEMENT_PRESETS,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { useFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { useCanvasStore, useIsBoxSelecting } from "@/stores/canvasStore";
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoCompose,
  submitFreezoneVideoErase,
  submitFreezoneVideoEdit,
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
import {
  awaitTaskCompletion,
  isTaskCancelledError,
  isTaskPollTimeoutError,
} from "@/api/tasks";
import { generationTaskDescriptor } from "@/features/canvas/application/resumeGeneration";
import { useNodeGenerationHistory } from "@/features/canvas/hooks/useNodeGenerationHistory";
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";
import { readUrl } from "@/lib/url-params";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { CreditCostPill } from "@/components/credits/credit-visual";
import { VideoOperationsPanel } from "@/features/canvas/nodes/VideoOperationsPanel";

type VideoNodeProps = NodeProps & {
  id: string;
  data: VideoNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 580;
export const DEFAULT_HEIGHT = 380;
/**
 * 视频生成的计费 feature key。主体（错误态重试的计费探针）与操作面板（估价
 * 展示 + 提交置灰）共用，必须同一口径——放主体导出、面板 import。
 */
export const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

const MIN_WIDTH = 480;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1000;

// 图片节点的默认落位尺寸（与 ImageGenNode 的 DEFAULT_WIDTH/HEIGHT 对齐）。
// 「全能参考 / 图片参考」会在视频节点左侧新建一个图片节点，排版要按它的真实尺寸算。
const IMAGE_GEN_NODE_WIDTH = 580;
const IMAGE_GEN_NODE_HEIGHT = 360;

export const OPERATIONS_PANEL_HEIGHT = 280;
export const OPERATIONS_PANEL_GAP = 12;
// Extend the ops panel beyond the node's left/right edges so the textarea +
// chips have more room than the video frame itself.
export const OPERATIONS_PANEL_OVERHANG = 120;

// 空态 CTA 的图标 + 文案：具体展示哪几个模式由 `videoEmptyStateCtaModes(modelId)`
// 按模型能力决定（见 shared/videoModelCapabilities.ts），这里只负责「模式 → 外观」。
const VIDEO_EMPTY_STATE_CTA_META: Record<
  VideoEmptyStateCtaMode,
  { Icon: LucideIcon; label: string }
> = {
  allReference: { Icon: Sparkles, label: "全能参考" },
  imageReference: { Icon: Images, label: "图片参考" },
  firstFrame: { Icon: Film, label: "首帧生成视频" },
  imageToVideo: { Icon: Film, label: "图生视频" },
  firstLastFrame: { Icon: Layers, label: "首尾帧生成视频" },
};

// 各 genMode 对上游引用数量的硬上限。UI 用这张表把后端字段约束（多图 / 多模态
// 场景下）显式表达出来：超额 chip 标灰 + 从 @ 候选剔除，避免「prompt 引用了
// @图片10 但提交时被静默丢掉」。
//
// 表里没出现的模式默认不限制（textToVideo 不消费上游），走原有路径。
//   - allReference (omni)  ：image 1-9 / video 0-3 / audio 0-3。音频另有两条厂商时长
//                            约束——**逐条** 1.8~15.2s 和**总和** ≤15.2s（后台可配
//                            referenceAudioTotalMaxSeconds）——都在提交前单独校验，
//                            见 audioReferenceDurationRejection。时长口径不进这张表：
//                            这里只表达条数。
//   - firstLastFrame       ：仅图片 2 张（首帧 + 尾帧），不允许任何视频 / 音频。
//                            图片 >2 时另有自动切到 allReference 的兜底（见
//                            VideoNode 内部 effect）。
//   - firstFrame / imageToVideo：都只接 1 张图；前者锁定首帧，后者作为整体画面参考。
const REFERENCE_CAPS_BY_MODE: Partial<
  Record<VideoGenMode, { image: number; video: number; audio: number }>
> = {
  firstFrame: { image: 1, video: 0, audio: 0 },
  imageToVideo: { image: 1, video: 0, audio: 0 },
  imageReference: { image: 9, video: 0, audio: 0 },
  videoEdit: { image: 5, video: 1, audio: 0 },
  allReference: { image: 9, video: 3, audio: 3 },
  firstLastFrame: { image: 2, video: 0, audio: 0 },
};

// 后台「媒体模型」未给该模型配置比例 / 分辨率时的兜底档位。正常路径下这两项
// 都来自目录条目的 ratioOptions / resolutionOptions。
export const ASPECT_RATIOS: ReadonlyArray<FreezoneVideoAspectRatio> =
  FALLBACK_VIDEO_ASPECT_OPTIONS;
const QUALITIES: ReadonlyArray<VideoGenQuality> = FALLBACK_VIDEO_RESOLUTION_OPTIONS;
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;

export function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q;
}

function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? []).map((item) => item.trim()).filter(Boolean);
  return options.length > 0 ? options : QUALITIES;
}

function normalizeVideoQuality(
  value: VideoGenQuality | undefined,
  options: readonly VideoGenQuality[],
): VideoGenQuality {
  const configured = value
    ? options.find((option) => option.toLowerCase() === value.toLowerCase())
    : undefined;
  const fallback =
    options.find((option) => option.toLowerCase() === "720p") ?? options[0] ?? "720p";
  return configured ?? fallback;
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

export function clampVideoDuration(value: number, bounds: { min: number; max: number }): number {
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

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

// 模型能力判定（isHappyHorseVideoModel / isSeedance1xVideoModel /
// isSeedance2VideoModel / isGrokVideoChannelModel / isVideoModeSupportedByModel）
// 统一收敛到 nodes/shared/videoModelCapabilities.ts，作为 CTA / tab / 提交校验的
// 单一事实来源；这里仅额外叠加媒体目录声明的逐模式素材上限。

function selectedVideoModelReferenceDisabledReason(
  model: ModelOption | null | undefined,
  counts: { images: number; videos: number; audios: number },
  mode: VideoGenMode,
): string | null {
  const capabilityReason = videoModelReferenceDisabledReason(model, counts);
  if (capabilityReason) return capabilityReason;
  const caps = referenceCapsForMode(model, mode);
  if (!caps) return null;
  if (counts.images > caps.image) {
    return `该模型最多支持 ${caps.image} 张图片素材`;
  }
  if (counts.videos > caps.video) {
    return caps.video === 0
      ? "该模型不支持视频素材"
      : `该模型最多支持 ${caps.video} 个视频素材`;
  }
  if (counts.audios > caps.audio) {
    return caps.audio === 0
      ? "该模型不支持音频素材"
      : `该模型最多支持 ${caps.audio} 个音频素材`;
  }
  return null;
}

// 首帧与单图图生视频的 1 张图是**结构性**的，不是模型容量。
// 所以这条不接受媒体目录 referenceImageMax 的覆盖——那个字段表达的是「这个模型最多
// 能吃几张参考图」，管的是参考类模式；让它盖住这里等于允许配置把首帧悄悄变成参考。
const FIXED_IMAGE_CAP_BY_MODE: Partial<Record<VideoGenMode, number>> = {
  firstFrame: 1,
  imageToVideo: 1,
};

function referenceCapsForMode(
  model: ModelOption | null | undefined,
  mode: VideoGenMode,
): { image: number; video: number; audio: number } | null {
  const defaults = REFERENCE_CAPS_BY_MODE[mode];
  if (!defaults) return null;
  return {
    image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image,
    video: model?.referenceVideoMax ?? defaults.video,
    audio: model?.referenceAudioMax ?? defaults.audio,
  };
}

function hasConfiguredReferenceCaps(model: ModelOption | null | undefined): boolean {
  return (
    model?.referenceImageMax != null ||
    model?.referenceVideoMax != null ||
    model?.referenceAudioMax != null
  );
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

// 上游「视频引用」：视频节点自带 videoUrl，但从资产库选入的视频是 upload 节点，
// 地址同样写在 data.videoUrl。所以「是不是视频上游」应按「存在非空 data.videoUrl」
// 判定，而非节点类型——否则资产库视频会被漏认（HappyHorse 不自动切 videoEdit、
// 提交找不到 videoUrl），还会被 referenceImageUrl / isUploadNode 误当图片。
function referenceVideoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  const url = (node.data as { videoUrl?: unknown }).videoUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
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
    const addEdgeWithData = useCanvasStore((state) => state.addEdgeWithData);
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

    // 低缩放档：选择器返回 boolean，只在跨过阈值那一次触发重渲染；平移中
    // transform[0]/[1] 每帧都变，但这里的返回值不变，所以不会每帧重渲染。
    const lowDetailZoom = useStore((state) => isLowDetailZoom(state.transform[2]));
    // 正在播放时不降级——用户主动播了就说明他在看，缩放小也别把播放器抽走。
    const isVideoPlayingRef = useRef(false);
    // 卸载时清掉模块级播放标记：视口裁剪把播放中的节点卸掉时 <video> 不会派发
    // pause 事件，不清会留下陈旧的「播放中」豁免，该节点从此不再降级。
    useEffect(() => () => setNodeMediaActive(id, false), [id]);
    const transientUrlRef = useRef<string | null>(null);
    const [transientPreviewUrl, setTransientPreviewUrl] = useState<
      string | null
    >(null);
    const [isCapturingFrame, setIsCapturingFrame] = useState(false);
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
    const genMode: VideoGenMode = data.genMode ?? "textToVideo";
    // Billing and submission must inspect the same one-hop inputs. Keeping the
    // subscription here also lets the displayed quote react when a source
    // video's browser-probed duration becomes available.
    const upstreamNodes = useUpstreamNodes(id);
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
    const modelId = selectedVideoModel?.id ?? "";
    const selectedVideoModelId = selectedVideoModel?.apiModel ?? selectedVideoModel?.id ?? modelId;
    const isHappyHorseModel = isHappyHorseVideoModel(selectedVideoModelId);
    const configuredAspectRatios = useMemo(
      () => (selectedVideoModel?.ratioOptions ?? []).map((ratio) => ratio.trim()).filter(Boolean),
      [selectedVideoModel],
    );
    const hasConfiguredAspectRatios = configuredAspectRatios.length > 0;
    const aspectRatio: FreezoneVideoAspectRatio = hasConfiguredAspectRatios
      ? configuredAspectRatios.includes(String(data.aspectRatio))
        ? String(data.aspectRatio)
        : configuredAspectRatios[0]
      : (ASPECT_RATIOS as readonly string[]).includes(String(data.aspectRatio))
        ? String(data.aspectRatio)
        : snapToAllowedAspectRatio(
            String(data.aspectRatio ?? ""),
            VIDEO_GENERATION_ASPECT_RATIOS,
            "16:9",
          );
    // Admin 配置存在时原样提交模型声明的比例；未配置时保留旧版 auto 推导逻辑。
    const submitAspectRatio: FreezoneVideoAspectRatio =
      !hasConfiguredAspectRatios && aspectRatio === "auto"
        ? snapToAllowedAspectRatio(
            typeof data.widthPx === "number" &&
              typeof data.heightPx === "number" &&
              data.widthPx > 0 &&
              data.heightPx > 0
              ? `${data.widthPx}:${data.heightPx}`
              : "",
            VIDEO_GENERATION_ASPECT_RATIOS,
            "16:9",
          )
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
    // 家族判定必须喂 `selectedVideoModelId`(apiModel ?? id)，**不能用 `modelId`**：
    // `modelId` 是 `selectedVideoModel.id`，在 EE 里是 media_model_catalog 的 ULID
    // 主键（如 `01KZ58VSE52RFFDASY2T9SY4NC`），根本不含模型名，判定恒为 false ——
    // 选了 Seedance 2.0 也会被「全能参考仅支持 Seedance 2.0」挡下，视频/音频上游
    // 也不再自动切模式。CE 兜底列表恰好 id === apiModel，所以这个坑只在 EE 显形。
    const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);
    const supportsAllReference = isVideoModeSupportedByModel(
      "allReference",
      selectedVideoModel,
    );
    const supportsHumanReview = selectedVideoModel?.humanReview === true;
    const humanReview = Boolean(data.humanReview);
    const count: VideoGenCount = (data.count ?? 1) as VideoGenCount;
    const videoInputBilling = useMemo(() => {
      if (genMode !== "allReference" && genMode !== "videoEdit") {
        return { present: false, ready: true, durationSeconds: 0 };
      }
      const ordered = sortUpstreamByReferenceOrder(
        upstreamNodes,
        data.referenceOrder,
      ).filter((node) => Boolean(referenceVideoUrl(node)));
      const limit =
        genMode === "videoEdit"
          ? 1
          : (selectedVideoModel?.referenceVideoMax ?? 3);
      const videos = ordered.slice(0, Math.max(limit, 0));
      if (videos.length === 0) {
        return { present: false, ready: true, durationSeconds: 0 };
      }
      const durations = videos.map((node) =>
        typeof node.data.durationMs === "number" && node.data.durationMs > 0
          ? node.data.durationMs
          : null,
      );
      const ready = durations.every((duration) => duration != null);
      return {
        present: true,
        ready,
        durationSeconds: ready
          ? durations.reduce((sum, duration) => sum + (duration ?? 0), 0) / 1000
          : 0,
      };
    }, [data.referenceOrder, genMode, selectedVideoModel, upstreamNodes]);
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
    // 节点被连线（存在入边）后：隐藏「试试」CTA，只在节点中间显示一个图标（对齐 libtv）。
    const isConnected = useCanvasStore((state) =>
      state.edges.some((edge) => edge.target === id)
    );
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
        const videoUrl = referenceVideoUrl(node);
        if (videoUrl) {
          const vdata = node.data as {
            previewImageUrl?: string | null;
            displayName?: string | null;
          };
          const thumbUrl =
            typeof vdata.previewImageUrl === "string" &&
            vdata.previewImageUrl.length > 0
              ? vdata.previewImageUrl
              : null;
          items.push({
            kind: "video",
            nodeId: node.id,
            videoUrl,
            thumbUrl,
            displayName: vdata.displayName ?? null,
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

    const referenceCaps = useMemo(
      () => referenceCapsForMode(selectedVideoModel, genMode),
      [genMode, selectedVideoModel],
    );

    // 通用上游遍历：拿到所有上游节点的 text/imageUrl/videoUrl/audioUrl 统一视图。
    // 视频生成只用其中的 text 字段拼接到 prompt 前面；image/video/audio 仍走
    // 各自分支已有的分类逻辑（带 backend 上限校验）。
    const upstreamContents = useMemo(
      () => upstreamNodes.map(extractUpstreamContent),
      [upstreamNodes],
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
        if (referenceVideoUrl(node)) {
          // 视频节点或携带 videoUrl 的 upload 节点（资产库选入的视频）都算视频。
          videos += 1;
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
    // HappyHorse 的模式可用性由「上游节点类型」决定，而非素材是否已填。空的图片
    // 节点（尚未生成/上传图）也应让「首帧 / 图片参考」可选——用户先连节点、后填图
    // 是正常顺序。所以这里按节点类型统计，区别于 upstreamCounts 的「已解析 URL」口径。
    const upstreamTypeCounts = useMemo(() => {
      let images = 0;
      let videos = 0;
      let audios = 0;
      for (const node of upstreamNodes) {
        // 携带 videoUrl 的 upload 节点（资产库视频）先判为视频，避免落到下面
        // 的 isUploadNode 分支被误算成图片。空的 video 节点（尚未生成）仍按类型算视频。
        if (isVideoNode(node) || referenceVideoUrl(node)) {
          videos += 1;
        } else if (isAudioNode(node)) {
          audios += 1;
        } else if (
          isImageGenNode(node) ||
          isUploadNode(node) ||
          isImageEditNode(node) ||
          isExportImageNode(node) ||
          isStoryboardGenNode(node)
        ) {
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

    // Spawn the source node(s) to the left of this video node and wire them as
    // inputs. Used by the empty-state 全能参考 / 图片参考 / 首尾帧 CTAs.
    // 全能参考 / 图片参考走图片节点（可上传也可直接生图）+ 对应参考模式；
    // 首尾帧走两个上传节点 + firstLastFrame 关键帧。
    const spawnFrameUploads = useCallback(
      (
        mode:
          | "allReference"
          | "imageReference"
          | "firstFrame"
          | "imageToVideo"
          | "firstLastFrame",
      ) => {
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        if (!self) return;
        // 垂直居中要按视频节点的真实高度算，优先用测量值，未测量时回退设定高度/默认值。
        const selfHeight =
          self.measured?.height ??
          (typeof self.height === "number" ? self.height : DEFAULT_HEIGHT);
        // 全能参考 / 图片参考 / 首帧生成视频都只铺一个图片节点；首尾帧要铺首帧 + 尾帧
        // 两个上传节点。
        const isSingleImage =
          mode === "allReference" ||
          mode === "imageReference" ||
          mode === "firstFrame" ||
          mode === "imageToVideo";
        // 两种源节点的默认尺寸不同（图片节点 580×360 / 上传节点 320×350），
        // 左列的定位与避让都得按实际尺寸算，否则图片节点会压到视频节点身上。
        const FRAME_WIDTH = isSingleImage ? IMAGE_GEN_NODE_WIDTH : 320;
        const FRAME_HEIGHT = isSingleImage ? IMAGE_GEN_NODE_HEIGHT : 350;
        const GAP_X = 40;
        const GAP_Y = 24;
        const baseX = self.position.x - FRAME_WIDTH - GAP_X;
        const stepY = FRAME_HEIGHT + GAP_Y;
        const nodeSize = (node: CanvasNode) => ({
          width:
            node.measured?.width ??
            (typeof node.width === "number" ? node.width : FRAME_WIDTH),
          height:
            node.measured?.height ??
            (typeof node.height === "number" ? node.height : FRAME_HEIGHT),
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
          if (
            node.type !== CANVAS_NODE_TYPES.upload &&
            node.type !== CANVAS_NODE_TYPES.imageGen
          ) {
            return false;
          }
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
            const candidate = { x: baseX, y, width: FRAME_WIDTH, height: FRAME_HEIGHT };
            if (!occupiedRects.some((rect) => overlaps(candidate, rect))) {
              occupiedRects.push(candidate);
              return y;
            }
            y += stepY;
          }
          occupiedRects.push({ x: baseX, y, width: FRAME_WIDTH, height: FRAME_HEIGHT });
          return y;
        };
        if (isSingleImage) {
          // 直接按视频高度垂直居中，不做向下避让。resolveAvailableY 只会向下顶，
          // 左侧空间一旦被别的节点占用就把参考图挤下一行、破坏与视频的对齐（正是
          // 「全能参考 vs 图片参考」对不齐的成因）。这里优先保证对齐：参考图恒在视频
          // 左侧（有 GAP_X 间隔）不会压到视频本身；万一撞上左侧的无关节点，宁可让
          // 用户手动挪开，也不牺牲与视频的对齐。
          const baseY = self.position.y + (selfHeight - FRAME_HEIGHT) / 2;
          const newId = addNode(
            CANVAS_NODE_TYPES.imageGen,
            { x: baseX, y: baseY },
            {
              displayName: mode === "firstFrame" ? "首帧" : "参考图",
            },
          );
          if (mode === "firstFrame") {
            addEdgeWithData(newId, id, { keyframeSlot: "first" });
          } else {
            addEdge(newId, id);
          }
          const groupLabel =
            mode === "imageReference"
              ? "图片参考组"
              : mode === "firstFrame"
                ? "首帧生成视频组"
                : mode === "imageToVideo"
                  ? "图生视频组"
                : "全能参考组";
          state.autoGroupSpawn(id, [newId], { label: groupLabel });
          // 上游图片直接作为素材喂给对应端点；模式切到用户点的那一个，不预填提示词
          // （尊重用户已写内容）。HappyHorse 下由统一状态机确认（imageToVideo /
          // imageReference 都与「1 张上游图」匹配，不会被改写）；非 HappyHorse 下
          // data.genMode 一旦非空，默认推断 effect 就不再覆盖它。
          updateNodeData(id, { genMode: mode });
          return;
        }
        const totalH = FRAME_HEIGHT * 2 + GAP_Y;
        const startY = self.position.y + (selfHeight - totalH) / 2;
        const firstY = resolveAvailableY(startY);
        const lastY = resolveAvailableY(firstY + stepY);
        const firstId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y: firstY },
          { displayName: "首帧" },
        );
        addEdgeWithData(firstId, id, { keyframeSlot: "first" });
        const lastId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y: lastY },
          { displayName: "尾帧" },
        );
        addEdgeWithData(lastId, id, { keyframeSlot: "last" });
        state.autoGroupSpawn(id, [firstId, lastId], { label: '首尾帧生成视频组' });
        updateNodeData(id, { genMode: "firstLastFrame" });
      },
      [addEdge, addEdgeWithData, addNode, id, updateNodeData],
    );

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
    // video actually consumes it. 默认模式按模型能力选（videoUpstreamImageDefaultMode）：
    // Seedance 2.0 → 全能参考（1-9 图的通用入口，首尾帧仍可经空态 CTA 进入）；
    // Seedance 1.x → 首帧（1.x 不支持全能参考，默认推成它会让提交必 400）。
    // 仅在 data.genMode 未定义时兜底——用户一旦选过任何 tab 就尊重其选择。
    // HappyHorse 走下面的统一状态机，不参与这条默认。
    useEffect(() => {
      if (isHappyHorseModel) return;
      if (data.genMode != null) return;
      if (referenceImages.length === 0) return;
      const defaultMode = videoUpstreamImageDefaultMode(selectedVideoModel);
      if (defaultMode) updateNodeData(id, { genMode: defaultMode });
    }, [
      data.genMode,
      id,
      isHappyHorseModel,
      referenceImages.length,
      selectedVideoModel,
      updateNodeData,
    ]);

    // HappyHorse 的模式完全由上游节点类型决定（文档的 4 大功能一一对应），这里用
    // 一条统一状态机替代分散的兜底 effect，避免多个 effect 互相打架：
    //   - 上游有视频            → 视频编辑 (videoEdit / video_url)
    //   - 上游图片 >1 张        → 图片参考 (imageReference / reference_images 1-9)
    //   - 上游图片 == 1 张      → 按目录能力选择单图默认入口，并尊重用户主动选择的
    //                             首帧 / 图生视频 / 图片参考
    //   - 无上游                → 文生视频 (textToVideo)
    // 每次都纠正，确保 genMode 不会卡在与当前上游不匹配的模式（否则 submit 时会被
    // 静默截断 / 触发上游互斥报错）。
    useEffect(() => {
      if (!isHappyHorseModel) return;
      const { images, videos } = upstreamTypeCounts;
      let target: VideoGenMode;
      if (videos > 0) {
        target = "videoEdit";
      } else if (images > 1) {
        target = "imageReference";
      } else if (images === 1) {
        const currentImageMode = ["firstFrame", "imageToVideo", "imageReference"].includes(
          genMode,
        )
          ? genMode
          : null;
        target =
          currentImageMode && isVideoModeSupportedByModel(currentImageMode, selectedVideoModel)
            ? currentImageMode
            : (videoUpstreamImageDefaultMode(selectedVideoModel) ?? "textToVideo");
      } else {
        target = "textToVideo";
      }
      if (genMode !== target) {
        updateNodeData(id, { genMode: target });
      }
    }, [
      genMode,
      id,
      isHappyHorseModel,
      selectedVideoModel,
      upstreamTypeCounts.images,
      upstreamTypeCounts.videos,
      updateNodeData,
    ]);

    // Audio refs only carry meaning under the omni-gen (allReference) path —
    // textToVideo / firstFrame / firstLastFrame / imageToVideo discard them. So when an
    // audio upstream first appears, force the mode to `allReference`. Tracked
    // through a ref so we only fire on the 0 → ≥1 transition; once the user
    // disconnects all audio and reconnects, it fires again.
    // 是否可消费音频由媒体目录的 all_reference 能力决定；未声明该能力的模型由
    // 模型选择器拦截，这里不强推 allReference 以免顶进提交必 400 的模式。
    const prevHasAudioRef = useRef(false);
    const hasAudioUpstream = useMemo(
      () => referenceMedia.some((item) => item.kind === "audio"),
      [referenceMedia],
    );
    useEffect(() => {
      const prev = prevHasAudioRef.current;
      prevHasAudioRef.current = hasAudioUpstream;
      if (
        !prev &&
        hasAudioUpstream &&
        data.genMode !== "allReference" &&
        !isHappyHorseModel &&
        supportsAllReference
      ) {
        updateNodeData(id, { genMode: "allReference" });
      }
    }, [
      data.genMode,
      hasAudioUpstream,
      id,
      isHappyHorseModel,
      supportsAllReference,
      updateNodeData,
    ]);

    // Seedance 1.x 吃不下视频 / 音频，留在上面只能收获一次必然失败的提交。用户把
    // 视频或音频节点连上来就是明确意图，直接替他换成 Seedance 2.0 + 全能参考。
    // 判定走 upstreamTypeCounts（按节点类型）：空的视频节点也算 —— 先连节点、后生成
    // 是正常顺序，等它出了 URL 再切模型就太迟了（用户中间会看见一个不该出现的 1.x）。
    // 模型和模式必须一次 patch 写完：分两步会先渲染出「2.0 + 图生视频」的中间态，
    // 再被下面那条 videos→allReference 的 effect 纠一次，白闪一帧。
    //
    // 只在「没有 → 有视频/音频」这一次跳变时触发，**不能每次渲染都无条件纠正**：
    // updateNodeData 每次都 pushSnapshot 且清空 future（canvasStore），若持续纠正，
    // 用户 ⌘Z 恢复回 1.x 后边还在，effect 立刻把 2.0 写回去、再压一条 past ——
    // 撤销看起来毫无反应，redo 栈还被清空，等于把「回到连线之前」这条路堵死。改的
    // 又是 model 这种用户显式挑过的值，无声覆盖且撤不回来，性质比 genMode 重得多。
    // 一次性触发也不会被绕过：素材在场期间选择器已经把 1.x 置灰了，切不回去。
    // 与紧邻上面那条音频 → allReference 的 effect 用的是同一套闩锁。
    const autoSwitchedForMediaRef = useRef(false);
    useEffect(() => {
      // 所有判断（加载态、闩锁、该不该换、换成谁）都在 videoReferenceAutoSwitchAction
      // 里，这里只负责改 ref 和发 patch —— 那边是纯函数，异步加载时序才测得到。
      const action = videoReferenceAutoSwitchAction({
        counts: upstreamTypeCounts,
        currentModelId: selectedVideoModelId,
        models: availableVideoModels,
        modelsLoading: videoModelsLoading,
        alreadySwitched: autoSwitchedForMediaRef.current,
      });
      if (action.kind === "release") {
        autoSwitchedForMediaRef.current = false;
        return;
      }
      if (action.kind === "none") return;
      autoSwitchedForMediaRef.current = true;
      updateNodeData(id, { model: action.modelId, genMode: action.genMode });
      // 刻意不调 writeLastVideoModel：这是替用户救场，不是他表达的偏好，不该顺手
      // 把后续新建视频节点继承的默认模型也改掉。
    }, [
      availableVideoModels,
      id,
      selectedVideoModelId,
      updateNodeData,
      upstreamTypeCounts,
      videoModelsLoading,
    ]);

    // 上游接入视频素材时，只有「全能参考」能消费视频；其它模式（文生 / 图生 /
    // 首尾帧 / 图片参考）都会把视频丢弃。所以只要上游存在视频就强制切到
    // allReference 并锁死——下面的 tab 禁用规则会把其它 tab 一并禁用。
    // 与音频的「0→≥1 transition」不同，这里每次都纠正，确保视频在场期间无法切走。
    // 是否可消费视频由媒体目录的 all_reference 能力决定；未声明该能力的模型不强推，
    // 以免顶进提交必 400 的模式。
    useEffect(() => {
      if (upstreamCounts.videos === 0) return;
      if (isHappyHorseModel) return;
      if (!supportsAllReference) return;
      if (genMode === "allReference") return;
      updateNodeData(id, { genMode: "allReference" });
    }, [
      upstreamCounts.videos,
      genMode,
      id,
      isHappyHorseModel,
      supportsAllReference,
      updateNodeData,
    ]);

    // 文生视频不接受任何素材引用。即便用户先手动选了 textToVideo 再接入
    // 图片/音频（此时上面两个自动切换 effect 都因 genMode 已显式而 bail），
    // 也要强制切走，否则会停在 textToVideo 把已连素材丢弃。
    // 有图 → 按模型能力选默认（2.0 全能参考 / 1.x 首帧）；仅音频（只有 Seedance 2.0
    // 能消费）→ 全能参考；音频对非 2.0 不可用，由模型选择器拦截，这里不强推。
    useEffect(() => {
      if (isHappyHorseModel) return;
      if (genMode !== "textToVideo") return;
      if (upstreamCounts.images === 0 && upstreamCounts.audios === 0) return;
      if (upstreamCounts.images > 0) {
        const defaultMode = videoUpstreamImageDefaultMode(selectedVideoModel);
        if (defaultMode) updateNodeData(id, { genMode: defaultMode });
      } else if (supportsAllReference) {
        updateNodeData(id, { genMode: "allReference" });
      }
    }, [
      genMode,
      isHappyHorseModel,
      supportsAllReference,
      selectedVideoModel,
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
      if (isHappyHorseModel) return;
      if (genMode !== "firstLastFrame") return;
      if (upstreamCounts.images <= 2) return;
      if (!supportsAllReference) return;
      updateNodeData(id, { genMode: "allReference" });
    }, [
      genMode,
      isHappyHorseModel,
      supportsAllReference,
      upstreamCounts.images,
      id,
      updateNodeData,
    ]);

    // 「首帧生成视频」只承载一张图。i2v 端点按图片张数分流（1 张 = 图生视频，
    // 2-9 张 = 图片参考），接上第二张后做的其实已经是图片参考了，模式却还停在
    // 首帧上——所以直接把模式导到它真正在做的事情：全能参考 / 图片参考。
    // 跟上面首尾帧 >2 图那条是同一类兜底，每次都纠正（不做一次性闩锁），
    // 免得用户在多图状态下停在首帧、提交时被静默截断成一张。
    // 该切到哪个、哪些情况不该动，全部收在 videoMultiImageAutoSwitchMode 里。
    useEffect(() => {
      const target = videoMultiImageAutoSwitchMode(
        genMode,
        selectedVideoModel ?? selectedVideoModelId,
        upstreamCounts.images,
      );
      if (!target || target === genMode) return;
      updateNodeData(id, { genMode: target });
    }, [
      genMode,
      selectedVideoModel,
      selectedVideoModelId,
      upstreamCounts.images,
      id,
      updateNodeData,
    ]);

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

    // 低缩放档要用的静态缩略图，走离屏 <video> + CORS 抓帧（见 videoFrameCapture）。
    // 在节点挂载时就排队，而不是等缩放缩下去才开始：低缩放档下画布上根本不挂
    // <video>，那时才抓的话用户会先盯着一屏占位块；而且首屏视口若恢复在低缩放档，
    // 展示用的 <video> 一次都不会挂载，永远等不到抓帧时机。
    useEffect(() => {
      requestLodStill(videoSource);
    }, [videoSource]);

    // 订阅模块级缓存：节点被 onlyRenderVisibleElements 反复 mount/unmount 后缩略图
    // 仍然在，重挂即用。快照是原始值，抓帧完成前后各渲染一次，不会每帧重渲染。
    const lodStill = useSyncExternalStore(subscribeLodStills, () =>
      getLodStill(videoSource)
    );

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
        const composeResolution = quality.toLowerCase() === "1080p" ? "1080p" : "720p";
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
          await awaitTaskCompletion(ref.task_key, projectId, {
            taskType: ref.task_type,
          });
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
        await awaitTaskCompletion(ref.task_key, projectId, {
          taskType: ref.task_type,
        });
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

    // 提交可用性按模式区分（对齐后端各端点校验）：
    // - 文生 / 全能参考：后端强校验 prompt，必须有提示词（自写或上游 text）；
    // - 首帧 / 图生视频 / 图片参考 / 首尾帧 / 视频编辑：后端不校验 prompt，允许空提示词，
    //   只要素材齐备即可提交（图片类要 ≥1 张上游图；视频编辑要 ≥1 个上游视频）。
    //   这修掉「删掉默认提示词后传了首帧仍无法直接生成」的问题。
    const hasPromptText =
      prompt.trim().length > 0 || upstreamTextJoined.length > 0;
    const hasRequiredMediaForMode =
      genMode === "videoEdit"
        ? upstreamCounts.videos > 0
        : genMode === "allReference"
          ? upstreamCounts.images + upstreamCounts.videos + upstreamCounts.audios > 0
          : upstreamCounts.images > 0;
    // 提交前守卫：当前模型/模式无法消费已接入素材（视频/音频被静默丢、非 2.0 非
    // HappyHorse 多图会被后端 400）时给出理由并禁用提交，替代静默丢素材 / 提交 400。
    const mediaRejectionReason = videoSubmitMediaRejectionReason(
      genMode,
      selectedVideoModel,
      upstreamCounts,
    );
    const selectedModelReferenceError = selectedVideoModelReferenceDisabledReason(
      selectedVideoModel,
      upstreamCounts,
      genMode,
    );
    // 错误态重试的计费闸门。估价链随操作面板下沉后（选中才挂载、未选中不发请求），
    // 失败态的 RegenerateButton 成了唯一在未选中时也能提交的入口——若不在主体拦截，
    // 计费规则未配置时重试会放行一次注定被后端拒绝的请求。这里用一个仅错误态启用
    // 的估价探针补回拦截：value 传 null 时 hook 不发请求，未选中且无错误的节点仍然
    // 零估价开销；错误态与面板同时活跃时参数一致、查询同 key，由 react-query 去重。
    const retryBillingProbe = useGenerationCreditCost(
      "feature",
      hasGenerationError && videoBackendForCost && videoInputBilling.ready
        ? VIDEO_GENERATE_FEATURE_KEY
        : null,
      {
        surface: "canvas",
        params: {
          ...(selectedVideoModel?.catalogId
            ? { catalog_id: selectedVideoModel.catalogId }
            : {}),
          video_backend: videoBackendForCost,
          resolution: qualityToResolution(quality),
          pricing_quantity: Math.min(Math.max(count, 1), 4) * durationSec,
          operation: genMode,
          generate_audio: generateAudio,
          video_input_present: videoInputBilling.present,
          input_video_duration_seconds: videoInputBilling.durationSeconds,
        },
        quantity: Math.min(Math.max(count, 1), 4),
      },
    );
    const videoBillingRuleMissing =
      retryBillingProbe.error instanceof BillingRuleNotConfiguredError;
    const submitDisabled =
      isGenerating ||
      videoBillingRuleMissing ||
      !selectedVideoModel ||
      selectedModelReferenceError !== null ||
      mediaRejectionReason != null ||
      (videoModeRequiresPrompt(genMode)
        ? !hasPromptText
        : !hasRequiredMediaForMode);

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
        const collectUpstreamKeyframeUrls = (): {
          firstFrameUrl: string | null;
          lastFrameUrl: string | null;
        } => {
          const state = useCanvasStore.getState();
          const candidates: Array<{
            url: string;
            slot?: "first" | "last";
            legacyDisplayName?: string | null;
          }> = [];
          for (const node of collectUpstream()) {
            const url = submittableImageUrl(node);
            if (!url) continue;
            const edge = state.edges.find(
              (candidate) => candidate.source === node.id && candidate.target === id,
            );
            candidates.push({
              url,
              slot: edge?.data?.keyframeSlot,
              legacyDisplayName:
                typeof node.data.displayName === "string" ? node.data.displayName : null,
            });
          }
          return resolveVideoKeyframeUrls(candidates);
        };

        const durationClamped = clampVideoDuration(durationSec, durationBounds);
        const cameraTemplateId = cameraMovementId;
        // 后端按 canvas_id + node_id 记录每个节点的生成历史。多条生成时每个
        // 兄弟节点用各自的 targetId 作 node_id，历史才能分别落到对应节点。
        const canvasId = readUrl().canvas ?? "default";

        // 后端不再支持一次出多条，改为按「生成数量」并发调用 N 次接口。先按
        // genMode 组装出一个「调一次接口」的闭包 doSubmit，校验失败则置空提前返回。
        let doSubmit: ((targetId: string) => Promise<FreezoneJobRef>) | null = null;
        if (genMode === "firstFrame" || genMode === "firstLastFrame") {
          const keyframes = collectUpstreamKeyframeUrls();
          const firstFrameUrl = keyframes.firstFrameUrl;
          const lastFrameUrl = genMode === "firstLastFrame" ? keyframes.lastFrameUrl : null;
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
              model: selectedVideoModel?.catalogId ?? modelId,
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "imageToVideo" || genMode === "imageReference") {
          // Unified i2v endpoint: 1 image = 图生视频, 2-9 images = 图片参考视频.
          const imageUrls = collectUpstreamImageUrls().slice(
            0,
            referenceCaps?.image ?? 9,
          );
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
              model: selectedVideoModel?.catalogId ?? modelId,
              genMode,
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
              sceneOptimize: sceneOptimize ?? null,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "videoEdit") {
          // HappyHorse 视频编辑：1 个源视频 + 0-5 张参考图 → video_url + reference_images。
          const upstream = collectUpstream();
          const videoUrl =
            upstream
              .map((node) => referenceVideoUrl(node) ?? "")
              .find((url) => url.length > 0) ?? "";
          if (!videoUrl) {
            console.warn("[video-node] videoEdit submit without upstream video");
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          const allImageUrls = collectUpstreamImageUrls();
          const imageLimit = referenceCaps?.image ?? 5;
          if (allImageUrls.length > imageLimit) {
            toast.warning(
              `视频编辑最多支持 ${imageLimit} 张参考图，已使用前 ${imageLimit} 张（忽略其余 ${allImageUrls.length - imageLimit} 张）`,
            );
          }
          const imageUrls = allImageUrls.slice(0, imageLimit);
          doSubmit = (targetId) =>
            submitFreezoneVideoEdit(projectId, {
              videoUrl,
              imageUrls,
              prompt: composedPrompt,
              cameraTemplateId,
              aspectRatio: submitAspectRatio,
              resolution: qualityToResolution(quality),
              durationSeconds: durationClamped,
              audioSetting: "auto",
              generateAudio,
              model: selectedVideoModel?.catalogId ?? modelId,
              genMode,
              modelParams: data.modelParams,
              canvasId,
              nodeId: targetId,
            });
        } else if (genMode === "allReference") {
          // 全能参考是否可用以媒体目录的 supportedModes 为准。这里前置守卫给出
          // 可读提示，防止切换模型后残留模式打到不支持的端点。
          if (!supportsAllReference) {
            void showErrorDialog(
              isHappyHorseModel
                ? "HappyHorse 不支持全能参考模式，请切换为文生视频或图生视频。"
                : "当前模型不支持全能参考，请切换模型或改用其它生成模式。",
              t("common.error"),
            );
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return;
          }
          // Omni-gen: classify each upstream node by its media type.
          const caps = referenceCaps ?? { image: 9, video: 3, audio: 3 };
          const totalReferenceLimit = hasConfiguredReferenceCaps(selectedVideoModel)
            ? caps.image + caps.video + caps.audio
            : 12;
          const upstream = collectUpstream();
          const references: FreezoneVideoReferenceItem[] = [];
          // 与 references 里 type==="audio" 的项一一对应，用于提交前逐条校验音频时长。
          const audioRefs: {
            url: string;
            label: string;
            durationMs: number | null;
          }[] = [];
          let imageCount = 0;
          let videoCount = 0;
          let audioCount = 0;
          for (const node of upstream) {
            if (references.length >= totalReferenceLimit) break;
            const videoRefUrl = referenceVideoUrl(node);
            if (videoRefUrl) {
              // 视频节点或携带 videoUrl 的 upload 节点（资产库视频）统一收集。
              if (videoCount < caps.video) {
                references.push({ type: "video", url: videoRefUrl });
                videoCount += 1;
              }
            } else if (isAudioNode(node)) {
              const url =
                typeof node.data.audioUrl === "string"
                  ? node.data.audioUrl
                  : "";
              if (url && audioCount < caps.audio) {
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
                  // 时长超限时要指名道姓是哪条，所以这里连标签一起留着；没有文件名
                  // 的（TTS 直出等）退回「音频N」。序号按音频自身 1-based 计，与后端
                  // pipeline.py 的 enumerate(audio_paths, start=1) 同口径；标签本身
                  // 只进提示文案、不随 references 发给后端，所以跟随界面语言。
                  label:
                    rawLabel ||
                    t("node.videoNode.audio.clipFallbackLabel", {
                      index: audioCount + 1,
                    }),
                  durationMs:
                    typeof node.data.durationMs === "number"
                      ? node.data.durationMs
                      : null,
                });
                audioCount += 1;
              }
            } else {
              const url = submittableImageUrl(node);
              if (url && imageCount < caps.image) {
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
          // Seedance 2.0 厂商对音频有两条时长约束，越界都会以 InvalidParameter 400
          // 回来：**每条** 1.8s ≤ 时长 ≤ 15.2s，以及**所有条加起来** ≤ 15.2s。提交前
          // 先本地校验：durationMs 缺失时用 <audio> 探测兜底，越界就弹窗拦下，避免白跑
          // 一趟后端。
          //
          // 两类边界分开授权，与后端 freezone omni-gen 的兜底一一对应：
          //   - 逐条 1.8~15.2s 只有 seedance2 成立（数字是从它的报文里实测出来的）；
          //   - 总时长凡是目录里配了 referenceAudioTotalMaxSeconds 的模型都要管——否则
          //     这类模型前端放行、后端拦下，用户白等一个来回还只能看到一句英文 400。
          const audioTotalConfigured =
            selectedVideoModel?.referenceAudioTotalMaxSeconds != null;
          if ((isSeedance20Model || audioTotalConfigured) && audioRefs.length > 0) {
            const resolvedDurations = await Promise.all(
              audioRefs.map((ref) =>
                typeof ref.durationMs === "number" && ref.durationMs > 0
                  ? Promise.resolve(ref.durationMs)
                  : probeAudioDurationMs(ref.url),
              ),
            );
            const rejection = audioReferenceDurationRejection(
              audioRefs.map((ref, index) => ({
                label: ref.label,
                durationMs: resolvedDurations[index] ?? null,
              })),
              {
                totalLimitMs: audioReferenceTotalDurationLimitMs(selectedVideoModel, {
                  // seedance2 有厂商硬顶，目录配得再宽也不能越过它。
                  vendorCapMs: isSeedance20Model
                    ? MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS
                    : undefined,
                }),
                perClipLimits: isSeedance20Model,
              },
            );
            if (rejection) {
              const clips = formatAudioDurationClips(rejection.clips, (key, vars) =>
                t(key, vars),
              );
              void showErrorDialog(
                rejection.kind === "tooShort"
                  ? t("node.videoNode.audio.durationTooShort", {
                      min: MIN_AUDIO_REFERENCE_DURATION_MS / 1000,
                      clips,
                    })
                  : rejection.kind === "tooLong"
                    ? t("node.videoNode.audio.durationTooLong", {
                        max: MAX_AUDIO_REFERENCE_DURATION_MS / 1000,
                        clips,
                      })
                    : t("node.videoNode.audio.durationTotalTooLong", {
                        max: formatAudioDurationSeconds(rejection.limitMs),
                        total: formatAudioDurationSeconds(rejection.totalMs),
                        clips,
                      }),
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
              model: selectedVideoModel?.catalogId ?? modelId,
              genMode,
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
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
              model: selectedVideoModel?.catalogId ?? modelId,
              genMode,
              modelParams: data.modelParams,
              humanReview: supportsHumanReview && humanReview,
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
            const completed = await awaitTaskCompletion(ref.task_key, projectId, {
              taskType: ref.task_type,
            });
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
            if (isTaskCancelledError(error)) {
              // 用户已在终止确认里知情：不进 runErrors、不弹错误框、不落错误横幅。
              if (runIndex === 0 && completedUrls.length === 0) {
                updateNodeData(id, { isGenerating: false, generationStartedAt: null });
              }
              return;
            }
            console.error("[video-node] video gen failed", error);
            // 先记下错误再决定是否早退 —— settle 后的聚合分支靠 runErrors 判断
            // 「部分失败」并弹 toast；早退前不记会把首个成功之后的失败彻底吞掉。
            runErrors.push(error);
            // 已有同批其它视频完成（主视频已落）时不覆盖成功态为错误——
            // 部分失败只影响画册条数。
            if (completedUrls.length > 0) return;
            // 轮询超时 ≠ 生成失败：后端还在跑。保留 isGenerating 与任务句柄，
            // 刷新页面时 resumeNodeGeneration 会重新接上并回填结果；这里写错误
            // 横幅只会把一个还活着的任务标成失败、并清掉可续接的句柄。
            if (isTaskPollTimeoutError(error)) return;
            const resolved = resolveErrorContent(error, "视频生成失败");
            const displayErrorMessage = backendErrorToastMessage(error, t);
            const diagnostics = resolveGenerationErrorDiagnostics(error, resolved.details);
            // Persist the failure on the node so the 重新生成 entry survives after
            // the user dismisses the dialog (previously the error was dialog-only).
            // 只有 run 0 失败才终结 loading：非首 run 失败时 run 0 可能还在跑，
            // 它的成功补丁会清掉这里写的错误横幅。
            updateNodeData(id, {
              ...(runIndex === 0
                ? { isGenerating: false, generationStartedAt: null }
                : {}),
              generationError: displayErrorMessage,
              generationErrorDetails: diagnostics.details,
              generationErrorRequestId: diagnostics.requestId,
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
          // 整批都只是「前端不等了」时走中性提示：后端仍在生成，节点保持生成中
          // 状态等待刷新续接，不该按报错呈现。真有失败混在里面则仍按失败处理。
          if (runErrors.every((error) => isTaskPollTimeoutError(error))) {
            notifyTaskStillRunning(t);
            void refreshHistory();
            return;
          }
          const resolved = resolveErrorContent(firstError, "视频生成失败");
          const displayErrorMessage = backendErrorToastMessage(firstError, t);
          const diagnostics = resolveGenerationErrorDiagnostics(firstError, resolved.details);
          const haystack = `${displayErrorMessage}\n${diagnostics.details ?? ""}`;
          if (
            haystack.includes(
              "InputImageSensitiveContentDetected.PrivateInformation",
            )
          ) {
            // 素材含真实人脸被拦截：引导用户开启「真人素材审核」后重试。
            void showErrorDialog(
              "素材包含真实人脸，已被内容安全策略拦截。请在下方打开「真人素材审核」开关后重试（可能增加审核时间，不保证通过）。",
              "素材被拦截",
              diagnostics.details ?? undefined,
            );
          } else {
            void showErrorDialog(
              displayErrorMessage,
              t("common.error"),
              diagnostics.details ?? undefined,
            );
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
      supportsAllReference,
      supportsHumanReview,
      modelId,
      prompt,
      quality,
      refreshHistory,
      sceneOptimize,
      submitDisabled,
      t,
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
          {/* 低缩放档：<video> 换成静态图/占位块。每个 <video> 都是一个独立
              合成层，数量随可见节点数线性增长——实测 69 节点 / zoom 0.1 下，
              只有连同视频层一起降级才能把 p90 帧时从 26ms 拉回 14ms。 */}
          {!isGenerating &&
          !isUploading &&
          videoSource &&
          lowDetailZoom &&
          !isVideoPlayingRef.current ? (
            lodStill ? (
              <img
                src={lodStill}
                alt=""
                className="h-full w-full object-contain"
                draggable={false}
                onClick={() => setSelectedNode(id)}
              />
            ) : (
              <div
                className="flex h-full w-full items-center justify-center bg-black/40"
                onClick={() => setSelectedNode(id)}
              >
                <VideoIcon className="h-1/4 max-h-10 w-1/4 max-w-10 text-white/25" />
              </div>
            )
          ) : !isGenerating && !isUploading && videoSource ? (
            <video
              ref={setVideoRef}
              src={videoPosterSource ?? undefined}
              className="h-full w-full object-contain"
              playsInline
              preload="metadata"
              onPlay={() => {
                isVideoPlayingRef.current = true;
                // shell 决策在组件外层（withLodShell），读不到组件内 ref，
                // 播放态同步进模块级注册表：播放中的节点低缩放档不降级。
                setNodeMediaActive(id, true);
              }}
              onPause={() => {
                isVideoPlayingRef.current = false;
                setNodeMediaActive(id, false);
              }}
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
          ) : isConnected ? (
            // 已连线：不再显示文字 CTA，只在节点中间放一个图标（对齐 libtv）。
            <div className="flex h-full w-full items-center justify-center">
              <Play className="h-9 w-9 text-text-muted/46" />
            </div>
          ) : (
            <div className="flex h-full w-full items-center px-8">
              {/* 空态（无入边）才走到这里。CTA 完全按媒体模型目录的 supportedModes
                  决定；目录尚未加载时才使用模型族兜底，避免展示后端会拒绝的入口。 */}
              <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                <div className="text-xs text-[var(--canvas-node-input-helper)]">试试：</div>
                <div className="flex flex-col gap-0.5">
                  {videoEmptyStateCtaModes(selectedVideoModel).map((mode) => {
                    const { Icon, label } = VIDEO_EMPTY_STATE_CTA_META[mode];
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          spawnFrameUploads(mode);
                        }}
                        className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                      >
                        <Icon className="h-4 w-4 text-text-muted/90" />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
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
          <VideoOperationsPanel
            id={id}
            data={data}
            genMode={genMode}
            modelId={modelId}
            selectedVideoModel={selectedVideoModel}
            availableVideoModels={availableVideoModels}
            isHappyHorseModel={isHappyHorseModel}
            upstreamCounts={upstreamCounts}
            upstreamTypeCounts={upstreamTypeCounts}
            upstreamContents={upstreamContents}
            upstreamTextJoined={upstreamTextJoined}
            referenceMedia={referenceMedia}
            referenceCaps={referenceCaps}
            cameraTemplates={cameraTemplates}
            cameraTemplatesLoading={cameraTemplatesLoading}
            configuredAspectRatios={configuredAspectRatios}
            aspectRatio={aspectRatio}
            quality={quality}
            qualityOptions={qualityOptions}
            durationSec={durationSec}
            durationBounds={durationBounds}
            sceneOptimize={sceneOptimize}
            sceneOptimizeOptions={sceneOptimizeOptions}
            generateAudio={generateAudio}
            supportsHumanReview={supportsHumanReview}
            humanReview={humanReview}
            count={count}
            prompt={prompt}
            isGenerating={isGenerating}
            videoBackendForCost={videoBackendForCost}
            videoInputPresent={videoInputBilling.present}
            videoInputBillingReady={videoInputBilling.ready}
            inputVideoDurationSeconds={videoInputBilling.durationSeconds}
            submitDisabled={submitDisabled}
            selectedModelReferenceError={selectedModelReferenceError}
            mediaRejectionReason={mediaRejectionReason}
            expanded={panelExpanded}
            onExpandedChange={setPanelExpanded}
            onSubmit={handleSubmit}
          />
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
      </div>
    );
  },
);

VideoNode.displayName = "VideoNode";

export type ReferenceMediaItem =
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
