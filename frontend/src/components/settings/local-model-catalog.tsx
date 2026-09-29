import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { fetchLocalCatalog, updateLocalCatalog, type CatalogProvider, type LocalCatalog } from '@/lib/local-model-catalog';

// Preview only: never treat these defaults as saved server configuration.
const providerPreviews: CatalogProvider[] = [
  { id: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', plan: '' },
  { id: 'ark', label: 'Volcengine · Agent Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', plan: '' },
].map(p => ({ ...p, configured: false, source: '', syncedAt: '', error: '', catalogDate: '' }));

function catalogLoadError(error: unknown): string {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
  if (status === 404) return 'backendUpdateRequired';
  if (status === 409) return 'localConfigUnavailable';
  return 'loadFailed';
}

export function LocalModelCatalogPanel() {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<LocalCatalog>();
  const [provider, setProvider] = useState('all');
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [keys, setKeys] = useState<Record<string, string>>({});
  const tr = (key: string) => t(`providerCatalog.${key}`);
  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try { setCatalog(await fetchLocalCatalog()); }
    catch (cause) { setLoadError(catalogLoadError(cause)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const unavailable = !catalog || Boolean(loadError);
  const disabled = busy || loading || unavailable;
  const rows = useMemo(() => (catalog?.models || []).filter(m =>
    (provider === 'all' || provider === m.provider) && (kind === 'all' || kind === m.kind) &&
    `${m.label} ${m.upstreamModel} ${m.providerLabel}`.toLowerCase().includes(search.toLowerCase())), [catalog, provider, kind, search]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('');
    try { await run(); } catch { setError(tr('saveFailed')); }
    finally { setBusy(false); }
  };
  const save = (path: string, body: unknown = {}) => action(async () => {
    setCatalog(await updateLocalCatalog(path, body));
    setMessage(tr('saved'));
  });
  return <section className="space-y-4" aria-label={tr('title')}>
    <div><h3 className="font-semibold">{tr('title')}</h3><p className="mt-1 text-sm text-muted-foreground">{tr('description')}</p></div>
    {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{tr('loading')}</p>}
    {loadError && <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3">
      <p role="alert" className="text-sm text-destructive">{tr(loadError)}</p>
      <p className="mt-2 text-xs text-muted-foreground">{tr('configurationUnavailable')}</p>
      <button type="button" disabled={loading} onClick={() => void load()} className="mt-3 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm disabled:opacity-40"><RefreshCw className="h-4 w-4" />{tr('retry')}</button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    <div className="grid gap-3">
      {(catalog?.providers || providerPreviews).map(p => <div key={p.id} className="rounded-xl border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><strong className="text-sm">{p.label}</strong><span className="ml-2 text-xs text-muted-foreground">{unavailable ? tr('statusUnknown') : p.configured ? tr('configured') : tr('needsKey')}{p.plan ? ` · ${p.plan}` : ''}</span></div>
          {p.id !== 'local' && <div className="flex gap-2">
            <button disabled={disabled || !p.configured} onClick={() => void action(async () => {
              const result = await api.post(`api/v1/model-gateway/local/providers/${p.id}/check`, { timeout: 60000 }).json<{ data: { connected: boolean; seconds: number; error: string } }>();
              setMessage(result.data.connected ? `${tr('connected')} · ${result.data.seconds}s` : tr(result.data.error));
              setCatalog(await fetchLocalCatalog());
            })} className="rounded-md border px-2 py-1 text-xs disabled:opacity-40">{tr('check')}</button>
            <button disabled={disabled} onClick={() => void save(`providers/${p.id}/refresh`)} className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-40"><RefreshCw className="h-3 w-3" />{tr('refresh')}</button>
          </div>}
        </div>
        {p.id !== 'local' && <div className="mt-4 space-y-3">
          <label className="block text-xs text-muted-foreground">{tr('baseUrl')}{!catalog ? ` · ${tr('presetAddress')}` : ''}
            <input readOnly aria-label={`${p.label} Base URL`} value={p.baseUrl} className="mt-1 w-full rounded-xl border bg-background px-3 py-2 font-mono text-xs text-foreground" />
          </label>
          <div>
            <label className="block text-xs text-muted-foreground" htmlFor={`provider-key-${p.id}`}>{tr('replaceKey')}</label>
            <form className="mt-1 flex flex-wrap gap-2" onSubmit={e => {
              e.preventDefault();
              if (disabled || !keys[p.id]?.trim()) return;
              void action(async () => {
                setCatalog(await updateLocalCatalog(`providers/${p.id}/key`, { api_key: keys[p.id].trim() }));
                setKeys(current => ({ ...current, [p.id]: '' }));
                setMessage(`${p.label} · ${tr('keySaved')}`);
              });
            }}>
              <input id={`provider-key-${p.id}`} type="password" autoComplete="new-password" spellCheck={false} disabled={disabled} aria-label={`${p.label} API Key`} placeholder={unavailable ? tr('keyUnavailable') : p.configured ? tr('keyConfiguredPlaceholder') : tr('keyPlaceholder')} value={keys[p.id] || ''} onChange={e => setKeys(current => ({ ...current, [p.id]: e.target.value }))} className="min-w-0 flex-1 rounded-xl border bg-background px-3 py-2 text-sm disabled:opacity-50" />
              <button type="submit" disabled={disabled || !keys[p.id]?.trim()} className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40">{tr('saveKey')}</button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">{tr('keyHelp')}</p>
          </div>
        </div>}
        {p.source && <p className="mt-3 text-xs text-muted-foreground">{tr(p.source)}{p.catalogDate ? ` · ${p.catalogDate}` : ''}{p.syncedAt ? ` · ${new Date(p.syncedAt).toLocaleString()}` : ''}</p>}
        {p.id === 'ark' && <p className="mt-1 text-xs text-muted-foreground">{tr('arkCatalogNote')}</p>}
        {p.error && <p className="mt-1 text-xs text-destructive">{tr(p.error)}</p>}
      </div>)}
    </div>
    {catalog && <><div className="grid gap-2 sm:grid-cols-3">{(['text', 'image', 'video'] as const).map(k => <label key={k} className="text-xs text-muted-foreground">{tr(`default_${k}`)}
      <select aria-label={tr(`default_${k}`)} disabled={disabled} value={catalog.defaults[k]} onChange={e => void save('preferences', { defaults: { [k]: e.target.value } })} className="mt-1 w-full rounded-md border bg-background p-2 text-foreground">
        {catalog.models.filter(m => m.kind === k && m.enabled && !m.blockedReason).map(m => <option key={m.id} value={m.id}>{m.label} · {m.providerLabel}</option>)}
      </select></label>)}</div>
    <div className="flex flex-wrap gap-2">
      <input aria-label={tr('search')} placeholder={tr('search')} value={search} onChange={e => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm" />
      <select aria-label={tr('provider')} value={provider} onChange={e => setProvider(e.target.value)} className="rounded-lg border bg-background p-2 text-sm"><option value="all">{tr('allProviders')}</option>{catalog.providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
      <select aria-label={tr('kind')} value={kind} onChange={e => setKind(e.target.value)} className="rounded-lg border bg-background p-2 text-sm">{['all', 'text', 'image', 'video', 'other'].map(k => <option key={k} value={k}>{tr(k)}</option>)}</select>
    </div>
    <div className="max-h-[390px] overflow-y-auto rounded-lg border divide-y divide-border">{rows.map(m => {
      const isDefault = Object.values(catalog.defaults).includes(m.id);
      return <label key={m.id} className="flex items-start gap-3 px-3 py-3 hover:bg-muted/30">
        <input type="checkbox" aria-label={`${tr('enable')} ${m.label} ${m.providerLabel}`} checked={m.enabled} disabled={disabled || Boolean(m.blockedReason) || isDefault} onChange={e => void save('preferences', { models: [{ id: m.id, enabled: e.target.checked }] })} className="mt-1" />
        <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.label}</div><div className="mt-0.5 break-all text-xs text-muted-foreground">{m.providerLabel} · {m.upstreamModel}</div>
          <div className="mt-1 text-xs text-muted-foreground">{tr(m.kind)}{m.inputModalities.includes('image') && m.kind === 'text' ? ` · ${tr('vision')}` : ''}{m.videoInput === 'sampled_frames' ? ` · ${tr('videoFrames')}` : ''}{isDefault ? ` · ${tr('isDefault')}` : ''}{m.blockedReason ? ` · ${tr(m.blockedReason)}` : ''}</div></div>
      </label>;
    })}{!rows.length && <p className="p-4 text-sm text-muted-foreground">{tr('empty')}</p>}</div>
    <p className="text-xs text-muted-foreground">{tr('defaultHint')}</p></>}
    {busy && <Loader2 aria-label={tr('loading')} className="h-4 w-4 animate-spin" />}
  </section>;
}
