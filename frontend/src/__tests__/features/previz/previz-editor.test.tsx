// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { createPrevizObject } from "@/features/previz/domain/objects";
import {
  createDefaultScene,
  type PrevizPathClip,
  type Vec3,
} from "@/features/previz/domain/scene";
import type { CanvasRecorderOptions } from "@/features/previz/capture/recordTimeline";
import { PrevizRenderer } from "@/features/previz/engine/PrevizRenderer";
import { PrevizEditor } from "@/features/previz/PrevizEditor";
import { usePrevizStore } from "@/features/previz/store";
import { readUrl } from "@/lib/url-params";

const dispose = vi.fn();
const resize = vi.fn();
const setScene = vi.fn();
const setSelection = vi.fn();
const setActiveCamera = vi.fn();
const setLiveCamera = vi.fn();
const setGizmoMode = vi.fn();
const applyViewDirection = vi.fn();
const focusObject = vi.fn();
const resetView = vi.fn();
const pickAt = vi.fn(() => null as string | null);
const pickPathPointAt = vi.fn(() => null as { clipId: string; pointId: string } | null);
const capture = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
const setFrame = vi.fn();
const setSelectedClip = vi.fn();
const planePointAt = vi.fn(
  (_clientX: number, _clientY: number, _height: number): Vec3 | null => [0, 0, 0],
);
const setStroke = vi.fn((_points: readonly Vec3[] | null) => {});
const setDrawing = vi.fn((_active: boolean) => {});
const viewPose = vi.fn(() => ({ position: [6, 4, 8] as Vec3, target: [0, 1, 0] as Vec3 }));
const renderCameraPreview = vi.fn();
const renderQuadPreview = vi.fn();
const renderCameraView = vi.fn();
const setViewOverlays = vi.fn();
const setMonitorSize = vi.fn();
const recordDrawFrame = vi.fn();
const recordEnd = vi.fn();
const startRecording = vi.fn((_mode: string, _cameraId: string | null) => ({
  canvas: document.createElement("canvas"),
  width: 1920,
  height: 1080,
  drawFrame: recordDrawFrame,
  end: recordEnd,
}));

/** 每条用例一份全新的假渲染器，免得 onTransformCommit 在用例之间串。 */
function fakeRenderer() {
  return {
    dispose,
    resize,
    setScene,
    setSelection,
    setActiveCamera,
    setLiveCamera,
    setGizmoMode,
    applyViewDirection,
    focusObject,
    resetView,
    pickAt,
    pickPathPointAt,
    capture,
    setFrame,
    setSelectedClip,
    planePointAt,
    setStroke,
    setDrawing,
    viewPose,
    renderCameraPreview,
    renderQuadPreview,
    renderCameraView,
    setViewOverlays,
    setMonitorSize,
    startRecording,
    onTransformCommit: null as
      | ((objectId: string, transform: unknown) => void)
      | null,
    onViewChange: null as ((pose: { position: Vec3; target: Vec3 }) => void) | null,
    onTransformDrag: null as (() => void) | null,
  };
}

// WebGL 在 jsdom 里不存在；编辑器只需要知道自己正确地建了、也正确地拆了渲染器。
vi.mock("@/features/previz/engine/PrevizRenderer", () => ({
  PrevizRenderer: {
    create: vi.fn(async () => fakeRenderer()),
  },
}));

const addDerivedUploadNode = vi.fn(() => "upload-1");
const addDerivedVideoNode = vi.fn(() => "video-1");
const addEdge = vi.fn(() => "edge-1");
const uploadFreezoneVideo = vi.fn(async () => ({ url: "/static/take.mp4" }));

vi.mock("@/lib/url-params", () => ({
  readUrl: vi.fn(() => ({ project: "demo" })),
}));

// ESM 的 mock 是整体替换：漏掉一个导出，被测模块 import 到的就是 undefined。
// 工厂跑在本文件常量求值之前，所以引用得包一层箭头，直接写名字会撞 TDZ。
vi.mock("@/api/ops", () => ({
  uploadFreezoneImage: vi.fn(async () => ({ url: "/static/shot.png" })),
  uploadFreezoneVideo: () => uploadFreezoneVideo(),
  uploadFreezoneAudio: vi.fn(async () => ({ url: "/static/take.mp3" })),
}));

// 这两个都是 vi.fn 而不是匿名箭头：混音那条线唯一的出口就是「录制器收到了什么
// options」，桩子不记参数的话，把 `audioStream` 整句删掉测试也照样全绿。
// 默认实现单独起名：`beforeEach` 里要把它原样装回去（见那里的注释）。
const defaultCanvasRecorder = (
  _canvas: HTMLCanvasElement,
  _options: CanvasRecorderOptions,
) => ({
  start: () => {},
  stop: async () => new Blob(["take"], { type: "video/mp4" }),
});
const createCanvasRecorder = vi.fn(defaultCanvasRecorder);
// 按 `withAudio` 分两种容器，跟真实实现一致：一律返回同一个值的话，「有 AudioContext
// 但没有带音轨的容器」那半边分支永远走不到。
const defaultRecordMimeType = (_isSupported?: unknown, withAudio?: boolean): string | null =>
  withAudio ? "video/mp4;codecs=avc1.42E01E,mp4a.40.2" : "video/mp4";
const pickRecordMimeType = vi.fn(defaultRecordMimeType);

// jsdom 里既没有 MediaRecorder 也没有 canvas.captureStream；只换掉碰浏览器 API 的
// 那两个导出，驱动循环本身走真实实现——这条用例要验的正是它把录制串起来了。
vi.mock("@/features/previz/capture/recordTimeline", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/previz/capture/recordTimeline")>()),
  pickRecordMimeType: (...args: Parameters<typeof pickRecordMimeType>) =>
    pickRecordMimeType(...args),
  createCanvasRecorder: (...args: Parameters<typeof createCanvasRecorder>) =>
    createCanvasRecorder(...args),
}));

// jsdom 没有 AudioContext，编辑器又只经这三个导出碰它；假一份就够，播放引擎自己的
// 行为归 audio-playback 那组用例管。
const audioDestination = { stream: { getAudioTracks: () => [] } };
const audioContext = { createMediaStreamDestination: () => audioDestination };
const audioPlayback = {
  context: audioContext,
  load: vi.fn(async (_clips: unknown) => {}),
  // 形参写全是为了 `mock.calls` 有长度可数：扬声器那一路是三参数、混音那一路带
  // destination，用例正是靠这个长度把两者分开。
  play: vi.fn(
    async (_clips: unknown, _fromFrame: number, _rate: number, _destination?: unknown) => {},
  ),
  stop: vi.fn(),
  dispose: vi.fn(),
  failedUrls: new Set<string>(),
};
const createAudioContext = vi.fn(() => audioContext);

vi.mock("@/features/previz/engine/audioPlayback", () => ({
  createAudioContext: () => createAudioContext(),
  fetchAudioBuffer: vi.fn(),
  createAudioPlayback: () => audioPlayback,
}));

vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ addDerivedUploadNode, addDerivedVideoNode, addEdge }),
    { getState: () => ({ addDerivedUploadNode, addDerivedVideoNode, addEdge }) },
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

