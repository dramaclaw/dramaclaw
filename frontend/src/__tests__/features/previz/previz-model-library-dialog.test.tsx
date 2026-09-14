// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PREVIZ_LIBRARY_ENTRIES } from "@/features/previz/domain/modelLibrary";
import { PrevizModelLibraryDialog } from "@/features/previz/ui/PrevizModelLibraryDialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 带值的 key 拼成 `key:{...}`，好让断言看得见插进去的面数。
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

function setup(open = true) {
  const handlers = { onPick: vi.fn(), onImportFile: vi.fn(), onClose: vi.fn() };
  render(<PrevizModelLibraryDialog open={open} {...handlers} />);
  return handlers;
}

/** 卡片的可访问名字以本地化名称开头（mock 下就是 key），后面跟着面数。 */
function cards(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: /^previz\.library\.primitive\./ });
}

function card(shape: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^previz\\.library\\.primitive\\.${shape}`) });
}

function rail(name: RegExp): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "previz.library.categories" });
  return within(nav).getByRole("button", { name });
}

describe("PrevizModelLibraryDialog", () => {
  it("renders nothing while closed", () => {
    setup(false);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows every entry with its preview and triangle count", () => {
    setup();

    expect(screen.getByRole("dialog", { name: "previz.library.title" })).toBeInTheDocument();
    expect(cards()).toHaveLength(8);
    const cube = card("cube");
    expect(within(cube).getByText('previz.library.triangles:{"count":12}')).toBeInTheDocument();
    expect(cube.querySelector('svg[data-shape="cube"]')).not.toBeNull();
  });

  it("counts entries in the category rail, with All selected first", () => {
    setup();

    const all = rail(/^previz\.library\.all/);
    const primitive = rail(/^previz\.library\.category\.primitive/);
    expect(within(all).getByText("8")).toBeInTheDocument();
    expect(within(primitive).getByText("8")).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(primitive).toHaveAttribute("aria-pressed", "false");
  });

  it("switches the category filter", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(rail(/^previz\.library\.category\.primitive/));

    expect(rail(/^previz\.library\.category\.primitive/)).toHaveAttribute("aria-pressed", "true");
    expect(rail(/^previz\.library\.all/)).toHaveAttribute("aria-pressed", "false");
    expect(cards()).toHaveLength(8);
  });

  it("focuses the search box on open and filters as you type", async () => {
    const user = userEvent.setup();
    setup();

    const search = screen.getByRole("searchbox", { name: "previz.library.search" });
    expect(search).toHaveFocus();

    await user.type(search, "ramp");

    expect(cards()).toHaveLength(1);
    expect(card("wedge")).toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByRole("searchbox", { name: "previz.library.search" }), "zzz");

    expect(cards()).toHaveLength(0);
    expect(screen.getByText("previz.library.empty")).toBeInTheDocument();
  });

  it("hands the clicked entry to onPick", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(card("sphere"));

    expect(handlers.onPick).toHaveBeenCalledTimes(1);
    // 比引用：编辑器拿到的必须就是清单里那一条，不是按 id 另拼的一份。
    expect(handlers.onPick.mock.calls[0]?.[0]).toBe(
      PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "primitive-sphere"),
    );
    expect(handlers.onImportFile).not.toHaveBeenCalled();
  });

  it("offers local import for the three loadable formats only", () => {
    setup();

    expect(screen.getByLabelText("previz.library.importLocal")).toHaveAttribute(
      "accept",
      ".glb,.gltf,.obj",
    );
  });

  it("hands the picked file to onImportFile, and lets the same file be picked again", async () => {
    const user = userEvent.setup();
    const handlers = setup();
    const file = new File([new Uint8Array(1)], "chair.glb");
    const input = screen.getByLabelText<HTMLInputElement>("previz.library.importLocal");

    await user.upload(input, file);
    // toHaveBeenCalledWith 对 File 走结构化相等，换成另一个 File 照样绿；比引用才锁得住。
    expect(handlers.onImportFile.mock.calls[0]?.[0]).toBe(file);
    // value 必须被清空，否则第二次挑同一个文件浏览器不会再发 change。
    expect(input).toHaveValue("");

    await user.upload(input, file);
    expect(handlers.onImportFile).toHaveBeenCalledTimes(2);
  });

  it("closes from the header button", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole("button", { name: "previz.library.close" }));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onPick).not.toHaveBeenCalled();
  });
});
