// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import type { TFunction } from "i18next";

/**
 * 单测用的 t：按中文词条真解一次。
 *
 * 文案搬进 i18n 之后，纯函数（大纲、参考拾取…）都改成收一个 t。单测如果传个回显
 * key 的假 t，断言就只能钉 key，读起来看不出用户看见的是什么，key 打错了也照样绿。
 * 这里直接读 zh 的 translation.json，断言仍然对着中文文案写，顺带把「key 存在」也
 * 一起钉住了。
 */
function loadLocale(lng: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`public/locales/${lng}/translation.json`, "utf8")) as Record<
    string,
    unknown
  >;
}

export const zhTranslation = loadLocale("zh");
export const enTranslation = loadLocale("en");

function lookup(key: string): string | undefined {
  let cursor: unknown = zhTranslation;
  for (const part of key.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

export const zhT = ((key: string, options?: Record<string, unknown>) => {
  const template = lookup(key);
  if (template === undefined) {
    // 动态拼出来的 key（比如 `sourceKinds.${kind}`）本来就允许落空，跟 i18next 一样
    // 退回 defaultValue；真正没写词条又没兜底的，才是要当场喊出来的漏翻。
    if (options && typeof options.defaultValue === "string") return options.defaultValue;
    throw new Error(`zh translation.json 里没有这个 key：${key}`);
  }
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    options && name in options ? String(options[name]) : whole,
  );
}) as unknown as TFunction;
