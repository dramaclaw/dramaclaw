// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import type { ActionInsertRejection } from '../domain/actionClips';
import { PREVIZ_MOTION_LIMITS } from '../domain/limits';
import { builtinMotionById, importedIdOf, type PrevizMotionLoadError } from '../domain/motionLibrary';
import type { PrevizImportedMotion } from '../domain/scene';

/**
 * 动作引用 → 给人看的名字。时间线片段、属性面板、动作库卡片三处都要，放一起免得
 * 「导入动作被删后显示什么」在三处各说各的。内置动作走翻译，导入动作用用户起的名字。
 */
export function motionLabel(
  t: TFunction,
  motions: readonly PrevizImportedMotion[],
  ref: string,
): string {
  const builtin = builtinMotionById(ref);
  if (builtin) return t(builtin.labelKey);
  const importedId = importedIdOf(ref);
  const imported = importedId === null ? undefined : motions.find((motion) => motion.id === importedId);
  return imported ? imported.name : t('previz.motion.unknown');
}

/**
 * 导入动作为什么用不了。时间线红斜纹的悬停提示、属性面板、导入确认前的报错共用一份：
 * 参数只有两个码要带（上限多少 MB、缺哪几根骨头），漏传的话用户看见的是 `{{bones}}`。
 */
export function motionErrorText(t: TFunction, error: PrevizMotionLoadError): string {
  const key = `previz.motion.error.${error.code}`;
  if (error.code === 'unsupported_skeleton') return t(key, { bones: error.missing.join(', ') });
  if (error.code === 'too_large') {
    // 按整 MB 报：limits 一旦改成厂商标 MB（1000 进制）之类的数，裸除法会带出一长串小数。
    return t(key, { max: Math.round(PREVIZ_MOTION_LIMITS.fileBytes / 1024 / 1024) });
  }
  return t(key);
}

/**
 * 动作库里「为什么加不了 / 换不了这条动作」。四种拒绝原因只有 `limit` 带参，集中在
 * 这里填人物动作片段上限，免得哪个调用点漏传、界面上露出 `{{max}}`。Task 13/15 的
 * 动作库对话框与导入面板都走这条。
 */
export function motionRejectText(t: TFunction, rejection: ActionInsertRejection): string {
  const key = `previz.motion.library.reject.${rejection}`;
  if (rejection === 'limit') return t(key, { max: PREVIZ_MOTION_LIMITS.clipsPerCharacter });
  return t(key);
}
