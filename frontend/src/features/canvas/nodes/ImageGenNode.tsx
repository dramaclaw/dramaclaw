// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  ArrowUp,
  Camera,
  ChevronDown,
  Copy,
  Download,
  Image as ImageIcon,
  Languages,
  Library,
  Loader2,
  Palette,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type ImageGenCameraSelection,
  type ImageGenCount,
  type ImageGenNodeData,
  type ImageQuality,
  type ImageSize,
} from '@/features/canvas/domain/canvasNodes';
import {
  IMAGE_GENERATION_ASPECT_RATIOS,
  parseAspectRatio,
  pickClosestAspectRatio,
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
  shouldForceNaturalImageSize,
} from '@/features/canvas/application/imageNodeSizing';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  isSystemManagedNodeData,
  mainlineNodeVisualState,
  nodeMainlineFlags,
} from '@/features/canvas/domain/mainlineNodeFlags';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { PanelExpandButton } from '@/features/canvas/ui/PanelExpandButton';
import {
  NODE_OPS_PANEL_ENTER_CLASS,
  OperationPanelShell,
} from '@/features/canvas/ui/OperationPanelShell';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import {
  setAlbumPendingTotal,
  useAlbumPendingTotal,
} from '@/features/canvas/nodes/shared/albumPendingTotals';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { getFreezoneCanvasMetadata } from '@/features/freezone/canvasMetadataContext';
import {
  fetchFreezoneJobResult,
  fetchFreezoneTextTranslateResult,
  submitFreezoneGen,
  submitFreezoneTextTranslate,
  uploadFreezoneImage,
} from '@/api/ops';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { getBeatDirectorStageManifest } from '@/api/viewerManifests';
import { BackgroundCropperDialog } from '@/features/canvas/ui/BackgroundCropperDialog';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type { DirectorStageManifest } from '@/features/viewer-kit/three-d/directorManifest';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { extractRequestId } from '@/features/canvas/application/generationErrorReport';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from '@/features/canvas/ui/NodeGenerationHistory';
import {
  CAMERA_PICKER_POPOVER_WIDTH,
  CameraPickerPopover,
  describeCameraSelection,
} from '@/features/canvas/nodes/CameraPickerPopover';
import {
  buildImageGenerationSuccessPatch,
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';
import { useFreezoneCameraOptions } from '@/features/canvas/hooks/useFreezoneCameraOptions';
import {
  StylePickerPopover,
  describeStyleSelection,
} from '@/features/canvas/nodes/StylePickerPopover';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import {
  PromptMentionEditor,
  type MentionCandidate,
  type PromptMentionEditorHandle,
} from '@/features/canvas/nodes/PromptMentionEditor';
import { CandidateBindingBadges } from '@/features/freezone/context/NodeContextBadges';
import {
  collectCandidateBindingsForNode,
} from '@/features/freezone/context/mainlineContext';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { CreditCostPill, formatCreditCost } from '@/components/credits/credit-visual';
import {
  NODE_COUNT_POPOVER_CLASS,
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
} from '@/features/canvas/ui/nodeControlStyles';
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import { NodeContextPromptPaletteButton } from '@/features/canvas/nodes/ContextPromptPaletteButton';
import {
  contextPromptPaletteInsertionText,
  type ContextPromptPaletteEntry,
} from '@/features/canvas/nodes/contextPromptPalette';
import { hasImageGenPromptOverride } from '@/features/canvas/nodes/imageGenPrompt';
import { orderedReferenceUrlsWithOwnFirst } from '@/features/canvas/nodes/referenceOrdering';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';

type ImageGenNodeProps = NodeProps & {
  id: string;
  data: ImageGenNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 580;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 260;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1000;

const OPERATIONS_PANEL_HEIGHT = 232;
const OPERATIONS_PANEL_GAP = 12;
const OPERATIONS_PANEL_MIN_WIDTH = 720;
// 「放大」后的操作区尺寸：给提示词编辑区更舒适的高度与宽度。
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_MIN_WIDTH = 960;

const ASPECT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: '自适应' },
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
  { value: '21:9', label: '21:9' },
];

const SIZE_OPTIONS: ReadonlyArray<ImageSize> = ['1K', '2K', '4K'];
const COUNT_OPTIONS: ReadonlyArray<ImageGenCount> = [1, 2, 4];
const SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS = ['2:3', '16:9'] as const;

