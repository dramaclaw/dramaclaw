// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrevizRenderer } from "@/features/previz/engine/PrevizRenderer";

const render = vi.fn();

class FakeControls {
  enableDamping = false;
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
    // create() 现在会建一个对象根挂进场景（场景图的父节点）。本用例不碰场景图，
    // 一个空壳就够——但少了它 create() 直接抛，整条按需重绘的断言都跑不到。
    Group: class {},
    Color: class {},
    GridHelper: class {},
    AmbientLight: class {},
    DirectionalLight: class {
      position = { set: vi.fn() };
    },
    PerspectiveCamera: class {
      aspect = 1;
      position = { set: vi.fn() };
      updateProjectionMatrix = vi.fn();
    },
    WebGLRenderer: class {
      render = render;
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
vi.mock("three/examples/jsm/controls/TransformControls.js", () => ({
  TransformControls: class {
    enabled = true;
    object = null;
    attach = vi.fn();
    detach = vi.fn();
    setMode = vi.fn();
    setSpace = vi.fn();
    dispose = vi.fn();
    getHelper = vi.fn(() => ({ traverse() {} }));
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

    // create() 里的 resize() 置了 needsRender，先把首帧跑掉。
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
