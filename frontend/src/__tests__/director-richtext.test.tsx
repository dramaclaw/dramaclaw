// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import { DirectorRichText, requiresSourceEditor, richTextExtensions } from '@/features/director/components/DirectorRichText';
import { DirectorSettingsDialog } from '@/features/director/components/DirectorSettingsDialog';
import { DirectorHistoryPopover } from '@/features/director/components/DirectorHistoryPopover';
import type { DirectorWork } from '@/api/director';
import { readDirectorPreference } from '@/features/director/director-ui-state';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const historyApi = vi.hoisted(() => ({ listDirectorWorks: vi.fn(), updateDirectorHistory: vi.fn() }));
vi.mock('@/api/director', () => historyApi);
afterEach(() => { cleanup(); localStorage.clear(); });

describe('rich editor and Markdown save boundary', () => {
  it('renders screenplay separators and speaker delivery line breaks without rewriting on open', async () => {
    const raw = '# Episode\n\n- **Beats**: action\n\n---\n\n## Synopsis\n\nA choice.\n\n---\n\n## Screenplay\n\n### 1-1 | Room\n\n**Ada:**\n*(quietly)*\n“Look again.”';
    expect(requiresSourceEditor(raw)).toBe(false);
    const change = vi.fn();
    render(<DirectorRichText value={raw} onChange={change} readOnly={false} label="Episode" screenplay />);
    await act(async () => {});
    const body = screen.getByRole('textbox');
    expect(body.querySelectorAll('hr')).toHaveLength(2);
    expect(body.querySelectorAll('br')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '1-1 | Room' })).toBeVisible();
    expect(change).not.toHaveBeenCalled();
  });
  it('keeps prop boundaries and episode labels through editable Markdown roundtrip', async () => {
    const change = vi.fn(), section = vi.fn();
    const raw = '# Prop list\n\n## Ada’s phone\n\n- **Type**: Technology\n- **Dramatic function**: Receives a message.\n- **Usage boundaries**: Ada retains this phone, not Ben’s.\n- **First appearance**: EP02\n- **Key episodes**: EP02 / EP03\n\n## Ben’s phone\n\n- **Type**: Evidence\n- **Dramatic function**: Replays the recording.\n- **Usage boundaries**: Not sent; replay does not transfer the file.\n- **First appearance**: EP03\n- **Key episodes**: EP03';
    render(<DirectorRichText value={raw} onChange={change} readOnly={false} label="Props"
      sections={[{ id: 'scenes', label: 'Scenes', selected: false }, { id: 'props', label: 'Props', selected: true }]} onSection={section} />);
    await act(async () => {});
    expect(screen.getByRole('textbox').querySelectorAll('li strong')).toHaveLength(10);
    expect(screen.getByRole('button', { name: 'Ada’s phone' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ben’s phone' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Scenes' }));
    expect(section).toHaveBeenCalledWith('scenes');
    expect(change).not.toHaveBeenCalled();
    const editor = new Editor({ extensions: richTextExtensions(), content: raw, contentType: 'markdown' });
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.commands.toggleBold();
    const saved = editor.getMarkdown();
    expect(saved).toContain('Ada retains this phone, not Ben’s.');
    expect(saved).toContain('Not sent; replay does not transfer the file.');
    expect(saved).toContain('EP02 / EP03');
    expect((saved.match(/\*\*First appearance\*\*/g) ?? [])).toHaveLength(2);
    editor.destroy();
  });

  it('renders the five scene fields and switches sections without rewriting the document', async () => {
    const change = vi.fn(), section = vi.fn();
    const raw = '# Scene list\n\n## Meeting room\n\n- **Type**: Interior\n- **Dramatic function**: The agreement is signed.\n- **Spatial constraints on action**: The door stays closed until Ada opens it.\n- **Reusable action positions**: The same table in both episodes.\n- **Key episodes**: EP01 / EP02\n\n## Courtyard\n\n- **Type**: Exterior';
    const view = render(<DirectorRichText value={raw} onChange={change} readOnly={false} label="Scenes"
      sections={[{ id: 'characters', label: 'Characters', selected: false }, { id: 'scenes', label: 'Scenes', selected: true }]} onSection={section} />);
    await act(async () => {});
    expect(screen.getByRole('textbox').querySelectorAll('h2')).toHaveLength(2);
    expect(screen.getByRole('textbox').querySelectorAll('li strong')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Meeting room' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Characters' }));
    expect(section).toHaveBeenCalledWith('characters');
    expect(change).not.toHaveBeenCalled();
    view.rerender(<DirectorRichText value={raw} onChange={change} readOnly label="Scenes" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    expect(screen.getByRole('textbox')).toHaveTextContent('EP01 / EP02');
  });

  it('uses heading positions for duplicate character names and never edits on navigation', async () => {
    const change = vi.fn(), jump = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = jump;
    try {
      render(<DirectorRichText value={'# Character roster\n\n## Lin\n\n- **Type**: Main\n\n## Lin\n\n- **Type**: Supporting'}
        onChange={change} readOnly={false} label="Characters" sections={[{ id: 'characters', label: 'Characters', selected: true }]} />);
      await act(async () => {});
      const names = screen.getAllByRole('button', { name: 'Lin' });
      expect(names).toHaveLength(2);
      fireEvent.click(names[1]);
      expect(names[1]).toHaveAttribute('aria-current', 'location');
      expect(names[0]).not.toHaveAttribute('aria-current');
      expect(jump).toHaveBeenCalledOnce();
      const scroller = screen.getByRole('textbox').closest('.dc-rich-scroll')!;
      const headingDom = screen.getByRole('textbox').querySelectorAll('h2');
      vi.spyOn(headingDom[0], 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect);
      vi.spyOn(headingDom[1], 'getBoundingClientRect').mockReturnValue({ top: 400 } as DOMRect);
      // A bottom-clamped smooth scroll must not highlight the previous person.
      fireEvent.scroll(scroller);
      expect(names[1]).toHaveAttribute('aria-current', 'location');
      fireEvent.wheel(scroller);
      fireEvent.scroll(scroller);
      expect(names[0]).toHaveAttribute('aria-current', 'location');
      expect(change).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox').querySelectorAll('li strong')).toHaveLength(2);
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });

  it('does not save or normalize content on open, zoom or source view changes', async () => {
    const change = vi.fn(), raw = '# Title\n\nOriginal text.\n\n';
    render(<DirectorRichText value={raw} onChange={change} readOnly={false} label="Outline" />);
    await act(async () => {});
    expect(screen.getByRole('textbox')).toHaveTextContent('Title');
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.zoomIn' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.sourceView' }));
    expect(screen.getByRole('textbox')).toHaveValue(raw);
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.richView' }));
    expect(change).not.toHaveBeenCalled();
  });

  it.each(['<custom>Keep</custom>', '![alt](image.png)', '---\ntitle: A\n---', 'Footnote[^x]\n\n[^x]: Keep'])('retains unsupported source literally: %s', async raw => {
    const change = vi.fn();
    render(<DirectorRichText value={raw} onChange={change} readOnly={false} label="Outline" />);
    await act(async () => {});
    expect(requiresSourceEditor(raw)).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue(raw);
    expect(screen.getByRole('button', { name: 'director.surface.richView' })).toBeDisabled();
    expect(change).not.toHaveBeenCalled();
  });

  it('renders GFM tables, nested lists, tasks and Unicode without dropping text', () => {
    const raw = '# Title 😀\n\n| Item | Owner |\n| --- | --- |\n| key | Ada |\n\n- First\n  - Child\n\n- [x] Done\n\n**bold** and _italic_';
    const editor = new Editor({ extensions: richTextExtensions(), content: raw, contentType: 'markdown' });
    const output = editor.getMarkdown();
    expect(editor.getHTML()).toContain('<table');
    for (const token of ['Title 😀', 'key', 'Ada', 'Child', '[x] Done', '**bold**']) expect(output).toContain(token);
    editor.destroy();
  });

  it('formatting and undo update the actual Markdown, not a decorative toolbar', () => {
    const editor = new Editor({ extensions: richTextExtensions(), content: 'Hello world', contentType: 'markdown' });
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();
    expect(editor.getMarkdown()).toBe('**Hello** world');
    editor.commands.undo();
    expect(editor.getMarkdown()).toBe('Hello world');
    editor.commands.redo();
    expect(editor.getMarkdown()).toBe('**Hello** world');
    editor.destroy();
  });

  it('read-only blocks formatting and external unsupported restores switch safely to source', async () => {
    const change = vi.fn();
    const view = render(<DirectorRichText value="Text" onChange={change} readOnly label="Outline" />);
    expect(screen.getByRole('button', { name: 'director.surface.bold' })).toBeDisabled();
    expect(screen.getByRole('textbox')).toHaveAttribute('contenteditable', 'false');
    view.rerender(<DirectorRichText value="<custom>Keep</custom>" onChange={change} readOnly label="Outline" />);
    await act(async () => {});
    expect(screen.getByRole('textbox')).toHaveValue('<custom>Keep</custom>');
    expect(change).not.toHaveBeenCalled();
  });
});

