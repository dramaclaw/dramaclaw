// SPDX-License-Identifier: Elastic-2.0
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getFreezoneCanvas, putFreezoneCanvas } from '@/api/canvas';
import { useCanvasSync } from '@/features/freezone/useCanvasSync';
import { useCanvasStore } from '@/stores/canvasStore';
import { useStoryboardMetadata } from '@/features/storyboard/storyboardStore';
import { useShotMetadataStore } from '@/features/freezone/shotMetadataStore';
vi.mock('@/api/canvas', async importOriginal => ({ ...await importOriginal<typeof import('@/api/canvas')>(), getFreezoneCanvas: vi.fn(), putFreezoneCanvas: vi.fn() }));
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ setViewport: vi.fn() }) }));
beforeEach(() => {
  localStorage.clear();
  vi.mocked(getFreezoneCanvas).mockReset();
  vi.mocked(putFreezoneCanvas).mockReset().mockResolvedValue({ saved: true, revision: 2 });
  useCanvasStore.getState().setCanvasData([], []);
  useShotMetadataStore.getState().hydrate({});
});
afterEach(cleanup);
it('hydrates board metadata and persists an ordering-only change with graph and other metadata intact', async () => {
  vi.mocked(getFreezoneCanvas).mockResolvedValue({ nodes: [], edges: [], revision: 1, viewport: { x: 12, y: 15, zoom: .4 }, metadata: { custom: 'retained', storyboardView: { version: 1, order: { image: ['old'] }, elementTags: { old: 'character' } } } } as unknown as Awaited<ReturnType<typeof getFreezoneCanvas>>);
  const { result } = renderHook(() => useCanvasSync('sb-project', 'sb-canvas'));
  await waitFor(() => expect(result.current.status).toBe('ready'));
  expect(useStoryboardMetadata.getState().metadata.order.image).toEqual(['old']);
  const nodes = useCanvasStore.getState().nodes;
  act(() => useStoryboardMetadata.getState().reorder('image', ['new', 'old']));
  await waitFor(() => expect(putFreezoneCanvas).toHaveBeenCalled(), { timeout: 4000 });
  const payload = vi.mocked(putFreezoneCanvas).mock.calls.slice(-1)[0]![2];
  expect(payload).toMatchObject({ nodes, edges: [], metadata: { custom: 'retained', storyboardView: { order: { image: ['new', 'old'] }, elementTags: { old: 'character' } } } });
});
