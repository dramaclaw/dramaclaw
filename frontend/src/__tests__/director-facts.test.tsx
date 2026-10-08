// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QualityReviewDialog } from '@/features/director/components/QualityReviewDialog';
import type { DirectorQualityReport, DirectorWork } from '@/api/director';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('shows the entire source/draft comparison and refuses finalization on a contradiction', () => {
  const report: DirectorQualityReport = { doc_key: 'episode-002', version: 1, blockers: ['EPISODE_FACTS_CONTRADICTED'], warnings: [], ready_for_human_review: false, schemaVersion: 2, contentHash: 'hash', productionReady: false, requiredHumanChecks: [],
    review: { id: 'review', reportHash: 'hash', reviewerRunId: 'run', status: 'FAIL', checks: [], episodeFacts: { status: 'FAIL', version: '1', coverage: { expected: 1, valid: 1, semanticCompletenessVerified: false }, issues: [], units: [{ id: 'fact-0001', inputId: 'document', text: 'Ada puts the phone down.', disposition: 'FACTS', explanation: 'Position conflict.', valid: true, requiresHumanCheck: true, facts: [{ subject: 'phone', relation: 'location', value: 'desk', before: 'hand', after: 'desk', layer: 'real', status: 'CONTRADICTED', explanation: 'The locked state forbids the transfer.', evidence: [{ inputId: 'locked', quote: 'The phone remains in her hand.', start: 0, end: 30 }] }] }] } } };
  render(<QualityReviewDialog work={{ id: 'work', revision: 1 } as DirectorWork} ordinal={2} report={report} busy={false} error="" onClose={vi.fn()} onReview={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByText('Ada puts the phone down.')).toBeVisible();
  expect(screen.getByText(/The phone remains in her hand/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'director.confirmFinalize' })).toBeDisabled();
});
