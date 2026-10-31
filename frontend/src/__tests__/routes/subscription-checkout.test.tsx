// SPDX-License-Identifier: Elastic-2.0
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/__mocks__/msw/server";
import { zhT } from "@/__tests__/helpers/i18n-fixtures";
import { useAuthStore } from "@/stores/auth-store";
import { CHECKOUT_DRAFT_KEY } from "@/lib/payment-navigation";
import { queryKeys } from "@/lib/query-keys";
import { CheckoutPage } from "@/routes/checkout";
import { SubscriptionPanel } from "@/components/credits/SubscriptionPanel";
import { PaymentReturnPage } from "@/routes/_app/payment-return";
import { subscriptionResultState } from "@/lib/subscription-checkout";
import { bindSubscriptionAttempt, subscriptionAttemptKey, type Subscription } from "@/lib/queries/subscriptions";

vi.mock("@/lib/api", () => ({
  api: ky.create({ prefix: "http://localhost:3000/" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: zhT, i18n: { language: "zh" } }),
}));
vi.mock("@/lib/queries/credits", () => ({
  creditScopeOf: () => "personal",
  useCreditSummary: () => ({
    isPending: false,
    data: { data: { scope: "personal" } },
  }),
  creditOrgOf: () => null,
}));

const plan = {
  plan_id: "plan-annual",
  version: 1,
  name: "基础年付",
  description: "年度订阅",
  billing_months: 12,
  credits_per_month: 1000,
  grant_mode: "monthly",
  terms_url: "https://app.example.test/terms",
  terms_agreement_id: "terms-test",
  terms_agreement_version: 1,
  terms_content_hash: "a".repeat(64),
  offers: [
    {
      payment_method: "alipay",
      amount_minor: 120000,
      first_amount_minor: null,
      currency: "CNY",
    },
    {
      payment_method: "wxpay",
      amount_minor: 120000,
      first_amount_minor: null,
      currency: "CNY",
    },
    {
      payment_method: "dodo",
      amount_minor: 120000,
      first_amount_minor: null,
      currency: "CNY",
      payment_currency: "USD",
      payment_amount_minor: 16667,
      fx_rate_snapshot: "7.2",
    },
  ],
};
let view: ReturnType<typeof render> | undefined;
let client: QueryClient;
let submitted: Record<string, unknown>[];
let keys: string[];
let onceCalls: number;
let currentPlan: typeof plan;
const endpoint = "http://localhost:3000/api/v1/payments/";
const surfacesEndpoint = "http://localhost:3000/api/v1/product-surfaces/me";
function surfaceResponse(available = true) {
  return HttpResponse.json({ ok: true, data: { items: [{
    surface_code: "payment", label: "积分充值", available,
    unavailable_message: "订阅及积分购买仅对测试组开放",
  }] } });
}
beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem(
    CHECKOUT_DRAFT_KEY,
    JSON.stringify({
      kind: "subscription",
      planId: plan.plan_id,
      planVersion: 1,
      username: "test-user",
    }),
  );
  useAuthStore.setState({ username: "test-user" });
  currentPlan = structuredClone(plan);
  submitted = [];
  keys = [];
  onceCalls = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  server.use(
    http.get(surfacesEndpoint, () => surfaceResponse()),
    http.get(endpoint + "subscriptions/plans", () =>
      HttpResponse.json({ ok: true, data: { items: [currentPlan] } }),
    ),
    http.get(endpoint + "subscriptions", () =>
      HttpResponse.json({ ok: true, data: { items: [] } }),
    ),
    http.get(endpoint + "subscriptions/membership", () =>
      HttpResponse.json({ ok: true, data: { active: false } }),
    ),
    http.get(
      "*/api/v1/payments/subscriptions/agreements/terms-test/versions/:version",
      ({ params }) => {
        const version = Number(params.version);
        return HttpResponse.json({
          ok: true,
          data: {
            agreement_id: "terms-test",
            version,
            title: `测试订阅协议 v${version}`,
            body: `协议正文版本 ${version}`,
            effective_at: "2020-01-01T00:00:00Z",
            content_hash: (version === 2 ? "b" : "a").repeat(64),
          },
        });
      },
    ),
    http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push((await request.json()) as Record<string, unknown>);
      keys.push(request.headers.get("Idempotency-Key")!);
      return HttpResponse.json(
        { detail: "SUBSCRIPTION_GATEWAY_UNCONFIRMED" },
        { status: 503 },
      );
    }),
    http.get(endpoint + "packages", () => {
      onceCalls++;
      return HttpResponse.json({}, { status: 503 });
    }),
    http.get(endpoint + "orders", () => {
      onceCalls++;
      return HttpResponse.json({}, { status: 503 });
    }),
  );
});
afterEach(() => {
  view?.unmount();
  client.clear();
  server.resetHandlers();
  window.history.replaceState({}, "", "/");
});
function mount(content = <CheckoutPage />) {
  view = render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
}
function restoreFromBrowserCache() {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  fireEvent(window, event);
}

