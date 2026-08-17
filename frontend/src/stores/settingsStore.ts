// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { quotaSafeStateStorage } from '@/lib/localStorageQuota';
// Side-effect import: registers the freezone canvas prune as a quota reclaimer
// so that when this small `settings-storage` blob fails to persist because the
// origin's localStorage is full of stale canvas keys, the write prunes them and
// retries instead of throwing (the original QuotaExceededError crash).
import '@/features/freezone/canvasDraftStorage';
import {
  DEFAULT_GRSAI_CREDIT_TIER_ID,
  PRICE_DISPLAY_CURRENCY_MODES,
  type GrsaiCreditTierId,
  type PriceDisplayCurrencyMode,
} from '@/features/canvas/pricing/types';

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';
export type ProviderApiKeys = Record<string, string>;
export const DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL = 'nano-banana-pro';

export type MediaStorageProvider = 'aliyun_oss' | 'cloudinary';

export type FeatureModelProvider = string;

export const FEATURE_MODEL_PROVIDERS: readonly FeatureModelProvider[] = [
  'openai',
  'midjourney',
  'azure',
  'ollama',
  'midjourneyplus',
  'openaimax',
  'ohmygpt',
  'custom',
  'ails',
  'aiproxy',
  'palm',
  'api2gpt',
  'aigc2d',
  'anthropic',
  'baidu',
  'zhipu',
  'ali',
  'xunfei',
  '360',
  'openrouter',
  'aiproxylibrary',
  'fastgpt',
  'tencent',
  'gemini',
  'moonshot',
  'zhipuv4',
  'perplexity',
  'lingyiwanwu',
  'aws',
  'cohere',
  'minimax',
  'sunoapi',
  'dify',
  'jina',
  'cloudflare',
  'siliconflow',
  'vertexai',
  'mistral',
  'deepseek',
  'mokaai',
  'volcengine',
  'baiduv2',
  'xinference',
  'xai',
  'coze',
  'kling',
  'jimeng',
  'vidu',
  'submodel',
  'doubaovideo',
  'sora',
  'replicate',
  'codex',
];


export const DEFAULT_FEATURE_MODEL_PROVIDER: FeatureModelProvider = 'ali';

export interface FeatureModelEntry {
  provider: FeatureModelProvider;
  /** 模型名；空表示走后端默认。 */
  model: string;
}

export interface FeatureProviderChannel {
  provider: FeatureModelProvider;
  /** 上游供应商 Key（写入 NewAPI 渠道时按 provider 取）。 */
  upstreamKey: string;
  /** 上游 Base URL 覆盖；空表示使用后端 provider preset。 */
  baseUrl: string;
  /** NewAPI channel priority. It only affects initial channel selection. */
  priority: number;
  /** Provider-specific NewAPI channel settings, e.g. ComfyUI workflows. */
  settings: Record<string, unknown>;
}

export interface MediaModelEntry {
  provider: FeatureModelProvider;
  /** NewAPI model_mapping 的 value；空表示使用固定模型名自身。 */
  upstreamModel: string;
  mediaType?: 'image' | 'video' | 'audio';
  label?: string;
  enabled?: boolean;
  sortOrder?: number;
  config?: Record<string, unknown>;
}

export interface EmbeddingModelEntry {
  provider: FeatureModelProvider;
  /** 固定内部模型名 DC-cognee-embedding 对应的上游 embedding 模型。 */
  upstreamModel: string;
  /** Cognee 本地向量库维度。 */
  dimension: number;
  /** Cognee embedding 单次请求文本条数；未设置表示使用环境变量或 Cognee 默认。 */
  batchSize?: number;
}

export interface FeatureModelSettings {
  /** featureId -> { provider, model }。缺省表示未配置文本功能模型映射。 */
  featureModels: Record<string, FeatureModelEntry>;
  /** media model name -> { provider, upstreamModel }。图片/视频固定模型只允许选择渠道和映射 value。 */
  mediaModels: Record<string, MediaModelEntry>;
  /** Cognee embedding 模型配置；undefined 表示沿用后端默认。 */
  embeddingModel?: EmbeddingModelEntry;
  /** provider -> 上游供应商 Key。旧版字段，保留用于迁移和兼容。 */
  providerKeys: Record<string, string>;
  /** provider -> 渠道级配置。 */
  providerChannels: Record<string, FeatureProviderChannel>;
}

