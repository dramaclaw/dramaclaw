// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { OUTPUT_PIXEL_SIZE } from '../domain/camera';
import type { OutputAspect } from '../domain/scene';

export type ThreeModule = typeof import('three');

/** ImageData 里本模块用到的那部分；真 ImageData 结构上满足它。 */
export interface CaptureImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface CaptureContext2D {
  createImageData(width: number, height: number): CaptureImageData;
  putImageData(image: CaptureImageData, dx: number, dy: number): void;
}

/**
 * 出片用的那块 2D 画布。写成结构类型是为了 jsdom：那里 `getContext('2d')` 返回
 * null（没装 node-canvas），测试塞一个假的进来就行。
 */
export interface CaptureCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CaptureContext2D | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface RenderCaptureDeps {
  three: ThreeModule;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** 出片相机。调用方负责先把它的 aspect / fov 调成出片画幅该有的样子。 */
  camera: THREE.Camera;
  createCanvas: (width: number, height: number) => CaptureCanvas;
}

/** 浏览器里的默认实现；测试不走这条。 */
export function createDomCaptureCanvas(width: number, height: number): CaptureCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas as unknown as CaptureCanvas;
}

/**
 * 把当前场景按画幅渲染成一张 PNG。
 *
 * 走离屏 render target 而不是临时改屏幕画布的尺寸：后者会在屏幕上真的闪一帧
 * 出片分辨率的画面，而且 `toBlob` 是异步的，恢复尺寸怎么排都别扭。
 *
 * `aspect` 是字符串联合，查表查不空——与 `domain/camera.ts` 的约定一致，这里不重复校验。
 */
export async function renderCapture(
  deps: RenderCaptureDeps,
  aspect: OutputAspect,
): Promise<Blob> {
  const { width, height } = OUTPUT_PIXEL_SIZE[aspect];

  const target = new deps.three.WebGLRenderTarget(width, height, {
    colorSpace: deps.three.SRGBColorSpace,
  });
  const previous = deps.renderer.getRenderTarget();
  deps.renderer.setRenderTarget(target);
  deps.renderer.render(deps.scene, deps.camera);

  const pixels = new Uint8Array(width * height * 4);
  deps.renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
  deps.renderer.setRenderTarget(previous);
  target.dispose();

  const canvas = deps.createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('previz capture: 2d context unavailable');

  const image = context.createImageData(width, height);
  const rowBytes = width * 4;
  // WebGL 读回来的行序是从下往上，2D canvas 是从上往下。不翻的话整张图上下颠倒。
  for (let row = 0; row < height; row += 1) {
    const source = (height - 1 - row) * rowBytes;
    image.data.set(pixels.subarray(source, source + rowBytes), row * rowBytes);
  }
  context.putImageData(image, 0, 0);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('previz capture: toBlob returned null'));
    }, 'image/png');
  });
}
