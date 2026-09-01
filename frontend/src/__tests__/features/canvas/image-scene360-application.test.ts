// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const submitFreezoneScene360 = vi.hoisted(() => vi.fn());
const fetchFreezoneJobResult = vi.hoisted(() => vi.fn());
const awaitTaskCompletion = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitFreezoneScene360,
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

import { scene360Image } from '@/features/canvas/application/imageScene360';

const JOB_REF = { task_key: 'tk-360', task_type: 'freezone_scene_360', job_id: 'job-360' };

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '16:9' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

describe('imageScene360 application（全景生成编排）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    submitFreezoneScene360.mockReset();
    fetchFreezoneJobResult.mockReset();
    awaitTaskCompletion.mockReset();
    seedSourceNode();
  });

  it('建全景候选节点并连边 → 提交 → 回填 url + 建 pano360 查看器节点', async () => {
    submitFreezoneScene360.mockResolvedValue(JOB_REF);
    awaitTaskCompletion.mockResolvedValue({ result: { output_url: '/static/pano.png' } });

    const result = scene360Image('src-1', '/static/src.png?sig=x', {
      displayName: '360°全景图',
      aspectRatio: '2:1',
    });

    expect(result).not.toBeNull();
    const nodeId = result?.nodeId;
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: '360°全景图',
      aspectRatio: '2:1',
      output_role: 'scene_360_candidate',
      media_kind: 'pano360',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);

    await result?.completion;
    expect(submitFreezoneScene360).toHaveBeenCalledWith('proj-1', {
      referenceUrl: '/static/src.png',
      aspectRatio: '2:1',
    });
    const done = useCanvasStore.getState();
    const candidate = done.nodes.find((node) => node.id === nodeId);
    expect(candidate?.data).toMatchObject({
      imageUrl: '/static/pano.png',
      isGenerating: false,
      generationError: null,
    });
    // 候选节点下游建了一个 pano360Viewer 并连边。
    const viewer = done.nodes.find(
      (node) => node.type === CANVAS_NODE_TYPES.pano360Viewer,
    );
    expect(viewer).toBeDefined();
    expect(
      done.edges.some((edge) => edge.source === nodeId && edge.target === viewer?.id),
    ).toBe(true);
  });

  it('缺 project → 返回 null，不建节点', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(
      scene360Image('src-1', '/static/src.png', {
        displayName: '360°全景图',
        aspectRatio: '2:1',
      }),
    ).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });

  it('提交失败 → 错误写回候选节点，不建查看器', async () => {
    submitFreezoneScene360.mockRejectedValue(new Error('pano boom'));

    const result = scene360Image('src-1', '/static/src.png', {
      displayName: '360°全景图',
      aspectRatio: '21:9',
    });
    await result?.completion;

    const state = useCanvasStore.getState();
    const failed = state.nodes.find((node) => node.id === result?.nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'pano boom',
    });
    expect(
      state.nodes.some((node) => node.type === CANVAS_NODE_TYPES.pano360Viewer),
    ).toBe(false);
  });
});
