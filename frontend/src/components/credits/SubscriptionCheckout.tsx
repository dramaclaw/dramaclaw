// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CreditCard,
  LockKeyhole,
  QrCode,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";
import { HTTPError } from "ky";
import { CheckoutShell } from "@/components/credits/CheckoutShell";
import { SubscriptionAgreementDialog } from "@/components/credits/SubscriptionAgreementDialog";
import {
  creditOrgOf,
  creditScopeOf,
  useCreditSummary,
} from "@/lib/queries/credits";
import {
  CHECKOUT_RETURN_KEY,
  CREDIT_CENTER_TAB_KEY,
  OPEN_CREDIT_CENTER_KEY,
  safePaymentReturnPath,
} from "@/lib/payment-navigation";
import {
  bindSubscriptionAttempt,
  safeSubscriptionCheckout,
  subscriptionAttemptKey,
  useCreateSubscription,
  useSubscriptionPlans,
  useSubscriptions,
  type SubscriptionMethod,
} from "@/lib/queries/subscriptions";
import {
  SUBSCRIPTION_RETURN_KEY,
  subscriptionReturnUrl,
  type SubscriptionDraft,
} from "@/lib/subscription-checkout";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";

export function SubscriptionCheckout({ draft }: { draft: SubscriptionDraft }) {
  const { t, i18n } = useTranslation();
  const username = useAuthStore((state) => state.username);
  const plans = useSubscriptionPlans(true);
  const summary = useCreditSummary();
  const subscriptions = useSubscriptions(true);
  const create = useCreateSubscription();
  const submitting = useRef(false);
  const [method, setMethod] = useState<SubscriptionMethod>("alipay");
  const [consent, setConsent] = useState<string | null>(null);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [customerUnavailable, setCustomerUnavailable] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem(SUBSCRIPTION_RETURN_KEY) ?? "null",
      );
      return saved?.username === username &&
        saved?.planId === draft.planId &&
        saved?.planVersion === draft.planVersion &&
        typeof saved.id === "string" &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(saved.id)
        ? saved.id
        : null;
    } catch {
      return null;
    }
  });
  const plan = plans.data?.data.items.find(
    (item) => item.plan_id === draft.planId,
  );
  const offers = plan?.offers ?? [];
  const selectedMethod = offers.some((offer) => offer.payment_method === method)
    ? method
    : offers[0]?.payment_method;
  const offer = offers.find((item) => item.payment_method === selectedMethod);
  const org = creditOrgOf(summary.data?.data);
  const subjectMatches = Boolean(
    username &&
    username === draft.username &&
    summary.data?.data &&
    (creditScopeOf(summary.data.data) !== "org_member" || Boolean(org)) &&
    (plan?.org_id ?? null) === (org?.org_id ?? null),
  );
  const versionMatches = plan?.version === draft.planVersion;
  const blocked = (subscriptions.data?.data.items ?? []).some(
    (row) =>
      row.subscription_id !== createdId &&
      (row.auto_renew ||
        !row.cancellation_confirmed_at ||
        Boolean(row.paid_until && Date.parse(row.paid_until) > Date.now())),
  );
  const fingerprint = JSON.stringify([
    plan?.plan_id,
    plan?.version,
    plan?.terms_url,
    plan?.terms_agreement_id,
    plan?.terms_agreement_version,
    plan?.terms_content_hash,
    plan?.billing_months,
    plan?.credits_per_month,
    plan?.grant_mode,
    plan?.intro_cycles,
    selectedMethod,
    offer,
    username,
    org?.org_id,
  ]);
  const accepted = consent === fingerprint;
  const needsPhone =
    selectedMethod === "alipay" &&
    (customerUnavailable ||
      (offer?.available === false &&
        offer.unavailable_reason === "SUBSCRIPTION_CUSTOMER_UNAVAILABLE"));
  const ready = Boolean(
    plan &&
    offer &&
    subjectMatches &&
    versionMatches &&
    plan.terms_agreement_id &&
    plan.terms_agreement_version &&
    !blocked &&
    !needsPhone &&
    offer.available !== false &&
    !plans.isFetching &&
    !plans.isError &&
    !summary.isError &&
    !subscriptions.isError &&
    (selectedMethod !== "dodo" ||
      (offer.payment_currency === "USD" &&
        offer.payment_amount_minor &&
        offer.fx_rate_snapshot)),
  );
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  const money = (amount: number, currency = "CNY") =>
    new Intl.NumberFormat(language, { style: "currency", currency }).format(
      amount / 100,
    );
  useEffect(() => {
    setConsent(null);
  }, [fingerprint]);
  const leave = () => {
    sessionStorage.setItem(OPEN_CREDIT_CENTER_KEY, "1");
    sessionStorage.setItem(CREDIT_CENTER_TAB_KEY, "subscriptions");
    window.location.assign(
      safePaymentReturnPath(sessionStorage.getItem(CHECKOUT_RETURN_KEY)),
    );
  };
  async function recheckChannel() {
    setConsent(null);
    const result = await plans.refetch();
    if (!result.isError) {
      setCustomerUnavailable(false);
      setNotice(null);
    }
  }
  async function purchase() {
    if (
      !ready ||
      !accepted ||
      !plan ||
      !selectedMethod ||
      submitting.current ||
      create.isPending
    )
      return;
    submitting.current = true;
    setNotice(null);
    try {
      const result = await create.mutateAsync({
        plan,
        method: selectedMethod,
        termsAccepted: true,
        key: subscriptionAttemptKey(
          username ?? "",
          plan.plan_id,
          plan.version,
          selectedMethod,
        ),
      });
      const id = result.data.subscription.subscription_id;
      setCreatedId(id);
      sessionStorage.setItem(
        SUBSCRIPTION_RETURN_KEY,
        JSON.stringify({
          id,
          username,
          planId: plan.plan_id,
          planVersion: plan.version,
        }),
      );
      bindSubscriptionAttempt(
        username ?? "",
        plan.plan_id,
        plan.version,
        selectedMethod,
        id,
      );
      if (result.data.checkout_url)
        window.location.assign(
          safeSubscriptionCheckout(result.data.checkout_url, selectedMethod),
        );
      else window.location.assign(subscriptionReturnUrl(id));
    } catch (error) {
      const detail =
        error instanceof HTTPError &&
        typeof error.data === "object" &&
        error.data &&
        "detail" in error.data
          ? error.data.detail
          : null;
      if (
        detail === "SUBSCRIPTION_AGREEMENT_CHANGED" ||
        detail === "SUBSCRIPTION_AGREEMENT_UNAVAILABLE"
      ) {
        setConsent(null);
        setNotice("subscriptionCheckout.agreementChanged");
        void plans.refetch();
      } else if (
        detail === "SUBSCRIPTION_QUOTE_CHANGED" ||
        detail === "SUBSCRIPTION_PLAN_CHANGED"
      ) {
        setConsent(null);
        setNotice("subscriptions.quoteChanged");
        void plans.refetch();
      } else if (
        detail === "SUBSCRIPTION_CUSTOMER_UNAVAILABLE" &&
        selectedMethod === "alipay"
      ) {
        setCustomerUnavailable(true);
      } else if (detail === "SUBSCRIPTION_CUSTOMER_UNAVAILABLE") {
        setNotice("subscriptionCheckout.channelUnavailable");
      } else setNotice("subscriptions.createUnconfirmed");
    } finally {
      submitting.current = false;
    }
  }
  if (plans.isPending || summary.isPending || subscriptions.isPending)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
        {t("checkout.loading")}
      </main>
    );
  if (plans.isError || summary.isError || subscriptions.isError)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
        <section className="max-w-md space-y-4 text-center">
          <p role="alert">{t("subscriptions.loadError")}</p>
          <button
            type="button"
            onClick={() => {
              void plans.refetch();
              void summary.refetch();
              void subscriptions.refetch();
            }}
            className="rounded-md border border-border px-5 py-3"
          >
            {t("subscriptions.refresh")}
          </button>
          <button
            type="button"
            onClick={leave}
            className="ml-3 rounded-md bg-primary px-5 py-3 text-primary-foreground"
          >
            {t("checkout.back")}
          </button>
        </section>
      </main>
    );
  if (!plan || !offer || !subjectMatches || !versionMatches)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
        <section className="max-w-md space-y-4 text-center">
          <h1 className="text-lg font-semibold">
            {t("checkout.invalidTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(
              !versionMatches && plan
                ? "subscriptionCheckout.planChanged"
                : "checkout.invalidDescription",
            )}
          </p>
          <button
            type="button"
            onClick={leave}
            className="rounded-md bg-primary px-5 py-3 text-primary-foreground"
          >
            {t("checkout.back")}
          </button>
        </section>
      </main>
    );
  const amount =
    selectedMethod === "dodo"
      ? offer.payment_amount_minor
      : (offer.first_amount_minor ?? offer.amount_minor);
  const currency = selectedMethod === "dodo" ? "USD" : "CNY";
  return (
    <CheckoutShell
      onLeave={leave}
      summary={
        <>
          <p className="text-xs text-white/45">
            {t("subscriptionCheckout.amountDue")}
          </p>
          <p className="mt-2 text-4xl font-semibold tabular-nums">
            {amount == null ? "—" : money(amount, currency)}
          </p>
          <p className="mt-3 text-sm text-white/65">
            {t(
              offer.first_amount_minor != null &&
                offer.first_amount_minor !== offer.amount_minor
                ? "subscriptions.renewAfterIntro"
                : "subscriptionCheckout.renewal",
              {
                price: money(offer.amount_minor),
                months: plan.billing_months,
                cycles: plan.intro_cycles ?? 1,
              },
            )}
          </p>
          {selectedMethod === "dodo" && (
            <p className="mt-2 text-sm text-white/55">
              {t("subscriptions.dodoQuote", {
                price: money(offer.payment_amount_minor ?? 0, "USD"),
                rate: offer.fx_rate_snapshot,
              })}{" "}
              {t("subscriptions.taxNote")}
            </p>
          )}
          {offer.first_amount_minor != null &&
            offer.first_amount_minor !== offer.amount_minor && (
              <p className="mt-2 text-sm text-white/65">
                {t("subscriptions.introCycles", {
                  cycles: plan.intro_cycles ?? 1,
                  price: money(offer.first_amount_minor),
                })}
              </p>
            )}
          <p className="mt-2 text-xs text-white/45">
            {t("subscriptionCheckout.renewalTiming")}
          </p>
          <h1 className="mt-10 text-base font-semibold">
            {t("checkout.orderSummary")}
          </h1>
          <div className="mt-4 space-y-4 rounded-lg border border-white/10 bg-black/15 p-5">
            <div className="flex justify-between gap-4">
              <span className="font-medium">{plan.name}</span>
              <span>{t(`subscriptions.cycle.${plan.billing_months}`)}</span>
            </div>
            <p className="text-sm text-white/55">{plan.description}</p>
            <dl className="space-y-3 border-t border-white/8 pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-white/45">
                  {t("subscriptionCheckout.membership")}
                </dt>
                <dd>
                  {t("subscriptionCheckout.months", {
                    months: plan.billing_months,
                  })}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-white/45">
                  {t("subscriptionCheckout.periodCredits")}
                </dt>
                <dd>
                  {(
                    plan.credits_per_month * plan.billing_months
                  ).toLocaleString(language)}
                </dd>
              </div>
            </dl>
            <p className="text-sm text-primary">
              {t(
                plan.grant_mode === "monthly"
                  ? "subscriptionCheckout.monthlyGrants"
                  : "subscriptionCheckout.upfrontGrants",
                {
                  credits: (
                    plan.credits_per_month *
                    (plan.grant_mode === "monthly" ? 1 : plan.billing_months)
                  ).toLocaleString(language),
                  count: plan.billing_months,
                },
              )}
            </p>
            {plan.billing_months > 1 && (
              <p className="text-xs text-white/45">
                {t("subscriptions.monthlyEquivalent", {
                  price: money(offer.amount_minor / plan.billing_months),
                })}{" "}
                {t("subscriptionCheckout.fullPeriod")}
              </p>
            )}
          </div>
        </>
      }
    >
      <p className="text-xs text-white/45">
        {t("subscriptionCheckout.account")}
      </p>
      <div className="mt-2 flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.035] p-4">
        <UserRound className="size-5 text-white/70" />
        <div>
          <p className="text-sm font-medium">{username}</p>
          <p className="mt-1 text-xs text-white/45">
            {org
              ? t("checkout.orgCredits", { organization: org.name })
              : t("checkout.personalCredits")}
          </p>
        </div>
        <Check className="ml-auto size-4 text-success" />
      </div>
      <h2 className="mt-8 text-base font-semibold">
        {t("checkout.paymentMethod")}
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {offers.map((item) => (
          <button
            key={item.payment_method}
            type="button"
            disabled={create.isPending || Boolean(createdId)}
            aria-pressed={selectedMethod === item.payment_method}
            onClick={() => {
              setMethod(item.payment_method);
              setConsent(null);
              setNotice(null);
            }}
            className={cn(
              "flex h-16 items-center gap-3 rounded-lg border px-4 text-sm disabled:opacity-55",
              selectedMethod === item.payment_method
                ? "border-primary/65 bg-primary/[0.08]"
                : "border-white/10 bg-white/[0.025]",
            )}
          >
            {item.payment_method === "alipay" ? (
              <WalletCards className="size-5 text-[#1677ff]" />
            ) : item.payment_method === "wxpay" ? (
              <QrCode className="size-5 text-[#07c160]" />
            ) : (
              <CreditCard className="size-5" />
            )}
            {t(`subscriptions.methods.${item.payment_method}`)}
          </button>
        ))}
      </div>
      {needsPhone && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-white/10 bg-white/[0.035] p-4 text-sm leading-6"
        >
          <p className="font-medium">
            {t("subscriptionCheckout.phoneRequiredTitle")}
          </p>
          <p className="mt-1 text-white/70">
            {t("subscriptionCheckout.phoneRequired")}
          </p>
          <button
            type="button"
            disabled={
              plans.isFetching || create.isPending || Boolean(createdId)
            }
            onClick={() => void recheckChannel()}
            className="mt-3 rounded-md border border-white/15 px-3 py-2 disabled:opacity-55"
          >
            {t(
              plans.isFetching
                ? "subscriptionCheckout.checking"
                : "subscriptionCheckout.recheck",
            )}
          </button>
        </div>
      )}
      {selectedMethod === "dodo" && (
        <p className="mt-4 text-sm leading-6 text-white/70">
          {t("subscriptionCheckout.dodoDetails")}
        </p>
      )}
      <p className="mt-5 text-sm leading-6 text-white/60">
        {t("subscriptionCheckout.cancelPolicy")}
      </p>
      <div className="mt-5 flex items-start gap-3 text-sm leading-6">
        <input
          id="subscription-renewal-consent"
          type="checkbox"
          aria-label={`${t("subscriptions.consent")} ${t("subscriptions.terms")}`}
          checked={accepted}
          disabled={create.isPending || Boolean(createdId)}
          onChange={(event) =>
            setConsent(event.target.checked ? fingerprint : null)
          }
          className="mt-1 accent-primary"
        />
        <span>
          <label htmlFor="subscription-renewal-consent">
            {t("subscriptions.consent")}{" "}
          </label>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setAgreementOpen(true)}
            className="text-primary underline"
          >
            {t("subscriptions.terms")}
          </button>
          {plan.terms_agreement_version && (
            <span className="ml-1 text-xs text-muted-foreground">
              v{plan.terms_agreement_version}
            </span>
          )}
        </span>
      </div>
      {!plan.terms_agreement_id && (
        <p role="alert" className="mt-3 text-sm text-muted-foreground">
          {t("subscriptionCheckout.agreementUnavailable")}
        </p>
      )}
      {blocked && (
        <p role="alert" className="mt-4 text-sm text-warning">
          {t("subscriptionCheckout.existing")}
        </p>
      )}
      {offer.available === false && !needsPhone && (
        <p role="alert" className="mt-4 text-sm text-warning">
          {t("subscriptionCheckout.channelUnavailable")}
        </p>
      )}
      {notice && (
        <p role="alert" className="mt-4 text-sm text-warning">
          {t(notice)}
        </p>
      )}
      {(plans.isError || subscriptions.isError || summary.isError) && (
        <p role="alert" className="mt-4 text-sm text-warning">
          {t("subscriptions.loadError")}
        </p>
      )}
      <button
        type="button"
        disabled={create.isPending || (!createdId && (!ready || !accepted))}
        onClick={() =>
          createdId
            ? window.location.assign(subscriptionReturnUrl(createdId))
            : void purchase()
        }
        className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-55"
      >
        <LockKeyhole className="size-4" />
        {t(
          create.isPending
            ? "checkout.creating"
            : createdId
              ? "checkout.viewResult"
              : "subscriptionCheckout.confirm",
        )}
      </button>
      <p className="mt-5 flex items-center justify-center gap-2 text-xs text-white/40">
        <ShieldCheck className="size-3.5" />
        {t("checkout.footerSecurity")}
      </p>
      {agreementOpen && (
        <SubscriptionAgreementDialog
          agreementId={plan.terms_agreement_id}
          version={plan.terms_agreement_version}
          contentHash={plan.terms_content_hash}
          fingerprint={fingerprint}
          disabled={create.isPending || Boolean(createdId)}
          onClose={() => setAgreementOpen(false)}
          onAccept={() => setConsent(fingerprint)}
        />
      )}
    </CheckoutShell>
  );
}
