// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import {
  renderCapture,
  type CaptureCanvas,
  type CaptureImageData,
  type RenderCaptureDeps,
} from "@/features/previz/capture/renderCapture";
import type { OutputAspect } from "@/features/previz/domain/scene";

class FakeRenderTarget {
  disposed = false;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly options: { colorSpace?: unknown } | undefined,
  ) {}
  dispose() {
    this.disposed = true;
  }
}

let lastTarget: FakeRenderTarget | null = null;

/**
 * 假的 three：只提供 renderCapture 用到的那两样。真 three 需要 WebGL 上下文，
 * jsdom 里建不出来。
 */
const three = {
  SRGBColorSpace: "srgb",
  WebGLRenderTarget: class extends FakeRenderTarget {
    constructor(width: number, height: number, options: { colorSpace?: unknown } | undefined) {
      super(width, height, options);
      lastTarget = this;
    }
  },
} as unknown as RenderCaptureDeps["three"];

interface SetupOptions {
  /** 往 readRenderTargetPixels 的缓冲里画点东西，用来验证行序。 */
  fill?: (pixels: Uint8Array, width: number, height: number) => void;
  /** 调用前屏幕上正挂着的 render target；默认是 null（直接画到画布上）。 */
  previousTarget?: unknown;
  /** getContext('2d') 返回 null——jsdom 没装 node-canvas 时的真实行为。 */
  noContext?: boolean;
}

function setup(options: SetupOptions = {}) {
  lastTarget = null;

  const previousTarget = options.previousTarget ?? null;
  const scene = { tag: "scene" };
  const camera = { tag: "camera" };

  const renderer = {
    getRenderTarget: vi.fn(() => previousTarget),
    setRenderTarget: vi.fn((_target: unknown) => {}),
    render: vi.fn((_scene: unknown, _camera: unknown) => {}),
    readRenderTargetPixels: vi.fn(
      (
        _target: unknown,
        _x: number,
        _y: number,
        width: number,
        height: number,
        buffer: Uint8Array,
      ) => {
        options.fill?.(buffer, width, height);
      },
    ),
  };

  let written: CaptureImageData | null = null;
  let writtenAt: readonly [number, number] | null = null;
  const blob = new Blob(["png"], { type: "image/png" });
  const toBlob = vi.fn((callback: (value: Blob | null) => void, _type?: string) => {
    callback(blob);
  });
  const canvas: CaptureCanvas = {
    width: 0,
    height: 0,
    getContext: () =>
      options.noContext
        ? null
        : {
            createImageData: (width: number, height: number) => ({
              data: new Uint8ClampedArray(width * height * 4),
              width,
              height,
            }),
            putImageData: (image: CaptureImageData, dx: number, dy: number) => {
              written = image;
              writtenAt = [dx, dy];
            },
          },
    toBlob,
  };

  const createCanvas = vi.fn((_width: number, _height: number) => canvas);

  const deps = {
    three,
    renderer,
    scene,
    camera,
    createCanvas,
  } as unknown as RenderCaptureDeps;

  return {
    deps,
    renderer,
    scene,
    camera,
    canvas,
    createCanvas,
    blob,
    previousTarget,
    written: (): CaptureImageData | null => written,
    writtenAt: (): readonly [number, number] | null => writtenAt,
  };
}

