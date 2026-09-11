// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrevizRenderer } from "@/features/previz/engine/PrevizRenderer";

const render = vi.fn();

class FakeControls {
  enableDamping = false;
  // 真 OrbitControls 在构造里就填好这两份按键映射（three 0.185
  // `OrbitControls.js:358`）；进入绘制态摘掉的正是其中的左键与单指。
  mouseButtons: Record<string, number | null> = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
  touches: Record<string, number | null> = { ONE: 0, TWO: 1 };
  target = { set: vi.fn() };
  update = vi.fn(() => false);
  dispose = vi.fn();
  private listeners: Record<string, (() => void)[]> = {};

  addEventListener(type: string, handler: () => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  emit(type: string) {
    for (const handler of this.listeners[type] ?? []) handler();
  }
}

let controls: FakeControls;

vi.mock("three", () => {
  class Scene {
    background: unknown = null;
    add() {}
    // 手柄 helper 挂在 scene 下，dispose() 时要摘回去。
    remove() {}
    traverse() {}
  }
  return {
    Scene,
    // create() 现在会建两个 Group 挂进场景：场景图的对象根，与轨迹预览的根。
    // 本用例不碰这两样，但 dispose() 会走进轨迹预览的清理，所以 children / remove
    // 得是真的——少了它 dispose() 直接抛，按需重绘那条断言就跑不完。
    Group: class {
      children: unknown[] = [];
      visible = true;
      userData: Record<string, unknown> = {};
      add() {}
      remove() {}
    },
    Color: class {},
    // 地面网格：一块平面几何体 + 一份着色器材质，挂在一个 Mesh 上。
    Vector3: class {
      constructor(
        public x = 0,
        public y = 0,
        public z = 0,
      ) {}
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      }
    },
    PlaneGeometry: class {
      dispose = vi.fn();
      constructor(..._args: number[]) {}
    },
    ShaderMaterial: class {
      uniforms: Record<string, { value: unknown }> = {};
      dispose = vi.fn();
      constructor(params: Record<string, unknown> = {}) {
        Object.assign(this, params);
      }
    },
    DoubleSide: 2,
    // 接触阴影那一套：软阴影贴图、ACES 色调映射，和只画影子的承影材质。
    PCFSoftShadowMap: 2,
    ACESFilmicToneMapping: 4,
    ShadowMaterial: class {
      dispose = vi.fn();
      constructor(public options: Record<string, unknown> = {}) {}
    },
    MOUSE: { LEFT: 0, MIDDLE: 1, RIGHT: 2, ROTATE: 0, DOLLY: 1, PAN: 2 },
    TOUCH: { ROTATE: 0, PAN: 1, DOLLY_PAN: 2, DOLLY_ROTATE: 3 },
    Mesh: class {
      renderOrder = 0;
      userData: Record<string, unknown> = {};
      position = { set: vi.fn() };
      rotation = { x: 0, y: 0, z: 0 };
      scale = { set: vi.fn() };
      updateMatrixWorld = vi.fn();
      constructor(
        public geometry: unknown,
        public material: unknown,
      ) {}
    },
    // 手柄改造要新建这两样（见 `gizmoEmphasis.ts`）。只记入参：本文件问的是
    // 「渲染器有没有把 three 递给手柄」，不问几何运算。
    OctahedronGeometry: class {
      dispose = vi.fn();
      constructor(
        public radius: number,
        public detail: number,
      ) {}
    },
    MeshBasicMaterial: class {
      dispose = vi.fn();
      color: { getHex(): number };
      constructor(public options: Record<string, unknown>) {
        const hex = typeof options.color === "number" ? options.color : 0;
        this.color = { getHex: () => hex };
      }
    },
    HemisphereLight: class {},
    DirectionalLight: class {
      position = { set: vi.fn() };
      castShadow = false;
      // 投影相机与深度图尺寸都要照着场景调（默认框只有 ±5 米），所以替身得把这两样
      // 摆出来，否则 create() 当场炸在一句和本文件无关的 TypeError 上。
      shadow = {
        camera: {
          left: -5,
          right: 5,
          top: 5,
          bottom: -5,
          near: 0.5,
          far: 500,
          updateProjectionMatrix: vi.fn(),
        },
        mapSize: { set: vi.fn() },
        normalBias: 0,
      };
    },
    PerspectiveCamera: class {
      aspect = 1;
      position = { set: vi.fn() };
      updateProjectionMatrix = vi.fn();
    },
    WebGLRenderer: class {
      render = render;
      shadowMap = { enabled: false, type: 0 };
      toneMapping = 0;
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
      autoClear = true;
      getSize = vi.fn((target: { x: number; y: number }) => {
        target.x = 800;
        target.y = 450;
        return target;
      });
      setViewport = vi.fn();
      setScissor = vi.fn();
      setScissorTest = vi.fn();
      clearDepth = vi.fn();
    },
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    constructor() {
      controls = new FakeControls();
      return controls as unknown as object;
    }
  },
}));

