// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import type { ExecutionRun } from '@/api/director-execution';
import type { RunPreview } from '../useExecutionStream';
import { ExecutionHistory } from './ExecutionHistory';

export function ConversationScroll({ children, revision }: { children: ReactNode; revision: string | number }) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    if (follow.current) root.current.scrollTop = root.current.scrollHeight;
    else setUnread(true);
  }, [revision]);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    // Quote cards and questions change without an execution-stream revision.
    const observer = new MutationObserver(() => {
      if (follow.current) node.scrollTop = node.scrollHeight;
      else setUnread(true);
    });
    observer.observe(node, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <div className="dc-conversation-scroll">
    <div className="dc-messages" ref={root} onScroll={() => {
      if (!root.current) return;
      follow.current = root.current.scrollHeight - root.current.scrollTop - root.current.clientHeight < 64;
      if (follow.current) setUnread(false);
    }}>{children}</div>
    {unread && <button className="dc-stream-bottom" type="button" onClick={() => {
      follow.current = true; setUnread(false); if (root.current) root.current.scrollTop = root.current.scrollHeight;
    }}>{t('director.stream.latest')}</button>}
  </div>;
}

export function DirectorConversation({ runs, previews, busy, onAction, onViewResult, onRefine }: {
  runs: ExecutionRun[]; previews: Record<string, RunPreview>; busy: boolean;
  onAction: (run: ExecutionRun, type: 'run.cancel' | 'run.resume') => void;
  onViewResult: (run: ExecutionRun) => void; onRefine: (run: ExecutionRun) => void;
}) {
  const { t } = useTranslation();
  const sectionLabel = (key: string) => {
    const option = /^options\.(\d+)\.(logline|goal|obstacle|stakes|tone|difference|productionRisks)(?:\.\d+)?$/.exec(key);
    if (option) return `${t('director.stream.directionNumber', { number: Number(option[1]) + 1 })} · ${t(`director.stream.directionFields.${option[2]}`)}`;
    const question = /^specQuestions\.(\d+)\.(question|choices)(?:\.\d+)?$/.exec(key);
    if (question) return `${t('director.stream.questionNumber', { number: Number(question[1]) + 1 })} · ${t(`director.stream.questionFields.${question[2]}`)}`;
    return '';
  };
  return <>{[...runs].sort((a, b) => a.createdAt - b.createdAt).map(run => {
    const preview = previews[run.id];
    return <div className="dc-conversation-turn" key={run.id}>
      {typeof run.parameters.instruction === 'string' && run.parameters.instruction && <div className="dc-message dc-message-user"><p>{run.parameters.instruction}</p></div>}
      {(preview?.method || preview?.model) && <details className="dc-method-trace"><summary>{t('director.stream.activity')}</summary>
        {preview.method && <p>{t('director.stream.method')} · <code>{preview.method.key ?? '—'} @ {preview.method.version ?? '—'}</code></p>}
        {preview.method?.references?.length ? <ul>{preview.method.references.map(path => <li key={path}><code>{path}</code></li>)}</ul> : null}
        {preview.model && <p>{t('director.stream.model')} · {preview.model.model}</p>}
        <small>{t('director.stream.traceHint')}</small>
      </details>}
      {preview?.text && <div className="dc-stream-answer" aria-label={t('director.stream.preview')}>
        <ReactMarkdown skipHtml components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{preview.text}</ReactMarkdown>
        <small>{t(['dispatching', 'queued'].includes(run.status) ? 'director.stream.writing' : 'director.stream.retained')}</small>
      </div>}
      {preview?.sections && <details className="dc-stream-answer" open={['dispatching', 'queued'].includes(run.status)}>
        <summary>{t(run.parameters.stage === 'M03' ? 'director.stream.directionPreview' : 'director.stream.outlinePreview')}</summary>
        {Object.entries(preview.sections).map(([key, part]) => <p key={key}>{sectionLabel(key) && <strong>{sectionLabel(key)} · </strong>}{part.text}</p>)}
        <small>{t(['dispatching', 'queued'].includes(run.status) ? 'director.stream.writing' : 'director.stream.retained')}</small>
      </details>}
      {run.response.episodeFormat && <div className="dc-format-notice" role="status">
        {t('director.stream.structure', { count: run.response.episodeFormat.sceneCount })}
        {run.response.episodeFormat.missing.length > 0 && <p>{t('director.stream.missing')}: {run.response.episodeFormat.missing.map(key => t(`director.stream.fields.${key}`)).join(' · ')}</p>}
        <small>{t('director.stream.qualityHint')}</small>
      </div>}
      <ExecutionHistory runs={[run]} busy={busy} onAction={onAction} onViewResult={onViewResult} />
      {run.docKey.startsWith('episode-') && run.status === 'succeeded' && <button type="button" disabled={busy} className="dc-refine-entry" onClick={() => onRefine(run)}>{t('director.stream.refine')}</button>}
    </div>;
  })}</>;
}
