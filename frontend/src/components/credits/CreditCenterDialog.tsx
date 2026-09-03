// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Gift,
  History,
  ReceiptText,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CreditSparkIcon,
  formatCreditPromotionLabel,
} from "@/components/credits/credit-visual";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CreditSummary,
  type CreditTransactionCategory,
  useCreditFilterOptions,
  useCreditPromotions,
  useCreditSummary,
  useCreditTransactions,
} from "@/lib/queries/credits";
import {
  normalizeWholeCnyCredits,
  wholeCnyRechargeBounds,
} from "@/lib/custom-recharge";
import {
  CHECKOUT_DRAFT_KEY,
  CHECKOUT_RETURN_KEY,
  PAYMENT_RETURN_ORDER_ID_KEY,
  PAYMENT_RETURN_ORDER_KEY,
} from "@/lib/payment-navigation";
import {
  type CustomRechargeConfig,
  type RechargeOrder,
  type RechargePackage,
  useCustomRechargeConfig,
  useRechargeOrders,
  useRechargePackages,
} from "@/lib/queries/payments";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";
import { businessWechatQrUrl } from "@/components/login/cinematic/media";

export type CreditCenterTab =
  | "packages"
  | "custom"
  | "benefits"
  | "orders"
  | "usage"
  | "help";

type CheckoutDraft =
  | { kind: "package"; packageId: string }
  | { kind: "custom"; credits: number };

function formatNumber(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

function formatMoney(cents: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function beginCheckout(draft: CheckoutDraft): void {
  sessionStorage.removeItem(PAYMENT_RETURN_ORDER_ID_KEY);
  sessionStorage.removeItem(PAYMENT_RETURN_ORDER_KEY);
  sessionStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft));
  sessionStorage.setItem(
    CHECKOUT_RETURN_KEY,
    `${window.location.pathname}${window.location.search}`,
  );
  window.location.assign("/checkout");
}

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ tab: CreditCenterTab; icon: typeof Gift }>;
}> = [
  {
    label: "credits.centerModal.groups.recharge",
    items: [
      { tab: "packages", icon: Gift },
      { tab: "custom", icon: WalletCards },
    ],
  },
  {
    label: "credits.centerModal.groups.account",
    items: [
      { tab: "benefits", icon: Sparkles },
      { tab: "orders", icon: ReceiptText },
      { tab: "usage", icon: BarChart3 },
    ],
  },
  {
    label: "credits.centerModal.groups.support",
    items: [{ tab: "help", icon: CircleHelp }],
  },
];

const PAYMENT_TABS = new Set<CreditCenterTab>(["packages", "custom", "orders"]);

