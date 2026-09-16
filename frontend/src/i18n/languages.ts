// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * The supported UI languages, kept in a side-effect-free module.
 *
 * `./index` initializes i18next as an import side effect, so anything that only
 * needs the language list (the account menu, for one) imports from here instead
 * — otherwise every consumer's test has to stand up the full i18next runtime.
 *
 * Adding a locale: add the tag here, add `locales/<tag>/translation.json`, and
 * add its label key to `LANGUAGE_LABEL_KEYS` in `components/layout/header.tsx`.
 */
export const SUPPORTED = ["zh", "en", "vi"] as const;
export type Supported = (typeof SUPPORTED)[number];

export function normalize(lng: string | undefined): Supported {
  const two = (lng ?? "").slice(0, 2).toLowerCase();
  return (SUPPORTED as readonly string[]).includes(two) ? (two as Supported) : "zh";
}
