// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Version evidence is read-only; importing old work requires a separate preview and intent. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { commitLegacyImport, getCanonicalDocuments, legacyImportCommand, previewLegacyImport,
  type CanonicalDocumentProjection, type LegacyImportPreview } from '@/api/director';

export function DocumentVersionPanel({ project, workId, revision, docKey, onImported }: {
  project: string; workId: string; revision: number; docKey: string; onImported: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [projection, setProjection] = useState<CanonicalDocumentProjection | null>(null);
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const intent = useRef<ReturnType<typeof legacyImportCommand> | null>(null);
  const scope = useRef(workId);
  scope.current = workId;
  useEffect(() => {
    let active = true;
    setProjection(null); setPreview(null); setError(false); intent.current = null;
    void getCanonicalDocuments(project, workId).then((value) => { if (active) setProjection(value); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [project, workId, revision]);
  const prepare = async () => {
    setBusy(true); setError(false);
    try {
      const value = await previewLegacyImport(project, workId);
      if (scope.current !== workId) return;
      intent.current = legacyImportCommand(value);
      setPreview(value);
    } catch { if (scope.current === workId) setError(true); }
    finally { if (scope.current === workId) setBusy(false); }
  };
  const commit = async () => {
    if (!intent.current) return;
    setBusy(true); setError(false);
    try {
      await commitLegacyImport(project, intent.current);
      if (scope.current !== workId) return;
      setPreview(null); intent.current = null;
      setProjection(await getCanonicalDocuments(project, workId));
      await onImported();
    } catch { if (scope.current === workId) setError(true); }
    finally { if (scope.current === workId) setBusy(false); }
  };
  const doc = projection?.documents.find((item) => item.docKey === docKey);
  const stale = projection?.artifacts.filter((item) => item.status === 'stale').length ?? 0;
  return <>
    {error && <p role="alert">{t('director.documents.loadError')}</p>}
    {projection?.schemaVersion === 1 && <p>{t('director.documents.legacyHint')} <button type="button" disabled={busy} onClick={() => void prepare()}>{t('director.documents.previewImport')}</button></p>}
    {doc && <details className="dc-document-meta">
      <summary>{t('director.documents.canonical')} · {t('director.version', { number: doc.version })}</summary>
      <p>{t('director.documents.stableId')}: <code>{doc.documentId}</code></p>
      {doc.contentHash && <p>{t('director.documents.contentHash')}: <code>{doc.contentHash}</code></p>}
      {doc.status === 'legacy_unverified' && <p>{t('director.documents.unverified')}</p>}
      {doc.unsupportedBlockIds.length > 0 && <p>{t('director.documents.rawBlocks', { count: doc.unsupportedBlockIds.length })}</p>}
      {stale > 0 && <p>{t('director.documents.staleArtifacts', { count: stale })}</p>}
    </details>}
    {preview && <div className="dc-overlay"><div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.documents.previewImport')}>
      <h2>{t('director.documents.previewImport')}</h2><p>{t('director.documents.importWarning')}</p>
      <p>{t('director.documents.versionCount', { count: preview.versionCount })}</p>
      <p>{t('director.documents.confirmationCount', { count: preview.historicalConfirmationCount })}</p>
      <div className="dc-parameter-list">{preview.documentMap.map((item) => <div key={item.documentId}><span>{item.docKey}</span><code>{item.documentId}</code></div>)}</div>
      <p>{t('director.documents.backupHash')}: <code>{preview.sourceHash}</code></p>
      {error && <p role="alert">{t('director.documents.loadError')}</p>}
      <footer><button type="button" disabled={busy} onClick={() => { setPreview(null); intent.current = null; }}>{t('director.cancel')}</button>
        <button type="button" className="dc-primary-button" disabled={busy} onClick={() => void commit()}>{t('director.documents.confirmImport')}</button></footer>
    </div></div>}
  </>;
}