describe('truthful local settings', () => {
  it('does not expose technical token settings or grant automatic spending', () => {
    const close = vi.fn();
    localStorage.setItem('director:ui:outputTokens', '1024');
    render(<DirectorSettingsDialog onClose={close} onMethods={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'director.surface.autoGenerate' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'director.surface.budget' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('director.execution.automaticBudgetHint')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'director.close' }));
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem('director:ui:outputTokens')).toBe('1024');
  });
  it('saves notification preferences without writing obsolete token settings', () => {
    const close = vi.fn();
    render(<DirectorSettingsDialog onClose={close} onMethods={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.done' }));
    expect(close).toHaveBeenCalledOnce();
    expect(localStorage.getItem('director:ui:outputTokens')).toBeNull();
    localStorage.setItem('director:ui:composer', '{}'); expect(readDirectorPreference('composer', '')).toBe('');
  });
});

describe('history commands preserve uncertain intent', () => {
  it('allows only the original restore retry after a transport failure', async () => {
    const rows = ['first', 'second'].map(id => ({ id, title: id, revision: 4, updated_at: 1 }) as DirectorWork);
    historyApi.listDirectorWorks.mockResolvedValue(rows);
    historyApi.updateDirectorHistory.mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce(rows[0]);
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<DirectorHistoryPopover project="fixture" works={rows} anchor={null} onClose={vi.fn()} onOpen={vi.fn()} onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.archivedHistory' }));
    await screen.findAllByRole('button', { name: 'director.surface.restoreConversation' });
    fireEvent.click(screen.getAllByRole('button', { name: 'director.surface.restoreConversation' })[0]);
    await screen.findByRole('alert');
    expect(screen.getAllByRole('button', { name: 'director.surface.restoreConversation' })[0]).not.toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'director.surface.restoreConversation' })[1]).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'director.surface.rename' })) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'director.surface.activeHistory' })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'director.surface.restoreConversation' })[0]);
    await waitFor(() => expect(changed).toHaveBeenCalledWith('first', false));
    expect(historyApi.updateDirectorHistory).toHaveBeenCalledTimes(2);
    expect(historyApi.updateDirectorHistory.mock.calls[1]).toEqual(historyApi.updateDirectorHistory.mock.calls[0]);
    expect(historyApi.updateDirectorHistory.mock.calls[0][2]).toMatchObject({ expected_revision: 4, action: 'restore' });
  });
});
