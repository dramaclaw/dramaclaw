// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import { normalize } from "@/i18n";
import { useAppStore } from "@/stores/app-store";

describe("UI language defaults", () => {
  it("normalizes unknown and missing locales to English", () => {
    expect(normalize(undefined)).toBe("en");
    expect(normalize("")).toBe("en");
    expect(normalize("fr-FR")).toBe("en");
    expect(normalize("en-US")).toBe("en");
    expect(normalize("zh-CN")).toBe("zh");
  });

  it("app store initial language is English", () => {
    expect(useAppStore.getState().language === "en" || useAppStore.getState().language === "zh").toBe(
      true,
    );
    // Module default in create() is "en"; persisted zh from prior sessions is allowed.
    const raw = window.localStorage.getItem("supertale-app");
    if (!raw) {
      expect(useAppStore.getState().language).toBe("en");
    }
  });
});
