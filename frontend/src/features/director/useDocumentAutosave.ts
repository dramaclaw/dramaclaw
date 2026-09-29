// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Serialize edits against acknowledged versions. A lost reply retains its intent;
 * a conflict never rebases someone's text onto a document they have not read. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { commitManualDocument, manualDocumentCommand, type DirectorDocument } from '@/api/director';
import { ApiError } from '@/api/client';

type Status = 'saved' | 'pending' | 'saving' | 'failed' | 'conflict' | 'recovered';
type Intent = ReturnType<typeof manualDocumentCommand>;
type Journal = { base: DirectorDocument; text: string; workRevision: number; intent: Intent | null };

export function useDocumentAutosave({ project, workId, workRevision, initial, currentVersion, blocked, enabled, onSaved }: {
  project: string; workId: string; workRevision: number; initial: DirectorDocument; currentVersion: number;
  blocked: boolean; enabled: boolean; onSaved?: (document: DirectorDocument, revision: number) => void;
}) {
  const key = `director:editing:${project}:${workId}:${initial.doc_key}`;
  const [journal, setJournal] = useState<Journal>(() => {
    if (enabled) try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Journal | null;
      if (saved && typeof saved.text === 'string' && Number.isInteger(saved.workRevision) && saved.base?.doc_key === initial.doc_key &&
          (saved.base.document_id === initial.document_id || (!initial.document_id && initial.version === 0)) && Number.isInteger(saved.base.version) &&
          (!saved.intent || (saved.intent.workId === workId && saved.intent.payload?.documentId === saved.base.document_id && saved.intent.payload.type === 'document.commitManual')))
        return saved;
    } catch { /* Unreadable recovery data must not replace the server document. */ }
    return { base: initial, text: initial.content, workRevision, intent: null };
  });
  const [status, setStatus] = useState<Status>(() => journal.text !== initial.content || journal.intent ? 'recovered' : 'saved');
  const [storageFailed, setStorageFailed] = useState(false);
  const state = useRef(journal);
  const active = useRef(true);
  const inflight = useRef<Promise<boolean> | null>(null);
  const options = useRef({ blocked, enabled, onSaved, currentVersion, workRevision });
  options.current = { blocked, enabled, onSaved, currentVersion, workRevision };
  const persist = useCallback((value: Journal) => {
    state.current = value;
    if (active.current) setJournal(value);
    if (!options.current.enabled) return;
    try {
      if (value.text === value.base.content && !value.intent) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
      if (active.current) setStorageFailed(false);
    } catch { if (active.current) setStorageFailed(true); }
  }, [key]);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const edit = useCallback((text: string) => {
    persist({ ...state.current, text });
    // Editing after a failed/unknown response cannot discard the previous intent.
    setStatus(previous => ['failed', 'conflict', 'recovered'].includes(previous) ? previous : 'pending');
  }, [persist]);
  const flush = useCallback(async (): Promise<boolean> => {
    if (inflight.current) return inflight.current;
    const run = async () => {
      while (state.current.intent || state.current.text !== state.current.base.content) {
        const current = state.current;
        if (!active.current || !options.current.enabled || options.current.blocked || !current.base.document_id) return false;
        // An unknown response must be reconciled with the original command even
        // when polling already sees the write. Never mint a retry with a new ID.
        if (!current.intent && options.current.currentVersion > current.base.version) {
          if (active.current) setStatus('conflict');
          return false;
        }
        const intent = current.intent ?? manualDocumentCommand(workId,
          Math.max(current.workRevision, options.current.workRevision), current.base, current.text);
        persist({ ...current, intent });
        if (active.current) setStatus('saving');
        try {
          const reply = await commitManualDocument(project, intent);
          const latest = state.current;
          const text = latest.text === intent.payload.text ? reply.document.content : latest.text;
          persist({ base: reply.document, text, workRevision: reply.workRevision, intent: null });
          if (active.current) options.current.onSaved?.(reply.document, reply.workRevision);
        } catch (error) {
          if (active.current) setStatus(error instanceof ApiError && error.status === 409 ? 'conflict' : 'failed');
          return false;
        }
      }
      if (active.current) setStatus('saved');
      return true;
    };
    inflight.current = run().finally(() => { inflight.current = null; });
    return inflight.current;
  }, [persist, project, workId]);
  useEffect(() => {
    if (!enabled || blocked || status !== 'pending') return;
    const timer = setTimeout(() => { void flush(); }, 1000);
    return () => clearTimeout(timer);
  }, [enabled, blocked, journal.text, status, flush]);
  const dirty = journal.text !== journal.base.content || Boolean(journal.intent);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  return { text: journal.text, baseline: journal.base, status,
    conflict: status === 'conflict' || (!journal.intent && currentVersion > journal.base.version),
    storageFailed, dirty, edit, flush,
    loadServerVersion: (document: DirectorDocument, revision: number) => {
      // Explicit conflict resolution only: unknown writes must reconcile first.
      if (inflight.current || (state.current.intent && status !== 'conflict') || document.doc_key !== state.current.base.doc_key || document.version < state.current.base.version) return false;
      persist({ base: document, text: document.content, workRevision: revision, intent: null });
      setStatus('saved');
      options.current.onSaved?.(document, revision);
      return true;
    },
    bindIdentity: (documentId: string) => {
      if (!state.current.base.document_id) persist({ ...state.current, base: { ...state.current.base, document_id: documentId } });
    },
    savedVersion: () => state.current.base.version };
}
