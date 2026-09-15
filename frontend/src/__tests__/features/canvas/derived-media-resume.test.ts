// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect, vi } from 'vitest';
vi.mock('@/api/tasks', () => ({
  listTasks: vi.fn().mockResolvedValue([{ task_key: 'child' }]),
  isTaskCancelledError: () => false,
  isTaskPollTimeoutError: () => false,
}));
vi.mock('@/features/canvas/application/derivedMedia', () => ({
  completeDerivedMedia: vi.fn().mockRejectedValue(new Error('GIF 转换失败')),
}));
vi.mock('@/features/canvas/application/errorDialog', () => ({
  resolveErrorContent: (e: Error) => ({ message: e.message }),
}));
vi.mock('@/lib/api-errors', () => ({ providerErrorMessage: (s: string) => s }));
import { resumeNodeGeneration } from '@/features/canvas/application/resumeGeneration';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
describe('derived media refresh failure', () => {
  it('keeps source video and displays conversion failure', async () => {
    const data: Record<string, unknown> = {
      imageUrl: null,
      aspectRatio: '16:9',
      sourceVideoUrl: '/source.mp4',
      isGenerating: true,
      generationTaskKey: 'child',
      generationTaskType: 'freezone_image_animate_gif',
      generationTaskJobId: 'c',
    };
    await resumeNodeGeneration({
      node: {
        id: 'n',
        type: 'animatedGifNode',
        position: { x: 0, y: 0 },
        data,
      } as CanvasNode,
      projectId: 'p',
      updateNodeData: (_, patch) => Object.assign(data, patch),
    });
    expect(data.sourceVideoUrl).toBe('/source.mp4');
    expect(data.generationError).toBe('GIF 转换失败');
    expect(data.isGenerating).toBe(false);
  });
});
