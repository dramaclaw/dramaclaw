// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { MultiAngleSubmitPayload } from '@/features/canvas/ui/MultiAngleEditorPanel';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneMultiView = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneMultiView,
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

import { multiAngleImage } from '@/features/canvas/application/imageMultiAngle';

const JOB_REF = { task_key: 'tk-mv', task_type: 'freezone_multi_view', job_id: 'job-mv' };

function payload(overrides: Partial<MultiAngleSubmitPayload> = {}): MultiAngleSubmitPayload {
  return {
    prompt: '',
    displayName: '多维度',
    preset: 'tilted',
    horizontalDeg: 200,
    verticalDeg: -30,
    zoom: 'medium',
    promptOverride: 'dutch angle',
    apiModel: 'gpt-image-2',
    providerId: 'huimeng',
    imageSize: '2K',
    ...overrides,
  };
}

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '3:4' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('imageMultiAngle application（多维度生成编排）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneMultiView.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('建结果节点并连边 → 提交（预设映射 + yaw 归一化）→ 回填 url', async () => {
    submitFreezoneMultiView.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/mv.png' } });

    const result = multiAngleImage('src-1', '/static/src.png?sig=x', payload());

    expect(result).not.toBeNull();
    const nodeId = result?.nodeId;
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: '多维度',
      aspectRatio: '3:4',
      resultKind: 'generic',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);

    await result?.completion;
    expect(submitFreezoneMultiView).toHaveBeenCalledWith('proj-1', {
      sourceUrl: '/static/src.png',
      // tilted → oblique（面板 key 到后端枚举的映射）。
      preset: 'oblique',
      // 200° 归一化到 [-180, 180)。
      yawDegrees: -160,
      pitchDegrees: -30,
      shotSize: 'medium',
      prompt: 'dutch angle',
      model: 'gpt-image-2',
      imageSize: '2K',
    });
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/mv.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('promptOverride 为 null → 提交空提示词', async () => {
    submitFreezoneMultiView.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: {} });
    fetchFreezoneJobResult.mockResolvedValue({ url: '/static/mv.png' });

    const result = multiAngleImage(
      'src-1',
      '/static/src.png',
      payload({ preset: 'custom', promptOverride: null, horizontalDeg: 0 }),
    );
    await result?.completion;

    expect(submitFreezoneMultiView.mock.calls[0][1]).toMatchObject({
      preset: 'custom',
      yawDegrees: 0,
      prompt: '',
    });
    // output_url 缺失 → 回退 job result。
    expect(fetchFreezoneJobResult).toHaveBeenCalledWith(
      'proj-1',
      'freezone_multi_view',
      'job-mv',
    );
  });

  it('缺 project → 返回 null，不建节点', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(multiAngleImage('src-1', '/static/src.png', payload())).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('提交失败 → 错误写回结果节点', async () => {
    submitFreezoneMultiView.mockRejectedValue(new Error('mv boom'));

    const result = multiAngleImage('src-1', '/static/src.png', payload());
    await result?.completion;

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === result?.nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'mv boom',
    });
  });
});
