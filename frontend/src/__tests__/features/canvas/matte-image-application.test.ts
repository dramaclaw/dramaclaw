// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const matteInWorker = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadFreezoneImage,
}));
vi.mock('@/features/canvas/application/matteClient', () => ({
  matteInWorker,
  preloadMatteWorker: vi.fn(),
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import { matteImage } from '@/features/canvas/application/matteImage';

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

describe('matteImage（抠图编排，从 NodeActionToolbar 抽出）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    uploadFreezoneImage.mockReset();
    matteInWorker.mockReset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['src']) })),
    );
    seedSourceNode();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同步建 isGenerating 的 exportImage 结果节点并连边/选中，完成后回填 url', async () => {
    matteInWorker.mockResolvedValue(new Blob(['matted']));
    uploadFreezoneImage.mockResolvedValue({ url: '/static/matted.png' });

    const result = matteImage('src-1', '/static/src.png', { displayName: '抠图' });

    expect(result).not.toBeNull();
    const resultId = result?.nodeId;
    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === resultId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: '抠图',
      aspectRatio: '16:9',
      resultKind: 'matte',
      isGenerating: true,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === resultId),
    ).toBe(true);
    expect(state.selectedNodeId).toBe(resultId);
    expect(state.pendingFocusNodeId).toBe(resultId);

    // completion 在后台链（fetch → worker → 上传 → 回填）settle 后 resolve。
    await result?.completion;
    // 调用序：fetch 源图 → worker 去背 → 上传 → 回填。
    expect(matteInWorker).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe('proj-1');
    const done = useCanvasStore.getState().nodes.find((node) => node.id === resultId);
    expect(done?.data).toMatchObject({
      imageUrl: '/static/matted.png',
      previewImageUrl: '/static/matted.png',
      isGenerating: false,
      generationError: null,
    });
  });

  it('去背失败 → 把错误写到结果节点并清 isGenerating', async () => {
    matteInWorker.mockRejectedValue(new Error('worker boom'));

    const result = matteImage('src-1', '/static/src.png');
    await result?.completion;

    const failed = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === result?.nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'worker boom',
      generationErrorDetails: 'worker boom',
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('缺 project → 不建节点直接返回 null', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const before = useCanvasStore.getState().nodes.length;
    expect(matteImage('src-1', '/static/src.png')).toBeNull();
    expect(useCanvasStore.getState().nodes.length).toBe(before);
  });
});
