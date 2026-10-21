// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth-store";
import {
  safeSubscriptionCheckout,
  subscriptionAttemptKey,
  forgetSubscriptionAttempt,
  bindSubscriptionAttempt,
  subscriptionStatus,
  useCancelSubscription,
  useRetrySubscription,
  useCreateSubscription,
  useSubscription,
  useSubscriptionPlans,
  useSubscriptions,
  useMembership,
  type SubscriptionMethod,
  type SubscriptionPlan,
} from "@/lib/queries/subscriptions";

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
  const create = useCreateSubscription();
  const cancel = useCancelSubscription();
  const retry = useRetrySubscription();
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [quoteChanged, setQuoteChanged] = useState(false);
  const [creationRejected, setCreationRejected] = useState(false);
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
  async function purchase(
    plan: SubscriptionPlan,
    method: SubscriptionMethod,
    customer?: { name: string; email: string },
  ) {
    setNotice(false);
    setQuoteChanged(false);
    setCreationRejected(false);
    try {
      const result = await create.mutateAsync({
        plan,
        method,
        customer,
        key: subscriptionAttemptKey(
          username ?? "",
          plan.plan_id,
          plan.version,
          method,
        ),
      });
      setSelectedId(result.data.subscription.subscription_id);
      bindSubscriptionAttempt(
        username ?? "",
        plan.plan_id,
        plan.version,
        method,
        result.data.subscription.subscription_id,
      );
      if (["ready", "failed"].includes(result.data.subscription.checkout_state))
        forgetSubscriptionAttempt(
          username ?? "",
          plan.plan_id,
          plan.version,
          method,
        );
      if (result.data.subscription.checkout_state === "failed")
        setCreationRejected(true);
      if (result.data.checkout_url)
        window.location.assign(
          safeSubscriptionCheckout(result.data.checkout_url, method),
        );
    } catch (error) {
      if (
        error instanceof HTTPError &&
        error.data &&
        typeof error.data === "object"
      ) {
        if (
          "detail" in error.data &&
          error.data.detail === "SUBSCRIPTION_QUOTE_CHANGED"
        ) {
          setQuoteChanged(true);
          void plans.refetch();
          return;
        }
      }
      setNotice(true);
    }
  }
  if (!enabled) return null;
  return (
    <div className="space-y-6">
      {creationRejected && (
        <p role="alert" className="text-sm text-warning">
          {t("subscriptions.creationRejected")}
        </p>
      )}
      {quoteChanged && (
        <p role="alert" className="text-sm text-warning">
          {t("subscriptions.quoteChanged")}
        </p>
      )}
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
      {notice && (
        <p role="alert" className="text-sm text-warning">
          {t("subscriptions.createUnconfirmed")}
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(plans.data?.data.items ?? []).map((plan) => (
          <PlanCard
            key={`${plan.plan_id}:${plan.version}`}
            plan={plan}
            disabled={blocked || create.isPending}
            money={money}
            onPurchase={purchase}
          />
        ))}
      </div>
      {plans.isSuccess && !plans.data.data.items.length && (
        <p className="text-sm text-muted-foreground">
          {t("subscriptions.noPlans")}
        </p>
      )}
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
                  {t(`subscriptions.status.${subscriptionStatus(row)}`)}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => setSelectedId(row.subscription_id)}
              >
                {t("subscriptions.details")}
              </Button>
            </div>
            <p className="mt-2 text-sm">
              {t("subscriptions.paidUntil")}: {date(row.paid_until)}
            </p>
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
            {t(`subscriptions.status.${subscriptionStatus(selected)}`)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("subscriptions.paidUntil")}: {date(selected.paid_until)}
          </p>
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

function PlanCard({
  plan,
  disabled,
  money,
  onPurchase,
}: {
  plan: SubscriptionPlan;
  disabled: boolean;
  money: (amount: number, currency: string) => string;
  onPurchase: (
    plan: SubscriptionPlan,
    method: SubscriptionMethod,
    customer?: { name: string; email: string },
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<SubscriptionMethod>(
    plan.offers[0]?.payment_method ?? "alipay",
  );
  const [accepted, setAccepted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const offer = plan.offers.find((item) => item.payment_method === method);
  useEffect(() => {
    setAccepted(false);
  }, [
    offer?.amount_minor,
    offer?.first_amount_minor,
    offer?.payment_amount_minor,
    offer?.fx_rate_snapshot,
  ]);
  if (!offer) return null;
  return (
    <form
      className="space-y-3 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!accepted || disabled) return;
        void onPurchase(
          plan,
          method,
          method === "alipay"
            ? { name: name.trim(), email: email.trim() }
            : undefined,
        );
      }}
    >
      <h3 className="font-semibold">{plan.name}</h3>
      <p className="text-sm text-muted-foreground">{plan.description}</p>
      <select
        aria-label={t("subscriptions.method")}
        value={method}
        onChange={(event) => {
          setMethod(event.target.value as SubscriptionMethod);
          setAccepted(false);
        }}
        className="w-full rounded-md border border-border bg-background p-2"
      >
        {plan.offers.map((item) => (
          <option key={item.payment_method} value={item.payment_method}>
            {t(`subscriptions.methods.${item.payment_method}`)}
          </option>
        ))}
      </select>
      <p className="text-xl font-semibold">
        {money(offer.first_amount_minor ?? offer.amount_minor, offer.currency)}{" "}
        <span className="text-sm font-normal">
          {t(`subscriptions.cycle.${plan.billing_months}`)}
        </span>
      </p>
      {method === "dodo" &&
        offer.payment_currency === "USD" &&
        offer.payment_amount_minor != null && (
          <p className="text-sm text-muted-foreground">
            {t("subscriptions.dodoQuote", {
              price: money(offer.payment_amount_minor, "USD"),
              rate: offer.fx_rate_snapshot,
            })}
          </p>
        )}
      <p className="text-sm">
        {t(
          offer.first_amount_minor != null && (plan.intro_cycles ?? 1) > 1
            ? "subscriptions.renewAfterIntro"
            : "subscriptions.renewPrice",
          {
            price: money(offer.amount_minor, offer.currency),
            months: plan.billing_months,
            cycles: plan.intro_cycles,
          },
        )}
      </p>
      {plan.billing_months > 1 && (
        <p className="text-sm text-muted-foreground">
          {t("subscriptions.monthlyEquivalent", {
            price: money(
              offer.amount_minor / plan.billing_months,
              offer.currency,
            ),
          })}
        </p>
      )}
      {offer.first_amount_minor != null &&
        offer.first_amount_minor !== offer.amount_minor &&
        (plan.intro_cycles ?? 1) > 1 && (
          <p className="text-sm">
            {t("subscriptions.introCycles", {
              cycles: plan.intro_cycles,
              price: money(offer.first_amount_minor, offer.currency),
            })}
          </p>
        )}
      <p className="text-sm text-muted-foreground">
        {t(
          plan.grant_mode === "monthly"
            ? "subscriptions.monthlyCredits"
            : "subscriptions.upfrontCredits",
          {
            credits:
              plan.grant_mode === "monthly"
                ? plan.credits_per_month
                : plan.credits_per_month * plan.billing_months,
          },
        )}
      </p>
      {method === "dodo" && (
        <p className="text-xs text-muted-foreground">
          {t("subscriptions.taxNote")}
        </p>
      )}
      {method === "alipay" && (
        <div className="space-y-2">
          <input
            required
            maxLength={64}
            aria-label={t("subscriptions.customerName")}
            placeholder={t("subscriptions.customerName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-md border border-border bg-background p-2"
          />
          <input
            required
            type="email"
            maxLength={255}
            aria-label={t("subscriptions.customerEmail")}
            placeholder={t("subscriptions.customerEmail")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-md border border-border bg-background p-2"
          />
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          {t("subscriptions.consent")}{" "}
          <a
            href={plan.terms_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            {t("subscriptions.terms")}
          </a>
        </span>
      </label>
      <Button type="submit" disabled={disabled || !accepted}>
        {t("subscriptions.subscribe")}
      </Button>
    </form>
  );
}
