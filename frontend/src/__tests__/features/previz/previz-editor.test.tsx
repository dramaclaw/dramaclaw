// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultScene, type Vec3 } from "@/features/previz/domain/scene";
import { PrevizRenderer } from "@/features/previz/engine/PrevizRenderer";
import { PrevizEditor } from "@/features/previz/PrevizEditor";
import { usePrevizStore } from "@/features/previz/store";
import { readUrl } from "@/lib/url-params";

const dispose = vi.fn();
const resize = vi.fn();
const setScene = vi.fn();
const setSelection = vi.fn();
const setActiveCamera = vi.fn();
const setGizmoMode = vi.fn();
const applyViewDirection = vi.fn();
const focusObject = vi.fn();
const resetView = vi.fn();
const pickAt = vi.fn(() => null as string | null);
const capture = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
const setFrame = vi.fn();
const setSelectedClip = vi.fn();
const groundPointAt = vi.fn((): Vec3 | null => [0, 0, 0]);

/** 每条用例一份全新的假渲染器，免得 onTransformCommit 在用例之间串。 */
function fakeRenderer() {
  return {
    dispose,
    resize,
    setScene,
    setSelection,
    setActiveCamera,
    setGizmoMode,
    applyViewDirection,
    focusObject,
    resetView,
    pickAt,
    capture,
    setFrame,
    setSelectedClip,
    groundPointAt,
    onTransformCommit: null as
      | ((objectId: string, transform: unknown) => void)
      | null,
  };
}

// WebGL 在 jsdom 里不存在；编辑器只需要知道自己正确地建了、也正确地拆了渲染器。
vi.mock("@/features/previz/engine/PrevizRenderer", () => ({
  PrevizRenderer: {
    create: vi.fn(async () => fakeRenderer()),
  },
}));

const addDerivedUploadNode = vi.fn(() => "upload-1");
const addEdge = vi.fn(() => "edge-1");

vi.mock("@/lib/url-params", () => ({
  readUrl: vi.fn(() => ({ project: "demo" })),
}));

vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: vi.fn(async () => ({ url: "/static/shot.png" })),
}));

vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ addDerivedUploadNode, addEdge }),
    { getState: () => ({ addDerivedUploadNode, addEdge }) },
  ),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// dispose / resize 是模块级共享的，而 testing-library 每个用例结束都会自动
// unmount、从而触发一次 dispose。不清的话第三条用例的 toHaveBeenCalledTimes(1)
// 会数到前两条留下的调用。
// store 也是模块级单例：新加的用例读它的真实状态，不重置就会串。
beforeEach(() => {
  vi.clearAllMocks();
  usePrevizStore.getState().loadScene(createDefaultScene());
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "frames" in options ? `${key}:${options.frames}` : key,
  }),
}));

