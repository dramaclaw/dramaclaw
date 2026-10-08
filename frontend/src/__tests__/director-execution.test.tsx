// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionHistory, RequestParameters } from '@/features/director/components/ExecutionHistory';
import { DirectorStudio } from '@/features/director/DirectorStudio';
import { DirectorPresetDialog } from '@/features/director/DirectorPresetDialog';
import { DocumentVersionPanel } from '@/features/director/components/DocumentVersionPanel';
import { QualityReviewDialog } from '@/features/director/components/QualityReviewDialog';
import { OutlineReviewDialog } from '@/features/director/components/OutlineReviewDialog';
import { RevisionImpactDialog } from '@/features/director/components/RevisionImpactDialog';
import { DirectorDocumentEditor } from '@/features/director/components/DirectorDocumentEditor';
import { PlanningWorkflow } from '@/features/director/components/PlanningWorkflow';
import { ConversationScroll } from '@/features/director/components/DirectorConversation';
import { executionCommand, isExecutionActive, type ExecutionRun } from '@/api/director-execution';
import * as executionApi from '@/api/director-execution';
import * as directorApi from '@/api/director';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/director', async (original) => ({
  ...await original<typeof import('@/api/director')>(),
  createDirectorWork: vi.fn(),
  getDirectorModelContract: vi.fn(), listDirectorWorks: vi.fn(), getDirectorWork: vi.fn(), getDirectorDocument: vi.fn(),
  getCanonicalDocuments: vi.fn(), previewLegacyImport: vi.fn(), commitLegacyImport: vi.fn(),
  previewSettingsRevision: vi.fn(), previewEpisodeReopen: vi.fn(), commitDirectorRevision: vi.fn(),
  listDirectorDrafts: vi.fn(), saveDirectorDraft: vi.fn(),
  getOutlineQualityReport: vi.fn(),
}));
vi.mock('@/api/director-execution', async (original) => ({
  ...await original<typeof import('@/api/director-execution')>(),
  getExecutionCapability: vi.fn(), listExecutionRuns: vi.fn(), sendExecutionCommand: vi.fn(), getRetainedResult: vi.fn(),
  getPlanningState: vi.fn(), sendPlanningCommand: vi.fn(), getExecutionEvents: vi.fn(),
}));

const capabilities = {
  schemaVersion: 2 as const, version: 'f'.repeat(64), model: { model_name: 'test-model', locked: true },
  methodVersion: 'test-method', maxAttempts: 1 as const,
  outputTokens: { minimum: 256, maximum: 16384, default: 4096 },
  cost: { estimateMinor: null, currency: null, requiresUnknownCostConsent: true as const },
  supportsRemoteCancellation: false as const, supportsAutomaticRedispatch: false as const,
};
const preset: directorApi.DirectorPreset = {
  mode: 'original', primary_genre: '', fusion_genre: '', audience: '', characters: '', era: '', highlights: '',
  visual_style: '', model_name: 'test-model', structure: 'three_act', episode_count: 1, duration_seconds: 30,
  adapt_direction: null, source_episode_label: '', delivery_episode_label: '',
};
const work: directorApi.DirectorWork = {
  id: 'work-one', title: 'Synthetic title', mode: 'original', preset, brief: 'A key opens a door.',
  source_sha256: '', source_episode_label: '', delivery_episode_label: '', current_episode: 1,
  status: 'created', revision: 1, created_at: 1000, updated_at: 1000,
};
const quoted: executionApi.ExecutionQuote = {
  quoteId: 'quote-one', requestHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), docKey: 'outline',
  parameters: { model_name: 'test-model', duration_seconds: 30 },
  limits: { maxAttempts: 1, maxOutputTokens: 4096, inputChars: 500, timeoutSeconds: 300 },
  estimateMinor: null, currency: null, expiresAt: Date.now() / 1000 + 600,
};
function run(status: ExecutionRun['status']): ExecutionRun {
  return { id: 'run-one', workId: work.id, sessionId: 'session', revision: 1, status,
    requestHash: 'a'.repeat(64), docKey: 'outline', parameters: quoted.parameters, limits: quoted.limits,
    errorCode: null, changeId: null, createdAt: 1000, updatedAt: 1000, response: {},
    cost: { status: 'unknown', estimateMinor: null, reservedMinor: null, actualMinor: null,
      currency: null, maxOutputTokens: 4096, actualOutputTokens: null },
    canResume: status === 'queued', canCancel: status === 'queued' || status === 'dispatching',
    requiresReconciliation: status === 'unknown',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.mocked(executionApi.getExecutionCapability).mockResolvedValue(capabilities);
  vi.mocked(executionApi.listExecutionRuns).mockResolvedValue([]);
  vi.mocked(executionApi.getExecutionEvents).mockResolvedValue({ schemaVersion: 2, events: [], nextSeq: 0 });
  vi.mocked(executionApi.getPlanningState).mockResolvedValue({ workId: work.id, revision: 1, phase: 'READY', checkpoint: null, budgets: [], artifacts: {}, errorCode: null });
  vi.mocked(directorApi.getDirectorModelContract).mockResolvedValue(capabilities.model);
  vi.mocked(directorApi.listDirectorWorks).mockResolvedValue([work]);
  vi.mocked(directorApi.getDirectorWork).mockResolvedValue({ work, documents: [], changes: [], runs: [] });
  vi.mocked(directorApi.getDirectorDocument).mockResolvedValue({ doc_key: 'outline', version: 0, content: '', origin: '', created_at: 0 });
  vi.mocked(directorApi.getCanonicalDocuments).mockResolvedValue({ schemaVersion: 2, workRevision: 1, documents: [], episodes: [], artifacts: [] });
  vi.mocked(directorApi.listDirectorDrafts).mockResolvedValue([]);
});
afterEach(cleanup);

it('keeps model and duration visible while nested immutable snapshots are expandable', () => {
  const parameters = { model_name: 'seed-example', duration_seconds: 600, patchContext: { baseVersion: 3, baseAst: { text: 'Preserved technical content' } } };
  render(<RequestParameters parameters={parameters} />);
  expect(screen.getByText('seed-example')).toBeVisible();
  expect(screen.getByText('600')).toBeVisible();
  const snapshot = screen.getByText('patchContext').closest('details')!;
  expect(snapshot).not.toHaveAttribute('open');
  expect(snapshot.textContent).toContain('Preserved technical content');
  expect(parameters.patchContext.baseVersion).toBe(3);
});

