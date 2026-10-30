// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ComponentProps } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PrevizHeaderBar } from "@/features/previz/ui/PrevizHeaderBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // 停止键上写着进度，插值必须真的插进去——原样吐 key 的话「停止 52%」这条断言
    // 会被一个不含数字的字符串蒙混过去。
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

type BarProps = ComponentProps<typeof PrevizHeaderBar>;

/**
 * 回调不进 overrides：`...Partial<Props>` 展开会把每个 handler 的类型拓宽成
 * `Mock | ((...) => void)`，之后取 `.mock` / `.mockClear()` 就过不了类型检查。
 */
type Overrides = Partial<
  Pick<BarProps, "canUndo" | "canRedo" | "capturing" | "recording" | "recordProgress"
  | "recordPublishing">
>;

function makeHandlers() {
  return {
    onUndo: vi.fn<BarProps["onUndo"]>(),
    onRedo: vi.fn<BarProps["onRedo"]>(),
    onCapture: vi.fn<BarProps["onCapture"]>(),
    onRecord: vi.fn<BarProps["onRecord"]>(),
    onStopRecord: vi.fn<BarProps["onStopRecord"]>(),
    onClose: vi.fn<BarProps["onClose"]>(),
  };
}

type Handlers = ReturnType<typeof makeHandlers>;

function setup(overrides: Overrides = {}): Handlers {
  const handlers = makeHandlers();
  render(
    <PrevizHeaderBar
      canUndo
      canRedo
      capturing={false}
      recording={null}
      recordProgress={0}
      recordPublishing={false}
      {...overrides}
      {...handlers}
    />,
  );
  return handlers;
}

function button(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

/** 一次交互只该惊动一个回调；缺了这条，把两个 handler 接反了照样全绿。 */
function expectOnly(handlers: Handlers, called: keyof Handlers): void {
  for (const [name, mock] of Object.entries(handlers)) {
    if (name === called) continue;
    expect(mock, `${name} should not have fired`).not.toHaveBeenCalled();
  }
}

/** 展开录制选单，返回里面那两项。 */
async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement[]> {
  await user.click(button("previz.editor.record.open"));
  return screen.getAllByRole("menuitem");
}

describe("PrevizHeaderBar", () => {
  it("fires nothing just by rendering", () => {
    const handlers = setup();

    for (const mock of Object.values(handlers)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("undoes without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: true, canRedo: false });

    expect(button("previz.editor.redo")).toBeDisabled();
    const undo = button("previz.editor.undo");
    expect(undo).toBeEnabled();
    await user.click(undo);

    expect(handlers.onUndo).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onUndo");
  });

  it("redoes without disturbing the rest", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: false, canRedo: true });

    expect(button("previz.editor.undo")).toBeDisabled();
    const redo = button("previz.editor.redo");
    expect(redo).toBeEnabled();
    await user.click(redo);

    expect(handlers.onRedo).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onRedo");
  });

  it("does not fire undo while there is nothing to undo", async () => {
    const user = userEvent.setup();
    const handlers = setup({ canUndo: false, canRedo: false });

    await user.click(button("previz.editor.undo"));
    await user.click(button("previz.editor.redo"));

    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(handlers.onRedo).not.toHaveBeenCalled();
  });

  // 撤销到底之后按钮是灰的，而「为什么灰」只写在提示里——禁用的按钮浏览器不再派发
  // hover，提示得由外面那层包装触发。少了那层，用户面前只剩一颗没有解释的灰按钮。
  it("still explains the undo button while it is disabled", async () => {
    const user = userEvent.setup();
    setup({ canUndo: false });

    const undo = button("previz.editor.undo");
    expect(undo).toBeDisabled();
    await user.hover(undo);
    const popup = await waitFor(() => {
      const open = document.querySelector<HTMLElement>('[data-slot="tooltip-content"][data-open]');
      expect(open, "hovering should have opened a tooltip").not.toBeNull();
      return open as HTMLElement;
    });
    expect(popup.textContent).toBe("previz.editor.undo");
  });

  it("closes the editor", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button("previz.editor.close"));

    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onClose");
  });

  it("captures a still", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    await user.click(button("previz.editor.capture"));

    expect(handlers.onCapture).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onCapture");
  });

  // 两条出片管线共用同一张画布，一条跑着的时候另一条按下去只会互相踩。
  it.each<[string, Overrides]>([
    ["capturing", { capturing: true }],
    ["recording", { recording: "global" }],
    ["publishing", { recordPublishing: true }],
  ])("refuses a second capture while %s", async (_label, overrides) => {
    const user = userEvent.setup();
    const handlers = setup(overrides);

    // 出片中那颗按钮的可见文字变了，而可见文字就是它的可访问名字（见组件里那段注释）。
    const capture = screen.getByRole("button", {
      name: overrides.capturing ? "previz.editor.capturing" : "previz.editor.capture",
    });
    expect(capture).toBeDisabled();
    await user.click(capture);

    expect(handlers.onCapture).not.toHaveBeenCalled();
  });

  it("offers both record modes and starts the one that is picked", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    const items = await openMenu(user);
    expect(items.map((item) => item.textContent)).toEqual([
      "previz.editor.record.mode.global",
      "previz.editor.record.mode.track",
    ]);

    await user.click(items[1]!);

    expect(handlers.onRecord).toHaveBeenCalledWith("track");
    expectOnly(handlers, "onRecord");
    // 选完就收，不然它一直挂在那儿挡着顶栏。
    expect(screen.queryByRole("menu")).toBeNull();
  });

  /*
    收起来靠的是一层铺满界面的透明背板，不是 onBlur：点选单里的按钮会先触发 blur、把
    自己卸掉，那一下就永远点不中。这里直接点背板本身——jsdom 不做命中测试，`user.click`
    是照着元素派事件而不是照着坐标，隔着背板点别处在这里是打不出来的。所以这条只钉两
    件事：菜单开着时背板确实铺了出来，且它收到指针就把菜单收掉。
  */
  it("lays a backdrop over the page and closes the record menu when it is hit", async () => {
    const user = userEvent.setup();
    const handlers = setup();

    expect(screen.queryByTestId("previz-record-backdrop")).toBeNull();
    await openMenu(user);

    const backdrop = screen.getByTestId("previz-record-backdrop");
    // fixed 铺满而不是只盖视口：点时间轴或右侧面板也该算「点到别处」。
    expect(backdrop.className).toContain("fixed inset-0");
    await user.click(backdrop);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByTestId("previz-record-backdrop")).toBeNull();
    for (const mock of Object.values(handlers)) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("turns the record button into a stop button while recording", async () => {
    const user = userEvent.setup();
    const handlers = setup({ recording: "global", recordProgress: 0.52 });

    const stop = button("previz.editor.record.stop");
    expect(stop).toHaveTextContent('previz.editor.record.stopWithProgress:{"percent":52}');
    await user.click(stop);

    expect(handlers.onStopRecord).toHaveBeenCalledTimes(1);
    expectOnly(handlers, "onStopRecord");
    // 录着的时候按下去是停，不是再开一层选单。
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the upload stage and refuses to start another take", async () => {
    const user = userEvent.setup();
    const handlers = setup({ recordPublishing: true });

    const record = button("previz.editor.record.open");
    expect(record).toHaveTextContent("previz.editor.record.publishing");
    expect(record).toBeDisabled();
    await user.click(record);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(handlers.onRecord).not.toHaveBeenCalled();
  });
});
