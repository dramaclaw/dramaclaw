// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneVideoErase,
  type FreezoneJobResult,
  type FreezoneVideoErasePayload,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';

/**
 * 视频去字幕提交核心（从 VideoNode.handleEraseSubmit 原样抽出，语义零变化）：
 * 提交 /freezone/video/erase → 等任务完成 → 取 job result（产物 url 在 result.url）。
 * UI 状态（isErasing、subtitleEraseMode 清理、videoUrl 回写）由调用方自持——
 * 工作流节点的去字幕面板与故事板详情的「智能去字幕」共用这一条提交路径。
 */
export async function runVideoSubtitleErase(
  project: string,
  payload: FreezoneVideoErasePayload,
): Promise<FreezoneJobResult> {
  const ref = await submitFreezoneVideoErase(project, payload);
  await awaitTaskCompletion(ref.task_key, project);
  return await fetchFreezoneJobResult(project, 'freezone_video_erase', ref.job_id);
}
