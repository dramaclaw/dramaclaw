// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import {
  BillingRuleNotConfiguredError,
  jsonWithBackendError,
} from "@/lib/api-errors";
import { api } from "@/lib/api";
import type { OkResponse } from "@/types/api";

export type GenerationCreditCost = {
  cost: number;
  display: string;
  unit?: "call" | "item" | "second" | "token" | "character" | string;
  unit_cost?: number;
  quantity?: number;
  params?: Record<string, unknown>;
};

export type GenerationCreditCostOptions = {
  surface?: "supertale" | "canvas" | null;
  params?: Record<string, unknown> | null;
  quantity?: number | null;
  modeKey?: string | null;
  imageRole?: string | null;
};

export const generationCreditCostQueryKey = (
  kind: string,
  value?: string | null,
  options: GenerationCreditCostOptions = {},
) =>
  [
    "generation-credit-cost",
    kind,
    value ?? "",
    options.surface ?? "",
    options.params ? JSON.stringify(options.params) : "",
    options.quantity ?? "",
    options.modeKey ?? "",
    options.imageRole ?? "",
  ] as const;

export function useGenerationCreditCost(
  kind: string,
  value?: string | null,
  options: GenerationCreditCostOptions = {},
) {
  const cleanKind = kind.trim();
  const cleanValue = String(value ?? "").trim();
  const cleanSurface = String(options.surface ?? "").trim();
  const cleanModeKey = String(options.modeKey ?? "").trim();
  const cleanImageRole = String(options.imageRole ?? "").trim();
  const paramsJson = options.params ? JSON.stringify(options.params) : "";
  const requiresValue =
    cleanKind === "model" ||
    cleanKind === "image_selection" ||
    cleanKind === "fixed_image" ||
    cleanKind === "video_backend" ||
    cleanKind === "feature";
  return useQuery({
    queryKey: generationCreditCostQueryKey(cleanKind, cleanValue, {
      params: options.params,
      surface: cleanSurface as GenerationCreditCostOptions["surface"],
      quantity: options.quantity,
      modeKey: cleanModeKey,
      imageRole: cleanImageRole,
    }),
    queryFn: ({ signal }) =>
      jsonWithBackendError<OkResponse<GenerationCreditCost>>(
        api.get("api/v1/generation-credit-cost", {
          searchParams: {
            kind: cleanKind,
            ...(cleanSurface ? { surface: cleanSurface } : {}),
            ...(cleanValue ? { value: cleanValue } : {}),
            ...(paramsJson ? { params: paramsJson } : {}),
            ...(options.quantity != null ? { quantity: String(options.quantity) } : {}),
            ...(cleanModeKey ? { mode_key: cleanModeKey } : {}),
            ...(cleanImageRole ? { image_role: cleanImageRole } : {}),
          },
          signal,
          throwHttpErrors: false,
        }),
      ),
    enabled: !!cleanKind && (!requiresValue || !!cleanValue),
    retry: (failureCount, error) =>
      !(error instanceof BillingRuleNotConfiguredError) && failureCount < 3,
    staleTime: 60_000,
  });
}
