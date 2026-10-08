// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { planBlockoutImport } from "@/features/previz/domain/blockout";
import { horizontalFovDeg } from "@/features/previz/domain/camera";
import { PREVIZ_PRIMITIVE_LIMIT } from "@/features/previz/domain/limits";
import {
  createDefaultScene,
  type PrevizCamera,
  type PrevizObject,
} from "@/features/previz/domain/scene";
import { buildPrimitive } from "@/features/previz/engine/primitiveBuilder";
import { PrevizSceneGraph } from "@/features/previz/engine/sceneGraph";

/**
 * 前后端共用的那份基准。后端的编译器测试断言「这段场景程序编译出来就是 `compiled`」，
 * 这里断言「`compiled` 进了预演台，摆出来的朝向和洞口跟 `expectations` 说的一样」。
 * `expectations` 是照着场景程序手写的，不是编译器算出来的——两边对着同一份手写答案，
 * 坐标系或旋转方向任何一边理解反了都会红。
 *
 * 文件在仓库根的 `tests/` 下，不往前端目录里抄一份：抄一份就有两份会各自漂移的真相。
 * vitest 的工作目录是 `frontend/`。
 */
const GOLDEN_PATH = "../tests/fixtures/previz_blockout/golden.json";

interface Golden {
  expectations: {
    directions: Array<{ object: string; localAxis: number[]; points: number[]; why: string }>;
    gaps: Array<{ wall: string; min: number[]; max: number[]; why: string }>;
    positions: Array<{ object: string; at: number[]; why: string }>;
    solid: Array<{ wall: string; point: number[]; why: string }>;
    horizontalFovDeg: number;
  };
  compiled: {
    objects: Array<{ id: string; kind: string; blockout: { id: string } }>;
    reference_camera_id: string;
    counts: Record<string, number>;
  };
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;

function importGolden() {
  const plan = planBlockoutImport(
    createDefaultScene(),
    { objects: golden.compiled.objects, referenceCameraId: golden.compiled.reference_camera_id },
    "replace",
  );
  if (!plan.ok) throw new Error(`rejected: ${JSON.stringify(plan.rejection)}`);
  const root = new THREE.Group();
  const graph = new PrevizSceneGraph(THREE, root);
  graph.sync(plan.scene);
  root.updateMatrixWorld(true);
  return { plan, graph };
}

function nodeOf(graph: PrevizSceneGraph, id: string): THREE.Object3D {
  const node = graph.nodeFor(id);
  if (!node) throw new Error(`no node for ${id}`);
  return node;
}

/**
 * 基础几何体是 1×1×1、底面落在原点：换到它自己的坐标里，盒子就是
 * |x| <= 0.5、0 <= y <= 1、|z| <= 0.5。
 */
function covers(node: THREE.Object3D, point: THREE.Vector3): boolean {
  const local = node.worldToLocal(point.clone());
  const slack = 1e-6;
  return (
    Math.abs(local.x) <= 0.5 + slack &&
    local.y >= -slack &&
    local.y <= 1 + slack &&
    Math.abs(local.z) <= 0.5 + slack
  );
}

function piecesOf(plan: { scene: { objects: PrevizObject[] } }, wall: string): PrevizObject[] {
  return plan.scene.objects.filter(
    (object) => object.kind === "prop" && object.blockout?.id === wall,
  );
}

describe("previz blockout golden", () => {
  it("imports every compiled object without dropping or renaming any", () => {
    const { plan } = importGolden();

    expect(plan.dropped).toBe(0);
    expect(plan.addedIds).toEqual(golden.compiled.objects.map((object) => object.id));
    expect(plan.referenceCameraId).toBe(golden.compiled.reference_camera_id);
  });

  it("agrees with the backend on how many of each kind there are", () => {
    const { plan } = importGolden();

    const counts: Record<string, number> = {};
    for (const object of plan.scene.objects) counts[object.kind] = (counts[object.kind] ?? 0) + 1;
    expect(counts).toEqual(golden.compiled.counts);
  });

  it.each(golden.expectations.directions)("$object points where the program says: $why", (entry) => {
    const { graph } = importGolden();
    const node = nodeOf(graph, entry.object);

    const direction = new THREE.Vector3(...(entry.localAxis as [number, number, number]))
      .applyQuaternion(node.quaternion)
      .toArray();

    direction.forEach((component, index) => {
      expect(component).toBeCloseTo(entry.points[index], 3);
    });
  });

  it.each(golden.expectations.gaps)("$wall leaves the opening clear: $why", (gap) => {
    const { plan, graph } = importGolden();
    const pieces = piecesOf(plan, gap.wall);
    expect(pieces.length).toBeGreaterThan(1);

    const centre = new THREE.Vector3(
      (gap.min[0] + gap.max[0]) / 2,
      (gap.min[1] + gap.max[1]) / 2,
      (gap.min[2] + gap.max[2]) / 2,
    );
    // 洞口中心落进任何一段墙里都算洞没开出来。
    for (const piece of pieces) {
      expect(covers(nodeOf(graph, piece.id), centre), `${piece.id} covers the opening`).toBe(false);
    }
  });

  // 只查「洞口是空的」不够：墙整个摆错地方时洞口同样是空的。所以洞口四周必须真有墙。
  it.each(golden.expectations.solid)("$wall is solid at $point: $why", (entry) => {
    const { plan, graph } = importGolden();
    const point = new THREE.Vector3(...(entry.point as [number, number, number]));

    const covering = piecesOf(plan, entry.wall).filter((piece) =>
      covers(nodeOf(graph, piece.id), point),
    );

    expect(covering).toHaveLength(1);
  });

  it.each(golden.expectations.positions)("$object stands at $at: $why", (entry) => {
    const { graph } = importGolden();

    nodeOf(graph, entry.object)
      .position.toArray()
      .forEach((component, index) => {
        expect(component).toBeCloseTo(entry.at[index], 3);
      });
  });

  it("gives the reference camera the field of view the program asked for", () => {
    const { plan } = importGolden();
    const camera = plan.scene.objects.find(
      (object) => object.id === plan.referenceCameraId,
    ) as PrevizCamera;

    expect(horizontalFovDeg(camera.focalMm, camera.sensor)).toBeCloseTo(
      golden.expectations.horizontalFovDeg,
      2,
    );
  });

  it("relies on a wedge that rises toward its own -z", () => {
    // `expectations.directions` 里楼梯那一条拿本地 -z 当「升高的方向」。这是对
    // `primitiveBuilder` 的一个假设，钉在这里：哪天楔形体的朝向改了，红的是这一条，
    // 而不是一句看不出原因的「楼梯朝向不对」。
    const wedge = buildPrimitive(THREE, "wedge");
    const position = (wedge.children[0] as THREE.Mesh).geometry.getAttribute("position");

    const top: number[] = [];
    for (let index = 0; index < position.count; index += 1) {
      if (position.getY(index) > 0.99) top.push(position.getZ(index));
    }
    expect(top.length).toBeGreaterThan(0);
    expect(Math.max(...top)).toBeLessThan(0);
  });
});

describe("previz blockout at the primitive limit", () => {
  it("syncs 150 primitives into the scene graph", () => {
    const objects = Array.from({ length: PREVIZ_PRIMITIVE_LIMIT }, (_, index) => ({
      id: `blockout-box_${index}`,
      kind: "prop",
      name: `box ${index}`,
      transform: { position: [index % 15, 0, Math.floor(index / 15)], rotation: [0, 0, 0], scale: [0.5, 0.5, 0.5] },
      visible: true,
      locked: false,
      assetUrl: "cube",
      assetFormat: "primitive",
      blockout: { id: `box_${index}`, semanticType: "prop" },
    }));
    const plan = planBlockoutImport(
      createDefaultScene(),
      { objects, referenceCameraId: null },
      "replace",
    );
    if (!plan.ok) throw new Error(`rejected: ${JSON.stringify(plan.rejection)}`);

    const root = new THREE.Group();
    const graph = new PrevizSceneGraph(THREE, root);
    graph.sync(plan.scene);

    for (const id of plan.addedIds) expect(graph.nodeFor(id)).toBeDefined();
    expect(nodeOf(graph, "blockout-box_149").position.toArray()).toEqual([14, 0, 9]);
  });
});
