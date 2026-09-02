// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ModelProviderDefinition } from '../types';

// HuiMeng Tasks API — domestic-friendly proxy.
// SuperTale `_image_provider_config(provider="huimeng")` reads HUIMENGI_API_KEY.
export const provider: ModelProviderDefinition = {
  id: 'huimeng',
  name: 'HuiMeng',
  label: '惠盟 / HuiMeng', // i18n-exempt —— 服务商品牌名
};
