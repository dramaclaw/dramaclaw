// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 把后台「媒体模型」下发的图片模型目录，适配成画布旧节点（分镜 / 图片编辑）
 * 与 `ModelParamsControls` 使用的 `ImageModelDefinition` 形状。
 *
 * 这两个节点原本读的是 `features/canvas/models` 里的静态注册表，模型清单、
 * 分辨率、画面比例、额外参数全写死在前端。现在这些都改由目录下发：
 * - 清单 → `useFreezoneImageModels()`（失败时回退到 ProviderModelPicker 的兜底列表）
 * - 分辨率 / 比例 → 条目的 resolutionOptions / ratioOptions（见 mediaModelOptions）
 * - 额外参数 → 条目 request.parameters 的控件声明
 */

import { useMemo } from 'react';

import type { MediaModelParameterDefinition, MediaModelRequestSchema } from '@/api/ops';
import type {
  ExtraParamDefinition,
  ExtraParamType,
  ImageModelDefinition,
} from '@/features/canvas/models';
import { normalizeImageModelId } from '@/features/canvas/models';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { SHARED_MODELS } from '@/features/canvas/ui/ProviderModelPicker';
import {
  resolveModelAspectOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';

/**
 * 适配所需的目录条目字段。
 *
 * 用结构类型而不是直接引 `FreezoneImageModelInfo`，是因为兜底列表 `ModelOption`
 * 的 providerId 比目录的 `FreezoneProvider` 更宽（含视频供应商），两者都要能进来。
 */
export interface CatalogImageModelEntry {
  id: string;
  providerId: string;
  apiModel: string;
  label: string;
  resolutionOptions?: string[] | null;
  ratioOptions?: string[] | null;
  qualityOptions?: string[] | null;
  request?: MediaModelRequestSchema;
}

/** 目录没给分辨率时，节点默认想要的档位（仍需落在实际可选档位里）。 */
const PREFERRED_DEFAULT_RESOLUTION = '2K';

const CONTROL_TO_PARAM_TYPE: Record<
  MediaModelParameterDefinition['control'],
  ExtraParamType
> = {
  select: 'enum',
  multiselect: 'enum',
  number: 'number',
  switch: 'boolean',
  text: 'string',
};

function toExtraParam(
  parameter: MediaModelParameterDefinition,
): ExtraParamDefinition {
  const type = CONTROL_TO_PARAM_TYPE[parameter.control] ?? 'string';
  const options = parameter.options?.map((value) => ({
    value: String(value),
    label: String(value),
  }));
  return {
    key: parameter.key,
    label: parameter.label || parameter.key,
    type,
    ...(options && options.length > 0 ? { options } : {}),
    ...(parameter.default === undefined || parameter.default === null
      ? {}
      : { defaultValue: parameter.default as boolean | number | string }),
    ...(parameter.min === undefined ? {} : { min: parameter.min }),
    ...(parameter.max === undefined ? {} : { max: parameter.max }),
    ...(parameter.step === undefined ? {} : { step: parameter.step }),
  };
}

/** 把一条目录条目适配成节点用的 `ImageModelDefinition`。 */
export function toImageModelDefinition(
  info: CatalogImageModelEntry,
): ImageModelDefinition {
  const resolutions = resolveModelSizeOptions(info).map((value) => ({
    value,
    label: value,
  }));
  const aspectRatios = resolveModelAspectOptions(info).map((value) => ({
    value,
    label: value,
  }));
  const parameters = info.request?.parameters ?? [];
  const extraParamsSchema = parameters.map(toExtraParam);
  const defaultExtraParams = Object.fromEntries(
    parameters
      .filter((parameter) => parameter.default !== undefined && parameter.default !== null)
      .map((parameter) => [parameter.key, parameter.default]),
  );

  return {
    id: info.id,
    mediaType: 'image',
    displayName: info.label,
    providerId: info.providerId,
    description: '',
    eta: '',
    defaultAspectRatio: aspectRatios[0]?.value ?? '1:1',
    defaultResolution:
      resolutions.find((item) => item.value === PREFERRED_DEFAULT_RESOLUTION)?.value
      ?? resolutions[0]?.value
      ?? PREFERRED_DEFAULT_RESOLUTION,
    aspectRatios,
    resolutions,
    ...(extraParamsSchema.length > 0 ? { extraParamsSchema } : {}),
    ...(Object.keys(defaultExtraParams).length > 0 ? { defaultExtraParams } : {}),
    resolveRequest: ({ referenceImageCount }) => ({
      requestModel: info.apiModel,
      modeLabel: referenceImageCount > 0 ? '编辑' : '生成',
    }),
  };
}

export interface CatalogImageModels {
  /** 目录里的全部图片模型，已适配成 `ImageModelDefinition`。 */
  models: ImageModelDefinition[];
  /**
   * 按节点上存的 model id 取模型。
   *
   * 兜底链：精确 id → 历史 id 别名 → apiModel 同名 → 目录首个模型。节点上可能
   * 存着后台已经下线的模型，这时落回第一个可用模型而不是崩掉。
   */
  getModel: (modelId: string | null | undefined) => ImageModelDefinition;
}

export function useCatalogImageModels(): CatalogImageModels {
  const { models: catalog } = useFreezoneImageModels();
  return useMemo(() => {
    // 目录接口成功但返回空数组时，`useFreezoneImageModels` 不会替换成兜底列表，
    // 这里补上，保证节点永远拿得到一个可用模型。
    const source = catalog.length > 0 ? catalog : SHARED_MODELS;
    const models = source.map(toImageModelDefinition);
    const byId = new Map(models.map((model) => [model.id, model]));
    const byApiModel = new Map(
      source.map((info, index) => [info.apiModel, models[index]]),
    );
    return {
      models,
      getModel: (modelId) => {
        const requested = String(modelId ?? '').trim();
        return (
          byId.get(requested)
          ?? byId.get(normalizeImageModelId(requested))
          ?? byApiModel.get(requested)
          ?? models[0]
        );
      },
    };
  }, [catalog]);
}