export function CreditCenterDialog({
  open,
  onOpenChange,
  initialTab = "packages",
  paymentAvailable,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: CreditCenterTab;
  paymentAvailable: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [activeTab, setActiveTab] = useState<CreditCenterTab>(initialTab);
  const [customCredits, setCustomCredits] = useState(3000);
  const username = useAuthStore((state) => state.username) ?? t("credits.centerModal.account");
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  const summaryQuery = useCreditSummary(open);
  const packagesQuery = useRechargePackages(open && paymentAvailable);
  const customRechargeQuery = useCustomRechargeConfig(open && paymentAvailable);
  const ordersQuery = useRechargeOrders({ enabled: open && paymentAvailable });
  const promotionsQuery = useCreditPromotions(open && activeTab === "benefits");
  const summary = summaryQuery.data?.data;
  const packages = useMemo(
    () => [...(packagesQuery.data?.data.items ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    [packagesQuery.data?.data.items],
  );
  const orders = ordersQuery.data?.data.items ?? [];
  const promotions = promotionsQuery.data?.data.items ?? [];
  const customRecharge = customRechargeQuery.data?.data;
  useEffect(() => {
    if (!customRecharge) return;
    setCustomCredits((current) => normalizeWholeCnyCredits(current, customRecharge));
  }, [customRecharge]);
  const customAmountCents = customRecharge
    ? (customCredits * 100) / customRecharge.credits_per_cny
    : 0;
  const visibleActiveTab =
    !paymentAvailable && PAYMENT_TABS.has(activeTab) ? "usage" : activeTab;
  const visibleNavGroups = paymentAvailable
    ? NAV_GROUPS
    : NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(({ tab }) => !PAYMENT_TABS.has(tab)),
      })).filter((group) => group.items.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "h-[min(780px,calc(100dvh-2rem))] w-[min(1380px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-xl border border-white/10 bg-[#0d0f13] p-0 text-white shadow-2xl sm:max-w-none",
          "grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)]",
        )}
        overlayClassName="bg-black/60 backdrop-blur-sm"
      >
        <DialogTitle className="sr-only">{t("credits.centerTitle")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("credits.centerDescription")}
        </DialogDescription>

        <aside className="hidden min-h-0 border-r border-white/8 bg-white/[0.035] px-3 py-5 md:flex md:flex-col">
          <div className="px-3 pb-5">
            <div className="flex size-10 items-center justify-center rounded-full bg-primary/18 text-base font-semibold text-primary">
              {username.slice(0, 1).toUpperCase()}
            </div>
            <div className="mt-3 truncate text-sm font-semibold">{username}</div>
            <div className="mt-1 flex items-center gap-1.5 text-xs text-white/50">
              <CreditSparkIcon className="size-3.5" />
              {summary ? formatNumber(summary.balance, language) : "--"}
              <span>{t("credits.short")}</span>
            </div>
          </div>

          <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto">
            {visibleNavGroups.map((group) => (
              <div key={group.label}>
                <div className="px-3 text-[11px] font-medium text-white/35">
                  {t(group.label)}
                </div>
                <div className="mt-1 space-y-0.5">
                  {group.items.map(({ tab, icon: Icon }) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className={cn(
                        "flex h-9 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm transition-colors",
                        visibleActiveTab === tab
                          ? "bg-white/[0.08] text-white"
                          : "text-white/58 hover:bg-white/[0.05] hover:text-white",
                      )}
                    >
                      <Icon className="size-4" strokeWidth={1.75} />
                      {t(`credits.centerModal.tabs.${tab}`)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b border-white/8 px-5 py-4 pr-14 md:px-7">
            <div>
              <h2 className="text-lg font-semibold">
                {t(`credits.centerModal.tabs.${visibleActiveTab}`)}
              </h2>
              <p className="mt-1 text-xs text-white/45">
                {t(`credits.centerModal.descriptions.${visibleActiveTab}`)}
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-white/45 md:hidden">
              <CreditSparkIcon className="size-4" />
              <span className="text-lg font-semibold tabular-nums text-white">
                {summary ? formatNumber(summary.balance, language) : "--"}
              </span>
            </div>
          </header>

          <div className="flex gap-1 overflow-x-auto border-b border-white/8 px-4 py-2 md:hidden">
            {visibleNavGroups.flatMap((group) => group.items).map(({ tab }) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1.5 text-xs",
                  visibleActiveTab === tab ? "bg-white text-black" : "bg-white/6 text-white/55",
                )}
              >
                {t(`credits.centerModal.tabs.${tab}`)}
              </button>
            ))}
          </div>

          <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
            {visibleActiveTab === "packages" ? (
              <PackageTab
                packages={packages}
                loading={packagesQuery.isPending}
                language={language}
                onCheckout={(packageId) => beginCheckout({ kind: "package", packageId })}
              />
            ) : null}
            {visibleActiveTab === "custom" ? (
              <CustomRechargeTab
                config={customRecharge}
                loading={customRechargeQuery.isPending}
                credits={customCredits}
                amountCents={customAmountCents}
                language={language}
                onCreditsChange={setCustomCredits}
                onCheckout={() =>
                  beginCheckout({
                    kind: "custom",
                    credits: customCredits,
                  })
                }
              />
            ) : null}
            {visibleActiveTab === "benefits" ? (
              <BenefitsTab promotions={promotions} loading={promotionsQuery.isPending} />
            ) : null}
            {visibleActiveTab === "orders" ? (
              <OrdersTab orders={orders} loading={ordersQuery.isPending} language={language} />
            ) : null}
            {visibleActiveTab === "usage" ? (
              <UsageTab summary={summary} language={language} />
            ) : null}
            {visibleActiveTab === "help" ? <HelpTab /> : null}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function PackageTab({
  packages,
  loading,
  language,
  onCheckout,
}: {
  packages: RechargePackage[];
  loading: boolean;
  language: string;
  onCheckout: (packageId: string) => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<"packages" | "enterprise">("packages");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, number>>({});
  const [showBusinessContact, setShowBusinessContact] = useState(false);
  const packageGroups = useMemo(() => {
    const grouped = new Map<string, {
      id: string;
      name: string;
      description: string;
      badge: string;
      validity: string;
      purchaseNote: string;
      sortOrder: number;
      options: RechargePackage[];
    }>();
    for (const item of packages) {
      const groupId = item.package_group_id ?? item.package_id;
      const current = grouped.get(groupId);
      if (current) {
        current.options.push(item);
        continue;
      }
      grouped.set(groupId, {
        id: groupId,
        name: item.name,
        description: item.description ?? "",
        badge: item.badge ?? "",
        validity: item.validity_label ?? "",
        purchaseNote: item.purchase_note ?? "",
        sortOrder: item.sort_order,
        options: [item],
      });
    }
    return [...grouped.values()]
      .map((group) => ({
        ...group,
        options: group.options.sort((a, b) =>
          (a.variant_sort_order ?? 0) - (b.variant_sort_order ?? 0) ||
          a.package_id.localeCompare(b.package_id),
        ),
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  }, [packages]);

  return (
    <div>
      <div className="mb-5 flex justify-center">
        <div className="flex rounded-lg border border-white/10 bg-black/25 p-1">
          {(["packages", "enterprise"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              className={cn(
                "h-8 rounded-md px-4 text-xs font-medium transition-colors",
                view === item ? "bg-white/14 text-white" : "text-white/42 hover:text-white/75",
              )}
            >
              {t(`credits.centerModal.packageViews.${item}`)}
            </button>
          ))}
        </div>
      </div>

      {view === "enterprise" ? (
        <section className="grid min-h-[430px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.035] lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.6fr)]">
          <div className="flex flex-col justify-between p-7 lg:p-10">
            <div>
              <p className="max-w-xl text-lg font-semibold leading-8">
                {t("credits.centerModal.enterprise.headline")}
              </p>
              <div className="mt-16 text-4xl font-semibold">Custom</div>
              <p className="mt-2 text-sm text-white/40">
                {t("credits.centerModal.enterprise.subtitle")}
              </p>
            </div>
            <div className="text-xs text-white/28">DramaClaw Enterprise</div>
          </div>
          <div className="border-t border-white/10 bg-black/10 p-7 lg:border-l lg:border-t-0 lg:p-10">
            <h3 className="text-sm font-semibold text-white/55">
              {t("credits.centerModal.enterprise.benefitsTitle")}
            </h3>
            <ul className="mt-6 space-y-4">
              {["quota", "priority", "templates", "security", "support"].map((benefit) => (
                <li key={benefit} className="flex items-start gap-2 text-sm text-white/68">
                  <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                  {t(`credits.centerModal.enterprise.benefits.${benefit}`)}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setShowBusinessContact((current) => !current)}
              className="mt-8 inline-flex h-10 w-full items-center justify-center rounded-md bg-white text-sm font-semibold text-black hover:bg-white/88"
            >
              {t("credits.centerModal.enterprise.contact")}
            </button>
            {showBusinessContact ? (
              <div className="mt-4 rounded-md border border-white/10 bg-white p-3 text-center">
                <img src={businessWechatQrUrl} alt={t("auth.businessWechat.qrAlt")} className="mx-auto size-40 object-contain" />
                <p className="mt-2 text-xs text-black/60">{t("auth.businessWechat.note")}</p>
              </div>
            ) : null}
          </div>
        </section>
      ) : loading ? (
        <LoadingState />
      ) : packageGroups.length === 0 ? (
        <EmptyState text={t("credits.centerModal.packagesUnavailable")} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
          {packageGroups.map((group, groupIndex) => {
            const selectedIndex = Math.min(
              selectedOptions[group.id] ?? 0,
              Math.max(0, group.options.length - 1),
            );
            const option = group.options[selectedIndex] ?? group.options[0];
            if (!option) return null;
            const totalCredits = option.base_credits + option.gift_credits;
            return (
              <article
                key={group.id}
                className={cn(
                  "flex min-h-[430px] flex-col rounded-lg border border-white/10 bg-white/[0.035] p-5",
                  (group.badge || groupIndex === 1) && "border-primary/40 ring-1 ring-inset ring-primary/12",
                )}
              >
                <div className="flex min-h-7 items-start justify-between gap-3">
                  <h3 className="text-lg font-semibold">{group.name}</h3>
                  {group.badge ? (
                    <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary">
                      {group.badge}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 min-h-9 text-xs leading-5 text-white/38">
                  {group.description}
                </p>
                <div className="mt-5 text-3xl font-semibold tabular-nums">
                  {formatMoney(option.amount_cents, language)}
                </div>
                <div className="mt-1 text-xs text-white/40">{group.validity}</div>

                {group.options.length > 1 ? (
                  <div className="mt-5">
                    <div className="flex justify-between text-[11px] text-white/35">
                      {group.options.map((item) => (
                        <span key={item.package_id}>
                          {formatNumber(item.base_credits + item.gift_credits, language)}
                        </span>
                      ))}
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={group.options.length - 1}
                      step={1}
                      value={selectedIndex}
                      onChange={(event) => setSelectedOptions((current) => ({ ...current, [group.id]: Number(event.target.value) }))}
                      aria-label={t("credits.centerModal.packageTiers.choose", { tier: group.name })}
                      className="mt-2 h-1.5 w-full cursor-pointer accent-primary"
                    />
                  </div>
                ) : <div className="mt-5 h-[37px]" />}

                <dl className="mt-5 space-y-3 rounded-md border border-white/8 bg-white/[0.035] p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-white/45">{t("credits.centerModal.baseCredits")}</dt>
                    <dd className="tabular-nums">{formatNumber(option.base_credits, language)}</dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-white/45">{t("credits.centerModal.giftCredits")}</dt>
                    <dd className="tabular-nums text-amber-300">+{formatNumber(option.gift_credits, language)}</dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-white/8 pt-3 font-medium">
                    <dt>{t("credits.centerModal.totalCredits")}</dt>
                    <dd className="tabular-nums text-primary">{formatNumber(totalCredits, language)}</dd>
                  </div>
                </dl>
                <p className="mt-4 text-center text-xs text-white/35">
                  {group.purchaseNote}
                </p>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => onCheckout(option.package_id)}
                  className="mt-auto inline-flex h-10 items-center justify-center rounded-md bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/88 disabled:cursor-not-allowed disabled:bg-white/8 disabled:text-white/30"
                >
                  {t("credits.centerModal.buyNow")}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CustomRechargeTab({
  config,
  loading,
  credits,
  amountCents,
  language,
  onCreditsChange,
  onCheckout,
}: {
  config: CustomRechargeConfig | undefined;
  loading: boolean;
  credits: number;
  amountCents: number;
  language: string;
  onCreditsChange: (value: number) => void;
  onCheckout: () => void;
}) {
  const { t } = useTranslation();
  const [creditInput, setCreditInput] = useState(String(credits));
  useEffect(() => setCreditInput(String(credits)), [credits]);
  if (loading) return <LoadingState />;
  if (!config?.enabled) {
    return <EmptyState text={t("credits.centerModal.customUnavailable")} />;
  }
  const bounds = wholeCnyRechargeBounds(config);
  const presets = config.quick_credits;
  const commitCreditInput = () => {
    const normalized = normalizeWholeCnyCredits(Number(creditInput), config);
    onCreditsChange(normalized);
    setCreditInput(String(normalized));
  };
  return (
    <div className="grid overflow-hidden rounded-lg border border-white/10 bg-white/[0.035] lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,0.65fr)]">
      <div className="p-6 lg:p-8">
        <div className="text-sm font-medium">{t("credits.centerModal.chooseCredits")}</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums text-primary">
            {formatNumber(credits, language)}
          </span>
          <span className="text-sm text-white/55">{t("credits.short")}</span>
        </div>
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={credits}
          onChange={(event) =>
            onCreditsChange(normalizeWholeCnyCredits(Number(event.target.value), config))
          }
          className="mt-6 h-1.5 w-full cursor-pointer accent-primary"
          aria-label={t("credits.centerModal.customCredits")}
        />
        <div className="mt-2 flex justify-between text-xs text-white/35">
          <span>{formatNumber(bounds.min, language)}</span>
          <span>{formatNumber(bounds.max, language)}</span>
        </div>
        <input
          type="number"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={creditInput}
          onChange={(event) => setCreditInput(event.target.value)}
          onBlur={commitCreditInput}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="mt-5 h-10 w-full rounded-md border border-white/12 bg-black/20 px-3 text-sm outline-none focus:border-primary/55"
        />
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => onCreditsChange(normalizeWholeCnyCredits(preset, config))}
              className={cn(
                "h-9 rounded-md border text-xs tabular-nums transition-colors",
                credits === preset
                  ? "border-primary/60 bg-primary text-primary-foreground"
                  : "border-white/10 bg-black/20 text-white/65 hover:border-white/25",
              )}
            >
              {formatNumber(preset, language)}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-white/8 bg-black/15 p-6 lg:border-l lg:border-t-0 lg:p-8">
        <div className="text-sm font-medium">{t("credits.centerModal.orderSummary")}</div>
        <div className="mt-8 flex items-center justify-between border-b border-white/8 pb-4">
          <span className="text-sm text-white/45">{t("credits.centerModal.totalCredits")}</span>
          <span className="text-2xl font-semibold tabular-nums text-primary">
            {formatNumber(credits, language)}
          </span>
        </div>
        <div className="flex items-center justify-between py-4">
          <span className="text-sm text-white/45">{t("credits.centerModal.exchangeRate")}</span>
          <span className="text-xs">
            ¥1 = {formatNumber(config.credits_per_cny, language)} {t("credits.short")}
          </span>
        </div>
        <div className="flex items-center justify-between border-t border-white/8 pt-4">
          <span className="text-sm text-white/45">{t("credits.centerModal.amountDue")}</span>
          <span className="text-2xl font-semibold tabular-nums">
            {formatMoney(amountCents, language)}
          </span>
        </div>
        <button
          type="button"
          onClick={onCheckout}
          className="mt-8 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {t("credits.centerModal.rechargeNow")}
        </button>
      </div>
    </div>
  );
}

function BenefitsTab({ promotions, loading }: { promotions: Array<{ id: string; name: string; target_label: string; discount_basis_points: number; ends_at: string | null }>; loading: boolean }) {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language ?? "zh";
  if (loading) return <LoadingState />;
  if (promotions.length === 0) return <EmptyState text={t("credits.centerModal.noBenefits")} />;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {promotions.map((promotion) => (
        <article key={promotion.id} className="rounded-lg border border-white/10 bg-white/[0.035] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{promotion.name}</h3>
              <p className="mt-1 text-xs text-white/42">{promotion.target_label}</p>
            </div>
            <Gift className="size-4 text-primary" />
          </div>
          <div className="mt-5 text-2xl font-semibold tabular-nums text-primary">
            {formatCreditPromotionLabel(promotion)}
          </div>
          <p className="mt-2 text-xs text-white/42">
            {promotion.ends_at
              ? t("credits.endsAt", { time: formatDate(promotion.ends_at, language) })
              : t("credits.longTerm")}
          </p>
        </article>
      ))}
    </div>
  );
}

function OrdersTab({ orders, loading, language }: { orders: RechargeOrder[]; loading: boolean; language: string }) {
  const { t } = useTranslation();
  if (loading) return <LoadingState />;
  if (orders.length === 0) return <EmptyState text={t("credits.recharge.noOrders")} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-white/[0.045] text-xs text-white/40">
          <tr>
            <th className="px-4 py-3 font-medium">{t("credits.recharge.columns.billId")}</th>
            <th className="px-4 py-3 font-medium">{t("credits.recharge.columns.transactionTime")}</th>
            <th className="px-4 py-3 font-medium">{t("credits.recharge.columns.content")}</th>
            <th className="px-4 py-3 font-medium">{t("credits.recharge.columns.amount")}</th>
            <th className="px-4 py-3 font-medium">{t("credits.recharge.columns.status")}</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => {
            const status =
              (order.payment_status === "refunded") !==
              (order.fulfillment_status === "reversed")
                ? "manualReview"
                : order.payment_status === "refunded"
                  ? "refunded"
                  : order.fulfillment_status === "credited"
                ? "credited"
                : order.fulfillment_status === "failed"
                  ? "creditFailed"
                  : order.payment_status;
            return (
              <tr key={order.order_id} className="border-t border-white/8">
                <td className="px-4 py-3 font-mono text-xs font-medium text-white/82">
                  {order.merchant_order_no}
                </td>
                <td className="px-4 py-3 text-xs tabular-nums text-white/48">
                  {formatDateTime(order.created_at, language)}
                </td>
                <td className="max-w-80 px-4 py-3">
                  <div className="truncate font-medium">{order.package_name}</div>
                  <div className="mt-1 text-xs text-white/38">
                    {formatNumber(order.base_credits + order.gift_credits, language)} {t("credits.short")}
                  </div>
                </td>
                <td className="px-4 py-3 font-medium tabular-nums">
                  {formatMoney(order.amount_cents, language)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium",
                      status === "credited" && "bg-emerald-500/12 text-emerald-400",
                      (status === "pending" || status === "paid") &&
                        "bg-amber-400/12 text-amber-300",
                      (status === "failed" ||
                        status === "creditFailed" ||
                        status === "manualReview") &&
                        "bg-red-500/12 text-red-400",
                      (status === "expired" || status === "closed") &&
                        "bg-white/8 text-white/45",
                      status === "refunded" && "bg-sky-500/12 text-sky-300",
                    )}
                  >
                    {t(`credits.recharge.status.${status}`)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UsageTab({ summary, language }: { summary: CreditSummary | undefined; language: string }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<CreditTransactionCategory | "pending">("all");
  const [activityView, setActivityView] = useState<"daily" | "weekly" | "cumulative">("daily");
  const [hoveredActivity, setHoveredActivity] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [projectId, setProjectId] = useState("");
  const [featureKey, setFeatureKey] = useState("");
  const [model, setModel] = useState("");
  const dashboardQuery = useCreditTransactions({ category: "all", page: 1, pageSize: 100 });
  const filterOptionsQuery = useCreditFilterOptions();
  const transactionsQuery = useCreditTransactions({
    category: category === "pending" ? "all" : category,
    status: category === "pending" ? "pending" : undefined,
    page,
    pageSize: 20,
    startAt: dateBoundary(startDate),
    endAt: dateBoundary(endDate, true),
    projectId: projectId || undefined,
    featureKey: featureKey || undefined,
    model: model || undefined,
  });
  const dashboardItems = dashboardQuery.data?.data.items ?? [];
  const transactionPage = transactionsQuery.data?.data;
  const visibleTransactions = transactionPage?.items ?? [];
  const visibleTotal = transactionPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(visibleTotal / 20));
  const filterOptions = filterOptionsQuery.data?.data;
  const dashboard = useMemo(() => {
    const spentByDay = new Map<string, number>();
    for (const item of dashboardItems) {
      if (item.category !== "spent" || !item.occurred_at) continue;
      const key = localDateKey(new Date(item.occurred_at));
      spentByDay.set(key, (spentByDay.get(key) ?? 0) + Math.abs(item.delta));
    }

    const activeDays = [...spentByDay.keys()].sort();
    let longestStreak = 0;
    let currentStreak = 0;
    let previousDay: number | null = null;
    for (const key of activeDays) {
      const timestamp = new Date(`${key}T00:00:00`).getTime();
      currentStreak = previousDay !== null && timestamp - previousDay === 86_400_000
        ? currentStreak + 1
        : 1;
      longestStreak = Math.max(longestStreak, currentStreak);
      previousDay = timestamp;
    }

    const sampledSpent = [...spentByDay.values()].reduce((sum, value) => sum + value, 0);
    const sampledWeeks = activeDays.length > 1
      ? Math.max(
          1,
          Math.ceil(
            (new Date(`${activeDays[activeDays.length - 1]}T00:00:00`).getTime() -
              new Date(`${activeDays[0]}T00:00:00`).getTime()) /
              (7 * 86_400_000),
          ),
        )
      : 1;
    const dailyPeak = Math.max(0, ...spentByDay.values());
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364);
    const heatmap: Array<{ key: string; amount: number } | null> = Array.from(
      { length: start.getDay() },
      () => null,
    );
    for (let offset = 0; offset < 365; offset += 1) {
      const date = new Date(start);
      date.setDate(start.getDate() + offset);
      const key = localDateKey(date);
      heatmap.push({ key, amount: spentByDay.get(key) ?? 0 });
    }
    const months = Array.from({ length: 12 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - 11 + index, 1);
      return new Intl.DateTimeFormat(language, { month: "short" }).format(date);
    });
    const weeks = Array.from({ length: Math.ceil(heatmap.length / 7) }, (_, index) => {
      const days = heatmap.slice(index * 7, index * 7 + 7).filter((day) => day !== null);
      return {
        key: days[0]?.key ?? `week-${index}`,
        endKey: days[days.length - 1]?.key ?? `week-${index}`,
        amount: days.reduce((sum, day) => sum + day.amount, 0),
      };
    });
    let cumulativeAmount = 0;
    const cumulativeValues = weeks.map((week) => {
      cumulativeAmount += week.amount;
      return cumulativeAmount;
    });
    const cumulativePeak = Math.max(1, ...cumulativeValues);
    const cumulativePoints = cumulativeValues.map((value, index) => ({
      x: (index / Math.max(1, cumulativeValues.length - 1)) * 1000,
      y: 130 - (value / cumulativePeak) * 110,
    }));
    const cumulativeLine = cumulativePoints
      .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
      .join(" ");
    const cumulativeArea = `${cumulativeLine} L1000,140 L0,140 Z`;
    return {
      dailyPeak,
      weeklyAverage: sampledSpent / sampledWeeks,
      activeDays: activeDays.length,
      longestStreak,
      heatmap,
      months,
      weeks,
      weeklyPeak: Math.max(0, ...weeks.map((week) => week.amount)),
      cumulativeLine,
      cumulativeArea,
      cumulativePoints,
      cumulativeValues,
    };
  }, [dashboardItems, language]);

  const resetPage = (update: () => void) => {
    update();
    setPage(1);
  };

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.025]">
        <div className="grid grid-cols-2 divide-x divide-y divide-white/10 sm:grid-cols-3 xl:grid-cols-5 xl:divide-y-0">
          {[
            ["totalSpent", summary?.spent],
            ["dailyPeak", dashboard.dailyPeak],
            ["weeklyAverage", dashboard.weeklyAverage],
            ["activeDays", dashboard.activeDays],
            ["longestStreak", dashboard.longestStreak],
          ].map(([key, value]) => (
            <div key={String(key)} className="min-w-0 px-4 py-4">
              <div className="text-2xl font-semibold tabular-nums">
                {typeof value === "number" ? formatNumber(value, language) : "--"}
              </div>
              <div className="mt-1 text-xs text-white/42">
                {t(`credits.centerModal.usage.${key}`)}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-white/10 px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">{t("credits.centerModal.usage.activity")}</h3>
              <span className="text-[11px] text-white/35">
                {t("credits.centerModal.usage.sampled", { count: dashboardItems.length })}
              </span>
            </div>
            <div className="flex rounded-lg bg-black/30 p-1">
              {(["daily", "weekly", "cumulative"] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => setActivityView(view)}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium transition-colors",
                    activityView === view
                      ? "bg-white/15 text-white shadow-sm"
                      : "text-white/38 hover:text-white/70",
                  )}
                >
                  {t(`credits.centerModal.usage.${view}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-1 overflow-x-auto pb-1 pt-10">
            <div className="min-w-[720px]">
              {activityView === "cumulative" ? (
                <div className="relative h-[140px]">
                  <svg viewBox="0 0 1000 140" className="h-[140px] w-full" preserveAspectRatio="none" aria-label={t("credits.centerModal.usage.cumulative")}>
                    {[20, 50, 80, 110, 140].map((y) => (
                      <line key={y} x1="0" x2="1000" y1={y} y2={y} stroke="currentColor" className="text-white/[0.055]" strokeWidth="1" />
                    ))}
                    <path d={dashboard.cumulativeArea} fill="currentColor" className="text-primary/18" />
                    <path d={dashboard.cumulativeLine} fill="none" stroke="currentColor" className="text-primary" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                  </svg>
                  <div className="absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${dashboard.weeks.length}, minmax(0, 1fr))` }}>
                    {dashboard.weeks.map((week, index) => {
                      const point = dashboard.cumulativePoints[index];
                      return (
                        <div key={week.key} className="group relative h-full">
                          <span className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px bg-primary/45 group-hover:block" />
                          <span
                            className="pointer-events-none absolute left-1/2 hidden size-2.5 -translate-x-1/2 rounded-full border-2 border-[#17191d] bg-primary group-hover:block"
                            style={{ top: `${(point?.y ?? 130) - 5}px` }}
                          />
                          <ActivityTooltip
                            label={formatActivityRange(week.key, week.endKey, language)}
                            value={formatNumber(dashboard.cumulativeValues[index] ?? 0, language)}
                            className="left-1/2 -translate-x-1/2"
                            style={{ top: `${Math.max(0, (point?.y ?? 130) - 42)}px` }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : activityView === "weekly" ? (
                <div className="grid h-[94px] grid-flow-col items-end gap-[3px]" style={{ gridAutoColumns: "10px" }}>
                  {dashboard.weeks.map((week) => {
                    const intensity = dashboard.weeklyPeak > 0
                      ? Math.ceil((week.amount / dashboard.weeklyPeak) * 4)
                      : 0;
                    return (
                      <span
                        key={week.key}
                        onMouseEnter={() => setHoveredActivity(`weekly-${week.key}`)}
                        onMouseLeave={() => setHoveredActivity(null)}
                        className={cn(
                          "group relative h-full w-2.5 rounded-[2px] transition-[background-color,box-shadow,opacity]",
                          intensity === 0 && "bg-white/[0.035]",
                          intensity === 1 && "bg-primary/20",
                          intensity === 2 && "bg-primary/40",
                          intensity === 3 && "bg-primary/65",
                          intensity === 4 && "bg-primary",
                          hoveredActivity?.startsWith("weekly-") &&
                            hoveredActivity !== `weekly-${week.key}` &&
                            "opacity-25",
                          hoveredActivity === `weekly-${week.key}` &&
                            "bg-primary opacity-100 ring-2 ring-primary/25",
                        )}
                      >
                        <ActivityTooltip
                          label={formatActivityRange(week.key, week.endKey, language)}
                          value={formatNumber(week.amount, language)}
                        />
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="grid w-max grid-flow-col gap-[3px]" style={{ gridTemplateRows: "repeat(7, 10px)", gridAutoColumns: "10px" }}>
                  {dashboard.heatmap.map((day, index) => {
                    const intensity = day && dashboard.dailyPeak > 0
                      ? Math.ceil((day.amount / dashboard.dailyPeak) * 4)
                      : 0;
                    return day ? (
                      <span
                        key={day.key}
                        onMouseEnter={() => setHoveredActivity(`daily-${day.key}`)}
                        onMouseLeave={() => setHoveredActivity(null)}
                        className={cn(
                          "group relative size-2.5 rounded-[2px] transition-[background-color,box-shadow,opacity,transform]",
                          intensity === 0 && "bg-white/[0.035]",
                          intensity === 1 && "bg-primary/20",
                          intensity === 2 && "bg-primary/40",
                          intensity === 3 && "bg-primary/65",
                          intensity === 4 && "bg-primary",
                          hoveredActivity?.startsWith("daily-") &&
                            hoveredActivity !== `daily-${day.key}` &&
                            "opacity-25",
                          hoveredActivity === `daily-${day.key}` &&
                            "z-10 scale-125 bg-primary opacity-100 ring-2 ring-primary/25",
                        )}
                      >
                        <ActivityTooltip
                          label={formatActivityDate(day.key, language)}
                          value={formatNumber(day.amount, language)}
                        />
                      </span>
                    ) : <span key={`empty-${index}`} className="size-2.5" />;
                  })}
                </div>
              )}
              <div className="mt-2 grid grid-cols-12 text-center text-[10px] text-white/32">
                {dashboard.months.map((month, index) => <span key={`${month}-${index}`}>{month}</span>)}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.025]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1">
            {(["all", "earned", "spent", "refunded", "pending"] as const).map(
              (value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => resetPage(() => setCategory(value))}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    category === value
                      ? "bg-white text-black"
                      : "bg-white/[0.06] text-white/50 hover:bg-white/10 hover:text-white",
                  )}
                >
                  {t(`credits.category.${value}`)}
                </button>
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-white/38">
              {transactionsQuery.isFetching
                ? t("credits.filtering")
                : t("credits.filteredRecords", { count: visibleTotal })}
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(event) => resetPage(() => setStartDate(event.target.value))}
              aria-label={t("credits.startDate")}
              className="h-9 rounded-md border border-white/10 bg-white/[0.055] px-2 text-xs text-white/65 outline-none focus:border-white/25"
            />
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(event) => resetPage(() => setEndDate(event.target.value))}
              aria-label={t("credits.endDate")}
              className="h-9 rounded-md border border-white/10 bg-white/[0.055] px-2 text-xs text-white/65 outline-none focus:border-white/25"
            />
            <UsageFilterSelect value={projectId} onChange={(value) => resetPage(() => setProjectId(value))} label={t("credits.allProjects")} options={filterOptions?.projects ?? []} />
            <UsageFilterSelect value={featureKey} onChange={(value) => resetPage(() => setFeatureKey(value))} label={t("credits.allFeatures")} options={filterOptions?.features ?? []} />
            <UsageFilterSelect value={model} onChange={(value) => resetPage(() => setModel(value))} label={t("credits.allModels")} options={filterOptions?.models ?? []} />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-white/[0.035] text-xs text-white/38">
              <tr>
                <th className="px-4 py-3 font-medium">{t("credits.columns.time")}</th>
                <th className="px-4 py-3 font-medium">{t("credits.columns.feature")}</th>
                <th className="px-4 py-3 font-medium">{t("credits.columns.project")}</th>
                <th className="px-4 py-3 font-medium">{t("credits.columns.status")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("credits.columns.change")}</th>
                <th className="px-4 py-3 text-right font-medium">{t("credits.columns.balance")}</th>
              </tr>
            </thead>
            <tbody>
              {transactionsQuery.isPending ? (
                <tr><td colSpan={6}><LoadingState /></td></tr>
              ) : visibleTransactions.length === 0 ? (
                <tr><td colSpan={6}><EmptyState text={t("credits.centerModal.usage.noRecords")} /></td></tr>
              ) : visibleTransactions.map((item) => (
                <tr key={item.id} className="border-t border-white/8">
                  <td className="px-4 py-3 text-xs tabular-nums text-white/45">
                    {item.occurred_at ? formatDateTime(item.occurred_at, language) : "--"}
                  </td>
                  <td className="max-w-64 px-4 py-3">
                    <div className="truncate font-medium">{item.feature_label || "--"}</div>
                    <div className="mt-1 truncate text-xs text-white/38">{item.model || "--"}</div>
                  </td>
                  <td className="max-w-48 truncate px-4 py-3 text-white/58">{item.project_name || "--"}</td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "inline-flex rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] font-medium",
                      (item.status === "confirmed" || item.status === "completed") && "text-emerald-400",
                      item.status === "pending" && "text-amber-300",
                      item.status === "refunded" && "text-white/45",
                    )}>
                      {t(`credits.status.${item.status}`)}
                    </span>
                  </td>
                  <td className={cn("px-4 py-3 text-right font-medium tabular-nums", item.delta < 0 ? "text-red-400" : "text-emerald-400")}>
                    {item.delta > 0 ? "+" : ""}{formatNumber(item.delta, language)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-white/58">{formatNumber(item.balance_after, language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="flex items-center justify-between border-t border-white/10 px-4 py-3 text-xs text-white/38">
          <span>{t("credits.centerModal.usage.recordCount", { count: visibleTotal })}</span>
          <div className="flex items-center gap-3">
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="inline-flex size-8 items-center justify-center rounded-full bg-white/[0.06] text-white/55 hover:bg-white/10 disabled:opacity-30" aria-label={t("credits.centerModal.usage.previousPage")}>
              <ChevronLeft className="size-4" />
            </button>
            <span>{t("credits.centerModal.usage.page", { page, total: totalPages })}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="inline-flex size-8 items-center justify-center rounded-full bg-white/[0.06] text-white/55 hover:bg-white/10 disabled:opacity-30" aria-label={t("credits.centerModal.usage.nextPage")}>
              <ChevronRight className="size-4" />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function UsageFilterSelect({ value, onChange, label, options }: { value: string; onChange: (value: string) => void; label: string; options: Array<{ value: string; label: string }> }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} className="h-9 min-w-32 rounded-md border border-white/10 bg-[#202329] px-3 text-xs text-white/65 outline-none focus:border-white/25">
      <option value="">{label}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

function ActivityTooltip({ label, value, className, style }: { label: string; value: string; className?: string; style?: { top: string } }) {
  const { t } = useTranslation();
  return (
    <span
      role="tooltip"
      style={style}
      className={cn(
        "pointer-events-none absolute z-20 hidden whitespace-nowrap rounded-md border border-white/12 bg-[#2a2d32] px-2.5 py-1.5 text-xs font-medium text-white shadow-xl group-hover:block",
        !style && "bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2",
        className,
      )}
    >
      {label} · {value} {t("credits.short")}
    </span>
  );
}

function dateBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatActivityDate(value: string, language: string): string {
  return new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function formatActivityRange(start: string, end: string, language: string): string {
  return `${formatActivityDate(start, language)} - ${formatActivityDate(end, language)}`;
}

function HelpTab() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      {["arrival", "validity", "refund"].map((key) => (
        <details key={key} className="group rounded-lg border border-white/10 bg-white/[0.035] px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
            {t(`credits.centerModal.help.${key}.question`)}
            <ChevronRight className="size-4 text-white/35 transition-transform group-open:rotate-90" />
          </summary>
          <p className="mt-3 border-t border-white/8 pt-3 text-sm leading-6 text-white/48">
            {t(`credits.centerModal.help.${key}.answer`)}
          </p>
        </details>
      ))}
    </div>
  );
}

function LoadingState() {
  const { t } = useTranslation();
  return <div className="flex h-48 items-center justify-center text-sm text-white/42">{t("common.loading")}</div>;
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-48 flex-col items-center justify-center text-sm text-white/42">
      <History className="mb-3 size-5" />
      {text}
    </div>
  );
}
