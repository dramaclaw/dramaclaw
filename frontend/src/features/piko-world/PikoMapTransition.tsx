// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  PIKO_MAP_TRANSITIONS,
  type PikoMapId,
} from "./piko-map-transitions";
import type { PikoMapLoadState } from "./PikoWorldCanvas";

export const PIKO_MAP_TRANSITION_TIMING = {
  holdMs: 1_200,
  exitMs: 1_000,
  reducedMotionHoldMs: 650,
} as const;

type TransitionPhase = "covered" | "showing" | "revealing" | "complete";

type PikoMapTransitionProps = {
  mapId: PikoMapId;
  loadState: PikoMapLoadState;
  paused?: boolean;
  onComplete?: () => void;
};

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function PikoMapTransition({
  mapId,
  loadState,
  onComplete,
  paused = false,
}: PikoMapTransitionProps) {
  const { t } = useTranslation();
  const completed = useRef(false);
  const [transition, setTransition] = useState<{
    mapId: PikoMapId;
    phase: TransitionPhase;
  }>({ mapId, phase: "covered" });
  const definition = PIKO_MAP_TRANSITIONS[mapId];
  const phase = transition.mapId === mapId ? transition.phase : "covered";

  useEffect(() => {
    completed.current = false;
    setTransition({ mapId, phase: "covered" });
  }, [mapId]);

  useEffect(() => {
    if (completed.current) return;
    if (loadState === "error") {
      completed.current = true;
      setTransition({ mapId, phase: "complete" });
      onComplete?.();
      return;
    }
    if (loadState !== "ready" || paused) return;

    const reducedMotion = prefersReducedMotion();
    setTransition({ mapId, phase: "showing" });

    if (reducedMotion) {
      const completeTimer = window.setTimeout(() => {
        completed.current = true;
        setTransition({ mapId, phase: "complete" });
        onComplete?.();
      }, PIKO_MAP_TRANSITION_TIMING.reducedMotionHoldMs);
      return () => window.clearTimeout(completeTimer);
    }

    const revealTimer = window.setTimeout(() => {
      setTransition({ mapId, phase: "revealing" });
    }, PIKO_MAP_TRANSITION_TIMING.holdMs);
    const completeTimer = window.setTimeout(() => {
      completed.current = true;
      setTransition({ mapId, phase: "complete" });
      onComplete?.();
    }, PIKO_MAP_TRANSITION_TIMING.holdMs + PIKO_MAP_TRANSITION_TIMING.exitMs);

    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(completeTimer);
    };
  }, [loadState, mapId, onComplete, paused]);

  if (phase === "complete") return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-[#17281e]/80 backdrop-blur-md transition-[opacity,backdrop-filter] ease-[var(--ease-in-out)] motion-reduce:backdrop-blur-none motion-reduce:transition-none",
        phase === "revealing" && "pointer-events-none opacity-0",
      )}
      style={{ transitionDuration: `${PIKO_MAP_TRANSITION_TIMING.exitMs}ms` }}
      role="status"
      aria-live="polite"
      aria-label={t("pikoWorld.mapTransitionAnnouncement", {
        mapName: definition.title,
      })}
      data-map-id={mapId}
      data-phase={phase}
    >
      <img
        style={{ transitionDuration: `${phase === "revealing" ? PIKO_MAP_TRANSITION_TIMING.exitMs : 400}ms` }}
        src={definition.src}
        alt=""
        fetchPriority="high"
        draggable={false}
        className={cn(
          "w-[min(49.6vw,33.6rem)] max-h-[24vh] max-w-[57.6vw] scale-100 object-contain blur-0 drop-shadow-[0_14px_28px_rgba(0,0,0,0.35)] transition-[opacity,transform,filter] ease-[var(--ease-out-quint)] sm:w-[min(38.4vw,33.6rem)] lg:w-[min(33.6vw,33.6rem)] motion-reduce:transition-none",
          phase === "covered" && "scale-[0.965] opacity-0 blur-[3px]",
          phase === "showing" && "opacity-100",
          phase === "revealing" && "opacity-0",
        )}
      />
    </div>
  );
}
