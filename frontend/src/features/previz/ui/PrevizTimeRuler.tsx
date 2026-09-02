// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { rulerTicks } from '../domain/timeline';

/**
 * 时间轴顶上的刻度尺。只画刻度不管交互：拖播放头是外层那层透明覆盖层的事，
 * 尺子被压在下面，两边各管一件事比在同一个元素上又画又拖好调试。
 */
export function PrevizTimeRuler({
  seconds,
  pxPerSecond,
}: {
  /** 尺子要覆盖的秒数，通常比内容长——参照实现的尺子一直铺到面板右边。 */
  seconds: number;
  pxPerSecond: number;
}) {
  return (
    <div
      data-testid="previz-ruler"
      className="relative h-6 shrink-0 border-b border-[#232833]"
      style={{ width: seconds * pxPerSecond }}
    >
      {rulerTicks(seconds, pxPerSecond).map((tick) => (
        <div
          key={tick.seconds}
          className={`absolute bottom-0 w-px ${
            tick.major ? 'h-2 bg-[#4a5262]' : 'h-1 bg-[#333b48]'
          }`}
          style={{ left: tick.seconds * pxPerSecond }}
        >
          {tick.label !== null && (
            // 标签挂在刻度线右边一点，压着线读不清；最后一根挪不动，让它出界。
            <span className="absolute -top-[2px] left-1 whitespace-nowrap text-[10px] leading-none text-[#6d7585]">
              {tick.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
