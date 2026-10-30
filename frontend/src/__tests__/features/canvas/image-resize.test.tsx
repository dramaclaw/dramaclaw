// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

const { upload, load, readUrl } = vi.hoisted(() => ({ upload: vi.fn(), load: vi.fn(), readUrl: vi.fn() }));
vi.mock('@/api/ops', async (original) => ({ ...await original<object>(), uploadFreezoneImage: upload }));
vi.mock('@/features/canvas/application/imageData', async (original) => ({ ...await original<object>(), loadImageElement: load }));
vi.mock('@/lib/url-params', async (original) => ({ ...await original<object>(), readUrl }));

import { resizeImage, validResizeDimensions } from '@/features/canvas/application/imageResize';
import { ImageResizePanel } from '@/features/canvas/ui/ImageResizeDialog';

beforeEach(() => {
  vi.clearAllMocks();
  readUrl.mockReturnValue({ project: 'resize-test' });
  load.mockResolvedValue({ naturalWidth: 179, naturalHeight: 100 });
  upload.mockResolvedValue({ url: '/static/resized.png' });
  useCanvasStore.getState().setCanvasData([{
    id: 'source', type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 },
    data: { imageUrl: '/static/original.png', aspectRatio: '179:100' },
  } as CanvasNode], []);
});
afterEach(() => vi.restoreAllMocks());

describe('local image resizing', () => {
  it('resamples to target pixels, uploads once, preserves source and adds one linked result', async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
      expect([this.width, this.height]).toEqual([537, 300]);
      callback(new Blob(['PNG'], { type: 'image/png' }));
    });
    const source = structuredClone(useCanvasStore.getState().nodes[0]);
    const result = resizeImage('source', '/static/original.png', 537, 300, '已调整像素')!;
    await result.completion;
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 179, 100, 0, 0, 537, 300);
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0][0]).toBe('resize-test');
    const { nodes, edges } = useCanvasStore.getState();
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toEqual(source);
    expect(nodes[1].data).toMatchObject({ imageUrl: '/static/resized.png', imageNaturalWidth: 537,
      imageNaturalHeight: 300, aspectRatio: '537:300', isGenerating: false });
    expect(edges).toEqual([expect.objectContaining({ source: 'source', target: result.nodeId })]);
  });

  it.each([[0, 300], [-1, 300], [1.5, 300], [Infinity, 300], [16385, 300], [7000, 7000]])(
    'rejects unsafe target %s × %s without creating a result', (width, height) => {
      expect(validResizeDimensions(width, height)).toBe(false);
      expect(resizeImage('source', '/static/original.png', width, height, 'result')).toBeNull();
      expect(useCanvasStore.getState().nodes).toHaveLength(1);
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it('does not spawn when project is absent', () => {
    readUrl.mockReturnValue({ project: null });
    expect(resizeImage('source', '/static/original.png', 537, 300, 'result')).toBeNull();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it('records a processing failure without exposing the original as a successful result', async () => {
    load.mockRejectedValue(new Error('Image unavailable'));
    const result = resizeImage('source', '/static/original.png', 537, 300, 'result')!;
    await result.completion;
    const node = useCanvasStore.getState().nodes.find((item) => item.id === result.nodeId)!;
    expect(node.data).toMatchObject({ imageUrl: null, previewImageUrl: null,
      isGenerating: false, generationError: 'Image unavailable' });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('resize panel', () => {
  it('loads natural dimensions, locks the original ratio, permits unlocking and cancels without creating nodes', async () => {
    const close = vi.fn();
    render(<ImageResizePanel nodeId="source" imageSource="/static/original.png" onClose={close} />);
    await screen.findByText('原像素：179 × 100 像素');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '调整像素' })).toBeInTheDocument();
    const width = screen.getByLabelText('宽度（px）');
    const height = screen.getByLabelText('高度（px）');
    expect(screen.getByRole('button', { name: '调整' })).toBeDisabled();
    fireEvent.change(width, { target: { value: '537' } });
    expect(height).toHaveValue(300);
    expect(screen.getByRole('button', { name: '调整' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '锁定宽高比' }));
    fireEvent.change(height, { target: { value: '400' } });
    expect(width).toHaveValue(537);
    fireEvent.change(width, { target: { value: '16000' } });
    expect(screen.getByRole('button', { name: '调整' })).toBeEnabled();
    fireEvent.change(height, { target: { value: '16000' } });
    expect(screen.getByRole('button', { name: '调整' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(close).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows original-image loading failure and keeps submission disabled', async () => {
    load.mockRejectedValue(new Error('Load failed'));
    render(<ImageResizePanel nodeId="source" imageSource="/static/original.png" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法读取原图'));
    expect(screen.getByRole('button', { name: '调整' })).toBeDisabled();
  });
});
