// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Check,
  ChevronDown,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';

import { CreditCostPill } from '@/components/credits/credit-visual';
import { UiTextArea } from '@/components/ui';
import { Slider } from '@/components/shadcn/slider';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import {
  CANVAS_NODE_TOOLBAR_CARD_CLASS,
} from '@/features/canvas/ui/nodeFrameStyles';
import { MultiAngleSphere } from '@/features/canvas/ui/MultiAngleSphere';

export type MultiAnglePresetKey =
  | 'custom'
  | 'fisheye'
  | 'tilted'
  | 'frontTopDown'
  | 'frontBottomUp'
  | 'panoramaTopDown'
  | 'backView';

// 景别档位，直接采用后端 shot_size 枚举字符串（避免前后端映射错位）。
export type MultiAngleZoomLevel =
  | 'extreme_close_up'
  | 'close_up'
  | 'medium_close'
  | 'medium'
  | 'full_body'
  | 'wide'
  | 'extreme_wide';

interface MultiAnglePresetConfig {
  horizontalDeg: number;
  verticalDeg: number;
  zoom: MultiAngleZoomLevel;
  defaultOverride?: string;
}

const PRESET_KEYS: MultiAnglePresetKey[] = [
  'custom',
  'fisheye',
  'tilted',
  'frontTopDown',
  'frontBottomUp',
  'panoramaTopDown',
  'backView',
];

const PRESET_CONFIGS: Record<Exclude<MultiAnglePresetKey, 'custom'>, MultiAnglePresetConfig> = {
  fisheye: {
    horizontalDeg: 0,
    verticalDeg: 30,
    zoom: 'extreme_close_up',
    defaultOverride: '极度特写镜头，广角镜头，边缘带有鱼眼畸变效果。',
  },
  tilted: {
    horizontalDeg: 45,
    verticalDeg: -30,
    zoom: 'medium',
    defaultOverride: 'dutch angle, tilted frame',
  },
  frontTopDown: { horizontalDeg: 0, verticalDeg: 60, zoom: 'medium' },
  frontBottomUp: { horizontalDeg: 0, verticalDeg: -30, zoom: 'medium' },
  panoramaTopDown: { horizontalDeg: 45, verticalDeg: 30, zoom: 'wide' },
  backView: { horizontalDeg: 180, verticalDeg: 0, zoom: 'medium' },
};

// 由近到远排列，对应景别滑块从左到右。
const ZOOM_LEVELS: MultiAngleZoomLevel[] = [
  'extreme_close_up',
  'close_up',
  'medium_close',
  'medium',
  'full_body',
  'wide',
  'extreme_wide',
];

export type MultiAngleProviderId = 'huimeng' | 'openrouter' | 'openai';

export const MULTI_ANGLE_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type MultiAngleImageSize = (typeof MULTI_ANGLE_IMAGE_SIZES)[number];
const DEFAULT_MULTI_ANGLE_IMAGE_SIZE: MultiAngleImageSize = '2K';

export interface MultiAngleSubmitPayload {
  prompt: string;
  displayName: string;
  preset: MultiAnglePresetKey;
  horizontalDeg: number;
  verticalDeg: number;
  zoom: MultiAngleZoomLevel;
  promptOverride: string | null;
  apiModel: string;
  providerId: MultiAngleProviderId;
  imageSize: MultiAngleImageSize;
}

interface MultiAngleEditorPanelProps {
  imageSource: string;
  onClose: () => void;
  onSubmit: (payload: MultiAngleSubmitPayload) => void;
}

const DEFAULT_HORIZONTAL = 0;
const DEFAULT_VERTICAL = 0;
const DEFAULT_ZOOM: MultiAngleZoomLevel = 'medium';
const EDITOR_PROMPT_TEXTAREA_CLASS =
  'mb-5 mt-3.5 h-14 rounded-xl !border-white/[0.14] !bg-bg-dark/45 px-3 py-2 text-xs !text-text-dark placeholder:!text-text-dark/52 shadow-inner';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function imageModelSupportsQuality(apiModel: string | null | undefined): boolean {
  const normalized = String(apiModel ?? '').trim().toLowerCase();
  return (
    normalized === 'gpt-image-2'
    || normalized === 'image-2'
    || normalized === 'image-2-official'
    || normalized.includes('gpt-image')
  );
}

// 预览图片卡片的相对尺寸：景别越近越大、越远越小（仅影响球内预览，不发后端）。
const ZOOM_PREVIEW_SCALE: Record<MultiAngleZoomLevel, number> = {
  extreme_close_up: 1.9,
  close_up: 1.55,
  medium_close: 1.25,
  medium: 1,
  full_body: 0.82,
  wide: 0.62,
  extreme_wide: 0.45,
};

