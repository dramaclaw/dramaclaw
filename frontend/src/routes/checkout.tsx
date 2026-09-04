// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleAlert,
  Building2,
  Check,
  CreditCard,
  LockKeyhole,
  Clock3,
  QrCode,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CreditSparkIcon } from "@/components/credits/credit-visual";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { creditOrgOf, creditScopeOf, useCreditSummary } from "@/lib/queries/credits";
import {
  type RechargePaymentMethod,
  submitEpayCheckout,
  useCreateCustomRechargeOrder,
  useCreateRechargeOrder,
  useCustomRechargeConfig,
  useRechargeOrder,
  useRechargePackages,
} from "@/lib/queries/payments";
import { paymentTimeRemaining, paymentWindowExpired } from "@/lib/payment-return";
import {
  CHECKOUT_DRAFT_KEY,
  CHECKOUT_RETURN_KEY,
  CREDIT_CENTER_TAB_KEY,
  clearPaymentAttempt,
  OPEN_CREDIT_CENTER_KEY,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
  paymentIdempotencyKey,
  rememberPaymentOrder,
  safePaymentReturnPath,
} from "@/lib/payment-navigation";
import { paymentErrorToastMessage } from "@/lib/payment-errors";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

type CheckoutDraft =
  | { kind: "package"; packageId: string }
  | { kind: "custom"; credits: number };

