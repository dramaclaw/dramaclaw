// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectorWork } from '@/api/director';
import { ApiError } from '@/api/client';
import { ChevronDown } from './DirectorReferenceIcon';
import { DirectorRichText } from './DirectorRichText';
import { createPortal } from 'react-dom';
import { getPlanningState, sendPlanningCommand, type ExecutionCapability, type PlanningCommand,
  type PlanningPayload, type PlanningQuote, type PlanningState } from '@/api/director-execution';

interface Props {
  project: string; work: DirectorWork; capability: ExecutionCapability | null;
  hasDocuments: boolean; onChanged: (workId: string) => void;
  onState: (phase: PlanningState['phase']) => void;
  quoteAction: MutableRefObject<(() => void) | null>;
  automatic?: boolean;
  autoQuote?: boolean;
  onAutoQuoteStarted?: () => void;
  onPreviewState?: (open: boolean) => void;
  onConversation?: () => void;
  onPipeline?: (active: boolean) => void;
}

export function PlanningWorkflow({ project, work, capability, hasDocuments, onChanged, onState, quoteAction, automatic = false, autoQuote, onAutoQuoteStarted, onPreviewState, onConversation, onPipeline }: Props) {
  const { t } = useTranslation();
  const targetScope = work.mode === 'adaptation' ? 'outline' : 'preparation';
  const [state, setState] = useState<PlanningState | null>(null);
  const [quote, setQuote] = useState<PlanningQuote | null>(null);
  const [consent, setConsent] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [episodeCountAnswer, setEpisodeCountAnswer] = useState('');
  const [durationAnswer, setDurationAnswer] = useState('');
  const [customEpisodeCount, setCustomEpisodeCount] = useState(false);
  const [customDuration, setCustomDuration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);
  const [revisionRequest, setRevisionRequest] = useState('');
  const host = useRef<HTMLElement>(null);
  useEffect(() => { onPreviewState?.(draftOpen); return () => onPreviewState?.(false); }, [draftOpen, onPreviewState]);
  useEffect(() => { if (state?.phase !== 'WAIT_OUTLINE') setDraftOpen(false); }, [state?.phase]);
  const sourceBound = Boolean(state?.artifacts.M04);
  useEffect(() => { onPipeline?.(sourceBound); return () => onPipeline?.(false); }, [sourceBound, onPipeline]);
  const pending = useRef<PlanningCommand | null>(null);
  const pendingAdvance = useRef(false);
  const autoQuoteIssued = useRef(false);
  const alive = useRef(true);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    alive.current = true;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getPlanningState(project, work.id);
        if (!active) return;
        setState(next); onStateRef.current(next.phase);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => { active = false; alive.current = false; if (timer) clearTimeout(timer); };
  }, [project, work.id]);

  const perform = useCallback(async (payload?: PlanningPayload, advance = false) => {
    if (busy || !state || !capability) return;
    // A lost HTTP response must retry the exact intent, even if polling has
    // since brought in a newer server revision. Do not guess it was unsent.
    const makeIntent = (nextPayload: PlanningPayload, workflowRevision: number, workRevision = work.revision): PlanningCommand => ({
      schemaVersion: 2 as const, commandId: crypto.randomUUID(), clientRequestId: crypto.randomUUID(),
      sessionId: `work-${work.id}`, workId: work.id,
      expected: { workRevision, workflowRevision, capabilityVersion: capability.version }, payload: nextPayload,
    });
    let intent = pending.current ?? (payload ? makeIntent(payload, state.revision) : null);
    if (!intent) return;
    let currentWorkRevision = intent.expected.workRevision;
    pendingAdvance.current = pending.current ? pendingAdvance.current : advance;
    pending.current = intent;
    setBusy(true); setError('');
    try {
      // Each explicit Send/answer may authorize one bounded budget group. The
      // quote remains a server-side scope fence; it is not a second UI gate.
      for (let step = 0; step < 3; step += 1) {
        const result = await sendPlanningCommand(project, intent);
        if (!alive.current) return;
        pending.current = null;
        if ('quoteId' in result) {
          setQuote(pendingAdvance.current ? null : result); setConsent(false);
          setState((prior) => prior ? { ...prior, revision: result.workflowRevision, phase: 'WAIT_COST' } : prior);
          onStateRef.current('WAIT_COST');
          if (!pendingAdvance.current) break;
          intent = makeIntent({ type: 'planning.grant', quoteId: result.quoteId, planHash: result.planHash,
            unknownCostConsent: true }, result.workflowRevision, currentWorkRevision);
          pending.current = intent;
          continue;
        }
        setState(result); onStateRef.current(result.phase); setQuote(null); onChanged(work.id);
        if (!pendingAdvance.current || result.phase !== 'WAIT_COST' || intent.payload.type === 'planning.grant') break;
        currentWorkRevision = result.workRevision ?? currentWorkRevision;
        intent = makeIntent({ type: 'planning.quote', targetScope }, result.revision, currentWorkRevision);
        pending.current = intent;
      }
      if (!pending.current) pendingAdvance.current = false;
    } catch (reason) {
      if (alive.current) {
        const code = reason instanceof ApiError ? (reason.body as { detail?: { code?: string } } | undefined)?.detail?.code : undefined;
        // A server's explicit 4xx rejection has no ambiguous acceptance. Only
        // transport failures retain an intent for exact replay.
        if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
          pending.current = null; pendingAdvance.current = false; setQuote(null); setConsent(false);
        }
        setError(code ? t(`director.execution.errors.${code}`, { defaultValue: code }) : reason instanceof Error ? reason.message : String(reason));
      }
    } finally { if (alive.current) setBusy(false); }
  }, [busy, state, capability, work.id, work.revision, project, onChanged, t, targetScope]);

  const canQuote = Boolean(state && ['NOT_STARTED', 'WAIT_COST', 'FAILED_RECOVERABLE', 'CANCELLED'].includes(state.phase) && !['PLANNING_INPUT_CHANGED', 'SNAPSHOT_CORRUPT'].includes(state.errorCode ?? ''));
  useEffect(() => {
    if (!autoQuote || autoQuoteIssued.current || !canQuote || !capability || busy || quote || pending.current) return;
    autoQuoteIssued.current = true;
    onAutoQuoteStarted?.();
    void perform({ type: 'planning.quote', targetScope }, automatic);
  }, [autoQuote, canQuote, capability, busy, quote, onAutoQuoteStarted, perform, targetScope, automatic]);
  useEffect(() => {
    quoteAction.current = canQuote ? () => void perform({ type: 'planning.quote', targetScope }, automatic) : null;
    return () => { quoteAction.current = null; };
  }, [quoteAction, canQuote, perform, targetScope, automatic]);

  const cp = state?.checkpoint;
  const outlineBlocked = cp?.payload.quality?.status === 'blocked';
  const outlineOnly = cp?.payload.documents?.outline !== undefined && Object.keys(cp.payload.documents).length === 1;
  const titleKey = work.mode === 'adaptation' ? 'director.planning.adaptationTitle' : 'director.planning.title';
  useEffect(() => {
    setQuestionIndex(0); setSelected(null); setFreeText(''); setAnswers({});
    setEpisodeCountAnswer(''); setDurationAnswer('');
    setCustomEpisodeCount(false); setCustomDuration(false);
  }, [cp?.id]);
  const questions = cp?.payload.specQuestions ?? [];
  const confirmedPreset = work.mode === 'original' ? cp?.payload.confirmedPreset : undefined;
  const questionCount = confirmedPreset ? 2 : questions.length;
  const pageIndex = Math.min(questionIndex, questionCount);
  const currentQuestion = !confirmedPreset && pageIndex > 0 ? questions[pageIndex - 1] : null;
  const validCount = Number.isSafeInteger(Number(episodeCountAnswer)) && Number(episodeCountAnswer) >= 1 && Number(episodeCountAnswer) <= 100 && episodeCountAnswer.trim() !== '';
  const validDuration = Number.isSafeInteger(Number(durationAnswer)) && Number(durationAnswer) > 0 && durationAnswer.trim() !== '';
  const pageAnswered = confirmedPreset && pageIndex === 1 ? validCount : confirmedPreset && pageIndex === 2 ? validDuration
    : currentQuestion ? Boolean(answers[currentQuestion.id]?.trim()) : Boolean(selected || freeText.trim());
  const allAnswered = Boolean(selected || freeText.trim()) && (confirmedPreset ? validCount && validDuration : questions.every((item) => answers[item.id]?.trim()));
  const questionTitle = confirmedPreset && pageIndex === 1 ? t('director.planning.episodeQuestion', { count: confirmedPreset.episodeCount })
    : confirmedPreset && pageIndex === 2 ? t('director.planning.durationQuestion', { seconds: confirmedPreset.durationSeconds })
      : currentQuestion?.question ?? t('director.planning.chooseDirection');
  const decide = (decision: 'select' | 'adopt' | 'skip' | 'return' | 'revise') => {
    if (!cp) return;
    void perform({ type: 'planning.decide', checkpointId: cp.id, resumeToken: cp.resumeToken, payloadHash: cp.payloadHash, decision,
      ...(decision === 'select' ? { optionId: selected, freeText, answers,
        ...(confirmedPreset ? { episodeCount: Number(episodeCountAnswer), durationSeconds: Number(durationAnswer) } : {}) } : {}),
      ...(decision === 'revise' ? { freeText: revisionRequest } : {}) }, automatic && ['select', 'revise'].includes(decision));
  };
  if (state?.phase === 'NOT_STARTED' && hasDocuments) return null;

  return <section ref={host} className="dc-planning dc-message" aria-label={t(titleKey)}>
    <h3>{t(titleKey)}</h3>
    <p role="status">{t(automatic && busy && ['NOT_STARTED', 'WAIT_COST'].includes(state?.phase ?? '') ? 'director.planning.starting' : automatic && state?.phase === 'WAIT_COST' ? 'director.planning.readyToStart' : busy && state?.phase === 'NOT_STARTED' ? 'director.planning.quoteLoading' : state?.phase === 'READY' && sourceBound ? 'director.planning.outlineReady' : state?.phase === 'WAIT_OUTLINE' && outlineOnly ? 'director.planning.outlineWait' : `director.planning.phase.${state?.phase ?? 'loading'}`)}</p>
    <p className="dc-planning-hint">{t(targetScope === 'outline' ? 'director.planning.adaptationScopeHint' : 'director.planning.scopeHint')}</p>
    {!!state?.budgets.length && <details><summary>{t('director.execution.requestDetails')}</summary><ol>{state.budgets.map((budget) => <li key={budget.id}>
      {t(`director.planning.group.${budget.plan.group}`)} · {t('director.planning.reserved', { used: budget.callsReserved, total: budget.plan.limits.maxCalls })}
    </li>)}</ol></details>}
    {state?.errorCode && <p role="alert">{t(`director.execution.errors.${state.errorCode}`, { defaultValue: state.errorCode })}</p>}
    {error && <div role="alert">{error}{pending.current && <button type="button" disabled={busy} onClick={() => void perform()}>{t('director.planning.retryIntent')}</button>}</div>}
    {canQuote && !quote && !pending.current && <button type="button" disabled={busy || !capability} onClick={() => void perform({ type: 'planning.quote', targetScope }, automatic)}>{t(automatic ? 'director.planning.continue' : 'director.planning.quote')}</button>}
    {state?.phase === 'FAILED_RECOVERABLE' && Boolean(state.artifacts.M04) && !quote && <button type="button" disabled={busy || !!pending.current} onClick={() => void perform({ type: 'planning.revalidate' })}>{t('director.planning.revalidate')}</button>}
    {quote && <div className="dc-planning-quote" role="group" aria-label={t('director.planning.budget')}>
      <strong>{t(`director.planning.group.${quote.plan.group}`)}</strong>
      <p>{quote.plan.stages.map((stage) => t(`director.planning.stage.${stage}`)).join(' → ')}</p>
      <p>{quote.plan.model}</p>
      <p>{t('director.execution.automaticScope', { calls: quote.plan.limits.maxCalls })}</p>
      <details><summary>{t('director.execution.requestDetails')}</summary><p>{t('director.planning.limit', { calls: quote.plan.limits.maxCalls, perCall: quote.plan.limits.maxOutputTokensPerCall, total: quote.plan.limits.maxTotalOutputTokens })}</p></details>
      <p>{t('director.planning.expires', { time: new Date(quote.expiresAt * 1000).toLocaleTimeString() })}</p>
      <p className="dc-cost-warning">{t('director.planning.unknownCost')}</p>
      <label><input type="checkbox" checked={consent} disabled={busy || !!pending.current} onChange={(e) => setConsent(e.target.checked)} />{t('director.planning.consent')}</label>
      <div className="dc-card-actions"><button type="button" disabled={busy || !!pending.current} onClick={() => setQuote(null)}>{t('director.cancel')}</button>
        <button type="button" className="dc-primary-button" disabled={busy || !consent || !!pending.current} onClick={() => void perform({ type: 'planning.grant', quoteId: quote.quoteId, planHash: quote.planHash, unknownCostConsent: consent })}>{t('director.planning.grant')}</button></div>
    </div>}
    {state?.phase === 'WAIT_DIRECTION' && cp && <fieldset disabled={busy || !!pending.current} className="dc-planning-options" aria-label={questionTitle}>
      <div className="dc-question-header"><h4>{questionTitle}</h4>
        {questionCount > 0 && <nav className="dc-question-pages" aria-label={t('director.planning.questionNavigation')}>
          <button type="button" aria-label={t('director.planning.previousQuestion')} disabled={pageIndex === 0} onClick={() => setQuestionIndex(pageIndex - 1)}><ChevronDown size={14} /></button>
          <span aria-live="polite">{pageIndex + 1} / {questionCount + 1}</span>
          <button type="button" aria-label={t('director.planning.nextQuestion')} disabled={pageIndex === questionCount} onClick={() => setQuestionIndex(pageIndex + 1)}><ChevronDown size={14} /></button>
        </nav>}
      </div>
      {pageIndex === 0 && <>{cp.payload.options?.map((option, index) => <div key={option.id}><label className={`dc-planning-option${selected === option.id ? ' is-selected' : ''}`}>
        <span className="dc-question-number">{index + 1}</span>
        <input type="radio" aria-label={option.logline} name={`direction-${work.id}`} checked={selected === option.id} onChange={() => { setSelected(option.id); if (questionCount) setQuestionIndex(1); }} />
        <strong>{option.logline}</strong><p>{option.difference}</p>
      </label><details className="dc-direction-details"><summary>{t('director.planning.directionDetails')}</summary>
        <dl>{(['goal', 'obstacle', 'stakes', 'tone'] as const).map((key) => <div key={key}><dt>{t(`director.planning.${key}`)}</dt><dd>{option[key]}</dd></div>)}</dl>
        {option.productionRisks.length > 0 && <p>{t('director.planning.risks')} · {option.productionRisks.join(' / ')}</p>}
      </details></div>)}
      <button type="button" onClick={() => setSelected(null)}>{t('director.planning.customDirection')}</button>
      <label>{t('director.planning.freeText')}<textarea value={freeText} onChange={(e) => setFreeText(e.target.value)} /></label></>}
      {confirmedPreset && pageIndex === 1 && <>
        <button type="button" className={`dc-planning-option${episodeCountAnswer === String(confirmedPreset.episodeCount) && !customEpisodeCount ? ' is-selected' : ''}`}
          aria-pressed={episodeCountAnswer === String(confirmedPreset.episodeCount) && !customEpisodeCount}
          onClick={() => { setCustomEpisodeCount(false); setEpisodeCountAnswer(String(confirmedPreset.episodeCount)); setQuestionIndex(2); }}>
          <span className="dc-question-number" aria-hidden="true">1</span>{t('director.planning.keepEpisodeCount', { count: confirmedPreset.episodeCount })}
        </button>
        <button type="button" className={`dc-planning-option${customEpisodeCount ? ' is-selected' : ''}`} aria-pressed={customEpisodeCount}
          onClick={() => { setCustomEpisodeCount(true); setEpisodeCountAnswer(''); }}>
          <span className="dc-question-number" aria-hidden="true">2</span>{t('director.planning.changeEpisodeCount')}
        </button>
        {customEpisodeCount && <input type="number" min={1} max={100} step={1} aria-label={t('director.episodeCount')}
          value={episodeCountAnswer} onChange={(event) => setEpisodeCountAnswer(event.target.value)} />}
      </>}
      {confirmedPreset && pageIndex === 2 && <>
        <button type="button" className={`dc-planning-option${durationAnswer === String(confirmedPreset.durationSeconds) && !customDuration ? ' is-selected' : ''}`}
          aria-pressed={durationAnswer === String(confirmedPreset.durationSeconds) && !customDuration}
          onClick={() => { setCustomDuration(false); setDurationAnswer(String(confirmedPreset.durationSeconds)); }}>
          <span className="dc-question-number" aria-hidden="true">1</span>{t('director.planning.keepDuration', { seconds: confirmedPreset.durationSeconds })}
        </button>
        <button type="button" className={`dc-planning-option${customDuration ? ' is-selected' : ''}`} aria-pressed={customDuration}
          onClick={() => { setCustomDuration(true); setDurationAnswer(''); }}>
          <span className="dc-question-number" aria-hidden="true">2</span>{t('director.planning.changeDuration')}
        </button>
        {customDuration && <input type="number" min={1} step={1} aria-label={t('director.durationSeconds')}
          value={durationAnswer} onChange={(event) => setDurationAnswer(event.target.value)} />}
      </>}
      {currentQuestion && <>
        {currentQuestion.choices?.map((choice, index) => <button key={choice} type="button" className={`dc-planning-option${answers[currentQuestion.id] === choice ? ' is-selected' : ''}`}
          aria-pressed={answers[currentQuestion.id] === choice} onClick={() => { setAnswers((prior) => ({ ...prior, [currentQuestion.id]: choice })); if (pageIndex < questions.length) setQuestionIndex(pageIndex + 1); }}>
          <span className="dc-question-number" aria-hidden="true">{index + 1}</span>{choice}
        </button>)}
        <textarea aria-label={currentQuestion.question} value={answers[currentQuestion.id] ?? ''} onChange={(e) => setAnswers((prior) => ({ ...prior, [currentQuestion.id]: e.target.value }))} />
      </>}
      <div className="dc-card-actions"><button type="button" onClick={() => decide('skip')}>{t('director.planning.skip')}</button>
        {pageIndex < questionCount
          ? <button type="button" className="dc-primary-button" disabled={!pageAnswered} onClick={() => setQuestionIndex(pageIndex + 1)}>{t('director.planning.continueQuestion')}</button>
          : <button type="button" className="dc-primary-button" disabled={!allAnswered} onClick={() => decide('select')}>{t('director.planning.confirmDirection')}</button>}</div>
    </fieldset>}
    {state?.phase === 'WAIT_OUTLINE' && cp && <div>
      {cp.payload.quality && <div role={outlineBlocked ? 'alert' : 'status'}>
        <p>{t(outlineBlocked ? 'director.planning.auditBlocked' : 'director.planning.auditReviewed')}</p>
        {outlineBlocked && <ul>{[...new Set([...cp.payload.quality.violatedPaths, ...cp.payload.quality.uncertainPaths])].map((path) => <li key={path}>{path}</li>)}</ul>}
      </div>}
      {outlineOnly ? <button type="button" onClick={() => setDraftOpen(true)}>{t('director.openDraft')}</button> : (['outline', 'characters', 'scenes', 'props'] as const).filter((key) => cp.payload.documents?.[key] !== undefined).map((key) => <details key={key}><summary>{t(`director.section.${key}`)}</summary><pre>{cp.payload.documents?.[key]}</pre></details>)}
      {outlineOnly && cp.payload.quality && <label>{t('director.planning.revisionRequest')}<textarea value={revisionRequest} onChange={e => setRevisionRequest(e.target.value)} /><button type="button" disabled={busy || !!pending.current || !revisionRequest.trim()} onClick={() => decide('revise')}>{t('director.planning.revise')}</button></label>}
      {draftOpen && host.current?.closest('.dc-studio') && createPortal(<div className="dc-editor-overlay dc-screenplay-editor" role="dialog" aria-label={t('director.openDraft')}>
        <header><strong>{work.title} · {t('director.section.outline')}</strong>{onConversation && <button type="button" className="dc-editor-chat-toggle" onClick={onConversation}>{t('director.openPanel')}</button>}<button type="button" onClick={() => setDraftOpen(false)}>{t('director.close')}</button></header>
        <DirectorRichText value={cp.payload.documents?.outline ?? ''} label={t('director.section.outline')} readOnly onChange={() => {}} />
      </div>, host.current.closest('.dc-studio')!)}
      <p>{t(outlineOnly ? 'director.planning.outlineAdoptHint' : 'director.planning.adoptHint')}</p>
      <div className="dc-card-actions"><button type="button" disabled={busy || !!pending.current} onClick={() => decide('skip')}>{t('director.planning.skip')}</button><button type="button" className="dc-primary-button" disabled={busy || !!pending.current || outlineBlocked} onClick={() => decide('adopt')}>{t(outlineOnly ? 'director.planning.outlineAdopt' : 'director.planning.adopt')}</button></div>
    </div>}
    {state?.phase === 'WAIT_INPUT' && <button type="button" disabled={busy || !!pending.current} onClick={() => decide('return')}>{t('director.planning.return')}</button>}
    {state?.phase === 'EXEC' && <div className="dc-card-actions"><button type="button" disabled={busy || !!pending.current} onClick={() => void perform({ type: 'planning.cancel' })}>{t('director.planning.stop')}</button><button type="button" disabled={busy || !!pending.current} onClick={() => void perform({ type: 'planning.resume' })}>{t('director.planning.resume')}</button></div>}
  </section>;
}
