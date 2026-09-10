// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { createPrevizObject } from "@/features/previz/domain/objects";
import {
  canvasToWorld,
  sceneTopDownBounds,
  topDownView,
  type PrevizTopDownFootprint,
  type PrevizTopDownView,
} from "@/features/previz/domain/topDownMap";
import { PREVIZ_TOP_DOWN_PICKER_SIZE } from "@/features/previz/ui/PrevizTopDownPicker";
import {
  PREVIZ_DEFAULT_DURATION_FRAMES,
  createDefaultScene,
  type PrevizPathClip,
  type PrevizScene,
  type Vec3,
} from "@/features/previz/domain/scene";
import { buildNodeScenePatch, loadNodeScene } from "@/features/previz/nodeScene";
import type { CanvasRecorderOptions } from "@/features/previz/capture/recordTimeline";
import { PrevizRenderer } from "@/features/previz/engine/PrevizRenderer";
import { PREVIZ_AUTOSAVE_MS, PrevizEditor } from "@/features/previz/PrevizEditor";
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
const propFootprints = vi.fn((): PrevizTopDownFootprint[] => []);
const renderCameraPreview = vi.fn();
// 真实现返回 Promise，桩也得返回一个：编辑器把它接在 void 上下文里，返回 undefined
// 时任何 `.catch` 都会当场炸成 TypeError。
// 形参要写出来：`vi.fn(async () => {})` 的 `mock.calls` 是 `[]` 元组，读 `[0]`/`[1]`
// 在 tsc 下直接报「长度 0 的元组没有下标 0」。
const renderCharacterPreview = vi.fn(async (_canvas: unknown, _draft: unknown) => {});
// 回 `null`（渲染器画不了底图）：选位图于是回落到那张 2D 示意图，下面按米算落点的
// 用例读的还是示意图那套取景。形参写出来的理由同上。
const renderTopDownMap = vi.fn((_canvas: HTMLCanvasElement): PrevizTopDownView | null => null);
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
    propFootprints,
    renderCameraPreview,
    renderCharacterPreview,
    renderTopDownMap,
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

/**
 * 在创建人物对话框的俯视选位图上点一下，返回这一下按 domain 映射应该得到的世界 XZ。
 *
 * jsdom 不排版，`getBoundingClientRect()` 四个数全是 0，而选位图按 rect 换算落点，
 * 所以要先塞一个真尺寸进去；`detail: 1` 才走坐标那条路（0 是键盘 / 合成点击，选位图
 * 会回落到取景中心）。期望值走同一份 domain 函数复算，不抄组件的算式。
 */
