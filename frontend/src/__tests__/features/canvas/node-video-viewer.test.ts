// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import { nodeMediaViewerUrls, openNodeVideoViewer } from '@/features/canvas/application/nodeMediaViewer';
import { useCanvasStore } from '@/stores/canvasStore';

const fetchHistory = vi.hoisted(() => vi.fn());
vi.mock('@/api/ops', async original => ({ ...await original<typeof import('@/api/ops')>(), fetchNodeGenerationHistory: fetchHistory }));
vi.mock('@/lib/url-params', async original => ({ ...await original<typeof import('@/lib/url-params')>(), readUrl: () => ({ project: 'project', canvas: 'canvas' }) }));
const record = (url: string, media_type = 'video', status = 'completed') => ({
  schema_version: 1, canvas_id: 'canvas', node_id: 'video',
  id: url, task_type: 'video', task_key: 'video', job_id: url, recorded_at: '2026-10-08T00:00:00Z', result: { output_url: url }, media_type, status
}) satisfies FreezoneGenerationHistoryRecord;
beforeEach(() => { fetchHistory.mockReset(); useCanvasStore.getState().closeVideoViewer(); useCanvasStore.getState().closeImageViewer(); });

it('filters video history and keeps current/batch entries unique', () => {
  expect(nodeMediaViewerUrls('/static/current.mp4', ['/static/batch.mp4', '/static/current.mp4'], [record('/static/old.mp4'), record('/static/image.png', 'image'), record('/static/failed.mp4', 'video', 'failed')], 'video'))
    .toEqual(['/static/current.mp4', '/static/batch.mp4', '/static/old.mp4']);
});

it('shares details navigation without restoring the underlying node', async () => {
  fetchHistory.mockResolvedValue([record('/static/history.mp4')]);
  const nodes = useCanvasStore.getState().nodes;
  useCanvasStore.getState().openImageViewer('/static/current.png');
  await openNodeVideoViewer('/static/current.mp4', 'video');
  expect(useCanvasStore.getState().imageViewer.isOpen).toBe(false);
  useCanvasStore.getState().navigateVideoViewer('next');
  expect(useCanvasStore.getState().videoViewer.videoUrl).toBe('/static/history.mp4');
  expect(useCanvasStore.getState().nodes).toBe(nodes);
  useCanvasStore.getState().navigateVideoViewer('next');
  expect(useCanvasStore.getState().videoViewer.currentIndex).toBe(1);
});

it('ignores late history after the video details close', async () => {
  let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
  fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
  const pending = openNodeVideoViewer('/static/current.mp4', 'video');
  useCanvasStore.getState().closeVideoViewer();
  const closed = useCanvasStore.getState().videoViewer;
  resolve([record('/static/late.mp4')]);
  await pending;
  expect(useCanvasStore.getState().videoViewer).toBe(closed);
});


it('merges video history after navigating the local batch and keeps the current video', async () => {
  let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
  fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
  const pending = openNodeVideoViewer('/static/current.mp4', 'video', ['/static/batch.mp4']);
  useCanvasStore.getState().navigateVideoViewer('next');
  resolve([record('/static/history.mp4')]);
  await pending;
  expect(useCanvasStore.getState().videoViewer).toMatchObject({
    videoUrl: '/static/batch.mp4', currentIndex: 1,
    videoList: ['/static/current.mp4', '/static/batch.mp4', '/static/history.mp4']
  });
});

it('closing all media viewers invalidates pending history without changing canvas data', async () => {
  let resolve!: (records: FreezoneGenerationHistoryRecord[]) => void;
  fetchHistory.mockReturnValue(new Promise<FreezoneGenerationHistoryRecord[]>(done => { resolve = done; }));
  const nodes = useCanvasStore.getState().nodes;
  const pending = openNodeVideoViewer('/static/current.mp4', 'video');
  useCanvasStore.getState().closeMediaViewers();
  const closed = useCanvasStore.getState().videoViewer;
  resolve([record('/static/late.mp4')]);
  await pending;
  expect(useCanvasStore.getState().videoViewer).toBe(closed);
  expect(useCanvasStore.getState().nodes).toBe(nodes);
});