export const DEFAULT_FEATURE_MODEL_SETTINGS: FeatureModelSettings = {
  featureModels: {},
  mediaModels: {},
  embeddingModel: undefined,
  providerKeys: {},
  providerChannels: {},
};

export interface CloudinaryStorageConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  apiFolder: string;
  materialsRoot: string;
}

export interface AliyunOssStorageConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  apiFolder: string;
  materialsRoot: string;
}

export interface MediaStorageSettings {
  provider: MediaStorageProvider;
  fullyManagedUpload: boolean;
  cloudinary: CloudinaryStorageConfig;
  aliyunOss: AliyunOssStorageConfig;
}

export const DEFAULT_MEDIA_STORAGE_SETTINGS: MediaStorageSettings = {
  provider: 'aliyun_oss',
  fullyManagedUpload: false,
  cloudinary: {
    cloudName: '',
    apiKey: '',
    apiSecret: '',
    apiFolder: '',
    materialsRoot: 'canvas-materials/',
  },
  aliyunOss: {
    accessKeyId: '',
    accessKeySecret: '',
    bucket: '',
    endpoint: '',
    apiFolder: '',
    materialsRoot: 'canvas-materials/',
  },
};

interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  showNodePrice: boolean;
  priceDisplayCurrencyMode: PriceDisplayCurrencyMode;
  usdToCnyRate: number;
  preferDiscountedPrice: boolean;
  grsaiCreditTierId: GrsaiCreditTierId;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  mediaStorage: MediaStorageSettings;
  featureModelConfig: FeatureModelSettings;
  updateFeatureModel: (featureId: string, patch: Partial<FeatureModelEntry>) => void;
  setMediaModels: (models: Record<string, MediaModelEntry>) => void;
  setEmbeddingModel: (model: EmbeddingModelEntry | undefined) => void;
  setProviderUpstreamKey: (provider: string, key: string) => void;
  addFeatureProviderChannel: (provider: FeatureModelProvider) => void;
  updateFeatureProviderChannel: (
    provider: FeatureModelProvider,
    patch: Partial<Omit<FeatureProviderChannel, 'provider'>>
  ) => void;
  clearFeatureProviderUpstreamKey: (provider: FeatureModelProvider) => void;
  removeFeatureProviderChannel: (provider: FeatureModelProvider) => void;
  setMediaStorageProvider: (provider: MediaStorageProvider) => void;
  setMediaStorageFullyManagedUpload: (enabled: boolean) => void;
  updateCloudinaryStorageConfig: (patch: Partial<CloudinaryStorageConfig>) => void;
  updateAliyunOssStorageConfig: (patch: Partial<AliyunOssStorageConfig>) => void;
  setProviderApiKey: (providerId: string, key: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setShowNodePrice: (enabled: boolean) => void;
  setPriceDisplayCurrencyMode: (mode: PriceDisplayCurrencyMode) => void;
  setUsdToCnyRate: (rate: number) => void;
  setPreferDiscountedPrice: (enabled: boolean) => void;
  setGrsaiCreditTierId: (tierId: GrsaiCreditTierId) => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
}

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return '#3B82F6';
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

function normalizeApiKey(input: string): string {
  return input.trim();
}

function normalizeFeatureModelProvider(
  input: FeatureModelProvider | string | null | undefined
): FeatureModelProvider {
  const normalized = String(input ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]*$/.test(normalized)
    ? normalized
    : DEFAULT_FEATURE_MODEL_PROVIDER;
}

