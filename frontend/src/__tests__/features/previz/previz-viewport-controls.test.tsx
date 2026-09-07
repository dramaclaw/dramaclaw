// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PrevizAxisView } from "@/features/previz/domain/axisGizmo";
import type { PrevizViewSource } from "@/features/previz/ui/PrevizAxisGizmo";
import { PrevizViewportControls } from "@/features/previz/ui/PrevizViewportControls";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type ControlsProps = ComponentProps<typeof PrevizViewportControls>;

/** 三个显示模式写成字面量而不是 import：跟着被测模块一起变的断言等于没有断言。 */
const DISPLAY_MODES = ["solid", "translucent", "clay"] as const;

/** 六个半轴，顺序按「正负成对」写，与坐标轴小球那六颗球一一对应。 */
const VIEW_DIRECTIONS = ["front", "back", "left", "right", "top", "bottom"] as const;

/** 小球面板的几何：边长 72、轨道半径 26，中心落在 36px。与被测组件里的常量对齐。 */
const CENTRE_PX = 36;
const ORBIT_PX = 26;

/** 正对 +Z 的视角：+Z 那颗压在正中，+X 在正右。 */
const FRONT_VIEW: PrevizAxisView = { position: [0, 0, 10], target: [0, 0, 0] };
/** 从 +X 看过去：+X 压在正中，+Z 转到了左边。 */
const RIGHT_VIEW: PrevizAxisView = { position: [10, 0, 0], target: [0, 0, 0] };

/**
 * 一个能推新视角的订阅源。相机是每帧在动的，小球必须跟着动——这里手动推一次，代替
 * 真实的 OrbitControls。
 */
function makeViewSource(initial: PrevizAxisView) {
  let pose = initial;
  const listeners = new Set<() => void>();
  return {
    source: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      // 同一个引用交回去：每次新建字面量的话 useSyncExternalStore 会当场无限重渲。
      snapshot: () => pose,
    } satisfies PrevizViewSource,
    moveTo(next: PrevizAxisView) {
      act(() => {
        pose = next;
        for (const listener of listeners) listener();
      });
    },
  };
}

/** 某颗球在面板里的落点。定位写在按钮外面那层（提示的锚点要留在球上）。 */
function dotAt(direction: (typeof VIEW_DIRECTIONS)[number]): { left: string; top: string } {
  const box = screen.getByTestId(`previz-axis-dot-${direction}`);
  return { left: box.style.left, top: box.style.top };
}

/**
 * 回调不进 overrides：`...Partial<Props>` 展开会把每个 handler 的类型拓宽成
 * `Mock | ((...) => void)`，之后取 `.mock` / `.mockClear()` 就过不了类型检查。
 */
type Overrides = Partial<
  Pick<
    ControlsProps,
    | "canUndo"
    | "canRedo"
    | "displayMode"
    | "pathSpacingM"
    | "pathSpeedMps"
    | "view"
    | "hasSelection"
    | "quadView"
  >
>;

function makeHandlers() {
  return {
    onUndo: vi.fn<ControlsProps["onUndo"]>(),
    onRedo: vi.fn<ControlsProps["onRedo"]>(),
    onDisplayMode: vi.fn<ControlsProps["onDisplayMode"]>(),
    onResetView: vi.fn<ControlsProps["onResetView"]>(),
    onPathSpacing: vi.fn<ControlsProps["onPathSpacing"]>(),
    onPathSpeed: vi.fn<ControlsProps["onPathSpeed"]>(),
    onViewDirection: vi.fn<ControlsProps["onViewDirection"]>(),
    onFocus: vi.fn<ControlsProps["onFocus"]>(),
    onQuadView: vi.fn<ControlsProps["onQuadView"]>(),
  };
}

type Handlers = ReturnType<typeof makeHandlers>;

