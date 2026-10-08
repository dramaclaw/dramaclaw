// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Display the immutable baseline and real replacement ranges; never diff a regenerated draft. */
import { createElement, Fragment, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectorChange, OutlineBlock } from '@/api/director';
import { Check, X, ChevronDown } from './DirectorReferenceIcon';

const ORDER = ['overview', 'adaptation', 'chapters', 'hooks', 'boundaries'];

function marked(block: OutlineBlock): ReactNode {
  const chars = Array.from(block.text);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mark of block.marks ?? []) {
    parts.push(chars.slice(cursor, mark.start).join(''));
    const content = chars.slice(mark.start, mark.end).join('');
    const tag = ({ bold: 'strong', italic: 'em', strike: 's', code: 'code' } as Record<string, string>)[mark.type] ?? 'span';
    parts.push(createElement(tag, { key: `${mark.start}-${mark.end}` }, content));
    cursor = mark.end;
  }
  parts.push(chars.slice(cursor).join(''));
  return <>{parts}</>;
}

function Block({ block }: { block: OutlineBlock }) {
  if (!block.text) return null; // Markdown separators are not extra visible paragraphs.
  const tag = block.type === 'heading' ? `h${block.attrs.level ?? 3}` : 'p';
  return createElement(tag, { 'data-block-id': block.id, className: block.type === 'list' ? 'dc-patch-list' : undefined }, marked(block));
}