// dispose / resize 是模块级共享的，而 testing-library 每个用例结束都会自动
// unmount、从而触发一次 dispose。不清的话第三条用例的 toHaveBeenCalledTimes(1)
// 会数到前两条留下的调用。
// store 也是模块级单例：新加的用例读它的真实状态，不重置就会串。
// `clearAllMocks()` 只抹调用记录，既不还原实现，也不清 `mockReturnValueOnce` /
// `mockImplementationOnce` 排下的队。哪条用例排了一次「返回 null」却没走到那一步，
// 这个 once 就会原封不动留给下一条用例，红在一个跟它毫无关系的地方。这三个桩子都被
// 用例按 once 改过，逐个 reset 回默认实现。
beforeEach(() => {
  vi.clearAllMocks();
  createAudioContext.mockReset().mockImplementation(() => audioContext);
  pickRecordMimeType.mockReset().mockImplementation(defaultRecordMimeType);
  createCanvasRecorder.mockReset().mockImplementation(defaultCanvasRecorder);
  usePrevizStore.getState().loadScene(createDefaultScene());
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      // 进度那句只有把 percent 插进来才看得见，「进度条走了几档」在 DOM 上就是它。
      if (options && "percent" in options) return `${key}:${options.percent}`;
      return options && "frames" in options ? `${key}:${options.frames}` : key;
    },
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
  it("lets the viewport hide the monitor picture-in-picture", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    // 没在监看时不该挂这个按钮：画布右下角空着，多一个关不掉的叉只会碍事。
    expect(screen.queryByTestId("previz-monitor-hide")).toBeNull();

    act(() => {
      usePrevizStore.getState().setActiveCamera(scene.objects[0]!.id);
    });

    const hide = screen.getByTestId("previz-monitor-hide");
    // 无障碍名写字面量：从被测组件读回 key 等于什么都没锁。
    expect(hide).toHaveAccessibleName("previz.editor.hideMonitor");

    await user.click(hide);

    // 关掉的是「谁在监看」这个状态本身，不是单藏一块画面——图层面板上那个
    // 监看图标要跟着灭掉，否则界面上会同时显示「正在监看」和一个空的右下角。
    expect(usePrevizStore.getState().activeCameraId).toBeNull();
    expect(screen.queryByTestId("previz-monitor-hide")).toBeNull();
  });

  it("brings the monitor back from the same corner", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));
    scene.objects.push(createPrevizObject("camera", scene.objects));
    const second = scene.objects[1]!.id;

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    act(() => {
      usePrevizStore.getState().setActiveCamera(second);
    });
    await user.click(screen.getByTestId("previz-monitor-hide"));

    // 关掉之后视口里得留一个开回来的入口。唯一的入口是右侧图层面板那个显示器图标的话，
    // 从画面上按叉关掉的人根本找不回来——那个叉就成了单向门。
    const show = screen.getByTestId("previz-monitor-show");
    expect(show).toHaveAccessibleName("previz.editor.showMonitor");

    await user.click(show);

    // 回到刚才那台，而不是场景里的第一台：机位不止一个时，「关掉再打开」不该顺手换一台。
    expect(usePrevizStore.getState().activeCameraId).toBe(second);
    expect(screen.queryByTestId("previz-monitor-show")).toBeNull();
  });

  it("offers no monitor switch until the scene has a camera", () => {
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    // 没有机位可监看时那个按钮点了也没有东西可开，挂着只是画布右下角一块空占位。
    expect(screen.queryByTestId("previz-monitor-show")).toBeNull();
  });

  it("hands the monitor's outline and name-plate switches to the renderer", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    act(() => {
      usePrevizStore.getState().setActiveCamera(scene.objects[0]!.id);
    });

    const outline = screen.getByTestId("previz-monitor-outline");
    const plate = screen.getByTestId("previz-monitor-plate");
    // 两样默认都开着：认不出画面里谁是谁的话，监看这块小画面就只是一团灰模型。
    expect(outline).toHaveAttribute("aria-pressed", "true");
    expect(plate).toHaveAttribute("aria-pressed", "true");

    await user.click(outline);
    // 一次只关一样，另一样原样传下去——两个开关合成一个对象发给渲染器，
    // 漏带没动的那个会把它一起关掉。
    expect(setViewOverlays).toHaveBeenLastCalledWith({ outline: false, namePlate: true });

    await user.click(plate);
    expect(setViewOverlays).toHaveBeenLastCalledWith({ outline: false, namePlate: false });
    expect(outline).toHaveAttribute("aria-pressed", "false");
    expect(plate).toHaveAttribute("aria-pressed", "false");
  });

  it("enlarges the monitor and offers the way back", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    act(() => {
      usePrevizStore.getState().setActiveCamera(scene.objects[0]!.id);
    });

    const size = screen.getByTestId("previz-monitor-size");
    expect(size).toHaveAccessibleName("previz.monitor.enlarge");

    await user.click(size);

    // 尺寸只影响画面在画布上占多大，跟出片无关，所以走渲染器而不是场景设置。
    expect(setMonitorSize).toHaveBeenLastCalledWith("large");
    // 同一个按钮换成还原：放大之后没有回头路的话，小画面就再也拿不回来了。
    expect(size).toHaveAccessibleName("previz.monitor.restore");

    await user.click(size);
    expect(setMonitorSize).toHaveBeenLastCalledWith("normal");
  });

  it("switches the output aspect from the monitor frame", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    act(() => {
      usePrevizStore.getState().setActiveCamera(scene.objects[0]!.id);
    });

    const select = screen.getByLabelText<HTMLSelectElement>("previz.monitor.aspect");
    // 左栏那份画幅下拉撤掉之后，这里是改出片画幅的唯一入口，四个比例都得在。
    expect([...select.options].map((option) => option.value)).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
    ]);

    await user.selectOptions(select, "9:16");

    // 画幅比是真出片参数，落在场景设置里；监看框只是它的入口。
    expect(usePrevizStore.getState().scene.settings.outputAspect).toBe("9:16");
    expect(select).toHaveValue("9:16");
  });

  it("collapses and reopens the timeline panel from the rail", async () => {
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

    // 时间码是轨迹面板独有的读数，拿它当「这块面板在不在」的探针。
    expect(screen.getByTestId("previz-timecode")).toBeInTheDocument();

    const toggle = screen.getByTestId("previz-timeline-toggle");
    await user.click(toggle);

    expect(screen.queryByTestId("previz-timecode")).toBeNull();
    // 开关本身留在原地：卸掉的是面板，不是那颗按钮——否则收起来就再也开不回来。
    expect(toggle).toHaveAccessibleName("previz.toolbar.expandTimeline");

    await user.click(toggle);
    expect(screen.getByTestId("previz-timecode")).toBeInTheDocument();
  });

  it("keeps the property column closed until something is selected", async () => {
    const scene = createDefaultScene();
    const camera = createPrevizObject("camera", scene.objects);
    scene.objects.push(camera);

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    // 什么都没选时只有对象列表：两条「选中后在这里编辑」的占位一起藏起来，别占着一整列。
    expect(screen.getByText("previz.layers.title")).toBeInTheDocument();
    expect(screen.queryByText("previz.inspector.empty")).toBeNull();
    expect(screen.queryByText("previz.clip.empty")).toBeNull();

    act(() => usePrevizStore.getState().selectObject(camera.id));
    expect(screen.getByText("previz.inspector.name")).toBeInTheDocument();

    act(() => usePrevizStore.getState().selectObject(null));
    expect(screen.queryByText("previz.inspector.name")).toBeNull();
    expect(screen.queryByText("previz.inspector.empty")).toBeNull();

    // 只在时间轴上点中片段、没点对象，片段属性照样要能编：这一列跟着片段开。
    act(() => usePrevizStore.getState().addObjectToTimeline(camera.id));
    expect(screen.queryByText("previz.clip.empty")).toBeNull();
    expect(screen.getByText("previz.inspector.empty")).toBeInTheDocument();
  });

  it("collapses and reopens the side panels", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    const camera = createPrevizObject("camera", scene.objects);
    scene.objects.push(camera);

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    // 先选中一个对象把属性列请出来：没选中时那一列本来就不在，收起来就没得验。
    act(() => usePrevizStore.getState().selectObject(camera.id));
    expect(screen.getByText("previz.layers.title")).toBeInTheDocument();
    expect(screen.getByText("previz.inspector.name")).toBeInTheDocument();

    const toggle = screen.getByTestId("previz-panels-toggle");
    expect(toggle).toHaveAccessibleName("previz.editor.collapsePanels");
    await user.click(toggle);

    // 图层与属性一起收：这两块上下相接、共用一条左边框，单收一块会在接缝处留下半截边。
    expect(screen.queryByText("previz.layers.title")).toBeNull();
    expect(screen.queryByText("previz.inspector.name")).toBeNull();

    // 把手留在原地，而且换成了「展开」——收起之后没有入口的话这就是一扇单向门。
    const reopen = screen.getByTestId("previz-panels-toggle");
    expect(reopen).toHaveAccessibleName("previz.editor.expandPanels");
    await user.click(reopen);

    expect(screen.getByText("previz.layers.title")).toBeInTheDocument();
  });

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

    // 机位不是点一下就建：先开创建对话框，让用户定焦距、画幅与朝向。
    expect(screen.getByRole("dialog", { name: "previz.cameraCreate.title" })).toBeInTheDocument();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.submit" }));

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(1);
    const created = state.scene.objects[0]!;
    // 新建即选中：否则用户建完还得自己去右边点一下才能改属性。
    expect(state.selectedObjectId).toBe(created.id);
    // 监看也切过去，不然建完机位右下角还盯着上一台。
    expect(state.activeCameraId).toBe(created.id);
    // 站位与朝向从导演视角来：视角 [6,4,8] 看向 [0,1,0]，往前挪 20% 落在 [4.8, 3.4, 6.4]。
    expect(created.transform.position[0]).toBeCloseTo(4.8, 6);
    expect(created.transform.rotation[1]).toBeCloseTo(36.9, 6);
    // 对话框关掉了，不会挡着刚建好的机位。
    expect(screen.queryByRole("dialog", { name: "previz.cameraCreate.title" })).toBeNull();
  });

  it("closes the camera dialog without creating anything", async () => {
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
    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.close" }));

    expect(screen.queryByRole("dialog", { name: "previz.cameraCreate.title" })).toBeNull();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it("draws the create dialog preview through the renderer", async () => {
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

    expect(renderCameraPreview).toHaveBeenCalled();
    const call = renderCameraPreview.mock.calls[renderCameraPreview.mock.calls.length - 1];
    expect(call?.[0]).toBe(screen.getByTestId("camera-create-preview"));
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
    // 六个方向现在是视口左上角那颗坐标轴小球上的六颗球。
    await user.click(screen.getByRole("button", { name: "previz.viewport.view.top" }));

    expect(applyViewDirection).toHaveBeenCalledWith("top");
  });

  // 聚焦要拿的是「当前选中的那个对象的 id」，而选中态存在 store 里、按钮在视口浮层上：
  // 这中间接错一环的表现是「点了聚焦，相机飞去了别的对象」，组件自己的用例看不见。
  it("focuses the selected object through the renderer", async () => {
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
    // 没选中东西时聚焦无从聚起。
    expect(screen.getByRole("button", { name: "previz.viewport.focus" })).toBeDisabled();

    act(() => {
      usePrevizStore.getState().addObject("character");
    });
    const selected = usePrevizStore.getState().selectedObjectId;
    expect(selected).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "previz.viewport.focus" }));

    expect(focusObject).toHaveBeenCalledWith(selected);
  });

  /*
    四视图是「开关在视口浮层、画布在右侧那一列、内容要渲染器来画」三处联动。断言画到
    哪块画布上而不只是「调用过」：两块画布接反了的话，俯视与侧视的标题会各配错一张图，
    而这正是用来读走位的两张图。
  */
  it("renders the two ortho previews once the quad view is on", async () => {
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
    expect(screen.queryByTestId("previz-quad-top")).toBeNull();

    await user.click(screen.getByRole("button", { name: "previz.viewport.quadView" }));

    await vi.waitFor(() => expect(renderQuadPreview).toHaveBeenCalledTimes(2));
    expect(renderQuadPreview.mock.calls[0]).toEqual([
      screen.getByTestId("previz-quad-top"),
      "top",
    ]);
    expect(renderQuadPreview.mock.calls[1]).toEqual([
      screen.getByTestId("previz-quad-side"),
      "right",
    ]);

    // 再点一次收起来：两块画布跟着走，不留在那儿当死图。
    await user.click(screen.getByRole("button", { name: "previz.viewport.quadView" }));
    expect(screen.queryByTestId("previz-quad-side")).toBeNull();
  });

  /*
    四视图的第四格是机位眼里的画面。建了机位就该看得见，不必先去图层面板设一次监看——
    要求先设的话，用户对着一格黑画面根本猜不到自己漏了哪步。场景里一台机位都没有时那格
    摆提示文字：留一块黑画布，用户分不出「没有机位」和「渲染坏了」。
  */
  it("renders a camera view in the fourth pane, preferring the monitor camera", async () => {
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
    await user.click(screen.getByRole("button", { name: "previz.viewport.quadView" }));

    await vi.waitFor(() => expect(renderQuadPreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("previz-quad-camera")).toBeNull();
    expect(screen.getByText("previz.viewport.quadNoCamera")).toBeInTheDocument();
    expect(renderCameraView).not.toHaveBeenCalled();

    // 只建机位、不设监看：那一格照样出画。
    let first: string | null = null;
    act(() => {
      first = usePrevizStore.getState().addObject("camera");
    });

    await vi.waitFor(() => expect(renderCameraView).toHaveBeenCalled());
    expect(renderCameraView).toHaveBeenCalledWith(
      screen.getByTestId("previz-quad-camera"),
      first,
    );

    // 设了监看就跟着监看那台走，而不是继续画场景里的第一台。
    act(() => {
      const store = usePrevizStore.getState();
      const second = store.addObject("camera");
      store.setActiveCamera(second);
    });

    await vi.waitFor(() =>
      expect(renderCameraView).toHaveBeenLastCalledWith(
        screen.getByTestId("previz-quad-camera"),
        usePrevizStore.getState().activeCameraId,
      ),
    );
  });

  /*
    拖手柄期间对象只在 three 的场景里动，变换要到松手才写回 store（每帧都提交等于毁掉
    撤销）。只跟着 store 走的话这两张参照图会僵在原地、松手才瞬移过去——而边拖边看俯视图
    对位置正是四视图存在的理由。
  */
  it("redraws the ortho previews while the gizmo is being dragged", async () => {
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
    await user.click(screen.getByRole("button", { name: "previz.viewport.quadView" }));
    await vi.waitFor(() => expect(renderQuadPreview).toHaveBeenCalledTimes(2));

    const renderer = await vi.mocked(PrevizRenderer.create).mock.results[0]!.value;
    // 一次拖拽这条信号能来几百次。连报三次只该重画一轮：两张图跟手就够了，跟上鼠标的
    // 采样率就是白跑几百趟离屏渲染。
    act(() => {
      renderer.onTransformDrag?.();
      renderer.onTransformDrag?.();
      renderer.onTransformDrag?.();
    });

    // 合并没生效的话这里会是 8，等不到 4，用例超时。
    await vi.waitFor(() => expect(renderQuadPreview).toHaveBeenCalledTimes(4));
  });

  /*
    撤销重做与显示模式、重置视角从左栏搬到了视口两角（见 `PrevizViewportControls`）。搬家
    真正会断的是接线：按钮还在、图标还对，回调却接到了隔壁那个 prop 上——组件自己的用例
    只看得见「点了会调用传进来的函数」，接错了也照样绿。所以这里从编辑器整体验一遍：一头
    是存储，一头是渲染器。
  */
  it("wires the relocated viewport controls to the store and the renderer", async () => {
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
    // 刚打开的场景没有可撤销的步骤。
    expect(screen.getByRole("button", { name: "previz.editor.undo" })).toBeDisabled();

    act(() => {
      usePrevizStore.getState().addObject("character");
    });
    const added = usePrevizStore.getState().scene.objects.length;
    await user.click(screen.getByRole("button", { name: "previz.editor.undo" }));
    expect(usePrevizStore.getState().scene.objects).toHaveLength(added - 1);

    await user.click(screen.getByRole("button", { name: "previz.editor.redo" }));
    expect(usePrevizStore.getState().scene.objects).toHaveLength(added);

    await user.click(screen.getByRole("button", { name: "previz.viewport.display.clay" }));
    expect(usePrevizStore.getState().scene.settings.displayMode).toBe("clay");

    resetView.mockClear();
    await user.click(screen.getByRole("button", { name: "previz.viewport.resetView" }));
    expect(resetView).toHaveBeenCalledTimes(1);

    // 间距是画笔的参数，落点在 store 上；浮层只是它现在的住处。
    const spacing = screen.getByLabelText<HTMLInputElement>("previz.viewport.pathSpacing");
    await user.clear(spacing);
    await user.type(spacing, "1.5");
    await user.tab();
    expect(usePrevizStore.getState().pathSpacingM).toBe(1.5);
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

  it("records the current track and publishes a video node", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    // 只留一帧：录制按墙上时钟走，默认的 120 帧会让这条用例真等四秒。
    scene.settings.durationFrames = 1;
    scene.objects.push(createPrevizObject("camera", scene.objects));
    const cameraId = scene.objects[0]!.id;

    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => usePrevizStore.getState().selectObject(cameraId));

    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.track" }),
    );

    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 3000 });

    // 录的是那台机位的画面，不是导演视角——这正是「当前轨道录制」与「全局录制」的分别。
    expect(startRecording).toHaveBeenCalledWith("track", cameraId);
    expect(recordDrawFrame).toHaveBeenCalled();
    // 出片阶段结束要把辅助物的可见性还回去，否则手柄与轨迹在编辑器里一直不见。
    expect(recordEnd).toHaveBeenCalled();
    expect(uploadFreezoneVideo).toHaveBeenCalled();
    expect(addDerivedVideoNode).toHaveBeenCalledWith(
      "previz-1",
      "/static/take.mp4",
      "16:9",
      "previz.editor.record.trackNodeName",
      // 时间轴只有 1 帧，30fps 下就是 33ms：顺手把单位钉成毫秒。
      33,
    );
    // 光有节点不算接出来：画布上得有一条从预演台连过去的边。
    expect(addEdge).toHaveBeenCalledWith("previz-1", "video-1");
  });

  it("moves the playhead only every few frames while recording", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    // 13 而不是 12：12 是步长 3 的整数倍，末帧会被常规节流顺手推到，那个「末帧必推」
    // 的兜底就白写了也测不出来。13 只能靠它。
    scene.settings.durationFrames = 13;
    scene.objects.push(createPrevizObject("camera", scene.objects));
    const cameraId = scene.objects[0]!.id;
    await renderEditor({ initialScene: scene });
    act(() => {
      usePrevizStore.getState().selectObject(cameraId);
      // 先把播放头挪开：开录第一帧推回 0 的那一下也得数进去。
      usePrevizStore.getState().setTimelineFrame(5);
    });
    const pushed: number[] = [];
    const unsubscribe = usePrevizStore.subscribe((state, previous) => {
      if (state.timelineFrame !== previous.timelineFrame) pushed.push(state.timelineFrame);
    });

    // 假时钟只罩住录制循环：`renderEditor` 里的 `create()` 是真异步的。录制按墙上时钟
    // 换算帧号，假 rAF 每 16ms 一拍、30fps 每 33ms 一帧，于是 0..12 帧一帧不落地画到。
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    });
    try {
      await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
      await user.click(
        screen.getByRole("menuitem", { name: "previz.editor.record.mode.track" }),
      );
      // 12 帧是 400ms，末尾再留 250ms 尾巴；多推一些，把收工那一拍也跑掉。
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await vi.waitFor(() => expect(recordEnd).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
      unsubscribe();
    }

    const drawn = recordDrawFrame.mock.calls.map(([frame]) => frame as number);
    expect(drawn[0]).toBe(0);
    expect(drawn[drawn.length - 1]).toBe(13);
    // 每画一帧都推播放头的话，整棵编辑器每帧重渲一遍、再把这一帧重新解算一遍，
    // 30fps 下这占掉每帧预算的一大块。播放头只要看得出在走就够了，但末帧必须推到。
    expect(pushed.length).toBeLessThan(drawn.length);
    expect(pushed).toEqual([0, 3, 6, 9, 12, 13]);
  });

  it("steps the recording progress in coarse jumps, but finishes at 100%", async () => {
    const user = userEvent.setup();
    const scene = createDefaultScene();
    // 够长才测得出来：121 帧下每帧只推进 0.83%，比 2% 那一档细，节流才有事可做。
    // 取 121 而不是 120：末帧的比例得**不是**恰好落在 2% 的档口上，那个「ratio 为 1
    // 必推」的兜底才是唯一能把进度条送到 100% 的东西。
    scene.settings.durationFrames = 121;
    scene.objects.push(createPrevizObject("camera", scene.objects));
    const cameraId = scene.objects[0]!.id;
    await renderEditor({ initialScene: scene });
    act(() => usePrevizStore.getState().selectObject(cameraId));

    const shown: number[] = [];
    /** 录制中那颗按钮上写着百分比；每报一次进度就重渲一次，这里逐拍取样。 */
    const sample = (button: HTMLElement) => {
      const match = /stopWithProgress:(\d+)/.exec(button.textContent ?? "");
      if (!match) return;
      const percent = Number(match[1]);
      if (shown[shown.length - 1] !== percent) shown.push(percent);
    };

    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    });
    try {
      await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
      await user.click(
        screen.getByRole("menuitem", { name: "previz.editor.record.mode.track" }),
      );
      // 按钮那个 DOM 节点跨重渲是同一个，抓一次就够，逐拍读它的文字。
      const button = screen.getByRole("button", { name: "previz.editor.record.stop" });
      sample(button);
      // 120 帧是 4 秒，末尾再留 250ms 尾巴；按假 rAF 的节拍一拍一拍推，别一口气跳过去。
      for (let tick = 0; tick < 300; tick += 1) {
        act(() => {
          vi.advanceTimersByTime(16);
        });
        sample(button);
      }
      await vi.waitFor(() => expect(recordEnd).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }

    const drawn = recordDrawFrame.mock.calls.length;
    expect(drawn).toBeGreaterThan(100);
    // 每帧都 setState 的话进度条会走满 101 档，每一档都是一次整棵编辑器的重渲。
    expect(shown.length).toBeLessThan(drawn / 2);
    // 进度条得从 0 开始、也得真的走满：2% 一档的取整不能把它卡在 99%。
    expect(shown[0]).toBe(0);
    expect(shown[shown.length - 1]).toBe(100);
  });

  it("refuses a track recording with no camera to follow", async () => {
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
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.track" }),
    );

    // 场景里一台机位都没有时宁可什么都不录：默默录成导演视角的话，用户拿到的是
    // 一段标着「轨道录制」的错画面，比报错难查得多。
    expect(startRecording).not.toHaveBeenCalled();
    expect(addDerivedVideoNode).not.toHaveBeenCalled();
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
  return {
    ...result,
    renderer: {
      setFrame,
      setSelectedClip,
      planePointAt,
      setStroke,
      setDrawing,
      pickAt,
      pickPathPointAt,
    },
  };
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

    expect(renderer.setSelectedClip).toHaveBeenLastCalledWith("clip-1", null);
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
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    let x = 0;
    renderer.planePointAt.mockImplementation(() => [(x += 1), 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 70, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 70, clientY: 10 });

    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(1);
  });

  it("draws on the plane the selected object sits on", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("camera")!;
    act(() => {
      usePrevizStore.getState().selectObject(objectId);
      usePrevizStore.getState().updateObject(objectId, {
        transform: {
          position: [0, 4, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      });
    });
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockClear();
    renderer.planePointAt.mockReturnValue([1, 4, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 打到地面上的话，给 4 米高的机位画完一笔机位就掉到地上了。整笔共用按下那一刻的
    // 高度：中途重算的话，笔画会在自己造成的移动上滑坡。
    expect(renderer.planePointAt.mock.calls.map((call) => call[2])).toEqual([4, 4]);
  });

  it("shows the stroke while it is being drawn, and drops it on release", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    let x = 0;
    renderer.planePointAt.mockImplementation(() => [(x += 1), 0, 0]);
    // 交出去的是那支笔画数组本体（渲染器当场就把坐标抄进缓冲），事后翻 mock.calls
    // 读到的三次都是同一个已经长满的数组——长度必须在调用的那一刻记下来。
    const lengths: (number | null)[] = [];
    renderer.setStroke.mockImplementation((points) => void lengths.push(points?.length ?? null));
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 70, clientY: 10 });

    // 每一下都要交出去：只在松手时给一次的话，画的过程仍然是盲的。
    expect(lengths).toEqual([1, 2, 3]);

    fireEvent.pointerUp(canvas, { clientX: 70, clientY: 10 });

    // 松手后由轨迹曲线接管；不收笔的话两条线重叠着留在画面上。
    expect(lengths[lengths.length - 1]).toBeNull();
  });

  it("returns to the select tool after a stroke", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 实测参照实现：画完一笔自动切回选择，否则下一次想选个对象反而又画了一条。
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /*
    画笔和轨道操作听的是同一块 canvas 上同一串「按住左键拖」。绘制期间不把左键从轨道
    旋转上摘下来，用户每划一笔整个空间就跟着转一次——而笔画落点是拿当下的相机打射线
    求出来的，视角边转边画，出来的轨迹和手划过的形状对不上。
  */
  it("takes the left button off the orbit while the draw tool is active", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));

    // 选择工具下左键照常转视角。
    expect(renderer.setDrawing).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));
    expect(renderer.setDrawing).toHaveBeenLastCalledWith(true);

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 画完自动切回选择，左键也得跟着还回去——还不回去就再也转不动视角了。
    expect(renderer.setDrawing).toHaveBeenLastCalledWith(false);
  });

  it("selects the path point under the pointer", async () => {
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    renderer.pickAt.mockClear();
    renderer.pickPathPointAt.mockReturnValueOnce({ clipId: "clip-9", pointId: "point-3" });

    const canvas = screen.getByTestId("previz-canvas");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    const state = usePrevizStore.getState();
    expect(state.selectedClipId).toBe("clip-9");
    expect(state.selectedPointId).toBe("point-3");
    // 轨迹点球是画在被它牵着走的那个对象身上的，按「最近的命中」算的话它永远输给对象，
    // 也就永远点不中；点球时干脆不问对象拾取。
    expect(renderer.pickAt).not.toHaveBeenCalled();
    // 选点不该把对象的选中状态挪走：右侧面板上下两半正好是「谁在动」和「动到哪」。
    expect(state.selectedObjectId).toBe(objectId);
  });

  it("falls back to picking an object when no path point is under the pointer", async () => {
    const { renderer } = await renderEditor();
    renderer.pickAt.mockClear();

    const canvas = screen.getByTestId("previz-canvas");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    expect(renderer.pickAt).toHaveBeenCalledTimes(1);
    expect(usePrevizStore.getState().selectedObjectId).toBeNull();
  });

  it("skips picking with the navigate tool, but still picks once back on select", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.navigate" }));
    renderer.pickAt.mockClear();
    renderer.pickPathPointAt.mockClear();

    const canvas = screen.getByTestId("previz-canvas");
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 导航工具点一下不选也不清选中：转到一半误点不会把面板换掉，给没有中键的触控板用。
    expect(renderer.pickAt).not.toHaveBeenCalled();
    expect(renderer.pickPathPointAt).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().selectedObjectId).toBe(objectId);

    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.select" }));
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 切回选择，同一个点还是照常走拾取。
    expect(renderer.pickAt).toHaveBeenCalledTimes(1);
  });

  it("does not select an object with the pen down", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));
    renderer.pickAt.mockClear();

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 画笔按下的那一下不能同时走拾取，否则一笔画完选中的对象已经换人了。
    expect(renderer.pickAt).not.toHaveBeenCalled();
  });

  it("ignores the pen with nothing selected", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    act(() => usePrevizStore.getState().selectObject(null));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
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

  it("switches tool with the W and Q keys, matching Blender", async () => {
    await renderEditor();

    fireEvent.keyDown(window, { key: "q" });
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.navigate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "w" });
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("ignores W and Q mid-stroke, so the camera does not orbit under a live pen", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });

    fireEvent.keyDown(window, { key: "q" });

    // 笔画还按着：Q 不该把工具切成导航，否则 setDrawing 的效果会重挂左键、
    // 让视口在笔下转起来。
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.draw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.navigate" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 松手照常收笔、自动切回选择——快捷键拦截只挡笔画中途，不影响画完的既有行为。
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("switches the gizmo mode with the G, R and S keys, matching Blender", async () => {
    await renderEditor();

    fireEvent.keyDown(window, { key: "r" });
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.rotate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.scale" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.keyDown(window, { key: "g" });
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.translate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("no longer treats E as a gizmo shortcut", async () => {
    await renderEditor();
    // 先切到旋转以外的手柄：E 以前正是旋转的键位，如果它没被摘干净，这里会悄悄切回去。
    fireEvent.keyDown(window, { key: "s" });

    fireEvent.keyDown(window, { key: "e" });

    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.scale" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  // 每颗按钮角上现在画着一个键帽（PrevizToolbar 里的 shortcut prop）。这条把角标念出
  // 的字母喂回真正的 keydown 处理器，两边才不会静悄悄地对不上——角标改了字母而没人
  // 跟着改这里的键位绑定，或者反过来，都会在这里变红。
  //
  // 次序不是随手写的：初始状态就是 select / translate，如果把它们摆在最前面，那一步
  // 断言在 case "w" / case "g" 被删掉之后依然是「本来就 true」，全程不会变红。每一条
  // 都得先离开那颗按钮的选中态，再靠对应的键把它按回来，断言才是真的在验证这颗键。
  it("every badged key activates the button it is drawn on", async () => {
    await renderEditor();

    const badged = [
      "previz.toolbar.tool.navigate", // 默认是 select，先按 Q 才看得出 W 有没有生效
      "previz.toolbar.tool.select",
      "previz.toolbar.gizmo.rotate", // 默认是 translate，同理
      "previz.toolbar.gizmo.scale",
      "previz.toolbar.gizmo.translate",
    ];

    for (const label of badged) {
      const control = screen.getByRole("button", { name: label });
      const key = control.getAttribute("aria-keyshortcuts");
      expect(key, `${label} should carry a shortcut badge`).toBeTruthy();

      fireEvent.keyDown(window, { key: (key as string).toLowerCase() });

      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
  });

  // 视口那两颗角标（H、F）不进上面那条循环：它们不是切换态的按钮，「生效」看的是
  // 对应回调有没有被调用一次，而不是 aria-pressed。键位同样从 aria-keyshortcuts 上
  // 读出来，不手写字母，理由同上——两边对不上时这里要红。
  it("badges H and F actually reset the view and focus the selection", async () => {
    await renderEditor();

    const reset = screen.getByRole("button", { name: "previz.viewport.resetView" });
    const resetKey = reset.getAttribute("aria-keyshortcuts");
    expect(resetKey, "reset view should carry a shortcut badge").toBeTruthy();
    resetView.mockClear();

    fireEvent.keyDown(window, { key: (resetKey as string).toLowerCase() });

    expect(resetView).toHaveBeenCalledTimes(1);

    // 聚焦无从聚起时是禁用的（见前面「focuses the selected object」那条），先选中一个
    // 对象再按键，跟鼠标点击那条用例走的是同一条路径。
    act(() => {
      usePrevizStore.getState().addObject("character");
    });
    const selected = usePrevizStore.getState().selectedObjectId;
    expect(selected).toBeTruthy();

    const focus = screen.getByRole("button", { name: "previz.viewport.focus" });
    const focusKey = focus.getAttribute("aria-keyshortcuts");
    expect(focusKey, "focus should carry a shortcut badge").toBeTruthy();
    focusObject.mockClear();

    fireEvent.keyDown(window, { key: (focusKey as string).toLowerCase() });

    expect(focusObject).toHaveBeenCalledWith(selected);
  });
});

describe("PrevizEditor mark tool", () => {
  const MARK = "previz.toolbar.tool.mark";

  function click(canvas: HTMLElement, x: number, y: number) {
    fireEvent.pointerDown(canvas, { clientX: x, clientY: y });
    fireEvent.pointerUp(canvas, { clientX: x, clientY: y });
  }

  function pathClips(): PrevizPathClip[] {
    return usePrevizStore
      .getState()
      .scene.timeline.tracks.flatMap((track) => track.clips)
      .filter((clip): clip is PrevizPathClip => clip.kind === "path");
  }

  async function markingEditor() {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character")!;
    act(() => usePrevizStore.getState().selectObject(objectId));
    await user.click(screen.getByRole("button", { name: MARK }));
    renderer.planePointAt.mockClear();
    return { user, renderer, objectId, canvas: screen.getByTestId("previz-canvas") };
  }

  it("places a point on every click and keeps the tool armed", async () => {
    const { renderer, canvas } = await markingEditor();
    renderer.planePointAt.mockReturnValueOnce([1, 0, 0]).mockReturnValueOnce([1, 0, 3]);

    click(canvas, 10, 10);
    click(canvas, 60, 10);

    const clips = pathClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].points.map((point) => point.position)).toEqual([
      [1, 0, 0],
      [1, 0, 3],
    ]);
    // 打点不像画笔那样一笔画完就切回选择：用户要连着点好几下，每下都切回去就没法用了。
    expect(screen.getByRole("button", { name: MARK })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the plane height of the first click for the whole session", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("camera")!;
    act(() => {
      usePrevizStore.getState().selectObject(objectId);
      usePrevizStore.getState().updateObject(objectId, {
        transform: { position: [0, 4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
    });
    await user.click(screen.getByRole("button", { name: MARK }));
    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockClear();
    // 第一下打完机位就被轨迹牵到 9 米高；第二下要是重新按当前高度取平面，两个点会落在
    // 两个平面上，整条轨迹在自己造成的移动上滑坡。
    renderer.planePointAt.mockReturnValue([1, 9, 0]);

    click(canvas, 10, 10);
    click(canvas, 60, 10);

    expect(renderer.planePointAt.mock.calls.map((call) => call[2])).toEqual([4, 4]);
  });

  it("leaves the left button on the orbit, so a drag places nothing", async () => {
    const { renderer, canvas } = await markingEditor();
    renderer.planePointAt.mockReturnValue([1, 0, 0]);

    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 60, clientY: 10 });

    // 打点靠单击，拖拽仍然是转视角：只有画笔才把左键从环绕上摘下来。
    expect(pathClips()).toHaveLength(0);
    expect(renderer.setDrawing).toHaveBeenLastCalledWith(false);
  });

  it("leaves the mark tool on Escape without closing the editor", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const { renderer } = await renderEditor({ onOpenChange });
    const objectId = usePrevizStore.getState().addObject("character")!;
    act(() => usePrevizStore.getState().selectObject(objectId));
    await user.click(screen.getByRole("button", { name: MARK }));
    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    click(canvas, 10, 10);
    renderer.pickAt.mockClear();

    fireEvent.keyDown(document.body, { key: "Escape" });

    // Esc 是「打完了」，不是「关掉预演台」：弹窗默认的 Esc 关闭得让位，不然打到一半
    // 一按整个编辑器没了。
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.select" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    // 退出之后同一个点击回到拾取。
    click(canvas, 10, 10);
    expect(renderer.pickAt).toHaveBeenCalledTimes(1);
  });

  it("still closes the editor on Escape when nothing is being marked", async () => {
    const onOpenChange = vi.fn();
    await renderEditor({ onOpenChange });

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("starts a fresh path when the selection moves to another object", async () => {
    const { renderer, canvas } = await markingEditor();
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    click(canvas, 10, 10);
    const other = usePrevizStore.getState().addObject("character")!;
    act(() => usePrevizStore.getState().selectObject(other));

    click(canvas, 60, 10);

    // 换了对象就是另一条轨迹，不能把第二个人的点接到第一个人的轨迹后面。
    const clips = pathClips();
    expect(clips).toHaveLength(2);
    expect(clips.every((clip) => clip.points.length === 1)).toBe(true);
  });

  it("marks into the clip under the playhead again after the tool was switched away", async () => {
    const { user, renderer, canvas } = await markingEditor();
    renderer.planePointAt.mockReturnValueOnce([1, 0, 0]).mockReturnValueOnce([1, 0, 3]);
    click(canvas, 10, 10);
    click(canvas, 60, 10);

    fireEvent.keyDown(window, { key: "w" });
    await user.click(screen.getByRole("button", { name: MARK }));
    renderer.planePointAt.mockReturnValue([5, 0, 5]);
    click(canvas, 80, 10);

    // 切走再切回来是重新起手：改播放头下那条轨迹，而不是接着上一轮往后加。
    const clips = pathClips();
    expect(clips).toHaveLength(1);
    expect(clips[0].points.map((point) => point.position)).toEqual([[5, 0, 5]]);
  });

  it("places nothing without a selected object", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    act(() => usePrevizStore.getState().selectObject(null));
    await user.click(screen.getByRole("button", { name: MARK }));
    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);

    click(canvas, 10, 10);

    expect(usePrevizStore.getState().scene.timeline.tracks).toHaveLength(0);
  });
});

describe("program follow", () => {
  function renderWithCameras(): { camA: string; camB: string } {
    const scene = createDefaultScene();
    const camA = createPrevizObject("camera", scene.objects);
    const camB = createPrevizObject("camera", [camA]);
    scene.objects.push(camA, camB);
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    return { camA: camA.id, camB: camB.id };
  }

  it("moves the monitor to the camera the program cuts to", async () => {
    const { camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(camB);
    });
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);
    expect(setLiveCamera).toHaveBeenLastCalledWith(camB);
    expect(screen.getByTestId("previz-monitor-frame")).toBeInTheDocument();
  });

  it("stops following on a hand-picked camera and resumes from the follow button", async () => {
    const user = userEvent.setup();
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(camB);
      usePrevizStore.getState().setActiveCamera(camA);
    });
    expect(setActiveCamera).toHaveBeenLastCalledWith(camA);
    const follow = screen.getByTestId("previz-monitor-follow");
    expect(follow).toHaveAccessibleName("previz.monitor.follow");
    await user.click(follow);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(true);
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);
    const following = screen.getByTestId("previz-monitor-follow");
    expect(following).toBeDisabled();
    expect(following).toHaveAccessibleName("previz.monitor.following");
  });

  it("cuts to the nth camera on a digit key", async () => {
    const { camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([{ cameraId: camB }]);
    // 没有第九台机位：什么都不发生，也不报错。监听器里抛出的异常被 jsdom 吞成 window 的
    // error 事件，不会让哪条断言变红，所以「不报错」得自己订一份来钉住。
    const onError = vi.fn();
    window.addEventListener("error", onError);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    });
    window.removeEventListener("error", onError);
    expect(onError).not.toHaveBeenCalled();
    expect(usePrevizStore.getState().scene.timeline.program).toHaveLength(1);
  });

  it("still cuts from a digit key pressed inside the editor dialog", async () => {
    const { camA } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    // 编辑器自己也是个 role="dialog"，嵌套弹窗守卫不能顺手把它自己的按键一起挡掉。
    act(() => {
      screen
        .getByTestId("previz-canvas")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toMatchObject([{ cameraId: camA }]);
  });

  it("ignores digit keys typed into an input", async () => {
    renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
    input.remove();
  });

  it("ignores digit keys inside a nested dialog", async () => {
    renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("button");
    dialog.appendChild(inner);
    document.body.appendChild(dialog);
    act(() => {
      inner.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
    dialog.remove();
  });

  it("ignores digit keys aimed at an svg inside a nested dialog", async () => {
    renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dialog.appendChild(svg);
    document.body.appendChild(dialog);
    // SVG 元素不是 HTMLElement，但 `closest` 长在 Element 上：守卫按 Element 收窄，
    // 弹窗里一个图标拿到焦点也照样挡得住。
    act(() => {
      svg.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(usePrevizStore.getState().scene.timeline.program).toEqual([]);
    dialog.remove();
  });

  function monitorButton(cameraId: string): HTMLElement {
    const row = screen.getByTestId(`previz-layer-${cameraId}`);
    return within(row).getByRole("button", { name: "previz.layers.setActiveCamera" });
  }

  /** 两段镜头轨：0–24 是 camA，24 往后是 camB。跟随的正片就是播放头越过切点这一下。 */
  function twoCuts(camA: string, camB: string): void {
    act(() => {
      const store = usePrevizStore.getState();
      store.cutToCamera(camA);
      store.setTimelineFrame(24);
      store.cutToCamera(camB);
      store.setTimelineFrame(0);
    });
  }

  it("swings the monitor to the live camera when the playhead crosses a cut", async () => {
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    twoCuts(camA, camB);
    expect(setActiveCamera).toHaveBeenLastCalledWith(camA);
    expect(setLiveCamera).toHaveBeenLastCalledWith(camA);

    act(() => {
      usePrevizStore.getState().setTimelineFrame(24);
    });

    // 用户一帧都没手选过：换机位的全部理由就是播放头进了下一段。
    expect(usePrevizStore.getState().activeCameraId).toBeNull();
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);
    expect(setLiveCamera).toHaveBeenLastCalledWith(camB);
  });

  it("falls back to the hand-picked camera on a frame no cut covers", async () => {
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      const store = usePrevizStore.getState();
      // 先钉住 camA 再回到跟随：手选的那台留着，正好当空隙里的兜底。
      store.setActiveCamera(camA);
      store.followProgram();
      store.setTimelineFrame(24);
      store.cutToCamera(camB);
    });
    expect(setActiveCamera).toHaveBeenLastCalledWith(camB);

    act(() => {
      usePrevizStore.getState().setTimelineFrame(0);
    });

    // 0–24 没有切片覆盖，监看退回手选那台，而不是空成导演视角。
    expect(setActiveCamera).toHaveBeenLastCalledWith(camA);
    expect(setLiveCamera).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("previz-monitor-frame")).toBeInTheDocument();
  });

  it("draws the quad view camera pane from the live camera too", async () => {
    const user = userEvent.setup();
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.viewport.quadView" }));
    await vi.waitFor(() => expect(renderCameraView).toHaveBeenCalled());
    twoCuts(camA, camB);

    act(() => {
      usePrevizStore.getState().setTimelineFrame(24);
    });

    // 那一格答的是「监看里是什么样」，跟随中就该是镜头轨给的那台，而不是场景第一台。
    await vi.waitFor(() =>
      expect(renderCameraView).toHaveBeenLastCalledWith(
        screen.getByTestId("previz-quad-camera"),
        camB,
      ),
    );
  });

  it("re-pins the remembered camera while the program is live on another", async () => {
    const user = userEvent.setup();
    const { camA, camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      const store = usePrevizStore.getState();
      // 钉过 camA 又回到跟随：activeCameraId 还留着 camA，但监看此刻归镜头轨管。
      store.setActiveCamera(camA);
      store.followProgram();
      store.cutToCamera(camB);
    });

    const buttonA = monitorButton(camA);
    // 跟随中谁都没被按下：camA 只是空隙里的兜底，报 pressed 就是在说监看钉在它身上。
    expect(buttonA).toHaveAttribute("aria-pressed", "false");
    expect(monitorButton(camB)).toHaveAttribute("aria-pressed", "false");

    await user.click(buttonA);

    // 点一颗没按下的按钮只会是「回到这台」，不该是「关掉监看」。
    expect(usePrevizStore.getState().activeCameraId).toBe(camA);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    expect(setActiveCamera).toHaveBeenLastCalledWith(camA);
    expect(screen.getByTestId("previz-monitor-frame")).toBeInTheDocument();
    expect(monitorButton(camA)).toHaveAttribute("aria-pressed", "true");
  });

  it("pins the live camera when its layer row monitor button is clicked", async () => {
    const user = userEvent.setup();
    const { camB } = renderWithCameras();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(camB);
    });

    // 亮着但没按下：镜头轨把它送上监看，用户还没把监看钉在它身上。
    expect(monitorButton(camB)).toHaveAttribute("aria-pressed", "false");
    await user.click(monitorButton(camB));

    // 亮着的那台是镜头轨给的、用户从没点过的：点它是「就盯住这台」，不是关掉监看。
    expect(usePrevizStore.getState().activeCameraId).toBe(camB);
    expect(usePrevizStore.getState().monitorFollowsProgram).toBe(false);
    expect(screen.getByTestId("previz-monitor-frame")).toBeInTheDocument();
  });
});

