// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  AlignJustify,
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Languages,
  Loader2,
  Music,
  Music2,
  PlaySquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  CANVAS_NODE_TYPES,
  type TextAnnotationNodeData,
  type TextNodeMode,
  type UploadImageNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
  CANVAS_NODE_INPUT_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import {
  ensureBackendImageUrl,
  fetchFreezoneReversePromptResult,
  fetchFreezoneTextGenerateResult,
  fetchFreezoneTextTranslateResult,
  submitFreezoneReversePrompt,
  submitFreezoneTextGenerate,
  submitFreezoneTextTranslate,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { readUrl } from '@/lib/url-params';
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
} from '@/features/canvas/ui/ProviderModelPicker';
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CreditCostInline } from '@/components/credit-cost-inline';
import type { CreditPromotionDisplay } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from '@/lib/api-errors';

type TextAnnotationNodeProps = NodeProps & {
  id: string;
  data: TextAnnotationNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 220;
const COMPACT_DEFAULT_HEIGHT = 320;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 240;
const COMPACT_MIN_HEIGHT = 240;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 1200;
const IMAGE_REVERSE_PROMPT_FEATURE_KEY = 'freezone.image_reverse_prompt';
const TEXT_GENERATE_FEATURE_KEY = 'freezone.text_generate';
const TEXT_WRITER_MODEL_ID = 'DC-freezone-text-writer-LLM';

const PICKER_INSET = 32;
const COMPACT_OPS_PANEL_HEIGHT = 140;
const COMPACT_OPS_PANEL_GAP = 12;
const COMPACT_OPS_PANEL_MIN_WIDTH = 480;

const COMPACT_MODES = new Set<TextNodeMode>(['textToVideo', 'imageToPrompt']);

const IMAGE_TO_PROMPT_DEFAULT_CONTENT =
  '根据图片生成结构化中文提示词，包括主体描述、环境、光影、镜头语言、风格关键词。';

function countBillableTextChars(text: string): number {
  return text.replace(/[\s\u3000]+/gu, '').length;
}

// 「文字生成音乐」的默认音乐描述——点击后预填进文本节点，用户可在此基础上改。
const TEXT_TO_MUSIC_DEFAULT_CONTENT =
  '生成一首现代品牌电子音乐（约 110 BPM），干净有力的低频贝斯，清晰电子鼓点，整体风格高级、未来感强。开场节奏型贝斯与简洁合成器音色建立律动。主段加入稳定鼓点，节奏清晰，保持克制的张力。强化段加入更丰富的音层，合成器音色提升，律动增强但不过度拥挤。结尾鼓点减弱，仅保留低频与氛围音渐出，干净利落收尾。';

const SPAWN_UPLOAD_WIDTH = 320;

/** 反推提示词通常十几秒返回，用它给 loading 覆盖层估算进度推进。 */
const REVERSE_PROMPT_DURATION_MS = 15000;

/**
 * 解析上游图片节点「眼下展示的那张图」的 URL。和 graphContentResolver 的图片分支
 * 保持同一套回退顺序：生成结果 imageUrl → previewImageUrl → referenceImageUrl，
 * 这样图生节点只挂了参考图（还没生成）时也能被识别为可引用素材。
 */
function resolveUpstreamImageUrl(data: unknown): string | null {
  const d = data as
    | { imageUrl?: unknown; previewImageUrl?: unknown; referenceImageUrl?: unknown }
    | undefined;
  for (const candidate of [d?.imageUrl, d?.previewImageUrl, d?.referenceImageUrl]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

const REAL_MODES = new Set<TextNodeMode>([
  'writing',
  'textToVideo',
  'imageToPrompt',
  'textToMusic',
  'textToMusicGen',
]);

const MODES: ReadonlyArray<{
  key: TextNodeMode;
  icon: typeof FileText;
  labelKey: string;
}> = [
  { key: 'writing', icon: FileText, labelKey: 'node.textNode.modes.writing' },
  { key: 'textToVideo', icon: PlaySquare, labelKey: 'node.textNode.modes.textToVideo' },
  { key: 'imageToPrompt', icon: ImageIcon, labelKey: 'node.textNode.modes.imageToPrompt' },
  { key: 'textToMusic', icon: Music, labelKey: 'node.textNode.modes.textToMusic' },
  { key: 'textToMusicGen', icon: Music2, labelKey: 'node.textNode.modes.textToMusicGen' },
];

const EDIT_VIEW_ZOOM = 1.4;

export const TextAnnotationNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: TextAnnotationNodeProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const content = typeof data.content === 'string' ? data.content : '';
  const instruction = typeof data.instruction === 'string' ? data.instruction : '';
  const mode: TextNodeMode = data.mode && REAL_MODES.has(data.mode) ? data.mode : 'writing';
  // 已从能力 picker 选过一次(如「文字生成音乐」)：恒为纯文本编辑区,空内容也不再弹「试试」。
  const pickerDismissed = Boolean(data.pickerDismissed);
  const modelId = typeof data.model === 'string' && data.model.length > 0
    ? data.model
    : DEFAULT_SHARED_MODEL_ID;
  const reversePromptInstruction =
    instruction.trim() || IMAGE_TO_PROMPT_DEFAULT_CONTENT;
  const reversePromptBillableChars = countBillableTextChars(
    reversePromptInstruction,
  );
  const reversePromptCost = useGenerationCreditCost(
    'feature',
    mode === 'imageToPrompt' ? IMAGE_REVERSE_PROMPT_FEATURE_KEY : null,
    {
      surface: 'canvas',
      quantity: reversePromptBillableChars,
      params: {
        operation: 'image_reverse_prompt',
        billable_chars: reversePromptBillableChars,
        pricing_quantity: reversePromptBillableChars,
      },
    },
  );
  const reversePromptBillingRuleMissing =
    reversePromptCost.error instanceof BillingRuleNotConfiguredError;
  const reversePromptCostDisplay =
    reversePromptCost.data?.data.display ??
    (reversePromptBillingRuleMissing
      ? t('common.billingRuleNotConfiguredShort')
      : null);
  const textGeneratePrompt = instruction;
  const textGenerateBillableChars = countBillableTextChars(textGeneratePrompt);
  const textGenerateCost = useGenerationCreditCost(
    'feature',
    (mode === 'writing' || mode === 'textToVideo') && selected
      ? TEXT_GENERATE_FEATURE_KEY
      : null,
    {
      surface: 'canvas',
      quantity: textGenerateBillableChars,
      params: {
        operation: 'text_generate',
        billable_chars: textGenerateBillableChars,
        pricing_quantity: textGenerateBillableChars,
      },
    },
  );
  const textGenerateBillingRuleMissing =
    textGenerateCost.error instanceof BillingRuleNotConfiguredError;
  const textGenerateCostDisplay =
    textGenerateCost.data?.data.display ??
    (textGenerateBillingRuleMissing
      ? t('common.billingRuleNotConfiguredShort')
      : null);
  const { isGenerating } = useNodeGenerationTaskState(data);
  const [isTranslating, setIsTranslating] = useState(false);
  // referenceOnly: 节点被作为上游引用素材使用（脚本节点 spawn 出来的）。
  // 复用 compact 视图（只渲染编辑卡片），同时 selected ops panel 也不显示。
  const isReferenceOnly = Boolean(data.referenceOnly);
  const isSystemManaged = isSystemManagedNodeData(data);
  const isCompactView = isReferenceOnly || COMPACT_MODES.has(mode);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedTitle = resolveNodeDisplayName(CANVAS_NODE_TYPES.textAnnotation, data);
  const minHeightForView = isCompactView ? COMPACT_MIN_HEIGHT : MIN_HEIGHT;
  const defaultHeightForView = isCompactView ? COMPACT_DEFAULT_HEIGHT : DEFAULT_HEIGHT;
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(minHeightForView, Math.round(height ?? defaultHeightForView));

  // Reactive lookup of the upstream image URL (e.g. uploaded reference image
  // for `imageToPrompt` mode). Re-evaluates whenever edges/nodes change.
  const upstreamImageUrl = useCanvasStore((state) => {
    const edge = state.edges.find((e) => e.target === id);
    if (!edge) return null;
    const node = state.nodes.find((n) => n.id === edge.source);
    return resolveUpstreamImageUrl(node?.data);
  });

  // 取消关联上游参考图：删掉指向本节点的那根连线（缩略图只在该边的源带图时
  // 才显示，所以这里删第一条 target===id 的边即对应当前展示的素材）。
  const handleDetachUpstreamImage = useCallback(() => {
    const state = useCanvasStore.getState();
    const edge = state.edges.find((e) => e.target === id);
    if (edge) {
      deleteEdge(edge.id);
    }
  }, [id, deleteEdge]);

  // libtv-style edit mode: dbl-click the preview card → zoom canvas to 200%
  // centered on this node and focus a fullsize textarea. Escape / blur exits.
  const enterEditMode = useCallback(() => {
    if (isSystemManaged) return;
    const node = reactFlow.getNode(id);
    if (node) {
      const w = (node.measured?.width ?? width ?? DEFAULT_WIDTH);
      const h = (node.measured?.height ?? height ?? DEFAULT_HEIGHT);
      // 组内成员的 node.position 是「相对父组」的坐标，而 setCenter 需要绝对画布坐标。
      // 用 internalNode 的 positionAbsolute（无父组时等于 position），否则双击组里的
      // 节点会把视野按组原点的偏移量平移到别处。
      const absolute =
        reactFlow.getInternalNode(id)?.internals.positionAbsolute ?? node.position;
      const cx = absolute.x + w / 2;
      const cy = absolute.y + h / 2;
      void reactFlow.setCenter(cx, cy, { zoom: EDIT_VIEW_ZOOM, duration: 280 });
    }
    setIsEditingContent(true);
  }, [height, id, isSystemManaged, reactFlow, width]);

  useEffect(() => {
    if (isSystemManaged && isEditingContent) {
      setIsEditingContent(false);
    }
  }, [isEditingContent, isSystemManaged]);

  useEffect(() => {
    if (!isEditingContent) return;
    // Focus on next tick so the textarea exists after the swap.
    const timer = window.setTimeout(() => {
      editTextareaRef.current?.focus();
      const len = editTextareaRef.current?.value.length ?? 0;
      editTextareaRef.current?.setSelectionRange(len, len);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isEditingContent]);

  const spawnVideoNode = useCallback(() => {
    const position = findNodePosition(id, 580, 680);
    const seedData: Partial<VideoNodeData> = {
      genMode: 'textToVideo',
      prompt: typeof data.content === 'string' ? data.content : '',
    };
    const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, seedData);
    addEdge(id, newNodeId);
    useCanvasStore.getState().autoGroupSpawn(id, [newNodeId], { label: '文生视频组' });
  }, [addEdge, addNode, data.content, findNodePosition, id]);

  const spawnUploadNode = useCallback(() => {
    const sourceNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === id);
    const sourceX = sourceNode?.position.x ?? 0;
    const sourceY = sourceNode?.position.y ?? 0;
    const position = {
      x: sourceX - SPAWN_UPLOAD_WIDTH - 60,
      y: sourceY,
    };
    // 反推提示词只能吃图片，限制上传节点仅接受图片类型（标题变「上传图片」、
    // 文件选择器 accept=image/*、拖入视频/音频会被拒）。
    const seedData: Partial<UploadImageNodeData> = { imageOnly: true };
    const newNodeId = addNode(CANVAS_NODE_TYPES.upload, position, seedData);
    addEdge(newNodeId, id);
    useCanvasStore.getState().autoGroupSpawn(id, [newNodeId], { label: '图片反推提示词组' });
  }, [addEdge, addNode, id]);

  // 克隆音频 / 文字生成音乐：在文本节点下游派生一个音频节点并连边（文本 → 音频），
  // 与「文生视频」派生视频节点同构。音频节点默认尺寸 480×180。
  // audioKind 决定下游音频节点走语音克隆(speech) 还是文本生成音乐(music)。
  const spawnAudioNode = useCallback((audioKind: 'speech' | 'music') => {
    const position = findNodePosition(id, 480, 180);
    const newNodeId = addNode(CANVAS_NODE_TYPES.audio, position, { audioKind });
    addEdge(id, newNodeId);
    const label = audioKind === 'music' ? '文字生成音乐组' : '克隆音频组';
    useCanvasStore.getState().autoGroupSpawn(id, [newNodeId], { label });
  }, [addEdge, addNode, findNodePosition, id]);

  const handlePickMode = useCallback((nextMode: TextNodeMode) => {
    if (nextMode === 'writing') {
      // 先打开 AI 创作面板；节点正文仍可通过单击占位区 / 双击已有内容手工编辑。
      updateNodeData(id, { mode: nextMode, pickerDismissed: true });
      return;
    }
    // 文字生成音乐：派生下游音乐音频节点后，左侧文本节点回到纯文本编辑态
    // (writing)——音乐描述在这里输入并同步给下游音频节点，不再显示能力 picker。
    if (nextMode === 'textToMusicGen') {
      spawnAudioNode('music');
      // 文本节点回到纯文本编辑态、关闭能力 picker,并预填默认音乐描述(同步给下游音频节点)。
      updateNodeData(id, {
        mode: 'writing',
        pickerDismissed: true,
        content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
      });
      enterEditMode();
      return;
    }
    updateNodeData(id, { mode: nextMode });
    if (nextMode === 'textToVideo') {
      spawnVideoNode();
    } else if (nextMode === 'imageToPrompt') {
      spawnUploadNode();
    } else if (nextMode === 'textToMusic') {
      spawnAudioNode('speech');
    }
  }, [enterEditMode, id, spawnAudioNode, spawnUploadNode, spawnVideoNode, updateNodeData]);

  const runImageToPrompt = useCallback(async () => {
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] no project in URL');
      return;
    }
    const state = useCanvasStore.getState();
    const upstreamEdge = state.edges.find((edge) => edge.target === id);
    const sourceNode = upstreamEdge
      ? state.nodes.find((node) => node.id === upstreamEdge.source)
      : null;
    const rawUrl = resolveUpstreamImageUrl(sourceNode?.data);
    if (!rawUrl) {
      console.warn('[text-node] imageToPrompt: no upstream image url');
      return;
    }
    updateNodeData(id, { isGenerating: true, generationStartedAt: Date.now() });
    try {
      // Backend looks up the file by static path — `data:` URLs get uploaded
      // first via /freezone/upload to obtain a real path; `?v=<ts>` cache
      // busters are stripped either way.
      const sourceUrl = await ensureBackendImageUrl(projectId, rawUrl);
      const ref = await submitFreezoneReversePrompt(projectId, {
        sourceUrl,
        instruction: reversePromptInstruction,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(id, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      // SSE task.result only carries `{ output_format: "json" }`; the prompt
      // text comes from the dedicated job-result endpoint.
      const { prompt } = await fetchFreezoneReversePromptResult(projectId, ref.job_id);
      if (prompt && prompt.trim().length > 0) {
        updateNodeData(id, { content: prompt, isGenerating: false, generationStartedAt: null });
      } else {
        console.warn('[text-node] reverse-prompt returned empty prompt', { jobId: ref.job_id });
        updateNodeData(id, { isGenerating: false, generationStartedAt: null });
      }
    } catch (error) {
      console.error('[text-node] reverse-prompt failed', error);
      updateNodeData(id, { isGenerating: false, generationStartedAt: null });
    }
  }, [id, reversePromptInstruction, updateNodeData]);

  const runTextGenerate = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride ?? instruction).trim();
    if (!prompt || textGenerateBillingRuleMissing) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] text generation: no project in URL');
      return;
    }

    updateNodeData(id, { isGenerating: true, generationStartedAt: Date.now() });
    try {
      const ref = await submitFreezoneTextGenerate(projectId, {
        prompt,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      updateNodeData(id, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneTextGenerateResult(projectId, ref.job_id);
      if (!result.generated_text.trim()) {
        throw new Error('text generation returned empty output');
      }
      updateNodeData(id, {
        content: result.generated_text,
        model: result.model || TEXT_WRITER_MODEL_ID,
        isGenerating: false,
        generationStartedAt: null,
      });
    } catch (error) {
      console.error('[text-node] text generation failed', error);
      toast.error(backendErrorToastMessage(error, t));
      updateNodeData(id, { isGenerating: false, generationStartedAt: null });
    }
  }, [id, instruction, t, textGenerateBillingRuleMissing, updateNodeData]);

  const runTextTranslate = useCallback(async () => {
    if (isGenerating || isTranslating) return;
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] translate: no project in URL');
      return;
    }
    setIsTranslating(true);
    try {
      const ref = await submitFreezoneTextTranslate(projectId, {
        text: content,
        nodeType: 'text',
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneTextTranslateResult(projectId, ref.job_id);
      updateNodeData(id, { content: result.translated_text });
    } catch (error) {
      console.error('[text-node] translate failed', error);
    } finally {
      setIsTranslating(false);
    }
  }, [content, id, isGenerating, isTranslating, updateNodeData]);

  const textPlaceholder = t('node.textNode.placeholder');
  const hasUserContent = content.trim().length > 0 && content.trim() !== textPlaceholder.trim();

  const handleSubmit = useCallback(() => {
    if (isGenerating) return;
    if (mode === 'writing') {
      void runTextGenerate();
      return;
    }
    if (reversePromptBillingRuleMissing) return;
    if (mode === 'imageToPrompt') {
      void runImageToPrompt();
      return;
    }
    if (mode === 'textToVideo') {
      void runTextGenerate();
      return;
    }
    if (!hasUserContent) return;
    console.info('[text-node] submit stub', { id, mode, model: modelId, content });
  }, [
    content,
    hasUserContent,
    id,
    isGenerating,
    mode,
    modelId,
    reversePromptBillingRuleMissing,
    runImageToPrompt,
    runTextGenerate,
  ]);

  const submitDisabled = isGenerating
    || (mode === 'writing' && (textGenerateBillingRuleMissing || instruction.trim().length === 0))
    || (
      mode === 'textToVideo'
      && (textGenerateBillingRuleMissing || instruction.trim().length === 0)
    )
    || (mode === 'imageToPrompt' && reversePromptBillingRuleMissing)
    || (
      mode !== 'writing'
      && mode !== 'textToVideo'
      && mode !== 'imageToPrompt'
      && !hasUserContent
    );
  // Inner panels stay neutral regardless of selection — the React Flow node
  // wrapper already shows the active state as an outer outline. Doubling it
  // up on the inner cards (libtv-style reference shows neutral borders only)
  // looks busy.
  const inputBodyToneClass = `${CANVAS_NODE_INPUT_SURFACE_CLASS} ${
    selected ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS : CANVAS_NODE_INPUT_BODY_FRAME_CLASS
  }`;
  const inputPanelToneClass = `${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`;

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
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

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<FileText className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable={!isSystemManaged}
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={minHeightForView}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      {!isCompactView && selected && !isBoxSelecting && !isReferenceOnly && !isSystemManaged && !isEditingContent && (
        <WritingOpsPanel
          nodeId={id}
          instruction={instruction}
          isGenerating={isGenerating}
          isTranslating={isTranslating}
          width={resolvedWidth}
          costDisplay={textGenerateCostDisplay}
          promotion={textGenerateCost.data?.data.promotion}
          submitDisabled={submitDisabled}
          translateDisabled={isGenerating || isTranslating || !hasUserContent}
          onGenerate={handleSubmit}
          onTranslate={runTextTranslate}
        />
      )}

      {isCompactView ? (
        <>
          <div
            className={`flex h-full w-full flex-col items-center justify-center rounded-[var(--node-radius)] border transition-colors ${inputBodyToneClass}`}
            onDoubleClick={(event) => {
              if (isEditingContent || isSystemManaged) return;
              event.stopPropagation();
              enterEditMode();
            }}
          >
            {isEditingContent ? (
              <textarea
                ref={editTextareaRef}
                value={content}
                onChange={(event) => updateNodeData(id, { content: event.target.value })}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setIsEditingContent(false);
                    editTextareaRef.current?.blur();
                  }
                }}
                onBlur={() => setIsEditingContent(false)}
                placeholder={textPlaceholder}
                className={`ui-scrollbar nodrag nowheel h-full w-full resize-none border-none bg-transparent px-4 py-4 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              />
            ) : hasUserContent ? (
              <div className="ui-scrollbar nowheel max-h-full w-full overflow-y-auto px-4 py-4 text-sm leading-6 text-text-dark">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={{
                    h1: ({ ...props }) => <h1 className="mb-1 mt-2 text-base font-semibold" {...props} />,
                    h2: ({ ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold" {...props} />,
                    h3: ({ ...props }) => <h3 className="mb-1 mt-1 text-sm font-semibold" {...props} />,
                    p: ({ ...props }) => <p className="my-1" {...props} />,
                    strong: ({ ...props }) => <strong className="font-semibold text-text-dark" {...props} />,
                    em: ({ ...props }) => <em className="italic" {...props} />,
                    ul: ({ ...props }) => <ul className="my-1 ml-5 list-disc" {...props} />,
                    ol: ({ ...props }) => <ol className="my-1 ml-5 list-decimal" {...props} />,
                    li: ({ ...props }) => <li className="my-0.5" {...props} />,
                    code: ({ ...props }) => (
                      <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />
                    ),
                    hr: () => <hr className="my-2 border-white/10" />,
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <AlignJustify className="h-12 w-12 stroke-[1.5] text-text-muted/40" />
            )}
            {isGenerating && (
              <NodeGenerationOverlay
                startedAt={data.generationStartedAt}
                durationMs={REVERSE_PROMPT_DURATION_MS}
                hasBackground={hasUserContent}
              />
            )}
          </div>

          {selected && !isBoxSelecting && !isReferenceOnly && !isSystemManaged && !isEditingContent && (
            <div
              className={`nodrag absolute left-1/2 z-[300] flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] border ${inputPanelToneClass}`}
              style={{
                top: `calc(100% + ${COMPACT_OPS_PANEL_GAP}px)`,
                height: COMPACT_OPS_PANEL_HEIGHT,
                width: Math.max(resolvedWidth, COMPACT_OPS_PANEL_MIN_WIDTH),
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {upstreamImageUrl && (
                <div className="flex shrink-0 items-center px-3 pt-3">
                  <div className="group relative h-9 w-9 overflow-hidden rounded-md border border-white/10">
                    <img
                      src={resolveImageDisplayUrl(upstreamImageUrl)}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                    <button
                      type="button"
                      title="取消引用此素材"
                      className="nodrag absolute right-0 top-0 z-10 hidden h-4 w-4 items-center justify-center rounded-bl-md bg-black/75 text-white transition-colors hover:bg-red-500 group-hover:flex"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDetachUpstreamImage();
                      }}
                    >
                      <X className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              )}
              <textarea
                value={
                  mode === 'imageToPrompt' || mode === 'textToVideo'
                    ? instruction === IMAGE_TO_PROMPT_DEFAULT_CONTENT ? '' : instruction
                    : content
                }
                onChange={(event) => {
                  const field = mode === 'imageToPrompt' || mode === 'textToVideo'
                    ? 'instruction'
                    : 'content';
                  updateNodeData(id, { [field]: event.target.value });
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={
                  mode === 'imageToPrompt'
                    ? IMAGE_TO_PROMPT_DEFAULT_CONTENT
                    : mode === 'textToVideo'
                      ? t('node.textNode.generatePlaceholder')
                      : textPlaceholder
                }
                className={`ui-scrollbar nodrag nowheel min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 pt-3 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              />
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                {/* 文生视频的视频模型由下游视频节点管理；反推提示词接口不接收模型。
                    因此这两种模式均不在文本节点显示模型选择器。 */}
                {mode === 'textToVideo' || mode === 'imageToPrompt' ? (
                  <span />
                ) : (
                  <ProviderModelPicker
                    selectedModelId={modelId}
                    onChange={(nextModelId) => updateNodeData(id, { model: nextModelId })}
                    popoverPlacement="top"
                  />
                )}
                <div className="flex items-center gap-1.5">
                  {mode === 'imageToPrompt' && (
                    <CreditCostInline
                      display={reversePromptCostDisplay}
                      promotion={reversePromptCost.data?.data.promotion}
                    />
                  )}
                  {mode === 'textToVideo' && (
                    <>
                      <button
                        type="button"
                        title={t('node.textNode.translate')}
                        onClick={(event) => {
                          event.stopPropagation();
                          void runTextTranslate();
                        }}
                        disabled={isGenerating || isTranslating || !hasUserContent}
                        className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
                          isTranslating ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
                        }`}
                      >
                        {isTranslating ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Languages className="h-4 w-4" />
                        )}
                      </button>
                      <CreditCostInline
                        display={textGenerateCostDisplay}
                        promotion={textGenerateCost.data?.data.promotion}
                      />
                    </>
                  )}
                  <button
                    type="button"
                    disabled={submitDisabled}
                    title={t('node.textNode.submit')}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSubmit();
                    }}
                    className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                      submitDisabled
                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                        : NODE_GENERATE_BUTTON_ENABLED_CLASS
                    }`}
                  >
                    {isGenerating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        // 默认视图（writing / textToMusic）：节点本体即文本编辑区——有内容
        // 时直接渲染 markdown，双击进入编辑；空内容时退回到 capability
        // picker（让用户选下一步要做什么 / 切到其它模式）。底部那条原本
        // 的 prompt + send 面板已移除——writing/textToMusic 的 submit
        // 之前就是 stub，留着只会和正文重复编辑同一个 content 字段。
        <div
          className={`flex h-full w-full flex-col rounded-[var(--node-radius)] border transition-colors ${inputBodyToneClass}`}
          onDoubleClick={(event) => {
            if (isEditingContent || isSystemManaged) return;
            event.stopPropagation();
            enterEditMode();
          }}
        >
          {isEditingContent ? (
            <textarea
              ref={editTextareaRef}
              value={content}
              onChange={(event) => updateNodeData(id, { content: event.target.value })}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  setIsEditingContent(false);
                  editTextareaRef.current?.blur();
                }
              }}
              onBlur={() => setIsEditingContent(false)}
              placeholder={textPlaceholder}
              className={`ui-scrollbar nodrag nowheel h-full w-full resize-none border-none bg-transparent px-4 py-4 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
            />
          ) : hasUserContent ? (
            <div className="ui-scrollbar nowheel max-h-full w-full flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-text-dark">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  h1: ({ ...props }) => <h1 className="mb-1 mt-2 text-base font-semibold" {...props} />,
                  h2: ({ ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold" {...props} />,
                  h3: ({ ...props }) => <h3 className="mb-1 mt-1 text-sm font-semibold" {...props} />,
                  p: ({ ...props }) => <p className="my-1" {...props} />,
                  strong: ({ ...props }) => <strong className="font-semibold text-text-dark" {...props} />,
                  em: ({ ...props }) => <em className="italic" {...props} />,
                  ul: ({ ...props }) => <ul className="my-1 ml-5 list-disc" {...props} />,
                  ol: ({ ...props }) => <ol className="my-1 ml-5 list-decimal" {...props} />,
                  li: ({ ...props }) => <li className="my-0.5" {...props} />,
                  code: ({ ...props }) => (
                    <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />
                  ),
                  hr: () => <hr className="my-2 border-white/10" />,
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : isSystemManaged ? (
            <div className="flex min-h-0 flex-1 items-center justify-center py-4">
              <AlignJustify className="h-12 w-12 stroke-[1.5] text-text-muted/40" />
            </div>
          ) : pickerDismissed ? (
            // 已选过模式的纯文本节点：空内容时显示占位文案、点击进入编辑，不再显示 picker。
            <div
              className={`flex min-h-0 flex-1 cursor-text items-start px-4 py-4 text-sm leading-6 ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              onClick={(event) => {
                event.stopPropagation();
                enterEditMode();
              }}
            >
              {textPlaceholder}
            </div>
          ) : (
            <div
              className="flex min-h-0 flex-1 flex-col justify-center gap-2 py-4"
              style={{ marginInline: PICKER_INSET }}
            >
              <div className="text-xs text-[var(--canvas-node-input-helper)]">{t('node.textNode.tryHint')}</div>
              <div className="flex flex-col gap-0.5">
                {MODES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handlePickMode(item.key);
                      }}
                      className="-mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                    >
                      <Icon className="h-4 w-4 text-text-muted/90" />
                      <span>{t(item.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

TextAnnotationNode.displayName = 'TextAnnotationNode';

interface WritingOpsPanelProps {
  nodeId: string;
  instruction: string;
  isGenerating: boolean;
  isTranslating: boolean;
  width: number;
  costDisplay: string | null;
  promotion?: CreditPromotionDisplay | null;
  submitDisabled: boolean;
  translateDisabled: boolean;
  onGenerate: () => void;
  onTranslate: () => void;
}

function WritingOpsPanel({
  nodeId,
  instruction,
  isGenerating,
  isTranslating,
  width,
  costDisplay,
  promotion,
  submitDisabled,
  translateDisabled,
  onGenerate,
  onTranslate,
}: WritingOpsPanelProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const generatePlaceholder = t('node.textNode.generatePlaceholder');

  return (
    <div
      className={`nodrag absolute left-1/2 z-[300] flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`}
      style={{
        top: `calc(100% + ${COMPACT_OPS_PANEL_GAP}px)`,
        height: COMPACT_OPS_PANEL_HEIGHT,
        width: Math.max(width, COMPACT_OPS_PANEL_MIN_WIDTH),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        value={instruction}
        onChange={(event) => updateNodeData(nodeId, { instruction: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder={generatePlaceholder}
        className={`ui-scrollbar nodrag nowheel min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 pt-3 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
        disabled={isGenerating}
      />
      <div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={t('node.textNode.translate')}
            onClick={(event) => {
              event.stopPropagation();
              onTranslate();
            }}
            disabled={translateDisabled}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              isTranslating ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
            }`}
          >
            {isTranslating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
          </button>
          <CreditCostInline display={costDisplay} promotion={promotion} />
          <button
            type="button"
            disabled={submitDisabled}
            title={t('node.textNode.submit')}
            onClick={(event) => {
              event.stopPropagation();
              onGenerate();
            }}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