function normalizeFeatureModelSettings(
  input: Partial<FeatureModelSettings> | null | undefined
): FeatureModelSettings {
  const featureModels: Record<string, FeatureModelEntry> = {};
  const raw = (input as { featureModels?: unknown } | null | undefined)?.featureModels;
  if (raw && typeof raw === 'object') {
    for (const [featureId, value] of Object.entries(raw as Record<string, unknown>)) {
      const fid = featureId.trim();
      if (!fid) continue;
      // 兼容旧结构：featureModels 旧版是 Record<string, string>（仅模型名）。
      if (typeof value === 'string') {
        const model = value.trim();
        if (model) featureModels[fid] = { provider: DEFAULT_FEATURE_MODEL_PROVIDER, model };
      } else if (value && typeof value === 'object') {
        const entry = value as Partial<FeatureModelEntry>;
        const provider = normalizeFeatureModelProvider(entry.provider);
        const model = typeof entry.model === 'string' ? entry.model.trim() : '';
        // 仅在偏离默认（provider≠ali 或有模型名）时保留，保持空状态干净。
        if (provider !== DEFAULT_FEATURE_MODEL_PROVIDER || model) {
          featureModels[fid] = { provider, model };
        }
      }
    }
  }

  const mediaModels: Record<string, MediaModelEntry> = {};
  const rawMediaModels = (input as { mediaModels?: unknown } | null | undefined)?.mediaModels;
  if (rawMediaModels && typeof rawMediaModels === 'object') {
    for (const [model, value] of Object.entries(rawMediaModels as Record<string, unknown>)) {
      const normalizedModel = model.trim();
      if (!normalizedModel || !value || typeof value !== 'object') continue;
      const entry = value as Partial<MediaModelEntry>;
      mediaModels[normalizedModel] = {
        provider: normalizeFeatureModelProvider(entry.provider),
        upstreamModel: typeof entry.upstreamModel === 'string' ? entry.upstreamModel.trim() : '',
        ...(entry.mediaType === 'image' || entry.mediaType === 'video' || entry.mediaType === 'audio'
          ? { mediaType: entry.mediaType }
          : {}),
        ...(typeof entry.label === 'string' && entry.label.trim()
          ? { label: entry.label.trim() }
          : {}),
        enabled: entry.enabled !== false,
        sortOrder: typeof entry.sortOrder === 'number' ? entry.sortOrder : 100,
        config: entry.config && typeof entry.config === 'object' ? entry.config : {},
      };
    }
  }

  const rawMediaModelProviders = (input as { mediaModelProviders?: unknown } | null | undefined)
    ?.mediaModelProviders;
  if (rawMediaModelProviders && typeof rawMediaModelProviders === 'object') {
    for (const [model, provider] of Object.entries(
      rawMediaModelProviders as Record<string, unknown>
    )) {
      const normalizedModel = model.trim();
      if (!normalizedModel || typeof provider !== 'string' || mediaModels[normalizedModel]) continue;
      mediaModels[normalizedModel] = {
        provider: normalizeFeatureModelProvider(provider),
        upstreamModel: '',
      };
    }
  }

  let embeddingModel: EmbeddingModelEntry | undefined;
  const rawEmbeddingModel = (input as { embeddingModel?: unknown } | null | undefined)
    ?.embeddingModel;
  if (rawEmbeddingModel && typeof rawEmbeddingModel === 'object') {
    const entry = rawEmbeddingModel as Partial<EmbeddingModelEntry>;
    const dimension = Number(entry.dimension);
    const batchSize = Number((entry as { batchSize?: unknown }).batchSize);
    const upstreamModel =
      typeof entry.upstreamModel === 'string' ? entry.upstreamModel.trim() : '';
    if (upstreamModel && Number.isFinite(dimension) && dimension > 0) {
      embeddingModel = {
        provider: normalizeFeatureModelProvider(entry.provider),
        upstreamModel,
        dimension: Math.max(1, Math.round(dimension)),
        ...(Number.isFinite(batchSize) && batchSize > 0
          ? { batchSize: Math.max(1, Math.round(batchSize)) }
          : {}),
      };
    }
  }

  const providerKeys: Record<string, string> = {};
  const rawKeys = (input as { providerKeys?: unknown } | null | undefined)?.providerKeys;
  if (rawKeys && typeof rawKeys === 'object') {
    for (const [provider, key] of Object.entries(rawKeys as Record<string, unknown>)) {
      const p = provider.trim();
      const k = typeof key === 'string' ? key.trim() : '';
      if (p && k) providerKeys[p] = k;
    }
  }

  const providerChannels: Record<string, FeatureProviderChannel> = {};
  const rawChannels = (input as { providerChannels?: unknown } | null | undefined)
    ?.providerChannels;
  if (rawChannels && typeof rawChannels === 'object') {
    for (const [provider, value] of Object.entries(rawChannels as Record<string, unknown>)) {
      const normalized = normalizeFeatureModelProvider(provider);
      if (!value || typeof value !== 'object') continue;
      const channel = value as Partial<FeatureProviderChannel>;
      providerChannels[normalized] = {
        provider: normalized,
        upstreamKey: typeof channel.upstreamKey === 'string' ? channel.upstreamKey.trim() : '',
        baseUrl: typeof channel.baseUrl === 'string' ? channel.baseUrl.trim() : '',
        priority: Number.isFinite(Number(channel.priority)) ? Math.round(Number(channel.priority)) : 0,
        settings:
          channel.settings && typeof channel.settings === 'object' && !Array.isArray(channel.settings)
            ? (channel.settings as Record<string, unknown>)
            : {},
      };
    }
  }

  // 兼容旧版本：已有 providerKeys 但没有渠道列表时，把 key 迁移成渠道级配置。
  for (const [provider, key] of Object.entries(providerKeys)) {
    const normalized = normalizeFeatureModelProvider(provider);
    if (!providerChannels[normalized] && key) {
      providerChannels[normalized] = {
        provider: normalized,
        upstreamKey: key,
        baseUrl: '',
        priority: 0,
        settings: {},
      };
    }
  }

  return { featureModels, mediaModels, embeddingModel, providerKeys, providerChannels };
}

