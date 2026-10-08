// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useMemo, useState } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { isCanvasGestureActive } from '../application/canvasLod';
import { useCanvasToolStore } from '../ui/canvasToolStore';
import { CanvasEdgeFlow, CANVAS_EDGE_STROKE, CANVAS_EDGE_HOVER_STROKE,
  CANVAS_EDGE_IDLE_WIDTH, CANVAS_EDGE_ACTIVE_WIDTH } from './CanvasEdgeFlow';
import styles from './CanvasEdgeFlow.module.css';

/** Imported edges explicitly use `default`, bypassing defaultEdgeOptions.
 * Keep RF's original Bezier and hit area; mount the unfiltered flow only on
 * an active edge, so idle/panning graphs do not animate hundreds of paths.
 */
export const DefaultCanvasEdge = memo(function DefaultCanvasEdge({
  id, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  pathOptions, style, selected, markerStart, markerEnd, interactionWidth,
  label, labelStyle, labelShowBg, labelBgStyle, labelBgPadding, labelBgBorderRadius,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const handTool = useCanvasToolStore(state => state.tool === 'hand');
  useEffect(() => { if (handTool) setHovered(false); }, [handTool]);
  const active = !handTool && (hovered || selected);
  const curvature = pathOptions?.curvature;
  const [path, labelX, labelY] = useMemo(() => getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature,
  }), [sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature]);

  return (
    <g
      data-canvas-default-edge={id}
      onPointerEnter={() => {
        if (!handTool && !isCanvasGestureActive()) setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <BaseEdge
        id={id} path={path} labelX={labelX} labelY={labelY}
        markerStart={markerStart} markerEnd={markerEnd} interactionWidth={interactionWidth}
        label={label} labelStyle={labelStyle} labelShowBg={labelShowBg}
        labelBgStyle={labelBgStyle} labelBgPadding={labelBgPadding}
        labelBgBorderRadius={labelBgBorderRadius}
        className={styles.line}
        style={{ ...style, stroke: active ? CANVAS_EDGE_HOVER_STROKE : CANVAS_EDGE_STROKE,
          strokeWidth: active ? CANVAS_EDGE_ACTIVE_WIDTH : CANVAS_EDGE_IDLE_WIDTH,
          opacity: 1, strokeOpacity: 1 }}
      />
      {active && <CanvasEdgeFlow id={id} path={path} />}
    </g>
  );
});
