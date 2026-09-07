// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { RechargeOrder } from "@/lib/queries/payments";

export type PaymentReturnState =
  | "confirming"
  | "credited"
  | "closed"
  | "failed"
  | "fulfillment_failed"
  | "manual_review"
  | "refunded"
  | "unavailable";

export type RechargeOrderStatus =
  | RechargeOrder["payment_status"]
  | "credited"
  | "creditFailed"
  | "manualReview";

export function resolveRechargeOrderStatus(order: RechargeOrder): RechargeOrderStatus {
  if (order.payment_status === "refunded" && order.fulfillment_status === "reversed") {
    return "refunded";
  }
  if (order.payment_status === "refunded" || order.fulfillment_status === "reversed") {
    return "manualReview";
  }
  if (order.fulfillment_status === "credited") {
    return order.payment_status === "paid" ? "credited" : "manualReview";
  }
  // Closing an unpaid order can also fail fulfillment; it does not imply payment.
  if (order.payment_status === "paid" && order.fulfillment_status === "failed") {
    return "creditFailed";
  }
  return order.payment_status;
}

export function resolvePaymentReturnState(
  order: RechargeOrder | undefined,
  queryFailed: boolean,
): PaymentReturnState {
  if (queryFailed) return "unavailable";
  if (!order) return "confirming";
  switch (resolveRechargeOrderStatus(order)) {
    case "credited": return "credited";
    case "creditFailed": return "fulfillment_failed";
    case "manualReview": return "manual_review";
    case "refunded": return "refunded";
    case "expired":
    case "closed": return "closed";
    case "failed": return "failed";
    default: return "confirming";
  }
}

export function paymentTimeRemaining(expiresAt: string, nowMs: number): string {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return "00:00";
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function paymentWindowExpired(expiresAt: string, nowMs: number): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
}
