// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({
  api: ky.create({ prefix: "http://localhost:3000/" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
import { SubscriptionPanel } from "@/components/credits/SubscriptionPanel";
import {
  safeSubscriptionCheckout,
  subscriptionStatus,
  subscriptionAttemptKey,
  bindSubscriptionAttempt,
  forgetSubscriptionAttempt,
  type Subscription,
} from "@/lib/queries/subscriptions";
import { useAuthStore } from "@/stores/auth-store";

afterEach(() => {
  server.resetHandlers();
  sessionStorage.clear();
});
function mount() {
  server.use(
    http.get(
      "http://localhost:3000/api/v1/payments/subscriptions/membership",
      () => HttpResponse.json({ ok: true, data: { active: false } }),
    ),
  );
  useAuthStore.setState({ username: "test-user" });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SubscriptionPanel />
    </QueryClientProvider>,
  );
  return () => {
    view.unmount();
    client.clear();
  };
}
describe("subscription purchase", () => {
  it("does not call subscription APIs when the payment surface is disabled", () => {
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <SubscriptionPanel enabled={false} />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("subscriptions.title")).not.toBeInTheDocument();
    view.unmount();
    client.clear();
  });
  it("displays a pending cancellation until the provider confirms it", () => {
    const record = {
      auto_renew: false,
      authorization_status: "active",
      cancellation_confirmed_at: null,
      review_required: false,
    } as Subscription;
    expect(subscriptionStatus(record)).toBe("cancelling");
    expect(
      subscriptionStatus({
        ...record,
        cancellation_confirmed_at: "2026-10-01T00:00:00Z",
      }),
    ).toBe("cancelled");
    expect(
      subscriptionStatus({ ...record, authorization_status: "failed" }),
    ).toBe("paymentFailed");
  });
  it("distinguishes cancelling an unconfirmed signup from an existing agreement", () => {
    const record = {
      auto_renew: false,
      authorization_status: "pending",
      checkout_state: "unknown",
      paid_until: null,
      cancellation_confirmed_at: null,
      review_required: false,
    } as Subscription;
    expect(subscriptionStatus(record)).toBe("cancellingSetup");
    expect(
      subscriptionStatus({ ...record, authorization_status: "active" }),
    ).toBe("cancelling");
    expect(
      subscriptionStatus({ ...record, paid_until: "2026-10-01T00:00:00Z" }),
    ).toBe("cancelling");
    expect(
      subscriptionStatus({
        ...record,
        cancellation_confirmed_at: "2026-10-22T02:11:38Z",
      }),
    ).toBe("cancelled");
  });
  it("an old cancelled subscription cannot clear a new unknown purchase key", () => {
    const key = subscriptionAttemptKey("test-user", "plan-1", 1, "wxpay");
    bindSubscriptionAttempt(
      "test-user",
      "plan-1",
      1,
      "wxpay",
      "new-subscription",
    );
    forgetSubscriptionAttempt(
      "test-user",
      "plan-1",
      1,
      "wxpay",
      "old-cancelled-subscription",
    );
    expect(subscriptionAttemptKey("test-user", "plan-1", 1, "wxpay")).toBe(key);
    forgetSubscriptionAttempt(
      "test-user",
      "plan-1",
      1,
      "wxpay",
      "new-subscription",
    );
    expect(subscriptionAttemptKey("test-user", "plan-1", 1, "wxpay")).not.toBe(
      key,
    );
  });
  it.each([
    "javascript:alert(1)",
    "https://checkout.dodopayments.com.attacker.test/pay",
    "https://u@checkout.dodopayments.com/pay",
    "https://checkout.dodopayments.com/pay#x",
  ])("rejects unsafe checkout %s", (url) => {
    expect(() => safeSubscriptionCheckout(url, "dodo")).toThrow();
  });
});

it("shows an incomplete signup without an empty paid membership period", async () => {
  const row = {
    subscription_id: "unconfirmed-signup",
    payment_method: "wxpay",
    auto_renew: false,
    authorization_status: "pending",
    billing_status: "pending",
    checkout_state: "unknown",
    paid_until: null,
    cancellation_confirmed_at: null,
    review_required: false,
    offer: { name: "Monthly", amount_minor: 1000, currency: "CNY" },
  };
  server.use(
    http.get("http://localhost:3000/api/v1/payments/subscriptions/plans", () =>
      HttpResponse.json({ ok: true, data: { items: [] } }),
    ),
    http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
      HttpResponse.json({ ok: true, data: { items: [row] } }),
    ),
  );
  const unmount = mount();
  await screen.findByText("subscriptions.status.cancellingSetup");
  expect(screen.getByRole("status")).toHaveTextContent(
    "subscriptions.purchaseBlocked",
  );
  expect(screen.queryByText(/subscriptions.paidUntil/)).not.toBeInTheDocument();
  expect(
    screen.queryByText("subscriptions.status.cancelled"),
  ).not.toBeInTheDocument();
  unmount();
});