function pickTopDownSpot(clientX: number, clientY: number): readonly [number, number] {
  const canvas = screen.getByTestId("top-down-picker");
  canvas.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      height: PREVIZ_TOP_DOWN_PICKER_SIZE.height,
      right: PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      bottom: PREVIZ_TOP_DOWN_PICKER_SIZE.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  fireEvent.click(canvas.parentElement!, { detail: 1, clientX, clientY });
  return canvasToWorld(
    topDownView(
      sceneTopDownBounds(usePrevizStore.getState().scene.objects),
      PREVIZ_TOP_DOWN_PICKER_SIZE.width,
      PREVIZ_TOP_DOWN_PICKER_SIZE.height,
    ),
    [clientX, clientY],
  );
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
// 这个 once 就会原封不动留给下一条用例，红在一个跟它毫无关系的地方。这四个桩子都被
// 用例按 once 改过，逐个 reset 回默认实现。`load` 尤其要命：排给它的那个 promise 攥在
// 某条用例的局部变量里，漏到下一条要解码音频的用例头上，就是一次永不 resolve 的 await。
beforeEach(() => {
  vi.clearAllMocks();
  createAudioContext.mockReset().mockImplementation(() => audioContext);
  pickRecordMimeType.mockReset().mockImplementation(defaultRecordMimeType);
  createCanvasRecorder.mockReset().mockImplementation(defaultCanvasRecorder);
  audioPlayback.load.mockReset().mockImplementation(async () => {});
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
      />,
    );

    expect(screen.getByTestId("previz-canvas")).toBeInTheDocument();
    expect(screen.getByText("previz.editor.duration:240")).toBeInTheDocument();
  });

  it("flushes the current scene when closed", async () => {
    const user = userEvent.setup();
    const onFlush = vi.fn((_scene: PrevizScene) => true);
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

    // 得先真改一笔。关窗兜底如今看 `dirty`——没改过就关，一个字节都不该写回，
    // 否则「打开看一眼再关掉」也会让画布记一次编辑、把整张画布推去落盘。
    act(() => {
      usePrevizStore.getState().setDurationFrames(200);
    });

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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.camera" }));
    await user.click(screen.getByRole("button", { name: "previz.cameraCreate.close" }));

    expect(screen.queryByRole("dialog", { name: "previz.cameraCreate.title" })).toBeNull();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it("opens the character dialog instead of dropping one at the origin", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));

    expect(
      screen.getByRole("dialog", { name: "previz.characterCreate.title" }),
    ).toBeInTheDocument();
    // 点一下工具栏就建人的老行为会让这条挂：人已经在场上了，而用户还没说站哪。
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it("creates the character where the top-down map was clicked", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));
    // 刻意不点画布中心：空场景的取景中心就是世界原点，而原点也正是「落点没接上」时
    // 人物会站的地方——中心点上两种实现同值，是一条谁都能过的空绿。
    const spot = pickTopDownSpot(96, 208);
    await user.click(screen.getByRole("button", { name: "previz.characterCreate.create" }));

    const state = usePrevizStore.getState();
    expect(state.scene.objects).toHaveLength(1);
    const created = state.scene.objects[0]!;
    expect(created.kind).toBe("character");
    // 选点 → 草稿的 spot → transform.position 这条链，断在哪一节表现都一样：
    // 人站在原点，没有任何报错。
    expect(created.transform.position[0]).toBeCloseTo(spot[0], 6);
    expect(created.transform.position[2]).toBeCloseTo(spot[1], 6);
    // 新建即选中：否则用户建完还得自己去右边点一下才能改属性。
    expect(state.selectedObjectId).toBe(created.id);
    // 对话框关掉了，不会挡着刚建好的人。
    expect(screen.queryByRole("dialog", { name: "previz.characterCreate.title" })).toBeNull();
  });

  it("closes the character dialog without creating anything", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));
    await user.click(screen.getByRole("button", { name: "previz.characterCreate.cancel" }));

    expect(screen.queryByRole("dialog", { name: "previz.characterCreate.title" })).toBeNull();
    expect(usePrevizStore.getState().scene.objects).toHaveLength(0);
  });

  it("measures the props once when the character dialog opens", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    // 关着的时候一次都不量：量一件道具要对它整棵子树跑 `Box3.setFromObject`，而这块
    // 数据只有那张选位图用得上。
    expect(propFootprints).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));

    expect(propFootprints).toHaveBeenCalledTimes(1);

    // 对话框是模态的，开着的时候场景不会变，所以量一次就够。每渲染一次量一遍的话，
    // 整个布景的包围盒会被反复重算；交出来的数组还每次换一个新引用，选位图的
    // useMemo / useEffect 于是跟着重算取景、整张图重画。这里借加一台机位逼编辑器
    // 重渲一轮——真实里对着对话框敲键盘、拖时间轴都会走到同一处。
    act(() => {
      usePrevizStore.getState().addObject("camera");
    });

    expect(propFootprints).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("dialog", { name: "previz.characterCreate.title" }),
    ).toBeInTheDocument();
  });

  it("draws the mannequin preview through the renderer", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));
    // 木偶那块画布是选位之后才挂上去的：站位没定之前，中栏是一块占位提示。
    pickTopDownSpot(96, 208);

    await vi.waitFor(() => expect(renderCharacterPreview).toHaveBeenCalled());
    const [canvas, draft] = renderCharacterPreview.mock.calls[0]!;
    expect(canvas).toBeInstanceOf(HTMLCanvasElement);
    expect(draft).toMatchObject({ bodyType: "average", heightPolicy: "follow" });
  });

  it("draws the real set on the character placement map", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "previz.toolbar.add.character" }));

    // 选位图的底图走的是渲染器那趟正俯视离屏 pass，画的是真几何体——不是那张只有
    // 圆点的示意图。这里桩回 `null`，正好也把「画不了就回落」那条路一起走了。
    await vi.waitFor(() => expect(renderTopDownMap).toHaveBeenCalled());
    expect(renderTopDownMap.mock.calls[0]![0]).toBeInstanceOf(HTMLCanvasElement);
  });

  it("draws the create dialog preview through the renderer", async () => {
    const user = userEvent.setup();
    render(
      <PrevizEditor
        open
        nodeId="previz-1"
        initialScene={createDefaultScene()}
        onOpenChange={vi.fn()}
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
      />,
    );

    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.editor.capture" }));

    expect(capture).not.toHaveBeenCalled();
  });
});