describe('durable original planning controls', () => {
  const initial: executionApi.PlanningState = { workId: work.id, revision: 0, phase: 'NOT_STARTED', checkpoint: null, budgets: [], artifacts: {}, errorCode: null };
  const stageQuote: executionApi.PlanningQuote = { quoteId: 'pq-1', planHash: 'f'.repeat(64), workflowRevision: 1, expiresAt: Date.now() / 1000 + 600, estimateMinor: null, currency: null,
    plan: { group: 'direction', stages: ['M03'], model: 'test-model', limits: { maxCalls: 1, maxOutputTokensPerCall: 4096, maxTotalOutputTokens: 4096, maxAttemptsPerStage: 1, automaticRevisions: 0 } } };
  const props = { project: 'synthetic', work, capability: capabilities, hasDocuments: false, onChanged: vi.fn(), onState: vi.fn(), quoteAction: { current: null } };

  it('the first Send creates a work and starts exactly one bounded stage without a second Send', async () => {
    vi.mocked(directorApi.listDirectorWorks).mockResolvedValue([]);
    vi.mocked(directorApi.createDirectorWork).mockResolvedValue(work);
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValueOnce(stageQuote).mockResolvedValueOnce({ ...initial, revision: 2, phase: 'EXEC' });
    render(<DirectorStudio project="synthetic" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'director.inputPlaceholder' }), { target: { value: '写关于曹操的故事' } });
    fireEvent.click(await screen.findByRole('button', { name: 'director.send' }));
    await screen.findByText('director.planning.phase.EXEC');
    expect(directorApi.createDirectorWork).toHaveBeenCalledWith('synthetic', expect.objectContaining({ brief: '写关于曹操的故事' }));
    expect(executionApi.sendPlanningCommand).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toEqual({ type: 'planning.quote', targetScope: 'preparation' });
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[1][1].payload).toEqual({ type: 'planning.grant', quoteId: stageQuote.quoteId, planHash: stageQuote.planHash, unknownCostConsent: true });
    expect(screen.queryByRole('button', { name: 'director.planning.grant' })).not.toBeInTheDocument();
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[1][1].expected.workflowRevision).toBe(stageQuote.workflowRevision);
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('reopening a created work never quotes or grants automatically', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    render(<DirectorStudio project="synthetic" />);
    await screen.findByText('director.planning.phase.NOT_STARTED');
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    expect(screen.getByText('director.workStatus.created', { exact: false })).toBeInTheDocument();
  });

  it('a lost first quote is not replayed until the user retries the same intent', async () => {
    vi.mocked(directorApi.listDirectorWorks).mockResolvedValue([]);
    vi.mocked(directorApi.createDirectorWork).mockResolvedValue(work);
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    vi.mocked(executionApi.sendPlanningCommand).mockRejectedValueOnce(new Error('quote transport lost')).mockResolvedValueOnce(stageQuote).mockResolvedValueOnce({ ...initial, revision: 2, phase: 'EXEC' });
    render(<DirectorStudio project="synthetic" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'director.inputPlaceholder' }), { target: { value: '写关于曹操的故事' } });
    fireEvent.click(await screen.findByRole('button', { name: 'director.send' }));
    expect(await screen.findByText('quote transport lost')).toBeInTheDocument();
    expect(executionApi.sendPlanningCommand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.retryIntent' }));
    await screen.findByText('director.planning.phase.EXEC');
    const calls = vi.mocked(executionApi.sendPlanningCommand).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1][1]).toEqual(calls[0][1]);
    expect(calls[2][1].payload.type).toBe('planning.grant');
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('submitting a direction starts only the next budget group without another fee click', async () => {
    const direction: executionApi.PlanningState = { ...initial, revision: 3, phase: 'WAIT_DIRECTION', checkpoint: {
      id: 'cp-direction', kind: 'WAIT_DIRECTION', status: 'open', resumeToken: 'resume', payloadHash: 'a'.repeat(64),
      payload: { options: [{ id: 'd1', logline: 'Chronological', goal: 'Return', obstacle: 'Gate', stakes: 'Freedom', tone: 'Tense', difference: 'One night', productionRisks: [] }],
        confirmedPreset: { episodeCount: 1, durationSeconds: 30 }, specQuestions: [] },
    } };
    const nextQuote = { ...stageQuote, quoteId: 'pq-next', workflowRevision: 5,
      plan: { ...stageQuote.plan, group: 'preparation' as const, stages: ['M07', 'M08', 'M09'] } };
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(direction);
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValueOnce({ ...initial, revision: 4, workRevision: 2, phase: 'WAIT_COST' })
      .mockResolvedValueOnce(nextQuote).mockResolvedValueOnce({ ...initial, revision: 6, phase: 'EXEC' });
    render(<PlanningWorkflow {...props} automatic />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Chronological' }));
    expect(screen.getByText('2 / 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.keepEpisodeCount' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.keepDuration' }));
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.confirmDirection' }));
    await screen.findByText('director.planning.phase.EXEC');
    const calls = vi.mocked(executionApi.sendPlanningCommand).mock.calls;
    expect(calls.map(([, command]) => command.payload.type)).toEqual(['planning.decide', 'planning.quote', 'planning.grant']);
    expect(calls[1][1].expected.workflowRevision).toBe(4);
    expect(calls[1][1].expected.workRevision).toBe(2);
    expect(calls[2][1].expected.workflowRevision).toBe(5);
    expect(calls[2][1].expected.workRevision).toBe(2);
    expect(calls[0][1].payload).toMatchObject({ episodeCount: 1, durationSeconds: 30, answers: {} });
    expect(screen.queryByRole('button', { name: 'director.planning.grant' })).not.toBeInTheDocument();
  });

  it('keeps custom count and duration through three pages and submits them only once', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 3, phase: 'WAIT_DIRECTION', checkpoint: {
      id: 'cp-three-pages', kind: 'WAIT_DIRECTION', status: 'open', resumeToken: 'resume', payloadHash: 'a'.repeat(64),
      payload: { options: [{ id: 'd1', logline: 'Chronological', goal: 'Read', obstacle: 'Box', stakes: 'Missed message', tone: 'Warm', difference: 'One night', productionRisks: [] }],
        confirmedPreset: { episodeCount: 1, durationSeconds: 30 }, specQuestions: [] },
    } });
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue({ ...initial, revision: 4, workRevision: 2, phase: 'WAIT_COST' });
    render(<PlanningWorkflow {...props} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Chronological' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.changeEpisodeCount' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'director.episodeCount' }), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.continueQuestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.changeDuration' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'director.durationSeconds' }), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.previousQuestion' }));
    expect(screen.getByRole('spinbutton', { name: 'director.episodeCount' })).toHaveValue(3);
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.nextQuestion' }));
    expect(screen.getByRole('spinbutton', { name: 'director.durationSeconds' })).toHaveValue(45);
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.confirmDirection' }));
    await screen.findByText('director.planning.phase.WAIT_COST');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toMatchObject({
      decision: 'select', optionId: 'd1', episodeCount: 3, durationSeconds: 45, answers: {},
    });
    expect(executionApi.sendPlanningCommand).toHaveBeenCalledTimes(1);
  });

  it('follows a newly inserted quote card even without an execution-stream revision', async () => {
    const view = render(<ConversationScroll revision="unchanged"><p>Start</p></ConversationScroll>);
    const messages = view.container.querySelector('.dc-messages') as HTMLDivElement;
    Object.defineProperty(messages, 'scrollHeight', { configurable: true, value: 500 });
    view.rerender(<ConversationScroll revision="unchanged"><p>Start</p><p>Quote ready</p></ConversationScroll>);
    await waitFor(() => expect(messages.scrollTop).toBe(500));
  });

  it('GET does not send; explicit grant uses revision from quote without waiting for polling', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValueOnce(stageQuote).mockResolvedValueOnce({ ...initial, revision: 2, phase: 'EXEC' });
    render(<PlanningWorkflow {...props} />);
    await screen.findByText('director.planning.phase.NOT_STARTED');
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.quote' }));
    await screen.findByRole('button', { name: 'director.planning.grant' });
    expect(screen.getByRole('button', { name: 'director.planning.grant' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.grant' }));
    await screen.findByText('director.planning.phase.EXEC');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[1][1].expected.workflowRevision).toBe(1);
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('lost grant response is recovered using identical command and consent scope', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValueOnce(stageQuote).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValueOnce({ ...initial, revision: 2, phase: 'EXEC' });
    render(<PlanningWorkflow {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'director.planning.quote' }));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.grant' }));
    fireEvent.click(await screen.findByRole('button', { name: 'director.planning.retryIntent' }));
    await screen.findByText('director.planning.phase.EXEC');
    const calls = vi.mocked(executionApi.sendPlanningCommand).mock.calls;
    expect(calls[1][1]).toEqual(calls[2][1]);
  });

  it('does not default-select a direction; retains free text and explicit answers', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 3, phase: 'WAIT_DIRECTION', checkpoint: { id: 'cp', kind: 'WAIT_DIRECTION', status: 'open', resumeToken: 'resume', payloadHash: 'a'.repeat(64), payload: {
      options: [{ id: 'd1', logline: 'A visible choice', goal: 'Read', obstacle: 'Box', stakes: 'Missed message', tone: 'Warm', difference: 'Retrieve glasses', productionRisks: [] }], specQuestions: [{ id: 'q1', question: 'Who holds the key?' }],
    } } });
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue({ ...initial, revision: 4, phase: 'WAIT_COST' });
    render(<PlanningWorkflow {...props} />);
    const next = await screen.findByRole('button', { name: 'director.planning.continueQuestion' });
    expect(next).toBeDisabled();
    expect(screen.getByRole('radio')).not.toBeChecked();
    fireEvent.change(screen.getByRole('textbox', { name: 'director.planning.freeText' }), { target: { value: 'My own silent direction' } });
    expect(next).toBeEnabled();
    expect(screen.getByRole('button', { name: 'director.planning.previousQuestion' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.nextQuestion' }));
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'director.planning.nextQuestion' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Who holds the key?' }), { target: { value: 'Lin' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.previousQuestion' }));
    expect(screen.getByRole('textbox', { name: 'director.planning.freeText' })).toHaveValue('My own silent direction');
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.nextQuestion' }));
    expect(screen.getByRole('textbox', { name: 'Who holds the key?' })).toHaveValue('Lin');
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.confirmDirection' }));
    await screen.findByText('director.planning.phase.WAIT_COST');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toMatchObject({ decision: 'select', optionId: null, freeText: 'My own silent direction', answers: { q1: 'Lin' } });
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls).toHaveLength(1);
  });

  it('an unknown parent has no quote or automatic recovery action', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 4, phase: 'UNKNOWN', errorCode: 'STATUS_UNKNOWN' });
    render(<PlanningWorkflow {...props} />);
    await screen.findByText('director.planning.phase.UNKNOWN');
    expect(screen.queryByRole('button', { name: 'director.planning.quote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'director.planning.resume' })).not.toBeInTheDocument();
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
  });

  it('adaptation requests an outline-only budget rather than four preparation stages', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue(initial);
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue(stageQuote);
    render(<PlanningWorkflow {...props} work={{ ...work, mode: 'adaptation', preset: { ...preset, mode: 'adaptation' } }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'director.planning.quote' }));
    await screen.findByRole('checkbox');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toEqual({ type: 'planning.quote', targetScope: 'outline' });
    expect(screen.getByText('director.planning.adaptationScopeHint')).toBeInTheDocument();
  });

  it('suggested choices advance pages but final answer waits for explicit submission', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 3, phase: 'WAIT_DIRECTION', checkpoint: { id: 'cp', kind: 'WAIT_DIRECTION', status: 'open', resumeToken: 'resume', payloadHash: 'a'.repeat(64), payload: {
      options: [{ id: 'd1', logline: 'Chronological', goal: 'Read', obstacle: 'Box', stakes: 'Missed message', tone: 'Warm', difference: 'Retrieve glasses', productionRisks: [] }],
      specQuestions: [{ id: 'q1', question: 'Keep the gap?', choices: ['Preserve uncertainty', 'Propose a bridge'] }, { id: 'q2', question: 'Which ending?', choices: ['Original ending'] }],
    } } });
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue({ ...initial, revision: 4, phase: 'WAIT_COST' });
    render(<PlanningWorkflow {...props} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Chronological' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preserve uncertainty' }));
    expect(screen.getByRole('textbox', { name: 'Which ending?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Original ending' }));
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Which ending?' }), { target: { value: 'Keep ending without new actions' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.previousQuestion' }));
    expect(screen.getByRole('button', { name: 'Preserve uncertainty' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.continueQuestion' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.confirmDirection' }));
    await screen.findByText('director.planning.phase.WAIT_COST');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toMatchObject({ optionId: 'd1', answers: { q1: 'Preserve uncertainty', q2: 'Keep ending without new actions' } });
  });

  it('an outline-only checkpoint has no empty character or asset document tabs', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 9, phase: 'WAIT_OUTLINE', checkpoint: {
      id: 'cp-outline', kind: 'WAIT_OUTLINE', status: 'open', resumeToken: 'resume-outline', payloadHash: 'a'.repeat(64), payload: { documents: { outline: '# Proposed outline' } },
    } });
    render(<div className="dc-studio"><PlanningWorkflow {...props} /></div>);
    fireEvent.click(await screen.findByRole('button', { name: 'director.openDraft' }));
    await screen.findByRole('heading', { name: 'Proposed outline' });
    fireEvent.click(screen.getByRole('button', { name: 'director.close' }));
    expect(screen.queryByText('director.section.characters')).not.toBeInTheDocument();
    expect(screen.queryByText('director.section.scenes')).not.toBeInTheDocument();
    expect(screen.queryByText('director.section.props')).not.toBeInTheDocument();
    expect(screen.getByText('director.planning.outlineWait')).toBeInTheDocument();
    expect(screen.getByText('director.planning.outlineAdoptHint')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'director.planning.adopt' })).not.toBeInTheDocument();
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue({ ...initial, revision: 10, phase: 'READY' });
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.outlineAdopt' }));
    await screen.findByText('director.planning.phase.READY');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toMatchObject({ type: 'planning.decide', decision: 'adopt' });
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('retains a blocked outline but does not offer adoption as success', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 9, phase: 'WAIT_OUTLINE', checkpoint: {
      id: 'cp-outline', kind: 'WAIT_OUTLINE', status: 'open', resumeToken: 'resume-outline', payloadHash: 'a'.repeat(64),
      payload: { documents: { outline: '# Retained candidate' }, quality: { status: 'blocked',
        violatedPaths: ['overview.synopsis.0'], uncertainPaths: [], literaryNotes: [] } },
    } });
    render(<div className="dc-studio"><PlanningWorkflow {...props} /></div>);
    expect(await screen.findByRole('alert')).toHaveTextContent('director.planning.auditBlocked');
    expect(screen.getByRole('button', { name: 'director.planning.outlineAdopt' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.openDraft' }));
    expect(await screen.findByRole('heading', { name: 'Retained candidate' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'director.close' }));
    expect(screen.getByRole('button', { name: 'director.planning.skip' })).toBeEnabled();
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
  });

  it('previews documents in canvas order and adopts them with one explicit checkpoint command', async () => {
    vi.mocked(executionApi.getPlanningState).mockResolvedValue({ ...initial, revision: 9, phase: 'WAIT_OUTLINE', checkpoint: {
      id: 'cp-outline', kind: 'WAIT_OUTLINE', status: 'open', resumeToken: 'resume-outline', payloadHash: 'a'.repeat(64),
      payload: { documents: { characters: 'People', outline: 'Story', props: 'Objects', scenes: 'Places' } },
    } });
    vi.mocked(executionApi.sendPlanningCommand).mockResolvedValue({ ...initial, revision: 10, phase: 'READY' });
    const view = render(<PlanningWorkflow {...props} />);
    await screen.findByText('director.planning.phase.WAIT_OUTLINE');
    expect([...view.container.querySelectorAll('summary')].map((node) => node.textContent)).toEqual([
      'director.section.outline', 'director.section.characters', 'director.section.scenes', 'director.section.props',
    ]);
    expect(executionApi.sendPlanningCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.planning.adopt' }));
    await screen.findByText('director.planning.phase.READY');
    expect(vi.mocked(executionApi.sendPlanningCommand).mock.calls[0][1].payload).toMatchObject({
      type: 'planning.decide', decision: 'adopt', checkpointId: 'cp-outline', resumeToken: 'resume-outline', payloadHash: 'a'.repeat(64),
    });
    expect(executionApi.sendPlanningCommand).toHaveBeenCalledOnce();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });
});

