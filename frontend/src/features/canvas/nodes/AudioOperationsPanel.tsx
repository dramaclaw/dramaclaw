// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Check,
  CircleHelp,
  Copy,
  Languages,
  Loader2,
  Repeat,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';

import {
  type AudioNodeData,
  type AudioVoiceRef,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import { useDetachUpstream } from '@/features/canvas/hooks/useDetachUpstream';
import {
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { deriveAudioText, useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { readUrl } from '@/lib/url-params';
import { PanelExpandButton } from '@/features/canvas/ui/PanelExpandButton';
import { OperationPanelShell } from '@/features/canvas/ui/OperationPanelShell';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CreditCostPill } from '@/components/credits/credit-visual';
import { UiSelect } from '@/components/ui';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { VoiceSelectionModal } from './VoiceSelectionModal';

const PANEL_GAP_PX = 12;
const PANEL_OVERHANG_PX = 60;
// 「放大」后用居中弹窗展示，弹窗宽度（高度随内容，文本框更高见下方 textarea）。
const PANEL_EXPANDED_WIDTH_PX = 760;
const AUDIO_INPUT_LABEL_CLASS = 'text-[12px] font-medium text-text-muted/90';
const AUDIO_INPUT_FIELD_CLASS =
  'nodrag nowheel w-full rounded-[10px] border border-white/[0.08] bg-transparent px-3 text-[13px] text-text-dark outline-none transition-colors placeholder:text-text-muted/70 hover:border-white/[0.12] focus:border-white/20';

// music 模式时长默认 30s（对齐后端 music_length_ms 默认 30000）。
export const DEFAULT_MUSIC_LENGTH_MS = 30000;
const AUDIO_SPEECH_FEATURE_KEY = 'freezone.audio_speech';
const AUDIO_MUSIC_FEATURE_KEY = 'freezone.audio_music';
// 音乐时长下拉样式：暗色画布风格 + min-width 兜底,避免画布缩放/窄触发器时
// 菜单按触发器屏幕宽渲染导致选项被 truncate 成「1…」。
const MUSIC_LENGTH_SELECT_CLASS =
  '!h-8 !w-[116px] !rounded-[8px] !border-white/[0.1] !bg-white/[0.04] !px-3 !text-[13px] !text-text-dark hover:!border-white/20';
const MUSIC_LENGTH_SELECT_MENU_CLASS =
  '!z-[260] !min-w-[140px] !border-white/10 !bg-[#202024] !text-text-dark shadow-[0_14px_34px_rgba(0,0,0,0.5)]';
// 音乐时长预设（毫秒）。后端范围 3000–600000，这里给常用档位。
export const MUSIC_LENGTH_PRESETS: ReadonlyArray<{ ms: number; label: string; labelKey: string }> = [
  { ms: 30000, label: '30秒', labelKey: 'node.audioPanel.musicLength.30s' },
  { ms: 60000, label: '1分钟', labelKey: 'node.audioPanel.musicLength.1m' },
  { ms: 120000, label: '2分钟', labelKey: 'node.audioPanel.musicLength.2m' },
  { ms: 180000, label: '3分钟', labelKey: 'node.audioPanel.musicLength.3m' },
  { ms: 240000, label: '4分钟', labelKey: 'node.audioPanel.musicLength.4m' },
  { ms: 300000, label: '5分钟', labelKey: 'node.audioPanel.musicLength.5m' },
  { ms: 600000, label: '10分钟', labelKey: 'node.audioPanel.musicLength.10m' },
];

export function musicBillingSecondsFromMs(ms: number): number {
  return Math.max(Math.ceil(Math.max(ms, 0) / 1000), 1);
}

function countBillableTextChars(text: string): number {
  return text.replace(/[\s\u3000]+/gu, '').length;
}

interface AudioOperationsPanelProps {
  nodeId: string;
  data: AudioNodeData;
}

export function AudioOperationsPanel({ nodeId, data }: AudioOperationsPanelProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [isTranslating, setIsTranslating] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  // 音色设置默认收起，参考 libtv：控制行的设置按钮点开后才展示音色卡。
  const [showVoiceSettings, setShowVoiceSettings] = useState(false);
  // music 模式：高级设置（音乐时长等）默认收起，点底部设置按钮展开。
  const [showMusicSettings, setShowMusicSettings] = useState(false);
  // 'music'：文字生成音乐(走 /freezone/audio/eleven-music)；缺省/'speech'：克隆音频(TTS)。
  const isMusic = data.audioKind === 'music';
  // 生成逻辑(含失败重试)抽到 useAudioGeneration，与节点本体的重试共用同一实现。
  const {
    generate: handleSubmit,
    effectivePrompt,
    isGenerating,
    modelTaskAccess,
  } = useAudioGeneration(nodeId, data);
  const speechBillableChars = countBillableTextChars(effectivePrompt);
  const musicLengthMs =
    typeof data.musicLengthMs === 'number' ? data.musicLengthMs : DEFAULT_MUSIC_LENGTH_MS;
  const musicBillingSeconds = musicBillingSecondsFromMs(musicLengthMs);
  const audioCost = useGenerationCreditCost(
    'feature',
    isMusic ? AUDIO_MUSIC_FEATURE_KEY : AUDIO_SPEECH_FEATURE_KEY,
    {
      surface: 'canvas',
      quantity: isMusic ? undefined : speechBillableChars,
      params: isMusic
        ? {
            operation: 'music',
            music_length_ms: musicLengthMs,
            pricing_quantity: musicBillingSeconds,
          }
        : {
            operation: 'speech',
            billable_chars: speechBillableChars,
            pricing_quantity: speechBillableChars,
          },
    },
  );
  const billingRuleMissing =
    audioCost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay =
    audioCost.data?.data.display ??
    (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);
  const text = useMemo(() => deriveAudioText(data), [data]);
  const emotionPrompt = data.emotionPrompt ?? '';

  // 本地草稿 + composition 守卫——避免 store 直绑导致 IME 候选被打断。
  // 同 docs/changes/2026-05-12-image-gen-ime-fix.md 的修复模式。
  const [textDraft, setTextDraft] = useState(text);
  const isComposingTextRef = useRef(false);
  useEffect(() => {
    if (isComposingTextRef.current) return;
    setTextDraft(text);
  }, [text]);

  const [emotionDraft, setEmotionDraft] = useState(emotionPrompt);
  const isComposingEmotionRef = useRef(false);
  useEffect(() => {
    if (isComposingEmotionRef.current) return;
    setEmotionDraft(emotionPrompt);
  }, [emotionPrompt]);

  // 收集上游 text 内容 —— 音频节点上游只允许文本节点（textAnnotation /
  // script），用 graphContentResolver 统一拿到 `text` 字段后过滤出非空项。
  // 注意：上游文本「不回显」进输入框（textarea 只反映用户本地输入），仅作为引用
  // chip 展示；提交时由 useAudioGeneration.effectivePrompt 拼接进最终 prompt。
  const upstreamContents = useUpstreamContents(nodeId);
  const upstreamTextContents = useMemo(
    () =>
      upstreamContents.filter(
        (c) => typeof c.text === 'string' && c.text.trim().length > 0,
      ),
    [upstreamContents],
  );
  const detachUpstream = useDetachUpstream(nodeId);

  const handleTextChange = useCallback(
    (next: string) => {
      updateNodeData(nodeId, { text: next });
    },
    [nodeId, updateNodeData],
  );

  const handleEmotionChange = useCallback(
    (next: string) => {
      updateNodeData(nodeId, { emotionPrompt: next });
    },
    [nodeId, updateNodeData],
  );

  const handleTranslate = useCallback(async () => {
    if (modelTaskAccess.blocked || isGenerating || isTranslating) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const project = readUrl().project;
    if (!project) {
      console.error('[audio-node] translate: no project in URL');
      return;
    }
    setIsTranslating(true);
    try {
      const ref = await submitFreezoneTextTranslate(project, {
        text: trimmed,
        nodeType: 'audio',
        canvasId: readUrl().canvas ?? 'default',
        nodeId,
      });
      await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const result = await fetchFreezoneTextTranslateResult(project, ref.job_id);
      handleTextChange(result.translated_text);
    } catch (error) {
      // 轮询超时 ≠ 生成失败：后端还在跑，节点上的任务句柄仍可续接。
      // 写错误横幅会把一个还活着的任务标成失败，并清掉句柄。
      if (isTaskPollTimeoutError(error)) {
        notifyTaskStillRunning(t);
        return;
      }
      console.error('[audio-node] translate failed', error);
    } finally {
      setIsTranslating(false);
    }
  }, [handleTextChange, isGenerating, isTranslating, modelTaskAccess.blocked, t, text]);

  // 文本框为空但引用了非空文本时也允许提交（effectivePrompt 会回退到上游引用）。
  const voiceMissing = !isMusic && data.voiceAvailable === false;
  const submitDisabled =
    isGenerating || billingRuleMissing || modelTaskAccess.blocked ||
    effectivePrompt.length === 0 || voiceMissing;

  return (
    <OperationPanelShell
      expanded={panelExpanded}
      onCollapse={() => setPanelExpanded(false)}
      inlineClassName={`nodrag absolute z-10 flex flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
      inlineStyle={{
        top: `calc(100% + ${PANEL_GAP_PX}px)`,
        left: -PANEL_OVERHANG_PX,
        right: -PANEL_OVERHANG_PX,
      }}
      modalStyle={{ width: `min(${PANEL_EXPANDED_WIDTH_PX}px, 92vw)` }}
    >
      <PanelExpandButton
        expanded={panelExpanded}
        onToggle={() => setPanelExpanded((v) => !v)}
        className="absolute right-2 top-2 z-20"
      />
      {upstreamTextContents.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
          {upstreamTextContents.map((content) => (
            <ReferenceTextChip
              key={`upstream-text-${content.nodeId}`}
              nodeId={content.nodeId}
              text={content.text ?? ''}
              sourceLabel={content.displayName ?? content.nodeType}
              onDetach={detachUpstream}
            />
          ))}
        </div>
      )}

      <div className="px-3 pt-3">
        <label className="flex flex-col gap-2">
          <span className={AUDIO_INPUT_LABEL_CLASS}>
            {isMusic
              ? t('node.audioPanel.promptLabel.music')
              : t('node.audioPanel.promptLabel.speech')}
          </span>
          <textarea
            value={textDraft}
            onChange={(event) => {
              const next = event.target.value;
              setTextDraft(next);
              if (!isComposingTextRef.current) handleTextChange(next);
            }}
            onCompositionStart={() => {
              isComposingTextRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isComposingTextRef.current = false;
              const next = (event.target as HTMLTextAreaElement).value;
              setTextDraft(next);
              handleTextChange(next);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={
              isMusic
                ? t('node.audioPanel.promptPlaceholder.music')
                : t('node.audioPanel.promptPlaceholder.speech')
            }
            disabled={isGenerating}
            className={`${AUDIO_INPUT_FIELD_CLASS} ui-scrollbar resize-none py-2 leading-[1.65] ${
              panelExpanded ? 'min-h-[360px] max-h-[560px]' : 'min-h-[108px] max-h-[180px]'
            }`}
          />
        </label>
      </div>

      {!isMusic && (
      <div className="px-3 pb-3 pt-4">
        <label className="flex flex-col gap-2">
          <span className={AUDIO_INPUT_LABEL_CLASS}>
            {t('node.audioPanel.emotionLabel')}
            <span className="ml-1 text-text-muted/60">
              {t('node.audioPanel.emotionOptional')}
            </span>
          </span>
          <input
            type="text"
            value={emotionDraft}
            onChange={(event) => {
              const next = event.target.value;
              setEmotionDraft(next);
              if (!isComposingEmotionRef.current) handleEmotionChange(next);
            }}
            onCompositionStart={() => {
              isComposingEmotionRef.current = true;
            }}
            onCompositionEnd={(event) => {
              isComposingEmotionRef.current = false;
              const next = (event.target as HTMLInputElement).value;
              setEmotionDraft(next);
              handleEmotionChange(next);
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder={t('node.audioPanel.emotionPlaceholder')}
            disabled={isGenerating}
            className={`${AUDIO_INPUT_FIELD_CLASS} h-9`}
          />
        </label>
      </div>
      )}

      {voiceMissing ? (
        <p className="px-3 pb-2 text-[12px] text-amber-300">
          {t('node.audioPanel.voiceMissing')}
        </p>
      ) : null}

      <div className="flex shrink-0 items-center justify-end gap-2 px-3 pb-3 pt-1">
        <IconButton
          title={modelTaskAccess.message ?? t('node.audioPanel.translate')}
          onClick={handleTranslate}
          disabled={
            modelTaskAccess.blocked
            || isGenerating
            || isTranslating
            || text.trim().length === 0
          }
          active={isTranslating}
        >
          {isTranslating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Languages className="h-4 w-4" />
          )}
        </IconButton>
        {!isMusic && (
          <IconButton
            title={t('node.audioPanel.voiceSettings')}
            onClick={() => setShowVoiceSettings((v) => !v)}
            active={showVoiceSettings}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </IconButton>
        )}
        {isMusic && (
          <IconButton
            title={t('node.audioPanel.advancedSettings')}
            onClick={() => setShowMusicSettings((v) => !v)}
            active={showMusicSettings}
          >
            <Settings2 className="h-4 w-4" />
          </IconButton>
        )}
        <CreditCostPill
          display={costDisplay}
          promotion={audioCost.data?.data.promotion}
          disabled={submitDisabled}
          className={NODE_CREDIT_PILL_FLAT_CLASS}
        />
        <button
          type="button"
          disabled={submitDisabled}
          title={
            modelTaskAccess.message
            ?? (voiceMissing ? t('node.audioPanel.voiceMissing') : t('node.audioPanel.generate'))
          }
          onClick={handleSubmit}
          className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
            submitDisabled
              ? NODE_GENERATE_BUTTON_DISABLED_CLASS
              : NODE_GENERATE_BUTTON_ENABLED_CLASS
          }`}
        >
          {isGenerating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )}
        </button>
      </div>

      {!isMusic && showVoiceSettings && (
        <AudioVoiceSettingsPanel nodeId={nodeId} data={data} />
      )}

      {isMusic && showMusicSettings && (
        <AudioMusicSettingsPanel nodeId={nodeId} data={data} />
      )}
    </OperationPanelShell>
  );
}

// ---------------------------------------------------------------------------
// 通用 icon 按钮
// ---------------------------------------------------------------------------

interface IconButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}

