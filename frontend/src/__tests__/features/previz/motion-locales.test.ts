// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PREVIZ_BUILTIN_MOTIONS,
  PREVIZ_MOTION_CATEGORIES,
  type PrevizMotionLoadError,
} from "@/features/previz/domain/motionLibrary";
import type { PrevizSkeletonKind } from "@/features/previz/domain/scene";
import type { ActionInsertRejection } from "@/features/previz/domain/actionClips";
import { motionErrorText, motionLabel, motionRejectText } from "@/features/previz/ui/motionLabel";
import { enT, zhT } from "../../helpers/i18n-fixtures";

function motionTree(lng: string): Record<string, unknown> {
  const table = JSON.parse(readFileSync(`public/locales/${lng}/translation.json`, "utf8")) as {
    previz?: { motion?: Record<string, unknown> };
  };
  return table.previz?.motion ?? {};
}

function flatten(tree: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") keys.push(...flatten(value as Record<string, unknown>, path));
    else keys.push(path);
  }
  return keys.sort();
}

// 类型把联合里的每个成员都列一遍：往联合里加码而忘了补文案时，这里先编不过。
const ERROR_CODES: Record<PrevizMotionLoadError["code"], true> = {
  bad_extension: true,
  too_large: true,
  fetch_failed: true,
  parse_failed: true,
  no_animation: true,
  zero_duration: true,
  unsupported_skeleton: true,
};
const REJECTIONS: Record<ActionInsertRejection, true> = {
  "no-room": true,
  limit: true,
  "unknown-motion": true,
  "not-character": true,
};
const SKELETONS: Record<PrevizSkeletonKind, true> = { ual: true, mixamo: true, smpl: true };

describe("previz.motion 文案", () => {
  it("三种语言的键完全一致", () => {
    const zh = flatten(motionTree("zh"));
    expect(zh.length).toBeGreaterThan(0);
    expect(flatten(motionTree("en"))).toEqual(zh);
    expect(flatten(motionTree("vi"))).toEqual(zh);
  });

  it("每条内置动作都有中英文名字", () => {
    for (const motion of PREVIZ_BUILTIN_MOTIONS) {
      expect(zhT(motion.labelKey)).not.toBe(motion.labelKey);
      expect(enT(motion.labelKey)).not.toBe(motion.labelKey);
    }
  });

  it("分类、拒绝原因、报错码、骨架都有文案", () => {
    const keys = [
      ...PREVIZ_MOTION_CATEGORIES.map((category) => `previz.motion.category.${category}`),
      "previz.motion.category.imported",
      ...Object.keys(REJECTIONS).map((code) => `previz.motion.library.reject.${code}`),
      ...Object.keys(ERROR_CODES).map((code) => `previz.motion.error.${code}`),
      ...Object.keys(SKELETONS).map((kind) => `previz.motion.skeleton.${kind}`),
    ];
    for (const key of keys) {
      expect(() => zhT(key)).not.toThrow();
      expect(() => enT(key)).not.toThrow();
    }
  });
});

/**
 * 「三种语言的键完全一致」只抓得住三份 JSON 之间的差异；如果三份一起漏掉同一个键
 * （比如都忘了写 `razor`），那条测试反而会通过。这里照 `previz-locale.test.ts` 的
 * 写法把键列表写死，钉住内置动作 / 分类 / 拒绝原因 / 报错码 / 骨架之外的那批杂项文案。
 */
const MOTION_KEYS = ["row", "add", "addTitle", "razor", "unknown", "loading", "loop", "once", "seconds"] as const;
const MOTION_LIBRARY_KEYS = [
  "titleAdd",
  "titleReplace",
  "close",
  "categories",
  "search",
  "list",
  "empty",
  "preview",
  "pickHint",
  "confirmAdd",
  "confirmReplace",
] as const;
const MOTION_LIBRARY_REJECT_KEYS = ["no-room", "limit", "unknown-motion", "not-character"] as const;
const MOTION_IMPORT_KEYS = [
  "button",
  "empty",
  "reading",
  "title",
  "fileInfo",
  "clips",
  "previewClip",
  "name",
  "loop",
  "truncated",
  "cancel",
  "confirm",
  "uploading",
  "uploadFailed",
  "limit",
  "noProject",
  "rename",
  "remove",
  "removeTitle",
  "removeUsed",
  "removeConfirm",
] as const;
const MOTION_INSPECTOR_KEYS = [
  "motion",
  "replace",
  "duration",
  "durationValue",
  "fit",
  "source",
  "builtin",
  "imported",
] as const;
const MOTION_TOP_LEVEL_GROUPS = ["category", "skeleton", "error", "builtin", "library", "import", "inspector"];