function setup(overrides: Overrides = {}): Handlers {
  const handlers = makeHandlers();
  render(
    <PrevizViewportControls
      canUndo
      canRedo
      displayMode="translucent"
      pathSpacingM={0.5}
      pathSpeedMps={1.4}
      view={makeViewSource(FRONT_VIEW).source}
      hasSelection
      quadView={false}
      {...overrides}
      {...handlers}
    />,
  );
  return handlers;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * 悬停一颗按钮，读出弹出来的提示文字，再挪开。
 *
 * 这几颗浮在画面上的控件只有图标没有可见文字，提示是鼠标用户读出「这颗是干什么的」
 * 的唯一渠道（aria-label 只服务读屏）。提示渲在 portal 里，按名字查不到，只能顺着
 * 设计系统给的 `data-slot` 找；离开之后才卸掉，所以出场也得等一等。
 */
async function tooltipOf(user: User, control: HTMLElement): Promise<string> {
  await user.hover(control);
  const popup = await waitFor(() => {
    const open = document.querySelector<HTMLElement>('[data-slot="tooltip-content"][data-open]');
    expect(open, "hovering should have opened a tooltip").not.toBeNull();
    return open as HTMLElement;
  });
  const text = popup.textContent ?? "";

  await user.unhover(control);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"][data-open]')).toBeNull();
  });
  return text;
}

/** 一次交互只该惊动一个回调；缺了这条，把两个 handler 接反了照样全绿。 */
function expectOnly(handlers: Handlers, called: keyof Handlers): void {
  for (const [name, mock] of Object.entries(handlers)) {
    if (name === called) continue;
    expect(mock, `${name} should not have fired`).not.toHaveBeenCalled();
  }
}

