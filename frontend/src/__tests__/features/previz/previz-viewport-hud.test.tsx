// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  PrevizViewportHud,
  type PrevizViewportHudProps,
} from "@/features/previz/ui/PrevizViewportHud";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 三组枚举与六个方向都写成字面量：跟着被测模块一起变的期望值等于没有期望值。 */
const DISPLAY_MODES = ["solid", "translucent", "clay"] as const;
const GIZMO_MODES = ["translate", "rotate", "scale"] as const;
const OUTPUT_ASPECTS = ["16:9", "9:16", "1:1", "4:3"] as const;
const VIEW_DIRECTIONS = ["front", "back", "left", "right", "top", "bottom"] as const;

/**
 * 只有取值型的 prop 走 overrides，回调一律由 setup 自己造并原样返回：`...Partial<Props>`
 * 展开之后每个回调都会被推成 `Mock | ((...) => void)`，`mockClear()` 之类就调不动了。
 */
type HudOverrides = Partial<
  Pick<PrevizViewportHudProps, "displayMode" | "outputAspect" | "gizmoMode" | "hasSelection">
>;

function makeHandlers() {
  return {
    onDisplayMode: vi.fn<PrevizViewportHudProps["onDisplayMode"]>(),
    onOutputAspect: vi.fn<PrevizViewportHudProps["onOutputAspect"]>(),
    onGizmoMode: vi.fn<PrevizViewportHudProps["onGizmoMode"]>(),
    onViewDirection: vi.fn<PrevizViewportHudProps["onViewDirection"]>(),
    onFocus: vi.fn<PrevizViewportHudProps["onFocus"]>(),
    onResetView: vi.fn<PrevizViewportHudProps["onResetView"]>(),
  };
}

type Handlers = ReturnType<typeof makeHandlers>;

/**
 * 三个枚举的默认值刻意落在互不相同的序号上——displayMode 取第 2 个、gizmoMode 取第 3 个、
 * outputAspect 取第 4 个。若某一组的选中态读串了另一组的 prop，取值相同的夹具会让这类
 * 交叉读取全程隐形。
 */
function setup(overrides: HudOverrides = {}): Handlers {
  const handlers = makeHandlers();
  const props: PrevizViewportHudProps = {
    displayMode: "translucent",
    outputAspect: "4:3",
    gizmoMode: "scale",
    hasSelection: true,
    ...overrides,
    ...handlers,
  };
  render(<PrevizViewportHud {...props} />);
  return handlers;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function aspectSelect(): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>("previz.hud.outputAspect");
}

/** 一次交互只该惊动一个回调；缺了这条，把两个 handler 接反了照样全绿。 */
function expectOnly(handlers: Handlers, called: keyof Handlers): void {
  for (const [name, mock] of Object.entries(handlers)) {
    if (name === called) continue;
    expect(mock, `${name} should not have fired`).not.toHaveBeenCalled();
  }
}

