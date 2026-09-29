// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, Check, Columns3, FileText, Film, GripVertical, Image as ImageIcon, Maximize2, Minimize2, Music, Network, Plus, Search, X, LocateFixed, Pencil, Copy, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { attachReferenceEdge } from '@/features/canvas/application/attachReference';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';
import { eligibleReferenceIds } from './references';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { buildStoryboardProjection, orderedCards, reorderCards, ELEMENT_TAGS, type BoardCard, type MediaKind, type ElementTag } from './projection';
import { useStoryboardMetadata, useStoryboardView } from './storyboardStore';
import './storyboard.css';

const icons = { text: FileText, image: ImageIcon, video: Film, audio: Music };
const dragType = 'application/x-dramaclaw-storyboard-node';
const mediaUrl = (url: string) => url ? resolveImageDisplayUrl(url) : undefined;
function selectNode(id: string | null) {
  const s = useCanvasStore.getState();
  s.onNodesChange(s.nodes.filter(n => Boolean(n.selected) !== (n.id === id)).map(n => ({ id: n.id, type: 'select' as const, selected: n.id === id })));
  s.setSelectedNode(id);
}

export function StoryboardModeSwitch({ scope, disabled }: { scope: string; disabled: boolean }) {
  const { t } = useTranslation();
  const mode = useStoryboardView(s => s.scope === scope ? s.mode : 'workflow');
  const switchMode = (next: 'workflow' | 'storyboard') => {
    if (next === mode) return;
    selectNode(null);
    document.querySelectorAll<HTMLMediaElement>('.sb-root video, .sb-root audio').forEach(m => m.pause());
    useStoryboardView.getState().setMode(next);
  };
  return <div className="sb-mode-switch" role="group" aria-label={t('storyboard.viewMode')}>
    <button title={t('storyboard.workflow')} aria-label={t('storyboard.workflow')} aria-pressed={mode === 'workflow'} disabled={disabled} onClick={() => switchMode('workflow')}><Network size={16} /><span>{t('storyboard.workflow')}</span></button>
    <button title={t('storyboard.storyboard')} aria-label={t('storyboard.storyboard')} aria-pressed={mode === 'storyboard'} disabled={disabled} onClick={() => switchMode('storyboard')}><Columns3 size={16} /><span>{t('storyboard.storyboard')}</span></button>
  </div>;
}

function ScrollArea({ name, children, className = '' }: { name: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = useStoryboardView.getState().scroll[name] ?? 0; }, [name]);
  return <div ref={ref} className={`sb-scroll ${className}`} onScroll={e => useStoryboardView.getState().setScroll(name, e.currentTarget.scrollTop)}>{children}</div>;
}

function Thumbnail({ card }: { card: BoardCard }) {
  const Icon = icons[card.kind];
  return card.kind === 'image' && card.url || card.kind === 'video' && card.poster
    ? <img src={mediaUrl(card.kind === 'image' ? card.url : card.poster)} alt={card.name} loading="lazy" draggable={false} />
    : <Icon size={20} />;
}

function Preview({ card, large = false }: { card: BoardCard; large?: boolean }) {
  const { t } = useTranslation();
  if (!card.url) return <div className="sb-media-empty">{card.busy ? t('storyboard.generating') : t('storyboard.noResult')}</div>;
  if (card.kind === 'image') return <img className={large ? 'sb-large-image' : 'sb-card-image'} src={mediaUrl(card.url)} alt={card.name} loading="lazy" draggable={false} />;
  if (card.kind === 'audio') return <audio controls preload="none" src={mediaUrl(card.url)} />;
  return <video key={card.url} className={large ? 'sb-large-video' : 'sb-card-video'} controls playsInline preload="none" poster={mediaUrl(card.poster)} src={mediaUrl(card.url)} onPlay={e => {
    const current = e.currentTarget;
    document.querySelectorAll<HTMLMediaElement>('.sb-root video, .sb-root audio').forEach(media => { if (media !== current) media.pause(); });
  }} />;
}

