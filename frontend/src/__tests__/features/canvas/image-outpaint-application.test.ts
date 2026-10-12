// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneOutpaint = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneOutpaint,
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

import { outpaintImage } from '@/features/canvas/application/imageOutpaint';

const JOB_REF = { task_key: 'tk-op', task_type: 'freezone_edit', job_id: 'job-op' };

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '1:1' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('imageOutpaint application（扩图提交编排）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneOutpaint.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('单图：建 isGenerating 结果节点并连边 → 提交（去 query 源 url）→ 回填 url', async () => {
    submitFreezoneOutpaint.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/op.png' } });

    const result = outpaintImage('src-1', '/static/src.png?sig=x', {
      displayName: '扩图',
      targetAspectRatio: '16:9',
      imageSize: '2K',
      numImages: 1,
      model: 'gpt-image-2',
    });

    expect(result).not.toBeNull();
    expect(result?.nodeIds).toHaveLength(1);
    const nodeId = result?.nodeIds[0];
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: '扩图',
      // target != original → 用目标比例。
      aspectRatio: '16:9',
      resultKind: 'generic',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);

    await result?.completion;
    expect(submitFreezoneOutpaint).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/src.png',
      targetAspectRatio: '16:9',
      numImages: 1,
      imageSize: '2K',
      model: 'gpt-image-2',
    });
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/op.png',
      previewImageUrl: '/static/op.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('original 比例：继承源节点 aspectRatio；N 张建 N 个节点各发一次单图请求', async () => {
    submitFreezoneOutpaint.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/op.png' });

    const result = outpaintImage('src-1', '/static/src.png', {
      displayName: '扩图',
      targetAspectRatio: 'original',
      imageSize: '2K',
      numImages: 3,
      model: 'gpt-image-2',
    });

    expect(result?.nodeIds).toHaveLength(3);
    const first = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeIds[0]);
    expect(first?.data).toMatchObject({ aspectRatio: '1:1' });

    await result?.completion;
    // 后端单次仅 1 张：N=3 发 3 次单图请求（num_images 恒为 1）。
    expect(submitFreezoneOutpaint).toHaveBeenCalledTimes(3);
    expect(submitFreezoneOutpaint.mock.calls[0][1]).toMatchObject({ numImages: 1 });
  });

  it('缺 project → 返回 null，不建节点', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(
      outpaintImage('src-1', '/static/src.png', {
        displayName: '扩图',
        targetAspectRatio: '1:1',
        imageSize: '2K',
        numImages: 1,
        model: 'gpt-image-2',
      }),
    ).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('单图失败 → 错误写回该结果节点', async () => {
    submitFreezoneOutpaint.mockRejectedValue(new Error('outpaint boom'));

    const result = outpaintImage('src-1', '/static/src.png', {
      displayName: '扩图',
      targetAspectRatio: '1:1',
      imageSize: '2K',
      numImages: 1,
      model: 'gpt-image-2',
    });
    await result?.completion;

    const failed = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeIds[0]);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'outpaint boom',
    });
  });
});
