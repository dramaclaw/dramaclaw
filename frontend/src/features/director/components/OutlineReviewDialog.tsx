import { useTranslation } from 'react-i18next';
import type { OutlineQualityReport } from '@/api/director';

/** Reading a report never approves a manuscript or purchases another review. */
export function OutlineReviewDialog({ report, canRun, onClose, onReview }: {
  report: OutlineQualityReport; canRun: boolean; onClose: () => void; onReview: () => void;
}) {
  const { t } = useTranslation();
  const review = report.review;
  return <div className="dc-overlay" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="dc-small-modal dc-quality-modal" role="dialog" aria-modal="true" aria-label={t('director.outlineReview.title')}>
      <h2>{t('director.outlineReview.title')}</h2>
      <p>{t('director.outlineReview.boundary')}</p>
      <strong>{t('director.version', { number: report.documentVersion })} · {review ? t(`director.outlineReview.status.${review.status}`) : t('director.review.notReviewed')}</strong>
      {review && <>
        <p>{t('director.outlineReview.coverage', { valid: review.coverage.valid, total: review.coverage.expected })}</p>
        {review.checks.map((check, index) => {
          const obligation = review.obligations.find(item => item.id === check.id);
          return <details key={`${check.id}-${index}`} open={check.status !== 'FULFILLED'}>
            <summary>{obligation?.text ?? t(`director.outlineReview.checks.${check.id}`)} · {t(`director.outlineReview.status.${check.status}`)}</summary>
            {obligation && <p>{t('director.outlineReview.source', { value: obligation.sourceRefs.map(ref => `${ref.inputId}:${ref.start}–${ref.end}`).join(', ') })}</p>}
            <p>{check.validationErrorCode ? t('director.outlineReview.invalidEvidence') : check.explanation}</p>
            {check.evidence.map((evidence, i) => <blockquote key={i}>{evidence.quote}<small> · {evidence.inputId} [{evidence.start}–{evidence.end}]</small></blockquote>)}
            {check.suggestion && <p>{check.suggestion}</p>}
          </details>;
        })}
      </>}
      <footer><button type="button" onClick={onClose}>{t('director.close')}</button>
        <button type="button" disabled={!canRun} onClick={onReview}>{t('director.review.run')}</button></footer>
    </div>
  </div>;
}