// create() 现在还会动态 import 这两个 three 扩展来建人物模型工厂。本文件不碰场景内容，
// 桩到能被 new 出来就够；不桩的话跑的是真模块，而真模块 import 的是上面那份残缺的假 three。
/** 手柄内部的一颗 mesh。改造只读 name / geometry / material 三样，替身也就只有这三样。 */
function fakeGizmoHandle(name: string, radius: number, colorHex: number) {
  return {
    name,
    geometry: { radius, dispose: vi.fn() } as { radius: number; dispose: unknown },
    material: { color: { getHex: () => colorHex }, dispose: vi.fn() },
  };
}

/**
 * 真 `TransformControlsGizmo` 内部结构的最小替身，照抄 three 0.185：`isTransformControlsGizmo`
 * 标记 + `gizmo` / `picker` 两张表，各含一个 `translate` 组。只搭到改造够得着的那一层——
 * 本文件不测改造改得对不对（那是 `gizmo-emphasis.test.ts` 的事），只测渲染器有没有让它跑起来。
 */
function fakeTransformGizmo() {
  const centre = fakeGizmoHandle("XYZ", 0.1, 0xffffff);
  const pickerCentre = fakeGizmoHandle("XYZ", 0.2, 0xffffff);
  return {
    isTransformControlsGizmo: true,
    gizmo: { translate: { children: [centre] } },
    picker: { translate: { children: [pickerCentre] } },
    centre,
    pickerCentre,
  };
}

let transformGizmo: ReturnType<typeof fakeTransformGizmo>;

vi.mock("three/examples/jsm/controls/TransformControls.js", () => ({
  TransformControls: class {
    enabled = true;
    object: unknown = null;
    // attach/detach 照抄 three 0.185 的副作用：`_root.visible` 跟着开关，初值是 false
    // （`TransformControlsRoot` 构造里就写死了）。替身在这个属性上偏离真身，「手柄
    // 该不该在」这一类回归在集成层就永远观测不到；`gizmo.test.ts` 与
    // `previz-renderer-scene.test.ts` 的两份替身都是忠实的，这份分家只会让三份互相
    // 打架，比干脆没有覆盖更能骗人。
    attach = vi.fn((object: unknown) => {
      this.object = object;
      this.helper.visible = true;
    });
    detach = vi.fn(() => {
      this.object = null;
      this.helper.visible = false;
    });
    setMode = vi.fn();
    setSpace = vi.fn();
    dispose = vi.fn();
    // 真手柄是个 Object3D，挂在 scene 下面。谁扫一遍 scene 的子节点都会碰到它，
    // 少了 userData 就是一句和被测行为毫无关系的 TypeError。
    //
    // 每次都交同一份，而不是新建一个字面量：`applyVisibility()` 改的就是它的 visible，
    // 每次换一份的话那次赋值写完就丢，「手柄藏没藏住」在这里根本观测不到；
    // gizmo dispose 里那次 `root.remove(getHelper())` 同理，删的得是当初加进去的那个。
    helper = {
      traverse: (visit: (node: unknown) => void) => visit(transformGizmo),
      visible: false,
      userData: {},
    };
    getHelper = vi.fn(() => this.helper);
    addEventListener = vi.fn();
  },
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    // 永不落地：本文件一个人物都没有，加载器本来就不该被调到。
    loadAsync = vi.fn(() => new Promise(() => {}));
  },
}));

vi.mock("three/examples/jsm/loaders/OBJLoader.js", () => ({
  OBJLoader: class {
    // 同上：本文件没有物件，加载器不该被调到。
    loadAsync = vi.fn(() => new Promise(() => {}));
  },
}));

vi.mock("three/examples/jsm/utils/SkeletonUtils.js", () => ({
  clone: (object: unknown) => object,
}));

let frames: FrameRequestCallback[] = [];

/** 跑一帧：rAF 回调里会重新排下一帧，所以先取走再执行。 */
function step() {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(0);
}

