// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from 'react';

export const CANVAS_CONTROL_EDGE_GAP = 20;
export const CANVAS_CONTROL_ICON_STEP = 36;

/** Shared glass background for the asset library, chat and quick action bar. */
export const CANVAS_PANEL_SURFACE_CLASS =
  'bg-[rgb(var(--surface-rgb)/0.78)] backdrop-blur-[20px]';

/** Shared workspace anchors; centered bars omit the right offset. */
export function canvasControlPositionStyle(
  placement: 'bottom-right' | 'top-right',
  rightOffset?: number,
): CSSProperties {
  const style: CSSProperties = placement === 'top-right'
    ? { top: CANVAS_CONTROL_EDGE_GAP }
    : { bottom: CANVAS_CONTROL_EDGE_GAP };
  if (rightOffset !== undefined) style.right = CANVAS_CONTROL_EDGE_GAP + rightOffset;
  return style;
}

export const CANVAS_CONTROL_GLASS_CLASS =
  'border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.58)] shadow-md backdrop-blur-xl';

export const CANVAS_CONTROL_ICON_BUTTON_CLASS =
  `flex h-7 w-7 items-center justify-center rounded-full ${CANVAS_CONTROL_GLASS_CLASS} transition`;

export const CANVAS_CONTROL_ICON_BUTTON_ACTIVE_CLASS =
  'border-white/30 bg-white/[0.16] text-text';

