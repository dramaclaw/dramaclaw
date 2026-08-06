// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, type RefObject } from 'react';
import { getNodesBounds, type ReactFlowInstance } from '@xyflow/react';

/**
 * 接管小地图的拖动平移，替掉 React Flow 内置的 `pannable`。
 *
 * 换掉的理由是内置实现有个正反馈缺陷。React Flow 算小地图范围时用的是
 * 「节点包围盒 ∪ 当前视口框」（@xyflow/react MiniMap 的 selector），而拖动增益
 * moveScale 正比于这个并集的尺寸。于是视口一旦被拖出内容区，并集就开始变大，
 * 增益跟着变大，下一帧拖得更远，并集又更大 —— 复利发散，没有上限。
 *
 * 实测（335 节点、包围盒宽 35638、zoom 0.1）：固定每次 +20px 输入连续拖 8 次，
 * 前 3 次增益稳定在 17.8 px/px，从第 4 次拖出内容边缘开始变成
 * 18.6 → 20.5 → 22.7 → 25.1 → 27.7，每次约 +10%；继续拖能把视口甩到 1e8 量级，
 * 而且这个坏视口会被持久化，刷新后依旧。手上动作没变画布却越拖越快，
 * 这就是「小地图拖起来不跟手」的真正来源，跟帧率无关。
 *
 * 这里的两点改动：
 * 1. 增益只按节点包围盒算，不含视口框 —— 增益在一次手势内恒定，不再发散。
 * 2. 视口用 rAF 缓动跟随目标，而不是每帧硬跳，抹掉指针采样抖动和起停的突变。
 */

/** 与 xyflow MiniMap 的 offsetScale 默认值一致，用于反推它渲染用的 viewBox。 */
const MINIMAP_FALLBACK_WIDTH = 200;
const MINIMAP_FALLBACK_HEIGHT = 150;

/**
 * 每帧向目标靠拢的比例，按 60fps 标定。0.3 意味着约 8 帧（130ms）走完 95%，
 * 手感上跟手但不会把指针抖动原样放大 17 倍甩到画布上。
 */
const FOLLOW_PER_FRAME = 0.3;
const REFERENCE_FRAME_MS = 1000 / 60;
/** 收尾阈值：差这么点就直接吸附，避免指数逼近永远跑 rAF。 */
const SETTLE_EPSILON_PX = 0.4;
/** 单帧最大补偿时长，防止切标签页回来后一帧跳完。 */
const MAX_FRAME_MS = 64;

interface SmoothMinimapPanOptions {
  /** 小地图当前是否挂载。false 时整个 effect 不接线。 */
  enabled: boolean;
  /** 画布容器，用来找到小地图的 svg。 */
  wrapperRef: RefObject<HTMLDivElement | null>;
  instance: ReactFlowInstance;
}

export function useSmoothMinimapPan({
  enabled,
  wrapperRef,
  instance,
}: SmoothMinimapPanOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const svg = wrapperRef.current?.querySelector<SVGSVGElement>(
      '.react-flow__minimap svg',
    );
    if (!svg) return;

    let activePointerId: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startViewportX = 0;
    let startViewportY = 0;
    /** 一次手势内固定，见文件头注释。 */
    let moveScale = 1;
    let targetX = 0;
    let targetY = 0;
    let rafId = 0;
    let lastFrameTime = 0;

    const stopLoop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastFrameTime = 0;
    };

    const startLoop = () => {
      if (rafId) return;
      lastFrameTime = 0;
      rafId = requestAnimationFrame(step);
    };

    function step(now: number) {
      const viewport = instance.getViewport();
      const deltaMs = lastFrameTime
        ? Math.min(MAX_FRAME_MS, now - lastFrameTime)
        : REFERENCE_FRAME_MS;
      lastFrameTime = now;

      // 按实际帧长补偿的指数逼近：掉帧时不会跟得更慢。
      const t = 1 - Math.pow(1 - FOLLOW_PER_FRAME, deltaMs / REFERENCE_FRAME_MS);
      let nextX = viewport.x + (targetX - viewport.x) * t;
      let nextY = viewport.y + (targetY - viewport.y) * t;

      const settled =
        Math.abs(targetX - nextX) < SETTLE_EPSILON_PX &&
        Math.abs(targetY - nextY) < SETTLE_EPSILON_PX;
      if (settled) {
        nextX = targetX;
        nextY = targetY;
      }

      instance.setViewport({ x: nextX, y: nextY, zoom: viewport.zoom });

      // 手指还按着就继续空转，等下一次 move；松手且已收敛才停。
      if (settled && activePointerId === null) {
        stopLoop();
        return;
      }
      rafId = requestAnimationFrame(step);
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || activePointerId !== null) return;

      const viewport = instance.getViewport();
      const bounds = getNodesBounds(instance.getNodes());
      const rect = svg.getBoundingClientRect();
      const elementWidth = rect.width || MINIMAP_FALLBACK_WIDTH;
      const elementHeight = rect.height || MINIMAP_FALLBACK_HEIGHT;

      // 复刻 xyflow 的 viewScale，唯一差别是不并上视口框（见文件头）。
      // 空画布时退化成 1，避免除零后增益变成 0 拖不动。
      const viewScale =
        bounds.width > 0 && bounds.height > 0
          ? Math.max(bounds.width / elementWidth, bounds.height / elementHeight)
          : 1;
      // xyflow 原式是 viewScale * Math.max(zoom, Math.log(zoom))，而 ln(z) < z
      // 对所有 z > 0 恒成立，那个 Math.max 永远取 zoom，这里直接写成 zoom。
      moveScale = viewScale * viewport.zoom;

      activePointerId = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startViewportX = viewport.x;
      startViewportY = viewport.y;
      targetX = viewport.x;
      targetY = viewport.y;

      // 监听挂在 window 上而不是 svg 上：拖动中指针经常会划出小地图，
      // 挂在 svg 上会中途丢事件（内置实现用的 d3-drag 同样是 window 级）。
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', endPan);
      window.addEventListener('pointercancel', endPan);

      event.preventDefault();
      event.stopPropagation();
    };

    function handlePointerMove(event: PointerEvent) {
      if (activePointerId !== event.pointerId) return;
      targetX = startViewportX - (event.clientX - startClientX) * moveScale;
      targetY = startViewportY - (event.clientY - startClientY) * moveScale;
      startLoop();
      event.preventDefault();
    }

    function endPan(event: PointerEvent) {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
      detachWindowListeners();
      // 松手后让缓动自己收尾，别硬切。
      startLoop();
    }

    function detachWindowListeners() {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', endPan);
      window.removeEventListener('pointercancel', endPan);
    }

    svg.addEventListener('pointerdown', handlePointerDown);

    return () => {
      svg.removeEventListener('pointerdown', handlePointerDown);
      detachWindowListeners();
      stopLoop();
    };
  }, [enabled, wrapperRef, instance]);
}