function zoomScale(level: MultiAngleZoomLevel): number {
  return ZOOM_PREVIEW_SCALE[level];
}

function describeHorizontal(t: (k: string) => string, deg: number): string {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized <= 22 || normalized >= 338) return t('multiAngleEditor.horizontalLabels.front');
  if (normalized < 68) return t('multiAngleEditor.horizontalLabels.frontRight');
  if (normalized < 112) return t('multiAngleEditor.horizontalLabels.right');
  if (normalized < 158) return t('multiAngleEditor.horizontalLabels.backRight');
  if (normalized < 202) return t('multiAngleEditor.horizontalLabels.back');
  if (normalized < 248) return t('multiAngleEditor.horizontalLabels.backLeft');
  if (normalized < 292) return t('multiAngleEditor.horizontalLabels.left');
  return t('multiAngleEditor.horizontalLabels.frontLeft');
}

function describeVertical(t: (k: string) => string, deg: number): string {
  if (deg >= 60) return t('multiAngleEditor.verticalLabels.lookDown');
  if (deg >= 20) return t('multiAngleEditor.verticalLabels.highAngle');
  if (deg > -20) return t('multiAngleEditor.verticalLabels.eyeLevel');
  if (deg > -60) return t('multiAngleEditor.verticalLabels.lowAngle');
  return t('multiAngleEditor.verticalLabels.lookUp');
}

interface SliderRowProps {
  label: string;
  trailing: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}

interface QualityPickerProps {
  value: MultiAngleImageSize;
  onChange: (value: MultiAngleImageSize) => void;
}

interface PresetPickerProps {
  value: MultiAnglePresetKey;
  onChange: (value: MultiAnglePresetKey) => void;
}

