// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type RechargePaymentMethod = "alipay" | "wxpay";
export type RechargeOrderType =
  | "personal_recharge"
  | "org_pool_purchase"
  | "org_member_recharge";

export interface RechargePackage {
  package_id: string;
  package_group_id?: string;
  order_type: RechargeOrderType;
  effective_org_id: string | null;
  name: string;
  description?: string;
  badge?: string;
  validity_label?: string;
  purchase_limit?: "once" | "unlimited";
  purchase_note?: string;
  payment_methods: RechargePaymentMethod[];
  amount_cents: number;
  base_credits: number;
  gift_credits: number;
  org_credit_cost: number;
  currency: "CNY";
  sort_order: number;
  variant_sort_order?: number;
}

export interface CustomRechargeConfig {
  enabled: boolean;
  payment_methods: RechargePaymentMethod[];
  credits_per_cny: number;
  min_credits: number;
  max_credits: number;
  quick_credits: number[];
  version: number;
}

export interface RechargeOrder {
  order_id: string;
  merchant_order_no: string;
  order_type: RechargeOrderType;
  org_id: string | null;
  package_name: string;
  amount_cents: number;
  base_credits: number;
  gift_credits: number;
  currency: "CNY";
  payment_method: RechargePaymentMethod;
  payment_status: "pending" | "paid" | "failed" | "expired" | "closed" | "refunded";
  fulfillment_status: "pending" | "reserved" | "processing" | "credited" | "failed" | "reversed";
  failure_code: string | null;
  expires_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EpayCheckout {
  action: string;
  method: "POST";
  fields: Record<string, string>;
}

type CreateRechargeOrderResponse = {
  order: RechargeOrder;
  checkout: EpayCheckout | null;
};

export type RechargeLinkSubject = "personal_user" | "org_generic" | "org_member";

type RechargeLinkPackagesResponse = {
  link: { subject_type: RechargeLinkSubject; expires_at: string | null };
  items: RechargePackage[];
};

export function useRechargePackages(enabled = true) {
  return useQuery({
    queryKey: queryKeys.rechargePackages(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/packages", { signal })
        .json<OkResponse<{ items: RechargePackage[] }>>(),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useCustomRechargeConfig(enabled = true) {
  return useQuery({
    queryKey: queryKeys.customRecharge(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/custom-recharge", { signal })
        .json<OkResponse<CustomRechargeConfig>>(),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useRechargeOrders(options: { poll?: boolean; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.rechargeOrders(),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/orders", {
          searchParams: { page: 1, page_size: 10 },
          signal,
        })
        .json<OkResponse<{ items: RechargeOrder[]; total: number }>>(),
    enabled: options.enabled ?? true,
    staleTime: 5_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      options.poll || query.state.data?.data.items.some(
        (order) => order.payment_status === "pending" || order.fulfillment_status === "processing",
      )
        ? 5_000
        : false,
    retry: false,
  });
}

export function useRechargeOrder(orderId: string | null) {
  return useQuery({
    queryKey: queryKeys.rechargeOrder(orderId ?? "missing"),
    queryFn: ({ signal }) =>
      api
        .get(`api/v1/payments/orders/${encodeURIComponent(orderId!)}`, { signal })
        .json<OkResponse<RechargeOrder>>(),
    enabled: Boolean(orderId),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const order = query.state.data?.data;
      if (!order) return 3_000;
      const terminalPayment = ["failed", "expired", "closed", "refunded"].includes(
        order.payment_status,
      );
      const terminalFulfillment = ["credited", "failed", "reversed"].includes(
        order.fulfillment_status,
      );
      return terminalPayment || terminalFulfillment ? false : 3_000;
    },
    retry: false,
  });
}

export function useCreateRechargeOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      packageId,
      paymentMethod,
      idempotencyKey,
    }: {
      packageId: string;
      paymentMethod: RechargePaymentMethod;
      idempotencyKey: string;
    }) =>
      api
        .post("api/v1/payments/orders", {
          headers: { "Idempotency-Key": idempotencyKey },
          json: { package_id: packageId, payment_method: paymentMethod },
          retry: 0,
        })
        .json<OkResponse<CreateRechargeOrderResponse>>(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rechargeOrders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditSummary() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditTransactionsRoot() }),
      ]);
    },
    retry: false,
  });
}

export function useCreateCustomRechargeOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      credits,
      configVersion,
      paymentMethod,
      idempotencyKey,
    }: {
      credits: number;
      configVersion: number;
      paymentMethod: RechargePaymentMethod;
      idempotencyKey: string;
    }) =>
      api
        .post("api/v1/payments/custom-orders", {
          headers: { "Idempotency-Key": idempotencyKey },
          json: {
            credits,
            config_version: configVersion,
            payment_method: paymentMethod,
          },
          retry: 0,
        })
        .json<OkResponse<CreateRechargeOrderResponse>>(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rechargeOrders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditSummary() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditTransactionsRoot() }),
      ]);
    },
    retry: false,
  });
}

export function useRechargeLinkPackages(token: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.rechargeLinkPackages(token),
    queryFn: ({ signal }) =>
      api
        .get("api/v1/payments/recharge-link/packages", {
          headers: { "X-Recharge-Token": token },
          signal,
        })
        .json<OkResponse<RechargeLinkPackagesResponse>>(),
    enabled: enabled && token.length >= 32,
    staleTime: 15_000,
    retry: false,
  });
}

export function useCreateRechargeLinkOrder(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      packageId,
      paymentMethod,
      idempotencyKey,
    }: {
      packageId: string;
      paymentMethod: RechargePaymentMethod;
      idempotencyKey: string;
    }) =>
      api
        .post("api/v1/payments/recharge-link/orders", {
          headers: {
            "X-Recharge-Token": token,
            "Idempotency-Key": idempotencyKey,
          },
          json: { package_id: packageId, payment_method: paymentMethod },
          retry: 0,
        })
        .json<OkResponse<CreateRechargeOrderResponse>>(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.rechargeOrders() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditSummary() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.creditTransactionsRoot() }),
      ]);
    },
    retry: false,
  });
}

export function submitEpayCheckout(checkout: EpayCheckout): void {
  const action = new URL(checkout.action, window.location.origin);
  const localHttp =
    action.protocol === "http:" &&
    (action.hostname === "localhost" || action.hostname === "127.0.0.1");
  if (action.protocol !== "https:" && !localHttp) {
    throw new Error("unsafe checkout URL");
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action.toString();
  form.style.display = "none";
  for (const [name, value] of Object.entries(checkout.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}
