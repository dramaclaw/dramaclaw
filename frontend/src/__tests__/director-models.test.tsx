// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DirectorStudio } from '@/features/director/DirectorStudio';
import { DirectorPresetDialog, type DirectorWorkDraft } from '@/features/director/DirectorPresetDialog';
import * as director from '@/api/director';
import * as execution from '@/api/director-execution';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/director', async (original) => ({ ...await original<typeof import('@/api/director')>(),
  getDirectorModelContract: vi.fn(), listDirectorWorks: vi.fn(), createDirectorWork: vi.fn(),
  getDirectorWork: vi.fn(), getDirectorDocument: vi.fn(), getCanonicalDocuments: vi.fn(),
}));
vi.mock('@/api/director-execution', async (original) => ({ ...await original<typeof import('@/api/director-execution')>(),
  getExecutionCapability: vi.fn(), listExecutionRuns: vi.fn(), getExecutionEvents: vi.fn(), getPlanningState: vi.fn(),
}));
const options: director.DirectorModelOption[] = [
  { id: 'ark::doubao-seed-evolving', label: 'Seed-Evolving', providerLabel: 'Volcengine · Agent Plan', upstreamModel: 'doubao-seed-evolving' },
  { id: 'ark::deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash', providerLabel: 'Volcengine · Agent Plan', upstreamModel: 'deepseek-v4.1-flash' },
];
const contract: director.DirectorModelContract = { model_name: options[0].id, locked: false, source: 'local_catalog', options };
const capability: execution.ExecutionCapability = { schemaVersion: 2, version: 'a'.repeat(64), model: contract, methodVersion: 'test', maxAttempts: 1,
  outputTokens: { minimum: 256, maximum: 16384, default: 4096 }, cost: { estimateMinor: null, currency: null, requiresUnknownCostConsent: true },
  supportsRemoteCancellation: false, supportsAutomaticRedispatch: false };
const draft: DirectorWorkDraft = { title: 'A return home', brief: 'A traveller returns.', sourceText: '', sourceFileName: '',
  preset: { mode: 'adaptation', primary_genre: '', fusion_genre: '', audience: '', characters: '', era: '', highlights: '', visual_style: '', model_name: options[0].id, structure: 'three_act', episode_count: 1, duration_seconds: 600, adapt_direction: 'condense', source_episode_label: '', delivery_episode_label: '' } };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(director.getDirectorModelContract).mockResolvedValue(contract);
  vi.mocked(director.listDirectorWorks).mockResolvedValue([]);
  vi.mocked(execution.getExecutionCapability).mockResolvedValue(capability);
  vi.mocked(execution.listExecutionRuns).mockResolvedValue([]);
  vi.mocked(execution.getExecutionEvents).mockResolvedValue({ schemaVersion: 2, events: [], nextSeq: 0 });
});
afterEach(cleanup);

it('uses real catalog labels and keeps an explicit choice after the global default refreshes', async () => {
  render(<DirectorStudio project="model-test" />);
  await screen.findByText('Seed-Evolving');
  fireEvent.click(screen.getByRole('button', { name: 'director.surface.chooseModel' }));
  fireEvent.click(screen.getByRole('button', { name: /DeepSeek-V4.1-Flash.*Volcengine/ }));
  expect(screen.getByRole('button', { name: 'director.surface.chooseModel' })).toHaveTextContent('DeepSeek-V4.1-Flash');
  fireEvent(window, new Event('media-model-catalog-updated'));
  await waitFor(() => expect(director.getDirectorModelContract).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', { name: 'director.surface.chooseModel' })).toHaveTextContent('DeepSeek-V4.1-Flash');
  expect(director.createDirectorWork).not.toHaveBeenCalled();
});

it('does not silently substitute a removed choice when settings are refreshed', async () => {
  render(<DirectorStudio project="model-test" />);
  await screen.findByText('Seed-Evolving');
  vi.mocked(director.getDirectorModelContract).mockResolvedValue({ ...contract, model_name: options[1].id, options: [options[1]] });
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(director.getDirectorModelContract).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'director.surface.chooseModel' }));
  expect(await screen.findByRole('button', { name: /ark::doubao-seed-evolving.*director.modelUnavailable/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: /DeepSeek-V4.1-Flash.*Volcengine/ })).toHaveAttribute('aria-pressed', 'false');
});

it('the preset selector stores the canonical provider ID, not the display label', () => {
  const confirm = vi.fn();
  render(<DirectorPresetDialog draft={draft} modelOptions={options} onClose={vi.fn()} onConfirm={confirm} />);
  fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
  const select = screen.getByLabelText('director.textModel');
  expect(within(select).getAllByRole('option')).toHaveLength(2);
  fireEvent.change(select, { target: { value: options[1].id } });
  fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
  expect(confirm.mock.calls[0][0].preset.model_name).toBe(options[1].id);
  expect(draft.preset.model_name).toBe(options[0].id);
});
