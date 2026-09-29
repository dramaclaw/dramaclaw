import { textModelPresentation } from '@/lib/local-model-catalog';
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Box, BrainCircuit, ChevronDown, Layers, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TextModelPickerProps {
  selectedModel: string;
  models: string[];
  defaultModel: string;
  fallbackModel: string;
  requiresVisionModel: boolean;
  disabled: boolean;
  onChange: (model: string) => void;
}

function modelPresentation(model: string) {
  const presentation = textModelPresentation(model);
  const label = presentation.label;
  const isPro = model.startsWith('Pro/');
  const family = model.includes('DeepSeek') ? 'DeepSeek'
    : model.includes('GLM') ? 'GLM'
      : model.includes('Qwen') ? 'Qwen' : '';
  const Icon = family === 'DeepSeek' ? BrainCircuit
    : family === 'GLM' ? Sparkles
      : family === 'Qwen' ? Layers : Box;
  return {
    label: isPro ? `${label} Pro` : label,
    description: presentation.providerLabel,
    Icon,
  };
}

/** The menu is portalled so canvas zoom cannot shrink its rows or clip it. */
export function TextModelPicker({
  selectedModel,
  models,
  defaultModel,
  fallbackModel,
  requiresVisionModel,
  disabled,
  onChange,
}: TextModelPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const defaultId = defaultModel || fallbackModel;
  const selectedValue = !requiresVisionModel && selectedModel === defaultId ? '' : selectedModel;
  const currentId = selectedModel || (requiresVisionModel ? '' : defaultId);
  const current = modelPresentation(currentId);
  const CurrentIcon = current.Icon;
  const options = [
    ...(!requiresVisionModel ? [{ value: '', id: defaultId }] : []),
    ...[...new Set(models)]
      .filter((model) => requiresVisionModel || model !== defaultId)
      .map((model) => ({ value: model, id: model })),
  ];
  if (selectedModel && !options.some((option) => option.value === selectedValue)) {
    options.unshift({ value: selectedModel, id: selectedModel });
  }

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      const active = menu?.querySelector<HTMLElement>('[data-state="checked"]')
        ?? menu?.querySelector<HTMLElement>('[role="menuitemradio"]');
      if (!menu || !active) return;
      active.focus({ preventScroll: true });
      menu.scrollTop = active.offsetTop - (menu.clientHeight - active.clientHeight) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <DropdownMenu.Root open={open && !disabled} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('node.textNode.modelPickerHint')}
          title={currentId || t('modelPicker.empty')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="nodrag flex h-8 min-w-0 max-w-full items-center gap-1 rounded-lg bg-transparent px-2 py-1 text-[#f7f7f7] outline-none transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-white/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-white/10"
        >
          <CurrentIcon aria-hidden className="h-4 w-4 shrink-0 text-[#919191]" />
          <span className="truncate text-[13px] leading-5">
            {current.label || t('modelPicker.empty')}
            {currentId && <span className="ml-1 text-[10px] text-[#919191]">{current.description}</span>}
          </span>
          <ChevronDown
            aria-hidden
            className={`h-3.5 w-3.5 shrink-0 text-[#919191] transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={menuRef}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          loop
          aria-label={t('node.textNode.modelPickerHint')}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          className="canvas-node-transient-ui ui-scrollbar nodrag nowheel z-[10000] w-[368px] max-w-[calc(100vw-16px)] overflow-y-auto overflow-x-hidden rounded-2xl border-[0.5px] border-[#525252] bg-[#262626]/95 p-1 text-[#f7f7f7] shadow-[0_4px_10px_#00000040,0_2px_4px_#0000004d] outline-none backdrop-blur-[32px]"
          style={{ maxHeight: 'min(408px, var(--radix-dropdown-menu-content-available-height))' }}
        >
          <DropdownMenu.RadioGroup
            value={selectedValue}
            onValueChange={onChange}
            className="flex flex-col gap-1"
          >
            {options.map(({ value, id }) => {
              const { label, description, Icon } = modelPresentation(id);
              return (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  textValue={label}
                  title={id}
                  className="group flex h-[52px] w-full shrink-0 cursor-pointer select-none items-center gap-1 rounded-xl p-2 text-left outline-none transition-colors duration-200 hover:bg-white/10 data-[highlighted]:bg-white/10 data-[state=checked]:bg-white/15"
                >
                  <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg bg-[#363636]">
                    <Icon aria-hidden className="h-4 w-4 text-[#919191]" />
                  </span>
                  <span className="h-full min-w-0 flex-1 overflow-hidden pr-1">
                    <span className="flex h-full translate-y-2 flex-col justify-start transition-transform duration-200 group-hover:translate-y-0 group-data-[highlighted]:translate-y-0 group-data-[state=checked]:translate-y-0">
                      <span className="truncate text-sm font-medium leading-5">{label}</span>
                      <span className="truncate text-xs leading-4 text-[#919191] opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-data-[highlighted]:opacity-100 group-data-[state=checked]:opacity-100">
                        {description}
                      </span>
                    </span>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
          {options.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-[#919191]">{t('modelPicker.empty')}</div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
