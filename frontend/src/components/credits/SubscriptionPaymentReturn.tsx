// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import {
  CHECKOUT_DRAFT_KEY,
  CHECKOUT_RETURN_KEY,
  CREDIT_CENTER_TAB_KEY,
  OPEN_CREDIT_CENTER_KEY,
  safePaymentReturnPath,
} from "@/lib/payment-navigation";
import { queryKeys } from "@/lib/query-keys";
import {
  safeSubscriptionCheckout,
  useSubscription,
} from "@/lib/queries/subscriptions";
import {
  SUBSCRIPTION_RETURN_KEY,
  subscriptionResultState,
} from "@/lib/subscription-checkout";
import { cn } from "@/lib/utils";
import { PaymentResultShell } from "@/components/credits/PaymentResultShell";

export function SubscriptionPaymentReturn({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const query = useSubscription(id);
  const subscription = query.data?.data;
  const state = subscriptionResultState(subscription, query.isError);
  const paid = state === "active" || state === "paid";
  const pending = state === "confirming" || state === "authorized";
  const Icon =
    state === "active"
      ? CheckCircle2
      : paid || state === "authorized"
        ? Clock3
        : pending
          ? LoaderCircle
          : state === "failed" || state === "cancelled"
            ? XCircle
            : TriangleAlert;
  useEffect(() => {
    if (paid) {
      void client.invalidateQueries({ queryKey: queryKeys.creditSummary() });
      void client.invalidateQueries({
        queryKey: ["subscriptions"],
        predicate: (query) => query.queryKey[2] === "membership",
      });
    }
  }, [paid, client]);
  const back = () => {
    sessionStorage.setItem(OPEN_CREDIT_CENTER_KEY, "1");
    sessionStorage.setItem(CREDIT_CENTER_TAB_KEY, "subscriptions");
    sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
    sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
    window.location.assign(
      safePaymentReturnPath(sessionStorage.getItem(CHECKOUT_RETURN_KEY)),
    );
  };
  let checkout: string | null = null;
  if (
    subscription?.checkout_url &&
    subscription.auto_renew &&
    subscription.authorization_status === "pending" &&
    !paid
  ) {
    try {
      checkout = safeSubscriptionCheckout(
        subscription.checkout_url,
        subscription.payment_method,
      );
    } catch {
      /* An unsafe URL never becomes a navigation action. */
    }
  }
  return (
    <PaymentResultShell
      back={
        <button
          type="button"
          onClick={back}
          className="inline-flex h-9 w-fit items-center gap-2 rounded-md px-2 text-sm text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("paymentReturn.back")}
        </button>
      }
    >
      <span
        className={cn(
          "flex size-14 items-center justify-center rounded-full bg-white/[0.05]",
          state === "active"
            ? "text-success"
            : pending || paid
              ? "text-sky-300"
              : "text-warning",
        )}
      >
        <Icon
          className={cn("size-7", state === "confirming" && "animate-spin")}
        />
      </span>
      <h1 className="mt-5 text-xl font-semibold">
        {t(`subscriptionReturn.states.${state}.title`)}
      </h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {t(`subscriptionReturn.states.${state}.description`)}
      </p>
      {subscription && (
        <div className="mt-6 w-full space-y-3 rounded-lg border border-border p-5 text-left text-sm">
          <p className="font-medium">
            {subscription.offer.name} ·{" "}
            {t(`subscriptions.cycle.${subscription.offer.billing_months}`)}
          </p>
          <p className="break-all text-xs text-muted-foreground">
            {t("subscriptionReturn.number")}: {subscription.subscription_id}
          </p>
          {paid && (
            <>
              <p>
                {t("subscriptions.paidUntil")}:{" "}
                {new Date(subscription.paid_until!).toLocaleString(
                  i18n.language,
                )}
              </p>
              <p>
                {t(
                  subscription.offer.grant_mode === "monthly"
                    ? "subscriptionCheckout.monthlyGrants"
                    : "subscriptionCheckout.upfrontGrants",
                  {
                    credits: (
                      subscription.offer.credits_per_month *
                      (subscription.offer.grant_mode === "monthly"
                        ? 1
                        : subscription.offer.billing_months)
                    ).toLocaleString(i18n.language),
                    count: subscription.offer.billing_months,
                  },
                )}
              </p>
              <p>
                {t(
                  subscription.auto_renew
                    ? "subscriptionReturn.renewal"
                    : "subscriptionReturn.notRenewing",
                  {
                    date: new Date(subscription.paid_until!).toLocaleDateString(
                      i18n.language,
                    ),
                  },
                )}
              </p>
            </>
          )}
        </div>
      )}
      {(query.isError || pending) && (
        <button
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm"
        >
          <RefreshCw className="size-4" />
          {t("paymentReturn.retry")}
        </button>
      )}
      {checkout && (
        <a href={checkout} className="mt-5 text-sm text-primary underline">
          {t("subscriptions.continueCheckout")}
        </a>
      )}
      <button
        type="button"
        onClick={() =>
          window.location.assign(
            `/credits?subscription_id=${encodeURIComponent(id)}`,
          )
        }
        className="mt-6 h-11 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground"
      >
        {t("subscriptionReturn.manage")}
      </button>
      <button
        type="button"
        onClick={back}
        className="mt-4 text-sm text-muted-foreground"
      >
        {t("paymentReturn.returnButton")}
      </button>
    </PaymentResultShell>
  );
}
