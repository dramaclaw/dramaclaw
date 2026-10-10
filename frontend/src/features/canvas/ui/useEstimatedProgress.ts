// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';

/**
 * 生成进度的时间估算（不是后端真实进度，后端目前不下发逐步进度事件）：按
 * `startedAt` + 预估 `durationMs` 做指数饱和估算，渐近 99%（真正的「完成」
 * 由调用方 `isGenerating` 变 false 触发）。120ms 轮询刷新一次。
 *
 * 从 {@link ./NodeGenerationOverlay.tsx} 的内部算法原样抽出（工作流节点覆盖层
 * 的大数字），故事板卡片/详情占位复用同一套估算，避免两处实现漂移。
 *
 * @param startedAt 生成开始时间戳（epoch ms）；为空则退化为 hook 挂载时刻——
 *   与原 NodeGenerationOverlay 的 `mountedAt` 兜底同语义。
 * @param durationMs 预估生成总时长（毫秒），最短钳到 1000ms。
 * @param paused 暂停轮询（故事板被保活隐藏时传 true）。故事板隐藏后数据源整体
 *   冻结，卡片会一直停在「生成中」那一帧——不停表的话这颗 120ms 定时器在用户切回
 *   工作流干活期间永远不会停，白白每秒重渲染隐藏视图 8 次。
 */
export function useEstimatedProgress(
  startedAt: number | null,
  durationMs: number,
  paused = false,
): number {
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => {
      window.clearInterval(timer);
    };
  }, [paused]);

  return useMemo(() => {
    const begin = typeof startedAt === 'number' ? startedAt : mountedAt;
    const duration = Math.max(1000, durationMs);
    const elapsed = Math.max(0, now - begin);
    const progress = 0.995 * (1 - Math.exp((-1.4 * elapsed) / duration));
    return Math.min(99, Math.floor(progress * 100));
  }, [durationMs, mountedAt, now, startedAt]);
}
