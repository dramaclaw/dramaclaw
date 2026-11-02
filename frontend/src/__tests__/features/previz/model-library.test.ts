// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_LIBRARY_CATEGORIES,
  PREVIZ_LIBRARY_ENTRIES,
  PREVIZ_MODEL_LIBRARY_BASE,
  isPrevizLibraryModelUrl,
  countByCategory,
  searchLibrary,
} from "@/features/previz/domain/modelLibrary";
import { PREVIZ_LIBRARY_MODELS } from "@/features/previz/domain/libraryModels";
import { PREVIZ_PRIMITIVE_SHAPES } from "@/features/previz/domain/primitives";

/** 只翻两个名字：搜中文要能命中，其余条目回落成 key 本身，正好证明没翻的不会误中。 */
const NAMES: Record<string, string> = {
  "previz.library.primitive.sphere": "球体",
  "previz.library.primitive.cube": "立方体",
};
const translate = (key: string) => NAMES[key] ?? key;

function ids(entries: readonly { id: string }[]): string[] {
  return entries.map((entry) => entry.id);
}

describe("previz model library", () => {
  it("lists the primitives first, then the CDN models, each in catalogue order", () => {
    expect(ids(PREVIZ_LIBRARY_ENTRIES)).toEqual([
      ...Object.keys(PREVIZ_PRIMITIVE_SHAPES).map((shape) => `primitive-${shape}`),
      ...ids(PREVIZ_LIBRARY_MODELS),
    ]);
  });

  it("gives every entry a unique id", () => {
    expect(new Set(ids(PREVIZ_LIBRARY_ENTRIES)).size).toBe(PREVIZ_LIBRARY_ENTRIES.length);
  });

  // 场景里存的是这条完整 URL：版本号必须在路径里，换一批模型才不会改掉已经排好的镜头。
  it("points each CDN model at its versioned glb and thumbnail", () => {
    const sedan = PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "vehicle-sedan");

    // 只锁版本段：本地 `.env.local` 可以把根改指同源目录（vitest 也会读它）。
    expect(PREVIZ_MODEL_LIBRARY_BASE).toMatch(/\/v\d+$/);
    expect(sedan).toMatchObject({
      nameKey: "previz.library.model.vehicle-sedan",
      category: "vehicle",
      assetFormat: "glb",
      assetUrl: `${PREVIZ_MODEL_LIBRARY_BASE}/vehicle/sedan.glb`,
      thumbnailUrl: `${PREVIZ_MODEL_LIBRARY_BASE}/vehicle/sedan.webp`,
    });
    expect(sedan?.tags).toContain("car");
  });

  // 挑中一张卡片之后，编辑器原样把这两个字段写进物件——它们就是场景里的那份真相。
  it("points each primitive entry at its shape", () => {
    const wedge = PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "primitive-wedge");

    expect(wedge).toMatchObject({
      nameKey: "previz.library.primitive.wedge",
      category: "primitive",
      triangles: 8,
      assetFormat: "primitive",
      assetUrl: "wedge",
    });
    expect(wedge?.tags).toEqual(["wedge", "ramp", "slope"]);
  });

  it("files every entry under a known category", () => {
    for (const entry of PREVIZ_LIBRARY_ENTRIES) {
      expect(Object.keys(PREVIZ_LIBRARY_CATEGORIES)).toContain(entry.category);
    }
  });

  it("counts entries per category, with the total matching their sum", () => {
    const counts = countByCategory(PREVIZ_LIBRARY_ENTRIES);

    expect(counts.all).toBe(25 + PREVIZ_LIBRARY_MODELS.length);
    expect(counts.byCategory.primitive).toBe(25);
    // 每个分类都得有货：左栏不该出现点进去是空的分类。
    for (const count of Object.values(counts.byCategory)) expect(count).toBeGreaterThan(0);
    expect(Object.values(counts.byCategory).reduce((sum, n) => sum + n, 0)).toBe(counts.all);
  });

  // 空分类也要在左栏出现并显示 0，而不是整行消失。
  it("reports empty categories as zero", () => {
    expect(countByCategory([])).toEqual({
      all: 0,
      byCategory: {
        primitive: 0,
        furniture: 0,
        architecture: 0,
        city: 0,
        vehicle: 0,
        prop: 0,
        nature: 0,
      },
    });
  });

  it("finds entries by localised name, alias and shape name", () => {
    expect(ids(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "球", translate))).toEqual([
      "primitive-sphere",
    ]);
    expect(ids(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "ramp", translate))).toEqual([
      "primitive-wedge",
    ]);
    // 英文形状名本身也在 tags 里（见 `PREVIZ_LIBRARY_ENTRIES` 的映射，tags 首项就是
    // shape），不靠 id 也搜得到——这一条要在 id 退出搜索范围之后依然成立。
    expect(ids(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "torus", translate))).toEqual([
      "primitive-torus",
    ]);
  });

  // id 不再参与匹配：清单里每条 id 都带 `primitive-` 前缀，这段前缀本身不该被搜到，
  // 否则单字母查询（"p"/"r"/"i"……）会靠它命中全部卡片，搜索框形同虚设。
  //
  // 这里另起一份 translate，把全部 key 都翻成形状名本身：文件顶上那份 `translate`
  // 只翻了两个键，其余回落成原始 key 字符串，而原始 key 恰好写成
  // `previz.library.primitive.<shape>`——字面上就带着 "primitive"，拿它当这条用例的
  // translate 会把「key 没翻译时凑巧带的这几个字母」和「真正要测的 id 前缀」混在一起。
  it("does not match the id's primitive- prefix", () => {
    const translateShapeName = (key: string) => key.split(".").pop() ?? key;
    expect(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "primitive", translateShapeName)).toEqual([]);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(ids(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "  DONUT ", translate))).toEqual([
      "primitive-torus",
    ]);
  });

  it("returns everything for a blank query and nothing for a miss", () => {
    expect(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "   ", translate)).toHaveLength(
      PREVIZ_LIBRARY_ENTRIES.length,
    );
    expect(searchLibrary(PREVIZ_LIBRARY_ENTRIES, "zzz", translate)).toEqual([]);
  });

  it("recognises library models by path, whichever root they were saved under", () => {
    const sedan = PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "vehicle-sedan")!;

    expect(isPrevizLibraryModelUrl(sedan.assetUrl)).toBe(true);
    expect(
      isPrevizLibraryModelUrl("https://nfg-web-assets.cdnfg.com/dramaclaw/previz/models/v1/vehicle/sedan.glb"),
    ).toBe(true);
    expect(isPrevizLibraryModelUrl("/previz/models/v1/vehicle/sedan.glb")).toBe(true);
    // 用户自己导入的模型保留原材质。
    expect(isPrevizLibraryModelUrl("/static/uploads/chair.glb")).toBe(false);
  });
});