beforeEach(() => {
  frames = [];
  transformGizmo = fakeTransformGizmo();
  render.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrevizRenderer 按需重绘", () => {
  it("在 controls 自己发 change 时重绘", async () => {
    const canvas = document.createElement("canvas");
    const instance = await PrevizRenderer.create(canvas);

    // create() 里的 resize() 已经同步画过首帧；先跑一帧、清掉计数，下面只看 change。
    step();
    render.mockClear();

    // 静止帧不该重绘，否则下面的断言就不是在测 change 了。
    step();
    expect(render).not.toHaveBeenCalled();

    // 滚轮缩放：OrbitControls 的 wheel 处理器自己调 update() 消化掉 _scale，
    // 只留下一个 change 事件。tick 里再调 update() 只会拿到 false —— 不听 change
    // 的话相机动了却永远不重绘，缩放在屏幕上完全没反应。
    controls.emit("change");
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });
});

describe("PrevizRenderer 尺寸变化", () => {
  it("resize() 当场重绘，不等下一帧", async () => {
    const canvas = document.createElement("canvas");
    const instance = await PrevizRenderer.create(canvas);
    step();
    render.mockClear();

    // 拖时间轴高度时每次 pointermove 都让 ResizeObserver 回调走到这里。同一帧里
    // ResizeObserver 排在 rAF 之后、绘制之前：setSize 一改画布属性，位图就被清空——
    // 这时只标 needsRender 等下一帧，合成出去的就是一块空画布，连着拖就一路闪。
    instance.resize();
    expect(render).toHaveBeenCalledTimes(1);

    // 已经画过了，下一帧不该再画一遍。
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });
});

describe("PrevizRenderer 视口手势", () => {
  it("中键始终环绕视角，不分工具", async () => {
    const canvas = document.createElement("canvas");
    const instance = await PrevizRenderer.create(canvas);

    // 滚轮已经负责推拉，中键再推拉是重复的；中键环绕是 Blender 等 DCC 的通用习惯，
    // 不必先切到某个特定工具。
    expect(controls.mouseButtons.MIDDLE).toBe(0);

    instance.dispose();
  });
});

describe("PrevizRenderer 绘制态", () => {
  it("绘制时摘掉左键与单指的轨道旋转，画完再挂回去", async () => {
    const canvas = document.createElement("canvas");
    const instance = await PrevizRenderer.create(canvas);

    // 画笔和 OrbitControls 听的是同一块 canvas 上同一串指针事件，都认「按住左键拖」。
    // 不摘的话每划一笔整个空间跟着转，而落点是拿当前相机打射线求的——视角边转边画，
    // 画出来的轨迹和手划过的形状对不上。
    instance.setDrawing(true);
    expect(controls.mouseButtons.LEFT).toBeNull();
    expect(controls.touches.ONE).toBeNull();

    // 缩放、环绕、平移在绘制途中照样要用：画一条长轨迹常常得一路转着看。
    expect(controls.mouseButtons.MIDDLE).toBe(0);
    expect(controls.mouseButtons.RIGHT).toBe(2);

    instance.setDrawing(false);
    expect(controls.mouseButtons.LEFT).toBe(0);
    expect(controls.touches.ONE).toBe(0);

    instance.dispose();
  });
});

describe("PrevizRenderer 手柄改造", () => {
  it("建手柄时把 three 递下去，中心那颗当场被改大", async () => {
    const canvas = document.createElement("canvas");
    const stock = transformGizmo.centre.geometry;
    const stockPicker = transformGizmo.pickerCentre.geometry;

    const instance = await PrevizRenderer.create(canvas);

    // 钉的是 create() 里 `new PrevizGizmo({ ... })` 那一行 `three,`。它是整个手柄改造
    // 的总开关，而且是个**可选**字段——漏掉不会有任何类型错误：PrevizGizmo 收到的
    // deps.three 是 undefined，改造整段跳过，中心手柄退回官方那颗 0.25 不透明度的白
    // 八面体，视口里照样看不见。`gizmo-emphasis.test.ts` 里那两条 wiring 用例测的是
    // PrevizGizmo 拿到 / 拿不到这个字段时的反应，测不到渲染器到底有没有传，删掉那
    // 一行它们全绿——这条是唯一会红的。
    expect(transformGizmo.centre.geometry).not.toBe(stock);
    expect(transformGizmo.centre.geometry.radius).toBeGreaterThan(stock.radius);
    expect(transformGizmo.pickerCentre.geometry.radius).toBeGreaterThan(stockPicker.radius);

    instance.dispose();
  });
});
