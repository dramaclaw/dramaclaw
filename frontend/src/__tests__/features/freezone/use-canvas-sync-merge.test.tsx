// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { generateClientSaveId, getFreezoneCanvas, putFreezoneCanvas, type FreezoneCanvasPayload, type FreezoneCanvasSaveResult } from '@/api/canvas';
import { useCanvasStore, type CanvasNode } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasSync } from '@/features/freezone/useCanvasSync';
import { applyRemoteFreezoneCanvas, refreshRemoteFreezoneCanvas } from '@/features/freezone/canvasSyncRuntime';
import { useShotMetadataStore } from '@/features/freezone/shotMetadataStore';
import { readCanvasDraft, writeCanvasDraft } from '@/features/freezone/canvasDraftStorage';

vi.mock('@/api/canvas', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/canvas')>(),
  getFreezoneCanvas: vi.fn(), putFreezoneCanvas: vi.fn(),
}));
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({ setViewport: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const node = (id: string, label = 'base'): CanvasNode => ({
  id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 },
  data: { label, content: 'base' },
});
const state = () => useCanvasStore.getState();
const find = (id: string) => state().nodes.find(item => item.id === id);
const remote = (revision: number, nodes = [node('A'), node('B'), node('C')]): FreezoneCanvasPayload =>
  ({ revision, nodes, edges: [], metadata: null });
const patch = (revision: number, nodes: CanvasNode[], extra = {}) => ({
  type: 'canvas.patch', canvas_id: 'c', revision, base_revision: revision - 1,
  nodes, edges: [], deleted_node_ids: [], deleted_edge_ids: [], ...extra,
});
const conflict = (code = 'canvas_revision_conflict') => ({ status: 409, body: { detail: { code } } });
async function settle() {
  await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
}
async function tick(ms = 800) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
let seq = 0;
async function open(payload = remote(1)) {
  const project = `merge-test-${++seq}`;
  vi.mocked(getFreezoneCanvas).mockResolvedValueOnce(payload);
  const hook = renderHook(() => useCanvasSync(project, 'c'));
  await settle();
  expect(hook.result.current.status).toBe('ready');
  vi.mocked(getFreezoneCanvas).mockClear();
  return { hook, project };
}
type SyncHook = Awaited<ReturnType<typeof open>>['hook'];
async function push(hook: SyncHook, frame: unknown) {
  act(() => { expect(hook.result.current.applyPushFrame(frame)).toBe(true); });
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getFreezoneCanvas).mockReset();
  vi.mocked(putFreezoneCanvas).mockReset().mockResolvedValue({ saved: true, revision: 6 });
  vi.mocked(toast).mockClear();
  localStorage.clear();
  state().setCanvasData([], []);
  useShotMetadataStore.getState().hydrate({});
});
afterEach(() => { vi.useRealTimers(); });

