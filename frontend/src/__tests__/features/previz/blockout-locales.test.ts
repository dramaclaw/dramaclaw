// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { PrevizBlockoutStage } from "@/features/previz/ui/useBlockoutGeneration";
import type { PrevizBlockoutImportMode } from "@/features/previz/domain/blockout";
import {
  PREVIZ_BLOCKOUT_GUIDE_KEYS,
  PREVIZ_BLOCKOUT_HINT_KEY,
  PREVIZ_BLOCKOUT_REJECTION_KEY,
} from "@/features/previz/ui/blockoutMessages";

const LANGUAGES = ["zh", "en", "vi"] as const;
/** 出文案的就这几个文件；往别处加了 `previz.blockout.*` 的话把它补进来。 */
const SOURCES = [
  "src/features/previz/blockoutLanding.ts",
  "src/features/previz/ui/PrevizBlockoutDialog.tsx",
  "src/features/previz/ui/PrevizToolbar.tsx",
  "src/features/previz/ui/blockoutMessages.ts",
  "src/features/previz/ui/useBlockoutGeneration.ts",
];

function table(lng: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`public/locales/${lng}/translation.json`, "utf8")) as Record<
    string,
    unknown
  >;
}

function lookup(tree: unknown, key: string): unknown {
  let cursor = tree;
  for (const part of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function flatten(tree: unknown, prefix: string): string[] {
  if (!tree || typeof tree !== "object") return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = `${prefix}.${key}`;
    if (value && typeof value === "object") keys.push(...flatten(value, path));
    else keys.push(path);
  }
  return keys.sort();
}

// 类型把联合里的每个成员都列一遍：往联合里加成员而忘了补文案时，这里先编不过。
const STAGES: Record<Exclude<PrevizBlockoutStage, "idle">, true> = {
  uploading: true,
  generating: true,
  importing: true,
};
const MODES: Record<PrevizBlockoutImportMode, true> = { replace: true, append: true };

/** 代码里写死的 key：直接从源码里扫，不手抄一份清单——手抄的那份迟早跟代码对不上。 */
function literalKeys(): string[] {
  const found = new Set<string>();
  for (const path of SOURCES) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/["'`](previz\.(?:blockout|toolbar\.blockout)[\w.]*)["'`$]/g)) {
      // 以点结尾的是模板串的前半截（`previz.blockout.stage.${stage}`），由下面的联合兜住。
      if (!match[1]!.endsWith(".")) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

const USED_KEYS = [
  ...literalKeys(),
  ...Object.values(PREVIZ_BLOCKOUT_HINT_KEY),
  ...Object.values(PREVIZ_BLOCKOUT_REJECTION_KEY),
  ...PREVIZ_BLOCKOUT_GUIDE_KEYS,
  ...Object.keys(STAGES).map((stage) => `previz.blockout.stage.${stage}`),
  ...Object.keys(MODES).map((mode) => `previz.blockout.mode.${mode}`),
];

/** 这几条不把变量插进去就是半句话。 */
const PLACEHOLDERS: Record<string, string[]> = {
  "previz.toolbar.blockoutFull": ["count"],
  "previz.blockout.noRoom": ["limit"],
  "previz.blockout.failed": ["message"],
  "previz.blockout.done": ["count"],
  "previz.blockout.warnings": ["count"],
  "previz.blockout.rejected.primitiveLimit": ["missing", "limit"],
  "previz.blockout.rejected.cameraLimit": ["missing", "limit"],
  "previz.blockout.rejected.fetchFailed": ["message"],
};

describe("previz.blockout 文案", () => {
  it("源码里扫得到 key", () => {
    // 扫描的正则写坏了会扫出空集，下面几条就全成了空转。
    expect(literalKeys()).toContain("previz.blockout.title");
    expect(literalKeys()).toContain("previz.toolbar.blockout");
    expect(literalKeys().length).toBeGreaterThan(15);
  });

  // 任务中心按 task_type 查 `tasks.types.*`，缺了就只能显示后端的 label 或裸 type。
  it.each(LANGUAGES)("任务中心在 %s 里有白模任务的名字", (lng) => {
    const label = lookup(table(lng), "tasks.types.freezone_image_to_blockout");
    expect(typeof label).toBe("string");
    expect((label as string).trim().length).toBeGreaterThan(0);
  });

  it("三种语言的键完全一致", () => {
    const zh = flatten(lookup(table("zh"), "previz.blockout"), "previz.blockout");
    expect(zh.length).toBeGreaterThan(0);
    for (const lng of LANGUAGES) {
      expect(flatten(lookup(table(lng), "previz.blockout"), "previz.blockout")).toEqual(zh);
    }
  });

  it.each(LANGUAGES)("代码用到的每个 key 在 %s 里都有非空文案", (lng) => {
    const tree = table(lng);
    const missing = USED_KEYS.filter((key) => {
      const text = lookup(tree, key);
      return typeof text !== "string" || text.trim() === "";
    });
    expect(missing).toEqual([]);
  });

  it("词条没有多出来的：每一条都有代码在用", () => {
    const used = new Set(USED_KEYS);
    const unused = flatten(lookup(table("zh"), "previz.blockout"), "previz.blockout").filter(
      (key) => !used.has(key),
    );
    expect(unused).toEqual([]);
  });

  it.each(LANGUAGES)("带变量的句子在 %s 里把变量都插进去了", (lng) => {
    const tree = table(lng);
    for (const [key, names] of Object.entries(PLACEHOLDERS)) {
      for (const name of names) {
        expect(String(lookup(tree, key)), `${lng} ${key}`).toContain(`{{${name}}}`);
      }
    }
  });

  // 「只提示不拒绝」落在文案上：提示说的是「效果可能不好」，不是「不能用」。
  it("尺寸与比例的提示不写成拒绝", () => {
    const zh = table("zh");
    for (const key of Object.values(PREVIZ_BLOCKOUT_HINT_KEY)) {
      expect(String(lookup(zh, key))).not.toMatch(/不支持|无法|不能|禁止/);
    }
  });
});