export function StoryboardView({ scope }: { scope: string }) {
  const { t } = useTranslation();
  const nodes = useCanvasStore(s => s.nodes), edges = useCanvasStore(s => s.edges);
  const selectedId = useCanvasStore(s => s.selectedNodeId);
  const metadata = useStoryboardMetadata(s => s.metadata);
  const cards = useMemo(() => buildStoryboardProjection(nodes, edges, metadata), [nodes, edges, metadata]);
  const byId = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<MediaKind | null>(null);
  const [assetTab, setAssetTab] = useState<'audio' | 'assets'>('audio');
  const [assetTag, setAssetTag] = useState<string>('all');
  const widths = useStoryboardView(s => s.widths);
  const root = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [picker, setPicker] = useState(false);
  const [refQuery, setRefQuery] = useState('');
  const setHost = useStoryboardView(s => s.setHost);
  const setHistoryHost = useStoryboardView(s => s.setHistoryHost);
  const pickRequest = useReferencePickStore(s => s.request);
  const referenceCandidates = useMemo(() => selected ? eligibleReferenceIds(cards, edges, selected) : new Set<string>(), [cards, edges, selected]);
  const managed = selected ? isSystemManagedNodeData(selected.node.data) : false;
  useEffect(() => { setEditing(false); setPicker(false); }, [selectedId]);
  useEffect(() => () => { setHost(null); setHistoryHost(null); useReferencePickStore.getState().stop(); }, [setHost, setHistoryHost]);
  useEffect(() => {
    if (pickRequest?.targetNodeId === selectedId) {
      setPicker(true);
      useReferencePickStore.getState().stop();
    }
  }, [pickRequest, selectedId]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')) return;
      if (picker) setPicker(false); else if (editing) setEditing(false); else if (selectedId) selectNode(null); else setExpanded(null);
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [picker, editing, selectedId]);
  const visibleCards = (kind: MediaKind) => orderedCards(cards, kind, metadata).filter(c =>
    !c.tag && (c.name + c.text).toLowerCase().includes(query.toLowerCase()) &&
    (kind !== 'video' || filter === 'all' || (filter === 'generating' ? c.busy : filter === 'failed' ? Boolean(c.error) : Boolean(c.url) && !c.busy)));
  const open = (id: string) => { setEditing(false); selectNode(id); };
  const locate = (id: string) => { useStoryboardView.getState().setMode('workflow'); useCanvasStore.getState().requestFocusNode(id); };
  const attach = (source: string, target: string) => {
    if (isSystemManagedNodeData(byId.get(target)?.node.data)) return;
    if (!referenceCandidates.has(source)) return;
    attachReferenceEdge(source, target);
  };
  const reorder = (sourceId: string, target: BoardCard) => {
    if (byId.get(sourceId)?.kind !== target.kind) return;
    const allIds = orderedCards(cards, target.kind, metadata).map(c => c.id);
    useStoryboardMetadata.getState().reorder(target.kind, reorderCards(allIds, sourceId, target.id));
  };
  const moveBy = (card: BoardCard, delta: number) => {
    const ids = orderedCards(cards, card.kind, metadata).map(c => c.id), index = ids.indexOf(card.id), next = index + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[index], ids[next]] = [ids[next], ids[index]];
    useStoryboardMetadata.getState().reorder(card.kind, ids);
  };
  const create = (kind: MediaKind) => {
    const types = { text: CANVAS_NODE_TYPES.textAnnotation, image: CANVAS_NODE_TYPES.imageGen, video: CANVAS_NODE_TYPES.video, audio: CANVAS_NODE_TYPES.audio };
    // New nodes alone get initial positions; existing groups/coordinates are never rearranged.
    const right = Math.max(0, ...nodes.filter(n => !n.parentId).map(n => n.position.x + (n.width ?? 480)));
    const id = useCanvasStore.getState().addNode(types[kind], { x: right + 120, y: 100 }, kind === 'text' ? { mode: 'writing', pickerDismissed: true } : {});
    open(id);
  };
  const refs = (card: BoardCard, editable = false) => <div className={`sb-references ${editable ? 'sb-drop-zone' : ''}`}
    aria-label={t('storyboard.references')} onDragOver={e => { if (editable && !managed && e.dataTransfer.types.includes(dragType)) { e.preventDefault(); e.dataTransfer.dropEffect = 'link'; } }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); if (editable && !managed) attach(e.dataTransfer.getData(dragType), card.id); }}>
    {card.references.map(id => { const ref = byId.get(id); return ref && <div className="sb-reference" key={id}>
      <button title={ref.name} aria-label={`${t('storyboard.viewReference')}: ${ref.name}`} onClick={e => { e.stopPropagation(); open(id); }}><Thumbnail card={ref} /></button>
      {editable && !managed && <button className="sb-detach" title={t('storyboard.detach')} aria-label={`${t('storyboard.detach')}: ${ref.name}`} onClick={() => edges.filter(e => e.source === id && e.target === card.id).forEach(e => useCanvasStore.getState().deleteEdge(e.id))}><X size={10} /></button>}
    </div>; })}
    {editable && !managed && <button className="sb-add-reference" onClick={() => setPicker(v => !v)} title={t('storyboard.addReference')} aria-label={t('storyboard.addReference')}><Plus size={16} />{t('storyboard.addReference')}</button>}
  </div>;
  const renderCard = (card: BoardCard) => {
    const Icon = icons[card.kind];
    return <article key={card.id} className={`sb-card ${card.kind === 'text' ? 'sb-text-row' : ''} ${selectedId === card.id ? 'is-selected' : ''}`} data-card-id={card.id} data-kind={card.kind}
      draggable onDragStart={e => { e.dataTransfer.setData(dragType, card.id); e.dataTransfer.effectAllowed = 'all'; }}
      onDragOver={e => { if (e.dataTransfer.types.includes(dragType)) e.preventDefault(); }}
      onDrop={e => { e.preventDefault(); reorder(e.dataTransfer.getData(dragType), card); }}>
      <button className="sb-card-heading" onClick={() => open(card.id)} title={card.name}>
        {card.kind === 'text' && <Icon size={16} />}<span>{card.name}</span>
      </button>
      <button className="sb-grip" aria-label={`${t('storyboard.reorder')}: ${card.name}`} title={t('storyboard.reorderHelp')} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); moveBy(card, e.key === 'ArrowUp' ? -1 : 1); } }}><GripVertical size={14} /></button>
      {card.kind !== 'text' && <>
        <div className="sb-preview" onDoubleClick={() => open(card.id)}>{card.kind === 'image' ? <button className="sb-image-button" onClick={() => open(card.id)} aria-label={`${t('storyboard.details')}: ${card.name}`}><Preview card={card} /></button> : <Preview card={card} />}</div>
        <div className="sb-badges">{card.model && <span>{card.model}</span>}{card.duration > 0 && <span>{t('storyboard.seconds', { count: Math.round(card.duration * 10) / 10 })}</span>}{card.width > 0 && card.height > 0 && <span>{card.width} × {card.height}</span>}<button onClick={() => open(card.id)}>{t('storyboard.details')}</button></div>
        {refs(card)}
      </>}
      {card.busy && <div className="sb-status" role="status">{t('storyboard.generating')} {card.progress > 0 ? `${Math.round(card.progress)}%` : ''}<progress max={100} value={card.progress || undefined} /></div>}
      {card.error && <p className="sb-error" title={card.error}>{card.error}</p>}
    </article>;
  };
  const section = (kind: MediaKind) => <section className={`sb-section sb-${kind}`} key={kind} aria-label={t(`storyboard.${kind}`)}>
    <header><h2>{t(`storyboard.${kind}`)}</h2><div className="sb-section-actions">
      {kind === 'video' && <select aria-label={t('storyboard.filter')} value={filter} onChange={e => setFilter(e.target.value)}>{['all', 'ready', 'generating', 'failed'].map(f => <option value={f} key={f}>{t(`storyboard.${f}`)}</option>)}</select>}
      <button onClick={() => create(kind)} title={t('storyboard.create')} aria-label={`${t('storyboard.create')} ${t(`storyboard.${kind}`)}`}><Plus size={15} /></button>
      {kind !== 'text' && <button onClick={() => setExpanded(expanded === kind ? null : kind)} title={t('storyboard.expand')} aria-label={`${t('storyboard.expand')} ${t(`storyboard.${kind}`)}`}>{expanded === kind ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
    </div></header>
    <ScrollArea name={`${scope}:${kind}`}><div>{visibleCards(kind).map(renderCard)}{!visibleCards(kind).length && <div className="sb-empty">{t('storyboard.empty')}</div>}</div></ScrollArea>
  </section>;
  const assets = cards.filter(c => c.tag && (assetTag === 'all' || c.tag === assetTag));
  const side = <div className="sb-left"><section className="sb-section sb-assets">
    <header><button aria-pressed={assetTab === 'assets'} onClick={() => setAssetTab('assets')}>{t('storyboard.keyElements')}</button><button aria-pressed={assetTab === 'audio'} onClick={() => setAssetTab('audio')}>{t('storyboard.audio')}</button>
      {assetTab === 'assets' && <select aria-label={t('storyboard.category')} value={assetTag} onChange={e => setAssetTag(e.target.value)}>{['all', ...ELEMENT_TAGS].map(tag => <option key={tag} value={tag}>{t(`storyboard.${tag}`)}</option>)}</select>}
    </header><div className="sb-asset-strip">{(assetTab === 'audio' ? orderedCards(cards, 'audio', metadata) : assets).map(c => <button className="sb-asset" key={c.id} onClick={() => open(c.id)} draggable onDragStart={e => { e.dataTransfer.setData(dragType, c.id); }} title={c.name}><span><Thumbnail card={c} /></span><small>{c.name}</small></button>)}{!(assetTab === 'audio' ? cards.some(c => c.kind === 'audio') : assets.length) && <p className="sb-empty">{t('storyboard.empty')}</p>}</div>
  </section>{section('text')}</div>;
  const divider = (index: number) => <div className="sb-divider" role="separator" aria-orientation="vertical" aria-label={t('storyboard.resize')} tabIndex={0}
    onKeyDown={e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const delta = e.key === 'ArrowLeft' ? -0.05 : 0.05; const next = [...widths]; next[index] = Math.max(0.35, next[index] + delta); next[index + 1] = Math.max(0.35, next[index + 1] - delta); useStoryboardView.getState().setWidths(next); }}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.dataset.start = String(e.clientX); e.currentTarget.dataset.widths = JSON.stringify(widths); }}
    onPointerMove={e => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const original = JSON.parse(e.currentTarget.dataset.widths!) as number[]; const delta = (e.clientX - Number(e.currentTarget.dataset.start)) / (root.current?.clientWidth ?? 1200) * original.reduce((a,b) => a+b,0); const total = original[index]+original[index+1]; const next = [...original]; next[index] = Math.max(0.35, Math.min(total-0.35, original[index]+delta)); next[index+1] = total-next[index]; useStoryboardView.getState().setWidths(next); }} />;

  return <div ref={root} className="sb-root" data-testid="storyboard-view">
    <div className="sb-tools"><label><Search size={14} /><input aria-label={t('storyboard.search')} placeholder={t('storyboard.search')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className={`sb-layout ${selected ? 'sb-detail-layout' : expanded ? 'sb-expanded' : ''}`} style={{ '--sb-columns': selected ? `${widths[0]}fr 12px ${widths[1] + widths[2]}fr` : `${widths[0]}fr 12px ${widths[1]}fr 12px ${widths[2]}fr` } as CSSProperties}>
      {selected ? <>{side}{divider(0)}<section className="sb-section sb-detail" aria-label={t('storyboard.details')} key={selected.id}>
        <header><button title={t('storyboard.back')} aria-label={t('storyboard.back')} onClick={() => selectNode(null)}><ArrowLeft size={17} /></button><h2>{selected.name}</h2>
          <button onClick={() => locate(selected.id)} title={t('storyboard.locate')} aria-label={t('storyboard.locate')}><LocateFixed size={17} /></button>
          <details className="sb-menu"><summary aria-label={t('storyboard.more')}>•••</summary><div>
            <label>{t('storyboard.category')}<select aria-label={t('storyboard.category')} disabled={managed} value={selected.tag ?? ''} onChange={e => useStoryboardMetadata.getState().tag(selected.id, (e.target.value || undefined) as ElementTag | undefined)}><option value="">{t('storyboard.unclassified')}</option>{ELEMENT_TAGS.map(tag => <option key={tag} value={tag}>{t(`storyboard.${tag}`)}</option>)}</select></label>
            <button onClick={() => { const ids = useCanvasStore.getState().duplicateNodesAsSiblings([selected.id]); if (ids[0]) open(ids[0]); }}><Copy size={14} />{t('storyboard.duplicate')}</button>
            <button disabled={managed} onClick={() => { useCanvasStore.getState().deleteNode(selected.id); selectNode(null); }}><Trash2 size={14} />{t('storyboard.delete')}</button>
          </div></details>
          <button title={t('storyboard.close')} aria-label={t('storyboard.close')} onClick={() => selectNode(null)}><X size={17} /></button>
        </header>
        <ScrollArea name={`${scope}:detail:${selected.id}`} className="sb-detail-content">
          {selected.kind === 'text' ? <><div className="sb-text-tools">{!managed && <button disabled={selected.busy} onClick={() => { if (editing) { useCanvasStore.getState().updateNodeData(selected.id, { content: draft }); setEditing(false); } else { setDraft(selected.text); setEditing(true); } }}>{editing ? <Check size={14} /> : <Pencil size={14} />}{t(editing ? 'storyboard.saveText' : 'storyboard.editText')}</button>}</div>
            {editing ? <textarea className="sb-content-editor" aria-label={t('storyboard.editText')} value={draft} onChange={e => setDraft(e.target.value)} /> : <div className="sb-markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{selected.text || t('storyboard.noResult')}</ReactMarkdown></div>}</>
            : <Preview card={selected} large />}
          {selected.busy && <div className="sb-status">{t('storyboard.generating')} {selected.progress > 0 ? `${selected.progress}%` : ''}</div>}
          {selected.error && <p className="sb-error">{selected.error}</p>}
          <div className="sb-detail-refs"><span>{t('storyboard.references')}</span>{refs(selected, true)}</div>
          {picker && <div className="sb-reference-picker"><input autoFocus aria-label={t('storyboard.searchReference')} placeholder={t('storyboard.searchReference')} value={refQuery} onChange={e => setRefQuery(e.target.value)} />{cards.filter(c => referenceCandidates.has(c.id) && !selected.references.includes(c.id) && c.name.toLowerCase().includes(refQuery.toLowerCase())).map(c => <button key={c.id} onClick={() => { attach(c.id, selected.id); setPicker(false); }}><span className="sb-picker-thumb"><Thumbnail card={c} /></span>{c.name}</button>)}</div>}
          <div ref={setHistoryHost} className="sb-history-host" />
        </ScrollArea>
        <div ref={setHost} className="sb-editor-host" data-testid="storyboard-editor-host" />
      </section></> : expanded ? section(expanded) : <>{side}{divider(0)}{section('image')}{divider(1)}{section('video')}</>}
    </div>
  </div>;
}