describe("audio playback and mix", () => {
  const source = {
    audioUrl: "/static/vo.mp3",
    sourceName: "vo.mp3",
    durationMs: 2000,
    sourceNodeId: null,
  };

  function renderOneFrame(durationFrames = 1): string {
    const scene = createDefaultScene();
    // 默认只留一帧：录制按墙上时钟走，默认的 120 帧会让这几条用例真等四秒。
    // 要在「录制进行中」做断言的用例才把它调长，好让那个窗口宽到不吃调度抖动。
    scene.settings.durationFrames = durationFrames;
    const camera = createPrevizObject("camera", scene.objects);
    scene.objects.push(camera);
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    return camera.id;
  }

  async function recordGlobal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
    );
    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 3000 });
  }

  it("plays the audio track while the timeline plays and stops with it", async () => {
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    expect(audioPlayback.play).toHaveBeenCalledWith(
      usePrevizStore.getState().scene.timeline.audio,
      0,
      1,
    );
    act(() => usePrevizStore.getState().setTimelinePlaying(false));
    expect(audioPlayback.stop).toHaveBeenCalled();
  });

  it("re-arranges the audio from the new position after a scrub, on one context", async () => {
    // 一次播放里守三件事，它们各自都是「删掉也全绿」的：
    // 1. 拖播放头得重排音频。effect 只认 seekSerial——播放头本身每帧都在变，进不了依赖。
    // 2. 起播位置与倍速要照实传下去，否则声音从头开始、或者按 1 倍速播。
    // 3. 整个编辑器只建一个 AudioContext。浏览器对它的数量有硬上限，
    //    每次重排都新建的话开关几次就彻底静音了。
    renderOneFrame(120);
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    expect(audioPlayback.play).toHaveBeenLastCalledWith(expect.anything(), 0, 1);

    // 先只拖播放头，倍速不动：这一步唯一能让 effect 察觉的就是 seekSerial，
    // 它不在依赖里的话音频会继续从第 0 帧那次排程往下走，跟画面对不上。
    act(() => usePrevizStore.getState().setTimelineFrame(12));
    expect(audioPlayback.play).toHaveBeenLastCalledWith(expect.anything(), 12, 1);
    // 再单独改倍速：起播帧不变，倍速要照实传下去。
    act(() => usePrevizStore.getState().setTimelineRate(2));
    expect(audioPlayback.play).toHaveBeenLastCalledWith(expect.anything(), 12, 2);

    // 播放中往轨上再加一段，也得当场重排：`timeline.audio` 这个数组引用进了 effect 的
    // 依赖，而 store 对它是结构共享的——拖对象、改机位、剪镜头轨都不换它，只有真编辑
    // 音频轨才换。所以这条依赖恰好等于「音频轨被改了」，白重排不会发生。
    act(() => {
      usePrevizStore.getState().addAudioClip({ ...source, audioUrl: "/static/sfx.mp3" }, 60);
    });
    expect(audioPlayback.play).toHaveBeenLastCalledWith(
      usePrevizStore.getState().scene.timeline.audio,
      12,
      2,
    );
    expect(createAudioContext).toHaveBeenCalledTimes(1);
  });

  it("does not touch the audio engine when the track is empty", async () => {
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => usePrevizStore.getState().setTimelinePlaying(true));
    expect(createAudioContext).not.toHaveBeenCalled();
  });

  it("mixes the audio track into a recording and stamps the duration", async () => {
    const user = userEvent.setup();
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      // 时间轴调到 2 倍速：混音那一路必须仍按 1 倍速排。成片是按 30fps 逐帧实速画出来
      // 的，跟着时间轴当前倍速排音频就是画面 1×、声音 2×，音画当场分家。
      usePrevizStore.getState().setTimelineRate(2);
    });
    const clips = usePrevizStore.getState().scene.timeline.audio;
    await recordGlobal(user);
    expect(audioPlayback.load).toHaveBeenCalledWith(clips);
    expect(audioPlayback.play).toHaveBeenCalledWith(clips, 0, 1, audioDestination);
    expect(audioPlayback.stop).toHaveBeenCalled();
    // 容器得是**带音轨**的那一种：`pickRecordMimeType()` 不传 withAudio 谈回来的是纯视频
    // 容器，音轨并进流里也编不进文件。第一次问就得带着 withAudio 问。
    expect(pickRecordMimeType).toHaveBeenNthCalledWith(1, undefined, true);
    // 混音节点得真的交到录制器手里：整条链上只有这一句把声音塞进文件，
    // 少了它录出来的仍是一段无声视频，而上面几条断言一条都不会红。
    expect(createCanvasRecorder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        audioStream: audioDestination.stream,
        mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
    // 一帧 @ 30fps ≈ 33ms：时长来自真正画出的帧数，不是设置里的总长。
    expect(addDerivedVideoNode).toHaveBeenLastCalledWith(
      "previz-1",
      "/static/take.mp4",
      "16:9",
      "previz.editor.record.globalNodeName",
      33,
    );
  });

  it("records silent video with a warning when the browser cannot mix", async () => {
    const user = userEvent.setup();
    createAudioContext.mockReturnValueOnce(null as unknown as typeof audioContext);
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    await recordGlobal(user);
    expect(toast.warning).toHaveBeenCalledWith("previz.editor.record.noAudioMix");
    expect(audioPlayback.play).not.toHaveBeenCalled();
    expect(addDerivedVideoNode).toHaveBeenCalled();
  });

  it("records silent video with a warning when no container carries audio", async () => {
    const user = userEvent.setup();
    // noAudioMix 的另一半：AudioContext 建得出来，浏览器却没有一种带音轨的容器能编。
    // 上一条走的是「压根没有 AudioContext」，两半各有各的判断，得分开守。
    pickRecordMimeType.mockImplementationOnce(() => null);
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    await recordGlobal(user);
    expect(toast.warning).toHaveBeenCalledWith("previz.editor.record.noAudioMix");
    // 退回无声容器接着录，而不是把整次录制取消掉：画面比声音重要得多。
    expect(pickRecordMimeType).toHaveBeenLastCalledWith();
    expect(audioPlayback.play).not.toHaveBeenCalled();
    expect(addDerivedVideoNode).toHaveBeenCalled();
  });

  it("keeps the speakers quiet while a recording is running", async () => {
    const user = userEvent.setup();
    // 这条要在「录制还没结束」的窗口里做断言，所以把片长撑到 60 帧（2 秒 + 250ms 尾巴）。
    // 一帧的话窗口只有 ~280ms，机器上任何一次几百毫秒的停顿都会让录制先跑完，
    // 断言就变成在录完之后做的，这条用例会毫无理由地红一次。
    renderOneFrame(60);
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    /** 扬声器那一路：三个参数、不带混音节点。混音那一路是四个。 */
    const speakerCalls = () =>
      audioPlayback.play.mock.calls.filter((call) => call.length === 3).length;
    expect(speakerCalls()).toBe(1);

    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
    );
    // 还在录：头部只禁了截图与录制入口，时间轴的播放键这时照样点得动。
    expect(
      screen.getByRole("button", { name: "previz.editor.record.stop" }),
    ).toBeInTheDocument();
    act(() => usePrevizStore.getState().setTimelinePlaying(true));
    // 录制期间扬声器那一路一次都不该再起：它与混音节点是两套排程，同时响就是双份
    // 声音，而且用户听到的和成片里录进去的还对不上。
    expect(speakerCalls()).toBe(1);

    // 收尾：停掉播放再等录制走完，免得录完那一下播放又接上、扰乱最后一条断言。
    act(() => usePrevizStore.getState().setTimelinePlaying(false));
    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 8000 });
    expect(audioPlayback.play).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      1,
      audioDestination,
    );
    // 单例超时抬到 10s：录制本身墙钟约 2.5s，而 vitest 的默认 5000 会先把用例杀掉，
    // 真挂起时拿到的就只是一句「Test timed out」，而不是上面那条信息量大得多的断言错误。
  }, 10000);

  it("refuses a second recording while the first is still decoding its audio", async () => {
    const user = userEvent.setup();
    // 开录之前要先解码音频，那期间组件的 `recording` 还是 null、顶栏按钮上还写着
    // 「开始录制」、选单照样打得开——界面上没有半点「正在忙」的迹象，而解码是一次网络取样
    // 加 decodeAudioData，首次录制轻松几百毫秒到几秒。「按钮没反应就再点一下」是本能动作，
    // 第二路录制会和第一路抢同一块画布：第一路的 `pass.end()` 会在第二路还在录的时候把
    // 辅助物还回去，手柄、轨迹、机位锥就被烤进第二路的成片里。守卫因此必须是同步的，
    // 不能等 `recording` 这个 state 渲染出来。
    let release = () => {};
    audioPlayback.load.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });

    const openRecord = () =>
      user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    const pickGlobal = () =>
      user.click(screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }));
    await openRecord();
    await pickGlobal();
    // 解码仍挂着，按钮的可访问名字还是「开始录制」——拿得到它本身就是这条用例的前提。
    await openRecord();
    await pickGlobal();

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 3000 });
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(addDerivedVideoNode).toHaveBeenCalledTimes(1);
  });

  it("hands the helper visibility back when the MediaRecorder refuses the container", async () => {
    const user = userEvent.setup();
    // `new MediaRecorder()` 谈不拢容器就当场抛，而混音的候选里就有裸 video/mp4 与
    // video/webm（Safari 要它们），谈崩不是罕见路径。抛在「建录制器」这一步时，
    // `pass.end()` 必须照样跑到：辅助物的可见性攥在那个句柄里，不还回去的话手柄、
    // 轨迹、机位锥全留在隐藏状态，视口也卡在输出分辨率上不再跟随窗口——只能重开编辑器。
    createCanvasRecorder.mockImplementationOnce(() => {
      throw new Error("mimeType not supported");
    });
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
    );
    await vi.waitFor(() => expect(recordEnd).toHaveBeenCalled(), { timeout: 3000 });
    expect(toast.error).toHaveBeenCalledWith("previz.editor.record.failed");
    // 排进混音节点的那些源也得停，否则它们一直挂在 AudioContext 上。
    expect(audioPlayback.stop).toHaveBeenCalled();
    expect(addDerivedVideoNode).not.toHaveBeenCalled();
  });

  it("stamps the duration from the frames actually drawn when stopped early", async () => {
    const user = userEvent.setup();
    // 之前几条录制用例都是 1 帧跑到底，那里「画到的帧号」和「设置里的总长」恰好都是 1，
    // 两种算法给的时长一模一样。只有中途叫停才把它们分开：60 帧的片子按总长算是 2000ms，
    // 按真画到的帧算要短得多。
    const cameraId = renderOneFrame(60);
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => usePrevizStore.getState().selectObject(cameraId));

    // 假时钟只罩住录制循环：`renderOneFrame` 之后的初始化是真异步的。假 rAF 每 16ms
    // 一拍、30fps 每 33ms 一帧，推 300ms 大约画到第 9 帧，然后按停。
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    });
    try {
      await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
      await user.click(
        screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
      );
      act(() => {
        vi.advanceTimersByTime(300);
      });
      await user.click(screen.getByRole("button", { name: "previz.editor.record.stop" }));
      // 叫停是下一拍才被 `shouldStop` 看到的，再多推一些把收工那段跑完。
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }

    const lastCall = addDerivedVideoNode.mock.lastCall as unknown as unknown[];
    const durationMs = lastCall[4] as number;
    expect(durationMs).toBeGreaterThan(0);
    // 拿设置里的总长充数就是 2000ms；成片其实只有开头那一小段。
    expect(durationMs).toBeLessThan((60 / 30) * 1000);
  });

  it("paints the live camera frame by frame in a global recording", async () => {
    const user = userEvent.setup();
    const cameraId = renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().cutToCamera(cameraId);
    });
    await recordGlobal(user);
    expect(recordDrawFrame).toHaveBeenCalledWith(0, cameraId);
  });

  it("disposes the audio engine when the editor closes", async () => {
    const scene = createDefaultScene();
    const { rerender } = render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
      usePrevizStore.getState().setTimelinePlaying(true);
    });
    expect(audioPlayback.play).toHaveBeenCalled();
    rerender(
      <PrevizEditor
        open={false}
        nodeId="previz-1"
        initialScene={scene}
        onOpenChange={vi.fn()}
        onFlush={vi.fn()}
      />,
    );
    expect(audioPlayback.dispose).toHaveBeenCalled();
  });
});
