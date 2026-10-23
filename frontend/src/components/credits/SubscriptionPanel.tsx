// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import { beginSubscriptionCheckout } from "@/lib/subscription-checkout";
import {
  safeSubscriptionCheckout,
  forgetSubscriptionAttempt,
  subscriptionStatus,
  useCancelSubscription,
  useRetrySubscription,
  useSubscription,
  useSubscriptionPlans,
  useSubscriptions,
  useMembership,
  groupSubscriptionPlans,
} from "@/lib/queries/subscriptions";

import { SubscriptionCatalog } from "./SubscriptionCatalog";

export function SubscriptionPanel({
  enabled = true,
  initialId = null,
}: {
  enabled?: boolean;
  initialId?: string | null;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const username = useAuthStore((state) => state.username);
  const plans = useSubscriptionPlans(enabled);
  const subscriptions = useSubscriptions(enabled);
  const membership = useMembership(enabled);
  const [selectedId, setSelectedId] = useState<string | null>(initialId);
  const detail = useSubscription(selectedId, enabled);
  const cancel = useCancelSubscription();
  const retry = useRetrySubscription();
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const rows = subscriptions.data?.data.items ?? [];
  const selected = detail.data?.data;
  const blocked = rows.some(
    (row) =>
      row.auto_renew ||
      !row.cancellation_confirmed_at ||
      (row.paid_until && Date.parse(row.paid_until) > Date.now()),
  );
  const money = (amount: number, currency: string) =>
    new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency,
    }).format(amount / 100);
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString(i18n.language) : "—";
  useEffect(() => {
    if (selected?.grants?.some((grant) => grant.status === "credited")) {
      void client.invalidateQueries({ queryKey: queryKeys.creditSummary() });
    }
  }, [client, selected]);
  useEffect(() => {
    for (const row of rows)
      if (row.cancellation_confirmed_at || row.checkout_state === "ready") {
        forgetSubscriptionAttempt(
          username ?? "",
          row.plan_id,
          row.plan_version,
          row.payment_method,
          row.subscription_id,
        );
      }
  }, [rows, username]);
  if (!enabled) return null;
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("subscriptions.title")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("subscriptions.intro")}
        </p>
      </div>
      {membership.isSuccess && (
        <p className="rounded-lg border border-border p-3 text-sm">
          {membership.data.data.active
            ? t("subscriptions.membershipActive", {
                name: membership.data.data.name,
                date: date(membership.data.data.valid_until ?? null),
              })
            : t("subscriptions.membershipInactive")}
        </p>
      )}
      {(plans.isError ||
        subscriptions.isError ||
        detail.isError ||
        membership.isError) && (
        <div role="alert" className="text-sm text-destructive">
          {t("subscriptions.loadError")}{" "}
          <Button
            variant="outline"
            onClick={() => {
              void plans.refetch();
              void subscriptions.refetch();
              void membership.refetch();
              if (selectedId) void detail.refetch();
            }}
          >
            {t("subscriptions.refresh")}
          </Button>
        </div>
      )}
      {blocked && (
        <p role="status" className="text-xs leading-5 text-white/45">
          {t("subscriptions.purchaseBlocked")}
        </p>
      )}
      <SubscriptionCatalog
        groups={
          plans.data?.data.groups ??
          groupSubscriptionPlans(plans.data?.data.items ?? [])
        }
        disabled={blocked}
        loaded={plans.isSuccess}
        onSelect={(plan) => beginSubscriptionCheckout(plan, username ?? "")}
      />
      <section className="space-y-3">
        <h3 className="font-semibold">{t("subscriptions.mine")}</h3>
        {rows.map((row) => (
          <article
            key={row.subscription_id}
            className="rounded-xl border border-border p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong>{row.offer.name}</strong>
                <p className="text-sm text-muted-foreground">
                  {t(`subscriptions.status.${subscriptionStatus(row)}`, {
                    method: t(`subscriptions.methods.${row.payment_method}`),
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setSelectedId(row.subscription_id)}
              >
                {t("subscriptions.details")}
              </Button>
            </div>
            {row.paid_until && (
              <p className="mt-2 text-sm">
                {t("subscriptions.paidUntil")}: {date(row.paid_until)}
              </p>
            )}
            {row.payment_method === "dodo" &&
              row.auto_renew &&
              row.authorization_status === "active" &&
              !row.review_required &&
              row.billing_status === "failed" &&
              row.paid_until && (
                <Button
                  className="mt-3 mr-3"
                  variant="outline"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate(row.subscription_id)}
                >
                  {t("subscriptions.retryPayment")}
                </Button>
              )}
            {retry.isError && retry.variables === row.subscription_id && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {t("subscriptions.retryUnconfirmed")}
              </p>
            )}
            {row.auto_renew && (
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => setConfirmCancel(row.subscription_id)}
              >
                {t("subscriptions.cancel")}
              </Button>
            )}
            {confirmCancel === row.subscription_id && (
              <div
                role="alert"
                className="mt-3 space-y-3 rounded-lg bg-muted p-3"
              >
                <p className="text-sm">{t("subscriptions.cancelExplain")}</p>
                <Button
                  disabled={cancel.isPending}
                  onClick={() =>
                    cancel.mutate(row.subscription_id, {
                      onSuccess: (result) => {
                        setConfirmCancel(null);
                        if (result.data.cancellation_confirmed_at) {
                          forgetSubscriptionAttempt(
                            username ?? "",
                            row.plan_id,
                            row.plan_version,
                            row.payment_method,
                          );
                        }
                      },
                    })
                  }
                >
                  {t("subscriptions.confirmCancel")}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmCancel(null)}>
                  {t("subscriptions.keep")}
                </Button>
                {cancel.isError && (
                  <p className="text-sm text-destructive">
                    {t("subscriptions.cancelUnconfirmed")}
                  </p>
                )}
              </div>
            )}
          </article>
        ))}
      </section>
      {selected && (
        <section className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="font-semibold">
            {selected.offer.name} · {t("subscriptions.details")}
          </h3>
          <p className="text-sm">
            {t(`subscriptions.status.${subscriptionStatus(selected)}`, {
              method: t(`subscriptions.methods.${selected.payment_method}`),
            })}
          </p>
          {selected.paid_until && (
            <p className="text-sm text-muted-foreground">
              {t("subscriptions.paidUntil")}: {date(selected.paid_until)}
            </p>
          )}
          {selected.checkout_url &&
            selected.auto_renew &&
            !selected.paid_until &&
            selected.authorization_status === "pending" && (
              <Button
                onClick={() =>
                  window.location.assign(
                    safeSubscriptionCheckout(
                      selected.checkout_url!,
                      selected.payment_method,
                    ),
                  )
                }
              >
                {t("subscriptions.continueCheckout")}
              </Button>
            )}
          <h4 className="text-sm font-semibold">
            {t("subscriptions.invoices")}
          </h4>
          {selected.offer.terms_agreement_id &&
            selected.offer.terms_agreement_version && (
              <p className="text-sm">
                <a
                  className="text-primary underline"
                  href={`/terms/subscription/${encodeURIComponent(selected.offer.terms_agreement_id)}/${selected.offer.terms_agreement_version}`}
                >
                  {t("subscriptions.terms")} · v
                  {selected.offer.terms_agreement_version}
                </a>
              </p>
            )}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>{t("subscriptions.period")}</th>
                  <th>{t("subscriptions.amount")}</th>
                  <th>{t("subscriptions.state")}</th>
                </tr>
              </thead>
              <tbody>
                {selected.invoices?.map((invoice) => (
                  <tr
                    key={invoice.invoice_id}
                    className="border-t border-border"
                  >
                    <td className="py-2">
                      {date(invoice.period_start)} — {date(invoice.period_end)}
                    </td>
                    <td>
                      {money(invoice.amount_minor, invoice.currency)}
                      {invoice.payment_currency === "USD" && (
                        <div className="text-xs text-muted-foreground">
                          {t("subscriptions.dodoPaid", {
                            price: money(
                              invoice.provider_total_minor ??
                                invoice.payment_amount_minor,
                              "USD",
                            ),
                          })}
                        </div>
                      )}
                    </td>
                    <td>
                      {t(`subscriptions.invoiceStatus.${invoice.status}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h4 className="text-sm font-semibold">{t("subscriptions.grants")}</h4>
          {selected.grants?.map((grant) => (
            <p
              className="text-sm text-muted-foreground"
              key={grant.month_index}
            >
              {date(grant.due_at)} ·{" "}
              {grant.amount.toLocaleString(i18n.language)} ·{" "}
              {t(`subscriptions.grantStatus.${grant.status}`)}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
