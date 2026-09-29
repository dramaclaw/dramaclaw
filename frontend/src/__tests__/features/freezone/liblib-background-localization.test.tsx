// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localizeLiblibCanvasAssets } from '@/api/canvas';
import { BackendStatusError } from '@/lib/api-errors';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { localizeLiblibCanvasInBackground } from '@/features/freezone/liblibBackgroundLocalization';
import { CanvasLocalizeAssetsButton } from '@/features/freezone/CanvasLocalizeAssetsButton';
import { flushFreezoneCanvasRuntime } from '@/features/freezone/canvasSyncRuntime';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('@/api/canvas', async (original) => ({
  ...await original<typeof import('@/api/canvas')>(), localizeLiblibCanvasAssets: vi.fn(),
}));
vi.mock('@/features/freezone/canvasSyncRuntime', () => ({ flushFreezoneCanvasRuntime: vi.fn(async () => true) }));

const url = (index: number) => `https://cdn.example/${index}.png`;
function nodes(count = 6): CanvasNode[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`, type: CANVAS_NODE_TYPES.imageGen, position: { x: index * 500, y: 0 },
    data: { imageUrl: url(index), prompt: 'original', liblibImport: { nodeKey: `n${index}`, sourceUrl: url(index) } },
  } as CanvasNode));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Reply = Awaited<ReturnType<typeof localizeLiblibCanvasAssets>>;
const reply = (urls: string[]): Reply => ({
  assetMap: Object.fromEntries(urls.map((source) => [source, `/static/projects/p/${source.split('/').pop()}`])),
  skippedMedia: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localizeLiblibCanvasAssets).mockReset();
  useCanvasStore.getState().setCanvasData(nodes(), []);
});
afterEach(cleanup);

it('saves each completed batch while retaining edits and deletions made during downloads', async () => {
  const first = deferred<Reply>();
  const second = deferred<Reply>();
  vi.mocked(localizeLiblibCanvasAssets).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const save = vi.fn(async () => {});
  const task = localizeLiblibCanvasInBackground({ project: 'p', sourceProjectId: 's', isActive: () => true, onProgress: vi.fn(), save });
  useCanvasStore.getState().updateNodeData('n0', { prompt: 'edited while downloading' });
  useCanvasStore.getState().updateNodeData('n1', { imageUrl: '/static/projects/p/replacement.png' });
  useCanvasStore.getState().setCanvasData(useCanvasStore.getState().nodes.filter((n) => n.id !== 'n2'), []);
  first.resolve(reply([url(0), url(1), url(2), url(3)]));
  await waitFor(() => expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenCalledTimes(1);
  expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n0')?.data).toMatchObject({
    prompt: 'edited while downloading', imageUrl: '/static/projects/p/0.png',
  });
  expect(useCanvasStore.getState().nodes.find((n) => n.id === 'n1')?.data.imageUrl).toBe('/static/projects/p/replacement.png');
  expect(useCanvasStore.getState().nodes.some((n) => n.id === 'n2')).toBe(false);
  second.resolve(reply([url(4), url(5)]));
  expect(await task).toMatchObject({ completed: 6, done: 6, failed: 0 });
  expect(save).toHaveBeenCalledTimes(2);
});

it('ignores a late response after switching canvas and does not start another batch', async () => {
  const request = deferred<Reply>();
  vi.mocked(localizeLiblibCanvasAssets).mockReturnValue(request.promise);
  let active = true;
  const save = vi.fn(async () => {});
  const task = localizeLiblibCanvasInBackground({ project: 'p', sourceProjectId: 's', isActive: () => active, onProgress: vi.fn(), save });
  active = false;
  useCanvasStore.getState().setCanvasData(nodes(1), []);
  request.resolve(reply([url(0)]));
  expect(await task).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe(url(0));
  expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(1);
});

it('keeps failed media remote, continues later batches and retries only remaining URLs', async () => {
  vi.mocked(localizeLiblibCanvasAssets).mockRejectedValueOnce(new Error('network'))
    .mockImplementation(async (_project, urls) => reply(urls));
  const options = { project: 'p', sourceProjectId: 's', isActive: () => true, onProgress: vi.fn(), save: vi.fn(async () => {}) };
  expect(await localizeLiblibCanvasInBackground(options)).toMatchObject({ done: 2, failed: 4 });
  const refs = (useCanvasStore.getState().nodes[0].data.liblibImport as { remoteMedia: { reason: string }[] }).remoteMedia;
  expect(refs[0].reason).toBe('liblib_media_unavailable');
  expect(await localizeLiblibCanvasInBackground(options)).toMatchObject({ total: 4, done: 4 });
  expect(localizeLiblibCanvasAssets).toHaveBeenLastCalledWith('p', [url(0), url(1), url(2), url(3)], 's');
});

it('waits for hydration, starts automatically once in StrictMode and saves progress', async () => {
  const request = deferred<Reply>();
  useCanvasStore.getState().setCanvasData(nodes(1), []);
  vi.mocked(localizeLiblibCanvasAssets).mockReturnValue(request.promise);
  const { rerender } = render(<StrictMode><CanvasLocalizeAssetsButton project="p" canvasId="c" sourceProjectId="s" autoStartKey="import-1" ready={false} /></StrictMode>);
  expect(localizeLiblibCanvasAssets).not.toHaveBeenCalled();
  rerender(<StrictMode><CanvasLocalizeAssetsButton project="p" canvasId="c" sourceProjectId="s" autoStartKey="import-1" ready /></StrictMode>);
  await waitFor(() => expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button')).toBeDisabled();
  await act(async () => { request.resolve(reply([url(0)])); });
  await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  expect(flushFreezoneCanvasRuntime).toHaveBeenCalledWith('p', 'c');
  expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(1);
});

it('stops when edit access is lost instead of marking every asset as a download failure', async () => {
  vi.mocked(localizeLiblibCanvasAssets).mockRejectedValue(new BackendStatusError('Forbidden', 403));
  const save = vi.fn(async () => {});
  await expect(localizeLiblibCanvasInBackground({
    project: 'p', sourceProjectId: 's', isActive: () => true, onProgress: vi.fn(), save,
  })).rejects.toThrow('Forbidden');
  expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(1);
  expect(save).not.toHaveBeenCalled();
});

it('stops applying results when the background control is unmounted', async () => {
  const request = deferred<Reply>();
  vi.mocked(localizeLiblibCanvasAssets).mockReturnValue(request.promise);
  const { unmount } = render(<CanvasLocalizeAssetsButton project="p" canvasId="c" sourceProjectId="s" autoStartKey="import-2" />);
  await waitFor(() => expect(localizeLiblibCanvasAssets).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => { request.resolve(reply([url(0)])); });
  expect(flushFreezoneCanvasRuntime).not.toHaveBeenCalled();
  expect(useCanvasStore.getState().nodes[0].data.imageUrl).toBe(url(0));
});