function prepareFeatureModelSettingsForPersistence(
  input: Partial<FeatureModelSettings> | null | undefined
): FeatureModelSettings {
  const normalized = normalizeFeatureModelSettings(input);
  return {
    ...normalized,
    providerKeys: {},
    providerChannels: {},
  };
}

function normalizePriceDisplayCurrencyMode(
  input: PriceDisplayCurrencyMode | string | null | undefined
): PriceDisplayCurrencyMode {
  return PRICE_DISPLAY_CURRENCY_MODES.includes(input as PriceDisplayCurrencyMode)
    ? (input as PriceDisplayCurrencyMode)
    : 'auto';
}

function normalizeUsdToCnyRate(input: number | string | null | undefined): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7.2;
  }

  return Math.min(100, Math.max(0.01, Math.round(numeric * 100) / 100));
}

function normalizeGrsaiCreditTierId(
  input: GrsaiCreditTierId | string | null | undefined
): GrsaiCreditTierId {
  switch (input) {
    case 'tier-10':
    case 'tier-20':
    case 'tier-49':
    case 'tier-99':
    case 'tier-499':
    case 'tier-999':
      return input;
    default:
      return DEFAULT_GRSAI_CREDIT_TIER_ID;
  }
}

function normalizeGrsaiNanoBananaProModel(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL || trimmed.startsWith('nano-banana-pro-')) {
    return trimmed;
  }
  return DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL;
}

function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

function normalizeApiKeys(input: ProviderApiKeys | null | undefined): ProviderApiKeys {
  if (!input) {
    return {};
  }

  return Object.entries(input).reduce<ProviderApiKeys>((acc, [providerId, key]) => {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return acc;
    }

    acc[normalizedProviderId] = normalizeApiKey(key);
    return acc;
  }, {});
}

export function hasConfiguredApiKey(apiKeys: ProviderApiKeys): boolean {
  return getConfiguredApiKeyCount(apiKeys) > 0;
}

