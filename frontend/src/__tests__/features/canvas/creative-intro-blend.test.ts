import { describe, expect, it, vi } from 'vitest';

import {
  buildCreativeIntroBlendComposePayload,
  creativeIntroBlendStartBounds,
  normalizeCreativeIntroBlendRange,
  renderCreativeIntroBlendClip,
  resolveCreativeIntroBlendCapability,
} from '@/features/canvas/application/creativeIntroBlend';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'seedance-2.5',
    providerId: 'newapi',
    apiModel: 'seedance-2.5',
    label: 'Seedance 2.5',
    supportedModes: ['all_reference'],
    referenceImageMax: 9,
    referenceVideoMax: 3,
    minDuration: 4,
    maxDuration: 30,
    referenceVideoMinSeconds: 2,
    referenceVideoMaxSeconds: 30,
    referenceVideoTotalMinSeconds: 2,
    referenceVideoTotalMaxSeconds: 30,
    ...overrides,
  };
}

describe('creative intro source blend', () => {
  it('only selects a catalog model with explicit image, video, mode, and duration support', () => {
    const result = resolveCreativeIntroBlendCapability([
      model({ id: 'image-only', supportedModes: ['image_reference'], referenceVideoMax: 0 }),
      model(),
    ]);
    expect(result).toEqual({
      modelId: 'seedance-2.5',
      modelLabel: 'Seedance 2.5',
      genMode: 'allReference',
    });
    expect(resolveCreativeIntroBlendCapability([model({ supportedModes: undefined })])).toBeNull();
    expect(resolveCreativeIntroBlendCapability([model({ referenceImageMax: 0 })])).toBeNull();
    expect(resolveCreativeIntroBlendCapability([model({ maxDuration: 4 })])).toBeNull();
    expect(
      resolveCreativeIntroBlendCapability([model({ referenceVideoMaxSeconds: 4 })]),
    ).toBeNull();
  });

  it('keeps the keyframe inside an exact five-second range', () => {
    expect(creativeIntroBlendStartBounds(8, 12)).toEqual({ min: 3, max: 7 });
    expect(normalizeCreativeIntroBlendRange(20, 8, 12)).toEqual({
      startSec: 7,
      endSec: 12,
      keyframeOffsetSec: 1,
    });
    expect(normalizeCreativeIntroBlendRange(-5, 1.25, 12)).toEqual({
      startSec: 0,
      endSec: 5,
      keyframeOffsetSec: 1.25,
    });
    expect(normalizeCreativeIntroBlendRange(0, 1, 4.99)).toBeNull();
  });

  it('builds and completes one local five-second compose task', async () => {
    const range = { startSec: 2, endSec: 7, keyframeOffsetSec: 1.5 };
    const payload = buildCreativeIntroBlendComposePayload({
      sourceNodeId: 'video-1',
      sourceUrl: '/static/source.mp4',
      range,
      resolution: '720p',
      canvasId: 'canvas-1',
    });
    expect(payload).toMatchObject({
      canvasId: 'canvas-1',
      fps: 30,
      keepOriginalAudio: true,
      tracks: [
        {
          kind: 'video',
          items: [
            {
              sourceUrl: '/static/source.mp4',
              timelineStart: 0,
              sourceStart: 2,
              sourceEnd: 7,
            },
          ],
        },
      ],
    });

    const submit = vi.fn().mockResolvedValue({
      task_type: 'freezone_video_compose',
      task_key: 'task-1',
      job_id: 'job-1',
    });
    const awaitCompletion = vi.fn().mockResolvedValue({});
    const fetchResult = vi.fn().mockResolvedValue({
      url: '/static/creative-intro-clip.mp4',
      size: 123,
    });
    await expect(
      renderCreativeIntroBlendClip(
        { submit, awaitCompletion, fetchResult },
        {
          projectId: 'project-1',
          sourceNodeId: 'video-1',
          sourceUrl: '/static/source.mp4',
          range,
          resolution: '720p',
          canvasId: 'canvas-1',
        },
      ),
    ).resolves.toBe('/static/creative-intro-clip.mp4');
    expect(awaitCompletion).toHaveBeenCalledWith(
      'task-1',
      'project-1',
      'freezone_video_compose',
    );
    expect(fetchResult).toHaveBeenCalledWith(
      'project-1',
      'freezone_video_compose',
      'job-1',
    );
  });

  it('rejects a compose task that completes without a URL', async () => {
    await expect(
      renderCreativeIntroBlendClip(
        {
          submit: vi.fn().mockResolvedValue({
            task_type: 'freezone_video_compose',
            task_key: 'task-1',
            job_id: 'job-1',
          }),
          awaitCompletion: vi.fn().mockResolvedValue({}),
          fetchResult: vi.fn().mockResolvedValue({ url: '', size: 0 }),
        },
        {
          projectId: 'project-1',
          sourceNodeId: 'video-1',
          sourceUrl: '/static/source.mp4',
          range: { startSec: 0, endSec: 5, keyframeOffsetSec: 1 },
          resolution: '720p',
        },
      ),
    ).rejects.toThrow('without an output URL');
  });
});
