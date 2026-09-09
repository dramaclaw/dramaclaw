// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { ChevronRight, Sparkles } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

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
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const username = useAuthStore((s) => s.username);
  const { data, isLoading, isError } = useCurrentUser(Boolean(username) && !ce);
  const summaryQuery = useCreditSummary(Boolean(username) && !ce);
  const summary = summaryQuery.data?.data;
  const balance = summary?.balance ?? data?.data.credit_balance;
  const language = i18n?.resolvedLanguage ?? i18n?.language ?? "en";

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );

  if (ce || !username || isError) return null;

  const cancelScheduledClose = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const openPanel = () => {
    cancelScheduledClose();
    if (!open) void summaryQuery.refetch();
    setOpen(true);
  };

  const scheduleClosePanel = () => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 160);
  };

  const openCredits = () => {
    cancelScheduledClose();
    setOpen(false);
    void navigate({ to: "/credits" });
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen && !open) void summaryQuery.refetch();
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="group/credits ml-1 flex h-9 min-w-0 items-center gap-1 rounded-md px-1 text-sm font-medium text-muted-foreground outline-none transition-colors hover:text-white focus:outline-none focus:shadow-none focus:ring-0 focus-visible:outline-none focus-visible:shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label={t("credits.openPanel")}
            onMouseEnter={openPanel}
            onMouseLeave={scheduleClosePanel}
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
        onMouseEnter={openPanel}
        onMouseLeave={scheduleClosePanel}
      >
        <div className="px-4 pb-2.5 pt-3.5">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold">{t("credits.availableBalance")}</div>
            <button
              type="button"
              onClick={openCredits}
              className="text-xs font-medium text-primary outline-none transition-colors hover:text-primary/80 focus:outline-none focus:shadow-none focus:ring-0 focus-visible:outline-none focus-visible:shadow-none focus-visible:ring-0"
            >
              {t("credits.details")}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-1.5">
            <CreditSparkIcon className="size-5" />
            <span className="text-2xl font-semibold tabular-nums">
              {balance === undefined ? "--" : formatFullCredits(balance, language)}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 px-4 pb-4 pt-1.5">
          {[
            ["earned", summary?.earned],
            ["spent", summary?.spent],
            ["refunded", summary?.refunded],
          ].map(([key, value]) => (
            <div key={String(key)} className="rounded-sm bg-white/[0.075] px-3 py-2.5">
              <div className="text-[10px] font-medium text-white/58">{t(`credits.${key}`)}</div>
              <div className="mt-1 text-sm font-semibold tabular-nums text-white/95">
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
      </PopoverContent>
    </Popover>
  );
}
