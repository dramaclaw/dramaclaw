// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PikoGameHud({
  left,
  center,
  right,
}: {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-3 top-3 z-20 grid grid-cols-[1fr_auto_1fr] items-start gap-2 text-xs font-medium text-white/82 sm:inset-x-4 sm:top-4 sm:text-sm">
      {left ? (
        <div className="justify-self-start rounded-full border border-white/10 bg-black/28 px-3 py-1.5 backdrop-blur-md">
          {left}
        </div>
      ) : <span />}
      {center ? (
        <div className="justify-self-center rounded-full border border-cyan-100/14 bg-cyan-200/[0.08] px-3 py-1.5 text-cyan-50/86 backdrop-blur-md">
          {center}
        </div>
      ) : null}
      {right ? (
        <div className="justify-self-end rounded-full border border-white/10 bg-black/28 px-3 py-1.5 text-right backdrop-blur-md">
          {right}
        </div>
      ) : <span />}
    </div>
  );
}

export function PikoGameOverlay({
  title,
  description,
  meta,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  accent = "cyan",
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  primaryLabel: ReactNode;
  onPrimary: () => void;
  secondaryLabel?: ReactNode;
  onSecondary?: () => void;
  accent?: "cyan" | "lime" | "violet";
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-black/56 px-5 backdrop-blur-[3px]">
      <div className="w-full max-w-sm rounded-[20px] border border-white/[0.14] bg-[#090c11]/88 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.5)]">
        {meta ? (
          <div
            className={cn(
              "mb-2 text-xs font-medium tracking-[0.04em]",
              accent === "lime"
                ? "text-lime-200/76"
                : accent === "violet"
                  ? "text-violet-200/76"
                  : "text-cyan-100/76",
            )}
          >
            {meta}
          </div>
        ) : null}
        <h3 className="text-2xl font-semibold tracking-[-0.02em] text-white">{title}</h3>
        {description ? <p className="mt-2 text-sm leading-6 text-white/58">{description}</p> : null}
        <div className="mt-6 flex justify-center gap-3">
          {secondaryLabel && onSecondary ? (
            <button
              type="button"
              className="h-10 rounded-full border border-white/[0.14] px-5 text-sm text-white/76 transition-colors hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35"
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            className={cn(
              "h-10 rounded-full px-5 text-sm font-medium text-slate-950 transition-[background-color,transform] hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090c11]",
              accent === "lime"
                ? "bg-lime-300 hover:bg-lime-200 focus-visible:ring-lime-200"
                : accent === "violet"
                  ? "bg-violet-300 hover:bg-violet-200 focus-visible:ring-violet-200"
                  : "bg-cyan-300 hover:bg-cyan-200 focus-visible:ring-cyan-200",
            )}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
