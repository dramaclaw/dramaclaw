// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 媒体元素时长（秒）→ 整数毫秒，向下取整。
 *
 * 不能四舍五入：14.066667s 取整成 14067ms 后，Studio 的 `#t=0,14.067` 会越过
 * 文件末尾（14.066667s），整条 film 被拒绝。音频/视频元数据回写与合成探测共用。
 */
export function mediaDurationMs(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds > 0
    ? Math.floor(seconds * 1000)
    : null;
}
