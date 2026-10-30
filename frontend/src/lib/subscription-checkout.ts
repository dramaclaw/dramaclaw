// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CHECKOUT_DRAFT_KEY,
  CHECKOUT_RETURN_KEY,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
  clearPaymentAttempt,
} from "@/lib/payment-navigation";
import type {
  Subscription,
  SubscriptionPlan,
} from "@/lib/queries/subscriptions";
import { safeSubscriptionCheckout } from "@/lib/queries/subscriptions";

export const SUBSCRIPTION_RETURN_KEY = "dramaclaw-subscription-return";
export interface SubscriptionDraft {
  kind: "subscription";
  planId: string;
  planVersion: number;
  username: string;
}

export function beginSubscriptionCheckout(
  plan: SubscriptionPlan,
  username: string,
) {
  clearPaymentAttempt();
  sessionStorage.removeItem(PAYMENT_RETURN_ORDER_ID_KEY);
  sessionStorage.removeItem(PAYMENT_RETURN_ORDER_KEY);
  sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
  sessionStorage.setItem(
    CHECKOUT_DRAFT_KEY,
    JSON.stringify({
      kind: "subscription",
      planId: plan.plan_id,
      planVersion: plan.version,
      username,
    } satisfies SubscriptionDraft),
  );
  sessionStorage.setItem(
    CHECKOUT_RETURN_KEY,
    window.location.pathname + window.location.search,
  );
  window.location.assign("/checkout");
}

export function subscriptionReturnUrl(id: string) {
  return `/payment-return?business_subscription_id=${encodeURIComponent(id)}`;
}

export function subscriptionReturnId(search: string): string | null {
  // A URL is a navigation hint; the detail API checks the authenticated owner.
  const id = new URLSearchParams(search).get("business_subscription_id");
  return id && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? id : null;
}

export type SubscriptionResultState =
  | "confirming"
  | "awaitingPayment"
  | "unconfirmed"
  | "checkoutUnavailable"
  | "authorized"
  | "expired"
  | "paid"
  | "active"
  | "failed"
  | "cancelled"
  | "review"
  | "refunded"
  | "compensating"
  | "unavailable";
export function subscriptionResultState(
  value: Subscription | undefined,
  failed: boolean,
  now = Date.now(),
): SubscriptionResultState {
  if (failed) return "unavailable";
  if (!value) return "confirming";
  if (value.billing_status === "refunded") return "refunded";
  if (value.settlement_state === "compensating") return "compensating";
  if (value.review_required) return "review";
  const paid = value.invoices?.some(
    (invoice) =>
      invoice.status === "paid" &&
      invoice.period_start &&
      invoice.period_end &&
      Date.parse(invoice.period_start) <= now &&
      Date.parse(invoice.period_end) > now,
  );
  if (paid && value.paid_until && Date.parse(value.paid_until) > now) {
    const due =
      value.grants?.filter((grant) => Date.parse(grant.due_at) <= now) ?? [];
    return (!value.settlement_state || value.settlement_state === "active") &&
      due.length && due.every((grant) => grant.status === "credited")
      ? "active"
      : "paid";
  }
  // A failed or cancelled authorization does not settle a payment in flight.
  // Keep checking until the payment itself reaches a definitive state.
  const paymentInFlight = value.has_pending_payment || value.invoices?.some(
    (invoice) => invoice.status === "processing",
  );
  if (
    paymentInFlight &&
    (value.billing_status === "failed" || value.authorization_status === "failed" ||
      value.checkout_state === "failed" || value.authorization_status === "cancelled")
  ) return "confirming";
  if (
    value.billing_status === "failed" ||
    value.authorization_status === "failed" ||
    value.checkout_state === "failed"
  )
    return "failed";
  if (value.authorization_status === "cancelled") return "cancelled";
  if (
    value.paid_until &&
    Date.parse(value.paid_until) <= now &&
    value.invoices?.some(
      (invoice) =>
        invoice.status === "paid" &&
        invoice.period_start &&
        invoice.period_end &&
        Date.parse(invoice.period_start) < Date.parse(invoice.period_end) &&
        Date.parse(invoice.period_end) <= now,
    )
  )
    return "expired";
  if (
    value.authorization_status === "pending" &&
    !value.checkout_url &&
    value.checkout_state === "unknown"
  )
    return "checkoutUnavailable";
  if (
    value.authorization_status === "pending" &&
    value.checkout_state === "ready" &&
    !value.paid_until
  ) return "awaitingPayment";
  return value.authorization_status === "active" ? "authorized" : "confirming";
}

export function subscriptionResultShouldPoll(value: Subscription | undefined): boolean {
  return ["confirming", "awaitingPayment", "authorized", "paid", "checkoutUnavailable", "compensating"]
    .includes(subscriptionResultState(value, false));
}

export function subscriptionResumeUrl(value: Subscription): string | null {
  if (
    value.payment_method === "dodo" || value.settlement_state === "compensating" ||
    value.settlement_state === "closed" || value.recovery_error || value.review_required || !value.auto_renew ||
    value.authorization_status !== "pending" || value.checkout_state !== "ready" ||
    !["pending", "processing"].includes(value.billing_status) ||
    value.paid_until || !value.checkout_url
  ) return null;
  try {
    return safeSubscriptionCheckout(value.checkout_url, value.payment_method);
  } catch {
    return null;
  }
}
