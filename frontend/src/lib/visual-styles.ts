// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 内置视觉风格 preset 的 id → i18n key。
 *
 * 后端 `src/novelvideo/styles/presets/*.json` 里的 `label` 是中文单语，直接渲染会
 * 让英文界面出现「写实古装剧」。preset id 是稳定的，所以显示名一律按 id 查这里的
 * key；只有用户自建的风格（查不到 id）才回落到后端给的 name/label。
 *
 * 顺序即导入页下拉框的展示顺序，第一项是默认风格。
 */
export const BUILTIN_VISUAL_STYLES: readonly { value: string; labelKey: string }[] = [
  { value: "chinese_period_drama", labelKey: "ingest.visualStyles.chinesePeriodDrama" },
  { value: "anime", labelKey: "ingest.visualStyles.anime" },
  { value: "guoman_fantasy", labelKey: "ingest.visualStyles.guomanFantasy" },
  { value: "post_apocalyptic", labelKey: "ingest.visualStyles.postApocalyptic" },
  { value: "realistic", labelKey: "ingest.visualStyles.realistic" },
  { value: "republican_era_drama", labelKey: "ingest.visualStyles.republicanEraDrama" },
];

export const BUILTIN_STYLE_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  BUILTIN_VISUAL_STYLES.map((style) => [style.value, style.labelKey]),
);

export const DEFAULT_VISUAL_STYLE = BUILTIN_VISUAL_STYLES[0].value;
