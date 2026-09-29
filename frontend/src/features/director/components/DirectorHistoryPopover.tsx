// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listDirectorWorks, updateDirectorHistory, type DirectorHistoryCommand, type DirectorWork } from '@/api/director';
import { ApiError } from '@/api/client';
import { DirectorPopover } from './DirectorPopover';
import { Search, X, DirectorReferenceIcon } from './DirectorReferenceIcon';

export function DirectorHistoryPopover({ project, works, anchor, onClose, onOpen, onChanged }: {
  project: string; works: DirectorWork[]; anchor: HTMLElement | null; onClose: () => void;
  onOpen: (id: string) => void; onChanged: (id: string, archived: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [archiveWorks, setArchiveWorks] = useState<DirectorWork[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<DirectorWork | null>(null);
  const [title, setTitle] = useState('');
  const [confirm, setConfirm] = useState<DirectorWork | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{ workId: string; command: DirectorHistoryCommand } | null>(null);
  useEffect(() => {
    if (!archived) return;
    let active = true; setLoading(true);
    void listDirectorWorks(project, true).then(values => { if (active) setArchiveWorks(values); }).catch(reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [archived, project]);
  const act = async (item: DirectorWork, action: DirectorHistoryCommand['action']) => {
    if (busy) return;
    // An uncertain response may only retry the exact intent, never a different row.
    if (pending.current && (pending.current.workId !== item.id || pending.current.command.action !== action)) return;
    const intent = pending.current ?? { workId: item.id, command: { command_id: crypto.randomUUID(), expected_revision: item.revision, action, ...(action === 'rename' ? { title: title.trim() } : {}) } };
    pending.current = intent; setBusy(true); setError('');
    try {
      await updateDirectorHistory(project, intent.workId, intent.command);
      pending.current = null; setEditing(null); setConfirm(null);
      await onChanged(intent.workId, intent.command.action === 'archive');
      if (archived) setArchiveWorks(await listDirectorWorks(project, true));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) pending.current = null;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const rows = (archived ? archiveWorks : works).filter(item => item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <DirectorPopover anchor={anchor} label={t('director.history')} width={320} side="bottom" align="end" onClose={onClose} className="dc-history-popover">
    <header><strong>{t('director.history')}</strong><button type="button" aria-label={t('director.close')} onClick={onClose}><X size={14} /></button></header>
    <label className="dc-history-search"><Search size={16} /><input placeholder={t('director.ui.search')} aria-label={t('director.ui.search')} value={search} onChange={e => setSearch(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">{t('director.surface.loading')}</p> : <div className="dc-history-rows">{rows.map(item => <div className="dc-history-row" key={item.id}>
      {editing?.id === item.id ? <form onSubmit={e => { e.preventDefault(); void act(item, 'rename'); }}><input autoFocus aria-label={t('director.surface.rename')} value={title} maxLength={160} disabled={busy || !!pending.current} onChange={e => setTitle(e.target.value)} /><button type="submit" disabled={busy || !title.trim()}>{t('director.confirm')}</button><button type="button" disabled={busy || !!pending.current} onClick={() => setEditing(null)}>{t('director.cancel')}</button></form> : <>
        <button type="button" className="dc-history-select" title={item.title} disabled={busy || !!pending.current} onClick={() => onOpen(item.id)}><span>{item.title}</span><small>{t('director.surface.script')}</small></button>
        <time>{new Date(item.updated_at * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })}</time>
        <div className="dc-history-row-actions"><button type="button" aria-label={t('director.surface.rename')} disabled={busy || !!pending.current} onClick={() => { setEditing(item); setTitle(item.title); }}><DirectorReferenceIcon name="Edit" size={14} /></button><button type="button" aria-label={t(archived ? 'director.surface.restoreConversation' : 'director.surface.archive')} disabled={busy || (!!pending.current && !(archived && pending.current.workId === item.id && pending.current.command.action === 'restore'))} onClick={() => archived ? void act(item, 'restore') : setConfirm(item)}><DirectorReferenceIcon name={archived ? 'Undo' : 'Close'} size={14} /></button></div>
      </>}
    </div>)}</div>}
    {!rows.length && !loading && <p className="dc-history-empty">{t('director.surface.noHistory')}</p>}
    <footer><button type="button" onClick={() => { setArchived(!archived); setEditing(null); }} disabled={busy || !!pending.current}>{t(archived ? 'director.surface.activeHistory' : 'director.surface.archivedHistory')}</button></footer>
    {confirm && <div className="dc-history-confirm"><strong>{t('director.surface.archive')}</strong><p>{t('director.surface.archiveHint')}</p><div><button type="button" disabled={busy || !!pending.current} onClick={() => setConfirm(null)}>{t('director.cancel')}</button><button type="button" disabled={busy} onClick={() => void act(confirm, 'archive')}>{t('director.confirm')}</button></div></div>}
  </DirectorPopover>;
}
