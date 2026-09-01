// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { PrevizObject } from "@/features/previz/domain/scene";
import {
  PrevizLayerPanel,
  type PrevizLayerPanelProps,
} from "@/features/previz/ui/PrevizLayerPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** 顺序即索引约定：0 人物 / 1 机位 / 2 灯光 / 3 物件。四类都要在，见「按类型」的几条用例。 */
function build(): PrevizObject[] {
  const objects: PrevizObject[] = [];
  objects.push(createPrevizObject("character", objects));
  objects.push(createPrevizObject("camera", objects));
  objects.push(createPrevizObject("light", objects));
  objects.push(createPrevizObject("prop", objects));
  return objects;
}

/**
 * 回调不走 overrides：从 setup 里原样返回才保得住 `Mock` 类型（`...Partial<Props>` 展开
 * 之后每个回调都会被推成 `Mock | ((id) => void)`，`mockClear` 之类就调不动了）。
 */
type PanelOverrides = Partial<Pick<PrevizLayerPanelProps, "objects" | "selectedId" | "activeCameraId">>;

function setup(overrides: PanelOverrides = {}) {
  const objects = overrides.objects ?? build();
  const handlers = {
    onSelect: vi.fn(),
    onToggleVisible: vi.fn(),
    onToggleLocked: vi.fn(),
    onRemove: vi.fn(),
    onSetActiveCamera: vi.fn(),
  };
  const props: PrevizLayerPanelProps = {
    selectedId: null,
    activeCameraId: null,
    ...overrides,
    ...handlers,
    objects,
  };
  render(<PrevizLayerPanel {...props} />);
  return { ...handlers, objects };
}

function row(id: string): HTMLElement {
  return screen.getByTestId(`previz-layer-${id}`);
}

function button(scope: HTMLElement, name: string): HTMLElement {
  return within(scope).getByRole("button", { name });
}