describe("previz.motion 非内置文案", () => {
  for (const lng of ["zh", "en"] as const) {
    it(`${lng} 覆盖 row/library/import/inspector 的全部键`, () => {
      const motion = motionTree(lng) as {
        library: Record<string, unknown> & { reject: Record<string, unknown> };
        import: Record<string, unknown>;
        inspector: Record<string, unknown>;
      };
      expect(
        Object.keys(motion)
          .filter((key) => !MOTION_TOP_LEVEL_GROUPS.includes(key))
          .sort(),
      ).toEqual([...MOTION_KEYS].sort());
      const { reject, ...libraryRest } = motion.library;
      expect(Object.keys(libraryRest).sort()).toEqual([...MOTION_LIBRARY_KEYS].sort());
      expect(Object.keys(reject).sort()).toEqual([...MOTION_LIBRARY_REJECT_KEYS].sort());
      expect(Object.keys(motion.import).sort()).toEqual([...MOTION_IMPORT_KEYS].sort());
      expect(Object.keys(motion.inspector).sort()).toEqual([...MOTION_INSPECTOR_KEYS].sort());
    });
  }
});

describe("motionLabel", () => {
  const motions = [
    {
      id: "m1",
      name: "挥手",
      url: "https://example.test/wave.glb",
      sourceFileName: "wave.glb",
      format: "glb" as const,
      skeleton: "mixamo" as const,
      clipIndex: 0,
      durationSec: 2,
      loop: false,
    },
  ];

  it("内置动作用本地化名字", () => {
    expect(motionLabel(zhT, motions, "builtin:Walk_Loop")).toBe("走路");
    expect(motionLabel(enT, motions, "builtin:Walk_Loop")).toBe("Walk");
  });

  it("导入动作用用户起的名字", () => {
    expect(motionLabel(zhT, motions, "import:m1")).toBe("挥手");
  });

  it("找不到的引用显示未知动作", () => {
    expect(motionLabel(zhT, motions, "import:gone")).toBe("未知动作");
    expect(motionLabel(zhT, motions, "builtin:Nope")).toBe("未知动作");
  });
});

describe("motionErrorText", () => {
  it("把缺的骨骼和文件上限填进文案", () => {
    expect(motionErrorText(zhT, { code: "unsupported_skeleton", missing: ["Hips", "Spine"] })).toBe(
      "不支持的骨架（支持 UAL / Mixamo / SMPL），缺少：Hips, Spine",
    );
    expect(motionErrorText(zhT, { code: "too_large" })).toBe("文件超过 50 MB");
    expect(motionErrorText(enT, { code: "no_animation" })).toBe("The file has no animation");
    // 英文只测过不带参的 no_animation：too_large、unsupported_skeleton 这两个带参分支
    // 换了占位符名字也不会被上面那句发现，这里把结果钉死。
    expect(motionErrorText(enT, { code: "too_large" })).toBe("The file is larger than 50 MB");
    expect(motionErrorText(enT, { code: "unsupported_skeleton", missing: ["Hips"] })).toBe(
      "Unsupported skeleton (supports UAL / Mixamo / SMPL); missing: Hips",
    );
  });
});

describe("motionRejectText", () => {
  it("把动作片段上限填进拒绝文案，其余原样返回", () => {
    expect(motionRejectText(zhT, "limit")).toBe("这个人物的动作片段已达上限（60）");
    expect(motionRejectText(enT, "limit")).toBe(
      "This character already has the maximum of 60 motion clips",
    );
    expect(motionRejectText(zhT, "no-room")).toBe("播放头之后放不下这段动作");
    expect(motionRejectText(enT, "no-room")).toBe("No room for this motion after the playhead");
  });
});
