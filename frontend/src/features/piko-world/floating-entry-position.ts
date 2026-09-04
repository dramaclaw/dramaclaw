// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface FloatingEntryPosition {
  left: number;
  top: number;
}

export interface FloatingEntrySize {
  width: number;
  height: number;
}

export interface NormalizedFloatingEntryPosition {
  xPercent: number;
  yPercent: number;
}

export const PIKO_WORLD_ENTRY_MARGIN = 12;

export function clampFloatingEntryPosition(
  position: FloatingEntryPosition,
  viewport: FloatingEntrySize,
  entry: FloatingEntrySize,
): FloatingEntryPosition {
  return {
    left: Math.round(
      Math.min(
        Math.max(PIKO_WORLD_ENTRY_MARGIN, position.left),
        Math.max(PIKO_WORLD_ENTRY_MARGIN, viewport.width - entry.width - PIKO_WORLD_ENTRY_MARGIN),
      ),
    ),
    top: Math.round(
      Math.min(
        Math.max(PIKO_WORLD_ENTRY_MARGIN, position.top),
        Math.max(PIKO_WORLD_ENTRY_MARGIN, viewport.height - entry.height - PIKO_WORLD_ENTRY_MARGIN),
      ),
    ),
  };
}

export function normalizeFloatingEntryPosition(
  position: FloatingEntryPosition,
  viewport: FloatingEntrySize,
): NormalizedFloatingEntryPosition {
  return {
    xPercent: (position.left / Math.max(1, viewport.width)) * 100,
    yPercent: (position.top / Math.max(1, viewport.height)) * 100,
  };
}

export function restoreFloatingEntryPosition(
  position: NormalizedFloatingEntryPosition,
  viewport: FloatingEntrySize,
  entry: FloatingEntrySize,
): FloatingEntryPosition {
  return clampFloatingEntryPosition(
    {
      left: (position.xPercent / 100) * viewport.width,
      top: (position.yPercent / 100) * viewport.height,
    },
    viewport,
    entry,
  );
}
