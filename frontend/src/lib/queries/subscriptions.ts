// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import type { OkResponse } from "@/types/api";

export type SubscriptionMethod = "alipay" | "wxpay" | "dodo";
export interface SubscriptionOffer {
  available?: boolean;
  unavailable_reason?: string;
  payment_method: SubscriptionMethod;
  currency: "CNY";
  amount_minor: number;
  first_amount_minor: number | null;
  payment_amount_minor?: number;
  payment_currency?: "CNY" | "USD";
  fx_rate_snapshot?: string | null;
}
export interface SubscriptionPlan {
  plan_id: string;
  version: number;
  name: string;
  description: string;
  group_id?: string | null;
  badge?: string;
  sort_order?: number;
  billing_months: 1 | 3 | 12;
  intro_cycles?: number;
  credits_per_month: number;
  grant_mode: "monthly" | "upfront";
  org_id?: string | null;
  terms_url: string;
  terms_agreement_id?: string | null;
  terms_agreement_version?: number | null;
  terms_content_hash?: string | null;
  offers: SubscriptionOffer[];
}
export interface SubscriptionPlanGroup {
  group_id: string;
  name: string;
  description: string;
  badge: string;
  sort_order: number;
  options: SubscriptionPlan[];
}
export function groupSubscriptionPlans(
  plans: SubscriptionPlan[],
): SubscriptionPlanGroup[] {
  const groups = new Map<string, SubscriptionPlanGroup>();
  for (const plan of plans) {
    const id = plan.group_id ?? plan.plan_id;
    const group = groups.get(id) ?? {
      group_id: id,
      name: plan.name,
      description: plan.description,
      badge: plan.badge ?? "",
      sort_order: plan.sort_order ?? 0,
      options: [],
    };
    group.options.push(plan);
    groups.set(id, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.sort_order - b.sort_order || a.group_id.localeCompare(b.group_id),
  );
}
export interface SubscriptionInvoice {
  invoice_id: string;
  merchant_order_no?: string | null;
  cycle_index: number;
  status: "pending" | "processing" | "paid" | "failed" | "refunded" | "closed";
  amount_minor: number;
  currency: string;
  payment_amount_minor: number;
  payment_currency: string;
  fx_rate_snapshot: string | number | null;
  provider_total_minor: number | null;
  provider_tax_minor: number | null;
  submitted_at?: string | null;
  paid_at?: string | null;
  payment_id?: string | null;
  period_start: string | null;
  period_end: string | null;
}
export interface Subscription {
  subscription_id: string;
  plan_id: string;
  plan_version: number;
  payment_method: SubscriptionMethod;
  offer: SubscriptionPlan & SubscriptionOffer;
  authorization_status: "pending" | "active" | "cancelled" | "failed";
  checkout_state: "pending" | "creating" | "ready" | "unknown" | "failed";
  checkout_started_at?: string | null;
  checkout_session_id?: string | null;
  remote_subscription_id?: string | null;
  checkout_url: string | null;
  auto_renew: boolean;
  cancellation_requested_at: string | null;
  cancellation_confirmed_at: string | null;
  paid_until: string | null;
  review_required: boolean;
  failure_code: string | null;
  recovery_error?: string | null;
  has_pending_payment?: boolean;
  purchase_blocked?: boolean;
  can_change_payment_method?: boolean;
  settlement_state?: "open" | "active" | "compensating" | "closed";
  billing_status: "pending" | "processing" | "paid" | "failed" | "refunded";
  invoices?: SubscriptionInvoice[];
  grants?: Array<{
    month_index: number;
    amount: number;
    due_at: string;
    status: "pending" | "credited" | "blocked" | "held";
  }>;
}
export type SubscriptionStatus =
  | "review"
  | "cancellingSetup"
  | "cancelling"
  | "cancelled"
  | "confirming"
  | "awaitingPayment"
  | "setupFailed"
  | "paymentFailed"
  | "active";
export function subscriptionStatus(value: Subscription): SubscriptionStatus {
  if (value.review_required) return "review";
  if (value.checkout_state === "failed" && !value.paid_until)
    return "setupFailed";
  if (value.authorization_status === "failed") return "paymentFailed";
  if (!value.auto_renew) {
    if (value.cancellation_confirmed_at) return "cancelled";
    if (value.authorization_status === "pending" && !value.paid_until)
      return "cancellingSetup";
    return "cancelling";
  }
  if (["creating", "unknown"].includes(value.checkout_state))
    return "confirming";
  if (value.billing_status === "failed") return "paymentFailed";
  if (!value.paid_until) return "awaitingPayment";
  return "active";
}
export function isHistoricalSubscription(
  value: Subscription,
  now = Date.now(),
): boolean {
  const paidUntil = value.paid_until ? Date.parse(value.paid_until) : null;
  return (
    !value.auto_renew &&
    !!value.cancellation_confirmed_at &&
    !value.review_required &&
    !value.has_pending_payment &&
    (paidUntil === null || (Number.isFinite(paidUntil) && paidUntil <= now)) &&
    value.billing_status !== "processing" &&
    !value.invoices?.some((invoice) =>
      ["pending", "processing"].includes(invoice.status),
    )
  );
}
export function subscriptionBlocksPurchase(value: Subscription, now = Date.now()): boolean {
  if (value.settlement_state === "compensating" || value.settlement_state === "closed") return false;
  if (typeof value.purchase_blocked === "boolean") return value.purchase_blocked;
  // An unpaid checkout is an attempt, not an active membership. Older API
  // responses may lack purchase_blocked, so fall back only to paid evidence.
  const paidUntil = value.paid_until ? Date.parse(value.paid_until) : null;
  return (paidUntil !== null && (!Number.isFinite(paidUntil) || paidUntil > now)) ||
    value.invoices?.some((invoice) => invoice.status === "paid" &&
      (!invoice.period_end || Date.parse(invoice.period_end) > now)) === true ||
    (value.billing_status === "paid" && paidUntil === null);
}
export function subscriptionAttemptFinished(value: Subscription): boolean {
  return !subscriptionBlocksPurchase(value) && !value.has_pending_payment &&
    !value.invoices?.some((invoice) => invoice.status === "processing") &&
    (value.checkout_state === "failed" || value.billing_status === "failed" ||
      value.billing_status === "refunded" || value.authorization_status === "failed" ||
      value.authorization_status === "cancelled");
}
export function reusableSubscriptionAttempt(value: Subscription): boolean {
  return value.payment_method !== "dodo" && value.settlement_state !== "compensating" &&
    value.settlement_state !== "closed" && !subscriptionBlocksPurchase(value) && !subscriptionAttemptFinished(value) &&
    value.auto_renew !== false && !value.cancellation_requested_at &&
    !value.review_required && ["pending", "creating", "ready", "unknown"].includes(value.checkout_state);
}
export function safeSubscriptionCheckout(
  raw: string,
  method: SubscriptionMethod,
): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  ) {
    throw new Error("unsafe subscription checkout URL");
  }
  const domains = {
    alipay: ["alipay.com", "alipay.net"],
    wxpay: ["weixin.qq.com", "wechatpay.cn"],
    dodo: ["dodopayments.com"],
  }[method];
  if (
    !domains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith("." + domain),
    )
  ) {
    throw new Error("unsafe subscription checkout URL");
  }
  // Channel replies are authenticated on the server; browsers still reject script URLs.
  return url.href;
}
export function subscriptionAttemptKey(
  user: string,
  plan: string,
  version: number,
  method: string,
): string {
  const key =
    "dramaclaw-subscription-attempt:" +
    JSON.stringify([user, plan, version, method]);
  const existing = sessionStorage.getItem(key);
  if (existing && /^sub-[a-z0-9-]{36}$/i.test(existing)) return existing;
  const value = "sub-" + crypto.randomUUID();
  sessionStorage.setItem(key, value);
  return value;
}
export function forgetSubscriptionAttempt(
  user: string,
  plan: string,
  version: number,
  method: string,
  subscriptionId?: string,
): void {
  const key =
    "dramaclaw-subscription-attempt:" +
    JSON.stringify([user, plan, version, method]);
  if (
    subscriptionId &&
    sessionStorage.getItem(key + ":subscription") !== subscriptionId
  )
    return;
  sessionStorage.removeItem(key);
  sessionStorage.removeItem(key + ":subscription");
}
export function bindSubscriptionAttempt(
  user: string,
  plan: string,
  version: number,
  method: string,
  subscriptionId: string,
): void {
  const key =
    "dramaclaw-subscription-attempt:" +
    JSON.stringify([user, plan, version, method]);
  sessionStorage.setItem(key + ":subscription", subscriptionId);
}
function useScope() {
  return useAuthStore((state) => state.username ?? "");
}
export function useSubscriptionPlans(enabled: boolean) {
  const scope = useScope();
  return useQuery({
    queryKey: ["subscriptions", scope, "plans"],
    enabled,
    queryFn: ({ signal }) =>
      api.get("api/v1/payments/subscriptions/plans", { signal }).json<
        OkResponse<{
          items: SubscriptionPlan[];
          groups?: SubscriptionPlanGroup[];
        }>
      >(),
    retry: false,
    staleTime: 30_000,
  });
}
export function useSubscriptions(enabled: boolean) {
  const scope = useScope();
  return useQuery({
    queryKey: ["subscriptions", scope, "list"],
    enabled,
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/subscriptions", { signal })
        .json<OkResponse<{ items: Subscription[] }>>(),
    retry: false,
    refetchInterval: enabled ? 15_000 : false,
  });
}
export function useSubscriptionBilling(enabled: boolean) {
  const scope = useScope();
  return useQuery({
    queryKey: ["subscriptions", scope, "billing"],
    enabled,
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/subscriptions/billing", { signal })
        .json<OkResponse<{ items: Subscription[] }>>(),
    retry: false,
    refetchInterval: enabled ? 15_000 : false,
    // Reconciliation can settle invoices while this tab is hidden or offline.
    // Show the current result on return, including within the app's 30s cache window.
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
export function useMembership(enabled: boolean) {
  const scope = useScope();
  return useQuery({
    queryKey: ["subscriptions", scope, "membership"],
    enabled,
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/subscriptions/membership", { signal })
        .json<
          OkResponse<{
            active: boolean;
            subscription_id?: string;
            plan_id?: string;
            plan_version?: number;
            name?: string;
            valid_until?: string;
            auto_renew?: boolean;
          }>
        >(),
    retry: false,
    refetchInterval: enabled ? 15_000 : false,
  });
}
export function useSubscription(
  id: string | null,
  enabled = true,
  shouldPoll: boolean | ((value: Subscription | undefined) => boolean) = true,
  pollInterval = 5_000,
) {
  const scope = useScope();
  return useQuery({
    queryKey: ["subscriptions", scope, "detail", id],
    enabled: enabled && !!id,
    queryFn: ({ signal }) =>
      api
        .get(`api/v1/payments/subscriptions/${encodeURIComponent(id!)}`, {
          signal,
        })
        .json<OkResponse<Subscription>>(),
    retry: false,
    refetchInterval: (query) =>
      enabled && id &&
      (typeof shouldPoll === "function" ? shouldPoll(query.state.data?.data) : shouldPoll)
        ? pollInterval : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
export function useCreateSubscription() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (input: {
      plan: SubscriptionPlan;
      method: SubscriptionMethod;
      key: string;
      termsAccepted: true;
    }) =>
      api
        .post("api/v1/payments/subscriptions", {
          retry: 0,
          headers: { "Idempotency-Key": input.key },
          json: {
            plan_id: input.plan.plan_id,
            plan_version: input.plan.version,
            payment_method: input.method,
            terms_accepted: input.termsAccepted,
            terms_agreement_id: input.plan.terms_agreement_id,
            terms_agreement_version: input.plan.terms_agreement_version,
            ...(input.method === "dodo"
              ? {
                  quote: (() => {
                    const offer = input.plan.offers.find(
                      (o) => o.payment_method === "dodo",
                    );
                    if (
                      !offer ||
                      offer.payment_currency !== "USD" ||
                      !offer.payment_amount_minor ||
                      !offer.fx_rate_snapshot
                    ) {
                      throw new Error("Dodo quote unavailable");
                    }
                    return {
                      base_amount_cents: offer.amount_minor,
                      payment_amount_cents: offer.payment_amount_minor,
                      currency: "USD",
                      cny_per_usd: offer.fx_rate_snapshot,
                    };
                  })(),
                }
              : {}),
          },
        })
        .json<
          OkResponse<{
            subscription: Subscription;
            checkout_url: string | null;
          }>
        >(),
    onSettled: () => client.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}
export function useCancelSubscription() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (id: string) =>
      api
        .post(
          `api/v1/payments/subscriptions/${encodeURIComponent(id)}/cancel`,
          { retry: 0 },
        )
        .json<OkResponse<Subscription>>(),
    onSettled: () => client.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}

export function useRetrySubscription() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (id: string) =>
      api
        .post(`api/v1/payments/subscriptions/${encodeURIComponent(id)}/retry`, {
          retry: 0,
        })
        .json<OkResponse<Subscription>>(),
    onSettled: () => client.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}

export function useRefreshSubscription() {
  const client = useQueryClient();
  return useMutation({
    retry: false,
    mutationFn: (id: string) =>
      api.post(`api/v1/payments/subscriptions/${encodeURIComponent(id)}/refresh`, {
        retry: 0,
      }).json<OkResponse<Subscription>>(),
    onSettled: () => client.invalidateQueries({ queryKey: ["subscriptions"] }),
  });
}
