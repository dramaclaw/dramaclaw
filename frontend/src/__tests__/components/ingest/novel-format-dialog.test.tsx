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
    // 三个 <pre> 依次是：完整场景头 / 可修复格式 / 示例片段。分开断言，
    // 因为「某一行出现在哪一块」正是这个弹窗要传达的信息。
    const [spec, repairable, example] = Array.from(
      baseElement.querySelectorAll("pre"),
    ).map((el) => el.textContent ?? "");

    expect(spec).toContain("INT. SEOUL SUBWAY STATION - NIGHT");
    expect(spec).toContain("EXT. SEOUL STREET - DAWN");
    // 精确钟点走独立的 Time: 行，不能写进地点名。
    expect(spec).toContain("Time: 11:47 PM");
    // 时间词只有 7 个，写别的会整行识别不出来。
    expect(spec).toContain("DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK");

    // INT./EXT. 落不到单一的内/外景取值上，一个这样的场景就会把整本剧本从
    // standard 拉到 repairable，所以它属于「可修复」而不是「完整」。对应后端
    // tests/test_screenplay_scene_parser.py::test_int_ext_heading_is_repairable_not_complete。
    expect(spec).not.toContain("INT./EXT.");
    expect(repairable).toContain("SCENE 1 - SEOUL SUBWAY STATION");
    expect(repairable).toContain("INT./EXT. MOVING TAXI - DAY");

    // 完整示例逐字对齐 tests/test_screenplay_scene_parser.py 里那份，
    // 那边钉住了它解析出来是 standard、零警告。
    expect(example).toContain("EXT. SEOUL STREET - DAWN");
    expect(example).toContain("JI-WON: I made it back.");

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
