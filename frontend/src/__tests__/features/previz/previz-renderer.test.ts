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
    traverse() {}
  }
  return {
    Scene,
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
