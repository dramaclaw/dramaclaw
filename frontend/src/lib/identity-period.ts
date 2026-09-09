// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * 身份名（identity_planner 生成的 visual_state）是自由文本，不是枚举，所以走不了
 * age-group.ts 那种「后端归一成 code」的路子。但提示词把命名口径钉死在人生阶段/
 * 常见造型分支上（见 agents/identity_planner.py 的 `命名优先使用人生阶段…`），
 * 实际生成出来的绝大多数就是下面这批固定说法，把它们按词条渲染，英文界面就不会再
 * 整块漏中文；认不出的（"大厂时期"、剧本自造的造型名）原样回显。
 *
 * 词条的中文值与这里的 key 逐字相同，所以中文界面渲染结果与生成数据完全一致——
 * 这层只影响显示，落库的值一个字都不动（重命名框、@提及 token、identity_id 都还是原值）。
 */
// i18n-exempt-start
const PERIOD_LABEL_KEYS: Record<string, string> = {
  幼年时期: "characters.identityPeriods.earlyChildhood",
  孩童时期: "characters.identityPeriods.childhoodKid",
  儿童时期: "characters.identityPeriods.childhoodChild",
  童年时期: "characters.identityPeriods.childhoodYears",
  少年时期: "characters.identityPeriods.adolescence",
  学生时期: "characters.identityPeriods.schoolYears",
  青年时期: "characters.identityPeriods.youngAdult",
  成年时期: "characters.identityPeriods.adulthood",
  中年时期: "characters.identityPeriods.middleAge",
  老年时期: "characters.identityPeriods.laterYears",
  职场装束: "characters.identityPeriods.workAttire",
  居家装束: "characters.identityPeriods.homeAttire",
  便装: "characters.identityPeriods.casualWear",
  正装: "characters.identityPeriods.formalWear",
  宫装: "characters.identityPeriods.courtDress",
};
// i18n-exempt-end

/** 认得的时期名返回本地化标签，认不得就原样回显。 */
export function identityPeriodLabel(
  value: string | null | undefined,
  t: TFn,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = PERIOD_LABEL_KEYS[raw];
  return key ? t(key) : raw;
}

/**
 * identity_id 形如 `沈晚_青年时期`：角色名来自原著、没得翻，只把下划线后的时期名
 * 本地化。按**最后一个**下划线切，角色名里带下划线也不会切错。
 */
export function identityRefLabel(
  value: string | null | undefined,
  t: TFn,
): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const at = raw.lastIndexOf("_");
  if (at <= 0 || at === raw.length - 1) return identityPeriodLabel(raw, t);
  const head = raw.slice(0, at);
  const tail = raw.slice(at + 1);
  const localized = identityPeriodLabel(tail, t);
  return localized === tail ? raw : `${head}_${localized}`;
}
