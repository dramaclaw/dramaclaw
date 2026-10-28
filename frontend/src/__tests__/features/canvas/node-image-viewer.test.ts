// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import { nodeImageViewerUrls, openNodeImageViewer } from '@/features/canvas/application/nodeMediaViewer';
import { useCanvasStore } from '@/stores/canvasStore';

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock('@/api/ops', async (original) => ({ ...await original<typeof import('@/api/ops')>(), fetchNodeGenerationHistory: fetchHistory }));
vi.mock('@/lib/url-params', async (original) => ({ ...await original<typeof import('@/lib/url-params')>(), readUrl: () => ({ project: 'project', canvas: 'canvas' }) }));

const record = (url: string, status = 'completed', media = 'image', date = '2026-10-08T00:00:00Z') => ({
  schema_version: 1, canvas_id: 'canvas', node_id: 'node', task_type: 'image', task_key: 'image', job_id: url,
  id: url, status, media_type: media, recorded_at: date, result: { output_url: url },
}) satisfies FreezoneGenerationHistoryRecord;

beforeEach(() => { fetchHistory.mockReset(); useCanvasStore.getState().closeImageViewer(); });

describe('node image details', () => {
  it('deduplicates local outputs and successful image history without changing record order', () => {
    const records = [record('/static/older.png', 'succeeded', 'image', '2026-10-07T00:00:00Z'), record('/static/new.png'), record('/static/current.png'), record('/static/fail.png', 'failed'), record('/static/video.mp4', 'completed', 'video')];
    expect(nodeImageViewerUrls('/static/current.png', [null, '', '/static/batch.png', '/static/current.png'], records)).toEqual([
      '/static/current.png', '/static/batch.png', '/static/new.png', '/static/older.png',
    ]);
    expect(records[0].id).toBe('/static/older.png');
  });

  it('opens immediately, adds history, and switches pictures without modifying canvas nodes', async () => {
    fetchHistory.mockResolvedValue([record('/static/history.png')]);
    const nodes = useCanvasStore.getState().nodes;
    const pending = openNodeImageViewer('/static/current.png', 'node');
    expect(useCanvasStore.getState().imageViewer.currentImageUrl).toBe('/static/current.png');
    await pending;
    expect(fetchHistory).toHaveBeenCalledWith('project', 'canvas', 'node', 100);
    useCanvasStore.getState().selectImageViewer(1);
    expect(useCanvasStore.getState().imageViewer.currentImageUrl).toBe('/static/history.png');
    expect(useCanvasStore.getState().nodes).toBe(nodes);
    useCanvasStore.getState().selectImageViewer(99);
    expect(useCanvasStore.getState().imageViewer.currentIndex).toBe(1);
  });

  it.each(['close', 'another-node'])('ignores history arriving after %s', async (action) => {
    let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
    fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
    const pending = openNodeImageViewer('/static/current.png', 'node');
    if (action === 'close') useCanvasStore.getState().closeImageViewer();
    else await openNodeImageViewer('/static/other.png');
    const viewer = useCanvasStore.getState().imageViewer;
    resolve([record('/static/late.png')]);
    await pending;
    expect(useCanvasStore.getState().imageViewer).toBe(viewer);
  });

  it('keeps the current picture usable when the history request fails', async () => {
    fetchHistory.mockRejectedValue(new Error('offline'));
    await openNodeImageViewer('/static/current.png', 'node');
    expect(useCanvasStore.getState().imageViewer).toMatchObject({ isOpen: true, imageList: ['/static/current.png'] });
  });
});


it('merges late history after navigation without changing the selected image', async () => {
  let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
  fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
  const pending = openNodeImageViewer('/static/current.png', 'node', ['/static/batch.png']);
  useCanvasStore.getState().selectImageViewer(1);
  resolve([record('/static/history.png')]);
  await pending;
  expect(useCanvasStore.getState().imageViewer).toMatchObject({
    currentImageUrl: '/static/batch.png', currentIndex: 1,
    imageList: ['/static/current.png', '/static/batch.png', '/static/history.png']
  });
});

it('ignores a prior request when the same image opens in a new session', async () => {
  let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
  fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
  const pending = openNodeImageViewer('/static/current.png', 'node');
  useCanvasStore.getState().openImageViewer('/static/current.png', ['/static/current.png', '/static/new.png']);
  const viewer = useCanvasStore.getState().imageViewer;
  resolve([record('/static/old.png')]);
  await pending;
  expect(useCanvasStore.getState().imageViewer).toBe(viewer);
});

it('normalizes direct viewer entries and rejects empty sources without changing state', () => {
  useCanvasStore.getState().openImageViewer(' /static/current.png ', [' /static/other.png ', '/static/other.png']);
  expect(useCanvasStore.getState().imageViewer).toMatchObject({
    currentImageUrl: '/static/current.png', currentIndex: 0,
    imageList: ['/static/current.png', '/static/other.png']
  });
  const viewer = useCanvasStore.getState().imageViewer;
  useCanvasStore.getState().openImageViewer(' ');
  expect(useCanvasStore.getState().imageViewer).toBe(viewer);
});
