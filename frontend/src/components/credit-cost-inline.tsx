// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CreditSparkIcon,
  formatCreditPromotionLabel,
  type CreditPromotionDisplay,
  useCreditDisplayHidden,
} from "@/components/credits/credit-visual";
import { isCeRuntime } from "@/lib/runtime-config";
import { cn } from "@/lib/utils";

export function CreditCostInline({
  display,
  promotion,
  className,
  iconClassName,
}: {
  display?: string | null;
  promotion?: CreditPromotionDisplay | null;
  className?: string;
  iconClassName?: string;
}) {
  if (useCreditDisplayHidden()) return null;
  if (isCeRuntime()) return null;
  if (!display) return null;
  const [originalDisplay, payableDisplay] = display.includes("→")
    ? display.split("→", 2)
    : [null, display];
  const promotionLabel = originalDisplay
    ? (formatCreditPromotionLabel(promotion) ?? "促销中")
    : null;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none ml-1 inline-flex shrink-0 flex-col items-end gap-0.5",
        className,
      )}
    >
      {promotionLabel && (
        <span
          className="whitespace-nowrap text-[9px] font-semibold leading-none text-amber-400"
          title={promotion?.name}
        >
          {promotionLabel}
        </span>
      )}
      <span
        className="inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums text-inherit"
      >
        <CreditSparkIcon className={cn("size-3", iconClassName)} />
        {originalDisplay && (
          <span className="text-[var(--color-muted-foreground)] line-through">
            {originalDisplay}
          </span>
        )}
        <span>{payableDisplay}</span>
      </span>
    </span>
  );
}
