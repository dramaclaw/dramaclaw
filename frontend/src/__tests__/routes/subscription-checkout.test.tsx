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
import type { Subscription } from "@/lib/queries/subscriptions";

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
