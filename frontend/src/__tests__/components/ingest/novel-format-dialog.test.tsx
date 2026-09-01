// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { NovelFormatDialog } from "@/components/ingest/NovelFormatDialog";
import { enTranslation, zhTranslation } from "../../helpers/i18n-fixtures";

/**
 * 格式说明弹窗里的样例是「照着抄」的模板，中英各一套：解析器两种格式都认，但
 * 给英文用户看中文制片格式等于没给。这里钉住的是「跟着界面语言切」这件事。
 */
async function renderIn(lng: "zh" | "en") {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: lng,
    interpolation: { escapeValue: false },
    resources: {
      zh: { translation: zhTranslation },
      en: { translation: enTranslation },
    },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <NovelFormatDialog open onOpenChange={vi.fn()} />
    </I18nextProvider>,
  );
}

beforeAll(() => {
  // Radix 的 Dialog 在 jsdom 里要用到这两个，缺了直接抛。
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("NovelFormatDialog", () => {
  it("shows the Fountain sample and English-only rules in the English UI", async () => {
    const { baseElement } = await renderIn("en");
    const shown = baseElement.textContent ?? "";

    // 完整示例逐字对齐 tests/test_screenplay_scene_parser.py 里那份，
    // 那边钉住了它解析出来是 standard、零警告。
    expect(shown).toContain("INT. SEOUL SUBWAY STATION - NIGHT");
    expect(shown).toContain("EXT. SEOUL STREET - DAWN");
    expect(shown).toContain("JI-WON: I made it back.");
    // 可修复格式：SCENE 1 - TITLE，能定边界但缺时间。
    expect(shown).toContain("SCENE 1 - SEOUL SUBWAY STATION");
    // 精确钟点走独立的 Time: 行，不能写进地点名。
    expect(shown).toContain("Time: 11:47 PM");
    // 时间词只有 7 个，写别的会整行识别不出来。
    expect(shown).toContain("DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK");
    expect(shown).toContain("MIDNIGHT");

    // 英文界面不该再漏中文样例。
    expect(shown).not.toContain("苏鸾寝殿");
  });

  it("keeps the Chinese production-format sample in the Chinese UI", async () => {
    const { baseElement } = await renderIn("zh");
    const shown = baseElement.textContent ?? "";

    expect(shown).toContain("1-1 苏鸾寝殿 深夜 内");
    expect(shown).toContain("苏糖：锦绣，几更了？");
    expect(shown).not.toContain("SEOUL SUBWAY STATION");
  });
});
