// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export const CHECKOUT_DRAFT_KEY = "dramaclaw-checkout-draft";
export const CHECKOUT_RETURN_KEY = "dramaclaw-checkout-return";
export const PAYMENT_RETURN_ORDER_KEY = "dramaclaw-payment-return-order";
export const PAYMENT_RETURN_ORDER_ID_KEY = "dramaclaw-payment-return-order-id";
export const PAYMENT_ATTEMPT_KEY = "dramaclaw-payment-attempt";
export const OPEN_CREDIT_CENTER_KEY = "dramaclaw-open-credit-center";
export const CREDIT_CENTER_TAB_KEY = "dramaclaw-credit-center-tab";

type PaymentAttempt = {
  fingerprint: string;
  idempotencyKey: string;
};

export function paymentIdempotencyKey(prefix: string, fingerprint: string): string {
  try {
    const existing = JSON.parse(sessionStorage.getItem(PAYMENT_ATTEMPT_KEY) ?? "null") as unknown;
    if (existing && typeof existing === "object") {
      const attempt = existing as Partial<PaymentAttempt>;
      if (
        attempt.fingerprint === fingerprint &&
        typeof attempt.idempotencyKey === "string" &&
        attempt.idempotencyKey.startsWith(`${prefix}-`)
      ) {
        return attempt.idempotencyKey;
      }
    }
  } catch {
    // Invalid session state is replaced below.
  }
  const idempotencyKey = `${prefix}-${crypto.randomUUID()}`;
  sessionStorage.setItem(
    PAYMENT_ATTEMPT_KEY,
    JSON.stringify({ fingerprint, idempotencyKey } satisfies PaymentAttempt),
  );
  return idempotencyKey;
}

export function rememberPaymentOrder(order: {
  order_id: string;
  merchant_order_no: string;
}): void {
  sessionStorage.setItem(PAYMENT_RETURN_ORDER_KEY, order.merchant_order_no);
  sessionStorage.setItem(PAYMENT_RETURN_ORDER_ID_KEY, order.order_id);
}

export function clearPaymentAttempt(): void {
  sessionStorage.removeItem(PAYMENT_ATTEMPT_KEY);
}

export function safePaymentReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  if (value === "/checkout" || value.startsWith("/payment-return")) return "/";
  return value;
}

export function paymentOrderNumberFromSearch(search: string): string | null {
  const parameters = new URLSearchParams(search);
  for (const key of ["mchOrderNo", "out_trade_no", "merchant_order_no"]) {
    const value = parameters.get(key)?.trim();
    if (value) return value;
  }
  return null;
}
