// SPDX-License-Identifier: Elastic-2.0
import { apiCall } from '@/api/client';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { fetchFreezoneJobResult, type FreezoneJobRef } from '@/api/ops';
import {
  CLEARED_GENERATION_TASK_FIELDS,
  generationTaskDescriptor,
} from './resumeGeneration';
import { providerErrorMessage } from '@/lib/api-errors';
export type DerivedMediaKind = 'svg' | 'gif';
export async function completeDerivedMedia(
  project: string,
  initial: FreezoneJobRef,
  update: (patch: Record<string, unknown>) => void,
) {
  let ref = initial;
  for (let stage = 0; stage < 2; stage++) {
    const completed = await awaitTaskCompletion(ref.task_key, project, {
      taskType: ref.task_type,
    });
    let result: Record<string, unknown> = completed.result || {};
    if (ref.task_type === 'freezone_video_gen' && !result.gif_task_key) {
      const stored = await fetchFreezoneJobResult(
        project,
        ref.task_type,
        ref.job_id,
      ).catch(() => null);
      if (stored) result = { ...result, ...stored };
    }
    if (ref.task_type === 'freezone_video_gen') {
      update({
        sourceVideoUrl: result.output_url || result.video_url || result.url,
      });
      if (!result.gif_task_key || !result.gif_job_id)
        throw new Error('视频已生成，但 GIF 转换任务未创建，请重试转换');
      ref = {
        task_type: 'freezone_image_animate_gif',
        task_key: String(result.gif_task_key),
        job_id: String(result.gif_job_id),
      };
      update({
        ...generationTaskDescriptor(ref),
        generationStage: '正在转换 GIF',
      });
      continue;
    }
    const url =
      result.gif_url ||
      result.svg_url ||
      result.output_url ||
      result.url ||
      (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
    if (typeof url !== 'string' || !url) throw new Error('没有可用的输出文件');
    update({
      ...CLEARED_GENERATION_TASK_FIELDS,
      imageUrl: url,
      generationError: null,
      generationStage: null,
    });
    return;
  }
}
export async function generateDerivedMedia(
  project: string,
  nodeId: string,
  kind: DerivedMediaKind,
  imageUrl: string,
  videoUrl: string | undefined,
  canvasId: string | null,
  update: (patch: Record<string, unknown>) => void,
) {
  update({
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
    generationStage:
      kind === 'svg'
        ? '正在转换 SVG'
        : videoUrl
          ? '正在转换 GIF'
          : '正在生成视频',
  });
  try {
    const operation =
      kind === 'svg' ? 'vectorize' : videoUrl ? 'animate-gif' : 'animate';
    const ref = await apiCall<FreezoneJobRef>(
      `projects/${encodeURIComponent(project)}/freezone/image/${operation}`,
      {
        method: 'POST',
        json: {
          ...(videoUrl ? { video_url: videoUrl } : { image_url: imageUrl }),
          canvas_id: canvasId || 'default',
          node_id: nodeId,
        },
      },
    );
    update(generationTaskDescriptor(ref));
    await completeDerivedMedia(project, ref, update);
  } catch (error) {
    if (isTaskPollTimeoutError(error)) return;
    update({
      ...CLEARED_GENERATION_TASK_FIELDS,
      generationError:
        providerErrorMessage(
          error instanceof Error ? error.message : String(error),
        ) || '生成失败，请重试',
    });
  }
}
