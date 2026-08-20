// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
} from './types';

const providerModules = import.meta.glob<{ provider: ModelProviderDefinition }>(
  './providers/*.ts',
  { eager: true }
);

const SUPERTALE_PROVIDER_IDS = new Set(['huimeng', 'openai', 'openrouter', 'orcarouter']);

const providers: ModelProviderDefinition[] = Object.values(providerModules)
  .map((module) => module.provider)
  .filter((provider): provider is ModelProviderDefinition => Boolean(provider))
  .filter((provider) => SUPERTALE_PROVIDER_IDS.has(provider.id))
  .sort((a, b) => a.id.localeCompare(b.id));

const providerMap = new Map<string, ModelProviderDefinition>(
  providers.map((provider) => [provider.id, provider])
);

// 图片模型清单本身来自后台「媒体模型」配置（`/freezone/image/models`），前端不再
// 维护静态注册表；见 `domain/catalogImageModels.ts`。这里只留下两类东西：
//   1. 供应商的展示名 —— 目录只下发 providerId，没有展示名；
//   2. 历史 model id 的别名 —— 老画布节点上存着已经不存在的 id。
export const DEFAULT_IMAGE_MODEL_ID = 'openrouter/default';

const imageModelAliasMap = new Map<string, string>([
  ['gemini-3.1-flash', DEFAULT_IMAGE_MODEL_ID],
  ['gemini-3.1-flash-edit', DEFAULT_IMAGE_MODEL_ID],
  ['ppio/gemini-3.1-flash', DEFAULT_IMAGE_MODEL_ID],
  ['google/gemini-3-pro-image', DEFAULT_IMAGE_MODEL_ID],
  ['volcengine/seedream-4', 'huimeng/default'],
  ['fal/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['fal/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
  ['kie/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['kie/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
  ['grsai/nano-banana-2', DEFAULT_IMAGE_MODEL_ID],
  ['grsai/nano-banana-pro', DEFAULT_IMAGE_MODEL_ID],
]);

/** 把历史节点上存的 model id 归一到当前 id；未知 id 原样返回。 */
export function normalizeImageModelId(modelId: string): string {
  return imageModelAliasMap.get(modelId) ?? modelId;
}

export function listModelProviders(): ModelProviderDefinition[] {
  return providers;
}

export function resolveImageModelResolutions(
  model: ImageModelDefinition,
  context: ImageModelRuntimeContext = {}
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {}
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution
      ? resolutionOptions.find(
          (item) => item.value.toLowerCase() === requestedResolution.toLowerCase(),
        )
      : undefined) ??
    resolutionOptions.find(
      (item) => item.value.toLowerCase() === model.defaultResolution.toLowerCase(),
    ) ??
    resolutionOptions[0] ??
    model.resolutions[0]
  );
}

export function getModelProvider(providerId: string): ModelProviderDefinition {
  return (
    providerMap.get(providerId) ?? {
      id: providerId || 'unknown',
      // 后台新配了一个前端还不认识的供应商时，直接把 id 当展示名，
      // 而不是显示 "Unknown Provider"。
      name: providerId || 'Unknown Provider',
      label: providerId || 'Unknown',
    }
  );
}
