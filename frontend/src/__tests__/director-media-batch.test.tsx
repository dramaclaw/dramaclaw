// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DirectorMediaPanel } from '@/features/director/components/DirectorMediaPanel';
import { DirectorMediaNodes } from '@/features/director/components/DirectorMediaNodes';
import * as api from '@/api/director';
import { fetchFreezoneImageModels, fetchFreezoneJobResult } from '@/api/ops';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/director', () => ({ listDirectorBatches: vi.fn(), prepareDirectorBatch: vi.fn(), approveDirectorBatch: vi.fn(), cancelDirectorBatch: vi.fn(), moveDirectorMediaNode: vi.fn(), listDirectorMedia: vi.fn(), getDirectorMediaSource: vi.fn(), prepareDirectorMedia: vi.fn(), confirmDirectorMedia: vi.fn() }));
vi.mock('@/api/ops', () => ({ fetchFreezoneImageModels: vi.fn(), fetchFreezoneJobResult: vi.fn() }));
vi.mock('@/api/tasks', () => ({ listTasks: vi.fn().mockResolvedValue([]) }));
const batch: api.DirectorMediaBatch = { id: 'batch', status: 'planned', selectedIds: [], nodes: ['Corridor', 'Courtyard', 'Screen room'].map((name, index) => ({
  id: `image-${index}`, batch_id: 'batch', ordinal: index, x: 720 + index * 292, y: 80, version: 1,
  intent: { id: `image-${index}`, workId: 'work', status: 'prepared', createdAt: 1, request: { batchId: 'batch', modelLabel: 'Image One', source: { kind: 'scenes', documentVersion: 1, asset: { id: String(index), name, text: `${name} source` } }, actual: { prompt: `${name} source`, aspect_ratio: '16:9', image_size: '1K' } }, result: {} },
})) };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDirectorBatches).mockResolvedValue([]);
  vi.mocked(api.listDirectorMedia).mockResolvedValue([]);
  vi.mocked(api.getDirectorMediaSource).mockResolvedValue({ kind: 'scenes', workRevision: 3, documentVersion: 1, style: 'Watercolor', assets: batch.nodes.map(n => n.intent.request.source.asset) });
  vi.mocked(fetchFreezoneImageModels).mockResolvedValue([{ id: 'image-one', label: 'Image One', providerId: 'openai', apiModel: 'actual', ratioOptions: ['16:9'], resolutionOptions: ['1K'], qualityOptions: ['high'] }]);
  vi.mocked(api.prepareDirectorBatch).mockResolvedValue(batch);
  vi.mocked(api.approveDirectorBatch).mockResolvedValue({ ...batch, status: 'approved' });
  vi.mocked(api.cancelDirectorBatch).mockResolvedValue({ ...batch, status: 'cancelled' });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<DirectorMediaPanel project="test" workId="work" kind="scenes" onKind={vi.fn()} onClose={vi.fn()} />);
