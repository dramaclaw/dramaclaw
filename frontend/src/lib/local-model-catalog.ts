import { api } from '@/lib/api';

export interface CatalogModel {
  id: string;
  provider: string;
  providerLabel: string;
  upstreamModel: string;
  label: string;
  kind: 'text' | 'image' | 'video' | 'other';
  inputModalities: string[];
  videoInput: string;
  enabled: boolean;
  available: boolean;
  blockedReason: string;
  source: string;
}
export interface CatalogProvider {
  id: string;
  label: string;
  baseUrl: string;
  configured: boolean;
  source: string;
  syncedAt: string;
  error: string;
  plan: string;
  catalogDate: string;
}
export interface LocalCatalog {
  models: CatalogModel[];
  providers: CatalogProvider[];
  defaults: Record<string, string>;
}

const textEntries = new Map<string, CatalogModel>();
const mediaDefaults = new Map<string, string>();
export function rememberMediaDefault(kind: 'image' | 'video', payload: unknown) {
  const body = payload as { models?: unknown; data?: unknown } | null;
  const rows = Array.isArray(payload) ? payload : body?.models ?? body?.data;
  const entry = Array.isArray(rows) ? rows.find(m => m?.isDefault === true && typeof m.id === 'string') : undefined;
  if (entry) mediaDefaults.set(kind, entry.id);
  else mediaDefaults.delete(kind);
}
export function readMediaDefault(kind: 'image' | 'video'): string | undefined {
  return mediaDefaults.get(kind);
}
export function rememberTextModels(entries: CatalogModel[] = []) {
  textEntries.clear();
  for (const entry of entries) textEntries.set(entry.id, entry);
}
export function textModelPresentation(id: string) {
  const entry = textEntries.get(id);
  const [provider, upstream] = id.includes('::') ? id.split('::') : ['siliconflow', id];
  return {
    label: entry?.label || upstream.split('/').pop() || id,
    providerLabel: entry?.providerLabel || (provider === 'ark' ? 'Volcengine · Agent Plan' : 'SiliconFlow'),
  };
}
export function textModelAccepts(id: string, kind: 'text' | 'image' | 'video') {
  if (kind === 'text') return true;
  const entry = textEntries.get(id);
  if (entry) return entry.inputModalities.includes('image') && (kind !== 'video' || entry.videoInput === 'sampled_frames');
  return /^Qwen\/Qwen3-VL-/.test(id) || (kind === 'image' && id === 'zai-org/GLM-4.5V');
}
export async function fetchLocalCatalog(): Promise<LocalCatalog> {
  return (await api.get('api/v1/model-gateway/local/catalog', { timeout: 10000, retry: 0 }).json<{ data: LocalCatalog }>()).data;
}
export async function updateLocalCatalog(path: string, json: unknown = {}): Promise<LocalCatalog> {
  const result = (await api.post(`api/v1/model-gateway/local/${path}`, { json, timeout: 60000 }).json<{ data: LocalCatalog }>()).data;
  for (const kind of ['image', 'video']) {
    const id = result.defaults[kind];
    if (id) mediaDefaults.set(kind, id);
  }
  window.dispatchEvent(new Event('media-model-catalog-updated'));
  return result;
}
