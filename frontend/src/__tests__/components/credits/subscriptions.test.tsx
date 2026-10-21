// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it.each(["unknown", "failed"])(
    "keeps the CNY price and handles Dodo create state %s",
    async (state) => {
      let submitted: Record<string, unknown> | undefined;
      const keys: string[] = [];
      const offer = {
        payment_method: "dodo",
        currency: "CNY",
        amount_minor: 6480,
        first_amount_minor: null,
        payment_amount_minor: 900,
        payment_currency: "USD",
        fx_rate_snapshot: "7.20000000",
      };
      server.use(
        http.get(
          "http://localhost:3000/api/v1/payments/subscriptions/plans",
          () =>
            HttpResponse.json({
              ok: true,
              data: {
                items: [
                  {
                    plan_id: "plan-dodo",
                    version: 1,
                    name: "Monthly CNY",
                    description: "",
                    billing_months: 1,
                    credits_per_month: 1500,
                    grant_mode: "monthly",
                    terms_url: "https://app.example.test/terms",
                    offers: [offer],
                  },
                ],
              },
            }),
        ),
        http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
          HttpResponse.json({ ok: true, data: { items: [] } }),
        ),
        http.post(
          "http://localhost:3000/api/v1/payments/subscriptions",
          async ({ request }) => {
            submitted = (await request.json()) as Record<string, unknown>;
            keys.push(request.headers.get("Idempotency-Key")!);
            return HttpResponse.json({
              ok: true,
              data: {
                checkout_url: null,
                subscription: {
                  subscription_id: "new-dodo-sub",
                  checkout_state: state,
                },
              },
            });
          },
        ),
        http.get(
          "http://localhost:3000/api/v1/payments/subscriptions/new-dodo-sub",
          () =>
            HttpResponse.json(
              { detail: "SUBSCRIPTION_QUERY_UNAVAILABLE" },
              { status: 503 },
            ),
        ),
      );
      const cleanup = mount();
      const purchase = await screen.findByRole("button", {
        name: "subscriptions.subscribe",
      });
      expect(screen.getByText(/64\.80/)).toBeInTheDocument();
      expect(screen.getByText("subscriptions.dodoQuote")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(purchase);
      await waitFor(() => expect(submitted).toBeDefined());
      expect(submitted).toMatchObject({
        plan_id: "plan-dodo",
        payment_method: "dodo",
        quote: {
          base_amount_cents: 6480,
          payment_amount_cents: 900,
          currency: "USD",
          cny_per_usd: "7.20000000",
        },
      });
      if (state === "failed") {
        await screen.findByText("subscriptions.creationRejected");
        await waitFor(() => expect(purchase).not.toBeDisabled());
        fireEvent.click(purchase);
        await waitFor(() => expect(keys).toHaveLength(2));
        expect(keys[0]).not.toBe(keys[1]);
      }
      cleanup();
    },
  );
  it("requires explicit consent and reuses the same request key after an unknown result", async () => {
    const keys: string[] = [];
    server.use(
      http.get(
        "http://localhost:3000/api/v1/payments/subscriptions/plans",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              items: [
                {
                  plan_id: "plan-1",
                  version: 1,
                  name: "Monthly",
                  description: "",
                  billing_months: 1,
                  credits_per_month: 1500,
                  grant_mode: "monthly",
                  terms_url: "https://app.example.test/terms",
                  offers: [
                    {
                      payment_method: "wxpay",
                      currency: "CNY",
                      amount_minor: 900,
                      first_amount_minor: null,
                    },
                  ],
                },
              ],
            },
          }),
      ),
      http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
        HttpResponse.json({ ok: true, data: { items: [] } }),
      ),
      http.post(
        "http://localhost:3000/api/v1/payments/subscriptions",
        async ({ request }) => {
          keys.push(request.headers.get("Idempotency-Key")!);
          expect(
            ((await request.json()) as { terms_accepted: boolean })
              .terms_accepted,
          ).toBe(true);
          return HttpResponse.json(
            { detail: "SUBSCRIPTION_GATEWAY_UNCONFIRMED" },
            { status: 503 },
          );
        },
      ),
    );
    const cleanup = mount();
    const purchase = await screen.findByRole("button", {
      name: "subscriptions.subscribe",
    });
    expect(purchase).toBeDisabled();
    expect(keys).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(purchase);
    await screen.findByText("subscriptions.createUnconfirmed");
    await waitFor(() => expect(purchase).not.toBeDisabled());
    fireEvent.click(purchase);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
    cleanup();
  });
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
  it("requires consent again when the configured FX quote changes before signing", async () => {
    let changed = false;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/payments/subscriptions/plans",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              items: [
                {
                  plan_id: "plan-dodo",
                  version: 1,
                  name: "Monthly CNY",
                  description: "",
                  billing_months: 1,
                  credits_per_month: 1500,
                  grant_mode: "monthly",
                  terms_url: "https://app.example.test/terms",
                  offers: [
                    {
                      payment_method: "dodo",
                      currency: "CNY",
                      amount_minor: 6480,
                      first_amount_minor: null,
                      payment_currency: "USD",
                      payment_amount_minor: changed ? 810 : 900,
                      fx_rate_snapshot: changed ? "8.00000000" : "7.20000000",
                    },
                  ],
                },
              ],
            },
          }),
      ),
      http.get("http://localhost:3000/api/v1/payments/subscriptions", () =>
        HttpResponse.json({ ok: true, data: { items: [] } }),
      ),
      http.post("http://localhost:3000/api/v1/payments/subscriptions", () => {
        changed = true;
        return HttpResponse.json(
          { detail: "SUBSCRIPTION_QUOTE_CHANGED" },
          { status: 409 },
        );
      }),
    );
    const cleanup = mount();
    const purchase = await screen.findByRole("button", {
      name: "subscriptions.subscribe",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(purchase);
    await screen.findByText("subscriptions.quoteChanged");
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(purchase).toBeDisabled();
    expect(
      screen.queryByText("subscriptions.createUnconfirmed"),
    ).not.toBeInTheDocument();
    cleanup();
  });
  it("displays a pending cancellation until the provider confirms it", () => {
    const record = {
      auto_renew: false,
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