function IconButton({ children, onClick, disabled, active, title }: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
        active ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 子面板：音色设置（只剩音色卡 + 切换按钮）
// ---------------------------------------------------------------------------

interface AudioVoiceSettingsPanelProps {
  nodeId: string;
  data: AudioNodeData;
}

// ---------------------------------------------------------------------------
// music 高级设置面板：音乐时长（带说明 tooltip + 预设下拉）
// ---------------------------------------------------------------------------

// 布尔设置开关，沿用画布里 VideoNode 的拨动开关样式（暗色面板下清晰可见）。
function MusicSettingToggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
      className="nodrag inline-flex shrink-0 items-center"
    >
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-[rgb(var(--accent-rgb))]' : 'bg-white/15'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

// 设置项标签后的「?」说明（hover 弹 tooltip）。
function MusicSettingHelp({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={120}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t('node.audioPanel.help')}
              className="inline-flex cursor-help items-center text-text-muted/70 transition-colors hover:text-text-dark"
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <CircleHelp className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[220px] leading-5">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function AudioMusicSettingsPanel({
  nodeId,
  data,
}: {
  nodeId: string;
  data: AudioNodeData;
}) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const musicLengthMs =
    typeof data.musicLengthMs === 'number' ? data.musicLengthMs : DEFAULT_MUSIC_LENGTH_MS;
  const forceInstrumental = data.forceInstrumental ?? true;
  const respectSectionsDurations = data.respectSectionsDurations ?? true;
  return (
    <div className="border-t border-white/[0.04] px-4 pb-3 pt-1">
      <div className="flex items-center justify-between py-2">
        <span className="text-[12px] font-semibold text-text-muted">
          {t('node.audioPanel.advancedSettings')}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-text-dark">
          {t('node.audioPanel.musicDuration')}
          <MusicSettingHelp text={t('node.audioPanel.musicDurationHelp')} />
        </span>
        <UiSelect
          aria-label={t('node.audioPanel.musicDuration')}
          value={String(musicLengthMs)}
          onChange={(event) =>
            updateNodeData(nodeId, { musicLengthMs: Number(event.target.value) })
          }
          onMouseDown={(event) => event.stopPropagation()}
          className={MUSIC_LENGTH_SELECT_CLASS}
          menuClassName={MUSIC_LENGTH_SELECT_MENU_CLASS}
        >
          {MUSIC_LENGTH_PRESETS.map((preset) => (
            <option key={preset.ms} value={String(preset.ms)}>
              {t(preset.labelKey)}
            </option>
          ))}
        </UiSelect>
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-text-dark">
          {t('node.audioPanel.forceInstrumental')}
          <MusicSettingHelp text={t('node.audioPanel.forceInstrumentalHelp')} />
        </span>
        <MusicSettingToggle
          ariaLabel={t('node.audioPanel.forceInstrumental')}
          checked={forceInstrumental}
          onChange={(next) => updateNodeData(nodeId, { forceInstrumental: next })}
        />
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-text-dark">
          {t('node.audioPanel.respectSections')}
          <MusicSettingHelp text={t('node.audioPanel.respectSectionsHelp')} />
        </span>
        <MusicSettingToggle
          ariaLabel={t('node.audioPanel.respectSections')}
          checked={respectSectionsDurations}
          onChange={(next) =>
            updateNodeData(nodeId, { respectSectionsDurations: next })
          }
        />
      </div>
    </div>
  );
}

