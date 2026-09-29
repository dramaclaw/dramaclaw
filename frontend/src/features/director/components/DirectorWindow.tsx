// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type Bounds = { width: number; height: number; right: number; bottom: number };
const DEFAULT: Bounds = { width: 400, height: 640, right: 16, bottom: 16 };

/** View-only window geometry never changes a conversation or starts a run. */
export function DirectorWindow({ children, docked, project }: { children: ReactNode; docked: boolean; project: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLElement>(null);
  const key = `director:window:${project}`;
  const [bounds, setBounds] = useState<Bounds>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Bounds | null;
      return value && Object.keys(DEFAULT).every((key) => Number.isFinite(value[key as keyof Bounds])) ? value : DEFAULT;
    } catch { return DEFAULT; }
  });
  const gesture = useRef<{ x: number; y: number; edge: string; bounds: Bounds } | null>(null);
  const clamp = (value: Bounds) => {
    const parent = ref.current?.parentElement;
    const width = parent?.clientWidth || window.innerWidth, height = parent?.clientHeight || window.innerHeight;
    const next = { ...value, width: Math.min(Math.max(320, value.width), width - 16), height: Math.min(Math.max(360, value.height), height - 16) };
    return { ...next, right: Math.max(8, Math.min(value.right, width - next.width - 8)), bottom: Math.max(8, Math.min(value.bottom, height - next.height - 8)) };
  };
  useEffect(() => {
    const resize = () => setBounds((value) => clamp(value));
    resize();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }
    const observer = new ResizeObserver(resize);
    if (ref.current?.parentElement) observer.observe(ref.current.parentElement);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(bounds)); } catch { /* Geometry is optional. */ } }, [key, bounds]);
  return <aside ref={ref} className={`dc-panel${docked ? ' is-docked' : ''}`} aria-label={t('director.panel')}
    style={docked ? undefined : { '--dc-panel-width': `${bounds.width}px`, '--dc-panel-height': `${bounds.height}px`, right: bounds.right, bottom: bounds.bottom } as CSSProperties}
    onPointerDown={(event) => {
      if (docked || event.button !== 0) return;
      const target = event.target as HTMLElement;
      const edge = target.dataset.resize;
      if (!edge && (!target.closest('.dc-panel-header') || target.closest('button'))) return;
      gesture.current = { x: event.clientX, y: event.clientY, edge: edge ?? 'move', bounds };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }} onPointerMove={(event) => {
      const start = gesture.current;
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      const next = { ...start.bounds };
      if (start.edge === 'move') { next.right -= dx; next.bottom -= dy; }
      else {
        if (start.edge.includes('w')) next.width -= dx;
        if (start.edge.includes('e')) { next.width += dx; next.right -= dx; }
        if (start.edge.includes('n')) next.height -= dy;
        if (start.edge.includes('s')) { next.height += dy; next.bottom -= dy; }
      }
      setBounds(clamp(next));
    }} onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>
    {children}
    {!docked && ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map((edge) => <div key={edge} role="separator" tabIndex={0}
      aria-label={t('director.ui.resize')} aria-valuenow={edge.includes('n') || edge.includes('s') ? bounds.height : bounds.width}
      aria-orientation={edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'}
      data-resize={edge} className={`dc-resize dc-resize-${edge}`} onKeyDown={(event) => {
        if (event.key === 'Home') { event.preventDefault(); setBounds(clamp(DEFAULT)); return; }
        if (!event.key.startsWith('Arrow')) return;
        event.preventDefault();
        const change = event.shiftKey ? 40 : 10;
        setBounds((value) => clamp({ ...value, width: value.width + (event.key === 'ArrowRight' ? change : event.key === 'ArrowLeft' ? -change : 0), height: value.height + (event.key === 'ArrowDown' ? change : event.key === 'ArrowUp' ? -change : 0) }));
      }} />)}
  </aside>;
}
