// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import { createDefaultScene, type PrevizScene, type Vec3 } from '@/features/previz/domain/scene';
import { buildPrimitive } from '@/features/previz/engine/primitiveBuilder';
import { PropLoader } from '@/features/previz/engine/propLoader';
import { PrevizSceneGraph } from '@/features/previz/engine/sceneGraph';

/**
 * 这一份用**真 three**，是这个特性里唯一一份。
 *
 * `previz-renderer-scene.test.ts` 里量落地范围的那五条用例跑在一份假 three 上，而那份假
 * `Box3.setFromObject()` 是这么写的：取 `object.getWorldPosition()`，再往两边各推一米。
 * 换句话说，它把「模型确实挂在这个节点下面、跟着这个节点的位置走」当成前提**烤了进去**
 * ——而那正是 `propFootprints()` 唯一真正依赖的一条性质。真把模型挂错父节点（挂到
 * `objectRoot` 上、或者中间多包一层被摆过位置的 Group），或者哪天给导入模型加一步
 * 「归一化到原点」，那五条用例一条都不会红，选位图上却会给每件道具画一块位置错的地。
 *
 * 所以这里不碰渲染器（`WebGLRenderer` 在 jsdom 里建不出来），只把场景图接上真 three 和
 * 一个交出真 `Object3D` 的加载器，然后照 `PrevizRenderer.propFootprints()` 的原样量一次
 * `new Box3().setFromObject(node)`——包括**不**先手动刷世界矩阵：那句依赖的是
 * `Box3.expandByObject()` 内部那次 `updateWorldMatrix(false, true)`，这条隐含契约值得被
 * 钉住，three 哪天改了这里会红。
 */

/** 一份「加载回来的 GLB」：1 m 见方、脚底贴自身原点，枢轴故意不在几何中心。 */
function loadedModel(): THREE.Object3D {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.position.set(0, 0.5, 0);
  group.add(mesh);
  return group;
}

/** 项目的 lib 目标在 es2022 以下，`Array.prototype.at` 用不了。 */
function lastOf<T>(items: T[]): T {
  return items[items.length - 1]!;
}

function propScene(position: Vec3, assetUrl: string | null): PrevizScene {
  const scene = createDefaultScene();
  scene.objects.push(
    createPrevizObject('prop', scene.objects, {
      transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
      ...(assetUrl ? { assetUrl, assetFormat: 'glb' as const } : {}),
    }),
  );
  return scene;
}

function graphWithLoader(): { graph: PrevizSceneGraph; root: THREE.Object3D } {
  const root = new THREE.Group();
  const graph = new PrevizSceneGraph(THREE, root);
  graph.attachPropLoader(
    new PropLoader({
      loadGltf: async () => ({ scene: loadedModel() }),
      loadObj: async () => new THREE.Group(),
      clone: skeletonClone,
      measure: largestDimension,
      prepareMaterials: bothFaces,
      buildPrimitive: (shape) => buildPrimitive(THREE, shape),
    }),
  );
  return { graph, root };
}

/** 模型是异步换进去的，`load()` 里还隔着一层缓存 Promise，让出两拍才轮得到它。 */
async function settleModelSwap(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 照渲染器注入的那个 `prepareMaterials` 原样改。 */
function bothFaces(node: THREE.Object3D): void {
  node.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (!material) return;
    for (const entry of Array.isArray(material) ? material : [material]) {
      entry.side = THREE.DoubleSide;
    }
  });
}

/** 照渲染器注入给 `PropLoader` 的那个 `measure` 原样量。 */
function largestDimension(node: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(node);
  return Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
}

/** 照 `propFootprints()` 的原样量：不预刷世界矩阵，空盒不兜底。 */
function measure(node: THREE.Object3D): THREE.Box3 {
  return new THREE.Box3().setFromObject(node);
}

