// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Download, FolderOpen, FileText, ChevronRight, ChevronDown, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { encodeSkillFiles, installSkillImport, listSkillImports, parseCandidateBundle, retrySkillImport, skillImportStudioPrompt, submitSkillImports, validateSkillImport, sameCandidateBundle, type SkillImportItem } from './api';

const canReview = (item: SkillImportItem) => Boolean(item.bundle) && ['ready', 'needs_review', 'installed'].includes(item.status);

export function SkillImportDialog({ open, onOpenChange, project, taskId }: { open: boolean; onOpenChange: (open: boolean) => void; project: string; taskId?: string }) {
  const { t } = useTranslation();
  const tr = (key: string, defaultValue: string) => t(`skillImport.${key}`, { defaultValue });
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<SkillImportItem | null>(null);
  const [draft, setDraft] = useState('');
  const [resultOpen, setResultOpen] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setAcknowledged(false); }, [selected?.id, draft, open]);
  const query = useQuery({
    queryKey: ['skill-imports', project],
    queryFn: () => listSkillImports(project),
    enabled: open && Boolean(project),
    refetchInterval: open ? 3000 : false,
  });
  const items = query.data?.items ?? [];
  const failed = items.filter(item => item.status === 'failed');
  const report = selected?.quality_report;
  const draftChanged = Boolean(selected) && !sameCandidateBundle(draft, selected?.bundle ?? null);
  const reportPassed = report?.version === 3 && report.validated && !report.blockers.length && [report.structure, report.coverage].every(check => check.status === 'passed');
  const needsAcknowledgment = selected?.status === 'needs_review' || Boolean(selected?.warnings?.length);
  useEffect(() => { setSelected(null); setDraft(''); setError(''); setNotice(''); }, [project, open]);
  const openedTask = useRef<string | null>(null);
  useEffect(() => { openedTask.current = null; }, [open, project, taskId]);
  useEffect(() => {
    if (!open || !taskId || openedTask.current === taskId) return;
    const match = items.find(item => item.task_id === taskId);
    if (!match || !canReview(match)) return;
    openedTask.current = taskId;
    setResultOpen(true); setSelected(match); setDraft(JSON.stringify(match.bundle, null, 2));
  }, [open, taskId, query.data]);
  useEffect(() => {
    const latest = items.find(item => item.id === selected?.id);
    if (!latest || latest === selected) return;
    // Polling updates validation state without overwriting work in the editor.
    if (selected && sameCandidateBundle(draft, selected.bundle)) setDraft(JSON.stringify(latest.bundle, null, 2));
    setSelected(latest);
    setAcknowledged(false);
  }, [query.data, selected?.id]);
  const refresh = () => client.invalidateQueries({ queryKey: ['skill-imports', project] });
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function retry(itemsToRetry: SkillImportItem[]) {
    await action(async () => {
      // Each admission reports independently; successful siblings are never retried.
      const results = await Promise.allSettled(itemsToRetry.map(item => retrySkillImport(project, item.id)));
      await refresh();
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (errors.length) throw new Error(errors.map(result => String(result.reason)).join('\n'));
    });
  }
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      overlayClassName="z-[70] bg-black/60 supports-backdrop-filter:backdrop-blur-sm"
      closeButtonClassName="top-5 right-5"
      className={`z-[71] flex max-h-[85vh] flex-col gap-0 overflow-hidden border border-border bg-card p-0 shadow-2xl ${project ? 'sm:max-w-3xl' : 'sm:max-w-md'}`}
    >
      <DialogHeader className="gap-3 border-b border-border px-6 py-5 pr-14">
        <DialogTitle className="flex items-center gap-2.5 text-base">
          <Download aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {tr('title', 'Convert external skills')}
        </DialogTitle>
        <DialogDescription className="text-xs leading-relaxed">{tr('description', 'Convert Markdown skill packages into native Skills and Recipes. Review the result before installing.')}</DialogDescription>
      </DialogHeader>
      {!project ? <>
        <div className="flex flex-col items-center px-8 py-9 text-center">
          <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-border bg-background/50">
            <FolderOpen aria-hidden="true" className="size-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-medium">{tr('selectProjectTitle', 'Open a project to continue')}</p>
          <p className="mt-2 max-w-72 text-xs leading-6 text-muted-foreground">{tr('projectRequired', 'Open a project to convert external skills.')}</p>
        </div>
        <div className="flex justify-end border-t border-border bg-background/20 px-6 py-4">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>{tr('backToSettings', 'Back to settings')}</Button>
        </div>
      </> : <div className="flex min-h-0 flex-1 flex-col gap-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-background/30 p-4">
          <input ref={input} type="file" multiple accept=".md,.zip" className="hidden" aria-label={tr('chooseFiles', 'Choose Markdown or ZIP files')} disabled={busy} onChange={event => {
            const files = Array.from(event.target.files ?? []); event.target.value = '';
            if (!files.length) return;
            void action(async () => { await submitSkillImports(project, await encodeSkillFiles(files)); await refresh(); setNotice(tr('submitted', 'Submitted. Conversion continues in the task center after this window closes.')); });
          }} />
          <Button size="sm" disabled={busy} onClick={() => input.current?.click()}><Download aria-hidden="true" className="mr-1 size-3.5" />{tr('upload', 'Upload MD / ZIP')}</Button>
          <Button size="sm" variant="outline" disabled={busy || !failed.length} onClick={() => void retry(failed)}>{tr('retryFailed', 'Retry failed')}</Button>
          <span className="mt-1 w-full text-xs leading-relaxed text-muted-foreground">{tr('limits', 'Up to 20 files; 2 MB each, 10 MB total. One skill per file or ZIP.')}</span>
        </div>
        {query.isLoading && <p role="status">{tr('loading', 'Loading…')}</p>}
        {(error || query.error) && <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{error || String(query.error)}</p>}
        {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {!query.isLoading && !query.error && !items.length && <p className="py-6 text-sm text-muted-foreground">{tr('empty', 'Upload a skill to start. Existing native JSON imports remain available in skill settings.')}</p>}
          {items.length > 0 && <div className="flex items-baseline justify-between gap-3 pb-1">
            <h3 className="text-sm font-medium">{tr('historyTitle', 'Conversion history')} <span className="ml-2 text-xs font-normal text-muted-foreground">{t('skillImport.recordCount', { count: items.length, defaultValue: 'Records: {{count}}' })}</span></h3>
            <p className="text-xs text-muted-foreground">{tr('historyHint', 'Each upload creates a separate conversion record.')}</p>
          </div>}
          <ul className="divide-y divide-border border-y border-border">
          {items.map(item => {
            const title = typeof item.bundle?.name === 'string' ? item.bundle.name : item.name;
            const active = ['queued', 'running'].includes(item.status);
            const legacy = item.quality_report?.version !== 3 && Boolean(item.bundle) && !active && item.status !== 'installed';
            const date = new Date(typeof item.created_at === 'number' ? item.created_at * 1000 : item.created_at);
            const issues = [...new Set([...(item.quality_report?.blockers ?? []), ...(item.warnings ?? []), ...(item.error ? [item.error] : [])])];
            const summary = active ? tr('recordRunning', 'Conversion is running in the background. You can close this window.')
              : item.status === 'installed' ? tr('recordInstalled', 'Added to your skill library.')
              : item.status === 'failed' ? tr('recordFailed', 'Conversion stopped. Expand the details, then retry.')
              : legacy ? tr('recordLegacy', 'This draft needs the latest checks. Open it to submit validation.')
              : item.quality_report?.validated ? tr('recordReady', 'Checks passed. Review the draft before adding it to your library.')
              : tr('recordBlocked', 'Some requirements are unresolved. Open the result to review what needs attention.');
            return <li key={item.id} className="grid grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-2 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex min-w-0 items-start gap-2.5">
                <FileText aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="break-words text-sm font-medium">{title}</h4>
                    <span className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{legacy ? tr('recordLegacyBadge', 'Needs revalidation') : tr(`status.${item.status}`, item.status)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{title !== item.name && <span>{item.name} · </span>}{!Number.isNaN(date.getTime()) && <time dateTime={date.toISOString()}>{date.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</time>}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{summary}</p>
                  {active && item.stage && <p className="mt-2 text-xs">{tr(`stage.${item.stage}`, item.stage)}</p>}
                </div>
              </div>
              <div className="flex shrink-0 items-start justify-end gap-1 sm:pt-0.5">
                {(['failed', 'needs_review', 'ready'].includes(item.status)) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void retry([item])}><RotateCcw aria-hidden="true" className="size-3" />{tr('retry', 'Retry')}</Button>}
                {canReview(item) && <Button size="sm" variant="outline" disabled={busy} aria-expanded={resultOpen && selected?.id === item.id} aria-controls={`skill-import-result-${item.id}`} onClick={() => { if (selected?.id === item.id) { setResultOpen(value => !value); } else { setSelected(item); setDraft(JSON.stringify(item.bundle, null, 2)); setResultOpen(true); } setError(''); }}>{resultOpen && selected?.id === item.id ? tr('collapseResult', 'Collapse result') : tr('review', 'Review')}{resultOpen && selected?.id === item.id ? <ChevronDown aria-hidden="true" className="size-3" /> : <ChevronRight aria-hidden="true" className="size-3" />}</Button>}
              </div>
                {!active && <details className="min-w-0 pl-6 text-xs text-muted-foreground sm:col-span-2">
                  <summary className="cursor-pointer py-1.5">{tr('recordDetails', 'Details')}{issues.length > 0 ? ` · ${t('skillImport.issueCount', { count: issues.length, defaultValue: '{{count}} notices' })}` : ''}</summary>
                  <div className="space-y-2 py-2"><p className="break-all font-mono text-[11px]">ID: {item.id}</p>{issues.map((issue, index) => <p className="break-words leading-relaxed" key={index}>{issue}</p>)}</div>
                </details>}
          {resultOpen && selected?.id === item.id && canReview(selected) && <section id={`skill-import-result-${item.id}`} className="min-w-0 space-y-3 border-l-2 border-border py-3 pl-4 sm:col-span-2">
            <p className="text-sm font-medium">{selected.name} · {tr('candidate', 'Conversion draft')}</p>
            <p className="text-xs text-muted-foreground">{tr('reviewHint', 'Schema validation does not prove production quality. Check that the original method and required capabilities are preserved.')}</p>
            {report?.version === 3 ? <div className="space-y-3 text-sm">
              <dl className="grid gap-3 sm:grid-cols-2">
                {(['structure', 'coverage'] as const).map(key => <div key={key} className="rounded-md bg-muted p-3">
                  <dt className="font-medium">{tr(`quality.${key}`, { structure: 'Structure', coverage: 'Method coverage', planning: 'Planning check' }[key])}</dt>
                  <dd>{tr(`quality.status.${report[key].status}`, { passed: 'Passed', failed: 'Failed', not_run: 'Not run' }[report[key].status])}</dd>
                  {report[key].issues.map((issue, index) => <dd className="mt-1 break-words" key={index}>{issue}</dd>)}
                </div>)}
              </dl>
              {report.blockers.length > 0 && <div>
                <p className="font-medium">{tr('quality.blockers', 'Installation blockers')}</p>
                <ul className="list-disc space-y-1 pl-5">{report.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>
              </div>}
              {(report.findings ?? []).some(finding => finding.severity === 'warning') && <div className="space-y-2">
                <p className="font-medium">{tr('conversionNotes', 'Conversion notes')}</p>
                {(report.findings ?? []).filter(finding => finding.severity === 'warning').map((finding, index) => <p key={index} className="break-words text-muted-foreground">{finding.message}</p>)}
              </div>}
            </div> : <p className="text-sm">{tr('revalidationRequired', 'Revalidation required. Validate this draft before installing.')}</p>}
            {draftChanged && <p className="text-sm">{tr('draftChanged', 'Draft changed. The results above apply to the previous version. Validate your changes before installing.')}</p>}
            <Textarea aria-label={tr('bundleLabel', 'Native Skill Bundle')} value={draft} onChange={event => setDraft(event.target.value)} className="min-h-64 font-mono text-xs" disabled={busy || selected.status === 'installed'} />
            {needsAcknowledgment && <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} disabled={busy || selected.status === 'installed'} />
              {tr('acknowledgeWarnings', 'I reviewed the conversion warnings and resolved any required changes.')}
            </label>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy || selected.status === 'installed'} onClick={() => void action(async () => {
                const updated = await validateSkillImport(project, selected.id, parseCandidateBundle(draft));
                setSelected(updated); setDraft(JSON.stringify(updated.bundle, null, 2)); setAcknowledged(false);
                client.setQueryData<{ items: SkillImportItem[] }>(['skill-imports', project], previous => previous ? { ...previous, items: previous.items.map(item => item.id === updated.id ? updated : item) } : previous);
                setNotice(tr('validationSubmitted', 'Validation submitted. Review the new results when it finishes.'));
              })}>{tr('validateDraft', 'Validate edited draft')}</Button>
              <Button size="sm" disabled={busy || !['ready', 'needs_review'].includes(selected.status) || !reportPassed || draftChanged || (needsAcknowledgment && !acknowledged)} onClick={() => void action(async () => {
                await installSkillImport(project, selected.id, parseCandidateBundle(draft), acknowledged);
                setSelected({ ...selected, status: 'installed' });
                await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['freezone-agent-config'] })]);
                setNotice(tr('installed', 'Installed in your skill library.'));
              })}>{tr('install', 'Install')}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async () => {
                await navigator.clipboard.writeText(skillImportStudioPrompt(parseCandidateBundle(draft)));
                setNotice(tr('copied', 'Copied. Paste into the canvas chat to continue editing in Skill Studio.'));
              })}>{tr('copyToChat', 'Copy for Skill Studio')}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async () => {
                const bundle = parseCandidateBundle(draft);
                const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
                const a = document.createElement('a'); a.href = url; a.download = 'skill-bundle.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
              })}>{tr('download', 'Download JSON')}</Button>
            </div>
          </section>}
            </li>;
          })}
          </ul>

        </div>
      </div>}
    </DialogContent>
  </Dialog>;
}
