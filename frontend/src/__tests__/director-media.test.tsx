// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectorMediaPanel } from '@/features/director/components/DirectorMediaPanel';
import { confirmDirectorMedia, getDirectorMediaSource, listDirectorMedia, prepareDirectorMedia, type DirectorMediaIntent } from '@/api/director';
import { fetchFreezoneImageModels, fetchFreezoneJobResult } from '@/api/ops';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/director', () => ({ listDirectorBatches: vi.fn().mockResolvedValue([]), confirmDirectorMedia: vi.fn(), getDirectorMediaSource: vi.fn(), listDirectorMedia: vi.fn(), prepareDirectorMedia: vi.fn() }));
vi.mock('@/api/ops', () => ({ fetchFreezoneImageModels: vi.fn(), fetchFreezoneJobResult: vi.fn() }));
vi.mock('@/api/tasks', () => ({ listTasks: vi.fn().mockResolvedValue([]) }));
const prepared: DirectorMediaIntent = { id: 'intent-one', workId: 'work-one', status: 'prepared', createdAt: 1,
  request: { source: { kind: 'scenes', documentVersion: 2, asset: { id: '1', name: 'Courtyard', text: 'Exterior.' } }, modelLabel: 'Image One', actual: { prompt: 'Actual prompt', model: 'image-one' } }, result: {} };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getDirectorMediaSource).mockResolvedValue({ kind: 'scenes', workRevision: 7, documentVersion: 2, style: 'Watercolor', assets: [{ id: '0', name: 'Corridor', text: 'Interior.' }, { id: '1', name: 'Courtyard', text: 'Exterior.' }] });
  vi.mocked(fetchFreezoneImageModels).mockResolvedValue([{ id: 'image-one', label: 'Image One', apiModel: 'actual-model', providerId: 'openai', ratioOptions: ['16:9'], resolutionOptions: ['1K'], qualityOptions: ['high'] }]);
  vi.mocked(listDirectorMedia).mockResolvedValue([]);
  vi.mocked(prepareDirectorMedia).mockResolvedValue(prepared);
  vi.mocked(confirmDirectorMedia).mockResolvedValue({ ...prepared, status: 'accepted', result: { task_key: 'task-one', job_id: 'job-one' } });
});
afterEach(cleanup);
const mount = async () => {
  render(<DirectorMediaPanel project="synthetic" workId="work-one" kind="scenes" onClose={vi.fn()} onKind={vi.fn()} />);
  fireEvent.click(await screen.findByLabelText('director.media.batch.mode'));
};

describe('Director media approval', () => {
  it('selects only the requested asset in source order and sends actual catalog choices', async () => {
    mount();
    const assets = await screen.findByLabelText('director.media.asset');
    expect([...assets.querySelectorAll('option')].map(option => option.textContent)).toEqual(['director.media.choose', '1. Corridor', '2. Courtyard']);
    expect(confirmDirectorMedia).not.toHaveBeenCalled();
    fireEvent.change(assets, { target: { value: '1' } });
    expect(screen.getByLabelText('director.media.promptLabel')).toHaveValue('director.media.prompt.scenes\nExterior.\nWatercolor');
    fireEvent.click(screen.getByRole('button', { name: 'director.media.prepare' }));
    await screen.findByRole('button', { name: 'director.media.confirm' });
    expect(vi.mocked(prepareDirectorMedia).mock.calls[0][2]).toMatchObject({ kind: 'scenes', asset_id: '1', model_id: 'image-one', aspect_ratio: '16:9', image_size: '1K', quality: 'high', document_version: 2, work_revision: 7 });
    expect(screen.getByRole('button', { name: 'director.media.confirm' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('director.media.acknowledge'));
    fireEvent.click(screen.getByRole('button', { name: 'director.media.confirm' }));
    await waitFor(() => expect(confirmDirectorMedia).toHaveBeenCalledWith('synthetic', 'work-one', 'intent-one'));
  });
  it('retains an unknown submission ID and does not automatically buy again', async () => {
    vi.mocked(listDirectorMedia).mockResolvedValue([{ ...prepared, status: 'unknown' }]);
    mount();
    await screen.findByText('director.media.unknown');
    expect(confirmDirectorMedia).not.toHaveBeenCalled();
    expect(prepareDirectorMedia).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'director.media.resume' })).not.toBeInTheDocument();
  });
  it('does not silently choose an asset or send when a menu is opened', async () => {
    mount();
    await screen.findByLabelText('director.media.asset');
    expect(screen.getByRole('button', { name: 'director.media.prepare' })).toBeDisabled();
    expect(prepareDirectorMedia).not.toHaveBeenCalled();
    expect(confirmDirectorMedia).not.toHaveBeenCalled();
  });
  it('shows empty catalog defaults and required selections exactly as submitted', async () => {
    vi.mocked(fetchFreezoneImageModels).mockResolvedValue([{ id: 'image-one', label: 'Image One', providerId: 'openai', apiModel: 'actual-model', ratioOptions: [], resolutionOptions: [], qualityOptions: [],
      request: { endpoint: 'images/generations', parameters: [{ key: 'format', label: 'Format', control: 'select', requestPath: 'output_format', required: true, options: ['png', 'jpeg'] }] } }]);
    mount();
    const assets = await screen.findByLabelText('director.media.asset');
    expect(screen.getByLabelText('director.media.ratio')).toHaveValue('1:1');
    expect(screen.getByLabelText('director.media.size')).toHaveValue('2K');
    expect(screen.getByLabelText('director.media.quality')).toHaveValue('medium');
    expect(screen.getByLabelText('Format')).toHaveValue('');
    fireEvent.change(assets, { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'director.media.prepare' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'jpeg' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.media.prepare' }));
    await screen.findByRole('button', { name: 'director.media.confirm' });
    expect(vi.mocked(prepareDirectorMedia).mock.calls[0][2]).toMatchObject({ aspect_ratio: '1:1', image_size: '2K', quality: 'medium', model_params: { format: 'jpeg' } });
  });
  it('restores a persisted result even when its task has aged out of the task list', async () => {
    vi.mocked(listDirectorMedia).mockResolvedValue([{ ...prepared, status: 'accepted', result: { job_id: 'old-job', task_key: 'old-task' } }]);
    vi.mocked(fetchFreezoneJobResult).mockResolvedValue({ url: '/api/v1/projects/synthetic/media/result.png', size: 100 });
    mount();
    const image = await screen.findByRole('img', { name: 'Courtyard' });
    expect(image).toHaveAttribute('src');
    expect(fetchFreezoneJobResult).toHaveBeenCalledWith('synthetic', 'freezone_gen', 'old-job');
    expect(confirmDirectorMedia).not.toHaveBeenCalled();
    expect(prepareDirectorMedia).not.toHaveBeenCalled();
  });
});
