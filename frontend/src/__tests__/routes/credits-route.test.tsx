// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ce: false,
  available: undefined as boolean | undefined,
  navigate: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  redirect: (options: unknown) => options,
  useNavigate: () => state.navigate,
}));
vi.mock("@/lib/runtime-config", () => ({ isCeRuntime: () => state.ce }));
vi.mock("@/lib/queries/product-surfaces", () => ({
  useProductSurfaces: () => ({ data: state.available }),
  surfaceAccess: (available: boolean | undefined) => ({ available }),
}));
vi.mock("@/components/credits/CreditCenterDialog", () => ({
  CreditCenterDialog: ({ open, initialTab, paymentAvailable, onOpenChange }: {
    open: boolean; initialTab: string; paymentAvailable: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div role="dialog" data-open={open} data-tab={initialTab} data-payment={paymentAvailable}>
      <button onClick={() => onOpenChange(false)}>Close</button>
    </div>
  ),
}));

import { CreditsPage, Route } from "@/routes/_app/credits";

const beforeLoad = (Route as unknown as {
  beforeLoad: (context: { location: { searchStr: string } }) => void;
}).beforeLoad;

describe("credits entry", () => {
  beforeEach(() => {
    state.ce = false;
    state.available = undefined;
    state.navigate.mockClear();
  });

  it.each(["mchOrderNo", "out_trade_no", "merchant_order_no"])(
    "routes a historical %s payment return to server-verified results", (key) => {
      expect(() => beforeLoad({ location: { searchStr: `?${key}=DC1&sign=secret&state=2&money=1000` } }))
        .toThrow(expect.objectContaining({
          href: "/payment-return?merchant_order_no=DC1", replace: true,
        }));
    },
  );

  it("does not treat a success parameter without an order as proof of payment", () => {
    expect(beforeLoad({ location: { searchStr: "?state=2&trade_status=TRADE_SUCCESS" } })).toBeUndefined();
  });

  it("keeps community edition outside the credit entry", () => {
    state.ce = true;
    expect(() => beforeLoad({ location: { searchStr: "?mchOrderNo=DC1" } }))
      .toThrow(expect.objectContaining({ to: "/", replace: true }));
  });

  it.each([true, false, undefined])("uses the shared dialog with payment availability %s", (available) => {
    state.available = available;
    render(<CreditsPage />);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-tab", "usage");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-payment", String(available ?? false));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(state.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });
});
