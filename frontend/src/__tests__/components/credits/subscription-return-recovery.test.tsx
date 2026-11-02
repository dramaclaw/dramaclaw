// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import { SubscriptionPaymentReturn } from "@/components/credits/SubscriptionPaymentReturn";
import { SubscriptionPanel } from "@/components/credits/SubscriptionPanel";
import { SubscriptionCheckout } from "@/components/credits/SubscriptionCheckout";
import { subscriptionResumeUrl } from "@/lib/subscription-checkout";
import type { Subscription } from "@/lib/queries/subscriptions";
import { useAuthStore } from "@/stores/auth-store";

vi.mock("@/lib/api", () => ({ api: ky.create({ prefix: "http://localhost:3000/" }) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@/lib/queries/credits", () => ({
  creditScopeOf: () => "personal", creditOrgOf: () => null,
  useCreditSummary: () => ({ isPending: false, data: { data: { scope: "personal" } } }),
}));
const endpoint = "http://localhost:3000/api/v1/payments/subscriptions";
const original = {
  subscription_id: "pending-dodo", plan_id: "dodo-plan", plan_version: 1,
  payment_method: "dodo", authorization_status: "pending", billing_status: "pending",
  checkout_state: "ready", checkout_url: "https://test.checkout.dodopayments.com/session/expired",
  auto_renew: true, paid_until: null, review_required: false, recovery_error: null,
  cancellation_requested_at: null, cancellation_confirmed_at: null,
  offer: { name: "Dodo monthly", billing_months: 1, grant_mode: "monthly", credits_per_month: 3000 },
  invoices: [], grants: [],
} as unknown as Subscription;
let row: Subscription;
let gets: number;
let refreshes: number;
let creates: number;
let client: QueryClient;
let view: ReturnType<typeof render> | undefined;

beforeEach(() => {
  row = structuredClone(original);
  gets = 0;
  refreshes = 0;
  creates = 0;
  useAuthStore.setState({ username: "recovery-user" });
  sessionStorage.setItem("dramaclaw-subscription-return", JSON.stringify({
    id: "pending-dodo", username: "recovery-user", planId: "dodo-plan", planVersion: 1,
  }));
  server.use(
    http.get(endpoint + "/pending-dodo", () => {
      gets++;
      return HttpResponse.json({ ok: true, data: row });
    }),
    http.get(endpoint, () => HttpResponse.json({ ok: true, data: { items: [row] } })),
    http.get(endpoint + "/plans", () => HttpResponse.json({ ok: true, data: { items: [{
      plan_id: "dodo-plan", version: 1, name: "Monthly", billing_months: 1,
      credits_per_month: 3000, grant_mode: "monthly", terms_agreement_id: "terms",
      terms_agreement_version: 1, offers: [{ payment_method: "dodo", currency: "CNY",
        amount_minor: 2900, payment_currency: "USD", payment_amount_minor: 414, fx_rate_snapshot: "7" }],
    }] } })),
    http.get(endpoint + "/membership", () => HttpResponse.json({ ok: true, data: { active: false } })),
    http.post(endpoint, () => { creates++; return HttpResponse.json({}, { status: 500 }); }),
  );
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  client?.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function mount(kind: "return" | "list" | "details" | "checkout" = "return") {
  if (kind === "checkout") {
    row.payment_method = "alipay";
    row.checkout_url = "https://openapi.alipay.com/authorize";
    server.use(http.get(endpoint + "/plans", () => HttpResponse.json({ ok: true, data: { items: [{
      plan_id: "dodo-plan", version: 1, name: "Monthly", billing_months: 1,
      credits_per_month: 3000, grant_mode: "monthly", terms_agreement_id: "terms",
      terms_agreement_version: 1, offers: [{ payment_method: "alipay", currency: "CNY", amount_minor: 2900 }],
    }] } })));
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  view = render(<QueryClientProvider client={client}>
    {kind === "checkout" ? <SubscriptionCheckout draft={{ kind: "subscription", planId: "dodo-plan", planVersion: 1, username: "recovery-user" }} /> :
    kind === "return" ? <SubscriptionPaymentReturn id="pending-dodo" /> :
      <SubscriptionPanel initialId={kind === "details" ? "pending-dodo" : null} />}
  </QueryClientProvider>);
}
function verifiedPaid(): Subscription {
  return {
    ...row, authorization_status: "active", billing_status: "paid",
    paid_until: "2099-11-28T00:00:00Z",
    invoices: [{ invoice_id: "paid-0", cycle_index: 0, status: "paid",
      period_start: "2020-01-01T00:00:00Z", period_end: "2099-11-28T00:00:00Z" }],
    grants: [{ month_index: 0, amount: 3000, due_at: "2020-01-01T00:00:00Z", status: "credited" }],
  } as Subscription;
}

it("shows a static incomplete signup state and manually queries the provider before showing paid benefits", async () => {
  server.use(http.post(endpoint + "/pending-dodo/refresh", () => {
    refreshes++;
    row = verifiedPaid();
    return HttpResponse.json({ ok: true, data: row });
  }));
  mount();
  await screen.findByRole("heading", { name: "subscriptionReturn.states.awaitingPayment.title" });
  expect(document.querySelector(".animate-spin")).not.toBeInTheDocument();
  expect(refreshes).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "paymentReturn.retry" }));
  await screen.findByRole("heading", { name: "subscriptionReturn.states.active.title" });
  expect(refreshes).toBe(1);
  expect(creates).toBe(0);
});

