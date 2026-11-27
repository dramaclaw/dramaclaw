// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHECKOUT_DRAFT_KEY, PAYMENT_ATTEMPT_KEY } from "@/lib/payment-navigation";
import { BackendStatusError } from "@/lib/api-errors";
import type { RechargePackage } from "@/lib/queries/payments";
import { CheckoutPage } from "@/routes/checkout";

const state = vi.hoisted(() => ({
  scope: "org_member",
  org: { org_id: "org-a", name: "Organization A" } as { org_id: string; name: string } | null,
  summaryPending: false,
  summaryError: false,
  creditPolicy: undefined as { version: number; valid_days: number | null } | undefined,
  refetchSummary: vi.fn(),
  enabled: true,
  packages: [] as RechargePackage[],
  createCustom: vi.fn(),
  createPackage: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { organization?: string }) => {
      if (key === "checkout.orgCredits") return `${key}:${args?.organization}`;
      return key;
    },
    i18n: { language: "zh" },
  }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (select: (state: { username: string }) => unknown) => select({ username: "AAA" }),
}));
vi.mock("@/lib/queries/product-surfaces", async (original) => ({
  ...await original<typeof import("@/lib/queries/product-surfaces")>(),
  useProductSurfaces: () => ({
    data: { data: { items: [{ surface_code: "payment", available: true }] } },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/lib/queries/credits", async (original) => ({
  ...await original<typeof import("@/lib/queries/credits")>(),
  useCreditSummary: () => ({
    data: state.summaryPending || state.summaryError ? undefined : {
      data: {
        scope: state.scope,
        organization: state.org,
        checkout_credit_policies: state.creditPolicy ? { recharge: state.creditPolicy } : undefined,
      },
    },
    isPending: state.summaryPending,
    isError: state.summaryError,
    refetch: state.refetchSummary,
  }),
}));
vi.mock("@/lib/queries/payments", () => ({
  usePaymentQuote: () => ({ data: undefined, isFetching: false, isError: false }),
  useRechargePackages: () => ({ data: { data: { items: state.packages } }, isPending: false }),
  useCustomRechargeConfig: () => ({ data: { data: {
    enabled: state.enabled, credits_per_cny: 30, min_credits: 510,
    max_credits: 500010, payment_methods: ["alipay"], version: 7,
  } }, isPending: false }),
  useRechargeOrder: () => ({ data: undefined }),
  useCreateCustomRechargeOrder: () => ({ mutateAsync: state.createCustom, isPending: false }),
  useCreateRechargeOrder: () => ({ mutateAsync: state.createPackage, isPending: false }),
  submitPaymentCheckout: state.submit,
}));

describe("custom recharge checkout identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({ kind: "custom", credits: 3000 }));
    state.scope = "org_member";
    state.org = { org_id: "org-a", name: "Organization A" };
    state.summaryPending = false;
    state.summaryError = false;
    state.creditPolicy = undefined;
    state.enabled = true;
    state.packages = [];
    state.createCustom.mockResolvedValue({ data: {
      order: { order_id: "order-a", merchant_order_no: "DC-A" },
      checkout: { action: "https://epay.example/submit.php", method: "POST", fields: {} },
    } });
  });

  it.each(["org_member", "personal"])("submits %s custom recharge using current configuration", async (scope) => {
    state.scope = scope;
    if (scope === "personal") state.org = null;
    render(<CheckoutPage />);
    expect(screen.queryByText("checkout.subjectMismatch")).not.toBeInTheDocument();
    expect(screen.getByText(scope === "org_member" ? "checkout.orgCredits:Organization A" : "checkout.personalCredits")).toBeInTheDocument();
    expect(screen.getAllByText("¥100.00").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "checkout.continue" }));
    await waitFor(() => expect(state.submit).toHaveBeenCalledTimes(1));
    expect(state.createCustom).toHaveBeenCalledWith({
      credits: 3000, configVersion: 7, paymentMethod: "alipay",
      idempotencyKey: expect.stringMatching(/^checkout-/),
    });
    expect(state.createPackage).not.toHaveBeenCalled();
    const attempt = JSON.parse(sessionStorage.getItem(PAYMENT_ATTEMPT_KEY)!);
    expect(JSON.parse(attempt.fingerprint)).toMatchObject({
      orderType: scope === "org_member" ? "org_member_recharge" : "personal_recharge",
      effectiveOrgId: scope === "org_member" ? "org-a" : null,
    });
  });

  it("waits for the account identity before allowing payment", () => {
    state.summaryPending = true;
    const view = render(<CheckoutPage />);
    expect(screen.getByText("checkout.loading")).toBeInTheDocument();
    expect(state.createCustom).not.toHaveBeenCalled();
    state.summaryPending = false;
    view.rerender(<CheckoutPage />);
    expect(screen.getByRole("button", { name: "checkout.continue" })).toBeInTheDocument();
  });

  it.each(["personal", "org_member"])("refreshes %s checkout after a policy conflict and waits for another payment click", async (scope) => {
    state.scope = scope;
    if (scope === "personal") state.org = null;
    state.creditPolicy = { version: 2, valid_days: 30 };
    state.createCustom.mockRejectedValueOnce(new BackendStatusError("CREDIT_CHECKOUT_POLICY_CHANGED", 409));
    const view = render(<CheckoutPage />);
    const pay = screen.getByRole("button", { name: "checkout.continue" });
    expect(screen.queryByText(/checkout\.creditValidity/)).not.toBeInTheDocument();
    fireEvent.click(pay);
    await waitFor(() => expect(state.refetchSummary).toHaveBeenCalledTimes(1));
    expect(pay).toBeDisabled();
    expect(screen.getByText("checkout.settingsRefreshFailed")).toBeInTheDocument();
    expect(sessionStorage.getItem(PAYMENT_ATTEMPT_KEY)).toBeNull();

    state.creditPolicy = { version: 3, valid_days: null };
    view.rerender(<CheckoutPage />);
    expect(screen.getByText("checkout.settingsUpdated")).toBeInTheDocument();
    expect(screen.queryByText(/checkout\.creditValidity/)).not.toBeInTheDocument();
    expect(pay).toBeEnabled();
    expect(state.createCustom).toHaveBeenCalledTimes(1);
    fireEvent.click(pay);
    await waitFor(() => expect(state.submit).toHaveBeenCalledTimes(1));
    expect(state.createCustom.mock.calls[0]?.[0].creditPolicyVersion).toBe(2);
    expect(state.createCustom.mock.calls[1]?.[0].creditPolicyVersion).toBe(3);
    expect(state.createCustom.mock.calls[1]?.[0].idempotencyKey)
      .not.toBe(state.createCustom.mock.calls[0]?.[0].idempotencyKey);
  });

  it.each(["missing organization", "identity query failed", "disabled rule", "below minimum", "above maximum"])(
    "does not create an order for %s", (reason) => {
      if (reason === "missing organization") state.org = null;
      if (reason === "identity query failed") state.summaryError = true;
      if (reason === "disabled rule") state.enabled = false;
      if (reason === "below minimum" || reason === "above maximum") {
        sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({
          kind: "custom", credits: reason === "below minimum" ? 480 : 500040,
        }));
      }
      render(<CheckoutPage />);
      expect(screen.getByText("checkout.invalidTitle")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "checkout.continue" })).not.toBeInTheDocument();
      expect(state.createCustom).not.toHaveBeenCalled();
    },
  );

  it.each(["org-a", "org-b"])("retains package organization validation for %s", (orgId) => {
    sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify({ kind: "package", packageId: "package-a" }));
    state.packages = [{
      package_id: "package-a", name: "Package A", order_type: "org_member_recharge",
      effective_org_id: orgId, payment_methods: ["alipay"], amount_cents: 100000,
      base_credits: 1000, gift_credits: 2999, org_credit_cost: 3999,
      currency: "CNY", sort_order: 0,
    }];
    render(<CheckoutPage />);
    if (orgId === "org-a") expect(screen.getByRole("button", { name: "checkout.continue" })).toBeInTheDocument();
    else expect(screen.getByText("checkout.subjectMismatch")).toBeInTheDocument();
    expect(state.createPackage).not.toHaveBeenCalled();
  });
});
