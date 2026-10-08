// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import type { PrevizBlockoutTone } from '../domain/blockout';
import type { PrevizPrimitiveShape } from '../domain/primitives';
import { propToneColor, type ThreeModule } from './sceneGraph';

/**
 * 按形状名现造一件基础几何体，交给 `PropLoader` 当「加载回来的模型」用。
 *
 * three 由调用方传入（渲染器那份动态 import 的模块），本文件只 import 它的类型：静态
 * import 一次 three 的实现，就会把整个库拖进首屏包。
 *
 * 尺寸与分段数只写在这里；面数写在 `domain/primitives.ts` 的清单里，两边是否一致由
 * `primitive-builder.test.ts` 拿真 three 核对。改分段数时两边一起改。
 *
 * `tone` 是白模物件的明暗档，手摆的道具为 null。
 */
export function buildPrimitive(
  three: ThreeModule,
  shape: PrevizPrimitiveShape,
  tone: PrevizBlockoutTone | null = null,
): THREE.Group {
  const mesh = new three.Mesh(
    primitiveGeometry(three, shape),
    // 与占位方块同色：模型换进来时颜色不跳，用户认得出这还是「那件物件」。
    new three.MeshStandardMaterial({ color: propToneColor(tone) }),
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
    // 以下各件只管比例，尺寸与落地统一交给 `standOnOrigin`：像正四面体、三棱柱这类底面
    // 不以原点对称的形状，手算偏移容易错，量一遍包围盒再挪最稳。
    case 'cuboid':
      return standOnOrigin(new three.BoxGeometry(1, 0.5, 0.5));
    case 'roundedBox':
      return standOnOrigin(roundedBoxGeometry(three, 0.12, 4));
    case 'hemisphere':
      return standOnOrigin(
        mergeGeometries(three, [
          new three.SphereGeometry(0.5, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2),
          // CircleGeometry 默认朝 +Z；转到朝下当底面。
          new three.CircleGeometry(0.5, 24).rotateX(Math.PI / 2),
        ]),
      );
    case 'ellipsoid':
      return standOnOrigin(new three.SphereGeometry(0.5, 24, 16).scale(1, 0.6, 0.6));
    case 'tube':
      return standOnOrigin(extrudeUp(three, ringShape(three, 0.5, 0.32), 1));
    case 'disc':
      return standOnOrigin(new three.CylinderGeometry(0.5, 0.5, 0.05, 32));
    case 'frustum':
      return standOnOrigin(new three.CylinderGeometry(0.3, 0.5, 1, 24));
    // 棱柱、棱锥一类转成非索引再算法线：three 的圆柱在相邻侧面间共用顶点，法线被平均后
    // 棱角会被抹圆，四棱锥看着像个圆锥。
    case 'pyramid':
      // 外接圆半径 √½ → 底边 1；thetaStart = π/4：底边与 X/Z 轴平行，而不是菱形朝前。
      return standOnOrigin(
        faceted(new three.ConeGeometry(Math.SQRT1_2, 1, 4, 1, false, Math.PI / 4)),
      );
    case 'squareFrustum':
      return standOnOrigin(
        faceted(
          new three.CylinderGeometry(Math.SQRT1_2 / 2, Math.SQRT1_2, 0.6, 4, 1, false, Math.PI / 4),
        ),
      );
    case 'bipyramid':
      // 两只开口圆锥底对底：各自保留自己的法线，腰线那一圈是硬棱。
      return standOnOrigin(
        mergeGeometries(three, [
          new three.ConeGeometry(0.5, 0.5, 24, 1, true).translate(0, 0.25, 0),
          new three.ConeGeometry(0.5, 0.5, 24, 1, true).rotateX(Math.PI).translate(0, -0.25, 0),
        ]),
      );
    case 'triangularPrism':
      return standOnOrigin(faceted(new three.CylinderGeometry(0.5, 0.5, 1, 3)));
    case 'hexagonalPrism':
      return standOnOrigin(faceted(new three.CylinderGeometry(0.5, 0.5, 1, 6)));
    case 'octagonalPrism':
      return standOnOrigin(faceted(new three.CylinderGeometry(0.5, 0.5, 1, 8)));
    case 'starPrism':
      return standOnOrigin(extrudeUp(three, starShape(three, 5, 0.5, 0.22), 1));
    case 'tetrahedron':
      // 用三棱锥造而不是 TetrahedronGeometry：后者默认顶点朝上、立不住。
      return standOnOrigin(faceted(new three.ConeGeometry(1, Math.sqrt(2), 3)));
    // 正多面体自带非索引 + 逐面法线，不用再 faceted。
    case 'octahedron':
      return standOnOrigin(new three.OctahedronGeometry(0.5));
    case 'icosahedron':
      return standOnOrigin(new three.IcosahedronGeometry(0.5));
  }
}

