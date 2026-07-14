// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

type WaitingPhase = "hidden" | "entering" | "idle" | "switching";

export function ComposerWaitingStatus({
  label,
  visible,
}: {
  label: string;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const waitingResponseOptions = t("aiAssistant.waitingResponses", { returnObjects: true });
  const longWaitingLabel = t("aiAssistant.waitingLongResponse");
  const veryLongWaitingLabel = t("aiAssistant.waitingVeryLongResponse");
  const waitingLabels = Array.isArray(waitingResponseOptions)
    ? waitingResponseOptions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const waitingLabelsKey = waitingLabels.join("\u0000");
  const [slotLabels, setSlotLabels] = useState<[string, string]>([label, ""]);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [phase, setPhase] = useState<WaitingPhase>("hidden");
  const activeSlotRef = useRef<0 | 1>(0);

  useEffect(() => {
    if (!visible) {
      setPhase("hidden");
      return;
    }

    const options = waitingLabels.length > 0 ? waitingLabels : [label];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers = new Set<number>();
    const schedule = (callback: () => void, delay: number) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
    };

    const transitionTo = (next: string, onComplete: () => void) => {
      const incomingSlot: 0 | 1 = activeSlotRef.current === 0 ? 1 : 0;
      setSlotLabels((currentSlots) => {
        const updatedSlots: [string, string] = [...currentSlots];
        updatedSlots[incomingSlot] = next;
        return updatedSlots;
      });

      if (reduceMotion) {
        activeSlotRef.current = incomingSlot;
        setActiveSlot(incomingSlot);
        setPhase("idle");
        onComplete();
        return;
      }

      setPhase("switching");
      schedule(() => {
        activeSlotRef.current = incomingSlot;
        setActiveSlot(incomingSlot);
        setPhase("idle");
        onComplete();
      }, 440);
    };

    const timeline = [
      { label: options[0] ?? label, delay: 350 },
      ...options.slice(1).map((option, index) => ({
        label: option,
        delay: index < 3 ? 3200 : 5000,
      })),
      { label: longWaitingLabel, delay: 5000 },
      { label: veryLongWaitingLabel, delay: 32000 },
    ];
    let timelineIndex = 0;

    const advanceTimeline = () => {
      const entry = timeline[timelineIndex];
      if (!entry) return;
      schedule(() => {
        if (timelineIndex === 0) {
          activeSlotRef.current = 0;
          setSlotLabels([entry.label, ""]);
          setActiveSlot(0);
          if (reduceMotion) {
            setPhase("idle");
            timelineIndex += 1;
            advanceTimeline();
          } else {
            setPhase("entering");
            schedule(() => setPhase("idle"), 100);
            schedule(() => {
              timelineIndex += 1;
              advanceTimeline();
            }, 280);
          }
        } else {
          transitionTo(entry.label, () => {
            timelineIndex += 1;
            advanceTimeline();
          });
        }
      }, entry.delay);
    };

    advanceTimeline();

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [label, longWaitingLabel, veryLongWaitingLabel, waitingLabelsKey, visible]);

  const displayLabels = slotLabels.map((item) => item.replace(/[.。…\s]+$/u, "")) as [string, string];
  const shown = visible && phase !== "hidden";
  return (
    <div
      className={cn(
        "flex h-7 w-full items-center px-1 text-xs text-foreground/55 transition-[opacity,translate]",
        shown
          ? "translate-y-0 opacity-100 duration-[260ms] ease-out"
          : "pointer-events-none translate-y-[2px] opacity-0 duration-150 ease-in",
      )}
      aria-live="polite"
      aria-hidden={!shown}
      aria-label={shown ? displayLabels[activeSlot] : undefined}
    >
      {shown && (
        <span className="flex w-full max-w-[360px] min-w-0 items-center gap-2" aria-hidden="true">
          <span
            className={cn(
              "flex h-3 w-[14px] shrink-0 items-center justify-center gap-[2px] text-foreground/40 transition-[opacity,scale] duration-200 motion-reduce:transition-none",
              phase === "entering" ? "scale-90 opacity-40" : "scale-100 opacity-100",
            )}
          >
            {[0, 1, 2].map((barIndex) => (
              <span
                key={barIndex}
                className="h-[9px] w-[2px] origin-center animate-[superchat-thinking-wave_2.2s_ease-in-out_infinite] rounded-full bg-current motion-reduce:animate-none"
                style={{ animationDelay: `${barIndex * -240}ms` }}
              />
            ))}
          </span>
          <span
            className={cn(
              "relative block h-[18px] min-w-0 flex-1 overflow-hidden whitespace-nowrap transition-[opacity,translate] duration-200 motion-reduce:transition-none",
              phase === "entering" ? "translate-y-[2px] opacity-0" : "translate-y-0 opacity-100",
            )}
          >
            {displayLabels.map((slotLabel, slotIndex) => {
              const isActive = slotIndex === activeSlot;
              const isSwitching = phase === "switching";
              return (
                <span
                  key={slotIndex}
                  className={cn(
                    "absolute inset-x-0 top-0 flex h-[18px] items-center truncate will-change-transform",
                    isSwitching && "transition-[translate,opacity] duration-[360ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none",
                    isActive
                      ? isSwitching
                        ? "-translate-y-[18px] opacity-0"
                        : "translate-y-0 opacity-100"
                      : isSwitching
                        ? "translate-y-0 opacity-100 delay-[60ms]"
                        : "translate-y-[18px] opacity-0",
                  )}
                >
                  {slotLabel}
                </span>
              );
            })}
          </span>
        </span>
      )}
    </div>
  );
}
