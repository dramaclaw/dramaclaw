// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Film,
  Languages,
  Library,
  Loader2,
  Music,
  Pause,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  CANVAS_NODE_TYPES,
  type Seedance2SceneOptimize,
  type VideoGenCount,
  type VideoGenMode,
  type VideoGenQuality,
  type VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { formatResolutionLabel } from "@/features/canvas/domain/mediaModelOptions";
import {
  isHappyHorseVideoModel,
  isVideoModeSupportedByModel,
  videoModeForcesAutomaticAspectRatio,
  videoModelDefaultGenerateAudio,
  videoModelReferenceDisabledReason,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { VIDEO_FILE_ACCEPT } from "@/features/canvas/application/videoFileTypes";
import { spawnExternalAssetNodes } from "@/features/canvas/application/spawnExternalAssets";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import type { UpstreamContent } from "@/features/canvas/application/ports";
import { ReferenceTextChip } from "@/features/canvas/nodes/shared/ReferenceTextChip";
import { ReferenceDetachButton } from "@/features/canvas/nodes/shared/ReferenceDetachButton";
import { ReferencePickChip } from "@/features/canvas/nodes/shared/ReferencePickChip";
import { ReferenceMentionButton } from "@/features/canvas/nodes/shared/ReferenceMentionButton";
import { focusReferenceNode } from "@/features/canvas/application/viewportReturnStore";
import { collectReferenceMaterials } from "@/features/canvas/application/referencePick";
import { attachReferenceEdge } from "@/features/canvas/application/attachReference";
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
import { PanelExpandButton } from "@/features/canvas/ui/PanelExpandButton";
import { OperationPanelShell } from "@/features/canvas/ui/OperationPanelShell";
import {
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
} from "@/features/canvas/ui/nodeFrameStyles";
import {
  filterMediaModelParamsForMode,
  MediaModelParameterChip,
} from "@/features/canvas/ui/MediaModelParameterChip";
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
import { CameraMovementPickerPopover } from "@/features/canvas/nodes/CameraMovementPickerPopover";
import {
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from "@/features/canvas/ui/AssetLibraryModal";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
  type FreezoneVideoAspectRatio,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { useModelTaskAccess } from "@/lib/model-task-access";
import { readUrl } from "@/lib/url-params";
import {
  ProviderModelPicker,
  type ModelOption,
} from "@/features/canvas/ui/ProviderModelPicker";
import { writeLastVideoModel } from "@/features/canvas/domain/lastVideoModel";
import { CreditCostPill } from "@/components/credits/credit-visual";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import {
  ASPECT_RATIOS,
  clampVideoDuration,
  DEFAULT_HEIGHT,
  OPERATIONS_PANEL_GAP,
  OPERATIONS_PANEL_HEIGHT,
  OPERATIONS_PANEL_OVERHANG,
  qualityToResolution,
  VIDEO_GENERATE_FEATURE_KEY,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/VideoNode";


// 「放大」后用居中弹窗展示，给提示词编辑更舒适的空间。
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_WIDTH = 1040;

const MODE_TABS: ReadonlyArray<{ key: VideoGenMode; labelKey: string }> = [
  { key: "textToVideo", labelKey: "node.videoNode.tabs.textToVideo" },
  { key: "allReference", labelKey: "node.videoNode.tabs.allReference" },
  { key: "firstFrame", labelKey: "node.videoNode.tabs.firstFrame" },
  { key: "imageToVideo", labelKey: "node.videoNode.tabs.imageToVideo" },
  { key: "firstLastFrame", labelKey: "node.videoNode.tabs.firstLastFrame" },
  { key: "imageReference", labelKey: "node.videoNode.tabs.imageReference" },
  { key: "videoEdit", labelKey: "node.videoNode.tabs.videoEdit" },
];

// HappyHorse 的入口顺序：文生视频 → 首帧 → 图生视频 → 图片参考 → 视频编辑。
const HAPPYHORSE_TAB_ORDER: ReadonlyArray<VideoGenMode> = [
  "textToVideo",
  "firstFrame",
  "imageToVideo",
  "imageReference",
  "videoEdit",
];

const COUNT_OPTIONS: ReadonlyArray<VideoGenCount> = [1, 2, 4];
const VIDEO_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[320px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const VIDEO_PARAM_LABEL_CLASS =
  "mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-dark/72";
const VIDEO_PARAM_BUTTON_BASE_CLASS =
  "inline-flex items-center justify-center rounded px-2 py-2 text-xs transition-colors";
const VIDEO_PARAM_ACTIVE_BUTTON_CLASS =
  "bg-white/[0.13] text-text-dark ring-1 ring-white/24";
const VIDEO_PARAM_IDLE_BUTTON_CLASS =
  "bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark";
const VIDEO_PARAM_ROW_CLASS = "mb-4 gap-2";
const VIDEO_COUNT_OPTION_BASE_CLASS =
  "block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors";
const VIDEO_MODE_POPOVER_CLASS =
  `nodrag nowheel fixed z-[10000] w-[132px] overflow-visible p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
// 禁用模式的 hover 提示气泡：悬浮在菜单右侧，深色圆角小胶囊，与设计稿一致。
const VIDEO_MODE_TOOLTIP_CLASS =
  "pointer-events-none absolute left-full top-1/2 z-[10001] ml-2 -translate-y-1/2 " +
  "whitespace-nowrap rounded-md bg-[#1f1f22] px-2.5 py-1.5 text-[11px] font-medium " +
  "text-white/90 shadow-lg ring-1 ring-white/10";

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

interface VideoOperationsPanelProps {
  id: string;
  data: VideoNodeData;
  genMode: VideoGenMode;
  modelId: string;
  selectedVideoModel: ModelOption | undefined;
  availableVideoModels: ModelOption[];
  isHappyHorseModel: boolean;
  upstreamCounts: { images: number; videos: number; audios: number };
  upstreamTypeCounts: { images: number; videos: number; audios: number };
  upstreamContents: UpstreamContent[];
  upstreamTextJoined: string;
  referenceMedia: ReferenceMediaItem[];
  referenceCaps: { image: number; video: number; audio: number } | null;
  cameraTemplates: ReadonlyArray<CameraMovementPreset>;
  cameraTemplatesLoading: boolean;
  configuredAspectRatios: string[];
  aspectRatio: FreezoneVideoAspectRatio;
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize: Seedance2SceneOptimize | undefined;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  supportsGenerateAudio: boolean;
  generateAudio: boolean;
  supportsHumanReview: boolean;
  humanReview: boolean;
  count: VideoGenCount;
  prompt: string;
  isGenerating: boolean;
  /** 估价用的后端模型 ID；模型目录加载中 / fallback 时为 null（暂不发估价请求）。 */
  videoBackendForCost: string | null;
  videoInputPresent: boolean;
  videoInputBillingReady: boolean;
  inputVideoDurationSeconds: number;
  submitDisabled: boolean;
  selectedModelReferenceError: string | null;
  mediaRejectionReason: string | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onSubmit: () => Promise<void>;
}

export function VideoOperationsPanel({
  id,
  data,
  genMode,
  modelId,
  selectedVideoModel,
  availableVideoModels,
  isHappyHorseModel,
  upstreamCounts,
  upstreamTypeCounts,
  upstreamContents,
  upstreamTextJoined,
  referenceMedia,
  referenceCaps,
  cameraTemplates,
  cameraTemplatesLoading,
  configuredAspectRatios,
  aspectRatio,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  supportsGenerateAudio,
  generateAudio,
  supportsHumanReview,
  humanReview,
  count,
  prompt,
  isGenerating,
  videoBackendForCost,
  videoInputPresent,
  videoInputBillingReady,
  inputVideoDurationSeconds,
  submitDisabled,
  selectedModelReferenceError,
  mediaRejectionReason,
  expanded,
  onExpandedChange,
  onSubmit,
}: VideoOperationsPanelProps) {
    const { t } = useTranslation();
    // `submitDisabled` already carries the org admission block from VideoNode;
    // this is only for the button's title, so a blocked member is told why.
    const modelTaskAccess = useModelTaskAccess();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const deleteEdge = useCanvasStore((state) => state.deleteEdge);
    // 与 inputRef 分开:那个是「替换本节点自身的视频」(单选、只收视频),
    // 这个是「添加上游外部素材」(多选、收图片/视频/音频)。
    const externalAssetInputRef = useRef<HTMLInputElement>(null);
    const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
    const [isCharacterLibraryOpen, setIsCharacterLibraryOpen] = useState(false);
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
    // 卸载前的 IME 合成兜底：合成进行中取消选中会直接卸载本面板，
    // onCompositionEnd 再也没有机会触发，最新草稿只存在于本地 state。
    // 用 ref 镜像 draft，卸载 cleanup 里发现仍在合成就把它落回 data.prompt。
    const promptDraftRef = useRef(promptDraft);
    promptDraftRef.current = promptDraft;
    useEffect(
      () => () => {
        if (!isComposingRef.current) return;
        isComposingRef.current = false;
        updateNodeData(id, { prompt: promptDraftRef.current });
      },
      [id, updateNodeData],
    );
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
    const aspectRatioOptions = useMemo(() => {
      return configuredAspectRatios.length > 0 ? configuredAspectRatios : ASPECT_RATIOS;
    }, [configuredAspectRatios]);
    const cameraMovementId =
      typeof data.cameraMovement === "string" ? data.cameraMovement : null;
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
      videoInputPresent,
      350,
    );
    const debouncedInputVideoDuration = useDebouncedValue(
      inputVideoDurationSeconds,
      350,
    );
    const videoCount = Math.min(Math.max(debouncedCount, 1), 4);
    const videoPricingQuantity =
      videoCount *
      (genMode === "videoEdit"
        ? Math.max(Math.floor(debouncedInputVideoDuration), 1)
        : debouncedDurationSec);
    const videoCreditCost = useGenerationCreditCost(
      "feature",
      debouncedBackend && videoInputBillingReady
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
    const totalCreditCostDisplay =
      videoCreditCost.data?.data.display ??
      (videoBillingRuleMissing
        ? t("common.billingRuleNotConfiguredShort")
        : null);
    // 给每个 referenceMedia 条目补上「同类型序号 + 是否在当前模式上限内」。
    // 当前 genMode 在 REFERENCE_CAPS_BY_MODE 里没有条目（如 textToVideo /
    // imageToVideo / imageReference），统一按 within=true 处理；下游 chip /
    // mention 候选会决定是否消费 within。
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
    // 在 REFERENCE_CAPS_BY_MODE 表里有条目的模式，超过 cap 的条目不能进
    // @ 候选 —— 服务端会直接丢弃，留在候选里只会让用户选了之后被静默忽略。
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

    // 引用缩略图右下角的 @ 按钮：把这条引用按它当前的编号插进提示词。编号是
    // mentionCandidates 算好的（图片 / 视频 / 音频各自计数），用户不必自己数。
    const mentionNameByNodeId = useMemo(() => {
      const map = new Map<string, string>();
      for (const candidate of mentionCandidates) map.set(candidate.key, candidate.name);
      return map;
    }, [mentionCandidates]);
    const handleMentionReference = useCallback(
      (nodeId: string) => {
        const candidate = mentionCandidates.find((item) => item.key === nodeId);
        if (!candidate) return;
        promptEditorRef.current?.insertMentionAtCursor(candidate);
      },
      [mentionCandidates],
    );
    // 双击引用 → 视口跳到那个上游节点，并在底部留下「返回节点」。
    const handleJumpToReference = useCallback(
      (nodeId: string) => {
        focusReferenceNode(nodeId, id);
      },
      [id],
    );

    // 替换选单的「素材引用」段：画布上还没连过来的素材。已引用的排除掉——它们
    // 已经在上面那段里了，同一条出现两次只会让人以为是两个东西。按**边**排除，
    // 连着但还没出内容的上游节点也算已引用（否则选中它只是对同一条边再建一次）。
    //
    // 打开选单时才算：这份清单要扫全画布，常驻订阅的话画布上拖任何一个节点都会
    // 让这个面板每帧重算一遍。
    const getMentionMaterials = useCallback(() => {
      const store = useCanvasStore.getState();
      const attached = new Set(
        store.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
      );
      return collectReferenceMaterials(store.nodes, id, CANVAS_NODE_TYPES.video, attached);
    }, [id]);
    // 选中一条画布素材：连成上游即可——引用行、@ 候选编号都由上游推导链路跟上，
    // 编辑器那边等它出现在候选里再把 @ 换过去。被拒（素材上限）时
    // attachReferenceEdge 已经弹过原因，这里把结果回给编辑器，让它别空等。
    const handleAttachMaterial = useCallback(
      (sourceNodeId: string) => attachReferenceEdge(sourceNodeId, id),
      [id],
    );

    const upstreamTextContents = useMemo(
      () =>
        upstreamContents.filter(
          (c) => typeof c.text === "string" && c.text.trim().length > 0,
        ),
      [upstreamContents],
    );

    // Spawn reference nodes from selected asset-library entries — one per
    // selection, stacked vertically to the left of this video node, then wired
    // as upstream references so they show up in the operations panel. The node
    // type depends on the media: images/videos become upload nodes carrying
    // imageUrl/videoUrl, audio becomes an audio node carrying audioUrl.
    const spawnCharacterLibraryReferences = useCallback(
      (selections: ReadonlyArray<AssetLibrarySelection>) => {
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
          const displayName = sel.name || undefined;
          let newId: string;
          if (sel.media === "audio") {
            newId = addNode(
              CANVAS_NODE_TYPES.audio,
              { x: baseX, y },
              { audioUrl: sel.url, displayName },
            );
          } else if (sel.media === "video") {
            // 资产库视频作为「上游视频引用素材」：建 referenceOnly 的 video 节点，
            // 它能播放视频本体、被 isVideoNode 识别、下游自动切 videoEdit。之前建的是
            // 只渲染图片的 upload 节点——即便塞了 videoUrl 也不显示、也不被识别成视频。
            newId = addNode(
              CANVAS_NODE_TYPES.video,
              { x: baseX, y },
              {
                videoUrl: sel.url,
                aspectRatio: data.aspectRatio,
                displayName,
                referenceOnly: true,
              } as Partial<VideoNodeData>,
            );
          } else {
            newId = addNode(
              CANVAS_NODE_TYPES.upload,
              { x: baseX, y },
              {
                imageUrl: sel.url,
                previewImageUrl: sel.url,
                displayName,
              },
            );
          }
          addEdge(newId, id);
          newIds.push(newId);
        });
        state.autoGroupSpawn(id, newIds, { label: '资产参考组' });
      },
      [addEdge, addNode, data.aspectRatio, id],
    );

    const handleExternalAssetFiles = useCallback(
      (event: ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        // 先清空,好让用户能连续两次选同一个文件(否则 change 不触发)。
        event.target.value = "";
        if (files.length === 0) return;
        const state = useCanvasStore.getState();
        const self = state.nodes.find((n) => n.id === id);
        // 节点可能在文件选择器打开期间被删掉了。
        if (!self) return;
        spawnExternalAssetNodes(
          {
            id,
            position: self.position,
            // measured 优先、再退 data.height —— 对齐 store duplicateNodeAsSibling
            // (canvasStore.ts:1600)的口径 measured?.height ?? height ?? fallback。
            // 只读 data.height 会漏掉「已重新测量但没写死 height」的常见节点,把整列
            // 排偏(节点实高 280、却按 fallback 380 居中,下移约 50px)。spawn 侧对
            // undefined/0 仍兜底成 380。
            height: self.measured?.height ?? self.height ?? undefined,
          },
          files,
          {
            addNode,
            addEdge,
            // canvasEventBus.publish 是原型方法、用到 this,不能裸传。
            publish: (type, payload) => canvasEventBus.publish(type, payload),
            autoGroupSpawn: (sourceId, spawnedIds, opts) =>
              state.autoGroupSpawn(sourceId, spawnedIds, opts),
          },
        );
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
        await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
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

    // 收起态浮动面板固定基础尺寸；放大用居中弹窗（见下方 OperationPanelShell）。
    const panelHeight = OPERATIONS_PANEL_HEIGHT;
    const panelOverhang = OPERATIONS_PANEL_OVERHANG;

    return (
      <>
            <OperationPanelShell
              expanded={expanded}
              onCollapse={() => onExpandedChange(false)}
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
                expanded={expanded}
                onToggle={() => onExpandedChange(!expanded)}
                className="absolute right-2 top-2 z-20"
              />
              <div className="flex shrink-0 items-center overflow-x-auto px-3 pb-2 pr-10 pt-3">
                <div className="flex shrink-0 items-center gap-2">
                  <ReferencePickChip
                    nodeId={id}
                    nodeType={CANVAS_NODE_TYPES.video}
                    onPickExternal={() => externalAssetInputRef.current?.click()}
                  />
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
                    modelId={selectedVideoModel?.apiModel ?? selectedVideoModel?.id ?? modelId}
                    supportedModes={selectedVideoModel?.supportedModes}
                    // HappyHorse 的可选模式由上游节点类型（含未填图的空节点）决定，
                    // 其余模型仍按已解析素材 URL 计数。
                    upstreamCounts={
                      isHappyHorseModel ? upstreamTypeCounts : upstreamCounts
                    }
                    onChange={(nextMode) =>
                      updateNodeData(id, {
                        genMode: nextMode,
                        modelParams: filterMediaModelParamsForMode(
                          selectedVideoModel?.request?.parameters,
                          data.modelParams,
                          nextMode,
                        ),
                      })
                    }
                  />
                  <NodeContextPromptPaletteButton
                    nodeId={id}
                    onInsert={insertContextPaletteEntry}
                  />
                </div>
              </div>

              {/* 引用素材单独占一行：顶排功能 chip 已经排满，素材再挤进去会顶掉输入区。 */}
              {(upstreamTextContents.length > 0 || referenceMedia.length > 0) && (
                <div className="nowheel flex shrink-0 items-center gap-3 overflow-x-auto px-3 pb-2">
                  {upstreamTextContents.map((content) => (
                    <ReferenceTextChip
                      key={`upstream-text-${content.nodeId}`}
                      nodeId={content.nodeId}
                      text={content.text ?? ""}
                      sourceLabel={content.displayName ?? content.nodeType}
                      onDetach={handleDetachUpstream}
                      onJump={handleJumpToReference}
                    />
                  ))}
                  {referenceMedia.length > 0 && (
                    <ReferenceMediaRow
                      items={referenceMediaCapInfo}
                      caps={referenceCaps}
                      genMode={genMode}
                      mentionNames={mentionNameByNodeId}
                      onFocus={(nodeId) => setSelectedNode(nodeId)}
                      onMention={handleMentionReference}
                      onJump={handleJumpToReference}
                      onDetach={handleDetachUpstream}
                      onReorder={(ids) =>
                        updateNodeData(id, { referenceOrder: ids })
                      }
                    />
                  )}
                </div>
              )}

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
                getMaterials={getMentionMaterials}
                onAttachMaterial={handleAttachMaterial}
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
                      const nextModel = availableVideoModels.find(
                        (item) => item.id === nextModelId,
                      );
                      // 切换模型后，若当前 genMode 不被新模型支持（如 HappyHorse
                      // 专属的 videoEdit 切到普通模型），重置为通用安全值 textToVideo，
                      // 让状态机按新模型 + 上游重新推导；否则残留模式会在提交时打到
                      // 不支持的端点被后端 400（界面还停在错误的 tab）。
                      const resetGenMode =
                        data.genMode != null &&
                        !isVideoModeSupportedByModel(
                          data.genMode,
                          nextModel,
                        );
                      updateNodeData(id, {
                        model: nextModelId,
                        modelParams: {},
                        generateAudio: videoModelDefaultGenerateAudio(nextModel),
                        ...(resetGenMode
                          ? { genMode: "textToVideo" as VideoGenMode }
                          : {}),
                      });
                      // 记住这次选择，后续新建的视频节点将继承它。
                      writeLastVideoModel(nextModelId);
                    }}
                    domain="video"
                    popoverPlacement="top"
                    getOptionDisabledReason={(model) =>
                      // 传整个 ModelOption,不要塌成 id —— 能力口径以后台「媒体模型」
                      // 声明的 supportedModes 为准,只传 id 会退到启发式,把目录里的
                      // 改动整个丢掉(例如后台下掉 HappyHorse 的视频编辑后,它在这里
                      // 依然可选,选进去所有模式都是灰的、提交也被拦)。与 VideoNode
                      // 的提交守卫同源。
                      videoModelReferenceDisabledReason(model, {
                        images: upstreamCounts.images,
                        // 视频 / 音频必须和自动切模型的 effect 同一口径（按节点类型，
                        // 空节点也算）。若这里用「已解析 URL」口径，连着空视频节点时
                        // 1.x 不置灰、用户能选回去，又被 effect 立刻切走，来回打架。
                        videos: upstreamTypeCounts.videos,
                        audios: upstreamTypeCounts.audios,
                      })
                    }
                  />
                  <VideoConfigChip
                    followInputAspectRatio={videoModeForcesAutomaticAspectRatio(genMode)}
                    followInputDuration={genMode === "videoEdit"}
                    aspectRatio={aspectRatio}
                    aspectRatioOptions={aspectRatioOptions}
                    quality={quality}
                    qualityOptions={qualityOptions}
                    durationSec={durationSec}
                    durationBounds={durationBounds}
                    sceneOptimize={sceneOptimize}
                    sceneOptimizeOptions={sceneOptimizeOptions}
                    supportsGenerateAudio={supportsGenerateAudio}
                    generateAudio={generateAudio}
                    onChange={(patch) => updateNodeData(id, patch)}
                  />
                  <MediaModelParameterChip
                    parameters={selectedVideoModel?.request?.parameters}
                    values={data.modelParams}
                    mode={genMode}
                    onChange={(modelParams) => updateNodeData(id, { modelParams })}
                  />
                  {supportsHumanReview && (
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
                    promotion={videoCreditCost.data?.data.promotion}
                    disabled={submitDisabled || videoBillingRuleMissing}
                    className={NODE_CREDIT_PILL_FLAT_CLASS}
                  />
                  <button
                    type="button"
                    disabled={submitDisabled || videoBillingRuleMissing}
                    title={
                      selectedModelReferenceError ?? (isGenerating
                        ? t("node.videoNode.submitBusy")
                        : (modelTaskAccess.message ?? mediaRejectionReason ??
                          t("node.videoNode.submit")))
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      void onSubmit();
                    }}
                    className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                      submitDisabled || videoBillingRuleMissing
                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                        : NODE_GENERATE_BUTTON_ENABLED_CLASS
                    }`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </OperationPanelShell>
        <input
          ref={externalAssetInputRef}
          type="file"
          multiple
          accept={`image/*,${VIDEO_FILE_ACCEPT},audio/*`}
          className="hidden"
          onChange={handleExternalAssetFiles}
        />

        <AssetLibraryModal
          mode="pick"
          open={isCharacterLibraryOpen}
          project={readUrl().project ?? null}
          onClose={() => setIsCharacterLibraryOpen(false)}
          onConfirm={(selections) =>
            spawnCharacterLibraryReferences(selections)
          }
        />
      </>
    );
}

interface GenModeSelectProps {
  value: VideoGenMode;
  modelId: string | null | undefined;
  supportedModes?: string[];
  upstreamCounts: { videos: number; images: number; audios: number };
  onChange: (next: VideoGenMode) => void;
}

export function videoModeDisabledReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  upstreamCounts: { videos: number; images: number; audios: number },
  supportedModes?: string[],
): string | null {
  // HappyHorse 的模式可用性完全由上游节点类型决定（文档 4 大功能）：
  //   文生视频  — 仅无上游时可用
  //   首帧/图生视频 — 仅上游正好 1 张图片时可用
  //   图片参考  — 上游 1~9 张图片时可用
  //   视频编辑  — 仅上游有 1 个视频时可用
  // 不可用时返回 hover 文案（提示用户需要连接什么）。
  if (isHappyHorseVideoModel(modelId)) {
    const { images, videos } = upstreamCounts;
    switch (mode) {
      case "textToVideo":
        if (videos > 0) return "已连接视频节点，请使用「视频编辑」";
        if (images > 0) return "已连接图片节点，请选择「首帧」「图生视频」或「图片参考」";
        return null;
      case "imageToVideo":
      case "firstFrame":
        if (videos > 0) {
          return mode === "firstFrame"
            ? "已连接视频节点，「首帧」不可用"
            : "已连接视频节点，「图生视频」不可用";
        }
        if (images === 0) return "需要连接图片节点（1个）";
        if (images > 1) {
          return mode === "firstFrame"
            ? "「首帧」仅支持单张图片"
            : "「图生视频」仅支持单张图片，请用「图片参考」";
        }
        return null;
      case "imageReference": // 图片参考 (r2v)
        if (videos > 0) return "已连接视频节点，「图片参考」不可用";
        if (images === 0) return "需要连接图片节点（1~9个）";
        if (images > 9) return "「图片参考」最多支持 9 张图片";
        return null;
      case "videoEdit":
        if (videos === 0) return "需要连接视频节点（1个）";
        if (videos > 1) return "「视频编辑」仅支持连接 1 个视频节点";
        return null;
      default:
        return "HappyHorse 不支持该模式";
    }
  }
  // 「视频编辑」以上游视频**为输入**，不能被下面那条「有视频就只剩全能参考」连坐。
  // 它和「全能参考」是仅有的两个消费视频素材的模式 —— 提交守卫
  // `videoSubmitMediaRejectionReason` 早就写着 `mode !== "allReference" && mode !==
  // "videoEdit"`，这里漏了同一条豁免。视频编辑一度是 HappyHorse 专属（见
  // `isVideoModeSupportedByModel` 的注释），后来目录里的 seedance-2.0-mini 这类模型
  // 也声明了 `video_edit`，tab 露出来了、却被这条旧规则一并置灰，于是「接上视频想切
  // 视频编辑」被自己挡死。
  const model = supportedModes?.length
    ? { apiModel: modelId ?? undefined, supportedModes }
    : modelId;
  const supportsVideoEdit = isVideoModeSupportedByModel("videoEdit", model);
  if (mode === "videoEdit") {
    if (!supportsVideoEdit) return "该模型不支持「视频编辑」";
    if (upstreamCounts.videos === 0) return "需要连接视频节点（1个）";
    if (upstreamCounts.videos > 1) return "「视频编辑」仅支持连接 1 个视频节点";
    return null;
  }
  if (upstreamCounts.videos > 0 && mode !== "allReference") {
    return supportsVideoEdit
      ? "上游含视频素材时只能用「全能参考」或「视频编辑」"
      : "上游含视频素材时只能用「全能参考」";
  }
  if (
    mode === "textToVideo" &&
    (upstreamCounts.images > 0 || upstreamCounts.audios > 0)
  ) {
    return "已引用图片/音频素材时不可用";
  }
  if ((mode === "firstFrame" || mode === "imageToVideo") && upstreamCounts.images > 1) {
    return mode === "firstFrame" ? "「首帧」仅支持单张图片" : "「图生视频」仅支持单张图片";
  }
  if (mode === "firstLastFrame" && upstreamCounts.images > 2) {
    return "上游图片超过 2 张时不可用";
  }
  return null;
}

function GenModeSelect({ value, modelId, supportedModes, upstreamCounts, onChange }: GenModeSelectProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<VideoGenMode | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // HappyHorse 的模式面板把首帧与单图整体参考拆成独立入口。
  //   - 隐藏「首尾帧」「全能参考」：HappyHorse 无这两种能力，点了只会报错。
  //   - 首帧与图生视频是两个独立模式：前者锁定第一帧，后者把单图作为整体参考。
  //   - 上游接入视频后，图片类入口隐藏，只保留「文生视频」(禁用) 与「视频编辑」。
  // 非 HappyHorse 不暴露「视频编辑」(它是 HappyHorse 专属功能)。
  const visibleTabs = useMemo(() => {
    if (supportedModes?.length) {
      const configuredModel = { apiModel: modelId ?? undefined, supportedModes };
      return MODE_TABS.filter((tab) => isVideoModeSupportedByModel(tab.key, configuredModel));
    }
    if (!isHappyHorseVideoModel(modelId)) {
      // 按模型能力过滤，而非「非 HappyHorse 一律给全部」：Seedance 1.x 不支持
      // 全能参考(400)与真尾帧首尾帧(静默丢尾帧)，这两个 tab 对它不可见。
      return MODE_TABS.filter((tab) => isVideoModeSupportedByModel(tab.key, modelId));
    }
    const order =
      upstreamCounts.videos > 0
        ? (["textToVideo", "videoEdit"] as VideoGenMode[])
        : HAPPYHORSE_TAB_ORDER;
    return order
      .map((key) => MODE_TABS.find((tab) => tab.key === key))
      .filter((tab): tab is (typeof MODE_TABS)[number] => Boolean(tab));
  }, [modelId, supportedModes, upstreamCounts.videos]);
  const activeTab = visibleTabs.find((tab) => tab.key === value) ?? visibleTabs[0];

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
    if (!isOpen) {
      setHoveredKey(null);
      return;
    }
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
          {visibleTabs.map((tab) => {
            const isActive = tab.key === value;
            const disabledReason = videoModeDisabledReason(
              tab.key,
              modelId,
              upstreamCounts,
              supportedModes,
            );
            const isDisabled = disabledReason != null && !isActive;
            // 禁用按钮在多数浏览器里不触发 mouse 事件，hover 提示挂在外层 div 上；
            // 提示气泡定位到菜单右侧，与设计稿一致。
            return (
              <div
                key={tab.key}
                className="relative"
                onMouseEnter={() =>
                  isDisabled ? setHoveredKey(tab.key) : setHoveredKey(null)
                }
                onMouseLeave={() =>
                  setHoveredKey((prev) => (prev === tab.key ? null : prev))
                }
              >
                <button
                  type="button"
                  disabled={isDisabled}
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
                {isDisabled && hoveredKey === tab.key && disabledReason && (
                  <div className={VIDEO_MODE_TOOLTIP_CLASS}>{disabledReason}</div>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface VideoConfigChipProps {
  followInputAspectRatio: boolean;
  followInputDuration: boolean;
  aspectRatio: FreezoneVideoAspectRatio;
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  supportsGenerateAudio: boolean;
  generateAudio: boolean;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function VideoConfigChip({
  followInputAspectRatio,
  followInputDuration,
  aspectRatio,
  aspectRatioOptions,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  supportsGenerateAudio,
  generateAudio,
  onChange,
}: VideoConfigChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Local draft for the direct-entry duration box. The field stays free text
  // while editing so a half-typed value isn't fought by clamping, but we still
  // want the slider and bottom chip to track the box live — so on each keystroke
  // we commit as soon as the draft is a *complete integer already inside* the
  // model's bounds. An out-of-range interim (the "1" of "12" when min is 5) is
  // held as draft only and NOT committed, so the user is never stranded at the
  // min mid-typing; blur/Enter clamps anything still out of range on the way out.
  const [durationDraft, setDurationDraft] = useState<string>(String(durationSec));
  useEffect(() => {
    setDurationDraft(String(durationSec));
  }, [durationSec]);
  const handleDurationInput = (raw: string) => {
    setDurationDraft(raw);
    const parsed = Number(raw);
    if (
      raw.trim() !== "" &&
      Number.isInteger(parsed) &&
      parsed >= durationBounds.min &&
      parsed <= durationBounds.max &&
      parsed !== durationSec
    ) {
      onChange({ durationSec: parsed });
    }
  };
  const commitDuration = () => {
    const parsed = Number(durationDraft);
    if (durationDraft.trim() === "" || !Number.isFinite(parsed)) {
      setDurationDraft(String(durationSec)); // revert empty/garbage to current
      return;
    }
    const clamped = clampVideoDuration(parsed, durationBounds);
    setDurationDraft(String(clamped));
    if (clamped !== durationSec) onChange({ durationSec: clamped });
  };

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
          {followInputAspectRatio || aspectRatio === "auto"
            ? t("node.videoNode.aspect.auto")
            : aspectRatio}
        </span>
        <span className="text-text-muted/80">·</span>
        <span>{formatResolutionLabel(quality)}</span>
        {!followInputDuration && (
          <>
            <span className="text-text-muted/80">·</span>
            <span>{durationSec}s</span>
          </>
        )}
        {supportsGenerateAudio && (
          generateAudio ? (
            <Volume2 className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
          ) : (
            <VolumeX className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
          )
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
          {!followInputAspectRatio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.aspect.title")}
              </div>
              <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
                {aspectRatioOptions.map((ratio) => {
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
            </>
          )}
          {followInputAspectRatio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.aspect.title")}
              </div>
              <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
                <button
                  type="button"
                  disabled
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${VIDEO_PARAM_ACTIVE_BUTTON_CLASS} cursor-not-allowed`}
                >
                  {t("node.videoNode.aspect.auto")}
                </button>
              </div>
            </>
          )}

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
                  {formatResolutionLabel(q)}
                </button>
              );
            })}
          </div>

          {!followInputDuration && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.duration.title")}
              </div>
              <div className="mb-4 flex items-center gap-3">
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
              className="video-duration-slider min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="number"
                inputMode="numeric"
                min={durationBounds.min}
                max={durationBounds.max}
                step={1}
                value={durationDraft}
                onChange={(event) => handleDurationInput(event.target.value)}
                onBlur={commitDuration}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDuration();
                    event.currentTarget.blur();
                  }
                }}
                aria-label={t("node.videoNode.duration.title")}
                className="h-7 w-12 rounded border border-white/12 bg-white/[0.07] px-1.5 text-center text-xs tabular-nums text-text-dark outline-none transition-colors focus:border-white/28 focus:bg-white/[0.11] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="text-[11px] text-text-muted/80">s</span>
            </div>
              </div>
            </>
          )}

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

          {supportsGenerateAudio && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.audio.title")}
              </div>
              <div className="flex items-center justify-between rounded-md bg-white/[0.045] px-2.5 py-1.5">
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
            </>
          )}
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
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/asset px-1.5`}
    >
      <Library className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/asset:text-text-dark`} />
      <span>资产库</span>
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

interface ReferenceMediaCapEntry {
  item: ReferenceMediaItem;
  /** 1-based 同类型序号（图片/视频/音频 各自累加），与 chip 角标 + @ 提及对齐。 */
  typeIndex: number;
  /** 是否在当前模式的引用上限内；表里没有的模式默认 true。 */
  withinCap: boolean;
}

interface ReferenceMediaRowProps {
  items: ReadonlyArray<ReferenceMediaCapEntry>;
  caps: { image: number; video: number; audio: number } | null;
  /** 当前 genMode；用来决定 firstLastFrame 模式下给前两张图片打 首帧/尾帧 角标。 */
  genMode: VideoGenMode;
  /**
   * nodeId → 这条引用在提示词里的名字（图片1 / 视频2 …）。不在表里的没有 @ 按钮
   * ——超出当前模式上限的素材本来就进不了 @ 候选，给它一个按钮只会插进一个后端
   * 会丢掉的编号。
   */
  mentionNames: ReadonlyMap<string, string>;
  onFocus: (nodeId: string) => void;
  /** 点右下角 @：把这条引用插进提示词。 */
  onMention: (nodeId: string) => void;
  /** 双击 chip：视口跳到该素材在画布上的位置。 */
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
  // 拖动 chip 换位后，回传新的「按可视顺序排列的上游节点 id 列表」。
  onReorder: (orderedNodeIds: string[]) => void;
}

function ReferenceMediaRow({
  items,
  caps,
  genMode,
  mentionNames,
  onFocus,
  onMention,
  onJump,
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
    <div className="flex shrink-0 items-center gap-1.5">
      {items.map((entry) => {
        const { item, typeIndex, withinCap } = entry;
        // 「超出当前模式上限」只在 REFERENCE_CAPS_BY_MODE 里登记过的模式生效。
        const overCap = caps != null && !withinCap;
        const modeCap = caps?.[item.kind] ?? 0;
        const modeLabel =
          {
            textToVideo: "文生视频",
            firstFrame: "首帧",
            imageToVideo: "图生视频",
            imageReference: "多图参考",
            firstLastFrame: "首尾帧",
            videoEdit: "视频编辑",
            allReference: "全能参考",
          }[genMode] ?? "当前模式";
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
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
              onDetach={onDetach}
            />
          );
        } else if (item.kind === "video") {
          chip = (
            <ReferenceVideoChip
              item={item}
              index={typeIndex - 1}
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
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
              mentionName={mentionNames.get(item.nodeId) ?? null}
              onFocus={onFocus}
              onMention={onMention}
              onJump={onJump}
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
  /** 这条引用在提示词里的名字；null 表示它不在 @ 候选里，不显示 @ 按钮。 */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceImageChip({
  item,
  index,
  slotLabel,
  mentionName,
  onFocus,
  onMention,
  onJump,
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
        onDoubleClick={(event) => {
          event.stopPropagation();
          hide();
          onJump(item.nodeId);
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
        {mentionName ? (
          <ReferenceMentionButton
            mentionName={mentionName}
            onInsert={() => {
              hide();
              onMention(item.nodeId);
            }}
          />
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
  /** 这条引用在提示词里的名字；null 表示它不在 @ 候选里，不显示 @ 按钮。 */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceVideoChip({
  item,
  index,
  mentionName,
  onFocus,
  onMention,
  onJump,
  onDetach,
}: ReferenceVideoChipProps) {
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
        onDoubleClick={(event) => {
          event.stopPropagation();
          hide();
          onJump(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        {thumb}
        {mentionName ? (
          <ReferenceMentionButton
            mentionName={mentionName}
            onInsert={() => {
              hide();
              onMention(item.nodeId);
            }}
          />
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
  /** 这条引用在提示词里的名字；null 表示它不在 @ 候选里，不显示 @ 按钮。 */
  mentionName: string | null;
  onFocus: (nodeId: string) => void;
  onMention: (nodeId: string) => void;
  onJump: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceAudioChip({
  item,
  index,
  isPlaying,
  onToggle,
  mentionName,
  onFocus,
  onMention,
  onJump,
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
      onDoubleClick={(event) => {
        // 双击跳到画布上那个音频节点。播放开关被这两下点成了「开了又关」，
        // 正好回到双击前的状态，不用额外去抑制它。
        event.stopPropagation();
        onJump(item.nodeId);
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
      {mentionName ? (
        <ReferenceMentionButton
          mentionName={mentionName}
          onInsert={() => onMention(item.nodeId)}
        />
      ) : null}
      <ReferenceDetachButton
        nodeId={item.nodeId}
        onDetach={onDetach}
        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
      />
    </button>
  );
}
