// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchFreezoneJobResult, sendGenerationWireRequest, type FreezoneJobRef } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { CANVAS_NODE_TYPES, type AudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveAudioKind } from '@/features/canvas/application/audioSpeechText';
import {
  audioEffectivePrompt, audioMusicKindRepairPatch, audioMusicLengthRepairPatch,
  audioSpeechInstructionRepairPatch, audioPromptCompileInput, audioPromptCompileMetadataPatch,
  buildAudioGenerationRequest, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import {
  audioGenerationStartPatch, audioGenerationAcceptedPatch, audioGenerationOutcomePatch,
  audioGenerationHookError,
} from '@/features/canvas/application/generationRequests/audioGenerationResult';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useUpstreamContents, useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { workflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import { useModelTaskAccess } from '@/lib/model-task-access';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * 老节点数据可能还带着 segments（旧版分段编辑器留下的）。新版直接读 `text`，
 * 没的话回退去拼 segments — 这样老节点打开后用户就能继续编辑。
 */
export { deriveAudioText } from './audioGenerationText';

/**
 * 音频节点的生成逻辑——提交按钮（面板）和失败重试（节点本体）共用。
 * 把生成放进 hook 而非面板组件，是因为面板只在节点被选中时渲染；节点本体需要
 * 在未选中时也能触发重试，且失败信息持久化在节点数据里跨虚拟化重挂存活。
 */
export function useAudioGeneration(nodeId: string, data: AudioNodeData) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { isGenerating } = useNodeGenerationTaskState(data);
  const upstreamNodes = useUpstreamNodes(nodeId);
  const upstreamContents = useUpstreamContents(nodeId);
  const isMusic = resolveAudioKind(data) === 'music';
  useEffect(() => {
    const patch = audioMusicKindRepairPatch(data, new Date().toISOString());
    if (patch) updateNodeData(nodeId, patch);
  }, [data, nodeId, updateNodeData]);
  useEffect(() => {
    const patch = audioMusicLengthRepairPatch(data);
    if (patch) updateNodeData(nodeId, patch);
  }, [data, nodeId, updateNodeData]);
  // 有效 prompt：上游引用的文本不回显进输入框，仅在提交时与本地输入「拼接」成最终
  // prompt（上游在前、本地在后，与 joinUpstreamText 一致用空行分隔，过滤空段）。
  const effectivePrompt = audioEffectivePrompt(data, upstreamContents);
  useEffect(() => {
    const patch = audioSpeechInstructionRepairPatch(data, new Date().toISOString());
    if (patch) updateNodeData(nodeId, patch);
  }, [data, nodeId, updateNodeData]);
  // 组织成员没有发起模型任务的资格时不放行。面板与节点本体的重试共用这个 hook，
  // 所以门控放在这里，两条入口都盖到。
  const modelTaskAccess = useModelTaskAccess();
  const { t } = useTranslation();

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
    const ctx: AudioGenerationRequestContext = {
      nodes: [{ id: nodeId, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
        data: runtimeData }, ...upstreamNodes],
      edges: upstreamNodes.map((node, index) => ({ id: `${nodeId}-upstream-${index}`,
        source: node.id, target: nodeId })),
      nodeId, projectId: readUrl().project ?? '', canvasId: readUrl().canvas ?? 'default',
      productOperation: null, isGenerating, translate: t,
    };
    const decision = audioPromptCompileInput(ctx);
    if (decision.kind === 'refuse'
      && (decision.code === 'generation_in_progress' || decision.code === 'not_audio_node')) return {};
    if (modelTaskAccess.blocked) {
      if (modelTaskAccess.message) updateNodeData(nodeId, { generationError: modelTaskAccess.message });
      return {};
    }
    if (decision.kind === 'skip') {
      updateNodeData(nodeId, decision.patch);
      return decision.output;
    }
    if (decision.kind === 'refuse') {
      if (decision.code === 'no_project') updateNodeData(nodeId, decision.patch);
      return {};
    }
    updateNodeData(nodeId, audioGenerationStartPatch(Date.now()));
    try {
      let compileMode: string | null = null;
      let recipeIds: string[] = [];
      const prompt = decision.kind === 'literal' ? decision.prompt : await compileWorkflowNodePrompt({
        nodeId, nodeData: runtimeData, ...decision.input,
        onCompileMetadata: (metadata) => {
          compileMode = metadata.mode;
          recipeIds = metadata.recipeIds;
          updateNodeData(nodeId, audioPromptCompileMetadataPatch(ctx, metadata, new Date().toISOString()));
        },
      });
      const build = buildAudioGenerationRequest({ ...ctx, canvasId: readUrl().canvas ?? 'default',
        productOperation: workflowProductOperation(nodeId) ?? null, prompt, compileMode, recipeIds });
      if (!build.ok) throw new Error(build.message);
      const ref = await sendGenerationWireRequest<FreezoneJobRef>(build.requests[0]);
      updateNodeData(nodeId, audioGenerationAcceptedPatch(ref));
      await awaitTaskCompletion(ref.task_key, ctx.projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneJobResult(
        ctx.projectId,
        resolveAudioKind(runtimeData) === 'music' ? 'freezone_audio_eleven_music' : 'freezone_audio_speech',
        ref.job_id,
      );
      const outcome = audioGenerationOutcomePatch({ outcome: { kind: 'completed', url: result.url }, translate: t });
      updateNodeData(nodeId, outcome.patches[0]);
      if ('hookOutput' in outcome) return outcome.hookOutput;
      return {};
    } catch (error) {
      console.error(
        `[audio-node] ${resolveAudioKind(runtimeData) === 'music' ? 'music' : 'speech'} generation failed`,
        error,
      );
      updateNodeData(nodeId, audioGenerationOutcomePatch({
        outcome: { kind: 'failed', ...audioGenerationHookError(error) }, translate: t,
      }).patches[0]);
      throw error;
    }
  }, [t, isGenerating, modelTaskAccess, data, nodeId, updateNodeData, upstreamNodes]);

  return { generate, isGenerating, effectivePrompt, isMusic, modelTaskAccess };
}
