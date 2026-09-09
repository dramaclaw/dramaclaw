// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

type CustomRechargeBounds = {
  credits_per_cny: number;
  min_credits: number;
  max_credits: number;
};

export function wholeCnyRechargeBounds(config: CustomRechargeBounds) {
  const step = Math.max(1, Math.trunc(config.credits_per_cny));
  const min = Math.ceil(config.min_credits / step) * step;
  const max = Math.max(min, Math.floor(config.max_credits / step) * step);
  return { min, max, step };
}

export function normalizeWholeCnyCredits(
  value: number,
  config: CustomRechargeBounds,
): number {
  const { min, max, step } = wholeCnyRechargeBounds(config);
  if (!Number.isFinite(value)) return min;
  const rounded = Math.round(value / step) * step;
  return Math.min(max, Math.max(min, rounded));
}
