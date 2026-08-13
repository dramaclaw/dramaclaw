// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSmoothMinimapPan } from "@/features/canvas/hooks/useSmoothMinimapPan";

const MINIMAP_RECT = { left: 100, top: 100, right: 300, bottom: 250, width: 200, height: 150 };
const FRAME_MS = 1000 / 60;

type TestNode = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  hidden?: boolean;
};

// 增益要可预期，所以把节点摆成固定尺寸：viewScale = max(2000/200, 1500/150) = 10。
const PLAIN_NODES: TestNode[] = [
  { id: "n", position: { x: 0, y: 0 }, width: 2000, height: 1500 },
];

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

/**
 * 复刻 `instance.getNodesBounds`：它带 nodeLookup，分组成员按**绝对坐标**
 * （父位置 + 相对位置）计入。同名的静态工具没有 nodeLookup，会把相对坐标
 * 当成全局坐标 —— 两者的差别正是下面那条分组用例要卡的东西。
 */
function makeGetNodesBounds(allNodes: TestNode[]) {
  const byId = new Map(allNodes.map((node) => [node.id, node]));
  const absolute = (node: TestNode): { x: number; y: number } => {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (!parent) return node.position;
    const base = absolute(parent);
    return { x: base.x + node.position.x, y: base.y + node.position.y };
  };
  return vi.fn((nodes: TestNode[]) => {
    if (nodes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    nodes.forEach((node) => {
      const { x, y } = absolute(node);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + node.width);
      maxY = Math.max(maxY, y + node.height);
    });
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  });
}

function makeInstance(nodes: TestNode[] = PLAIN_NODES, initial = { x: 0, y: 0, zoom: 0.5 }) {
  let viewport = { ...initial };
  const setViewport = vi.fn((next: { x: number; y: number; zoom: number }) => {
    viewport = { ...next };
  });
  return {
    getViewport: () => viewport,
    getNodes: () => nodes,
    getNodesBounds: makeGetNodesBounds(nodes),
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

  function setup(nodes: TestNode[] = PLAIN_NODES) {
    const { wrapper, svg } = mountMinimapDom();
    const instance = makeInstance(nodes);
    const onPanStart = vi.fn();
    const onPanEnd = vi.fn();
    const onViewportSettled = vi.fn();
    const view = renderHook(() =>
      useSmoothMinimapPan({
        enabled: true,
        wrapperRef: { current: wrapper },
        // 只用到 getViewport / getNodes / getNodesBounds / setViewport 四个方法。
        instance: instance as never,
        onPanStart,
        onPanEnd,
        onViewportSettled,
      }),
    );
    return { view, svg, instance, onPanStart, onPanEnd, onViewportSettled };
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
    flushFrames(120);
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
    flushFrames(120);
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

  // ---- P1：增益只按可见节点的绝对包围盒算 ------------------------------------
  it("分组的隐藏成员不参与增益计算，相对坐标也不会被当成全局坐标", () => {
    // 分镜组：组在 x=10000，成员被改成 parentId + hidden，position 是组内单元格
    // 坐标（近原点）。静态 getNodesBounds 会把包围盒从 x=20 一路撑到 x=12000
    // （宽 11980 ⇒ 增益 ~29.95），而正确答案只算可见的组本身（宽 2000 ⇒ 增益 5）。
    const nodes: TestNode[] = [
      { id: "g", position: { x: 10000, y: 0 }, width: 2000, height: 1500 },
      { id: "c", parentId: "g", hidden: true, position: { x: 20, y: 10 }, width: 100, height: 100 },
    ];
    const { svg, instance } = setup(nodes);

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 9, clientX: 200, clientY: 180 }));

    // 隐藏成员必须先被过滤掉 —— 内置 MiniMap 的包围盒同样只算可见节点。
    expect(instance.getNodesBounds).toHaveBeenCalledTimes(1);
    expect(instance.getNodesBounds.mock.calls[0][0].map((node: TestNode) => node.id)).toEqual(["g"]);

    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 9, clientX: 220, clientY: 180 }));
    flushFrames(200);
    // moveScale = 10 * 0.5 = 5 ⇒ 20px 位移走 -100，而不是被撑大后的 -599。
    expect(instance.current().x).toBeCloseTo(-100, 5);
  });

  // ---- P1：收敛时提交一次最终视口 --------------------------------------------
  it("收敛时把最终视口交给外层提交一次，缓动中途不发", () => {
    const { svg, instance, onViewportSettled } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 2, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 2, clientX: 220, clientY: 180 }));

    // 缓动每帧只走 30%，头几帧远没到位，这期间不该有任何提交。
    flushFrames(3);
    expect(instance.setViewport.mock.calls.length).toBeGreaterThan(1);
    expect(onViewportSettled).not.toHaveBeenCalled();

    flushFrames(200);
    expect(onViewportSettled).toHaveBeenCalledTimes(1);
    expect(onViewportSettled.mock.calls[0][0].x).toBeCloseTo(-100, 5);
  });

  // ---- P2：结束通知等缓动真正到位 --------------------------------------------
  it("松手时缓动还没收尾，就要等到位后才通知外层结束", () => {
    const { svg, instance, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 4, clientX: 200, clientY: 180 }));
    // 一口气拖很远（400px ⇒ 视口要走 2000），松手时离目标还差得远。
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 4, clientX: 600, clientY: 180 }));
    flushFrames(2);
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 4, clientX: 600, clientY: 180 }));

    // 松手那一刻不能就报结束：外层一旦解除挂载保护，MiniMap 卸载会把 rAF 掐断，
    // 画布停在半路。固定 180ms 的老做法盖不住这段收敛时间。
    expect(onPanEnd).not.toHaveBeenCalled();
    flushFrames(5);
    expect(onPanEnd).not.toHaveBeenCalled();
    expect(Math.abs(instance.current().x)).toBeLessThan(2000);

    flushFrames(200);
    expect(instance.current().x).toBeCloseTo(-2000, 5);
    expect(onPanEnd).toHaveBeenCalledTimes(1);
  });

  it("缓动收尾期间又按下去，不会把上一次的结束通知冲出来", () => {
    const { svg, onPanEnd } = setup();

    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 6, clientX: 200, clientY: 180 }));
    window.dispatchEvent(pointerEvent("pointermove", { pointerId: 6, clientX: 600, clientY: 180 }));
    flushFrames(2);
    window.dispatchEvent(pointerEvent("pointerup", { pointerId: 6, clientX: 200, clientY: 180 }));

    // 收尾还没走完就又按下 ⇒ 新手势开始，旧的结束通知作废。
    svg.dispatchEvent(pointerEvent("pointerdown", { pointerId: 8, clientX: 200, clientY: 180 }));
    flushFrames(200);
    expect(onPanEnd).not.toHaveBeenCalled();
  });
});
