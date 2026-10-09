// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEstimatedProgress } from './useEstimatedProgress';

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
  // 估算算法抽到 useEstimatedProgress，与故事板卡片/详情共用。
  const percent = useEstimatedProgress(startedAt, durationMs);

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
