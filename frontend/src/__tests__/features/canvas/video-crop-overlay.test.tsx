// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestVideoCropFocus } from "@/features/canvas/application/videoCrop/videoCropInFlight";
import { VideoCropOverlay } from "@/features/canvas/nodes/VideoCropOverlay";

// 400×300 容器里放 720×1280 的画面：画面宽 168.75px，1 屏幕像素 = 720/168.75 源像素，
// 所以 23.4375px 正好是 100 源像素（两个数都能被二进制精确表示，断言可以用 toEqual）。
const PX_PER_100_SOURCE = 23.4375;
const BOX = { x: 72, y: 128, width: 576, height: 1024 };
// 一次性抢焦点的挂号表是按 nodeId 登记的模块级单例，固定一个测试节点 id 就行。
const NODE_ID = "test-video-crop-node";

type ObserverCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ObserverCallback;
      constructor(callback: ObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: 400, height: 300 } }]);
      }
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderOverlay(overrides: Partial<Parameters<typeof VideoCropOverlay>[0]> = {}) {
  const onChange = vi.fn();
  const result = render(
    <VideoCropOverlay
      nodeId={NODE_ID}
      box={BOX}
      ratio={null}
      sourceWidth={720}
      sourceHeight={1280}
      disabled={false}
      onChange={onChange}
      {...overrides}
    />,
  );
  return { onChange, rerender: result.rerender, unmount: result.unmount };
}

const handle = (name: string) => document.querySelector(`[data-crop-handle="${name}"]`) as HTMLElement;

