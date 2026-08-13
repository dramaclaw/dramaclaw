// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AUTO_REQUEST_ASPECT_RATIO } from '@/features/canvas/domain/canvasNodes';
import {
  getModelProvider,
  type AspectRatioOption,
  type ImageModelDefinition,
  type ResolutionOption,
} from '@/features/canvas/models';
import {
  UiChipButton,
  UiPanel,
  UiInput,
  UiCheckbox,
  UiSelect,
} from '@/components/ui';

interface ModelParamsControlsProps {
  imageModels: ImageModelDefinition[];
  selectedModel: ImageModelDefinition;
  resolutionOptions: ResolutionOption[];
  selectedResolution: ResolutionOption;
  selectedAspectRatio: AspectRatioOption;
  aspectRatioOptions: AspectRatioOption[];
  onModelChange: (modelId: string) => void;
  onResolutionChange: (resolution: string) => void;
  onAspectRatioChange: (aspectRatio: string) => void;
  extraParams?: Record<string, unknown>;
  onExtraParamChange?: (key: string, value: boolean | number | string) => void;
  showWebSearchToggle?: boolean;
  webSearchEnabled?: boolean;
  onWebSearchToggle?: (enabled: boolean) => void;
  webSearchLabel?: string;
  showProviderName?: boolean;
  triggerSize?: 'md' | 'sm';
  chipClassName?: string;
  modelChipClassName?: string;
  paramsChipClassName?: string;
  modelPanelAlign?: 'center' | 'start';
  paramsPanelAlign?: 'center' | 'start';
  modelPanelClassName?: string;
  paramsPanelClassName?: string;
  providerOptionClassName?: string;
  modelOptionClassName?: string;
  activeProviderOptionClassName?: string;
  inactiveProviderOptionClassName?: string;
  activeModelOptionClassName?: string;
  inactiveModelOptionClassName?: string;
  optionGroupClassName?: string;
  activeParamOptionClassName?: string;
  inactiveParamOptionClassName?: string;
  extraParamsGroupClassName?: string;
  extraParamItemClassName?: string;
  extraParamLabelClassName?: string;
  extraParamFieldClassName?: string;
  showExtraParamsHeading?: boolean;
  showExtraParamDescription?: boolean;
  panelRenderMode?: 'portal' | 'inline';
  inlinePanelClassName?: string;
}

interface PanelAnchor {
  left: number;
  top: number;
}

const OTHER_PARAMS_PANEL_CLASS_NAME = 'w-[280px] p-3';
const DEFAULT_MODEL_PANEL_CLASS_NAME = 'inline-block min-w-[320px] max-w-[calc(100vw-32px)] p-2';
const DEFAULT_PROVIDER_OPTION_CLASS_NAME =
  'min-w-[92px] px-3 text-center';
const DEFAULT_MODEL_OPTION_CLASS_NAME =
  'min-h-9 min-w-[128px] max-w-full justify-center px-3 py-2 text-center';
const DEFAULT_ACTIVE_PROVIDER_OPTION_CLASS_NAME =
  'border-accent/50 bg-accent/15 text-text-dark';
const DEFAULT_INACTIVE_PROVIDER_OPTION_CLASS_NAME =
  'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)]';
const DEFAULT_ACTIVE_MODEL_OPTION_CLASS_NAME =
  'border-accent/50 bg-accent/15 text-text-dark shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]';
const DEFAULT_INACTIVE_MODEL_OPTION_CLASS_NAME =
  'border-[rgba(255,255,255,0.12)] bg-bg-dark/65 text-text-muted hover:border-[rgba(255,255,255,0.2)] hover:bg-[rgba(255,255,255,0.05)]';
const DEFAULT_OPTION_GROUP_CLASS_NAME =
  'rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/65 p-1';
