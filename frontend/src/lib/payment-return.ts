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

export function resolvePaymentReturnState(
  order: RechargeOrder | undefined,
  queryFailed: boolean,
): PaymentReturnState {
  if (queryFailed) return "unavailable";
  if (!order) return "confirming";
  if (order.payment_status === "refunded" && order.fulfillment_status === "reversed") {
    return "refunded";
  }
  if (order.payment_status === "refunded" || order.fulfillment_status === "reversed") {
    return "manual_review";
  }
  if (order.fulfillment_status === "credited") return "credited";
  if (order.fulfillment_status === "failed") return "fulfillment_failed";
  if (["expired", "closed"].includes(order.payment_status)) return "closed";
  if (order.payment_status === "failed") return "failed";
  return "confirming";
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