function PresetPicker({ value, onChange }: PresetPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-7 min-w-[70px] items-center justify-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[11px] font-medium text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        {t(`multiAngleEditor.presets.${value}`)}
        <ChevronDown className="h-2.5 w-2.5 text-text-dark/55" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={`absolute left-0 top-full z-50 mt-2 w-[168px] p-1.5 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {PRESET_KEYS.map((key) => {
            const isActive = value === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setIsOpen(false);
                }}
                className={`flex h-8 w-full items-center gap-2 rounded border px-2.5 text-left text-xs transition-colors ${
                  isActive
                    ? 'border-white/[0.16] bg-white/[0.12] text-text-dark'
                    : 'border-transparent text-text-dark/50 hover:bg-white/[0.07] hover:text-text-dark/78'
                }`}
              >
                {isActive ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-text-dark" />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                <span>{t(`multiAngleEditor.presets.${key}`)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QualityPicker({ value, onChange }: QualityPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  const title = t('multiAngleEditor.qualityPicker.title');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-2 text-[11px] text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        <Sparkles className="h-3 w-3 text-text-dark/55" />
        <span className="font-medium">{title}</span>
        <span className="text-text-dark/35">·</span>
        <span className="text-text-dark/50">{value}</span>
        <ChevronDown className="h-2.5 w-2.5 text-text-dark/55" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={`absolute left-0 top-full z-50 mt-2 w-[206px] p-2 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-1 text-[11px] uppercase tracking-wide text-text-dark/50">{title}</div>
          <div className="flex gap-1.5">
            {MULTI_ANGLE_IMAGE_SIZES.map((size) => {
              const isActive = value === size;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => {
                    onChange(size);
                    setIsOpen(false);
                  }}
                  className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    isActive
                      ? 'border-white/[0.16] bg-white/[0.12] text-text-dark'
                      : 'border-transparent bg-transparent text-text-dark/50 hover:bg-white/[0.07] hover:text-text-dark/78'
                  }`}
                >
                  {isActive && <Check className="h-3 w-3" />}
                  {size}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface DegreeInputProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

// 可手动输入的角度框：用于「水平环绕 / 垂直俯仰」，让用户能精确到滑块拖不到的值。
function DegreeInput({ value, min, max, onChange }: DegreeInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? String(Math.round(value));

  const commit = useCallback(
    (raw: string) => {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isNaN(parsed)) {
        onChange(clamp(parsed, min, max));
      }
      setDraft(null);
    },
    [max, min, onChange]
  );

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        value={display}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d-]/g, ''))}
        onFocus={(event) => event.target.select()}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="w-7 rounded bg-transparent text-right text-xs tabular-nums text-text-dark/58 outline-none transition-colors hover:text-text-dark/78 focus:bg-white/[0.06] focus:text-text-dark"
      />
      <span className="text-xs text-text-dark/58">°</span>
    </>
  );
}

function SliderRow({ label, trailing, value, min, max, step = 1, onChange }: SliderRowProps) {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">{label}</span>
      <Slider
        className="flex-1"
        trackClassName="h-1 bg-white/24"
        rangeClassName="bg-[#5b8df6]"
        thumbClassName="h-3 w-3 border-0 bg-[#5b8df6] shadow-none focus-visible:ring-[#5b8df6]/45"
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => onChange(next)}
      />
      <div className="flex w-7 shrink-0 items-center justify-end gap-0.5 text-right text-[11px] text-text-dark/58">
        {trailing}
      </div>
    </div>
  );
}

export function MultiAngleEditorPanel({ imageSource, onClose, onSubmit }: MultiAngleEditorPanelProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [activePreset, setActivePreset] = useState<MultiAnglePresetKey>('custom');
  const [horizontalDeg, setHorizontalDeg] = useState<number>(DEFAULT_HORIZONTAL);
  const [verticalDeg, setVerticalDeg] = useState<number>(DEFAULT_VERTICAL);
  const [zoom, setZoom] = useState<MultiAngleZoomLevel>(DEFAULT_ZOOM);
  const [promptOverrideEnabled, setPromptOverrideEnabled] = useState(false);
  const [promptOverride, setPromptOverride] = useState('');
  const [imageSize, setImageSize] = useState<MultiAngleImageSize>(DEFAULT_MULTI_ANGLE_IMAGE_SIZE);
  const { models: imageModels } = useFreezoneImageModels();
  const selectedModel = imageModels[0];
  const creditCost = useGenerationCreditCost(
    'feature',
    selectedModel ? FREEZONE_IMAGE_FEATURES.multiView : null,
    {
      surface: 'canvas',
      params: {
        image_selection: selectedModel?.apiModel,
        size: imageSize,
        ...(imageModelSupportsQuality(selectedModel?.apiModel)
          ? { quality: 'medium' }
          : {}),
        operation: 'multi_view',
      },
    },
  );
  const billingRuleMissing =
    creditCost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay =
    creditCost.data?.data.display ??
    (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (panelRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [onClose]);

  const applyPreset = useCallback((key: MultiAnglePresetKey) => {
    setActivePreset(key);
    if (key === 'custom') return;
    const config = PRESET_CONFIGS[key];
    setHorizontalDeg(config.horizontalDeg);
    setVerticalDeg(config.verticalDeg);
    setZoom(config.zoom);
    if (config.defaultOverride) {
      setPromptOverrideEnabled(true);
      setPromptOverride(config.defaultOverride);
    } else {
      setPromptOverrideEnabled(false);
      setPromptOverride('');
    }
  }, []);

  const handleAngleChange = useCallback(
    (next: { horizontalDeg: number; verticalDeg: number }) => {
      setHorizontalDeg(next.horizontalDeg);
      setVerticalDeg(next.verticalDeg);
      setActivePreset('custom');
    },
    []
  );

  const handleHorizontalChange = useCallback((value: number) => {
    setHorizontalDeg(value);
    setActivePreset('custom');
  }, []);

  const handleVerticalChange = useCallback((value: number) => {
    setVerticalDeg(value);
    setActivePreset('custom');
  }, []);

  const handleZoomChange = useCallback((index: number) => {
    const next = ZOOM_LEVELS[clamp(index, 0, ZOOM_LEVELS.length - 1)];
    setZoom(next);
    setActivePreset('custom');
  }, []);

  const handleReset = useCallback(() => {
    setActivePreset('custom');
    setHorizontalDeg(DEFAULT_HORIZONTAL);
    setVerticalDeg(DEFAULT_VERTICAL);
    setZoom(DEFAULT_ZOOM);
    setPromptOverrideEnabled(false);
    setPromptOverride('');
  }, []);

  const presetLabel = useMemo(() => t(`multiAngleEditor.presets.${activePreset}`), [activePreset, t]);
  const horizontalDescription = useMemo(() => describeHorizontal(t, horizontalDeg), [horizontalDeg, t]);
  const verticalDescription = useMemo(() => describeVertical(t, verticalDeg), [verticalDeg, t]);
  const zoomLabel = useMemo(() => t(`multiAngleEditor.zoomLevels.${zoom}`), [t, zoom]);
  const zoomIndex = ZOOM_LEVELS.indexOf(zoom);

  const handleSubmit = useCallback(() => {
    const lines: string[] = [];
    lines.push(t('multiAngleEditor.promptIntro'));
    lines.push(
      t('multiAngleEditor.promptHorizontal', {
        deg: Math.round(horizontalDeg),
        description: horizontalDescription,
      })
    );
    lines.push(
      t('multiAngleEditor.promptVertical', {
        deg: Math.round(verticalDeg),
        description: verticalDescription,
      })
    );
    lines.push(
      t('multiAngleEditor.promptZoom', {
        zoom: zoomLabel,
      })
    );
    if (activePreset !== 'custom') {
      lines.push(
        t('multiAngleEditor.promptPreset', {
          preset: presetLabel,
        })
      );
    }
    if (promptOverrideEnabled && promptOverride.trim()) {
      lines.push(t('multiAngleEditor.promptExtra', { text: promptOverride.trim() }));
    }
    lines.push(t('multiAngleEditor.promptOutro'));
    const prompt = lines.join('\n');
    const displayName =
      activePreset === 'custom'
        ? `${t('nodeToolbar.multiDimension')} · ${horizontalDescription} ${verticalDescription}`
        : `${t('nodeToolbar.multiDimension')} · ${presetLabel}`;
    // No model picker in this panel — just use the first model returned by
    // the API (the shared store already falls back to SHARED_MODELS on
    // failure, so this is always defined unless the URL has no project).
    if (!selectedModel) return;
    onSubmit({
      prompt,
      displayName,
      preset: activePreset,
      horizontalDeg,
      verticalDeg,
      zoom,
      promptOverride: promptOverrideEnabled && promptOverride.trim() ? promptOverride.trim() : null,
      apiModel: selectedModel.apiModel,
      providerId: selectedModel.providerId as MultiAngleProviderId,
      imageSize,
    });
  }, [
    activePreset,
    horizontalDeg,
    horizontalDescription,
    imageSize,
    onSubmit,
    presetLabel,
    promptOverride,
    promptOverrideEnabled,
    t,
    verticalDeg,
    verticalDescription,
    zoom,
    zoomLabel,
    selectedModel,
  ]);

  return (
    <div
      ref={panelRef}
      className={`w-[600px] ${CANVAS_NODE_TOOLBAR_CARD_CLASS}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between pl-6 pr-4 pt-5">
        <h2 className="text-lg font-semibold text-text-dark">{t('multiAngleEditor.title')}</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-text-dark/55 transition-colors hover:text-text-dark/82"
            onClick={handleReset}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('multiAngleEditor.reset')}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-white/10 hover:text-text-dark"
            onClick={onClose}
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-6 px-6 pb-6 pt-4">
        <div className="flex h-[254px] w-[254px] shrink-0 flex-col items-center justify-center rounded-xl border border-white/10 bg-bg-dark/40 p-3">
          <MultiAngleSphere
            horizontalDeg={horizontalDeg}
            verticalDeg={verticalDeg}
            imageScale={zoomScale(zoom)}
            imageSource={imageSource}
            onAngleChange={handleAngleChange}
          />
        </div>

        <div className="flex min-h-[254px] flex-1 flex-col">
          <div className="mb-5 flex items-center gap-2.5">
            <PresetPicker value={activePreset} onChange={applyPreset} />
            <QualityPicker value={imageSize} onChange={setImageSize} />
          </div>

          <SliderRow
            label={t('multiAngleEditor.horizontal')}
            value={horizontalDeg}
            min={0}
            max={360}
            onChange={handleHorizontalChange}
            trailing={
              <DegreeInput value={horizontalDeg} min={0} max={360} onChange={handleHorizontalChange} />
            }
          />
          <SliderRow
            label={t('multiAngleEditor.vertical')}
            value={verticalDeg}
            min={-90}
            max={90}
            onChange={handleVerticalChange}
            trailing={
              <DegreeInput value={verticalDeg} min={-90} max={90} onChange={handleVerticalChange} />
            }
          />
          <SliderRow
            label={t('multiAngleEditor.zoom')}
            value={zoomIndex}
            min={0}
            max={ZOOM_LEVELS.length - 1}
            onChange={handleZoomChange}
            trailing={zoomLabel}
          />

          <div className="mt-3 flex items-center gap-2.5">
            <span className="w-14 shrink-0 text-right text-xs text-text-dark/86">{t('multiAngleEditor.promptToggle')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={promptOverrideEnabled}
              onClick={() => setPromptOverrideEnabled((prev) => !prev)}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-dark ${
                promptOverrideEnabled ? 'bg-[rgb(var(--accent-rgb))]' : 'bg-white/15'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform ${
                  promptOverrideEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
          {promptOverrideEnabled && (
            <UiTextArea
              className={EDITOR_PROMPT_TEXTAREA_CLASS}
              value={promptOverride}
              onChange={(event) => setPromptOverride(event.target.value)}
              placeholder={t('multiAngleEditor.promptPlaceholder')}
            />
          )}

          <div className="mt-auto flex items-center justify-end gap-5">
            <CreditCostPill
              display={costDisplay}
              className={NODE_CREDIT_PILL_FLAT_CLASS}
            />
            <button
              type="button"
              disabled={billingRuleMissing || !selectedModel}
              className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                billingRuleMissing || !selectedModel
                  ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                  : NODE_GENERATE_BUTTON_ENABLED_CLASS
              }`}
              onClick={handleSubmit}
              aria-label={t('multiAngleEditor.submit')}
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
