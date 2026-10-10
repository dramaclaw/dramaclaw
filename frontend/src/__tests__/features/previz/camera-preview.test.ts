// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { createCameraDraft } from "@/features/previz/domain/cameraDraft";
import {
  PREVIZ_PREVIEW_SIZE,
  previewFitRect,
  renderCameraPreview,
  type CameraPreviewCanvas,
  type CameraPreviewDeps,
  type CameraPreviewImageData,
} from "@/features/previz/engine/cameraPreview";

describe("previewFitRect", () => {
  it("fills the canvas when the output aspect matches it", () => {
    // 320×180 就是 16:9，出片也是 16:9 时不该有黑边。
    expect(previewFitRect(320, 180, "16:9")).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });

  it("pillarboxes a portrait output inside the landscape canvas", () => {
    const rect = previewFitRect(320, 180, "9:16");

    expect(rect.height).toBe(180);
    // 180 × 9/16 = 101.25，取整到 101；左右各留 109/110 的黑边。
    expect(rect.width).toBe(101);
    expect(rect.y).toBe(0);
    expect(rect.x).toBe(109);
    // 居中：左右黑边加起来正好是画布减去画面。
    expect(rect.x * 2 + rect.width).toBeLessThanOrEqual(320);
  });

  it("letterboxes a squarer output", () => {
    const rect = previewFitRect(320, 180, "4:3");

    expect(rect.height).toBe(180);
    expect(rect.width).toBe(240);
    expect(rect.x).toBe(40);
  });

  it("never returns a degenerate rect for an unlaid-out canvas", () => {
    // 画布还没布局完时宽高是 0。`setSize(0, 0)` 与 `createImageData(0, 0)` 都会抛，
    // 而这只是一帧过渡态，不该让整个对话框炸掉。
    const rect = previewFitRect(0, 0, "16:9");

    expect(rect.width).toBeGreaterThanOrEqual(1);
    expect(rect.height).toBeGreaterThanOrEqual(1);
  });

  it("pins the size upstream's dialog uses", () => {
    expect(PREVIZ_PREVIEW_SIZE).toEqual({ width: 320, height: 180 });
  });
});

class FakeRenderTarget {
  disposed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  dispose() {
    this.disposed = true;
  }
}

function setup() {
  const targets: FakeRenderTarget[] = [];
  const three = {
    SRGBColorSpace: "srgb",
    WebGLRenderTarget: class extends FakeRenderTarget {
      constructor(width: number, height: number) {
        super(width, height);
        targets.push(this);
      }
    },
  } as unknown as CameraPreviewDeps["three"];

  const camera = {
    position: { set: vi.fn() },
    rotation: { set: vi.fn() },
    fov: 0,
    aspect: 0,
    updateProjectionMatrix: vi.fn(),
  };

  const renderer = {
    getRenderTarget: vi.fn(() => null),
    setRenderTarget: vi.fn(),
    render: vi.fn(),
    readRenderTargetPixels: vi.fn(
      (
        _target: unknown,
        _x: number,
        _y: number,
        width: number,
        height: number,
        buffer: Uint8Array,
      ) => {
        // 最上面一行（WebGL 读回来是最后一行）涂成红色，用来验行序。
        const rowBytes = width * 4;
        for (let index = 0; index < rowBytes; index += 4) {
          buffer[(height - 1) * rowBytes + index] = 255;
          buffer[(height - 1) * rowBytes + index + 3] = 255;
        }
      },
    ),
  };

  const fills: Array<[number, number, number, number]> = [];
  let written: CameraPreviewImageData | null = null;
  let writtenAt: [number, number] | null = null;
  const context = {
    fillStyle: "",
    fillRect: vi.fn((x: number, y: number, width: number, height: number) => {
      fills.push([x, y, width, height]);
    }),
    createImageData: vi.fn((width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
    })),
    putImageData: vi.fn((image: CameraPreviewImageData, dx: number, dy: number) => {
      written = image;
      writtenAt = [dx, dy];
    }),
  };

  const canvas: CameraPreviewCanvas = {
    width: 320,
    height: 180,
    getContext: () => context,
  };

  const deps = {
    three,
    renderer,
    scene: { tag: "scene" },
    camera,
    canvas,
  } as unknown as CameraPreviewDeps;

  return {
    deps,
    canvas,
    camera,
    renderer,
    context,
    fills,
    targets,
    written: () => written,
    writtenAt: () => writtenAt,
  };
}

describe("renderCameraPreview", () => {
  it("poses the scratch camera from the draft and frames it by focal length", () => {
    const harness = setup();
    const draft = { ...createCameraDraft({ position: [1, 2, 3], target: [1, 2, 0] }), focalMm: 85 };

    renderCameraPreview(harness.deps, draft, "16:9");

    // 站位直接用草稿的（前移在 createCameraDraft 里已经算过，这里不能再挪一次）。
    expect(harness.camera.position.set).toHaveBeenCalledWith(...draft.position);
    expect(draft.position).toEqual([1, 2, 2.4]);
    // 姿态按 sceneGraph 同一套 YXZ 弧度写，不是度。
    expect(harness.camera.rotation.set).toHaveBeenCalledWith(0, 0, 0, "YXZ");
    // 85mm 全画幅、16:9 出片：垂直视场角 13.586°。
    expect(harness.camera.fov).toBeCloseTo(13.586, 3);
    expect(harness.camera.aspect).toBeCloseTo(16 / 9, 6);
    expect(harness.camera.updateProjectionMatrix).toHaveBeenCalled();
  });

  it("paints black bars around a portrait framing", () => {
    const harness = setup();

    renderCameraPreview(harness.deps, createCameraDraft({ position: [0, 1, 4], target: [0, 1, 0] }), "9:16");

    // 先把整块画布刷黑，再把画面贴在居中的位置上——否则上一帧的画面会从黑边里露出来。
    expect(harness.fills[0]).toEqual([0, 0, 320, 180]);
    expect(harness.targets[0]).toMatchObject({ width: 101, height: 180 });
    expect(harness.writtenAt()).toEqual([109, 0]);
  });

  it("flips the WebGL row order and releases the render target", () => {
    const harness = setup();

    renderCameraPreview(harness.deps, createCameraDraft({ position: [0, 1, 4], target: [0, 1, 0] }), "16:9");

    const image = harness.written();
    expect(image).not.toBeNull();
    // WebGL 的最后一行要落在 2D canvas 的第一行。
    expect(image?.data[0]).toBe(255);
    expect(image?.data[3]).toBe(255);
    expect(image?.data[image.data.length - 4]).toBe(0);
    // 离屏缓冲不释放的话，拖一次视角就漏掉几十张。
    expect(harness.targets[0]?.disposed).toBe(true);
    // 屏幕上原来挂着的 target 要还回去。
    expect(harness.renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it("does nothing when the canvas has no 2d context", () => {
    const harness = setup();
    const canvas: CameraPreviewCanvas = { width: 320, height: 180, getContext: () => null };

    // jsdom 里 getContext('2d') 返回 null。抛出去的话对话框一打开就白屏。
    expect(() =>
      renderCameraPreview(
        { ...harness.deps, canvas },
        createCameraDraft({ position: [0, 1, 4], target: [0, 1, 0] }),
        "16:9",
      ),
    ).not.toThrow();
    expect(harness.renderer.render).not.toHaveBeenCalled();
  });
});
