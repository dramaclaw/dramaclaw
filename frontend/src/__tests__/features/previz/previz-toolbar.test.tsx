// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PrevizToolbar } from "@/features/previz/ui/PrevizToolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 带值的 key 拼成 `key:{...}`，好让下面那条断言看得见插进去的上限数字。
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

type ToolbarProps = ComponentProps<typeof PrevizToolbar>;

/**
 * 上限写成字面量而不是 import `PREVIZ_OBJECT_LIMITS`：跟着被测模块一起变的断言
 * 等于没有断言。icon class 是 lucide 给每个图标挂的稳定类名——这条菜单列上的按钮
 * 只有图标没有可见文字，图标就是它们对用户的全部身份，所以也得逐个锁住。
 */
const KINDS = [
  { kind: "character", limit: 50, icon: "lucide-user" },
  { kind: "camera", limit: 30, icon: "lucide-camera" },
  { kind: "light", limit: 12, icon: "lucide-lightbulb" },
  { kind: "prop", limit: 20, icon: "lucide-box" },
] as const;

/** 三组枚举与六个方向都写成字面量，理由同上。 */
const TOOLS = ["select", "draw"] as const;
const GIZMO_MODES = ["translate", "rotate", "scale"] as const;
const VIEW_DIRECTIONS = ["front", "back", "left", "right", "top", "bottom"] as const;

function canAddExcept(atLimit: string): ToolbarProps["canAdd"] {
  return {
    character: atLimit !== "character",
    camera: atLimit !== "camera",
    light: atLimit !== "light",
    prop: atLimit !== "prop",
  };
}

/**
 * 回调不进 overrides：`...Partial<ToolbarProps>` 展开会把每个 handler 的类型拓宽成
 * `Mock | ((...) => void)`，之后取 `.mock` / `.mockClear()` 就过不了类型检查。只让状态类
 * prop 可覆盖，mock 原样返回，类型就保得住。
 */
type ToolbarOverrides = Partial<
  Pick<ToolbarProps, "canAdd" | "gizmoMode" | "tool" | "timelineOpen">
>;

function makeHandlers() {
  return {
    onAdd: vi.fn<ToolbarProps["onAdd"]>(),
    onImportProp: vi.fn<ToolbarProps["onImportProp"]>(),
    onGizmoMode: vi.fn<ToolbarProps["onGizmoMode"]>(),
    onTool: vi.fn<ToolbarProps["onTool"]>(),
    onTimelineOpen: vi.fn<ToolbarProps["onTimelineOpen"]>(),
  };
}

type Handlers = ReturnType<typeof makeHandlers>;

/**
 * 两个枚举的默认值刻意落在不同的序号上——tool 取第 2 个、gizmoMode 取第 3 个。若某一组
 * 的选中态读串了另一组的 prop，取值相同的夹具会让这类交叉读取全程隐形。
 */
function makeProps(overrides: ToolbarOverrides, handlers: Handlers): ToolbarProps {
  return {
    canAdd: { character: true, camera: true, light: true, prop: true },
    gizmoMode: "scale",
    tool: "draw",
    timelineOpen: true,
    ...overrides,
    ...handlers,
  };
}