describe("subscription checkout", () => {
  it.each([
    { kind: "subscription", planId: "plan-annual", planVersion: 1, username: "test-user" },
    { kind: "package", packageId: "package-a" },
    { kind: "custom", credits: 3000 },
  ])("applies payment entry visibility to a saved $kind checkout", async (draft) => {
    const paymentRequests: string[] = [];
    server.use(
      http.get(surfacesEndpoint, () => surfaceResponse(false)),
      http.all(endpoint + "*", ({ request }) => {
        paymentRequests.push(request.url);
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft));
    mount();
    expect(await screen.findByText("订阅及积分购买仅对测试组开放")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认订阅并前往支付" })).not.toBeInTheDocument();
    expect(paymentRequests).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    expect(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)).toBe(JSON.stringify(draft));
  });

  it("waits for entry visibility before loading subscription plans", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    let planReads = 0;
    server.use(
      http.get(surfacesEndpoint, async () => { await ready; return surfaceResponse(); }),
      http.get(endpoint + "subscriptions/plans", () => {
        planReads++;
        return HttpResponse.json({ ok: true, data: { items: [currentPlan] } });
      }),
    );
    mount();
    try {
      expect(screen.getByRole("status")).toHaveTextContent(zhT("checkout.loading"));
      expect(planReads).toBe(0);
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    } finally {
      release();
    }
    expect(await screen.findByRole("button", { name: "确认订阅并前往支付" })).toBeDisabled();
    expect(planReads).toBe(1);
  });

  it.each(["failed", "missing"])("keeps checkout unavailable when entry configuration is %s and allows retry", async (reason) => {
    let reads = 0;
    server.use(http.get(surfacesEndpoint, () => {
      reads++;
      if (reads > 1) return surfaceResponse();
      return reason === "failed"
        ? HttpResponse.json({}, { status: 503 })
        : HttpResponse.json({ ok: true, data: { items: [] } });
    }));
    mount();
    expect(await screen.findByText(zhT(reason === "failed" ? "productSurface.statusUnknown" : "productSurface.misconfigured"))).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(submitted).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByRole("button", { name: "确认订阅并前往支付" })).toBeDisabled();
    expect(reads).toBe(2);
  });

  it("removes an open checkout when the shared visibility becomes unavailable", async () => {
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    server.use(http.get(surfacesEndpoint, () => surfaceResponse(false)));
    await client.invalidateQueries({ queryKey: queryKeys.productSurfaces() });
    expect(await screen.findByText("订阅及积分购买仅对测试组开放")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认订阅并前往支付" })).not.toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });

  it("clears consent when only the agreement version changes", async () => {
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(action).toBeEnabled());
    currentPlan = {
      ...currentPlan,
      terms_agreement_version: 2,
      terms_content_hash: "b".repeat(64),
      terms_url: "/terms/subscription/terms-test/2",
    };
    await client.invalidateQueries({ queryKey: ["subscriptions"] });
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "订阅服务协议" }));
    expect(await screen.findByText("协议正文版本 2")).toBeInTheDocument();
    expect(action).toBeDisabled();
    expect(submitted).toHaveLength(0);
  });

  it("does not allow a plan without published agreement metadata", async () => {
    currentPlan = { ...currentPlan, terms_agreement_id: "" };
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeDisabled();
    expect(
      await screen.findByText(/尚未关联已发布的服务协议/),
    ).toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });
  it("keeps channels, contact fields and consent off the plan cards", async () => {
    mount(<SubscriptionPanel />);
    expect(await screen.findByRole("button", { name: /^订阅$/ })).toBeEnabled();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });
  it.each(["unknown", "failed"])("stays on checkout when creation returns %s without a payment link", async (state) => {
    const before = window.location.href;
    server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ ok: true, data: {
        subscription: {
          subscription_id: "sub-no-link", checkout_state: state, checkout_url: null,
          authorization_status: state === "failed" ? "failed" : "pending",
          paid_until: null,
        },
        checkout_url: null,
      } });
    }));
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    fireEvent.click(action);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      state === "failed" ? "暂时无法创建签约页面" : "暂未取得支付渠道的签约链接",
    );
    expect(window.location.href).toBe(before);
    expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled();
    expect(submitted).toHaveLength(1);
  });
  it.each([
    ["alipay", "支付宝", "failed"], ["alipay", "支付宝", "unknown"],
    ["wxpay", "微信支付", "failed"], ["wxpay", "微信支付", "unknown"],
    ["dodo", "Dodo", "failed"], ["dodo", "Dodo", "unknown"],
  ])("retains a failed HTTP creation response for %s without redirecting or reposting (%s, %s)", async (method, label, state) => {
    server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ ok: false, detail: "SUBSCRIPTION_CHECKOUT_NOT_READY", data: {
        checkout_url: null, subscription: {
          subscription_id: "sub-owned-attempt", plan_id: plan.plan_id, plan_version: plan.version,
          payment_method: method, checkout_state: state, checkout_url: null,
          authorization_status: state === "failed" ? "failed" : "pending", paid_until: null,
        },
      } }, { status: state === "failed" ? 503 : 409 });
    }));
    mount();
    await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("checkbox"));
    const before = window.location.href;
    const action = screen.getByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(action);
    fireEvent.click(action);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      state === "failed" ? "暂时无法创建签约页面" : "暂未取得支付渠道的签约链接",
    );
    expect(window.location.href).toBe(before);
    expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled();
    expect(submitted).toHaveLength(1);
    if (state === "failed") expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
    else expect(sessionStorage.getItem("dramaclaw-subscription-return")).toContain("sub-owned-attempt");
    expect(screen.queryByText("订阅已生效")).not.toBeInTheDocument();
  });
  it("requires consent, submits no contact data and reuses the key after an unknown result", async () => {
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    expect(action).toBeDisabled();
    expect(screen.getByText("¥1,200.00")).toBeInTheDocument();
    expect(
      screen.getByText(/每月发放 1,000 积分，本期共 12 次/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "订阅服务协议" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    await screen.findByText(/请求结果尚未确认/);
    expect(submitted[0]).toMatchObject({
      plan_id: plan.plan_id,
      plan_version: 1,
      payment_method: "alipay",
      terms_accepted: true,
      terms_agreement_id: "terms-test",
      terms_agreement_version: 1,
    });
    expect(submitted[0]).not.toHaveProperty("customer");
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
    expect(onceCalls).toBe(0);
  });
  it.each(["支付宝", "微信支付", "Dodo"])("reuses the attempt key when the browser loses the response for %s", async (method) => {
    server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      keys.push(request.headers.get("Idempotency-Key")!);
      return HttpResponse.error();
    }));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: method }));
    fireEvent.click(screen.getByRole("checkbox"));
    const action = screen.getByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(action);
    await screen.findByText(/请求结果尚未确认/);
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
  });
  it.each(["支付宝", "微信支付", "Dodo"])("uses a fresh attempt after a confirmed preflight failure with %s", async (method) => {
    server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      submitted.push(body);
      keys.push(request.headers.get("Idempotency-Key")!);
      return HttpResponse.json({ ok: false, detail: "SUBSCRIPTION_GATEWAY_UNAVAILABLE", data: {
        checkout_url: null, subscription: {
          subscription_id: `failed-${keys.length}`, plan_id: plan.plan_id, plan_version: plan.version,
          payment_method: body.payment_method, checkout_state: "failed", checkout_url: null,
        },
      } }, { status: 503 });
    }));
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("button", { name: method }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    await screen.findByText(/暂时无法创建签约页面/);
    await waitFor(() => expect(action).toBeEnabled());
    fireEvent.click(action);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).not.toBe(keys[1]);
  });
  it.each([
    ["支付宝", "https://openapi.alipay.com/authorize"],
    ["微信支付", "https://api.mch.weixin.qq.com/papay/entrustweb"],
    ["Dodo", "https://test.checkout.dodopayments.com/session/cks_test"],
  ])("keeps the action locked while %s opens so a second click cannot redirect to the result page", async (label, url) => {
    server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      submitted.push(body);
      return HttpResponse.json({ ok: true, data: {
        checkout_url: url, subscription: {
          subscription_id: "sub-checkout-redirect", plan_id: plan.plan_id, plan_version: plan.version,
          payment_method: body.payment_method, checkout_state: "ready", checkout_url: url,
          authorization_status: "pending", billing_status: "pending", paid_until: null,
        },
      } });
    }));
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("button", { name: label }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    fireEvent.click(action);
    const opening = await screen.findByRole("button", { name: "正在前往支付…" });
    expect(opening).toBeDisabled();
    fireEvent.click(opening);
    expect(submitted).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "查看申请状态" })).not.toBeInTheDocument();
    expect(window.location.search).not.toContain("business_subscription_id");
  });
  it("clears consent on payment method and FX quote changes", async () => {
    mount();
    await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    currentPlan.offers[2].payment_amount_minor = 17000;
    await client.invalidateQueries({
      queryKey: ["subscriptions", "test-user", "plans"],
    });
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(submitted).toHaveLength(0);
  });

  it("reads terms in a dialog and preserves the selected payment method when consent is confirmed", async () => {
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    const consent = screen.getByRole("checkbox");
    const method = screen.getByRole("button", { name: "微信支付" });
    fireEvent.click(method);
    const location = window.location.href;
    fireEvent.click(screen.getByRole("button", { name: "订阅服务协议" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("协议正文版本 1");
    const confirm = within(dialog).getByRole("button", {
      name: "确认并返回结算",
    });
    expect(confirm).toBeDisabled();
    expect(consent).not.toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(consent).not.toBeChecked();
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(consent).toBeChecked();
    expect(method).toHaveAttribute("aria-pressed", "true");
    expect(action).toBeEnabled();
    expect(window.location.href).toBe(location);
    expect(submitted).toHaveLength(0);
  });

  it("does not accept or remember an unconfirmed checkbox when the dialog is closed", async () => {
    mount();
    await screen.findByRole("button", { name: "订阅服务协议" });
    const consent = screen.getByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "订阅服务协议" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("协议正文版本 1");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(consent).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "订阅服务协议" }));
    expect(
      within(await screen.findByRole("dialog")).getByRole("checkbox"),
    ).not.toBeChecked();
    expect(submitted).toHaveLength(0);
  });

  it("disables dialog consent while loading and after a failure, and permits retry", async () => {
    let fail: (() => void) | undefined;
    server.use(
      http.get(
        "*/api/v1/payments/subscriptions/agreements/terms-test/versions/1",
        async () => {
          await new Promise<void>((resolve) => {
            fail = resolve;
          });
          return HttpResponse.json({}, { status: 404 });
        },
      ),
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "订阅服务协议" }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("status");
    const confirm = within(dialog).getByRole("button", {
      name: "确认并返回结算",
    });
    expect(within(dialog).getByRole("checkbox")).toBeDisabled();
    expect(confirm).toBeDisabled();
    await waitFor(() => expect(fail).toBeDefined());
    fail!();
    await within(dialog).findByRole("alert");
    expect(confirm).toBeDisabled();
    server.use(
      http.get(
        "*/api/v1/payments/subscriptions/agreements/terms-test/versions/1",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              agreement_id: "terms-test",
              version: 1,
              title: "重试后的协议",
              body: "重试成功的协议正文",
              effective_at: "2020-01-01T00:00:00Z",
              content_hash: "a".repeat(64),
            },
          }),
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "刷新" }));
    await within(dialog).findByText("重试成功的协议正文");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(confirm).toBeEnabled();
    expect(submitted).toHaveLength(0);
  });

  it("rejects a published body whose hash differs from the displayed plan", async () => {
    currentPlan.terms_content_hash = "b".repeat(64);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "订阅服务协议" }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/协议内容与当前套餐不一致/);
    expect(within(dialog).getByRole("checkbox")).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "确认并返回结算" }),
    ).toBeDisabled();
    expect(submitted).toHaveLength(0);
  });

  it("requires fresh agreement consent when the plan changes while the reader is open", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "订阅服务协议" }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("协议正文版本 1");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    currentPlan = {
      ...currentPlan,
      terms_agreement_version: 2,
      terms_content_hash: "b".repeat(64),
    };
    await client.invalidateQueries({ queryKey: ["subscriptions"] });
    await within(dialog).findByText("协议正文版本 2");
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "确认并返回结算" }),
    ).toBeDisabled();
    expect(submitted).toHaveLength(0);
  });
  it("shows the frozen Dodo USD quote for automatic renewal", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
    expect(
      await screen.findByText("自动续费：每 12 个月 US$166.67"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("自动续费：每 12 个月 ¥1,200.00"),
    ).not.toBeInTheDocument();
  });
  it("keeps a missing Dodo quote unavailable without relabeling the CNY price as USD", async () => {
    Object.assign(currentPlan.offers[2], { payment_amount_minor: undefined });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
    expect(screen.getByText("自动续费：每 12 个月 —")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "确认订阅并前往支付" }),
    ).toBeDisabled();
  });
  it("sends the exact displayed Dodo quote through the subscription API", async () => {
    mount();
    await screen.findByRole("button", { name: "Dodo" });
    fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0].quote).toEqual({
      base_amount_cents: 120000,
      payment_amount_cents: 16667,
      currency: "USD",
      cny_per_usd: "7.2",
    });
    expect(onceCalls).toBe(0);
  });
  it("blocks an outdated plan and a different logged-in account", async () => {
    currentPlan.version = 2;
    mount();
    expect(await screen.findByText(/套餐版本已更新/)).toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });

  it("does not submit a draft belonging to a different account", async () => {
    useAuthStore.setState({ username: "another-user" });
    mount();
    expect(await screen.findByText("支付会话已失效")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认订阅并前往支付" }),
    ).not.toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });

  it("shows an unavailable channel before authorization and permits another method", async () => {
    Object.assign(currentPlan.offers[0], { available: false });
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeDisabled();
    expect(screen.getByText(/当前暂时无法使用此渠道签约/)).toBeInTheDocument();
    expect(screen.queryByText("请先绑定手机号")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "微信支付" }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    expect(submitted).toHaveLength(0);
  });

  it("shows missing phone guidance only for Alipay and leaves other channels usable", async () => {
    Object.assign(currentPlan.offers[0], {
      available: false,
      unavailable_reason: "SUBSCRIPTION_CUSTOMER_UNAVAILABLE",
    });
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    expect(screen.getByText(/工作台右上角账号菜单/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "微信支付" }));
    expect(screen.queryByText("请先绑定手机号")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新检查" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
    expect(screen.getByText(/请在 Dodo 收银台填写或确认/)).toBeInTheDocument();
    expect(screen.queryByText("请先绑定手机号")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    expect(submitted).toHaveLength(0);
  });

  it("rechecks account eligibility without losing the draft or creating a subscription", async () => {
    Object.assign(currentPlan.offers[0], {
      available: false,
      unavailable_reason: "SUBSCRIPTION_CUSTOMER_UNAVAILABLE",
    });
    mount();
    const recheck = await screen.findByRole("button", { name: "重新检查" });
    const action = screen.getByRole("button", { name: "确认订阅并前往支付" });
    const draft = sessionStorage.getItem(CHECKOUT_DRAFT_KEY);
    fireEvent.click(screen.getByRole("checkbox"));
    // Simulate binding the phone in the existing account menu in another tab.
    currentPlan.offers[0] = structuredClone(plan.offers[0]);
    let finishCheck!: () => void;
    const pending = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    server.use(
      http.get(endpoint + "subscriptions/plans", async () => {
        await pending;
        return HttpResponse.json({ ok: true, data: { items: [currentPlan] } });
      }),
    );
    fireEvent.click(recheck);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "正在检查…" })).toBeDisabled(),
    );
    expect(action).toBeDisabled();
    finishCheck();
    await waitFor(() =>
      expect(screen.queryByText("请先绑定手机号")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(action).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    expect(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)).toBe(draft);
    expect(submitted).toHaveLength(0);
  });

  it("does not unlock checkout when the eligibility recheck fails", async () => {
    Object.assign(currentPlan.offers[0], {
      available: false,
      unavailable_reason: "SUBSCRIPTION_CUSTOMER_UNAVAILABLE",
    });
    mount();
    const recheck = await screen.findByRole("button", { name: "重新检查" });
    server.use(
      http.get(endpoint + "subscriptions/plans", () =>
        HttpResponse.json({ detail: "unavailable" }, { status: 503 }),
      ),
    );
    fireEvent.click(recheck);
    await screen.findByText("暂时无法读取订阅信息。");
    expect(
      screen.queryByRole("button", { name: "确认订阅并前往支付" }),
    ).not.toBeInTheDocument();
    expect(submitted).toHaveLength(0);
  });

  it("uses the same phone guidance if account eligibility changes at submission", async () => {
    server.use(
      http.post(endpoint + "subscriptions", async ({ request }) => {
        submitted.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json(
          { detail: "SUBSCRIPTION_CUSTOMER_UNAVAILABLE" },
          { status: 422 },
        );
      }),
    );
    mount();
    const action = await screen.findByRole("button", {
      name: "确认订阅并前往支付",
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    await screen.findByText("请先绑定手机号");
    expect(action).toBeDisabled();
    expect(submitted).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "微信支付" }));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(action).toBeEnabled();
    expect(screen.queryByText("请先绑定手机号")).not.toBeInTheDocument();
  });

  it("shows an unavailable signup entry instead of a payment spinner for an unknown checkout without a URL", async () => {
    window.history.replaceState({}, "", "/payment-return?business_subscription_id=sub-no-link");
    server.use(http.get(endpoint + "subscriptions/sub-no-link", () => HttpResponse.json({
      ok: true, data: {
        subscription_id: "sub-no-link", offer: plan, checkout_state: "unknown", checkout_url: null,
        authorization_status: "pending", billing_status: "pending", auto_renew: true,
        paid_until: null, review_required: false, failure_code: "SUBSCRIPTION_GATEWAY_UNCONFIRMED",
        invoices: [], grants: [],
      },
    })));
    mount(<PaymentReturnPage />);
    expect(await screen.findByText("签约页面暂不可用")).toBeInTheDocument();
    expect(screen.queryByText("正在确认签约和付款")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新查询" })).toBeEnabled();
    expect(onceCalls).toBe(0);
  });
  it("renders the subscription result on the shared return route without querying recharge orders", async () => {
    window.history.replaceState(
      {},
      "",
      "/payment-return?business_subscription_id=sub-return",
    );
    server.use(
      http.get(endpoint + "subscriptions/sub-return", () =>
        HttpResponse.json({
          ok: true,
          data: {
            subscription_id: "sub-return",
            offer: plan,
            authorization_status: "active",
            checkout_state: "ready",
            auto_renew: true,
            review_required: false,
            billing_status: "pending",
            paid_until: null,
            invoices: [],
            grants: [],
          },
        }),
      ),
    );
    mount(<PaymentReturnPage />);
    expect(
      await screen.findByText("签约已确认，等待首期付款"),
    ).toBeInTheDocument();
    expect(screen.queryByText("订阅已生效")).not.toBeInTheDocument();
    expect(onceCalls).toBe(0);
  });
});