describe("renderCapture", () => {
  // 四种画幅的像素尺寸两两互异，正好把「读表」和「写死一组数」区分开。
  const cases: ReadonlyArray<readonly [OutputAspect, number, number]> = [
    ["16:9", 1920, 1080],
    ["9:16", 1080, 1920],
    ["1:1", 1440, 1440],
    ["4:3", 1600, 1200],
  ];

  it.each(cases)(
    "renders %s at the pixel size that aspect prescribes",
    async (aspect, width, height) => {
      const { deps, createCanvas, renderer } = setup();

      const blob = await renderCapture(deps, aspect);

      expect(lastTarget?.width).toBe(width);
      expect(lastTarget?.height).toBe(height);
      expect(createCanvas).toHaveBeenCalledWith(width, height);
      expect(renderer.readRenderTargetPixels).toHaveBeenCalledWith(
        lastTarget,
        0,
        0,
        width,
        height,
        expect.any(Uint8Array),
      );
      const buffer = renderer.readRenderTargetPixels.mock.calls[0][5];
      expect(buffer.length).toBe(width * height * 4);
      expect(blob.type).toBe("image/png");
    },
  );

  it("asks for an sRGB target and hands back the canvas's own blob", async () => {
    const { deps, canvas, blob } = setup();

    const produced = await renderCapture(deps, "16:9");

    expect(lastTarget?.options?.colorSpace).toBe("srgb");
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(produced).toBe(blob);
  });

  it("renders the scene and camera it was given into the offscreen target", async () => {
    const { deps, renderer, scene, camera } = setup();

    await renderCapture(deps, "16:9");

    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
    // 必须先切到离屏 target 再渲染，否则画的是屏幕。
    expect(renderer.setRenderTarget.mock.calls[0][0]).toBe(lastTarget);
    expect(renderer.setRenderTarget.mock.invocationCallOrder[0]).toBeLessThan(
      renderer.render.mock.invocationCallOrder[0],
    );
    expect(renderer.render.mock.invocationCallOrder[0]).toBeLessThan(
      renderer.readRenderTargetPixels.mock.invocationCallOrder[0],
    );
  });

  // WebGL 从下往上读，2D canvas 从上往下写。不翻行的话截图整张上下颠倒——
  // 而且是那种「看着像没坏」的颠倒，很容易一路带到下游。
  // 用 4:3（1600×1200）而不是方形：宽高不等才能顺带钉住「行跨距按宽算」。
  it("flips the rows out of WebGL bottom-up order", async () => {
    const { deps, written, writtenAt } = setup({
      // 每行的行号编进 R/G 两个通道（1200 行放不进一个字节），列号编进 B。
      // 这样输出的任意一行都能反解出它来自 WebGL 的哪一行、哪一列。
      fill: (pixels, width, height) => {
        for (let row = 0; row < height; row += 1) {
          for (let column = 0; column < width; column += 1) {
            const at = (row * width + column) * 4;
            pixels[at] = row & 0xff;
            pixels[at + 1] = (row >> 8) & 0xff;
            pixels[at + 2] = column & 0xff;
            pixels[at + 3] = 255;
          }
        }
      },
    });

    await renderCapture(deps, "4:3");

    const image = written();
    expect(image).not.toBeNull();
    expect(image!.width).toBe(1600);
    expect(image!.height).toBe(1200);
    expect(writtenAt()).toEqual([0, 0]);

    const sourceRowOf = (outputRow: number, column = 0): number => {
      const at = (outputRow * 1600 + column) * 4;
      return image!.data[at] + (image!.data[at + 1] << 8);
    };
    // 输出第 0 行来自 WebGL 的最后一行（1199），输出最后一行来自 WebGL 的第 0 行。
    expect(sourceRowOf(0)).toBe(1199);
    expect(sourceRowOf(1)).toBe(1198);
    expect(sourceRowOf(700)).toBe(499);
    expect(sourceRowOf(1199)).toBe(0);
    // 列序不动：翻的是行，不是整个缓冲。
    expect(sourceRowOf(0, 1599)).toBe(1199);
    expect(image!.data[(0 * 1600 + 1599) * 4 + 2]).toBe(1599 & 0xff);
    expect(image!.data[(1199 * 1600 + 37) * 4 + 2]).toBe(37);
    expect(image!.data[3]).toBe(255);
  });

  it("restores the render target that was active before and frees the temporary one", async () => {
    const previous = { tag: "previous-target" };
    const { deps, renderer } = setup({ previousTarget: previous });

    await renderCapture(deps, "4:3");

    // 恢复的是调用前那一个，不是无脑 setRenderTarget(null)。
    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(previous);
    expect(lastTarget?.disposed).toBe(true);
    // 恢复必须发生在像素读回之后，否则读的是错的 framebuffer。
    const restoreOrder =
      renderer.setRenderTarget.mock.invocationCallOrder[
        renderer.setRenderTarget.mock.invocationCallOrder.length - 1
      ];
    expect(restoreOrder).toBeGreaterThan(
      renderer.readRenderTargetPixels.mock.invocationCallOrder[0],
    );
  });

  it("restores a null render target when none was active", async () => {
    const { deps, renderer } = setup();

    await renderCapture(deps, "16:9");

    expect(renderer.setRenderTarget).toHaveBeenLastCalledWith(null);
  });

  it("rejects when the canvas has no 2d context", async () => {
    const { deps } = setup({ noContext: true });

    await expect(renderCapture(deps, "16:9")).rejects.toThrow(/2d context/);
  });

  it("rejects when the canvas hands back no blob", async () => {
    const { deps, canvas } = setup();
    canvas.toBlob = ((callback: (value: Blob | null) => void) =>
      callback(null)) as CaptureCanvas["toBlob"];

    await expect(renderCapture(deps, "16:9")).rejects.toThrow(/toBlob/);
  });
});
