// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { getExecutionEvents, type ExecutionEvent } from '@/api/director-execution';

export interface RunPreview { text: string; method?: ExecutionEvent['payload']; model?: ExecutionEvent['payload'];
  sections?: Record<string, { section: string; text: string }> }
export interface StreamState { cursor: number; runs: Record<string, RunPreview> }
export const emptyStream = (): StreamState => ({ cursor: 0, runs: {} });

/** Replayed GET pages must never submit an intent, duplicate text or adopt it. */
export function reduceExecutionEvents(state: StreamState, events: ExecutionEvent[]): StreamState {
  const next = { cursor: state.cursor, runs: { ...state.runs } };
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.seq <= next.cursor) continue;
    next.cursor = event.seq;
    if (!event.runId || !['text.delta', 'method.loaded', 'model.started', 'outline.section.preview'].includes(event.type)) continue;
    const run = { ...(next.runs[event.runId] ?? { text: '' }) };
    if (event.type === 'text.delta' && typeof event.payload.text === 'string') run.text += event.payload.text;
    if (event.type === 'method.loaded') run.method = event.payload;
    if (event.type === 'model.started') run.model = event.payload;
    if (event.type === 'outline.section.preview' && event.payload.provisional === true &&
      typeof event.payload.blockKey === 'string' && typeof event.payload.text === 'string' &&
      ['direction', 'questions', 'overview', 'adaptation', 'chapters', 'hooks', 'boundaries'].includes(event.payload.sectionKey ?? '')) {
      run.sections = { ...run.sections, [event.payload.blockKey]: { section: event.payload.sectionKey!, text: event.payload.text } };
    }
    next.runs[event.runId] = run;
  }
  return next;
}

export function useExecutionStream(project: string, workId: string | undefined, activeRun: boolean) {
  const scope = `${project}:${workId ?? ''}`;
  const active = useRef(activeRun);
  active.current = activeRun;
  const [snapshot, setSnapshot] = useState({ scope, state: emptyStream(), reconnecting: false });
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false, state = emptyStream(), failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot({ scope, state, reconnecting: false });
    if (!workId) return () => controller.abort();
    const poll = async () => {
      let delay = active.current ? 350 : 2000;
      try {
        const page = await getExecutionEvents(project, workId, state.cursor, controller.signal);
        if (disposed) return;
        state = reduceExecutionEvents(state, page.events);
        failures = 0;
        setSnapshot({ scope, state, reconnecting: false });
        if (page.events.length === 200) delay = 0;
      } catch {
        if (disposed) return;
        failures += 1;
        delay = Math.min(10000, 500 * 2 ** Math.min(failures, 5));
        setSnapshot({ scope, state, reconnecting: true });
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), delay);
      }
    };
    void poll();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [project, workId, scope]);
  // Do not show the old work for the render before effect cleanup.
  return snapshot.scope === scope ? snapshot : { scope, state: emptyStream(), reconnecting: false };
}
