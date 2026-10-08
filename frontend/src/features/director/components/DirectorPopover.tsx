// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Anchor to the actual control, including when the chat window is dragged. */
export function DirectorPopover({ anchor, label, width = 240, side = 'top', align = 'center', onClose, children, className = '' }: {
  anchor: HTMLElement | null; label: string; width?: number; side?: 'top' | 'bottom'; align?: 'center' | 'end';
  onClose: () => void; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      const left = rect ? (align === 'end' ? rect.right - box.width : rect.left + rect.width / 2 - box.width / 2) : (innerWidth - box.width) / 2;
      const top = rect ? (side === 'top' ? rect.top - box.height - 8 : rect.bottom + 8) : (innerHeight - box.height) / 2;
      setPosition({ left: Math.max(8, Math.min(left, innerWidth - box.width - 8)), top: Math.max(8, Math.min(top, innerHeight - box.height - 8)) });
    };
    place();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    observer?.observe(element);
    window.addEventListener('resize', place);
    element.querySelector<HTMLElement>('input,button:not(:disabled),[tabindex="0"]')?.focus();
    return () => { observer?.disconnect(); window.removeEventListener('resize', place); anchor?.focus(); };
  }, [anchor, side, align]);
  return <div className="dc-popover-scrim" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className={`dc-anchored-popover ${className}`} style={{ ...position, width, maxWidth: 'calc(100vw - 16px)' }} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('input,button:not(:disabled),[tabindex="0"]')];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>{children}</div>
  </div>;
}
