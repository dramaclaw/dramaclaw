// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectorRichText, requiresSourceEditor } from '@/features/director/components/DirectorRichText';
import golden from '../../../tests/fixtures/director/outline-v3/projections.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('five-section adaptation delivery through the existing editor', () => {
  for (const projection of golden.projections) {
    it(`renders the host projection and section navigation in ${projection.language}`, async () => {
      const onChange = vi.fn();
      const headings = projection.markdown.split('\n').filter(line => line.startsWith('## ')).map(line => line.slice(3));
      expect(headings).toHaveLength(5);
      expect(requiresSourceEditor(projection.markdown)).toBe(false);
      render(<DirectorRichText value={projection.markdown} onChange={onChange} readOnly={false} label="Outline" />);
      const editor = await screen.findByRole('textbox');
      await waitFor(() => expect([...editor.querySelectorAll('h2')].map(h => h.textContent)).toEqual(headings));
      for (const title of headings) expect(screen.getByRole('button', { name: title })).toBeVisible();
      expect(editor.querySelectorAll('h3')).toHaveLength(3);
      expect(editor).toHaveTextContent('1 / 600s / 600s');
      expect(onChange).not.toHaveBeenCalled();
      const original = HTMLElement.prototype.scrollIntoView;
      const scroll = vi.fn();
      HTMLElement.prototype.scrollIntoView = scroll;
      try {
        fireEvent.click(screen.getByRole('button', { name: headings[4] }));
        expect(scroll).toHaveBeenCalledOnce();
        expect(screen.getByRole('button', { name: headings[4] })).toHaveAttribute('aria-current', 'location');
        expect(onChange).not.toHaveBeenCalled();
      } finally { HTMLElement.prototype.scrollIntoView = original; }
    });
  }

  it('renders hostile story markup as literal text, without extra headings or remote content', async () => {
    expect(requiresSourceEditor(golden.safetyMarkdown)).toBe(false);
    const onChange = vi.fn();
    render(<DirectorRichText value={golden.safetyMarkdown} onChange={onChange} readOnly label="Outline" />);
    await act(async () => {});
    const editor = screen.getByRole('textbox');
    expect(editor.querySelectorAll('h2')).toHaveLength(5);
    expect(editor.querySelectorAll('img, script, iframe, a')).toHaveLength(0);
    expect(editor).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(editor).toHaveTextContent('[click](javascript:alert(1))');
    expect(editor).toHaveTextContent('## Fake heading');
    expect(editor).toHaveTextContent('😀');
    expect(onChange).not.toHaveBeenCalled();
  });
});