it.each([false, true])(
  "keeps an unresolved signup blocked and restores purchase after a verified preflight failure (resolved=%s)",
  async (resolved) => {
    const plan = {
      plan_id: "monthly-plan",
      version: 1,
      name: "Monthly",
      description: "For creators",
      billing_months: 1,
      credits_per_month: 3000,
      grant_mode: "monthly",
      terms_url: "https://app.example.test/terms",
      offers: [
        {
          payment_method: "wxpay",
          currency: "CNY",
          amount_minor: 2900,
          first_amount_minor: null,
        },
      ],
    };
    const row = {
      subscription_id: "preflight-signup",
      plan_id: plan.plan_id,
      plan_version: 1,
      payment_method: "wxpay",
      auto_renew: false,
      authorization_status: resolved ? "failed" : "pending",
      billing_status: "pending",
      checkout_state: resolved ? "failed" : "unknown",
      paid_until: null,
      cancellation_confirmed_at: resolved ? "2026-10-22T09:00:00Z" : null,
      review_required: false,
      offer: { ...plan, ...plan.offers[0] },
      invoices: [
        {
          invoice_id: "preflight-invoice",
          status: resolved ? "closed" : "processing",
          amount_minor: 2900,
          currency: "CNY",
          payment_currency: "CNY",
          period_start: null,
          period_end: null,
        },
      ],
    };
    server.use(
      http.get(
        "http://localhost:3000/api/v1/payments/subscriptions/plans",
        () => HttpResponse.json({ ok: true, data: { items: [plan] } }),
      ),
      http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
        HttpResponse.json({ ok: true, data: { items: [row] } }),
      ),
      http.get(
        "http://localhost:3000/api/v1/payments/subscriptions/preflight-signup",
        () => HttpResponse.json({ ok: true, data: row }),
      ),
    );
    const unmount = mount();
    await screen.findByText(
      resolved
        ? "subscriptions.status.setupFailed"
        : "subscriptions.status.cancellingSetup",
    );
    const subscribe = await screen.findByRole("button", {
      name: "subscriptions.subscribe",
    });
    expect(subscribe).toHaveProperty("disabled", !resolved);
    expect(!!screen.queryByText("subscriptions.purchaseBlocked")).toBe(
      !resolved,
    );
    expect(
      screen.queryByText("subscriptions.status.paymentFailed"),
    ).not.toBeInTheDocument();
    if (resolved) {
      fireEvent.click(
        screen.getByRole("button", { name: "subscriptions.details" }),
      );
      await screen.findByText("subscriptions.invoiceStatus.closed");
    }
    unmount();
  },
);

it("exposes one deliberate Dodo renewal retry without automatic POST retries", async () => {
  let calls = 0;
  const row = {
    subscription_id: "retry-sub",
    payment_method: "dodo",
    auto_renew: true,
    authorization_status: "active",
    billing_status: "failed",
    review_required: false,
    checkout_state: "ready",
    paid_until: "2026-01-01T00:00:00Z",
    offer: { name: "Monthly", amount_minor: 1000, currency: "CNY" },
  };
  server.use(
    http.get("http://localhost:3000/api/v1/payments/subscriptions/plans", () =>
      HttpResponse.json({ ok: true, data: { items: [] } }),
    ),
    http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
      HttpResponse.json({ ok: true, data: { items: [row] } }),
    ),
    http.post(
      "http://localhost:3000/api/v1/payments/subscriptions/retry-sub/retry",
      () => {
        calls++;
        return HttpResponse.json({ detail: "UNCONFIRMED" }, { status: 503 });
      },
    ),
  );
  const unmount = mount();
  fireEvent.click(await screen.findByText("subscriptions.retryPayment"));
  await screen.findByText("subscriptions.retryUnconfirmed");
  expect(calls).toBe(1);
  unmount();
});
