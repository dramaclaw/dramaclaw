// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { listCapabilities } from "@/features/freezone/capabilities/capabilityRegistry";

function lookup(translations: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      translations,
    );
}

/**
 * 能力表的展示文案全在词条里，源码只留 key。漏配词条时界面会直接显示裸 key，
 * 而不是回退到中文——所以这里把每个 key 都对着两份 locale 查一遍。
 */
describe("capability copy is fully translated", () => {
  const locales = ["zh", "en"].map((language) => ({
    language,
    translations: JSON.parse(
      readFileSync(`public/locales/${language}/translation.json`, "utf8"),
    ) as Record<string, unknown>,
  }));

  const keys = listCapabilities().flatMap((capability) => [
    capability.nameKey,
    capability.shortNameKey,
    capability.descriptionKey,
    ...capability.inputs.flatMap((input) =>
      [input.labelKey, input.descriptionKey].filter((key): key is string => Boolean(key)),
    ),
    ...capability.params.flatMap((param) => [
      param.labelKey,
      ...(param.descriptionKey ? [param.descriptionKey] : []),
      ...(param.options ?? []).map((option) => option.labelKey),
    ]),
  ]);

  it.each(locales)("resolves every capability key in $language", ({ translations }) => {
    const missing = keys.filter((key) => typeof lookup(translations, key) !== "string");

    expect(missing).toEqual([]);
  });
});
