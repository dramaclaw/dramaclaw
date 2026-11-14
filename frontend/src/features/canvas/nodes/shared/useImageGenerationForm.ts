// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type {
  ImageGenCameraSelection,
  ImageGenCount,
  ImageGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { setAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { resolveImageGenerationCompletionMode } from '@/features/canvas/nodes/imageGenCompletionMode';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { workflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { imageGenerationResultUrls } from '@/features/canvas/application/imageGenerationResults';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  ensureBackendImageUrls,
  sendGenerationWireRequest,
  type FreezoneJobRef,
} from '@/api/ops';
import { translateNodeText } from '@/features/canvas/application/translateText';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  BillingRuleNotConfiguredError,
} from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { describeCameraSelection } from '@/features/canvas/nodes/CameraPickerPopover';
import { isTaskCancelledError } from '@/features/canvas/application/generationTaskArbitration';
import { useFreezoneCameraOptions } from '@/features/canvas/hooks/useFreezoneCameraOptions';
import { describeStyleSelection } from '@/features/canvas/nodes/StylePickerPopover';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { extractUpstreamContent, joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { type MentionCandidate } from '@/features/canvas/nodes/PromptMentionEditor';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { hasImageGenPromptOverride } from '@/features/canvas/nodes/imageGenPrompt';
import { upstreamNodesInEdgeOrder } from '@/features/canvas/nodes/referenceOrdering';
import { matchesReference, referenceIssueName, type ReferenceIssue } from '@/features/canvas/nodes/shared/ReferenceValidationDialog';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';
import { attachCompletedStoryAsset, attachCompletedStoryFrame } from '@/features/canvas/application/videoContinuity';
import type { ImageGenerationFormProps } from '@/features/canvas/nodes/shared/ImageGenerationForm';

import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import {
  buildImageGenerationRequest, imagePromptCompileInput, imagePromptCompileMetadataPatch,
  imageGenerationModel, imageGenerationOptions, imageGenerationReferenceUrls, imageGenerationMode,
  imageGenerationCount, imageGenerationStartPatch, imageGenerationRunAccepted,
  imageGenerationAcceptedPatch, imageGenerationOutcomePatch, imageGenerationBackgroundFailurePatch,
  imageGenerationSettleOutcome, imageGenerationMissingUrlOutcome, describeGenerationError,
  type ImageGenerationRequestContext, type ImageGenerationTaskRef, type ImageGenerationOutcome,
} from '@/features/canvas/application/generationRequests';

// 统一计费（#210）：图片生成走 feature 键询价，模型身份塞进 params。
const IMAGE_GENERATE_FEATURE_KEY = 'freezone.image_generate';

// 节点被删除 / 尚未出现在 store 里时的空数据兜底，保持 hook 的 early-return-free
// 结构（hooks 数量必须每帧一致）。
const EMPTY_NODE_DATA = {} as ImageGenNodeData;

/**
 * `ImageGenerationForm` 的 props 里，由本 hook 负责供给的那一部分。
 *
 * 剩下的两个（`onStylePickerOpenChange` / `onOpenAssetLibrary`）是**宿主自己的
 * 浮层编排**——前者用来让宿主临时藏起叠在下方的历史记录条，后者打开宿主持有的
 * 素材库弹窗——与生成表单的数据/提交无关，故不进 hook。
 */
export type ImageGenerationFormBoundProps = Omit<
  ImageGenerationFormProps,
  'onStylePickerOpenChange' | 'onOpenAssetLibrary'
>;

export interface UseImageGenerationFormOptions {
  /**
   * 一批生成（含并发的 N 次调用）全部尘埃落定后触发。节点用它刷新「生成历史」
   * 记录条；不关心历史的宿主可以不传。
   */
  onGenerationSettled?: () => void;
  /** 首个任务受理成功时触发（用于节点收起大面板等交互）。 */
  onTaskAccepted?: () => void;
}

export interface UseImageGenerationFormResult {
  /** 直接展开给 `<ImageGenerationForm {...formProps} />`。 */
  formProps: ImageGenerationFormBoundProps;
  /**
   * 下面几个值 formProps 里也有，但宿主自己还要用：
   * - isGenerating / submitDisabled / submit：节点上「生成失败」横幅的重试按钮，
   *   以及历史记录点击时的「非破坏性预览」分支；
   * - canAutoCommitOnGenerate：决定主线托管节点是否只读；
   * - referenceImageUrl：节点主体的占位图 / 「移除参考图」按钮。
   */
  isGenerating: boolean;
  submitDisabled: boolean;
  /**
   * 提交生成。completionMode='submitted' 时提交完成即返回任务句柄，产物在后台
   * 回填（工作流配方按单节点执行时用）；默认 'completed' 等产物落地后再返回。
   */
  submit: (
    options?: {
      completionMode?: 'submitted' | 'completed';
      executionSource?: 'manual' | 'workflow';
      attachStoryFrame?: boolean;
    },
  ) => Promise<Record<string, unknown> | undefined>;
  canAutoCommitOnGenerate: boolean;
  referenceImageUrl: string | null;
  referenceErrors: ReferenceIssue[];
  referenceErrorsOpen: boolean;
  closeReferenceErrors: () => void;
  openReferenceErrors: () => void;
  /**
   * 作废在途生成（#224）。宿主每条「用户主动换掉节点上这张图」的路径都要先调它，
   * 否则上一批还在飞的请求回来会把刚换上的图盖掉，或糊上一条对不上号的失败横幅。
   */
  invalidateInFlightGeneration: () => void;
}

/**
 * 图片生成表单的**父级状态与提交编排**：prompt 草稿 + 输入法合成态、上游文本/
 * 图片、@图片N 编号与重排、模型/参数/算力、翻译、以及并发出图的 handleSubmit。
 *
 * 与 `ImageGenerationForm` 一样不碰任何 React Flow 上下文——节点数据一律从
 * `useCanvasStore` 按 id 取（画布喂给 ReactFlow 的就是 store 里的同一份 nodes，
 * 因此与节点组件收到的 `data` prop 是同一个对象）。这样故事板详情之类的独立
 * 布局也能直接 `useImageGenerationForm(nodeId)` 拿到整套能力。
 */
export function useImageGenerationForm(
  nodeId: string,
  options?: UseImageGenerationFormOptions,
): UseImageGenerationFormResult {
  const { t } = useTranslation();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const id = nodeId;

  const data = (useCanvasStore(
    (state) => state.nodes.find((node) => node.id === nodeId)?.data,
  ) ?? EMPTY_NODE_DATA) as ImageGenNodeData;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // Local prompt buffer keeps the textarea's React `value` in lockstep with
  // user input even during IME composition (中文输入法). Committing to the
  // Zustand store on every keystroke triggers a global re-render that can
  // clobber the in-flight composition; the buffer absorbs that race.
  const externalPrompt = typeof data.prompt === 'string' ? data.prompt : '';
  const [promptDraft, setPromptDraft] = useState(externalPrompt);
  const isComposingRef = useRef(false);
  const hasUserEditedPromptRef = useRef(false);
  const submittingRef = useRef(false);
  // 用户手动换图（恢复历史记录等）会作废上一批还在飞的请求：异步完成回来时必须
  // 先对上这个计数器，才允许把结果或错误写回节点，否则新图刚换上就被旧批次覆盖，
  // 或者盖上一条对不上号的失败横幅。宿主换图路径调 invalidateInFlightGeneration()。
  const generationAttemptRef = useRef(0);
  // 在途提交的等待队列：配方运行时可能在同一节点上并发触发 submit，后到的调用
  // 不另起一次生成，而是挂在这里等前一次的产物（与工作流侧语义一致）。
  const submitWaitersRef = useRef<Array<(value: Record<string, unknown> | undefined) => void>>([]);
  useEffect(() => {
    if (isComposingRef.current) return;
    setPromptDraft(externalPrompt);
  }, [externalPrompt]);
  const prompt = promptDraft;
  const count = (data.count ?? 1) as ImageGenCount;
  const autoCommitOnGenerate = data.autoCommitOnGenerate === true;
  const canAutoCommitOnGenerate =
    autoCommitOnGenerate &&
    isSystemManagedNodeData(data);
  const { isGenerating } = useNodeGenerationTaskState(data);
  const cameraSelection = (data.cameraSelection ?? null) as ImageGenCameraSelection | null;
  const styleTemplateId =
    typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
      ? data.styleTemplateId
      : null;
  const referenceImageUrl =
    typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
      ? data.referenceImageUrl
      : null;
  const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
  const [referenceErrors, setReferenceErrors] = useState<ReferenceIssue[]>([]);
  const [referenceErrorsOpen, setReferenceErrorsOpen] = useState(false);

  const {
    models: availableModels,
    isLoading: imageModelsLoading,
    isFallback: imageModelsFallback,
  } = useFreezoneImageModels();

  const selectedModel = useMemo(() => imageGenerationModel(data, availableModels), [data, availableModels]);
  const modelId = selectedModel?.id ?? '';
  const {
    sizes: modelSizeOptions, aspectOptions: modelAspectOptions, qualities: qualityOptions,
    aspectRatio, effectiveImageSize, effectiveQuality,
  } = useMemo(() => imageGenerationOptions(data, selectedModel), [data, selectedModel]);
  const supportsImageQuality = qualityOptions.length > 0;
  const imageSelectionForCost =
    imageModelsLoading || imageModelsFallback ? null : selectedModel?.apiModel ?? null;
  const imageQuantity = imageGenerationCount(data);
  // 统一计费（#210）：按 feature 键询价，模型身份走 buildImageFeatureBillingParams
  // 拼进 params。与 ImageGenNode 从前的写法必须逐字一致，否则同一个节点在工作流
  // 和故事板两个视图里会报出不同的价格。
  const imageCreditCost = useGenerationCreditCost(
    'feature',
    imageSelectionForCost ? IMAGE_GENERATE_FEATURE_KEY : null,
    {
      surface: 'canvas',
      params: buildImageFeatureBillingParams(selectedModel, {
        size: effectiveImageSize,
        ...(supportsImageQuality ? { quality: effectiveQuality } : {}),
        pricing_quantity: imageQuantity,
      }),
      quantity: imageQuantity,
    },
  );
  const imageBillingRuleMissing =
    imageCreditCost.error instanceof BillingRuleNotConfiguredError;
  const billingRuleMissingSubmitMessage = imageBillingRuleMissing
    ? t('node.imageGenNode.billingRuleMissingSubmit')
    : null;
  // 用服务端下发的 `display`，别自己 format `cost`：促销时 display 是「原价→现价」，
  // CreditCostPill 正是靠这个 `→` 才渲染划线原价和促销标签（credit-visual.tsx:117）。
  // 自拼出来的只有一个数字，促销展示会整块消失。口径与 ImageGenNode 一致。
  const totalCreditCostDisplay = useMemo(() => {
    const display = imageCreditCost.data?.data.display;
    if (!display) {
      return imageBillingRuleMissing
        ? t('common.billingRuleNotConfiguredShort')
        : null;
    }
    return display;
  }, [imageBillingRuleMissing, imageCreditCost.data?.data.display, t]);
  // display 与 promotion 必须成对下发：只有前者时标签会兜底成通用的「促销中」，
  // 拿不到「限时 5 折」这种真实文案。
  const creditPromotion = imageCreditCost.data?.data.promotion ?? null;
  const { options: cameraOptions } = useFreezoneCameraOptions();
  const cameraSummary = describeCameraSelection(cameraSelection, cameraOptions);
  const { templates: styleTemplates } = useFreezoneStyleTemplates();
  const selectedStyle = describeStyleSelection(styleTemplateId, styleTemplates);

  const upstreamNodes = useUpstreamNodes(id);
  const upstreamContents = useMemo(() => upstreamNodes.map(extractUpstreamContent), [upstreamNodes]);
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
  const orderedReferenceUrls = useMemo(
    () => imageGenerationReferenceUrls(data, upstreamNodes), [data, upstreamNodes],
  );
  const generationMode = imageGenerationMode(orderedReferenceUrls);

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
      const translated = await translateNodeText(projectId, {
        text: prompt,
        nodeId: id,
        nodeType: 'image',
      });
      if (translated) {
        setPromptDraft(translated);
        updateNodeData(id, { prompt: translated });
      }
    } catch (error) {
      console.error('[image-gen] translate failed', error);
    } finally {
      setIsTranslatingPrompt(false);
    }
  }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

  // 「实时读取上游」：用户可以不填 prompt，只要上游连了带 text 的节点
  // (文本/脚本/图片生成 prompt 等) 就能 submit；submit 时拼接上游 text。
  const hasEffectivePrompt =
    prompt.trim().length > 0 ||
    (
      upstreamTextJoined.length > 0 &&
      (!shouldInlineUpstreamTextAsPrompt || !hasUserEditedPromptRef.current)
    );
  // 媒体目录可以给模型声明参考图上限；超了就别让用户点下去白等一次后端 400。
  const selectedModelReferenceError =
    selectedModel?.referenceImageMax != null &&
    orderedReferenceUrls.length > selectedModel.referenceImageMax
      ? `该模型最多支持 ${selectedModel.referenceImageMax} 张图片素材`
      : null;
  // 下拉里逐项标灰：换到上限更小的模型前就能看见「该模型最多支持 N 张」。
  const getModelOptionDisabledReason = useCallback(
    (model: { referenceImageMax?: number | null }) =>
      model.referenceImageMax != null && orderedReferenceUrls.length > model.referenceImageMax
        ? `该模型最多支持 ${model.referenceImageMax} 张图片素材`
        : null,
    [orderedReferenceUrls.length],
  );
  const submitDisabled =
    isGenerating ||
    !selectedModel ||
    !hasEffectivePrompt ||
    imageBillingRuleMissing ||
    selectedModelReferenceError !== null;

  /**
   * 宿主在「用户主动把节点上的图换成别的」时调用（恢复历史记录、把画册某格设为
   * 主图……）：作废上一批还在飞的请求，它们回来后不再写节点。
   */
  const invalidateInFlightGeneration = useCallback(() => {
    generationAttemptRef.current += 1;
  }, []);

  const handleSubmit = useCallback(async (
    options: {
      completionMode?: 'submitted' | 'completed';
      executionSource?: 'manual' | 'workflow';
      attachStoryFrame?: boolean;
    } = {},
  ) => {
    const completionMode = options.completionMode ?? 'completed';
    const executionSource = options.executionSource ?? 'manual';
    if (submittingRef.current) {
      return await new Promise<Record<string, unknown> | undefined>((resolve) => {
        submitWaitersRef.current.push(resolve);
      });
    }
    if (billingRuleMissingSubmitMessage) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: billingRuleMissingSubmitMessage,
        generationErrorDetails: billingRuleMissingSubmitMessage,
        generationErrorRequestId: null,
      });
      return undefined;
    }
    if (submitDisabled) return undefined;
    submittingRef.current = true;
    let actionOutput: Record<string, unknown> | undefined;
    try {
    const projectId = readUrl().project;
    if (!projectId) {
      const message = t('canvas.imageGen.submitMissingProject');
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationTaskKey: null,
        generationTaskType: null,
        generationTaskJobId: null,
        generationError: message,
        generationErrorDetails: message,
        generationErrorRequestId: null,
      });
      throw new Error(message);
    }
    const generationAttempt = generationAttemptRef.current + 1;
    generationAttemptRef.current = generationAttempt;
    const isCurrentGenerationAttempt = () =>
      generationAttemptRef.current === generationAttempt;

    // Recipe 节点在真正提交图片任务前还要先编译提示词。编译可能需要数秒，必须
    // 从点击这一刻就给出反馈；编译失败由下方的窄 catch 恢复按钮并展示错误。
    updateNodeData(id, imageGenerationStartPatch(Date.now()));
    const renderCtx: ImageGenerationRequestContext = {
      nodeId: id,
      nodes: [{ id, type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
        data: { ...data, prompt: promptDraft } }, ...upstreamNodes],
      edges: upstreamNodes.map((node, index) => ({ id: `${id}-upstream-${index}`, source: node.id, target: id })),
      projectId, canvasId: readUrl().canvas ?? 'default', imageModels: availableModels,
      executionSource, productOperation: null, inlineMedia: 'forward',
      promptDraft: { userEdited: hasUserEditedPromptRef.current },
    };
    setReferenceErrors([]);
    setReferenceErrorsOpen(false);
    const canvas = useCanvasStore.getState();
    const referenceSnapshot = [
      ...upstreamNodesInEdgeOrder(canvas.nodes, canvas.edges, id),
      ...canvas.nodes.filter((node) => node.id === id),
    ];
    let effectivePrompt: string;
    try {
      effectivePrompt = await compileWorkflowNodePrompt({
        nodeId: id,
        nodeData: data,
        ...imagePromptCompileInput(renderCtx),
        executionSource,
        onCompileMetadata: (metadata) => updateNodeData(id,
          imagePromptCompileMetadataPatch(metadata, new Date().toISOString())),
      });
    } catch (error) {
      console.error('[image-gen] image Recipe compilation failed', error);
      const rawErrorMessage =
        error instanceof Error && error.message
          ? error.message
          : String(error || t('common.error'));
      const outcome = imageGenerationOutcomePatch({
        nodeId: id, nodeData: data, taskKey: null, firstAcceptedTask: null, runIndex: 0,
        total: imageGenerationCount(data), completedUrls: [], attachStoryFrame: false, translate: t,
        outcome: { kind: 'compile_failed', message: rawErrorMessage,
          error: describeGenerationError(error, t, t('common.error')) },
      });
      if (outcome.action === 'write') updateNodeData(id, outcome.patch);
      throw error;
    }
    const built = buildImageGenerationRequest({ ...renderCtx, prompt: effectivePrompt,
      productOperation: workflowProductOperation(id) ?? null });
    if (!built.ok) throw new Error(built.message);
    const total = typeof built.requests[0]?.body.variant_count === 'number'
      ? built.requests[0].body.variant_count : built.requests.length;
    const batchVariants = typeof built.requests[0]?.body.variant_count === 'number';
    const resolvedCompletionMode = batchVariants ? 'completed'
      : resolveImageGenerationCompletionMode(completionMode, total);
    // Clear any prior failure / album on resubmit — the on-node error banner
    // should only reflect the most recent attempt.
    updateNodeData(id, { generationBatch: null });
    // 先完成的图立即入册展示，未完成的在画册里渲染占位骨架。
    setAlbumPendingTotal(id, total > 1 ? total : 0);

    let completedUrls: string[] = [];
    let submittedRefs: ImageGenerationTaskRef[] = [];
    const deriveOutcome = (runIndex: number, taskKey: string | null, outcome: ImageGenerationOutcome) =>
      imageGenerationOutcomePatch({
        nodeId: id, nodeData: useCanvasStore.getState().nodes.find((node) => node.id === id)?.data ?? {},
        taskKey, firstAcceptedTask: submittedRefs[0] ?? null, runIndex, total, completedUrls,
        attachStoryFrame: options.attachStoryFrame !== false, canAutoCommitOnGenerate,
        outcome, translate: t,
      });
    type GenerationRunOutcome = 'completed' | 'submitted' | 'ignored' | 'handled';
    let panelCollapsedAfterSubmit = false;
    const runOne = async (runIndex: number): Promise<GenerationRunOutcome> => {
      let taskKey: string | null = null;
      try {
        const request = built.requests[runIndex];
        const referenceUrls = await ensureBackendImageUrls(projectId, request.body.reference_urls);
        const ref = await sendGenerationWireRequest<FreezoneJobRef>({ ...request,
          body: { ...request.body, reference_urls: referenceUrls } });
        taskKey = ref.task_key;
        const accepted = imageGenerationRunAccepted({ runIndex, acceptedRefs: submittedRefs, task: ref });
        if (accepted.action === 'handled') return 'handled';
        if (!panelCollapsedAfterSubmit && isCurrentGenerationAttempt()) {
          panelCollapsedAfterSubmit = true;
          optionsRef.current?.onTaskAccepted?.();
        }
        if (accepted.applyPatch) updateNodeData(id, imageGenerationAcceptedPatch(ref));
        submittedRefs = accepted.acceptedRefs;
        const completeTask = async (): Promise<'completed' | 'ignored'> => {
          const completed = await awaitTaskCompletion(ref.task_key, projectId, {
            taskType: ref.task_type,
          });
          let urls = imageGenerationResultUrls(completed.result as Record<string, unknown> | null);
          if (urls.length === 0) {
            try {
              const fallback = await fetchFreezoneJobResult(projectId, ref.task_type, ref.job_id);
              if (fallback.url) urls = [fallback.url];
            } catch (error) {
              console.warn('[image-gen] fallback fetch failed', error);
            }
          }
          if (urls.length > 0) {
            if (!isCurrentGenerationAttempt()) return 'ignored';
            const outcome = deriveOutcome(runIndex, taskKey, { kind: 'completed', result: { output_urls: urls } });
            if (outcome.action === 'write') {
              completedUrls = outcome.completedUrls;
              updateNodeData(id, outcome.patch);
              for (const effect of outcome.effects) {
                if (effect.kind === 'commit_node') {
                  canvasEventBus.publish('freezone/commit-node', { nodeId: effect.nodeId, auto: effect.auto });
                } else {
                  const error = effect.kind === 'attach_story_frame'
                    ? attachCompletedStoryFrame(effect.nodeId) : attachCompletedStoryAsset(effect.nodeId);
                  if (error) toast.warning(error);
                }
              }
            }
            return 'completed';
          } else {
            if (!isCurrentGenerationAttempt()) return 'ignored';
            console.warn('[image-gen] generation completed without output url', completed);
            const missing = imageGenerationMissingUrlOutcome(runIndex, completedUrls);
            if (missing.patch) updateNodeData(id, missing.patch);
            throw new Error(missing.message);
          }
        };
        // 'submitted'：提交即返回任务句柄，产物回填在后台继续（配方运行时按
        // 单节点执行时用这个模式，不阻塞整条链路）。
        if (resolvedCompletionMode === 'submitted') {
          void completeTask().catch((error) => {
            console.error('[image-gen] background generation failed', error);
            const rawErrorMessage =
              error instanceof Error && error.message
                ? error.message
                : String(error || t('common.error'));
            updateNodeData(id, imageGenerationBackgroundFailurePatch({ runIndex,
              message: rawErrorMessage, error: describeGenerationError(error, t, t('common.error')), translate: t }));
          });
          return 'submitted';
        }
        return await completeTask();
      } catch (error) {
        if (!isCurrentGenerationAttempt()) return 'ignored';
        console.error('[image-gen] generation failed', error);
        // 已有同批其它图完成（主图已落）时不覆盖成功态为错误——部分失败只
        // 影响画册张数。
        if (completedUrls.length > 0) return 'handled';
        const info = describeGenerationError(error, t, t('common.error'));
        const issues = info.referenceIssues;
        if (issues.length > 0 && runIndex === 0) {
          setReferenceErrors(issues.map((issue) => {
            const matching = referenceSnapshot.filter((node) => {
              const content = extractUpstreamContent(node);
              const values = [
                content.imageUrl,
                'referenceImageUrl' in node.data ? node.data.referenceImageUrl : null,
              ];
              return values.some((url) =>
                typeof url === 'string' && matchesReference(url, issue.reference_key));
            });
            const source = matching.length === 1 ? matching[0] : undefined;
            return {
              ...issue,
              nodeId: source?.id,
              label: referenceIssueName(issue, source?.data.sourceFileName),
            };
          }));
          setReferenceErrorsOpen(true);
          const outcome = deriveOutcome(runIndex, taskKey, { kind: 'reference_invalid', message: info.message });
          if (outcome.action === 'write') updateNodeData(id, outcome.patch);
          throw error;
        }
        const rawErrorMessage = error instanceof Error && error.message
          ? error.message : String(error || t('common.error'));
        const outcome = deriveOutcome(runIndex, taskKey, {
          kind: isTaskCancelledError(error) ? 'cancelled' : 'failed',
          message: rawErrorMessage, error: info,
        });
        if (outcome.action === 'ignore') return 'ignored';
        updateNodeData(id, outcome.patch);
        if (!outcome.error) return 'ignored';
        throw error;
      }
    };

    const settledRuns = await Promise.allSettled(
      built.requests.map((_, runIndex) => runOne(runIndex)),
    );
    // 全部尘埃落定后撤掉占位（失败的任务不留空槽，画册按实际完成数收口）。
    setAlbumPendingTotal(id, 0);
    // Backend records each attempt (success or failure); pull the new entries.
    // Failures are surfaced directly on the failing node (request-id banner),
    // set per-target inside runOne's catch — no global modal.
    optionsRef.current?.onGenerationSettled?.();
    const settlement = imageGenerationSettleOutcome({
      settled: settledRuns.map((run) => run.status === 'fulfilled' ? run
        : { status: 'rejected', message: run.reason instanceof Error ? run.reason.message : String(run.reason) }),
      completedUrls, acceptedRefs: submittedRefs, completionMode: resolvedCompletionMode, translate: t,
    });
    switch (settlement.kind) {
      case 'output': actionOutput = settlement.output; return actionOutput;
      case 'undefined': return undefined;
      case 'rethrow': {
        const failure = settledRuns[settlement.runIndex];
        if (failure.status === 'rejected') throw failure.reason;
        throw new Error('Expected rejected image run');
      }
      case 'no_result':
        updateNodeData(id, settlement.patch);
        throw new Error(settlement.error.message);
    }
    } finally {
      submittingRef.current = false;
      const waiters = submitWaitersRef.current;
      submitWaitersRef.current = [];
      for (const resolve of waiters) {
        resolve(actionOutput);
      }
    }
  }, [
    availableModels, canAutoCommitOnGenerate, data, id, promptDraft, upstreamNodes,
    billingRuleMissingSubmitMessage, submitDisabled, updateNodeData, t,
  ]);

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

  return {
    formProps: {
      nodeId: id,
      styleTemplateId,
      selectedStyleLabel: selectedStyle?.label ?? null,
      upstreamTextContents,
      upstreamImageContents,
      onDetachUpstream: handleDetachUpstream,
      prompt,
      onPromptChange: (next: string) => {
        hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
        setPromptDraft(next);
        if (!isComposingRef.current) {
          updateNodeData(id, { prompt: next });
        }
      },
      onCompositionStart: () => {
        isComposingRef.current = true;
      },
      onCompositionEnd: (next: string) => {
        isComposingRef.current = false;
        hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
        setPromptDraft(next);
        updateNodeData(id, { prompt: next });
      },
      mentionCandidates,
      upstreamTextJoined,
      modelId,
      aspectRatio,
      size: effectiveImageSize,
      sizeOptions: modelSizeOptions,
      aspectOptions: modelAspectOptions,
      quality: effectiveQuality,
      qualityOptions,
      showQuality: supportsImageQuality,
      modelParameters: selectedModel?.request?.parameters,
      modelParams: data.modelParams,
      modelParamsMode: generationMode,
      selectedModelReferenceError:
        selectedModelReferenceError ?? billingRuleMissingSubmitMessage,
      getModelOptionDisabledReason,
      cameraSelection,
      cameraSummary,
      showCountSelect: !canAutoCommitOnGenerate,
      count,
      isTranslatingPrompt,
      isGenerating,
      onTranslate: () => void handleTranslatePrompt(),
      totalCreditCostDisplay,
      creditPromotion,
      submitDisabled,
      // 手动点击的错误已经写回节点；这里吞掉 rejected Promise，避免浏览器只留下
      // 一条 unhandled rejection。工作流调用的是上面的 submit，仍能收到 reject。
      onSubmit: () => void handleSubmit().catch(() => undefined),
    },
    isGenerating,
    submitDisabled,
    submit: handleSubmit,
    canAutoCommitOnGenerate,
    referenceImageUrl,
    referenceErrors,
    referenceErrorsOpen,
    closeReferenceErrors: () => setReferenceErrorsOpen(false),
    openReferenceErrors: () => setReferenceErrorsOpen(true),
    invalidateInFlightGeneration,
  };
}