it("distinguishes authorization, paid membership and credits currently due", () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const row = {
    authorization_status: "active",
    billing_status: "pending",
    checkout_state: "ready",
    paid_until: null,
    review_required: false,
    grants: [],
    invoices: [],
  } as unknown as Subscription;
  expect(subscriptionResultState(row, false, now)).toBe("authorized");
  const paid = {
    ...row,
    billing_status: "paid",
    paid_until: "2027-10-21T00:00:00Z",
    invoices: [
      {
        status: "paid",
        period_start: "2026-10-20T00:00:00Z",
        period_end: "2027-10-21T00:00:00Z",
      },
    ],
    grants: [{ due_at: "2026-10-20T00:00:00Z", status: "pending" }],
  } as Subscription;
  expect(subscriptionResultState(paid, false, now)).toBe("paid");
  const active = {
    ...paid,
    grants: [
      { due_at: "2026-10-20T00:00:00Z", status: "credited" },
      { due_at: "2026-11-20T00:00:00Z", status: "pending" },
    ],
  } as Subscription;
  expect(subscriptionResultState(active, false, now)).toBe("active");
  expect(
    subscriptionResultState({ ...active, review_required: true }, false, now),
  ).toBe("review");
  expect(subscriptionResultState(active, true, now)).toBe("unavailable");
});

