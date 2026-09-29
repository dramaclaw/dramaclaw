// SPDX-License-Identifier: Elastic-2.0
import { create } from 'zustand';
import { normalizeBoardMetadata, type BoardMetadata, type MediaKind, type ElementTag } from './projection';

interface MetadataState {
  scope: string; metadata: BoardMetadata; revision: number;
  hydrate: (scope: string, raw: unknown) => void;
  reorder: (kind: MediaKind, ids: string[]) => void;
  tag: (id: string, tag?: ElementTag) => void;
}
export const useStoryboardMetadata = create<MetadataState>((set) => ({
  scope: '', metadata: normalizeBoardMetadata(null), revision: 0,
  hydrate: (scope, raw) => set({ scope, metadata: normalizeBoardMetadata(raw), revision: 0 }),
  reorder: (kind, ids) => set(s => ({ metadata: { ...s.metadata, order: { ...s.metadata.order, [kind]: ids } }, revision: s.revision + 1 })),
  tag: (id, tag) => set(s => {
    const elementTags = { ...s.metadata.elementTags }; if (tag) elementTags[id] = tag; else delete elementTags[id];
    return { metadata: { ...s.metadata, elementTags }, revision: s.revision + 1 };
  }),
}));

interface ViewState {
  scope: string; mode: 'workflow' | 'storyboard'; host: HTMLElement | null; historyHost: HTMLElement | null;
  widths: number[]; scroll: Record<string, number>;
  enterScope: (scope: string) => void;
  leaveScope: () => void;
  setMode: (mode: ViewState['mode']) => void;
  setHost: (host: HTMLElement | null) => void;
  setHistoryHost: (historyHost: HTMLElement | null) => void;
  setWidths: (widths: number[]) => void;
  setScroll: (key: string, value: number) => void;
}
function remember(s: Pick<ViewState, 'scope' | 'mode' | 'widths' | 'scroll'>) {
  try { localStorage.setItem(`dramaclaw:storyboard:${s.scope}`, JSON.stringify({ mode: s.mode, widths: s.widths, scroll: s.scroll })); } catch { /* Optional personal preference. */ }
}
export const useStoryboardView = create<ViewState>((set, get) => ({
  scope: '', mode: 'workflow', host: null, historyHost: null, widths: [1, 1, 1], scroll: {},
  enterScope: scope => {
    if (scope === get().scope) return;
    let stored: Partial<ViewState> = {};
    try { const raw = JSON.parse(localStorage.getItem(`dramaclaw:storyboard:${scope}`) ?? '{}'); if (raw && typeof raw === 'object' && !Array.isArray(raw)) stored = raw; } catch { /* Ignore old/corrupt preferences. */ }
    const scroll = stored.scroll && typeof stored.scroll === 'object' ? Object.fromEntries(Object.entries(stored.scroll).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) : {};
    set({ scope, host: null, historyHost: null, mode: stored.mode === 'storyboard' ? 'storyboard' : 'workflow',
      widths: Array.isArray(stored.widths) && stored.widths.length === 3 && stored.widths.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0.35) ? stored.widths : [1, 1, 1], scroll });
  },
  leaveScope: () => set({ scope: '', mode: 'workflow', host: null, historyHost: null }),
  setMode: mode => { set({ mode, host: null, historyHost: null }); remember(get()); },
  setHost: host => set({ host }),
  setHistoryHost: historyHost => set({ historyHost }),
  setWidths: widths => { set({ widths }); remember(get()); },
  setScroll: (key, value) => { set(s => ({ scroll: { ...s.scroll, [key]: value } })); remember(get()); },
}));

export const storyboardActive = () => useStoryboardView.getState().mode === 'storyboard';
