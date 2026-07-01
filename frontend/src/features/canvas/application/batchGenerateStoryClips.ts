import { useCanvasStore } from '@/stores/canvasStore';
import { readUrl } from '@/lib/url-params';
import {
  submitFreezoneVideoGen,
  fetchFreezoneJobResult,
  type FreezoneVideoResolution,
  type FreezoneVideoAspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { DEFAULT_VIDEO_MODEL_ID } from '@/features/canvas/ui/ProviderModelPicker';
import { collectMissingStoryClips, runWithConcurrency } from '@/features/canvas/story/batchClipPlan';

const CONCURRENCY = 3;

const VALID_ASPECTS = new Set<FreezoneVideoAspectRatio>([
  'auto', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9',
]);

export interface BatchGenOptions {
  resolution: FreezoneVideoResolution;
  durationSeconds: number;
}

export interface BatchGenSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** 无 project 上下文时为 true(未提交任何生成)。 */
  noProject?: boolean;
}

/**
 * 批量为某故事组的缺失片段生成视频:旁白作提示词,限并发 3,逐片段提交→await→回写
 * `videoUrl`。每片段进度复用节点自身的生成遮罩(经 `isGenerating`/任务句柄)。
 */
export async function batchGenerateStoryClips(
  groupId: string,
  opts: BatchGenOptions,
): Promise<BatchGenSummary> {
  const projectId = readUrl().project;
  const { generable, skipped } = collectMissingStoryClips(
    useCanvasStore.getState().nodes,
    groupId,
  );
  if (!projectId) {
    return { total: generable.length, succeeded: 0, failed: 0, skipped: skipped.length, noProject: true };
  }
  const canvasId = readUrl().canvas ?? 'default';
  const { updateNodeData } = useCanvasStore.getState();

  const results = await runWithConcurrency(generable, CONCURRENCY, async ({ id, prompt }) => {
    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
    });
    try {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
      const rawAspect = (node?.data as { aspectRatio?: string } | undefined)?.aspectRatio;
      const aspectRatio: FreezoneVideoAspectRatio =
        rawAspect && VALID_ASPECTS.has(rawAspect as FreezoneVideoAspectRatio)
          ? (rawAspect as FreezoneVideoAspectRatio)
          : '16:9';
      const ref = await submitFreezoneVideoGen(projectId, {
        prompt,
        aspectRatio,
        resolution: opts.resolution,
        durationSeconds: opts.durationSeconds,
        generateAudio: false,
        model: DEFAULT_VIDEO_MODEL_ID,
        genMode: 'textToVideo',
        canvasId,
        nodeId: id,
      });
      updateNodeData(id, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, projectId);
      const result = await fetchFreezoneJobResult(projectId, ref.task_type, ref.job_id);
      const url = result.url;
      if (!url) throw new Error('no result url');
      updateNodeData(id, {
        videoUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });
    } catch (error) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  const succeeded = results.filter((r) => r.status === 'fulfilled').length;
  return {
    total: generable.length,
    succeeded,
    failed: generable.length - succeeded,
    skipped: skipped.length,
  };
}