export function OutlinePatchReview({ change, busy, label, onAccept, onReject, onReview, sections = [], onSection }: {
  change: DirectorChange; busy: boolean; label: string;
  sections?: Array<{ id: string; label: string; selected: boolean }>;
  onSection?: (id: string) => void;
  onAccept: (groups: string[], reportId: string) => void;
  onReject: (groups: string[]) => void;
  onReview: (groups: string[]) => void;
}) {
  const { t } = useTranslation();
  const patch = change.outlinePatch!;
  const pending = patch.groups.filter(g => patch.decisions[g.id] === 'pending');
  const root = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState(100);
  const groupsFor = (hunkId: string) => patch.groups.find(g => g.hunkIds.includes(hunkId))!;
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const reportFor = (groups: string[]) => [...patch.reviews].reverse().find(r => r.currentValidator !== false && r.changeRevision === patch.revision && same(r.acceptGroupIds, groups));
  const accept = (groups: string[]) => {
    const report = reportFor(groups);
    if (report?.status === 'reviewed') onAccept(groups, report.id);
    else onReview(groups);
  };
  const controls = (groups: string[], count: number) => {
    const report = reportFor(groups);
    return <div className="dc-patch-actions">
      <span>{t('director.patch.count', { count })}</span>
      <button type="button" disabled={busy || !groups.length} onClick={() => onReject(groups)}><X size={20} />{t('director.patch.rejectAll')}</button>
      <button type="button" disabled={busy || !groups.length || report?.status === 'blocked'}
        title={t(report?.status === 'reviewed' ? 'director.patch.reviewed' : 'director.patch.reviewFirst')}
        onClick={() => accept(groups)}><Check size={20} />{t(report ? 'director.patch.acceptAll' : 'director.patch.reviewFirst')}</button>
    </div>;
  };
  const headings = patch.baseAst.blocks.filter(b => b.type === 'heading' && b.attrs.level === 2);
  const [headingFocus, setHeadingFocus] = useState(0);
  const headingButtons = headings.map((h, i) => <button type="button" key={h.id}
    aria-current={headingFocus === i ? 'location' : undefined}
    onClick={() => { root.current?.querySelector(`[data-section="${ORDER[i]}"]`)?.scrollIntoView({ block: 'start' }); setHeadingFocus(i); }}>{h.text}</button>);
  const activeSections = ORDER.filter(key => pending.some(g => g.sectionKeys.includes(key)));
  const jump = (index: number) => {
    const next = Math.max(0, Math.min(index, activeSections.length - 1));
    root.current?.querySelector(`[data-section="${activeSections[next]}"]`)?.scrollIntoView({ block: 'start' });
    setFocus(next);
  };
  const renderBlocks: ReactNode[] = [];
  const byStart = new Map(patch.hunks.map(h => [h.targetBlockIds[0], h]));
  const hidden = new Set(patch.hunks.flatMap(h => h.targetBlockIds.slice(1)));
  let sectionIndex = -1;
  for (const block of patch.baseAst.blocks) {
    if (hidden.has(block.id)) continue;
    if (block.type === 'heading' && block.attrs.level === 2) {
      const key = ORDER[++sectionIndex];
      const sectionGroups = pending.filter(g => g.sectionKeys.includes(key));
      const count = patch.hunks.filter(h => h.sectionKey === key && patch.decisions[groupsFor(h.id).id] === 'pending').length;
      renderBlocks.push(<div key={`actions-${key}`} className="dc-patch-section" data-section={key}>
        {count > 0 && controls(sectionGroups.map(g => g.id), count)}</div>);
    }
    const hunk = byStart.get(block.id);
    if (!hunk) { renderBlocks.push(<Block key={block.id} block={block} />); continue; }
    const group = groupsFor(hunk.id), status = patch.decisions[group.id];
    const old = hunk.targetBlockIds.map(id => patch.baseAst.blocks.find(b => b.id === id)!);
    const after = hunk.renderedBlocks ?? hunk.afterBlocks.map((b, i) => ({ id: `${hunk.id}-${i}`, type: b.type, text: b.text,
      attrs: { level: b.level, lineBreak: b.lineBreak } }));
    renderBlocks.push(<div key={hunk.id} className={`dc-patch-hunk is-${status}`} data-hunk={hunk.id}>
      {status !== 'accepted' && <div className={status === 'pending' ? 'dc-patch-removed' : undefined}>{old.map(b => <Block key={b.id} block={b} />)}</div>}
      {status !== 'rejected' && <div className={status === 'pending' ? 'dc-patch-added' : undefined}>{after.map(b => <Block key={b.id} block={b} />)}</div>}
      {status === 'pending' && <div className="dc-patch-hunk-actions" role="group" aria-label={hunk.reason}>
        <span>{group.hunkIds.length > 1 ? t('director.patch.linked', { count: group.hunkIds.length }) : hunk.reason}</span>
        <button type="button" disabled={busy} onClick={() => onReject([group.id])}><X size={20} />{t('director.patch.rejectGroup')}</button>
        <button type="button" disabled={busy || reportFor([group.id])?.status === 'blocked'} onClick={() => accept([group.id])}><Check size={20} />{t(reportFor([group.id]) ? 'director.patch.acceptGroup' : 'director.patch.reviewFirst')}</button>
      </div>}
    </div>);
  }
  return <Fragment>
    <div className="dc-rich-toolbar dc-patch-toolbar" role="toolbar" aria-label={t('director.patch.toolbar')}>
      <button type="button" onClick={() => setZoom(Math.max(50, zoom - 10))} aria-label={t('director.surface.zoomOut')}>−</button>
      <button type="button" className="dc-zoom-value" onClick={() => setZoom(100)}>{zoom}%</button>
      <button type="button" onClick={() => setZoom(Math.min(200, zoom + 10))} aria-label={t('director.surface.zoomIn')}>+</button><i />
    </div>
    <div className="dc-patch-global" role="toolbar" aria-label={t('director.patch.toolbar')}>
      <button type="button" disabled={!activeSections.length || focus === 0} aria-label={t('director.patch.previous')} onClick={() => jump(focus - 1)}><ChevronDown className="dc-patch-up" size={18} /></button>
      <span>{activeSections.length ? focus + 1 : 0}/{activeSections.length}</span>
      <button type="button" disabled={!activeSections.length || focus >= activeSections.length - 1} aria-label={t('director.patch.next')} onClick={() => jump(focus + 1)}><ChevronDown size={18} /></button>
      {controls(pending.map(g => g.id), pending.reduce((n, g) => n + g.hunkIds.length, 0))}
    </div>
    <div className="dc-rich-scroll" ref={root}>
      <nav className="dc-rich-outline" aria-label={t('director.sections')}>
        {sections.length ? sections.map(section => <div key={section.id}><button type="button"
          aria-current={section.selected ? 'page' : undefined} onClick={() => { if (!section.selected) onSection?.(section.id); }}>{section.label}</button>
          {section.selected && <div className="dc-rich-headings">{headingButtons}</div>}</div>)
          : <><strong>{label}</strong><div className="dc-rich-headings">{headingButtons}</div></>}
      </nav>
      <article className="dc-rich-paper" style={{ zoom: zoom / 100 }}><h2>{label}</h2><div className="dc-rich-body">{renderBlocks}</div>
        {patch.unresolvedRequests.length > 0 && <aside role="status">{patch.unresolvedRequests.map(text => <p key={text}>{text}</p>)}</aside>}
        {patch.reviews.filter(r => r.changeRevision === patch.revision).map(r => <aside key={r.id} role={r.status === 'blocked' ? 'alert' : 'status'}>
          <p>{t(r.status === 'blocked' ? 'director.planning.auditBlocked' : 'director.patch.reviewed')}</p>
          {r.status === 'blocked' && <details open><summary>{t('director.patch.auditDetails')}</summary>
            {(r.units ?? []).filter(unit => r.violatedPaths.includes(unit.path) || r.uncertainPaths.includes(unit.path)).map(unit =>
              <div key={unit.path}>{unit.findings.filter(finding => finding.verdict !== 'supported').map((finding, i) => <div key={i}>
                <blockquote>{finding.candidateQuote}</blockquote><p>{finding.reason}</p>
                {finding.sourceEvidence.length > 0 && <details><summary>{t('director.patch.sourceEvidence')}</summary>
                  {finding.sourceEvidence.map((evidence, index) => <blockquote key={index}>{evidence.quote}</blockquote>)}
                </details>}
              </div>)}</div>)}
          </details>}
          {r.literaryNotes.map(note => <p key={note}>{note}</p>)}</aside>)}
      </article>
    </div>
  </Fragment>;
}