/**
 * 左栏两段工具里按下态的那几颗。整屏去数是不行的：视口自己那一角还有显示模式那组
 * 按钮，它们也有 aria-pressed，跟「当前工具」毫无关系。
 */
function pressedRailButtons(): HTMLElement[] {
  return ["previz.toolbar.group.tool", "previz.toolbar.group.gizmo"].flatMap((label) =>
    within(screen.getByRole("group", { name: label })).queryAllByRole("button", { pressed: true }),
  );
}

/** 上面每条用例都手抄一遍的那五个 prop。新加的用例只改 `open`，其余给默认。 */
function editorProps(overrides: Partial<ComponentProps<typeof PrevizEditor>> = {}) {
  return {
    open: true,
    nodeId: "previz-1",
    initialScene: createDefaultScene(),
    onOpenChange: vi.fn(),
    // 返回 true = 「节点收下了」。桩成 `vi.fn()` 会返回 undefined，编辑器会当成拒收、
    // 把场景一直记作未保存，跟着就冒出第二次写回。
    onFlush: vi.fn(() => true),
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
      setGizmoMode,
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

  it("returns to the default move tool after a stroke", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));
    renderer.setGizmoMode.mockClear();

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 10 });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 10 });

    // 画完得离开画笔，否则下一次想选个对象反而又画了一条。落在「移动」而不是「选择」：
    // 两者对这条回落的要求是一样的（只要不是 draw），而移动让用户画完立刻能拖。
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.translate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 手柄也得跟着回来——工具亮着却没有手柄的话，这条回落等于把用户丢在一个空档里。
    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith("translate");
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

  /*
    两颗键各来一遍。这条用例的标题原先就写着 W 和 Q，函数体却只按了 Q——`case "w"` 的
    守卫因此一直零测试，删掉它 1373 条全绿。而 W 恰恰是最容易按到的那一颗：画到一半
    想「先选个东西」顺手一按，setDrawing 的效果就把左键重新挂回轨道旋转，剩下半笔全
    变成在笔下转视角，画了一半的路径作废。
  */
  it.each([
    ["w", "previz.toolbar.tool.select"],
    ["q", "previz.toolbar.tool.navigate"],
  ])("ignores %s mid-stroke, so the camera does not orbit under a live pen", async (key, label) => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character");
    act(() => usePrevizStore.getState().selectObject(objectId!));
    await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });

    fireEvent.keyDown(window, { key });

    // 笔画还按着：这一下不该把工具切走，否则 setDrawing 的效果会重挂左键、
    // 让视口在笔下转起来。
    expect(screen.getByRole("button", { name: "previz.toolbar.tool.draw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "false");

    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10 });

    // 松手照常收笔、回落到默认工具——快捷键拦截只挡笔画中途，不影响画完的既有行为。
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.translate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /*
    W 和 R 曾经同时亮着：栏上画的是两份互不相干的 state（工具一份、手柄模式一份），
    各算各的按下态。合并之后整条栏子任何时刻只有一颗亮，开局那一颗是移动。
  */
  it("opens on the move tool alone, with its gizmo already up", async () => {
    const { renderer } = await renderEditor();

    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.translate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // 只数左栏那两段：视口自己那一角（显示模式）也有按下态的按钮，跟工具无关。
    expect(pressedRailButtons()).toHaveLength(1);
    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith("translate");
  });

  it("switches the transform tool with the G, R and S keys, matching Blender", async () => {
    const { renderer } = await renderEditor();

    for (const [key, mode] of [
      ["r", "rotate"],
      ["s", "scale"],
      ["g", "translate"],
    ] as const) {
      fireEvent.keyDown(window, { key });

      expect(
        screen.getByRole("button", { name: `previz.toolbar.gizmo.${mode}` }),
      ).toHaveAttribute("aria-pressed", "true");
      // 手柄模式现在是从工具派生出来的，不再是第二份 state：按键改的是工具，
      // 视口里那副手柄跟着换。
      expect(renderer.setGizmoMode).toHaveBeenLastCalledWith(mode);
    }
  });

  /*
    W / Q / 绘制 / 标记这四颗下视口里不该有手柄——这正是「一条互斥列表」的另一半：
    七颗按钮只有一颗亮，而亮着的那颗是不是变换工具，决定了手柄在不在。

    传 null 而不是「随便留着上一次的模式再把 helper 藏起来」：手柄不光是看得见的箭头，
    它还在接指针事件，留着它用户会在一片空白里莫名其妙地拖动物体（见 PrevizGizmo）。
  */
  it.each([
    ["w", "previz.toolbar.tool.select"],
    ["q", "previz.toolbar.tool.navigate"],
  ])("clears the gizmo when %s selects a pointer tool", async (key, label) => {
    const { renderer } = await renderEditor();

    // 先落在一颗变换工具上：默认就是移动，不先离开的话下面这一步在实现退化成
    // 「永远传 translate」时照样绿。
    fireEvent.keyDown(window, { key: "r" });
    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith("rotate");

    fireEvent.keyDown(window, { key });

    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith(null);
  });

  /*
    G/R/S 原来只改手柄模式，笔画中途按下去是无害的，所以没有守卫。合并之后它们会
    把工具从 draw 切走，和 W/Q 掉进同一个坑：setDrawing 的效果会把左键重新挂回轨道
    旋转，视口就在笔下转起来了。

    三颗键各来一遍而不是只验 G：守卫是三条各写各的 `if (stroke.current) break;`，
    只钉住一条的话，删掉另外两条里的任何一条都没人报。
  */
  it.each([["g"], ["r"], ["s"]])(
    "ignores %s mid-stroke, so the camera does not orbit under a live pen",
    async (key) => {
      const user = userEvent.setup();
      const { renderer } = await renderEditor();
      const objectId = usePrevizStore.getState().addObject("character");
      act(() => usePrevizStore.getState().selectObject(objectId!));
      await user.click(screen.getByRole("button", { name: "previz.toolbar.tool.draw" }));

      const canvas = screen.getByTestId("previz-canvas");
      renderer.planePointAt.mockReturnValue([1, 0, 0]);
      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });

      fireEvent.keyDown(window, { key });

      expect(screen.getByRole("button", { name: "previz.toolbar.tool.draw" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(renderer.setDrawing).toHaveBeenLastCalledWith(true);
    },
  );

  it("no longer treats E as a transform-tool shortcut", async () => {
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
  // 次序不是随手写的：初始工具就是 translate，如果把它摆在最前面，那一步断言在
  // case "g" 被删掉之后依然是「本来就 true」，全程不会变红。每一条都得先离开那颗
  // 按钮的选中态，再靠对应的键把它按回来，断言才是真的在验证这颗键。
  it("every badged key activates the button it is drawn on", async () => {
    await renderEditor();

    const badged = [
      "previz.toolbar.tool.navigate", // 默认是 translate，这一步顺带离开它
      "previz.toolbar.tool.select",
      "previz.toolbar.gizmo.rotate",
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
    expect(screen.getByRole("button", { name: MARK })).toHaveAttribute("aria-pressed", "false");
    expect(onOpenChange).not.toHaveBeenCalled();

    // 退出之后同一个点击回到拾取。
    click(canvas, 10, 10);
    expect(renderer.pickAt).toHaveBeenCalledTimes(1);
  });

  /*
    Esc 收手和画完一笔是同一件事，落点也该一样。两处各写各的字面量的话，用起来就是
    「画完一笔能直接拖、Esc 收手完不能」——用户读不出这里面有什么道理，只会觉得手柄
    时有时无。

    断言的是「手柄已经支在那里、可以直接拖」这个用户看得见的结果，不是把
    PREVIZ_DEFAULT_TOOL 搬过来跟自己比：那样写的话，常量改成一颗不带手柄的工具，两处
    一起变成「Esc 完拖不动」，这条用例照样全绿。
  */
  it("leaves the viewport ready to drag after Escape, like a finished stroke does", async () => {
    const user = userEvent.setup();
    const { renderer } = await renderEditor();
    const objectId = usePrevizStore.getState().addObject("character")!;
    act(() => usePrevizStore.getState().selectObject(objectId));
    await user.click(screen.getByRole("button", { name: MARK }));
    const canvas = screen.getByTestId("previz-canvas");
    renderer.planePointAt.mockReturnValue([1, 0, 0]);
    click(canvas, 10, 10);
    // 标记工具下手柄是收着的。不先钉住这一步的话，下面那条在「Esc 压根没换工具」时
    // 也会因为「开局本来就是移动」而全绿。
    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith(null);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(renderer.setGizmoMode).toHaveBeenLastCalledWith("translate");
    expect(screen.getByRole("button", { name: "previz.toolbar.gizmo.translate" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(pressedRailButtons()).toHaveLength(1);
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
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

  it("unlocks the recorder after an attempt that never got off the ground", async () => {
    const user = userEvent.setup();
    // 入口锁是同步 ref，`finally` 是唯一还锁的地方。它要是不跑，这个组件实例的余生里录制
    // 就永久死掉：按钮照样写着「开始录制」，点了没反应、不报错、连个转圈都没有——比重入
    // 本身更难被发现。四条早退路径（没项目 / 没机位 / 没容器 / 内层抛出）共用这一个
    // `finally`，钉住最好造的那条就够了。
    pickRecordMimeType.mockImplementation(() => null);
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
    );
    expect(toast.error).toHaveBeenCalledWith("previz.editor.record.unsupported");
    expect(startRecording).not.toHaveBeenCalled();

    // 换台能录的浏览器再来一次：这一次必须录得成。
    pickRecordMimeType.mockImplementation(defaultRecordMimeType);
    await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
    await user.click(
      screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
    );
    await vi.waitFor(() => expect(addDerivedVideoNode).toHaveBeenCalled(), { timeout: 3000 });
    expect(startRecording).toHaveBeenCalledTimes(1);
  });

  it("hands the helper visibility back when the mix destination cannot be opened", async () => {
    const user = userEvent.setup();
    // 混音出口也在那个 try 里面。今天没有可达的抛出路径（`dispose()` 关掉 context 的同时
    // 就把 ref 置了空，关编辑器时渲染器先一步同步 dispose、`startRecording()` 会先返回
    // null），但这条用例是唯一挡得住「重构时又把它挪回 try 外」的东西——挪出去，
    // `pass.end()` 就再也不跑了。
    renderOneFrame();
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());
    act(() => {
      usePrevizStore.getState().addAudioClip(source, 0);
    });
    const openDestination = audioContext.createMediaStreamDestination;
    audioContext.createMediaStreamDestination = () => {
      throw new Error("audio context is closed");
    };
    try {
      await user.click(screen.getByRole("button", { name: "previz.editor.record.open" }));
      await user.click(
        screen.getByRole("menuitem", { name: "previz.editor.record.mode.global" }),
      );
      await vi.waitFor(() => expect(recordEnd).toHaveBeenCalled(), { timeout: 3000 });
    } finally {
      audioContext.createMediaStreamDestination = openDestination;
    }
    expect(toast.error).toHaveBeenCalledWith("previz.editor.record.failed");
    expect(addDerivedVideoNode).not.toHaveBeenCalled();
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
        onFlush={vi.fn(() => true)}
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
        onFlush={vi.fn(() => true)}
      />,
    );
    expect(audioPlayback.dispose).toHaveBeenCalled();
  });
});

/*
  自动保存。防的是一个很具体的丢数据：以前 `onFlush` 只在关对话框那一下触发，
  用户在预演台里导入 obj、摆完位置，不关对话框直接刷新页面——这一场戏从没进过
  `node.data`，刷完就空了。画布那一层其实早就全自动（`updateNodeData` 每次都
  `trackEdit`，`useCanvasSync` 防抖 800ms 落盘），缺口只在预演台这一层。
*/
describe("PrevizEditor autosave", () => {
  it("writes the scene back without waiting for the editor to close", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => true);
    await renderEditor({ onFlush });
    // 只假造定时器本身。渲染器那次 `create()` 是真异步的，所以假时钟必须等
    // `renderEditor` 之后再换；`toFake` 也不碰 rAF / performance，免得连带停掉
    // 播放循环和 React 的调度。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });

      // 差一毫秒都不许写：这一条锁的是「确实等满了一个防抖窗口」。少了它，把
      // PREVIZ_AUTOSAVE_MS 改成 0（等于每次编辑都同步写回）也照样绿。
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS - 1);
      });
      expect(onFlush).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith(usePrevizStore.getState().scene);
      // 写完就不脏了，否则关窗那条兜底会把同一份场景再写一遍。
      expect(usePrevizStore.getState().dirty).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses a burst of edits into one write", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => true);
    await renderEditor({ onFlush });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // 拖一根滑杆会连发几十次 `applyScene`。这里把三次改动摆在同一个窗口内、
      // 但彼此隔开，逼出「每次改动都要把窗口往后推」——只按 `dirty` 起一次定时器
      // 的实现是节流不是防抖，拖一次滑杆会写十几遍，每遍都过一整轮 JSON 序列化
      // 加整画布落盘。那种实现会在下面第二次推进时就把 onFlush 打出来。
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS - 100);
      });
      act(() => {
        usePrevizStore.getState().setDurationFrames(280);
      });
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS - 100);
      });
      act(() => {
        usePrevizStore.getState().setDurationFrames(330);
      });
      expect(onFlush).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS);
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // 写回去的必须是最后那一版，不是窗口开头那一版。
      expect(onFlush.mock.calls[0]![0].settings.durationFrames).toBe(330);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not write anything back while the user only browses", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => true);
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject("camera", scene.objects));
    await renderEditor({ onFlush, initialScene: scene });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // 播放头、时间轴缩放、选中项都刻意不在 `PrevizScene` 里（store 里那段注释
      // 讲了为什么），所以纯浏览一遍不该置脏、也就一个字节都不该写回。写回一次
      // 就等于让画布 `trackEdit` 一次、把整张画布推去落盘，而用户什么都没改。
      act(() => {
        const store = usePrevizStore.getState();
        store.setTimelineFrame(42);
        store.zoomTimelineBy(2);
        store.selectObject(scene.objects[0]!.id);
        store.setActiveCamera(scene.objects[0]!.id);
        store.selectClip(null);
      });
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS * 3);
      });
      expect(onFlush).not.toHaveBeenCalled();

      // 关窗那条兜底同样要看 `dirty`。少了这一半断言，「无条件写」的实现能全绿：
      // 定时器那条路本来就只在场景变过时才排。
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "previz.editor.close" }));
      });
      expect(onFlush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still writes the last edit back when the editor closes mid-debounce", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => true);
    await renderEditor({ onFlush });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });
      // 不等防抖到点就关窗。兜底那一次必须把这笔改动接住，否则「改完立刻关」
      // 这条最常见的路径反而丢数据——比没有自动保存还糟。
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "previz.editor.close" }));
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush.mock.calls[0]![0].settings.durationFrames).toBe(200);

      // 防抖那一发随后还是会到点，但场景已经不脏了，不许再写第二遍。
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS * 2);
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the pending write when the editor unmounts", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => true);
    const { unmount } = await renderEditor({ onFlush });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });
      act(() => {
        unmount();
      });
      // 定时器攥着 `onFlush`，而 `onFlush` 攥着节点 id。编辑器都没了还开火，
      // 写的可能是一个刚被删掉的节点；卸载时必须把它清掉。
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS * 2);
      });
      expect(onFlush).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 把编辑器和节点接成真实回路的宿主：逐字复刻 `PrevizNode` 里那三步推导
 * （`loadNodeScene` → `initialScene` memo → `handleFlush` 写回），其余全用本文件
 * 既有的渲染器桩。
 *
 * 不这么接就测不出 M1 那个 bug：把 `onFlush` 桩成 `vi.fn()` 的用例只看得见
 * 「写回被调了几次」，看不见写回**反过来**把编辑器自己重置了。
 */