describe("VideoCropOverlay", () => {
  it("shows the pixel size and all eight handles in free mode", () => {
    renderOverlay();
    expect(screen.getByText("576 × 1024")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-crop-handle]")).toHaveLength(8);
  });

  it("keeps only the corner handles when the ratio is locked", () => {
    renderOverlay({ ratio: 0.5625 });
    expect(document.querySelectorAll("[data-crop-handle]")).toHaveLength(4);
    expect(handle("e")).toBeNull();
  });

  it("converts handle drags into source pixels", () => {
    const { onChange } = renderOverlay();
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(handle("se"), { pointerId: 1, clientX: 200 - PX_PER_100_SOURCE, clientY: 200 });
    expect(onChange).toHaveBeenLastCalledWith({ x: 72, y: 128, width: 476, height: 1024 });
  });

  it("moves the whole box and clamps it to the frame", () => {
    const { onChange } = renderOverlay();
    const box = screen.getByTestId("video-crop-box");
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 200 + PX_PER_100_SOURCE, clientY: 200 });
    expect(onChange).toHaveBeenLastCalledWith({ ...BOX, x: 144 });
  });

  it("ignores drags while disabled", () => {
    const { onChange } = renderOverlay({ disabled: true });
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(handle("se"), { pointerId: 1, clientX: 100, clientY: 200 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores presses from non-primary buttons", () => {
    const { onChange } = renderOverlay();
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 200, clientY: 200, button: 2 });
    fireEvent.pointerMove(handle("se"), { pointerId: 1, clientX: 200 - PX_PER_100_SOURCE, clientY: 200 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stops applying moves once the pointer is released", () => {
    const { onChange } = renderOverlay();
    const handleEl = handle("se");
    fireEvent.pointerDown(handleEl, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(handleEl, { pointerId: 1, clientX: 200 - PX_PER_100_SOURCE, clientY: 200 });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(handleEl, { pointerId: 1 });
    fireEvent.pointerMove(handleEl, { pointerId: 1, clientX: 100, clientY: 200 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("stops a drag mid-flight when disabled flips to true", () => {
    const { onChange, rerender } = renderOverlay();
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 200, clientY: 200 });
    rerender(
      <VideoCropOverlay
        nodeId={NODE_ID}
        box={BOX}
        ratio={null}
        sourceWidth={720}
        sourceHeight={1280}
        disabled
        onChange={onChange}
      />,
    );
    fireEvent.pointerMove(handle("se"), { pointerId: 1, clientX: 100, clientY: 200 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides the size label when the displayed box is tiny", () => {
    renderOverlay({ box: { x: 0, y: 0, width: 64, height: 64 } });
    expect(screen.queryByText("64 × 64")).not.toBeInTheDocument();
  });

  it("moves the box right by 1 source px on ArrowRight", () => {
    const { onChange } = renderOverlay();
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith({ ...BOX, x: 73 });
  });

  it("moves the box down by 10 source px on Shift+ArrowDown", () => {
    const { onChange } = renderOverlay();
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith({ ...BOX, y: 138 });
  });

  it("grows the width by 1 source px on Alt+ArrowRight in free ratio", () => {
    const { onChange } = renderOverlay({ ratio: null });
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "ArrowRight", altKey: true });
    expect(onChange).toHaveBeenCalledWith({ x: 72, y: 128, width: 577, height: 1024 });
  });

  it("keeps a locked ratio when resizing with Alt+ArrowRight", () => {
    const { onChange } = renderOverlay({ ratio: 1 });
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "ArrowRight", altKey: true });
    const [box] = onChange.mock.lastCall as [{ width: number; height: number }];
    expect(box.width).toBe(box.height);
  });

  it("calls onEscape without mutating the box", () => {
    const onEscape = vi.fn();
    const { onChange } = renderOverlay({ onEscape });
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores every key while disabled", () => {
    const onEscape = vi.fn();
    const { onChange } = renderOverlay({ disabled: true, onEscape });
    const box = screen.getByTestId("video-crop-box");
    fireEvent.keyDown(box, { key: "ArrowRight" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("still calls preventDefault on arrows and Escape while disabled, so react-flow doesn't move or deselect the node", () => {
    // disabled 时 onChange/onEscape 不能被调用（上一条测试已经盯住了），但这两类键
    // 还是要被吃掉——不然 react-flow 自己的方向键移动 / Canvas.tsx 的 Esc 处理会
    // 接手，用户会看到节点自己动了或者被取消选中。
    const onEscape = vi.fn();
    const { onChange } = renderOverlay({ disabled: true, onEscape });
    const box = screen.getByTestId("video-crop-box");

    const arrowEvent = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    box.dispatchEvent(arrowEvent);
    expect(arrowEvent.defaultPrevented).toBe(true);

    const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    box.dispatchEvent(escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);

    expect(onChange).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("stops handled keys from bubbling up to react-flow's node handlers", () => {
    const onChange = vi.fn();
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <VideoCropOverlay
          nodeId={NODE_ID}
          box={BOX}
          ratio={null}
          sourceWidth={720}
          sourceHeight={1280}
          disabled={false}
          onChange={onChange}
        />
      </div>,
    );
    fireEvent.keyDown(screen.getByTestId("video-crop-box"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("keeps a native document-level keydown listener from seeing a handled ArrowRight or Escape", () => {
    // 跟上面那条测的是同一件事（命中的键不能冒泡出去），只是把「父级 React
    // 处理器」换成「document 上的原生监听器」——这才是 Canvas.tsx 里真正挂的
    // 那一层，也是这条修复原本要堵的口子。
    const onEscape = vi.fn();
    renderOverlay({ onEscape });
    const box = screen.getByTestId("video-crop-box");
    const documentKeyDown = vi.fn();
    document.addEventListener("keydown", documentKeyDown);
    try {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener("keydown", documentKeyDown);
    }
    expect(documentKeyDown).not.toHaveBeenCalled();
  });

  it("focuses the crop box when a focus request is pending for this node", async () => {
    requestVideoCropFocus(NODE_ID);
    renderOverlay();
    // 焦点是在 rAF 里抢的（见 VideoCropOverlay 里的注释），不是挂载后立刻发生。
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("video-crop-box"));
    });
  });

  it("does not focus the crop box without a pending focus request", async () => {
    renderOverlay();
    // 没挂号就不该抢焦点：给一轮 rAF 的时间，确认真的什么都没发生，而不是只测
    // 挂载那一刻的状态。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).not.toBe(screen.getByTestId("video-crop-box"));
  });

  it("consumes the pending focus request only once, so a remount does not refocus", async () => {
    requestVideoCropFocus(NODE_ID);
    const first = renderOverlay();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId("video-crop-box"));
    });
    first.unmount();

    // 同一个节点重新挂载（比如被 onlyRenderVisibleElements 卸载又挂回来）：
    // 挂号已经在上一次挂载时被消费掉了，这次不该再抢焦点。
    renderOverlay();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(document.activeElement).not.toBe(screen.getByTestId("video-crop-box"));
  });

  it("accounts for canvas zoom when converting pointer deltas", () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    } as DOMRect);
    const { onChange } = renderOverlay();
    fireEvent.pointerDown(handle("se"), { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(handle("se"), {
      pointerId: 1,
      clientX: 200 - 2 * PX_PER_100_SOURCE,
      clientY: 200,
    });
    expect(onChange).toHaveBeenLastCalledWith({ x: 72, y: 128, width: 476, height: 1024 });
  });
});
