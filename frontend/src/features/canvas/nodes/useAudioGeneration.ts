// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo } from 'react';

import {
  fetchFreezoneJobResult,
  submitFreezoneAudioMusic,
  submitFreezoneAudioSpeech,
} from '@/api/ops';
import { requiresCustomVoiceSelection } from './audioVoicePolicy';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  type AudioNodeData,
  type AudioTextSegment,
} from '@/features/canvas/domain/canvasNodes';
import { joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import {
  CLEARED_GENERATION_TASK_FIELDS,
  generationTaskDescriptor,
} from '@/features/canvas/application/resumeGeneration';
import {
  extractSpeakableAudioText,
  isSpeechGenerationInstruction,
  resolveAudioKind,
  resolveMusicLengthMs,
} from '@/features/canvas/application/audioSpeechText';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import {
  compileWorkflowNodePrompt,
  selectWorkflowUpstreamText,
} from '@/features/canvas/application/workflowRecipeRuntime';
import { useModelTaskAccess } from '@/lib/model-task-access';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * 老节点数据可能还带着 segments（旧版分段编辑器留下的）。新版直接读 `text`，
 * 没的话回退去拼 segments — 这样老节点打开后用户就能继续编辑。
 */
export function deriveAudioText(data: AudioNodeData): string {
  if (typeof data.text === 'string') return data.text;
  if (Array.isArray(data.segments)) {
    return data.segments
      .map((seg: AudioTextSegment) => (seg.type === 'text' ? seg.value : ''))
      .join('');
  }
  return '';
}

/**
 * 音频节点的生成逻辑——提交按钮（面板）和失败重试（节点本体）共用。
 * 把生成放进 hook 而非面板组件，是因为面板只在节点被选中时渲染；节点本体需要
 * 在未选中时也能触发重试，且失败信息持久化在节点数据里跨虚拟化重挂存活。
 */
export function useAudioGeneration(nodeId: string, data: AudioNodeData) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { isGenerating } = useNodeGenerationTaskState(data);
  const upstreamContents = useUpstreamContents(nodeId);
  const upstreamTextJoined = useMemo(
    () => joinUpstreamText(upstreamContents),
    [upstreamContents],
  );
  const resolvedAudioKind = resolveAudioKind(data);
  const isMusic = resolvedAudioKind === 'music';
  const resolvedMusicLengthMs = isMusic ? resolveMusicLengthMs(data) : undefined;
  useEffect(() => {
    if (resolvedAudioKind === 'music' && data.audioKind !== 'music') {
      updateNodeData(nodeId, {
        audioKind: 'music',
        model: 'suno_music',
        ...(data.audioUrl
          ? {}
          : {
              audioUrl: null,
              durationMs: null,
              generationError: '背景音乐节点已修正，请重新生成音乐',
              workflowResultStale: true,
              workflowInvalidatedAt: new Date().toISOString(),
              workflowInvalidationReason: '音频类型由语音修正为背景音乐',
            }),
      });
    }
  }, [data.audioKind, data.audioUrl, nodeId, resolvedAudioKind, updateNodeData]);
  useEffect(() => {
    if (
      isMusic
      && resolvedMusicLengthMs !== undefined
      && data.musicLengthMs !== resolvedMusicLengthMs
    ) {
      updateNodeData(nodeId, { musicLengthMs: resolvedMusicLengthMs });
    }
  }, [
    data.musicLengthMs,
    isMusic,
    nodeId,
    resolvedMusicLengthMs,
    updateNodeData,
  ]);
  // 有效 prompt：上游引用的文本不回显进输入框，仅在提交时与本地输入「拼接」成最终
  // prompt（上游在前、本地在后，与 joinUpstreamText 一致用空行分隔，过滤空段）。
  const ownText = deriveAudioText(data);
  const hasInvalidSpeechInstruction =
    !isMusic && isSpeechGenerationInstruction(ownText);
  useEffect(() => {
    if (hasInvalidSpeechInstruction && data.audioUrl) {
      updateNodeData(nodeId, {
        audioUrl: null,
        durationMs: null,
        generationError: '旁白节点缺少实际朗读文案，请填写旁白正文后重新生成',
        workflowResultStale: true,
        workflowInvalidatedAt: new Date().toISOString(),
        workflowInvalidationReason: '旁白生成说明不能作为朗读正文',
      });
    }
  }, [data.audioUrl, hasInvalidSpeechInstruction, nodeId, updateNodeData]);
  const effectivePrompt = [upstreamTextJoined.trim(), ownText.trim()]
    .filter((segment) => segment.length > 0)
    .join('\n\n');
  const emotionPrompt = data.emotionPrompt ?? '';
  const speechMode = 'clone';
  // 组织成员没有发起模型任务的资格时不放行。面板与节点本体的重试共用这个 hook，
  // 所以门控放在这里，两条入口都盖到。
  const modelTaskAccess = useModelTaskAccess();

  const generate = useCallback(async (): Promise<{
    audioUrl?: string;
    skipped?: boolean;
    reason?: string;
  }> => {
    // 画布批量命令会在同一轮里先写节点参数、再立即执行动作。React props 可能尚未
    // 完成下一次渲染，因此这里必须以 store 中的最新节点数据为准，避免漏掉用户刚在
    // 选择器中确认的自定义声线并把本次生成误判为跳过。
    const latestNode = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    const runtimeData = (latestNode?.data as AudioNodeData | undefined) ?? data;
    const runtimeAudioKind = resolveAudioKind(runtimeData);
    const runtimeIsMusic = runtimeAudioKind === 'music';
    // Freezone speech is custom-voice only. Keep backend preset support for
    // historical/Hermes callers, but never submit preset generation here.
    const runtimeSpeechMode = 'clone';
    const runtimeOwnText = deriveAudioText(runtimeData);
    const runtimeEffectivePrompt = [upstreamTextJoined.trim(), runtimeOwnText.trim()]
      .filter((segment) => segment.length > 0)
      .join('\n\n');
    const runtimeMusicLengthMs = runtimeIsMusic
      ? resolveMusicLengthMs(runtimeData)
      : undefined;
    if (isGenerating || runtimeData.isGenerating === true) return {};
    if (modelTaskAccess.blocked) {
      if (modelTaskAccess.message) {
        updateNodeData(nodeId, { generationError: modelTaskAccess.message });
      }
      return {};
    }
    if (!runtimeIsMusic && requiresCustomVoiceSelection(runtimeData)) {
      updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: '未选择自定义声线，已跳过生成',
      });
      return { skipped: true, reason: 'missing_custom_voice' };
    }
    const fallbackPrompt = runtimeEffectivePrompt;
    if (fallbackPrompt.length === 0) return {};
    const project = readUrl().project;
    if (!project) {
      updateNodeData(nodeId, { generationError: '当前 URL 缺少 project 参数' });
      return {};
    }
    updateNodeData(nodeId, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
    });
    try {
      const trimmed = runtimeIsMusic
        ? await compileWorkflowNodePrompt({
            nodeId,
            nodeData: runtimeData,
            nodeKind: 'audio',
            nodePrompt: runtimeOwnText,
            upstreamText: upstreamTextJoined,
            upstreamContents,
            fallbackPrompt,
            onCompileMetadata: ({ mode, prompt: compiledPrompt, recipeIds }) => updateNodeData(nodeId, {
              workflowRecipeCompileMode: mode,
              workflowRecipeCompiledAt: new Date().toISOString(),
              workflowRecipeCompiledPrompt: compiledPrompt,
              text: compiledPrompt,
              workflowRecipeIds: recipeIds,
            }),
          })
        : (() => {
            // A workflow may leave a label such as “这是短剧的第一段旁白”
            // in the audio node while the real narration is provided by an
            // upstream script/text node.  Strip the label first, then fall
            // back to the upstream narration instead of sending the label to
            // TTS verbatim.
            const ownNarration = extractSpeakableAudioText(runtimeOwnText.trim());
            const upstreamNarration = extractSpeakableAudioText(
              selectWorkflowUpstreamText(runtimeData, upstreamContents, upstreamTextJoined),
            );
            return ownNarration || upstreamNarration;
          })();
      if (!trimmed) {
        throw new Error('没有可朗读的旁白或对白');
      }
      const ref = runtimeIsMusic
        ? await submitFreezoneAudioMusic(project, {
            prompt: trimmed,
            musicLengthMs: runtimeMusicLengthMs,
            forceInstrumental: runtimeData.forceInstrumental ?? true,
            respectSectionsDurations: runtimeData.respectSectionsDurations ?? true,
          })
        : await submitFreezoneAudioSpeech(project, {
            text: trimmed,
            speechMode: runtimeSpeechMode,
            emotionPrompt: (runtimeData.emotionPrompt ?? '').trim() || undefined,
            voiceRef: runtimeData.voiceRef,
          });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(nodeId, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const result = await fetchFreezoneJobResult(
        project,
        runtimeIsMusic ? 'freezone_audio_eleven_music' : 'freezone_audio_speech',
        ref.job_id,
      );
      updateNodeData(nodeId, {
        ...CLEARED_GENERATION_TASK_FIELDS,
        audioUrl: result.url,
        durationMs: null,
        generationError: null,
      });
      return result.url ? { audioUrl: result.url } : {};
    } catch (error) {
      console.error(
        `[audio-node] ${runtimeIsMusic ? 'music' : 'speech'} generation failed`,
        error,
      );
      updateNodeData(nodeId, {
        ...CLEARED_GENERATION_TASK_FIELDS,
        generationError: error instanceof Error ? error.message : '生成失败',
      });
      throw error;
    }
  }, [
    isGenerating,
    modelTaskAccess,
    isMusic,
    data,
    data.musicLengthMs,
    data.forceInstrumental,
    data.respectSectionsDurations,
    data.voiceAvailable,
    data.voiceRef,
    data.presetModel,
    data.presetVoice,
    effectivePrompt,
    hasInvalidSpeechInstruction,
    resolvedMusicLengthMs,
    emotionPrompt,
    speechMode,
    nodeId,
    ownText,
    updateNodeData,
    upstreamContents,
    upstreamTextJoined,
  ]);

  return { generate, isGenerating, effectivePrompt, isMusic, modelTaskAccess };
}