describe("PrevizViewportControls", () => {
  it("fires nothing just by rendering", () => {
    const handlers = setup();

    for (const mock of Object.values(handlers)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // 这几样从左侧菜单列搬到视口两角，就是为了让「按一下、当场看画面」不用把视线拽走。
  // 各簇自己定位、中间不铺东西：铺一条横跨顶边的容器会把视口顶部的拾取和绘制吃掉。
  it("splits the controls into history, axis, view, draw and display clusters", () => {
    setup();

    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "previz.viewport.group.history",
      "previz.viewport.group.axis",
      "previz.viewport.group.view",
      "previz.viewport.group.draw",
      "previz.viewport.group.display",
    ]);

    expect(within(groups[0]).getAllByRole("button")).toHaveLength(2);
    // 六个半轴各一颗球。
    expect(within(groups[1]).getAllByRole("button")).toHaveLength(6);
    // 聚焦 + 四视图。
    expect(within(groups[2]).getAllByRole("button")).toHaveLength(2);
    // 绘制那簇是间距与速度两个数字框，一颗按钮都不该有——跑错簇的按钮在这里现形。
    expect(within(groups[3]).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(groups[3])
        .getAllByRole("spinbutton")
        .map((field) => (field as HTMLInputElement).value),
    ).toEqual(["0.5", "1.4"]);
    // 三个显示模式 + 重置视角。
    expect(within(groups[4]).getAllByRole("button")).toHaveLength(4);
  });

  /*
    间距决定一笔画出来落几个轨迹点：写 0.3 就是每 0.3 米一个点，一笔下来点密、贴合手
    划的形状但时间轴上挤；写 2 就是两米一个点，轨迹顺、关键帧少好调。它跟着场景尺度
    改，所以摆在画面这一侧——「够不够密」只有看着画面里那串点才判断得出来。
  */
  it("reports the drawing spacing", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const field = screen.getByLabelText<HTMLInputElement>("previz.viewport.pathSpacing");

    // 浮层上唯一一个没有图标的控件：光看「1 m」猜不出这是什么，提示是它的全部说明。
    expect(await tooltipOf(user, field)).toBe("previz.viewport.pathSpacing");
    // 走设计系统那只输入框，而不是裸 <input> 自己配一套边框圆角。
    expect(field).toHaveAttribute("data-slot", "input");
    expect(field).toHaveValue(0.5);

    await user.clear(field);
    await user.type(field, "2");
    // 改动在失焦时才交出去：每敲一个键就报一次的话，"0.3" 会在打到 "0." 时先被当成 0。
    expect(handlers.onPathSpacing).not.toHaveBeenCalled();
    await user.tab();

    expect(handlers.onPathSpacing).toHaveBeenLastCalledWith(2);
    expectOnly(handlers, "onPathSpacing");
  });

  /**
   * 上层没接受这次改动时（超界被夹回 0.05–5）数字框必须退回 prop。写成受控的话每次
   * 按键都回写，输到一半的 "0." 当场被抹平，0.3 根本打不出来；所以这里靠 `key` 重挂
   * 一个非受控输入，而重挂这件事只有重渲一次才验得到。
   */
  it("snaps the spacing field back to its prop when the change is not accepted", async () => {
    const user = userEvent.setup();
    const handlers = setup({ pathSpacingM: 0.5 });

    const field = screen.getByLabelText<HTMLInputElement>("previz.viewport.pathSpacing");
    await user.clear(field);
    await user.type(field, "9");
    await user.tab();
    expect(handlers.onPathSpacing).toHaveBeenLastCalledWith(9);

    // 上层把 9 夹回了 5，交回来的 prop 和用户打的不是一回事。
    render(
      <PrevizViewportControls
        canUndo
        canRedo
        displayMode="translucent"
        pathSpacingM={5}
        pathSpeedMps={1.4}
        view={makeViewSource(FRONT_VIEW).source}
        hasSelection
        quadView={false}
        {...handlers}
      />,
    );

    const fields = screen.getAllByLabelText<HTMLInputElement>("previz.viewport.pathSpacing");
    expect(fields[fields.length - 1]).toHaveValue(5);
  });

  /*
    速度决定一笔画出来在时间轴上占多久：画笔按这个速度沿轨迹走一遍，走多久片段就多长。
    它和间距挨在一起，因为两者都是「这一笔怎么落」的参数，而且都得跟着场景尺度改——
    同一条十几米的走位，人物散步是八秒多，车开过去不到一秒。
  */
  it("reports the drawing speed", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const field = screen.getByLabelText<HTMLInputElement>("previz.viewport.pathSpeed");

    expect(await tooltipOf(user, field)).toBe("previz.viewport.pathSpeed");
    expect(field).toHaveAttribute("data-slot", "input");
    expect(field).toHaveValue(1.4);

    await user.clear(field);
    await user.type(field, "3");
    // 和间距同一套：失焦才交出去，不然 "0.5" 会在打到 "0." 时先被当成 0。
    expect(handlers.onPathSpeed).not.toHaveBeenCalled();
    await user.tab();

    expect(handlers.onPathSpeed).toHaveBeenLastCalledWith(3);
    expectOnly(handlers, "onPathSpeed");
  });

  it("undoes without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: true, canRedo: false });

    expect(button("previz.viewport.redo")).toBeDisabled();
    const undo = button("previz.viewport.undo");
    expect(undo).toBeEnabled();
    await user.click(undo);

    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onUndo");
  });

  it("redoes without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: false, canRedo: true });

    expect(button("previz.viewport.undo")).toBeDisabled();
    const redo = button("previz.viewport.redo");
    expect(redo).toBeEnabled();
    await user.click(redo);

    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onRedo");
  });

  it("does not fire undo while there is nothing to undo", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: false, canRedo: false });

    await user.click(button("previz.viewport.undo"));
    await user.click(button("previz.viewport.redo"));

    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(handlers.onRedo).not.toHaveBeenCalled();
  });

  // 图标是这些按钮对鼠标用户的全部身份，提示是唯一的文字解释——两样都得逐个锁住。
  it.each([
    ["previz.viewport.undo", "lucide-undo-2"],
    ["previz.viewport.redo", "lucide-redo-2"],
    ["previz.viewport.display.solid", "lucide-cuboid"],
    ["previz.viewport.display.translucent", "lucide-blend"],
    ["previz.viewport.display.clay", "lucide-shapes"],
    ["previz.viewport.resetView", "lucide-rotate-ccw"],
  ])("labels the %s button with its own icon and tooltip", async (name, icon) => {
    const user = userEvent.setup();
    setup();

    const control = button(name);
    expect(await tooltipOf(user, control)).toBe(name);
    expect(control.querySelector("svg")).toHaveClass(icon);
  });

  // 撤销到底之后按钮是灰的，而「为什么灰」只写在提示里——禁用的按钮浏览器不再派发
  // hover，提示得由外面那层包装触发。少了那层，用户面前只剩一颗没有解释的灰按钮。
  it("still explains the undo button while it is disabled", async () => {
    const user = userEvent.setup();
    setup({ canUndo: false });

    const undo = button("previz.viewport.undo");
    expect(undo).toBeDisabled();
    expect(await tooltipOf(user, undo)).toBe("previz.viewport.undo");
  });

  it.each(DISPLAY_MODES)("asks for the %s display mode when that chip is clicked", async (mode) => {
    const user = userEvent.setup();
    // 每条都从别的模式出发，免得「点了当前项」这种无操作也算通过。
    const handlers = setup({ displayMode: mode === "clay" ? "solid" : "clay" });

    await user.click(button(`previz.viewport.display.${mode}`));

    expect(handlers.onDisplayMode).toHaveBeenCalledTimes(1);
    expect(handlers.onDisplayMode).toHaveBeenCalledWith(mode);
    expectOnly(handlers, "onDisplayMode");
  });

  it.each(DISPLAY_MODES)("marks %s as current and the other display chips as not", (mode) => {
    setup({ displayMode: mode });

    for (const candidate of DISPLAY_MODES) {
      expect(button(`previz.viewport.display.${candidate}`)).toHaveAttribute(
        "aria-pressed",
        candidate === mode ? "true" : "false",
      );
    }
  });

  // 三个模式「有哪几个、按什么顺序」是用户直接看到的东西：只逐个断言「每个都在」的话，
  // 多长一个或换个先后顺序都是全绿。重置视角排在它们后面，隔着一条分隔线。
  it("lists the three display modes in order, then reset view", () => {
    setup();

    const cluster = within(screen.getByRole("group", { name: "previz.viewport.group.display" }));
    const expected = [
      ...DISPLAY_MODES.map((mode) => `previz.viewport.display.${mode}`),
      "previz.viewport.resetView",
    ];
    expect(
      cluster.getAllByRole("button").map((control) => control.getAttribute("aria-label")),
    ).toEqual(expected);
  });

  it("resets the view without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button("previz.viewport.resetView"));

    expect(handlers.onResetView).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onResetView");
  });

  // 显示模式与重置视角跟撤销栈无关，不该被顺手一起禁掉。
  it("keeps the display cluster usable with an empty undo stack", () => {
    setup({ canUndo: false, canRedo: false });

    for (const mode of DISPLAY_MODES) {
      expect(button(`previz.viewport.display.${mode}`)).toBeEnabled();
    }
    expect(button("previz.viewport.resetView")).toBeEnabled();
  });

  // 六颗球是六个真按钮：键盘要 Tab 得过去，读屏要念得出「顶视图」。画成 SVG 图形的话
  // 这两样一起没。
  it("offers one clickable dot per half axis", () => {
    setup();

    for (const direction of VIEW_DIRECTIONS) {
      expect(button(`previz.viewport.view.${direction}`)).toBeEnabled();
    }
  });

  // 正半轴带字母、负半轴空着，是「现在看的是顶还是底」的唯一线索——两边都画成实心球
  // 的话顶视图与底视图长得一模一样。
  it("letters the positive half axes and leaves the negative ones bare", () => {
    setup();

    expect(button("previz.viewport.view.right")).toHaveTextContent("X");
    expect(button("previz.viewport.view.top")).toHaveTextContent("Y");
    expect(button("previz.viewport.view.front")).toHaveTextContent("Z");
    for (const direction of ["left", "bottom", "back"] as const) {
      expect(button(`previz.viewport.view.${direction}`)).toHaveTextContent("");
    }
  });

  it.each(VIEW_DIRECTIONS)("switches to the %s view when that dot is clicked", async (direction) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.viewport.view.${direction}`));

    expect(handlers.onViewDirection).toHaveBeenCalledTimes(1);
    expect(handlers.onViewDirection).toHaveBeenCalledWith(direction);
    expectOnly(handlers, "onViewDirection");
  });

  /*
    小球的全部意义是「报告现在从哪个方向在看」：不跟着相机转的话它就只是一张贴纸，
    而贴纸会把用户往反方向带。这里推一次新视角，看六颗球有没有跟着挪。
  */
  it("follows the camera as it orbits", () => {
    const view = makeViewSource(FRONT_VIEW);
    setup({ view: view.source });

    // 正对 +Z：Z 压在正中，X 甩到正右。
    expect(dotAt("front")).toEqual({ left: `${CENTRE_PX}px`, top: `${CENTRE_PX}px` });
    expect(dotAt("right")).toEqual({ left: `${CENTRE_PX + ORBIT_PX}px`, top: `${CENTRE_PX}px` });

    view.moveTo(RIGHT_VIEW);

    // 转到从 +X 看过去：换成 X 压在正中，Z 落到左边。
    expect(dotAt("right")).toEqual({ left: `${CENTRE_PX}px`, top: `${CENTRE_PX}px` });
    expect(dotAt("front")).toEqual({ left: `${CENTRE_PX - ORBIT_PX}px`, top: `${CENTRE_PX}px` });
  });

  // 六颗球按由远及近渲染，近的靠 DOM 次序盖住远的（没有 z-index）。次序反了的话背面
  // 那颗会浮在正面那颗上头，看着就是在看背面。
  it("paints the far dots before the near ones", () => {
    setup();

    const order = screen
      .getAllByRole("button")
      .filter((control) => control.textContent === "Z" || control.getAttribute("aria-label") === "previz.viewport.view.back")
      .map((control) => control.getAttribute("aria-label"));
    expect(order).toEqual(["previz.viewport.view.back", "previz.viewport.view.front"]);
  });

  it("focuses the selection without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup({ hasSelection: true });

    const focus = button("previz.viewport.focus");
    expect(focus).toBeEnabled();
    // 能用的时候提示说的就是它自己，不是那句「先选中一个对象」。
    expect(await tooltipOf(user, focus)).toBe("previz.viewport.focus");

    await user.click(focus);

    expect(handlers.onFocus).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onFocus");
  });

  // 没选中东西时「聚焦」无从聚起，禁用比点了没反应清楚——但光禁用不说原因就只剩一个
  // 灰按钮，所以提示得换成解释。
  it("disables focus and explains why when nothing is selected", async () => {
    const user = userEvent.setup();
    const handlers = setup({ hasSelection: false });

    const focus = button("previz.viewport.focus");
    expect(focus).toBeDisabled();
    expect(await tooltipOf(user, focus)).toBe("previz.viewport.focusHint");

    await user.click(focus);
    expect(handlers.onFocus).not.toHaveBeenCalled();

    // 切视角跟选中态无关，不该被顺手一起禁掉。
    expect(button("previz.viewport.view.top")).toBeEnabled();
  });

  // 同一颗按钮既开也关。两个方向都得测：只测「开」的话，把关那半接成空函数照样绿，
  // 而那正好是「开出来之后再也关不掉」这个最难受的坏法。
  it.each([
    { quadView: false, next: true },
    { quadView: true, next: false },
  ])("toggles the quad view from $quadView", async ({ quadView, next }) => {
    const user = userEvent.setup();
    const handlers = setup({ quadView });

    const toggle = button("previz.viewport.quadView");
    expect(toggle).toHaveAttribute("aria-pressed", String(quadView));

    await user.click(toggle);

    expect(handlers.onQuadView).toHaveBeenCalledTimes(1);
    expect(handlers.onQuadView).toHaveBeenCalledWith(next);
    expectOnly(handlers, "onQuadView");
  });
});
