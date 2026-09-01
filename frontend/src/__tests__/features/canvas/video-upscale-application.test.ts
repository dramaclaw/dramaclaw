// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneVideoUpscale = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneVideoUpscale,
  fetchFreezoneJobResult,
}));
vi.mock('@/api/tasks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  awaitTaskCompletion,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import {
  createVideoUpscaleResultNode,
  submitVideoUpscale,
} from '@/features/canvas/application/videoUpscale';

const JOB_REF = { task_key: 'tk-up', task_type: 'freezone_video_upscale', job_id: 'job-up' };

function seedVideoNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'vid-1',
      type: CANVAS_NODE_TYPES.video,
      position: { x: 0, y: 0 },
      data: {
        videoUrl: '/static/v.mp4',
        previewImageUrl: '/static/poster.png',
        aspectRatio: '9:16',
      },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('videoUpscale application（高清结果节点 + 提交编排）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneVideoUpscale.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedVideoNode();
  });

  it('createVideoUpscaleResultNode：建 isUpscaleNode 视频节点并连边（继承封面/画幅）', () => {
    const upscaleId = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4',
      displayName: '高清（2K）',
      resolution: '2k',
      denoise: '1x',
    });

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === upscaleId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.video);
    expect(created?.data).toMatchObject({
      displayName: '高清（2K）',
      videoUrl: null,
      previewImageUrl: '/static/poster.png',
      aspectRatio: '9:16',
      isUpscaleNode: true,
      upscaleSourceUrl: '/static/v.mp4',
      upscaleResolution: '2k',
      upscaleDenoise: '1x',
      isGenerating: false,
    });
    expect(
      state.edges.some((edge) => edge.source === 'vid-1' && edge.target === upscaleId),
    ).toBe(true);
  });

  it('submitVideoUpscale：置 isGenerating → 提交（去 query 源 url + canvas/node 上下文）→ 回填 videoUrl', async () => {
    const upscaleId = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4',
      displayName: '高清（1080P）',
      resolution: '1080p',
      denoise: 'none',
    }) as string;
    submitFreezoneVideoUpscale.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/v-hd.mp4' });

    await submitVideoUpscale(upscaleId, {
      sourceUrl: '/static/v.mp4?sig=abc',
      resolution: '1080p',
      denoise: 'none',
    });

    expect(submitFreezoneVideoUpscale).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/v.mp4',
      resolution: '1080p',
      frameInterpolation: 'none',
      denoiseStrength: 'none',
      canvasId: 'canvas-1',
      nodeId: upscaleId,
    });
    expect(awaitTaskCompletion).toHaveBeenCalledWith('tk-up', 'proj-1', {
      taskType: 'freezone_video_upscale',
    });
    expect(fetchFreezoneJobResult).toHaveBeenCalledWith(
      'proj-1',
      'freezone_video_upscale',
      'job-up',
    );
    const done = useCanvasStore.getState().nodes.find((node) => node.id === upscaleId);
    expect(done?.data).toMatchObject({
      videoUrl: '/static/v-hd.mp4',
      isGenerating: false,
      generationError: null,
    });
  });

  it('submitVideoUpscale 失败 → 错误写回节点', async () => {
    const upscaleId = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4',
      displayName: '高清（4K）',
      resolution: '4k',
      denoise: '2x',
    }) as string;
    submitFreezoneVideoUpscale.mockRejectedValue(new Error('backend down'));

    await submitVideoUpscale(upscaleId, {
      sourceUrl: '/static/v.mp4',
      resolution: '4k',
      denoise: '2x',
    });

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === upscaleId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'backend down',
    });
  });
});