const QUALITY_OPTIONS: ReadonlyArray<{ value: ImageQuality; label: string }> = [
  { value: 'low', label: '低画质' },
  { value: 'medium', label: '标准画质' },
  { value: 'high', label: '高画质' },
];
const DEFAULT_IMAGE_QUALITY: ImageQuality = 'medium';
const IMAGE_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[300px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const IMAGE_PARAM_LABEL_CLASS =
  'mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted/85';
const IMAGE_PARAM_BUTTON_BASE_CLASS =
  'inline-flex h-8 items-center justify-center rounded-md text-xs transition-colors';
const IMAGE_PARAM_ACTIVE_BUTTON_CLASS =
  'bg-white/[0.13] text-text-dark ring-1 ring-white/24';
const IMAGE_PARAM_IDLE_BUTTON_CLASS =
  'bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark';
const IMAGE_PARAM_ROW_CLASS = 'mb-4 flex gap-2';
const NODE_COUNT_OPTION_BASE_CLASS =
  'flex w-full items-center justify-center rounded-[6px] px-3 py-1.5 text-xs transition-colors';

// 「画质」选项只对 image2 系模型（LingShan-G2 / gpt-image-2 等）生效，
// 后端也只在 gpt-image-2 上识别该字段。其余模型隐藏该选择器。
function isImage2Model(apiModel: string | null | undefined): boolean {
  return /image[-_]?2/i.test(apiModel ?? '');
}

function resolveOutputUrl(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  for (const key of ['output_url', 'image_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export const ImageGenNode = memo(({ id, data, selected, width, height }: ImageGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  // 顶部工具栏打开了二级功能浮层（全景 / 多角度 / 打光 等）时，浮层会在节点下方
  // 展开自己的操作区。此时隐藏本节点底部的生成/历史面板，让位给浮层，避免两块
  // 操作区重叠。
  const hasActiveOverlay = useCanvasStore((state) => state.activeOverlayNodeId === id);
  const setActiveOverlayNodeId = useCanvasStore((state) => state.setActiveOverlayNodeId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const addNodeAction = useCanvasStore((state) => state.addNode);
  const addEdgeAction = useCanvasStore((state) => state.addEdge);

  // Local prompt buffer keeps the textarea's React `value` in lockstep with
  // user input even during IME composition (中文输入法). Committing to the
  // Zustand store on every keystroke triggers a global re-render that can
  // clobber the in-flight composition; the buffer absorbs that race.
  const externalPrompt = typeof data.prompt === 'string' ? data.prompt : '';
  const [promptDraft, setPromptDraft] = useState(externalPrompt);
  const isComposingRef = useRef(false);
  const hasUserEditedPromptRef = useRef(false);
  const submittingRef = useRef(false);
  useEffect(() => {
    if (isComposingRef.current) return;
    setPromptDraft(externalPrompt);
  }, [externalPrompt]);
  const prompt = promptDraft;
  const promptEditorRef = useRef<PromptMentionEditorHandle>(null);
  const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio
    ? data.aspectRatio
    : '16:9';
  const size = (data.size ?? '2K') as ImageSize;
  const quality = (data.quality ?? DEFAULT_IMAGE_QUALITY) as ImageQuality;
  const count = (data.count ?? 1) as ImageGenCount;
  const autoCommitOnGenerate = data.autoCommitOnGenerate === true;
  const canAutoCommitOnGenerate =
    autoCommitOnGenerate &&
    isSystemManagedNodeData(data);
  const effectiveCount = canAutoCommitOnGenerate ? 1 : count;
  const { isGenerating } = useNodeGenerationTaskState(data);
  const generationError =
    typeof data.generationError === 'string' && data.generationError.length > 0
      ? data.generationError
      : null;
  const generationErrorDetails =
    typeof data.generationErrorDetails === 'string' && data.generationErrorDetails.length > 0
      ? data.generationErrorDetails
      : null;
  const generationErrorRequestId =
    typeof data.generationErrorRequestId === 'string' && data.generationErrorRequestId.length > 0
      ? data.generationErrorRequestId
      : null;
  const cameraSelection = (data.cameraSelection ?? null) as ImageGenCameraSelection | null;
  const styleTemplateId =
    typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
      ? data.styleTemplateId
      : null;
  const referenceImageUrl =
    typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
      ? data.referenceImageUrl
      : null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
  const [errorDetailsCopied, setErrorDetailsCopied] = useState(false);

  const handleCopyErrorDetails = useCallback(async () => {
    // New failures keep the complete task/provider response in details. For
    // older persisted nodes, generationError itself may still be the raw blob.
    const copyText = generationErrorDetails || generationError || generationErrorRequestId;
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setErrorDetailsCopied(true);
      window.setTimeout(() => setErrorDetailsCopied(false), 1200);
    } catch (error) {
      console.error('[image-gen] copy error details failed', error);
    }
  }, [generationError, generationErrorDetails, generationErrorRequestId]);

  const {
    models: availableModels,
    isLoading: imageModelsLoading,
    isFallback: imageModelsFallback,
  } = useFreezoneImageModels();
  // Per-node generation history. Only fetch while the node is selected so an
  // unselected canvas full of nodes doesn't fan out a request each. `refresh`
  // is called after a generation settles to pull in the new record.
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

  // 生成进行中时，点击历史记录走「非破坏性预览」：不覆写 imageUrl、不打断在途
  // 任务，仅把这张历史图临时显示在主体上（见 isGenerating 渲染分支）。新图生成
  // 完成后由下方 effect 自动清空，回到最新结果。非生成态恢复历史时也清掉它。
  const [historyPreviewUrl, setHistoryPreviewUrl] = useState<string | null>(null);

  const handleRestoreHistory = useCallback(
    (record: Parameters<typeof historyRecordOutputUrl>[0]) => {
      const url = historyRecordOutputUrl(record);
      if (!url) return;
      // 生成进行中：仅做非破坏性预览，绝不动 imageUrl，也不打断在途任务。
      if (isGenerating) {
        setHistoryPreviewUrl(url);
        return;
      }
      setHistoryPreviewUrl(null);
      updateNodeData(id, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        // 恢复的是单张历史结果，旧批次画册已与主图脱钩（没有任何一张会命中
        // 「主图」标记，点画册格还会静默丢掉刚恢复的图）——一并清掉。
        generationBatch: null,
      });
    },
    [id, isGenerating, updateNodeData],
  );

  // 生成结束（成功/失败）后清掉临时历史预览，让主体回到最新结果。
  useEffect(() => {
    if (!isGenerating) setHistoryPreviewUrl(null);
  }, [isGenerating]);
  // Resolve the model against the LIVE model list and derive BOTH the picker's
  // displayed id and the submit apiModel from this one object, so they can
  // never diverge.
  //
  // The node's default `data.model` is seeded to the static
  // `DEFAULT_SHARED_MODEL_ID` (`huimeng/gpt-image-2`), which is normally NOT in
  // the live `/freezone/image/models` list. Trusting it blindly is the bug:
  // ProviderModelPicker silently falls back to showing `availableModels[0]`
  // (e.g. LingShan-G2) when the id isn't found, while submit resolves the stale
  // id through SHARED_MODELS to `huimeng_gpt_image2` — display ≠ value sent.
  // Reconciling here keeps them in lockstep: an unknown persisted id falls back
  // to the first live model (exactly what the picker shows).
  const selectedModel = useMemo(() => {
    const persisted =
      typeof data.model === 'string' && data.model.length > 0 ? data.model : null;
    return (
      (persisted ? availableModels.find((m) => m.id === persisted) : undefined)
      ?? availableModels[0]
    );
  }, [data.model, availableModels]);
  const modelId = selectedModel?.id ?? DEFAULT_SHARED_MODEL_ID;
  const isImage2 = isImage2Model(selectedModel?.apiModel);
  const imageSelectionForCost =
    imageModelsLoading || imageModelsFallback ? null : selectedModel?.apiModel ?? null;
  const imageCreditCost = useGenerationCreditCost('image_selection', imageSelectionForCost, {
    surface: 'canvas',
    params: isImage2 ? { size, quality } : { size },
    quantity: Math.min(Math.max(effectiveCount, 1), 4),
  });
  const totalCreditCostDisplay = useMemo(() => {
    const total = imageCreditCost.data?.data.cost;
    if (typeof total !== 'number') return null;
    return formatCreditCost(total);
  }, [imageCreditCost.data?.data.cost]);
  const { options: cameraOptions } = useFreezoneCameraOptions();
  const cameraSummary = describeCameraSelection(cameraSelection, cameraOptions);
  const { templates: styleTemplates } = useFreezoneStyleTemplates();
  const selectedStyle = describeStyleSelection(styleTemplateId, styleTemplates);

  const upstreamContents = useUpstreamContents(id);
  // ImageGen 上游只消费「文本 + 图片」，视频/音频内容被丢弃 ——
  // 即便 upload 节点带了视频 URL，也不进 OpsPanel 也不进 reference_urls。
  const upstreamImageContents = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof upstreamContents = [];
    for (const content of upstreamContents) {
      const url = typeof content.imageUrl === 'string' ? content.imageUrl : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(content);
    }
    return out;
  }, [upstreamContents]);
  const upstreamTextContents = useMemo(
    () =>
      upstreamContents.filter(
        (content) => typeof content.text === 'string' && content.text.trim().length > 0,
      ),
    [upstreamContents],
  );
  const upstreamTextJoined = useMemo(
    () => joinUpstreamText(upstreamContents),
    [upstreamContents],
  );
  const freezoneSource = (data.__freezone_source as
    | { role?: string; meta?: Record<string, unknown> }
    | undefined) ?? undefined;
  const sourceRole = typeof freezoneSource?.role === "string"
    ? freezoneSource.role
    : "";
  const shouldInlineUpstreamTextAsPrompt =
    sourceRole === "scene_master" || sourceRole === "scene_reverse_master";
  const upstreamReferenceUrls = useMemo(
    () =>
      Array.from(
        new Set(
          upstreamImageContents
            .map((c) => (typeof c.imageUrl === 'string' ? c.imageUrl : ''))
            .filter((url) => url.length > 0),
        ),
      ),
    [upstreamImageContents],
  );
  // 提交给后端的参考图有序列表：自身参考图排第 1、上游图接在后面（URL 去重）。
  // @图片N 编号、mention 重排基线、提交三处共用这一份 —— 后端按位置解释 图片N，
  // 曾经编号只数上游图、提交却把自身参考图前置，节点自带参考图时所有 @图片N
  // 到后端整体偏移 1（@图片1 实际指向自身参考图）。
  const orderedReferenceUrls = useMemo(
    () => orderedReferenceUrlsWithOwnFirst(referenceImageUrl, upstreamReferenceUrls),
    [referenceImageUrl, upstreamReferenceUrls],
  );
  // collectCandidateBindingsForNode 只关心连到 this node 的边。用 useShallow 只订阅
  // 本节点相连的边(逐元素比较),拖动无关节点时边引用稳定,本节点不再重渲染。
  const connectedEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id || edge.target === id)),
  );
  const candidateBindingRoles = useMemo(
    () => collectCandidateBindingsForNode(connectedEdges, id).map((binding) => binding.role),
    [connectedEdges, id],
  );
  // 节点被连线（存在入边）后：隐藏「试试」CTA，只在节点中间显示一个图标（对齐 libtv）。
  const isConnected = useMemo(
    () => connectedEdges.some((edge) => edge.target === id),
    [connectedEdges, id],
  );

  // 候选按 orderedReferenceUrls 编号（自身参考图在场时就是图片1），保证 @ 出来的
  // 缩略图与后端解析到的 图片N 是同一张。key 优先用上游 nodeId；自身参考图没有
  // 上游节点，用 URL 兜底（key 只需在候选内稳定唯一）。
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      orderedReferenceUrls.map((url, index) => ({
        key:
          upstreamImageContents.find((content) => content.imageUrl === url)
            ?.nodeId ?? `self:${url}`,
        name: `图片${index + 1}`,
        imageUrl: resolveImageDisplayUrl(url),
        index: index + 1,
      })),
    [orderedReferenceUrls, upstreamImageContents],
  );

  // 让 prompt 里的 @图片N 始终跟随参考图引用编号：删除 / 重排 / 新增引用连线、
  // 上传或移除自身参考图后，mentionCandidates 会重新编号，这里把 prompt 里的数字
  // 一并重写、被删引用的 mention 移除。有序基线 = orderedReferenceUrls（自身参考图
  // 在前、去重 URL、连接顺序，与编号和提交口径一致；用 URL 而非 nodeId 作身份，
  // 避免「两个上游节点图同一 URL」时删其一被误判为引用消失）。
  const applyPromptRemap = useCallback(
    (next: string) => {
      setPromptDraft(next);
      updateNodeData(id, { prompt: next });
    },
    [id, updateNodeData],
  );
  useReferenceMentionSync(
    prompt,
    [{ prefix: "图片", ids: orderedReferenceUrls }],
    applyPromptRemap,
  );

  // 弹层与编辑器同在面板里、编辑器恒已挂载，故插入直接走命令式 API，回调保持稳定引用
  // （无需依赖 prompt，避免每次按键重建回调、连带调色盘按钮重渲染）。
  const insertContextPaletteEntry = useCallback(
    (entry: ContextPromptPaletteEntry) => {
      promptEditorRef.current?.insertTextAtCursor(
        contextPromptPaletteInsertionText(entry),
      );
    },
    [],
  );

  // 取消关联某个上游素材：直接删掉「该上游节点 → 本节点」的连线，无需用户
  // 去画布上找那根线。collectInputContents 只走一跳，所以 content.nodeId 就是
  // 直接相连的上游节点，可精确定位到要删的边。
  const handleDetachUpstream = useCallback(
    (sourceNodeId: string) => {
      useCanvasStore
        .getState()
        .edges.filter((edge) => edge.source === sourceNodeId && edge.target === id)
        .forEach((edge) => deleteEdge(edge.id));
    },
    [id, deleteEdge],
  );

  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  // Spawn upload reference nodes from selected asset-library images — one per
  // selection, stacked to the left of this node, then wired as upstream refs so
  // they feed the multi-reference generation. Image-only here (the modal is
  // opened with allowedMedia=['image']), but we still guard on media.
  const spawnAssetLibraryReferences = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      const imageSelections = selections.filter((sel) => sel.media === 'image');
      if (imageSelections.length === 0) return;
      const state = useCanvasStore.getState();
      const self = state.nodes.find((n) => n.id === id);
      if (!self) return;
      const UPLOAD_WIDTH = 320;
      const UPLOAD_HEIGHT = 240;
      const GAP_X = 40;
      const GAP_Y = 24;
      const baseX = self.position.x - UPLOAD_WIDTH - GAP_X;
      const totalH =
        UPLOAD_HEIGHT * imageSelections.length + GAP_Y * (imageSelections.length - 1);
      const startY =
        self.position.y + ((self.height ?? DEFAULT_HEIGHT) - totalH) / 2;
      const newIds: string[] = [];
      imageSelections.forEach((sel, idx) => {
        const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
        const newId = addNodeAction(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y },
          {
            imageUrl: sel.url,
            previewImageUrl: sel.url,
            displayName: sel.name || undefined,
          },
        );
        addEdgeAction(newId, id);
        newIds.push(newId);
      });
      state.autoGroupSpawn(id, newIds, { label: '资产参考组' });
    },
    [addEdgeAction, addNodeAction, id],
  );

  // Hover preview state for the upstream image thumbnails in the OpsPanel
  // reference row. Mirrors the @-mention chip preview UX so users can peek
  // a full-size image without leaving the prompt editor.
  const [refHover, setRefHover] = useState<{ imageUrl: string; rect: DOMRect } | null>(null);
  const refPreviewStyle = useMemo(() => {
    if (!refHover) return null;
    const SIZE = 220;
    const left = Math.min(
      Math.max(8, refHover.rect.left),
      window.innerWidth - SIZE - 8,
    );
    const top = refHover.rect.top - SIZE - 8;
    return { left, top: Math.max(8, top), size: SIZE };
  }, [refHover]);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.imageGen, data),
    [data],
  );
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));
  // 收起态浮动面板固定基础尺寸；放大用居中弹窗（见下方 OperationPanelShell）。
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const panelHeight = OPERATIONS_PANEL_HEIGHT;
  const panelWidth = Math.max(resolvedWidth, OPERATIONS_PANEL_MIN_WIDTH);

  const previewUrl = useMemo(() => {
    if (data.previewImageUrl) return resolveImageDisplayUrl(data.previewImageUrl);
    if (data.imageUrl) return resolveImageDisplayUrl(data.imageUrl);
    if (referenceImageUrl) return resolveImageDisplayUrl(referenceImageUrl);
    return null;
  }, [data.imageUrl, data.previewImageUrl, referenceImageUrl]);
  const visiblePreviewUrl = isGenerating ? null : previewUrl;

  const hasGeneratedResult = Boolean(data.imageUrl);
  // Natural pixel size of the displayed image, mirrored from data when present
  // (persisted by the onLoad handler below) and refreshed on every <img> load so
  // the resolution badge shows even for nodes whose size already matched (those
  // skip the persist branch). Lets us render a top-right resolution chip like the
  // video node.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(() => {
    const w = (data as { imageNaturalWidth?: unknown }).imageNaturalWidth;
    const h = (data as { imageNaturalHeight?: unknown }).imageNaturalHeight;
    return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
      ? { width: w, height: h }
      : null;
  });
  // ── 叠卡画册（count > 1 的一组生成结果）──
  // 收拢时主图后探出 N-1 张卡片边缘；hover 出现右上角数量徽标，点开展开成
  // 宫格画册（同一节点内，天然不可解组）。展开态可对任意一张「设为主图」
  // （回填 imageUrl 并收拢）或单独下载。
  const albumRootRef = useRef<HTMLDivElement | null>(null);
  // 画册容器 pointerdown 起点，用于区分点击与拖动（拖动节点后松手会补发 click）。
  const albumPointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const [albumExpanded, setAlbumExpanded] = useState(false);
  // 本次会话内"应到张数"：N 个接口并发、完成有先后，先完成的立即入册，
  // 未完成的在画册里占位（骨架 + spinner）。存模块级登记表而非组件 state——
  // onlyRenderVisibleElements 下平移出视口会卸载组件，state 会丢；见模块注释。
  const albumPendingTotal = useAlbumPendingTotal(id);
  const albumUrls = useMemo(() => {
    const raw = data.generationBatch;
    if (!Array.isArray(raw)) return [];
    return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }, [data.generationBatch]);
  const albumTotalSlots = Math.max(albumUrls.length, albumPendingTotal);
  const albumPendingCount = Math.max(0, albumPendingTotal - albumUrls.length);
  const hasAlbum = albumTotalSlots > 1;

  // 画册展开期间注册为本节点的 activeOverlay：拖动画册会让 React Flow 重新
  // 选中节点（selectNodesOnDrag），单靠展开瞬间的取消选中压不住——action
  // 工具条 / OpsPanel / 历史条 / 替换素材把手都认 activeOverlayNodeId 让位，
  // 注册后无论选中与否都不会再叠出来。
  useEffect(() => {
    if (!albumExpanded) return;
    setActiveOverlayNodeId(id);
    return () => {
      // 只清自己注册的，避免误清其它浮层（多角度/打光等）的注册。
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

  const handleSetAlbumMainImage = useCallback(
    (url: string) => {
      updateNodeData(id, { imageUrl: url, previewImageUrl: url });
      setAlbumExpanded(false);
    },
    [id, updateNodeData],
  );

  // 展开画册时取消节点激活态：上方 action 工具条、下方 OpsPanel、历史记录条
  // 都跟着 selected 走，叠在宫格上很乱——画册期间只看图。
  // 注意必须经 onNodesChange 派发 select=false 清掉 React Flow 自身的选中
  // 标志——只清 store 的 selectedNodeId 会被 Canvas 的选中同步 effect
  // （RF selectedNodeIds → setSelectedNode）立刻写回来。
  // 副作用放在 setState updater 外面：updater 必须纯（StrictMode 会双调用，
  // 副作用入内会把 onNodesChange 派发两遍）。
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

  // 「应用到画布」：把这张图作为独立图片节点放到展开宫格右侧（同构 imageGen
  // 节点，可直接被下游引用/二次生成）。画册保持展开，方便连续应用多张——
  // 连续应用的落点逐次向下错开，避免精确叠在同一坐标上只看得见最后一个。
  const albumAppliedCountRef = useRef(0);
  const handleApplyAlbumImageToCanvas = useCallback(
    (url: string) => {
      const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
      if (!self) return;
      const applyIndex = albumAppliedCountRef.current;
      albumAppliedCountRef.current += 1;
      const position = {
        x: self.position.x + resolvedWidth * 2 + 12 + 48 + applyIndex * 36,
        y: self.position.y + applyIndex * 36,
      };
      const newNodeId = addNodeAction(CANVAS_NODE_TYPES.imageGen, position, {
        imageUrl: url,
        previewImageUrl: url,
        aspectRatio: data.aspectRatio,
        user_spawned: true,
      } as Partial<ImageGenNodeData>);
      setSelectedNode(newNodeId);
    },
    [addNodeAction, data.aspectRatio, id, resolvedWidth, setSelectedNode],
  );

  const handleDownloadAlbumImage = useCallback(
    async (url: string, index: number) => {
      try {
        await downloadUrlAsFile(resolveImageDisplayUrl(url), `image-gen-${id}-${index + 1}.png`);
      } catch (error) {
        console.error('[image-gen] album download failed', error);
      }
    },
    [id],
  );

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback(
    async (file: File) => {
      const projectId = readUrl().project;
      if (!projectId) {
        console.error('[image-gen] no project in URL');
        return;
      }
      setIsUploading(true);
      try {
        const result = await uploadFreezoneImage(projectId, file, file.name);
        updateNodeData(id, { referenceImageUrl: result.url });
      } catch (error) {
        console.error('[image-gen] upload failed', error);
      } finally {
        setIsUploading(false);
      }
    },
    [id, updateNodeData],
  );

  const handleClearReference = useCallback(() => {
    updateNodeData(id, { referenceImageUrl: null });
  }, [id, updateNodeData]);

  const handleSpawnUpstreamImage = useCallback(() => {
    const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
    if (!self) return;
    // 上游图片节点本身也是 imageGen —— 用户可以直接在它里面写 prompt /
    // 选模型 / 生成图，下游再拿它的结果当参考图。与 upload 相比好处是
    // 自带 OpsPanel，整链路同构。
    const UPSTREAM_WIDTH = DEFAULT_WIDTH;
    const position = {
      x: self.position.x - UPSTREAM_WIDTH - 28,
      y: self.position.y,
    };
    const newNodeId = addNodeAction(CANVAS_NODE_TYPES.imageGen, position);
    addEdgeAction(newNodeId, id);
    setSelectedNode(newNodeId);
  }, [addEdgeAction, addNodeAction, id, setSelectedNode]);

  const handleTranslatePrompt = useCallback(async () => {
    if (isTranslatingPrompt || isGenerating) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[image-gen] translate: no project in URL');
      return;
    }
    setIsTranslatingPrompt(true);
    try {
      const ref = await submitFreezoneTextTranslate(projectId, {
        text: prompt,
        nodeType: 'image',
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      await awaitTaskCompletion(ref.task_key, projectId);
      const result = await fetchFreezoneTextTranslateResult(projectId, ref.job_id);
      if (result.translated_text) {
        setPromptDraft(result.translated_text);
        updateNodeData(id, { prompt: result.translated_text });
      }
    } catch (error) {
      console.error('[image-gen] translate failed', error);
    } finally {
      setIsTranslatingPrompt(false);
    }
  }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // 「实时读取上游」：用户可以不填 prompt，只要上游连了带 text 的节点
  // (文本/脚本/图片生成 prompt 等) 就能 submit；submit 时拼接上游 text。
  const hasEffectivePrompt =
    prompt.trim().length > 0 ||
    (
      upstreamTextJoined.length > 0 &&
      (!shouldInlineUpstreamTextAsPrompt || !hasUserEditedPromptRef.current)
    );
  const submitDisabled =
    isGenerating || !hasEffectivePrompt;

  const handleSubmit = useCallback(async () => {
    if (submitDisabled || submittingRef.current) return;
    submittingRef.current = true;
    try {
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[image-gen] no project in URL');
      return;
    }

    // apiModel comes from the SAME reconciled model the picker displays, so the
    // backend always receives the model the user actually sees.
    const apiModel =
      selectedModel?.apiModel
      ?? SHARED_MODELS.find((m) => m.id === modelId)?.apiModel
      ?? modelId;
    // 自身参考图（用户手动上传） + 所有上游图片/视频 URL，去重 —— 与 @图片N
    // 编号共用同一份有序列表（orderedReferenceUrls），后端按位置解释 图片N。
    // 后端 reference_urls 接受 image / video 混合数组。
    const referenceUrls = orderedReferenceUrls;
    const hasCamera = Boolean(
      cameraSelection
      && (cameraSelection.cameraBodyId
        || cameraSelection.lensId
        || cameraSelection.focalLengthMm
        || cameraSelection.aperture),
    );
    const ownPrompt = prompt.trim();
    const effectivePrompt = shouldInlineUpstreamTextAsPrompt
      ? (ownPrompt || (hasUserEditedPromptRef.current ? "" : upstreamTextJoined.trim()))
      : [upstreamTextJoined, ownPrompt]
        .filter((s) => s.length > 0)
        .join('\n\n');
    const genPayload = {
      prompt: effectivePrompt,
      // 后端只接受固定的几个比例；节点上的 aspectRatio 可能是图片自然尺寸约分出的
      // 非标准值（如 "43:24"）或 "auto"，提交前吸附到最接近的合法比例（auto→1:1）。
      aspectRatio: snapToAllowedAspectRatio(
        aspectRatio,
        IMAGE_GENERATION_ASPECT_RATIOS,
        '1:1',
      ) as typeof aspectRatio,
      imageSize: size,
      // 画质仅对 image2 系模型生效，其余模型不下发该字段。
      quality: isImage2 ? quality : null,
      referenceUrls,
      model: apiModel,
      modelId,
      camera: hasCamera
        ? {
            cameraBodyId: cameraSelection?.cameraBodyId ?? null,
            lensId: cameraSelection?.lensId ?? null,
            focalLengthMm: cameraSelection?.focalLengthMm ?? null,
            aperture: cameraSelection?.aperture ?? null,
          }
        : null,
      style: styleTemplateId ? { templateId: styleTemplateId } : null,
    };

    // 后端不再支持一次出多张，改为按「生成数量」并发调用 N 次接口，每次出
    // 1 张。N > 1 时不再复制兄弟节点，而是全部回填到当前节点的
    // generationBatch（叠卡画册）：第 1 张完成的设为主图（imageUrl），其余
    // 逐张追加进画册，收拢态渲染成叠起的卡片。
    const total = Math.min(Math.max(effectiveCount, 1), 4);
    // Clear any prior failure / album on resubmit — the on-node error banner
    // should only reflect the most recent attempt.
    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
      generationErrorDetails: null,
      generationErrorRequestId: null,
      generationBatch: null,
    });
    // 先完成的图立即入册展示，未完成的在画册里渲染占位骨架。
    setAlbumPendingTotal(id, total > 1 ? total : 0);

    const canvasId = readUrl().canvas ?? 'default';
    // 各并发任务完成顺序不定，本地累积已完成的 URL，整组写回（避免读改写竞态）。
    const completedUrls: string[] = [];
    const runOne = async (runIndex: number) => {
      let taskKey: string | null = null;
      try {
        const ref = await submitFreezoneGen(projectId, {
          ...genPayload,
          canvasId,
          nodeId: id,
        });
        taskKey = ref.task_key;
        // Persist the task handle so a page refresh can resume polling this
        // job. With N concurrent runs on one node only one handle can persist —
        // keep the first (main-image) run's.
        if (runIndex === 0) {
          updateNodeData(id, generationTaskDescriptor(ref));
        }
        const completed = await awaitTaskCompletion(ref.task_key, projectId);
        let url = resolveOutputUrl(completed.result as Record<string, unknown> | null);
        if (!url) {
          try {
            const fallback = await fetchFreezoneJobResult(projectId, ref.task_type, ref.job_id);
            url = fallback.url;
          } catch (error) {
            console.warn('[image-gen] fallback fetch failed', error);
          }
        }
        if (url) {
          completedUrls.push(url);
          const isFirstCompleted = completedUrls.length === 1;
          updateNodeData(id, {
            // 第 1 张完成的设为主图并结束 loading；后续只扩充画册。
            ...(isFirstCompleted ? buildImageGenerationSuccessPatch(url) : {}),
            ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
          });
          if (canAutoCommitOnGenerate && isFirstCompleted) {
            canvasEventBus.publish('freezone/commit-node', {
              nodeId: id,
              auto: true,
            });
          }
        } else {
          console.warn('[image-gen] generation completed without output url', completed);
          // 只有 run 0（任务句柄的归属者）且尚无任何成功时才终结 loading——
          // 非首个任务先「无 URL 完成」不能把还在跑的整体 loading 提前掐掉。
          if (runIndex === 0 && completedUrls.length === 0) {
            updateNodeData(id, { isGenerating: false, generationStartedAt: null });
          }
        }
      } catch (error) {
        console.error('[image-gen] generation failed', error);
        // 已有同批其它图完成（主图已落）时不覆盖成功态为错误——部分失败只
        // 影响画册张数。
        if (completedUrls.length > 0) return;
        // 任务仲裁（stale / shouldWrite）只对 run 0 有意义：节点上只持久化了
        // run 0 的任务句柄，其余 run 的 taskKey 必然对不上，套用仲裁会把
        // 它们的失败全部误判为「过期任务」而静默吞掉。
        if (runIndex === 0) {
          const latestNodeData = (useCanvasStore
            .getState()
            .nodes
            .find((node) => node.id === id)?.data ?? {}) as Record<string, unknown>;
          if (
            taskKey
            && isStaleGenerationTask({ nodeData: latestNodeData, taskKey })
          ) return;
          if (
            taskKey
            && !shouldWriteGenerationError({ nodeData: latestNodeData, taskKey, error })
          ) {
            updateNodeData(id, { isGenerating: false, generationStartedAt: null });
            return;
          }
        }
        // Persist the failure on the node so it stays visible until the next
        // submit — the request id is the handle support uses to trace it.
        // 只有 run 0 失败才终结 loading：非首 run 失败时 run 0 可能还在跑，
        // 它的成功补丁会清掉这里写的错误横幅。
        const rawErrorMessage =
          error instanceof Error && error.message
            ? error.message
            : String(error || t('common.error'));
        const displayErrorMessage = backendErrorToastMessage(error, t);
        updateNodeData(id, {
          ...(runIndex === 0
            ? { isGenerating: false, generationStartedAt: null }
            : {}),
          generationError: displayErrorMessage,
          // Keep the complete task/provider error for support copy. Only the
          // concise provider `message` is rendered on the node.
          generationErrorDetails: rawErrorMessage,
          generationErrorRequestId: extractRequestId(rawErrorMessage),
        });
        // Re-throw so the caller can surface a single error dialog after all
        // concurrent attempts settle (rather than one dialog per failed image).
        throw error;
      }
    };

    await Promise.allSettled(
      Array.from({ length: total }, (_, runIndex) => runOne(runIndex)),
    );
    // 全部尘埃落定后撤掉占位（失败的任务不留空槽，画册按实际完成数收口）。
    setAlbumPendingTotal(id, 0);
    // Backend records each attempt (success or failure); pull the new entries.
    // Failures are surfaced directly on the failing node (request-id banner),
    // set per-target inside runOne's catch — no global modal.
    void refreshHistory();
    } finally {
      submittingRef.current = false;
    }
  }, [
    aspectRatio,
    canAutoCommitOnGenerate,
    selectedModel,
    cameraSelection,
    count,
    effectiveCount,
    id,
    isImage2,
    modelId,
    orderedReferenceUrls,
    prompt,
    quality,
    size,
    styleTemplateId,
    submitDisabled,
    shouldInlineUpstreamTextAsPrompt,
    updateNodeData,
    upstreamTextJoined,
    refreshHistory,
  ]);

  // ===== Step B: 场景资产节点的 "用作背景源" 操作 =====
  // scene_master / scene_reverse_master 节点上的按钮 → 打开 BackgroundCropperDialog
  // → 用户选择截图比例和区域 → 生成当前背景候选节点 → 自动 commit 主线。
  // 用户明确要求 \"不全用 master/reverse,要截图\" — 所以走 cropper 路径,不是
  // 直接 PATCH anchor (旧实现已替换)。
  // Step C: director_combined 节点上的「打开导演世界」按钮使用
  // supertale-fe 内置同源 viewer,不跳旧外部导演台。
  const sourceMeta = (freezoneSource?.meta ?? {}) as Record<string, unknown>;
  const sourceEpisode = typeof sourceMeta.episode === "number"
    ? sourceMeta.episode
    : null;
  const sourceBeat = typeof sourceMeta.beat === "number"
    ? sourceMeta.beat
    : null;
  // 平面 source: master / reverse 走 BackgroundCropperDialog (用户选择截图比例和区域)。
  // 360 / 3GS 不走这条 — 它们统一进入 Director World，capture 入口在那里。
  const cropperSourceRoles = new Set(['scene_master', 'scene_reverse_master']);
  const canUseAsBackground = cropperSourceRoles.has(sourceRole);
  const canOpenDirectorStage = sourceRole === "director_combined"
    && sourceEpisode !== null
    && sourceBeat !== null;
  const [bgCropperOpen, setBgCropperOpen] = useState(false);
  const [directorStageBusy, setDirectorStageBusy] = useState(false);
  const [directorStageOpen, setDirectorStageOpen] = useState(false);
  const [directorStageManifest, setDirectorStageManifest] = useState<DirectorStageManifest | null>(null);
  // 从 canvas metadata 拿到当前镜头的 episode/beat 定位信息 (selectedBackground 在
  // beat preset 里 emit 时跟 beat-scope 节点同步,但本节点 (scene_master 等) 来自
  // _add_scene_refs 没带 episode/beat meta — 从 canvas metadata.preset 兜底)。
  const canvasMetaForBeat = getFreezoneCanvasMetadata();
  const canvasPresetMeta = (canvasMetaForBeat?.preset as
    | { episode?: number; beat?: number }
    | undefined) ?? undefined;
  const effectiveEpisode = sourceEpisode ?? canvasPresetMeta?.episode ?? null;
  const effectiveBeat = sourceBeat ?? canvasPresetMeta?.beat ?? null;

  useEffect(() => {
    if (!shouldInlineUpstreamTextAsPrompt) return;
    if (isComposingRef.current) return;
    if (hasUserEditedPromptRef.current) return;
    if (externalPrompt.trim().length > 0) return;
    const nextPrompt = upstreamTextJoined.trim();
    if (!nextPrompt) return;
    setPromptDraft(nextPrompt);
  }, [
    externalPrompt,
    shouldInlineUpstreamTextAsPrompt,
    upstreamTextJoined,
  ]);

  const handleOpenDirectorStageInline = useCallback(async () => {
    if (!canOpenDirectorStage) return;
    const projectId = readUrl().project;
    if (!projectId || effectiveEpisode === null || effectiveBeat === null) return;
    setDirectorStageBusy(true);
    try {
      const manifest = await getBeatDirectorStageManifest(projectId, effectiveEpisode, effectiveBeat);
      setDirectorStageManifest(manifest);
      setDirectorStageOpen(true);
    } catch (err) {
      console.error('[director-stage] manifest fetch failed', err);
    } finally {
      setDirectorStageBusy(false);
    }
  }, [canOpenDirectorStage, effectiveEpisode, effectiveBeat]);

  const handleDirectorCaptureCombined = useCallback(
    async (blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      const projectId = readUrl().project;
      if (!projectId || effectiveEpisode === null || effectiveBeat === null) {
        throw new Error('缺少项目或镜头上下文');
      }

      let imageUrl = meta.controlFrameUrl
        ?? meta.controlFrameBundle?.urls?.combined
        ?? '';
      if (!imageUrl) {
        const uploaded = await uploadFreezoneImage(
          projectId,
          blob,
          `director_combined_${Date.now()}.png`,
          { timeoutMs: false },
        );
        imageUrl = uploaded.url;
      }

      const nextBundle = meta.controlFrameBundle ?? data.director_control_bundle;

      updateNodeData(id, {
        imageUrl,
        previewImageUrl: withImageCacheBust(imageUrl, Date.now()),
        ...(nextBundle ? { director_control_bundle: nextBundle } : {}),
        committed_at: new Date().toISOString(),
        committed_slot_url: imageUrl,
        slot_target: {
          kind: 'director_render',
          episode: effectiveEpisode,
          beat: effectiveBeat,
        },
      });
      canvasEventBus.publish('freezone/assets-updated', undefined);
    },
    [data.director_control_bundle, effectiveEpisode, effectiveBeat, id, updateNodeData],
  );

  // 视觉态从 4 个 derived flag 派生(see mainlineNodeFlags):
  //   preset_locked      — preset_managed === true:amber 实线 + lock badge
  //   candidate_pushable — user_spawned + slot_target:amber 虚线 + push badge
  //   context_only       — 有 mainline_context 但无 slot_target:cyan 细线 + context chip
  //   ordinary           — 都没有:默认白色 border
  //
  const mainlineFlags = useMemo(
    () => nodeMainlineFlags({ data, id, type: 'imageGenNode', position: { x: 0, y: 0 } } as never),
    [data, id],
  );
  const visualState = mainlineNodeVisualState(mainlineFlags);
  const mainlineCanvasReadonly = mainlineFlags.isPresetManaged && !canAutoCommitOnGenerate;
  const cardToneClass = (() => {
    switch (visualState) {
      case 'preset_locked':
        return canvasNodeFrameClass({ selected, mainline: true });
      case 'candidate_pushable':
        return canvasNodeFrameClass({ selected, mainline: true, dashed: true });
      case 'context_only':
        return canvasNodeFrameClass({ selected, mainline: true });
      case 'ordinary':
      default:
        return canvasNodeFrameClass({ selected });
    }
  })();
  // 画册展开时一并隐藏 OpsPanel——展开瞬间已 setSelectedNode(null)，这里再兜
  // 一道，防止展开后用户点节点重新选中时面板叠到宫格上。
  const showImageOpsPanel =
    selected && !isBoxSelecting && !hasActiveOverlay && !mainlineCanvasReadonly && !albumExpanded;

  return (
    <div
      ref={albumRootRef}
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      {/* 叠卡画册的卡片边缘：从主图右下方探出，张数与画册一致（最多露 3 张）。
          先渲染、被后面的主卡覆盖，只露出错位的边。 */}
      {hasAlbum && !albumExpanded && previewUrl && (
        <>
          {Array.from({ length: Math.min(albumTotalSlots - 1, 3) }, (_, index) => {
            const step = index + 1;
            return (
              // 点探出的卡片边也能展开画册（和点数量徽标等效）。
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
                  // 仿 TapNow：后面的卡依次上下内缩、向右探出、微旋转——
                  // 露出的是一条条「卡片边」，而不是整块色板。
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

      {/* 画册展开时隐藏浮动标题和分辨率角标——画册容器自带「画册 · N 张」头部，
          两者都浮在节点上沿同一位置，叠在一起显示错乱。 */}
      {!albumExpanded && (
        <>
          <NodeHeader
            className={NODE_HEADER_FLOATING_POSITION_CLASS}
            icon={<ImageIcon className="h-4 w-4" />}
            titleText={resolvedTitle}
            editable
            onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
          />
          {visiblePreviewUrl && naturalSize ? (
            <div
              className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
              title={t('node.imageNode.resolution')}
            >
              <ImageIcon className="h-3 w-3 text-white/45" />
              {naturalSize.width}×{naturalSize.height}
            </div>
          ) : null}
        </>
      )}
      <CandidateBindingBadges roles={candidateBindingRoles} />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
        keepAspectRatio
      />

      {!hasGeneratedResult && !referenceImageUrl && !isGenerating && !generationError && (
        <NodeSideActionRail nodeId={id} autoHide selected={Boolean(selected)}>
          <button
            type="button"
            disabled={isUploading}
            onClick={(event) => {
              event.stopPropagation();
              handlePickFile();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title="上传图片"
            className={NODE_SIDE_ACTION_BUTTON_CLASS}
          >
            {isUploading ? (
              <Loader2 className={`${NODE_SIDE_ACTION_ICON_CLASS} animate-spin`} />
            ) : (
              <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
            )}
            <span>{isUploading ? '上传中' : '上传图片'}</span>
          </button>
        </NodeSideActionRail>
      )}

      <div
        className={`relative flex h-full w-full items-center justify-center ${visiblePreviewUrl ? 'overflow-hidden' : 'overflow-visible'} rounded-[var(--node-radius)] border transition-colors ${visiblePreviewUrl ? CANVAS_NODE_PANEL_SURFACE_CLASS : CANVAS_NODE_INPUT_SURFACE_CLASS} ${cardToneClass} ${visiblePreviewUrl ? '' : CANVAS_NODE_INPUT_BODY_FRAME_CLASS} ${
          // 画册展开时藏起节点本体的图片卡——半透明的画册容器盖不严，
          // 底下的主图会透出来叠在宫格头部。
          albumExpanded && hasAlbum ? 'invisible' : ''
        }`}
      >
        {visiblePreviewUrl ? (
          <>
            <CanvasNodeImage
              src={visiblePreviewUrl}
              alt={resolvedTitle}
              viewerSourceUrl={visiblePreviewUrl}
              onLoad={(event) => {
                const naturalW = event.currentTarget.naturalWidth;
                const naturalH = event.currentTarget.naturalHeight;
                if (naturalW > 0 && naturalH > 0) {
                  setNaturalSize((prev) =>
                    prev && prev.width === naturalW && prev.height === naturalH
                      ? prev
                      : { width: naturalW, height: naturalH },
                  );
                }
                const forceNaturalSize = shouldForceNaturalImageSize(data as Record<string, unknown>);
                if (data.isSizeManuallyAdjusted === true && !forceNaturalSize) {
                  return;
                }
                const nextAspectRatio = aspectRatioFromImageDimensions(
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                );
                if (!nextAspectRatio) {
                  return;
                }
                const nextSize = resolveMinEdgeFittedSize(nextAspectRatio, {
                  minWidth: MIN_WIDTH,
                  minHeight: MIN_HEIGHT,
                });
                const displaySizeMismatch =
                  Math.abs(resolvedWidth - nextSize.width) > 1 ||
                  Math.abs(resolvedHeight - nextSize.height) > 1;
                if (nextAspectRatio !== data.aspectRatio || displaySizeMismatch) {
                  updateNodeSize(id, nextSize, {
                    lockManualSize: forceNaturalSize ? false : undefined,
                    data: {
                      aspectRatio: nextAspectRatio,
                      imageNaturalWidth: event.currentTarget.naturalWidth,
                      imageNaturalHeight: event.currentTarget.naturalHeight,
                      imageAspectRatioUpdatedAt: Date.now(),
                    },
                  });
                }
              }}
              className="h-full w-full object-contain"
            />
            {!hasGeneratedResult && referenceImageUrl && !isGenerating && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleClearReference();
                }}
                title="移除参考图"
                className="nodrag absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {/* 画册数量徽标：hover 节点时出现，hover 徽标时箭头下探，点击展开画册。 */}
            {hasAlbum && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleAlbumExpanded();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={`展开 ${albumTotalSlots} 张生成结果`}
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
          </>
        ) : isGenerating && historyPreviewUrl ? (
          // 生成进行中，但用户点了历史记录预览：临时显示那张历史图，新图仍在
          // 后台生成。顶部 pill 提示「生成中」，右上「返回」回到 loading 遮罩。
          // 用原生 <img>（非 CanvasNodeImage）避免 onLoad 按预览图改节点尺寸。
          <div className="relative h-full w-full">
            <img
              src={resolveImageDisplayUrl(historyPreviewUrl)}
              alt=""
              className="h-full w-full object-contain"
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
              <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur">
                <Loader2 className="h-3 w-3 animate-spin" />
                新图片生成中…
              </span>
              <button
                type="button"
                className="nodrag pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur transition-colors hover:bg-black/75"
                onClick={(event) => {
                  event.stopPropagation();
                  setHistoryPreviewUrl(null);
                }}
              >
                <X className="h-3 w-3" />
                返回
              </button>
            </div>
          </div>
        ) : isGenerating ? (
          <div className="h-full w-full" />
        ) : generationError ? (
          // Failed with no result yet: keep the card empty so only the centered
          // error banner shows — placeholder + upload affordances would clutter it.
          <div className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full items-center px-8 text-text-muted/55">
            {isUploading ? (
              <div className="flex w-full flex-col items-center justify-center gap-2">
                <Loader2 className="h-7 w-7 animate-spin opacity-70" />
                <span className="text-[12px] leading-6">上传中…</span>
              </div>
            ) : isConnected ? (
              // 已连线：不再显示文字 CTA，只在节点中间放一个图标（对齐 libtv）。
              <div className="flex w-full items-center justify-center">
                <ImageIcon className="h-9 w-9 text-text-muted/46" aria-hidden />
              </div>
            ) : (
              <>
                <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                  <div className="text-xs text-[var(--canvas-node-input-helper)]">试试：</div>
                  <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSpawnUpstreamImage();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title="新建一个上游图片节点用作参考"
                    className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                  >
                    <Upload className="h-4 w-4 text-text-muted/90" />
                    <span>图生图</span>
                  </button>
                  </div>
                </div>
                <ImageIcon className="ml-auto mr-20 h-9 w-9 text-text-muted/46" aria-hidden />
              </>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleUploadFile(file);
          }}
        />

        {isGenerating && !historyPreviewUrl && (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            durationMs={data.generationDurationMs}
            hasBackground={Boolean(visiblePreviewUrl)}
          />
        )}

        {!isGenerating && generationError && (
          <div className="nodrag absolute inset-x-5 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center text-center">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300/90" />
              <span>{t("node.imageNode.generationFailed")}</span>
            </div>
            <div
              className="mt-1 max-h-12 max-w-full overflow-y-auto break-words text-[11px] leading-4 text-red-100/76 [overflow-wrap:anywhere]"
              title={generationError}
            >
              {generationError}
            </div>
            {generationErrorRequestId && (
              <div className="mt-1 flex max-w-full items-center justify-center gap-1.5 text-[10px] text-text-muted/58">
                <span className="shrink-0">{t("node.imageNode.requestId")}</span>
                <code className="min-w-0 max-w-[160px] truncate font-mono" title={generationErrorRequestId}>
                  {generationErrorRequestId}
                </code>
                <button
                  type="button"
                  title={errorDetailsCopied ? t("nodeToolbar.copied") : t("nodeToolbar.copyErrorReport")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCopyErrorDetails();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted/70 transition-colors hover:bg-white/10 hover:text-text-dark"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="mt-2 flex justify-center">
              <RegenerateButton
                onClick={() => void handleSubmit()}
                busy={isGenerating}
                disabled={submitDisabled}
              />
            </div>
          </div>
        )}
      </div>

      {/* 展开的画册宫格：覆盖在节点位置向右下铺开，每格与节点等尺寸。
          外层一圈「组」式轮廓（边框 + 弱底色 + 左上角标签），强调这组图是
          一个组合。hover 单格出现「应用到画布」+ 下载；点击图片设为主图。 */}
      {albumExpanded && hasAlbum && (
        // 容器不带 nodrag、也不拦 pointerdown——按住画册任意处即可拖动整个节点
        // （组合一起走）。按下时记录起点，cell 的 onClick 据此区分「点击选主图」
        // 和「拖动后松手」（React Flow 拖完浏览器仍会补发 click）。
        <div
          className="nowheel absolute -left-3 -top-3 z-[80] cursor-grab rounded-2xl border border-white/15 bg-white/[0.045] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-[2px] active:cursor-grabbing"
          style={{ width: resolvedWidth * 2 + 12 + 24 }}
          onClick={(event) => event.stopPropagation()}
          onPointerDownCapture={(event) => {
            albumPointerDownPosRef.current = { x: event.clientX, y: event.clientY };
          }}
        >
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-white/60">
            <ImageIcon className="h-3.5 w-3.5 text-white/45" />
            画册 · {albumTotalSlots} 张
          </div>
          <div className="grid grid-cols-2 gap-3">
          {albumUrls.map((url, index) => {
            const isMain = url === data.imageUrl;
            return (
              // 直接点击图片即设为主图并收拢画册（不再需要单独的「设为主图」按钮）。
              <div
                key={`album-cell-${index}`}
                role="button"
                tabIndex={-1}
                title="点击设为主图"
                onClick={(event) => {
                  event.stopPropagation();
                  // 拖动画册（移动节点）后松手补发的 click 不算选主图。
                  const start = albumPointerDownPosRef.current;
                  if (
                    start
                    && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
                  ) {
                    return;
                  }
                  handleSetAlbumMainImage(url);
                }}
                className={`group/albumcell relative cursor-pointer overflow-hidden rounded-[var(--node-radius)] border bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition-colors ${
                  isMain
                    ? 'border-accent/80 ring-2 ring-accent/40'
                    : 'border-white/12 hover:border-white/35'
                }`}
                style={{ width: resolvedWidth, height: resolvedHeight }}
              >
                <img
                  src={resolveImageDisplayUrl(url)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleApplyAlbumImageToCanvas(url);
                  }}
                  title="把这张图作为独立图片节点放到画布上"
                  className="nodrag absolute left-2 top-2 z-10 hidden h-7 items-center gap-1 rounded-md bg-black/70 px-2.5 text-[12px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Upload className="h-3.5 w-3.5" />
                  应用到画布
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownloadAlbumImage(url, index);
                  }}
                  title="下载这张图片"
                  className="nodrag absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                {isMain && (
                  <span className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                    主图
                  </span>
                )}
              </div>
            );
          })}
          {/* 还在生成中的槽位：占位骨架，完成一张替换一张。 */}
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

      {/*
        Step B + C: 场景资产 / 导演中间产物节点的内联 action 按钮
        (scene_master / scene_reverse_master 加 "用作背景源" → 打开 cropper
         dialog 选 16:9 区域 → 生成当前背景候选并自动 commit;
         director_combined 加 "打开导演世界" → 同源 viewer dialog)。
        button 浮在节点右下角,selected 时可见,避免占用节点 body 空间。
      */}
      {selected && (canUseAsBackground || canOpenDirectorStage) && (
        <div className="nodrag absolute bottom-2 right-2 z-[6] flex gap-1">
          {canUseAsBackground && (
            <button
              type="button"
              disabled={effectiveEpisode === null || effectiveBeat === null}
              onClick={(event) => {
                event.stopPropagation();
                setBgCropperOpen(true);
              }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-300/55 bg-[rgba(120,77,19,0.78)] px-2 text-[10px] font-medium text-amber-100 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] hover:bg-[rgba(140,90,22,0.88)] disabled:cursor-not-allowed disabled:opacity-50"
              title={`从 ${sourceRole === 'scene_master' ? 'scene_master' : 'scene_reverse_master'} 选一个 16:9 区域写入本 beat 的 selected_background.png — beat 工作台后续 sketch/render 会用这张做背景锚点`}
            >
              📐 截取背景
            </button>
          )}
          {canOpenDirectorStage && (
            <button
              type="button"
              disabled={directorStageBusy}
              onClick={(event) => {
                event.stopPropagation();
                void handleOpenDirectorStageInline();
              }}
              className={`inline-flex h-6 items-center gap-1 rounded-md border border-sky-300/55 px-2 text-[10px] font-medium shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${
                directorStageBusy
                  ? 'cursor-not-allowed bg-sky-400/10 text-sky-100/60'
                  : 'bg-[rgba(15,67,107,0.78)] text-sky-100 hover:bg-[rgba(22,90,140,0.88)]'
              }`}
              title={t("viewer.threeD.openDirectorWorldTitle")}
            >
              {directorStageBusy
                ? t("viewer.threeD.openingDirectorWorld")
                : `🎬 ${t("viewer.threeD.directorWorld")}`}
            </button>
          )}
        </div>
      )}

      {/*
        自由 canvas 上 ImageGenNode 的全功能 ops panel (camera / model picker /
        free reference upload / generation count / style picker / submit ...).
        Preset-managed source nodes hide this panel; user-spawned nodes keep it.
      */}
      {showImageOpsPanel && (
        <OperationPanelShell
          expanded={panelExpanded}
          onCollapse={() => setPanelExpanded(false)}
          inlineClassName={`nodrag absolute left-1/2 z-10 flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
          inlineStyle={{
            top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)`,
            height: panelHeight,
            width: panelWidth,
          }}
          modalStyle={{
            width: `min(${OPERATIONS_PANEL_EXPANDED_MIN_WIDTH}px, 92vw)`,
            height: `min(${OPERATIONS_PANEL_EXPANDED_HEIGHT}px, 86vh)`,
          }}
        >
          <PanelExpandButton
            expanded={panelExpanded}
            onToggle={() => setPanelExpanded((v) => !v)}
            className="absolute right-2 top-2 z-20"
          />
          <div className="flex shrink-0 items-center gap-2 pl-3 pr-10 pt-3">
            <StyleChip
              selectedId={styleTemplateId}
              selectedLabel={selectedStyle?.label ?? null}
              onChange={(nextId) => updateNodeData(id, { styleTemplateId: nextId })}
              onOpenChange={setStylePickerOpen}
            />
            <NodeContextPromptPaletteButton
              nodeId={id}
              onInsert={insertContextPaletteEntry}
            />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setIsAssetLibraryOpen(true);
              }}
              className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/asset px-1.5`}
              title="从资产库选择参考图（人物 / 场景 / 道具）"
            >
              <Library className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/asset:text-text-dark`} />
              <span>资产库</span>
            </button>
            {upstreamTextContents.map((content) => (
              <ReferenceTextChip
                key={content.nodeId}
                nodeId={content.nodeId}
                text={content.text ?? ''}
                sourceLabel={content.displayName ?? content.nodeType}
                onDetach={handleDetachUpstream}
              />
            ))}
            {upstreamImageContents.length > 0 && (
              <div className="ml-3 flex shrink-0 items-center gap-1.5">
                {upstreamImageContents.map((content) => {
                  const url = resolveImageDisplayUrl(content.imageUrl as string);
                  return (
                    <div
                      key={`upstream-image-${content.nodeId}`}
                      className={NODE_REFERENCE_MEDIA_CHIP_CLASS}
                      title={`来自上游 · ${content.displayName ?? content.nodeType}`}
                      onMouseEnter={(event) => {
                        setRefHover({
                          imageUrl: url,
                          rect: event.currentTarget.getBoundingClientRect(),
                        });
                      }}
                      onMouseLeave={() => setRefHover(null)}
                    >
                      <img
                        src={url}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                      {/* 前端按产品要求不再显示「图片N」数字角标——引用统一呈现为
                          「图片」，序号只存在于提交给后端的 prompt（@图片N）里。 */}
                      <button
                        type="button"
                        title="取消引用此素材"
                        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          setRefHover(null);
                          handleDetachUpstream(content.nodeId);
                        }}
                      >
                        <X className="h-3 w-3" strokeWidth={2.5} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <PromptMentionEditor
            ref={promptEditorRef}
            value={prompt}
            onChange={(next) => {
              hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
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
              hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
              setPromptDraft(next);
              updateNodeData(id, { prompt: next });
            }}
            candidates={mentionCandidates}
            placeholder={
              upstreamTextJoined.length > 0
                ? '上游内容已自动接入，可继续补充提示词…'
                : '描述你想要生成的画面内容，@引用素材'
            }
            className={`nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
          />

          <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderModelPicker
                selectedModelId={modelId}
                onChange={(nextModelId) => updateNodeData(id, { model: nextModelId })}
                popoverPlacement="top"
              />
              <AspectSizeChip
                aspectRatio={aspectRatio}
                size={size}
                quality={quality}
                showQuality={isImage2}
                onChange={(patch) => updateNodeData(id, patch)}
              />
              <CameraChip
                selection={cameraSelection}
                summary={cameraSummary}
                onChange={(next) => updateNodeData(id, { cameraSelection: next })}
              />
              {!canAutoCommitOnGenerate && (
                <CountSelect
                  value={count}
                  onChange={(nextCount) => updateNodeData(id, { count: nextCount })}
                />
              )}
              <button
                type="button"
                title="翻译提示词（中英文互译）"
                disabled={isTranslatingPrompt || isGenerating || prompt.trim().length === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleTranslatePrompt();
                }}
                className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
                  isTranslatingPrompt
                    ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS
                    : ''
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
                title="生成"
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
      {selected && !isBoxSelecting && !hasActiveOverlay && !panelExpanded && !stylePickerOpen && hasCompletedHistoryRecords(historyRecords) && (
        <div
          className={`nodrag absolute left-1/2 z-[300] -translate-x-1/2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} ${NODE_OPS_PANEL_ENTER_CLASS} px-3 py-2`}
          style={{
            top: `calc(100% + ${OPERATIONS_PANEL_GAP * 2 + panelHeight}px)`,
            width: panelWidth,
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
              // 预览态下高亮正在预览的历史条，否则高亮当前主图。
              if (isGenerating && historyPreviewUrl) {
                return url === historyPreviewUrl;
              }
              return url === data.imageUrl;
            }}
          />
        </div>
      )}
      {refHover && refPreviewStyle
        && createPortal(
          <div
            className="pointer-events-none fixed z-[10001] overflow-hidden rounded-lg border border-white/15 bg-surface-dark/95 shadow-xl"
            style={{
              left: refPreviewStyle.left,
              top: refPreviewStyle.top,
              width: refPreviewStyle.size,
              height: refPreviewStyle.size,
            }}
          >
            <img
              src={refHover.imageUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          </div>,
          document.body,
        )}

      {/* Step B: 平面 source (master/reverse) 的截取背景 dialog。
          Pano360 / 3GS 不走这条 — 它们用各自 viewer 上的 capture 按钮。 */}
      {canUseAsBackground && effectiveEpisode !== null && effectiveBeat !== null && (
        <BackgroundCropperDialog
          isOpen={bgCropperOpen}
          onClose={() => setBgCropperOpen(false)}
          sourceUrl={typeof data.imageUrl === 'string' ? data.imageUrl : ''}
          sourceLabel={sourceRole === 'scene_master' ? 'master' : 'reverse'}
          aspectOptions={SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS}
          onConfirmBlob={async (blob, filename) => {
            await uploadAndAutoCommitSelectedBackgroundCandidate(
              { episode: effectiveEpisode, beat: effectiveBeat },
              blob,
              filename,
              {
                sourceNodeId: id,
                label: t("viewer.threeD.selectedBackgroundOutputLabel"),
                successMessage: t("viewer.threeD.selectedBackgroundCommitSuccess", {
                  episode: effectiveEpisode,
                  beat: effectiveBeat,
                }),
              },
            );
          }}
          onCandidateSuccess={() => setBgCropperOpen(false)}
          onError={(msg) => console.warn('[bg-cropper]', msg)}
        />
      )}
      {canOpenDirectorStage && (
        <ThreeDDirectorDialog
          open={directorStageOpen}
          onOpenChange={setDirectorStageOpen}
          manifest={directorStageManifest}
          title={t("viewer.threeD.beatDirectorWorld")}
          description={t("viewer.threeD.beatDirectorWorldDescription")}
          viewerPurpose="beat"
          autoCommitDirectorCombined
          onSubmitDirectorCombined={handleDirectorCaptureCombined}
        />
      )}
      <AssetLibraryModal
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        allowedMedia={['image']}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={(selections) => spawnAssetLibraryReferences(selections)}
      />
    </div>
  );
});

ImageGenNode.displayName = 'ImageGenNode';

// 图片按自然尺寸算出的比例常是约分形式（如 21:9 会被约成 7:3），不在 ASPECT_OPTIONS 里，
// 直接显示就会出现「7:3」这种列表外的标签。这里退回到「数值最接近的可选比例」（复用
// imageData 的 pickClosestAspectRatio）——chip 标签与下拉里的高亮选项都基于它，保证两边一致。
function resolveNearestAspectOption(aspectRatio: string): { value: string; label: string } {
  const exact = ASPECT_OPTIONS.find((option) => option.value === aspectRatio);
  if (exact) return exact;
  const candidates = ASPECT_OPTIONS.filter((option) => option.value !== 'auto');
  const nearestValue = pickClosestAspectRatio(
    parseAspectRatio(aspectRatio),
    candidates.map((option) => option.value),
  );
  return (
    candidates.find((option) => option.value === nearestValue)
    ?? { value: aspectRatio, label: aspectRatio }
  );
}

interface AspectSizeChipProps {
  aspectRatio: string;
  size: ImageSize;
  quality: ImageQuality;
  /** image2 系模型才显示「画质」选择器，并在标签里带上画质。 */
  showQuality: boolean;
  onChange: (patch: Partial<ImageGenNodeData>) => void;
}

function AspectSizeChip({ aspectRatio, size, quality, showQuality, onChange }: AspectSizeChipProps) {
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
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  const nearestAspect = resolveNearestAspectOption(aspectRatio);
  const aspectLabel = nearestAspect.label;
  const qualityLabel = QUALITY_OPTIONS.find((option) => option.value === quality)?.label
    ?? quality;

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
        <span>{aspectLabel}</span>
        {showQuality && (
          <>
            <span className="text-text-muted/80">·</span>
            <span>{qualityLabel}</span>
          </>
        )}
        <span className="text-text-muted/80">·</span>
        <span>{size}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={IMAGE_PARAM_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {showQuality && (
            <>
              <div className={IMAGE_PARAM_LABEL_CLASS}>画质</div>
              <div className={IMAGE_PARAM_ROW_CLASS}>
                {QUALITY_OPTIONS.map((option) => {
                  const isActive = quality === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => onChange({ quality: option.value })}
                      className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} flex-1 ${
                        isActive
                          ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                          : IMAGE_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className={IMAGE_PARAM_LABEL_CLASS}>分辨率</div>
          <div className={IMAGE_PARAM_ROW_CLASS}>
            {SIZE_OPTIONS.map((option) => {
              const isActive = size === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChange({ size: option })}
                  className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} flex-1 ${
                    isActive
                      ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                      : IMAGE_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </div>

          <div className={IMAGE_PARAM_LABEL_CLASS}>比例</div>
          <div className="grid grid-cols-4 gap-2">
            {ASPECT_OPTIONS.map((option) => {
              const isActive = nearestAspect.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange({ aspectRatio: option.value })}
                  className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                      : IMAGE_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface StyleChipProps {
  selectedId: string | null;
  selectedLabel: string | null;
  onChange: (nextId: string | null) => void;
  onOpenChange?: (open: boolean) => void;
}

function StyleChip({ selectedId, selectedLabel, onChange, onOpenChange }: StyleChipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  useEffect(() => {
    return () => onOpenChange?.(false);
  }, [onOpenChange]);

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
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  const isActive = Boolean(selectedId);
  const label = isActive ? selectedLabel ?? '风格' : '风格';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        title={isActive ? selectedLabel ?? undefined : '风格'}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} max-w-[160px]`}
      >
        <Palette className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
        <span className="truncate">{label}</span>
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 z-50 mt-2"
          onClick={(event) => event.stopPropagation()}
        >
          <StylePickerPopover
            selectedId={selectedId}
            onSelect={(nextId) => {
              onChange(nextId);
              setIsOpen(false);
            }}
            onClose={() => setIsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

interface CameraChipProps {
  selection: ImageGenCameraSelection | null;
  summary: string | null;
  onChange: (next: ImageGenCameraSelection | null) => void;
}

function CameraChip({ selection, summary, onChange }: CameraChipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const syncPopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    setPopoverPosition({
      left: Math.min(
        Math.max(margin, rect.left),
        window.innerWidth - CAMERA_PICKER_POPOVER_WIDTH - margin,
      ),
      top: Math.max(margin, rect.top - 8),
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
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, syncPopoverPosition]);

  const isActive = Boolean(selection) && summary != null;
  const label = isActive && summary ? summary : '摄像机';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        title={isActive ? summary ?? undefined : '摄像机'}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} max-w-[220px]`}
      >
        <Camera className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
        <span className="truncate">{label}</span>
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[10000]"
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
            transform: 'translateY(-100%)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <CameraPickerPopover
            selection={selection}
            onConfirm={(next) => {
              onChange(next);
              setIsOpen(false);
            }}
            onClose={() => setIsOpen(false)}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

interface CountSelectProps {
  value: ImageGenCount;
  onChange: (value: ImageGenCount) => void;
}

function CountSelect({ value, onChange }: CountSelectProps) {
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
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
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
        <span>{value}张</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={NODE_COUNT_POPOVER_CLASS}
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
                className={`${NODE_COUNT_OPTION_BASE_CLASS} ${
                  isActive
                    ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                    : 'text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark'
                }`}
              >
                {option}张
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
