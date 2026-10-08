// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectorPresetDialog, SUBJECTS, PRESET_DEFAULTS, type DirectorWorkDraft } from '@/features/director/DirectorPresetDialog';
import { DirectorWindow } from '@/features/director/components/DirectorWindow';
import { DirectorReferenceIcon, type ReferenceIconName } from '@/features/director/components/DirectorReferenceIcon';
import iconCatalog from '@/features/director/assets/libtv-icons.json';
import referenceAssets from '@/features/director/assets/reference-assets.json';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); localStorage.clear(); });
const draft: DirectorWorkDraft = { title: 'Example', brief: 'Two friends find a key.', sourceText: '', sourceFileName: '',
  preset: { mode: 'original', primary_genre: SUBJECTS[0], fusion_genre: '', audience: '', characters: '', era: '', highlights: '', visual_style: 'ink', model_name: 'actual-model', structure: 'three_act', episode_count: 2, duration_seconds: 60, adapt_direction: null, source_episode_label: '', delivery_episode_label: '' } };

describe('reference-shaped preset UI with real draft boundaries', () => {
  it.each([1, 120, 5400])('keeps the user duration of %i seconds through template changes and confirmation', (seconds) => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    const input = screen.getByLabelText('director.durationSeconds');
    expect(input).not.toHaveAttribute('max');
    fireEvent.change(input, { target: { value: String(seconds) } });
    fireEvent.click(screen.getByRole('button', { name: '1director.genre.1' }));
    expect(input).toHaveValue(seconds);
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    expect(confirm.mock.calls[0][0].preset.duration_seconds).toBe(seconds);
    expect(draft.preset.duration_seconds).toBe(60);
  });

  it.each(['', '0', '-1', '2.5'])('preserves invalid duration %j without silently substituting a default', (value) => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    const input = screen.getByLabelText('director.durationSeconds');
    fireEvent.change(input, { target: { value } });
    expect(input).toHaveValue(value === '' ? null : Number(value));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const button = screen.getByRole('button', { name: 'director.confirm' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '120' } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(confirm.mock.calls[0][0].preset.duration_seconds).toBe(120);
  });

  it('discards a provisional duration on cancel', () => {
    const confirm = vi.fn(), close = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={close} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.change(screen.getByLabelText('director.durationSeconds'), { target: { value: '5400' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(draft.preset.duration_seconds).toBe(60);
  });

  it.each(PRESET_DEFAULTS.map((template, index) => ({ template, index })))('applies every captured preset field without changing explicit structure or provider: $index', ({ template, index }) => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: `${index + 1}director.genre.${index + 1}` }));
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    const { name: _name, ...expected } = template;
    expect(confirm.mock.calls[0][0].preset).toMatchObject({ ...expected, structure: draft.preset.structure, model_name: draft.preset.model_name, duration_seconds: draft.preset.duration_seconds });
  });
  it('opens six summary cards, preserves hidden parameters and exposes structure controls', () => {
    const confirm = vi.fn();
    const { container } = render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    expect(container.querySelectorAll('.dc-summary-card')).toHaveLength(6);
    expect(screen.queryByLabelText('director.workTitle')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'director.structure.label' }));
    fireEvent.change(screen.getByRole('slider'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.spec.structures.nonlinear' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    expect(confirm.mock.calls[0][0].preset).toMatchObject({ episode_count: 7, structure: 'nonlinear', visual_style: 'ink', model_name: 'actual-model', duration_seconds: 60 });
    expect(draft.preset.episode_count).toBe(2);
  });

  it('hides the Top8 rail without clearing a selection and cancels edits without confirming', () => {
    const confirm = vi.fn(), close = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={close} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByText('director.top8')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'director.visualStyle' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.custom' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'watercolor' } });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(draft.preset.visual_style).toBe('ink');
  });

  it('uses fifteen subject categories independently of eight templates and excludes duplicates', () => {
    const confirm = vi.fn();
    const { container } = render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    expect(SUBJECTS).toHaveLength(15);
    fireEvent.click(screen.getByRole('button', { name: 'director.fusionGenre' }));
    const lists = container.querySelectorAll('.dc-genre-list');
    expect(within(lists[1] as HTMLElement).getByRole('button', { name: 'director.ui.subject.0' })).toBeDisabled();
    fireEvent.click(within(lists[1] as HTMLElement).getByRole('button', { name: 'director.ui.subject.1' }));
    expect(within(lists[0] as HTMLElement).getByRole('button', { name: 'director.ui.subject.1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.removeFusion' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    expect(confirm.mock.calls[0][0].preset.fusion_genre).toBe('');
  });

  it('read-only prevents card edits, templates, and confirmation', () => {
    const { container } = render(<DirectorPresetDialog draft={draft} readOnly onClose={vi.fn()} onConfirm={vi.fn()} />);
    container.querySelectorAll('.dc-summary-card, .dc-top8-item').forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('button', { name: 'director.confirm' })).toBeDisabled();
  });

  it('limits catalog choices in order and does not overwrite unrelated settings', () => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.audience' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.choices.audience.0' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.choices.audience.1' }));
    expect(screen.getByRole('button', { name: 'director.ui.choices.audience.2' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.choices.audience.0' }));
    expect(screen.getByRole('button', { name: 'director.ui.choices.audience.2' })).toBeEnabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    // i18n-exempt-next-line — Semantic stored option value.
    expect(confirm.mock.calls[0][0].preset).toMatchObject({ audience: '女频', model_name: 'actual-model', visual_style: 'ink' });
  });

  it('keeps a custom subject visible rather than relabeling it as fantasy', () => {
    render(<DirectorPresetDialog draft={{ ...draft, preset: { ...draft.preset, primary_genre: 'Custom genre' } }} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('Custom genre')).toBeInTheDocument();
  });

  it('restores keyboard focus to the parameter card after closing its popup', () => {
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'director.structure.label' });
    fireEvent.click(trigger);
    expect(within(screen.getByRole('dialog', { name: 'director.structure.label' })).getByRole('slider')).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});

describe('pinned reference artwork', () => {
  it('renders original SVG geometry with isolated gradient IDs and no executable or remote content', () => {
    const names = Object.keys(iconCatalog) as ReferenceIconName[];
    const { container } = render(<>{names.map((name) => <DirectorReferenceIcon key={name} name={name} />)}<DirectorReferenceIcon name="Welcome" /></>);
    expect(names).toHaveLength(54);
    expect(container.querySelectorAll(':scope > svg')).toHaveLength(names.length + 1);
    expect(container.querySelector('script, foreignObject, image, use')).toBeNull();
    const ids = Array.from(container.querySelectorAll('[id]')).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const el of container.querySelectorAll('*')) for (const attr of Array.from(el.attributes)) {
      expect(attr.name).not.toMatch(/^on|href/i);
      expect(attr.value).not.toMatch(/https?:|javascript:|data:/i);
      for (const match of attr.value.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(match[1]);
    }
    expect(container.querySelector('svg path')?.getAttribute('d')).toBe(iconCatalog.NewConversation.children[0].attrs.d);
  });

  it('matches every local material to its pinned byte length and SHA-256', () => {
    expect(referenceAssets.genres).toHaveLength(14);
    expect(new Set(referenceAssets.genres.map((asset) => asset.path)).size).toBe(14);
    expect(referenceAssets.styles).toHaveLength(21);
    for (const asset of [...referenceAssets.genres, ...referenceAssets.styles]) {
      expect(asset.path).toMatch(/^\/director-reference\/(genre|style)-\d{2}\.(webp|png)$/);
      expect(asset.source).not.toMatch(/[?#]/);
      const bytes = readFileSync(resolve(process.cwd(), 'public', asset.path.slice(1)));
      expect(bytes.length).toBe(asset.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
    const icons = readFileSync(resolve(process.cwd(), 'src/features/director/assets/libtv-icons.json'));
    expect(createHash('sha256').update(icons).digest('hex')).toBe(referenceAssets.iconCatalog.sha256);
    expect(referenceAssets.icons).toEqual(Object.keys(iconCatalog));
  });
});

describe('floating window is local view state', () => {
  it('has eight keyboard resize handles, persists geometry and preserves children on docking', () => {
    const { rerender } = render(<DirectorWindow project="example" docked={false}><textarea defaultValue="unsent" /></DirectorWindow>);
    const handles = screen.getAllByRole('separator');
    expect(handles).toHaveLength(8);
    fireEvent.keyDown(handles[2], { key: 'ArrowRight' });
    expect(JSON.parse(localStorage.getItem('director:window:example')!).width).toBe(410);
    rerender(<DirectorWindow project="example" docked><textarea defaultValue="unsent" /></DirectorWindow>);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('unsent');
    rerender(<DirectorWindow project="example" docked={false}><textarea defaultValue="unsent" /></DirectorWindow>);
    fireEvent.keyDown(screen.getAllByRole('separator')[0], { key: 'Home' });
    expect(JSON.parse(localStorage.getItem('director:window:example')!).width).toBe(400);
  });
});
