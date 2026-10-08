// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import type { PrevizBlockoutHoldReason } from '../domain/blockout';
import type { PrevizBlockoutImageHint } from '../domain/blockoutImage';

/**
 * 写成 Record 而不是拼字符串：新增一种提示时这里编译期报错，locale 的对齐用例
 * 也从这张表取键，不会出现「代码里有、文案里没有」。
 */
export const PREVIZ_BLOCKOUT_HINT_KEY: Record<PrevizBlockoutImageHint, string> = {
  small: 'previz.blockout.hint.small',
  wide: 'previz.blockout.hint.wide',
  tall: 'previz.blockout.hint.tall',
  unreadable: 'previz.blockout.hint.unreadable',
};

export const PREVIZ_BLOCKOUT_REJECTION_KEY: Record<PrevizBlockoutHoldReason['reason'], string> = {
  empty: 'previz.blockout.rejected.empty',
  'primitive-limit': 'previz.blockout.rejected.primitiveLimit',
  'camera-limit': 'previz.blockout.rejected.cameraLimit',
  'too-large': 'previz.blockout.rejected.tooLarge',
  'fetch-failed': 'previz.blockout.rejected.fetchFailed',
  'version-too-new': 'previz.blockout.rejected.versionTooNew',
};

/** 对话框开着时一直摆在那儿的选图建议。只是建议：不符合的图照样能生成。 */
export const PREVIZ_BLOCKOUT_GUIDE_KEYS = [
  'previz.blockout.guide.space',
  'previz.blockout.guide.floor',
  'previz.blockout.guide.framing',
  'previz.blockout.guide.occlusion',
] as const;

/** toast 和对话框说的是同一句话。 */
export function blockoutRejectionMessage(rejection: PrevizBlockoutHoldReason, t: TFunction): string {
  const key = PREVIZ_BLOCKOUT_REJECTION_KEY[rejection.reason];
  if (rejection.reason === 'primitive-limit' || rejection.reason === 'camera-limit') {
    return t(key, { missing: rejection.missing, limit: rejection.limit });
  }
  if (rejection.reason === 'fetch-failed') {
    return t(key, { message: rejection.message });
  }
  return t(key);
}