describe('version-pinned private editor drafts', () => {
  const initial: directorApi.DirectorDocument = { doc_key: 'outline', document_id: 'document-one', version: 1,
    content: 'Original scene.', origin: 'user', created_at: 1 };
  const base = { project: 'synthetic', work, initial, currentVersion: 1, readOnly: false, busy: false, error: '', label: 'outline',
    onClose: vi.fn(), onSave: vi.fn(), onPropose: vi.fn() };

  it('keeps unsaved protection when a stream makes the open editor read-only', async () => {
    const close = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const ui = render(<DirectorDocumentEditor {...base} onClose={close} companionOpen />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.sourceView' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'director.documentBody' }), { target: { value: 'Unsaved line.' } });
    ui.rerender(<DirectorDocumentEditor {...base} onClose={close} readOnly companionOpen />);
    expect(screen.getByRole('dialog', { name: 'director.editor' })).toHaveAttribute('aria-modal', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'director.close' }));
    expect(confirm).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'director.documentBody' })).toHaveValue('Unsaved line.');
    confirm.mockRestore();
  });

  it('preserves input and pinned version when polling brings in a newer document', async () => {
    const save = vi.fn();
    const ui = render(<DirectorDocumentEditor {...base} onSave={save} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.sourceView' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'director.documentBody' }), { target: { value: 'My edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.save' }));
    expect(save).toHaveBeenCalledWith('My edit.', 1);
    ui.rerender(<DirectorDocumentEditor {...base} onSave={save} initial={{ ...initial, version: 2, content: 'Concurrent edit.' }} currentVersion={2} />);
    expect(screen.getByRole('textbox', { name: 'director.documentBody' })).toHaveValue('My edit.');
    expect(screen.getByRole('button', { name: 'director.save' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('director.editorDraft.stale');
  });

  it('private save is separate from formal save; ambiguous retry reuses its command', async () => {
    const privateDraft: directorApi.DirectorPrivateDraft = { documentId: 'document-one', clientDraftId: 'd', revision: 1, baseVersion: 1, text: 'Private edit.' };
    vi.mocked(directorApi.saveDirectorDraft).mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(privateDraft);
    const save = vi.fn();
    render(<DirectorDocumentEditor {...base} onSave={save} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.sourceView' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'director.documentBody' }), { target: { value: 'Private edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.editorDraft.savePrivate' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'director.editorDraft.savePrivate' }));
    await screen.findByText('director.editorDraft.saved');
    const calls = vi.mocked(directorApi.saveDirectorDraft).mock.calls;
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1].expected.documentVersions).toEqual({ 'document-one': 1 });
    expect(save).not.toHaveBeenCalled();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('old-version drafts stay readable but cannot silently overwrite a newer baseline', async () => {
    vi.mocked(directorApi.getCanonicalDocuments).mockResolvedValue({ schemaVersion: 2, workRevision: 1,
      documents: [{ documentId: 'document-one', docKey: 'outline', kind: 'outline', version: 1, content: initial.content, status: 'accepted', unsupportedBlockIds: [] }], episodes: [], artifacts: [] });
    vi.mocked(directorApi.listDirectorDrafts).mockResolvedValue([{ documentId: 'document-one', clientDraftId: 'old', revision: 2, baseVersion: 0, text: 'Retained old text.' }]);
    render(<DirectorDocumentEditor {...base} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.surface.sourceView' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.editorDraft.privateTitle' }));
    fireEvent.click(await screen.findByRole('button', { name: 'director.editorDraft.version' }));
    expect(screen.getByRole('textbox', { name: 'director.editorDraft.retained' })).toHaveValue('Retained old text.');
    expect(screen.getByRole('button', { name: 'director.editorDraft.restore' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'director.documentBody' })).toHaveValue(initial.content);
  });
});

describe('safe settings and episode revisions', () => {
  const impact: directorApi.RevisionImpact = {
    schemaVersion: 2, previewId: 'impact-one', previewHash: 'a'.repeat(64), workId: work.id, workRevision: 1,
    type: 'settings.preview', expiresAt: Date.now() / 1000 + 900, modelCalls: 0,
    changedFields: [{ field: 'episode_count', before: 3, after: 1 }], restartEpisode: 1,
    affectedEpisodes: [], restoredEpisodes: [], addedOrdinals: [], invalidatedReportIds: ['review'], invalidatedFinalizationIds: ['final'],
    archiveEpisodes: [
      { id: 'episode-two', docKey: 'episode-002', ordinal: 2, label: 'EP02', version: 2 },
      { id: 'episode-three', docKey: 'episode-003', ordinal: 3, label: 'EP03', version: 1 },
    ],
  };
  it('requires every archived episode and a reason; ambiguous retry keeps its intent', () => {
    const submit = vi.fn();
    render(<RevisionImpactDialog impact={impact} busy={false} error="" onClose={vi.fn()} onCommit={submit} />);
    const button = screen.getByRole('button', { name: 'director.revision.confirm' });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Remove these episodes from delivery; keep history.' } });
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[0]);
    expect(button).toBeDisabled();
    fireEvent.click(checks[1]);
    fireEvent.click(button); fireEvent.click(button);
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
    expect(submit.mock.calls[0][0].archiveEpisodeIds).toEqual(['episode-two', 'episode-three']);
    expect(submit.mock.calls[0][0].previewHash).toBe(impact.previewHash);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Different explicit handling evidence.' } });
    fireEvent.click(button);
    expect(submit.mock.calls[2][0].commandId).not.toBe(submit.mock.calls[0][0].commandId);
  });

  it('sends every visible preset value with canonical camelCase spelling', () => {
    const request = directorApi.settingsRevisionRequest(work, { title: work.title, brief: work.brief,
      preset: { ...preset, episode_count: 3, narrative_tone: 'warm', visual_style: 'ink', ending_type: 'closed' } });
    expect(request.payload.candidate.preset).toMatchObject({ episodeCount: 3, narrativeTone: 'warm', visualStyle: 'ink', endingType: 'closed' });
    expect(Object.keys(request.payload.candidate.preset).every((key) => !key.includes('_'))).toBe(true);
    expect(request.expectedWorkRevision).toBe(work.revision);
  });

  it('keeps immutable source read-only while allowing reviewable creative settings', () => {
    render(<DirectorPresetDialog sourceLocked draft={{ title: 'Synthetic', brief: 'A box.', sourceText: 'Original text', sourceFileName: '',
      preset: { ...preset, mode: 'adaptation', adapt_direction: 'condense' } }} onClose={vi.fn()} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    expect(screen.getByRole('button', { name: 'director.original' })).toBeDisabled();
    expect(screen.getByLabelText('director.sourceText')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('director.spec.narrativeTone')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'director.revision.preview' })).toBeEnabled();
  });

  it('opens an actual impact preview for settings on a finalized work', async () => {
    const complete = { ...work, status: 'completed' };
    vi.mocked(directorApi.listDirectorWorks).mockResolvedValue([complete]);
    vi.mocked(directorApi.getDirectorWork).mockResolvedValue({ work: complete, documents: [], changes: [], runs: [] });
    vi.mocked(directorApi.previewSettingsRevision).mockResolvedValue(impact);
    render(<DirectorStudio project="synthetic" />);
    await screen.findByText('director.workStatus.completed', { exact: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'director.presetTitle' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.change(screen.getByLabelText('director.spec.narrativeTone'), { target: { value: 'Warm and restrained' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.revision.preview' }));
    await screen.findByRole('dialog', { name: 'director.revision.title' });
    expect(directorApi.previewSettingsRevision).toHaveBeenCalledWith('synthetic', complete,
      expect.objectContaining({ preset: expect.objectContaining({ narrative_tone: 'Warm and restrained' }) }));
    expect(directorApi.commitDirectorRevision).not.toHaveBeenCalled();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });
});

describe('independent quality gate', () => {
  const report: directorApi.DirectorQualityReport = {
    doc_key: 'episode-001', version: 2, schemaVersion: 2, contentHash: 'a'.repeat(64), productionReady: false,
    blockers: [], warnings: [], ready_for_human_review: true,
    requiredHumanChecks: ['literary_confirmation', 'production_unverified', 'timing'],
    review: { id: 'report-one', reportHash: 'b'.repeat(64), status: 'PASS', reviewerRunId: 'review-run', checks: [] },
  };
  it('shows local retained-output failures without another model call or allowing finalize', () => {
    const submit = vi.fn();
    render(<QualityReviewDialog work={work} ordinal={1} busy={false} error="" onClose={vi.fn()} onReview={vi.fn()} onConfirm={submit}
      report={{ ...report, blockers: ['REVIEW_FAILED'], ready_for_human_review: false,
        review: { ...report.review!, status: 'UNAVAILABLE' },
        retainedValidation: { status: 'FAIL', sourceReportId: 'report-one', checks: [{ id: 'causality', status: 'FAIL', explanation: 'The box-to-glasses action is missing.', suggestion: 'Show the transfer.', evidence: [] }] },
      }} />);
    expect(screen.getByRole('region', { name: 'director.review.retainedValidation' })).toBeTruthy();
    expect(screen.getByText('The box-to-glasses action is missing.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'director.confirmFinalize' }).hasAttribute('disabled')).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });
  it('requires separate evidence and retries an ambiguous finalize with the same intent', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<QualityReviewDialog work={work} ordinal={1} report={report} busy={false} error="" onClose={vi.fn()} onReview={vi.fn()} onConfirm={submit} />);
    const confirm = screen.getByRole('button', { name: 'director.confirmFinalize' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    for (const id of report.requiredHumanChecks) fireEvent.change(screen.getByLabelText(`director.review.checks.${id}`), { target: { value: `Verified Scene 1 for ${id}.` } });
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    fireEvent.click(confirm);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[0][0]).toEqual(submit.mock.calls[1][0]);
    expect(submit.mock.calls[0][0]).toMatchObject({ documentVersion: 2, reportId: 'report-one', contentHash: report.contentHash });
    expect(submit.mock.calls[0][0].humanChecks[1].conclusion).toBe('literary_only');
    expect(submit.mock.calls[0][0].humanChecks[0].conclusion).toBe('verified');
  });
  it('failed review cannot be confirmed, and requesting review is not authorization', () => {
    const review = vi.fn();
    const submit = vi.fn();
    render(<QualityReviewDialog work={work} ordinal={1} report={{ ...report, blockers: ['REVIEW_FAILED'], ready_for_human_review: false,
      review: { ...report.review!, status: 'FAIL' } }} busy={false} error="" onClose={vi.fn()} onReview={review} onConfirm={submit} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'director.confirmFinalize' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'director.review.run' }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });
});

describe('canonical document upgrade', () => {
  const preview: directorApi.LegacyImportPreview = {
    schemaVersion: 2, workId: work.id, workRevision: 1, sourceHash: 'a'.repeat(64), previewHash: 'b'.repeat(64),
    documentMap: [{ docKey: 'episode-001', documentId: 'stable-document', version: 2 }],
    versionCount: 2, historicalConfirmationCount: 1, warnings: ['LEGACY_REVIEW_REQUIRED'], modelCalls: 0,
  };
  it('opening and cancelling upgrade never commits or runs a model', async () => {
    vi.mocked(directorApi.getCanonicalDocuments).mockResolvedValue({ schemaVersion: 1, workRevision: 1, documents: [], episodes: [], artifacts: [] });
    vi.mocked(directorApi.previewLegacyImport).mockResolvedValue(preview);
    render(<DocumentVersionPanel project="synthetic" workId={work.id} revision={1} docKey="outline" onImported={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'director.documents.previewImport' }));
    await screen.findByRole('dialog', { name: 'director.documents.previewImport' });
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    expect(directorApi.commitLegacyImport).not.toHaveBeenCalled();
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });
  it('retries an interrupted explicit import with exactly the original intent', async () => {
    vi.mocked(directorApi.getCanonicalDocuments).mockResolvedValue({ schemaVersion: 1, workRevision: 1, documents: [], episodes: [], artifacts: [] });
    vi.mocked(directorApi.previewLegacyImport).mockResolvedValue(preview);
    vi.mocked(directorApi.commitLegacyImport).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    const imported = vi.fn().mockResolvedValue(undefined);
    render(<DocumentVersionPanel project="synthetic" workId={work.id} revision={1} docKey="outline" onImported={imported} />);
    fireEvent.click(await screen.findByRole('button', { name: 'director.documents.previewImport' }));
    fireEvent.click(await screen.findByRole('button', { name: 'director.documents.confirmImport' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'director.documents.confirmImport' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'director.documents.confirmImport' }));
    await waitFor(() => expect(imported).toHaveBeenCalledOnce());
    const calls = vi.mocked(directorApi.commitLegacyImport).mock.calls;
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1].payload.previewHash).toBe(preview.previewHash);
  });
});

describe('execution controls', () => {
  it('labels prop runs with the existing translated document name, preserving submitted keys', () => {
    const props = { ...run('succeeded'), docKey: 'props', parameters: { doc_key: 'props', output_contract: 'prop-design/1.0.0' } };
    render(<ExecutionHistory runs={[props]} busy={false} onAction={vi.fn()} />);
    expect(screen.getByText('director.run · director.section.props')).toBeVisible();
    expect(screen.getByText('prop-design/1.0.0')).toBeInTheDocument();
    expect(props.parameters.doc_key).toBe('props');
  });

  it('never presents an unknown billable task as retryable or free', () => {
    const action = vi.fn();
    render(<ExecutionHistory runs={[run('unknown')]} busy={false} onAction={action} />);
    expect(screen.getByText(/director.execution.costUnknown/)).toBeTruthy();
    expect(screen.getByText('director.execution.reconciliationHint')).toBeTruthy();
    expect(screen.queryByText('director.execution.resumeQueued')).toBeNull();
    expect(screen.queryByText('director.execution.stop')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it('resume is a queued intent, not a new generate request', () => {
    const action = vi.fn();
    const queued = run('queued');
    render(<ExecutionHistory runs={[queued]} busy={false} onAction={action} />);
    fireEvent.click(screen.getByText('director.execution.resumeQueued'));
    expect(action).toHaveBeenCalledWith(queued, 'run.resume');
    expect(isExecutionActive(queued)).toBe(true);
    expect(isExecutionActive(run('unknown'))).toBe(true);
    expect(isExecutionActive(run('succeeded'))).toBe(false);
  });

  it('keeps intent IDs separate for identical user requests', () => {
    const payload = { type: 'cost.quote' as const, kind: 'outline' as const, instruction: 'Keep the key', maxOutputTokens: 1024 };
    const first = executionCommand(work.id, 3, 'outline', 2, capabilities.version, payload);
    const second = executionCommand(work.id, 3, 'outline', 2, capabilities.version, payload);
    expect(first.commandId).not.toBe(second.commandId);
    expect(first.commandId).toBe(first.clientRequestId);
    expect(first.expected).toEqual({ workRevision: 3, documentVersions: { outline: 2 }, capabilityVersion: capabilities.version });
  });
});

describe('studio uses durable authorization', () => {
  it('reads outline evidence without a paid call and quotes a separate explicit review', async () => {
    vi.mocked(directorApi.getDirectorDocument).mockResolvedValue({ doc_key: 'outline', version: 1, content: 'A story.', origin: 'manual', created_at: 0 });
    vi.mocked(directorApi.getOutlineQualityReport).mockResolvedValue({ docKey: 'outline', documentVersion: 1,
      contentHash: 'a'.repeat(64), review: null, requiresHumanReview: true, productionReady: false });
    vi.mocked(executionApi.sendExecutionCommand).mockResolvedValue({ ...quoted, parameters: { purpose: 'review', review_kind: 'outline' } });
    render(<DirectorStudio project="synthetic" />);
    const button = await screen.findByRole('button', { name: 'director.outlineReview.title' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'director.outlineReview.title' });
    expect(directorApi.getOutlineQualityReport).toHaveBeenCalledWith('synthetic', work.id);
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'director.review.run' }));
    await screen.findByRole('dialog', { name: 'director.parameterReview' });
    expect(vi.mocked(executionApi.sendExecutionCommand).mock.calls[0][1].payload).toEqual({
      type: 'cost.quote', kind: 'outline', instruction: '', purpose: 'review',
    });
    expect(screen.getByRole('button', { name: 'director.review.confirm' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    expect(executionApi.sendExecutionCommand).toHaveBeenCalledTimes(1);
  });

  it('shows a failed outline finding and its exact evidence without a finalize button', () => {
    const review = vi.fn();
    render(<OutlineReviewDialog report={{ docKey: 'outline', documentVersion: 1, contentHash: 'a'.repeat(64),
      requiresHumanReview: true, productionReady: false, review: { id: 'report', reportHash: 'b'.repeat(64), reviewerRunId: 'run', status: 'FAIL',
        coverage: { expected: 6, valid: 5, semanticCompletenessVerified: false },
        obligations: [{ id: 'obligation-001', text: 'A real consequence must occur.', sourceRefs: [{ inputId: 'brief', start: 0, end: 30 }] }],
        checks: [{ id: 'obligation-001', status: 'VIOLATED', explanation: 'Risk is not an actual loss.', suggestion: 'Make a consequence occur.',
          evidence: [{ inputId: 'story-001', quote: 'She might lose her bonus.', start: 4, end: 29, quoteHash: 'c'.repeat(64) }] }],
      } }} canRun={false} onClose={vi.fn()} onReview={review} />);
    expect(screen.getByText('She might lose her bonus.')).toBeTruthy();
    expect(screen.getByText('Risk is not an actual loss.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'director.review.run' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'director.finalizeEpisode' })).toBeNull();
    expect(review).not.toHaveBeenCalled();
  });

  it('reads a retained failed result without new approval or adoption', async () => {
    const retained = run('failed');
    retained.response = { output_sha256: 'f'.repeat(64), output_chars: 20 };
    vi.mocked(executionApi.listExecutionRuns).mockResolvedValue([retained]);
    vi.mocked(executionApi.getRetainedResult).mockResolvedValue({ runId: retained.id, status: 'failed', output: 'Truncated model text', outputHash: 'f'.repeat(64), readOnly: true });
    render(<DirectorStudio project="synthetic" />);
    fireEvent.click(await screen.findByRole('button', { name: 'director.execution.viewResult' }));
    const textbox = await screen.findByRole('textbox', { name: 'director.execution.retainedText' });
    expect(textbox.getAttribute('readonly')).not.toBeNull();
    expect((textbox as HTMLTextAreaElement).value).toBe('Truncated model text');
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
    expect(executionApi.getRetainedResult).toHaveBeenCalledWith('synthetic', work.id, retained.id);
  });

  it('explains structural failures without offering adoption or automatic re-dispatch', () => {
    const failed = run('failed');
    failed.errorCode = 'PLANNING_OUTPUT_INVALID';
    failed.response.validation = { kind: 'schema', issueCount: 2, issues: [
      { path: 'segments.2.carryIn', code: 'missing' },
      { path: 'whyWatch.0.reasonId', code: 'extra_forbidden' },
    ] };
    const action = vi.fn();
    render(<ExecutionHistory runs={[failed]} busy={false} onAction={action} />);
    expect(screen.getByText('segments.2.carryIn')).toBeInTheDocument();
    expect(screen.getByText('extra_forbidden')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'director.execution.resumeQueued' })).not.toBeInTheDocument();
    expect(action).not.toHaveBeenCalled();
  });
  it('shows nested scene parameters literally and cancels without granting approval', async () => {
    const root = { episodes: [{ id: 'episode-a', deliveryLabel: 'EP02' }] };
    vi.mocked(executionApi.sendExecutionCommand).mockResolvedValueOnce({ ...quoted, docKey: 'scenes', parameters: { ...quoted.parameters, sceneRoot: root, response_format: { type: 'json_object' } } });
    render(<DirectorStudio project="synthetic" />);
    const button = await screen.findByRole('button', { name: 'director.send' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'director.parameterReview' });
    const technical = screen.getByText('sceneRoot').closest('details')!;
    expect(technical).not.toHaveAttribute('open');
    expect(JSON.parse(technical.querySelector('pre')!.textContent!)).toEqual(root);
    expect(JSON.parse(screen.getByText('response_format').closest('details')!.querySelector('pre')!.textContent!)).toEqual({ type: 'json_object' });
    expect(screen.queryByText('[object Object]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    expect(executionApi.sendExecutionCommand).toHaveBeenCalledTimes(1);
  });

  it('previews the actual limit and requires consent; failed transport reuses the same approval intent', async () => {
    // An obsolete browser preference must never silently truncate new writing.
    localStorage.setItem('director:ui:outputTokens', '1024');
    const send = vi.mocked(executionApi.sendExecutionCommand);
    send.mockResolvedValueOnce(quoted).mockRejectedValueOnce(new Error('Temporary connection loss')).mockResolvedValueOnce(run('queued'));
    render(<DirectorStudio project="synthetic" />);
    const button = await screen.findByRole('button', { name: 'director.send' });
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'director.parameterReview' });
    expect(send.mock.calls[0][1].payload).toEqual({ type: 'cost.quote', kind: 'outline', instruction: '', purpose: 'draft' });
    const confirm = screen.getByRole('button', { name: 'director.confirmGeneration' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    await screen.findByText('Temporary connection loss');
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[1][1]).toEqual(send.mock.calls[2][1]);
    expect(send.mock.calls[1][1].payload).toEqual({ type: 'approval.grant', quoteId: quoted.quoteId, requestHash: quoted.requestHash, unknownCostConsent: true });
    await screen.findByText('director.execution.status.queued');
    expect(screen.queryByRole('dialog', { name: 'director.parameterReview' })).toBeNull();
  });

  it('refresh reads an unknown task and blocks sending without issuing any command', async () => {
    vi.mocked(executionApi.listExecutionRuns).mockResolvedValue([run('unknown')]);
    render(<DirectorStudio project="synthetic" />);
    await screen.findByText('director.execution.status.unknown');
    expect(screen.getByRole('button', { name: 'director.send' }).hasAttribute('disabled')).toBe(true);
    expect(executionApi.sendExecutionCommand).not.toHaveBeenCalled();
  });

  it('switching to a new conversation discards a late preview without authorizing it', async () => {
    let resolve: (value: executionApi.ExecutionQuote) => void = () => {};
    vi.mocked(executionApi.sendExecutionCommand).mockImplementation(() => new Promise((done) => { resolve = done; }));
    render(<DirectorStudio project="synthetic" />);
    const send = await screen.findByRole('button', { name: 'director.send' });
    await waitFor(() => expect(send.hasAttribute('disabled')).toBe(false));
    fireEvent.click(send);
    fireEvent.click(screen.getByRole('button', { name: 'director.newConversation' }));
    await act(async () => resolve(quoted));
    expect(screen.queryByRole('dialog', { name: 'director.parameterReview' })).toBeNull();
    expect(executionApi.sendExecutionCommand).toHaveBeenCalledTimes(1);
  });
});

describe('preset confirmation boundary', () => {
  const draft = { title: 'Original title', brief: 'A key', sourceText: '', sourceFileName: '', preset };

  it('cancel and Escape do not mutate the parent draft', () => {
    const close = vi.fn();
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={close} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.change(screen.getByLabelText('director.workTitle'), { target: { value: 'Provisional title' } });
    fireEvent.change(screen.getByLabelText('director.episodeCount'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
    expect(draft.title).toBe('Original title');
    expect(draft.preset.episode_count).toBe(1);
  });

  it('confirm sends the current isolated draft, not stale parent props', () => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.change(screen.getByLabelText('director.workTitle'), { target: { value: 'Confirmed title' } });
    fireEvent.change(screen.getByLabelText('director.durationSeconds'), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    expect(confirm).toHaveBeenCalledWith({ ...draft, title: 'Confirmed title', preset: {
      ...preset, duration_seconds: 45, narrative_tone: '', ending_type: 'closed',
      output_language: 'zh-CN', market: 'unspecified', fidelity: 'strict', locked_facts: '', allowed_additions: '',
    } });
    expect(draft.preset.duration_seconds).toBe(30);
  });

  it('keeps style, narrative, source identity and delivery identity independent', () => {
    const confirm = vi.fn();
    render(<DirectorPresetDialog draft={draft} onClose={vi.fn()} onConfirm={confirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'director.ui.advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'director.adaptation' }));
    const inputs: Record<string, string> = {
      'director.visualStyle': 'ink', 'director.spec.narrativeTone': 'dry comedy',
      'director.spec.endingType': 'reversal', 'director.spec.language': 'en',
      'director.spec.market': 'global', 'director.spec.fidelity': 'approved_changes',
      'director.spec.lockedFacts': 'Keep the red key', 'director.spec.allowedAdditions': 'Only weather',
      'director.sourceEpisodeLabel': 'EP02', 'director.spec.deliveryLabel': 'Pilot',
      'director.structure.label': 'nonlinear',
    };
    for (const [label, value] of Object.entries(inputs)) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'director.confirm' }));
    expect(confirm.mock.calls[0][0].preset).toMatchObject({
      visual_style: 'ink', narrative_tone: 'dry comedy', ending_type: 'reversal', output_language: 'en',
      market: 'global', fidelity: 'approved_changes', locked_facts: 'Keep the red key', allowed_additions: 'Only weather',
      source_episode_label: 'EP02', delivery_episode_label: 'Pilot', structure: 'nonlinear', mode: 'adaptation',
    });
    expect(draft.preset.source_episode_label).toBe('');
  });
});
