// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  const handlers = { onPlace: vi.fn(), onImportFile: vi.fn(), onClose: vi.fn() };
  render(<PrevizModelLibraryDialog open={open} objects={[]} {...handlers} />);
  return handlers;
}

/** 在选位图上合成点一下（`detail: 0`，落在取景中心），返回读数回显的世界 XZ。 */
function pickSpot(): [number, number] {
  fireEvent.click(screen.getByRole("button", { name: /previz\.characterCreate\.pickHint/ }));
  const readout = screen.getByLabelText("previz.library.spotLabel").textContent ?? "";
  return readout.split(" / ").map(Number) as [number, number];
}

function placeButton(): HTMLElement {
  return screen.getByRole("button", { name: "previz.library.place" });
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
    expect(cards()).toHaveLength(25);
    const cube = card("cube");
    expect(within(cube).getByText('previz.library.triangles:{"count":12}')).toBeInTheDocument();
    expect(cube.querySelector('svg[data-shape="cube"]')).not.toBeNull();
  });

  it("counts entries in the category rail, with All selected first", () => {
    setup();

    const all = rail(/^previz\.library\.all/);
    const primitive = rail(/^previz\.library\.category\.primitive/);
    expect(within(all).getByText(String(PREVIZ_LIBRARY_ENTRIES.length))).toBeInTheDocument();
    expect(within(primitive).getByText("25")).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(primitive).toHaveAttribute("aria-pressed", "false");
  });

  it("switches the category filter", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(rail(/^previz\.library\.category\.primitive/));

    expect(rail(/^previz\.library\.category\.primitive/)).toHaveAttribute("aria-pressed", "true");
    expect(rail(/^previz\.library\.all/)).toHaveAttribute("aria-pressed", "false");
    expect(cards()).toHaveLength(25);
  });

  it("shows a CDN model's thumbnail, and a placeholder icon if it fails to load", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(rail(/^previz\.library\.category\.vehicle/));
    const sedan = screen.getByRole("button", { name: /^previz\.library\.model\.vehicle-sedan/ });
    const thumbnail = sedan.querySelector("img");
    expect(thumbnail).toHaveAttribute(
      "src",
      PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "vehicle-sedan")?.thumbnailUrl,
    );

    fireEvent.error(thumbnail!);

    expect(sedan.querySelector("img")).toBeNull();
    expect(sedan.querySelector("svg")).not.toBeNull();
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

  it("asks for a spot after a card is clicked, and hands both to onPlace", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(card("sphere"));

    // 挑中只换屏，不建：没选落点前「放置」是灰的。
    expect(handlers.onPlace).not.toHaveBeenCalled();
    expect(placeButton()).toBeDisabled();

    const spot = pickSpot();
    await user.click(placeButton());

    expect(handlers.onPlace).toHaveBeenCalledTimes(1);
    // 比引用：编辑器拿到的必须就是清单里那一条，不是按 id 另拼的一份。
    expect(handlers.onPlace.mock.calls[0]?.[0]).toBe(
      PREVIZ_LIBRARY_ENTRIES.find((entry) => entry.id === "primitive-sphere"),
    );
    expect(handlers.onPlace.mock.calls[0]?.[1]).toEqual(spot);
    expect(handlers.onImportFile).not.toHaveBeenCalled();
  });

  it("goes back to the grid with the search kept, and forgets the spot", async () => {
    const user = userEvent.setup();
    setup();

    await user.type(screen.getByRole("searchbox", { name: "previz.library.search" }), "ramp");
    await user.click(card("wedge"));
    pickSpot();
    await user.click(screen.getAllByRole("button", { name: "previz.library.back" })[0]!);

    expect(screen.getByRole("searchbox", { name: "previz.library.search" })).toHaveValue("ramp");
    await user.click(card("wedge"));
    // 换一次模型就重选落点，不沿用上一次的。
    expect(placeButton()).toBeDisabled();
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
    // value 必须被清空，否则第二次挑同一个文件浏览器不会再发 change。
    expect(input).toHaveValue("");
    // 本地文件同样先选落点。
    expect(handlers.onImportFile).not.toHaveBeenCalled();
    const spot = pickSpot();
    await user.click(placeButton());
    // toHaveBeenCalledWith 对 File 走结构化相等，换成另一个 File 照样绿；比引用才锁得住。
    expect(handlers.onImportFile.mock.calls[0]?.[0]).toBe(file);
    expect(handlers.onImportFile.mock.calls[0]?.[1]).toEqual(spot);

    await user.click(screen.getAllByRole("button", { name: "previz.library.back" })[0]!);
    await user.upload(screen.getByLabelText<HTMLInputElement>("previz.library.importLocal"), file);
    pickSpot();
    await user.click(placeButton());
    expect(handlers.onImportFile).toHaveBeenCalledTimes(2);
  });

  it("closes from the header button", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(screen.getByRole("button", { name: "previz.library.close" }));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onPlace).not.toHaveBeenCalled();
  });
});
