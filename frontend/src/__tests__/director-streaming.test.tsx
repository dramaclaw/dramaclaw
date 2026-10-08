// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyStream, reduceExecutionEvents, useExecutionStream } from '@/features/director/useExecutionStream';
import { ConversationScroll, DirectorConversation } from '@/features/director/components/DirectorConversation';
import { getExecutionEvents, type ExecutionEvent, type ExecutionRun } from '@/api/director-execution';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/api/director-execution', () => ({ getExecutionEvents: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });
const delta = (seq: number, text: string, runId = 'r1'): ExecutionEvent => ({ seq, eventId: `e${seq}`, type: 'text.delta', sessionId: 's', runId, payload: { text }, createdAt: 0 });

it('replays ordered deltas once, separating runs and preserving Unicode', () => {
  const first = reduceExecutionEvents(emptyStream(), [delta(2, '界'), delta(1, '世')]);
  const next = reduceExecutionEvents(first, [delta(2, '界'), delta(3, '!'), delta(4, 'Other', 'r2')]);
  expect(next.runs.r1.text).toBe('世界!');
  expect(next.runs.r2.text).toBe('Other');
  expect(next.cursor).toBe(4);
});

it('replaces provisional structured fields on replay without exposing raw JSON', () => {
  const part = (seq: number, text: string): ExecutionEvent => ({ ...delta(seq, text), type: 'outline.section.preview',
    payload: { text, provisional: true, blockKey: 'overview.logline.text', sectionKey: 'overview' } });
  const first = reduceExecutionEvents(emptyStream(), [part(1, '草稿'), part(2, '草稿内容')]);
  const next = reduceExecutionEvents(first, [part(2, '草稿内容'), part(3, '草稿内容。')]);
  expect(next.runs.r1.text).toBe('');
  expect(next.runs.r1.sections).toEqual({ 'overview.logline.text': { section: 'overview', text: '草稿内容。' } });
});

it('shows first direction and question fields as provisional stream, excluding private ids', () => {
  const run: ExecutionRun = { id: 'r1', workId: 'w', sessionId: 's', revision: 1,
    status: 'dispatching', requestHash: 'a'.repeat(64), docKey: 'outline', parameters: { stage: 'M03' },
    limits: { maxAttempts: 1, maxOutputTokens: 4096, inputChars: 10, timeoutSeconds: 300 },
    errorCode: null, changeId: null, createdAt: 0, updatedAt: 0, response: {},
    cost: { status: 'unknown', estimateMinor: null, reservedMinor: null, actualMinor: null,
      currency: null, maxOutputTokens: 4096, actualOutputTokens: null },
    canResume: false, canCancel: true, requiresReconciliation: false };
  const event = (seq: number, blockKey: string, sectionKey: string, text: string): ExecutionEvent => ({
    ...delta(seq, text), type: 'outline.section.preview',
    payload: { blockKey, sectionKey, text, provisional: true },
  });
  const stream = reduceExecutionEvents(emptyStream(), [
    event(1, 'options.0.logline', 'direction', '曹操在盟约和生存间抉择'),
    event(2, 'specQuestions.0.question', 'questions', '史实边界？'),
    event(3, 'options.0.id', 'private', 'secret-id'),
  ]);
  expect(stream.runs.r1.sections?.['options.0.id']).toBeUndefined();
  render(<DirectorConversation runs={[run]} previews={stream.runs} busy={false}
    onAction={vi.fn()} onViewResult={vi.fn()} onRefine={vi.fn()} />);
  expect(screen.getByText('director.stream.directionPreview')).toBeVisible();
  expect(screen.getByText('曹操在盟约和生存间抉择')).toBeVisible();
  expect(screen.getByText('史实边界？')).toBeVisible();
  expect(screen.queryByText('secret-id')).not.toBeInTheDocument();
});

it('labels outline streams separately from episode streams', () => {
  const run: ExecutionRun = { id: 'r1', workId: 'w', sessionId: 's', revision: 1,
    status: 'dispatching', requestHash: 'a'.repeat(64), docKey: 'outline', parameters: { stage: 'M14' },
    limits: { maxAttempts: 1, maxOutputTokens: 4096, inputChars: 10, timeoutSeconds: 300 },
    errorCode: null, changeId: null, createdAt: 0, updatedAt: 0, response: {},
    cost: { status: 'unknown', estimateMinor: null, reservedMinor: null, actualMinor: null,
      currency: null, maxOutputTokens: 4096, actualOutputTokens: null },
    canResume: false, canCancel: true, requiresReconciliation: false };
  const stream = reduceExecutionEvents(emptyStream(), [{ ...delta(1, 'Draft'), type: 'outline.section.preview',
    payload: { text: 'Draft', provisional: true, blockKey: 'overview.logline.text', sectionKey: 'overview' } }]);
  render(<DirectorConversation runs={[run]} previews={stream.runs} busy={false}
    onAction={vi.fn()} onViewResult={vi.fn()} onRefine={vi.fn()} />);
  expect(screen.getByText('director.stream.outlinePreview')).toBeVisible();
  expect(screen.queryByText('director.stream.preview')).not.toBeInTheDocument();
  expect(screen.getByText('Draft')).toBeVisible();
});

it('ignores a late response after switching works and aborts the old read', async () => {
  let oldResolve!: (value: { schemaVersion: 2; events: ExecutionEvent[]; nextSeq: number }) => void;
  vi.mocked(getExecutionEvents).mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; }))
    .mockResolvedValue({ schemaVersion: 2, events: [delta(1, 'new')], nextSeq: 1 });
  const { result, rerender } = renderHook(({ id }) => useExecutionStream('p', id, true), { initialProps: { id: 'old' } });
  rerender({ id: 'new' });
  await waitFor(() => expect(result.current.state.runs.r1.text).toBe('new'));
  await act(async () => oldResolve({ schemaVersion: 2, events: [delta(1, 'OLD')], nextSeq: 1 }));
  expect(result.current.state.runs.r1.text).toBe('new');
  expect(vi.mocked(getExecutionEvents).mock.calls[0][3]?.aborted).toBe(true);
});

it('drains full pages and reconnects using the last durable cursor', async () => {
  vi.useFakeTimers();
  const page = Array.from({ length: 200 }, (_, i) => delta(i + 1, 'a'));
  vi.mocked(getExecutionEvents).mockResolvedValueOnce({ schemaVersion: 2, events: page, nextSeq: 200 })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ schemaVersion: 2, events: [delta(201, 'b')], nextSeq: 201 });
  const { result } = renderHook(() => useExecutionStream('p', 'w', true));
  await act(async () => { await vi.advanceTimersByTimeAsync(5); });
  expect(result.current.reconnecting).toBe(true);
  expect(result.current.state.runs.r1.text.length).toBe(200);
  await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
  expect(result.current.reconnecting).toBe(false);
  expect(result.current.state.runs.r1.text).toBe('a'.repeat(200) + 'b');
  expect(vi.mocked(getExecutionEvents).mock.calls[2][2]).toBe(200);
});

it('does not pull the reader down when they are inspecting earlier passages', () => {
  const { container, rerender } = render(<ConversationScroll revision={1}>First</ConversationScroll>);
  const viewport = container.querySelector('.dc-messages')!;
  Object.defineProperties(viewport, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  rerender(<ConversationScroll revision={2}>Second</ConversationScroll>);
  expect(viewport.scrollTop).toBe(200);
  fireEvent.click(screen.getByRole('button', { name: 'director.stream.latest' }));
  expect(viewport.scrollTop).toBe(1000);
});
