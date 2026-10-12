// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function collectKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    collectKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function loadLocale(language: string): unknown {
  return JSON.parse(readFileSync(`public/locales/${language}/translation.json`, "utf8"));
}

describe("locale translation files", () => {
  it.each(["en", "zh", "vi"])("%s translation JSON is valid", (language) => {
    const content = readFileSync(`public/locales/${language}/translation.json`, "utf8");

    expect(() => JSON.parse(content)).not.toThrow();
  });

  // `en` is the reference key set. A locale may leave a value in English on
  // purpose — prompt fragments, domain terms and product names all stay as they
  // are — but it may never be missing a key, or i18next renders the raw key.
  it.each(["zh", "vi"])("keeps %s aligned with the en key set", (language) => {
    const en = loadLocale("en");
    const other = loadLocale(language);
    const enKeys = new Set(collectKeys(en));
    const otherKeys = new Set(collectKeys(other));

    expect([...enKeys].filter((key) => !otherKeys.has(key)).sort()).toEqual([]);
    expect([...otherKeys].filter((key) => !enKeys.has(key)).sort()).toEqual([]);
  });

  it("defines the Niu Lai accessory name and selection feedback", () => {
    const zh = JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8"));

    expect(zh.myBuddy.debug.accessories.niulai).toBe("牛来");
    expect(zh.myBuddy.debug.accessoryFeedback.niulai).toBe("妈妈！");
  });

  it("uses the requested custom prompt label for Seedance2 guidance in Chinese", () => {
    const content = readFileSync("public/locales/zh/translation.json", "utf8");
    const translations = JSON.parse(content);

    expect(translations.episode.workbench.video.seedance2PromptGuidance).toBe("自定义提示词");
  });

  it("labels Seedance2 text-only reference fallbacks as missing reference images in Chinese", () => {
    const content = readFileSync("public/locales/zh/translation.json", "utf8");
    const translations = JSON.parse(content);

    expect(translations.episode.workbench.video.seedance2ReferenceFallback).toBe("缺参考图");
  });

  it("uses the requested default project queue full toast in Chinese", () => {
    const content = readFileSync("public/locales/zh/translation.json", "utf8");
    const translations = JSON.parse(content);

    expect(translations.common.projectDefaultQueueFull).toBe(
      "当前项目默认队列已满",
    );
  });

  it("defines organization, platform, and node queue limit toasts in Chinese", () => {
    const content = readFileSync("public/locales/zh/translation.json", "utf8");
    const translations = JSON.parse(content);

    expect(translations.common.organizationDefaultQueueFull).toBe("当前组织默认队列已满");
    expect(translations.common.platformDefaultQueueFull).toBe("平台默认队列已满");
    expect(translations.common.nodeDefaultQueueFull).toBe("当前节点默认队列已满");
  });

  it("defines project queue kind labels in Chinese", () => {
    const content = readFileSync("public/locales/zh/translation.json", "utf8");
    const translations = JSON.parse(content);

    expect(translations.common.projectQueueKinds).toMatchObject({
      video: "视频",
      world: "世界",
      ffmpeg: "合成",
    });
  });

  it("defines 3D director labels used without default values", () => {
    const zh = JSON.parse(readFileSync("public/locales/zh/translation.json", "utf8"));
    const en = JSON.parse(readFileSync("public/locales/en/translation.json", "utf8"));
    const keys = [
      "currentBackgroundSource",
      "downstreamCurrentBackground",
      "shapeHint",
      "saveScene",
      "clearScene",
    ];

    for (const language of [zh, en]) {
      for (const key of keys) {
        expect(language.viewer.threeD[key]).toEqual(expect.any(String));
        expect(language.viewer.threeD[key].length).toBeGreaterThan(0);
      }
    }
  });
});

it("translates the missing keyframe recovery hint in Vietnamese", () => {
  const vi = JSON.parse(readFileSync("public/locales/vi/translation.json", "utf8"));
  const en = JSON.parse(readFileSync("public/locales/en/translation.json", "utf8"));
  expect(vi.node.videoNode.generation.missingKeyframe).not.toBe(en.node.videoNode.generation.missingKeyframe);
  expect(vi.node.videoNode.generation.missingKeyframe).toContain("khung hình");
});

it("localizes every shot continuity control in Vietnamese", () => {
  const vi = JSON.parse(readFileSync("public/locales/vi/translation.json", "utf8"));
  const en = JSON.parse(readFileSync("public/locales/en/translation.json", "utf8"));
  for (const key of Object.keys(en.canvas.story.continuity)) {
    expect(vi.canvas.story.continuity[key], key).not.toBe(en.canvas.story.continuity[key]);
  }
});

function localeValue(root: unknown, path: string): unknown {
  let value = root;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

it.each(["canvas.story", "storyPublication"])("localizes %s in Vietnamese and preserves interpolation", (namespace) => {
  const en = loadLocale("en");
  const vi = loadLocale("vi");
  const keys = collectKeys(localeValue(en, namespace));
  const untranslated: string[] = [];
  for (const key of keys) {
    const fullKey = `${namespace}.${key}`;
    const source = localeValue(en, fullKey);
    const translated = localeValue(vi, fullKey);
    expect(typeof translated, fullKey).toBe("string");
    if (source === translated) untranslated.push(fullKey);
    if (typeof source === "string" && typeof translated === "string") {
      expect((translated.match(/\{\{.*?\}\}/g) ?? []).sort(), fullKey)
        .toEqual((source.match(/\{\{.*?\}\}/g) ?? []).sort());
    }
  }
  expect(untranslated).toEqual([]);
});