it("slows local polling after a minute and automatically observes backend recovery", async () => {
  vi.useFakeTimers();
  server.use(http.post(endpoint + "/pending-dodo/refresh", () => {
    refreshes++;
    return HttpResponse.json({ ok: true, data: row });
  }));
  mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await vi.waitFor(() => expect(screen.getByRole("heading", {
    name: "subscriptionReturn.states.awaitingPayment.title",
  })).toBeInTheDocument());
  for (let n = 0; n < 12; n++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(screen.getByRole("heading", { name: "subscriptionReturn.states.unconfirmed.title" })).toBeInTheDocument();
  expect(gets).toBeGreaterThan(1);
  const stopped = gets;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(gets).toBeGreaterThan(stopped);
  expect(gets).toBeLessThanOrEqual(stopped + 2);
  expect(refreshes).toBe(0);
  expect(creates).toBe(0);
  expect(screen.getByRole("button", { name: "paymentReturn.retry" })).toBeEnabled();
  row = verifiedPaid();
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByRole("heading", { name: "subscriptionReturn.states.active.title" })).toBeInTheDocument();
  expect(refreshes).toBe(0);
  expect(creates).toBe(0);
});

it("stops local polling once paid benefits are confirmed", async () => {
  vi.useFakeTimers();
  row = verifiedPaid();
  mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  await vi.waitFor(() => expect(screen.getByRole("heading", {
    name: "subscriptionReturn.states.active.title",
  })).toBeInTheDocument());
  const stopped = gets;
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(gets).toBe(stopped);
  expect(refreshes).toBe(0);
});

