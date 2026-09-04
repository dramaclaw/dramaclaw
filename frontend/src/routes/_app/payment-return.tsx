// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  CHECKOUT_DRAFT_KEY,
  CHECKOUT_RETURN_KEY,
  clearPaymentAttempt,
  CREDIT_CENTER_TAB_KEY,
  OPEN_CREDIT_CENTER_KEY,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
  paymentOrderNumberFromSearch,
  safePaymentReturnPath,
} from "@/lib/payment-navigation";
import { resolvePaymentReturnState, type PaymentReturnState } from "@/lib/payment-return";
import { useRechargeOrder, useRechargeOrders } from "@/lib/queries/payments";
import { cn } from "@/lib/utils";

const STATE_PRESENTATION: Record<
  PaymentReturnState,
  { icon: typeof Clock3; tone: string }
> = {
  confirming: { icon: LoaderCircle, tone: "text-sky-300" },
  credited: { icon: CheckCircle2, tone: "text-success" },
  closed: { icon: Clock3, tone: "text-white/55" },
  failed: { icon: XCircle, tone: "text-destructive" },
  fulfillment_failed: { icon: TriangleAlert, tone: "text-warning" },
	manual_review: { icon: TriangleAlert, tone: "text-warning" },
  refunded: { icon: RotateCcw, tone: "text-white/65" },
  unavailable: { icon: TriangleAlert, tone: "text-warning" },
};

export function PaymentReturnPage() {
  const { t } = useTranslation();
  const expectedOrderNo = sessionStorage.getItem(PAYMENT_RETURN_ORDER_KEY)?.trim() || null;
  const expectedOrderId =
    sessionStorage.getItem(PAYMENT_RETURN_ORDER_ID_KEY)?.trim() || null;
  const providerOrderNo = paymentOrderNumberFromSearch(window.location.search);
  const merchantOrderNo = expectedOrderNo ?? providerOrderNo;
  const orderQuery = useRechargeOrder(expectedOrderId);
  const ordersQuery = useRechargeOrders({ poll: true, enabled: !expectedOrderId });
  const order =
    orderQuery.data?.data ??
    ordersQuery.data?.data.items.find((item) => item.merchant_order_no === merchantOrderNo);
  const activeQueryFailed = expectedOrderId ? orderQuery.isError : ordersQuery.isError;
  const state = resolvePaymentReturnState(
    order,
    activeQueryFailed || (!expectedOrderId && !merchantOrderNo),
  );
  const displayOrderNo = order?.merchant_order_no ?? merchantOrderNo;
  const presentation = STATE_PRESENTATION[state];
  const StatusIcon = presentation.icon;

  const returnToDramaClaw = () => {
    const returnPath = safePaymentReturnPath(sessionStorage.getItem(CHECKOUT_RETURN_KEY));
    sessionStorage.setItem(OPEN_CREDIT_CENTER_KEY, "1");
    sessionStorage.setItem(CREDIT_CENTER_TAB_KEY, "orders");
    sessionStorage.removeItem(CHECKOUT_DRAFT_KEY);
    sessionStorage.removeItem(PAYMENT_RETURN_ORDER_ID_KEY);
    sessionStorage.removeItem(PAYMENT_RETURN_ORDER_KEY);
    clearPaymentAttempt();
    window.location.assign(returnPath);
  };

  return (
    <div className="flex min-h-full flex-col">
      <button
        type="button"
        onClick={returnToDramaClaw}
        className="inline-flex h-9 w-fit items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("paymentReturn.back")}
      </button>

      <section className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-4 pb-20 text-center">
        <span
          className={cn(
            "flex size-14 items-center justify-center rounded-full bg-white/[0.05]",
            presentation.tone,
          )}
        >
          <StatusIcon className={cn("size-7", state === "confirming" && "animate-spin")} />
        </span>
        <h1 className="mt-5 text-xl font-semibold">
          {t(`paymentReturn.states.${state}.title`)}
        </h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          {t(`paymentReturn.states.${state}.description`)}
        </p>
        {displayOrderNo ? (
          <div className="mt-5 text-xs text-white/35">
            {t("paymentReturn.orderNumber")}: {displayOrderNo}
          </div>
        ) : null}
        {state === "unavailable" ? (
          <button
            type="button"
            onClick={() =>
              void (expectedOrderId ? orderQuery.refetch() : ordersQuery.refetch())
            }
            className="mt-6 inline-flex h-10 items-center gap-2 rounded-md border border-white/12 bg-white/[0.04] px-4 text-sm font-medium hover:bg-white/[0.08]"
          >
            <RefreshCw className="size-4" />
            {t("paymentReturn.retry")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={returnToDramaClaw}
          className="mt-8 h-11 min-w-44 rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {t("paymentReturn.returnButton")}
        </button>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/_app/payment-return")({
  component: PaymentReturnPage,
});
