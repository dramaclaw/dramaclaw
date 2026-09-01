// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ImageGenCameraSelection,
  ImageGenCount,
  ImageGenNodeData,
  ImageQuality,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from '@/features/canvas/application/imageData';
import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import {
  IMAGE_ASPECT_OPTIONS,
  IMAGE_SIZE_OPTIONS,
} from '@/features/canvas/nodes/shared/imageGenerationOptions';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { setAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { resolveImageGenerationCompletionMode } from '@/features/canvas/nodes/imageGenCompletionMode';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  submitFreezoneGen,
  type FreezoneProvider,
} from '@/api/ops';
import { translateNodeText } from '@/features/canvas/application/translateText';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { SHARED_MODELS } from '@/features/canvas/ui/ProviderModelPicker';
import { extractRequestId } from '@/features/canvas/application/generationErrorReport';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { describeCameraSelection } from '@/features/canvas/nodes/CameraPickerPopover';
import {
  buildImageGenerationSuccessPatch,
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';
import { useFreezoneCameraOptions } from '@/features/canvas/hooks/useFreezoneCameraOptions';
import { describeStyleSelection } from '@/features/canvas/nodes/StylePickerPopover';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { type MentionCandidate } from '@/features/canvas/nodes/PromptMentionEditor';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { hasImageGenPromptOverride } from '@/features/canvas/nodes/imageGenPrompt';
import { orderedReferenceUrlsWithOwnFirst } from '@/features/canvas/nodes/referenceOrdering';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';
import type { ImageGenerationFormProps } from '@/features/canvas/nodes/shared/ImageGenerationForm';

const DEFAULT_IMAGE_QUALITY: ImageQuality = 'medium';

// 统一计费（#210）：图片生成走 feature 键询价，模型身份塞进 params。
const IMAGE_GENERATE_FEATURE_KEY = 'freezone.image_generate';

// 节点被删除 / 尚未出现在 store 里时的空数据兜底，保持 hook 的 early-return-free
// 结构（hooks 数量必须每帧一致）。
const EMPTY_NODE_DATA = {} as ImageGenNodeData;

function resolveOutputUrl(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  for (const key of ['output_url', 'image_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

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
    options?: { completionMode?: 'submitted' | 'completed' },
  ) => Promise<Record<string, unknown> | undefined>;
  canAutoCommitOnGenerate: boolean;
  referenceImageUrl: string | null;
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
  const onGenerationSettled = options?.onGenerationSettled;
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
  const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio
    ? data.aspectRatio
    : '16:9';
  // 目录可以给模型声明任意分辨率档位（不限于 1K/2K/4K），所以这里按裸字符串读。
  const size = typeof data.size === 'string' && data.size.trim() ? data.size : '2K';
  const quality = (data.quality ?? DEFAULT_IMAGE_QUALITY) as ImageQuality;
  const count = (data.count ?? 1) as ImageGenCount;
  const autoCommitOnGenerate = data.autoCommitOnGenerate === true;
  const canAutoCommitOnGenerate =
    autoCommitOnGenerate &&
    isSystemManagedNodeData(data);
  const effectiveCount = canAutoCommitOnGenerate ? 1 : count;
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

  const {
    models: availableModels,
    isLoading: imageModelsLoading,
    isFallback: imageModelsFallback,
  } = useFreezoneImageModels();

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
  const modelId = selectedModel?.id ?? '';
  // 分辨率/比例/画质三档一律由媒体目录（admin 后台可配）驱动，不再靠模型名正则猜。
  // 目录没声明时退回内置常量，保证老模型与离线兜底列表照常可用。
  const modelSizeOptions = useMemo(() => {
    const configured = selectedModel?.resolutionOptions
      ?.map((item) => item.trim())
      .filter(Boolean);
    return configured?.length ? configured : IMAGE_SIZE_OPTIONS;
  }, [selectedModel]);
  const modelAspectOptions = useMemo(() => {
    const configured = (selectedModel?.ratioOptions ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .map((value) => ({
        value,
        label: IMAGE_ASPECT_OPTIONS.find((item) => item.value === value)?.label ?? value,
      }));
    return configured.length ? configured : IMAGE_ASPECT_OPTIONS;
  }, [selectedModel]);
  const effectiveImageSize = modelSizeOptions.includes(size) ? size : modelSizeOptions[0];
  const effectiveAspectRatio = snapToAllowedAspectRatio(
    aspectRatio,
    modelAspectOptions.map((item) => item.value),
    modelAspectOptions[0]?.value ?? '1:1',
  );
  const qualityOptions = useMemo(
    () => (selectedModel?.qualityOptions ?? []).map((item) => item.trim()).filter(Boolean),
    [selectedModel],
  );
  const supportsImageQuality = qualityOptions.length > 0;
  const effectiveQuality =
    qualityOptions.find((option) => option.toLowerCase() === quality.toLowerCase())
    ?? qualityOptions.find((option) => option.toLowerCase() === DEFAULT_IMAGE_QUALITY)
    ?? qualityOptions[0]
    ?? DEFAULT_IMAGE_QUALITY;
  const imageSelectionForCost =
    imageModelsLoading || imageModelsFallback ? null : selectedModel?.apiModel ?? null;
  const imageQuantity = Math.min(Math.max(effectiveCount, 1), 4);
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
    ? t('node.imageGenNode.billingRuleMissingSubmit', {
        defaultValue:
          '图片生成未启动：计费规则未配置，请联系管理员设置积分规则后重试。',
      })
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
  const generationMode =
    orderedReferenceUrls.length > 0 ? 'image_to_image' : 'text_to_image';

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
    options: { completionMode?: 'submitted' | 'completed' } = {},
  ) => {
    const completionMode = options.completionMode ?? 'completed';
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
      console.error('[image-gen] no project in URL');
      return;
    }
    const generationAttempt = generationAttemptRef.current + 1;
    generationAttemptRef.current = generationAttempt;
    const isCurrentGenerationAttempt = () =>
      generationAttemptRef.current === generationAttempt;

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
    const fallbackPrompt = shouldInlineUpstreamTextAsPrompt
      ? (ownPrompt || (hasUserEditedPromptRef.current ? "" : upstreamTextJoined.trim()))
      : [upstreamTextJoined, ownPrompt]
        .filter((s) => s.length > 0)
        .join('\n\n');
    // 工作流配方节点用配方编译出的最终 prompt；非配方节点回落上面这段拼接。
    const effectivePrompt = await compileWorkflowNodePrompt({
      nodeId: id,
      nodeData: data,
      nodeKind: 'image',
      nodePrompt: ownPrompt,
      upstreamText: upstreamTextJoined,
      upstreamContents,
      fallbackPrompt,
      referenceMedia: referenceUrls.map((_, index) => ({
        kind: 'image',
        label: `reference-${index + 1}`,
      })),
      onCompileMetadata: ({ mode, prompt: compiledPrompt, recipeIds }) => updateNodeData(id, {
        workflowRecipeCompileMode: mode,
        workflowRecipeCompiledAt: new Date().toISOString(),
        workflowRecipeCompiledPrompt: compiledPrompt,
        prompt: compiledPrompt,
        workflowRecipeIds: recipeIds,
      }),
    });
    const genPayload = {
      prompt: effectivePrompt,
      // 后端只接受固定的几个比例；节点上的 aspectRatio 可能是图片自然尺寸约分出的
      // 非标准值（如 "43:24"）或 "auto"，提交前吸附到最接近的合法比例（auto→1:1）。
      aspectRatio: effectiveAspectRatio as typeof aspectRatio,
      imageSize: effectiveImageSize,
      // 画质仅在媒体目录声明 qualityOptions 时下发。
      quality: supportsImageQuality ? effectiveQuality : null,
      referenceUrls,
      provider: selectedModel?.providerId as FreezoneProvider | undefined,
      model: apiModel,
      modelId: selectedModel?.catalogId ?? modelId,
      genMode: generationMode,
      modelParams: data.modelParams,
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
    const resolvedCompletionMode = resolveImageGenerationCompletionMode(completionMode, total);
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
    const submittedRefs: Array<{
      task_key: string;
      task_type: string;
      job_id: string;
    }> = [];
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
        submittedRefs.push({
          task_key: ref.task_key,
          task_type: ref.task_type,
          job_id: ref.job_id,
        });
        const completeTask = async () => {
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
            if (!isCurrentGenerationAttempt()) return;
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
            if (!isCurrentGenerationAttempt()) return;
            console.warn('[image-gen] generation completed without output url', completed);
            // 只有 run 0（任务句柄的归属者）且尚无任何成功时才终结 loading——
            // 非首个任务先「无 URL 完成」不能把还在跑的整体 loading 提前掐掉。
            if (runIndex === 0 && completedUrls.length === 0) {
              updateNodeData(id, { isGenerating: false, generationStartedAt: null });
            }
            throw new Error('图片生成完成但未返回图片地址');
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
            const displayErrorMessage = backendErrorToastMessage(error, t);
            updateNodeData(id, {
              ...(runIndex === 0
                ? { isGenerating: false, generationStartedAt: null }
                : {}),
              generationError: displayErrorMessage,
              generationErrorDetails: rawErrorMessage,
              generationErrorRequestId: extractRequestId(rawErrorMessage),
            });
          });
          return;
        }
        await completeTask();
      } catch (error) {
        if (!isCurrentGenerationAttempt()) return;
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
          generationErrorDetails: rawErrorMessage,
          generationErrorRequestId: extractRequestId(rawErrorMessage),
        });
        // Re-throw so the caller can surface a single error dialog after all
        // concurrent attempts settle (rather than one dialog per failed image).
        throw error;
      }
    };

    const settledRuns = await Promise.allSettled(
      Array.from({ length: total }, (_, runIndex) => runOne(runIndex)),
    );
    // 全部尘埃落定后撤掉占位（失败的任务不留空槽，画册按实际完成数收口）。
    setAlbumPendingTotal(id, 0);
    // Backend records each attempt (success or failure); pull the new entries.
    // Failures are surfaced directly on the failing node (request-id banner),
    // set per-target inside runOne's catch — no global modal.
    onGenerationSettled?.();
    if (completedUrls.length > 0) {
      actionOutput = {
        imageUrl: completedUrls[0],
        imageUrls: completedUrls,
      };
      return actionOutput;
    }
    const firstFailure = settledRuns.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure) throw firstFailure.reason;
    if (resolvedCompletionMode === 'submitted' && submittedRefs.length > 0) {
      const firstRef = submittedRefs[0]!;
      actionOutput = {
        submitted: true,
        task_key: firstRef.task_key,
        taskKey: firstRef.task_key,
        task_type: firstRef.task_type,
        taskType: firstRef.task_type,
        job_id: firstRef.job_id,
        jobId: firstRef.job_id,
      };
      return actionOutput;
    }
    throw new Error('图片生成未提交任务，也没有返回图片地址');
    } finally {
      submittingRef.current = false;
      const waiters = submitWaitersRef.current;
      submitWaitersRef.current = [];
      for (const resolve of waiters) {
        resolve(actionOutput);
      }
    }
  }, [
    aspectRatio,
    canAutoCommitOnGenerate,
    selectedModel,
    cameraSelection,
    count,
    data,
    effectiveCount,
    id,
    modelId,
    orderedReferenceUrls,
    prompt,
    effectiveAspectRatio,
    effectiveImageSize,
    effectiveQuality,
    generationMode,
    supportsImageQuality,
    styleTemplateId,
    billingRuleMissingSubmitMessage,
    submitDisabled,
    shouldInlineUpstreamTextAsPrompt,
    updateNodeData,
    upstreamContents,
    upstreamTextJoined,
    onGenerationSettled,
    t,
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
      onSubmit: () => void handleSubmit(),
    },
    isGenerating,
    submitDisabled,
    submit: handleSubmit,
    canAutoCommitOnGenerate,
    referenceImageUrl,
    invalidateInFlightGeneration,
  };
}
