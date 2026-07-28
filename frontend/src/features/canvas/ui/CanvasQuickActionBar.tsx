// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Hand, HelpCircle, Keyboard, MousePointer2, Plus } from 'lucide-react';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import type { CanvasAsset } from '@/features/canvas/domain/canvasAssets';
import type { SkillDefinition } from '@/features/freezone/context/skillRoles';

import { CanvasAddNodePanel } from './CanvasAddNodePanel';
import { CanvasShortcutsPanel } from './CanvasShortcutsPanel';
import { CanvasHistoryAssetsModal } from './CanvasHistoryAssetsModal';
import { CanvasToolMenu } from './CanvasToolMenu';
import { useCanvasToolStore } from './canvasToolStore';

type QuickPanel = 'add' | 'tool' | 'history' | 'shortcuts' | 'help';

// 悬停即开 / 离开延迟关闭的轻量 popover 面板（区别于 history 那种 modal）。
const HOVER_POPOVER_PANELS: ReadonlySet<QuickPanel> = new Set(['add']);
const ANCHORED_POPOVER_PANELS: ReadonlySet<QuickPanel> = new Set([
  'add',
  'tool',
  'shortcuts',
]);
const PRODUCT_MANUAL_URL = 'https://neo-flying.feishu.cn/docx/T2UgdVA4Fo1A5KxCh0vckDz3nTg';

interface CanvasQuickActionBarProps {
  placement?: 'bottom-right' | 'top-right';
  skillItems: SkillDefinition[];
  onAddNode: (type: CanvasNodeType) => void;
  onAddSkill: (skill: SkillDefinition) => void;
  onUseAsset: (asset: CanvasAsset) => void;
  onDeleteNode: (nodeId: string) => void;
}

interface QuickActionDef {
  key: QuickPanel;
  icon: ComponentType<{ className?: string }>;
  labelKey: string;
  tooltipKey?: string;
  href?: string;
  /** Rendered as the always-filled white primary button (libtv "+" style). */
  primary?: boolean;
}

const ACTIONS: QuickActionDef[] = [
  { key: 'add', icon: Plus, labelKey: 'canvas.quickbar.addNode', primary: true },
  // 指针工具。图标跟着当前工具走（见下方 resolveIcon），所以这里的 icon 只是占位。
  { key: 'tool', icon: MousePointer2, labelKey: 'canvas.toolbar.toolGroupLabel' },
  {
    key: 'history',
    icon: Clock,
    labelKey: 'canvas.quickbar.history',
    tooltipKey: 'canvas.quickbar.history',
  },
  {
    key: 'shortcuts',
    icon: Keyboard,
    labelKey: 'canvas.quickbar.shortcuts',
    tooltipKey: 'canvas.quickbar.shortcuts',
  },
  {
    key: 'help',
    icon: HelpCircle,
    labelKey: 'canvas.quickbar.help',
    tooltipKey: 'canvas.quickbar.viewManual',
    href: PRODUCT_MANUAL_URL,
  },
];

