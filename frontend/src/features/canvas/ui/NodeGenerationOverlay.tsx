// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';

type NodeGenerationOverlayProps = {
  /** 生成开始时间戳,用于模拟进度。为空时从挂载时刻开始计时。 */
  startedAt?: number | null;
  /** 预估生成总时长(毫秒),用于模拟进度推进。 */
  durationMs?: number;
  /** @deprecated 仅保留兼容旧调用，加载态不再绘制背景遮罩。 */
  hasBackground?: boolean;
  /** 圆角,默认跟随节点圆角变量。 */
  rounded?: string;
  /** 进度文案的 i18n key,需接收 {{percent}} 插值。默认「生成中 X%」。 */
  messageKey?: string;
};

const DEFAULT_DURATION_MS = 60000;

/**
 * 进度上限:渐近逼近但永远到不了 100%,真正完成由外部卸载覆盖层来体现。
 */
const PROGRESS_CEILING = 0.995;
/**
 * 曲线陡峭度。真实生成常比预估时长慢一截,所以整体推进要比线性更保守:
 * 走到预估时长时约 75%,2 倍时长约 93%,3 倍约 98%,之后仍在极慢地爬。
 */
const PROGRESS_CURVE = 1.4;

/**
 * 节点生成中的统一 loading 覆盖层:
 * - 中央直接显示百分比,不再额外叠加遮罩、图标或状态文案
 */
export function NodeGenerationOverlay({
  startedAt = null,
  durationMs = DEFAULT_DURATION_MS,
  hasBackground: _hasBackground = false,
  rounded = 'rounded-[var(--node-radius)]',
  messageKey: _messageKey = 'canvas.generationProgress',
}: NodeGenerationOverlayProps) {
  const [now, setNow] = useState(() => Date.now());
  const [mountedAt] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const percent = useMemo(() => {
    const begin = typeof startedAt === 'number' ? startedAt : mountedAt;
    const duration = Math.max(1000, durationMs);
    const elapsed = Math.max(0, now - begin);
    // 指数饱和曲线:超时后不会像线性那样撞到硬顶卡死,而是继续以越来越小的
    // 步幅往上挪,视觉上始终"还在动"。
    const progress =
      PROGRESS_CEILING * (1 - Math.exp((-PROGRESS_CURVE * elapsed) / duration));
    return Math.min(99, Math.floor(progress * 100));
  }, [durationMs, mountedAt, now, startedAt]);

  return (
    <div
      className={`pointer-events-none absolute inset-0 z-10 flex items-center justify-center overflow-hidden ${rounded}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div className="relative flex flex-col items-center text-center">
        <div className="flex items-baseline leading-none text-white">
          <span className="text-[34px] font-semibold tabular-nums tracking-tight">
            {percent}
          </span>
          <span className="ml-1 text-[15px] font-medium text-white/70">%</span>
        </div>
      </div>
    </div>
  );
}
