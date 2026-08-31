// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Map } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_CONTROL_ICON_BUTTON_ACTIVE_CLASS,
  CANVAS_CONTROL_ICON_BUTTON_CLASS,
} from './canvasControlStyles';

interface CanvasMinimapButtonProps {
  pinned: boolean;
  onTogglePin: () => void;
  onHoverChange: (hovered: boolean) => void;
  placement?: 'bottom-right' | 'top-right';
}

export function CanvasMinimapButton({
  pinned,
  onTogglePin,
  onHoverChange,
  placement = 'bottom-right',
}: CanvasMinimapButtonProps) {
  const { t } = useTranslation();
  const isTop = placement === 'top-right';
  return (
    <div
      className={`nopan nowheel pointer-events-auto group absolute right-3 z-30 ${
        isTop ? 'top-3' : 'bottom-3'
      }`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      <button
        type="button"
        onClick={onTogglePin}
        className={`${CANVAS_CONTROL_ICON_BUTTON_CLASS} ${
          pinned
            ? CANVAS_CONTROL_ICON_BUTTON_ACTIVE_CLASS
            : 'text-text-muted hover:bg-white/10 hover:text-text'
        }`}
        aria-label={t('canvas.controls.minimap')}
        aria-pressed={pinned}
      >
        <Map className="h-3.5 w-3.5" />
      </button>
      <span
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-[rgba(255,255,255,0.12)] bg-bg-dark/95 px-2 py-1 text-[11px] text-text-dark opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 ${
          isTop ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
        }`}
      >
        {t('canvas.controls.minimap')}
      </span>
    </div>
  );
}
