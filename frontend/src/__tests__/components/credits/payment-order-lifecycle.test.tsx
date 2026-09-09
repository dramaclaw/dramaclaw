// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CreditCenterDialog } from "@/components/credits/CreditCenterDialog";
import { PaymentReturnPage } from "@/routes/_app/payment-return";
import {
  CHECKOUT_DRAFT_KEY,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
  paymentIdempotencyKey,
  rememberPaymentOrder,
} from "@/lib/payment-navigation";
import type { RechargeOrder, RechargePackage } from "@/lib/queries/payments";

const { ordersQuery, packagesQuery, orderQuery } = vi.hoisted(() => ({
  ordersQuery: vi.fn(),
  packagesQuery: vi.fn(),
  orderQuery: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { username: string }) => unknown) =>
    selector({ username: "AAA" }),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>,
}));
vi.mock("@/lib/queries/credits", () => ({
  useCreditSummary: () => ({ data: undefined }),
  useCreditPromotions: () => ({ data: undefined, isPending: false }),
}));
vi.mock("@/lib/queries/payments", () => ({
  useRechargePackages: packagesQuery,
  useCustomRechargeConfig: () => ({ data: undefined, isPending: false }),
  useRechargeOrders: ordersQuery,
  useRechargeOrder: orderQuery,
  useCreateRechargeOrder: () => ({ isPending: false }),
}));

const closedOrder: RechargeOrder = {
  order_id: "order-closed",
  merchant_order_no: "DC-CLOSED",
  order_type: "org_member_recharge",
  org_id: "org-aaa",
  package_name: "School package",
  amount_cents: 100000,
  base_credits: 1000,
  gift_credits: 2999,
  currency: "CNY",
  payment_method: "alipay",
  payment_status: "closed",
  fulfillment_status: "failed",
  failure_code: "closed",
  expires_at: "2026-09-07T08:33:58Z",
  paid_at: null,
  fulfilled_at: null,
  created_at: "2026-09-07T08:23:58Z",
  updated_at: "2026-09-07T08:36:59Z",
};
const rechargePackage: RechargePackage = {
  package_id: "package-a",
  order_type: "org_member_recharge",
  effective_org_id: "org-aaa",
  name: "School package",
  payment_methods: ["alipay"],
  amount_cents: 100000,
  base_credits: 1000,
  gift_credits: 2999,
  org_credit_cost: 3999,
  currency: "CNY",
  sort_order: 0,
};

describe("closed order presentation and repurchase", () => {
  beforeEach(() => {
    sessionStorage.clear();
    orderQuery.mockReturnValue({ data: undefined, isError: false });
    ordersQuery.mockReturnValue({ data: { data: { items: [closedOrder] } }, isPending: false });
    packagesQuery.mockReturnValue({ data: { data: { items: [rechargePackage] } }, isPending: false });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the unpaid organization order as closed on the payment return page", () => {
    rememberPaymentOrder(closedOrder);
    render(<PaymentReturnPage />);
    expect(screen.getByRole("heading", { name: "paymentReturn.states.closed.title" })).toBeInTheDocument();
    expect(screen.queryByText("paymentReturn.states.fulfillment_failed.title")).not.toBeInTheDocument();
  });

  it("does not show another cached order as paid when opening a historical return link", () => {
    rememberPaymentOrder({ order_id: "newer-order", merchant_order_no: "DC-NEWER" });
    vi.stubGlobal("location", { ...window.location, search: "?merchant_order_no=DC-CLOSED&state=2" });
    render(<PaymentReturnPage />);
    expect(orderQuery).toHaveBeenCalledWith(null);
    expect(ordersQuery).toHaveBeenCalledWith({ poll: true, enabled: true });
    expect(screen.getByRole("heading", { name: "paymentReturn.states.closed.title" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "paymentReturn.states.credited.title" })).not.toBeInTheDocument();
  });

  it("shows closed instead of credit failure in the billing history", () => {
    render(<CreditCenterDialog open onOpenChange={vi.fn()} initialTab="orders" paymentAvailable />);
    expect(screen.getByText("credits.recharge.status.closed")).toBeInTheDocument();
    expect(screen.queryByText("credits.recharge.status.creditFailed")).not.toBeInTheDocument();
  });

  it("starts a new purchase without reusing the old order but keeps retries idempotent", () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const oldKey = paymentIdempotencyKey("checkout", "package-a:alipay:org-aaa");
    rememberPaymentOrder(closedOrder);
    render(<CreditCenterDialog open onOpenChange={vi.fn()} initialTab="packages" paymentAvailable />);

    fireEvent.click(screen.getByRole("button", { name: "credits.centerModal.buyNow" }));

    expect(window.location.assign).toHaveBeenCalledWith("/checkout");
    expect(sessionStorage.getItem(PAYMENT_RETURN_ORDER_ID_KEY)).toBeNull();
    expect(sessionStorage.getItem(PAYMENT_RETURN_ORDER_KEY)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(CHECKOUT_DRAFT_KEY)!)).toEqual({ kind: "package", packageId: "package-a" });
    const newKey = paymentIdempotencyKey("checkout", "package-a:alipay:org-aaa");
    expect(newKey).not.toBe(oldKey);
    expect(paymentIdempotencyKey("checkout", "package-a:alipay:org-aaa")).toBe(newKey);
  });
});