const DEFAULT_ACTIVE_PARAM_OPTION_CLASS_NAME = 'bg-surface-dark text-text-dark';
const DEFAULT_INACTIVE_PARAM_OPTION_CLASS_NAME = 'text-text-muted hover:bg-bg-dark';
const DEFAULT_EXTRA_PARAMS_GROUP_CLASS_NAME =
  'space-y-2 rounded-xl border border-[rgba(255,255,255,0.1)] bg-bg-dark/65 p-3';
const DEFAULT_EXTRA_PARAM_ITEM_CLASS_NAME =
  'space-y-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-black/10 p-2';
const DEFAULT_EXTRA_PARAM_LABEL_CLASS_NAME = 'text-xs font-medium text-text-dark';
const DEFAULT_EXTRA_PARAM_FIELD_CLASS_NAME = 'h-9 text-sm';

function NanoBananaIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <path d="M1.5 19.824c0-.548.444-.992.991-.992h.744a.991.991 0 010 1.983H2.49a.991.991 0 01-.991-.991z" fill="#F3AD61" />
      <path d="M14.837 13.5h7.076c.522 0 .784-.657.413-1.044l-1.634-1.704a3.183 3.183 0 00-4.636 0l-1.633 1.704c-.37.385-.107 1.044.414 1.044zM3.587 13.5h7.076c.521 0 .784-.659.414-1.044l-1.635-1.704a3.183 3.183 0 00-4.636 0l-1.633 1.704c-.37.385-.107 1.044.414 1.044z" fill="#F9C23C" />
      <path d="M12.525 1.521c3.69-.53 5.97 8.923 4.309 12.744-1.662 3.82-5.248 4.657-9.053 6.152a3.49 3.49 0 01-1.279.244c-1.443 0-2.227 1.187-2.774-.282-.707-1.9.22-4.031 2.069-4.757 2.014-.79 3.084-2.308 3.89-4.364.82-2.096.877-2.956.873-5.241-.003-1.827-.123-4.195 1.965-4.496z" fill="#FEEFC2" />
      <path d="M16.834 14.264l-7.095-3.257c-.815 1.873-2.29 3.308-4.156 4.043-2.16.848-3.605 3.171-2.422 5.54 2.364 4.727 13.673-.05 13.673-6.325z" fill="#FCD53F" />
      <path d="M13.68 12.362c.296.094.46.41.365.707-1.486 4.65-5.818 6.798-9.689 6.997a.562.562 0 11-.057-1.124c3.553-.182 7.372-2.138 8.674-6.216a.562.562 0 01.707-.364z" fill="#F9C23C" />
      <path d="M17.43 19.85l-7.648-8.835h6.753c1.595.08 2.846 1.433 2.846 3.073v5.664c0 .997-.898 1.302-1.95.098z" fill="#FFF478" />
    </svg>
  );
}

function getRatioPreviewStyle(ratio: string): { width: number; height: number } {
  const [rawW, rawH] = ratio.split(':').map((value) => Number(value));
  const width = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const height = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;

  const box = 20;
  if (width >= height) {
    return {
      width: box,
      height: Math.max(8, Math.round((box * height) / width)),
    };
  }

  return {
    width: Math.max(8, Math.round((box * width) / height)),
    height: box,
  };
}

function resolveTranslatedText(
  t: (key: string) => string,
  key: string | undefined,
  fallback: string | undefined
): string {
  if (!key) {
    return fallback ?? '';
  }

  const translated = t(key);
  return translated === key ? (fallback ?? key) : translated;
}

function resolveExtraParamValue(
  key: string,
  extraParams: Record<string, unknown> | undefined,
  defaultExtraParams: Record<string, unknown> | undefined,
  schemaDefault: boolean | number | string | undefined
): boolean | number | string | undefined {
  const currentValue = extraParams?.[key];
  if (typeof currentValue === 'boolean' || typeof currentValue === 'number' || typeof currentValue === 'string') {
    return currentValue;
  }

  const modelDefaultValue = defaultExtraParams?.[key];
  if (
    typeof modelDefaultValue === 'boolean' ||
    typeof modelDefaultValue === 'number' ||
    typeof modelDefaultValue === 'string'
  ) {
    return modelDefaultValue;
  }

  return schemaDefault;
}

