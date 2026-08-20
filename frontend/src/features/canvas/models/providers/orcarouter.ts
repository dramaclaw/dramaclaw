// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ModelProviderDefinition } from '../types';

// OrcaRouter — OpenAI-compatible meta-router that proxies namespaced model
// families (openai/*, anthropic/*, orcarouter/*) through a single gateway.
// SuperTale `_image_provider_config(provider="orcarouter")` reads ORCAROUTER_API_KEY.
export const provider: ModelProviderDefinition = {
  id: 'orcarouter',
  name: 'OrcaRouter',
  label: 'OrcaRouter',
};
