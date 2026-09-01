// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultScene } from "@/features/previz/domain/scene";
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
