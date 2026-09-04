// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useViewport } from '@xyflow/react';

import { useSnapAlignStore } from './snapAlignStore';

const GUIDE_COLOR = '#5ba0ff';
const GUIDE_OPACITY = 0.52;

/** 局部智能引导线：只连接参与吸附的两个节点，不叠加数值标签。 */
export function SnapAlignGuides() {
  const guides = useSnapAlignStore((state) => state.guides);
  const { x: viewportX, y: viewportY, zoom } = useViewport();

  if (guides.vertical.length === 0 && guides.horizontal.length === 0) return null;

  return (
    <svg className="pointer-events-none absolute inset-0 z-[120] h-full w-full overflow-visible">
      {guides.vertical.map((guide) => {
        const x = viewportX + guide.coordinate * zoom;
        const y1 = viewportY + guide.start * zoom;
        const y2 = viewportY + guide.end * zoom;
        return (
          <g key={`v-${guide.targetNodeId}-${guide.coordinate}-${guide.relation}`}>
            <line
              x1={x}
              x2={x}
              y1={y1}
              y2={y2}
              stroke={GUIDE_COLOR}
              strokeOpacity={GUIDE_OPACITY}
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
      {guides.horizontal.map((guide) => {
        const y = viewportY + guide.coordinate * zoom;
        const x1 = viewportX + guide.start * zoom;
        const x2 = viewportX + guide.end * zoom;
        return (
          <g key={`h-${guide.targetNodeId}-${guide.coordinate}-${guide.relation}`}>
            <line
              x1={x1}
              x2={x2}
              y1={y}
              y2={y}
              stroke={GUIDE_COLOR}
              strokeOpacity={GUIDE_OPACITY}
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
    </svg>
  );
}
