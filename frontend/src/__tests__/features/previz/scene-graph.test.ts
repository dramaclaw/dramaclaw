// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import {
  createPrevizObject,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
} from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  PREVIZ_SCALE_RANGE,
  type PrevizCharacter,
  type PrevizProp,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import { CharacterRigFactory } from '@/features/previz/engine/characterRig';
import { PropLoader } from '@/features/previz/engine/propLoader';
import { PrevizSceneGraph } from '@/features/previz/engine/sceneGraph';

/**
 * 一份够用的假 three。真 three 在 jsdom 里连 WebGLRenderer 都建不出来，而这个
 * 模块要测的全是「场景图里现在有哪些节点、它们的变换对不对」这类结构性行为，
 * 用假的反而断言得更准。`PrevizSceneGraph` 把 three 当构造参数收就是为了这个。
 */
function fakeThree() {
  class Vector3 {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }
  class Euler extends Vector3 {}
  class Object3D {
    name = '';
    visible = true;
    userData: Record<string, unknown> = {};
    children: Object3D[] = [];
    parent: Object3D | null = null;
    position = new Vector3();
    rotation = new Euler();
    scale = new Vector3(1, 1, 1);
    add(child: Object3D) {
      child.parent = this;
      this.children.push(child);
      return this;
    }
    remove(child: Object3D) {
      this.children = this.children.filter((entry) => entry !== child);
      child.parent = null;
      return this;
    }
    traverse(callback: (object: Object3D) => void) {
      callback(this);
      for (const child of [...this.children]) child.traverse(callback);
    }
    /**
     * 照着真 three 的语义来：结构深拷贝，**几何体与材质按引用共享**。共享正是
     * `previzSharedModel` 那道 dispose 护栏要挡的东西——假实现里改成深拷贝几何体的话，
     * 「删一个物件把缓存里的源模型一起 dispose 掉」这个 bug 在测试里根本复现不出来。
     */
    clone(): Object3D {
      const copy = this.newInstance();
      copy.name = this.name;
      copy.visible = this.visible;
      copy.userData = { ...this.userData };
      copy.position.set(this.position.x, this.position.y, this.position.z);
      copy.rotation.set(this.rotation.x, this.rotation.y, this.rotation.z);
      copy.scale.set(this.scale.x, this.scale.y, this.scale.z);
      for (const child of this.children) copy.add(child.clone());
      return copy;
    }
    protected newInstance(): Object3D {
      return new Object3D();
    }
  }
  class Group extends Object3D {
    protected override newInstance(): Object3D {
      return new Group();
    }
  }
  class Mesh extends Object3D {
    constructor(
      public geometry: FakeGeometry,
      public material: FakeMaterial,
    ) {
      super();
    }
    protected override newInstance(): Object3D {
      return new Mesh(this.geometry, this.material);
    }
  }
  /**
   * 几何体记下构造实参：占位体的尺寸是本模块的输出之一，不记就断言不到。
   *
   * 四种形状各是一个独立子类，而不是四个名字指向同一个类：形状本身就是本模块的
   * 一句话职责（人物胶囊、机位锥体、灯球、物件方块），共用一个类之后「把 ConeGeometry
   * 写成 BoxGeometry」这类改动在测试里完全看不出来——连 instanceof 都分不开。
   * `shape` 是给断言用的标签，比 instanceof 在这份 `as unknown as` 出来的假模块上好读。
   */
  class FakeGeometry {
    readonly shape: string = 'unknown';
    readonly args: number[];
    dispose = vi.fn();
    constructor(...args: number[]) {
      this.args = args;
    }
  }
  class FakeCapsuleGeometry extends FakeGeometry {
    readonly shape = 'capsule';
  }
  class FakeConeGeometry extends FakeGeometry {
    readonly shape = 'cone';
  }
  class FakeSphereGeometry extends FakeGeometry {
    readonly shape = 'sphere';
  }
  class FakeBoxGeometry extends FakeGeometry {
    readonly shape = 'box';
  }
  class FakeMaterial {
    opacity = 1;
    transparent = false;
    needsUpdate = false;
    color = { set: vi.fn() };
    dispose = vi.fn();
    constructor(public params: Record<string, unknown> = {}) {}
  }
  /**
   * 净高 2 m 的模型。真 `setFromObject()` 量的是**世界**包围盒，根对象自己的 scale
   * 就在它的 matrixWorld 里，所以这份假实现也把 scale 乘进去——恒定尺寸的假盒会让
   * 「重量一次已经缩放过的 rig」这个错误完全测不出来。
   */
  class FakeBox3 {
    min = new Vector3(Infinity, Infinity, Infinity);
    max = new Vector3(-Infinity, -Infinity, -Infinity);
    setFromObject(object: Object3D) {
      this.min.set(-0.3 * object.scale.x, 0, -0.3 * object.scale.z);
      this.max.set(0.3 * object.scale.x, 2 * object.scale.y, 0.3 * object.scale.z);
      return this;
    }
    isEmpty() {
      return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
    }
  }
  /** 姿势采样只要求「能建、能 play、能 setTime」，本文件不断言它，行为归 character-rig 那边。 */
  class FakeAnimationMixer {
    constructor(_root: unknown) {}
    clipAction(_clip: unknown) {
      return { play: () => {} };
    }
    setTime(_time: number) {}
  }

  return {
    Object3D,
    Group,
    Mesh,
    Vector3,
    Euler,
    Box3: FakeBox3,
    AnimationMixer: FakeAnimationMixer,
    CapsuleGeometry: FakeCapsuleGeometry,
    ConeGeometry: FakeConeGeometry,
    SphereGeometry: FakeSphereGeometry,
    BoxGeometry: FakeBoxGeometry,
    MeshStandardMaterial: FakeMaterial,
  } as unknown as typeof import('three');
}

