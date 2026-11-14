// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Pure VideoNode option normalization, shared with the request builder.
import type { Seedance2SceneOptimize, VideoGenQuality } from '../../domain/canvasNodes';
import { FALLBACK_VIDEO_RESOLUTION_OPTIONS } from '../../domain/mediaModelOptions';

const QUALITIES: ReadonlyArray<VideoGenQuality> = FALLBACK_VIDEO_RESOLUTION_OPTIONS;
const SCENE_OPTIMIZE_OPTIONS: ReadonlyArray<Seedance2SceneOptimize> = ["anime", "realistic"];
export const DEFAULT_DURATION_MIN = 5;
const DEFAULT_DURATION_MAX = 15;

export function videoQualityOptionsForModel(
  model: { resolutionOptions?: string[] } | null | undefined,
): readonly VideoGenQuality[] {
  const options = (model?.resolutionOptions ?? []).map((item) => item.trim()).filter(Boolean);
  return options.length > 0 ? options : QUALITIES;
}

export function normalizeVideoQuality(
  value: VideoGenQuality | undefined,
  options: readonly VideoGenQuality[],
): VideoGenQuality {
  const configured = value
    ? options.find((option) => option.toLowerCase() === value.toLowerCase())
    : undefined;
  const fallback =
    options.find((option) => option.toLowerCase() === "720p") ?? options[0] ?? "720p";
  return configured ?? fallback;
}

export function videoDurationBoundsForModel(
  model: { minDuration?: number | null; maxDuration?: number | null } | null | undefined,
): { min: number; max: number } {
  const min = Number(model?.minDuration);
  const max = Number(model?.maxDuration);
  const resolvedMin = Number.isFinite(min) && min > 0 ? min : DEFAULT_DURATION_MIN;
  const resolvedMax = Number.isFinite(max) && max >= resolvedMin ? max : DEFAULT_DURATION_MAX;
  return { min: resolvedMin, max: resolvedMax };
}

function isSeedance2ValueModel(modelId: string | null | undefined): boolean {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return normalized === "newapi_seedance-2.0-value" ||
    normalized === "newapi_seedance-2.0-fast-value" ||
    normalized === "huimeng_seedance-2.0-value" ||
    normalized === "huimeng_seedance-2.0-fast-value";
}

export function sceneOptimizeOptionsForModel(
  model: {
    id?: string;
    apiModel?: string;
    sceneOptimizeOptions?: Array<"anime" | "realistic">;
  } | null | undefined,
): readonly Seedance2SceneOptimize[] {
  if (model?.sceneOptimizeOptions?.length) {
    return model.sceneOptimizeOptions;
  }
  return isSeedance2ValueModel(model?.apiModel ?? model?.id) ? SCENE_OPTIMIZE_OPTIONS : [];
}

export function defaultSceneOptimizeForModel(
  model: {
    id?: string;
    apiModel?: string;
    defaultSceneOptimize?: "anime" | "realistic" | null;
  } | null | undefined,
): Seedance2SceneOptimize {
  if (model?.defaultSceneOptimize === "anime" || model?.defaultSceneOptimize === "realistic") {
    return model.defaultSceneOptimize;
  }
  const modelId = String(model?.apiModel ?? model?.id ?? "").toLowerCase();
  return modelId.includes("fast-value") ? "realistic" : "anime";
}

export function normalizeSceneOptimize(
  value: Seedance2SceneOptimize | undefined,
  options: readonly Seedance2SceneOptimize[],
  fallback: Seedance2SceneOptimize,
): Seedance2SceneOptimize | undefined {
  if (options.length === 0) return undefined;
  return value && options.includes(value) ? value : fallback;
}
