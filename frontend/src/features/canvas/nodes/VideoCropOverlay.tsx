// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切的裁剪框：叠在视频真实画面上（object-contain 的黑边不算），框外压暗、框内
// 三分网格，四角 + 四边中点 8 个手柄；锁定比例时只留四角。受控组件——框状态在
// VideoNode，这里只把指针位移换算成源像素交给 cropMath。
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  CROP_ALL_HANDLES,
  CROP_CORNER_HANDLES,
  containRect,
  dragCropHandle,
  moveCropBox,
  toEvenSourceRect,
  type CropBox,
  type CropHandle,
} from "@/features/canvas/application/videoCrop/cropMath";
import { consumeVideoCropFocus } from "@/features/canvas/application/videoCrop/videoCropInFlight";

interface VideoCropOverlayProps {
  /** 挂号一次性抢焦点用，见 consumeVideoCropFocus。 */
  nodeId: string;
  box: CropBox;
  /** 宽/高；null = 自由比例。 */
  ratio: number | null;
  sourceWidth: number;
  sourceHeight: number;
  disabled: boolean;
  onChange: (box: CropBox) => void;
  /** Esc 退出裁剪模式；不传就不响应 Esc（保持向后兼容）。 */
  onEscape?: () => void;
}

/** 方向键单步 1 源像素，Shift 加速到 10。 */
const KEY_STEP = 1;
const KEY_STEP_FAST = 10;

const HANDLE_LAYOUT: Record<CropHandle, { left: string; top: string; cursor: string }> = {
  nw: { left: "0%", top: "0%", cursor: "nwse-resize" },
  n: { left: "50%", top: "0%", cursor: "ns-resize" },
  ne: { left: "100%", top: "0%", cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: "0%", top: "100%", cursor: "nesw-resize" },
  w: { left: "0%", top: "50%", cursor: "ew-resize" },
};

interface DragState {
  kind: "move" | CropHandle;
  pointerId: number;
  startBox: CropBox;
  clientX: number;
  clientY: number;
  /** 屏幕像素 / 源像素。按下时定格，拖动途中画布缩放不影响这一次拖拽。 */
  clientPxPerSourcePx: number;
}