/** 等比缩放到最长边 1 m，再挪成底面贴地、XZ 以原点居中。 */
function standOnOrigin(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const scale = 1 / Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  return geometry.scale(scale, scale, scale);
}

function faceted(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

/**
 * 把几件几何体的位置与法线首尾拼成一件。只拼这两样：物件用纯色材质，用不上 uv。
 * 不用 three 的 `BufferGeometryUtils.mergeGeometries`：它在 examples 里，要多一次动态 import。
 */
function mergeGeometries(
  three: ThreeModule,
  parts: readonly THREE.BufferGeometry[],
): THREE.BufferGeometry {
  const flat = parts.map((part) => (part.index ? part.toNonIndexed() : part));
  const merged = new three.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arrays = flat.map((part) => part.getAttribute(name).array as ArrayLike<number>);
    const out = new Float32Array(arrays.reduce((sum, array) => sum + array.length, 0));
    let offset = 0;
    for (const array of arrays) {
      out.set(array, offset);
      offset += array.length;
    }
    merged.setAttribute(name, new three.Float32BufferAttribute(out, 3));
  }
  return merged;
}

/** 把 XY 平面上的截面沿 +Y 拉出 `height`（ExtrudeGeometry 默认沿 +Z 拉）。 */
function extrudeUp(three: ThreeModule, shape: THREE.Shape, height: number): THREE.BufferGeometry {
  return new three.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 12 })
    .rotateX(-Math.PI / 2);
}

function ringShape(three: ThreeModule, outer: number, inner: number): THREE.Shape {
  const shape = new three.Shape().absarc(0, 0, outer, 0, Math.PI * 2, false);
  // 洞的绕向与外轮廓相反，ExtrudeGeometry 才把它当洞挖掉。
  shape.holes.push(new three.Path().absarc(0, 0, inner, 0, Math.PI * 2, true));
  return shape;
}

function starShape(three: ThreeModule, points: number, outer: number, inner: number): THREE.Shape {
  const shape = new three.Shape();
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    // 从正上方起笔：星尖朝 +Y，拉伸并放倒后朝 -Z（朝前）。
    const angle = Math.PI / 2 + (i * Math.PI) / points;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

/**
 * 边长 1、倒角半径 `radius` 的圆角方体，每段圆弧 `arcSegments` 段。
 *
 * 做法与 three examples 的 RoundedBoxGeometry 同源：先造一个每轴 `2 × arcSegments + 1`
 * 段的方体，把每个顶点往「内缩方体」上钳一下，再沿钳出来的方向推出去 `radius`。
 * 格点事先按 tan 重排，推出去后圆弧上各段张角相等；法线就是那个推出方向，棱上是光滑的。
 */
function roundedBoxGeometry(
  three: ThreeModule,
  radius: number,
  arcSegments: number,
): THREE.BufferGeometry {
  const segments = arcSegments * 2 + 1;
  const half = 0.5;
  const inner = half - radius;
  const geometry = new three.BoxGeometry(1, 1, 1, segments, segments, segments);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  // 格点序号 → 推出前的坐标。两头各 arcSegments 段落在倒角里，正中一段是平面。
  const remap = (value: number): number => {
    const index = Math.round((value + half) * segments);
    const fromEdge = Math.min(index, segments - index);
    // 离棱 fromEdge 格：张角从 π/4（棱线，推出去正好 ±0.5）线性降到 0（倒角与平面交界）。
    const offset = radius * Math.tan(((arcSegments - fromEdge) / arcSegments) * (Math.PI / 4));
    return Math.sign(value) * (inner + offset);
  };
  const vertex = new three.Vector3();
  const core = new three.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    vertex.set(remap(position.getX(i)), remap(position.getY(i)), remap(position.getZ(i)));
    core.set(
      Math.max(-inner, Math.min(inner, vertex.x)),
      Math.max(-inner, Math.min(inner, vertex.y)),
      Math.max(-inner, Math.min(inner, vertex.z)),
    );
    const direction = vertex.sub(core).normalize();
    normal.setXYZ(i, direction.x, direction.y, direction.z);
    position.setXYZ(
      i,
      core.x + direction.x * radius,
      core.y + direction.y * radius,
      core.z + direction.z * radius,
    );
  }
  return geometry;
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
