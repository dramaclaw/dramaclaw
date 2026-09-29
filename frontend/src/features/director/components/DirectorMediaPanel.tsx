// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Media controls share the provider catalog, but never the old canvas UI state. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { approveDirectorBatch, cancelDirectorBatch, listDirectorBatches, prepareDirectorBatch, type DirectorBatchPrepare, type DirectorMediaBatch,
  confirmDirectorMedia, getDirectorMediaSource, listDirectorMedia, prepareDirectorMedia,
  type DirectorMediaIntent, type DirectorMediaKind, type DirectorMediaPrepare, type DirectorMediaSource } from '@/api/director';
import { fetchFreezoneImageModels, fetchFreezoneJobResult, type FreezoneImageModelInfo } from '@/api/ops';
import { listTasks } from '@/api/tasks';
import { resolveMediaUrl } from '@/lib/media-url';

export function DirectorMediaPanel({ project, workId, kind, onClose, onKind }: {
  project: string; workId: string; kind: DirectorMediaKind; onClose: () => void; onKind: (kind: DirectorMediaKind) => void;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<DirectorMediaSource | null>(null);
  const [models, setModels] = useState<FreezoneImageModelInfo[]>([]);
  const [modelId, setModelId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [ratio, setRatio] = useState('1:1'), [size, setSize] = useState('2K'), [quality, setQuality] = useState('medium');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [intents, setIntents] = useState<DirectorMediaIntent[]>([]);
  const [quote, setQuote] = useState<DirectorMediaIntent | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<Record<string, { status: string; url?: string }>>({});
  const preparing = useRef<DirectorMediaPrepare | null>(null);
  const batchPreparing = useRef<DirectorBatchPrepare | null>(null);
  const [batchMode, setBatchMode] = useState(true);
  const [batches, setBatches] = useState<DirectorMediaBatch[]>([]);
  const [batch, setBatch] = useState<DirectorMediaBatch | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPrompts, setBatchPrompts] = useState<Record<string, string>>({});
  const model = models.find(item => item.id === modelId);
  const definitions = model?.request?.parameters?.filter(item => !item.modes?.length || item.modes.includes('text_to_image')) ?? [];
  const missingParameter = definitions.some(item => item.required && (params[item.key] === undefined || params[item.key] === '' || (Array.isArray(params[item.key]) && (params[item.key] as unknown[]).length === 0)));
  const upsert = (item: DirectorMediaIntent) => setIntents(values => [...values.filter(value => value.id !== item.id), item]);
  useEffect(() => {
    let active = true;
    setSource(null); setAssetId(''); setPrompt(''); setQuote(null); setBatch(null); setError(''); preparing.current = null; batchPreparing.current = null;
    Promise.all([getDirectorMediaSource(project, workId, kind), fetchFreezoneImageModels(project), listDirectorMedia(project, workId), listDirectorBatches(project, workId)]).then(([next, catalog, history, plans]) => {
      if (!active) return;
      setSource(next); setModels(catalog); setModelId(catalog[0]?.id ?? ''); setIntents(history);
      setBatches(plans);
      setBatchPrompts(Object.fromEntries(next.assets.map(asset => [asset.id, `${t(`director.media.prompt.${kind}`)}\n${asset.text}\n${next.style}`])));
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [project, workId, kind]);
  useEffect(() => {
    setRatio(model?.ratioOptions?.[0] ?? '1:1'); setSize(model?.resolutionOptions?.[0] ?? '2K'); setQuality(model?.qualityOptions?.[0] ?? 'medium');
    setParams(Object.fromEntries((model?.request?.parameters ?? []).filter(item => (item.default !== undefined || item.control === 'switch') && (!item.modes?.length || item.modes.includes('text_to_image'))).map(item => [item.key, item.default ?? false])));
  }, [model]);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    const finished = new Set<string>();
    const poll = async () => {
      try {
        const tasks = await listTasks(project);
        for (const item of intents.filter(value => value.status === 'accepted')) {
          if (finished.has(item.id)) continue;
          const task = tasks.find(task => task.task_key === item.result.task_key);
          let url: string | undefined;
          if ((!task || task.status === 'completed') && item.result.job_id) {
            try {
              const result = await fetchFreezoneJobResult(project, 'freezone_gen', item.result.job_id);
              url = resolveMediaUrl(result.url) ?? undefined;
            } catch { /* One unavailable result cannot hide other completed assets. */ }
          }
          const status = url ? 'completed' : task?.status ?? 'accepted';
          if (url || status === 'failed' || status === 'cancelled') finished.add(item.id);
          if (active) setOutcomes(previous => ({ ...previous, [item.id]: { status, url } }));
        }
      } catch { /* Reading progress must never restart a paid request. */ }
      if (active && intents.some(value => value.status === 'accepted' && !finished.has(value.id))) timer = setTimeout(() => void poll(), 3000);
    };
    if (intents.some(value => value.status === 'accepted')) void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [project, intents]);
  const prepare = async () => {
    if (!source || !model || busy) return;
    setBusy(true); setError('');
    const fields = { work_revision: source.workRevision, document_version: source.documentVersion, kind,
      asset_id: assetId, prompt, model_id: model.id, aspect_ratio: ratio, image_size: size, quality, model_params: params };
    if (!preparing.current || JSON.stringify({ ...preparing.current, intent_id: undefined }) !== JSON.stringify(fields))
      preparing.current = { ...fields, intent_id: crypto.randomUUID() };
    try { const result = await prepareDirectorMedia(project, workId, preparing.current); upsert(result); setQuote(result); setAcknowledged(false); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!quote || !acknowledged || busy) return;
    setBusy(true); setError('');
    try { const result = await confirmDirectorMedia(project, workId, quote.id); upsert(result); setQuote(null); preparing.current = null; }
    catch { setError(t('director.media.unknown')); /* Keep the same ID; GET or confirm replay cannot dispatch twice. */ }
    finally { setBusy(false); }
  };
  const prepareBatch = async () => {
    if (!source || !model || busy) return;
    const fields = { work_revision: source.workRevision, document_version: source.documentVersion, kind,
      model_id: model.id, aspect_ratio: ratio, image_size: size, quality, model_params: params, prompts: batchPrompts };
    if (!batchPreparing.current || JSON.stringify({ ...batchPreparing.current, id: undefined }) !== JSON.stringify(fields)) batchPreparing.current = { ...fields, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const value = await prepareDirectorBatch(project, workId, batchPreparing.current);
      setBatch(value); setSelectedIds(value.nodes.map(n => n.id)); setAcknowledged(false);
      setBatches(values => [...values.filter(b => b.id !== value.id), value]);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const actBatch = async (action: 'approve' | 'cancel') => {
    if (!batch || busy || (action === 'approve' && (!acknowledged || !selectedIds.length))) return;
    setBusy(true); setError('');
    try {
      const value = action === 'approve' ? await approveDirectorBatch(project, workId, batch.id, selectedIds) : await cancelDirectorBatch(project, workId, batch.id);
      setBatches(values => [...values.filter(b => b.id !== value.id), value]);
      setIntents(values => [...values.filter(i => !value.nodes.some(n => n.id === i.id)), ...value.nodes.map(n => n.intent)]);
      setBatch(null); batchPreparing.current = null;
    } catch (reason) { setError(`${t('director.media.unknown')} ${String(reason)}`); }
    finally { setBusy(false); }
  };
  return <section className="dc-media-panel" aria-label={t('director.media.title')}>
    <header><strong>{t('director.ui.creation')}</strong><button type="button" disabled={busy} onClick={onClose}>{t('director.close')}</button></header>
    <nav>{(['characters', 'scenes', 'props'] as const).map(value => <button key={value} type="button" disabled={busy} aria-pressed={value === kind} onClick={() => onKind(value)}>{t(`director.media.${value}`)}</button>)}</nav>
    <p>{t('director.media.sourceHint', { version: source?.documentVersion ?? 0 })}</p>
    {error && <p role="alert">{error}</p>}
    {!source ? <p role="status">{t('director.media.loading')}</p> : !source.assets.length ? <p>{t('director.media.empty')}</p> : <fieldset disabled={busy || Boolean(quote) || Boolean(batch)}>
      <label><input type="checkbox" checked={batchMode} onChange={event => setBatchMode(event.target.checked)} />{t('director.media.batch.mode')}</label>
      {batchMode ? <div className="dc-media-plan-roster"><p>{t('director.media.batch.hint', { count: source.assets.length })}</p>{source.assets.map(asset => <details key={asset.id}><summary>{Number(asset.id) + 1}. {asset.name}</summary><label>{t('director.media.promptLabel')}<textarea value={batchPrompts[asset.id] ?? ''} onChange={event => setBatchPrompts(values => ({ ...values, [asset.id]: event.target.value }))} /></label></details>)}</div> : <><label>{t('director.media.asset')}<select value={assetId} onChange={event => { setAssetId(event.target.value); const asset = source.assets.find(item => item.id === event.target.value); setPrompt(asset ? `${t(`director.media.prompt.${kind}`)}\n${asset.text}\n${source.style}` : ''); }}>
        <option value="">{t('director.media.choose')}</option>{source.assets.map(asset => <option key={asset.id} value={asset.id}>{Number(asset.id) + 1}. {asset.name}</option>)}
      </select></label>
      <label>{t('director.media.promptLabel')}<textarea value={prompt} onChange={event => setPrompt(event.target.value)} /></label></>}
      <label>{t('director.media.model')}<select value={modelId} onChange={event => setModelId(event.target.value)}>{models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      {!model && <p role="alert">{t('director.media.noModel')}</p>}
      <div className="dc-media-options">{([['ratio', ratio, setRatio, model?.ratioOptions?.length ? model.ratioOptions : ['1:1']], ['size', size, setSize, model?.resolutionOptions?.length ? model.resolutionOptions : ['2K']], ['quality', quality, setQuality, model?.qualityOptions?.length ? model.qualityOptions : ['medium']]] as const).map(([key, value, setter, choices]) => <label key={key}>{t(`director.media.${key}`)}<select value={value} onChange={event => setter(event.target.value)}>{choices.map(choice => <option key={choice}>{choice}</option>)}</select></label>)}</div>
      {definitions.map(definition => <label key={definition.key}>{definition.label}
        {definition.control === 'select' || definition.control === 'multiselect' ? <select multiple={definition.control === 'multiselect'} value={definition.control === 'multiselect' ? (params[definition.key] as unknown[] ?? []).map(String) : String(params[definition.key] ?? '')} onChange={event => {
          const selected = [...event.target.selectedOptions].map(option => definition.options?.find(value => String(value) === option.value)); setParams(current => ({ ...current, [definition.key]: definition.control === 'multiselect' ? selected : selected[0] }));
        }}>{definition.control === 'select' && <option value="">{t('director.media.choose')}</option>}{definition.options?.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> :
        definition.control === 'switch' ? <input type="checkbox" checked={params[definition.key] === true} onChange={event => setParams(current => ({ ...current, [definition.key]: event.target.checked }))} /> :
        <input type={definition.control === 'number' ? 'number' : 'text'} min={definition.min} max={definition.max} step={definition.step} value={String(params[definition.key] ?? '')} onChange={event => setParams(current => ({ ...current, [definition.key]: definition.control === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value }))} />}
      </label>)}
      <small>{t('director.media.catalogHint')}</small>
      <button type="button" className="dc-primary-button" disabled={!model || missingParameter || (batchMode ? source.assets.some(a => !(batchPrompts[a.id] ?? '').trim()) : !assetId || !prompt.trim())} onClick={() => void (batchMode ? prepareBatch() : prepare())}>{t(batchMode ? 'director.media.batch.prepare' : 'director.media.prepare')}</button>
    </fieldset>}
    {batch && <div className="dc-media-approval"><strong>{t('director.media.batch.approval')}</strong><p>{t('director.media.costUnknown')}</p>
      {batch.nodes.map(node => <details key={node.id}><summary><label><input type="checkbox" disabled={busy || batch.status !== 'planned'} checked={selectedIds.includes(node.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, node.id] : ids.filter(id => id !== node.id))} />{node.ordinal + 1}. {node.intent.request.source.asset.name}</label></summary><pre>{JSON.stringify(node.intent.request, null, 2)}</pre></details>)}
      <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />{t('director.media.acknowledge')}</label>
      <footer><button type="button" disabled={busy} onClick={() => void actBatch('cancel')}>{t('director.media.batch.cancel')}</button><button type="button" disabled={busy || !acknowledged || !selectedIds.length} className="dc-primary-button" onClick={() => void actBatch('approve')}>{t('director.media.batch.confirm', { count: selectedIds.length })}</button></footer>
    </div>}
    {quote && <div className="dc-media-approval"><strong>{quote.request.source.asset.name}</strong><p>{t('director.media.costUnknown')}</p><details><summary>{t('director.media.parameters')}</summary><pre>{JSON.stringify(quote.request.actual, null, 2)}</pre></details>
      <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} />{t('director.media.acknowledge')}</label>
      <footer><button type="button" disabled={busy} onClick={() => setQuote(null)}>{t('director.cancel')}</button><button type="button" className="dc-primary-button" disabled={!acknowledged || busy} onClick={() => void confirm()}>{t('director.media.confirm')}</button></footer>
    </div>}
    <h3>{t('director.media.history')}</h3>
    {batches.filter(b => b.nodes[0]?.intent.request.source.kind === kind).map(b => <article className="dc-media-receipt" key={b.id}><strong>{t('director.media.batch.summary', { count: b.nodes.length })}</strong><p>{t(`director.media.batch.status.${b.status}`)}</p>
      <ol>{b.nodes.map(n => <li key={n.id}>{n.intent.request.source.asset.name} · {t(`director.media.status.${outcomes[n.id]?.status ?? n.intent.status}`)}</li>)}</ol>
      {b.status !== 'cancelled' && b.nodes.some(n => n.intent.status === 'prepared') && <button type="button" disabled={busy} onClick={() => { setQuote(null); setBatch(b); setSelectedIds(b.status === 'approved' ? b.selectedIds : b.nodes.map(n => n.id)); setAcknowledged(false); }}>{t('director.media.resume')}</button>}
      <details><summary>{t('director.media.parameters')}</summary><pre>{JSON.stringify(b, null, 2)}</pre></details>
    </article>)}
    {intents.filter(item => item.request.source.kind === kind && !item.request.batchId).map(item => <article className="dc-media-receipt" key={item.id}><strong>{item.request.source.asset.name}</strong><p>{t(`director.media.status.${outcomes[item.id]?.status ?? item.status}`)}</p>
      {outcomes[item.id]?.url && <a href={outcomes[item.id].url} target="_blank" rel="noreferrer"><img src={outcomes[item.id].url} alt={item.request.source.asset.name} /></a>}
      {item.status === 'prepared' && <button type="button" disabled={busy} onClick={() => { setQuote(item); setAcknowledged(false); }}>{t('director.media.resume')}</button>}
      {(item.status === 'unknown' || item.status === 'submitting') && <p>{t('director.media.unknown')}</p>}
      <details><summary>{t('director.media.parameters')}</summary><pre>{JSON.stringify({ id: item.id, source: item.request.source, request: item.request.actual, receipt: item.result }, null, 2)}</pre></details>
    </article>)}
  </section>;
}
