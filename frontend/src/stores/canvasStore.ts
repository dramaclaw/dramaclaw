// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useStore, type UseBoundStore } from 'zustand';

import {
  createCanvasStore,
  type CanvasState,
  type CanvasStoreApi,
} from '@/features/canvas/core/canvasStore';
import { browserCanvasEnvironment } from '@/features/canvas/infrastructure/browserCanvasEnvironment';

export * from '@/features/canvas/core/canvasStore';

const browserCanvasStore = createCanvasStore(browserCanvasEnvironment);

/** The browser's canvas: the one store instance React components subscribe to. */
export const useCanvasStore: UseBoundStore<CanvasStoreApi> = Object.assign(
  <T>(selector?: (state: CanvasState) => T) => useStore(browserCanvasStore, selector!),
  browserCanvasStore,
) as UseBoundStore<CanvasStoreApi>;

/**
 * True while a box-selection spans 2+ nodes. Node components use this to hide
 * their per-node bottom ops panel during a multi-select (the panels only make
 * sense for a single, intentionally-clicked node and otherwise clutter the
 * canvas). The selector returns a boolean so subscribers only re-render when
 * the multi-select state actually flips.
 */
export function useIsBoxSelecting(): boolean {
  return useCanvasStore((state) => {
    let count = 0;
    for (const node of state.nodes) {
      if (node.selected) {
        count += 1;
        if (count > 1) {
          return true;
        }
      }
    }
    return false;
  });
}
