// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OutlinePatchReview } from '@/features/director/components/OutlinePatchReview';
import type { DirectorChange } from '@/api/director';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const sample = (): DirectorChange => ({ id: 'c', work_id: 'w', doc_key: 'outline', base_version: 1,
  content: '', reason: '', status: 'pending', created_at: 1, decided_at: null, outlinePatch: {
    contract: 'outline-patch/1.0.0', revision: 1, headVersion: 1,
    baseAst: { blocks: [{ id: 'h', type: 'heading', text: 'Overview', attrs: { level: 2, lineBreak: true } },
      { id: 'p', type: 'paragraph', text: 'Original fact', attrs: { level: null, lineBreak: true } }] },
    groups: [{ id: 'g', hunkIds: ['edit'], sectionKeys: ['overview'], requiresGroupIds: [] }], decisions: { g: 'pending' }, acceptedGroupIds: [],
    hunks: [{ id: 'edit', sectionKey: 'overview', targetBlockIds: ['p'],
      afterBlocks: [{ type: 'paragraph', text: '<img src=x onerror=alert(1)>', level: null, lineBreak: true }],
      reason: 'Clarify wording' }], changeSummary: [], unresolvedRequests: [], reviews: [],
  } });

it('reviews before accepting, preserves the old passage, and escapes model markup', () => {
  const onAccept = vi.fn(), onReview = vi.fn(), onReject = vi.fn();
  const { container } = render(<OutlinePatchReview change={sample()} busy={false} label="Outline" {...{ onAccept, onReview, onReject }} />);
  expect(screen.getByText('Original fact')).toBeVisible();
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  expect(container.querySelector('img')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'director.patch.reviewFirst' })[0]);
  expect(onReview).toHaveBeenCalledWith(['g']);
  expect(onAccept).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole('button', { name: 'director.patch.rejectAll' })[0]);
  expect(onReject).toHaveBeenCalledWith(['g']);
});

it('only accepts a review matching the exact revision and group selection', () => {
  const change = sample();
  change.outlinePatch!.reviews = [{ id: 'r', changeRevision: 1, acceptGroupIds: ['g'],
    status: 'reviewed', literaryNotes: [], violatedPaths: [], uncertainPaths: [] }];
  const onAccept = vi.fn(), onReview = vi.fn();
  const { rerender } = render(<OutlinePatchReview change={change} busy={false} label="Outline" onAccept={onAccept} onReview={onReview} onReject={vi.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'director.patch.acceptAll' })[0]);
  expect(onAccept).toHaveBeenCalledWith(['g'], 'r');
  change.outlinePatch!.revision = 2;
  rerender(<OutlinePatchReview change={change} busy={false} label="Outline" onAccept={onAccept} onReview={onReview} onReject={vi.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'director.patch.reviewFirst' })[0]);
  expect(onReview).toHaveBeenCalledWith(['g']);
});

it('explains blocked passages with evidence without offering acceptance or interpreting markup', () => {
  const change = sample();
  change.outlinePatch!.reviews = [{ id: 'r', changeRevision: 1, acceptGroupIds: ['g'],
    status: 'blocked', literaryNotes: [], violatedPaths: [], uncertainPaths: ['overview'],
    units: [{ path: 'overview', findings: [{ candidateQuote: '<script>invented</script>', assertion: 'New action',
      verdict: 'uncertain', reason: 'No source support for the action.', sourceEvidence: [{ unitId: 's1', quote: 'The door stays shut.' }] }] }] }];
  const onAccept = vi.fn();
  const { container } = render(<OutlinePatchReview change={change} busy={false} label="Outline"
    onAccept={onAccept} onReview={vi.fn()} onReject={vi.fn()} />);
  expect(screen.getByText('No source support for the action.')).toBeVisible();
  expect(screen.getByText('<script>invented</script>')).toBeVisible();
  expect(container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByText('director.patch.sourceEvidence'));
  expect(screen.getByText('The door stays shut.')).toBeVisible();
  expect(screen.getAllByRole('button', { name: 'director.patch.acceptAll' }).every(button => button.hasAttribute('disabled'))).toBe(true);
  expect(onAccept).not.toHaveBeenCalled();
});

it('navigates documents while keeping the pending review unchanged', () => {
  const change = sample(), onSection = vi.fn(), onAccept = vi.fn(), onReject = vi.fn();
  render(<OutlinePatchReview change={change} busy={false} label="Outline" onAccept={onAccept}
    onReview={vi.fn()} onReject={onReject} onSection={onSection}
    sections={[{ id: 'outline', label: 'Outline', selected: true }, { id: 'characters', label: 'Characters', selected: false }]} />);
  expect(screen.getByRole('button', { name: 'Outline' })).toHaveAttribute('aria-current', 'page');
  fireEvent.click(screen.getByRole('button', { name: 'Outline' }));
  expect(onSection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Characters' }));
  expect(onSection).toHaveBeenCalledWith('characters');
  expect(onAccept).not.toHaveBeenCalled();
  expect(onReject).not.toHaveBeenCalled();
  expect(change.outlinePatch!.decisions).toEqual({ g: 'pending' });
});
