// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import { BillingOrdersTab } from "@/components/credits/BillingOrdersTab";
import { useAuthStore } from "@/stores/auth-store";

vi.mock("@/lib/api", () => ({ api: ky.create({ prefix: "http://localhost:3000/", retry: 0 }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const endpoint = "http://localhost:3000/api/v1/payments/subscriptions/billing";
let status: "processing" | "failed" | "paid";
let unavailable: boolean;
let gets: number;
let client: QueryClient;
let view: ReturnType<typeof render> | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  status = "processing";
  unavailable = false;
  gets = 0;
  useAuthStore.setState({ username: "billing-recovery-user" });
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  server.use(http.get(endpoint, () => {
    gets++;
    if (unavailable) return HttpResponse.json({}, { status: 503 });
    return HttpResponse.json({ ok: true, data: { items: [{
      subscription_id: "subscription", offer: { name: "Monthly" }, invoices: [{
        invoice_id: "invoice", merchant_order_no: "DC_BILL", cycle_index: 0, status,
        payment_amount_minor: 2900, payment_currency: "CNY",
        created_at: "2026-10-29T00:00:00Z", submitted_at: "2026-10-29T00:00:01Z",
      }],
    }] } });
  }));
});

afterEach(() => {
  view?.unmount();
  client?.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

async function mount() {
  // Match the app defaults: a test client with staleTime=0 would hide stale
  // billing data when the user returns from a payment page or another tab.
  client = new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: Infinity, staleTime: 30_000, refetchOnWindowFocus: false,
  } } });
  view = render(<QueryClientProvider client={client}>
    <BillingOrdersTab orders={[]} loading={false} language="en" enabled />
  </QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByText("subscriptions.bill.unconfirmed")).toBeInTheDocument();
}

it.each(["failed", "paid"] as const)("automatically replaces an unconfirmed invoice with %s without a manual refresh", async (resolved) => {
  await mount();
  status = resolved;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText(`subscriptions.bill.${resolved}`)).toBeInTheDocument();
  expect(screen.queryByText("subscriptions.bill.unconfirmed")).not.toBeInTheDocument();
  expect(gets).toBe(2);
});

it("keeps polling after a billing query fails and observes the server recovery", async () => {
  await mount();
  unavailable = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText("subscriptions.loadError")).toBeInTheDocument();
  expect(screen.getByText("subscriptions.bill.unconfirmed")).toBeInTheDocument();
  unavailable = false;
  status = "failed";
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(screen.getByText("subscriptions.bill.failed")).toBeInTheDocument();
  expect(screen.queryByText("subscriptions.loadError")).not.toBeInTheDocument();
  expect(gets).toBe(3);
});

it.each(["focus", "reconnect"] as const)("refreshes a recent cached invoice immediately on %s", async (event) => {
  await mount();
  status = "failed";
  await act(async () => {
    if (event === "focus") {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    } else {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    }
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(screen.getByText("subscriptions.bill.failed")).toBeInTheDocument();
  expect(gets).toBe(2);
});