export function CanvasQuickActionBar({
  placement = 'bottom-right',
  skillItems,
  onAddNode,
  onAddSkill,
  onUseAsset,
  onDeleteNode,
}: CanvasQuickActionBarProps) {
  const { t } = useTranslation();
  const [openPanel, setOpenPanel] = useState<QuickPanel | null>(null);
  const popoverCloseTimerRef = useRef<number | null>(null);
  const isTop = placement === 'top-right';
  const handToolActive = useCanvasToolStore((state) => state.tool === 'hand');

  const cancelPopoverClose = () => {
    if (popoverCloseTimerRef.current !== null) {
      window.clearTimeout(popoverCloseTimerRef.current);
      popoverCloseTimerRef.current = null;
    }
  };

  const schedulePopoverClose = () => {
    cancelPopoverClose();
    popoverCloseTimerRef.current = window.setTimeout(() => {
      setOpenPanel((current) => (current && HOVER_POPOVER_PANELS.has(current) ? null : current));
      popoverCloseTimerRef.current = null;
    }, 120);
  };

  useEffect(() => {
    return () => cancelPopoverClose();
  }, []);

  const toggle = (panel: QuickPanel) => {
    setOpenPanel((current) => (current === panel ? null : panel));
  };

  const handleActionClick = (action: QuickActionDef) => {
    const panel = action.key;
    if (action.href) {
      window.open(action.href, '_blank', 'noopener,noreferrer');
      setOpenPanel(null);
      return;
    }
    if (HOVER_POPOVER_PANELS.has(panel)) {
      cancelPopoverClose();
      setOpenPanel(panel);
      return;
    }
    toggle(panel);
  };

  const handleActionHover = (panel: QuickPanel) => {
    if (!HOVER_POPOVER_PANELS.has(panel)) {
      return;
    }
    cancelPopoverClose();
    setOpenPanel(panel);
  };

  const hasPopover = openPanel != null && ANCHORED_POPOVER_PANELS.has(openPanel);
  // Anchor the popovers above the bar (or below it when the chrome lives at the
  // top), opening upward toward the canvas.
  const popoverAnchorClass = isTop ? 'top-full mt-3' : 'bottom-full mb-3';
  const popoverEnterClass = `animate-in fade-in-0 zoom-in-95 duration-150 ease-out motion-reduce:animate-none ${
    isTop ? 'slide-in-from-top-1' : 'slide-in-from-bottom-1'
  }`;

  return (
    <>
      {/*
        Click-away layer for the anchored popovers. Kept OUT of the centered bar
        wrapper below: that wrapper would carry no transform, but the shortcuts
        popover uses `-translate-x-1/2`, and a `fixed` backdrop nested under any
        transformed ancestor is positioned relative to it instead of the
        viewport — so the backdrop lives here at the fragment root.
      */}
      {hasPopover && (
        <div className="fixed inset-0 z-[40]" onClick={() => setOpenPanel(null)} />
      )}

      <div
        className={`pointer-events-none absolute inset-x-0 z-[41] flex justify-center ${
          isTop ? 'top-3' : 'bottom-3'
        }`}
      >
        <div
          className="nopan nowheel pointer-events-auto relative"
          onPointerEnter={cancelPopoverClose}
          onPointerLeave={() => {
            if (openPanel != null && HOVER_POPOVER_PANELS.has(openPanel)) {
              schedulePopoverClose();
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {openPanel === 'add' && (
            <div
              className={`absolute left-0 ${popoverAnchorClass}`}
              onPointerEnter={cancelPopoverClose}
              onPointerLeave={schedulePopoverClose}
            >
              <div className={popoverEnterClass}>
                <CanvasAddNodePanel
                  skillItems={skillItems}
                  onSelectNode={onAddNode}
                  onSelectSkill={onAddSkill}
                  onClose={() => setOpenPanel(null)}
                />
              </div>
            </div>
          )}

          {openPanel === 'shortcuts' && (
            <div className={`absolute left-1/2 -translate-x-1/2 ${popoverAnchorClass}`}>
              <div className={popoverEnterClass}>
                <CanvasShortcutsPanel onClose={() => setOpenPanel(null)} />
              </div>
            </div>
          )}

          <div className="flex h-12 items-center gap-2.5 rounded-[12px] border border-white/[0.08] bg-[#11151d]/95 px-1.5 shadow-[0_14px_36px_rgba(0,0,0,0.42)] backdrop-blur-md">
            {ACTIONS.map((action) => {
              const { key, labelKey, tooltipKey, primary } = action;
              const active = openPanel === key;
              // 指针工具的图标就是当前工具本身 —— 收起菜单后还得一眼看出现在是抓手。
              const Icon =
                key === 'tool' ? (handToolActive ? Hand : MousePointer2) : action.icon;
              // 指针工具的悬浮提示报当前工具和它的快捷键，别只报「指针工具」这个类别名。
              const tooltip =
                key === 'tool'
                  ? handToolActive
                    ? `${t('canvas.toolbar.toolHand')} H`
                    : `${t('canvas.toolbar.toolMove')} V`
                  : tooltipKey && t(tooltipKey);
              // The "+" is always a white primary chip; the other two only fill
              // white while their panel is open (libtv keyboard-highlight style).
              // 指针工具多一条：抓手是「画布现在不听左键选择」的状态，菜单关了也要亮着。
              const filled = primary || active || (key === 'tool' && handToolActive);
              return (
                <span key={key} className="group relative inline-flex">
                  <button
                    type="button"
                    onMouseEnter={() => handleActionHover(key)}
                    onFocus={() => handleActionHover(key)}
                    onClick={() => handleActionClick(action)}
                    aria-label={t(labelKey)}
                    aria-pressed={active}
                    className={`flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors ${
                      filled
                        ? 'bg-white text-[#15171c] shadow-[0_2px_8px_rgba(0,0,0,0.22)]'
                        : 'text-white/52 hover:bg-white/[0.09] hover:text-white/82'
                    }`}
                  >
                    <Icon
                      className={`h-[18px] w-[18px] ${
                        primary
                          ? 'transition-transform duration-200 ease-out motion-reduce:transition-none group-hover:rotate-45 group-hover:scale-110 motion-reduce:group-hover:rotate-0 motion-reduce:group-hover:scale-100'
                          : ''
                      }`}
                    />
                  </button>
                  {/* 面板开着就别再弹提示了：两者都锚在按钮正上方，会糊在一起。 */}
                  {tooltip && !active && (
                    <span
                      className={`pointer-events-none absolute left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-[6px] border border-white/[0.08] bg-[#11151d]/95 px-2 py-1 text-[11px] leading-none text-white/78 opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.32)] transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${
                        isTop ? 'top-full mt-2' : 'bottom-full mb-2'
                      }`}
                    >
                      {tooltip}
                    </span>
                  )}
                  {/* 挂在按钮自己的 span 上，菜单跟着按钮走，不用去算它在这一排里的偏移。 */}
                  {key === 'tool' && active && (
                    <div className={`absolute left-0 z-20 ${popoverAnchorClass}`}>
                      <div className={popoverEnterClass}>
                        <CanvasToolMenu onSelect={() => setOpenPanel(null)} />
                      </div>
                    </div>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {openPanel === 'history' && (
        <CanvasHistoryAssetsModal
          onClose={() => setOpenPanel(null)}
          onUseAsset={onUseAsset}
          onDeleteNode={onDeleteNode}
        />
      )}
    </>
  );
}
