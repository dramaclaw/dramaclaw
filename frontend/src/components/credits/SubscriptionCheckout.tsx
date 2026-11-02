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
  forgetSubscriptionAttempt,
  isHistoricalSubscription,
  reusableSubscriptionAttempt,
  subscriptionAttemptFinished,
  subscriptionBlocksPurchase,
  safeSubscriptionCheckout,
  subscriptionAttemptKey,
  useCreateSubscription,
  useMembership,
  useSubscriptionPlans,
  useSubscriptions,
  useRefreshSubscription,
  useSubscription,
  type Subscription,
  type SubscriptionMethod,
} from "@/lib/queries/subscriptions";
import {
  SUBSCRIPTION_RETURN_KEY,
  subscriptionReturnUrl,
  subscriptionResumeUrl,
  subscriptionResultShouldPoll,
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
  const membership = useMembership(true);
  const create = useCreateSubscription();
  const refresh = useRefreshSubscription();
  const submitting = useRef(false);
  const redirectingRef = useRef(false);
  const selectionChanged = useRef(false);
  const selectionVersion = useRef(0);
  const returnVersion = useRef(0);
  const [redirecting, setRedirecting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [method, setMethod] = useState<SubscriptionMethod>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SUBSCRIPTION_RETURN_KEY) ?? "null");
      return saved?.username === username && saved?.planId === draft.planId &&
        saved?.planVersion === draft.planVersion && ["alipay", "wxpay", "dodo"].includes(saved?.paymentMethod)
        ? saved.paymentMethod : "alipay";
    } catch { return "alipay"; }
  });
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
  const restoredAttemptId = useRef(createdId);
  const enteredCheckout = useRef(false);
  const [pollExpired, setPollExpired] = useState(false);
  const attempt = useSubscription(createdId, Boolean(createdId), (row) =>
    subscriptionResultShouldPoll(row) || Boolean(
      row && !row.paid_until && !row.review_required && subscriptionBlocksPurchase(row),
    ), pollExpired ? 15_000 : 5_000);
  useEffect(() => {
    setPollExpired(false);
    if (!createdId) return;
    const timer = window.setTimeout(() => setPollExpired(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [createdId]);
  const attemptLocksMethod = Boolean(attempt.data?.data && subscriptionBlocksPurchase(attempt.data.data));
  const resumeExisting = Boolean(createdId && attempt.data?.data &&
    (subscriptionResumeUrl(attempt.data.data) || attemptLocksMethod));
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
  const blocked = membership.data?.data.active === true || (subscriptions.data?.data.items ?? []).some(
    (row) =>
      row.subscription_id !== createdId &&
      subscriptionBlocksPurchase(row),
  );
  useEffect(() => {
    if (!username) return;
    for (const row of subscriptions.data?.data.items ?? []) {
      if (isHistoricalSubscription(row)) {
        forgetSubscriptionAttempt(
          username, row.plan_id, row.plan_version, row.payment_method, row.subscription_id,
        );
      }
    }
  }, [username, subscriptions.data]);
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
    !attemptLocksMethod &&
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
  function retainAttempt(id: string, paymentMethod = selectedMethod) {
    if (!plan || !paymentMethod || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return;
    setCreatedId(id);
    sessionStorage.setItem(
      SUBSCRIPTION_RETURN_KEY,
      JSON.stringify({
        id,
        username,
        planId: plan.plan_id,
        planVersion: plan.version,
        paymentMethod,
      }),
    );
    bindSubscriptionAttempt(
      username ?? "",
      plan.plan_id,
      plan.version,
      paymentMethod,
      id,
    );
  }
  function selectMethod(next: SubscriptionMethod) {
    if (next === selectedMethod) return;
    selectionChanged.current = true;
    selectionVersion.current++;
    setCreatedId(null);
    sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
    setMethod(next);
    setConsent(null);
    setNotice(null);
    // Keep the old attempt and its idempotency key for background reconciliation.
    // A different channel has a different key; returning to an existing channel
    // resumes that attempt instead of silently creating a second mandate.
    const reusable = subscriptions.data?.data.items.find((row) =>
      row.plan_id === draft.planId && row.plan_version === draft.planVersion &&
      row.payment_method === next && reusableSubscriptionAttempt(row));
    if (reusable) retainAttempt(reusable.subscription_id, next);
    else if (next === "dodo") forgetSubscriptionAttempt(username ?? "", draft.planId, draft.planVersion, next);
  }
  function releaseFailedAttempt(row?: Subscription) {
    selectionChanged.current = true;
    forgetSubscriptionAttempt(
      username ?? "", row?.plan_id ?? draft.planId, row?.plan_version ?? draft.planVersion,
      row?.payment_method ?? selectedMethod!,
    );
    setCreatedId(null);
    sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
    void subscriptions.refetch();
  }
  useEffect(() => {
    const row = attempt.data?.data;
    if (row && !selectionChanged.current) setMethod(row.payment_method);
    if (row?.payment_method === "dodo" && row.subscription_id === restoredAttemptId.current &&
      !subscriptionBlocksPurchase(row)) {
      // Dodo checkout URLs are single-use. Returning from the provider starts a
      // new user-initiated checkout; the original payment stays under reconciliation.
      restoredAttemptId.current = null;
      selectionChanged.current = true;
      forgetSubscriptionAttempt(username ?? "", draft.planId, draft.planVersion, "dodo");
      setCreatedId(null);
      sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
      return;
    }
    if (row && subscriptionAttemptFinished(row)) {
      releaseFailedAttempt(row);
      setNotice("subscriptionCheckout.channelUnavailable");
    }
  }, [attempt.data]);
  useEffect(() => {
    if (enteredCheckout.current || !subscriptions.isSuccess) return;
    enteredCheckout.current = true;
    // Only forget keys bound to a known checkout. A response lost before an ID
    // was received must still retry with its original HTTP idempotency key.
    for (const row of subscriptions.data.data.items) {
      if (row.payment_method === "dodo" && row.plan_id === draft.planId && row.plan_version === draft.planVersion) {
        forgetSubscriptionAttempt(username ?? "", draft.planId, draft.planVersion, "dodo", row.subscription_id);
      }
    }
  }, [subscriptions.isSuccess, subscriptions.data]);
  useEffect(() => {
    if (createdId || selectionChanged.current || !plan) return;
    const reusable = subscriptions.data?.data.items.find((row) =>
      row.plan_id === draft.planId && row.plan_version === draft.planVersion &&
      offers.some((offer) => offer.payment_method === row.payment_method) && reusableSubscriptionAttempt(row));
    if (reusable) {
      setMethod(reusable.payment_method);
      retainAttempt(reusable.subscription_id, reusable.payment_method);
    }
  }, [createdId, subscriptions.data, plan]);

  useEffect(() => {
    function restoreCheckout(event: PageTransitionEvent) {
      if (!event.persisted) return;
      // BFCache restores this mounted component, including its navigation lock.
      // Invalidate frozen async handlers before allowing another explicit action.
      const selection = ++selectionVersion.current;
      const recovery = ++returnVersion.current;
      redirectingRef.current = false;
      submitting.current = false;
      setRedirecting(false);
      setRestoring(true);
      setPollExpired(false);
      create.reset();
      refresh.reset();
      void Promise.allSettled([
        membership.refetch(),
        subscriptions.refetch(),
        createdId ? attempt.refetch() : Promise.resolve(null),
      ]).then(([, list, detail]) => {
        if (selection !== selectionVersion.current) return;
        const row = (detail.status === "fulfilled" ? detail.value?.data?.data : undefined) ??
          (list.status === "fulfilled" ? list.value.data?.data.items.find(
            (item) => item.subscription_id === createdId,
          ) : undefined);
        if (createdId && row?.payment_method === "dodo" && !subscriptionBlocksPurchase(row)) {
          // A consumed Dodo URL belongs to the old attempt. Preserve its backend
          // reconciliation and clear only the known attempt's browser binding.
          restoredAttemptId.current = null;
          selectionChanged.current = true;
          forgetSubscriptionAttempt(username ?? "", draft.planId, draft.planVersion, "dodo", createdId);
          setCreatedId(null);
          sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
        }
        // No received ID means an unknown create response: keep its original key.
        // Restoring a page never POSTs a checkout or opens a payment URL.
      }).finally(() => {
        if (recovery === returnVersion.current) setRestoring(false);
      });
    }
    window.addEventListener("pageshow", restoreCheckout);
    return () => window.removeEventListener("pageshow", restoreCheckout);
  }, [createdId, username, draft.planId, draft.planVersion, membership.refetch,
    subscriptions.refetch, attempt.refetch, create.reset, refresh.reset]);

  async function recoverAttempt() {
    if (!createdId || submitting.current || refresh.isPending) return;
    submitting.current = true;
    const selection = selectionVersion.current;
    try {
      const { data: row } = await refresh.mutateAsync(createdId);
      if (selection !== selectionVersion.current) return;
      if (row.recovery_error) {
        setNotice(row.recovery_error === "SUBSCRIPTION_PAYMENT_CONFIG_INVALID"
          ? "subscriptions.recoveryConfigUnavailable" : "subscriptions.recoveryUnavailable");
        return;
      }
      if (subscriptionAttemptFinished(row)) {
        releaseFailedAttempt(row);
        setNotice("subscriptionCheckout.channelUnavailable");
        return;
      }
      const url = subscriptionResumeUrl(row);
      if (url) {
        redirectingRef.current = true;
        setRedirecting(true);
        window.location.assign(url);
      } else if (row.paid_until && row.invoices?.some((invoice) => invoice.status === "paid")) {
        window.location.assign(subscriptionReturnUrl(createdId));
      } else setNotice("subscriptionCheckout.linkUnavailable");
    } catch {
      if (selection !== selectionVersion.current) return;
      setNotice("subscriptions.recoveryUnavailable");
    } finally {
      if (selection === selectionVersion.current) submitting.current = false;
    }
  }
  async function purchase(newAttempt = false) {
    if (
      !ready ||
      !accepted ||
      !plan ||
      !selectedMethod ||
      submitting.current ||
      create.isPending
    )
      return;
    selectionChanged.current = true;
    submitting.current = true;
    const selection = selectionVersion.current;
    setNotice(null);
    if (newAttempt) {
      forgetSubscriptionAttempt(username ?? "", plan.plan_id, plan.version, selectedMethod);
      setCreatedId(null);
      sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
    }
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
      if (selection !== selectionVersion.current) return;
      const id = result.data.subscription.subscription_id;
      retainAttempt(id);
      if (result.data.checkout_url) {
        const checkoutUrl = safeSubscriptionCheckout(result.data.checkout_url, selectedMethod);
        redirectingRef.current = true;
        setRedirecting(true);
        window.location.assign(checkoutUrl);
      } else {
        const failed = subscriptionAttemptFinished(result.data.subscription);
        if (failed) releaseFailedAttempt(result.data.subscription);
        setNotice(failed ? "subscriptionCheckout.linkFailed" : "subscriptionCheckout.linkUnavailable");
      }
    } catch (error) {
      if (selection !== selectionVersion.current) return;
      redirectingRef.current = false;
      setRedirecting(false);
      const errorBody = error instanceof HTTPError ? error.data : null;
      if (errorBody && typeof errorBody === "object" && "data" in errorBody) {
        const data = errorBody.data;
        const attempt =
          data && typeof data === "object" && "subscription" in data
            ? data.subscription
            : null;
        if (
          attempt &&
          typeof attempt === "object" &&
          "subscription_id" in attempt &&
          typeof attempt.subscription_id === "string" &&
          "plan_id" in attempt &&
          attempt.plan_id === plan.plan_id &&
          "plan_version" in attempt &&
          attempt.plan_version === plan.version &&
          "payment_method" in attempt &&
          attempt.payment_method === selectedMethod
        ) {
          retainAttempt(attempt.subscription_id);
          const failed = subscriptionAttemptFinished(attempt as Subscription);
          if (failed) {
            forgetSubscriptionAttempt(username ?? "", plan.plan_id, plan.version, selectedMethod);
            setCreatedId(null);
            sessionStorage.removeItem(SUBSCRIPTION_RETURN_KEY);
          }
          setNotice(
            failed
              ? ("failure_code" in attempt && ["SUBSCRIPTION_GATEWAY_PREFLIGHT_REJECTED", "SUBSCRIPTION_GATEWAY_CREATION_REJECTED", "SUBSCRIPTION_GATEWAY_UNAVAILABLE"].includes(String(attempt.failure_code))
                ? "subscriptionCheckout.channelUnavailable"
                : "subscriptionCheckout.linkFailed")
              : "subscriptionCheckout.linkUnavailable",
          );
          return;
        }
      }
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
      } else if (detail === "SUBSCRIPTION_PAYMENT_CONFIG_INVALID") {
        setNotice("subscriptions.paymentUnavailable");
        void plans.refetch();
      } else if (detail === "SUBSCRIPTION_ORG_CREDITS_INSUFFICIENT") {
        setNotice("subscriptionCheckout.orgCreditsInsufficient");
      } else if (detail === "SUBSCRIPTION_ALREADY_EXISTS") {
        setNotice("subscriptionCheckout.existing");
        void subscriptions.refetch();
      } else if (detail === "SUBSCRIPTION_PLAN_UNAVAILABLE") {
        setNotice("subscriptionCheckout.planChanged");
        void plans.refetch();
      } else if (detail === "SUBSCRIPTION_ATTEMPT_RATE_LIMITED" ||
        (error instanceof HTTPError && error.response.status === 429)) {
        setNotice("credits.recharge.createFailed");
      } else setNotice("subscriptions.createUnconfirmed");
    } finally {
      if (selection === selectionVersion.current) submitting.current = false;
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
                price:
                  selectedMethod === "dodo"
                    ? amount == null
                      ? "—"
                      : money(amount, currency)
                    : money(offer.amount_minor),
                months: plan.billing_months,
                cycles: plan.intro_cycles ?? 1,
              },
            )}
          </p>
          {selectedMethod === "dodo" && (
            <p className="mt-2 text-sm text-white/55">
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
              <span className="shrink-0 tabular-nums">
                {amount == null ? "—" : money(amount, currency)}
                {t(`subscriptions.cycle.${plan.billing_months}`)}
              </span>
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
            disabled={redirecting || create.isPending || attemptLocksMethod}
            aria-pressed={selectedMethod === item.payment_method}
            onClick={() => {
              selectMethod(item.payment_method);
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
              plans.isFetching || create.isPending || attemptLocksMethod
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
          disabled={create.isPending || attemptLocksMethod}
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
        disabled={redirecting || restoring || create.isPending || refresh.isPending ||
          (!resumeExisting && (!ready || !accepted))}
        onClick={() => {
          if (redirectingRef.current) return;
          return resumeExisting
            ? void recoverAttempt()
            : void purchase(Boolean(createdId));
        }}
        className="mt-8 inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-55"
      >
        <LockKeyhole className="size-4" />
        {t(
          redirecting
            ? "subscriptionCheckout.redirecting"
            : create.isPending || refresh.isPending
            ? "checkout.creating"
            : resumeExisting
              ? "subscriptionCheckout.recover"
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
          disabled={create.isPending || attemptLocksMethod}
          onClose={() => setAgreementOpen(false)}
          onAccept={() => setConsent(fingerprint)}
        />
      )}
    </CheckoutShell>
  );
}
