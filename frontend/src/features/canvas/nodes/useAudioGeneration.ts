// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useMemo } from 'react';

import {
  fetchFreezoneJobResult,
  submitFreezoneAudioMusic,
  submitFreezoneAudioSpeech,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  type AudioNodeData,
  type AudioTextSegment,
} from '@/features/canvas/domain/canvasNodes';
import { joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
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
  const isMusic = data.audioKind === 'music';
  // 有效 prompt：上游引用的文本不回显进输入框，仅在提交时与本地输入「拼接」成最终
  // prompt（上游在前、本地在后，与 joinUpstreamText 一致用空行分隔，过滤空段）。
  const ownText = deriveAudioText(data);
  const effectivePrompt = [upstreamTextJoined.trim(), ownText.trim()]
    .filter((segment) => segment.length > 0)
    .join('\n\n');
  const emotionPrompt = data.emotionPrompt ?? '';
  // 组织成员没有发起模型任务的资格时不放行。面板与节点本体的重试共用这个 hook，
  // 所以门控放在这里，两条入口都盖到。
  const modelTaskAccess = useModelTaskAccess();

  const generate = useCallback(async () => {
    if (isGenerating) return;
    if (modelTaskAccess.blocked) {
      if (modelTaskAccess.message) {
        updateNodeData(nodeId, { generationError: modelTaskAccess.message });
      }
      return;
    }
    const trimmed = effectivePrompt;
    if (trimmed.length === 0) return;
    const project = readUrl().project;
    if (!project) {
      updateNodeData(nodeId, { generationError: '当前 URL 缺少 project 参数' });
      return;
    }
    updateNodeData(nodeId, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
    });
    try {
      const ref = isMusic
        ? await submitFreezoneAudioMusic(project, {
            prompt: trimmed,
            musicLengthMs:
              typeof data.musicLengthMs === 'number' ? data.musicLengthMs : undefined,
            forceInstrumental: data.forceInstrumental ?? true,
            respectSectionsDurations: data.respectSectionsDurations ?? true,
          })
        : await submitFreezoneAudioSpeech(project, {
            text: trimmed,
            emotionPrompt: emotionPrompt.trim() || undefined,
            voiceRef: data.voiceRef ?? { scope: 'project_narrator' },
          });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(nodeId, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const result = await fetchFreezoneJobResult(
        project,
        isMusic ? 'freezone_audio_eleven_music' : 'freezone_audio_speech',
        ref.job_id,
      );
      updateNodeData(nodeId, {
        isGenerating: false,
        audioUrl: result.url,
        durationMs: null,
        generationError: null,
      });
    } catch (error) {
      console.error(
        `[audio-node] ${isMusic ? 'music' : 'speech'} generation failed`,
        error,
      );
      updateNodeData(nodeId, {
        isGenerating: false,
        generationError: error instanceof Error ? error.message : '生成失败',
      });
    }
  }, [
    isGenerating,
    modelTaskAccess,
    isMusic,
    data.musicLengthMs,
    data.forceInstrumental,
    data.respectSectionsDurations,
    data.voiceRef,
    effectivePrompt,
    emotionPrompt,
    nodeId,
    updateNodeData,
  ]);

  return { generate, isGenerating, effectivePrompt, isMusic, modelTaskAccess };
}