describe("subscription failure recovery in checkout", () => {
  it.each([
    ["SUBSCRIPTION_ORG_CREDITS_INSUFFICIENT", "subscriptionCheckout.orgCreditsInsufficient"],
    ["SUBSCRIPTION_ALREADY_EXISTS", "subscriptionCheckout.existing"],
    ["SUBSCRIPTION_PLAN_UNAVAILABLE", "subscriptionCheckout.planChanged"],
  ])("shows the actual %s error without calling it unknown", async (detail, key) => {
    server.use(http.post(endpoint + "subscriptions", () => HttpResponse.json({ detail }, { status: 409 })));
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    expect(await screen.findByRole("alert")).toHaveTextContent(zhT(key));
    expect(screen.queryByText(zhT("subscriptions.createUnconfirmed"))).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "微信支付" })).toBeEnabled();
  });

  it("verifies an existing Alipay link before navigation and keeps other channels usable after failure", async () => {
    let posts = 0;
    let refreshes = 0;
    const row = {
      subscription_id: "recover-in-place", plan_id: plan.plan_id, plan_version: 1,
      payment_method: "alipay", checkout_state: "ready", checkout_url: "https://openapi.alipay.com/authorize",
      authorization_status: "pending", billing_status: "pending", auto_renew: true,
    };
    server.use(
      http.post(endpoint + "subscriptions", () => {
        posts++;
        return HttpResponse.json({ detail: "SUBSCRIPTION_CHECKOUT_NOT_READY", data: { subscription: row } }, { status: 409 });
      }),
      http.get(endpoint + "subscriptions/recover-in-place", () => HttpResponse.json({ ok: true, data: row })),
      http.post(endpoint + "subscriptions/recover-in-place/refresh", () => {
        refreshes++;
        return HttpResponse.json({ ok: true, data: { ...row, checkout_state: "failed", billing_status: "failed", authorization_status: "failed", auto_renew: false } });
      }),
    );
    mount();
    const action = await screen.findByRole("button", { name: "确认订阅并前往支付" });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(action);
    const before = window.location.href;
    fireEvent.click(await screen.findByRole("button", { name: "重新获取支付入口" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "微信支付" })).toBeEnabled());
    expect(window.location.href).toBe(before);
    expect(posts).toBe(1);
    expect(refreshes).toBe(1);
    expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(zhT("subscriptionCheckout.channelUnavailable"));
  });
});

