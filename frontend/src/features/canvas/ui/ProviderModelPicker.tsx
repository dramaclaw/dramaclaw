// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MediaModelRequestSchema } from '@/api/ops';

import {
  FALLBACK_IMAGE_ASPECT_OPTIONS,
  FALLBACK_IMAGE_SIZE_OPTIONS,
  FALLBACK_VIDEO_ASPECT_OPTIONS,
} from '@/features/canvas/domain/mediaModelOptions';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { useFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import {
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

const MODEL_PICKER_POPOVER_WIDTH = 260;
const MODEL_PICKER_POPOVER_CLASS =
  `nodrag nowheel fixed z-[10000] max-h-[280px] w-[260px] overflow-y-auto p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const MODEL_PICKER_OPTION_BASE_CLASS =
  'inline-flex h-8 w-full items-center gap-2 rounded-[6px] px-3 text-left text-xs font-medium transition-colors';

export type ProviderId =
  | 'newapi'
  | 'huimeng'
  | 'openrouter'
  | 'openai'
  | 'seedance'
  | 'minimax'
  | 'eleven'
  | 'mureka';

export interface ProviderOption {
  id: ProviderId;
  label: string;
}

export interface ModelOption {
  catalogId?: string;
  id: string;
  providerId: ProviderId;
  apiModel: string;
  label: string;
  resolutionOptions?: string[];
  qualityOptions?: string[];
  humanReview?: boolean;
  supportsGenerateAudio?: boolean;
  minDuration?: number | null;
  maxDuration?: number | null;
  sceneOptimizeOptions?: Array<'anime' | 'realistic'>;
  defaultSceneOptimize?: 'anime' | 'realistic' | null;
  ratioOptions?: string[];
  supportedModes?: string[];
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
  referenceFileMax?: number | null;
  referenceLinkMax?: number | null;
  referenceFileTypes?: string[];
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  /** 参考音频总时长上限（秒，可为小数）；没配时前端按 15.2s 兜底。 */
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
  request?: MediaModelRequestSchema;
}

// 服务商品牌名，不跟界面语言走。
// i18n-exempt-start
export const SHARED_PROVIDERS: ProviderOption[] = [
  { id: 'newapi', label: 'DramaClawAPI' },
  { id: 'huimeng', label: '绘梦 / HuiMeng' },
// i18n-exempt-end
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
];

// 兜底模型列表。仅在 /freezone/image/models 拉取失败时顶上 —— 正常路径下模型
// 及其能力全部来自后台「媒体模型」配置。这里的能力字段跟着一起给，是为了让
// 兜底状态下的尺寸 / 比例选择器仍有可用档位，而不是散落回各个面板里去硬编码。
export const SHARED_MODELS: ModelOption[] = [
  {
    id: 'newapi_gpt_image2',
    providerId: 'newapi',
    apiModel: 'newapi_gpt_image2',
    label: 'LingShan-G2',
  },
  {
    id: 'newapi_nanobanana2',
    providerId: 'newapi',
    apiModel: 'newapi_nanobanana2',
    label: 'LingShan-NB-2',
  },
  {
    id: 'huimeng/gpt-image-2',
    providerId: 'huimeng',
    apiModel: 'huimeng_gpt_image2',
    label: 'LingShan-G2',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
  },
  {
    id: 'openrouter/gemini-2.5-flash-image',
    providerId: 'openrouter',
    apiModel: 'google/gemini-2.5-flash-image-preview',
    label: 'Gemini 2.5 Flash Image',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
  },
  {
    id: 'openai/gpt-image-2',
    providerId: 'openai',
    apiModel: 'gpt-image-2',
    label: 'GPT Image 2',
    resolutionOptions: [...FALLBACK_IMAGE_SIZE_OPTIONS],
    ratioOptions: [...FALLBACK_IMAGE_ASPECT_OPTIONS],
    qualityOptions: ['low', 'medium', 'high'],
  },
];

export const DEFAULT_SHARED_MODEL_ID = 'newapi_gpt_image2';
export const DEFAULT_UPSCALE_MODEL_ID = 'newapi_gpt_image2';

// Video generation models. `id` is the raw backend model id sent to
// /freezone/video/gen so we don't need a separate apiModel mapping.
export const VIDEO_PROVIDERS: ProviderOption[] = [
  { id: 'seedance', label: 'Seedance' },
  { id: 'huimeng', label: '绘梦 / HuiMeng' }, // i18n-exempt —— 服务商品牌名
];

// 兜底视频模型列表。同 SHARED_MODELS：仅在 /freezone/video/models 拉取失败时
// 顶上，能力字段随行以保证兜底状态下参数面板仍有档位可选。
export const VIDEO_MODELS: ModelOption[] = [
  {
    id: 'newapi_seedance-2.0-fast',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-fast',
    label: 'Seedance2.0 Fast',
    resolutionOptions: ['480p', '720p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
  },
  {
    id: 'newapi_seedance-2.0',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0',
    label: 'Seedance2.0',
    resolutionOptions: ['480p', '720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
  },
  {
    id: 'newapi_seedance-2.0-value',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-value',
    label: 'Seedance2.0 Value',
    resolutionOptions: ['720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
    sceneOptimizeOptions: ['anime', 'realistic'],
    defaultSceneOptimize: 'anime',
  },
  {
    id: 'newapi_seedance-2.0-fast-value',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-2.0-fast-value',
    label: 'Seedance2.0 Fast Value',
    resolutionOptions: ['720p', '1080p'],
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 15,
    sceneOptimizeOptions: ['anime', 'realistic'],
    defaultSceneOptimize: 'realistic',
  },
  {
    id: 'newapi_seedance-1.5-pro',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-1.5-pro',
    label: 'Seedance1.5 Pro',
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 4,
    maxDuration: 12,
  },
  {
    id: 'newapi_seedance-1.0-pro-fast',
    providerId: 'seedance',
    apiModel: 'newapi_seedance-1.0-pro-fast',
    label: 'Seedance1.0 Pro Fast',
    ratioOptions: [...FALLBACK_VIDEO_ASPECT_OPTIONS],
    minDuration: 2,
    maxDuration: 12,
  },
];

// Matches the backend `FreezoneVideoGenRequest.model` default. The picker
// hydrates the live list via /freezone/video/models, but this id is what the
// canvas store uses on first node creation before that fetch resolves (and
// when no previously-picked model has been remembered).
export const DEFAULT_VIDEO_MODEL_ID = 'newapi_seedance-2.0';

export type ProviderModelDomain = 'image' | 'video';

interface ProviderModelPickerProps {
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
   * clickable, with the reason shown as a hover tooltip. Used by the video node
   * to block Seedance 1.0 models while reference media is attached.
   */
  getOptionDisabledReason?: (model: ModelOption) => string | null;
}

export function ProviderModelPicker({
  selectedModelId,
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
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // 禁用项的 hover 提示。自渲染成一个 z 高于弹窗(z-[10001] > z-[10000])的浮层,
  // 锚定到当前项的右下角并 portal 到 body,避免被弹窗遮挡 / 被列表 overflow 裁剪。
  const [disabledTooltip, setDisabledTooltip] = useState<{
    reason: string;
    left: number;
    top: number;
  } | null>(null);
  const selectedModel = effectiveModels.find((m) => m.id === selectedModelId) ?? effectiveModels[0];

  const syncPopoverPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(
      Math.max(margin, rect.left),
      window.innerWidth - MODEL_PICKER_POPOVER_WIDTH - margin,
    );
    const top = popoverPlacement === 'top'
      ? rect.top - 8
      : rect.bottom + 8;
    setPopoverPosition({ left, top });
  };

  useEffect(() => {
    if (!isOpen) return;
    syncPopoverPosition();
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onViewportChange = () => syncPopoverPosition();
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, popoverPlacement]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <Box className={NODE_TEXT_CONTROL_ICON_CLASS} />
        <span className="font-medium">
          {selectedModel?.label
            ?? (catalogIsEmpty ? t('modelParams.noModelsAvailable') : selectedModelId)}
        </span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className={MODEL_PICKER_POPOVER_CLASS}
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
            transform: popoverPlacement === 'top' ? 'translateY(-100%)' : undefined,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex flex-col gap-0.5">
            {effectiveModels.map((model) => {
              const isActive = selectedModel?.id === model.id;
              const disabledReason = getOptionDisabledReason?.(model) ?? null;
              const isDisabled = disabledReason != null && !isActive;
              const optionInner = (
                <>
                  {isActive ? (
                    <Check className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <span className="inline-block h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate">{model.label}</span>
                </>
              );
              const optionClass = `${MODEL_PICKER_OPTION_BASE_CLASS} ${
                isActive
                  ? 'bg-white/[0.13] text-text-dark ring-1 ring-white/24'
                  : isDisabled
                    ? 'cursor-not-allowed text-text-muted/40'
                    : 'text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark'
              }`;
              if (isDisabled) {
                return (
                  <button
                    key={model.id}
                    type="button"
                    aria-disabled
                    onClick={(event) => event.stopPropagation()}
                    onMouseEnter={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setDisabledTooltip({
                        reason: disabledReason,
                        // 锚定到当前项的右下角:水平从图标右侧起,垂直略压住项底边。
                        left: rect.left + 36,
                        top: rect.bottom - 6,
                      });
                    }}
                    onMouseLeave={() => setDisabledTooltip(null)}
                    className={optionClass}
                  >
                    {optionInner}
                  </button>
                );
              }
              return (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    onChange(model.id);
                    setIsOpen(false);
                  }}
                  className={optionClass}
                >
                  {optionInner}
                </button>
              );
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
      {isOpen && disabledTooltip && createPortal(
        <div
          className="pointer-events-none fixed z-[10001] max-w-[240px] rounded-lg bg-neutral-800/95 px-3 py-2 text-xs leading-5 text-white shadow-lg"
          style={{ left: disabledTooltip.left, top: disabledTooltip.top }}
        >
          {disabledTooltip.reason}
        </div>,
        document.body,
      )}
    </div>
  );
}
