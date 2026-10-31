// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";

import { resolveRechargeOrderStatus } from "@/lib/payment-return";
import type { RechargeOrder } from "@/lib/queries/payments";
import {
  type Subscription,
  type SubscriptionInvoice,
  useSubscriptionBilling,
} from "@/lib/queries/subscriptions";
import { cn } from "@/lib/utils";

type Invoice = SubscriptionInvoice & { created_at?: string };
type Bill =
  | { kind: "recharge"; order: RechargeOrder; at: string }
  | { kind: "subscription"; subscription: Subscription; invoice: Invoice; at: string };

function dateTime(value: string, language: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--";
  return new Intl.DateTimeFormat(language, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function money(cents: number, language: string, currency: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency", currency, minimumFractionDigits: 0,
  }).format(cents / 100);
}

/** Display confirmed subscription invoices alongside existing one-time bills. */
export function BillingOrdersTab({
  orders, loading, language, enabled,
}: {
  orders: RechargeOrder[];
  loading: boolean;
  language: string;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const subscriptions = useSubscriptionBilling(enabled);
  if (loading || (enabled && subscriptions.isPending)) {
    return <div className="py-12 text-center text-sm text-white/40">{t("credits.recharge.loadingOrders")}</div>;
  }
  const invoiceIds = new Set<string>();
  const invoices: Bill[] = [];
  for (const subscription of subscriptions.data?.data.items ?? []) {
    for (const invoice of (subscription.invoices ?? []) as Invoice[]) {
      // Personal recharge history may also contain this exact underlying order.
      invoiceIds.add(invoice.invoice_id);
      const at = invoice.created_at ?? invoice.paid_at ?? "";
      invoices.push({ kind: "subscription", subscription, invoice, at });
    }
  }
  const bills: Bill[] = [
    ...orders.filter((order) => !invoiceIds.has(order.order_id) && !order.order_id.startsWith("sinv_"))
      .map((order): Bill => ({ kind: "recharge", order, at: order.created_at })),
    ...invoices,
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

  if (!bills.length) return <div className="py-12 text-center text-sm text-white/40">{subscriptions.isError ? t("subscriptions.loadError") : t("subscriptions.bill.empty")}</div>;
  return (
    <>
    {subscriptions.isError && <p className="mb-3 text-sm text-white/50">{t("subscriptions.loadError")}</p>}
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-white/[0.045] text-xs text-white/40">
          <tr>{["billId", "transactionTime", "content", "amount", "status"].map((column) => (
            <th key={column} className="px-4 py-3 font-medium">{t(`credits.recharge.columns.${column}`)}</th>
          ))}</tr>
        </thead>
        <tbody>
          {bills.map((bill) => {
            if (bill.kind === "subscription") {
              const { invoice, subscription } = bill;
              // Creating a checkout session is not a debit. The server reports
              // processing only for payment evidence; an unknown create still
              // needs reconciliation without blocking another checkout.
              const status = subscription.settlement_state === "compensating" && invoice.status === "paid"
                ? "compensating" : invoice.status === "processing" ||
                (invoice.status === "pending" && ["creating", "unknown"].includes(subscription.checkout_state))
                ? "unconfirmed" : invoice.status;
              return (
                <tr key={`subscription:${invoice.invoice_id}`} className="border-t border-white/8">
                  <td className="px-4 py-3 font-mono text-xs font-medium text-white/82">{invoice.merchant_order_no || invoice.invoice_id}</td>
                  <td className="px-4 py-3 text-xs tabular-nums text-white/48">{dateTime(bill.at, language)}</td>
                  <td className="max-w-80 px-4 py-3 font-medium">{t("subscriptions.bill.content", { name: subscription.offer.name })}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{money(invoice.provider_total_minor ?? invoice.payment_amount_minor, language, invoice.payment_currency)}</td>
                  <td className="px-4 py-3"><span className={cn(
                    "inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium",
                    status === "paid" && "bg-emerald-500/12 text-emerald-400",
                    (status === "pending" || status === "unconfirmed" || status === "compensating") && "bg-amber-400/12 text-amber-300",
                    status === "failed" && "bg-red-500/12 text-red-400",
                    status === "closed" && "bg-white/8 text-white/45",
                    status === "refunded" && "bg-sky-500/12 text-sky-300",
                  )}>{t(`subscriptions.bill.${status}`)}</span></td>
                </tr>
              );
            }
            const { order } = bill;
            const status = resolveRechargeOrderStatus(order);
            return (
              <tr key={`recharge:${order.order_id}`} className="border-t border-white/8">
                <td className="px-4 py-3 font-mono text-xs font-medium text-white/82">{order.merchant_order_no}</td>
                <td className="px-4 py-3 text-xs tabular-nums text-white/48">{dateTime(order.created_at, language)}</td>
                <td className="max-w-80 px-4 py-3"><div className="truncate font-medium">{order.package_name}</div>
                  <div className="mt-1 text-xs text-white/38">{new Intl.NumberFormat(language).format(order.base_credits + order.gift_credits)} {t("credits.short")}</div></td>
                <td className="px-4 py-3 font-medium tabular-nums">{money(order.provider_total_cents ?? order.amount_cents, language, order.currency)}</td>
                <td className="px-4 py-3"><span className={cn(
                  "inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium",
                  status === "credited" && "bg-emerald-500/12 text-emerald-400",
                  (status === "pending" || status === "paid") && "bg-amber-400/12 text-amber-300",
                  (status === "failed" || status === "creditFailed" || status === "manualReview") && "bg-red-500/12 text-red-400",
                  (status === "expired" || status === "closed") && "bg-white/8 text-white/45",
                  status === "refunded" && "bg-sky-500/12 text-sky-300",
                )}>{t(`credits.recharge.status.${status}`)}</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </>
  );
}
