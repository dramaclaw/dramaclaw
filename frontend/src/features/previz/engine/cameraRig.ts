// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { aspectRatio, verticalFovDeg } from '../domain/camera';
import type { OutputAspect, PrevizCamera } from '../domain/scene';

/** 监看画中画占画布宽度的比例。 */
const MONITOR_WIDTH_RATIO = 0.26;
/** 监看距画布边缘的留白，单位是绘制缓冲像素。 */
const MONITOR_MARGIN = 16;

/**
 * 把机位对象的参数与世界变换灌进监看相机。
 *
 * 读 `matrixWorld` 而不是 `position` / `rotation`：机位节点将来可能挂在别的父节点
 * 下（P4 的特写 rig 就是这么做的），那时局部变换已经不等于世界变换了。
 */
export function syncMonitorCamera(
  monitor: THREE.PerspectiveCamera,
  node: THREE.Object3D,
  camera: PrevizCamera,
  outputAspect: OutputAspect,
): void {
  node.updateWorldMatrix(true, false);
  monitor.position.setFromMatrixPosition(node.matrixWorld);
  monitor.quaternion.setFromRotationMatrix(node.matrixWorld);
  monitor.fov = verticalFovDeg(camera.focalMm, camera.sensor, outputAspect);
  monitor.aspect = aspectRatio(outputAspect);
  monitor.updateProjectionMatrix();
}

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 监看画中画在主画布里的矩形，单位是绘制缓冲像素。**原点在左下角**——
 * WebGL 的视口坐标系是这样，不是 DOM 那套左上角。
 */
export function monitorViewportRect(
  canvasWidth: number,
  canvasHeight: number,
  outputAspect: OutputAspect,
): MonitorRect {
  const aspect = aspectRatio(outputAspect);
  // 至少 1 像素：画布还没布局完（clientWidth 为 0）或者被拖到极窄时，
  // 按比例算出来的宽高会是 0，而 `setViewport(…, 0, 0)` 在部分驱动上是
  // GL_INVALID_VALUE——three 不报错，画面上只是监看框莫名其妙没了。
  let width = Math.max(1, Math.round(canvasWidth * MONITOR_WIDTH_RATIO));
  let height = Math.max(1, Math.round(width / aspect));

  // 竖幅监看在小画布上按宽度算会比画布还高，那时改按高度回推宽度。
  const maxHeight = Math.max(1, canvasHeight - MONITOR_MARGIN * 2);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.max(1, Math.round(height * aspect));
  }

  return {
    // 画布比监看还窄时 x 会是负数，视口整个跑到画布外——夹在 0。
    x: Math.max(0, canvasWidth - width - MONITOR_MARGIN),
    y: MONITOR_MARGIN,
    width,
    height,
  };
}