function AutosaveHost({
  onStored,
  onInitialScene,
}: {
  onStored: (scene: PrevizScene) => void;
  onInitialScene?: (scene: PrevizScene) => void;
}) {
  const [stored, setStored] = useState<unknown>(undefined);
  const loaded = useMemo(() => loadNodeScene(stored), [stored]);
  const initialScene = useMemo(
    () => (loaded.ok ? loaded.scene : createDefaultScene()),
    [loaded],
  );
  // 每换一次 `initialScene` 引用就报一次。写回**反过来**换掉编辑器的入参，正是
  // M1 那条回路的第一环；不数这一下，「会话没被重置」有可能只是回路根本没接通。
  useEffect(() => {
    onInitialScene?.(initialScene);
  }, [initialScene, onInitialScene]);
  const onFlush = useCallback(
    (scene: PrevizScene) => {
      const result = buildNodeScenePatch(scene);
      if (!result.ok) return false;
      onStored(result.patch.scene);
      setStored(result.patch.scene);
      return true;
    },
    [onStored],
  );
  return (
    <PrevizEditor
      open
      nodeId="previz-1"
      initialScene={initialScene}
      onOpenChange={vi.fn()}
      onFlush={onFlush}
    />
  );
}

describe("PrevizEditor autosave round trip", () => {
  it("keeps the editing session alive when an autosave lands", async () => {
    const onStored = vi.fn();
    const onInitialScene = vi.fn();
    render(<AutosaveHost onStored={onStored} onInitialScene={onInitialScene} />);
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());

    // 假时钟必须在编辑**之前**换上：防抖那一发是编辑当场排下的，用真 setTimeout
    // 排出去的定时器，后面 `advanceTimersByTime` 一辈子也推不到它。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // 造一份「用户正干到一半」的会话态：撤销栈里有一步、选中了一个对象、
      // 播放头停在第 42 帧、时间轴放大过一档。
      let objectId: string | null = null;
      act(() => {
        const store = usePrevizStore.getState();
        objectId = store.addObject("character");
        store.setTimelineFrame(42);
        store.zoomTimelineBy(2);
      });
      const before = usePrevizStore.getState();
      expect(before.past.length).toBe(1);
      expect(before.selectedObjectId).toBe(objectId);

      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS);
      });

      // 先确认这一发自动保存真的落地了，否则下面那串「什么都没变」是空欢喜。
      expect(onStored).toHaveBeenCalledTimes(1);
      expect(usePrevizStore.getState().dirty).toBe(false);
      // 而且它确实把编辑器的入参换掉了——回路是通的，只是没再叫醒灌场景那条 effect。
      expect(onInitialScene).toHaveBeenCalledTimes(2);

      /*
        写回 node.data 会换掉 `data.scene` 的引用，节点重算 `loadNodeScene`，
        而 `parseScene` 永远吐一个全新对象，于是 `initialScene` 也换引用——编辑器
        那条 `useEffect(…, [open, initialScene])` 就会重跑 `loadScene`，把 past /
        future / 选中 / 播放头 / 时间轴缩放**全部清零**。

        用户看到的是：手停 0.6 秒，播放头啪一下跳回第 0 帧、预览画面整个变了、
        右边检查器收起、Ctrl+Z 从此撤不动。场景数据没丢，但等于每停手一次就把他
        的工作状态砸一次。这一条把那条回路钉死。
      */
      const after = usePrevizStore.getState();
      expect(after.timelineFrame).toBe(42);
      expect(after.past.length).toBe(1);
      expect(after.future.length).toBe(0);
      expect(after.selectedObjectId).toBe(objectId);
      expect(after.timelineZoom).toBe(before.timelineZoom);
      expect(after.scene.objects).toHaveLength(1);

      // 再等三个窗口：写回换了 `initialScene` 引用，但不该把自己再点着一次。
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS * 3);
      });
      expect(onStored).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PrevizEditor initial scene", () => {
  it("loads whatever scene the node holds at the moment it reopens", async () => {
    const first = createDefaultScene();
    first.settings.durationFrames = 200;
    const second = createDefaultScene();
    second.settings.durationFrames = 300;

    const { rerender } = render(
      <PrevizEditor {...editorProps({ open: false, initialScene: first })} />,
    );
    // 关着的时候一个字节都不该灌进 store：这里必须还是 beforeEach 灌的那份默认场景。
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(
      PREVIZ_DEFAULT_DURATION_FRAMES,
    );

    rerender(<PrevizEditor {...editorProps({ open: true, initialScene: second })} />);
    await vi.waitFor(() => expect(setScene).toHaveBeenCalled());

    // 灌进来的必须是**打开这一刻**节点手里的那一份，不是挂载那一刻的那一份。
    //
    // 今天的 `PrevizNode` 是条件挂载，关窗就卸载、重开是重新挂载，`useRef` 的初值
    // 天然是当下那一份——所以这条用例钉的是**面向未来**的不变量：`initialScene` 走
    // 了 ref（免得自动保存写回换引用时把编辑会话重置掉），那么 ref 就必须在渲染期
    // 跟着最新 prop 走。谁把编辑器改成常驻挂载、拿 `open` 开关，这行断言就是他会先
    // 撞上的那道墙；少了它，改完之后重开会静静地灌回旧场景。
    expect(usePrevizStore.getState().scene.settings.durationFrames).toBe(300);
  });
});

