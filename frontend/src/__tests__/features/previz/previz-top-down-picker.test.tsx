// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { PrevizObject, PrevizObjectKind } from "@/features/previz/domain/scene";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  worldToCanvas,
} from "@/features/previz/domain/topDownMap";
import {
  PREVIZ_TOP_DOWN_KEY_STEP_M,
  PREVIZ_TOP_DOWN_PICKER_SIZE,
  PrevizTopDownPicker,
} from "@/features/previz/ui/PrevizTopDownPicker";

// 回显 key，与 previz-camera-create-dialog.test.tsx 同一个做法。这里必须 mock 而不是
// 靠全局 setup 那个真 i18next：`previz.characterCreate.*` 的词条是 Task 8 的活，今天
// 缺 key 时 t() 恰好回显 key，等 Task 8 把中文补进 translation.json，断言就会突然变成
// 「按钮叫『点一下决定站位』」而挂——一条与本组件无关的红。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

/** 只有 x/z 进俯视映射，y 一律给非零值，免得用例在「其实读的是 y」上蒙混过关。 */
function objectAt(kind: PrevizObjectKind, x: number, z: number): PrevizObject {
  const created = createPrevizObject(kind, []);
  return { ...created, transform: { ...created.transform, position: [x, 1.5, z] } };
}

/**
 * 组件里那张视图的复算。断言不直接抄组件的算式，而是走同一份 domain 函数：
 * 这样测的是「组件有没有用对映射」，映射本身对不对由 top-down-map.test.ts 管。
 */
function viewFor(objects: readonly PrevizObject[], ratio = 1) {
  return topDownView(
    sceneTopDownBounds(objects),
    PREVIZ_TOP_DOWN_PICKER_SIZE.width * ratio,
    PREVIZ_TOP_DOWN_PICKER_SIZE.height * ratio,
  );
}

interface StubRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * jsdom 不排版，`getBoundingClientRect()` 四个数全是 0。组件按 rect 去换算落点，所以
 * 不塞一个真尺寸进去，鼠标那条路在测试里根本走不到（也确实走不到——见「量不到尺寸」
 * 那条用例）。刻意做成可以给出与位图尺寸不同的 rect：只有 rect ≠ 画布像素时，
 * `画布宽 / rect 宽` 那个缩放才有区分度。
 */
function stubRect(element: Element, rect: StubRect): void {
  element.getBoundingClientRect = () =>
    ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

interface ArcCall {
  x: number;
  y: number;
  radius: number;
  fillStyle: string;
  strokeStyle: string;
}

/**
 * 记账用的假 2D 上下文。
 *
 * jsdom 的 `getContext('2d')` 返回 null（没装 canvas 包），所以真实现里那一整段绘制在
 * 测试里一行都不会跑——参照点循环整个删掉都不会有用例变红。塞个假的进来之后，
 * 「每个对象画一个点、点在哪、什么颜色」才钉得住。
 *
 * 只记圆：底色和网格是装饰，画错了没有正确答案可断言；而圆的位置直接就是
 * `worldToCanvas` 的输出，是这个组件唯一一处「画面必须和数据对上」的地方。
 */
function fakeContext() {
  const arcs: ArcCall[] = [];
  let pending: { x: number; y: number; radius: number } | null = null;
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(() => {
      pending = null;
    }),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn((x: number, y: number, radius: number) => {
      pending = { x, y, radius };
    }),
    fill: vi.fn(() => {
      if (pending) arcs.push({ ...pending, ...styles() });
      pending = null;
    }),
    stroke: vi.fn(() => {
      if (pending) arcs.push({ ...pending, ...styles() });
      pending = null;
    }),
  };
  const styles = () => ({ fillStyle: context.fillStyle, strokeStyle: context.strokeStyle });
  return { context, arcs };
}

/** 让画布交出假上下文。返回记下来的圆，随后断言直接读它。 */
function captureArcs(): ArcCall[] {
  const { context, arcs } = fakeContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  return arcs;
}

function picker() {
  return screen.getByRole("button");
}

function canvasOf(): HTMLCanvasElement {
  const canvas = picker().querySelector("canvas");
  if (!canvas) throw new Error("picker has no canvas");
  return canvas;
}

