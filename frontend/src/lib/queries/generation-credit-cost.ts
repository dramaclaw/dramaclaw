// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQueries, useQuery } from "@tanstack/react-query";

import {
  BillingRuleNotConfiguredError,
  jsonWithBackendError,
} from "@/lib/api-errors";
import { api } from "@/lib/api";
import type { OkResponse } from "@/types/api";

export type GenerationCreditCost = {
  cost: number;
  display: string;
  original_cost?: number;
  original_display?: string;
  discount_amount?: number;
  promotion?: {
    id?: string;
    name?: string;
    discount_basis_points?: number;
    starts_at?: string | null;
    ends_at?: string | null;
  };
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

export type GenerationCreditCostPlanItem = {
  modeKey?: string | null;
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

export function useGenerationCreditCostPlan(
  kind: string,
  value: string,
  items: readonly GenerationCreditCostPlanItem[],
  options: Omit<GenerationCreditCostOptions, "quantity" | "modeKey"> = {},
) {
  const groupedItems = new Map<string, number>();
  for (const item of items) {
    const modeKey = String(item.modeKey ?? "").trim();
    groupedItems.set(modeKey, (groupedItems.get(modeKey) ?? 0) + 1);
  }
  const groups = [...groupedItems.entries()].map(([modeKey, quantity]) => ({
    modeKey,
    quantity,
  }));
  const cleanKind = kind.trim();
  const cleanValue = value.trim();
  const cleanSurface = String(options.surface ?? "").trim();
  const cleanImageRole = String(options.imageRole ?? "").trim();
  const paramsJson = options.params ? JSON.stringify(options.params) : "";
  const queries = useQueries({
    queries: groups.map(({ modeKey, quantity }) => ({
      queryKey: generationCreditCostQueryKey(cleanKind, cleanValue, {
        ...options,
        modeKey,
        quantity,
      }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        jsonWithBackendError<OkResponse<GenerationCreditCost>>(
          api.get("api/v1/generation-credit-cost", {
            searchParams: {
              kind: cleanKind,
              ...(cleanSurface ? { surface: cleanSurface } : {}),
              value: cleanValue,
              ...(paramsJson ? { params: paramsJson } : {}),
              quantity: String(quantity),
              ...(modeKey ? { mode_key: modeKey } : {}),
              ...(cleanImageRole ? { image_role: cleanImageRole } : {}),
            },
            signal,
            throwHttpErrors: false,
          }),
        ),
      enabled: !!cleanKind && !!cleanValue && quantity > 0,
      retry: (failureCount: number, error: Error) =>
        !(error instanceof BillingRuleNotConfiguredError) && failureCount < 3,
      staleTime: 60_000,
    })),
  });

  const cost =
    groups.length > 0 && queries.every((query) => query.data?.ok === true)
      ? queries.reduce((sum, query) => sum + (query.data?.data.cost ?? 0), 0)
      : undefined;
  const originalCost =
    cost != null
      ? queries.reduce(
          (sum, query) =>
            sum
            + (query.data?.data.original_cost
              ?? query.data?.data.cost
              ?? 0),
          0,
        )
      : undefined;
  const appliedPromotions = queries
    .map((query) => query.data?.data.promotion)
    .filter(
      (
        promotion,
      ): promotion is NonNullable<GenerationCreditCost["promotion"]> =>
        !!promotion?.id,
    );
  const firstPromotion = appliedPromotions[0];
  const promotion =
    firstPromotion
    && appliedPromotions.length === queries.length
    && appliedPromotions.every((item) => item.id === firstPromotion.id)
      ? firstPromotion
      : undefined;

  return { cost, originalCost, promotion, queries };
}
