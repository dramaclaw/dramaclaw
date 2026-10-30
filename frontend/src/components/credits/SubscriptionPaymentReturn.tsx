// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
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
  useSubscription,
  useRefreshSubscription,
} from "@/lib/queries/subscriptions";
import {
  SUBSCRIPTION_RETURN_KEY,
  subscriptionResultState,
  subscriptionResultShouldPoll,
} from "@/lib/subscription-checkout";
import { cn } from "@/lib/utils";
import { PaymentResultShell } from "@/components/credits/PaymentResultShell";

export function SubscriptionPaymentReturn({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [pollExpired, setPollExpired] = useState(false);
  const [pollEpoch, setPollEpoch] = useState(0);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const query = useSubscription(id, true, (value) =>
    subscriptionResultShouldPoll(value), pollExpired ? 15_000 : 5_000);
  const refresh = useRefreshSubscription();
  const subscription = query.data?.data;
  const resultState = subscriptionResultState(subscription, query.isError);
  const state = pollExpired &&
    ["confirming", "awaitingPayment", "checkoutUnavailable"].includes(resultState)
    ? "unconfirmed" : resultState;
  const paid = state === "active" || state === "paid";
  const pending = ["confirming", "awaitingPayment", "authorized", "unconfirmed"].includes(state);
  const Icon =
    state === "active"
      ? CheckCircle2
      : paid || ["authorized", "awaitingPayment", "unconfirmed"].includes(state)
        ? Clock3
        : pending
          ? LoaderCircle
          : state === "failed" || state === "cancelled"
            ? XCircle
            : TriangleAlert;
  useEffect(() => {
    setPollExpired(false);
    const timer = window.setTimeout(() => setPollExpired(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [id, pollEpoch]);
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
  const viewBills = () => {
    sessionStorage.setItem(OPEN_CREDIT_CENTER_KEY, "1");
    sessionStorage.setItem(CREDIT_CENTER_TAB_KEY, "orders");
    sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
    sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
    window.location.assign(
      safePaymentReturnPath(sessionStorage.getItem(CHECKOUT_RETURN_KEY)),
    );
  };
  // A subscription spans multiple bills. Show the bill for the displayed paid
  // period, not an upcoming renewal or the internal subscription identity.
  const now = Date.now();
  const invoice = [...(subscription?.invoices ?? [])]
    .filter((item) => !paid || (item.status === "paid" && item.period_start &&
      item.period_end && Date.parse(item.period_start) <= now && Date.parse(item.period_end) > now))
    .sort((a, b) => b.cycle_index - a.cycle_index)[0];
  const billNumber = invoice?.merchant_order_no || invoice?.invoice_id;
  const priceAmount = subscription?.payment_method === "dodo"
    ? subscription.offer.payment_amount_minor : subscription?.offer.amount_minor;
  const priceCurrency = subscription?.payment_method === "dodo"
    ? subscription.offer.payment_currency : subscription?.offer.currency;
  const price = typeof priceAmount === "number" && Number.isSafeInteger(priceAmount) &&
    priceAmount >= 0 && priceCurrency
    ? new Intl.NumberFormat(i18n.language, {
      style: "currency", currency: priceCurrency,
    }).format(priceAmount / 100)
    : null;
  const refreshStatus = async () => {
    setRecoveryNotice(null);
    try {
      const result = await refresh.mutateAsync(id);
      setPollEpoch((epoch) => epoch + 1);
      if (result.data.recovery_error) {
        setRecoveryNotice(result.data.recovery_error === "SUBSCRIPTION_PAYMENT_CONFIG_INVALID"
          ? "subscriptions.recoveryConfigUnavailable" : "subscriptions.recoveryUnavailable");
        return;
      }
    } catch {
      setRecoveryNotice("subscriptions.recoveryUnavailable");
    }
  };
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
            {subscription.offer.name}
            {price && <> · {price}{t(`subscriptions.cycle.${subscription.offer.billing_months}`)}</>}
          </p>
          {billNumber && (
            <p className="break-all text-xs text-muted-foreground">
              {t("credits.recharge.columns.billId")}: {billNumber}
            </p>
          )}
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
      {(query.isError ||
        pending ||
        state === "checkoutUnavailable" ||
        state === "expired") && (
        <button
          type="button"
          disabled={query.isFetching || refresh.isPending}
          onClick={() => void refreshStatus()}
          className="mt-5 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm"
        >
          <RefreshCw className="size-4" />
          {t("paymentReturn.retry")}
        </button>
      )}
      {recoveryNotice && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">{t(recoveryNotice)}</p>
      )}
      <button
        type="button"
        onClick={viewBills}
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