export function getConfiguredApiKeyCount(
  apiKeys: ProviderApiKeys,
  providerIds?: readonly string[]
): number {
  const keysToCount = providerIds
    ? providerIds.map((providerId) => apiKeys[providerId] ?? '')
    : Object.values(apiKeys);

  return keysToCount.reduce((count, key) => {
    return normalizeApiKey(key).length > 0 ? count + 1 : count;
  }, 0);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isHydrated: false,
      apiKeys: {},
      grsaiNanoBananaProModel: DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
      hideProviderGuidePopover: false,
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      showNodePrice: true,
      priceDisplayCurrencyMode: 'auto',
      usdToCnyRate: 7.2,
      preferDiscountedPrice: false,
      grsaiCreditTierId: DEFAULT_GRSAI_CREDIT_TIER_ID,
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: '#3B82F6',
      canvasEdgeRoutingMode: 'spline',
      autoCheckAppUpdateOnLaunch: true,
      enableUpdateDialog: true,
      mediaStorage: DEFAULT_MEDIA_STORAGE_SETTINGS,
      featureModelConfig: DEFAULT_FEATURE_MODEL_SETTINGS,
      updateFeatureModel: (featureId, patch) =>
        set((state) => {
          const nextFeatureModels = { ...state.featureModelConfig.featureModels };
          const prev = nextFeatureModels[featureId] ?? {
            provider: DEFAULT_FEATURE_MODEL_PROVIDER,
            model: '',
          };
          const provider = normalizeFeatureModelProvider(patch.provider ?? prev.provider);
          const model = (patch.model ?? prev.model).trim();
          // 回到默认（ali + 空模型）时删除该条，保持空状态干净。
          if (provider === DEFAULT_FEATURE_MODEL_PROVIDER && !model) {
            delete nextFeatureModels[featureId];
          } else {
            nextFeatureModels[featureId] = { provider, model };
          }
          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              featureModels: nextFeatureModels,
            },
          };
        }),
      setMediaModels: (models) =>
        set((state) => ({
          featureModelConfig: {
            ...state.featureModelConfig,
            mediaModels: Object.fromEntries(
              Object.entries(models)
                .map(([model, entry]) => [
                  model.trim(),
                  {
                    provider: normalizeFeatureModelProvider(entry.provider),
                    upstreamModel: entry.upstreamModel.trim(),
                    ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
                    ...(entry.label?.trim() ? { label: entry.label.trim() } : {}),
                    enabled: entry.enabled !== false,
                    sortOrder: entry.sortOrder ?? 100,
                    config: entry.config ?? {},
                  },
                ] as const)
                .filter(([model]) => Boolean(model))
            ),
          },
        })),
      setEmbeddingModel: (model) =>
        set((state) => ({
          featureModelConfig: {
            ...state.featureModelConfig,
            embeddingModel: model
              ? {
                  provider: normalizeFeatureModelProvider(model.provider),
                  upstreamModel:
                    typeof model.upstreamModel === 'string'
                      ? model.upstreamModel.trim()
                      : '',
                  dimension: Math.max(1, Math.round(Number(model.dimension) || 0)),
                  ...(model.batchSize != null
                    ? {
                        batchSize: Math.max(
                          1,
                          Math.round(Number(model.batchSize) || 0),
                        ),
                      }
                    : {}),
                }
              : undefined,
          },
        })),
      setProviderUpstreamKey: (provider, key) =>
        set((state) => {
          const normalized = normalizeFeatureModelProvider(provider);
          const nextKeys = { ...state.featureModelConfig.providerKeys };
          const nextChannels = { ...state.featureModelConfig.providerChannels };
          const trimmed = key.trim();
          if (trimmed) {
            nextKeys[normalized] = trimmed;
          } else {
            delete nextKeys[normalized];
          }
          if (nextChannels[normalized]) {
            nextChannels[normalized] = { ...nextChannels[normalized], upstreamKey: trimmed };
          }
          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              providerKeys: nextKeys,
              providerChannels: nextChannels,
            },
          };
        }),
      addFeatureProviderChannel: (provider) =>
        set((state) => {
          const normalized = normalizeFeatureModelProvider(provider);
          if (state.featureModelConfig.providerChannels[normalized]) {
            return state;
          }
          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              providerChannels: {
                ...state.featureModelConfig.providerChannels,
                [normalized]: {
                  provider: normalized,
                  upstreamKey: state.featureModelConfig.providerKeys[normalized] ?? '',
                  baseUrl: '',
                  priority: 0,
                  settings: {},
                },
              },
            },
          };
        }),
      updateFeatureProviderChannel: (provider, patch) =>
        set((state) => {
          const normalized = normalizeFeatureModelProvider(provider);
          const prev = state.featureModelConfig.providerChannels[normalized] ?? {
            provider: normalized,
            upstreamKey: '',
            baseUrl: '',
            priority: 0,
            settings: {},
          };
          const upstreamKey = (patch.upstreamKey ?? prev.upstreamKey).trim();
          const baseUrl = (patch.baseUrl ?? prev.baseUrl).trim();
          const priority = Math.round(Number(patch.priority ?? prev.priority) || 0);
          const settings = patch.settings ?? prev.settings;
          const nextKeys = { ...state.featureModelConfig.providerKeys };
          if (upstreamKey) {
            nextKeys[normalized] = upstreamKey;
          } else {
            delete nextKeys[normalized];
          }
          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              providerKeys: nextKeys,
              providerChannels: {
                ...state.featureModelConfig.providerChannels,
                [normalized]: { provider: normalized, upstreamKey, baseUrl, priority, settings },
              },
            },
          };
        }),
      clearFeatureProviderUpstreamKey: (provider) =>
        set((state) => {
          const normalized = normalizeFeatureModelProvider(provider);
          const nextKeys = { ...state.featureModelConfig.providerKeys };
          delete nextKeys[normalized];
          const nextChannels = { ...state.featureModelConfig.providerChannels };
          if (nextChannels[normalized]) {
            nextChannels[normalized] = { ...nextChannels[normalized], upstreamKey: '' };
          }
          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              providerKeys: nextKeys,
              providerChannels: nextChannels,
            },
          };
        }),
      removeFeatureProviderChannel: (provider) =>
        set((state) => {
          const normalized = normalizeFeatureModelProvider(provider);
          const nextChannels = { ...state.featureModelConfig.providerChannels };
          delete nextChannels[normalized];

          const nextKeys = { ...state.featureModelConfig.providerKeys };
          delete nextKeys[normalized];

          const nextFeatureModels = { ...state.featureModelConfig.featureModels };
          for (const [featureId, entry] of Object.entries(nextFeatureModels)) {
            if (entry.provider === normalized) {
              delete nextFeatureModels[featureId];
            }
          }

          const nextMediaModels = { ...(state.featureModelConfig.mediaModels ?? {}) };
          for (const [model, entry] of Object.entries(nextMediaModels)) {
            if (entry.provider === normalized) {
              delete nextMediaModels[model];
            }
          }

          const nextEmbeddingModel =
            state.featureModelConfig.embeddingModel?.provider === normalized
              ? undefined
              : state.featureModelConfig.embeddingModel;

          return {
            featureModelConfig: {
              ...state.featureModelConfig,
              featureModels: nextFeatureModels,
              mediaModels: nextMediaModels,
              embeddingModel: nextEmbeddingModel,
              providerKeys: nextKeys,
              providerChannels: nextChannels,
            },
          };
        }),
      setMediaStorageProvider: (provider) =>
        set((state) => ({
          mediaStorage: { ...state.mediaStorage, provider },
        })),
      setMediaStorageFullyManagedUpload: (enabled) =>
        set((state) => ({
          mediaStorage: { ...state.mediaStorage, fullyManagedUpload: enabled },
        })),
      updateCloudinaryStorageConfig: (patch) =>
        set((state) => ({
          mediaStorage: {
            ...state.mediaStorage,
            cloudinary: { ...state.mediaStorage.cloudinary, ...patch },
          },
        })),
      updateAliyunOssStorageConfig: (patch) =>
        set((state) => ({
          mediaStorage: {
            ...state.mediaStorage,
            aliyunOss: { ...state.mediaStorage.aliyunOss, ...patch },
          },
        })),
      setProviderApiKey: (providerId, key) =>
        set((state) => ({
          apiKeys: {
            ...state.apiKeys,
            [providerId]: normalizeApiKey(key),
          },
        })),
      setGrsaiNanoBananaProModel: (model) =>
        set({
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(model),
        }),
      setHideProviderGuidePopover: (hide) => set({ hideProviderGuidePopover: hide }),
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setShowNodePrice: (enabled) => set({ showNodePrice: enabled }),
      setPriceDisplayCurrencyMode: (priceDisplayCurrencyMode) =>
        set({
          priceDisplayCurrencyMode:
            normalizePriceDisplayCurrencyMode(priceDisplayCurrencyMode),
        }),
      setUsdToCnyRate: (usdToCnyRate) =>
        set({ usdToCnyRate: normalizeUsdToCnyRate(usdToCnyRate) }),
      setPreferDiscountedPrice: (enabled) => set({ preferDiscountedPrice: enabled }),
      setGrsaiCreditTierId: (grsaiCreditTierId) =>
        set({ grsaiCreditTierId: normalizeGrsaiCreditTierId(grsaiCreditTierId) }),
      setUiRadiusPreset: (uiRadiusPreset) => set({ uiRadiusPreset }),
      setThemeTonePreset: (themeTonePreset) => set({ themeTonePreset }),
      setAccentColor: (color) => set({ accentColor: normalizeHexColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setAutoCheckAppUpdateOnLaunch: (enabled) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
    }),
    {
      name: 'settings-storage',
      version: 18,
      // Quota-safe persistence: on a QuotaExceededError, prune stale freezone
      // canvas keys (via the registered reclaimer) and retry once instead of
      // letting the whole store fail to hydrate/persist.
      storage: createJSONStorage(() => quotaSafeStateStorage),
      // Model-gateway drafts may contain secrets and very large ComfyUI
      // workflows. The backend settings database is their source of truth;
      // keeping them in the global startup store can exhaust localStorage or
      // make hydration block the whole application after a refresh.
      partialize: (state) => ({
        ...state,
        featureModelConfig: prepareFeatureModelSettingsForPersistence(
          state.featureModelConfig
        ),
      }),
      onRehydrateStorage: () => {
        return (_state, error) => {
          if (error) {
            console.error('failed to hydrate settings storage', error);
          }
          // Defer past create() — when persist hydrates synchronously the
          // `useSettingsStore` binding is still in TDZ at this point.
          queueMicrotask(() => {
            useSettingsStore.setState({ isHydrated: true });
          });
        };
      },
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as {
          apiKey?: string;
          apiKeys?: ProviderApiKeys;
          ignoreAtTagWhenCopyingAndGenerating?: boolean;
          grsaiNanoBananaProModel?: string;
          hideProviderGuidePopover?: boolean;
          canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
          autoCheckAppUpdateOnLaunch?: boolean;
          enableUpdateDialog?: boolean;
          enableStoryboardGenGridPreviewShortcut?: boolean;
          showStoryboardGenAdvancedRatioControls?: boolean;
          storyboardGenAutoInferEmptyFrame?: boolean;
          showNodePrice?: boolean;
          priceDisplayCurrencyMode?: PriceDisplayCurrencyMode | string;
          usdToCnyRate?: number | string;
          preferDiscountedPrice?: boolean;
          grsaiCreditTierId?: GrsaiCreditTierId | string;
          featureModelConfig?: Partial<FeatureModelSettings>;
        };

        const migratedApiKeys = normalizeApiKeys(state.apiKeys);
        const ignoreAtTagWhenCopyingAndGenerating =
          state.ignoreAtTagWhenCopyingAndGenerating ?? true;
        if (Object.keys(migratedApiKeys).length > 0) {
          return {
            ...(persistedState as object),
            isHydrated: true,
            apiKeys: migratedApiKeys,
            ignoreAtTagWhenCopyingAndGenerating,
            grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
              state.grsaiNanoBananaProModel
            ),
            hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
            canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
            autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
            enableUpdateDialog: state.enableUpdateDialog ?? true,
            enableStoryboardGenGridPreviewShortcut:
              state.enableStoryboardGenGridPreviewShortcut ?? false,
            showStoryboardGenAdvancedRatioControls:
              state.showStoryboardGenAdvancedRatioControls ?? false,
            storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
            showNodePrice: state.showNodePrice ?? true,
            priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
              state.priceDisplayCurrencyMode
            ),
            usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
            preferDiscountedPrice: state.preferDiscountedPrice ?? false,
            grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
            featureModelConfig: prepareFeatureModelSettingsForPersistence(
              state.featureModelConfig
            ),
          };
        }

        return {
          ...(persistedState as object),
          isHydrated: true,
          apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
          ignoreAtTagWhenCopyingAndGenerating,
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
            state.grsaiNanoBananaProModel
          ),
          hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
          canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
          autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
          enableUpdateDialog: state.enableUpdateDialog ?? true,
          enableStoryboardGenGridPreviewShortcut:
            state.enableStoryboardGenGridPreviewShortcut ?? false,
          showStoryboardGenAdvancedRatioControls:
            state.showStoryboardGenAdvancedRatioControls ?? false,
          storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
          showNodePrice: state.showNodePrice ?? true,
          priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
            state.priceDisplayCurrencyMode
          ),
          usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
          preferDiscountedPrice: state.preferDiscountedPrice ?? false,
          grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
          featureModelConfig: prepareFeatureModelSettingsForPersistence(
            state.featureModelConfig
          ),
        };
      },
    }
  )
);
