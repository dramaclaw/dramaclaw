// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// `@图N` 是写进提示词、模型认的引用 token，跟界面语言无关。
// i18n-exempt-start
const STORYBOARD_AT_TAG_REGEX = /@\s*图\d+/g;
const STORYBOARD_AT_PREFIX_REGEX = /@(?=\s*图\d+)/g;
// i18n-exempt-end

export function sanitizeStoryboardText(input: string, ignoreAtTag: boolean): string {
  if (!ignoreAtTag) {
    return input.trim();
  }

  return input
    .replace(STORYBOARD_AT_TAG_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function sanitizeStoryboardPromptText(input: string): string {
  return input
    .replace(STORYBOARD_AT_PREFIX_REGEX, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
