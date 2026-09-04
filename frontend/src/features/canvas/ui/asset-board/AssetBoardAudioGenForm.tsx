// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { ArrowUp, Loader2, Music2, Settings2, SlidersHorizontal } from 'lucide-react';

import { CreditCostPill } from '@/components/credits/credit-visual';
import { UiSelect } from '@/components/ui';
import type {
  AudioNodeData,
  AudioVoiceRef,
  CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_MUSIC_LENGTH_MS,
  MUSIC_LENGTH_PRESETS,
  musicBillingSecondsFromMs,
} from '@/features/canvas/nodes/AudioOperationsPanel';
import { deriveAudioText, useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { requiresCustomVoiceSelection } from '@/features/canvas/nodes/audioVoicePolicy';
import { VoiceSelectionModal } from '@/features/canvas/nodes/VoiceSelectionModal';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { useCanvasStore } from '@/stores/canvasStore';

import { createAssetBoardOpsRegistry } from './assetBoardOpsState';

/** 进行中的音频操作（目前只有生成——下载/转码的 busy 态由 chip 自己持有）。 */
type AudioBusyOp = 'generate';

/**
 * 音频侧的「进行中 + 失败反馈」登记表（与图片/视频/文本侧同一套工厂，见
 * assetBoardOpsState）。生成本身的 loading 与错误其实已经写在 node.data 上
 * （useAudioGeneration 负责），这里登记的是**详情面板这一侧**的重复提交防护：
 * 表单按 key={nodeId} 重挂载，切走再切回不该让同一个节点被再提交一次。
 */
const audioOpsRegistry = createAssetBoardOpsRegistry<AudioBusyOp>();

/** 导出供测试断言（nodeId → 进行中的音频操作名）。 */
export const inFlightAudioOps: ReadonlyMap<string, AudioBusyOp> = audioOpsRegistry.inFlight;

/** 仅供测试：清空进行中/失败两张登记表，避免用例间靠固定 node id 串态。 */
export function __resetAssetBoardAudioOpsStateForTest(): void {
  audioOpsRegistry.resetForTest();
}

const FIELD_LABEL_CLASS = 'text-[12px] text-white/40';
// 圆角 6px：本项目 --radius=1rem，rounded-lg 折合 16px，在输入框上过圆（同
// AssetBoardToolbarButton 收到 rounded-[6px] 的理由）。
const FIELD_CLASS =
  'w-full rounded-[6px] border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-6 text-white/85 outline-none placeholder:text-white/25 focus:border-white/25';
const MUSIC_LENGTH_SELECT_CLASS =
  '!h-8 !w-[120px] !rounded-[8px] !border-white/10 !bg-white/[0.06] !px-3 !text-[12px] !text-white/85 hover:!border-white/25';
const MUSIC_LENGTH_SELECT_MENU_CLASS =
  '!z-[260] !min-w-[140px] !border-white/10 !bg-[#2e2e2e] !text-white/85 shadow-xl';

/** 布尔设置开关（与工作流音频面板的拨动开关同构，配色贴故事板暗面板）。 */
function SettingToggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center"
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

interface AssetBoardAudioGenFormProps {
  nodeId: string;
  data: AudioNodeData;
}

/**
 * 故事板音频详情里挂在波形播放器下方的「音频生成表单」：合成文本/音乐描述、语气词、
 * 声线选择、音乐高级设置、生成/重新生成。与图片/视频详情的 `AssetBoardImageGenForm`
 * / `AssetBoardVideoGenForm` 同一族位置（媒体区下方一条生成条）。
 *
 * 竖向布局，宽度贴合详情面板（此前的顶部内联展开是横向铺开的一整行，已随音频进
 * 详情栈一并退掉——见 AssetBoardView 的音频条注释）。生成走 useAudioGeneration ——
 * 与工作流节点面板、节点本体的失败重试同一份实现。空音频节点（无 audioUrl）也挂
 * 这份表单，可从零生成，对齐图片/视频空节点体验。
 */
export function AssetBoardAudioGenForm({
  nodeId,
  data,
}: AssetBoardAudioGenFormProps): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { generate, isGenerating, effectivePrompt, isMusic } = useAudioGeneration(nodeId, data);
  const busyOp = audioOpsRegistry.useInFlightOp(nodeId);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [showMusicSettings, setShowMusicSettings] = useState(false);

  const text = useMemo(() => deriveAudioText(data), [data]);
  const emotionPrompt = data.emotionPrompt ?? '';
  const musicLengthMs =
    typeof data.musicLengthMs === 'number' ? data.musicLengthMs : DEFAULT_MUSIC_LENGTH_MS;
  const currentVoiceRef: AudioVoiceRef = data.voiceRef ?? { scope: 'project_narrator' };
  const voiceMissing = requiresCustomVoiceSelection(data);
  // 已有产物 → 提交键语义是「重新生成」（与图片/视频详情口径一致）。
  const hasAudio = typeof data.audioUrl === 'string' && data.audioUrl.length > 0;

  // 算力询价：与工作流 AudioOperationsPanel 同一口径（music 按计费秒数，speech 按次）。
  const audioCost = useGenerationCreditCost(
    isMusic ? 'freezone_audio_music' : 'beat_tts',
    null,
    isMusic
      ? { surface: 'canvas', quantity: musicBillingSecondsFromMs(musicLengthMs) }
      : {},
  );

  const patch = useCallback(
    (next: Partial<AudioNodeData>) => {
      updateNodeData(nodeId, next as Partial<CanvasNodeData>);
    },
    [nodeId, updateNodeData],
  );

  const handleGenerate = useCallback(async () => {
    if (audioOpsRegistry.inFlight.get(nodeId)) return;
    audioOpsRegistry.markOpStart(nodeId, 'generate');
    try {
      await generate();
    } finally {
      audioOpsRegistry.markOpSettled(nodeId);
    }
  }, [generate, nodeId]);

  const submitDisabled = isGenerating || busyOp !== null || effectivePrompt.length === 0;

  return (
    // 外框与图片/视频生成条同款（CANVAS_NODE_OPS_PANEL_CLASS + 节点圆角）：三种
    // 生成条摆在同一个详情面板里，边框/底色不该各写一套（用户要求对齐视频）。
    <div
      className={`flex w-full flex-col gap-3 rounded-[var(--node-radius)] p-3 ${CANVAS_NODE_OPS_PANEL_CLASS}`}
    >
      {/* 失败原因不在这里内联：详情头部下方已有共享失败红条（AssetBoardDetail），
          对所有栏含音频统一展示 node.data.generationError，与图片/视频 GenForm
          一致（它们也不内联错误）。此前这份内联块是从旧顶部内联面板带过来的。 */}

      <div className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>{isMusic ? '音乐描述' : '要合成的文本'}</span>
        {/* 直绑 store（不做本地草稿 + IME 守卫）：工作流面板那份守卫是为了避开
            画布上高频重渲染打断输入法候选；故事板隐藏时数据源整体冻结，这里没有
            同一个问题，多一层草稿反而会和「切走再切回」的重挂载互相打架。 */}
        <textarea
          value={text}
          onChange={(event) => patch({ text: event.target.value })}
          disabled={isGenerating}
          placeholder={
            isMusic ? '描述想要的音乐：风格、乐器、节奏、氛围…' : '输入要合成的文本'
          }
          className={`${FIELD_CLASS} min-h-[84px] resize-y`}
        />
      </div>

      {!isMusic && (
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL_CLASS}>语气词（可选）</span>
          <input
            type="text"
            value={emotionPrompt}
            onChange={(event) => patch({ emotionPrompt: event.target.value })}
            disabled={isGenerating}
            placeholder="如：紧张、压低声音、带一点恐惧感"
            className={FIELD_CLASS}
          />
        </div>
      )}

      {!isMusic && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setVoiceModalOpen(true)}
            className="h-7 rounded-[5px] bg-white/10 text-[12px] text-white/90 transition-colors hover:bg-white/15"
          >
            {voiceMissing ? '选择自定义声线' : '更换自定义声线'}
          </button>
          <div className="flex items-center gap-2 text-[12px] text-white/60">
            <span className={FIELD_LABEL_CLASS}>声线</span>
            <span className="truncate text-white/85">
              {voiceMissing ? '未选择（生成时跳过）' : data.voiceLabel ?? '自定义声线'}
            </span>
            {data.voiceLanguage && (
              <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[11px] text-white/70">
                {data.voiceLanguage}
              </span>
            )}
          </div>
        </div>
      )}

      {isMusic && showMusicSettings && (
        <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">音乐时长</span>
            <UiSelect
              aria-label="音乐时长"
              value={String(musicLengthMs)}
              onChange={(event) => patch({ musicLengthMs: Number(event.target.value) })}
              className={MUSIC_LENGTH_SELECT_CLASS}
              menuClassName={MUSIC_LENGTH_SELECT_MENU_CLASS}
            >
              {MUSIC_LENGTH_PRESETS.map((preset) => (
                <option key={preset.ms} value={String(preset.ms)}>
                  {preset.label}
                </option>
              ))}
            </UiSelect>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">强制纯音乐</span>
            <SettingToggle
              ariaLabel="强制纯音乐"
              checked={data.forceInstrumental ?? true}
              onChange={(next) => patch({ forceInstrumental: next })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">遵守段落时长</span>
            <SettingToggle
              ariaLabel="遵守段落时长"
              checked={data.respectSectionsDurations ?? true}
              onChange={(next) => patch({ respectSectionsDurations: next })}
            />
          </div>
        </div>
      )}

      {/* 底部控制行（对标 liblib 的紧凑 footer，去掉模型选择——我们不给选模型）：
          左 = 模式（自定义声线旁白或文字生成音乐）；
          右 = 字数 · 音色/高级设置 · 算力 ✦ · 提交箭头。与工作流 AudioOperationsPanel
          的控制行同款组件（IconButton / CreditCostPill / ArrowUp 提交键）。 */}
      <div className="flex items-center gap-2 pt-0.5">
        <Music2 className="h-3.5 w-3.5 shrink-0 text-white/40" />
        <span className="min-w-0 truncate text-[12px] text-white/60">
          {isMusic
            ? '文字生成音乐'
            : '自定义声线旁白'}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] tabular-nums text-white/35">{text.length}</span>
        {!isMusic && (
          <button
            type="button"
            title={`音色设置（当前：${voiceMissing ? '未选择' : data.voiceLabel ?? '自定义声线'}）`}
            onClick={() => setVoiceModalOpen(true)}
            className={NODE_INLINE_ICON_BUTTON_CLASS}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        )}
        {isMusic && (
          <button
            type="button"
            title="高级设置"
            onClick={() => setShowMusicSettings((open) => !open)}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              showMusicSettings ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
            }`}
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
        <CreditCostPill
          display={audioCost.data?.data.display}
          promotion={audioCost.data?.data.promotion}
          disabled={submitDisabled}
          className={NODE_CREDIT_PILL_FLAT_CLASS}
        />
        <button
          type="button"
          disabled={submitDisabled}
          // 已有产物时语义是「重新生成」（与图片/视频详情口径一致）。
          title={
            effectivePrompt.length === 0
              ? isMusic
                ? '先填写音乐描述'
                : '先填写要合成的文本'
              : hasAudio
                ? '重新生成'
                : '生成'
          }
          aria-label={hasAudio ? '重新生成' : '生成'}
          onClick={() => void handleGenerate()}
          className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
            submitDisabled
              ? NODE_GENERATE_BUTTON_DISABLED_CLASS
              : NODE_GENERATE_BUTTON_ENABLED_CLASS
          }`}
        >
          {isGenerating || busyOp === 'generate' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )}
        </button>
      </div>

      <VoiceSelectionModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        currentRef={currentVoiceRef}
        onPick={({ ref, label, language }) => {
          patch({
            speechMode: 'clone',
            voiceRef: ref,
            voiceLabel: label,
            voiceLanguage: language ?? '',
          });
          setVoiceModalOpen(false);
        }}
      />
    </div>
  );
}