describe("PrevizViewportHud", () => {
  it("fires nothing just by rendering", () => {
    const handlers = setup();

    for (const mock of Object.values(handlers)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it.each(DISPLAY_MODES)("asks for the %s display mode when that chip is clicked", async (mode) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.hud.display.${mode}`));

    expect(handlers.onDisplayMode).toHaveBeenCalledTimes(1);
    expect(handlers.onDisplayMode).toHaveBeenCalledWith(mode);
    expectOnly(handlers, "onDisplayMode");
  });

  it.each(DISPLAY_MODES)("marks %s as current and the other display chips as not", (mode) => {
    setup({ displayMode: mode });

    for (const candidate of DISPLAY_MODES) {
      expect(button(`previz.hud.display.${candidate}`)).toHaveAttribute(
        "aria-pressed",
        candidate === mode ? "true" : "false",
      );
    }
  });

  it.each(GIZMO_MODES)("asks for the %s gizmo when that chip is clicked", async (mode) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.hud.gizmo.${mode}`));

    expect(handlers.onGizmoMode).toHaveBeenCalledTimes(1);
    expect(handlers.onGizmoMode).toHaveBeenCalledWith(mode);
    expectOnly(handlers, "onGizmoMode");
  });

  it.each(GIZMO_MODES)("marks %s as current and the other gizmo chips as not", (mode) => {
    setup({ gizmoMode: mode });

    for (const candidate of GIZMO_MODES) {
      expect(button(`previz.hud.gizmo.${candidate}`)).toHaveAttribute(
        "aria-pressed",
        candidate === mode ? "true" : "false",
      );
    }
  });

  // 两组 chip 的选中态各读各的 prop：显示模式取第 1 个、手柄模式取第 3 个，
  // 任何一边读了另一边的 state，这里都会同时看到两个 false。
  it("reads each toggle group's pressed state off its own prop", () => {
    setup({ displayMode: "solid", gizmoMode: "scale" });

    expect(button("previz.hud.display.solid")).toHaveAttribute("aria-pressed", "true");
    expect(button("previz.hud.display.clay")).toHaveAttribute("aria-pressed", "false");
    expect(button("previz.hud.gizmo.scale")).toHaveAttribute("aria-pressed", "true");
    expect(button("previz.hud.gizmo.translate")).toHaveAttribute("aria-pressed", "false");
  });

  it.each(VIEW_DIRECTIONS)("aims the camera %s when that view button is clicked", async (direction) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.hud.view.${direction}`));

    expect(handlers.onViewDirection).toHaveBeenCalledTimes(1);
    expect(handlers.onViewDirection).toHaveBeenCalledWith(direction);
    expectOnly(handlers, "onViewDirection");
  });

  // 正交视图不依赖选中态，跟着「聚焦」一起被禁掉就没法看空场景的布局了。
  it("keeps all six view directions available with nothing selected", () => {
    setup({ hasSelection: false });

    for (const direction of VIEW_DIRECTIONS) {
      expect(button(`previz.hud.view.${direction}`)).toBeEnabled();
    }
  });

  it("focuses the selection without disturbing the rest of the hud", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    const focus = button("previz.hud.focus");
    expect(focus).toBeEnabled();
    // 能用的时候 tooltip 说的就是它自己，不是那句「先选中一个对象」。
    expect(focus).toHaveAttribute("title", "previz.hud.focus");

    await user.click(focus);

    expect(handlers.onFocus).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onFocus");
  });

  it("resets the view without disturbing the rest of the hud", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button("previz.hud.resetView"));

    expect(handlers.onResetView).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onResetView");
  });

  // 没选中东西时「聚焦」无从聚起，禁用比点了没反应清楚——但光禁用不说原因就只剩
  // 一个灰按钮，所以 title 得换成解释。
  it("disables focus and explains why when nothing is selected", async () => {
    const user = userEvent.setup();
    const handlers = setup({ hasSelection: false });

    const focus = button("previz.hud.focus");
    expect(focus).toBeDisabled();
    expect(focus).toHaveAttribute("title", "previz.hud.focusHint");

    await user.click(focus);
    expect(handlers.onFocus).not.toHaveBeenCalled();

    // 重置视角与选中态无关，不该被顺手一起禁掉。
    expect(button("previz.hud.resetView")).toBeEnabled();
  });

  it("lists exactly the four output aspects and shows the current one", () => {
    setup();

    const select = aspectSelect();
    expect(select).toHaveValue("4:3");
    expect([...select.options].map((option) => option.value)).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
    ]);
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
    ]);
  });

  /**
   * `from` 与 `to` 成对给：原生 select 选中已选项不会触发 change，所以每条都必须从
   * 别的画幅出发。四条合起来让四个画幅各当过一次目标。
   */
  const ASPECT_STEPS = [
    { from: "1:1", to: "16:9" },
    { from: "16:9", to: "9:16" },
    { from: "9:16", to: "1:1" },
    { from: "16:9", to: "4:3" },
  ] as const satisfies ReadonlyArray<{
    from: (typeof OUTPUT_ASPECTS)[number];
    to: (typeof OUTPUT_ASPECTS)[number];
  }>;

  it.each(ASPECT_STEPS)("switches the output aspect from $from to $to", async ({ from, to }) => {
    const user = userEvent.setup();
    const handlers = setup({ outputAspect: from });

    const select = aspectSelect();
    expect(select).toHaveValue(from);

    await user.selectOptions(select, to);

    expect(handlers.onOutputAspect).toHaveBeenCalledTimes(1);
    expect(handlers.onOutputAspect).toHaveBeenCalledWith(to);
    expectOnly(handlers, "onOutputAspect");
  });
});