function readCheckoutDraft(): CheckoutDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(CHECKOUT_DRAFT_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const draft = value as Record<string, unknown>;
    if (draft.kind === "package" && typeof draft.packageId === "string") {
      return { kind: "package", packageId: draft.packageId };
    }
    if (
      draft.kind === "custom" &&
      typeof draft.credits === "number" &&
      Number.isFinite(draft.credits) &&
      Number.isSafeInteger(draft.credits) &&
      draft.credits > 0
    ) {
      return {
        kind: "custom",
        credits: draft.credits,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function money(cents: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function number(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

export function CheckoutPage() {
  const { t, i18n } = useTranslation();
  const draft = useMemo(readCheckoutDraft, []);
  const [paymentMethod, setPaymentMethod] = useState<RechargePaymentMethod>("alipay");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const existingOrderId = useMemo(
    () => sessionStorage.getItem(PAYMENT_RETURN_ORDER_ID_KEY)?.trim() || null,
    [],
  );
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  const username = useAuthStore((state) => state.username) ?? t("checkout.account");
  const packagesQuery = useRechargePackages();
  const customRechargeQuery = useCustomRechargeConfig(draft?.kind === "custom");
  const summaryQuery = useCreditSummary();
  const createOrder = useCreateRechargeOrder();
  const createCustomOrder = useCreateCustomRechargeOrder();
  const existingOrderQuery = useRechargeOrder(existingOrderId);
  const existingOrder = existingOrderQuery.data?.data;
  const packageItem =
    draft?.kind === "package"
      ? packagesQuery.data?.data.items.find((item) => item.package_id === draft.packageId)
      : undefined;
  const summary = summaryQuery.data?.data;
  const org = creditOrgOf(summary);
  const targetOrderType =
    existingOrder?.order_type ?? packageItem?.order_type ?? "personal_recharge";
  const effectiveOrgId = existingOrder?.org_id ?? packageItem?.effective_org_id ?? null;
  const isOrgScope = targetOrderType === "org_member_recharge" && Boolean(effectiveOrgId);
  const targetOrganizationName = org?.org_id === effectiveOrgId ? org.name : effectiveOrgId;
  const subjectMatches = Boolean(
    existingOrder ||
      (summary &&
        (targetOrderType === "personal_recharge"
          ? creditScopeOf(summary) === "personal" && effectiveOrgId === null
          : isOrgScope && creditScopeOf(summary) === "org_member" && org?.org_id === effectiveOrgId)),
  );
  const customRecharge = customRechargeQuery.data?.data;
  const configuredPaymentMethods =
    draft?.kind === "custom"
      ? (customRecharge?.payment_methods ?? [])
      : (packageItem?.payment_methods ?? []);
  const selectedPaymentMethod = configuredPaymentMethods.includes(paymentMethod)
    ? paymentMethod
    : configuredPaymentMethods[0];
  const availablePaymentMethods = existingOrder
    ? [existingOrder.payment_method]
    : configuredPaymentMethods;
  const credits =
    draft?.kind === "custom"
      ? draft.credits
      : (packageItem?.base_credits ?? 0) + (packageItem?.gift_credits ?? 0);
  const amountCents =
    draft?.kind === "custom" && customRecharge
      ? Math.ceil((draft.credits * 100) / customRecharge.credits_per_cny)
      : (packageItem?.amount_cents ?? 0);
  const customReady = Boolean(
    draft?.kind === "custom" &&
      customRecharge?.enabled &&
      !isOrgScope &&
      draft.credits >= customRecharge.min_credits &&
      draft.credits <= customRecharge.max_credits,
  );
  const ready = Boolean(
    draft &&
      subjectMatches &&
      selectedPaymentMethod &&
      (draft.kind === "custom" ? customReady : packageItem),
  );
  const creating = createOrder.isPending || createCustomOrder.isPending;
  const paymentClosed = Boolean(
    existingOrder && ["closed", "expired"].includes(existingOrder.payment_status),
  );
  const paymentFailed = existingOrder?.payment_status === "failed";
  const paymentExpired = Boolean(
    existingOrder &&
      existingOrder.payment_status === "pending" &&
      paymentWindowExpired(existingOrder.expires_at, nowMs),
  );
  const paymentPending = Boolean(
    existingOrder && existingOrder.payment_status === "pending" && !paymentExpired,
  );
  const effectivePaymentMethod = existingOrder?.payment_method ?? selectedPaymentMethod;

  useEffect(() => {
    if (!existingOrder || existingOrder.payment_status !== "pending") return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [existingOrder]);

  const leaveCheckout = () => {
    sessionStorage.setItem(OPEN_CREDIT_CENTER_KEY, "1");
    sessionStorage.setItem(CREDIT_CENTER_TAB_KEY, "packages");
    window.location.assign(safePaymentReturnPath(sessionStorage.getItem(CHECKOUT_RETURN_KEY)));
  };

  const continuePayment = async () => {
    if (!draft || !ready || !selectedPaymentMethod || creating) return;
    try {
      const fingerprint = JSON.stringify({
        draft,
        paymentMethod: selectedPaymentMethod,
        orderType: targetOrderType,
        effectiveOrgId,
        amountCents,
        credits,
        configVersion: draft.kind === "custom" ? customRecharge?.version : undefined,
      });
      const idempotencyKey = paymentIdempotencyKey("checkout", fingerprint);
      const response = draft.kind === "custom"
        ? await createCustomOrder.mutateAsync({
            credits: draft.credits,
            configVersion: customRecharge!.version,
            paymentMethod: selectedPaymentMethod,
            idempotencyKey,
          })
        : await createOrder.mutateAsync({
            packageId: draft.packageId,
            paymentMethod: selectedPaymentMethod,
            idempotencyKey,
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

  const handlePrimaryAction = () => {
    if (paymentClosed || paymentFailed) {
      sessionStorage.removeItem(PAYMENT_RETURN_ORDER_ID_KEY);
      sessionStorage.removeItem(PAYMENT_RETURN_ORDER_KEY);
      clearPaymentAttempt();
      window.location.reload();
      return;
    }
    if (existingOrder) {
      window.location.assign("/payment-return");
      return;
    }
    void continuePayment();
  };

  if (
    summaryQuery.isPending ||
    (draft?.kind === "package" && packagesQuery.isPending) ||
    (draft?.kind === "custom" && customRechargeQuery.isPending)
  ) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0b0d11] text-sm text-white/45">
        {t("checkout.loading")}
      </main>
    );
  }

  if (!draft || !subjectMatches || (draft.kind === "package" ? !packageItem : !customReady)) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#0b0d11] px-4 text-white">
        <section className="w-full max-w-md rounded-lg border border-white/10 bg-white/[0.035] p-6 text-center">
          <h1 className="text-lg font-semibold">{t("checkout.invalidTitle")}</h1>
          <p className="mt-2 text-sm text-white/45">
            {t(subjectMatches ? "checkout.invalidDescription" : "checkout.subjectMismatch")}
          </p>
          <button
            type="button"
            onClick={leaveCheckout}
            className="mt-6 h-10 rounded-md bg-white px-5 text-sm font-semibold text-black"
          >
            {t("credits.back")}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0b0d11] text-white">
      <div className="grid min-h-dvh lg:grid-cols-[minmax(360px,0.88fr)_minmax(520px,1.12fr)]">
        <section className="flex min-h-[42dvh] flex-col border-b border-white/8 bg-white/[0.025] px-6 py-7 lg:min-h-dvh lg:border-b-0 lg:border-r lg:px-12 lg:py-10 xl:px-20">
          <button
            type="button"
            onClick={() => setLeaveOpen(true)}
            className="group inline-flex h-9 w-fit items-center gap-2 rounded-md px-2 text-sm text-white/48 transition-colors hover:bg-white/[0.05] hover:text-white"
          >
            <ArrowLeft className="size-4" />
            <span>{t("checkout.back")}</span>
          </button>

          <div className="mx-auto my-auto w-full max-w-lg py-10">
            <div className="text-xs text-white/38">{t("checkout.amountDue")}</div>
            <div className="mt-2 text-4xl font-semibold tabular-nums">
              {money(amountCents, language)}
            </div>

            <div className="mt-10">
              <h1 className="text-base font-semibold">{t("checkout.orderSummary")}</h1>
              <div className="mt-4 rounded-lg border border-white/10 bg-black/15 p-5">
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <div className="font-medium">
                      {draft.kind === "package"
                        ? packageItem?.name
                        : t("checkout.customRecharge")}
                    </div>
                    <div className="mt-1 text-xs text-white/42">
                      {t("checkout.quantity", { count: 1 })}
                    </div>
                  </div>
                  <span className="font-medium tabular-nums">{money(amountCents, language)}</span>
                </div>
                <dl className="mt-5 space-y-3 border-t border-white/8 pt-4 text-sm">
                  {draft.kind === "package" ? (
                    <>
                      <div className="flex justify-between">
                        <dt className="text-white/42">{t("credits.centerModal.baseCredits")}</dt>
                        <dd className="tabular-nums">{number(packageItem?.base_credits ?? 0, language)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-white/42">{t("credits.centerModal.giftCredits")}</dt>
                        <dd className="tabular-nums text-primary">+{number(packageItem?.gift_credits ?? 0, language)}</dd>
                      </div>
                    </>
                  ) : null}
                  <div className="flex justify-between font-medium">
                    <dt>{t("credits.centerModal.totalCredits")}</dt>
                    <dd className="flex items-center gap-1.5 tabular-nums">
                      <CreditSparkIcon className="size-4" />
                      {number(credits, language)}
                    </dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>

          <div className="text-xs text-white/28">DramaClaw · Secure checkout</div>
        </section>

        <section className="flex items-center px-6 py-10 lg:px-12 xl:px-20">
          <div className="mx-auto w-full max-w-xl">
            <header>
              <div className="text-xs text-white/38">{t("checkout.rechargeSubject")}</div>
              <div className="mt-2 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.035] p-4">
                <span className="flex size-10 items-center justify-center rounded-md bg-white/[0.06] text-white/70">
                  {isOrgScope ? <Building2 className="size-5" /> : <UserRound className="size-5" />}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {isOrgScope ? targetOrganizationName : username}
                  </div>
                  <div className="mt-1 text-xs text-white/40">
                    {t(isOrgScope ? "checkout.orgCredits" : "checkout.personalCredits")}
                  </div>
                </div>
                <Check className="ml-auto size-4 text-success" />
              </div>
            </header>

            <div className="mt-8">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">{t("checkout.paymentMethod")}</h2>
                <ShieldCheck className="size-4 text-success" />
              </div>
              <p className="mt-1 text-xs text-white/38">{t("checkout.securePayment")}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {availablePaymentMethods.map((method) => (
                  <button
                    key={method}
                    type="button"
                    aria-pressed={effectivePaymentMethod === method}
                    disabled={Boolean(existingOrder)}
                    onClick={() => setPaymentMethod(method)}
                    className={cn(
                      "flex h-16 items-center gap-3 rounded-lg border px-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-65",
                      effectivePaymentMethod === method
                        ? "border-primary/65 bg-primary/[0.08] ring-1 ring-inset ring-primary/15"
                        : "border-white/10 bg-white/[0.025] hover:border-white/22",
                    )}
                  >
                    <span className={cn("flex size-9 items-center justify-center rounded-md", method === "alipay" ? "bg-[#1677ff] text-white" : "bg-[#07c160] text-white")}>
                      {method === "alipay" ? <WalletCards className="size-4" /> : <QrCode className="size-4" />}
                    </span>
                    <span className="text-sm font-medium">{t(`credits.recharge.methods.${method}`)}</span>
                    <span className={cn("ml-auto size-4 rounded-full border", effectivePaymentMethod === method ? "border-[5px] border-primary" : "border-white/25")} />
                  </button>
                ))}
              </div>
              {existingOrder ? (
                <div
                  className={cn(
                    "mt-3 flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm",
                    paymentClosed || paymentExpired
                      ? "border-white/10 bg-white/[0.04] text-white/58"
                      : paymentFailed
                        ? "border-destructive/25 bg-destructive/10 text-destructive"
                        : "border-warning/25 bg-warning/10 text-warning",
                  )}
                >
                  {paymentPending ? <Clock3 className="size-4" /> : <CircleAlert className="size-4" />}
                  <span>
                    {paymentClosed
                      ? t("checkout.paymentClosed")
                      : paymentFailed
                        ? t("checkout.paymentFailed")
                        : paymentExpired
                          ? t("checkout.paymentClosing")
                          : t("checkout.paymentPending", {
                              time: paymentTimeRemaining(existingOrder.expires_at, nowMs),
                            })}
                  </span>
                </div>
              ) : null}
            </div>

            <button
              type="button"
              disabled={creating}
              onClick={handlePrimaryAction}
              className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-wait disabled:opacity-55"
            >
              {creating ? <CreditCard className="size-4 animate-pulse" /> : <LockKeyhole className="size-4" />}
              {creating
                ? t("checkout.creating")
                : paymentClosed || paymentFailed
                  ? t("checkout.restart")
                  : existingOrder
                    ? t("checkout.viewResult")
                    : t("checkout.continue")}
            </button>
            <div className="mt-5 flex items-center justify-center gap-2 text-xs text-white/30">
              <ShieldCheck className="size-3.5" />
              {t("checkout.footerSecurity")}
            </div>
          </div>
        </section>
      </div>

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="max-w-md rounded-xl border border-white/10 bg-[#17191e] p-6 text-white">
          <DialogTitle className="text-base font-semibold">{t("checkout.leaveTitle")}</DialogTitle>
          <DialogDescription className="text-sm text-white/45">
            {t("checkout.leaveDescription")}
          </DialogDescription>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={leaveCheckout}
              className="h-10 rounded-md bg-white/[0.06] text-sm font-medium text-white/70 hover:bg-white/[0.1]"
            >
              {t("checkout.leave")}
            </button>
            <button
              type="button"
              onClick={() => setLeaveOpen(false)}
              className="h-10 rounded-md bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {t("checkout.stay")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}

export const Route = createFileRoute("/checkout")({ component: CheckoutPage });