describe("PrevizLayerPanel", () => {
  it("lists every object by name inside a labelled listbox", () => {
    const { objects } = setup();

    // listbox 不是可有可无的包装：行上的 aria-selected 只有在 option 里才有含义，
    // 而 option 只有在 listbox 里才是 option。名字来自面板标题。
    expect(screen.getByRole("listbox", { name: "previz.layers.title" })).toBeInTheDocument();
    for (const object of objects) {
      expect(screen.getByText(object.name)).toBeInTheDocument();
    }
  });

  it("shows an empty hint when there is nothing yet", () => {
    setup({ objects: [] });

    expect(screen.getByText("previz.layers.empty")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // 四类各自一条断言：把某一类的分组标题写成另一类的 key，只有那一条会红。
  it("groups each object under a heading naming its own kind", () => {
    const { objects } = setup();
    const expected: ReadonlyArray<readonly [number, string]> = [
      [0, "previz.layers.kind.character"],
      [1, "previz.layers.kind.camera"],
      [2, "previz.layers.kind.light"],
      [3, "previz.layers.kind.prop"],
    ];

    for (const [index, label] of expected) {
      const group = screen.getByRole("group", { name: label });
      expect(within(group).getByTestId(`previz-layer-${objects[index]!.id}`)).toBeInTheDocument();
    }
  });

  // 同上，但锁的是图标：把机位的图标换成灯泡，只有机位那条会红。
  it("gives each object kind its own icon", () => {
    const { objects } = setup();
    const expected: ReadonlyArray<readonly [number, string]> = [
      [0, "lucide-user"],
      [1, "lucide-camera"],
      [2, "lucide-lightbulb"],
      [3, "lucide-box"],
    ];

    for (const [index, iconClass] of expected) {
      expect(screen.getByTestId(`previz-layer-icon-${objects[index]!.id}`)).toHaveClass(iconClass);
    }
  });

  it("selects on click and marks only the selected row", async () => {
    const user = userEvent.setup();
    const objects = build();
    const { onSelect } = setup({ objects, selectedId: objects[1]!.id });

    expect(row(objects[1]!.id)).toHaveAttribute("aria-selected", "true");
    expect(row(objects[0]!.id)).toHaveAttribute("aria-selected", "false");
    expect(row(objects[2]!.id)).toHaveAttribute("aria-selected", "false");

    // 两行都点：只断言第 0 行的话，「永远传第一行的 id」这种写法一条都红不了。
    await user.click(screen.getByText(objects[2]!.name));
    expect(onSelect).toHaveBeenCalledWith(objects[2]!.id);

    await user.click(screen.getByText(objects[0]!.name));
    expect(onSelect).toHaveBeenLastCalledWith(objects[0]!.id);
  });

  it("toggles visibility and lock per row without touching each other", async () => {
    const user = userEvent.setup();
    const { objects, onSelect, onToggleVisible, onToggleLocked, onRemove } = setup();
    const target = row(objects[0]!.id);

    await user.click(button(target, "previz.layers.toggleVisible"));
    expect(onToggleVisible).toHaveBeenCalledWith(objects[0]!.id);
    expect(onToggleLocked).not.toHaveBeenCalled();

    await user.click(button(target, "previz.layers.toggleLocked"));
    expect(onToggleLocked).toHaveBeenCalledWith(objects[0]!.id);
    expect(onToggleVisible).toHaveBeenCalledTimes(1);

    expect(onRemove).not.toHaveBeenCalled();
    // 行内按钮吃掉冒泡：点「隐藏」不该顺手把这一行也选中。
    expect(onSelect).not.toHaveBeenCalled();
  });

  // 两行的 visible 与 locked 刻意相反：两者相等的行分辨不出「可见按钮读了 locked」，
  // 这条断言就成了摆设。
  it("reads visible and locked off their own fields", () => {
    const objects: PrevizObject[] = [];
    objects.push(createPrevizObject("character", objects, { visible: false, locked: true }));
    objects.push(createPrevizObject("camera", objects, { visible: true, locked: false }));
    setup({ objects });

    const hidden = row(objects[0]!.id);
    const visibleToggle = button(hidden, "previz.layers.toggleVisible");
    expect(visibleToggle).toHaveAttribute("aria-pressed", "false");
    expect(visibleToggle.querySelector("svg")).toHaveClass("lucide-eye-off");
    const closedLock = button(hidden, "previz.layers.toggleLocked");
    expect(closedLock).toHaveAttribute("aria-pressed", "true");
    expect(closedLock.querySelector("svg")).toHaveClass("lucide-lock");

    const shown = row(objects[1]!.id);
    const shownToggle = button(shown, "previz.layers.toggleVisible");
    expect(shownToggle).toHaveAttribute("aria-pressed", "true");
    expect(shownToggle.querySelector("svg")).toHaveClass("lucide-eye");
    const openLock = button(shown, "previz.layers.toggleLocked");
    expect(openLock).toHaveAttribute("aria-pressed", "false");
    expect(openLock.querySelector("svg")).toHaveClass("lucide-lock-open");
  });

  it("removes the row it was clicked on", async () => {
    const user = userEvent.setup();
    const { objects, onRemove, onSelect, onToggleVisible, onToggleLocked } = setup();

    await user.click(button(row(objects[2]!.id), "previz.layers.remove"));

    expect(onRemove).toHaveBeenCalledWith(objects[2]!.id);
    expect(onToggleVisible).not.toHaveBeenCalled();
    expect(onToggleLocked).not.toHaveBeenCalled();
    // 删一行不该顺带把它选中——它下一刻就不存在了。
    expect(onSelect).not.toHaveBeenCalled();
  });

  // 只有机位有监看，人物行上冒出一个「设为监看」按钮会让人以为能从人物眼睛看出去。
  it("offers the monitor toggle on cameras only", async () => {
    const user = userEvent.setup();
    const { objects, onSelect, onSetActiveCamera } = setup();
    const monitor = "previz.layers.setActiveCamera";

    for (const index of [0, 2, 3]) {
      expect(within(row(objects[index]!.id)).queryByRole("button", { name: monitor })).toBeNull();
    }

    await user.click(button(row(objects[1]!.id), monitor));
    expect(onSetActiveCamera).toHaveBeenCalledWith(objects[1]!.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the active camera and clears the monitor when its button is clicked again", async () => {
    const user = userEvent.setup();
    const objects = build();
    objects.push(createPrevizObject("camera", objects));
    const { onSetActiveCamera } = setup({ objects, activeCameraId: objects[1]!.id });
    const monitor = "previz.layers.setActiveCamera";

    expect(button(row(objects[1]!.id), monitor)).toHaveAttribute("aria-pressed", "true");
    expect(button(row(objects[4]!.id), monitor)).toHaveAttribute("aria-pressed", "false");

    await user.click(button(row(objects[4]!.id), monitor));
    expect(onSetActiveCamera).toHaveBeenCalledWith(objects[4]!.id);

    onSetActiveCamera.mockClear();
    await user.click(button(row(objects[1]!.id), monitor));
    expect(onSetActiveCamera).toHaveBeenCalledWith(null);
  });

  it("selects from the keyboard, but a row button's own key press stays its own", async () => {
    const user = userEvent.setup();
    const { objects, onSelect, onToggleVisible } = setup();
    const target = row(objects[0]!.id);

    // Tab 键要够得着行本身，不然「回车选中」只对已经用鼠标点过的行有效。
    await user.tab();
    expect(target).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(objects[0]!.id);

    onSelect.mockClear();
    button(target, "previz.layers.toggleVisible").focus();
    await user.keyboard(" ");
    expect(onToggleVisible).toHaveBeenCalledWith(objects[0]!.id);
    expect(onSelect).not.toHaveBeenCalled();

    // 行本身收到空格时要吃掉默认行为，否则列表会跟着滚一屏。jsdom 观察不到滚动，
    // 只能看事件有没有被 preventDefault——dispatchEvent 对被取消的事件返回 false。
    target.focus();
    expect(fireEvent.keyDown(target, { key: " " })).toBe(false);
    expect(onSelect).toHaveBeenCalledWith(objects[0]!.id);
  });

  it("leaves out the heading for a kind that has nothing in it", () => {
    const objects = build().filter((object) => object.kind === "character");
    setup({ objects });

    expect(screen.getByRole("group", { name: "previz.layers.kind.character" })).toBeInTheDocument();
    for (const kind of ["camera", "light", "prop"]) {
      expect(screen.queryByRole("group", { name: `previz.layers.kind.${kind}` })).toBeNull();
    }
  });
});
