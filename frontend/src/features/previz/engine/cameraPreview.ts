// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { DEG_TO_RAD, aspectRatio, verticalFovDeg } from '../domain/camera';
import type { PrevizCameraDraft } from '../domain/cameraDraft';
import type { OutputAspect } from '../domain/scene';

export type ThreeModule = typeof import('three');

/** 摄影机创建对话框那块预览画布的 CSS 尺寸，与 upstream 一致。 */
export const PREVIZ_PREVIEW_SIZE = { width: 320, height: 180 } as const;

export interface CameraPreviewImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * 预览画布用到的那部分 2D 上下文。写成结构类型的理由同 `renderCapture`：
 * jsdom 里 `getContext('2d')` 返回 null，测试塞个假的进来就行。
 */
export interface CameraPreviewContext2D {
  // 与真 `CanvasRenderingContext2D` 对齐的宽类型：写成 `string` 的话真画布赋不进来，
  // 属性的可赋值性是协变的，窄一格就整个不兼容。本模块只往里写颜色字符串。
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, width: number, height: number): void;
  createImageData(width: number, height: number): CameraPreviewImageData;
  putImageData(image: CameraPreviewImageData, dx: number, dy: number): void;
}

export interface CameraPreviewCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CameraPreviewContext2D | null;
}

export interface CameraPreviewDeps {
  three: ThreeModule;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** 一台临时相机，每次预览都按草稿重新摆位；不要复用监看相机，那台归监看管。 */
  camera: THREE.PerspectiveCamera;
  canvas: CameraPreviewCanvas;
}

export interface CameraPreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 出片画面在预览画布里的位置，**原点在左上角**（2D canvas 那一套，不是 WebGL 的左下角）。
 *
 * 预览画布是固定的 320×180，出片画幅却可能是 9:16。等比缩进去、居中、四周留黑边，
 * 用户看到的才是真出片时的取景，而不是被拉伸过的画面。
 */
export function previewFitRect(
  canvasWidth: number,
  canvasHeight: number,
  aspect: OutputAspect,
): CameraPreviewRect {
  // 至少 1 像素：画布尚未布局时宽高是 0，而 `WebGLRenderTarget(0, 0)` 与
  // `createImageData(0, 0)` 都会抛。那只是一帧过渡态，不该炸掉整个对话框。
  const width = Math.max(1, Math.floor(canvasWidth));
  const height = Math.max(1, Math.floor(canvasHeight));
  const ratio = aspectRatio(aspect);

  let fitWidth = Math.max(1, Math.round(height * ratio));
  let fitHeight = height;
  if (fitWidth > width) {
    fitWidth = width;
    fitHeight = Math.max(1, Math.round(width / ratio));
  }

  // 用 floor 而不是 round 居中：剩下的那半像素留给右边/下边，画面不会越出画布。
  return {
    x: Math.floor((width - fitWidth) / 2),
    y: Math.floor((height - fitHeight) / 2),
    width: fitWidth,
    height: fitHeight,
  };
}

/**
 * 按草稿的机位参数渲染一帧取景预览。
 *
 * 借的是视口那套渲染器与场景（见 [blitCameraToCanvas]），所以预览里所见与视口里所见
 * 严格一致。画布是固定的 320×180 而出片画幅可能是 9:16，画面按 [previewFitRect] 等比
 * 缩进去、四周留黑边——拉伸过的预览会让用户按错误的构图去摆机位。
 */
export function renderCameraPreview(
  deps: CameraPreviewDeps,
  draft: PrevizCameraDraft,
  aspect: OutputAspect,
): void {
  const rect = previewFitRect(deps.canvas.width, deps.canvas.height, aspect);

  const [px, py, pz] = draft.position;
  deps.camera.position.set(px, py, pz);
  // 与 `sceneGraph` 同一套约定：YXZ 次序、弧度、对象在零旋转时朝 -Z。
  deps.camera.rotation.set(
    draft.pitchDeg * DEG_TO_RAD,
    draft.yawDeg * DEG_TO_RAD,
    draft.rollDeg * DEG_TO_RAD,
    'YXZ',
  );
  deps.camera.fov = verticalFovDeg(draft.focalMm, draft.sensor, aspect);
  deps.camera.aspect = aspectRatio(aspect);
  deps.camera.updateProjectionMatrix();

  blitCameraToCanvas(deps, deps.camera, rect);
}

/**
 * 把 `camera` 眼里的一帧画进 `deps.canvas` 上的 `rect`，画布其余部分刷黑。
 *
 * 走离屏 render target 再读回像素，而不是给预览画布单开一个 WebGL 上下文：浏览器对
 * 同时存活的上下文有个位数的上限，多开一个还要多一套场景、灯光与模型副本。取景预览与
 * 四视图预览共用这一份，是因为「读回来的行序要翻」「离屏缓冲用完要 dispose」「屏幕上
 * 原来挂着的 target 要还回去」这三件事漏掉任何一件都只表现为画面不对，很难倒查。
 *
 * 拿不到 2D 上下文时**什么都不做**：jsdom 与个别隐私模式下 `getContext('2d')` 会返回
 * null，抛出去的话对话框一打开就白屏，而预览本来就只是个辅助。
 */
export function blitCameraToCanvas(
  deps: Omit<CameraPreviewDeps, 'camera'>,
  camera: THREE.Camera,
  rect: CameraPreviewRect,
): void {
  const context = deps.canvas.getContext('2d');
  if (!context) return;

  const target = new deps.three.WebGLRenderTarget(rect.width, rect.height, {
    colorSpace: deps.three.SRGBColorSpace,
  });
  const previous = deps.renderer.getRenderTarget();
  deps.renderer.setRenderTarget(target);
  deps.renderer.render(deps.scene, camera);

  const pixels = new Uint8Array(rect.width * rect.height * 4);
  deps.renderer.readRenderTargetPixels(target, 0, 0, rect.width, rect.height, pixels);
  deps.renderer.setRenderTarget(previous);
  target.dispose();

  // 先整块刷黑：出片画幅从 16:9 换成 9:16 时，上一帧铺满画布的画面会从新的黑边里露出来。
  context.fillStyle = '#000000';
  context.fillRect(0, 0, deps.canvas.width, deps.canvas.height);

  const image = context.createImageData(rect.width, rect.height);
  const rowBytes = rect.width * 4;
  // WebGL 读回来的行序自下而上，2D canvas 自上而下。不翻的话画面上下颠倒。
  for (let row = 0; row < rect.height; row += 1) {
    const source = (rect.height - 1 - row) * rowBytes;
    image.data.set(pixels.subarray(source, source + rowBytes), row * rowBytes);
  }
  context.putImageData(image, rect.x, rect.y);
}
