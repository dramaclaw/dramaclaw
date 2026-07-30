// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createContext, useContext, useId } from "react";

import { cn } from "@/lib/utils";

export const CREDIT_VALUE_CLASS = "tabular-nums text-white";

// When true (set by a provider — e.g. the canvas root), credit cost badges
// render nothing. Lets us hide credits inside the canvas without touching the
// many non-canvas call sites that share these components.
const CreditDisplayHiddenContext = createContext(false);
export const CreditDisplayHiddenProvider = CreditDisplayHiddenContext.Provider;
export function useCreditDisplayHidden(): boolean {
  return useContext(CreditDisplayHiddenContext);
}

export function formatCreditCost(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/\.?0+$/, "");
}

export type CreditPromotionDisplay = {
  name?: string;
  discount_basis_points?: number;
  ends_at?: string | null;
};

export function formatCreditPromotionLabel(
  promotion?: CreditPromotionDisplay | null,
): string | null {
  const basisPoints = Number(promotion?.discount_basis_points);
  if (!Number.isFinite(basisPoints) || basisPoints <= 0 || basisPoints >= 10_000) {
    return null;
  }
  const discount = (basisPoints / 1_000)
    .toFixed(2)
    .replace(/\.?0+$/, "");
  return promotion?.ends_at ? `限时 ${discount} 折` : `${discount} 折优惠`;
}

type CreditSparkIconProps = {
  className?: string;
  muted?: boolean;
  withHoverMotion?: boolean;
};

export function CreditSparkIcon({
  className,
  muted = false,
  withHoverMotion = false,
}: CreditSparkIconProps) {
  const gradientId = `credit-spark-gradient-${useId().replace(/:/g, "")}`;

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn(
        "shrink-0 origin-center",
        muted
          ? "opacity-35 grayscale"
          : "drop-shadow-[0_0_8px_rgba(20,184,255,0.34)]",
        withHoverMotion
          && "transition-[filter] duration-150 ease-[var(--ease-out-quint)] group-hover/credits:brightness-125",
        className,
      )}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="20"
          x2="20"
          y2="4"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#19e6ff" />
          <stop offset="0.52" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.6l2.16 6.28L20.4 11l-6.24 2.12L12 19.4l-2.16-6.28L3.6 11l6.24-2.12L12 2.6Z"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M18.1 16.2l.72 1.98 1.98.72-1.98.72-.72 1.98-.72-1.98-1.98-.72 1.98-.72.72-1.98Z"
        fill="#7dd3fc"
        opacity="0.78"
      />
      <path
        d="M7.2 3.3l.44 1.18 1.18.44-1.18.44-.44 1.18-.44-1.18-1.18-.44 1.18-.44.44-1.18Z"
        fill="#22d3ee"
        opacity="0.72"
      />
    </svg>
  );
}

export function CreditCostPill({
  display,
  promotion,
  disabled = false,
  className,
}: {
  display?: string | null;
  promotion?: CreditPromotionDisplay | null;
  disabled?: boolean;
  className?: string;
}) {
  // Hidden inside the canvas (a provider sets this) so cost badges don't show
  // next to canvas node buttons; unaffected everywhere else.
  if (useCreditDisplayHidden()) return null;
  if (!display) return null;
  const [originalDisplay, payableDisplay] = display.includes("→")
    ? display.split("→", 2)
    : [null, display];
  const promotionLabel = originalDisplay
    ? (formatCreditPromotionLabel(promotion) ?? "促销中")
    : null;

  return (
    <span className="pointer-events-none inline-flex shrink-0 flex-col items-end gap-0.5">
      {promotionLabel && (
        <span
          className={cn(
            "whitespace-nowrap text-[9px] font-semibold leading-none text-amber-400",
            disabled && "opacity-40",
          )}
          title={promotion?.name}
        >
          {promotionLabel}
        </span>
      )}
      <span
        className={cn(
          "inline-flex h-7 items-center gap-0.5 rounded-md px-1.5 text-[11px] font-medium",
          disabled ? "bg-white/5 text-text-muted/40" : "bg-white/[0.08]",
          !disabled && CREDIT_VALUE_CLASS,
          className,
        )}
      >
        <CreditSparkIcon className="h-3.5 w-3.5" muted={disabled} />
        {originalDisplay && (
          <span className="text-text-muted line-through">{originalDisplay}</span>
        )}
        <span>{payableDisplay}</span>
      </span>
    </span>
  );
}
