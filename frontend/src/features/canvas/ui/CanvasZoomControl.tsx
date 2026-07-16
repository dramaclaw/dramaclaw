// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';
import { Waypoints, Wand2 } from 'lucide-react';
import { useReactFlow, useViewport } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { isImmersiveViewerActive } from '@/features/viewer-kit/useViewerImmersiveBody';
import { MOD_KEY_LABEL } from '@/lib/platform';
import { CANVAS_CONTROL_GLASS_CLASS } from './canvasControlStyles';
import { useEdgeVisibilityStore } from './edgeVisibilityStore';

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const ZOOM_PRESETS = [50, 100, 800];

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    element.isContentEditable ||
    Boolean(element.closest('[role="textbox"]'))
  );
}

interface CanvasZoomControlProps {
  onOrganize: () => void;
  placement?: 'bottom-right' | 'top-right';
}

export function CanvasZoomControl({
  onOrganize,
  placement = 'bottom-right',
}: CanvasZoomControlProps) {
  const { zoomTo, getZoom, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const { t } = useTranslation();

  const edgesHidden = useEdgeVisibilityStore((state) => state.hidden);
  const toggleEdgesHidden = useEdgeVisibilityStore((state) => state.toggle);

  const percent = Math.round(zoom * 100);

  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<string>('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleZoomIn = useCallback(() => {
    const next = getZoom() * ZOOM_STEP;
    zoomTo(Math.min(next, ZOOM_MAX), { duration: 120 });
  }, [getZoom, zoomTo]);

  const handleZoomOut = useCallback(() => {
    const next = getZoom() / ZOOM_STEP;
    zoomTo(Math.max(next, ZOOM_MIN), { duration: 120 });
  }, [getZoom, zoomTo]);

  const handleFitView = useCallback(() => {
    void fitView({ padding: 0.2, duration: 200 });
  }, [fitView]);

  const handleZoomToPercent = useCallback(
    (value: number) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value / 100));
      zoomTo(clamped, { duration: 160 });
    },
    [zoomTo],
  );

  // ⌘/Ctrl + (=) 放大、- 缩小、0 适合屏幕。preventDefault 拦掉浏览器自身的页面缩放。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) return;
      if (event.key === '=' || event.key === '+') {
        event.preventDefault();
        handleZoomIn();
      } else if (event.key === '-') {
        event.preventDefault();
        handleZoomOut();
      } else if (event.key === '0') {
        event.preventDefault();
        handleFitView();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleFitView, handleZoomIn, handleZoomOut]);

  // 点击菜单外部关闭。
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [menuOpen]);

  const openMenu = () => {
    setDraft(String(percent));
    setMenuOpen(true);
    window.requestAnimationFrame(() => inputRef.current?.select());
  };

  const commitDraft = () => {
    const value = Number.parseFloat(draft);
    if (Number.isFinite(value) && value > 0) {
      handleZoomToPercent(value);
    }
  };

  const runAndClose = (action: () => void) => {
    action();
    setMenuOpen(false);
  };

  const organizeTitle = `${t('canvas.toolbar.organize')} ${t('canvas.toolbar.organizeShortcut')}`;
  const edgesToggleTitle = edgesHidden
    ? t('canvas.toolbar.showEdges')
    : t('canvas.toolbar.hideEdges');
  const isTop = placement === 'top-right';

  const menuItemClass =
    'flex w-full items-center justify-between gap-6 rounded-lg px-3 py-1.5 text-left text-[13px] text-text-dark transition hover:bg-white/10';

  return (
    <div
      ref={rootRef}
      className={`nopan nowheel pointer-events-auto absolute right-[5.25rem] z-30 ${
        isTop ? 'top-3' : 'bottom-3'
      }`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className={`flex items-center gap-0.5 rounded-full px-1 py-0.5 text-text ${CANVAS_CONTROL_GLASS_CLASS}`}
      >
        <span className="group relative inline-flex">
          <button
            type="button"
            onClick={toggleEdgesHidden}
            className={`flex h-5 w-5 items-center justify-center rounded-full transition ${
              edgesHidden
                ? 'bg-white/[0.16] text-text'
                : 'text-text-muted hover:bg-white/10 hover:text-text'
            }`}
            aria-label={edgesToggleTitle}
            aria-pressed={edgesHidden}
          >
            <Waypoints className="h-3 w-3" />
          </button>
          <span
            className={`pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[rgba(255,255,255,0.12)] bg-bg-dark/95 px-2 py-1 text-[11px] text-text-dark opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 ${
              isTop ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
            }`}
          >
            {edgesToggleTitle}
          </span>
        </span>
        <span className="mx-0.5 h-3 w-px bg-white/10" aria-hidden />
        <span className="group relative inline-flex">
          <button
            type="button"
            onClick={onOrganize}
            className="flex h-5 w-5 items-center justify-center rounded-full text-text-muted transition hover:bg-white/10 hover:text-text"
            aria-label={t('canvas.toolbar.organize')}
          >
            <Wand2 className="h-3 w-3" />
          </button>
          <span
            className={`pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[rgba(255,255,255,0.12)] bg-bg-dark/95 px-2 py-1 text-[11px] text-text-dark opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 ${
              isTop ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
            }`}
          >
            {organizeTitle}
          </span>
        </span>
        <span className="mx-0.5 h-3 w-px bg-white/10" aria-hidden />
        <button
          type="button"
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          className="min-w-[42px] rounded-full px-1.5 text-center text-[11px] tabular-nums text-text transition hover:bg-white/10"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('canvas.zoom.menuLabel')}
        >
          {percent}%
        </button>
      </div>

      {menuOpen && (
        <div
          role="menu"
          className={`absolute right-0 z-40 w-[200px] rounded-xl border border-white/10 bg-[#1c1c1e]/95 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-2xl ${
            isTop ? 'top-full mt-2' : 'bottom-full mb-2'
          }`}
        >
          <div className="mb-1 flex items-center rounded-lg bg-white/[0.07] px-3 py-1.5">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value.replace(/[^\d.]/g, ''))}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  commitDraft();
                  setMenuOpen(false);
                } else if (event.key === 'Escape') {
                  setMenuOpen(false);
                }
              }}
              onBlur={commitDraft}
              inputMode="decimal"
              className="w-full bg-transparent text-[13px] tabular-nums text-text-dark outline-none"
              aria-label={t('canvas.zoom.inputLabel')}
            />
            <span className="text-[13px] text-text-muted">%</span>
          </div>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => runAndClose(handleZoomIn)}>
            <span>{t('canvas.zoom.zoomIn')}</span>
            <span className="text-[12px] text-text-muted">{MOD_KEY_LABEL} +</span>
          </button>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => runAndClose(handleZoomOut)}>
            <span>{t('canvas.zoom.zoomOut')}</span>
            <span className="text-[12px] text-text-muted">{MOD_KEY_LABEL} -</span>
          </button>
          <button type="button" role="menuitem" className={menuItemClass} onClick={() => runAndClose(handleFitView)}>
            <span>{t('canvas.zoom.fitView')}</span>
            <span className="text-[12px] text-text-muted">{MOD_KEY_LABEL} 0</span>
          </button>
          <div className="mx-1 my-1 h-px bg-white/10" aria-hidden />
          {ZOOM_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              role="menuitem"
              className={menuItemClass}
              onClick={() => runAndClose(() => handleZoomToPercent(preset))}
            >
              <span>{t('canvas.zoom.zoomToPercent', { percent: preset })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
