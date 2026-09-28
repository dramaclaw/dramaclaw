// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { CreditCenterDialog } from "@/components/credits/CreditCenterDialog";
import { paymentOrderNumberFromSearch } from "@/lib/payment-navigation";
import { surfaceAccess, useProductSurfaces } from "@/lib/queries/product-surfaces";
import { isCeRuntime } from "@/lib/runtime-config";

export function CreditsPage() {
  const navigate = useNavigate();
  const surfaces = useProductSurfaces();
  const paymentAvailable = surfaceAccess(surfaces.data, "payment")?.available ?? false;

  return (
    <CreditCenterDialog
      open
      initialTab="usage"
      paymentAvailable={paymentAvailable}
      onOpenChange={(open) => {
        if (!open) void navigate({ to: "/", replace: true });
      }}
    />
  );
}

export const Route = createFileRoute("/_app/credits")({
  beforeLoad: ({ location }) => {
    if (isCeRuntime()) throw redirect({ to: "/", replace: true });
    const orderNo = paymentOrderNumberFromSearch(location.searchStr);
    if (orderNo) {
      // Old payment links are navigation hints, never proof of payment.
      throw redirect({
        href: `/payment-return?merchant_order_no=${encodeURIComponent(orderNo)}`,
        replace: true,
      });
    }
  },
  component: CreditsPage,
});
