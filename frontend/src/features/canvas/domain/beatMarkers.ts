// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Sentinels the backend puts in `detected_identities` / `detected_props` to say
 * "this beat deliberately has no character / no prop" — they are NOT ids, and
 * must never reach the UI as a chip, mention or option label.
 */
export const NO_CHARACTER_MARKER = "__NO_CHARACTER__";
export const NO_PROP_MARKER = "__NO_PROP__";

export function isNoReferenceMarker(id: string): boolean {
  return id === NO_CHARACTER_MARKER || id === NO_PROP_MARKER;
}
