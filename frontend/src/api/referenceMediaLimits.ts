// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Optional reference limits. Null/absence is intentionally not a default. */
const numericFields = [
  "referenceImageMaxMB", "referenceImageMinWidth", "referenceImageMaxWidth",
  "referenceImageMinHeight", "referenceImageMaxHeight",
  "referenceImageMinAspectRatio", "referenceImageMaxAspectRatio",
  "referenceAudioMaxMB", "referenceVideoMaxMB", "referenceVideoMinFPS", "referenceVideoMaxFPS",
] as const;
const formatFields = ["referenceImageFormats", "referenceAudioFormats", "referenceVideoFormats"] as const;
export type ReferenceMediaLimits = Partial<Record<typeof numericFields[number], number | null>>
  & Partial<Record<typeof formatFields[number], string[] | null>>;

export function readReferenceMediaLimits(entry: Record<string, unknown>): ReferenceMediaLimits {
  const result: ReferenceMediaLimits = {};
  for (const field of numericFields) {
    const value = entry[field];
    if (value === null || (typeof value === "number" && Number.isFinite(value) && value > 0)) result[field] = value;
  }
  for (const field of formatFields) {
    const value = entry[field];
    if (value === null) result[field] = null;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) result[field] = value;
  }
  return result;
}
