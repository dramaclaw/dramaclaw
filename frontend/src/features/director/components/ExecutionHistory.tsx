// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from 'react-i18next';
import type { ExecutionRun } from '@/api/director-execution';

export function RequestParameters({ parameters }: { parameters: Record<string, unknown> }) {
  const { t } = useTranslation();
  const entries = Object.entries(parameters);
  const nested = entries.filter(([, value]) => value !== null && typeof value === 'object');
  return <>
    <div className="dc-parameter-list">{entries.filter(([, value]) => value !== null && typeof value !== 'object' && value !== '').map(([key, value]) =>
      <div key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</div>
    {nested.length > 0 && <details><summary>{t('director.execution.requestDetails')}</summary>
      {nested.map(([key, value]) => <details key={key}><summary>{key}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>)}
    </details>}
  </>;
}

export function ExecutionHistory({ runs, busy, onAction, onViewResult }: {
  runs: ExecutionRun[];
  busy: boolean;
  onAction: (run: ExecutionRun, type: 'run.cancel' | 'run.resume') => void;
  onViewResult?: (run: ExecutionRun) => void;
}) {
  const { t } = useTranslation();
  return <>{runs.map((run) => {
    const documentLabel = ['outline', 'characters', 'scenes', 'props'].includes(run.docKey)
      ? t(`director.section.${run.docKey}`) : run.docKey;
    return <section className="dc-message dc-execution-card" key={run.id}
    aria-label={t('director.execution.runLabel', { stage: documentLabel })}>
    <strong>{run.parameters.stage ? t(`director.planning.stage.${run.parameters.stage}`) : <>{t(run.parameters.purpose === 'review' ? 'director.review.task' : 'director.run')} · {documentLabel}</>}</strong>
    <p role="status">{run.parameters.stage && run.status === 'succeeded' ? t('director.planning.stageSaved') : run.response.review ? t('director.review.finished', { status: run.response.review.status }) : t(`director.execution.status.${run.status}`)}</p>
    <small>{t('director.execution.costLabel')}: {run.cost.actualMinor == null
      ? t('director.execution.costUnknown')
      : t('director.execution.costAmount', { amount: run.cost.actualMinor, currency: run.cost.currency ?? '' })}</small>
    {run.errorCode && <p>{t(`director.execution.errors.${run.errorCode}`, { defaultValue: run.errorCode })}</p>}
    {run.response.validation && <details><summary>{t('director.execution.validationDetails', { count: run.response.validation.issueCount })}</summary>
      <ul>{run.response.validation.issues.map((issue, index) => <li key={index}><code>{issue.path}</code> · <code>{issue.code}</code></li>)}</ul>
    </details>}
    {run.requiresReconciliation && <p className="dc-cost-warning">{t('director.execution.reconciliationHint')}</p>}
    {run.status === 'cancel_requested' && <p>{t('director.execution.cancelInFlightHint')}</p>}
    <details><summary>{t('director.parameterReview')}</summary><RequestParameters parameters={run.parameters} /><div className="dc-parameter-list">
      <div><span>{t('director.execution.maxOutputTokens')}</span><strong>{run.limits.maxOutputTokens}</strong></div>
      <div><span>{t('director.execution.requestHash')}</span><code>{run.requestHash}</code></div>
      {run.response.usage && <>
        <div><span>{t('director.execution.inputTokens')}</span><strong>{run.response.usage.inputTokens}</strong></div>
        <div><span>{t('director.execution.outputTokens')}</span><strong>{run.response.usage.outputTokens}</strong></div>
        <div><span>{t('director.execution.finishReason')}</span><strong>{run.response.usage.finishReason ?? '—'}</strong></div>
        <div><span>{t('director.execution.reportedModel')}</span><strong>{run.response.usage.reportedModel ?? '—'}</strong></div>
      </>}
    </div></details>
    <div className="dc-card-actions">
      {run.response.output_sha256 && onViewResult && <button type="button" disabled={busy} onClick={() => onViewResult(run)}>{t('director.execution.viewResult')}</button>}
      {run.canCancel && (run.purpose ? run.purpose !== 'planning' : !run.parameters.stage) && <button type="button" disabled={busy} onClick={() => onAction(run, 'run.cancel')}>{t('director.execution.stop')}</button>}
      {run.canResume && (run.purpose ? run.purpose !== 'planning' : !run.parameters.stage) && <button type="button" disabled={busy} onClick={() => onAction(run, 'run.resume')}>{t('director.execution.resumeQueued')}</button>}
      {run.requiresReconciliation && run.status !== 'unknown' && <button type="button" disabled={busy} onClick={() => onAction(run, 'run.resume')}>{t('director.execution.markUnknown')}</button>}
    </div>
  </section>; })}</>;
}