it('automatically rosters all assets, lets prompts change, and freezes selected images explicitly', async () => {
  mount();
  await screen.findByRole('button', { name: 'director.media.batch.prepare' });
  const prompts = screen.getAllByLabelText('director.media.promptLabel');
  fireEvent.change(prompts[1], { target: { value: 'Only this courtyard; no people.' } });
  expect(api.prepareDirectorBatch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'director.media.batch.prepare' }));
  await screen.findByText('director.media.batch.approval');
  expect(api.prepareDirectorBatch).toHaveBeenCalledWith('test', 'work', expect.objectContaining({ document_version: 1, work_revision: 3, model_id: 'image-one', aspect_ratio: '16:9', image_size: '1K', quality: 'high', prompts: expect.objectContaining({ '1': 'Only this courtyard; no people.' }) }));
  expect(screen.getByRole('button', { name: 'director.media.batch.confirm' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('2. Courtyard'));
  fireEvent.click(screen.getByLabelText('director.media.acknowledge'));
  fireEvent.click(screen.getByRole('button', { name: 'director.media.batch.confirm' }));
  await waitFor(() => expect(api.approveDirectorBatch).toHaveBeenCalledWith('test', 'work', 'batch', ['image-0', 'image-2']));
  expect(api.confirmDirectorMedia).not.toHaveBeenCalled();
});
it('cancellation records the batch ID without sending any generation', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'director.media.batch.prepare' }));
  fireEvent.click(await screen.findByRole('button', { name: 'director.media.batch.cancel' }));
  await waitFor(() => expect(api.cancelDirectorBatch).toHaveBeenCalledWith('test', 'work', 'batch'));
  expect(api.approveDirectorBatch).not.toHaveBeenCalled();
});
it('lost approval response retains the same batch and selection on explicit retry', async () => {
  vi.mocked(api.approveDirectorBatch).mockRejectedValueOnce(new Error('lost response'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'director.media.batch.prepare' }));
  fireEvent.click(await screen.findByLabelText('director.media.acknowledge'));
  fireEvent.click(screen.getByRole('button', { name: 'director.media.batch.confirm' }));
  await screen.findByRole('alert');
  expect(api.approveDirectorBatch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'director.media.batch.confirm' }));
  await waitFor(() => expect(api.approveDirectorBatch).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.approveDirectorBatch).mock.calls[0]).toEqual(vi.mocked(api.approveDirectorBatch).mock.calls[1]);
});
it('canvas restores persistent nodes and old completed results without an open panel or another purchase', async () => {
  const restored = structuredClone(batch);
  restored.nodes[1].x = 480;
  restored.nodes[1].intent.status = 'accepted';
  restored.nodes[1].intent.result = { job_id: 'old-result', task_key: 'old-task' };
  vi.mocked(api.listDirectorBatches).mockResolvedValue([restored]);
  vi.mocked(fetchFreezoneJobResult).mockResolvedValue({ url: '/api/v1/test.png', size: 1 });
  render(<DirectorMediaNodes project="test" work="work" onPlan={vi.fn()} />);
  const image = await screen.findByRole('img', { name: 'Courtyard' });
  expect(image).toHaveAttribute('src', '/api/v1/test.png');
  expect(image.closest('article')).toHaveStyle({ left: '480px' });
  expect(image.closest('button')).toHaveStyle({ aspectRatio: '16 / 9' });
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(api.approveDirectorBatch).not.toHaveBeenCalled();
});
it('a second drag before polling saves from the acknowledged position and version, even back to the original point', async () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.mocked(api.listDirectorBatches).mockResolvedValue([batch]);
  vi.mocked(api.moveDirectorMediaNode).mockImplementation(async (_project, _work, node, x, y) => ({ ...node, x, y, version: node.version + 1 }));
  render(<DirectorMediaNodes project="test" work="work" onPlan={vi.fn()} />);
  const article = await screen.findByRole('article', { name: 'Corridor' });
  const handle = article.querySelector('header')!;
  handle.setPointerCapture = vi.fn();
  fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(handle, { clientX: 150, clientY: 120 });
  fireEvent.pointerUp(handle, { clientX: 150, clientY: 120 });
  await waitFor(() => expect(article).toHaveStyle({ left: '770px', top: '100px' }));
  await waitFor(() => expect(api.moveDirectorMediaNode).toHaveBeenCalledTimes(1));
  fireEvent.pointerDown(handle, { button: 0, clientX: 150, clientY: 120 });
  fireEvent.pointerMove(handle, { clientX: 100, clientY: 100 });
  fireEvent.pointerUp(handle, { clientX: 100, clientY: 100 });
  await waitFor(() => expect(api.moveDirectorMediaNode).toHaveBeenCalledTimes(2));
  expect(api.moveDirectorMediaNode).toHaveBeenLastCalledWith('test', 'work', expect.objectContaining({ x: 770, y: 100, version: 2 }), 720, 80);
});
