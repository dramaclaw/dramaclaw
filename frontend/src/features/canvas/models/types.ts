// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MediaModelParameterDefinition } from '@/api/ops';
import type { ModelPricingDefinition } from '@/features/canvas/pricing/types';

export type MediaModelType = 'image' | 'video' | 'audio';

export interface ModelProviderDefinition {
  id: string;
  name: string;
  label: string;
}

export interface AspectRatioOption {
  value: string;
  label: string;
}

export interface ResolutionOption {
  value: string;
  label: string;
}

export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
}

export type ExtraParamType = 'boolean' | 'enum' | 'number' | 'string';

export interface ExtraParamDefinition {
  key: string;
  label: string;
  labelKey?: string;
  type: ExtraParamType;
  description?: string;
  descriptionKey?: string;
  defaultValue?: boolean | number | string;
  options?: Array<{ value: string; label: string; labelKey?: string }>;
  min?: number;
  max?: number;
  step?: number;
}

export interface ImageModelDefinition {
  id: string;
  mediaType: 'image';
  displayName: string;
  providerId: string;
  description: string;
  eta: string;
  expectedDurationMs?: number;
  defaultAspectRatio: string;
  defaultResolution: string;
  aspectRatios: AspectRatioOption[];
  resolutions: ResolutionOption[];
  resolveResolutions?: (context: ImageModelRuntimeContext) => ResolutionOption[];
  extraParamsSchema?: ExtraParamDefinition[];
  defaultExtraParams?: Record<string, unknown>;
  /**
   * 后台「媒体模型」下发的 `request.parameters` 原样带过来，交给
   * `MediaModelParameterChip` 渲染、以 `model_params` 提交。
   *
   * 刻意不塞进上面的 `extraParamsSchema`：那是前端静态注册表的老结构，只认
   * enum/boolean/number/string，没有 multiselect、没有 modes 过滤，选项值也一律
   * 被 `String()` 拍成字符串。目录里的 multiselect 参数按它渲染会退化成单选、
   * 数字/布尔选项会变成字符串，后端 `media_model_request_schema` 的类型校验直接
   * 打回来。两套 schema 各管各的，不互相翻译。
   */
  requestParameters?: MediaModelParameterDefinition[];
  pricing?: ModelPricingDefinition;
  resolveRequest: (context: { referenceImageCount: number }) => {
    requestModel: string;
    modeLabel: string;
  };
}
