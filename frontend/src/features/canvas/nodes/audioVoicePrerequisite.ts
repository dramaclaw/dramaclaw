// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Subscriber classifier used at AudioNode.tsx:129. Matches message text only, for any
 * Error class (including task failures), or String(error) for other thrown values.
 * The regex is unanchored and case-sensitive; `.*` does not cross line terminators.
 * No status, code, translated display or diagnostics participate.
 */
export function isVoicePrerequisiteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:声线未配置|缺少.*声线|请先配置或选择声线|上传或录制.*音频)/u.test(message); // i18n-exempt -- backend errors
}
