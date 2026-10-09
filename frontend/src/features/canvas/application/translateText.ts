// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneTextTranslateResult,
  submitFreezoneTextTranslate,
  type FreezoneTextTranslateNodeType,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { readUrl } from '@/lib/url-params';

/**
 * 文本翻译共享核心（原 ImageGenNode / VideoNode / TextAnnotationNode / ScriptNode /
 * AudioOperationsPanel 各自内联的同一段编排）：提交 /freezone/text/translate →
 * 等任务完成 → 取译文。canvasId 统一取当前 URL（与原实现一致）。
 * project 守卫、加载态与译文写回（各节点字段不同）由调用方自持。
 */
export async function translateNodeText(
  project: string,
  params: { text: string; nodeId: string; nodeType: FreezoneTextTranslateNodeType },
): Promise<string> {
  const ref = await submitFreezoneTextTranslate(project, {
    text: params.text,
    nodeType: params.nodeType,
    canvasId: readUrl().canvas ?? 'default',
    nodeId: params.nodeId,
  });
  await awaitTaskCompletion(ref.task_key, project);
  const result = await fetchFreezoneTextTranslateResult(project, ref.job_id);
  return result.translated_text;
}
