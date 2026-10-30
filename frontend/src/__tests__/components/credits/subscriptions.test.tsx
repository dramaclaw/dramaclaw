// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubscriptionPanel } from "@/components/credits/SubscriptionPanel";
import { BillingOrdersTab } from "@/components/credits/BillingOrdersTab";
import { safeSubscriptionCheckout, subscriptionStatus, subscriptionAttemptKey,
  bindSubscriptionAttempt, forgetSubscriptionAttempt, useRetrySubscription,
  type Subscription } from "@/lib/queries/subscriptions";
import { useAuthStore } from "@/stores/auth-store";
import { CHECKOUT_DRAFT_KEY } from "@/lib/payment-navigation";
vi.mock("@/lib/api", () => ({ api: ky.create({ prefix: "http://localhost:3000/" }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));
const endpoint = "http://localhost:3000/api/v1/payments/subscriptions";
let client: QueryClient;
let view: ReturnType<typeof render> | undefined;
afterEach(() => { view?.unmount(); client?.clear(); server.resetHandlers(); sessionStorage.clear(); });
function mount(billing = false) {
  useAuthStore.setState({ username: "test-user" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view = render(<QueryClientProvider client={client}>
    {billing ? <BillingOrdersTab orders={[]} loading={false} language="en" enabled /> : <SubscriptionPanel />}
  </QueryClientProvider>);
}
// Invoices now live in the billing tab; the catalog no longer contains the old
// details accordion or manual recovery controls.
it.each([
  ["pending", "pending", "pending"], ["active", "processing", "unconfirmed"],
  ["active", "paid", "paid"], ["cancelled", "refunded", "refunded"],
  ["pending", "failed", "failed"], ["failed", "closed", "closed"],
])("renders invoice facts for authorization %s / payment %s", async (authorization, status, label) => {
  server.use(http.get(endpoint + "/billing", () => HttpResponse.json({ ok: true, data: { items: [{
    subscription_id: "invoice-sub", authorization_status: authorization, checkout_state: "ready",
    offer: { name: "Monthly" }, invoices: [{ invoice_id: "internal-invoice", merchant_order_no: "DC_BILL",
      cycle_index: 0, status, payment_amount_minor: 500, payment_currency: "USD",
      provider_total_minor: status === "paid" || status === "refunded" ? 550 : null,
      created_at: "2026-10-29T00:00:00Z" }],
  }] } })));
  mount(true);
  const table = await screen.findByRole("table");
  expect(within(table).getByText("subscriptions.bill." + label)).toBeInTheDocument();
  expect(within(table).getByText("DC_BILL")).toBeInTheDocument();
  expect(within(table).getByText(status === "paid" || status === "refunded" ? "$5.5" : "$5")).toBeInTheDocument();
  expect(within(table).queryByText("internal-invoice")).not.toBeInTheDocument();
});
it.each(["paid_at", "payment_id"])("does not relabel processing as paid from %s alone", async (evidence) => {
  server.use(http.get(endpoint + "/billing", () => HttpResponse.json({ ok: true, data: { items: [{
    subscription_id: "invoice-sub", offer: { name: "Monthly" }, invoices: [{ invoice_id: "invoice",
      status: "processing", payment_amount_minor: 500, payment_currency: "USD", [evidence]: "present" }],
  }] } })));
  mount(true);
  expect(await screen.findByText("subscriptions.bill.unconfirmed")).toBeInTheDocument();
  expect(screen.queryByText("subscriptions.bill.paid")).not.toBeInTheDocument();
});
it("shows a ready but unpaid checkout as awaiting payment even when its creation was submitted", async () => {
  server.use(http.get(endpoint + "/billing", () => HttpResponse.json({ ok: true, data: { items: [{
    subscription_id: "ready-session", checkout_state: "ready", checkout_session_id: "checkout-session",
    checkout_started_at: "2026-10-29T00:00:00Z", offer: { name: "Monthly" }, invoices: [{
      invoice_id: "invoice", cycle_index: 0, status: "pending", submitted_at: "2026-10-29T00:00:00Z",
      payment_amount_minor: 500, payment_currency: "USD",
    }],
  }] } })));
  mount(true);
  expect(await screen.findByText("subscriptions.bill.pending")).toBeInTheDocument();
  expect(screen.queryByText("subscriptions.bill.unconfirmed")).not.toBeInTheDocument();
});
it("keeps a duplicate payment amount visible while compensation is pending", async () => {
  server.use(http.get(endpoint + "/billing", () => HttpResponse.json({ ok: true, data: { items: [{
    subscription_id: "duplicate", settlement_state: "compensating", offer: { name: "Monthly" }, invoices: [{
      invoice_id: "duplicate-invoice", status: "paid", payment_amount_minor: 500,
      payment_currency: "USD", provider_total_minor: 550,
    }],
  }] } })));
  mount(true);
  expect(await screen.findByText("subscriptions.bill.compensating")).toBeInTheDocument();
  expect(screen.getByText("$5.5")).toBeInTheDocument();
  expect(screen.queryByText("subscriptions.bill.failed")).not.toBeInTheDocument();
});
it("reads released purchase access and lets the next catalog selection proceed", async () => {
  let blocked = true;
  const plan = { plan_id: "monthly", version: 1, name: "Monthly", billing_months: 1,
    credits_per_month: 3000, grant_mode: "monthly", offers: [{ payment_method: "wxpay", amount_minor: 2900, currency: "CNY" }] };
  server.use(
    http.get(endpoint + "/plans", () => HttpResponse.json({ ok: true, data: { items: [plan] } })),
    http.get(endpoint + "/membership", () => HttpResponse.json({ ok: true, data: { active: false } })),
    http.get(endpoint, () => HttpResponse.json({ ok: true, data: { items: [{ subscription_id: "old-attempt", purchase_blocked: blocked }] } })),
  );
  mount();
  const action = await screen.findByRole("button", { name: "subscriptions.subscribe" });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.click(action);
  expect(await screen.findByText("subscriptionCheckout.existing")).toBeInTheDocument();
  expect(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)).toBeNull();
  blocked = false;
  await client.invalidateQueries({ queryKey: ["subscriptions", "test-user", "list"] });
  await waitFor(() => expect(client.getQueryData<{ data: { items: { purchase_blocked: boolean }[] } }>(["subscriptions", "test-user", "list"])?.data.items[0].purchase_blocked).toBe(false));
  fireEvent.click(action);
  await waitFor(() => expect(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)).toContain('"planId":"monthly"'));
});
it("does not automatically retry a Dodo renewal POST after a network failure", async () => {
  let calls = 0;
  server.use(http.post(endpoint + "/retry-sub/retry", () => { calls++; return HttpResponse.json({ detail: "UNCONFIRMED" }, { status: 503 }); }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useRetrySubscription(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await act(async () => { await expect(hook.result.current.mutateAsync("retry-sub")).rejects.toThrow(); });
  expect(calls).toBe(1);
  hook.unmount();
});
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
