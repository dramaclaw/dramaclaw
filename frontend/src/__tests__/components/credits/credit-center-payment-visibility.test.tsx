// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreditCenterDialog } from "@/components/credits/CreditCenterDialog";

const rechargeOrdersQuery = vi.hoisted(() => vi.fn());
const creditState = vi.hoisted(() => ({ summary: undefined as Record<string, unknown> | undefined }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "zh", language: "zh" },
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { username: string }) => unknown) =>
    selector({ username: "alice" }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h1>{children}</h1>,
}));

vi.mock("@/lib/queries/credits", () => ({
  useCreditSummary: () => ({ data: creditState.summary ? { data: creditState.summary } : undefined }),
  useCreditPromotions: () => ({ data: undefined, isPending: false }),
  useCreditFilterOptions: () => ({ data: undefined }),
  useCreditTransactions: () => ({ data: undefined, isPending: false }),
}));

vi.mock("@/lib/queries/payments", () => ({
  useRechargePackages: () => ({ data: undefined, isPending: false }),
  useCustomRechargeConfig: () => ({ data: undefined, isPending: false }),
  useRechargeOrders: rechargeOrdersQuery,
}));

function renderDialog(
  paymentAvailable: boolean,
  initialTab: "benefits" | "orders" = "benefits",
) {
  return render(
    <CreditCenterDialog
      open
      onOpenChange={vi.fn()}
      initialTab={initialTab}
      paymentAvailable={paymentAvailable}
    />,
  );
}

describe("CreditCenterDialog payment visibility", () => {
  beforeEach(() => {
    creditState.summary = undefined;
    rechargeOrdersQuery.mockReset();
    rechargeOrdersQuery.mockReturnValue({ data: undefined, isPending: false });
  });

  it("hides all recharge surfaces and skips loading orders when payment is disabled", () => {
    renderDialog(false);

    expect(screen.queryByRole("button", { name: "credits.centerModal.tabs.packages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "credits.centerModal.tabs.custom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "credits.centerModal.tabs.orders" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "credits.centerModal.tabs.usage" })).not.toHaveLength(0);
    expect(rechargeOrdersQuery).toHaveBeenCalledWith({ enabled: false });
  });

  it("falls back to usage when stale payment return state requests billing history", () => {
    renderDialog(false, "orders");

    expect(
      screen.getByRole("heading", { name: "credits.centerModal.tabs.usage" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "credits.centerModal.tabs.orders" }),
    ).not.toBeInTheDocument();
  });

  it("shows recharge and billing history when payment is enabled", () => {
    renderDialog(true);

    expect(screen.getAllByRole("button", { name: "credits.centerModal.tabs.packages" })).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "credits.centerModal.tabs.custom" })).not.toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "credits.centerModal.tabs.orders" })).not.toHaveLength(0);
    expect(rechargeOrdersQuery).toHaveBeenCalledWith({ enabled: true });
  });

  it.each(["personal", "org_member"])("shows the current %s account balance, not a dormant wallet", (scope) => {
    creditState.summary = {
      scope, balance: 3999, earned: 5000, spent: 1001, refunded: 0,
      dormant_personal_balance: scope === "org_member" ? 12345 : null,
      organization: scope === "org_member" ? { org_id: "org-a", name: "Organization A" } : null,
    };
    renderDialog(false, "orders");
    expect(screen.getAllByText("3,999").length).toBeGreaterThan(0);
    expect(screen.queryByText("12,345")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "credits.centerModal.tabs.usage" })).toBeInTheDocument();
  });
});
