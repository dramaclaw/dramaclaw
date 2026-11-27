// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const MODEL_MENU_VIEWPORT_MARGIN = 8;
type ElementRef = RefObject<HTMLDivElement | null>;
type Bounds = { left: number; top: number; bottom: number; width: number; vw: number; vh: number };

/** Canvas pans, zooms and node drags change screen coordinates without a DOM scroll event. */
export function useModelMenuAnchor(trigger: RefObject<HTMLElement | null>, open: boolean) {
  const [bounds, setBounds] = useState<Bounds | null>(null);
  useLayoutEffect(() => {
    if (!open) { setBounds(null); return; }
    let frame: number;
    let last: Bounds | undefined;
    function measure() {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect && (!last || rect.left !== last.left || rect.top !== last.top ||
          rect.bottom !== last.bottom || rect.width !== last.width ||
          window.innerWidth !== last.vw || window.innerHeight !== last.vh)) {
        last = {left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width,
          vw: window.innerWidth, vh: window.innerHeight};
        setBounds(last);
      }
      frame = requestAnimationFrame(measure);
    }
    measure();
    return () => cancelAnimationFrame(frame);
  }, [trigger, open]);
  return open ? bounds : null;
}

export function useModelMenuPreview(panelRef: ElementRef, bounds: Bounds | null, above: boolean, scrollRef = panelRef) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const pin = useRef<{ element: HTMLElement; offset: number } | null>(null);
  function preview(next: string | null, element?: HTMLElement) {
    const scroll = scrollRef.current;
    if (!element && scroll) {
      pin.current = null;
      scroll.style.removeProperty('height');
    }
    if (next === previewId) return;
    if (element && scroll && scroll.offsetHeight) {
      const box = scroll.getBoundingClientRect();
      const scale = box.height / scroll.offsetHeight;
      if (scale > 0) {
        pin.current = {element, offset: (element.getBoundingClientRect().top - box.top) / scale};
        // The lower edge of an upward menu belongs to the trigger. Growing the
        // viewport upward would pull the button away before the user could scroll.
        if (above && !scroll.style.height) scroll.style.height = getComputedStyle(scroll).height;
      }
    }
    setPreviewId(next);
  }

  useLayoutEffect(() => {
    const panel = panelRef.current, scroll = scrollRef.current;
    if (!bounds || !panel || !scroll) return;
    // The grouped image menu opens above the node, sometimes inside a scaled canvas.
    if (panel !== scroll && scroll.offsetHeight) {
      const shell = panel.getBoundingClientRect(), box = scroll.getBoundingClientRect();
      const scale = box.height / scroll.offsetHeight;
      if (scale > 0) scroll.style.setProperty('--preview-room',
        `${Math.max(0, (box.bottom - (box.top - shell.top) - MODEL_MENU_VIEWPORT_MARGIN) / scale)}px`);
    }
    const row = pin.current;
    pin.current = null;
    if (!row || !scroll.contains(row.element) || !scroll.offsetHeight) return;
    const box = scroll.getBoundingClientRect();
    const scale = box.height / scroll.offsetHeight;
    if (!scale) return;
    const target = scroll.scrollTop + (row.element.getBoundingClientRect().top - box.top) / scale - row.offset;
    // Pin within the real content only. Fabricating scroll range at either
    // edge leaves a blank band when the previous option's guide collapses.
    scroll.scrollTop = Math.max(0, Math.min(target, scroll.scrollHeight - scroll.clientHeight));
  }, [panelRef, scrollRef, bounds, previewId]);
  return {previewId, preview};
}
