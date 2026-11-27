// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskPollTimeoutError } from '@/api/tasks';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const apiCall = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const notifyTaskStillRunning = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/errorDialog', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyTaskStillRunning,
}));
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<object>()), apiCall,
}));
vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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

import { createVideoUpscaleResultNode, submitVideoUpscale } from '@/features/canvas/application/videoUpscale';

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
    notifyTaskStillRunning.mockReset();
    apiCall.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedVideoNode();
  });

  it('createVideoUpscaleResultNode：建 isUpscaleNode 视频节点并连边（继承封面/画幅）', () => {
    const upscaleId = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4',
      displayName: '高清（2K）',
      resolution: '2k',
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
      upscaleEnhancementModel: 'topaz',
      upscaleModelPendingInitialization: true,
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
    }) as string;
    apiCall.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/v-hd.mp4' });

    await submitVideoUpscale(upscaleId, {
      sourceUrl: '/static/v.mp4?sig=abc',
      resolution: '1080p',
    });

    const json = { source_url: '/static/v.mp4', enhancement_model: 'topaz', resolution: '1080p', slowdown: 'auto',
      smart_interpolation: true, scene: 'realistic', face_enhance: false,
      canvas_id: 'canvas-1', node_id: upscaleId };
    expect(apiCall).toHaveBeenCalledWith('projects/proj-1/freezone/video/upscale', {
      method: 'POST', json,
    });
    expect(JSON.stringify(apiCall.mock.calls[0][1].json)).toBe(JSON.stringify(json));
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
      upscaleModelPendingInitialization: false,
    });
  });

  it('submitVideoUpscale 失败 → 错误写回节点', async () => {
    const upscaleId = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4',
      displayName: '高清（4K）',
      resolution: '4k',
    }) as string;
    apiCall.mockRejectedValue(new Error('backend down'));

    await submitVideoUpscale(upscaleId, {
      sourceUrl: '/static/v.mp4',
      resolution: '4k',
    });

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === upscaleId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'backend down',
    });
  });
});


describe('submitVideoUpscale reports its outcome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    apiCall.mockReset().mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockReset().mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockReset().mockResolvedValue({ url: '/static/v-hd.mp4' });
    seedVideoNode();
  });

  function createUpscale() {
    const id = createVideoUpscaleResultNode('vid-1', {
      sourceUrl: '/static/v.mp4', displayName: '高清（1080P）', resolution: '1080p',
    });
    if (!id) throw new Error('Expected upscale node');
    return id;
  }
  const options = { sourceUrl: '/static/v.mp4?sig=abc', resolution: '1080p' } as const;

  it('returns completed with the fallback URL', async () => {
    await expect(submitVideoUpscale(createUpscale(), options)).resolves.toStrictEqual({
      kind: 'completed', result: {}, fallbackUrl: '/static/v-hd.mp4',
    });
  });

  it('returns failed and preserves the raw node error', async () => {
    const id = createUpscale();
    awaitTaskCompletion.mockRejectedValue(new Error('raw upscale failure'));
    const outcome = await submitVideoUpscale(id, options);
    expect(useCanvasStore.getState().nodes.find(node => node.id === id)?.data)
      .toMatchObject({ generationError: 'raw upscale failure' });
    expect(outcome).toStrictEqual({ kind: 'failed', message: 'raw upscale failure' });
  });

  it('returns poll_timeout and leaves the node running', async () => {
    const id = createUpscale();
    awaitTaskCompletion.mockRejectedValue(new TaskPollTimeoutError('tk-up', 1000));
    const outcome = await submitVideoUpscale(id, options);
    expect(notifyTaskStillRunning).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().nodes.find(node => node.id === id)?.data)
      .toMatchObject({ isGenerating: true, generationError: null });
    expect(outcome).toStrictEqual({ kind: 'poll_timeout' });
  });

  it('returns failed when the fallback fetch fails', async () => {
    fetchFreezoneJobResult.mockRejectedValue(new Error('fallback failed'));
    await expect(submitVideoUpscale(createUpscale(), options)).resolves.toStrictEqual({
      kind: 'failed', message: 'fallback failed',
    });
  });

  it('refuses without a project and leaves node data unchanged', async () => {
    const id = createUpscale();
    const before = structuredClone(useCanvasStore.getState().nodes);
    readUrl.mockReturnValue({ project: '', canvas: 'canvas-1' });
    const outcome = await submitVideoUpscale(id, options);
    expect(apiCall).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes).toStrictEqual(before);
    expect(outcome).toStrictEqual({ kind: 'refused', message: 'A project is required.' });
  });
});