export const ModelParamsControls = memo(({
  imageModels,
  selectedModel,
  resolutionOptions,
  selectedResolution,
  selectedAspectRatio,
  aspectRatioOptions,
  onModelChange,
  onResolutionChange,
  onAspectRatioChange,
  extraParams,
  onExtraParamChange,
  showWebSearchToggle = false,
  webSearchEnabled = false,
  onWebSearchToggle,
  webSearchLabel,
  showProviderName = true,
  triggerSize = 'md',
  chipClassName = '',
  modelChipClassName = 'w-auto justify-start',
  paramsChipClassName = 'w-auto justify-start',
  modelPanelAlign = 'center',
  paramsPanelAlign = 'center',
  modelPanelClassName = DEFAULT_MODEL_PANEL_CLASS_NAME,
  paramsPanelClassName = 'w-[420px] p-3',
  providerOptionClassName = DEFAULT_PROVIDER_OPTION_CLASS_NAME,
  modelOptionClassName = DEFAULT_MODEL_OPTION_CLASS_NAME,
  activeProviderOptionClassName = DEFAULT_ACTIVE_PROVIDER_OPTION_CLASS_NAME,
  inactiveProviderOptionClassName = DEFAULT_INACTIVE_PROVIDER_OPTION_CLASS_NAME,
  activeModelOptionClassName = DEFAULT_ACTIVE_MODEL_OPTION_CLASS_NAME,
  inactiveModelOptionClassName = DEFAULT_INACTIVE_MODEL_OPTION_CLASS_NAME,
  optionGroupClassName = DEFAULT_OPTION_GROUP_CLASS_NAME,
  activeParamOptionClassName = DEFAULT_ACTIVE_PARAM_OPTION_CLASS_NAME,
  inactiveParamOptionClassName = DEFAULT_INACTIVE_PARAM_OPTION_CLASS_NAME,
  extraParamsGroupClassName = DEFAULT_EXTRA_PARAMS_GROUP_CLASS_NAME,
  extraParamItemClassName = DEFAULT_EXTRA_PARAM_ITEM_CLASS_NAME,
  extraParamLabelClassName = DEFAULT_EXTRA_PARAM_LABEL_CLASS_NAME,
  extraParamFieldClassName = DEFAULT_EXTRA_PARAM_FIELD_CLASS_NAME,
  showExtraParamsHeading = true,
  showExtraParamDescription = true,
  panelRenderMode = 'portal',
  inlinePanelClassName = 'absolute bottom-full left-0 z-[80] mb-2',
}: ModelParamsControlsProps) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const modelTriggerRef = useRef<HTMLDivElement>(null);
  const paramsTriggerRef = useRef<HTMLDivElement>(null);
  const otherParamsTriggerRef = useRef<HTMLDivElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const paramsPanelRef = useRef<HTMLDivElement>(null);
  const otherParamsPanelRef = useRef<HTMLDivElement>(null);
  const [openPanel, setOpenPanel] = useState<'model' | 'params' | 'otherParams' | null>(null);
  const [renderPanel, setRenderPanel] = useState<'model' | 'params' | 'otherParams' | null>(null);
  const [isPanelVisible, setIsPanelVisible] = useState(false);
  const [modelPanelAnchor, setModelPanelAnchor] = useState<PanelAnchor | null>(null);
  const [paramsPanelAnchor, setParamsPanelAnchor] = useState<PanelAnchor | null>(null);
  const [otherParamsPanelAnchor, setOtherParamsPanelAnchor] = useState<PanelAnchor | null>(null);
  const [modelAnchorBaseWidth, setModelAnchorBaseWidth] = useState<number | null>(null);
  const [paramsAnchorBaseWidth, setParamsAnchorBaseWidth] = useState<number | null>(null);
  const [otherParamsAnchorBaseWidth, setOtherParamsAnchorBaseWidth] = useState<number | null>(null);
  const [panelProviderId, setPanelProviderId] = useState(selectedModel.providerId);

  const selectedProvider = useMemo(
    () => getModelProvider(selectedModel.providerId),
    [selectedModel.providerId]
  );
  const selectedModelName = useMemo(
    () => selectedModel.displayName.replace(/\s*\([^)]*\)\s*$/u, '').trim() || selectedModel.displayName,
    [selectedModel.displayName]
  );
  const selectedProviderName = selectedProvider.label || selectedProvider.name;
  const providerOptions = useMemo(() => {
    const providerOrder = ['huimeng', 'openrouter', 'openai'];
    const providerIndex = new Map(providerOrder.map((id, index) => [id, index]));
    const uniqueProviderIds = Array.from(new Set(imageModels.map((model) => model.providerId)));
    return uniqueProviderIds
      .map((providerId) => getModelProvider(providerId))
      .sort((left, right) => {
        const leftIndex = providerIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = providerIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
      });
  }, [imageModels]);
  const providerModels = useMemo(
    () => imageModels.filter((model) => model.providerId === panelProviderId),
    [imageModels, panelProviderId]
  );
  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ImageModelDefinition[]>();
    providerModels.forEach((model) => {
      const normalizedName = model.displayName.replace(/\s*\([^)]*\)\s*$/u, '').trim();
      const key = normalizedName.length > 0 ? normalizedName : model.displayName;
      const current = grouped.get(key) ?? [];
      current.push(model);
      grouped.set(key, current);
    });
    return Array.from(grouped.entries())
      .map(([name, models]) => ({ name, models }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [providerModels]);
  const isCompactTrigger = triggerSize === 'sm';
  const modelIconClassName = isCompactTrigger ? 'h-3 w-3 shrink-0' : 'h-4 w-4 shrink-0';
  const paramsIconClassName = isCompactTrigger ? 'h-2.5 w-2.5 shrink-0' : 'h-4 w-4 shrink-0';
  const modelTextClassName = isCompactTrigger
    ? 'min-w-0 truncate text-[10px] font-medium leading-none'
    : 'min-w-0 truncate font-medium';
  const providerTextClassName = isCompactTrigger
    ? 'shrink-0 text-[10px] leading-none text-text-muted/80'
    : 'shrink-0 text-text-muted/80';
  const paramsPrimaryTextClassName = isCompactTrigger
    ? 'truncate text-[10px] leading-none'
    : 'truncate';
  const paramsSecondaryTextClassName = isCompactTrigger
    ? 'text-[10px] leading-none text-text-muted/80'
    : 'text-text-muted/80';
  const extraParamSchema = selectedModel.extraParamsSchema ?? [];
  const inlineExtraParamSchema = useMemo(
    () =>
      extraParamSchema.filter(
        (definition) => definition.key === 'thinking_level' && definition.type === 'enum'
      ),
    [extraParamSchema]
  );
  const panelExtraParamSchema = useMemo(
    () => extraParamSchema.filter((definition) => definition.key !== 'thinking_level'),
    [extraParamSchema]
  );
  const hasOtherParamsPanel = showWebSearchToggle || inlineExtraParamSchema.length > 0;

  useEffect(() => {
    const animationDurationMs = 200;
    let enterRaf1: number | null = null;
    let enterRaf2: number | null = null;
    let switchTimer: ReturnType<typeof setTimeout> | null = null;

    const startEnterAnimation = () => {
      enterRaf1 = requestAnimationFrame(() => {
        enterRaf2 = requestAnimationFrame(() => {
          setIsPanelVisible(true);
        });
      });
    };

    if (!openPanel) {
      setIsPanelVisible(false);
      switchTimer = setTimeout(() => setRenderPanel(null), animationDurationMs);
      return () => {
        if (switchTimer) {
          clearTimeout(switchTimer);
        }
        if (enterRaf1) {
          cancelAnimationFrame(enterRaf1);
        }
        if (enterRaf2) {
          cancelAnimationFrame(enterRaf2);
        }
      };
    }

    if (renderPanel && renderPanel !== openPanel) {
      setIsPanelVisible(false);
      switchTimer = setTimeout(() => {
        setRenderPanel(openPanel);
        startEnterAnimation();
      }, animationDurationMs);
      return () => {
        if (switchTimer) {
          clearTimeout(switchTimer);
        }
        if (enterRaf1) {
          cancelAnimationFrame(enterRaf1);
        }
        if (enterRaf2) {
          cancelAnimationFrame(enterRaf2);
        }
      };
    }

    if (!renderPanel) {
      setRenderPanel(openPanel);
    }
    startEnterAnimation();

    return () => {
      if (switchTimer) {
        clearTimeout(switchTimer);
      }
      if (enterRaf1) {
        cancelAnimationFrame(enterRaf1);
      }
      if (enterRaf2) {
        cancelAnimationFrame(enterRaf2);
      }
    };
  }, [openPanel, renderPanel]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (containerRef.current?.contains(target)) {
        return;
      }
      if (modelPanelRef.current?.contains(target)) {
        return;
      }
      if (paramsPanelRef.current?.contains(target)) {
        return;
      }
      if (otherParamsPanelRef.current?.contains(target)) {
        return;
      }
      setOpenPanel(null);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const getPanelAnchor = (
    triggerElement: HTMLDivElement | null,
    align: 'center' | 'start',
    baseWidth?: number | null
  ): PanelAnchor | null => {
    if (!triggerElement) {
      return null;
    }
    const rect = triggerElement.getBoundingClientRect();
    const anchorWidth = typeof baseWidth === 'number' && baseWidth > 0 ? baseWidth : rect.width;
    return {
      left: align === 'center' ? rect.left + anchorWidth / 2 : rect.left,
      top: rect.top - 8,
    };
  };

  const buildPanelStyle = (
    anchor: PanelAnchor | null,
    align: 'center' | 'start'
  ): CSSProperties | undefined => {
    if (!anchor) {
      return undefined;
    }

    const xTransform = align === 'center' ? 'translateX(-50%) ' : '';
    return {
      left: anchor.left,
      top: anchor.top,
      transform: `${xTransform}translateY(-100%)`,
    };
  };

  const renderPanelShell = (
    panelRef: RefObject<HTMLDivElement | null>,
    anchor: PanelAnchor | null,
    align: 'center' | 'start',
    children: ReactNode
  ): ReactNode => {
    const panel = (
      <div
        ref={panelRef}
        className={`${panelRenderMode === 'inline' ? inlinePanelClassName : 'fixed z-[80]'} transition-opacity duration-200 ease-out ${isPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          }`}
        style={panelRenderMode === 'inline' ? undefined : buildPanelStyle(anchor, align)}
      >
        {children}
      </div>
    );

    if (panelRenderMode === 'inline') {
      return panel;
    }

    return typeof document !== 'undefined' ? createPortal(panel, document.body) : null;
  };

  return (
    <div ref={containerRef} className="relative flex items-center gap-1">
      <div ref={modelTriggerRef} className="relative flex">
        <UiChipButton
          active={openPanel === 'model'}
          className={`${chipClassName} ${modelChipClassName}`}
          onClick={(event) => {
            event.stopPropagation();
            if (openPanel === 'model') {
              setOpenPanel(null);
              return;
            }
            setPanelProviderId(selectedModel.providerId);
            const triggerWidth = modelTriggerRef.current?.getBoundingClientRect().width ?? null;
            const nextBaseWidth = modelAnchorBaseWidth ?? triggerWidth;
            if (modelAnchorBaseWidth == null && triggerWidth) {
              setModelAnchorBaseWidth(triggerWidth);
            }
            setModelPanelAnchor(getPanelAnchor(modelTriggerRef.current, modelPanelAlign, nextBaseWidth));
            setOpenPanel('model');
          }}
        >
          <NanoBananaIcon className={modelIconClassName} />
          <span className={modelTextClassName}>{selectedModelName}</span>
          {showProviderName && (
            <span className={providerTextClassName}>{selectedProviderName}</span>
          )}
        </UiChipButton>
      </div>

      <div ref={paramsTriggerRef} className="relative flex">
        <UiChipButton
          active={openPanel === 'params'}
          className={`${chipClassName} ${paramsChipClassName}`}
          onClick={(event) => {
            event.stopPropagation();
            if (openPanel === 'params') {
              setOpenPanel(null);
              return;
            }
            const triggerWidth = paramsTriggerRef.current?.getBoundingClientRect().width ?? null;
            const nextBaseWidth = paramsAnchorBaseWidth ?? triggerWidth;
            if (paramsAnchorBaseWidth == null && triggerWidth) {
              setParamsAnchorBaseWidth(triggerWidth);
            }
            setParamsPanelAnchor(getPanelAnchor(paramsTriggerRef.current, paramsPanelAlign, nextBaseWidth));
            setOpenPanel('params');
          }}
        >
          <SlidersHorizontal className={paramsIconClassName} />
          <span className={paramsPrimaryTextClassName}>{selectedAspectRatio.label}</span>
          <span className={paramsSecondaryTextClassName}>· {selectedResolution.label}</span>
        </UiChipButton>
      </div>

      {hasOtherParamsPanel && (
        <div ref={otherParamsTriggerRef} className="relative flex">
          <UiChipButton
            active={openPanel === 'otherParams'}
            className={`${chipClassName} w-auto shrink-0 justify-center`}
            onClick={(event) => {
              event.stopPropagation();
              if (openPanel === 'otherParams') {
                setOpenPanel(null);
                return;
              }
              const triggerWidth = otherParamsTriggerRef.current?.getBoundingClientRect().width ?? null;
              const nextBaseWidth = otherParamsAnchorBaseWidth ?? triggerWidth;
              if (otherParamsAnchorBaseWidth == null && triggerWidth) {
                setOtherParamsAnchorBaseWidth(triggerWidth);
              }
              setOtherParamsPanelAnchor(
                getPanelAnchor(otherParamsTriggerRef.current, 'center', nextBaseWidth)
              );
              setOpenPanel('otherParams');
            }}
          >
            <SlidersHorizontal className={paramsIconClassName} />
            <span className={paramsPrimaryTextClassName}>{t('modelParams.otherParams')}</span>
          </UiChipButton>
        </div>
      )}

      {renderPanel === 'model' && renderPanelShell(
        modelPanelRef,
        modelPanelAnchor,
        modelPanelAlign,
        (
          <UiPanel className={modelPanelClassName}>
            <div className="ui-scrollbar max-h-[340px] space-y-4 overflow-y-auto p-1">
              <section>
                <div className="mb-2 text-xs font-medium text-text-muted">
                  {t('modelParams.provider')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {providerOptions.map((provider) => {
                    const active = provider.id === panelProviderId;
                    return (
                      <button
                        key={provider.id}
                        className={`h-8 rounded-lg border text-xs transition-colors ${providerOptionClassName} ${active
                          ? activeProviderOptionClassName
                          : inactiveProviderOptionClassName
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (provider.id !== panelProviderId) {
                            const firstModel = imageModels.find((model) => model.providerId === provider.id);
                            if (firstModel) {
                              onModelChange(firstModel.id);
                            }
                          }
                          setPanelProviderId(provider.id);
                        }}
                      >
                        {provider.label || provider.name}
                      </button>
                    );
                  })}
                </div>
              </section>

              <section>
                <div className="mb-2 text-xs font-medium text-text-muted">
                  {t('modelParams.model')}
                </div>
                <div className="flex flex-wrap gap-2">
                  {/* 后台一个模型都没配时列表是空的——说清楚，别只留一片空白让用户
                      以为是没加载出来。提交侧由各节点的 imageModelsEmpty 拦死。 */}
                  {modelGroups.length === 0 && (
                    <span className="text-xs text-text-muted">
                      {t('modelParams.noModelsAvailable')}
                    </span>
                  )}
                  {modelGroups.map((group) => {
                    const active = group.models.some((model) => model.id === selectedModel.id);
                    const targetModel = group.models.find((model) => model.id === selectedModel.id)
                      ?? group.models[0];
                    return (
                      <button
                        key={group.name}
                        className={`inline-flex max-w-full items-center rounded-lg border text-xs leading-4 transition-colors ${modelOptionClassName} ${active
                          ? activeModelOptionClassName
                          : inactiveModelOptionClassName
                          }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onModelChange(targetModel.id);
                          setOpenPanel(null);
                        }}
                      >
                        <span className="max-w-full break-words text-inherit">{group.name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </UiPanel>
        )
      )}

      {renderPanel === 'params' && renderPanelShell(
        paramsPanelRef,
        paramsPanelAnchor,
        paramsPanelAlign,
        (
          <UiPanel className={paramsPanelClassName}>
            <div>
              <div className="mb-2 text-xs text-text-muted">{t('modelParams.quality')}</div>
              <div
                className={`grid gap-1 ${optionGroupClassName}`}
                style={{
                  gridTemplateColumns: `repeat(${Math.max(1, resolutionOptions.length)}, minmax(0, 1fr))`,
                }}
              >
                {resolutionOptions.map((item) => {
                  const active = item.value === selectedResolution.value;
                  return (
                    <button
                      key={item.value}
                      className={`h-8 rounded-lg text-sm transition-colors ${active
                        ? activeParamOptionClassName
                        : inactiveParamOptionClassName
                        }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onResolutionChange(item.value);
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-2 text-xs text-text-muted">{t('modelParams.aspectRatio')}</div>
              <div className={`grid grid-cols-5 gap-1 ${optionGroupClassName}`}>
                {aspectRatioOptions.map((item) => {
                  const active = item.value === selectedAspectRatio.value;
                  const previewStyle = getRatioPreviewStyle(
                    item.value === AUTO_REQUEST_ASPECT_RATIO ? '1:1' : item.value
                  );

                  return (
                    <button
                      key={item.value}
                      className={`rounded-lg px-1 py-1.5 transition-colors ${active
                        ? activeParamOptionClassName
                        : inactiveParamOptionClassName
                        }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onAspectRatioChange(item.value);
                      }}
                    >
                      <div className="mb-1 flex h-6 items-center justify-center">
                        {item.value === AUTO_REQUEST_ASPECT_RATIO ? (
                          <Zap className="h-3 w-3" strokeWidth={2.4} />
                        ) : (
                          <span
                            className="inline-block rounded-[3px] border border-current/60"
                            style={previewStyle}
                          />
                        )}
                      </div>
                      <div className="text-[10px]">{item.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {panelExtraParamSchema.length > 0 && (
              <div className="mt-3">
                {showExtraParamsHeading && (
                  <div className="mb-2 text-xs text-text-muted">{t('modelParams.extraOptions')}</div>
                )}
                <div className={extraParamsGroupClassName}>
                  {panelExtraParamSchema.map((definition) => {
                    const translatedLabel = resolveTranslatedText(
                      t,
                      definition.labelKey,
                      definition.label
                    );
                    const translatedDescription = definition.description || definition.descriptionKey
                      ? resolveTranslatedText(
                        t,
                        definition.descriptionKey,
                        definition.description
                      )
                      : '';
                    const resolvedValue = resolveExtraParamValue(
                      definition.key,
                      extraParams,
                      selectedModel.defaultExtraParams,
                      definition.defaultValue
                    );

                    return (
                      <div key={definition.key} className={extraParamItemClassName}>
                        <div>
                          <div className={extraParamLabelClassName}>{translatedLabel}</div>
                          {showExtraParamDescription && translatedDescription && (
                            <div className="mt-0.5 text-[11px] leading-4 text-text-muted">
                              {translatedDescription}
                            </div>
                          )}
                        </div>

                        {definition.type === 'enum' && definition.options && (
                          <UiSelect
                            value={String(resolvedValue ?? '')}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, event.target.value)
                            }
                            className={extraParamFieldClassName}
                          >
                            {definition.options.map((option) => (
                              <option key={option.value} value={option.value}>
                                {resolveTranslatedText(t, option.labelKey, option.label)}
                              </option>
                            ))}
                          </UiSelect>
                        )}

                        {definition.type === 'boolean' && (
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dark">
                            <UiCheckbox
                              checked={Boolean(resolvedValue)}
                              onCheckedChange={(checked) =>
                                onExtraParamChange?.(definition.key, checked)
                              }
                            />
                            <span>{translatedLabel}</span>
                          </label>
                        )}

                        {definition.type === 'number' && (
                          <UiInput
                            type="number"
                            min={definition.min}
                            max={definition.max}
                            step={definition.step}
                            value={typeof resolvedValue === 'number' ? String(resolvedValue) : ''}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, Number(event.target.value))
                            }
                            className={extraParamFieldClassName}
                          />
                        )}

                        {definition.type === 'string' && (
                          <UiInput
                            value={typeof resolvedValue === 'string' ? resolvedValue : ''}
                            onChange={(event) =>
                              onExtraParamChange?.(definition.key, event.target.value)
                            }
                            className={extraParamFieldClassName}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </UiPanel>
        )
      )}

      {renderPanel === 'otherParams' && renderPanelShell(
        otherParamsPanelRef,
        otherParamsPanelAnchor,
        'center',
        (
          <UiPanel className={OTHER_PARAMS_PANEL_CLASS_NAME}>
            <div className="space-y-3">
              {showWebSearchToggle && (
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark/65 px-3 py-2">
                  <UiCheckbox
                    checked={webSearchEnabled}
                    onCheckedChange={(checked) => onWebSearchToggle?.(checked)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text-dark">
                      {webSearchLabel ?? t('modelParams.enableWebSearch')}
                    </div>
                  </div>
                </label>
              )}

              {inlineExtraParamSchema.map((definition) => {
                const translatedLabel = resolveTranslatedText(t, definition.labelKey, definition.label);
                const translatedDescription = definition.description || definition.descriptionKey
                  ? resolveTranslatedText(
                    t,
                    definition.descriptionKey,
                    definition.description
                  )
                  : '';
                const resolvedValue = resolveExtraParamValue(
                  definition.key,
                  extraParams,
                  selectedModel.defaultExtraParams,
                  definition.defaultValue
                );

                return (
                  <div
                    key={definition.key}
                    className="space-y-2 rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark/65 p-3"
                  >
                    <div>
                      <div className="text-xs font-medium text-text-dark">{translatedLabel}</div>
                      {translatedDescription && (
                        <div className="mt-0.5 text-[11px] leading-4 text-text-muted">
                          {translatedDescription}
                        </div>
                      )}
                    </div>
                    <UiSelect
                      value={String(resolvedValue ?? '')}
                      onChange={(event) => onExtraParamChange?.(definition.key, event.target.value)}
                      className="h-9 text-sm"
                    >
                      {(definition.options ?? []).map((option) => (
                        <option key={option.value} value={option.value}>
                          {resolveTranslatedText(t, option.labelKey, option.label)}
                        </option>
                      ))}
                    </UiSelect>
                  </div>
                );
              })}
            </div>
          </UiPanel>
        )
      )}

    </div>
  );
});

ModelParamsControls.displayName = 'ModelParamsControls';
