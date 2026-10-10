// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const uploadFreezoneImage = vi.hoisted(() => vi.fn());
const loadImageElement = vi.hoisted(() => vi.fn());
const readUrl = vi.hoisted(() => vi.fn());

vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  uploadFreezoneImage,
}));
vi.mock('@/features/canvas/application/imageData', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadImageElement,
}));
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readUrl,
}));

import {
  createRotateResultNode,
  discardRotateResultNode,
  isIdentityRotateTransform,
  rotateImageInPlace,
} from '@/features/canvas/application/imageRotate';

function seedSourceNode() {
  const nodes: CanvasNode[] = [
    {
      id: 'src-1',
      type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 },
      data: { imageUrl: '/static/src.png', aspectRatio: '4:3' },
    } as CanvasNode,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

// jsdom 的 <canvas> 无 2D 上下文；stub 一个最简 ctx + toBlob。
function stubCanvas() {
  const ctx = {
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    callback(new Blob(['png']));
  });
}

describe('imageRotate application（预建/取消 + 原地旋转写回）', () => {
  beforeEach(() => {
    readUrl.mockReturnValue({ project: 'proj-1', canvas: 'canvas-1' });
    uploadFreezoneImage.mockReset();
    loadImageElement.mockReset();
    seedSourceNode();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('isIdentityRotateTransform：角度 0 且无镜像视为无变换', () => {
    expect(isIdentityRotateTransform({ angleDeg: 0, mirrorH: false, mirrorV: false })).toBe(true);
    expect(isIdentityRotateTransform({ angleDeg: 90, mirrorH: false, mirrorV: false })).toBe(false);
    expect(isIdentityRotateTransform({ angleDeg: 0, mirrorH: true, mirrorV: false })).toBe(false);
  });

  it('createRotateResultNode：以源图为预览建 exportImage 并连边（不置 isGenerating）', () => {
    const nodeId = createRotateResultNode('src-1', { displayName: '旋转结果' });

    const state = useCanvasStore.getState();
    const created = state.nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data).toMatchObject({
      displayName: '旋转结果',
      previewImageUrl: '/static/src.png',
      aspectRatio: '4:3',
      resultKind: 'generic',
      isGenerating: false,
    });
    expect(
      state.edges.some((edge) => edge.source === 'src-1' && edge.target === nodeId),
    ).toBe(true);
  });

  it('createRotateResultNode：支持只有 referenceImageUrl 的 imageGen 节点', () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'src-ref',
          type: CANVAS_NODE_TYPES.imageGen,
          position: { x: 0, y: 0 },
          data: { referenceImageUrl: '/static/reference.png', aspectRatio: '1:1' },
        } as CanvasNode,
      ],
      [],
    );

    const nodeId = createRotateResultNode('src-ref', { displayName: '旋转结果' });

    const created = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(created?.type).toBe(CANVAS_NODE_TYPES.exportImage);
    expect(created?.data.previewImageUrl).toBe('/static/reference.png');
  });

  it('discardRotateResultNode：删掉预建节点（取消/退出路径）', () => {
    const nodeId = createRotateResultNode('src-1', { displayName: '旋转结果' }) as string;
    discardRotateResultNode(nodeId);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)).toBeUndefined();
  });

  it('rotateImageInPlace：本地 canvas 旋转 → 上传 → 原地写回 url 与新 aspectRatio', async () => {
    stubCanvas();
    loadImageElement.mockResolvedValue({ naturalWidth: 100, naturalHeight: 50 });
    uploadFreezoneImage.mockResolvedValue({ url: '/static/rotated.png' });
    const nodeId = createRotateResultNode('src-1', { displayName: '旋转结果' }) as string;

    await rotateImageInPlace(nodeId, '/static/src.png', {
      angleDeg: 90,
      mirrorH: false,
      mirrorV: false,
    });

    expect(loadImageElement).toHaveBeenCalledWith('/static/src.png');
    expect(uploadFreezoneImage).toHaveBeenCalledTimes(1);
    expect(uploadFreezoneImage.mock.calls[0][0]).toBe('proj-1');
    const done = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    // 90° 旋转后画布交换宽高 → 50x100。
    expect(done?.data).toMatchObject({
      imageUrl: '/static/rotated.png',
      previewImageUrl: '/static/rotated.png',
      aspectRatio: '50:100',
      isGenerating: false,
      generationError: null,
    });
  });

  it('rotateImageInPlace：缺 project → 返回 null，不上传', () => {
    readUrl.mockReturnValue({ project: null, canvas: null });
    const nodeId = createRotateResultNode('src-1', { displayName: '旋转结果' }) as string;
    expect(
      rotateImageInPlace(nodeId, '/static/src.png', {
        angleDeg: 90,
        mirrorH: false,
        mirrorV: false,
      }),
    ).toBeNull();
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });

  it('rotateImageInPlace 失败 → 错误写回节点', async () => {
    stubCanvas();
    loadImageElement.mockRejectedValue(new Error('load boom'));
    const nodeId = createRotateResultNode('src-1', { displayName: '旋转结果' }) as string;

    await rotateImageInPlace(nodeId, '/static/src.png', {
      angleDeg: 90,
      mirrorH: false,
      mirrorV: false,
    });

    const failed = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(failed?.data).toMatchObject({
      isGenerating: false,
      generationError: 'load boom',
      generationErrorDetails: 'load boom',
    });
    expect(uploadFreezoneImage).not.toHaveBeenCalled();
  });
});
