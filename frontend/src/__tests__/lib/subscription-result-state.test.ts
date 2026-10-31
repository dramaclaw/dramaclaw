import { describe, expect, it } from "vitest";
import {
  subscriptionResultState,
  subscriptionReturnId,
} from "@/lib/subscription-checkout";
import { subscriptionBlocksPurchase, type Subscription } from "@/lib/queries/subscriptions";

const now = Date.parse("2026-10-23T10:00:00Z");
const pending = {
  authorization_status: "pending",
  billing_status: "pending",
  checkout_state: "ready",
  checkout_url: "https://openapi.alipay.com/authorize",
  paid_until: null,
  review_required: false,
  invoices: [],
  grants: [],
} as unknown as Subscription;
const paid = {
  ...pending,
  authorization_status: "active",
  billing_status: "paid",
  paid_until: "2026-11-23T09:00:00Z",
  invoices: [
    {
      status: "paid",
      period_start: "2026-10-23T09:00:00Z",
      period_end: "2026-11-23T09:00:00Z",
    },
  ],
  grants: [
    { status: "credited", due_at: "2026-10-23T09:00:00Z", amount: 3000 },
  ],
} as Subscription;

it("separates a duplicate paid attempt from the active subscription", () => {
  const duplicate = { ...paid, settlement_state: "compensating" as const, review_required: true };
  expect(subscriptionResultState(duplicate, false, now)).toBe("compensating");
  expect(subscriptionBlocksPurchase(duplicate, now)).toBe(false);
  expect(subscriptionResultState({ ...paid, settlement_state: "open" }, false, now)).toBe("paid");
  expect(subscriptionResultState({ ...paid, settlement_state: "active" }, false, now)).toBe("active");
});

it.each(["pending", "ready", "unknown", "failed"] as const)("does not infer a purchase lock from an unpaid %s checkout", (checkout_state) => {
  expect(subscriptionBlocksPurchase({ ...pending, checkout_state }, now)).toBe(false);
  expect(subscriptionBlocksPurchase(paid, now)).toBe(true);
});

describe.each(["alipay", "wxpay", "dodo"] as const)(
  "%s payment result requires server evidence",
  (method) => {
    it.each([
      { name: "an order only", change: {} },
      {
        name: "an authorization only",
        change: { authorization_status: "active" },
      },
      {
        name: "a claimed paid flag without an invoice",
        change: { billing_status: "paid", paid_until: paid.paid_until },
      },
      {
        name: "a missing payment entry",
        change: { checkout_state: "unknown", checkout_url: null },
      },
    ])("never displays success for $name", ({ change }) => {
      const row = {
        ...pending,
        ...change,
        payment_method: method,
      } as Subscription;
      expect(["paid", "active"]).not.toContain(
        subscriptionResultState(row, false, now),
      );
    });
    it("does not trust success flags in the return URL", () => {
      expect(
        subscriptionReturnId(
          "?business_subscription_id=sub-owned&status=success&payment_status=paid&credits=3000",
        ),
      ).toBe("sub-owned");
      expect(
        subscriptionResultState(
          { ...pending, payment_method: method },
          false,
          now,
        ),
      ).toBe("awaitingPayment");
    });
    it("does not call an expired paid period an unpaid first payment", () => {
      expect(
        subscriptionResultState(
          {
            ...paid,
            payment_method: method,
            paid_until: "2026-10-23T09:00:00Z",
            invoices: [
              {
                ...paid.invoices![0]!,
                period_start: "2026-09-23T09:00:00Z",
                period_end: "2026-10-23T09:00:00Z",
              },
            ],
          },
          false,
          now,
        ),
      ).toBe("expired");
    });
    it("requires a paid invoice to describe an expired paid period", () => {
      expect(
        subscriptionResultState(
          {
            ...pending,
            payment_method: method,
            authorization_status: "active",
            paid_until: "2026-10-23T09:00:00Z",
          },
          false,
          now,
        ),
      ).toBe("authorized");
    });
    it("requires paid invoice and credited grants for active benefits", () => {
      const row = { ...paid, payment_method: method };
      expect(subscriptionResultState(row, false, now)).toBe("active");
      expect(subscriptionResultState({ ...row, grants: [] }, false, now)).toBe(
        "paid",
      );
      expect(
        subscriptionResultState({ ...row, invoices: [] }, false, now),
      ).not.toBe("active");
      expect(
        subscriptionResultState({ ...row, review_required: true }, false, now),
      ).toBe("review");
      expect(
        subscriptionResultState(
          { ...row, billing_status: "refunded" },
          false,
          now,
        ),
      ).toBe("refunded");
      expect(subscriptionResultState(row, true, now)).toBe("unavailable");
    });
  },
);
