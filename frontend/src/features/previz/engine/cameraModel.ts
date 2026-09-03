// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { DEG_TO_RAD, aspectRatio, verticalFovDeg } from '../domain/camera';
import type { OutputAspect, PrevizCamera } from '../domain/scene';
import type { ThreeModule } from './sceneGraph';

/**
 * 机位在视口里的样子：一台蓝色的摄影机，加一具朝前张开的橙色取景视锥。
 *
 * 为什么不是一个锥体了：只有一个锥体时，「机位朝哪」和「取景多宽」挤在同一个形状上，
 * 换焦距画面里什么都不变，得点开属性面板才知道这台机器现在是广角还是长焦。拆成
 * 「实体机身指朝向 + 线框视锥指取景范围」之后，焦距、传感器、出片画幅三个参数任意一个
 * 改动都直接看得见。
 *
 * three 以构造参数传入，与 `sceneGraph.ts` / `characterRig.ts` 同一个理由：jsdom 里建不出
 * WebGL 上下文，测试要喂假 three；而任何一句静态 `import 'three'` 都会把 three 从
 * `PrevizRenderer` 那个唯一的 `import('three')` 懒加载块里拽出来。
 */

/**
 * 视锥画到机位前方多远，单位米。
 *
 * 1.6 m 是个取景意图的示意长度，不是对焦距离——真按超焦距画的话长焦机位的视锥会捅穿
 * 半个场景。选它是因为它比人物占位体（~1.7 m 高）略短：视锥落在人身上时一眼看得出
 * 谁在框里，又不至于把画面糊住。
 */
export const PREVIZ_CAMERA_FRUSTUM_DISTANCE = 1.6;

/** 机身各件的本色。视锥用橙色，为的是在一堆蓝色机身里认得出哪一具是自己的。 */
export const PREVIZ_CAMERA_COLOR = {
  body: 0x3f6fb4,
  /** 顶板与尾板：比机身深一档，靠明暗差把机身的体块关系撑出来。 */
  shell: 0x24365c,
  barrel: 0x2f4f8f,
  hood: 0x6d9ada,
  frustum: 0xd69a24,
} as const;

/** 机身各件的尺寸与站位，单位米。整台约 0.51 m 长，与真实电影机同量级。 */
const HOOD_LENGTH = 0.06;
const BARREL_LENGTH = 0.11;
const BODY_LENGTH = 0.34;

/**
 * 视锥的线段端点，扁平排布（每三个数一个点，每两个点一段）。
 *
 * 8 段：4 条从镜头出发的棱，加远端矩形的 4 条边。
 *
 * 取景角走 `verticalFovDeg` 而不是 `sensorVerticalFovDeg`——前者把出片画幅算进去了，
 * 与 `cameraRig.ts` 里监看相机用的是同一个函数。用后者的话视口里画的框会比监看里
 * 真正拍到的画面大一圈，而这正是这个视锥唯一要回答的问题。
 *
 * 朝向取 -Z：three 的相机就是朝 -Z 看的，机位节点的旋转直接套在这上面。
 */
export function frustumWireframe(
  focalMm: number,
  sensor: PrevizCamera['sensor'],
  aspect: OutputAspect,
  distance: number,
): number[] {
  const halfHeight = distance * Math.tan((verticalFovDeg(focalMm, sensor, aspect) * DEG_TO_RAD) / 2);
  const halfWidth = halfHeight * aspectRatio(aspect);
  const z = -distance;
  const corners: Array<[number, number, number]> = [
    [-halfWidth, halfHeight, z],
    [halfWidth, halfHeight, z],
    [halfWidth, -halfHeight, z],
    [-halfWidth, -halfHeight, z],
  ];

  const points: number[] = [];
  for (const [x, y, cz] of corners) points.push(0, 0, 0, x, y, cz);
  for (let index = 0; index < corners.length; index += 1) {
    const [ax, ay, az] = corners[index]!;
    const [bx, by, bz] = corners[(index + 1) % corners.length]!;
    points.push(ax, ay, az, bx, by, bz);
  }
  return points;
}

/** 焦距 / 传感器 / 出片画幅这三个决定取景范围的输入，拼成一个比对用的记账串。 */
function frustumKey(camera: PrevizCamera, aspect: OutputAspect): string {
  return `${camera.focalMm}|${camera.sensor}|${aspect}`;
}

function makeFrustum(
  three: ThreeModule,
  camera: PrevizCamera,
  aspect: OutputAspect,
): THREE.BufferGeometry {
  const points = frustumWireframe(
    camera.focalMm,
    camera.sensor,
    aspect,
    PREVIZ_CAMERA_FRUSTUM_DISTANCE,
  );
  const geometry = new three.BufferGeometry();
  geometry.setAttribute('position', new three.Float32BufferAttribute(points, 3));
  return geometry;
}

