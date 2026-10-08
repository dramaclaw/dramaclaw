// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from 'react';

import { fetchFreezoneBlockoutModels } from '@/api/ops';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';
import { readUrl } from '@/lib/url-params';

/**
 * 白模对话框的模型下拉数据：第一项是服务端解析出的默认模型，其余是网关上还能选的。
 *
 * 对话框关掉就整个卸载，所以每次打开拉一次，列表很短。拉不到就给空列表——
 * 下拉不显示，用默认模型照样能生成；不像图片模型那样塞一份前端兜底清单，
 * 因为这里的候选完全由部署方配置，前端猜不出来。
 */
export function useBlockoutModels(): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    const { project } = readUrl();
    if (!project) return;
    let alive = true;
    fetchFreezoneBlockoutModels(project)
      .then((list) => {
        if (!alive) return;
        setModels(
          list.map((model) => ({
            id: model.id,
            providerId: model.providerId,
            apiModel: model.apiModel,
            label: model.label,
          })),
        );
      })
      .catch(() => {
        if (alive) setModels([]);
      });
    return () => {
      alive = false;
    };
  }, []);
  return models;
}