/*
  写回没落地时不许谎报「已保存」。谎报一次的后果是：`dirty` 变 false，此后停手也好、
  关窗兜底也好，全被判据挡掉，编辑器一路空转到用户刷新页面——而节点那边「存不下」的
  toast 一辈子只弹一次，界面上没有任何异样。

  两条失败路径分开钉：**拒收**（`onFlush` 返回 false）是今天真会发生的那条——场景撑爆
  体积上限，`buildNodeScenePatch` 失败、一个字节都没存；**抛异常**今天没有生产来源
  （`handleFlush` 失败是 return，`updateNodeData` 是 zustand set），钉的是「将来写回改
  成会抛的实现」时 `onFlush()` 在前、`markSaved()` 在后这个顺序。
*/
describe("PrevizEditor autosave failure", () => {
  it("keeps the scene unsaved when the node refuses to store it", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => false);
    await renderEditor({ onFlush });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS);
      });
      expect(onFlush).toHaveBeenCalledTimes(1);
      // 拒收 = 没存下。记成「已保存」就等于把这一份连同后面所有改动一起放弃了。
      expect(usePrevizStore.getState().dirty).toBe(true);

      // 但也不许变成「每 600ms 重试一次」的空转：定时器开完火不会自己续命，用户
      // 不动手就没有第二次尝试。
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS * 5);
      });
      expect(onFlush).toHaveBeenCalledTimes(1);

      // 而下一次真编辑（比如删掉几个对象瘦身）必须把整份场景重新试一遍——这是超限
      // 之后唯一的复原路径。
      act(() => {
        usePrevizStore.getState().setDurationFrames(240);
      });
      act(() => {
        vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS);
      });
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush.mock.calls[1]![0].settings.durationFrames).toBe(240);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the scene unsaved when the close time write back is refused", async () => {
    const onFlush = vi.fn((_scene: PrevizScene) => false);
    const onOpenChange = vi.fn();
    await renderEditor({ onFlush, onOpenChange });

    act(() => {
      usePrevizStore.getState().setDurationFrames(200);
    });
    // 不等防抖到点就关窗，走的是兜底那条路。
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "previz.editor.close" }));
    });

    expect(onFlush).toHaveBeenCalledTimes(1);
    // 兜底这一发同样可能被拒收（场景撑爆体积上限），同样不许记成「已保存」。今天关窗
    // 之后编辑器立刻卸载、下次挂载又会 `loadScene` 清脏，所以这一条暂时观测不到——它
    // 钉的是「常驻挂载」那一天：那时谎报一次，这一整段编辑就再也没有第二次机会了。
    expect(usePrevizStore.getState().dirty).toBe(true);
    // 而且拒收不能把弹窗卡住：`flushIfDirty` 是同步调的，它要是拦下 `onOpenChange`，
    // 用户就关不掉编辑器了。
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays dirty when the write back throws", async () => {
    const onFlush = vi.fn(() => {
      throw new Error("node is gone");
    });
    await renderEditor({ onFlush });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      act(() => {
        usePrevizStore.getState().setDurationFrames(200);
      });
      expect(() =>
        act(() => {
          vi.advanceTimersByTime(PREVIZ_AUTOSAVE_MS);
        }),
      ).toThrow("node is gone");

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(usePrevizStore.getState().dirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
