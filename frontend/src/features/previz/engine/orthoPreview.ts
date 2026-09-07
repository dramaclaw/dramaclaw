// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { PrevizOrthoPlacement } from '../domain/view';
import { blitCameraToCanvas } from './cameraPreview';
import type { CameraPreviewCanvas, ThreeModule } from './cameraPreview';

/**
 * 四视图那两块预览画布：拿一台正交相机把整场戏画进画布。
 *
 * 与取景预览（`cameraPreview.ts`）的区别只有两条，其余全走同一条离屏路径：
 * 相机是正交的（俯视/侧视要的是「量得准」，透视会让平行的走位往灭点收），画面铺满整块
 * 画布不留黑边（取景窗本来就是按画布比例开的，见 `domain/view.ts` 的 `orthoPlacement`）。
 */

export interface OrthoPreviewDeps {
  three: ThreeModule;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** 一台常驻的临时相机，每次预览重新摆位；每帧新建会在拖时间轴时一秒丢几十个对象。 */
  camera: THREE.OrthographicCamera;
  canvas: CameraPreviewCanvas;
}

export function renderOrthoPreview(deps: OrthoPreviewDeps, placement: PrevizOrthoPlacement): void {
  // 至少 1 像素：画布尚未布局时宽高是 0，而 `WebGLRenderTarget(0, 0)` 与
  // `createImageData(0, 0)` 都会抛。那只是一帧过渡态，不该炸掉整个面板。
  const width = Math.max(1, Math.floor(deps.canvas.width));
  const height = Math.max(1, Math.floor(deps.canvas.height));

  const { camera } = deps;
  camera.left = -placement.halfWidth;
  camera.right = placement.halfWidth;
  camera.top = placement.halfHeight;
  camera.bottom = -placement.halfHeight;
  camera.near = placement.near;
  camera.far = placement.far;
  camera.position.set(...placement.position);
  // up 必须在 lookAt 之前写：lookAt 是拿当前的 up 去正交化出姿态的，写反了顶视图的
  // 滚转就由上一次预览留下的 up 决定，两块画布还会互相影响。
  camera.up.set(...placement.up);
  camera.lookAt(placement.target[0], placement.target[1], placement.target[2]);
  camera.updateProjectionMatrix();

  blitCameraToCanvas(deps, camera, { x: 0, y: 0, width, height });
}
