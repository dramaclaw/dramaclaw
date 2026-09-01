// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
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
 * 等于没有断言。icon class 是 lucide 给每个图标挂的稳定类名——这四个按钮只有图标
 * 没有可见文字，图标就是它们对用户的全部身份，所以也得逐个锁住。
 */
const KINDS = [
  { kind: "character", limit: 50, icon: "lucide-user" },
  { kind: "camera", limit: 30, icon: "lucide-camera" },
  { kind: "light", limit: 12, icon: "lucide-lightbulb" },
  { kind: "prop", limit: 20, icon: "lucide-box" },
] as const;

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
 * `Mock | ((kind: PrevizObjectKind) => void)`，之后取 `.mock` / `.mockClear()` 就过不了
 * 类型检查。只让状态类 prop 可覆盖，mock 原样返回，类型就保得住。
 */
type ToolbarOverrides = Partial<Pick<ToolbarProps, "canAdd" | "canUndo" | "canRedo">>;

function setup(overrides: ToolbarOverrides = {}) {
  const handlers = {
    onAdd: vi.fn(),
    onImportProp: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };
  const props: ToolbarProps = {
    canAdd: { character: true, camera: true, light: true, prop: true },
    canUndo: true,
    canRedo: false,
    ...overrides,
    ...handlers,
  };
  render(<PrevizToolbar {...props} />);
  return handlers;
}

describe("PrevizToolbar", () => {
  it.each(KINDS)("offers an enabled create button for $kind", ({ kind, icon }) => {
    setup();

    const button = screen.getByRole("button", { name: `previz.toolbar.add.${kind}` });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", `previz.toolbar.add.${kind}`);
    expect(button.querySelector("svg")).toHaveClass(icon);
  });

  it.each(KINDS)("calls onAdd with $kind when that button is clicked", async ({ kind }) => {
    const user = userEvent.setup();
    const { onAdd } = setup();

    await user.click(screen.getByRole("button", { name: `previz.toolbar.add.${kind}` }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(kind);
  });

  // 到上限时静默失败最气人：按钮看着能点，点了什么都不发生。禁用之外还得说清
  // 为什么禁用——一个灰掉且没有解释的按钮同样让人摸不着头脑。
  it.each(KINDS)("disables the $kind button at its limit and says why", ({ kind, limit }) => {
    setup({ canAdd: canAddExcept(kind) });

    const button = screen.getByRole("button", { name: `previz.toolbar.add.${kind}` });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", `previz.toolbar.limitReached:{"count":${limit}}`);

    // 别的类型不受牵连——不然「全部禁用」也能骗过上面两条。
    for (const other of KINDS) {
      if (other.kind === kind) continue;
      expect(screen.getByRole("button", { name: `previz.toolbar.add.${other.kind}` })).toBeEnabled();
    }
  });

  it("mirrors undo availability", async () => {
    const user = userEvent.setup();
    const { onUndo, onRedo } = setup({ canUndo: true, canRedo: false });

    expect(screen.getByRole("button", { name: "previz.toolbar.redo" })).toBeDisabled();
    const undo = screen.getByRole("button", { name: "previz.toolbar.undo" });
    expect(undo).toBeEnabled();
    await user.click(undo);

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).not.toHaveBeenCalled();
  });

  it("mirrors redo availability", async () => {
    const user = userEvent.setup();
    const { onUndo, onRedo } = setup({ canUndo: false, canRedo: true });

    expect(screen.getByRole("button", { name: "previz.toolbar.undo" })).toBeDisabled();
    const redo = screen.getByRole("button", { name: "previz.toolbar.redo" });
    expect(redo).toBeEnabled();
    await user.click(redo);

    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  // 同 KINDS 那条的理由：这三个控件也只有图标，没有可见文字。图标画错、tooltip 丢了，
  // 鼠标用户就再也读不出这个按钮是干什么的，而 aria-label 只服务读屏。
  it.each([
    ["previz.toolbar.undo", "lucide-undo-2"],
    ["previz.toolbar.redo", "lucide-redo-2"],
  ])("labels the %s button with its own icon and tooltip", (name, icon) => {
    setup({ canUndo: true, canRedo: true });

    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("title", name);
    expect(button.querySelector("svg")).toHaveClass(icon);
  });

  it("labels the import control with its own icon and tooltip", () => {
    setup();

    // getByTitle 落在视觉控件（<label>）上，input 本身是 sr-only 的。
    const importControl = screen.getByTitle("previz.toolbar.importProp");
    expect(importControl).toHaveAttribute("for", screen.getByLabelText("previz.toolbar.importProp").id);
    expect(importControl.querySelector("svg")).toHaveClass("lucide-upload");
  });

  it("hands the picked file to onImportProp", async () => {
    const user = userEvent.setup();
    const { onImportProp } = setup();
    const file = new File([new Uint8Array(1)], "chair.glb");

    const input = screen.getByLabelText("previz.toolbar.importProp");
    await user.upload(input, file);

    expect(onImportProp).toHaveBeenCalledWith(file);
    // toHaveBeenCalledWith 对 File 走结构化相等，换成另一个 File 照样绿。要锁住「转发的
    // 是用户挑的那一个」，只能比引用同一性。
    expect(onImportProp.mock.calls[0]?.[0]).toBe(file);
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
});