describe.each(["checkout"] as const)("%s resume entry", (kind) => {
  it.each([
    { name: "configuration error", patch: { recovery_error: "SUBSCRIPTION_PAYMENT_CONFIG_INVALID" }, notice: "subscriptions.recoveryConfigUnavailable" },
    { name: "query error", patch: { recovery_error: "DODO_SUBSCRIPTION_PROVIDER_UNAVAILABLE" }, notice: "subscriptions.recoveryUnavailable" },
    { name: "missing recovery link", patch: { checkout_url: null }, notice: "subscriptionCheckout.linkUnavailable" },
    { name: "unsafe recovery link", patch: { checkout_url: "https://attacker.example/payment" }, notice: "subscriptionCheckout.linkUnavailable" },
    { name: "cancellation", patch: { auto_renew: false }, notice: "subscriptionCheckout.linkUnavailable" },
    { name: "review required", patch: { review_required: true }, notice: "subscriptionCheckout.linkUnavailable" },
    { name: "payment confirmed meanwhile", patch: { authorization_status: "active", paid_until: "2099-11-28T00:00:00Z" }, notice: "subscriptionCheckout.linkUnavailable" },
  ])("refreshes first and never falls back to the old link on $name", async ({ patch, notice }) => {
    server.use(http.post(endpoint + "/pending-dodo/refresh", () => {
      refreshes++;
      row = { ...row, ...patch } as Subscription;
      return HttpResponse.json({ ok: true, data: row });
    }));
    const before = window.location.href;
    mount(kind);
    await vi.waitFor(() => expect(screen.getAllByRole("button", {
      name: "subscriptionCheckout.recover",
    }).length).toBeGreaterThanOrEqual(1));
    const buttons = screen.getAllByRole("button", { name: "subscriptionCheckout.recover" });
    fireEvent.click(buttons[0]);
    await screen.findAllByText(notice);
    expect(refreshes).toBe(1);
    expect(creates).toBe(0);
    expect(window.location.href).toBe(before);
    expect(document.querySelector(`a[href="${original.checkout_url}"]`)).not.toBeInTheDocument();
  });
});

it("keeps the checkout editable after a resume refresh fails", async () => {
  server.use(http.post(endpoint + "/pending-dodo/refresh", () => {
    refreshes++;
    return HttpResponse.json({}, { status: 503 });
  }));
  mount("checkout");
  fireEvent.click(await screen.findByRole("button", { name: "subscriptionCheckout.recover" }));
  await screen.findByText("subscriptions.recoveryUnavailable");
  expect(screen.getByRole("checkbox")).toBeEnabled();
  expect(screen.getByRole("button", { name: "subscriptionCheckout.recover" })).toBeEnabled();
  expect(refreshes).toBe(1);
  expect(creates).toBe(0);
});

it("accepts only the current verified response's pending checkout for navigation", () => {
  expect(subscriptionResumeUrl(original)).toBeNull(); // Dodo checkout URLs are single-use.
  const currentUrl = "https://openapi.alipay.com/authorize";
  const alipay = { ...original, payment_method: "alipay" as const, checkout_url: currentUrl };
  expect(subscriptionResumeUrl(alipay)).toBe(currentUrl);
  for (const patch of [
    { recovery_error: "provider_timeout" }, { checkout_state: "unknown" },
    { authorization_status: "active" }, { billing_status: "refunded", paid_until: "2026-01-01" },
    { auto_renew: false }, { review_required: true }, { checkout_url: "javascript:alert(1)" },
  ]) expect(subscriptionResumeUrl({ ...alipay, ...patch } as Subscription)).toBeNull();
});

it("shows the current paid bill number, not the subscription ID or next renewal bill", async () => {
  row = verifiedPaid();
  row.invoices![0].merchant_order_no = "DC_CURRENT_PAID_BILL";
  row.invoices!.push({ ...row.invoices![0], invoice_id: "internal-next",
    merchant_order_no: "DC_NEXT_RENEWAL", cycle_index: 1, status: "pending",
    period_start: "2099-11-28T00:00:00Z", period_end: "2099-12-28T00:00:00Z" });
  mount();
  expect(await screen.findByText("credits.recharge.columns.billId: DC_CURRENT_PAID_BILL")).toBeInTheDocument();
  expect(screen.queryByText(/DC_NEXT_RENEWAL/)).not.toBeInTheDocument();
  expect(screen.queryByText(/subscriptionReturn.number:/)).not.toBeInTheDocument();
});

it("shows automatic duplicate payment handling instead of activated benefits", async () => {
  row = { ...verifiedPaid(), settlement_state: "compensating" };
  mount();
  expect(await screen.findByRole("heading", { name: "subscriptionReturn.states.compensating.title" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "subscriptionReturn.states.active.title" })).not.toBeInTheDocument();
  expect(screen.queryByText(/subscriptions.paidUntil:/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "subscriptionReturn.manage" })).toBeEnabled();
});