it.each(["alipay", "wxpay"])("keeps other methods available while backend resolves %s rejection", async (method) => {
  let resolved = false;
  const row = () => ({ subscription_id: "recovery-attempt", plan_id: plan.plan_id,
    plan_version: 1, payment_method: method, checkout_state: resolved ? "failed" : "unknown",
    authorization_status: resolved ? "failed" : "pending", billing_status: resolved ? "failed" : "pending",
    auto_renew: !resolved, has_pending_payment: !resolved, purchase_blocked: false,
    can_change_payment_method: true, cancellation_confirmed_at: resolved ? "2026-10-29T00:00:00Z" : null,
    paid_until: null, checkout_url: null, invoices: [], offer: plan });
  server.use(
    http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ ok: true, data: { subscription: row(), checkout_url: null } });
    }),
    http.get(endpoint + "subscriptions/recovery-attempt", () => HttpResponse.json({ ok: true, data: row() })),
  );
  const before = window.location.href;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: method === "alipay" ? "支付宝" : "微信支付" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await screen.findByText(/暂未取得支付渠道的签约链接/);
  expect(screen.getByRole("button", { name: "Dodo" })).toBeEnabled();
  resolved = true;
  await client.invalidateQueries({ queryKey: ["subscriptions", "test-user", "detail", "recovery-attempt"] });
  await waitFor(() => expect(screen.getByRole("button", { name: "Dodo" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
  expect(screen.getByRole("button", { name: "Dodo" })).toHaveAttribute("aria-pressed", "true");
  expect(window.location.href).toBe(before);
  expect(submitted).toHaveLength(1);
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
});

it("does not wait for background cancellation to allow another channel after a failed attempt", async () => {
  const row = () => ({
    subscription_id: "failure-awaiting-cancellation", plan_id: plan.plan_id,
    plan_version: 1, payment_method: "alipay", checkout_state: "failed",
    authorization_status: "failed", billing_status: "failed", auto_renew: false,
    has_pending_payment: false, purchase_blocked: false,
    can_change_payment_method: true,
    cancellation_confirmed_at: null,
    paid_until: null, checkout_url: null, invoices: [], offer: plan,
  });
  server.use(
    http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ ok: true, data: { subscription: row(), checkout_url: null } });
    }),
    http.get(endpoint + "subscriptions/failure-awaiting-cancellation", () => {
      return HttpResponse.json({ ok: true, data: row() });
    }),
  );
  mount();
  const purchase = await screen.findByRole("button", { name: "确认订阅并前往支付" });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(purchase);
  await screen.findByText(/暂时无法创建签约页面/);
  expect(screen.getByRole("button", { name: "Dodo" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
  expect(screen.getByRole("button", { name: "Dodo" })).toHaveAttribute("aria-pressed", "true");
  expect(submitted).toHaveLength(1);
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
});

function unpaidAttempt(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscription_id: "old-unpaid", plan_id: plan.plan_id, plan_version: 1,
    payment_method: "alipay", checkout_state: "unknown", checkout_url: null,
    authorization_status: "pending", billing_status: "pending", auto_renew: true,
    has_pending_payment: false, purchase_blocked: false, can_change_payment_method: true,
    settlement_state: "open", cancellation_requested_at: null, cancellation_confirmed_at: null,
    paid_until: null, review_required: false, failure_code: null, invoices: [],
    offer: plan as unknown as Subscription["offer"], ...overrides,
  };
}

