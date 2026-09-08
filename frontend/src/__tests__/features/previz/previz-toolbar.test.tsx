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

/** 两段工具与六个方向都写成字面量，理由同上。 */
const POINTER_TOOLS = ["select", "navigate", "draw", "mark"] as const;
const TRANSFORM_TOOLS = ["translate", "rotate", "scale"] as const;
/** 栏上从上到下的实际顺序；互斥性的断言要拿整条列表去比，不能只比其中一段。 */
const TOOLS = [...POINTER_TOOLS, ...TRANSFORM_TOOLS] as const;
/**
 * 工具名到可访问名字的映射写死在这里。前四个在 `tool.` 下、后三个仍在 `gizmo.` 下：
 * 七颗按钮合成一条互斥列表这件事不动任何一条 i18n 键，这份字面量把这一点也钉住。
 */
const TOOL_LABELS: Record<(typeof TOOLS)[number], string> = {
  select: "previz.toolbar.tool.select",
  navigate: "previz.toolbar.tool.navigate",
  draw: "previz.toolbar.tool.draw",
  mark: "previz.toolbar.tool.mark",
  translate: "previz.toolbar.gizmo.translate",
  rotate: "previz.toolbar.gizmo.rotate",
  scale: "previz.toolbar.gizmo.scale",
};
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
type ToolbarOverrides = Partial<Pick<ToolbarProps, "canAdd" | "tool" | "timelineOpen">>;

function makeHandlers() {
  return {
    onAdd: vi.fn<ToolbarProps["onAdd"]>(),
    onImportProp: vi.fn<ToolbarProps["onImportProp"]>(),
    onTool: vi.fn<ToolbarProps["onTool"]>(),
    onTimelineOpen: vi.fn<ToolbarProps["onTimelineOpen"]>(),
  };
}

type Handlers = ReturnType<typeof makeHandlers>;

/**
 * 默认工具刻意不落在两段的头一个上（取的是第二段之外的 navigate）：夹具要是恰好落在
 * 某段的首项，「按下态读串了另一段」这类错法会被一个碰巧相同的取值遮住。
 */
function makeProps(overrides: ToolbarOverrides, handlers: Handlers): ToolbarProps {
  return {
    canAdd: { character: true, camera: true, light: true, prop: true },
    tool: "navigate",
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
      "previz.editor.undo",
      "previz.editor.redo",
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
  // 标记轨迹的提示不是名字本身而是用法：光一个「标记轨迹」看不出要逐点单击、按 Esc 收手。
  it.each([
    ["previz.toolbar.tool.select", "lucide-mouse-pointer-2", "previz.toolbar.tool.select"],
    ["previz.toolbar.tool.navigate", "lucide-orbit", "previz.toolbar.tool.navigate"],
    ["previz.toolbar.tool.draw", "lucide-pen-line", "previz.toolbar.tool.draw"],
    ["previz.toolbar.tool.mark", "lucide-waypoints", "previz.toolbar.markHint"],
    ["previz.toolbar.gizmo.translate", "lucide-move-3d", "previz.toolbar.gizmo.translate"],
    ["previz.toolbar.gizmo.rotate", "lucide-rotate-3d", "previz.toolbar.gizmo.rotate"],
    ["previz.toolbar.gizmo.scale", "lucide-scaling", "previz.toolbar.gizmo.scale"],
  ])("labels the %s button with its own icon and tooltip", async (name, icon, tip) => {
    const user = userEvent.setup();
    setup();

    const control = button(name);
    expect(await tooltipOf(user, control)).toBe(tip);
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
      "previz.toolbar.tool.navigate",
      "previz.toolbar.tool.draw",
      "previz.toolbar.tool.mark",
    ]);
  });

  /*
    栏上原先在显示两个互不相干的 state（工具一份、手柄模式一份），各算各的按下态，
    于是 W 和 R 永远同时亮着。七颗按钮现在是一条互斥列表：逐个取值走一遍，每一遍都
    要求「这一颗亮、另外六颗灭」，并且整条栏子上按下的按钮总数恰好是 1。

    最后那句 `pressed: true` 的计数不能省：只逐颗比 aria-pressed 的话，把某一段重新
    接回一份独立的 state 仍然可能让这七条各自全绿，而多亮出来的那颗恰恰在别处。
  */
  it.each(TOOLS)("lights %s alone across the whole rail", (current) => {
    setup({ tool: current });

    for (const candidate of TOOLS) {
      const why = `${candidate} while ${current} is active`;
      expect(button(TOOL_LABELS[candidate]), why).toHaveAttribute(
        "aria-pressed",
        candidate === current ? "true" : "false",
      );
    }
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(1);
  });

  it.each(TOOLS)("switches to the %s tool", async (option) => {
    const user = userEvent.setup();
    // 每条都从另一个工具出发，免得「点了当前项」这种无操作也算通过。
    const handlers = setup({ tool: option === "select" ? "draw" : "select" });

    await user.click(button(TOOL_LABELS[option]));

    // G/R/S 现在交出去的也是 onTool：手柄模式不再是工具栏认识的概念，栏上只有一条
    // 工具列表，`onGizmoMode` 这个 prop 已经整个不存在了。
    expect(handlers.onTool).toHaveBeenCalledTimes(1);
    expect(handlers.onTool).toHaveBeenCalledWith(option);
    expectOnly(handlers, "onTool");
  });

  // 段里「有哪几个、按什么顺序」是用户直接看到的东西，跟画幅下拉一样得整段钉死：
  // 只逐个断言「每个都在」的话，多长一个按钮或换个先后顺序都是全绿。合并成一条互斥
  // 列表之后分段与分隔线照旧：变换那三颗跟指针工具混排的话，用户再也认不出「按了它
  // 视口里会多出一副手柄」这条界。
  it("lists exactly the three transform tools in order", () => {
    setup();

    expectInOrder(groupNamed("previz.toolbar.group.gizmo"), "button", [
      "previz.toolbar.gizmo.translate",
      "previz.toolbar.gizmo.rotate",
      "previz.toolbar.gizmo.scale",
    ]);
  });

  // 悬停提示曾是唯一念出 W/Q/G/R/S 的地方，鼠标不划过去就看不见。角标要把这五个键位
  // 画在按钮角上，并且写进 aria-keyshortcuts 给辅助技术读。`button(label)` 本身就是
  // 按可访问名字查询的，角标要是把名字带偏了这一步就先找不到按钮，用不着另开一条
  // 断言证明「名字没变」。
  it.each([
    ["previz.toolbar.tool.select", "W"],
    ["previz.toolbar.tool.navigate", "Q"],
    ["previz.toolbar.gizmo.translate", "G"],
    ["previz.toolbar.gizmo.rotate", "R"],
    ["previz.toolbar.gizmo.scale", "S"],
  ])("badges each shortcut on its button and exposes it as aria-keyshortcuts", (label, key) => {
    setup();

    const control = button(label);
    expect(control).toHaveAttribute("aria-keyshortcuts", key);
    const badge = within(control).getByText(key);
    expect(badge.tagName).toBe("KBD");
  });

  // 绘制与标记没有键位：不该无中生有画一个角标出来。
  it.each(["draw", "mark"])("draws no shortcut badge on the %s tool button", (option) => {
    setup();

    const control = button(`previz.toolbar.tool.${option}`);
    expect(control).not.toHaveAttribute("aria-keyshortcuts");
    expect(control.querySelector("kbd")).toBeNull();
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
