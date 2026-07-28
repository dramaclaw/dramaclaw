// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type CreditTransactionCategory = "all" | "earned" | "spent" | "refunded";

export interface CreditSummary {
  balance: number;
  earned: number;
  spent: number;
  refunded: number;
  pending: number;
  promotion_count: number;
  updated_at: string | null;
}

export interface CreditPromotion {
  id: string;
  name: string;
  target_type: "feature" | "model";
  target_label: string;
  billing_domain: "mainline" | "freezone" | "all";
  discount_basis_points: number;
  starts_at: string | null;
  ends_at: string | null;
}

export interface CreditTransaction {
  id: string;
  occurred_at: string | null;
  category: Exclude<CreditTransactionCategory, "all">;
  status: "pending" | "confirmed" | "refunded" | "completed";
  delta: number;
  balance_after: number;
  project_id: string;
  project_name: string;
  resource_kind: string;
  feature_key: string;
  feature_label: string;
  model: string;
  original_cost: number | null;
  charged_cost: number | null;
  promotion: {
    id?: string;
    name?: string;
    discount_basis_points?: number;
    ends_at?: string | null;
  };
}

export interface CreditTransactionPage {
  items: CreditTransaction[];
  page: number;
  page_size: number;
  total: number;
}

export interface CreditFilterOption {
  value: string;
  label: string;
}

export interface CreditFilterOptions {
  projects: CreditFilterOption[];
  features: CreditFilterOption[];
  models: CreditFilterOption[];
}

export interface CreditTransactionFilters {
  category: CreditTransactionCategory;
  page: number;
  pageSize: number;
  startAt?: string;
  endAt?: string;
  projectId?: string;
  featureKey?: string;
  model?: string;
}

export function useCreditSummary(enabled = true) {
  return useQuery({
    queryKey: queryKeys.creditSummary(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/credits/me/summary", { signal })
        .json<OkResponse<CreditSummary>>(),
    enabled,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreditPromotions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.creditPromotions(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/credits/me/promotions", { signal })
        .json<OkResponse<{ items: CreditPromotion[] }>>(),
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreditFilterOptions(enabled = true) {
  return useQuery({
    queryKey: queryKeys.creditFilterOptions(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/credits/me/filter-options", { signal })
        .json<OkResponse<CreditFilterOptions>>(),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreditTransactions(filters: CreditTransactionFilters, enabled = true) {
  return useQuery({
    queryKey: queryKeys.creditTransactions(filters),
    queryFn: ({ signal }) => {
      const searchParams: Record<string, string | number> = {
        category: filters.category,
        page: filters.page,
        page_size: filters.pageSize,
      };
      if (filters.startAt) searchParams.start_at = filters.startAt;
      if (filters.endAt) searchParams.end_at = filters.endAt;
      if (filters.projectId) searchParams.project_id = filters.projectId;
      if (filters.featureKey) searchParams.feature_key = filters.featureKey;
      if (filters.model) searchParams.model = filters.model;
      return api
        .get("api/v1/credits/me/transactions", { searchParams, signal })
        .json<OkResponse<CreditTransactionPage>>();
    },
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
}
