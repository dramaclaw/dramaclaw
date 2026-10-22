// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type {
  SubscriptionPlan,
  SubscriptionPlanGroup,
} from "@/lib/queries/subscriptions";
import {
  PricingCard,
  PricingCardPrice,
  PricingCardDetails,
  PricingCardNote,
  PricingCardAction,
} from "./PricingCard";

type BillingPeriod = 1 | 3 | 12;
const periods: BillingPeriod[] = [1, 3, 12];
export function SubscriptionCatalog({
  groups,
  disabled,
  onSelect,
}: {
  groups: SubscriptionPlanGroup[];
  disabled: boolean;
  onSelect: (plan: SubscriptionPlan) => void;
}) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<BillingPeriod | "all" | null>(null);
  const [tiers, setTiers] = useState<Record<string, number>>({});
  const availablePeriods = periods.filter((months) =>
    groups.some((g) => g.options.some((o) => o.billing_months === months)),
  );
  const commonPeriods = availablePeriods.filter((months) =>
    groups.every((g) => g.options.some((o) => o.billing_months === months)),
  );
  // Old catalogs may contain a monthly-only, quarterly-only and yearly-only card.
  // Show their actual offers together, without inventing prices for missing periods.
  const showAllPeriods =
    availablePeriods.length > 1 && commonPeriods.length === 0;
  const defaultPeriod = showAllPeriods
    ? "all"
    : (commonPeriods[0] ?? availablePeriods[0]);
  const selectedPeriod =
    period === "all" && showAllPeriods
      ? "all"
      : typeof period === "number" && availablePeriods.includes(period)
        ? period
        : defaultPeriod;
  const visibleGroups =
    selectedPeriod === "all"
      ? groups
      : groups.filter((g) =>
          g.options.some((o) => o.billing_months === selectedPeriod),
        );
  const money = (amount: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 0,
    }).format(amount / 100);
  if (!groups.length) return null;
  const tabs = showAllPeriods
    ? ["all" as const, ...availablePeriods]
    : availablePeriods;
  return (
    <section className="space-y-5" aria-label={t("subscriptions.catalog")}>
      <div className="flex justify-center">
        <div
          role="tablist"
          aria-label={t("subscriptions.billingPeriod")}
          className="flex max-w-full flex-wrap justify-center rounded-lg border border-white/10 bg-black/25 p-1"
        >
          {tabs.map((months) => (
            <button
              type="button"
              role="tab"
              aria-selected={selectedPeriod === months}
              key={months}
              onClick={() => setPeriod(months)}
              className={cn(
                "h-8 rounded-md px-4 text-xs font-medium transition-colors",
                selectedPeriod === months
                  ? "bg-white/14 text-white"
                  : "text-white/42 hover:text-white/75",
              )}
            >
              {t(
                months === "all"
                  ? "subscriptions.allPeriods"
                  : `subscriptions.billingPeriodLabels.${months}`,
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        {visibleGroups.map((group) => {
          const billingPeriod =
            selectedPeriod === "all"
              ? availablePeriods.find((months) =>
                  group.options.some((o) => o.billing_months === months),
                )
              : selectedPeriod;
          const options = group.options
            .filter((o) => o.billing_months === billingPeriod)
            .sort((a, b) => a.credits_per_month - b.credits_per_month);
          const selectedIndex = Math.max(
            0,
            options.findIndex(
              (o) => o.credits_per_month === tiers[group.group_id],
            ),
          );
          const plan = options[selectedIndex];
          const offer =
            plan?.offers.find((o) => o.available !== false) ?? plan?.offers[0];
          if (!plan || !offer) return null;
          const canBuy = plan.offers.some((o) => o.available !== false);
          return (
            <PricingCard
              key={group.group_id}
              name={group.name}
              description={group.description}
              badge={group.badge}
              highlighted={!!group.badge}
            >
              <PricingCardPrice
                unit={t("subscriptions.perMonth")}
                caption={t(
                  `subscriptions.billingTotal.${plan.billing_months}`,
                  { price: money(offer.amount_minor) },
                )}
              >
                {money(offer.amount_minor / plan.billing_months)}
              </PricingCardPrice>
              <div className="mt-5 h-[37px]">
                {options.length > 1 && (
                  <>
                    <div className="flex justify-between gap-2 text-[11px] text-white/35">
                      {options.map((o) => (
                        <span
                          key={o.plan_id}
                          className={cn(
                            o === plan && "font-semibold text-white/80",
                          )}
                        >
                          {o.credits_per_month.toLocaleString(i18n.language)}
                        </span>
                      ))}
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={options.length - 1}
                      step={1}
                      value={selectedIndex}
                      aria-label={t("subscriptions.chooseTier", {
                        name: group.name,
                      })}
                      aria-valuetext={t("subscriptions.monthlyCredits", {
                        credits: plan.credits_per_month,
                      })}
                      onChange={(e) =>
                        setTiers({
                          ...tiers,
                          [group.group_id]:
                            options[Number(e.target.value)].credits_per_month,
                        })
                      }
                      className="mt-2 h-1.5 w-full cursor-pointer accent-primary"
                    />
                  </>
                )}
              </div>
              <PricingCardDetails>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/45">
                    {t("subscriptions.creditsLabel")}
                  </dt>
                  <dd className="tabular-nums">
                    {plan.credits_per_month.toLocaleString(i18n.language)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-white/45">
                    {t("subscriptions.grantLabel")}
                  </dt>
                  <dd>
                    {t(`subscriptions.grantModeShort.${plan.grant_mode}`)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-white/8 pt-3 font-medium">
                  <dt>{t("subscriptions.periodCredits")}</dt>
                  <dd className="tabular-nums text-primary">
                    {(
                      plan.credits_per_month * plan.billing_months
                    ).toLocaleString(i18n.language)}
                  </dd>
                </div>
              </PricingCardDetails>
              <PricingCardNote>
                {t("subscriptions.renewalNote")}
              </PricingCardNote>
              <PricingCardAction
                disabled={disabled || !canBuy}
                onClick={() => onSelect(plan)}
              >
                {t(
                  canBuy
                    ? "subscriptions.subscribe"
                    : "subscriptions.periodUnavailable",
                )}
              </PricingCardAction>
            </PricingCard>
          );
        })}
      </div>
    </section>
  );
}
