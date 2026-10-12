// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';

/** 容器像素坐标系里的「视频画面实际占据的矩形」（object-contain 去掉黑边后）。 */
export interface DisplayedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 归一化（0..1，相对源画面）的框选区域。 */
export interface SubtitleEraseBoxValue {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 拖拽中的瞬时两点（归一化坐标）。 */
export interface SubtitleEraseDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Compute the displayed video frame rect inside its container (object-contain).
 * Returns container-pixel coords. We use this to (a) size the box overlay so
 * it sits on top of the actual video pixels (not the letterbox bars) and (b)
 * convert pointer coords ↔ normalized 0..1 source coords.
 *
 * 从 VideoNode 的私有 getDisplayedVideoRect 原样搬出（工作流节点播放器与故事板
 * 详情播放器共用同一套换算）。视频固有宽高未知时退化为整个容器。
 */
export function computeDisplayedVideoRect(
  containerW: number,
  containerH: number,
  videoW: number | null | undefined,
  videoH: number | null | undefined,
): DisplayedRect {
  const vw = videoW ?? 0;
  const vh = videoH ?? 0;
  if (!vw || !vh || containerW <= 0 || containerH <= 0) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }
  const containerRatio = containerW / containerH;
  const videoRatio = vw / vh;
  if (videoRatio > containerRatio) {
    const w = containerW;
    const h = containerW / videoRatio;
    return { left: 0, top: (containerH - h) / 2, width: w, height: h };
  }
  const h = containerH;
  const w = containerH * videoRatio;
  return { left: (containerW - w) / 2, top: 0, width: w, height: h };
}

export interface SubtitleEraseBoxOverlayProps {
  box: SubtitleEraseBoxValue | null;
  drag: SubtitleEraseDrag | null;
  disabled: boolean;
  getDisplayedRect: (containerW: number, containerH: number) => DisplayedRect;
  onDragStart: (start: SubtitleEraseDrag) => void;
  onDragMove: (next: { x1: number; y1: number }) => void;
  onDragEnd: (final: SubtitleEraseBoxValue | null) => void;
}

/**
 * 框选去字幕的拖拽层：绝对定位铺满播放器容器，把指针坐标换算成归一化的
 * 0..1 源画面坐标（先减掉 object-contain 的黑边偏移），并把当前框画出来。
 *
 * 从 VideoNode 的私有组件原样搬出，供工作流节点与故事板详情两处复用。
 */
export function SubtitleEraseBoxOverlay({
  box,
  drag,
  disabled,
  getDisplayedRect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: SubtitleEraseBoxOverlayProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const displayed = getDisplayedRect(containerSize.w, containerSize.h);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { nx: 0, ny: 0 };
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left - displayed.left;
      const localY = clientY - rect.top - displayed.top;
      const nx = displayed.width > 0 ? localX / displayed.width : 0;
      const ny = displayed.height > 0 ? localY / displayed.height : 0;
      return {
        nx: Math.max(0, Math.min(1, nx)),
        ny: Math.max(0, Math.min(1, ny)),
      };
    },
    [displayed.height, displayed.left, displayed.top, displayed.width],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragStart({ x0: nx, y0: ny, x1: nx, y1: ny });
    },
    [disabled, onDragStart, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragMove({ x1: nx, y1: ny });
    },
    [disabled, drag, onDragMove, toNormalized],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer may not have been captured
      }
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const width = Math.abs(drag.x1 - drag.x0);
      const height = Math.abs(drag.y1 - drag.y0);
      if (width < 0.01 || height < 0.01) {
        onDragEnd(null);
        return;
      }
      onDragEnd({ x, y, width, height });
    },
    [disabled, drag, onDragEnd],
  );

  const effective = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : box;

  return (
    <div
      ref={containerRef}
      className="nodrag absolute inset-0 z-30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(event) => event.stopPropagation()}
      style={{ cursor: disabled ? 'not-allowed' : 'crosshair' }}
    >
      {effective && effective.width > 0 && effective.height > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.15)]"
          style={{
            left: displayed.left + effective.x * displayed.width,
            top: displayed.top + effective.y * displayed.height,
            width: effective.width * displayed.width,
            height: effective.height * displayed.height,
          }}
        />
      )}
    </div>
  );
}
