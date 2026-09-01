// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  createPrevizObject,
  PREVIZ_MAX_HEIGHT_CM,
  PREVIZ_MIN_HEIGHT_CM,
} from '@/features/previz/domain/objects';
import {
  createDefaultScene,
  PREVIZ_SCALE_RANGE,
  type PrevizScene,
} from '@/features/previz/domain/scene';
import {
  PREVIZ_PLACEHOLDER_RADIUS,
  PREVIZ_TRANSLUCENT_OPACITY,
  PrevizSceneGraph,
} from '@/features/previz/engine/sceneGraph';

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
  }
  class Group extends Object3D {}
  class Mesh extends Object3D {
    constructor(
      public geometry: FakeGeometry,
      public material: FakeMaterial,
    ) {
      super();
    }
  }
  /** 几何体记下构造实参：占位体的尺寸是本模块的输出之一，不记就断言不到。 */
  class FakeGeometry {
    readonly args: number[];
    dispose = vi.fn();
    constructor(...args: number[]) {
      this.args = args;
    }
  }
  class FakeMaterial {
    opacity = 1;
    transparent = false;
    needsUpdate = false;
    color = { set: vi.fn() };
    dispose = vi.fn();
    constructor(public params: Record<string, unknown> = {}) {}
  }

  return {
    Object3D,
    Group,
    Mesh,
    Vector3,
    Euler,
    CapsuleGeometry: FakeGeometry,
    ConeGeometry: FakeGeometry,
    SphereGeometry: FakeGeometry,
    BoxGeometry: FakeGeometry,
    MeshStandardMaterial: FakeMaterial,
  } as unknown as typeof import('three');
}

/** 断言用的最小结构视图：假 three 的 Mesh 是 `any` 之外唯一能看清内部的入口。 */
interface FakeMeshView {
  geometry: { args: number[]; dispose: ReturnType<typeof vi.fn> };
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
    // 夹取语义整个仓库只有 `clampToRange` 一份，这里复用的就是它。
    const node = graph.nodeFor(scene.objects[0]!.id);
    expect(node?.scale.x).toBe(PREVIZ_SCALE_RANGE.min);
    expect(node?.scale.y).toBe(PREVIZ_SCALE_RANGE.min);
    // 非有限值回落到默认值而不是边界值，与 `clampToRange` 的约定一致。
    expect(node?.scale.z).toBe(PREVIZ_SCALE_RANGE.default);
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
    expect(mesh.geometry.args[0]).toBeCloseTo(PREVIZ_PLACEHOLDER_RADIUS, 6);
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
      expect(material.opacity).toBeCloseTo(PREVIZ_TRANSLUCENT_OPACITY, 6);
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
    expect(added.material.opacity).toBeCloseTo(PREVIZ_TRANSLUCENT_OPACITY, 6);
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
    expect(view.material.opacity).toBeCloseTo(PREVIZ_TRANSLUCENT_OPACITY, 6);
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
});
