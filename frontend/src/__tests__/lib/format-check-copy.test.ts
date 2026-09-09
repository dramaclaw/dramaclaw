// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { localizeFormatCheck } from "@/lib/format-check-copy";
import type { FormatCheck } from "@/lib/queries/ingest";

const CJK = /[一-鿿、。“”]/;
const BACKEND_SOURCE = "../src/novelvideo/utils/screenplay_quality.py";

function loadLocale(language: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`public/locales/${language}/translation.json`, "utf8"));
}

let instance: ReturnType<typeof i18next.createInstance>;
let en: TFunction;
let zh: TFunction;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: "en",
    fallbackLng: false,
    resources: {
      en: { translation: loadLocale("en") },
      zh: { translation: loadLocale("zh") },
    },
    interpolation: { escapeValue: false },
  });
  en = instance.getFixedT("en");
  zh = instance.getFixedT("zh");
});

// 后端 screenplay_quality.py 只产中文，前端按 code 查 i18n。这份样例覆盖了它能发出
// 的每种 issue 形态：报告级（params 为空）、行级场景头（params.header 决定共用 key）、
// 章节结构（带数字/标题插值）。
const PAYLOAD: FormatCheck = {
  level: "warning",
  summary: "上传成功，但检测到 3 个格式风险，可能影响场景识别。",
  summary_code: "format_risks",
  summary_params: { count: 3 },
  issues: [
    {
      code: "scene_headers_missing_time",
      line: null,
      message:
        "检测到缺少明确时间锚点的场景头/场次头；后续 time_of_day 与 scene variant 继承可能不稳定。",
      fix: "建议在场景头中补充明确时间，如“日/夜/深夜”；系统仍会保留场景边界并在后续规范化。",
      params: {},
    },
    {
      code: "incomplete_scene_header",
      line: 12,
      message: "场景头“1-1 城市咖啡馆”缺少时间、内/外。",
      fix: "请按实际场景补充，可参考“1-1 城市咖啡馆 [日/夜] [内/外]”。",
      params: {
        header: "1-1 城市咖啡馆",
        missing_slots: ["time", "interior_exterior"],
        location: "城市咖啡馆",
        time_of_day: "",
        interior_exterior: "",
        labeled_form: false,
      },
    },
    {
      code: "duplicate_chapter_number",
      line: 40,
      message: "检测到重复章节序号 3：未命名章节。",
      fix: "建议检查正文中疑似章节标题的句子，避免同一章节号被切成多个章节。",
      params: { number: 3, title: "" },
    },
  ],
  metrics: {},
  scene_header_status: "repairable",
};