describe("PrevizTopDownPicker", () => {
  it("hands back the world point the user clicked", () => {
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />);
    const view = viewFor([]);
    // rect 与位图同尺寸、贴在视口原点：这条只钉「点中心 = 世界原点」，缩放与偏移
    // 各有专门的用例。
    stubRect(canvasOf(), { left: 0, top: 0, width: view.width, height: view.height });

    // detail 必须显式给 1。`fireEvent.click` 的默认 detail 是 0，而组件把 detail === 0
    // 当作「没有坐标的激活」（键盘回车、读屏软件），不给的话这条用例测的是键盘那条路。
    fireEvent.click(picker(), { clientX: view.width / 2, clientY: view.height / 2, detail: 1 });

    expect(onPick).toHaveBeenCalledTimes(1);
    const [x, z] = onPick.mock.calls[0][0] as [number, number];
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it("reads the click through the canvas' own pixel scale, not raw CSS pixels", () => {
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />);
    const view = viewFor([]);
    // rect 是位图的两倍、还挪开了：CSS 尺寸与位图尺寸不一致是常态（画布节点里的
    // 预演台整个被 CSS 缩放过）。两个数都给非零，减偏移与乘缩放少做哪一步都会露馅。
    stubRect(canvasOf(), { left: 40, top: 12, width: view.width * 2, height: view.height * 2 });

    // 落在 rect 里的 (480, 160) → 位图里的 (240, 80) → 世界 (3, -3)。
    fireEvent.click(picker(), { clientX: 40 + 480, clientY: 12 + 160, detail: 1 });

    const [x, z] = onPick.mock.calls[0][0] as [number, number];
    expect(x).toBeCloseTo(3, 9);
    expect(z).toBeCloseTo(-3, 9);
    // 同一个落点用 domain 的逆映射复算一遍：把 canvasToWorld 换成恒等函数就活不下来
    // ——那样吐出来的是 (240, 80) 这两个像素数，而不是 (3, -3) 这两个米数。
    const [expectedX, expectedZ] = canvasToWorld(view, [240, 80]);
    expect(x).toBeCloseTo(expectedX, 9);
    expect(z).toBeCloseTo(expectedZ, 9);
  });

  it("frames the picker on the objects already in the scene", () => {
    const onPick = vi.fn();
    // 这群人偏在 -X-Z 那侧，取景中心因此不是世界原点；画布正中该映射到取景中心。
    const objects = [objectAt("character", -8, -6), objectAt("prop", -2, -2)];
    render(<PrevizTopDownPicker objects={objects} value={null} onPick={onPick} />);
    const view = viewFor(objects);
    stubRect(canvasOf(), { left: 0, top: 0, width: view.width, height: view.height });

    fireEvent.click(picker(), { clientX: view.width / 2, clientY: view.height / 2, detail: 1 });

    const [x, z] = onPick.mock.calls[0][0] as [number, number];
    expect(x).toBeCloseTo(-5, 9);
    expect(z).toBeCloseTo(-4, 9);
  });

  it("scales the bitmap by the device pixel ratio without moving the picked point", () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />);

    // 位图按设备像素铺开，CSS 尺寸不变。
    expect(canvasOf().width).toBe(PREVIZ_TOP_DOWN_PICKER_SIZE.width * 2);
    expect(canvasOf().height).toBe(PREVIZ_TOP_DOWN_PICKER_SIZE.height * 2);

    // rect 仍是 CSS 尺寸——2× 屏上浏览器给的就是这个。缩放那一步顺手把 dpr 也吃掉了，
    // 所以同一个 CSS 落点必须还是同一个世界点（与第一条用例的 (3, -3) 对齐）。
    stubRect(canvasOf(), {
      left: 0,
      top: 0,
      width: PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      height: PREVIZ_TOP_DOWN_PICKER_SIZE.height,
    });
    fireEvent.click(picker(), { clientX: 240, clientY: 80, detail: 1 });

    const [x, z] = onPick.mock.calls[0][0] as [number, number];
    expect(x).toBeCloseTo(3, 9);
    expect(z).toBeCloseTo(-3, 9);
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  it("refuses a click it cannot measure instead of picking a NaN spot", () => {
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />);

    // rect 不 stub：jsdom 里四个数全是 0，也就是元素还没排版 / 被折叠成 0 宽。
    // 除以 0 会算出 Infinity 或 NaN，而 NaN 的站位在画面上没有任何提示——
    // 人就是放不下去，还查不出为什么。宁可这一下不算数。
    fireEvent.click(picker(), { clientX: 160, clientY: 160, detail: 1 });

    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps working when the canvas has no 2d context", () => {
    const onPick = vi.fn();
    // jsdom 默认就拿不到 2D 上下文（没装 canvas 包，`getContext('2d')` 返回 null），
    // 这里不塞假的，走的正是那条路。画不出来可以，抛异常把整个创建对话框带走不行。
    expect(() =>
      render(
        <PrevizTopDownPicker
          objects={[objectAt("character", 1, 2)]}
          value={[0, 0]}
          onPick={onPick}
        />,
      ),
    ).not.toThrow();

    const view = viewFor([objectAt("character", 1, 2)]);
    // 位图尺寸走 JSX 属性、不在绘制那一步里设：拿不到上下文时绘制会提前 return，
    // 尺寸若跟在它后面，位图就停在 canvas 默认的 300×150，而点击换算除的正是这个
    // 宽度——画面全空的同时每一次落点还都是错的。
    expect(canvasOf().width).toBe(view.width);
    expect(canvasOf().height).toBe(view.height);

    stubRect(canvasOf(), { left: 0, top: 0, width: view.width, height: view.height });
    fireEvent.click(picker(), { clientX: view.width / 2, clientY: view.height / 2, detail: 1 });
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("stays operable from the keyboard", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />);
    picker().focus();

    // 回车合成的 click 的 clientX/Y 恒为 0（已实测）。照鼠标那条路算，(0, 0) 是画布
    // 左上角，人会被放到取景框的角上——一个不报错的错答案。没有落点时该回到取景中心。
    await user.keyboard("{Enter}");

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toEqual([0, 0]);
  });

  it("nudges the spot with the arrow keys so a keyboard user can aim", () => {
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={[1, 1]} onPick={onPick} />);

    // 俯视图里 +X 朝右、+Z 朝下（topDownMap 的约定，源头是 domain/view.ts 顶视图的
    // up = [0, 0, -1]）。所以「下」键必须往 +Z 走，反了的话画面上的光标会往上跑。
    expect(fireEvent.keyDown(picker(), { key: "ArrowRight" })).toBe(false);
    expect(onPick).toHaveBeenLastCalledWith([1 + PREVIZ_TOP_DOWN_KEY_STEP_M, 1]);
    fireEvent.keyDown(picker(), { key: "ArrowDown" });
    expect(onPick).toHaveBeenLastCalledWith([1, 1 + PREVIZ_TOP_DOWN_KEY_STEP_M]);
    fireEvent.keyDown(picker(), { key: "ArrowLeft" });
    expect(onPick).toHaveBeenLastCalledWith([1 - PREVIZ_TOP_DOWN_KEY_STEP_M, 1]);
    fireEvent.keyDown(picker(), { key: "ArrowUp" });
    expect(onPick).toHaveBeenLastCalledWith([1, 1 - PREVIZ_TOP_DOWN_KEY_STEP_M]);
  });

  it("starts the arrow keys from the framing centre when nothing is picked yet", () => {
    const onPick = vi.fn();
    const objects = [objectAt("character", -8, -6), objectAt("prop", -2, -2)];
    render(<PrevizTopDownPicker objects={objects} value={null} onPick={onPick} />);

    fireEvent.keyDown(picker(), { key: "ArrowRight" });

    // 取景中心是 (-5, -4)，不是世界原点：没落点时从画布正中那一格起步。
    expect(onPick).toHaveBeenLastCalledWith([-5 + PREVIZ_TOP_DOWN_KEY_STEP_M, -4]);
  });

  it("leaves other keys to the browser", () => {
    const onPick = vi.fn();
    render(<PrevizTopDownPicker objects={[]} value={[1, 1]} onPick={onPick} />);

    // Tab 得能把焦点带走，preventDefault 一刀切会把用户锁在这个按钮上。
    expect(fireEvent.keyDown(picker(), { key: "Tab" })).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("swaps the label once a spot has been picked", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <PrevizTopDownPicker objects={[]} value={null} onPick={onPick} />,
    );

    expect(picker()).toHaveAttribute("aria-label", "previz.characterCreate.pickHint");

    rerender(<PrevizTopDownPicker objects={[]} value={[2, 2]} onPick={onPick} />);

    // 换一句话是 upstream 的做法，也是这个按钮唯一的状态提示：读屏用户看不见那个
    // 高亮环，标签不换就分不出「还没选」和「已经选过、再点一下改」。
    expect(picker()).toHaveAttribute("aria-label", "previz.characterCreate.pickHintAgain");
  });

  it("draws one reference dot per object, characters in their own colour", () => {
    const arcs = captureArcs();
    const character = { ...objectAt("character", 2, -4), color: "#ff00ff" } as PrevizObject;
    const objects = [character, objectAt("prop", -3, 1), objectAt("light", 0, 5)];
    render(<PrevizTopDownPicker objects={objects} value={null} onPick={vi.fn()} />);

    // 没有落点就没有高亮环：圆的条数正好是对象数。
    expect(arcs).toHaveLength(3);
    const view = viewFor(objects);
    const [px, py] = worldToCanvas(view, [2, -4]);
    expect(arcs[0].x).toBeCloseTo(px, 9);
    expect(arcs[0].y).toBeCloseTo(py, 9);
    // 所有人物共用同一副模型，辨识色是唯一能在俯视图上认出「哪个点是谁」的东西。
    expect(arcs[0].fillStyle).toBe("#ff00ff");
    // 其余按分类色，三种 kind 互不相同——否则场上的灯和道具在俯视图上分不开。
    expect(new Set(arcs.map((arc) => arc.fillStyle)).size).toBe(3);
  });

  it("rings the picked spot on top of the reference dots", () => {
    const arcs = captureArcs();
    const objects = [objectAt("character", 2, -4)];
    render(<PrevizTopDownPicker objects={objects} value={[-3, 3]} onPick={vi.fn()} />);

    expect(arcs).toHaveLength(2);
    const view = viewFor(objects);
    const [px, py] = worldToCanvas(view, [-3, 3]);
    expect(arcs[1].x).toBeCloseTo(px, 9);
    expect(arcs[1].y).toBeCloseTo(py, 9);
    // 环比参照点大：两者重合时（把人放在已有人物脚下）还得看得出来选中的是哪一个。
    expect(arcs[1].radius).toBeGreaterThan(arcs[0].radius);
  });
});