/**
 * 建一件机身零件。
 *
 * 每件都自己记一份本色：`sceneGraph` 的显示模式从「全灰」切回来时就地读它。把颜色
 * 记在父节点上是行不通的——一台机位有五件不同颜色的实体，父节点上只放得下一个。
 */
function addPart(
  three: ThreeModule,
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  color: number,
  position: [number, number, number],
): THREE.Mesh {
  const material = new three.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 });
  const mesh = new three.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.previzPlaceholder = true;
  mesh.userData.previzPlaceholderColor = color;
  parent.add(mesh);
  return mesh;
}

/** 建一台机位的可视模型。整台都在原点后方（+Z），镜头口正对原点，视锥从那里张开。 */
export function buildCameraModel(
  three: ThreeModule,
  camera: PrevizCamera,
  aspect: OutputAspect,
): THREE.Object3D {
  const model = new three.Group();
  // 场景图按 `previzPlaceholder` 找占位体来删；机位模型也是占位体的一种。
  model.userData.previzPlaceholder = true;
  model.userData.previzCameraModel = true;

  const hoodZ = HOOD_LENGTH / 2;
  const barrelZ = HOOD_LENGTH + BARREL_LENGTH / 2;
  const bodyZ = HOOD_LENGTH + BARREL_LENGTH + BODY_LENGTH / 2;

  // 遮光罩比镜头筒粗一圈、颜色浅一档，机头朝哪一眼可辨——只看方盒子是分不出正反的。
  const hood = addPart(
    three,
    model,
    new three.CylinderGeometry(0.075, 0.068, HOOD_LENGTH, 20),
    PREVIZ_CAMERA_COLOR.hood,
    [0, 0, hoodZ],
  );
  const barrel = addPart(
    three,
    model,
    new three.CylinderGeometry(0.055, 0.055, BARREL_LENGTH, 20),
    PREVIZ_CAMERA_COLOR.barrel,
    [0, 0, barrelZ],
  );
  // three 的圆柱轴默认沿 Y。不转过来的话镜头是竖着插在机身上的。
  hood.rotation.x = Math.PI / 2;
  barrel.rotation.x = Math.PI / 2;

  addPart(
    three,
    model,
    new three.BoxGeometry(0.24, 0.18, BODY_LENGTH),
    PREVIZ_CAMERA_COLOR.body,
    [0, 0, bodyZ],
  );
  // 顶板（取景器那一坨）压在机身上沿，让机位的「上」方向在视口里立得住：横滚之后
  // 光靠一个左右对称的方盒子看不出机器翻了多少度。
  addPart(
    three,
    model,
    new three.BoxGeometry(0.13, 0.045, 0.17),
    PREVIZ_CAMERA_COLOR.shell,
    [0, 0.1125, bodyZ - 0.03],
  );
  addPart(
    three,
    model,
    new three.BoxGeometry(0.21, 0.155, 0.035),
    PREVIZ_CAMERA_COLOR.shell,
    [0, 0, bodyZ + BODY_LENGTH / 2 - 0.0175],
  );

  const frustum = new three.LineSegments(
    makeFrustum(three, camera, aspect),
    new three.LineBasicMaterial({ color: PREVIZ_CAMERA_COLOR.frustum }),
  );
  frustum.userData.previzPlaceholder = true;
  frustum.userData.previzPlaceholderColor = PREVIZ_CAMERA_COLOR.frustum;
  frustum.userData.previzCameraFrustum = true;
  frustum.userData.previzFrustumKey = frustumKey(camera, aspect);
  model.add(frustum);

  return model;
}

/**
 * 焦距 / 传感器 / 出片画幅变了就把视锥重画一遍，返回是否真的重画过。
 *
 * 只在这三个输入真的变了时重建：`sync` 是逐帧调的，白重建一次就是每帧扔掉一份几何体，
 * 拖一次焦距滑杆能攒下几十份。材质不动，所以重建之后不必再补一次显示模式。
 */
export function syncCameraFrustum(
  three: ThreeModule,
  model: THREE.Object3D,
  camera: PrevizCamera,
  aspect: OutputAspect,
): boolean {
  let frustum: THREE.Mesh | undefined;
  model.traverse((object) => {
    if (object.userData.previzCameraFrustum) frustum = object as THREE.Mesh;
  });
  if (!frustum) return false;

  const key = frustumKey(camera, aspect);
  if (frustum.userData.previzFrustumKey === key) return false;
  frustum.geometry.dispose();
  frustum.geometry = makeFrustum(three, camera, aspect);
  frustum.userData.previzFrustumKey = key;
  return true;
}
