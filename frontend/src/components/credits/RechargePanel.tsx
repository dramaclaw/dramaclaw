// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Check, History, QrCode, WalletCards } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  type RechargeOrder,
  type RechargePaymentMethod,
  submitEpayCheckout,
  useCreateRechargeOrder,
  useRechargeOrders,
  useRechargePackages,
} from "@/lib/queries/payments";
import { cn } from "@/lib/utils";
import {
  paymentIdempotencyKey,
  rememberPaymentOrder,
} from "@/lib/payment-navigation";
import { paymentErrorToastMessage } from "@/lib/payment-errors";

const PANEL = "rounded-lg border border-foreground/12 bg-foreground/8 p-4";
const ITEM = "rounded-md border border-foreground/12 bg-foreground/10";

function money(cents: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function timestamp(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function orderStatus(order: RechargeOrder): string {
  if (
    (order.payment_status === "refunded") !==
    (order.fulfillment_status === "reversed")
  ) {
    return "manualReview";
  }
  if (order.payment_status === "refunded") return "refunded";
  if (order.fulfillment_status === "credited") return "credited";
  if (order.fulfillment_status === "failed") return "creditFailed";
  if (order.payment_status === "paid") return "paid";
  return order.payment_status;
}

export function RechargePanel() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  const [selectedPackage, setSelectedPackage] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<RechargePaymentMethod>("alipay");
  const packages = useRechargePackages();
  const orders = useRechargeOrders();
  const createOrder = useCreateRechargeOrder();
  const packageItems = packages.data?.data.items ?? [];
  const orderItems = orders.data?.data.items ?? [];
  const selectedPackageItem = packageItems.find(
    (item) => item.package_id === selectedPackage,
  );
  const availablePaymentMethods = selectedPackageItem?.payment_methods ?? [];
  const selectedPaymentMethod = availablePaymentMethods.includes(paymentMethod)
    ? paymentMethod
    : availablePaymentMethods[0];

  const pay = async () => {
    if (!selectedPackage || !selectedPaymentMethod || createOrder.isPending) return;
    try {
      const response = await createOrder.mutateAsync({
        packageId: selectedPackage,
        paymentMethod: selectedPaymentMethod,
        idempotencyKey: paymentIdempotencyKey(
          "web",
          JSON.stringify({ packageId: selectedPackage, paymentMethod: selectedPaymentMethod }),
        ),
      });
      rememberPaymentOrder(response.data.order);
      if (!response.data.checkout) {
        window.location.assign("/payment-return");
        return;
      }
      submitEpayCheckout(response.data.checkout);
    } catch (error) {
      toast.error(paymentErrorToastMessage(error, t, "credits.recharge.createFailed"));
    }
  };

  return (
    <section className={PANEL}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {t("credits.recharge.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("credits.recharge.subtitle")}
          </p>
        </div>
        <History className="size-4 text-muted-foreground" strokeWidth={1.75} />
      </div>

      {packages.isPending ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          {t("credits.recharge.loading")}
        </p>
      ) : null}
      {packages.isError ? (
        <div className="mt-4 flex items-center justify-between gap-3 text-sm text-destructive">
          <span role="alert">{t("credits.recharge.unavailable")}</span>
          <button
            type="button"
            className="rounded-md border border-foreground/15 px-3 py-1.5 text-xs text-foreground hover:bg-foreground/10"
            onClick={() => void packages.refetch()}
          >
            {t("credits.retry")}
          </button>
        </div>
      ) : null}
      {!packages.isPending && !packages.isError && packageItems.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {t("credits.recharge.empty")}
        </p>
      ) : null}

      {packageItems.length > 0 ? (
        <>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {packageItems.map((item) => {
              const selected = selectedPackage === item.package_id;
              const credits = item.base_credits + item.gift_credits;
              return (
                <button
                  key={item.package_id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedPackage(item.package_id)}
                  className={cn(
                    ITEM,
                    "relative min-h-28 p-3 text-left transition-colors",
                    "hover:border-foreground/25 hover:bg-foreground/15",
                    selected && "border-primary/50 ring-1 ring-inset ring-primary/30",
                  )}
                >
                  {selected ? (
                    <Check className="absolute right-3 top-3 size-4 text-primary" />
                  ) : null}
                  <div className="pr-6 text-sm font-medium text-foreground">{item.name}</div>
                  <div className="mt-2 text-xl font-semibold text-foreground tabular-nums">
                    {money(item.amount_cents, language)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("credits.recharge.credits", { count: credits })}
                    {item.gift_credits > 0
                      ? ` · ${t("credits.recharge.gift", { count: item.gift_credits })}`
                      : ""}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-foreground/12 pt-4">
            <div
              className="inline-flex rounded-md border border-foreground/12 bg-foreground/10 p-1"
              aria-label={t("credits.recharge.paymentMethod")}
            >
              {availablePaymentMethods.map((method) => (
                <button
                  key={method}
                  type="button"
                  aria-pressed={selectedPaymentMethod === method}
                  onClick={() => setPaymentMethod(method)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors",
                    selectedPaymentMethod === method
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {method === "alipay" ? (
                    <WalletCards className="size-3.5" />
                  ) : (
                    <QrCode className="size-3.5" />
                  )}
                  {t(`credits.recharge.methods.${method}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!selectedPackage || !selectedPaymentMethod || createOrder.isPending}
              onClick={() => void pay()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <WalletCards className="size-4" />
              {createOrder.isPending
                ? t("credits.recharge.creating")
                : t("credits.recharge.pay")}
            </button>
          </div>
        </>
      ) : null}

      <div className="mt-5 border-t border-foreground/12 pt-4">
        <h3 className="text-sm font-medium text-foreground">
          {t("credits.recharge.history")}
        </h3>
        {orders.isPending ? (
          <p className="mt-3 text-xs text-muted-foreground" role="status">
            {t("credits.recharge.loadingOrders")}
          </p>
        ) : orderItems.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {t("credits.recharge.noOrders")}
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">{t("credits.recharge.columns.time")}</th>
                  <th className="py-2 font-medium">{t("credits.recharge.columns.package")}</th>
                  <th className="py-2 font-medium">{t("credits.recharge.columns.amount")}</th>
                  <th className="py-2 font-medium">{t("credits.recharge.columns.credits")}</th>
                  <th className="py-2 font-medium">{t("credits.recharge.columns.status")}</th>
                </tr>
              </thead>
              <tbody>
                {orderItems.map((order) => (
                  <tr key={order.order_id} className="border-t border-foreground/10">
                    <td className="py-2.5 text-muted-foreground">
                      {timestamp(order.created_at, language)}
                    </td>
                    <td className="py-2.5 text-foreground">{order.package_name}</td>
                    <td className="py-2.5 text-foreground tabular-nums">
                      {money(order.amount_cents, language)}
                    </td>
                    <td className="py-2.5 text-foreground tabular-nums">
                      {order.base_credits + order.gift_credits}
                    </td>
                    <td className="py-2.5 text-muted-foreground">
                      {t(`credits.recharge.status.${orderStatus(order)}`)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
