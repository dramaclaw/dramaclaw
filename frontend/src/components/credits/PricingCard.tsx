// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PricingCard({
  name,
  description,
  badge,
  highlighted = false,
  children,
}: {
  name: string;
  description: string;
  badge?: string;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      aria-label={name}
      className={cn(
        "flex min-h-[430px] min-w-0 flex-col rounded-lg border border-white/10 bg-white/[0.035] p-5",
        highlighted && "border-primary/40 ring-1 ring-inset ring-primary/12",
      )}
    >
      <header className="h-[80px]">
        <div className="flex min-h-7 items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 line-clamp-2 text-lg font-semibold leading-7">
            {name}
          </h3>
          {badge && (
            <span className="max-w-[45%] shrink-0 truncate whitespace-nowrap rounded-full bg-primary/15 px-2 py-1 text-[10px] font-medium text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/38">
          {description}
        </p>
      </header>
      {children}
    </article>
  );
}

export function PricingCardPrice({
  children,
  unit,
  caption,
}: {
  children: ReactNode;
  unit?: ReactNode;
  caption: ReactNode;
}) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline gap-1 tabular-nums">
        <span className="text-3xl font-semibold">{children}</span>
        {unit && <span className="text-xs text-white/40">{unit}</span>}
      </div>
      <p className="mt-1 min-h-4 text-xs text-white/40">{caption}</p>
    </div>
  );
}

export function PricingCardDetails({ children }: { children: ReactNode }) {
  return (
    <dl className="mt-5 space-y-3 rounded-md border border-white/8 bg-white/[0.035] p-4 text-sm">
      {children}
    </dl>
  );
}

export function PricingCardNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 min-h-8 text-center text-xs leading-4 text-white/35">
      {children}
    </p>
  );
}

export function PricingCardAction({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "mt-auto inline-flex h-10 shrink-0 items-center justify-center rounded-md bg-white px-4 text-sm font-semibold text-black transition-colors hover:bg-white/88 disabled:cursor-not-allowed disabled:bg-white/8 disabled:text-white/30",
        className,
      )}
    />
  );
}