it.each(["pending", "ready", "unknown", "failed"] as const)("lets an unpaid %s application enter the catalog checkout", async (state) => {
  const row = unpaidAttempt({ checkout_state: state });
  server.use(http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: [row] } })));
  mount(<SubscriptionPanel />);
  const subscribe = await screen.findByRole("button", { name: "订阅" });
  await waitFor(() => expect(subscribe).toBeEnabled());
  sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
  fireEvent.click(subscribe);
  expect(JSON.parse(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)!)).toMatchObject({ planId: plan.plan_id });
  expect(screen.queryByText(zhT("subscriptionCheckout.existing"))).not.toBeInTheDocument();
  expect(submitted).toHaveLength(0);
});

it("keeps active membership plans unavailable while upgrades are unsupported", async () => {
  server.use(
    http.get(endpoint + "subscriptions/plans", () => HttpResponse.json({ ok: true, data: { items: [
      plan, { ...plan, plan_id: "another-plan", name: "另一个套餐" },
    ] } })),
    http.get(endpoint + "subscriptions/membership", () => HttpResponse.json({ ok: true, data: {
    active: true, subscription_id: "winner", plan_id: plan.plan_id, plan_version: 1,
  } })));
  mount(<SubscriptionPanel />);
  expect(await screen.findByRole("button", { name: "当前套餐" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "订阅" })).toBeDisabled();
  expect(submitted).toHaveLength(0);
});

