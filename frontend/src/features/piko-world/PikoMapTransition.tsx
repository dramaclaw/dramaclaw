// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  PIKO_MAP_TRANSITIONS,
  type PikoMapId,
} from "./piko-map-transitions";
import type { PikoMapLoadState } from "./PikoWorldCanvas";

export const PIKO_MAP_TRANSITION_TIMING = {
  holdMs: 2_400,
  exitMs: 1_400,
  reducedMotionHoldMs: 650,
} as const;

type TransitionPhase = "covered" | "showing" | "revealing" | "complete";

type PikoMapTransitionProps = {
  mapId: PikoMapId;
  loadState: PikoMapLoadState;
  onComplete?: () => void;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function PikoMapTransition({
  mapId,
  loadState,
  onComplete,
}: PikoMapTransitionProps) {
  const { t } = useTranslation();
  const [transition, setTransition] = useState<{
    mapId: PikoMapId;
    phase: TransitionPhase;
  }>({ mapId, phase: "covered" });
  const definition = PIKO_MAP_TRANSITIONS[mapId];
  const phase = transition.mapId === mapId ? transition.phase : "covered";

  useEffect(() => {
    setTransition({ mapId, phase: "covered" });
  }, [mapId]);

  useEffect(() => {
    if (loadState === "error") {
      setTransition({ mapId, phase: "complete" });
      onComplete?.();
      return;
    }
    if (loadState !== "ready") return;

    const reducedMotion = prefersReducedMotion();
    setTransition({ mapId, phase: "showing" });

    if (reducedMotion) {
      const completeTimer = window.setTimeout(() => {
        setTransition({ mapId, phase: "complete" });
        onComplete?.();
      }, PIKO_MAP_TRANSITION_TIMING.reducedMotionHoldMs);
      return () => window.clearTimeout(completeTimer);
    }

    const revealTimer = window.setTimeout(() => {
      setTransition({ mapId, phase: "revealing" });
    }, PIKO_MAP_TRANSITION_TIMING.holdMs);
    const completeTimer = window.setTimeout(() => {
      setTransition({ mapId, phase: "complete" });
      onComplete?.();
    }, PIKO_MAP_TRANSITION_TIMING.holdMs + PIKO_MAP_TRANSITION_TIMING.exitMs);

    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(completeTimer);
    };
  }, [loadState, mapId, onComplete]);

  if (phase === "complete") return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[#17281e]/80 backdrop-blur-md transition-[opacity,backdrop-filter] duration-[1400ms] ease-[var(--ease-in-out)] motion-reduce:backdrop-blur-none motion-reduce:transition-none",
        phase === "revealing" && "pointer-events-none opacity-0",
      )}
      role="status"
      aria-live="polite"
      aria-label={t("pikoWorld.mapTransitionAnnouncement", {
        mapName: definition.title,
      })}
      data-map-id={mapId}
      data-phase={phase}
    >
      <img
        src={definition.src}
        alt=""
        fetchPriority="high"
        draggable={false}
        className={cn(
          "w-[min(62vw,42rem)] max-h-[30vh] max-w-[72vw] scale-100 object-contain blur-0 drop-shadow-[0_14px_28px_rgba(0,0,0,0.35)] transition-[opacity,transform,filter] duration-[1200ms] ease-[var(--ease-out-quint)] sm:w-[min(48vw,42rem)] lg:w-[min(42vw,42rem)] motion-reduce:transition-none",
          phase === "covered" && "scale-[0.965] opacity-0 blur-[3px]",
          phase === "showing" && "opacity-100",
          phase === "revealing" && "opacity-0",
        )}
      />
    </div>
  );
}
