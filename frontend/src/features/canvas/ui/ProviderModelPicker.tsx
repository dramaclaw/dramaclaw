// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, ChevronDown } from 'lucide-react';
import { ModelGuideOption } from './ModelGuideOption';
import { MODEL_MENU_VIEWPORT_MARGIN, useModelMenuAnchor, useModelMenuPreview } from './useModelMenuPreview';
import { useTranslation } from 'react-i18next';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { useFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import {
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

import { SHARED_PROVIDERS, type ModelOption, type ProviderOption, type ProviderModelDomain } from '../domain/modelOptions';

const MODEL_PICKER_POPOVER_WIDTH = 344;
const MODEL_PICKER_POPOVER_CLASS =
  'ui-panel ui-scrollbar canvas-node-transient-ui nodrag nowheel fixed z-[10000] overscroll-contain overflow-y-auto [overflow-anchor:none] p-1.5 backdrop-blur-md';

interface ProviderModelPickerProps {
  /** Explicit catalogs can distinguish an unavailable selection from their default. */
  placeholder?: string;
  disabled?: boolean;
  title?: string;
  showGuide?: boolean;
  selectedModelId: string;
  onChange: (modelId: string) => void;
  providers?: ProviderOption[];
  models?: ModelOption[];
  /**
   * Selects which freezone models endpoint backs the picker when no explicit
   * `models` prop is provided (`image` → /freezone/image/models, `video` →
   * /freezone/video/models). Defaults to `image` so existing image-node call
   * sites are unaffected.
   */
  domain?: ProviderModelDomain;
  className?: string;
  popoverPlacement?: 'top' | 'bottom';
  /**
   * Returns a disabled reason for a given model option, or null when the model
   * is selectable. When non-null, that option is rendered greyed-out and not
   * clickable, with the reason shown below the name (e.g. missing video input).
   */
  getOptionDisabledReason?: (model: ModelOption) => string | null;
}

export function ProviderModelPicker({
  selectedModelId,
  placeholder,
  disabled = false,
  title,
  showGuide = true,
  onChange,
  providers: _providers = SHARED_PROVIDERS,
  models,
  domain = 'image',
  className,
  popoverPlacement = 'top',
  getOptionDisabledReason,
}: ProviderModelPickerProps) {
  const { t } = useTranslation();
  // When the caller supplies an explicit `models` prop we don't fire any API
  // request — pass `null` to both hooks so they no-op. Otherwise the active
  // hook is picked by `domain`, and the inactive one is fed `null` to stay
  // dormant. (React still calls both hooks unconditionally so the call order
  // is stable across renders.)
  const skipFetch = models ? null : undefined;
  const imageHook = useFreezoneImageModels(domain === 'image' ? skipFetch : null);
  const videoHook = useFreezoneVideoModels(domain === 'video' ? skipFetch : null);
  const apiHook = domain === 'video' ? videoHook : imageHook;
  const effectiveModels = models ?? apiHook.models;
  // 后台**确实**一个模型都没配（接口成功返回空列表，不是拉取失败兜底、也不是
  // 还在加载）。此时触发器上原来会直接显示 `selectedModelId` —— 一个前端硬编码
  // 的默认 id，看着像有个模型可用，点开却是空列表。
  const catalogIsEmpty = !models && isAuthoritativeEmptyCatalog(apiHook);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const bounds = useModelMenuAnchor(triggerRef, isOpen);
  const focusOnOpen = useRef(false);
  const needsVideoSelection = domain === 'video' && !selectedModelId;
  const selectedModel = needsVideoSelection ? undefined
    : effectiveModels.find((m) => m.id === selectedModelId) ?? (placeholder ? undefined : effectiveModels[0]);

  const popoverPosition = (() => {
    if (!bounds) return null;
    const margin = MODEL_MENU_VIEWPORT_MARGIN;
    const width = Math.min(showGuide ? MODEL_PICKER_POPOVER_WIDTH : 260, bounds.vw - 2 * margin);
    const left = Math.max(margin, Math.min(bounds.left, bounds.vw - width - margin));
    const aboveSpace = Math.max(0, bounds.top - 2 * margin);
    const belowSpace = Math.max(0, bounds.vh - bounds.bottom - 2 * margin);
    const preferredAbove = popoverPlacement === 'top';
    const preferredSpace = preferredAbove ? aboveSpace : belowSpace;
    const above = preferredSpace >= 280 ? preferredAbove : aboveSpace > belowSpace;
    return { left, width, above,
      anchor: above ? bounds.top - margin : bounds.bottom + margin,
      height: Math.min(showGuide ? 400 : 280, above ? aboveSpace : belowSpace),
    };
  })();
  const { previewId, preview } = useModelMenuPreview(popoverRef, bounds, !!popoverPosition?.above);

  useEffect(() => {
    if (!isOpen) return;
    const onOutsideClick = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    // React Flow suppresses clicks after a drag. A press that starts a pan
    // or moves the node must not dismiss the menu before the anchor moves.
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('click', onOutsideClick, true);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (bounds && focusOnOpen.current) {
      popoverRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      focusOnOpen.current = false;
    }
  }, [bounds]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        onClick={(event) => {
          event.stopPropagation();
          focusOnOpen.current = event.detail === 0;
          preview(null);
          setIsOpen((prev) => !prev);
        }}
        aria-expanded={isOpen && !disabled}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} max-w-full disabled:cursor-not-allowed disabled:opacity-45`}
      >
        <Box className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
        <span className="truncate font-medium">
          {selectedModel?.label
            ?? placeholder
            ?? (catalogIsEmpty ? t('modelParams.noModelsAvailable')
              : needsVideoSelection ? t('episode.renderSettings.modelPlaceholder') : selectedModelId)}
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-text-muted/90" />
      </button>
      {isOpen && !disabled && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className={MODEL_PICKER_POPOVER_CLASS}
          style={{
            left: popoverPosition.left,
            top: popoverPosition.anchor,
            width: popoverPosition.width,
            maxHeight: popoverPosition.height,
            transform: popoverPosition.above ? 'translateY(-100%)' : undefined,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onMouseLeave={() => preview(null)}
          onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) preview(null); }}
        >
          <div className="flex flex-col gap-0.5">
            {effectiveModels.map((model) => {
              const isActive = selectedModel?.id === model.id;
              const disabledReason = getOptionDisabledReason?.(model) ?? null;
              const isDisabled = disabledReason != null && (!isActive || domain === "video");
              return <ModelGuideOption key={model.id} label={model.label}
                data={showGuide && (models || !apiHook.isFallback) ? model : undefined} selected={isActive}
                preview={previewId === model.id} disabledReason={isDisabled ? disabledReason : null}
                onPreview={(open, element) => preview(open ? model.id : null, element)}
                onSelect={() => { onChange(model.id); setIsOpen(false); triggerRef.current?.focus(); }} />;
            })}
            {effectiveModels.length === 0 && (
              <span className="px-3 py-2 text-xs text-text-muted">
                {t('modelPicker.empty')}
              </span>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
