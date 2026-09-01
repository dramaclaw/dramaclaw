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

function setup(overrides: Partial<ToolbarProps> = {}) {
  const props = {
    canAdd: { character: true, camera: true, light: true, prop: true },
    canUndo: true,
    canRedo: false,
    onAdd: vi.fn(),
    onImportProp: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  } satisfies ToolbarProps;
  render(<PrevizToolbar {...props} />);
  return props;
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
    const props = setup();

    await user.click(screen.getByRole("button", { name: `previz.toolbar.add.${kind}` }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith(kind);
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
    const props = setup({ canUndo: true, canRedo: false });

    expect(screen.getByRole("button", { name: "previz.toolbar.redo" })).toBeDisabled();
    const undo = screen.getByRole("button", { name: "previz.toolbar.undo" });
    expect(undo).toBeEnabled();
    await user.click(undo);

    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onRedo).not.toHaveBeenCalled();
  });

  it("mirrors redo availability", async () => {
    const user = userEvent.setup();
    const props = setup({ canUndo: false, canRedo: true });

    expect(screen.getByRole("button", { name: "previz.toolbar.undo" })).toBeDisabled();
    const redo = screen.getByRole("button", { name: "previz.toolbar.redo" });
    expect(redo).toBeEnabled();
    await user.click(redo);

    expect(props.onRedo).toHaveBeenCalledTimes(1);
    expect(props.onUndo).not.toHaveBeenCalled();
  });

  it("hands the picked file to onImportProp", async () => {
    const user = userEvent.setup();
    // 单独持一个 mock 引用，而不是从 setup() 的返回值上取：那个返回值被 `...overrides`
    // 铺开过，每个 handler 的类型都拓宽成了 `Mock | ((file: File) => void)`，取 `.mock`
    // 过不了类型检查。
    const onImportProp = vi.fn();
    setup({ onImportProp });
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
