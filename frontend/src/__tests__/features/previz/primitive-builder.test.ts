// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  PREVIZ_PRIMITIVE_SHAPES,
  type PrevizPrimitiveShape,
} from "@/features/previz/domain/primitives";
import { buildPrimitive } from "@/features/previz/engine/primitiveBuilder";
import { KIND_COLOR } from "@/features/previz/engine/sceneGraph";

/**
 * 用真 three：面数、包围盒、法线朝向都得是 three 真算出来的，假 three 只会把前提烤进去。
 */
const SHAPES = Object.keys(PREVIZ_PRIMITIVE_SHAPES) as PrevizPrimitiveShape[];

function meshOf(root: THREE.Object3D): THREE.Mesh {
  // 与 GLB 的 `scene` 同形：一个 Group 包着模型。
  expect(root).toBeInstanceOf(THREE.Group);
  expect(root.children).toHaveLength(1);
  return root.children[0] as THREE.Mesh;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  const index = geometry.getIndex();
  return (index ? index.count : geometry.getAttribute("position").count) / 3;
}

describe.each(SHAPES)("buildPrimitive(%s)", (shape) => {
  it("has exactly the triangle count the catalogue advertises", () => {
    expect(triangleCount(meshOf(buildPrimitive(THREE, shape)).geometry)).toBe(
      PREVIZ_PRIMITIVE_SHAPES[shape].triangles,
    );
  });

  // 落地、居中、1 m：占位方块换成模型时不跳位，单位换算也一个都不动它。
  it("stands on its own origin, centred, with a 1 m longest side", () => {
    const box = new THREE.Box3().setFromObject(buildPrimitive(THREE, shape));
    const size = box.getSize(new THREE.Vector3());

    expect(box.min.y).toBeCloseTo(0, 6);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 6);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 6);
    expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(1, 6);
  });

  it("wears a standard material in the prop colour", () => {
    const material = meshOf(buildPrimitive(THREE, shape)).material;

    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((material as THREE.MeshStandardMaterial).color.getHex()).toBe(KIND_COLOR.prop);
  });
});

describe("primitive orientation", () => {
  it("lays the plane flat, facing up", () => {
    const geometry = meshOf(buildPrimitive(THREE, "plane")).geometry;
    const box = new THREE.Box3().setFromBufferAttribute(
      geometry.getAttribute("position") as THREE.BufferAttribute,
    );

    expect(box.max.y - box.min.y).toBeCloseTo(0, 6);
    expect(geometry.getAttribute("normal").getY(0)).toBeCloseTo(1, 6);
  });

  it("lays the torus flat: 1 m across, 0.2 m tall", () => {
    const size = new THREE.Box3()
      .setFromObject(buildPrimitive(THREE, "torus"))
      .getSize(new THREE.Vector3());

    expect(size.x).toBeCloseTo(1, 6);
    expect(size.z).toBeCloseTo(1, 6);
    expect(size.y).toBeCloseTo(0.2, 6);
  });

  // 楔形是手写顶点：绕序写反一个面，那个面的法线就朝里，白模下会黑一块。
  it("winds every wedge face outwards", () => {
    const geometry = meshOf(buildPrimitive(THREE, "wedge")).geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    // 直角三棱柱的体心：底面 1×1、背面竖直，截面三角形的重心在 (y, z) = (1/3, -1/6)。
    const centroid = new THREE.Vector3(0, 1 / 3, -1 / 6);

    for (let i = 0; i < position.count; i += 3) {
      const faceCentre = new THREE.Vector3(
        (position.getX(i) + position.getX(i + 1) + position.getX(i + 2)) / 3,
        (position.getY(i) + position.getY(i + 1) + position.getY(i + 2)) / 3,
        (position.getZ(i) + position.getZ(i + 1) + position.getZ(i + 2)) / 3,
      );
      const outward = faceCentre.sub(centroid);
      const faceNormal = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
      expect(outward.dot(faceNormal), `face ${i / 3}`).toBeGreaterThan(0);
    }
  });
});