beforeAll(() => {
  // jsdom 29 不提供 ResizeObserver。
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("PrevizEditor", () => {
  it("mounts a canvas and shows the timeline duration", () => {
    const scene = createDefaultScene();
    scene.settings.durationFrames = 240;

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    expect(screen.getByTestId("previz-canvas")).toBeInTheDocument();
    expect(screen.getByText("previz.editor.duration:240")).toBeInTheDocument();
  });

  it("flushes the current scene when closed", async () => {
    const user = userEvent.setup();
    const onFlush = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={onOpenChange}
        onFlush={onFlush}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.editor.close" }));

    expect(onFlush).toHaveBeenCalledWith(usePrevizStore.getState().scene);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  // 卸载竞态（Task 7 交下来的隐患 1）：`create()` 里两个动态 import 是异步的，弹窗
  // 可能在 three chunk 落地前就关了。此时 effect 清理跑的时候 `renderer` 还是 null，
  // 清理函数拿不到实例——如果 `.then()` 里没有 `cancelled` 守卫，这个实例就永远没人
  // dispose，泄漏一个 rAF 循环加一个 WebGL context。而浏览器对并发 WebGL context
  // 有上限（~16），预演台按设计就是反复开关的，泄漏几次之后就再也开不出来了。
  //
  // 这条必须留着：删掉实现里的 `if (cancelled) { created.dispose(); return; }` 分支，
  // 其余两条用例照样全绿——只有这条会红。
  it("disposes the renderer that resolves after unmount", async () => {
    let settle: (renderer: PrevizRenderer) => void = () => {};
    const pending = new Promise<PrevizRenderer>((resolve) => {
      settle = resolve;
    });
    vi.mocked(PrevizRenderer.create).mockImplementationOnce(() => pending);

    const { unmount } = render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    // 先卸载，再让 create() 落地——顺序就是这条用例的全部意义，别调换。
    unmount();
    expect(dispose).not.toHaveBeenCalled();

    settle(fakeRenderer() as unknown as PrevizRenderer);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it("pushes the store scene into the renderer", async () => {
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
  });

  it("adds an object from the toolbar and selects it", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.camera" }));

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(1);
    // 新建即选中：否则用户建完还得自己去右边点一下才能改属性。
    expect(state.selectedObjectId).toBe(state.scene.objects[0]!.id);
  });

  it("routes a view button to the renderer", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.hud.view.top" }));

    expect(applyViewDirection).toHaveBeenCalledWith("top");
  });
  it("captures and publishes into the canvas", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.editor.capture" }));

    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    await vi.waitFor(() => expect(addDerivedUploadNode).toHaveBeenCalled());
  });

  it("does not capture without a project in the url", async () => {
    const user = userEvent.setup();
    vi.mocked(readUrl).mockReturnValueOnce({ project: "" } as ReturnType<typeof readUrl>);

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.editor.capture" }));

    expect(capture).not.toHaveBeenCalled();
  });
});

/** 上面每条用例都手抄一遍的那五个 prop。新加的用例只改 `open`，其余给默认。 */
function editorProps(overrides: Partial<ComponentProps<typeof PrevizEditor>> = {}) {
  return {
    open: true,
    nodeId: "previz-1",
    initialScene: createDefaultScene(),
    onOpenChange: vi.fn(),
    onFlush: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof PrevizEditor>;
}

/**
 * 渲染编辑器并等到渲染器建好为止。时间轴那组用例几乎每条都要碰渲染器，
 * 而 `create()` 是异步的——不等这一下，`setFrame` 之类的断言会跑在实例存在之前。
 */
async function renderEditor(overrides: Partial<ComponentProps<typeof PrevizEditor>> = {}) {
  const result = render(<PrevizEditor {...editorProps(overrides)} />);
  await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
  return { ...result, renderer: { setFrame, setSelectedClip, groundPointAt, pickAt } };
}

describe("PrevizEditor timeline", () => {
  it("shows the timeline under the viewport", async () => {
    await renderEditor();

    expect(screen.getByRole("slider", { name: "previz.timeline.playhead" })).toBeInTheDocument();
  });

  it("tells the renderer which frame to show", async () => {
    const { renderer } = await renderEditor();

    act(() => usePrevizStore.getState().setTimelineFrame(42));

    expect(renderer.setFrame).toHaveBeenLastCalledWith(42);
  });

  it("tells the renderer which clip is selected", async () => {
    const { renderer } = await renderEditor();

    act(() => usePrevizStore.getState().selectClip("clip-1"));

    expect(renderer.setSelectedClip).toHaveBeenLastCalledWith("clip-1");
  });

  it("advances the playhead while playing", async () => {
    await renderEditor();
    // 假时钟只罩住播放这一段：`renderEditor` 里的 `create()` 是真异步的，
    // 提前换掉时钟会让那次等待永远等不到。
    // vitest 默认不假造 rAF 与 performance，这两样正是播放循环的心跳，得点名。
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    });
    try {
      act(() => {
        usePrevizStore.getState().setTimelinePlaying(true);
      });

      // 推进一秒的 rAF。tickPlayback 收的是真实耗时，所以这里推的是时钟，不是帧数。
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(usePrevizStore.getState().timelineFrame).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the playback loop when the editor closes", async () => {
    const { rerender } = await renderEditor();
    act(() => usePrevizStore.getState().setTimelinePlaying(true));

    rerender(<PrevizEditor {...editorProps({ open: false })} />);

    // 循环留在后台跑着，关掉编辑器之后播放头还在动，下次打开是从半路开始的。
    expect(usePrevizStore.getState().timelinePlaying).toBe(false);
  });

  it("draws a path with the pen tool", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.hud.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    let x = 0;
    renderer.groundPointAt.mockImplementation(() => [(x += 1), 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 70, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 70, clientY: 10 });

    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(1);
  });

  it("returns to the select tool after a stroke", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.hud.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.groundPointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 实测参照实现：画完一笔自动切回选择，否则下一次想选个对象反而又画了一条。
    expect(screen.getByRole("button", { name: "previz.hud.tool.select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not select an object with the pen down", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.hud.tool.draw" }));
    renderer.pickAt.mockClear();

    const canvas = screen.getByTestId("previz-canvas");
    renderer.groundPointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 画笔按下的那一下不能同时走拾取，否则一笔画完选中的对象已经换人了。
    expect(renderer.pickAt).not.toHaveBeenCalled();
  });

  it("ignores the pen with nothing selected", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    act(() => usePrevizStore.getState().selectObject(null));
    await user.click(screen.getByRole("button", { name: "previz.hud.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.groundPointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 没选对象时这一笔没有归属；建一条无主轨迹只会在时间轴上多一行删不掉的东西。
    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
  });

  it("toggles playback with the space bar", async () => {
    await renderEditor();

    fireEvent.keyDown(window, { key: " " });

    expect(usePrevizStore.getState().timelinePlaying).toBe(true);
  });

  it("steps frames with the arrow keys", async () => {
    await renderEditor();
    act(() => usePrevizStore.getState().setTimelineFrame(10));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(usePrevizStore.getState().timelineFrame).toBe(11);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(usePrevizStore.getState().timelineFrame).toBe(10);
  });
});
