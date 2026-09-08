// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { aspectRatio, verticalFovDeg } from '../domain/camera';
import type { OutputAspect, PrevizCamera } from '../domain/scene';

/** 监看画中画的两档大小。放大档没有铺满画布：主视图里的走位还得看得见。 */
export type MonitorSize = 'normal' | 'large';

/** 每一档占画布宽度的比例。 */
const MONITOR_WIDTH_RATIO: Record<MonitorSize, number> = { normal: 0.26, large: 0.55 };
/** 监看距画布边缘的留白，单位是 CSS 像素——见 [monitorViewportRect] 关于单位的说明。 */
const MONITOR_MARGIN = 16;

/**
 * 画布顶边要替右上角那排视口控件让开的高度，CSS 像素。
 *
 * 数是从 `PrevizViewportControls` 的类名推出来的：外层那条 `top-4` 离顶边 16，一簇
 * 控件是 `p-1`（4）加 1 px 边框裹着 `h-7`（28）的按钮与输入框，纵向 28 + 4 * 2 +
 * 1 * 2 = 38，底边正好落在 54；再加一个 `MONITOR_MARGIN` 的呼吸位，监看与控件之间
 * 的缝就和它跟画布另外三条边的缝一样宽，不至于两排控件贴着脸。
 *
 * 为什么不能只留 `MONITOR_MARGIN`：那 16 px 是画布自身的留白，而这排控件是浮在画布
 * **上面**的一层 DOM。监看铺满可用高度时顶边会长到它们背后，画面糊在按钮底下——按钮
 * 还在、还能点，只是读不出来了。只有竖幅出片 + 矮视口（时间轴拉高）才会走到按高度
 * 回推宽度那条分支，16:9 下够不着这条上限，所以这个洞一直没露过面。
 */
export const PREVIZ_MONITOR_TOP_RESERVE = 70;

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
 * 监看画中画在主画布里的矩形。**原点在左下角**——WebGL 的视口坐标系是这样，不是 DOM
 * 那套左上角。
 *
 * 单位是 CSS 像素而不是绘制缓冲像素：three 的 `setViewport` / `setScissor` 自己会乘
 * `pixelRatio`，`getSize` 拿回来的也是 CSS 尺寸。浮在上面那层 DOM（`PrevizMonitorFrame`）
 * 直接把这里的数当 style 用，两边因此天然对得上；换算成缓冲像素反倒会在高 DPR 屏上
 * 把框线甩到画面外，也会让这里按 Tailwind 类名推出来的留白凭空翻倍。
 */
export function monitorViewportRect(
  canvasWidth: number,
  canvasHeight: number,
  outputAspect: OutputAspect,
  size: MonitorSize = 'normal',
): MonitorRect {
  const aspect = aspectRatio(outputAspect);
  // 可用范围是画布减掉四周留白。两个方向都夹一遍，画面才会自己适应容器：
  // 只夹高度的话，放大档遇到又矮又宽的画布会横着顶出去；只夹宽度的话，竖幅
  // 画幅在矮画布上会上下顶出去。
  // 高度两头不对称：底边是普通留白，顶边得替视口控件让开一整排
  // （见 [PREVIZ_MONITOR_TOP_RESERVE]）。这条上限只在按宽度算出来的高超了它时才
  // 生效，所以监看本来就够矮的画幅（16:9 之类）一个像素都不会因此缩水。
  const maxWidth = Math.max(1, canvasWidth - MONITOR_MARGIN * 2);
  const maxHeight = Math.max(1, canvasHeight - MONITOR_MARGIN - PREVIZ_MONITOR_TOP_RESERVE);

  // 至少 1 像素：画布还没布局完（clientWidth 为 0）或者被拖到极窄时，
  // 按比例算出来的宽高会是 0，而 `setViewport(…, 0, 0)` 在部分驱动上是
  // GL_INVALID_VALUE——three 不报错，画面上只是监看框莫名其妙没了。
  let width = Math.max(1, Math.round(Math.min(canvasWidth * MONITOR_WIDTH_RATIO[size], maxWidth)));
  let height = Math.max(1, Math.round(width / aspect));

  // 竖幅监看在小画布上按宽度算会比画布还高，那时改按高度回推宽度。
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
