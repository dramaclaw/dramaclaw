// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface PrevizSelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 预演台的下拉框。不用原生 `<select>`：macOS 上系统菜单把选中项对齐到框上，整块面板
 * 压住选择框本身，深色画面上还是一块浅色原生面板。这里面板挂在框下方，放不下自动翻到
 * 上方；外观跟着调用方传进来的 `className`（各面板原有的 FIELD 那套），只多一个箭头。
 *
 * 嵌在预演台的 base-ui Dialog 里，Esc 先关面板、不会把整个编辑器带走（base-ui 的浮层
 * 树按层级处理 dismiss）。
 *
 * 有 `placeholder` 时是「动作选单」：框里常驻占位字，选一项只触发 `onChange`，
 * 不留在框里（切机位、加对象到时间轴这类）。
 */
export function PrevizSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  id,
  'aria-label': ariaLabel,
  className,
  disabled,
}: {
  value: T | null;
  options: readonly PrevizSelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
  className?: string;
  disabled?: boolean;
}) {
  const current = placeholder === undefined ? value : null;
  return (
    <Select.Root<T>
      value={current}
      items={options}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <Select.Trigger
        id={id}
        aria-label={ariaLabel}
        // 当前值挂在属性上：触发器是个按钮，没有 value 可读，测试与调试都靠它。
        data-value={current ?? ''}
        className={cn(
          'flex items-center justify-between gap-1 text-left disabled:cursor-not-allowed disabled:opacity-40',
          className,
        )}
      >
        <Select.Value className="min-w-0 truncate" placeholder={placeholder} />
        <Select.Icon className="shrink-0 text-white/45">
          <ChevronDown className="h-3.5 w-3.5" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
          className="isolate z-50 outline-none"
        >
          <Select.Popup className="max-h-[min(var(--available-height),18rem)] min-w-(--anchor-width) overflow-y-auto rounded-md border border-[#2f3542] bg-[#1d222b] py-1 shadow-lg outline-none">
            <Select.List>
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  data-value={option.value}
                  className="relative flex cursor-default items-center py-1 pl-2 pr-7 text-[12px] text-[#c7cedb] outline-none select-none data-highlighted:bg-[#2a2f3a]"
                >
                  <Select.ItemText className="whitespace-nowrap">{option.label}</Select.ItemText>
                  <Select.ItemIndicator className="absolute right-2 flex items-center">
                    <Check className="h-3.5 w-3.5 text-sky-300" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
