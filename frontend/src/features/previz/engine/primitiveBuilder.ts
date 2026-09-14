// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { PrevizPrimitiveShape } from '../domain/primitives';
import { KIND_COLOR, type ThreeModule } from './sceneGraph';

/**
 * 按形状名现造一件基础几何体，交给 `PropLoader` 当「加载回来的模型」用。
 *
 * three 由调用方传入（渲染器那份动态 import 的模块），本文件只 import 它的类型：静态
 * import 一次 three 的实现，就会把整个库拖进首屏包。
 *
 * 尺寸与分段数只写在这里；面数写在 `domain/primitives.ts` 的清单里，两边是否一致由
 * `primitive-builder.test.ts` 拿真 three 核对。改分段数时两边一起改。
 */
export function buildPrimitive(three: ThreeModule, shape: PrevizPrimitiveShape): THREE.Group {
  const mesh = new three.Mesh(
    primitiveGeometry(three, shape),
    // 与占位方块同色：模型换进来时颜色不跳，用户认得出这还是「那件物件」。
    new three.MeshStandardMaterial({ color: KIND_COLOR.prop }),
  );
  // 包一层 Group，与 GLB 的 `scene` 同形：场景图与落地范围的量法都按「模型根下挂 mesh」写。
  const root = new three.Group();
  root.add(mesh);
  return root;
}

function primitiveGeometry(three: ThreeModule, shape: PrevizPrimitiveShape): THREE.BufferGeometry {
  // three 自带的几何体都以自身中心为原点；统一抬到底面贴地（y 最小值为 0）。
  switch (shape) {
    case 'cube':
      return new three.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    case 'sphere':
      return new three.SphereGeometry(0.5, 24, 16).translate(0, 0.5, 0);
    case 'cylinder':
      return new three.CylinderGeometry(0.5, 0.5, 1, 24).translate(0, 0.5, 0);
    case 'cone':
      return new three.ConeGeometry(0.5, 1, 24).translate(0, 0.5, 0);
    case 'plane':
      // PlaneGeometry 默认立在 XY 平面、朝 +Z；放倒成水平朝上。
      return new three.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    case 'capsule':
      // 半径 0.25 + 中段 0.5 + 半径 0.25 = 总高 1。
      return new three.CapsuleGeometry(0.25, 0.5, 4, 16).translate(0, 0.5, 0);
    case 'wedge':
      return wedgeGeometry(three);
    case 'torus':
      // 主半径 0.4 + 管半径 0.1 = 外径 1；默认环面在 XY 平面，放倒成平放后高 0.2。
      return new three.TorusGeometry(0.4, 0.1, 12, 32).rotateX(-Math.PI / 2).translate(0, 0.1, 0);
  }
}

/**
 * 1 × 1 × 1 的直角三棱柱（斜坡）：背面竖直在 z = -0.5，斜面从背面顶边落到前面底边。
 *
 * 非索引、每个面自带三个顶点：`computeVertexNormals` 在非索引几何体上逐面算法线，
 * 棱角才是硬的；共用顶点的话法线会被平均，斜坡看起来像被抹圆了。绕序一律从外面看逆时针。
 */
const WEDGE_VERTICES = [
  // 底面（朝 -Y）
  -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5,
  -0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5,
  // 背面（朝 -Z）
  -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5,
  -0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 0, -0.5,
  // 斜面（朝 +Y+Z）
  -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, -0.5,
  -0.5, 0, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5,
  // 左侧（朝 -X）
  -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, -0.5,
  // 右侧（朝 +X）
  0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 0, 0.5,
];

function wedgeGeometry(three: ThreeModule): THREE.BufferGeometry {
  const geometry = new three.BufferGeometry();
  geometry.setAttribute('position', new three.Float32BufferAttribute(WEDGE_VERTICES, 3));
  geometry.computeVertexNormals();
  return geometry;
}
