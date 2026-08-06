// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 增益要可预期，所以把节点包围盒固定住：viewScale = max(2000/200, 1500/150) = 10。
const NODE_BOUNDS = { x: 0, y: 0, width: 2000, height: 1500 };

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return { ...actual, getNodesBounds: () => NODE_BOUNDS };
});

import { useSmoothMinimapPan } from "@/features/canvas/hooks/useSmoothMinimapPan";

const MINIMAP_RECT = { left: 100, top: 100, right: 300, bottom: 250, width: 200, height: 150 };
const FRAME_MS = 1000 / 60;

// ---- 手动驱动的 rAF ---------------------------------------------------------
let rafCallbacks = new Map<number, FrameRequestCallback>();
let nextRafId = 1;
let now = 0;

function flushFrames(maxFrames: number) {
  for (let i = 0; i < maxFrames; i += 1) {
    if (rafCallbacks.size === 0) return;
    now += FRAME_MS;
    const pending = [...rafCallbacks.values()];
    rafCallbacks.clear();
    pending.forEach((cb) => cb(now));
  }
}

function pointerEvent(
  type: string,
  init: { pointerId: number; clientX: number; clientY: number; button?: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
    button: init.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

function mountMinimapDom() {
  const wrapper = document.createElement("div");
  const minimap = document.createElement("div");
  minimap.className = "react-flow__minimap";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  minimap.appendChild(svg);
  wrapper.appendChild(minimap);
  document.body.appendChild(wrapper);

  const rect = { ...MINIMAP_RECT, x: MINIMAP_RECT.left, y: MINIMAP_RECT.top, toJSON: () => ({}) };
  minimap.getBoundingClientRect = () => rect as DOMRect;
  svg.getBoundingClientRect = () => rect as DOMRect;
  return { wrapper, svg };
}

function makeInstance(initial = { x: 0, y: 0, zoom: 0.5 }) {
  let viewport = { ...initial };
  const setViewport = vi.fn((next: { x: number; y: number; zoom: number }) => {
    viewport = { ...next };
  });
  return {
    getViewport: () => viewport,
    getNodes: () => [],
    setViewport,
    current: () => viewport,
  };
}

describe("useSmoothMinimapPan", () => {
  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;
    now = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextRafId;
      nextRafId += 1;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  function setup() {
    const { wrapper, svg } = mountMinimapDom();
    const instance = makeInstance();
    const onPanStart = vi.fn();
    const onPanEnd = vi.fn();
    const view = renderHook(() =>
      useSmoothMinimapPan({
        enabled: true,
        wrapperRef: { current: wrapper },
        // 只用到 getViewport / getNodes / setViewport 三个方法。
        instance: instance as never,
        onPanStart,
        onPanEnd,
      }),
    );
    return { view, svg, instance, onPanStart, onPanEnd };
  }

  it("指针拖出小地图后仍继续平移，直到 pointerup 才结束", () => {
    const { svg, instance, onPanStart, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientX: 200, clientY: 180 }));
    expect(onPanStart).toHaveBeenCalledTimes(1);

    // 指针已经远在小地图之外（小地图右边界 300），事件只会打到 window 上。
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 220, clientY: 180 }));
    flushFrames(120);

    // moveScale = viewScale(10) * zoom(0.5) = 5，位移 20px ⇒ 视口 x 走 -100。
    expect(instance.current().x).toBeCloseTo(-100, 5);

    // 还没松手，继续拖依然跟手，而且增益不变（不再随视口拖离内容区复利放大）。
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 240, clientY: 180 }));
    flushFrames(120);
    expect(instance.current().x).toBeCloseTo(-200, 5);
    expect(onPanEnd).not.toHaveBeenCalled();

    // 松手点在小地图外（小地图下边界 250）⇒ 外层应恢复自动隐藏。
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 7, clientX: 240, clientY: 400 }));
    expect(onPanEnd).toHaveBeenCalledTimes(1);
    expect(onPanEnd).toHaveBeenCalledWith(false);

    // 松手后的 pointermove 不该再动视口。
    const settled = instance.current().x;
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientX: 400, clientY: 180 }));
    flushFrames(120);
    expect(instance.current().x).toBeCloseTo(settled, 5);
  });

  it("松手点仍在小地图内时告知外层保持显示", () => {
    const { svg, onPanEnd } = setup();
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 3, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 3, clientX: 210, clientY: 190 }));
    expect(onPanEnd).toHaveBeenCalledWith(true);
  });

  it("收敛后按住不动不再空转 rAF，也不再重复写视口", () => {
    const { svg, instance } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 1, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 1, clientX: 220, clientY: 180 }));
    flushFrames(200);

    // 指针仍按着，但已经到位：循环必须自己停掉。
    expect(rafCallbacks.size).toBe(0);

    const callsAfterSettle = instance.setViewport.mock.calls.length;
    flushFrames(200);
    expect(instance.setViewport).toHaveBeenCalledTimes(callsAfterSettle);
  });

  it("卸载时若仍在拖动，要把结束事件还给外层", () => {
    const { view, svg, onPanEnd } = setup();
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 5, clientX: 200, clientY: 180 }));
    view.unmount();
    expect(onPanEnd).toHaveBeenCalledWith(false);
  });
});
