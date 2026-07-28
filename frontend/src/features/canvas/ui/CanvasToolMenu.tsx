// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Hand, MousePointer2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanvasToolStore, type CanvasTool } from './canvasToolStore';

export const CANVAS_TOOL_ITEMS: ReadonlyArray<{
  tool: CanvasTool;
  Icon: typeof Hand;
  labelKey: string;
  shortcut: string;
}> = [
  { tool: 'move', Icon: MousePointer2, labelKey: 'canvas.toolbar.toolMove', shortcut: 'V' },
  { tool: 'hand', Icon: Hand, labelKey: 'canvas.toolbar.toolHand', shortcut: 'H' },
];

interface CanvasToolMenuProps {
  onSelect?: () => void;
}

/** 快捷操作栏里「指针工具」按钮弹出的两行菜单：移动 V / 抓手工具 H。 */
export function CanvasToolMenu({ onSelect }: CanvasToolMenuProps) {
  const { t } = useTranslation();
  const tool = useCanvasToolStore((state) => state.tool);
  const setTool = useCanvasToolStore((state) => state.setTool);

  return (
    <div
      role="menu"
      aria-label={t('canvas.toolbar.toolGroupLabel')}
      className="w-[196px] rounded-[12px] border border-white/[0.08] bg-[#11151d]/95 p-1.5 shadow-[0_14px_36px_rgba(0,0,0,0.42)] backdrop-blur-md"
    >
      {CANVAS_TOOL_ITEMS.map(({ tool: value, Icon, labelKey, shortcut }) => {
        const active = tool === value;
        return (
          <button
            key={value}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            onClick={() => {
              setTool(value);
              onSelect?.();
            }}
            className={`flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[14px] leading-none transition-colors ${
              active
                ? 'bg-white/[0.1] text-white'
                : 'text-white/68 hover:bg-white/[0.06] hover:text-white'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1">{t(labelKey)}</span>
            <span className="text-[12px] tabular-nums text-white/38">{shortcut}</span>
          </button>
        );
      })}
    </div>
  );
}
