// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useLayoutEffect, type RefObject } from 'react';
import { FREEZONE_DOCK_TRANSITION_VAR, FREEZONE_DOCK_WIDTH_VAR } from './dockOffset';

/** Keep canvas controls and body-portalled panels clear of the docked assistant. */
export function useFreezoneDockOffset(
  asideRef: RefObject<HTMLElement | null>,
  active: boolean,
  resizing: boolean,
): void {
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!active || !aside) return;
    const root = document.documentElement;
    let width = aside.getBoundingClientRect().width;
    const updateWidth = () => {
      const nextWidth = aside.getBoundingClientRect().width;
      if (nextWidth === width) return;
      // Window resizing and history-pane changes must not leave an animated
      // stale margin that briefly pushes panels past the left edge.
      root.style.setProperty(FREEZONE_DOCK_TRANSITION_VAR, '0ms');
      root.style.setProperty(FREEZONE_DOCK_WIDTH_VAR, `${nextWidth}px`);
      width = nextWidth;
    };
    root.style.setProperty(FREEZONE_DOCK_TRANSITION_VAR, resizing ? '0ms' : '300ms');
    root.style.setProperty(FREEZONE_DOCK_WIDTH_VAR, `${width}px`);
    const observer = new ResizeObserver(updateWidth);
    observer.observe(aside);
    return () => {
      observer.disconnect();
      root.style.removeProperty(FREEZONE_DOCK_WIDTH_VAR);
      root.style.removeProperty(FREEZONE_DOCK_TRANSITION_VAR);
    };
  }, [active, asideRef, resizing]);
}
