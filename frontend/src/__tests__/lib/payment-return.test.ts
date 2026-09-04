// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPaymentAttempt,
  paymentIdempotencyKey,
  paymentOrderNumberFromSearch,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
  rememberPaymentOrder,
  safePaymentReturnPath,
} from "@/lib/payment-navigation";
import {
  paymentTimeRemaining,
  paymentWindowExpired,
  resolvePaymentReturnState,
} from "@/lib/payment-return";
import type { RechargeOrder } from "@/lib/queries/payments";

function order(overrides: Partial<RechargeOrder> = {}): RechargeOrder {
  return {
    order_id: "order-1",
    merchant_order_no: "DC-ORDER-1",
    order_type: "personal_recharge",
    org_id: null,
    package_name: "PRO",
    amount_cents: 100,
    base_credits: 100,
    gift_credits: 0,
    currency: "CNY",
    payment_method: "alipay",
    payment_status: "pending",
    fulfillment_status: "pending",
    failure_code: null,
    expires_at: "2026-08-26T12:00:00Z",
    paid_at: null,
    fulfilled_at: null,
    created_at: "2026-08-26T11:50:00Z",
    updated_at: "2026-08-26T11:50:00Z",
    ...overrides,
  };
}

describe("payment return state", () => {
  it("only reports success after server-side fulfillment", () => {
    expect(resolvePaymentReturnState(order(), false)).toBe("confirming");
    expect(
      resolvePaymentReturnState(
        order({ payment_status: "paid", fulfillment_status: "processing" }),
        false,
      ),
    ).toBe("confirming");
    expect(
      resolvePaymentReturnState(
        order({ payment_status: "paid", fulfillment_status: "credited" }),
        false,
      ),
    ).toBe("credited");
  });

  it("distinguishes payment, fulfillment, and refund failures", () => {
    expect(resolvePaymentReturnState(order({ payment_status: "expired" }), false)).toBe("closed");
    expect(resolvePaymentReturnState(order({ payment_status: "closed" }), false)).toBe("closed");
    expect(resolvePaymentReturnState(order({ payment_status: "failed" }), false)).toBe("failed");
    expect(resolvePaymentReturnState(order({ fulfillment_status: "failed" }), false)).toBe(
      "fulfillment_failed",
    );
    expect(resolvePaymentReturnState(order({ payment_status: "refunded" }), false)).toBe(
      "manual_review",
    );
    expect(resolvePaymentReturnState(order({ fulfillment_status: "reversed" }), false)).toBe(
      "manual_review",
    );
    expect(
      resolvePaymentReturnState(
        order({ payment_status: "refunded", fulfillment_status: "reversed" }),
        false,
      ),
    ).toBe("refunded");
  });
});

describe("payment expiry presentation", () => {
  it("counts down against the server supplied expiry timestamp", () => {
    const now = Date.parse("2026-08-26T11:50:00Z");
    expect(paymentTimeRemaining("2026-08-26T12:00:00Z", now)).toBe("10:00");
    expect(paymentWindowExpired("2026-08-26T12:00:00Z", now)).toBe(false);
    expect(paymentTimeRemaining("2026-08-26T11:49:59Z", now)).toBe("00:00");
    expect(paymentWindowExpired("2026-08-26T11:49:59Z", now)).toBe(true);
  });
});

describe("payment return navigation", () => {
  beforeEach(() => sessionStorage.clear());

  it("reads supported merchant order number parameters", () => {
    expect(paymentOrderNumberFromSearch("?mchOrderNo=DC1")).toBe("DC1");
    expect(paymentOrderNumberFromSearch("?out_trade_no=DC2")).toBe("DC2");
  });

  it("only permits safe in-app return paths", () => {
    expect(safePaymentReturnPath("/projects/demo")).toBe("/projects/demo");
    expect(safePaymentReturnPath("https://evil.example")).toBe("/");
    expect(safePaymentReturnPath("//evil.example")).toBe("/");
    expect(safePaymentReturnPath("/payment-return?state=2")).toBe("/");
  });

  it("reuses an idempotency key for the same payment draft", () => {
    const first = paymentIdempotencyKey("checkout", "package-a:alipay");
    const retry = paymentIdempotencyKey("checkout", "package-a:alipay");
    const changed = paymentIdempotencyKey("checkout", "package-a:wxpay");

    expect(retry).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("records the order before checkout navigation and clears only the attempt", () => {
    rememberPaymentOrder({ order_id: "order-1", merchant_order_no: "DC-1" });
    paymentIdempotencyKey("checkout", "package-a:alipay");

    expect(sessionStorage.getItem(PAYMENT_RETURN_ORDER_ID_KEY)).toBe("order-1");
    expect(sessionStorage.getItem(PAYMENT_RETURN_ORDER_KEY)).toBe("DC-1");
    clearPaymentAttempt();
    expect(sessionStorage.getItem(PAYMENT_RETURN_ORDER_ID_KEY)).toBe("order-1");
  });
});
