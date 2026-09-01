// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  ensureBackendImageUrl,
  fetchFreezoneReversePromptResult,
  submitFreezoneReversePrompt,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

/** 反推提示词通常十几秒返回，用它给 loading 覆盖层估算进度推进。 */
export const REVERSE_PROMPT_DURATION_MS = 15000;

/**
 * 解析上游图片节点「眼下展示的那张图」的 URL。和 graphContentResolver 的图片分支
 * 保持同一套回退顺序：生成结果 imageUrl → previewImageUrl → referenceImageUrl，
 * 这样图生节点只挂了参考图（还没生成）时也能被识别为可引用素材。
 *
 * （从 TextAnnotationNode 的模块私有函数原样搬出并导出——故事板详情要在按钮显隐
 * 判断里用同一套回退顺序，否则「有图能反推」的口径会和工作流分叉。）
 */
export function resolveUpstreamImageUrl(data: unknown): string | null {
  const d = data as
    | { imageUrl?: unknown; previewImageUrl?: unknown; referenceImageUrl?: unknown }
    | undefined;
  for (const candidate of [d?.imageUrl, d?.previewImageUrl, d?.referenceImageUrl]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

/** 取文本节点第一条上游边源节点上「眼下展示的那张图」（无上游/无图 → null）。 */
export function resolveTextNodeUpstreamImageUrl(nodeId: string): string | null {
  const state = useCanvasStore.getState();
  const upstreamEdge = state.edges.find((edge) => edge.target === nodeId);
  if (!upstreamEdge) return null;
  const sourceNode = state.nodes.find((node) => node.id === upstreamEdge.source);
  return resolveUpstreamImageUrl(sourceNode?.data);
}

export interface TextImageToPromptResult {
  /** 反推出的提示词；未成功回填时为 null。 */
  prompt: string | null;
  /** 失败原因；成功（含「返回空提示词」）时为 null。 */
  error: string | null;
}

/**
 * 图片反推提示词提交编排（从 TextAnnotationNode.runImageToPrompt 原样搬出，语义
 * 零变化）：取上游图 URL → 置本节点 isGenerating → 必要时先把 data: URL 传成后端
 * 静态路径 → 提交 /freezone/reverse-prompt → 等任务完成 → 取 job result 的 prompt
 * 回填到**本节点自己的 content**（不新建节点）。
 *
 * 失败与「无上游图」都只清 loading 态、不写 node.data.generationError —— 原实现
 * 就是这样（错误只进 console），保持不变；返回值让调用方（故事板详情）能把失败
 * 文案显示在自己的工具条上。
 */
export async function runTextImageToPrompt(
  nodeId: string,
): Promise<TextImageToPromptResult> {
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[text-node] no project in URL');
    return { prompt: null, error: '当前 URL 缺少 project 参数' };
  }
  const rawUrl = resolveTextNodeUpstreamImageUrl(nodeId);
  if (!rawUrl) {
    console.warn('[text-node] imageToPrompt: no upstream image url');
    return { prompt: null, error: '上游没有可反推的图片' };
  }
  const updateNodeData = useCanvasStore.getState().updateNodeData;
  updateNodeData(nodeId, { isGenerating: true, generationStartedAt: Date.now() });
  try {
    // Backend looks up the file by static path — `data:` URLs get uploaded
    // first via /freezone/upload to obtain a real path; `?v=<ts>` cache
    // busters are stripped either way.
    const sourceUrl = await ensureBackendImageUrl(projectId, rawUrl);
    const ref = await submitFreezoneReversePrompt(projectId, {
      sourceUrl,
      canvasId: readUrl().canvas ?? 'default',
      nodeId,
    });
    // Persist the task handle so a page refresh can resume this job.
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    await awaitTaskCompletion(ref.task_key, projectId);
    // SSE task.result only carries `{ output_format: "json" }`; the prompt
    // text comes from the dedicated job-result endpoint.
    const { prompt } = await fetchFreezoneReversePromptResult(projectId, ref.job_id);
    const done = useCanvasStore.getState().updateNodeData;
    if (prompt && prompt.trim().length > 0) {
      done(nodeId, { content: prompt, isGenerating: false, generationStartedAt: null });
      return { prompt, error: null };
    }
    console.warn('[text-node] reverse-prompt returned empty prompt', { jobId: ref.job_id });
    done(nodeId, { isGenerating: false, generationStartedAt: null });
    return { prompt: null, error: null };
  } catch (error) {
    console.error('[text-node] reverse-prompt failed', error);
    useCanvasStore
      .getState()
      .updateNodeData(nodeId, { isGenerating: false, generationStartedAt: null });
    return {
      prompt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