it("keeps an unknown attempt in the background when switching to a fresh channel", async () => {
  const row = unpaidAttempt();
  const oldKey = subscriptionAttemptKey("test-user", plan.plan_id, 1, "alipay");
  bindSubscriptionAttempt("test-user", plan.plan_id, 1, "alipay", row.subscription_id);
  server.use(
    http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: [row] } })),
    http.get(endpoint + "subscriptions/old-unpaid", () => HttpResponse.json({ ok: true, data: row })),
  );
  mount();
  await screen.findByRole("button", { name: "确认订阅并前往支付" });
  await waitFor(() => expect(sessionStorage.getItem("dramaclaw-subscription-return")).toContain(row.subscription_id));
  fireEvent.click(screen.getByRole("button", { name: "Dodo" }));
  expect(screen.getByRole("button", { name: "Dodo" })).toHaveAttribute("aria-pressed", "true");
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
  expect(subscriptionAttemptKey("test-user", plan.plan_id, 1, "alipay")).toBe(oldKey);
  expect(submitted).toHaveLength(0);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await waitFor(() => expect(keys).toHaveLength(1));
  expect(keys[0]).not.toBe(oldKey);
  expect(submitted[0].payment_method).toBe("dodo");
});

it("observes an old Alipay checkout URL becoming ready without navigating or posting automatically", async () => {
  let row = unpaidAttempt();
  server.use(
    http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: [row] } })),
    http.get(endpoint + "subscriptions/old-unpaid", () => HttpResponse.json({ ok: true, data: row })),
  );
  mount();
  await screen.findByRole("button", { name: "确认订阅并前往支付" });
  await waitFor(() => expect(sessionStorage.getItem("dramaclaw-subscription-return")).toContain(row.subscription_id));
  row = { ...row, checkout_state: "ready", checkout_url: "https://openapi.alipay.com/authorize" };
  await client.invalidateQueries({ queryKey: ["subscriptions", "test-user", "detail", row.subscription_id] });
  await waitFor(() => expect(screen.getByRole("button", { name: "重新获取支付入口" })).toBeEnabled());
  expect(screen.queryByRole("button", { name: "正在前往支付…" })).not.toBeInTheDocument();
  expect(submitted).toHaveLength(0);
});

it("starts a new same-channel attempt only when the user explicitly confirms an unknown checkout", async () => {
  const row = unpaidAttempt();
  const oldKey = subscriptionAttemptKey("test-user", plan.plan_id, 1, "alipay");
  bindSubscriptionAttempt("test-user", plan.plan_id, 1, "alipay", row.subscription_id);
  server.use(
    http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: [row] } })),
    http.get(endpoint + "subscriptions/old-unpaid", () => HttpResponse.json({ ok: true, data: row })),
  );
  mount();
  const confirm = await screen.findByRole("button", { name: "确认订阅并前往支付" });
  await waitFor(() => expect(sessionStorage.getItem("dramaclaw-subscription-return")).toContain(row.subscription_id));
  expect(submitted).toHaveLength(0);
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirm);
  await waitFor(() => expect(keys).toHaveLength(1));
  expect(keys[0]).not.toBe(oldKey);
  expect(submitted[0].payment_method).toBe("alipay");
  await screen.findByText(/请求结果尚未确认/);
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]); // Lost response of the new attempt replays its own key.
});

it("returns from a Dodo checkout and creates a new session only after an explicit payment action", async () => {
  const row = unpaidAttempt({ payment_method: "dodo", checkout_state: "ready",
    checkout_url: "https://test.checkout.dodopayments.com/session/old", checkout_session_id: "old" });
  const oldKey = subscriptionAttemptKey("test-user", plan.plan_id, 1, "dodo");
  bindSubscriptionAttempt("test-user", plan.plan_id, 1, "dodo", row.subscription_id);
  sessionStorage.setItem("dramaclaw-subscription-return", JSON.stringify({ id: row.subscription_id,
    username: "test-user", planId: plan.plan_id, planVersion: 1, paymentMethod: "dodo" }));
  let refreshes = 0;
  server.use(
    http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: [row] } })),
    http.get(endpoint + "subscriptions/old-unpaid", () => HttpResponse.json({ ok: true, data: row })),
    http.post(endpoint + "subscriptions/old-unpaid/refresh", () => { refreshes++; return HttpResponse.json({ ok: true, data: row }); }),
  );
  mount();
  const confirm = await screen.findByRole("button", { name: "确认订阅并前往支付" });
  await waitFor(() => expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull());
  expect(screen.getByRole("button", { name: "Dodo" })).toHaveAttribute("aria-pressed", "true");
  expect(submitted).toHaveLength(0);
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirm);
  await waitFor(() => expect(keys).toHaveLength(1));
  expect(keys[0]).not.toBe(oldKey);
  expect(submitted[0].payment_method).toBe("dodo");
  expect(refreshes).toBe(0);
});

