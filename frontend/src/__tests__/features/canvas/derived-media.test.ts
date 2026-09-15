// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  awaitTaskCompletion: vi.fn(),
  apiCall: vi.fn(),
}));
vi.mock('@/api/tasks', () => ({
  ...mocks,
  isTaskPollTimeoutError: () => false,
}));
vi.mock('@/api/client', () => ({ apiCall: mocks.apiCall }));
vi.mock('@/api/ops', () => ({
  fetchFreezoneJobResult: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/features/canvas/application/resumeGeneration', () => ({
  CLEARED_GENERATION_TASK_FIELDS: {
    isGenerating: false,
    generationTaskKey: null,
  },
  generationTaskDescriptor: (r: { task_key: string }) => ({
    generationTaskKey: r.task_key,
  }),
}));
vi.mock('@/lib/api-errors', () => ({ providerErrorMessage: (s: string) => s }));
import {
  completeDerivedMedia,
  generateDerivedMedia,
} from '@/features/canvas/application/derivedMedia';
describe('derived media task lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  it('persists child identity before waiting and finishes as GIF', async () => {
    mocks.awaitTaskCompletion
      .mockResolvedValueOnce({
        result: {
          output_url: '/video.mp4',
          gif_task_key: 'child',
          gif_job_id: 'c',
        },
      })
      .mockResolvedValueOnce({ result: { gif_url: '/image.gif' } });
    const update = vi.fn();
    await completeDerivedMedia(
      'p',
      { task_type: 'freezone_video_gen', task_key: 'parent', job_id: 'v' },
      update,
    );
    expect(update).toHaveBeenCalledWith({ sourceVideoUrl: '/video.mp4' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ generationTaskKey: 'child' }),
    );
    expect(mocks.awaitTaskCompletion).toHaveBeenNthCalledWith(2, 'child', 'p', {
      taskType: 'freezone_image_animate_gif',
    });
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ imageUrl: '/image.gif', isGenerating: false }),
    );
  });
  it('resumes directly from persisted child', async () => {
    mocks.awaitTaskCompletion.mockResolvedValueOnce({
      result: { gif_url: '/done.gif' },
    });
    const update = vi.fn();
    await completeDerivedMedia(
      'p',
      {
        task_type: 'freezone_image_animate_gif',
        task_key: 'child',
        job_id: 'c',
      },
      update,
    );
    expect(mocks.awaitTaskCompletion).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: '/done.gif' }),
    );
  });
  it('retry with existing video only submits conversion', async () => {
    mocks.apiCall.mockResolvedValue({
      task_type: 'freezone_image_animate_gif',
      task_key: 'c',
      job_id: 'c',
    });
    mocks.awaitTaskCompletion.mockResolvedValue({
      result: { gif_url: '/ok.gif' },
    });
    await generateDerivedMedia(
      'p',
      'n',
      'gif',
      '/source.png',
      '/video.mp4',
      'canvas',
      vi.fn(),
    );
    expect(mocks.apiCall).toHaveBeenCalledWith(
      'projects/p/freezone/image/animate-gif',
      expect.objectContaining({
        json: {
          video_url: '/video.mp4',
          canvas_id: 'canvas',
          node_id: 'n',
        },
      }),
    );
  });
  it('preserves generated video when child dispatch was unsuccessful', async () => {
    mocks.awaitTaskCompletion.mockResolvedValue({
      result: { output_url: '/video.mp4' },
    });
    const update = vi.fn();
    await expect(
      completeDerivedMedia(
        'p',
        { task_type: 'freezone_video_gen', task_key: 'p', job_id: 'p' },
        update,
      ),
    ).rejects.toThrow('转换任务未创建');
    expect(update).toHaveBeenCalledWith({ sourceVideoUrl: '/video.mp4' });
  });
});