export function VideoCropOverlay({
  nodeId,
  box,
  ratio,
  sourceWidth,
  sourceHeight,
  disabled,
  onChange,
  onEscape,
}: VideoCropOverlayProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // 只在工具栏「进入裁剪模式」那一次点击挂了号（见 videoCropInFlight.ts 的
    // requestVideoCropFocus）才抢一次焦点，不是「每次挂载都抢」：
    // 1. Radix 下拉菜单关闭时会把焦点收回触发它的按钮，跟这里抢一次抢不赢，得靠
    //    NodeActionToolbar 那边的 onCloseAutoFocus 让路 + 这里真正抢到。
    // 2. 节点被 onlyRenderVisibleElements 卸载重挂时这个浮层会重新挂载；如果每次
    //    挂载都抢焦点，用户正在别的输入框打字，光标会被这次重挂无声地薅走。
    // consumeVideoCropFocus 是一次性的，就算这个 effect 因为 containerSize 变化
    // 重跑好几遍，也只有挂着号的那一次会真正拿到 true。
    if (disabled || !boxRef.current) return;
    if (!consumeVideoCropFocus(nodeId)) return;
    const el = boxRef.current;
    // 框要等 ResizeObserver 第一次回调（容器有宽高了）才会渲染出来；rAF 让浏览器
    // 先把这一帧布局落定，避免抢到一个还没真正出现在页面上的元素。
    const raf = requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [disabled, nodeId, containerSize.w, containerSize.h]);

  useEffect(() => {
    // 源尺寸变了（比如切换到另一段视频）：父组件会重新给一个框，旧的拖拽起点作废。
    dragRef.current = null;
  }, [sourceWidth, sourceHeight]);

  const displayed = containRect(containerSize.w, containerSize.h, sourceWidth, sourceHeight);
  const pixel = toEvenSourceRect(box, sourceWidth, sourceHeight);
  const boxLeft = (box.x / sourceWidth) * displayed.width;
  const boxTop = (box.y / sourceHeight) * displayed.height;
  const boxWidth = (box.width / sourceWidth) * displayed.width;
  const boxHeight = (box.height / sourceHeight) * displayed.height;

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, kind: DragState["kind"]) => {
    event.preventDefault();
    event.stopPropagation();
    // 仍然吞掉事件不让 react-flow 处理，但只有主按钮（左键/触摸/触控笔）才真正开始拖拽。
    if (event.button !== 0) return;
    if (disabled) return;
    // preventDefault 顺带吃掉了默认的点击抢焦点，手动补上，不然拖完键盘挪不动框。
    boxRef.current?.focus({ preventScroll: true });
    const container = containerRef.current;
    if (!container || displayed.width <= 0) return;
    // 画布缩放时节点带 CSS transform：clientX 是屏幕像素，contentRect 是布局像素。
    const zoom = containerSize.w > 0 ? container.getBoundingClientRect().width / containerSize.w : 1;
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startBox: box,
      clientX: event.clientX,
      clientY: event.clientY,
      clientPxPerSourcePx: (displayed.width / sourceWidth) * zoom,
    };
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / 已释放的 pointer 不支持捕获，拖拽照样靠冒泡工作
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (disabled) {
      // 拖到一半外部把裁剪关掉了：清掉拖拽状态，不再把位移套用到框上。
      dragRef.current = null;
      return;
    }
    event.stopPropagation();
    const dx = (event.clientX - drag.clientX) / drag.clientPxPerSourcePx;
    const dy = (event.clientY - drag.clientY) / drag.clientPxPerSourcePx;
    onChange(
      drag.kind === "move"
        ? moveCropBox(drag.startBox, dx, dy, sourceWidth, sourceHeight)
        : dragCropHandle(drag.startBox, drag.kind, dx, dy, ratio, sourceWidth, sourceHeight),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      containerRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // pointer 可能没被捕获
    }
  };

  // 方向键挪框、Alt+方向键从右下角调大小、Esc 退出。命中的按键要 stopPropagation，
  // 否则会同时触发 react-flow 节点自带的方向键移动整个节点、以及 Canvas.tsx 里
  // 挂在 document 上另外注册的方向键 / Esc 处理——这里只挡这两类键，不影响删除、
  // 撤销这些走其它按键的快捷键。
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const directions: Record<string, { dx: number; dy: number }> = {
      ArrowLeft: { dx: -1, dy: 0 },
      ArrowRight: { dx: 1, dy: 0 },
      ArrowUp: { dx: 0, dy: -1 },
      ArrowDown: { dx: 0, dy: 1 },
    };
    const isEscape = event.key === "Escape";
    const direction = directions[event.key];
    if (!isEscape && !direction) return;

    // disabled 时也要吃掉这两类键：不然 react-flow / Canvas.tsx 那两层还是会接
    // 到，只是这里不再触发裁剪框自己的挪动/退出动作。
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    if (isEscape) {
      onEscape?.();
      return;
    }

    const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    const dx = direction.dx * step;
    const dy = direction.dy * step;
    onChange(
      event.altKey
        ? dragCropHandle(box, "se", dx, dy, ratio, sourceWidth, sourceHeight)
        : moveCropBox(box, dx, dy, sourceWidth, sourceHeight),
    );
  };

  const handles = ratio === null ? CROP_ALL_HANDLES : CROP_CORNER_HANDLES;

  return (
    <div
      ref={containerRef}
      className="nodrag nopan absolute inset-0 z-30"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onClick={(event) => event.stopPropagation()}
    >
      {displayed.width > 0 && (
        <>
          {/* 压暗层：超大 box-shadow 画框外，外面套一层只露出画面区域的裁剪容器。 */}
          <div className="pointer-events-none absolute overflow-hidden" style={displayed}>
            <div
              className="absolute shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{ left: boxLeft, top: boxTop, width: boxWidth, height: boxHeight }}
            />
          </div>

          <div
            ref={boxRef}
            data-testid="video-crop-box"
            data-crop-box=""
            role="group"
            aria-label={t("node.videoNode.crop.boxLabel")}
            tabIndex={0}
            className="absolute border border-white/90 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
            style={{
              left: displayed.left + boxLeft,
              top: displayed.top + boxTop,
              width: boxWidth,
              height: boxHeight,
              cursor: disabled ? "not-allowed" : "move",
            }}
            onPointerDown={(event) => beginDrag(event, "move")}
            onKeyDown={handleKeyDown}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/45" />
            <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/45" />
            <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/45" />
            <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/45" />
            {boxWidth >= 72 && boxHeight >= 24 && (
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
                {pixel.width} × {pixel.height}
              </span>
            )}
            {handles.map((name) => (
              <div
                key={name}
                data-crop-handle={name}
                // before 伪元素把可点击区域悄悄扩大一圈，手柄本身还是视觉上的小圆点。
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/30 bg-white shadow before:absolute before:-inset-2 before:content-['']"
                style={{
                  left: HANDLE_LAYOUT[name].left,
                  top: HANDLE_LAYOUT[name].top,
                  cursor: disabled ? "not-allowed" : HANDLE_LAYOUT[name].cursor,
                }}
                onPointerDown={(event) => beginDrag(event, name)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
