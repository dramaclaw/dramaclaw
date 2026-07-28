// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentType } from 'react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MouseLeft, X } from 'lucide-react';

import { platformKeyLabel } from '@/lib/platform';
import { KeyboardPanIcon, MousePanIcon, TrackpadPanIcon } from './pan-shortcut-icons';

type NoteIcon = ComponentType<{ className?: string }>;

interface ShortcutRow {
  /** i18n key for the action label. */
  labelKey: string;
  /** i18n keys for keycap chips whose legend must localize (e.g. Space / 空格). Rendered before `keys`. */
  keyKeys?: string[];
  /** Modifier / letter tokens rendered as keycap chips. */
  keys?: string[];
  /**
   * Icons rendered (in order) in place of the note text — used for mouse / pan
   * gestures (left / middle button, or the keyboard / trackpad / mouse pan-device
   * icons). `noteKey` is still required alongside them and supplies the hover
   * tooltip + accessible label.
   */
  noteIcons?: NoteIcon[];
  /** Override the default note-icon size (e.g. larger pan-device icons). */
  noteIconClassName?: string;
  /** i18n key for a trailing gesture description (rendered as muted text, or as the icon's label). */
  noteKey?: string;
}

interface ShortcutGroup {
  titleKey: string;
  rows: ShortcutRow[];
}

// Only shortcuts that are actually wired up in the canvas (see Canvas.tsx
// keydown handler, onPaneClick double-click, alt-drag duplicate, and the
// ReactFlow pan/zoom config). No aspirational entries.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'canvas.shortcuts.groups.create',
    rows: [
      { labelKey: 'canvas.shortcuts.actions.openNodePanel', keys: ['Tab'] },
      { labelKey: 'canvas.shortcuts.actions.closeAddNodePanel', keys: ['Esc'] },
      { labelKey: 'canvas.shortcuts.actions.cancelNodePlacement', keys: ['Esc'] },
      { labelKey: 'canvas.shortcuts.actions.paste', keys: ['⌘', 'V'] },
      { labelKey: 'canvas.shortcuts.actions.copy', keys: ['⌘', 'C'] },
      { labelKey: 'canvas.shortcuts.actions.duplicateNode', keys: ['⌥'], noteKey: 'canvas.shortcuts.gestures.dragNode' },
      { labelKey: 'canvas.shortcuts.actions.multiSelect', keys: ['⌘'], noteKey: 'canvas.shortcuts.gestures.clickNode' },
      { labelKey: 'canvas.shortcuts.actions.group', keys: ['⌘', 'G'] },
    ],
  },
  {
    titleKey: 'canvas.shortcuts.groups.move',
    rows: [
      // 拖动画布按输入设备拆成三行：键盘(空格+拖动) / 触控板双指 / 鼠标中键。
      {
        labelKey: 'canvas.shortcuts.devices.keyboard',
        keyKeys: ['canvas.shortcuts.keys.space'],
        noteIcons: [KeyboardPanIcon],
        noteIconClassName: 'h-7 w-7',
        noteKey: 'canvas.shortcuts.gestures.spaceDrag',
      },
      {
        labelKey: 'canvas.shortcuts.devices.trackpad',
        noteIcons: [TrackpadPanIcon],
        noteIconClassName: 'h-7 w-7',
        noteKey: 'canvas.shortcuts.gestures.twoFingerSwipe',
      },
      {
        labelKey: 'canvas.shortcuts.devices.mouse',
        noteIcons: [MousePanIcon],
        noteIconClassName: 'h-7 w-7',
        noteKey: 'canvas.shortcuts.gestures.middleDrag',
      },
      { labelKey: 'canvas.shortcuts.actions.boxSelect', noteIcons: [MouseLeft], noteKey: 'canvas.shortcuts.gestures.holdLeftDrag' },
      { labelKey: 'canvas.toolbar.toolMove', keys: ['V'] },
      {
        labelKey: 'canvas.toolbar.toolHand',
        keys: ['H'],
        noteIcons: [MouseLeft],
        noteKey: 'canvas.shortcuts.gestures.holdLeftDrag',
      },
      { labelKey: 'canvas.shortcuts.actions.organize', keys: ['⌥', '⇧', 'F'] },
    ],
  },
  {
    titleKey: 'canvas.shortcuts.groups.zoom',
    rows: [
      { labelKey: 'canvas.shortcuts.actions.zoomIn', keys: ['⌘', '+'] },
      { labelKey: 'canvas.shortcuts.actions.zoomOut', keys: ['⌘', '-'] },
      { labelKey: 'canvas.shortcuts.actions.fitView', keys: ['⌘', '0'] },
    ],
  },
  {
    titleKey: 'canvas.shortcuts.groups.other',
    rows: [
      { labelKey: 'canvas.shortcuts.actions.undo', keys: ['⌘', 'Z'] },
      { labelKey: 'canvas.shortcuts.actions.redo', keys: ['⇧', '⌘', 'Z'] },
      { labelKey: 'canvas.shortcuts.actions.delete', keys: ['Delete'] },
      { labelKey: 'canvas.shortcuts.actions.toggleMinimap', keys: ['M'] },
    ],
  },
];

function Keycap({ token }: { token: string }) {
  return (
    <kbd className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-md border border-white/[0.12] bg-white/[0.06] px-1.5 text-[12px] font-medium leading-none text-white/82">
      {token}
    </kbd>
  );
}

interface CanvasShortcutsPanelProps {
  onClose: () => void;
}

export function CanvasShortcutsPanel({ onClose }: CanvasShortcutsPanelProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="relative w-[min(900px,calc(100vw-24px))] overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#101217]/85 shadow-2xl backdrop-blur-2xl">
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close')}
        className="absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="ui-scrollbar grid max-h-[70vh] grid-cols-2 gap-x-8 gap-y-6 overflow-y-auto px-7 py-6 md:grid-cols-4">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.titleKey} className="min-w-0">
            <div className="mb-3 text-[13px] font-semibold leading-none text-cyan-300/90">
              {t(group.titleKey)}
            </div>
            <div className="flex flex-col gap-3">
              {group.rows.map((row, rowIndex) => (
                <div key={rowIndex} className="flex items-center justify-between gap-3">
                  <span className="truncate text-[13px] leading-5 text-white/72">
                    {t(row.labelKey)}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {row.keyKeys?.map((key, index) => <Keycap key={`k-${index}`} token={t(key)} />)}
                    {row.keys?.map((token, index) => (
                      <Keycap key={index} token={platformKeyLabel(token)} />
                    ))}
                    {row.noteIcons ? (
                      <span
                        title={row.noteKey ? t(row.noteKey) : undefined}
                        aria-label={row.noteKey ? t(row.noteKey) : undefined}
                        className="inline-flex items-center gap-1 text-white/60"
                      >
                        {row.noteIcons.map((Icon, index) => (
                          <Icon key={index} className={row.noteIconClassName ?? 'h-[18px] w-[18px]'} />
                        ))}
                      </span>
                    ) : row.noteKey ? (
                      <span className="whitespace-nowrap text-[12px] leading-5 text-white/45">
                        {t(row.noteKey)}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
