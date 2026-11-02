// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, CreditCard, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useCancelSubscription,
  useMembership,
  useSubscription,
  useSubscriptions,
} from "@/lib/queries/subscriptions";

export function SubscriptionBenefits({ enabled }: { enabled: boolean }) {
  const { t, i18n } = useTranslation();
  const membership = useMembership(enabled);
  const subscriptions = useSubscriptions(enabled);
  const detail = useSubscription(membership.data?.data.active ? membership.data.data.subscription_id ?? null : null, enabled, false);
  const cancel = useCancelSubscription();
  const [confirm, setConfirm] = useState(false);
  const current = membership.data?.data;
  if (!enabled) return null;
  if (membership.isError || subscriptions.isError) {
    return <p role="alert" className="text-sm text-destructive">{t("subscriptions.loadError")}</p>;
  }
  if (!current?.active) return null;
  const subscription = subscriptions.data?.data.items.find(
    (item) => item.subscription_id === current.subscription_id,
  );
  const date = current.valid_until
    ? new Date(current.valid_until).toLocaleString(i18n.language)
    : "—";
  const invoice = detail.data?.data.invoices?.find((item) => item.status === "paid" &&
    item.period_end === current.valid_until);
  const amount = invoice?.provider_total_minor ?? invoice?.payment_amount_minor;
  const price = typeof amount === "number" && invoice?.payment_currency
    ? new Intl.NumberFormat(i18n.language, { style: "currency", currency: invoice.payment_currency }).format(amount / 100)
    : null;
  const renewalLabel = current.auto_renew
    ? t("subscriptions.automaticRenewalEnabled")
    : subscription?.cancellation_confirmed_at
      ? t("subscriptions.automaticRenewalDisabled")
      : t("subscriptions.automaticRenewalCancelling");
  return (
    <article className="w-full overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Sparkles className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{t("subscriptions.currentPlan")}</p>
            <h3 className="mt-1 break-words text-lg font-semibold text-foreground">{current.name}</h3>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <span className={current.auto_renew ? "size-1.5 shrink-0 rounded-full bg-primary" : "size-1.5 shrink-0 rounded-full bg-muted-foreground"} aria-hidden="true" />
              {renewalLabel}
            </p>
          </div>
        </div>
        {current.auto_renew && subscription?.auto_renew && (
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>{t("subscriptions.cancel")}</Button>
        )}
      </div>
      <dl className="grid gap-4 border-t border-border px-5 py-4 sm:grid-cols-2 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <dt className="text-sm text-muted-foreground">{t("subscriptions.paidUntil")}</dt>
            <dd className="mt-1 break-words text-sm font-medium tabular-nums text-foreground">{date}</dd>
          </div>
        </div>
        {price && (
          <div className="flex min-w-0 items-start gap-3">
            <CreditCard className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <dt className="text-sm text-muted-foreground">{t("subscriptions.periodPaymentLabel")}</dt>
              <dd className="mt-1 text-sm font-medium tabular-nums text-foreground">{price}</dd>
            </div>
          </div>
        )}
      </dl>
      {!subscriptions.isPending && !subscription && (
        <p role="alert" className="px-5 pb-4 text-sm text-destructive sm:px-6">{t("subscriptions.loadError")}</p>
      )}
      {confirm && subscription && (
        <div role="alert" className="mx-5 mb-5 space-y-3 rounded-lg border border-border bg-background p-4 sm:mx-6 sm:mb-6">
          <p className="text-sm">{t("subscriptions.cancelExplain")}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={cancel.isPending} onClick={() => cancel.mutate(subscription.subscription_id, {
              onSuccess: () => setConfirm(false),
            })}>{t("subscriptions.confirmCancel")}</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>{t("subscriptions.keep")}</Button>
          </div>
          {cancel.isError && <p className="text-sm text-destructive">{t("subscriptions.cancelUnconfirmed")}</p>}
        </div>
      )}
    </article>
  );
}