describe('canvas sync merges', () => {
  it('merges fields while dragging and editing text without fetching', async () => {
    const { hook } = await open();
    act(() => {
      state().onNodesChange([{ id: 'A', type: 'position', position: { x: 40, y: 20 }, dragging: true }]);
      state().beginNodeFieldEdit('B', 'data.content');
      state().updateNodeData('B', { content: 'typing' });
    });
    await push(hook, patch(2, [
      { ...node('A', 'remote A'), position: { x: 90, y: 90 } },
      { ...node('B'), data: { label: 'base', content: 'remote text' } }, node('C', 'remote C'),
    ]));
    expect(find('A')?.position).toEqual({ x: 40, y: 20 });
    expect(find('A')?.data.label).toBe('remote A');
    expect(find('B')?.data.content).toBe('typing');
    expect(find('C')?.data.label).toBe('remote C');
    expect(getFreezoneCanvas).not.toHaveBeenCalled();
    expect(hook.result.current.revision).toBe(2);
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].base_revision).toBe(2);
    hook.unmount();
  });

  it('keeps deleted nodes deleted and only notifies for changes to that node', async () => {
    const { hook } = await open();
    act(() => state().onNodesChange([{ id: 'C', type: 'remove' }]));
    await push(hook, patch(2, [node('C', 'remote C')]));
    expect(find('C')).toBeUndefined();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('你删除的节点刚被别处（例如 Agent）修改过，已保持删除。');
    vi.mocked(toast).mockClear();
    await push(hook, patch(3, [node('B', 'remote B')]));
    expect(toast).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('keeps changed nodes deleted remotely and notifies once per kind', async () => {
    const { hook } = await open();
    act(() => {
      state().updateNodeData('B', { label: 'local B' });
      state().updateNodeData('C', { label: 'local C' });
    });
    await push(hook, patch(2, [], { deleted_node_ids: ['B', 'C'] }));
    expect(find('B')?.data.label).toBe('local B');
    expect(find('C')?.data.label).toBe('local C');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('你改过的节点已在别处被删除，已保留你的版本。');
    hook.unmount();
  });

  it('keeps a new local node on refresh and saves with the new revision once', async () => {
    const { hook, project } = await open();
    let localId = '';
    act(() => { localId = state().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 5, y: 6 }, { label: 'local' }); });
    vi.mocked(getFreezoneCanvas).mockResolvedValueOnce(remote(2));
    await act(async () => { expect(await refreshRemoteFreezoneCanvas(project, 'c')).toBe(true); });
    expect(find(localId)?.position).toEqual({ x: 5, y: 6 });
    expect(readCanvasDraft(project, 'c')?.baseRevision).toBe(2);
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2]).toMatchObject({
      base_revision: 2, nodes: expect.arrayContaining([expect.objectContaining({ id: localId })]),
    });
    hook.unmount();
  });

  it('replays undo and redo history and keeps it after the save resolves', async () => {
    const saved = deferred<FreezoneCanvasSaveResult>();
    vi.mocked(putFreezoneCanvas).mockReturnValueOnce(saved.promise);
    const { hook } = await open();
    act(() => state().onNodesChange([{ id: 'A', type: 'position', position: { x: 40, y: 0 } }]));
    await push(hook, patch(2, [node('B', 'remote B')]));
    act(() => { expect(state().undo()).toBe(true); });
    expect(find('A')?.position).toEqual({ x: 0, y: 0 });
    expect(find('B')?.data.label).toBe('remote B');
    act(() => state().redo());
    await tick(800);
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    saved.resolve({ saved: true, revision: 3 });
    await settle();
    act(() => state().undo());
    expect(find('A')?.position).toEqual({ x: 0, y: 0 });
    expect(find('B')?.data.label).toBe('remote B');
    act(() => state().redo());
    expect(find('A')?.position).toEqual({ x: 40, y: 0 });
    expect(find('B')?.data.label).toBe('remote B');
    hook.unmount();
  });

  it.each([false, true])('recovers a revision conflict once (retry fails: %s)', async failsAgain => {
    const { hook } = await open();
    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(conflict());
    if (failsAgain) vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(conflict());
    vi.mocked(getFreezoneCanvas).mockResolvedValueOnce(remote(5, [node('A'), node('B', 'remote B'), node('C')]));
    act(() => state().updateNodeData('A', { label: 'local A' }));
    await tick();
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(putFreezoneCanvas).mock.calls.map(call => call[2]);
    expect(second.base_revision).toBe(5);
    expect(second.client_save_id).not.toBe(first.client_save_id);
    expect(second.nodes).toEqual([
      expect.objectContaining({ id: 'A', data: expect.objectContaining({ label: 'local A' }) }),
      expect.objectContaining({ id: 'B', data: expect.objectContaining({ label: 'remote B' }) }),
      expect.objectContaining({ id: 'C' }),
    ]);
    expect(hook.result.current.status).toBe(failsAgain ? 'conflict' : 'ready');
    if (failsAgain) {
      expect(hook.result.current.error).toBe('画布已被其他窗口或用户修改');
      expect(hook.result.current.readConflictSnapshot()).toMatchObject({ canvas_id: 'c', nodes: second.nodes });
    }
    hook.unmount();
  });

  it('does not recover idempotency conflicts', async () => {
    const { hook } = await open();
    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(conflict('canvas_idempotency_conflict'));
    act(() => state().updateNodeData('A', { label: 'local' }));
    await tick();
    expect(getFreezoneCanvas).not.toHaveBeenCalled();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe('conflict');
    hook.unmount();
  });

  it('uses the existing conflict overlay if recovery fetch fails', async () => {
    const { hook } = await open();
    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(conflict());
    vi.mocked(getFreezoneCanvas).mockRejectedValueOnce(new Error('fetch failed'));
    act(() => state().updateNodeData('A', { label: 'local' }));
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toBe('conflict');
    expect(hook.result.current.readConflictSnapshot()?.canvas_id).toBe('c');
    hook.unmount();
  });

  it('ignores own and stale frames and rejects frames for another canvas', async () => {
    const { hook } = await open();
    await push(hook, patch(2, [node('A', 'own')], { client_save_id: generateClientSaveId() }));
    await push(hook, patch(1, [node('A', 'stale')]));
    expect(hook.result.current.applyPushFrame({ ...patch(2, []), canvas_id: 'other' })).toBe(false);
    expect(hook.result.current.applyPushFrame({ ...patch(2, []), revision: 2.5 })).toBe(false);
    expect(hook.result.current.applyPushFrame(null)).toBe(false);
    expect(find('A')?.data.label).toBe('base');
    expect(hook.result.current.revision).toBe(1);
    expect(getFreezoneCanvas).not.toHaveBeenCalled();
    hook.unmount();
  });

  it.each(['reset', 'mismatch', 'empty'])('fetches for a %s frame', async kind => {
    const { hook } = await open();
    vi.mocked(getFreezoneCanvas).mockResolvedValueOnce(remote(3, [node('A', 'fetched')]));
    await push(hook, kind === 'reset' ? { type: 'canvas.reset', canvas_id: 'c', revision: 3 }
      : patch(3, kind === 'empty' ? [] : [node('A')], { base_revision: kind === 'mismatch' ? 2 : 1 }));
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(find('A')?.data.label).toBe('fetched');
    expect(hook.result.current.revision).toBe(3);
    hook.unmount();
  });

  it('waits for the in-flight save before applying a frame', async () => {
    const { hook } = await open();
    const save = deferred<FreezoneCanvasSaveResult>();
    vi.mocked(putFreezoneCanvas).mockReturnValueOnce(save.promise);
    act(() => state().updateNodeData('A', { label: 'local A' }));
    await tick();
    await push(hook, patch(3, [node('B', 'remote B')]));
    expect(find('B')?.data.label).toBe('base');
    save.resolve({ saved: true, revision: 2 });
    await settle();
    expect(find('B')?.data.label).toBe('remote B');
    expect(find('A')?.data.label).toBe('local A');
    expect(hook.result.current.revision).toBe(3);
    expect(getFreezoneCanvas).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('does not save a remote-only change and preserves selection and tool dialog', async () => {
    const { hook } = await open();
    act(() => {
      state().setSelectedNode('A');
      state().openToolDialog({ nodeId: 'B', toolType: 'crop' });
    });
    await push(hook, patch(2, [node('B', 'remote B')]));
    expect(state().selectedNodeId).toBe('A');
    expect(state().activeToolDialog).toEqual({ nodeId: 'B', toolType: 'crop' });
    await tick(1600);
    expect(putFreezoneCanvas).not.toHaveBeenCalled();
    hook.unmount();
  });

  it('catches up once after frames arrive during hydration', async () => {
    const initial = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValueOnce(initial.promise).mockResolvedValueOnce(remote(5));
    const project = `early-${++seq}`;
    const hook = renderHook(() => useCanvasSync(project, 'c'));
    await push(hook, patch(3, [node('B', 'early')]));
    await push(hook, { type: 'canvas.reset', canvas_id: 'c', revision: 5 });
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    initial.resolve(remote(1));
    await settle();
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(2);
    expect(hook.result.current.revision).toBe(5);
    hook.unmount();
  });

  it('does not roll the revision or base back when an older PUT resolves after refresh', async () => {
    const { hook, project } = await open();
    const save = deferred<FreezoneCanvasSaveResult>();
    vi.mocked(putFreezoneCanvas).mockReturnValueOnce(save.promise);
    act(() => state().updateNodeData('A', { label: 'local A' }));
    await tick();
    act(() => { applyRemoteFreezoneCanvas(project, 'c', remote(5, [node('A', 'local A'), node('B', 'remote B'), node('C')])); });
    save.resolve({ saved: true, revision: 2 });
    await settle();
    expect(hook.result.current.revision).toBe(5);
    await push(hook, patch(6, [node('C', 'remote C')], { base_revision: 5 }));
    expect(find('B')?.data.label).toBe('remote B');
    expect(hook.result.current.revision).toBe(6);
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('keeps metadata and its store objects untouched for a patch', async () => {
    const metadata = {
      shotMetadata: { mood: 'base' },
      viewportBookmarks: [null, null, null, null, null, null, null, null, null, null],
      title: 'base title',
    };
    const { hook } = await open({ ...remote(1), metadata });
    const shot = useShotMetadataStore.getState().shot;
    const bookmarks = state().viewportBookmarks;
    await push(hook, patch(2, [node('B', 'remote B')]));
    expect(hook.result.current.metadata).toBe(metadata);
    expect(useShotMetadataStore.getState().shot).toBe(shot);
    expect(state().viewportBookmarks).toBe(bookmarks);
    await tick();
    expect(putFreezoneCanvas).not.toHaveBeenCalled();
    hook.unmount();
  });

  it.each([false, true])('merges metadata keys and hydrates only accepted sidecars (local shot: %s)', async localShot => {
    const bookmarks = [null, null, null, null, null, null, null, null, null, null];
    const { hook, project } = await open({
      ...remote(1), metadata: { shotMetadata: { mood: 'base' }, viewportBookmarks: bookmarks, title: 'base' },
    });
    if (localShot) act(() => useShotMetadataStore.getState().setShot({ mood: 'local' }));
    const shotBefore = useShotMetadataStore.getState().shot;
    const newBookmarks = [{ x: 10, y: 20, zoom: 2 }, null, null, null, null, null, null, null, null, null];
    act(() => {
      expect(applyRemoteFreezoneCanvas(project, 'c', {
        ...remote(2),
        metadata: { shotMetadata: { mood: 'remote' }, viewportBookmarks: newBookmarks, title: 'remote' },
      })).toBe(true);
    });
    expect(hook.result.current.metadata).toEqual({
      shotMetadata: { mood: localShot ? 'local' : 'remote' }, viewportBookmarks: newBookmarks, title: 'remote',
    });
    expect(useShotMetadataStore.getState().shot).toEqual({ mood: localShot ? 'local' : 'remote' });
    if (localShot) expect(useShotMetadataStore.getState().shot).toBe(shotBefore);
    expect(state().viewportBookmarks).toEqual([
      { x: 10, y: 20, zoom: 2 }, null, null, null, null, null, null, null, null, null,
    ]);
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(localShot ? 1 : 0);
    if (localShot) expect(vi.mocked(putFreezoneCanvas).mock.calls[0][2].metadata).toEqual({
      shotMetadata: { mood: 'local' }, viewportBookmarks: newBookmarks, title: 'remote',
    });
    hook.unmount();
  });

  it('uses the remote canvas as the base when hydrating a same-revision draft', async () => {
    const project = `merge-test-${seq + 1}`;
    writeCanvasDraft(project, 'c', {
      baseRevision: 1, nodes: [node('A'), node('B')], edges: [], metadata: null, viewport: null,
      history: { past: [], future: [] },
      mutation: { userEditsSinceHydrate: 1, lastMutationSource: 'user_edit', pendingClearIntent: false },
      updatedAt: Date.now(),
    });
    const { hook } = await open();
    expect(find('C')).toBeUndefined();
    await push(hook, patch(2, [node('C', 'remote C')]));
    expect(find('C')).toBeUndefined();
    expect(toast).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('replays history even when the current canvas already equals the remote change', async () => {
    const { hook } = await open();
    act(() => {
      state().onNodesChange([{ id: 'A', type: 'position', position: { x: 40, y: 0 } }]);
      state().updateNodeData('B', { label: 'remote B' });
    });
    await push(hook, patch(2, [node('B', 'remote B')]));
    act(() => state().undo());
    expect(find('B')?.data.label).toBe('remote B');
    expect(find('A')?.position).toEqual({ x: 40, y: 0 });
    act(() => state().undo());
    expect(find('B')?.data.label).toBe('remote B');
    expect(find('A')?.position).toEqual({ x: 0, y: 0 });
    hook.unmount();
  });

  it('serializes a reset fetch and a following patch', async () => {
    const { hook } = await open();
    const fetched = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValueOnce(fetched.promise);
    await push(hook, { type: 'canvas.reset', canvas_id: 'c', revision: 2 });
    await push(hook, patch(3, [node('C', 'remote C')]));
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.revision).toBe(1);
    fetched.resolve(remote(2, [node('A'), node('B', 'remote B'), node('C')]));
    await settle();
    expect(getFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(hook.result.current.revision).toBe(3);
    expect(find('B')?.data.label).toBe('remote B');
    expect(find('C')?.data.label).toBe('remote C');
    hook.unmount();
  });

  it('drops an in-flight push fetch after switching canvases', async () => {
    vi.mocked(getFreezoneCanvas).mockResolvedValueOnce(remote(1));
    const project = `switch-merge-${++seq}`;
    const hook = renderHook(({ canvasId }) => useCanvasSync(project, canvasId),
      { initialProps: { canvasId: 'c' } });
    await settle();
    const fetched = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValueOnce(fetched.promise).mockResolvedValueOnce(remote(8, [node('D')]));
    act(() => { hook.result.current.applyPushFrame({ type: 'canvas.reset', canvas_id: 'c', revision: 5 }); });
    await settle();
    hook.rerender({ canvasId: 'other' });
    await settle();
    fetched.resolve(remote(5));
    await settle();
    expect(hook.result.current.revision).toBe(8);
    expect(state().nodes.map(item => item.id)).toEqual(['D']);
    hook.unmount();
  });

  it('keeps a conflict overlay while applying subsequent remote changes', async () => {
    const { hook } = await open();
    vi.mocked(putFreezoneCanvas).mockRejectedValueOnce(conflict('canvas_idempotency_conflict'));
    act(() => state().updateNodeData('A', { label: 'local A' }));
    await tick();
    const message = hook.result.current.error;
    await push(hook, patch(2, [node('B', 'remote B')]));
    expect(hook.result.current.status).toBe('conflict');
    expect(hook.result.current.error).toBe(message);
    expect(find('B')?.data.label).toBe('remote B');
    await tick();
    expect(putFreezoneCanvas).toHaveBeenCalledTimes(1);
    hook.unmount();
  });

  it('continues processing frames after a failed fetch', async () => {
    const { hook } = await open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getFreezoneCanvas).mockRejectedValueOnce(new Error('fetch failed'));
    await push(hook, { type: 'canvas.reset', canvas_id: 'c', revision: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    await push(hook, patch(2, [node('B', 'remote B')]));
    expect(find('B')?.data.label).toBe('remote B');
    expect(hook.result.current.status).toBe('ready');
    warn.mockRestore();
    hook.unmount();
  });

});
