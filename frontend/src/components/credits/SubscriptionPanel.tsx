// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/stores/auth-store";
import { beginSubscriptionCheckout } from "@/lib/subscription-checkout";
import {
  groupSubscriptionPlans,
  subscriptionBlocksPurchase,
  useMembership,
  useSubscriptionPlans,
  useSubscriptions,
} from "@/lib/queries/subscriptions";
import { SubscriptionCatalog } from "./SubscriptionCatalog";

export function SubscriptionPanel({
  enabled = true,
}: {
  enabled?: boolean;
  initialId?: string | null;
}) {
  const { t } = useTranslation();
  const username = useAuthStore((state) => state.username);
  const plans = useSubscriptionPlans(enabled);
  const subscriptions = useSubscriptions(enabled);
  const membership = useMembership(enabled);
  const [purchaseBlocked, setPurchaseBlocked] = useState(false);
  const activeMembership = membership.data?.data.active ? membership.data.data : null;
  const existingApplication = (subscriptions.data?.data.items ?? []).some((row) =>
    subscriptionBlocksPurchase(row),
  );
  const paymentUnavailable = plans.data?.data.items.some((plan) =>
    plan.offers.some((offer) => offer.unavailable_reason === "SUBSCRIPTION_PAYMENT_CONFIG_INVALID"),
  );
  if (!enabled) return null;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("subscriptions.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("subscriptions.intro")}</p>
      </div>
      {(plans.isError || subscriptions.isError || membership.isError) && (
        <div role="alert" className="text-sm text-destructive">
          {t("subscriptions.loadError")} {" "}
          <Button variant="outline" onClick={() => {
            void plans.refetch();
            void subscriptions.refetch();
            void membership.refetch();
          }}>{t("subscriptions.refresh")}</Button>
        </div>
      )}
      {paymentUnavailable && (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
          <p>{t("subscriptions.paymentUnavailable")}</p>
          <Button variant="outline" disabled={plans.isFetching} onClick={() => void plans.refetch()}>
            {t("subscriptions.recheckPayment")}
          </Button>
        </div>
      )}
      {purchaseBlocked && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("subscriptionCheckout.existing")}
        </p>
      )}
      <SubscriptionCatalog
        groups={plans.data?.data.groups ?? groupSubscriptionPlans(plans.data?.data.items ?? [])}
        disabled={!subscriptions.isSuccess || !membership.isSuccess || !!activeMembership}
        currentPlan={activeMembership ? {
          plan_id: activeMembership.plan_id,
          version: activeMembership.plan_version,
        } : null}
        loaded={plans.isSuccess}
        onSelect={(plan) => {
          if (existingApplication) {
            setPurchaseBlocked(true);
            void subscriptions.refetch();
            return;
          }
          setPurchaseBlocked(false);
          beginSubscriptionCheckout(plan, username ?? "");
        }}
      />
    </div>
  );
}
