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

import type { MediaModelRequestSchema } from '@/api/ops';
import type { ImageModelDefinition } from '@/features/canvas/models';
import { normalizeImageModelId } from '@/features/canvas/models';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { SHARED_MODELS } from '@/features/canvas/ui/ProviderModelPicker';
import {
  formatResolutionLabel,
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
const PREFERRED_DEFAULT_RESOLUTION = '2k';

/** 把一条目录条目适配成节点用的 `ImageModelDefinition`。 */
export function toImageModelDefinition(
  info: CatalogImageModelEntry,
): ImageModelDefinition {
  const resolutions = resolveModelSizeOptions(info).map((value) => ({
    value,
    label: formatResolutionLabel(value),
  }));
  const aspectRatios = resolveModelAspectOptions(info).map((value) => ({
    value,
    label: value,
  }));
  // 目录参数原样带给 `MediaModelParameterChip`，不再翻译成静态注册表的
  // `extraParamsSchema`（见 ImageModelDefinition.requestParameters 的注释：那次翻译
  // 会把 multiselect 拍成单选、把数字/布尔选项拍成字符串，而且值最后根本没提交）。
  const parameters = info.request?.parameters ?? [];

  return {
    id: info.id,
    mediaType: 'image',
    displayName: info.label,
    providerId: info.providerId,
    description: '',
    eta: '',
    defaultAspectRatio: aspectRatios[0]?.value ?? '1:1',
    defaultResolution:
      resolutions.find(
        (item) => item.value.toLowerCase() === PREFERRED_DEFAULT_RESOLUTION,
      )?.value
      ?? resolutions[0]?.value
      ?? PREFERRED_DEFAULT_RESOLUTION,
    aspectRatios,
    resolutions,
    ...(parameters.length > 0 ? { requestParameters: parameters } : {}),
    resolveRequest: ({ referenceImageCount }) => ({
      // 必须带上 provider 前缀：`freezoneAiGateway.splitProviderModel` 按**第一个**
      // `/` 拆 provider/model。只给裸 apiModel 的话，`huimeng_gpt_image2` 这类无斜杠
      // 的会丢掉 provider（回落到后端 env），而 OpenRouter 那种自带命名空间的
      // `google/gemini-2.5-flash-image-preview` 更会被截成 `gemini-...`，与目录里
      // 配置的模型对不上，后端 `_catalog_image_execution_selection` 直接 400。
      // 加前缀后拆出来正是 (openrouter, google/gemini-2.5-flash-image-preview)。
      requestModel: `${info.providerId}/${info.apiModel}`,
      modeLabel: referenceImageCount > 0 ? '编辑' : '生成',
    }),
  };
}

export interface CatalogImageModels {
  /** 目录里的全部图片模型，已适配成 `ImageModelDefinition`。权威空目录时为空数组。 */
  models: ImageModelDefinition[];
  /**
   * 按节点上存的 model id 取模型。
   *
   * 兜底链：精确 id → 历史 id 别名 → apiModel 同名 → 目录首个模型。节点上可能
   * 存着后台已经下线的模型，这时落回第一个可用模型而不是崩掉。
   *
   * 权威空目录（`isEmpty`）时返回 undefined —— 没有任何模型可选是一个必须让调用方
   * 看见的状态，不能拿兜底模型把它盖掉。
   */
  getModel: (modelId: string | null | undefined) => ImageModelDefinition | undefined;
  /** 目录还在路上。此时 `models` 是兜底列表，别拿它做「有没有模型」的判断。 */
  isLoading: boolean;
  /**
   * 后台**确实**一个图片模型都没配（接口成功返回空列表），不是拉取失败兜底。
   * 为 true 时必须禁用提交：后端 `_resolve_catalog_request` 对空目录直接 409，
   * 让用户挑一个前端硬编码的模型再收一个报错，是最糟的体验。
   */
  isEmpty: boolean;
}

export function useCatalogImageModels(): CatalogImageModels {
  const { models: catalog, isLoading, isFallback } = useFreezoneImageModels();
  return useMemo(() => {
    // 「拉取失败」和「后台就是没配」必须分开：
    // - 失败（isFallback）→ `useFreezoneImageModels` 已经把 SHARED_MODELS 塞进来了，
    //   catalog 非空，照常用，用户还能继续干活；
    // - 加载中 → 同上，先用兜底撑住，别闪一下「无可用模型」；
    // - 成功但返回空（isFallback=false 且非加载中）→ 这是后台的**权威答案**。
    //   此前这里无条件回落到 SHARED_MODELS，等于把「没配模型」伪装成「有模型」，
    //   用户选中一个前端硬编码的模型、点生成，才被后端 409 顶回来。
    const isEmpty = isAuthoritativeEmptyCatalog({
      models: catalog,
      isLoading,
      isFallback,
    });
    const source = isEmpty ? [] : catalog.length > 0 ? catalog : SHARED_MODELS;
    const models = source.map(toImageModelDefinition);
    const byId = new Map(models.map((model) => [model.id, model]));
    const byApiModel = new Map(
      source.map((info, index) => [info.apiModel, models[index]]),
    );
    return {
      models,
      isLoading,
      isEmpty,
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
  }, [catalog, isFallback, isLoading]);
}

/**
 * 权威空目录下给节点撑场面的占位定义。
 *
 * 只为让比例 / 分辨率这些选择器有东西可读，**绝不可用于提交** —— 提交路径由
 * `isEmpty` 拦死。故意不复用 `SHARED_MODELS[0]`：拿一个真模型名当占位，用户会
 * 以为它可用，正是这次要修掉的那种误导。
 */
export const EMPTY_CATALOG_IMAGE_MODEL: ImageModelDefinition = toImageModelDefinition({
  id: '',
  providerId: '',
  apiModel: '',
  label: '无可用模型',
});