function setup(overrides: ToolbarOverrides = {}): Handlers {
  const handlers = makeHandlers();
  render(<PrevizToolbar {...makeProps(overrides, handlers)} />);
  return handlers;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * 悬停一个控件，读出弹出来的提示文字，再挪开。
 *
 * 这条竖栏上的控件只有图标没有可见文字，提示是鼠标用户读出「这颗按钮是干什么的」的
 * 唯一渠道（aria-label 只服务读屏）。提示渲在 portal 里，按名字是查不到的，只能顺着
 * 设计系统给的 `data-slot` 找；离开之后才卸掉，所以出场也得等一等——不等的话下一条
 * 断言会读到上一颗按钮还没收走的那条提示。
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

/** 每一段控件各有 `role="group"` 与一个名字，组内查询一律从这里出发。 */
function groupNamed(label: string): ReturnType<typeof within> {
  return within(screen.getByRole("group", { name: label }));
}

/** `screen` 与 `within(...)` 的公共子集，让下面那条断言既能查全屏也能查一组之内。 */
type RoleScope = Pick<typeof screen, "queryAllByRole" | "getByRole">;

/**
 * 拿「按名字取到的元素序列」跟「实际的元素序列」逐位比，而不是自己从 aria-label 或文本
 * 里拼名字：可访问名怎么算交给 getByRole，测试就不会被「名字改从 title 来」这类对用户
 * 无感的改动误伤，而少一个、多一个、换个先后顺序照样红。
 *
 * `queryAllByRole` 而不是 `getAllByRole`：`names` 传空数组时要能表达「这里一个都不该有」，
 * 而 getAllBy 在零命中时是抛异常。
 */
function expectInOrder(
  scope: RoleScope,
  role: "button" | "group" | "menuitem",
  names: readonly string[],
): void {
  const actual = scope.queryAllByRole(role);
  const expected = names.map((name) => scope.getByRole(role, { name }));

  expect(actual.length, `should hold exactly: ${names.join(", ") || "(nothing)"}`).toBe(names.length);
  actual.forEach((element, index) => {
    expect(element, `${role} #${index} should be ${names[index]}`).toBe(expected[index]);
  });
}

/** 一次交互只该惊动一个回调；缺了这条，把两个 handler 接反了照样全绿。 */
function expectOnly(handlers: Handlers, called: keyof Handlers): void {
  for (const [name, mock] of Object.entries(handlers)) {
    if (name === called) continue;
    expect(mock, `${name} should not have fired`).not.toHaveBeenCalled();
  }
}

describe("PrevizToolbar", () => {
  it("fires nothing just by rendering", () => {
    const handlers = setup();

    for (const mock of Object.values(handlers)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  // 三段的上下次序是用户一眼看到的布局，而段与段之间没有任何按钮名字能表达它：
  // 把手柄那段整个挪到创建前面，下面每一条「段内顺序」用例都照样全绿。
  it("lays the three rail groups out in order", () => {
    setup();

    expectInOrder(screen, "group", [
      "previz.toolbar.group.create",
      "previz.toolbar.group.tool",
      "previz.toolbar.group.gizmo",
    ]);
  });

  // 撤销重做、显示模式、重置视角、轨迹点间距、切视角与聚焦都搬去了视口自己那两角
  // （`PrevizViewportControls`），出片画幅搬去了监看画中画（`PrevizMonitorFrame`）。这里
  // 挡的是「搬完之后栏上又长回来一份」：同一个功能两处各一份，用户按哪一颗都对，但两边
  // 的选中态各画各的，很快就对不上。
  it("leaves the relocated controls out of the rail", () => {
    setup();

    expect(screen.queryByLabelText("previz.toolbar.outputAspect")).toBeNull();
    expect(screen.queryByLabelText("previz.toolbar.pathSpacing")).toBeNull();
    expect(screen.queryByRole("group", { name: "previz.toolbar.group.aspect" })).toBeNull();
    expect(screen.queryByRole("group", { name: "previz.toolbar.group.view" })).toBeNull();
    // 六个方向原先收在一层 role="menu" 的浮层里，整层都该跟着走。
    expect(screen.queryByRole("menu")).toBeNull();

    for (const name of [
      "previz.toolbar.undo",
      "previz.toolbar.redo",
      "previz.toolbar.resetView",
      "previz.viewport.undo",
      "previz.viewport.redo",
      "previz.viewport.resetView",
      "previz.toolbar.display.solid",
      "previz.viewport.display.solid",
      "previz.toolbar.viewMenu",
      "previz.toolbar.focus",
      "previz.viewport.focus",
      "previz.viewport.quadView",
      ...VIEW_DIRECTIONS.flatMap((direction) => [
        `previz.toolbar.view.${direction}`,
        `previz.viewport.view.${direction}`,
      ]),
    ]) {
      expect(screen.queryByRole("button", { name }), name).toBeNull();
    }
  });

  it.each(KINDS)("offers an enabled create button for $kind", async ({ kind, icon }) => {
    const user = userEvent.setup();
    setup();

    const control = button(`previz.toolbar.add.${kind}`);
    expect(control).toBeEnabled();
    expect(await tooltipOf(user, control)).toBe(`previz.toolbar.add.${kind}`);
    expect(control.querySelector("svg")).toHaveClass(icon);
  });

  it.each(KINDS)("calls onAdd with $kind when that button is clicked", async ({ kind }) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.toolbar.add.${kind}`));

    expect(handlers.onAdd).toHaveBeenCalledTimes(1);
    expect(handlers.onAdd).toHaveBeenCalledWith(kind);
    expectOnly(handlers, "onAdd");
  });

  // 到上限时静默失败最气人：按钮看着能点，点了什么都不发生。禁用之外还得说清
  // 为什么禁用——一个灰掉且没有解释的按钮同样让人摸不着头脑。
  it.each(KINDS)("disables the $kind button at its limit and says why", async ({ kind, limit }) => {
    const user = userEvent.setup();
    setup({ canAdd: canAddExcept(kind) });

    const control = button(`previz.toolbar.add.${kind}`);
    expect(control).toBeDisabled();
    // 禁用的按钮浏览器不再往它派发 hover，提示得由外面那层包装触发——这条正是钉住
    // 那层包装的：少了它，用户面前只剩一颗没有解释的灰按钮。
    expect(await tooltipOf(user, control)).toBe(
      `previz.toolbar.limitReached:{"count":${limit}}`,
    );

    // 别的类型不受牵连——不然「全部禁用」也能骗过上面两条。
    for (const other of KINDS) {
      if (other.kind === kind) continue;
      expect(button(`previz.toolbar.add.${other.kind}`)).toBeEnabled();
    }
  });

  // 同 KINDS 那条的理由：这一条竖栏上的控件全都只有图标，没有可见文字。图标画错、
  // tooltip 丢了，鼠标用户就再也读不出这个按钮是干什么的，而 aria-label 只服务读屏。
  it.each([
    ["previz.toolbar.tool.select", "lucide-mouse-pointer-2"],
    ["previz.toolbar.tool.draw", "lucide-pen-line"],
    ["previz.toolbar.gizmo.translate", "lucide-move-3d"],
    ["previz.toolbar.gizmo.rotate", "lucide-rotate-3d"],
    ["previz.toolbar.gizmo.scale", "lucide-scaling"],
  ])("labels the %s button with its own icon and tooltip", async (name, icon) => {
    const user = userEvent.setup();
    setup();

    const control = button(name);
    expect(await tooltipOf(user, control)).toBe(name);
    expect(control.querySelector("svg")).toHaveClass(icon);
  });

  it("labels the import control with its own icon and tooltip", async () => {
    const user = userEvent.setup();
    setup();

    // 视觉控件是 <label>，input 本身是 sr-only 的：提示要挂在看得见的那个上面。
    const input = screen.getByLabelText<HTMLInputElement>("previz.toolbar.importProp");
    const importControl = input.labels?.[0];
    expect(importControl).toBeTruthy();
    expect(importControl?.querySelector("svg")).toHaveClass("lucide-upload");
    expect(await tooltipOf(user, importControl as HTMLElement)).toBe("previz.toolbar.importProp");
  });

  it("hands the picked file to onImportProp", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const file = new File([new Uint8Array(1)], "chair.glb");

    const input = screen.getByLabelText("previz.toolbar.importProp");
    await user.upload(input, file);

    expect(handlers.onImportProp).toHaveBeenCalledWith(file);
    // toHaveBeenCalledWith 对 File 走结构化相等，换成另一个 File 照样绿。要锁住「转发的
    // 是用户挑的那一个」，只能比引用同一性。
    expect(handlers.onImportProp.mock.calls[0]?.[0]).toBe(file);
    // value 必须被清空，否则用户第二次挑同一个文件浏览器不会再发 change。
    expect(input).toHaveValue("");
  });

  it("offers the import control only for the three loadable model formats", () => {
    setup();

    expect(screen.getByLabelText("previz.toolbar.importProp")).toHaveAttribute(
      "accept",
      ".glb,.gltf,.obj",
    );
  });

  it("lays the tool group out in order", () => {
    setup();

    expectInOrder(groupNamed("previz.toolbar.group.tool"), "button", [
      "previz.toolbar.tool.select",
      "previz.toolbar.tool.draw",
    ]);
  });

  it("reads the tool group's pressed state off its own prop", () => {
    setup({ tool: "select" });

    expect(button("previz.toolbar.tool.select")).toHaveAttribute("aria-pressed", "true");
    expect(button("previz.toolbar.tool.draw")).toHaveAttribute("aria-pressed", "false");
  });

  it.each(TOOLS)("switches to the %s tool", async (option) => {
    const user = userEvent.setup();
    // 每条都从另一个工具出发，免得「点了当前项」这种无操作也算通过。
    const handlers = setup({ tool: option === "select" ? "draw" : "select" });

    await user.click(button(`previz.toolbar.tool.${option}`));

    expect(handlers.onTool).toHaveBeenCalledWith(option);
    expectOnly(handlers, "onTool");
  });

  it.each(GIZMO_MODES)("asks for the %s gizmo when that chip is clicked", async (mode) => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button(`previz.toolbar.gizmo.${mode}`));

    expect(handlers.onGizmoMode).toHaveBeenCalledTimes(1);
    expect(handlers.onGizmoMode).toHaveBeenCalledWith(mode);
    expectOnly(handlers, "onGizmoMode");
  });

  it.each(GIZMO_MODES)("marks %s as current and the other gizmo chips as not", (mode) => {
    setup({ gizmoMode: mode });

    for (const candidate of GIZMO_MODES) {
      expect(button(`previz.toolbar.gizmo.${candidate}`)).toHaveAttribute(
        "aria-pressed",
        candidate === mode ? "true" : "false",
      );
    }
  });

  // 段里「有哪几个、按什么顺序」是用户直接看到的东西，跟画幅下拉一样得整段钉死：
  // 只逐个断言「每个都在」的话，多长一个按钮或换个先后顺序都是全绿。
  it("lists exactly the three gizmo modes in order", () => {
    setup();

    expectInOrder(groupNamed("previz.toolbar.group.gizmo"), "button", [
      "previz.toolbar.gizmo.translate",
      "previz.toolbar.gizmo.rotate",
      "previz.toolbar.gizmo.scale",
    ]);
  });

  // 两组按钮的选中态各读各的 prop：手柄模式取第 3 个、工具取第 1 个，任何一边读了
  // 另一边的 state，这里都会看到一个本该 true 的 false。
  it("reads each toggle group's pressed state off its own prop", () => {
    setup({ gizmoMode: "scale", tool: "select" });

    expect(button("previz.toolbar.gizmo.scale")).toHaveAttribute("aria-pressed", "true");
    expect(button("previz.toolbar.gizmo.translate")).toHaveAttribute("aria-pressed", "false");
    expect(button("previz.toolbar.tool.select")).toHaveAttribute("aria-pressed", "true");
  });

  // 同一颗按钮既收也展。两个方向都得测：只测「收」的话，把展开那半接成空函数照样绿，
  // 而那正好是「收起来之后再也开不回来」这个最难受的坏法。
  it.each([
    { open: true, label: "previz.toolbar.collapseTimeline", icon: "lucide-panel-bottom-close", next: false },
    { open: false, label: "previz.toolbar.expandTimeline", icon: "lucide-panel-bottom-open", next: true },
  ])("toggles the timeline panel from $label", async ({ open, label, icon, next }) => {
    const user = userEvent.setup();
    const handlers = setup({ timelineOpen: open });

    const toggle = screen.getByTestId("previz-timeline-toggle");
    expect(toggle).toHaveAccessibleName(label);
    expect(await tooltipOf(user, toggle)).toBe(label);
    expect(toggle).toHaveAttribute("aria-expanded", String(open));
    expect(toggle.querySelector("svg")).toHaveClass(icon);

    await user.click(toggle);

    expect(handlers.onTimelineOpen).toHaveBeenCalledWith(next);
    expectOnly(handlers, "onTimelineOpen");
  });
});
