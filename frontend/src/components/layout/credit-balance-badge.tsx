// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";

import { CREDIT_VALUE_CLASS, CreditSparkIcon } from "@/components/credits/credit-visual";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCurrentUser } from "@/lib/queries/auth";
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
  const username = useAuthStore((s) => s.username);
  const { data, isLoading, isError } = useCurrentUser(Boolean(username) && !ce);
  const balance = data?.data.credit_balance;
  const language = i18n?.resolvedLanguage ?? i18n?.language ?? "en";

  if (ce || !username || isError) return null;

  const tooltipLabel =
    balance === undefined
      ? t("credits.balance")
      : `${t("credits.balance")}: ${formatFullCredits(balance, language)}`;

  return (
    <TooltipProvider delay={80}>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              className="group/credits ml-1 flex h-9 min-w-0 cursor-default items-center gap-1 px-0.5 text-sm font-medium text-muted-foreground"
              aria-label={t("credits.balance")}
            />
          }
        >
          <span className="flex shrink-0 items-center">
            <CreditSparkIcon className="size-[17px]" withHoverMotion />
          </span>
          <span className={cn("shrink-0 whitespace-nowrap text-[12px] leading-none tabular-nums", CREDIT_VALUE_CLASS)}>
            {isLoading || balance === undefined ? "--" : formatFullCredits(balance, language)}
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={10}
          showArrow={false}
          className="border border-white/10 bg-background/95 text-foreground shadow-none"
        >
          {tooltipLabel}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
