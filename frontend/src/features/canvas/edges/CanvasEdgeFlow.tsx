// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo } from 'react';
import styles from './CanvasEdgeFlow.module.css';

export const CANVAS_EDGE_STROKE = '#86909c';
export const CANVAS_EDGE_HOVER_STROKE = '#c0c8d0';
export const CANVAS_EDGE_IDLE_WIDTH = 1.5;
export const CANVAS_EDGE_ACTIVE_WIDTH = 2;

const FLOW_SEGMENTS = [
  { dash: '36 64', width: CANVAS_EDGE_ACTIVE_WIDTH * 3, opacity: 0.06, cap: 'round' },
  { dash: '36 64', width: CANVAS_EDGE_ACTIVE_WIDTH * 1.75, opacity: 0.12, cap: 'round' },
  { dash: '36 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.15, cap: 'butt' },
  { dash: '0 6 30 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.1765, cap: 'butt' },
  { dash: '0 12 24 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.2143, cap: 'butt' },
  { dash: '0 18 18 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.2727, cap: 'butt' },
  { dash: '0 24 12 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.375, cap: 'butt' },
  { dash: '0 30 6 64', width: CANVAS_EDGE_ACTIVE_WIDTH, opacity: 0.6, cap: 'butt' },
] as const;

/** Overlapping dashes give the trail a bright head without blur surfaces.
 * Both imported and native edges mount this only while highlighted.
 */
export const CanvasEdgeFlow = memo(function CanvasEdgeFlow({ id, path }: { id: string; path: string }) {
  return (
    <g data-canvas-edge-flow={id} className={styles.flow} fill="none" pointerEvents="none">
      {FLOW_SEGMENTS.map(segment => (
        <path key={`${segment.dash}-${segment.width}`} d={path} pathLength={300}
          strokeDasharray={segment.dash} strokeWidth={segment.width}
          strokeOpacity={segment.opacity} strokeLinecap={segment.cap} />
      ))}
    </g>
  );
});
