// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
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
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from "@/features/canvas/application/imageData";
import {
  extractUpstreamContent,
  joinUpstreamText,
} from "@/features/canvas/application/graphContentResolver";
import { compileWorkflowNodePrompt } from "@/features/canvas/application/workflowRecipeRuntime";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  sortUpstreamByReferenceOrder,
  upstreamNodesInEdgeOrder,
} from "@/features/canvas/nodes/referenceOrdering";
import {
  referenceImageUrl,
  referenceVideoUrl,
} from "@/features/canvas/nodes/referenceMedia";
import {
  ASPECT_RATIOS,
  clampVideoDuration,
  formatReferenceMediaCompilerLabel,
  hasConfiguredReferenceCaps,
  referenceCapsForMode,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/shared/videoFormOptions";
import {
  audioReferenceDurationRejection,
  formatAudioDurationClips,
  formatAudioDurationSeconds,
  isCompositionTimelineAudioData,
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  MAX_AUDIO_REFERENCE_DURATION_MS,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  MIN_AUDIO_REFERENCE_DURATION_MS,
  referenceDurationLimitsMs,
  resolveVideoKeyframeUrls,
  videoModeRequiresPrompt,
  videoModelReferenceDisabledReason,
  videoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { normalizeCanvasEdgeSemanticKind } from "@/features/freezone/canvasEdgeSemantics";
import type { VideoGenerationFormProps } from "@/features/canvas/nodes/shared/VideoGenerationForm";
import { setAlbumPendingTotal } from "@/features/canvas/nodes/shared/albumPendingTotals";
import { useReferenceMentionSync } from "@/features/canvas/nodes/useReferenceMentionSync";
import { useNodeGenerationTaskState } from "@/features/canvas/application/useNodeGenerationTaskState";
import {
  resolveErrorContent,
  showErrorDialog,
} from "@/features/canvas/application/errorDialog";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { resolveGenerationErrorDiagnostics } from "@/features/canvas/application/generationErrorReport";
import type { MentionCandidate } from "@/features/canvas/nodes/PromptMentionEditor";
import {
  CAMERA_MOVEMENT_PRESETS,
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { useFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import { useFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoEdit,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
  type FreezoneJobRef,
  type FreezoneVideoAspectRatio,
  type FreezoneVideoReferenceItem,
  type FreezoneVideoResolution,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import {
  CLEARED_GENERATION_TASK_FIELDS,
  generationTaskDescriptor,
} from "@/features/canvas/application/resumeGeneration";
import { translateNodeText } from "@/features/canvas/application/translateText";
import { readUrl } from "@/lib/url-params";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

// 媒体目录可以给模型声明任意分辨率档位，这里只是没配置时的兜底；大小写按后端
// 口径统一成小写（`qualityToResolution` 因此退化成恒等函数）。
const QUALITIES: ReadonlyArray<VideoGenQuality> = ["480p", "720p", "1080p"];
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;
// 统一计费（#210）：视频生成走 feature 键询价，模型身份塞进 params。
const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

// 节点被删除 / 尚未出现在 store 里时的空数据兜底，保持 hook 的 early-return-free
// 结构（hooks 数量必须每帧一致）。
const EMPTY_NODE_DATA = {} as VideoNodeData;

// 档位字符串就是后端要的 resolution：媒体目录里配什么就原样发什么，前端不再做
// 「480P → 480p」这类白名单映射，否则 Admin 新配的档位会被静默丢掉。
function qualityToResolution(q: VideoGenQuality): FreezoneVideoResolution {
  return q;
}

function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? []).map((item) => item.trim()).filter(Boolean);
  return options.length > 0 ? options : QUALITIES;
}

// 节点上存着的旧值可能是 "720P"，目录里现在写的是 "720p"：大小写不敏感地对上，
// 别把用户选过的档位当非法值重置掉。
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

// 素材守卫两层叠加：先是模型能力（Seedance 1.x 只吃 1 张图之类，写死在能力模块
// 里），再是媒体目录声明的逐模式上限。
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

function videoDurationBoundsForModel(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : DEFAULT_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : DEFAULT_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

// 媒体节点的 durationMs 可能尚未加载。提交前用临时媒体元素探测真实时长兜底，
// 探测失败（CORS/网络等）返回 null，不阻断提交，交由后端兜底。
function probeMediaDurationMs(
  url: string,
  media: "audio" | "video",
): Promise<number | null> {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const element = document.createElement(media);
    let settled = false;
    const finish = (ms: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      element.load();
      resolve(ms);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    element.preload = "metadata";
    element.onloadedmetadata = () => {
      const secs = element.duration;
      finish(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null);
    };
    element.onerror = () => finish(null);
    element.src = url;
  });
}

function probeAudioDurationMs(url: string): Promise<number | null> {
  return probeMediaDurationMs(url, "audio");
}

function probeVideoDurationMs(url: string): Promise<number | null> {
  return probeMediaDurationMs(url, "video");
}

function isCompositionTimelineAudioNode(node: CanvasNode): boolean {
  return isAudioNode(node) && isCompositionTimelineAudioData(node.data);
}

function isSeedance2ValueModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return normalized === "newapi_seedance-2.0-value" ||
    normalized === "newapi_seedance-2.0-fast-value" ||
    normalized === "huimeng_seedance-2.0-value" ||
    normalized === "huimeng_seedance-2.0-fast-value";
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
 * `VideoGenerationForm` 的 props 里，由本 hook 负责供给的那一部分。
 *
 * 剩下的两个是**宿主自己的编排 / 排版**，与生成表单的数据与提交无关，故不进 hook：
 * - `onOpenCharacterLibrary`：打开宿主持有的资产库弹窗；
 * - `compact`：宿主自己决定 chips 行右侧是否留出「放大」按钮的位置。
 */
export type VideoGenerationFormBoundProps = Omit<
  VideoGenerationFormProps,
  "onOpenCharacterLibrary" | "compact"
>;

export interface UseVideoGenerationFormOptions {
  /**
   * 一批生成（含并发的 N 次调用）全部尘埃落定后触发。节点用它刷新「生成历史」
   * 记录条；不关心历史的宿主可以不传。
   */
  onGenerationSettled?: () => void;
  /**
   * 是否发起算力预估询价。默认 true —— 故事板那种「表单常驻、一屏一个」的宿主
   * 直接用默认值。
   *
   * 工作流节点必须传 `selected`：hook 挂在 VideoNode 顶层，画布上每个配好模型的
   * 视频节点都会各发一次 /generation-credit-cost（query key 含各自的 params，
   * react-query 去重不了）。口径与同文件上方 `useNodeGenerationHistory` 的
   * `enabled: Boolean(selected)` 一致。
   *
   * 失败态由 hook 内部兜底常开，不受本开关约束：失败横幅上的重试按钮是节点未选中
   * 时唯一还能提交的入口，它的 disabled 接的就是 submitDisabled，必须拿得到
   * billing 规则缺失的闸门。
   */
  costProbeEnabled?: boolean;
}

export interface UseVideoGenerationFormResult {
  /** 直接展开给 `<VideoGenerationForm {...formProps} />`。 */
  formProps: VideoGenerationFormBoundProps;
  /**
   * 下面几个值 formProps 里也有（或由它派生），但宿主自己还要用：
   * - isGenerating / submitDisabled / submit：节点上「生成失败」横幅的重试按钮，
   *   以及生成中时历史记录点击的「非破坏性预览」分支；
   * - prompt：**已落库的** `data.prompt`（非编辑器草稿）——「首帧生成视频」CTA
   *   靠它判断用户是否已经写过提示词、要不要覆盖；
   * - quality：节点剪辑合成按它挑 compose 分辨率；
   * - upstreamCounts：节点空态 CTA 用 `videos === 0` 决定是否显示首帧/首尾帧引导。
   */
  isGenerating: boolean;
  submitDisabled: boolean;
  /** 提交生成；返回本批第 1 条完成的视频 url（全失败/无产物时为空对象）。 */
  submit: () => Promise<{ videoUrl?: string }>;
  prompt: string;
  quality: VideoGenQuality;
  selectedVideoModelId: string;
  upstreamCounts: { images: number; videos: number; audios: number };
}

/**
 * 视频生成表单的**父级状态与编排**：prompt 草稿 + 输入法合成态、上游文本 / 图 /
 * 视频 / 音频的收集与编号（@图片N / @视频N / @音频N）、genMode 状态机（含随上游
 * 与模型自动切换的那几条兜底）、模型与参数归一化、翻译、算力预估，以及按「生成
 * 数量」并发调用的 handleSubmit（按 genMode 分派到 keyframes / i2v / edit /
 * omni-gen / gen 五个端点）。
 *
 * 与 `VideoGenerationForm` 一样不碰任何 React Flow 上下文——节点数据一律从
 * `useCanvasStore` 按 id 取（画布喂给 ReactFlow 的就是 store 里的同一份 nodes，
 * 因此与节点组件收到的 `data` prop 是同一个对象）。这样故事板详情之类的独立布局
 * 也能直接 `useVideoGenerationForm(nodeId)` 拿到整套能力。
 *
 * 提交编排刻意留在 hook 内部（与图片侧 `useImageGenerationForm` 同样的取舍）：它
 * 交织了 per-run 补丁、模块级画册计数（albumPendingTotals）、错误聚合弹窗与
 * 「部分失败」toast，外提到 application/ 需要十几个入参，反而危及「行为零变化」。
 */
export function useVideoGenerationForm(
  nodeId: string,
  options?: UseVideoGenerationFormOptions,
): UseVideoGenerationFormResult {
  const { t } = useTranslation();
  const onGenerationSettled = options?.onGenerationSettled;
  const costProbeEnabled = options?.costProbeEnabled ?? true;
  const id = nodeId;

  const data = (useCanvasStore(
    (state) => state.nodes.find((node) => node.id === nodeId)?.data,
  ) ?? EMPTY_NODE_DATA) as VideoNodeData;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // 在途守卫：持到本批所有并发任务 allSettled 才释放（见 handleSubmit）。
  const submittingRef = useRef(false);
  const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);

  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  // Local draft + composition guard so IME (中文输入法) candidates stop being
  // wiped by the store-driven re-render. Same fix pattern as
  // `docs/changes/2026-05-12-image-gen-ime-fix.md`.
  const [promptDraft, setPromptDraft] = useState(prompt);
  const isComposingRef = useRef(false);
  useEffect(() => {
    if (isComposingRef.current) return;
    setPromptDraft(prompt);
  }, [prompt]);

  // 提示词草稿 / IME 合成态留在本 hook 里（不下沉到表单组件）：「生成失败」重试
  // 横幅与自动提交都读同一份 prompt 判断可否提交，草稿若下沉会造成两处失配。
  const handlePromptChange = useCallback(
    (next: string) => {
      setPromptDraft(next);
      if (!isComposingRef.current) {
        updateNodeData(id, { prompt: next });
      }
    },
    [id, updateNodeData],
  );
  const handlePromptCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);
  const handlePromptCompositionEnd = useCallback(
    (next: string) => {
      isComposingRef.current = false;
      setPromptDraft(next);
      updateNodeData(id, { prompt: next });
    },
    [id, updateNodeData],
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
  const modelId = selectedVideoModel?.id ?? "";
  const selectedVideoModelId = selectedVideoModel?.apiModel ?? selectedVideoModel?.id ?? modelId;
  const isHappyHorseModel = isHappyHorseVideoModel(selectedVideoModelId);
  const configuredAspectRatios = useMemo(
    () => (selectedVideoModel?.ratioOptions ?? []).map((ratio) => ratio.trim()).filter(Boolean),
    [selectedVideoModel],
  );
  const hasConfiguredAspectRatios = configuredAspectRatios.length > 0;
  // 模型在媒体目录里声明了比例时以它为准；没声明才走旧口径 —— aspectRatio 只认
  // 合法的比例预设（含 "auto"），历史上曾被写成像素串(如 "1248:704")的旧节点在
  // 这里吸附到最接近的合法视频比例，保证 chip 显示干净。
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
  // Admin 配置存在时原样提交模型声明的比例；未配置时保留旧版 auto 推导逻辑：
  // 绝不发 "auto"，按节点真实像素(若有)推导最接近的比例，否则回退 16:9。
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
  const aspectRatioOptions = useMemo<readonly FreezoneVideoAspectRatio[]>(
    () => (hasConfiguredAspectRatios ? configuredAspectRatios : ASPECT_RATIOS),
    [configuredAspectRatios, hasConfiguredAspectRatios],
  );
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
  const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);
  // 真人素材审核开关改由媒体目录声明（#210）：以前是「凡 Seedance 2.0 都显示」，
  // 现在谁支持谁在 Admin 里勾。isSeedance20Model 仍用于场景优化等 2.0 专属逻辑。
  const supportsHumanReview = selectedVideoModel?.humanReview === true;
  const humanReview = Boolean(data.humanReview);
  const count: VideoGenCount = (data.count ?? 1) as VideoGenCount;
  const upstreamNodes = useUpstreamNodes(id);
  const videoInputBilling = useMemo(() => {
    if (genMode !== "allReference" && genMode !== "videoEdit") {
      return { present: false, ready: true, durationSeconds: 0 };
    }
    const ordered = sortUpstreamByReferenceOrder(
      upstreamNodes,
      data.referenceOrder,
    ).filter((node) => Boolean(referenceVideoUrl(node)));
    const limit =
      genMode === "videoEdit" ? 1 : (selectedVideoModel?.referenceVideoMax ?? 3);
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
  // Debounce the cost-estimate inputs: dragging the duration slider (and,
  // to a lesser degree, flipping count/quality/model) churns the query key
  // and TanStack Query aborts each in-flight request, spraying "Canceled"
  // rows across the Network tab. Coalesce to one request once the params
  // settle (~350ms). Primitives only — see useDebouncedValue's contract.
  const debouncedBackend = useDebouncedValue(videoBackendForCost, 350);
  const debouncedCatalogId = useDebouncedValue(
    selectedVideoModel?.catalogId ?? null,
    350,
  );
  const debouncedQuality = useDebouncedValue(quality, 350);
  const debouncedCount = useDebouncedValue(count, 350);
  const debouncedDurationSec = useDebouncedValue(durationSec, 350);
  const debouncedVideoInputPresent = useDebouncedValue(
    videoInputBilling.present,
    350,
  );
  const debouncedInputVideoDuration = useDebouncedValue(
    videoInputBilling.durationSeconds,
    350,
  );
  const videoCount = Math.min(Math.max(debouncedCount, 1), 4);
  const videoPricingQuantity = videoCount * debouncedDurationSec;
  // 失败态永远询价（见 costProbeEnabled 的注释）：重试按钮在节点未选中时也能提交。
  // 这行原本在下方 cameraMovementPreset 之后，为了给询价当输入提到这里；调用位置
  // 变了但仍然无条件执行，hook 顺序照旧稳定。
  const { isGenerating } = useNodeGenerationTaskState(data);
  const hasGenerationError =
    !isGenerating &&
    !data.videoUrl &&
    typeof data.generationError === "string" &&
    data.generationError.trim().length > 0;
  const costProbeActive = costProbeEnabled || hasGenerationError;
  const videoCreditCost = useGenerationCreditCost(
    "feature",
    costProbeActive && debouncedBackend && videoInputBilling.ready
      ? VIDEO_GENERATE_FEATURE_KEY
      : null,
    {
      surface: "canvas",
      params: {
        ...(debouncedCatalogId ? { catalog_id: debouncedCatalogId } : {}),
        video_backend: debouncedBackend,
        resolution: qualityToResolution(debouncedQuality),
        pricing_quantity: videoPricingQuantity,
        operation: genMode,
        generate_audio: generateAudio,
        video_input_present: debouncedVideoInputPresent,
        input_video_duration_seconds: debouncedInputVideoDuration,
      },
      quantity: videoCount,
    },
  );
  const videoBillingRuleMissing =
    videoCreditCost.error instanceof BillingRuleNotConfiguredError;
  const billingRuleMissingSubmitMessage = videoBillingRuleMissing
    ? t("node.videoNode.billingRuleMissingSubmit", {
        defaultValue:
          "视频生成未启动：计费规则未配置，请联系管理员设置积分规则后重试。",
      })
    : null;
  // 用服务端下发的 `display`，别自己 format `cost`：促销时 display 是「原价→现价」，
  // CreditCostPill 正是靠这个 `→` 才渲染划线原价和促销标签（credit-visual.tsx:117）。
  // 自拼出来的只有一个数字，促销展示会整块消失。口径与 VideoNode 一致。
  const totalCreditCostDisplay =
    videoCreditCost.data?.data.display ??
    (videoBillingRuleMissing ? t("common.billingRuleNotConfiguredShort") : null);
  // display 与 promotion 必须成对下发：只有前者时标签会兜底成通用的「促销中」，
  // 拿不到「限时 5 折」这种真实文案。
  const creditPromotion = videoCreditCost.data?.data.promotion ?? null;
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
  // ------ upstream reference images ----------------------------------------
  // Anything connected via target → this video node that has an image url
  // shows up as a thumbnail chip next to the camera/role/marker chips. Ordered
  // by connection order (later-referenced after earlier), with manual
  // referenceOrder taking precedence — see sortUpstreamByReferenceOrder.
  // Subscribe to ONLY this node's one-hop upstream (not the whole nodes array)
  // so dragging unrelated nodes doesn't re-render this node. See useUpstreamGraph.
  const videoInputNodes = useMemo(
    () => upstreamNodes.filter((node) => !isCompositionTimelineAudioNode(node)),
    [upstreamNodes],
  );
  const referenceImages = useMemo(() => {
    const upstream = sortUpstreamByReferenceOrder(
      videoInputNodes,
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
  }, [videoInputNodes, data.referenceOrder]);

  // 统一的「图 / 视 / 音」上游引用条目，给 chips 行用。顺序按连接顺序
  // （与 referenceImages 同步），让 chip 编号 1/2/3... 跟可视顺序一致。
  // text 上游不进这一行 —— 上面已经单独渲染了「@文本 chip」。
  const referenceMedia = useMemo<ReferenceMediaItem[]>(() => {
    const upstream = sortUpstreamByReferenceOrder(
      videoInputNodes,
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
  }, [videoInputNodes, data.referenceOrder]);

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
  // 当前 genMode 在 REFERENCE_CAPS_BY_MODE 里没有条目（textToVideo），统一按
  // within=true 处理；下游 chip / mention 候选会决定是否消费 within。
  const referenceCaps = useMemo(
    () => referenceCapsForMode(selectedVideoModel, genMode),
    [genMode, selectedVideoModel],
  );
  const referenceMediaCapInfo = useMemo(() => {
    const counts = { image: 0, video: 0, audio: 0 };
    return referenceMedia.map((item) => {
      counts[item.kind] += 1;
      const cap = referenceCaps?.[item.kind];
      const withinCap = cap == null || counts[item.kind] <= cap;
      return { item, typeIndex: counts[item.kind], withinCap };
    });
  }, [referenceCaps, referenceMedia]);

  // @ 提及候选 —— 图片、音频都可引用，但编号按 *各自类型* 的序号走，
  // *不* 按行内混合位置。后端按上传的图片数量来对应 图片N，若用混合位置编号
  // （音频排第一时图片就成了「图片2」），后端只看到 1 张图却被要求引用图片2
  // 会报错。所以图片用图片序号、音频用音频序号，各自独立计数。
  //
  // 在 REFERENCE_CAPS_BY_MODE 表里有条目的模式，超过 cap 的条目不能进 @ 候选
  // —— 服务端会直接丢弃，留在候选里只会让用户选了之后被静默忽略。
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const out: MentionCandidate[] = [];
    let imageIdx = 0;
    let videoIdx = 0;
    let audioIdx = 0;
    const enforceCap = referenceCaps != null;
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
  }, [referenceCaps, referenceMediaCapInfo]);

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
    () => videoInputNodes.map(extractUpstreamContent),
    [videoInputNodes],
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
    for (const node of videoInputNodes) {
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
  }, [videoInputNodes]);
  // HappyHorse 的模式可用性由「上游节点类型」决定，而非素材是否已填。空的图片
  // 节点（尚未生成/上传图）也应让「首帧 / 图片参考」可选——用户先连节点、后填图
  // 是正常顺序。所以这里按节点类型统计，区别于 upstreamCounts 的「已解析 URL」口径。
  const upstreamTypeCounts = useMemo(() => {
    let images = 0;
    let videos = 0;
    let audios = 0;
    for (const node of videoInputNodes) {
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
  }, [videoInputNodes]);

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
      const translated = await translateNodeText(project, {
        text: prompt,
        nodeId: id,
        nodeType: "video",
      });
      if (translated) {
        updateNodeData(id, { prompt: translated });
      }
    } catch (error) {
      console.error("[video-node] translate failed", error);
    } finally {
      setIsTranslatingPrompt(false);
    }
  }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

  // First connected image selects a model-compatible mode. Seedance 2.0 uses
  // omni reference; Seedance 1.x uses first-frame generation.
  useEffect(() => {
    if (isHappyHorseModel) return;
    if (data.genMode != null) return;
    if (referenceImages.length === 0) return;
    updateNodeData(id, {
      genMode: videoUpstreamImageDefaultMode(selectedVideoModelId),
    });
  }, [
    data.genMode,
    id,
    isHappyHorseModel,
    referenceImages.length,
    selectedVideoModelId,
    updateNodeData,
  ]);

  // HappyHorse 的模式完全由上游节点类型决定（文档的 4 大功能一一对应），这里用
  // 一条统一状态机替代分散的兜底 effect，避免多个 effect 互相打架：
  //   - 上游有视频            → 视频编辑 (videoEdit / video_url)
  //   - 上游图片 >1 张        → 图片参考 (imageReference / reference_images 1-9)
  //   - 上游图片 == 1 张      → 默认首帧 (imageToVideo / image_url)，但尊重用户
  //                             主动切到的「图片参考」
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
      target = genMode === "imageReference" ? "imageReference" : "imageToVideo";
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
    upstreamTypeCounts.images,
    upstreamTypeCounts.videos,
    updateNodeData,
  ]);

  // Seedance 1.x cannot consume video or audio references. Switch once to the
  // base Seedance 2.0 omni model when those node types first appear. The pure
  // capability helper also waits for the real model list before choosing.
  const autoSwitchedForMediaRef = useRef(false);
  useEffect(() => {
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
    updateNodeData(id, {
      model: action.modelId,
      genMode: action.genMode,
    });
  }, [
    availableVideoModels,
    id,
    selectedVideoModelId,
    updateNodeData,
    upstreamTypeCounts,
    videoModelsLoading,
  ]);

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
    if (
      !prev &&
      hasAudioUpstream &&
      data.genMode !== "allReference" &&
      !isHappyHorseModel &&
      isSeedance20Model
    ) {
      updateNodeData(id, { genMode: "allReference" });
    }
  }, [
    data.genMode,
    hasAudioUpstream,
    id,
    isHappyHorseModel,
    isSeedance20Model,
    updateNodeData,
  ]);

  // 上游接入视频素材时，只有「全能参考」能消费视频；其它模式（文生 / 图生 /
  // 首尾帧 / 图片参考）都会把视频丢弃。所以只要上游存在视频就强制切到
  // allReference 并锁死——下面的 tab 禁用规则会把其它 tab 一并禁用。
  // 与音频的「0→≥1 transition」不同，这里每次都纠正，确保视频在场期间无法切走。
  useEffect(() => {
    if (upstreamCounts.videos === 0) return;
    if (isHappyHorseModel) return;
    if (!isSeedance20Model) return;
    if (genMode === "allReference") return;
    updateNodeData(id, { genMode: "allReference" });
  }, [
    upstreamCounts.videos,
    genMode,
    id,
    isHappyHorseModel,
    isSeedance20Model,
    updateNodeData,
  ]);

  // 文生视频不接受任何素材引用。即便用户先手动选了 textToVideo 再接入
  // 图片/音频（此时上面两个自动切换 effect 都因 genMode 已显式而 bail），
  // 也要强制切走，否则会停在 textToVideo 把已连素材丢弃。图片/音频统一走
  // allReference（全能参考），与「首次接入图片」的默认保持一致。
  useEffect(() => {
    if (isHappyHorseModel) return;
    if (genMode !== "textToVideo") return;
    if (upstreamCounts.images === 0 && upstreamCounts.audios === 0) return;
    if (upstreamCounts.images > 0) {
      updateNodeData(id, {
        genMode: videoUpstreamImageDefaultMode(selectedVideoModelId),
      });
    } else if (isSeedance20Model) {
      updateNodeData(id, { genMode: "allReference" });
    }
  }, [
    genMode,
    isHappyHorseModel,
    isSeedance20Model,
    selectedVideoModelId,
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
    updateNodeData(id, { genMode: "allReference" });
  }, [genMode, isHappyHorseModel, upstreamCounts.images, id, updateNodeData]);

  const hasPromptText = prompt.trim().length > 0 || upstreamTextJoined.length > 0;
  const hasRequiredMediaForMode =
    genMode === "videoEdit"
      ? upstreamCounts.videos > 0
      : upstreamCounts.images > 0;
  const mediaRejectionReason = videoSubmitMediaRejectionReason(
    genMode,
    selectedVideoModelId,
    upstreamCounts,
  );
  // 媒体目录声明的逐模式素材上限：超了就别让用户点下去白等一次后端 400。
  const selectedModelReferenceError = selectedVideoModelReferenceDisabledReason(
    selectedVideoModel,
    upstreamCounts,
    genMode,
  );
  const submitDisabled =
    isGenerating ||
    videoBillingRuleMissing ||
    !selectedVideoModel ||
    selectedModelReferenceError !== null ||
    mediaRejectionReason != null ||
    (videoModeRequiresPrompt(genMode)
      ? !hasPromptText
      : !hasRequiredMediaForMode);

  const handleSubmit = useCallback(async (): Promise<{ videoUrl?: string }> => {
    if (billingRuleMissingSubmitMessage) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: billingRuleMissingSubmitMessage,
        generationErrorDetails: billingRuleMissingSubmitMessage,
        generationErrorRequestId: null,
      });
      return {};
    }
    if (submitDisabled) return {};
    // 在途守卫（与 ImageGenNode 一致）：第 1 条完成就会清 isGenerating，
    // submitDisabled 拦不住「旧批次 N-1 个任务还在跑时重新提交」——旧闭包
    // 会用过期的 completedUrls 覆写新批次的 generationBatch。
    if (submittingRef.current) return {};
    submittingRef.current = true;
    try {
    const projectId = readUrl().project;
    if (!projectId) {
      console.error("[video-node] no project in URL");
      return {};
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
    const fallbackPrompt = fragment
      ? userPrompt
        ? `${fragment}，${userPrompt}`
        : fragment
      : userPrompt;
    try {
      // 工作流配方节点用配方编译出的最终 prompt；非配方节点回落上面这段拼接。
      const composedPrompt = await compileWorkflowNodePrompt({
        nodeId: id,
        nodeData: data,
        nodeKind: "video",
        nodePrompt: trimmedPrompt,
        upstreamText: upstreamTextJoined,
        upstreamContents,
        fallbackPrompt,
        referenceMedia: referenceMediaCapInfo.map((entry) => ({
          kind: entry.item.kind,
          label: formatReferenceMediaCompilerLabel(entry),
        })),
        onCompileMetadata: ({ mode, prompt: compiledPrompt, recipeIds }) => updateNodeData(id, {
          workflowRecipeCompileMode: mode,
          workflowRecipeCompiledAt: new Date().toISOString(),
          workflowRecipeCompiledPrompt: compiledPrompt,
          prompt: compiledPrompt,
          workflowRecipeIds: recipeIds,
        }),
      });
      // Walk the current edges/nodes once — used by every non-textToVideo
      // branch to collect upstream resources. 必须与 UI 编号侧（useUpstreamNodes）
      // 同源：按连线顺序收集。曾按 state.nodes 顺序（节点创建顺序）收集，先创建
      // 但后连线的节点会排到 references 前面，@图片N 在后端就指向错位的图。
      const collectUpstream = () => {
        const state = useCanvasStore.getState();
        const inputEdges = state.edges.filter((edge) => {
          const edgeData =
            edge.data && typeof edge.data === "object"
              ? edge.data as Record<string, unknown>
              : null;
          return normalizeCanvasEdgeSemanticKind(edgeData?.link_type) !== "dependency_for";
        });
        return sortUpstreamByReferenceOrder(
          upstreamNodesInEdgeOrder(state.nodes, inputEdges, id)
            .filter((node) => !isCompositionTimelineAudioNode(node)),
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
          return {};
        }
        doSubmit = (targetId) =>
          submitFreezoneVideoKeyframes(projectId, {
            firstFrameUrl,
            lastFrameUrl,
            genMode,
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
          return {};
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
        // 视频编辑：1 个源视频 + 0-5 张参考图 → video_url + reference_images。
        // 不再是 HappyHorse 专属 —— 目录里声明了 video_edit 的模型都走这条路，
        // 提交时带的是各自的 catalogId，能力由后端按目录校验。
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
          return {};
        }
        const allImageUrls = collectUpstreamImageUrls();
        // 视频编辑的参考图上限以媒体目录为准（没配就是 5）；超出的静默截断会让
        // 用户以为全用上了。
        const imageLimit = referenceCaps?.image ?? 5;
        if (allImageUrls.length > imageLimit) {
          toast.warning(
            `视频编辑最多支持 ${imageLimit} 张参考图，已使用前 ${imageLimit} 张（忽略其余 ${allImageUrls.length - imageLimit} 张）`,
          );
        }
        const imageUrls = allImageUrls.slice(0, imageLimit);
        const audioLimit = referenceCaps?.audio ?? 0;
        const audioUrls = referenceMedia
          .filter((item) => item.kind === "audio")
          .map((item) => item.audioUrl)
          .slice(0, audioLimit);
        doSubmit = (targetId) =>
          submitFreezoneVideoEdit(projectId, {
            videoUrl,
            imageUrls,
            audioUrls,
            prompt: composedPrompt,
            cameraTemplateId,
            resolution: qualityToResolution(quality),
            audioSetting: "auto",
            generateAudio,
            model: selectedVideoModel?.catalogId ?? modelId,
            genMode,
            modelParams: data.modelParams,
            canvasId,
            nodeId: targetId,
          });
      } else if (genMode === "allReference") {
        if (!isSeedance20Model) {
          void showErrorDialog(
            isHappyHorseModel
              ? "HappyHorse 不支持全能参考模式，请切换为文生视频或图生视频。"
              : "全能参考仅支持 Seedance 2.0 模型，请切换到 Seedance 2.0，或改用「首帧生成视频」。",
            t("common.error"),
          );
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
          });
          return {};
        }
        // Omni-gen: classify each upstream node by its media type.
        // 逐类型上限以媒体目录为准（没配就是 image≤9 / video≤3 / audio≤3）；总数
        // 上限只有在模型自带配置时才按三者之和算，否则沿用后端的硬上限 12。
        const caps = referenceCaps ?? { image: 9, video: 3, audio: 3 };
        const totalReferenceLimit = hasConfiguredReferenceCaps(selectedVideoModel)
          ? caps.image + caps.video + caps.audio
          : 12;
        const upstream = collectUpstream();
        const references: FreezoneVideoReferenceItem[] = [];
        const audioRefs: {
          url: string;
          label: string;
          durationMs: number | null;
        }[] = [];
        const videoRefs: {
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
              videoRefs.push({
                url: videoRefUrl,
                label: t("node.videoNode.referenceDuration.videoFallbackLabel", {
                  index: videoCount + 1,
                }),
                durationMs:
                  typeof node.data.durationMs === "number"
                    ? node.data.durationMs
                    : null,
              });
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
          return {};
        }
        const validateReferenceDurations = async (
          media: "audio" | "video",
          refs: typeof audioRefs,
        ): Promise<boolean> => {
          const configured = referenceDurationLimitsMs(selectedVideoModel, media);
          const limits = {
            minMs:
              configured.minMs ??
              (media === "audio" && isSeedance20Model
                ? MIN_AUDIO_REFERENCE_DURATION_MS
                : undefined),
            maxMs:
              configured.maxMs ??
              (media === "audio" && isSeedance20Model
                ? MAX_AUDIO_REFERENCE_DURATION_MS
                : undefined),
            totalMinMs: configured.totalMinMs,
            totalMaxMs:
              configured.totalMaxMs ??
              (media === "audio" && isSeedance20Model
                ? MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS
                : undefined),
          };
          if (refs.length === 0 || Object.values(limits).every((value) => value == null)) {
            return true;
          }
          const resolvedDurations = await Promise.all(
            refs.map((ref) =>
              typeof ref.durationMs === "number" && ref.durationMs > 0
                ? Promise.resolve(ref.durationMs)
                : media === "audio"
                  ? probeAudioDurationMs(ref.url)
                  : probeVideoDurationMs(ref.url),
            ),
          );
          const rejection = audioReferenceDurationRejection(
            refs.map((ref, index) => ({
              label: ref.label,
              durationMs: resolvedDurations[index] ?? null,
            })),
            {
              minMs: limits.minMs ?? null,
              maxMs: limits.maxMs ?? null,
              totalMinMs: limits.totalMinMs,
              totalLimitMs: limits.totalMaxMs ?? null,
              perClipLimits: limits.minMs != null || limits.maxMs != null,
            },
          );
          if (rejection) {
            const clips = formatAudioDurationClips(rejection.clips, (key, vars) =>
              t(key, vars),
            );
            const prefix =
              media === "audio"
                ? "node.videoNode.audio"
                : "node.videoNode.referenceDuration";
            const message =
              rejection.kind === "tooShort"
                ? t(`${prefix}.${media === "audio" ? "durationTooShort" : "videoTooShort"}`, {
                    min: formatAudioDurationSeconds(limits.minMs ?? 0),
                    clips,
                  })
                : rejection.kind === "tooLong"
                  ? t(`${prefix}.${media === "audio" ? "durationTooLong" : "videoTooLong"}`, {
                      max: formatAudioDurationSeconds(limits.maxMs ?? 0),
                      clips,
                    })
                  : rejection.kind === "totalTooShort"
                    ? t(
                        `${prefix}.${media === "audio" ? "durationTotalTooShort" : "videoTotalTooShort"}`,
                        {
                          min: formatAudioDurationSeconds(rejection.limitMs),
                          total: formatAudioDurationSeconds(rejection.totalMs),
                          clips,
                        },
                      )
                    : t(
                        `${prefix}.${media === "audio" ? "durationTotalTooLong" : "videoTotalTooLong"}`,
                        {
                          max: formatAudioDurationSeconds(rejection.limitMs),
                          total: formatAudioDurationSeconds(rejection.totalMs),
                          clips,
                        },
                      );
            toast.error(message, { duration: 5_000 });
            updateNodeData(id, {
              isGenerating: false,
              generationStartedAt: null,
            });
            return false;
          }
          return true;
        };
        if (!(await validateReferenceDurations("audio", audioRefs))) return {};
        if (!(await validateReferenceDurations("video", videoRefs))) return {};
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
        return {};
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
      updateNodeData(id, CLEARED_GENERATION_TASK_FIELDS);
      // 整批结束后再决定错误反馈：
      //  - 一条都没成功 → 弹一次错误框（含真人素材被拦截的专用引导）；
      //  - 部分成功 → 不弹模态打断，仅用轻量 toast 告知少出了几条。
      // 这样「N 条里 1 条命中队列上限秒失败、其余正常在跑」时不会再出现
      // 「先弹上限报错、节点却又冒出加载动画」的矛盾观感。
      if (completedUrls.length === 0 && runErrors.length > 0) {
        const firstError = runErrors[0];
        const resolved = resolveErrorContent(firstError, "视频生成失败");
        const displayErrorMessage = backendErrorToastMessage(firstError, t);
        const diagnostics = resolveGenerationErrorDiagnostics(firstError, resolved.details);
        const haystack = `${displayErrorMessage}\n${diagnostics.details ?? ""}`;
        if (
          haystack.includes("InputImageSensitiveContentDetected.PrivateInformation")
          || haystack.includes("InputImageSensitiveContentDetected.PrivacyInformation")
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
      onGenerationSettled?.();
      return completedUrls[0] ? { videoUrl: completedUrls[0] } : {};
    } catch (error) {
      console.error("[video-node] video gen failed", error);
      updateNodeData(id, CLEARED_GENERATION_TASK_FIELDS);
      setAlbumPendingTotal(id, 0);
    }
    } finally {
      submittingRef.current = false;
    }
    return {};
  }, [
    aspectRatio,
    submitAspectRatio,
    cameraMovementId,
    cameraMovementPreset,
    count,
    data,
    referenceMediaCapInfo,
    upstreamContents,
    durationBounds,
    durationSec,
    generateAudio,
    genMode,
    humanReview,
    id,
    isSeedance20Model,
    supportsHumanReview,
    modelId,
    selectedVideoModel,
    referenceCaps,
    prompt,
    quality,
    onGenerationSettled,
    sceneOptimize,
    billingRuleMissingSubmitMessage,
    submitDisabled,
    updateNodeData,
    upstreamTextJoined,
  ]);

  // 换模型不是一次纯 patch，故不下沉到表单组件：新模型不支持当前 genMode 时
  // （如 HappyHorse 专属的 videoEdit 切到普通模型）要重置为通用安全值
  // textToVideo，让状态机按新模型 + 上游重新推导；否则残留模式会在提交时打到
  // 不支持的端点被后端 400（界面还停在错误的 tab）。顺带记住这次选择，后续新建
  // 的视频节点将继承它。
  const handleModelChange = useCallback(
    (nextModelId: string) => {
      // 传模型对象而非裸 id：媒体目录声明了 supportedModes 时以它为准，
      // 落回能力推断只是没配置时的兜底。
      const resetGenMode =
        data.genMode != null &&
        !isVideoModeSupportedByModel(
          data.genMode,
          availableVideoModels.find((item) => item.id === nextModelId),
        );
      updateNodeData(id, {
        model: nextModelId,
        // 换模型必须清空 modelParams：参数表是按模型声明的，留着上一个模型的键
        // 会原样发给后端，轻则被忽略重则报参数不合法。
        modelParams: {},
        ...(resetGenMode ? { genMode: "textToVideo" as VideoGenMode } : {}),
      });
      writeLastVideoModel(nextModelId);
    },
    [availableVideoModels, data.genMode, id, updateNodeData],
  );

  // 表单按钮只需要 `() => void`；异步编排仍在本 hook 里。
  const handleTranslate = useCallback(() => {
    void handleTranslatePrompt();
  }, [handleTranslatePrompt]);
  const handleGenerateClick = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  return {
    formProps: {
      nodeId: id,
      cameraTemplates,
      cameraTemplatesLoading,
      cameraMovementId,
      genMode,
      genModeModelId: selectedVideoModelId,
      genModeSupportedModes: selectedVideoModel?.supportedModes,
      // HappyHorse 的可选模式由上游节点类型（含未填图的空节点）决定，
      // 其余模型仍按已解析素材 URL 计数。
      genModeUpstreamCounts: isHappyHorseModel ? upstreamTypeCounts : upstreamCounts,
      upstreamTextContents,
      onDetachUpstream: handleDetachUpstream,
      referenceMediaItems: referenceMediaCapInfo,
      referenceCaps,
      prompt: promptDraft,
      onPromptChange: handlePromptChange,
      onCompositionStart: handlePromptCompositionStart,
      onCompositionEnd: handlePromptCompositionEnd,
      mentionCandidates,
      upstreamTextJoined,
      modelId,
      onModelChange: handleModelChange,
      modelUpstreamCounts: {
        images: upstreamCounts.images,
        videos: upstreamTypeCounts.videos,
        audios: upstreamTypeCounts.audios,
      },
      aspectRatio,
      aspectRatioOptions,
      quality,
      qualityOptions,
      durationSec,
      durationBounds,
      sceneOptimize,
      sceneOptimizeOptions,
      generateAudio,
      showHumanReview: supportsHumanReview,
      humanReview,
      modelParameters: selectedVideoModel?.request?.parameters,
      modelParams: data.modelParams,
      count,
      isTranslatingPrompt,
      isGenerating,
      // 翻译门槛看的是**已落库的** prompt（data.prompt），不是编辑器草稿——
      // IME 合成途中草稿已有字符但还没写回 store，此时按钮仍应保持禁用。
      translateDisabled:
        isTranslatingPrompt || isGenerating || prompt.trim().length === 0,
      onTranslate: handleTranslate,
      totalCreditCostDisplay,
      creditPromotion,
      submitDisabled,
      // 素材超限的提示优先于「素材类型不支持」：前者是用户刚拖多了、改得动的。
      submitDisabledReason:
        billingRuleMissingSubmitMessage ??
        selectedModelReferenceError ??
        mediaRejectionReason,
      onSubmit: handleGenerateClick,
    },
    isGenerating,
    submitDisabled,
    submit: handleSubmit,
    prompt,
    quality,
    selectedVideoModelId,
    upstreamCounts,
  };
}
