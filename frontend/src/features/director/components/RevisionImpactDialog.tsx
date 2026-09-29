// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommitRevision, RevisionImpact } from '@/api/director';

const FIELD_KEYS: Record<string, string> = {
  title: 'workTitle', brief: 'revision.brief', primary_genre: 'primaryGenre', fusion_genre: 'fusionGenre',
  audience: 'audience', characters: 'characters', era: 'era', highlights: 'highlights', visual_style: 'visualStyle',
  narrative_tone: 'spec.narrativeTone', ending_type: 'spec.endingType', output_language: 'spec.language',
  market: 'spec.market', fidelity: 'spec.fidelity', locked_facts: 'spec.lockedFacts', allowed_additions: 'spec.allowedAdditions',
  model_name: 'textModel', structure: 'structure', episode_count: 'episodeCount', duration_seconds: 'durationSeconds',
  adapt_direction: 'adaptDirection', delivery_episode_label: 'spec.deliveryLabel',
};

export function RevisionImpactDialog({ impact, busy, error, onClose, onCommit }: {
  impact: RevisionImpact; busy: boolean; error: string; onClose: () => void;
  onCommit: (command: CommitRevision) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [archived, setArchived] = useState<string[]>([]);
  const intent = useRef<CommitRevision | null>(null);
  const valid = reason.replace(/\s/g, '').length >= 10 && archived.length === impact.archiveEpisodes.length;
  const commit = () => {
    if (!valid || busy) return;
    if (!intent.current) {
      const id = crypto.randomUUID();
      intent.current = { schemaVersion: 2, commandId: id, clientRequestId: id, workId: impact.workId,
        previewId: impact.previewId, previewHash: impact.previewHash, archiveEpisodeIds: archived, reason };
    }
    onCommit(intent.current);
  };
  return <div className="dc-overlay"><div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.revision.title')}>
    <h2>{t('director.revision.title')}</h2>
    <p>{t('director.revision.preserve')}</p>
    {impact.changedFields.length > 0 && <div className="dc-parameter-list">{impact.changedFields.map((field) =>
      <div key={field.field}><span>{t(`director.${FIELD_KEYS[field.field] ?? field.field}`)}</span>
        <strong>{String(field.before ?? '—')} → {String(field.after ?? '—')}</strong></div>)}</div>}
    {impact.restartEpisode != null && <p>{t('director.revision.restart', { number: impact.restartEpisode })}</p>}
    <p>{t('director.revision.invalidations', { reports: impact.invalidatedReportIds.length, finalizations: impact.invalidatedFinalizationIds.length })}</p>
    {impact.affectedEpisodes.length > 0 && <p>{t('director.revision.affected')} {impact.affectedEpisodes.map((e) => `${e.label} (v${e.version})`).join(', ')}</p>}
    {impact.addedOrdinals.length > 0 && <p>{t('director.revision.added')} {impact.addedOrdinals.join(', ')}</p>}
    {impact.restoredEpisodes.length > 0 && <p>{t('director.revision.restored')} {impact.restoredEpisodes.map((e) => e.label).join(', ')}</p>}
    {impact.archiveEpisodes.map((episode) => <label key={episode.id} className="dc-consent">
      <input type="checkbox" checked={archived.includes(episode.id)} disabled={busy} onChange={(event) => {
        intent.current = null;
        setArchived(event.target.checked ? [...archived, episode.id] : archived.filter((id) => id !== episode.id));
      }} />{t('director.revision.archive', { label: episode.label, version: episode.version })}</label>)}
    <label className="dc-field-label">{t('director.revision.reason')}
      <textarea value={reason} maxLength={2000} disabled={busy} onChange={(event) => { intent.current = null; setReason(event.target.value); }} />
    </label>
    {error && <div role="alert" className="dc-error">{error}</div>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{t('director.cancel')}</button>
      <button type="button" className="dc-primary-button" disabled={!valid || busy} onClick={commit}>{t('director.revision.confirm')}</button></footer>
  </div></div>;
}
