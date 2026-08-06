// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, type RefObject } from 'react';
import type { ReactFlowInstance, Viewport } from '@xyflow/react';

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
 * 这里的三点改动：
 * 1. 增益只按**可见**节点的**绝对**包围盒算，不含视口框 —— 增益在一次手势内恒定，
 *    不再发散，且与内置 MiniMap 实际渲染的范围对齐（它同样只画可见节点）。
 * 2. 视口用 rAF 缓动跟随目标，而不是每帧硬跳，抹掉指针采样抖动和起停的突变。
 * 3. 缓动的开始/收敛/结束都通知外层：外层据此在缓动期间跳过逐帧的视口提交，
 *    并且等真正收敛后才收起小地图（否则清理函数会把缓动掐断在半路）。
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
  /**
   * 拖动开始。调用方必须借此把小地图钉住不卸载 —— 小地图默认靠 hover 显示，
   * 指针一划出去 onMouseLeave 就会在 180ms 后卸载 MiniMap，
   * 连带本 hook 的清理函数摘掉 window 监听、拖动会突然断掉。
   */
  onPanStart?: () => void;
  /**
   * 拖动**彻底**结束：指针已松开**且**缓动已收敛（或 hook 在拖动中被卸载）。
   * 调用方据此解除小地图的挂载保护 —— 必须等收敛，不能用固定延时：收敛耗时
   * 取决于松手瞬间的剩余距离（剩 100px 约 260ms、剩 1000px 约 360ms），
   * 都超过自动隐藏的 180ms，小地图会在缓动到位前卸载、rAF 被清理函数取消。
   *
   * `pointerInsideMinimap` 表示松手时指针是否还落在小地图内：拖动期间 hover 态
   * 多半已经被置 false，调用方据此决定是继续显示还是收起。
   */
  onPanEnd?: (pointerInsideMinimap: boolean) => void;
  /**
   * 缓动收敛到目标（此刻指针可能还按着不动）。调用方据此把最终视口提交一次。
   *
   * 之所以要这个回调：`instance.setViewport` 每次都会走一遍完整的
   * `onMoveStart → onMove → onMoveEnd`（d3 zoom transform，没有 internal 标记），
   * 而 React Flow 只对 `panOnScroll` 才合并结束事件（`panOnScroll ? 150 : 0`）。
   * 用户关掉「触控板平移」后合并不存在，缓动的每一帧都会提交一次视口 ——
   * 正是本 hook 想消掉的 store 风暴。调用方应在缓动期间跳过 `onMoveEnd` 的提交，
   * 改由这里收敛时提交一次。
   */
  onViewportSettled?: (viewport: Viewport) => void;
}

export function useSmoothMinimapPan({
  enabled,
  wrapperRef,
  instance,
  onPanStart,
  onPanEnd,
  onViewportSettled,
}: SmoothMinimapPanOptions): void {
  // 回调走 ref：它们的身份变化不该重挂监听（重挂会在拖动中途摘掉 window 监听）。
  const onPanStartRef = useRef(onPanStart);
  const onPanEndRef = useRef(onPanEnd);
  const onViewportSettledRef = useRef(onViewportSettled);
  onPanStartRef.current = onPanStart;
  onPanEndRef.current = onPanEnd;
  onViewportSettledRef.current = onViewportSettled;

  useEffect(() => {
    if (!enabled) return;
    const minimap = wrapperRef.current?.querySelector<HTMLElement>(
      '.react-flow__minimap',
    );
    const svg = minimap?.querySelector<SVGSVGElement>('svg');
    if (!minimap || !svg) return;
    // 收窄后另起一个非空 const：下面的 endPan 是函数声明，闭包里拿不到窄化结果。
    const minimapEl: HTMLElement = minimap;

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
    /**
     * 指针已松开、只等缓动收尾时记下松手点是否在小地图内；收敛后才把结束通知
     * 发出去（见 onPanEnd 的注释）。null 表示当前没有待发的结束通知。
     */
    let pendingPanEndInside: boolean | null = null;

    function flushPanEnd() {
      if (pendingPanEndInside === null) return;
      const inside = pendingPanEndInside;
      pendingPanEndInside = null;
      onPanEndRef.current?.(inside);
    }

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

      // 已经落在目标上就别再写一遍：按住不动时每帧 setViewport 会白白触发
      // React Flow 的 move 生命周期和画布 viewport store 提交。
      if (viewport.x !== nextX || viewport.y !== nextY) {
        instance.setViewport({ x: nextX, y: nextY, zoom: viewport.zoom });
      }

      // 收敛就停，不管指针是否还按着。下一次 pointermove 会重新 startLoop()，
      // 跟手不受影响；按住不动时则彻底静默。
      if (settled) {
        stopLoop();
        // 最终视口在这里提交一次 —— 缓动期间外层会跳过 onMoveEnd 的逐帧提交。
        onViewportSettledRef.current?.({ x: nextX, y: nextY, zoom: viewport.zoom });
        // 松手后到位才算拖动真正结束，这时才允许外层收起小地图。
        flushPanEnd();
        return;
      }
      rafId = requestAnimationFrame(step);
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || activePointerId !== null) return;

      const viewport = instance.getViewport();
      // 必须走 instance 上的 getNodesBounds（它带 nodeLookup），不能用同名的静态
      // 工具：静态版对普通 node 直接取 `node.position`，而分组成员的 position 是
      // **相对父节点**的。分镜组把成员改成 `parentId + hidden: true`、position 是
      // 组内单元格坐标（近原点），组本身却可能在 x=10000 —— 静态版会把包围盒从
      // 原点一路撑到组的位置，增益随之远大于小地图的视觉映射。
      // 同时要过滤 hidden：内置 MiniMap 的包围盒是 getInternalNodesBounds(…, {
      // filter: filterHidden })，只算可见节点，我们得跟它对齐才跟手。
      const visibleNodes = instance.getNodes().filter((node) => !node.hidden);
      const bounds = instance.getNodesBounds(visibleNodes);
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

      // 上一次手势的缓动可能还没收尾就又按了下来：把待发的结束通知丢掉，
      // 否则这一次收敛时会把它冲出去，拖动中途就被外层收起。
      pendingPanEndInside = null;

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

      // 通知外层把小地图钉住：默认非固定模式下指针一划出小地图，
      // onMouseLeave 会在 180ms 后卸载 MiniMap，本 effect 的清理函数
      // 会连带摘掉上面这三个 window 监听，拖动就断在半路了。
      onPanStartRef.current?.();

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

      const rect = minimapEl.getBoundingClientRect();
      pendingPanEndInside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;

      // 松手后让缓动自己收尾，别硬切；结束通知压到收敛之后再发（见 onPanEnd
      // 的注释：收敛耗时随剩余距离变化，固定延时会把缓动掐断）。
      // 若此刻已经在目标上，startLoop 排的这一帧会立刻判定 settled 并把它冲出去。
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
      // 兜底：真被卸载时（enabled 变 false / 换 instance）必须把「拖动中」还回去，
      // 否则外层会永远认为还在拖，小地图再也收不起来。缓动没收尾就被卸载的情况
      // （pendingPanEndInside 还挂着）同理，一并冲出去。
      if (activePointerId !== null) {
        activePointerId = null;
        pendingPanEndInside = false;
      }
      flushPanEnd();
    };
  }, [enabled, wrapperRef, instance]);
}
