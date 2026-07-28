// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { ChevronRight, Sparkles } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { CREDIT_VALUE_CLASS, CreditSparkIcon } from "@/components/credits/credit-visual";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useCurrentUser } from "@/lib/queries/auth";
import { useCreditSummary } from "@/lib/queries/credits";
import { isCeRuntime } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth-store";

function formatFullCredits(value: number, language: string): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits: 0 }).format(value);
}

export function CreditBalanceBadge() {
  // Hooks must run unconditionally (Rules of Hooks); gate the CE/auth checks
  // after them. `useCurrentUser` stays disabled in CE so we don't fetch there.
  const ce = isCeRuntime();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const username = useAuthStore((s) => s.username);
  const { data, isLoading, isError } = useCurrentUser(Boolean(username) && !ce);
  const summaryQuery = useCreditSummary(Boolean(username) && !ce);
  const summary = summaryQuery.data?.data;
  const balance = summary?.balance ?? data?.data.credit_balance;
  const language = i18n?.resolvedLanguage ?? i18n?.language ?? "en";

  if (ce || !username || isError) return null;

  const openCredits = () => {
    setOpen(false);
    void navigate({ to: "/credits" });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) void summaryQuery.refetch();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="group/credits ml-1 flex h-9 min-w-0 items-center gap-1 rounded-md px-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-white"
            aria-label={t("credits.openPanel")}
          />
        }
      >
        <span className="flex shrink-0 items-center">
          <CreditSparkIcon className="size-[17px]" withHoverMotion />
        </span>
        <span
          className={cn(
            "shrink-0 whitespace-nowrap text-[12px] leading-none tabular-nums",
            CREDIT_VALUE_CLASS,
          )}
        >
          {isLoading || balance === undefined ? "--" : formatFullCredits(balance, language)}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={10}
        className="w-[330px] overflow-hidden border border-white/10 bg-[#17191d] p-0 text-white shadow-2xl"
      >
        <div className="border-b border-white/8 px-4 py-3.5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{t("credits.personalAccount")}</div>
            <button
              type="button"
              onClick={openCredits}
              className="text-xs text-sky-300 transition-colors hover:text-sky-200"
            >
              {t("credits.details")}
            </button>
          </div>
          <div className="mt-3 text-xs text-white/50">{t("credits.balance")}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <CreditSparkIcon className="size-5" />
            <span className="text-2xl font-semibold tabular-nums">
              {balance === undefined ? "--" : formatFullCredits(balance, language)}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-px bg-white/8">
          {[
            ["earned", summary?.earned],
            ["spent", summary?.spent],
            ["refunded", summary?.refunded],
          ].map(([key, value]) => (
            <div key={String(key)} className="bg-[#17191d] px-3 py-3">
              <div className="text-[11px] text-white/45">{t(`credits.${key}`)}</div>
              <div className="mt-1 text-sm font-medium tabular-nums">
                {typeof value === "number" ? formatFullCredits(value, language) : "--"}
              </div>
            </div>
          ))}
        </div>

        {summary && summary.promotion_count > 0 ? (
          <button
            type="button"
            onClick={openCredits}
            className="flex w-full items-center gap-3 border-t border-white/8 px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-400/12 text-amber-300">
              <Sparkles className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{t("credits.promotions")}</span>
              <span className="block text-xs text-white/45">
                {t("credits.promotionCount", { count: summary.promotion_count })}
              </span>
            </span>
            <ChevronRight className="size-4 text-white/35" />
          </button>
        ) : null}

        <button
          type="button"
          onClick={openCredits}
          className="flex w-full items-center justify-between border-t border-white/8 px-4 py-3 text-sm text-white/75 transition-colors hover:bg-white/[0.04] hover:text-white"
        >
          <span>{t("credits.viewTransactions")}</span>
          <ChevronRight className="size-4 text-white/35" />
        </button>
      </PopoverContent>
    </Popover>
  );
}