describe("localizeFormatCheck", () => {
  it("returns null for a missing format check", () => {
    expect(localizeFormatCheck(null, en)).toBeNull();
    expect(localizeFormatCheck(undefined, en)).toBeNull();
  });

  it("leaves no backend Chinese in the English rendering", () => {
    const localized = localizeFormatCheck(PAYLOAD, en)!;

    expect(localized.summary).toBe(
      "Upload succeeded, but 3 formatting risks were detected that may affect scene recognition.",
    );
    // 用户原文（场景头、地点）本来就可能是中文，只断言我们自己产的句式部分。
    expect(localized.issues![0].message).not.toMatch(CJK);
    expect(localized.issues![0].fix).not.toMatch(CJK);
    expect(localized.issues![1].message).toBe(
      "Scene heading “1-1 城市咖啡馆” is missing a time of day, an INT/EXT marker.",
    );
    expect(localized.issues![1].fix).toBe(
      "Fill in the missing values from the actual scene — for example “1-1 城市咖啡馆 [DAY/NIGHT] [INT/EXT]”.",
    );
    expect(localized.issues![2].message).toBe("Duplicate chapter number 3: Untitled chapter.");
    expect(localized.issues![2].fix).not.toMatch(CJK);
  });

  it("keeps the singular form for a single risk", () => {
    const localized = localizeFormatCheck(
      { ...PAYLOAD, summary_params: { count: 1 } },
      en,
    )!;

    expect(localized.summary).toContain("1 formatting risk was detected");
  });

  it("rebuilds the labeled suggestion form with localized placeholders", () => {
    const localized = localizeFormatCheck(
      {
        ...PAYLOAD,
        issues: [
          {
            code: "incomplete_scene_header",
            line: 7,
            message: "场景头“场次 1”缺少时间、内/外。",
            fix: "请按实际场景补充。",
            params: {
              header: "场次 1",
              missing_slots: ["time", "interior_exterior"],
              location: "咖啡馆",
              time_of_day: "",
              interior_exterior: "",
              labeled_form: true,
            },
          },
        ],
      },
      en,
    )!;

    expect(localized.issues![0].fix).toContain(
      "场次 1; Location: 咖啡馆, [DAY/NIGHT], [INT/EXT]",
    );
  });

  it("reproduces the backend copy verbatim in Chinese", () => {
    const localized = localizeFormatCheck(PAYLOAD, zh)!;

    expect(localized.summary).toBe(PAYLOAD.summary);
    expect(localized.issues![1].message).toBe(PAYLOAD.issues![1].message);
    expect(localized.issues![1].fix).toBe(PAYLOAD.issues![1].fix);
    expect(localized.issues![2].message).toBe(PAYLOAD.issues![2].message);
  });

  it("falls back to the backend copy for a code the frontend has no key for", () => {
    const localized = localizeFormatCheck(
      {
        ...PAYLOAD,
        summary_code: "brand_new_backend_code",
        issues: [
          {
            code: "brand_new_issue",
            line: null,
            message: "后端刚加的问题。",
            fix: "后端刚加的建议。",
            params: {},
          },
        ],
      },
      en,
    )!;

    expect(localized.summary).toBe(PAYLOAD.summary);
    expect(localized.issues![0].message).toBe("后端刚加的问题。");
  });
});

// 棘轮：后端新增 issue code 却没补 en/zh key 时，英文界面会静默漏中文（defaultValue
// 兜底不会报错）。这里直接从 Python 源码里抠出 code 常量来对账。
describe("format check codes stay covered by the locale files", () => {
  // 行级场景头的三个 code 共用 sceneHeaderMissingSlots，由 params.header 路由。
  const HEADER_ROUTED = new Set([
    "incomplete_scene_header",
    "scene_headers_missing_time",
    "missing_interior_exterior",
  ]);

  it("has a message and fix for every code the backend can emit", () => {
    const source = readFileSync(BACKEND_SOURCE, "utf8");
    const codes = new Set<string>();
    for (const match of source.matchAll(/(?:"code":\s*|code=)"([a-z_]+)"/g)) {
      codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(8);

    const missing = [...codes]
      .filter((code) => !HEADER_ROUTED.has(code))
      .filter((code) => {
        const key = `ingest.formatCheck.issue.${code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`;
        return !instance.exists(`${key}.message`, { lng: "en" }) ||
          !instance.exists(`${key}.fix`, { lng: "en" });
      })
      .sort();

    expect(missing).toEqual([]);
  });

  it("has a summary for every summary_code the backend can emit", () => {
    const source = readFileSync(BACKEND_SOURCE, "utf8");
    const codes = new Set<string>();
    for (const match of source.matchAll(/summary_code\s*=\s*"([a-z_]+)"/g)) {
      codes.add(match[1]);
    }
    expect(codes.size).toBeGreaterThan(3);

    const missing = [...codes]
      .filter((code) => {
        const camel = code.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        // 复数键在 i18next 里存成 _one/_other，exists 对裸键会落空。
        return (
          !instance.exists(`ingest.formatCheck.summary.${camel}`, { lng: "en" }) &&
          !instance.exists(`ingest.formatCheck.summary.${camel}_other`, { lng: "en" })
        );
      })
      .sort();

    expect(missing).toEqual([]);
  });
});
