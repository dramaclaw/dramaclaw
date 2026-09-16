// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type CreditTransactionCategory = "all" | "earned" | "spent" | "refunded";

// Which account the `credits/me/*` figures were read from. An organization
// member's tasks are charged to their org member account, so the page must
// show that account — showing the personal wallet next to org spending was
// the whole defect (OI-7).
export type CreditScope = "personal" | "org_member";

export interface CreditOrgRef {
  org_id: string;
  name: string;
}

export interface CreditSummary {
  balance: number;
  earned: number;
  spent: number;
  refunded: number;
  pending: number;
  promotion_count: number;
  updated_at: string | null;
  // The three keys below are optional on purpose: a backend that predates the
  // scope contract simply omits them, and such a response must keep working
  // as a personal account rather than failing to parse.
  scope?: CreditScope;
  organization?: CreditOrgRef | null;
  // Personal balance that still exists but cannot be spent here, surfaced
  // only when it is non-zero. Never folded into `balance`.
  dormant_personal_balance?: number | null;
  // The low-balance threshold an org admin set on *this member's* allocation —
  // not an organization-wide figure. Only org members ever receive it; `0`
  // means "no threshold configured", which is why it can never be compared
  // naively (every non-negative balance is `>= 0`).
  low_balance_threshold?: number | null;
}

// Anything that is not literally "org_member" reads as a personal account.
// Failing towards "personal" keeps an unknown/absent value from painting the
// organization framing onto a personal wallet.
export function creditScopeOf(payload?: { scope?: string | null } | null): CreditScope {
  return payload?.scope === "org_member" ? "org_member" : "personal";
}

// Reads the wire key so no component has to. Two surfaces render this scope —
// the credit page and the top-bar balance badge — and a nameless org ref would
// print an empty label, so the emptiness check belongs here instead of twice at
// the call sites.
export function creditOrgOf(summary?: CreditSummary | null): CreditOrgRef | null {
  if (creditScopeOf(summary) !== "org_member") return null;
  const ref = summary?.organization;
  return ref && typeof ref.name === "string" && ref.name !== "" ? ref : null;
}

export function dormantPersonalBalanceOf(summary?: CreditSummary | null): number | null {
  if (creditScopeOf(summary) !== "org_member") return null;
  const value = summary?.dormant_personal_balance;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Same reason `creditOrgOf` lives here: the guards are the contract, not a
// component detail. A threshold only exists for an org member's allocation,
// and `0` is the backend's "not configured" — reading it as a real threshold
// would fire the warning permanently, since a balance is never below zero.
export function lowBalanceThresholdOf(summary?: CreditSummary | null): number | null {
  if (creditScopeOf(summary) !== "org_member") return null;
  const value = summary?.low_balance_threshold;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

// Who configured a promotion the caller can hit: their own organization, or
// the platform. The backend merges both lists before sending them.
export type CreditPromotionScope = "org" | "platform";

// Mirrors `creditScopeOf`: anything that is not literally "org" reads as a
// platform promotion. Failing towards "platform" keeps an absent or
// not-yet-known wire value from claiming that the member's organization
// authored a discount it did not.
export function promotionScopeOf(
  promotion?: { scope?: string | null } | null,
): CreditPromotionScope {
  return promotion?.scope === "org" ? "org" : "platform";
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
  // Optional for the same reason the summary's scope keys are: a backend that
  // predates organization promotions omits it, and such a response must keep
  // rendering as a platform promotion.
  scope?: CreditPromotionScope;
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
  // Same contract as the summary: org members get their org account's ledger.
  scope?: CreditScope;
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
  status?: CreditTransaction["status"];
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
        .get("api/v1/credits/me/summary", { signal, retry: 0 })
        .json<OkResponse<CreditSummary>>(),
    enabled,
    // Task events invalidate normal lifecycle changes. Only accounts with
    // unsettled reservations poll: CronJob recovery has no browser event and
    // may otherwise leave pending/refund totals stale indefinitely.
    staleTime: 60_000,
    refetchInterval: (query) =>
      query.state.error == null && (query.state.data?.data.pending ?? 0) > 0
        ? 60_000
        : false,
    refetchIntervalInBackground: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
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
      if (filters.status) searchParams.status = filters.status;
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