/** 断言用的最小结构视图：假 three 的 Mesh 是 `any` 之外唯一能看清内部的入口。 */
interface FakeMeshView {
  geometry: { shape: string; args: number[]; dispose: ReturnType<typeof vi.fn> };
  material: {
    opacity: number;
    transparent: boolean;
    needsUpdate: boolean;
    color: { set: ReturnType<typeof vi.fn> };
    dispose: ReturnType<typeof vi.fn>;
    params: { color?: number };
  };
  position: { x: number; y: number; z: number };
}

function placeholderOf(graph: PrevizSceneGraph, objectId: string): FakeMeshView {
  const node = graph.nodeFor(objectId);
  if (!node) throw new Error(`no node for ${objectId}`);
  return node.children[0] as unknown as FakeMeshView;
}

/** 材质最后一次被染上的颜色。`Array.prototype.at` 不在本仓的 lib 里，只能按下标取。 */
function lastColour(mesh: FakeMeshView): number | undefined {
  const calls = mesh.material.color.set.mock.calls;
  return calls.length === 0 ? undefined : (calls[calls.length - 1]![0] as number);
}

/** 胶囊总高：中段柱体高度加上两端各一个半球。 */
function capsuleHeight(mesh: FakeMeshView): number {
  const [radius, middle] = mesh.geometry.args;
  return middle! + radius! * 2;
}

/**
 * 一个真的 `CharacterRigFactory`，喂同一份假 three。这里刻意不用手搓的桩：本组用例测的
 * 就是场景图与工厂之间的接线，桩替掉之后工厂改了签名或者语义，这边一条都不会红。
 *
 * `clone` 每次交出一个新的模型根，下面再挂一个带材质的 Mesh——显示模式要刷到模型的
 * 每份材质上，模型根自己是没有材质的。
 */
function rigFactory(three: typeof import('three'), clipNames: string[] = ['Idle_Loop']) {
  const loadGltf = vi.fn(async () => ({
    scene: new three.Object3D(),
    animations: clipNames.map((name) => ({ name })) as unknown as THREE.AnimationClip[],
  }));
  const clone = vi.fn(() => {
    const model = new three.Object3D();
    model.add(new three.Mesh(new three.BoxGeometry(1, 1, 1), new three.MeshStandardMaterial()));
    return model;
  });
  return { factory: new CharacterRigFactory({ three, loadGltf, clone }), loadGltf, clone };
}

/** 排空微任务队列：模型换入走的是一条纯 Promise 链，没有定时器。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 节点下面那个模型根（`build()` 在它身上留了 `previzRig`）。 */
function rigOf(graph: PrevizSceneGraph, objectId: string): THREE.Object3D | undefined {
  return graph.nodeFor(objectId)?.children.find((child) => child.userData.previzRig);
}

/**
 * 一个真的 `PropLoader`，喂同一份假 three 建出来的源模型。同 `rigFactory`：接线是本组
 * 用例的被测对象，桩替掉之后加载器改了语义这边一条都不会红。
 *
 * 源模型下面挂一个带几何体与材质的 Mesh——`clone()` 是浅克隆这两样，共享正是那道
 * dispose 护栏要挡的东西。
 */
function propLoaderWith(three: typeof import('three')) {
  const source = new three.Object3D();
  const sourceMesh = new three.Mesh(
    new three.BoxGeometry(1, 1, 1),
    new three.MeshStandardMaterial(),
  );
  source.add(sourceMesh);
  const loadGltf = vi.fn(async () => ({ scene: source }));
  const loadObj = vi.fn(async () => source);
  return {
    loader: new PropLoader({ loadGltf, loadObj }),
    loadGltf,
    loadObj,
    sourceMesh: sourceMesh as unknown as FakeMeshView,
  };
}

/** 节点下面那个共享模型根（两条加载路径都在它身上留了 `previzSharedModel`）。 */
function sharedModelOf(graph: PrevizSceneGraph, objectId: string): THREE.Object3D | undefined {
  return graph.nodeFor(objectId)?.children.find((child) => child.userData.previzSharedModel);
}

function propScene(overrides: Partial<PrevizProp> = {}): PrevizScene {
  const scene = createDefaultScene();
  const prop = createPrevizObject('prop', scene.objects);
  scene.objects.push({ ...prop, assetUrl: '/uploads/chair.glb', assetFormat: 'glb', ...overrides });
  return scene;
}

function characterScene(overrides: Partial<PrevizCharacter> = {}): PrevizScene {
  const scene = createDefaultScene();
  const character = createPrevizObject('character', scene.objects);
  scene.objects.push({ ...character, ...overrides });
  return scene;
}

function sceneWith(...kinds: Array<'character' | 'camera' | 'light' | 'prop'>): PrevizScene {
  const scene = createDefaultScene();
  for (const kind of kinds) {
    scene.objects.push(createPrevizObject(kind, scene.objects));
  }
  return scene;
}

