// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { Check, LogIn, QrCode, WalletCards } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  type RechargePaymentMethod,
  submitEpayCheckout,
  useCreateRechargeLinkOrder,
  useRechargeLinkPackages,
} from "@/lib/queries/payments";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import {
  paymentIdempotencyKey,
  rememberPaymentOrder,
} from "@/lib/payment-navigation";
import { paymentErrorToastMessage } from "@/lib/payment-errors";

const TOKEN_STORAGE_KEY = "supertale-recharge-token";

function initialToken(): string {
  if (typeof window === "undefined") return "";
  const fromUrl = new URLSearchParams(window.location.search).get("token") ?? "";
  if (/^[A-Za-z0-9_-]{32,128}$/.test(fromUrl)) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
}

function money(cents: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function RechargePage() {
  const { t, i18n } = useTranslation();
  const token = useMemo(initialToken, []);
  const validateSession = useAuthStore((state) => state.validateSession);
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [selectedPackage, setSelectedPackage] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<RechargePaymentMethod>("alipay");
  const packages = useRechargeLinkPackages(token, authenticated);
  const createOrder = useCreateRechargeLinkOrder(token);
  const items = packages.data?.data.items ?? [];
  const selectedPackageItem = items.find(
    (item) => item.package_id === selectedPackage,
  );
  const availablePaymentMethods = selectedPackageItem?.payment_methods ?? [];
  const selectedPaymentMethod = availablePaymentMethods.includes(paymentMethod)
    ? paymentMethod
    : availablePaymentMethods[0];
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";

  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(window.history.state, "", "/recharge");
    }
  }, []);

  useEffect(() => {
    if (!token) {
      setCheckingSession(false);
      return;
    }
    let cancelled = false;
    void validateSession().then((valid) => {
      if (cancelled) return;
      setAuthenticated(valid);
      setCheckingSession(false);
      if (!valid) {
        sessionStorage.setItem("supertale-payment-login-redirect", "/recharge");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, validateSession]);

  const pay = async () => {
    if (!selectedPackage || !selectedPaymentMethod || createOrder.isPending) return;
    try {
      const response = await createOrder.mutateAsync({
        packageId: selectedPackage,
        paymentMethod: selectedPaymentMethod,
        idempotencyKey: paymentIdempotencyKey(
          "link",
          JSON.stringify({ token, packageId: selectedPackage, paymentMethod: selectedPaymentMethod }),
        ),
      });
      rememberPaymentOrder(response.data.order);
      if (!response.data.checkout) {
        window.location.assign("/payment-return");
        return;
      }
      submitEpayCheckout(response.data.checkout);
    } catch (error) {
      toast.error(paymentErrorToastMessage(error, t, "rechargeLink.createFailed"));
    }
  };

  if (!token) {
    return <Message title={t("rechargeLink.invalidTitle")} text={t("rechargeLink.invalid")} />;
  }
  if (checkingSession) {
    return <Message title={t("rechargeLink.title")} text={t("rechargeLink.checking")} />;
  }
  if (!authenticated) {
    return (
      <Message title={t("rechargeLink.loginTitle")} text={t("rechargeLink.loginRequired")}>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
          onClick={() => window.location.assign("/login")}
        >
          <LogIn className="size-4" />
          {t("rechargeLink.login")}
        </button>
      </Message>
    );
  }
  if (packages.isPending) {
    return <Message title={t("rechargeLink.title")} text={t("rechargeLink.loading")} />;
  }
  if (packages.isError || items.length === 0) {
    return <Message title={t("rechargeLink.unavailableTitle")} text={t("rechargeLink.unavailable")} />;
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-10 text-foreground">
      <section className="mx-auto max-w-3xl">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold">{t("rechargeLink.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("rechargeLink.subtitle")}</p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const selected = item.package_id === selectedPackage;
            return (
              <button
                key={item.package_id}
                type="button"
                aria-pressed={selected}
                className={cn(
                  "relative min-h-32 rounded-md border border-foreground/12 bg-foreground/8 p-4 text-left",
                  "hover:border-foreground/25 hover:bg-foreground/12",
                  selected && "border-primary/60 ring-1 ring-primary/30",
                )}
                onClick={() => setSelectedPackage(item.package_id)}
              >
                {selected ? <Check className="absolute right-3 top-3 size-4 text-primary" /> : null}
                <div className="pr-6 text-sm font-medium">{item.name}</div>
                <div className="mt-3 text-xl font-semibold tabular-nums">
                  {money(item.amount_cents, language)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("rechargeLink.credits", { count: item.base_credits + item.gift_credits })}
                </div>
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-foreground/12 pt-5">
          <div className="inline-flex rounded-md border border-foreground/12 bg-foreground/8 p-1">
            {availablePaymentMethods.map((method) => (
              <button
                key={method}
                type="button"
                aria-pressed={selectedPaymentMethod === method}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium",
                  selectedPaymentMethod === method
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setPaymentMethod(method)}
              >
                {method === "alipay" ? <WalletCards className="size-3.5" /> : <QrCode className="size-3.5" />}
                {t(`rechargeLink.methods.${method}`)}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!selectedPackage || !selectedPaymentMethod || createOrder.isPending}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void pay()}
          >
            <WalletCards className="size-4" />
            {createOrder.isPending ? t("rechargeLink.creating") : t("rechargeLink.pay")}
          </button>
        </div>
      </section>
    </main>
  );
}

function Message({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-foreground/12 bg-foreground/8 p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{text}</p>
        {children ? <div className="mt-5">{children}</div> : null}
      </section>
    </main>
  );
}

export const Route = createFileRoute("/recharge")({ component: RechargePage });