it.each(["Dodo", "支付宝"])("restores the mounted Dodo checkout from BFCache and permits an explicit %s purchase", async (nextMethod) => {
  const row = unpaidAttempt({ subscription_id: "bfcache-unpaid", payment_method: "dodo",
    checkout_state: "ready", checkout_session_id: "bfcache-session",
    checkout_url: "https://test.checkout.dodopayments.com/session/bfcache" });
  const reads = { list: 0, membership: 0, attempt: 0 };
  server.use(
    http.get(endpoint + "subscriptions", () => {
      reads.list++;
      return HttpResponse.json({ ok: true, data: { items: submitted.length ? [row] : [] } });
    }),
    http.get(endpoint + "subscriptions/membership", () => {
      reads.membership++;
      return HttpResponse.json({ ok: true, data: { active: false } });
    }),
    http.get(endpoint + "subscriptions/bfcache-unpaid", () => {
      reads.attempt++;
      return HttpResponse.json({ ok: true, data: row });
    }),
    http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      keys.push(request.headers.get("Idempotency-Key")!);
      return submitted.length === 1
        ? HttpResponse.json({ ok: true, data: { subscription: row, checkout_url: row.checkout_url } })
        : HttpResponse.json({ detail: "SUBSCRIPTION_GATEWAY_UNCONFIRMED" }, { status: 503 });
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  expect(await screen.findByRole("button", { name: "正在前往支付…" })).toBeDisabled();
  await waitFor(() => expect(reads.attempt).toBeGreaterThan(0));
  const before = { ...reads };
  restoreFromBrowserCache();
  await waitFor(() => expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull());
  await waitFor(() => expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled());
  expect(reads.list).toBeGreaterThan(before.list);
  expect(reads.membership).toBeGreaterThan(before.membership);
  expect(reads.attempt).toBeGreaterThan(before.attempt);
  expect(submitted).toHaveLength(1);
  expect(screen.getByRole("button", { name: "支付宝" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "微信支付" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: nextMethod }));
  if (nextMethod !== "Dodo") fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).not.toBe(keys[0]);
  expect(submitted[1].payment_method).toBe(nextMethod === "Dodo" ? "dodo" : "alipay");
  expect(onceCalls).toBe(0);
});

it("keeps the unknown create key across a BFCache restore without posting automatically", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await screen.findByText(/请求结果尚未确认/);
  expect(keys).toHaveLength(1);
  restoreFromBrowserCache();
  await waitFor(() => expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled());
  expect(keys).toHaveLength(1);
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]);
});

it("refreshes paid membership on BFCache restore and keeps the winning subscription blocked", async () => {
  let row = unpaidAttempt({ subscription_id: "bfcache-winner", payment_method: "dodo",
    checkout_state: "ready", checkout_url: "https://test.checkout.dodopayments.com/session/winner" });
  let paid = false;
  server.use(
    http.get(endpoint + "subscriptions", () => HttpResponse.json({ ok: true, data: { items: submitted.length ? [row] : [] } })),
    http.get(endpoint + "subscriptions/membership", () => HttpResponse.json({ ok: true, data: { active: paid, subscription_id: row.subscription_id } })),
    http.get(endpoint + "subscriptions/bfcache-winner", () => HttpResponse.json({ ok: true, data: row })),
    http.post(endpoint + "subscriptions", async ({ request }) => {
      submitted.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ ok: true, data: { subscription: row, checkout_url: row.checkout_url } });
    }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await screen.findByRole("button", { name: "正在前往支付…" });
  paid = true;
  row = { ...row, settlement_state: "active", billing_status: "paid", purchase_blocked: true,
    paid_until: "2099-01-01T00:00:00Z" };
  restoreFromBrowserCache();
  await waitFor(() => expect(screen.queryByRole("button", { name: "正在前往支付…" })).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "支付宝" })).toBeDisabled());
  expect(screen.getByRole("button", { name: "Dodo" })).toBeDisabled();
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toContain(row.subscription_id);
  expect(submitted).toHaveLength(1);
});

it("ignores a frozen create response after BFCache restore and preserves its key for explicit retry", async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const row = unpaidAttempt({ subscription_id: "frozen-response", payment_method: "dodo",
    checkout_state: "ready", checkout_url: "https://test.checkout.dodopayments.com/session/frozen" });
  server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
    submitted.push(await request.json() as Record<string, unknown>);
    keys.push(request.headers.get("Idempotency-Key")!);
    if (submitted.length > 1) {
      return HttpResponse.json({ detail: "SUBSCRIPTION_GATEWAY_UNCONFIRMED" }, { status: 503 });
    }
    await paused;
    return HttpResponse.json({ ok: true, data: { subscription: row, checkout_url: row.checkout_url } });
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Dodo" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  try {
    await waitFor(() => expect(keys).toHaveLength(1));
    restoreFromBrowserCache();
    await waitFor(() => expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled());
    expect(keys).toHaveLength(1);
  } finally {
    release();
  }
  await waitFor(() => expect(client.isMutating()).toBe(0));
  expect(screen.queryByRole("button", { name: "正在前往支付…" })).not.toBeInTheDocument();
  expect(sessionStorage.getItem("dramaclaw-subscription-return")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]);
});

it("shows a short retryable creation failure for attempt rate limits", async () => {
  server.use(http.post(endpoint + "subscriptions", async ({ request }) => {
    submitted.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json({ detail: "SUBSCRIPTION_ATTEMPT_RATE_LIMITED" }, { status: 429 });
  }));
  mount();
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "确认订阅并前往支付" }));
  expect(await screen.findByText("支付订单创建失败，请稍后重试")).toBeInTheDocument();
  expect(screen.queryByText(/请求结果尚未确认/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Dodo" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "确认订阅并前往支付" })).toBeEnabled();
  expect(submitted).toHaveLength(1);
});