function AudioVoiceSettingsPanel({ nodeId, data }: AudioVoiceSettingsPanelProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  // 默认音色的拉取放在 AudioNode 里完成（音频节点一挂载就会触发）；这里只负责展示。
  // 显示兜底改为「加载中…」而不是「项目解说人」——避免在 references 落地前误导用户。
  const voiceLabel = data.voiceLabel ?? t('node.audioPanel.voiceLoading');
  const voiceLanguage = data.voiceLanguage ?? '';
  const currentRef: AudioVoiceRef = data.voiceRef ?? { scope: 'project_narrator' };
  const [modalOpen, setModalOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    };
  }, []);

  const scheduleCopyStateReset = useCallback(() => {
    if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
    copyResetTimerRef.current = setTimeout(() => {
      setCopyState('idle');
      copyResetTimerRef.current = null;
    }, 1200);
  }, []);

  const handleCopyVoiceId = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyState('error');
      scheduleCopyStateReset();
      return;
    }
    const id = describeVoiceRef(currentRef, t);
    try {
      await navigator.clipboard.writeText(id);
      setCopyState('success');
    } catch {
      setCopyState('error');
    }
    scheduleCopyStateReset();
  }, [currentRef, scheduleCopyStateReset]);

  return (
    <div className="border-t border-white/[0.04] px-4 pt-1 pb-3">
      <div className="flex items-center justify-between py-2">
        <span className="text-[12px] font-semibold text-text-muted">
          {t('node.audioPanel.voiceSettings')}
        </span>
      </div>
      <div className="flex min-h-[55px] w-full items-center gap-3 rounded-[10px] border border-white/[0.08] bg-transparent px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-medium text-text-dark">{voiceLabel}</span>
            <button
              type="button"
              title={
                copyState === 'success'
                  ? t('node.audioPanel.copied')
                  : copyState === 'error'
                    ? t('node.audioPanel.copyFailed')
                    : t('node.audioPanel.copyVoiceRef')
              }
              onClick={handleCopyVoiceId}
              className={`flex h-4 w-4 shrink-0 items-center justify-center transition-colors ${
                copyState === 'success'
                  ? 'text-[rgb(var(--accent-rgb))]'
                  : copyState === 'error'
                    ? 'text-rose-300'
                    : 'text-text-muted hover:text-text-dark'
              }`}
            >
              {copyState === 'success' ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {voiceLanguage && (
            <span className="h-5 rounded bg-white/[0.08] px-1.5 text-[12px] leading-5 text-text-dark">
              {voiceLanguage}
            </span>
          )}
          <button
            type="button"
            title={t('node.audioPanel.switchVoice')}
            onClick={() => setModalOpen(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-dark transition-colors hover:bg-white/[0.06]"
          >
            <Repeat className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <VoiceSelectionModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        currentRef={currentRef}
        onPick={({ ref, label, language }) => {
          updateNodeData(nodeId, {
            voiceRef: ref,
            voiceAvailable: true,
            voiceLabel: label,
            voiceLanguage: language ?? '',
          });
          setModalOpen(false);
        }}
      />
    </div>
  );
}

function describeVoiceRef(ref: AudioVoiceRef, t: TFunction): string {
  switch (ref.scope) {
    case 'project_narrator':
      return t('node.voiceRef.projectNarrator');
    case 'user_custom':
      return ref.voiceId ?? t('node.voiceRef.userCustom');
    case 'character_default':
      return t('node.voiceRef.characterDefault', {
        name: ref.characterName ?? t('node.voiceRef.character'),
      });
    case 'character_age_group':
      return t('node.voiceRef.characterAgeGroup', {
        name: ref.characterName ?? t('node.voiceRef.character'),
        slot: ref.slot ?? t('node.voiceRef.ageGroup'),
      });
    case 'identity':
      return t('node.voiceRef.identity', {
        id: ref.identityId ?? t('node.voiceRef.identityFallback'),
      });
    case 'identity_resolved':
      return t('node.voiceRef.identityResolved', {
        id: ref.identityId ?? t('node.voiceRef.identityFallback'),
      });
    default:
      return ref.scope;
  }
}