describe('道具模型挂在对象节点下面（真 three）', () => {
  it('模型换入之后，节点量出来的地面范围以道具位置为心', async () => {
    const { graph } = graphWithLoader();
    const scene = propScene([3, 0, 2], 'https://example.test/chair.glb');
    const propId = lastOf(scene.objects).id;

    graph.sync(scene);
    await settleModelSwap();

    const node = graph.nodeFor(propId)!;
    // 先确认量的确实是模型而不是占位方块——占位方块也以节点为心，两者在下面那组
    // 断言上是一模一样的，这一条不写的话这个用例在模型根本没换入时照样绿。
    expect(node.children.map((child) => child.userData.previzSharedModel)).toEqual([true]);

    const box = measure(node);
    expect(box.min.x).toBeCloseTo(2.5, 6);
    expect(box.max.x).toBeCloseTo(3.5, 6);
    expect(box.min.z).toBeCloseTo(1.5, 6);
    expect(box.max.z).toBeCloseTo(2.5, 6);
  });

  it('改一次位置，模型跟着搬家', async () => {
    const { graph } = graphWithLoader();
    const scene = propScene([0, 0, 0], 'https://example.test/chair.glb');
    const propId = lastOf(scene.objects).id;

    graph.sync(scene);
    await settleModelSwap();

    // 检查器改坐标走的就是这条路：同一份场景改一个数再 `sync` 一次。
    const moved = structuredClone(scene);
    lastOf(moved.objects).transform.position = [3, 0, 2];
    graph.sync(moved);

    const box = measure(graph.nodeFor(propId)!);
    expect(box.min.x).toBeCloseTo(2.5, 6);
    expect(box.max.x).toBeCloseTo(3.5, 6);
    expect(box.min.z).toBeCloseTo(1.5, 6);
    expect(box.max.z).toBeCloseTo(2.5, 6);
  });

  // 几何体走同一条换入路径，但模型是现造的：这里钉住它同样挂在节点下面、同样贴地，
  // 选位图上给它画的那块地不会错位。
  it('几何体物件的地面范围同样以道具位置为心', async () => {
    const root = new THREE.Group();
    const graph = new PrevizSceneGraph(THREE, root);
    graph.attachPropLoader(
      new PropLoader({
        loadGltf: async () => {
          throw new Error('几何体不该走 GLTF 加载');
        },
        loadObj: async () => {
          throw new Error('几何体不该走 OBJ 加载');
        },
        clone: skeletonClone,
        measure: largestDimension,
        prepareMaterials: bothFaces,
        buildPrimitive: (shape) => buildPrimitive(THREE, shape),
      }),
    );
    const scene = createDefaultScene();
    scene.objects.push(
      createPrevizObject('prop', scene.objects, {
        transform: { position: [3, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
        assetUrl: 'cube',
        assetFormat: 'primitive',
      }),
    );
    const propId = lastOf(scene.objects).id;

    graph.sync(scene);
    await settleModelSwap();

    const node = graph.nodeFor(propId)!;
    expect(node.children.map((child) => child.userData.previzSharedModel)).toEqual([true]);
    const box = measure(node);
    expect(box.min.x).toBeCloseTo(2.5, 6);
    expect(box.max.x).toBeCloseTo(3.5, 6);
    expect(box.min.z).toBeCloseTo(1.5, 6);
    expect(box.max.z).toBeCloseTo(2.5, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(1, 6);
  });

  it('没有模型地址的物件，量到的是占位方块', async () => {
    const { graph } = graphWithLoader();
    const scene = propScene([3, 0, 2], null);
    const propId = lastOf(scene.objects).id;

    graph.sync(scene);
    await settleModelSwap();

    const node = graph.nodeFor(propId)!;
    expect(node.children.map((child) => child.userData.previzPlaceholder)).toEqual([true]);
    // 占位方块同样跟着位置走。选位图上它照样会占一块地——那是对的：主视口里
    // 看得见这个方块，左栏就该有它。
    const box = measure(node);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(3, 6);
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(2, 6);
    expect(box.isEmpty()).toBe(false);
  });
});

/**
 * 带骨架的 GLB（用户拿 Mixamo / Quaternius 的角色当道具摆进来就是这样）在克隆这一步
 * 有一个 three 自己的坑：`Object3D.clone()` 复制 `SkinnedMesh` 时**不重建骨架绑定**，
 * 克隆体的 `skeleton` 仍指向源模型那一具。源模型躺在 `PropLoader` 的缓存里、从来没被
 * 加进场景，它的骨头永远停在世界原点——于是克隆体不管挂到哪个节点下面，蒙皮都按原点
 * 那具骨架解算，人渲染在原点上，`Box3` 也量在原点上。
 *
 * `characterRig.ts` 的 `CharacterRigDeps.clone` 上写着同一条警告，人物那条路已经注入了
 * `SkeletonUtils.clone`；物件这条路当时漏了。
 */
describe('带骨架的道具模型（真 three）', () => {
  /** 一具最小的骨架模型：一根骨头 + 一块整体绑在它上面的蒙皮。 */
  function riggedModel(): THREE.Object3D {
    const group = new THREE.Group();
    const bone = new THREE.Bone();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute(
      'skinIndex',
      new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4),
    );
    geometry.setAttribute(
      'skinWeight',
      new THREE.Float32BufferAttribute(
        Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
        4,
      ),
    );
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
    group.add(bone);
    group.add(mesh);
    mesh.bind(new THREE.Skeleton([bone]));
    group.updateMatrixWorld(true);
    return group;
  }

  it('摆在 (3, 0, 2) 的带骨架道具，量出来的地面范围也在 (3, 2)', async () => {
    const root = new THREE.Group();
    const graph = new PrevizSceneGraph(THREE, root);
    graph.attachPropLoader(
      new PropLoader({
        loadGltf: async () => ({ scene: riggedModel() }),
        loadObj: async () => new THREE.Group(),
        clone: skeletonClone,
        measure: largestDimension,
        prepareMaterials: bothFaces,
        buildPrimitive: (shape) => buildPrimitive(THREE, shape),
      }),
    );

    const scene = propScene([3, 0, 2], 'https://example.test/rigged.glb');
    const propId = lastOf(scene.objects).id;
    graph.sync(scene);
    await settleModelSwap();

    const node = graph.nodeFor(propId)!;
    expect(node.children.map((child) => child.userData.previzSharedModel)).toEqual([true]);

    // 骨头必须在这个节点的子树里。不在，就说明克隆体还绑着缓存里那具骨架——
    // 下面那组数字会跟着错，但先在这里说清楚错在哪。
    let boneInSubtree = false;
    node.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) {
        const bone = (child as THREE.SkinnedMesh).skeleton.bones[0]!;
        node.traverse((inner) => {
          if (inner === bone) boneInSubtree = true;
        });
      }
    });
    expect(boneInSubtree).toBe(true);

    root.updateMatrixWorld(true);
    const box = measure(node);
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(3, 3);
    expect(box.getCenter(new THREE.Vector3()).z).toBeCloseTo(2, 3);
  });
});
