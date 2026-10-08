// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DirectorReferenceIcon, Plus } from './DirectorReferenceIcon';
import { readDirectorPreference, saveDirectorPreference } from '../director-ui-state';

type View = { x: number; y: number; zoom: number };
const initial: View = { x: 0, y: 0, zoom: 1 };
export function DirectorCanvas({ project, children, onCreate, onDirector }: { project: string; children: ReactNode; onCreate: () => void; onDirector: () => void }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>(() => {
    const v = readDirectorPreference(`canvas:${project}`, initial);
    return [v.x, v.y, v.zoom].every(Number.isFinite) && v.zoom >= .05 && v.zoom <= 2 ? v : initial;
  });
  const [pan, setPan] = useState(false);
  const [map, setMap] = useState(false);
  const [snap, setSnap] = useState(false);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; base: View } | null>(null);
  const current = useRef(view); current.current = view;
  const fit = () => {
    const canvas = ref.current;
    if (!canvas) return;
    const rectangles = [...canvas.querySelectorAll('.dc-script-node, .dc-media-node')].map(n => n.getBoundingClientRect());
    if (!rectangles.length) { setView(initial); return; }
    const bounds = canvas.getBoundingClientRect(), v = current.current;
    const minX = Math.min(...rectangles.map(r => (r.left - bounds.left - bounds.width / 2 - v.x) / v.zoom));
    const maxX = Math.max(...rectangles.map(r => (r.right - bounds.left - bounds.width / 2 - v.x) / v.zoom));
    const minY = Math.min(...rectangles.map(r => (r.top - bounds.top - v.y) / v.zoom));
    const maxY = Math.max(...rectangles.map(r => (r.bottom - bounds.top - v.y) / v.zoom));
    // Fit all persisted nodes outside the floating conversation's footprint.
    const panel = canvas.parentElement?.querySelector('.dc-panel')?.getBoundingClientRect();
    const usable = panel && bounds.width > 900 ? Math.max(bounds.width / 2, panel.left - bounds.left - 24) : bounds.width;
    const zoom = Math.max(.05, Math.min(1, (usable - 96) / (maxX - minX), (bounds.height - 192) / (maxY - minY)));
    setView({ zoom, x: usable / 2 - bounds.width / 2 - (minX + maxX) * zoom / 2, y: 96 - minY * zoom });
  };
  useEffect(() => { saveDirectorPreference(`canvas:${project}`, view); }, [project, view]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('button, input, textarea, select, .dc-document-preview')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const bounds = element.getBoundingClientRect(), v = current.current;
        const zoom = Math.min(2, Math.max(.05, v.zoom * Math.exp(-event.deltaY * .01)));
        const dx = event.clientX - bounds.left - bounds.width / 2, dy = event.clientY - bounds.top;
        setView({ zoom, x: dx - (dx - v.x) * zoom / v.zoom, y: dy - (dy - v.y) * zoom / v.zoom });
      } else setView(v => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  return <>
    <main ref={ref} tabIndex={0} className={`dc-canvas dc-infinite-canvas${pan ? ' is-panning' : ''}`} aria-label={t('director.canvas')}
      style={{ backgroundSize: `${16 * view.zoom}px ${16 * view.zoom}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
      onDoubleClick={event => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('dc-canvas-transform')) setView(initial); }}
      onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Home') { event.preventDefault(); setView(initial); } if (event.code === 'Space') { event.preventDefault(); setPan(true); } }}
      onKeyUp={event => { if (event.code === 'Space') setPan(false); }} onBlur={() => { setPan(false); drag.current = null; }}
      onPointerDown={event => {
        const target = event.target as HTMLElement;
        if (event.button !== 0 && event.button !== 1 || target.closest('button, input, textarea, select, summary, .dc-document-preview, .dc-document-rail')) return;
        if (!pan && event.button !== 1 && target.closest('.dc-script-document, .dc-media-node')) return;
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, base: view };
      }} onPointerMove={event => {
        const d = drag.current; if (!d || d.pointer !== event.pointerId) return;
        const x = d.base.x + event.clientX - d.x, y = d.base.y + event.clientY - d.y;
        setView({ ...d.base, x: snap ? Math.round(x / 16) * 16 : x, y: snap ? Math.round(y / 16) * 16 : y });
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className="dc-canvas-transform" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>{children}</div>
    </main>
    <div className="dc-canvas-tools" role="toolbar" aria-label={t('director.surface.canvasTools')}>
      <button type="button" aria-label={t('director.surface.addScript')} onClick={onCreate}><Plus size={22} /></button>
      <button type="button" aria-label={t('director.surface.pan')} aria-pressed={pan} onClick={() => setPan(!pan)}><DirectorReferenceIcon name="Move" size={20} /></button><i />
      <button type="button" aria-label={t('director.surface.fit')} onClick={fit}><DirectorReferenceIcon name="Arrange" size={20} /></button>
      <button type="button" aria-label={t('director.surface.shortcuts')} onClick={() => setHelp(!help)}><DirectorReferenceIcon name="Shortcuts" size={20} /></button><i />
      <button type="button" aria-label={t('director.openPanel')} onClick={onDirector}><DirectorReferenceIcon name="Welcome" size={24} /></button>
    </div>
    <div className="dc-canvas-zoom"><button type="button" aria-label={t('director.surface.minimap')} aria-pressed={map} onClick={() => setMap(!map)}><DirectorReferenceIcon name="Map" size={18} /></button><button type="button" aria-label={t('director.surface.snap')} aria-pressed={snap} onClick={() => setSnap(!snap)}><DirectorReferenceIcon name="Snap" size={18} /></button><button type="button" aria-expanded={zoomMenu} aria-label={t('director.surface.zoomOptions')} onClick={() => setZoomMenu(!zoomMenu)}>{Math.round(view.zoom * 100)}%</button>
      {zoomMenu && <div className="dc-canvas-zoom-menu">{[25, 50, 75, 100, 125, 150, 200].map(z => <button type="button" key={z} onClick={() => { setView(v => ({ ...v, zoom: z / 100 })); setZoomMenu(false); }}>{z}%</button>)}</div>}
    </div>
    {map && <button type="button" className="dc-minimap" aria-label={t('director.surface.fit')} onClick={() => setView(initial)}><span style={{ transform: `translate(${view.x / 20}px, ${view.y / 20}px) scale(${view.zoom})` }} /></button>}
    {help && <div className="dc-canvas-help"><p>{t('director.surface.shortcutHint')}</p><button type="button" onClick={() => setHelp(false)}>{t('director.close')}</button></div>}
  </>;
}
