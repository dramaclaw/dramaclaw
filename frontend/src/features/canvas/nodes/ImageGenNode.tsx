// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  type ImageGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveImageDisplayUrl,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
  shouldForceNaturalImageSize,
} from '@/features/canvas/application/imageNodeSizing';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  mainlineNodeVisualState,
  nodeMainlineFlags,
} from '@/features/canvas/domain/mainlineNodeFlags';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { PanelExpandButton } from '@/features/canvas/ui/PanelExpandButton';
import {
  NODE_OPS_PANEL_ENTER_CLASS,
  OperationPanelShell,
} from '@/features/canvas/ui/OperationPanelShell';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { useAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { useModelTaskAccess } from '@/lib/model-task-access';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { getFreezoneCanvasMetadata } from '@/features/freezone/canvasMetadataContext';
import { uploadFreezoneImage } from '@/api/ops';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import { getBeatDirectorStageManifest } from '@/api/viewerManifests';
import { BackgroundCropperDialog } from '@/features/canvas/ui/BackgroundCropperDialog';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type { DirectorStageManifest } from '@/features/viewer-kit/three-d/directorManifest';
import { readUrl } from '@/lib/url-params';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from '@/features/canvas/ui/NodeGenerationHistory';
import { CandidateBindingBadges } from '@/features/freezone/context/NodeContextBadges';
import {
  collectCandidateBindingsForNode,
} from '@/features/freezone/context/mainlineContext';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import { GENERATION_ERROR_CLEARED_PATCH } from '@/features/canvas/application/generationTaskArbitration';
import { ImageGenerationForm } from '@/features/canvas/nodes/shared/ImageGenerationForm';
import { spawnAssetLibraryReferences } from '@/features/canvas/nodes/shared/assetLibraryReferenceSpawn';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { useImageOpFormProps } from '@/features/canvas/nodes/shared/useImageOpFormProps';

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

// 面板高度。参考素材独占一行（缩略图 48px + 间距）之后，232px 只给提示词剩下两行
// 多一点，写长一点就要在窄缝里滚——加高到给提示词留出四五行的程度。
const OPERATIONS_PANEL_HEIGHT = 288;
const OPERATIONS_PANEL_GAP = 12;
const OPERATIONS_PANEL_MIN_WIDTH = 720;
// 「放大」后的操作区尺寸：给提示词编辑区更舒适的高度与宽度。
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_MIN_WIDTH = 960;

const SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS = ['2:3', '16:9'] as const;

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
  const addNodeAction = useCanvasStore((state) => state.addNode);
  const addEdgeAction = useCanvasStore((state) => state.addEdge);

  // Per-node generation history. Only fetch while the node is selected so an
  // unselected canvas full of nodes doesn't fan out a request each. `refresh`
  // is called after a generation settles to pull in the new record.
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

  // 提示词草稿（含输入法合成态）、上游文本/图片、@图片N 编号、模型/参数/算力、
  // 翻译与提交编排全在这个 hook 里 —— 它不读 React Flow 上下文，只按 nodeId 从
  // canvasStore 取数，所以故事板详情也能挂同一张表单。
  const {
    formProps: imageGenerationFormProps,
    isGenerating,
    submitDisabled: formSubmitDisabled,
    submit: handleSubmit,
    canAutoCommitOnGenerate,
    referenceImageUrl,
    invalidateInFlightGeneration,
  } = useImageGenerationForm(id, { onGenerationSettled: refreshHistory });

  // 功能节点（工具条「九宫格」下拉点某一项后建出来的那种）：输入框里多一枚可切可删
  // 的功能 chip、功能说明当占位文案、↑ 走对应模板。与故事板详情共用同一个 hook，
  // 两个视图的交互因此完全一致；普通图片生成节点拿到 null，渲染与从前一致。
  const opFormProps = useImageOpFormProps(id, { isGenerating });

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [errorDetailsCopied, setErrorDetailsCopied] = useState(false);

  const handleCopyErrorDetails = useCallback(async () => {
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
      // 用户挑的这张历史图作数，上一批还在结算的请求全部作废——否则它们回来会把
      // 刚恢复的图盖掉。
      invalidateInFlightGeneration();
      updateNodeData(id, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        // 恢复的是单张历史结果，旧批次画册已与主图脱钩（没有任何一张会命中
        // 「主图」标记，点画册格还会静默丢掉刚恢复的图）——一并清掉。
        generationBatch: null,
        // 节点上已经换成历史里那张成功的图了，上一次失败的横幅不能再盖着。
        ...GENERATION_ERROR_CLEARED_PATCH,
      });
    },
    [id, invalidateInFlightGeneration, isGenerating, updateNodeData],
  );

  // 生成结束（成功/失败）后清掉临时历史预览，让主体回到最新结果。
  useEffect(() => {
    if (!isGenerating) setHistoryPreviewUrl(null);
  }, [isGenerating]);

  const freezoneSource = (data.__freezone_source as
    | { role?: string; meta?: Record<string, unknown> }
    | undefined) ?? undefined;
  const sourceRole = typeof freezoneSource?.role === "string"
    ? freezoneSource.role
    : "";
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

  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  // Spawn upload reference nodes from selected asset-library images — one per
  // selection, stacked to the left of this node, then wired as upstream refs so
  // they feed the multi-reference generation. Image-only here (the modal is
  // opened with allowedMedia=['image']), but we still guard on media.
  // 编排本体抽到 shared/assetLibraryReferenceSpawn（纯 store 操作），故事板详情里
  // 的同一份生成表单复用它，两处「资产库」chip 行为一致。
  const handleAssetLibraryConfirm = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      spawnAssetLibraryReferences(id, selections);
    },
    [id],
  );

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.imageGen, data, t),
    [data, t],
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
      updateNodeData(id, {
        imageUrl: url,
        previewImageUrl: url,
        ...GENERATION_ERROR_CLEARED_PATCH,
      });
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
        // 参考图在显示优先级里排最后（previewImageUrl → imageUrl → referenceImageUrl），
        // 只有节点还没有生成结果时它才会顶到主体上——这时旧的失败横幅盖的是新图，得清掉。
        // 已经有生成图时主体不变，失败信息仍然对得上那张图，保留；等用户真正重新提交，
        // handleSubmit 自己会清。
        updateNodeData(id, {
          referenceImageUrl: result.url,
          ...(hasGeneratedResult ? {} : GENERATION_ERROR_CLEARED_PATCH),
        });
      } catch (error) {
        console.error('[image-gen] upload failed', error);
      } finally {
        setIsUploading(false);
      }
    },
    [hasGeneratedResult, id, updateNodeData],
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

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // 组织成员没有发起模型任务的资格时不放行提交（节点动作、失败重试与面板按钮
  // 都从这里拿 submitDisabled）。其余提交可用性判断已下沉到 useImageGenerationForm。
  const modelTaskAccess = useModelTaskAccess();
  const submitDisabled = formSubmitDisabled || modelTaskAccess.blocked;

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, executionMode, requestId }) => {
      if (nodeId !== id || action !== 'generate_image') return;
      publishNodeActionAccepted(requestId, id, action);
      void handleSubmit({
        completionMode: executionMode === 'single' ? 'submitted' : 'completed',
      })
        .then((output) => publishNodeActionSuccess(requestId, id, action, output))
        .catch((error) => publishNodeActionError(requestId, id, action, error));
    });
  }, [handleSubmit, id]);

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
        throw new Error(t('node.imageGen.missingContext'));
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
        ...GENERATION_ERROR_CLEARED_PATCH,
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
                title={t('node.imageGen.album.expand')}
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
      <AddNodeToChatButton nodeId={id} />
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
            title={t('node.imageGen.upload')}
            className={NODE_SIDE_ACTION_BUTTON_CLASS}
          >
            {isUploading ? (
              <Loader2 className={`${NODE_SIDE_ACTION_ICON_CLASS} animate-spin`} />
            ) : (
              <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
            )}
            <span>{t(isUploading ? 'node.imageGen.uploading' : 'node.imageGen.upload')}</span>
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
                title={t('node.imageGen.removeReference')}
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
                title={t('node.imageGen.album.expandCount', { count: albumTotalSlots })}
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
                {t('node.imageGen.history.generatingNew')}
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
                {t('node.imageGen.history.back')}
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
                <span className="text-[12px] leading-6">{t('node.imageGen.uploadingEllipsis')}</span>
              </div>
            ) : isConnected ? (
              // 已连线：不再显示文字 CTA，只在节点中间放一个图标（对齐 libtv）。
              <div className="flex w-full items-center justify-center">
                <ImageIcon className="h-9 w-9 text-text-muted/46" aria-hidden />
              </div>
            ) : (
              <>
                <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                  <div className="text-xs text-[var(--canvas-node-input-helper)]">
                    {t('node.imageGen.emptyState.tryLabel')}
                  </div>
                  <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSpawnUpstreamImage();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t('node.imageGen.emptyState.imageToImageTitle')}
                    className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                  >
                    <Upload className="h-4 w-4 text-text-muted/90" />
                    <span>{t('node.imageGen.emptyState.imageToImage')}</span>
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
              {/* 功能节点重试要走它自己的模板，别退回常规文生图（那样重试出来的
                  东西跟失败的那次不是一回事）。 */}
              <RegenerateButton
                onClick={() => (opFormProps ? opFormProps.onSubmit() : void handleSubmit())}
                busy={isGenerating}
                disabled={opFormProps ? opFormProps.submitDisabled : submitDisabled}
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
            {t('node.imageGen.album.heading', { count: albumTotalSlots })}
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
                title={t('node.imageGen.album.setAsMain')}
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
                  title={t('node.imageGen.album.applyToCanvas')}
                  className="nodrag absolute left-2 top-2 z-10 hidden h-7 items-center gap-1 rounded-md bg-black/70 px-2.5 text-[12px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {t('node.imageGen.album.applyToCanvasLabel')}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownloadAlbumImage(url, index);
                  }}
                  title={t('node.imageGen.album.download')}
                  className="nodrag absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                {isMain && (
                  <span className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                    {t('node.imageGen.album.mainImage')}
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
                <span className="text-[12px]">{t('node.imageGen.album.generating')}</span>
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
              title={t('node.imageGen.cropBackgroundTitle', {
                source: sourceRole === 'scene_master' ? 'scene_master' : 'scene_reverse_master',
              })}
            >
              {t('node.imageGen.cropBackground')}
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
          <ImageGenerationForm
            {...imageGenerationFormProps}
            onStylePickerOpenChange={setStylePickerOpen}
            onOpenAssetLibrary={() => setIsAssetLibraryOpen(true)}
            {...(opFormProps ?? {})}
          />
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
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        allowedMedia={['image']}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={handleAssetLibraryConfirm}
      />
    </div>
  );
});

ImageGenNode.displayName = 'ImageGenNode';
