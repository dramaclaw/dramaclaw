// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from 'react';
import { Check, X } from 'lucide-react';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

interface StylePickerPopoverProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

export function StylePickerPopover({
  selectedId,
  onSelect,
  onClose,
}: StylePickerPopoverProps) {
  const { templates, isLoading } = useFreezoneStyleTemplates();

  // Stable groups: backend `category` first (insertion order), un-categorized
  // bucket goes last under 「其他」.
  const grouped = useMemo(() => {
    const buckets = new Map<string, FreezoneStyleTemplate[]>();
    for (const item of templates) {
      const key = item.category && item.category.trim().length > 0
        ? item.category
        : '__other__';
      const arr = buckets.get(key) ?? [];
      arr.push(item);
      buckets.set(key, arr);
    }
    return Array.from(buckets.entries()).map(([key, items]) => ({
      key,
      label: key === '__other__' ? '其他' : key,
      items,
    }));
  }, [templates]);

  return (
    <div
      className={`nodrag nowheel flex max-h-[420px] w-[280px] flex-col overflow-hidden ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <span className="text-sm font-medium text-text-dark">风格</span>
        <div className="flex items-center gap-1">
          {selectedId && (
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="h-7 rounded-md px-2 text-[11px] font-medium text-text-dark/78 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            >
              清除
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            aria-label="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="ui-scrollbar nowheel flex-1 overflow-y-auto px-4 pb-3 pt-1">
        {isLoading && templates.length === 0 && (
          <div className="flex h-20 items-center justify-center text-[11px] text-text-muted">
            加载中…
          </div>
        )}
        {!isLoading && templates.length === 0 && (
          <div className="flex h-20 items-center justify-center text-[11px] text-text-muted">
            暂无风格模板
          </div>
        )}
        {grouped.map((group) => (
          <div key={group.key} className="mb-2.5 last:mb-0">
            <div className="pb-1.5 pt-1 text-[11px] font-semibold leading-none text-text-dark/50">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = item.id === selectedId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelect(item.id)}
                    title={item.style_prompt}
                    className={`-mx-2 flex min-h-8 items-center justify-between gap-2 rounded-[6px] px-2 py-1.5 text-left text-xs font-medium leading-snug transition-colors ${
                      isActive
                        ? 'bg-white/[0.13] text-text-dark ring-1 ring-white/24'
                        : 'text-text-dark/76 hover:bg-white/[0.11] hover:text-text-dark'
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {isActive && <Check className="size-3.5 shrink-0 text-[rgb(var(--accent-rgb))]" />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function describeStyleSelection(
  selectedId: string | null,
  templates: FreezoneStyleTemplate[],
): FreezoneStyleTemplate | null {
  if (!selectedId) return null;
  return templates.find((item) => item.id === selectedId) ?? null;
}
