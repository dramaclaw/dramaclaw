// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";

/** The four user-facing H3 modes, in the same order as the LibLib picker. */
export const MINIMAX_H3_MODE_ORDER: readonly VideoGenMode[] = [
  "textToVideo",
  "allReference",
  "imageToVideo",
  "firstLastFrame",
];

export interface MiniMaxH3MediaCounts {
  images: number;
  videos: number;
  audios: number;
}

export interface MiniMaxH3ModeAvailability {
  mode: VideoGenMode;
  enabled: boolean;
  reasonKey: string | null;
  reasonArgs?: Record<string, number>;
}

const H3_REFERENCE_LIMITS = {
  images: 9,
  videos: 3,
  audios: 3,
} as const;

function totalMedia(counts: MiniMaxH3MediaCounts): number {
  return counts.images + counts.videos + counts.audios;
}

/**
 * Decide one H3 mode without looking at React state.
 *
 * The local H3 service exposes only t2v/i2v/r2v transports. The canvas keeps
 * the more useful four-mode product vocabulary: one-image "image to video"
 * uses r2v, two-image first/last frame uses i2v, and mixed references use r2v.
 * Keeping that mapping here prevents UI availability and submission safety
 * from drifting apart again.
 */
export function minimaxH3ModeAvailability(
  mode: VideoGenMode,
  counts: MiniMaxH3MediaCounts,
): MiniMaxH3ModeAvailability {
  const total = totalMedia(counts);
  switch (mode) {
    case "textToVideo":
      return total === 0
        ? { mode, enabled: true, reasonKey: null }
        : {
            mode,
            enabled: false,
            reasonKey: "node.videoOps.modeDisabled.h3MediaConnected",
          };
    case "imageToVideo":
      if (counts.videos > 0 || counts.audios > 0) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3UseAllReferenceForMixed",
        };
      }
      return counts.images === 1
        ? { mode, enabled: true, reasonKey: null }
        : {
            mode,
            enabled: false,
            reasonKey: "node.videoOps.modeDisabled.h3ImageExactlyOne",
            reasonArgs: { count: counts.images },
          };
    case "firstLastFrame":
      if (counts.videos > 0 || counts.audios > 0) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3UseAllReferenceForMixed",
        };
      }
      return counts.images === 2
        ? { mode, enabled: true, reasonKey: null }
        : {
            mode,
            enabled: false,
            reasonKey: "node.videoOps.modeDisabled.h3FirstLastExactlyTwo",
            reasonArgs: { count: counts.images },
          };
    case "allReference":
      if (total === 0) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3NeedReference",
        };
      }
      if (counts.images > H3_REFERENCE_LIMITS.images) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3MaxImages",
          reasonArgs: { count: H3_REFERENCE_LIMITS.images },
        };
      }
      if (counts.videos > H3_REFERENCE_LIMITS.videos) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3MaxVideos",
          reasonArgs: { count: H3_REFERENCE_LIMITS.videos },
        };
      }
      if (counts.audios > H3_REFERENCE_LIMITS.audios) {
        return {
          mode,
          enabled: false,
          reasonKey: "node.videoOps.modeDisabled.h3MaxAudios",
          reasonArgs: { count: H3_REFERENCE_LIMITS.audios },
        };
      }
      return { mode, enabled: true, reasonKey: null };
    default:
      return {
        mode,
        enabled: false,
        reasonKey: "node.videoOps.modeDisabled.h3UnsupportedMode",
      };
  }
}

/** Pick a deterministic valid H3 mode after the connected material changes. */
export function minimaxH3BestMode(
  counts: MiniMaxH3MediaCounts,
  currentMode?: VideoGenMode | null,
): VideoGenMode | null {
  if (
    currentMode &&
    MINIMAX_H3_MODE_ORDER.includes(currentMode) &&
    minimaxH3ModeAvailability(currentMode, counts).enabled
  ) {
    return currentMode;
  }
  if (totalMedia(counts) === 0) return "textToVideo";
  if (counts.videos === 0 && counts.audios === 0 && counts.images === 1) {
    return "imageToVideo";
  }
  if (counts.videos === 0 && counts.audios === 0 && counts.images === 2) {
    return "firstLastFrame";
  }
  return minimaxH3ModeAvailability("allReference", counts).enabled
    ? "allReference"
    : null;
}