describe('PrevizSceneGraph', () => {
  it('creates one root node per object, keyed by object id', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'camera');
    graph.sync(scene);

    expect(root.children).toHaveLength(2);
    expect(graph.nodeFor(scene.objects[0]!.id)).toBeDefined();
    expect(graph.nodeFor(scene.objects[1]!.id)).toBeDefined();
    // 节点要认得回自己是哪个对象：手柄拖拽（Task 11）从射线命中的节点反查 id 就靠它。
    expect(graph.nodeFor(scene.objects[0]!.id)?.userData.previzObjectId).toBe(scene.objects[0]!.id);
    expect(graph.nodeFor(scene.objects[1]!.id)?.userData.previzKind).toBe('camera');

    // 名字与锁定态也要镜到节点上：名字是 three 侧唯一的可读标识（调试与 Task 11 的
    // 命中提示都读它），锁定态是手柄拒绝拖拽的依据。两者都得跟着对象改。
    graph.sync({
      ...scene,
      objects: [{ ...scene.objects[0]!, name: '主角', locked: true }, scene.objects[1]!],
    });
    expect(graph.nodeFor(scene.objects[0]!.id)?.name).toBe('主角');
    expect(graph.nodeFor(scene.objects[0]!.id)?.userData.previzLocked).toBe(true);
    expect(graph.nodeFor(scene.objects[1]!.id)?.userData.previzLocked).toBe(false);
    // 锁定只挡手柄，不挡渲染。两个标志在这里必须分开断言：把 `visible` 写成
    // `visible && !locked`，锁住的灯就从画面上消失了，而只测 `visible` 的那条用例
    // 里对象从来没被锁过，一条都不会红。
    expect(graph.nodeFor(scene.objects[0]!.id)?.visible).toBe(true);
  });

  it('reuses the existing node when only the transform changed', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    graph.sync(scene);
    const node = graph.nodeFor(scene.objects[0]!.id);

    const moved: PrevizScene = {
      ...scene,
      objects: [
        {
          ...scene.objects[0]!,
          transform: { position: [1, 2, 3], rotation: [0, 90, 0], scale: [2, 2, 2] },
        },
      ],
    };
    graph.sync(moved);

    // 同一个节点对象：每帧重建会让 Task 8 加载好的 GLB 白扔一次又重下一次。
    expect(root.children).toHaveLength(1);
    expect(graph.nodeFor(scene.objects[0]!.id)).toBe(node);
    expect(node?.position).toMatchObject({ x: 1, y: 2, z: 3 });
    // 场景里存的是度，three 的 Euler 收弧度。
    expect(node?.rotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(node?.scale).toMatchObject({ x: 2, y: 2, z: 2 });
  });

  it('falls back to zero for non-finite position and rotation components', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    graph.sync({
      ...scene,
      objects: [
        {
          ...scene.objects[0]!,
          transform: {
            position: [Number.NaN, 2, Number.POSITIVE_INFINITY],
            rotation: [Number.NaN, 90, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    });

    // NaN 进了变换矩阵之后整棵子树的世界矩阵都是 NaN，物体从画面上凭空消失，
    // 而 three 一声不吭。脏值到这里就得停下。
    const node = graph.nodeFor(scene.objects[0]!.id);
    expect(node?.position).toMatchObject({ x: 0, y: 2, z: 0 });
    expect(node?.rotation.x).toBe(0);
    expect(node?.rotation.y).toBeCloseTo(Math.PI / 2, 6);
  });

  it('clamps scale into the domain range', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    graph.sync({
      ...scene,
      objects: [
        {
          ...scene.objects[0]!,
          transform: {
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [0, -3, Number.NaN],
          },
        },
      ],
    });

    // 零与负缩放压出退化几何（法线全零、包围盒没厚度），取景距离跟着算不出来；
    // 预演台里凡是有现成区间常量的字段都走 `clampToRange`，这里复用的就是它。
    const node = graph.nodeFor(scene.objects[0]!.id);
    expect(node?.scale.x).toBe(PREVIZ_SCALE_RANGE.min);
    expect(node?.scale.y).toBe(PREVIZ_SCALE_RANGE.min);
    // 非有限值回落到默认值而不是边界值，与 `clampToRange` 的约定一致。
    expect(node?.scale.z).toBe(PREVIZ_SCALE_RANGE.default);
  });

  it('gives each kind its own placeholder shape at a readable size', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'camera', 'light', 'prop');
    graph.sync(scene);
    const [character, camera, light, prop] = scene.objects.map((object) =>
      placeholderOf(graph, object.id),
    );

    // 「人物是胶囊、机位是锥体、灯是小球、物件是方块」是本模块的一句话职责。
    // 形状互换任意两个，画面上就分不出谁是谁了，而所有尺寸断言一条都不会红。
    expect(character!.geometry.shape).toBe('capsule');
    expect(camera!.geometry.shape).toBe('cone');
    expect(light!.geometry.shape).toBe('sphere');
    expect(prop!.geometry.shape).toBe('box');

    // 胶囊的分段数：radialSegments 太少就不是个圆柱而是根三棱柱，一眼穿帮。
    // CapsuleGeometry(radius, height, capSegments, radialSegments)。
    expect(character!.geometry.args[2]).toBeGreaterThanOrEqual(4);
    expect(character!.geometry.args[3]).toBeGreaterThanOrEqual(8);

    // 机位是个小四棱锥（radialSegments = 4），比人物矮一大截才不喧宾夺主：
    // 半径 0.16 m、高 0.42 m 的量级。ConeGeometry(radius, height, radialSegments)。
    const cone = camera!.geometry.args;
    expect(cone[0]).toBeGreaterThan(0);
    expect(cone[0]).toBeLessThan(0.3);
    expect(cone[1]).toBeGreaterThan(cone[0]!);
    expect(cone[1]).toBeLessThan(1);
    expect(cone[2]).toBe(4);

    // 灯是个更小的球，物件是个 0.6 m 见方的盒子——都在「人一眼扫过去认得出」的量级。
    // 球同样要够圆：SphereGeometry(radius, widthSegments, heightSegments)，段数掉到个位数
    // 就成了个多面体疙瘩，而上面那两条尺寸断言照样绿。
    expect(light!.geometry.args[0]).toBeGreaterThan(0);
    expect(light!.geometry.args[0]).toBeLessThan(0.3);
    expect(light!.geometry.args[1]).toBeGreaterThanOrEqual(8);
    expect(light!.geometry.args[2]).toBeGreaterThanOrEqual(6);
    expect(prop!.geometry.args.slice(0, 3)).toEqual([0.6, 0.6, 0.6]);

    // 四类的分类色必须两两不同。形状之外这是第二条辨认线索，也正是 clay 模式回程
    // 要还原的那份映射；把机位改成和灯一个色，上面所有形状与尺寸断言一条都不会红。
    const colours = [character!, camera!, light!, prop!].map((mesh) => mesh.material.params.color);
    expect(new Set(colours).size).toBe(4);
  });

  it('sizes the character capsule from heightCm and stands it on the ground', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character');
    const character = scene.objects[0]!;
    if (character.kind !== 'character') throw new Error('expected a character');
    graph.sync({ ...scene, objects: [{ ...character, heightCm: 180 }] });

    const mesh = placeholderOf(graph, character.id);
    // 半径同样写字面量：它是 `PrevizRenderer` 的聚焦包围盒也在用的那条尺寸约束
    // （见 `PREVIZ_PLACEHOLDER_RADIUS` 的注释），从被测模块 import 回来就锁不住了。
    expect(mesh.geometry.args[0]).toBeCloseTo(0.22, 6);
    // 断言的是性质而不是实现里那个式子：CapsuleGeometry(radius, height, …) 的第二参数
    // 是两个半球之间那段柱体的高度（three 0.185 的形参名就叫 height），胶囊总高是它
    // 加上两个半径——总高必须正好是身高，1.8 是这条用例自己给的输入，不是算出来的。
    expect(capsuleHeight(mesh)).toBeCloseTo(1.8, 6);
    // 胶囊自身以原点为中心，抬高半个身高才让脚底落在 y=0 的地面网格上。
    expect(mesh.position.y).toBeCloseTo(0.9, 6);
  });

  it('clamps heightCm so the capsule never degenerates', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'character');
    const [tall, tiny] = scene.objects;
    if (tall?.kind !== 'character' || tiny?.kind !== 'character') {
      throw new Error('expected characters');
    }
    graph.sync({
      ...scene,
      objects: [
        { ...tall, heightCm: 1e9 },
        { ...tiny, heightCm: 0 },
      ],
    });

    const tallMesh = placeholderOf(graph, tall.id);
    const tinyMesh = placeholderOf(graph, tiny.id);
    expect(capsuleHeight(tallMesh)).toBeCloseTo(PREVIZ_MAX_HEIGHT_CM / 100, 6);
    expect(capsuleHeight(tinyMesh)).toBeCloseTo(PREVIZ_MIN_HEIGHT_CM / 100, 6);
    // 夹到下界之后中段柱体仍然为正，`createPlaceholder` 不必再自己兜一次 Math.max(0, …)。
    expect(tinyMesh.geometry.args[1]).toBeGreaterThan(0);
  });

  it('rebuilds the capsule when heightCm changes, and returns the old resources', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character');
    const character = scene.objects[0]!;
    if (character.kind !== 'character') throw new Error('expected a character');
    graph.sync({ ...scene, objects: [{ ...character, heightCm: 150 }] });
    const node = graph.nodeFor(character.id);
    const before = placeholderOf(graph, character.id);
    expect(capsuleHeight(before)).toBeCloseTo(1.5, 6);

    graph.sync({ ...scene, objects: [{ ...character, heightCm: 200 }] });

    // 身高是唯一一个能改变占位几何的用户输入，而属性面板的滑杆直接接在它上面。
    // 几何体建好就不会自己跟着变：少了重建，拖完滑杆得到的是一个还停在旧身高的胶囊，
    // 而且它不会在下一次 sync 时自愈——只有整个节点被拆掉才会。
    const after = placeholderOf(graph, character.id);
    expect(capsuleHeight(after)).toBeCloseTo(2, 6);
    // 站位跟着一起改，否则那个尺寸错的胶囊还悬空或者陷进地里。
    expect(after.position.y).toBeCloseTo(1, 6);
    // 换的是占位体不是整个节点：节点上挂着 Task 8 加载好的 GLB，重建等于白下一次。
    expect(root.children).toHaveLength(1);
    expect(graph.nodeFor(character.id)).toBe(node);
    expect(node?.children).toHaveLength(1);
    // 换下来的那一对必须还掉，不然拖一次滑杆就按帧泄漏一个几何体加一份材质。
    expect(before.geometry.dispose).toHaveBeenCalled();
    expect(before.material.dispose).toHaveBeenCalled();
    // 而新建的这一对当然不能跟着一起还。
    expect(after.geometry.dispose).not.toHaveBeenCalled();
    expect(after.material.dispose).not.toHaveBeenCalled();
  });

  it('leaves the capsule alone when heightCm did not change', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character');
    const character = scene.objects[0]!;
    if (character.kind !== 'character') throw new Error('expected a character');
    const posed = { ...character, heightCm: 180 };
    graph.sync({ ...scene, objects: [posed] });
    const mesh = placeholderOf(graph, character.id);

    graph.sync({
      ...scene,
      objects: [
        { ...posed, transform: { position: [1, 0, 2], rotation: [0, 45, 0], scale: [1, 1, 1] } },
      ],
    });

    // 无条件重建就是每帧扔掉一对 geometry / material 再建一对——身高之外胶囊的输入
    // （半径、分段数）全是常量，拆了也建回同一个东西。
    expect(placeholderOf(graph, character.id)).toBe(mesh);
    expect(mesh.geometry.dispose).not.toHaveBeenCalled();

    // 比的是夹取之后的身高：两个都超上界的值算出来是同一个胶囊，不该拆了重建。
    graph.sync({ ...scene, objects: [{ ...posed, heightCm: 1e9 }] });
    const clamped = placeholderOf(graph, character.id);
    expect(capsuleHeight(clamped)).toBeCloseTo(PREVIZ_MAX_HEIGHT_CM / 100, 6);
    graph.sync({ ...scene, objects: [{ ...posed, heightCm: 1e10 }] });
    expect(placeholderOf(graph, character.id)).toBe(clamped);
  });

  it('gives the rebuilt capsule the display mode that is already in force', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character');
    const character = scene.objects[0]!;
    if (character.kind !== 'character') throw new Error('expected a character');
    const translucent = { ...scene.settings, displayMode: 'translucent' as const };
    graph.sync({ ...scene, settings: translucent, objects: [{ ...character, heightCm: 150 }] });
    graph.sync({ ...scene, settings: translucent, objects: [{ ...character, heightCm: 200 }] });

    // 新材质是按「实心」建出来的，而显示模式这一帧没变——不给它补一次，拖一次身高
    // 滑杆就能在半透明场景里留下一个实心的人。
    const rebuilt = placeholderOf(graph, character.id);
    expect(rebuilt.material.transparent).toBe(true);
    expect(rebuilt.material.opacity).toBeCloseTo(0.35, 6);
  });

  it('invalidates the shader program only when transparency actually flips', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    const solid = scene.settings;
    graph.sync(scene);
    const mesh = placeholderOf(graph, scene.objects[0]!.id);
    // 刚建出来的材质本来就是实心的，实心模式下不该白让它的着色程序失效一次。
    expect(mesh.material.needsUpdate).toBe(false);

    graph.sync({ ...scene, settings: { ...solid, displayMode: 'translucent' } });
    expect(mesh.material.needsUpdate).toBe(true);

    // Task 8 / Task 9 的每个模型一到位就调一次 `refreshDisplayMode()`，而它遍历整个 root。
    // 无条件置 needsUpdate 的话，N 个模型就是 N 次全场景着色器重编译——three 里最典型的
    // 掉帧来源，而画面上什么都没变。
    mesh.material.needsUpdate = false;
    graph.refreshDisplayMode();
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.needsUpdate).toBe(false);

    // 回到实心是一次真翻转，这一次必须失效。
    graph.sync({ ...scene, settings: { ...solid, displayMode: 'solid' } });
    expect(mesh.material.needsUpdate).toBe(true);

    // 全灰只改颜色。`color` 与 `opacity` 都是 uniform，改了直接生效，不必重编译。
    mesh.material.needsUpdate = false;
    graph.sync({ ...scene, settings: { ...solid, displayMode: 'clay' } });
    expect(mesh.material.color.set).toHaveBeenCalled();
    expect(mesh.material.needsUpdate).toBe(false);
  });

  it('removes nodes for objects that are gone and disposes their resources', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('light', 'prop');
    graph.sync(scene);
    const removedId = scene.objects[0]!.id;
    const mesh = placeholderOf(graph, removedId);

    graph.sync({ ...scene, objects: [scene.objects[1]!] });

    expect(root.children).toHaveLength(1);
    expect(graph.nodeFor(removedId)).toBeUndefined();
    // 不 dispose 就是显存泄漏，而预演台是反复开关的。
    expect(mesh.geometry.dispose).toHaveBeenCalled();
    expect(mesh.material.dispose).toHaveBeenCalled();
    // 留下的那个不能跟着一起还，否则下一帧渲染的是一个已经释放的材质。
    expect(placeholderOf(graph, scene.objects[1]!.id).geometry.dispose).not.toHaveBeenCalled();
  });

  it('mirrors the visible flag', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    graph.sync(scene);
    expect(graph.nodeFor(scene.objects[0]!.id)?.visible).toBe(true);

    graph.sync({ ...scene, objects: [{ ...scene.objects[0]!, visible: false }] });

    expect(graph.nodeFor(scene.objects[0]!.id)?.visible).toBe(false);
  });

  it('applies the display mode to every material', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'prop');
    graph.sync(scene);

    graph.sync({ ...scene, settings: { ...scene.settings, displayMode: 'translucent' } });
    const materials: Array<{ opacity: number; transparent: boolean; needsUpdate: boolean }> = [];
    root.traverse((object) => {
      const mesh = object as unknown as {
        material?: { opacity: number; transparent: boolean; needsUpdate: boolean };
      };
      if (mesh.material) materials.push(mesh.material);
    });

    expect(materials).toHaveLength(2);
    for (const material of materials) {
      expect(material.transparent).toBe(true);
      // 字面量而不是从被测模块 import 的那个常量：0.35 是设计文档「显示模式」一节
      // 定死的值，从实现里读回来的期望值改一处两边一起变，等于什么都没锁。
      expect(material.opacity).toBeCloseTo(0.35, 6);
      // `transparent` 参与 three 的着色程序缓存键（WebGLPrograms 的 opaque 项），
      // 不置 needsUpdate 就还在用旧程序，材质变了画面不变。
      expect(material.needsUpdate).toBe(true);
    }
  });

  it('applies the current display mode to objects added later', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    const translucent: PrevizScene = {
      ...scene,
      settings: { ...scene.settings, displayMode: 'translucent' },
    };
    graph.sync(translucent);

    const grown: PrevizScene = {
      ...translucent,
      objects: [...translucent.objects, createPrevizObject('light', translucent.objects)],
    };
    graph.sync(grown);

    // 显示模式没变，但新对象是这一帧才建出来的：只在模式变化时刷一遍树，
    // 后建的对象就永远停在实心态，画面上一半透明一半不透明。
    const added = placeholderOf(graph, grown.objects[1]!.id);
    expect(added.material.transparent).toBe(true);
    // 同上：0.35 取自设计文档，不从实现里读。
    expect(added.material.opacity).toBeCloseTo(0.35, 6);
  });

  it('re-applies the display mode to a subtree attached after the last sync', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('prop');
    graph.sync({ ...scene, settings: { ...scene.settings, displayMode: 'translucent' } });

    // Task 8 / Task 9 的模型是异步落进同一个节点的，落进来时没经过任何一次 sync。
    const loaded = new three.Mesh(new three.BoxGeometry(1, 1, 1), new three.MeshStandardMaterial());
    graph.nodeFor(scene.objects[0]!.id)!.add(loaded);
    const view = loaded as unknown as FakeMeshView;
    expect(view.material.transparent).toBe(false);

    graph.refreshDisplayMode();

    expect(view.material.transparent).toBe(true);
    expect(view.material.opacity).toBeCloseTo(0.35, 6);
  });

  it('tints everything in clay mode and restores the kind colour on the way back', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'prop');
    graph.sync(scene);
    const character = placeholderOf(graph, scene.objects[0]!.id);
    const prop = placeholderOf(graph, scene.objects[1]!.id);
    // 建材质时的分类色是构造实参，不是一次 set()，所以从 params 读。
    const createdColour = character.material.params.color;
    const createdPropColour = prop.material.params.color;

    graph.sync({ ...scene, settings: { ...scene.settings, displayMode: 'clay' } });
    const clayColour = lastColour(character);
    expect(clayColour).toBe(lastColour(prop));
    // 全灰模式的意义就是抹掉分类色，两类对象染成同一个色才算做到了。
    expect(clayColour).not.toBe(createdColour);
    // 人物与物件本来是两个色，不然上一条断言用哪个对象都无所谓，就白测了。
    expect(createdColour).not.toBe(createdPropColour);

    graph.sync({ ...scene, settings: { ...scene.settings, displayMode: 'solid' } });
    expect(lastColour(character)).toBe(createdColour);
    expect(lastColour(prop)).toBe(createdPropColour);
    // 回程要连半透明一起还掉，不只是颜色。把 transparent 恒设成 true、opacity 恒设成
    // 0.35，上面那几条颜色断言一条都不会红——而后果是 solid 模式下整个场景发虚，
    // 且所有占位体都进 three 的透明渲染队列、按距离排序、丢掉深度写入。
    expect(character.material.transparent).toBe(false);
    expect(character.material.opacity).toBeCloseTo(1, 6);
  });

  it('clears everything on dispose', () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);

    const scene = sceneWith('character', 'camera', 'light', 'prop');
    graph.sync(scene);
    const mesh = placeholderOf(graph, scene.objects[0]!.id);
    graph.dispose();

    expect(root.children).toHaveLength(0);
    expect(graph.nodeFor(scene.objects[0]!.id)).toBeUndefined();
    expect(mesh.geometry.dispose).toHaveBeenCalled();
    expect(mesh.material.dispose).toHaveBeenCalled();
  });
  it('swaps the placeholder capsule for the loaded model, and only loads it once', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const onReady = vi.fn();
    const { factory, loadGltf } = rigFactory(three);
    graph.attachCharacterRig(factory, onReady);

    const scene = characterScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    const node = graph.nodeFor(id);
    const placeholder = placeholderOf(graph, id);
    // 模型是异步来的：这一刻画面上还只有占位胶囊。
    expect(node?.children).toHaveLength(1);

    await flush();

    expect(node?.children).toHaveLength(1);
    expect(rigOf(graph, id)).toBeDefined();
    // 占位胶囊必须摘掉并还资源：留着就是一个人和一个胶囊叠在一起，还按帧漏几何体。
    expect(placeholder.geometry.dispose).toHaveBeenCalled();
    expect(placeholder.material.dispose).toHaveBeenCalled();
    // 按需重绘的循环这时早就静下来了。不主动请求一帧，人物要等到用户下一次动鼠标才出现。
    expect(onReady).toHaveBeenCalled();

    // sync 是可以每帧调的。少了「只发一次」的守卫，每一帧都往同一个节点上再叠一个 GLB。
    graph.sync(scene);
    graph.sync(scene);
    await flush();
    expect(loadGltf).toHaveBeenCalledTimes(1);
    expect(node?.children).toHaveLength(1);
  });

  it('rescales the loaded rig when heightCm changes, without loading a second model', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const { factory, loadGltf } = rigFactory(three);
    graph.attachCharacterRig(factory, vi.fn());

    const scene = characterScene({ heightCm: 150 });
    const character = scene.objects[0]!;
    if (character.kind !== 'character') throw new Error('expected a character');
    graph.sync(scene);
    await flush();
    const rig = rigOf(graph, character.id);
    // 假模型净高 2 m，1.5 m 的人就是缩到 0.75。
    expect(rig?.scale.y).toBeCloseTo(0.75, 6);

    graph.sync({ ...scene, objects: [{ ...character, heightCm: 200, bodyType: 'heavy' }] });

    // 模型到位之后占位胶囊已经没了，`resizePlaceholder` 从此直接早退——身高体型
    // 只能由 rig 的缩放接手。少了这条，属性面板的身高滑杆对已加载的人物完全失效。
    expect(rig?.scale.y).toBeCloseTo(1, 6);
    expect(rig?.scale.x).toBeCloseTo(1.15, 6);
    // 而且是重新缩放，不是重新下一个模型。
    expect(loadGltf).toHaveBeenCalledTimes(1);
    expect(graph.nodeFor(character.id)?.children).toHaveLength(1);
    expect(rigOf(graph, character.id)).toBe(rig);
  });

  it('gives the model that just arrived the display mode already in force', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const { factory } = rigFactory(three);
    graph.attachCharacterRig(factory, vi.fn());

    const scene = characterScene();
    graph.sync({ ...scene, settings: { ...scene.settings, displayMode: 'translucent' } });
    await flush();

    // 模型是在任何一次 sync 之外落进树里的：不补一次显示模式，半透明场景里每个
    // 人物都会是实心的，而占位体又都是半透明的。
    const mesh = rigOf(graph, scene.objects[0]!.id)?.children[0] as unknown as FakeMeshView;
    expect(mesh.material.transparent).toBe(true);
    expect(mesh.material.opacity).toBeCloseTo(0.35, 6);
  });

  it('keeps the placeholder capsule when the model cannot be loaded, and retries later', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const onReady = vi.fn();
    const loadGltf = vi.fn(async () => {
      throw new Error('404');
    });
    graph.attachCharacterRig(
      new CharacterRigFactory({ three, loadGltf, clone: (object) => object }),
      onReady,
    );

    const scene = characterScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    await flush();

    // 模型 404 不该把人物从场景里抹掉，也不该白请求一帧。
    const placeholder = placeholderOf(graph, id);
    expect(placeholder.geometry.shape).toBe('capsule');
    expect(placeholder.geometry.dispose).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();

    // 失败之后要能重试：用户改一次属性触发的下一次 sync 就是一次重试，
    // 否则一次网络抖动就把这个人物永久钉死在占位胶囊上。
    graph.sync(scene);
    await flush();
    expect(loadGltf).toHaveBeenCalledTimes(2);

    error.mockRestore();
  });

  it('drops the model when its node is gone by the time it arrives', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const onReady = vi.fn();
    const { factory } = rigFactory(three);
    graph.attachCharacterRig(factory, onReady);

    const scene = characterScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    const node = graph.nodeFor(id);
    graph.dispose();
    await flush();

    // 节点已经从树上摘掉、资源也还过了。往它身上挂一个 GLB 就是一份谁都够不着、
    // 也永远不会再被 dispose 的副本。
    expect(node?.children).toHaveLength(1);
    expect(node?.children[0]?.userData.previzPlaceholder).toBe(true);
    expect(onReady).not.toHaveBeenCalled();
  });

  it('requests the model again for an object that came back after being removed', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const { factory, clone } = rigFactory(three);
    graph.attachCharacterRig(factory, vi.fn());

    const scene = characterScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    await flush();
    expect(rigOf(graph, id)).toBeDefined();

    // 删掉再撤销：对象带着同一个 id 回来，但节点是全新的。「已经建过 rig 的 id」
    // 这种记法会让撤销回来的人物永远停在占位胶囊上。
    graph.sync({ ...scene, objects: [] });
    graph.sync(scene);
    await flush();

    expect(rigOf(graph, id)).toBeDefined();
    expect(clone).toHaveBeenCalledTimes(2);
  });
  it('swaps the placeholder box for the loaded prop model', async () => {
    const three = fakeThree();
    const root = new three.Group();
    const graph = new PrevizSceneGraph(three, root);
    const onReady = vi.fn();
    const { loader, loadGltf } = propLoaderWith(three);
    graph.attachCharacterRig(rigFactory(three).factory, onReady);
    graph.attachPropLoader(loader);

    const scene = propScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    // 先抓住占位方块：换模型是异步的，flush 之后它已经从树上摘走，取不回来了。
    const placeholder = placeholderOf(graph, id);
    await flush();

    expect(loadGltf).toHaveBeenCalledWith('/uploads/chair.glb');
    expect(sharedModelOf(graph, id)).toBeDefined();
    // 占位方块是一节点一份、谁都不共享的，必须真的还掉，否则每换一次模型泄漏一对资源。
    expect(graph.nodeFor(id)?.children).toHaveLength(1);
    expect(placeholder.geometry.dispose).toHaveBeenCalledTimes(1);
    // 模型是在任何一次 sync 之外落进树里的：不主动请求一帧，按需重绘的循环这时已经静了，
    // 物件要等到用户下一次动鼠标才出现。
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('leaves a prop without an asset url on its placeholder', async () => {
    const three = fakeThree();
    const graph = new PrevizSceneGraph(three, new three.Group());
    const { loader, loadGltf, loadObj } = propLoaderWith(three);
    graph.attachPropLoader(loader);

    const scene = propScene({ assetUrl: '' });
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    await flush();

    expect(loadGltf).not.toHaveBeenCalled();
    expect(loadObj).not.toHaveBeenCalled();
    expect(placeholderOf(graph, id).geometry.shape).toBe('box');
  });

  it('routes obj assets to the obj loader', async () => {
    const three = fakeThree();
    const graph = new PrevizSceneGraph(three, new three.Group());
    const { loader, loadGltf, loadObj } = propLoaderWith(three);
    graph.attachPropLoader(loader);

    graph.sync(propScene({ assetUrl: '/uploads/chair.obj', assetFormat: 'obj' }));
    await flush();

    expect(loadObj).toHaveBeenCalledWith('/uploads/chair.obj');
    expect(loadGltf).not.toHaveBeenCalled();
  });

  it('reloads the model when the asset url changes and not when it does not', async () => {
    const three = fakeThree();
    const graph = new PrevizSceneGraph(three, new three.Group());
    const { loader, loadGltf } = propLoaderWith(three);
    graph.attachPropLoader(loader);

    const scene = propScene();
    const prop = scene.objects[0] as PrevizProp;
    graph.sync(scene);
    await flush();
    // 每帧都 sync，但资产没变：重复加载会把同一个模型每帧换一次，画面闪、显存涨。
    graph.sync(scene);
    graph.sync(scene);
    await flush();
    expect(loadGltf).toHaveBeenCalledTimes(1);

    const swapped = { ...scene, objects: [{ ...prop, assetUrl: '/uploads/desk.glb' }] };
    graph.sync(swapped);
    await flush();

    expect(loadGltf).toHaveBeenCalledTimes(2);
    expect(loadGltf).toHaveBeenLastCalledWith('/uploads/desk.glb');
    // 换模型时旧模型也要从树上摘掉，不然新旧两份叠在同一个位置。
    expect(graph.nodeFor(prop.id)?.children).toHaveLength(1);
  });

  // 这条是承重的：`clone()` 与 `SkeletonUtils.clone` 都是浅克隆几何体与材质，克隆体和
  // 缓存里那份源模型指向同一批 GPU 资源。照占位体的路子 dispose 一个克隆，等于把源模型
  // 一起还了——删掉第一把椅子之后，同一个 URL 克隆出来的每一把都是空的，而症状离
  // 「删除」这个动作隔了好几步。
  it('does not dispose the shared source when a prop is removed', async () => {
    const three = fakeThree();
    const graph = new PrevizSceneGraph(three, new three.Group());
    const { loader, sourceMesh } = propLoaderWith(three);
    graph.attachPropLoader(loader);

    const scene = propScene();
    graph.sync(scene);
    await flush();

    graph.sync({ ...scene, objects: [] });
    expect(sourceMesh.geometry.dispose).not.toHaveBeenCalled();
    expect(sourceMesh.material.dispose).not.toHaveBeenCalled();
  });

  it('does not dispose the shared actor model when a character is removed', async () => {
    const three = fakeThree();
    const graph = new PrevizSceneGraph(three, new three.Group());
    const { factory } = rigFactory(three);
    graph.attachCharacterRig(factory, vi.fn());

    const scene = characterScene();
    const id = scene.objects[0]!.id;
    graph.sync(scene);
    await flush();
    const rigMesh = rigOf(graph, id)?.children[0] as unknown as FakeMeshView;
    expect(rigMesh).toBeDefined();

    // 删除走的是 sync 的清理分支，dispose() 走的是另一条——两条都得跳过共享模型。
    graph.sync({ ...scene, objects: [] });
    expect(rigMesh.geometry.dispose).not.toHaveBeenCalled();
    expect(rigMesh.material.dispose).not.toHaveBeenCalled();

    graph.sync(scene);
    await flush();
    const second = rigOf(graph, id)?.children[0] as unknown as FakeMeshView;
    graph.dispose();
    expect(second.geometry.dispose).not.toHaveBeenCalled();
    expect(second.material.dispose).not.toHaveBeenCalled();
  });
});
