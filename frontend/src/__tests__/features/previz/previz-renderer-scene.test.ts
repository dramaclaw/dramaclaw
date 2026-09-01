// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrevizObject } from '@/features/previz/domain/objects';
import { createDefaultScene, type PrevizScene, type Vec3 } from '@/features/previz/domain/scene';
import { PREVIZ_DEFAULT_VIEW } from '@/features/previz/domain/view';
import { PrevizRenderer } from '@/features/previz/engine/PrevizRenderer';

/**
 * 这份用例盯的是渲染器与场景图 / 取景数学之间的接线，不是 three 本身。真 three 在
 * jsdom 里连 WebGLRenderer 都建不出来，所以整个模块换成一份够用的假实现——它只需要
 * 忠实到能反映被测代码依赖的那几条行为：
 *
 * - `Box3.setFromObject()` 先 `makeEmpty()`，没有几何体时留下 min=+∞ / max=-∞；
 * - `isEmpty()` 判的是 max < min（照抄 three 0.185 的 `math/Box3.js`）；
 * - `Raycaster` 只按 layers 过滤，**不看 visible**（three 0.185 `core/Raycaster.js`
 *   的 `intersect()`，`Mesh.raycast()` 里也没有这项检查），隐藏对象要调用方自己剔。
 */

const render = vi.fn();
const setFromCamera = vi.fn();
let intersections: Array<{ object: unknown }> = [];
const intersectObjects = vi.fn((_objects: unknown[], _recursive?: boolean) => intersections);

interface FakeMaterial {
  transparent: boolean;
  opacity: number;
  dispose: ReturnType<typeof vi.fn>;
}
const materials: FakeMaterial[] = [];

/** 打开后所有 `setFromObject()` 都交出空盒，模拟「节点下面还没有任何几何体」。 */
let boxIsEmpty = false;

vi.mock('three', () => {
  class Vector2 {
    constructor(
      public x = 0,
      public y = 0,
    ) {}
  }
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
  class Object3D {
    name = '';
    visible = true;
    userData: Record<string, unknown> = {};
    children: Object3D[] = [];
    parent: Object3D | null = null;
    position = new Vector3();
    rotation = new Vector3();
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
    /** 沿父链累加：本用例里的节点只有平移，够用且不用假装有矩阵。 */
    getWorldPosition(target: Vector3) {
      let x = 0;
      let y = 0;
      let z = 0;
      let node: Object3D | null = this;
      while (node) {
        x += node.position.x;
        y += node.position.y;
        z += node.position.z;
        node = node.parent;
      }
      return target.set(x, y, z);
    }
  }
  class Box3 {
    min = new Vector3(Infinity, Infinity, Infinity);
    max = new Vector3(-Infinity, -Infinity, -Infinity);
    /** 非空时给一个 2×2×2、脚底贴地、跟着对象位置走的盒子。 */
    setFromObject(object: Object3D) {
      if (boxIsEmpty) return this;
      const origin = object.getWorldPosition(new Vector3());
      this.min.set(origin.x - 1, origin.y, origin.z - 1);
      this.max.set(origin.x + 1, origin.y + 2, origin.z + 1);
      return this;
    }
    isEmpty() {
      return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
    }
  }
  class FakeGeometry {
    dispose = vi.fn();
    constructor(..._args: number[]) {}
  }
  class FakeMaterialImpl {
    transparent = false;
    opacity = 1;
    needsUpdate = false;
    color = { set: vi.fn() };
    dispose = vi.fn();
    constructor(public params: Record<string, unknown> = {}) {
      materials.push(this as unknown as FakeMaterial);
    }
  }

  return {
    Scene: class extends Object3D {
      background: unknown = null;
    },
    Group: class extends Object3D {},
    Mesh: class extends Object3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterialImpl,
      ) {
        super();
      }
    },
    Object3D,
    Box3,
    Vector2,
    Vector3,
    Euler: Vector3,
    Color: class {},
    GridHelper: class extends Object3D {},
    AmbientLight: class extends Object3D {},
    DirectionalLight: class extends Object3D {},
    CapsuleGeometry: FakeGeometry,
    ConeGeometry: FakeGeometry,
    SphereGeometry: FakeGeometry,
    BoxGeometry: FakeGeometry,
    MeshStandardMaterial: FakeMaterialImpl,
    PerspectiveCamera: class extends Object3D {
      aspect = 1;
      fov: number;
      updateProjectionMatrix = vi.fn();
      constructor(fov = 50) {
        super();
        this.fov = fov;
      }
    },
    Raycaster: class {
      setFromCamera = setFromCamera;
      intersectObjects = intersectObjects;
    },
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      render = render;
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
    },
  };
});

class FakeTarget {
  x = 0;
  y = 0;
  z = 0;
  set(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
}

class FakeControls {
  enableDamping = false;
  target = new FakeTarget();
  // 恒为 false：本文件测的都是「显式调了 requestRender 吗」，让 update() 自己报
  // 「相机动了」会把这条路径盖掉。
  update = vi.fn(() => false);
  dispose = vi.fn();
  addEventListener() {}
}

let controls: FakeControls;

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => ({
  OrbitControls: class {
    constructor() {
      controls = new FakeControls();
      return controls as unknown as object;
    }
  },
}));

let frames: FrameRequestCallback[] = [];

/** 跑一帧：rAF 回调里会重新排下一帧，所以先取走再执行。 */
function step() {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame(0);
}

beforeEach(() => {
  frames = [];
  intersections = [];
  materials.length = 0;
  boxIsEmpty = false;
  render.mockClear();
  setFromCamera.mockClear();
  intersectObjects.mockClear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function createRenderer() {
  const canvas = document.createElement('canvas');
  const instance = await PrevizRenderer.create(canvas);
  // create() 里的 resize() 置了 needsRender，先把首帧跑掉再计数。
  step();
  render.mockClear();
  return { canvas, instance };
}

/** 每个位置放一个人物。假 Box3 会把包围盒挂到这些位置上，取景结果才分得开。 */
function sceneWith(...positions: Vec3[]): PrevizScene {
  const scene = createDefaultScene();
  for (const position of positions) {
    scene.objects.push(
      createPrevizObject('character', scene.objects, {
        transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    );
  }
  return scene;
}

/** jsdom 的 clientWidth/clientHeight 恒为 0，resize() 要拿到真尺寸只能自己盖上去。 */
function setClientSize(canvas: HTMLCanvasElement, width: number, height: number) {
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
}

function targetOf(): Vec3 {
  return [controls.target.x, controls.target.y, controls.target.z];
}

/** 相机相对轨道中心的方向与距离——聚焦要保住前者、只改后者。 */
function orbitOffset(instance: PrevizRenderer): { unit: Vec3; distance: number } {
  const position = instance.cameraPositionForTest();
  const target = targetOf();
  const raw: Vec3 = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  const distance = Math.hypot(raw[0], raw[1], raw[2]);
  return { unit: [raw[0] / distance, raw[1] / distance, raw[2] / distance], distance };
}

describe('PrevizRenderer 接场景图', () => {
  it('把场景灌进对象树并请求一次重绘', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([0, 0, 0]);

    // 静止帧不重绘，否则下面那次计数不是在测 setScene。
    step();
    expect(render).not.toHaveBeenCalled();

    instance.setScene(scene);
    step();

    expect(render).toHaveBeenCalledTimes(1);
    expect(instance.nodeFor(scene.objects[0].id)?.userData.previzObjectId).toBe(
      scene.objects[0].id,
    );

    instance.dispose();
  });

  it('按方向把相机摆到包围球之外，注视点落在对象中心', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([2, 0, 0]);
    instance.setScene(scene);

    instance.applyViewDirection('left');

    // 假 Box3 给这个对象的是 [1,0,-1]..[3,2,1]：中心 (2,1,0)、包围球半径 √3。
    expect(targetOf()[0]).toBeCloseTo(2, 6);
    expect(targetOf()[1]).toBeCloseTo(1, 6);
    expect(targetOf()[2]).toBeCloseTo(0, 6);

    const position = instance.cameraPositionForTest();
    // 左视图站在中心的 -X 一侧，另外两轴与中心齐平，且要退到包围球之外。
    expect(position[1]).toBeCloseTo(1, 6);
    expect(position[2]).toBeCloseTo(0, 6);
    expect(position[0]).toBeLessThan(2 - Math.sqrt(3));

    instance.dispose();
  });

  it('有选中对象就只框选中的，没有就框全场景', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([2, 0, 0], [-8, 0, 0]);
    instance.setScene(scene);

    instance.applyViewDirection('front');
    // 两个盒子并起来是 x∈[-9,3]，中心 -3。
    expect(targetOf()[0]).toBeCloseTo(-3, 6);

    instance.setSelection(scene.objects[1].id);
    instance.applyViewDirection('front');
    expect(targetOf()[0]).toBeCloseTo(-8, 6);

    instance.setSelection(null);
    instance.applyViewDirection('front');
    expect(targetOf()[0]).toBeCloseTo(-3, 6);

    instance.dispose();
  });

  it('隐藏的对象不进「框全场景」的并集', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([2, 0, 0], [-8, 0, 0]);
    scene.objects[1].visible = false;
    instance.setScene(scene);

    instance.applyViewDirection('front');

    expect(targetOf()[0]).toBeCloseTo(2, 6);

    instance.dispose();
  });

  it('空场景切视图时回落到占位包围盒，而不是崩在 null 上', async () => {
    const { instance } = await createRenderer();
    instance.setScene(createDefaultScene());

    instance.applyViewDirection('front');

    const position = instance.cameraPositionForTest();
    expect(position.every((value) => Number.isFinite(value))).toBe(true);
    // 占位盒是 1.75 m 高、脚底贴地的一个人，中心在 y=0.875。
    expect(targetOf()).toEqual([0, 0.875, 0]);
    expect(position[2]).toBeGreaterThan(1);

    instance.dispose();
  });

  it('对象没有几何体时，占位包围盒挂在它自己的位置上', async () => {
    boxIsEmpty = true;
    const { instance } = await createRenderer();
    const scene = sceneWith([4, 0, 0]);
    instance.setScene(scene);

    instance.applyViewDirection('front');

    // 空 Box3 是 min=+∞ / max=-∞，原样交给取景数学会收敛成「原点上的一个点」，
    // 相机被甩回场景中心；占位盒既要有人的尺寸，也要跟着对象走。
    expect(targetOf()[0]).toBeCloseTo(4, 6);
    expect(targetOf()[1]).toBeCloseTo(0.875, 6);
    expect(instance.cameraPositionForTest()[2]).toBeGreaterThan(1);

    instance.dispose();
  });

  it('聚焦保住当前观察方向，只改注视点与距离', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([0, 0, 0], [10, 0, 0]);
    instance.setScene(scene);
    const before = orbitOffset(instance);

    instance.focusObject(scene.objects[1].id);

    const after = orbitOffset(instance);
    expect(targetOf()[0]).toBeCloseTo(10, 6);
    expect(after.unit[0]).toBeCloseTo(before.unit[0], 6);
    expect(after.unit[1]).toBeCloseTo(before.unit[1], 6);
    expect(after.unit[2]).toBeCloseTo(before.unit[2], 6);
    // 默认机位离原点 √109 ≈ 10.4，框一个半径 √3 的盒子该拉近到几米。
    expect(after.distance).toBeGreaterThan(Math.sqrt(3));
    expect(after.distance).toBeLessThan(before.distance);

    // 认不出的 id 什么都不做，别把相机甩到原点。
    const parked = instance.cameraPositionForTest();
    instance.focusObject('no-such-object');
    expect(instance.cameraPositionForTest()).toEqual(parked);
    expect(targetOf()[0]).toBeCloseTo(10, 6);

    instance.dispose();
  });

  it('重置回共享的默认机位', async () => {
    const { instance } = await createRenderer();
    expect(instance.cameraPositionForTest()).toEqual([...PREVIZ_DEFAULT_VIEW.position]);

    instance.applyViewDirection('top');
    expect(instance.cameraPositionForTest()).not.toEqual([...PREVIZ_DEFAULT_VIEW.position]);

    controls.update.mockClear();
    instance.resetView();

    expect(instance.cameraPositionForTest()).toEqual([...PREVIZ_DEFAULT_VIEW.position]);
    expect(targetOf()).toEqual([...PREVIZ_DEFAULT_VIEW.target]);
    // 直接写 position/target 之后必须让 OrbitControls 重算一次：真 three 里这一步
    // 才会 lookAt(target) 把姿态摆正，少了它相机位置变了、朝向还停在原处。
    expect(controls.update).toHaveBeenCalledTimes(1);

    instance.dispose();
  });

  it('取景用的是画布当前的宽高比', async () => {
    const { canvas, instance } = await createRenderer();
    instance.setScene(sceneWith([0, 0, 0]));

    setClientSize(canvas, 400, 1600);
    instance.resize();
    instance.applyViewDirection('front');
    const tall = instance.cameraPositionForTest()[2];

    setClientSize(canvas, 1600, 1600);
    instance.resize();
    instance.applyViewDirection('front');
    const square = instance.cameraPositionForTest()[2];

    // 注视点在 z=0，所以 position[2] 就是取景距离。竖幅下水平方向更紧，必须退得更远，
    // 否则左右会被裁掉——写死 aspect=1 的话这两个数会一模一样。
    expect(square).toBeGreaterThan(1);
    expect(tall).toBeGreaterThan(square * 2);

    instance.dispose();
  });

  it('把画布坐标换成 NDC，并从命中的子网格往上找到对象组', async () => {
    const { canvas, instance } = await createRenderer();
    canvas.getBoundingClientRect = () => new DOMRect(100, 50, 400, 200);
    const scene = sceneWith([0, 0, 0]);
    instance.setScene(scene);
    const node = instance.nodeFor(scene.objects[0].id);

    // 命中的永远是子网格，previzObjectId 挂在它上面那个组上。
    intersections = [{ object: node?.children[0] }];
    expect(instance.pickAt(300, 100)).toBe(scene.objects[0].id);

    const pointer = setFromCamera.mock.calls[0][0] as { x: number; y: number };
    expect(pointer.x).toBeCloseTo(0, 6);
    // 画布上半部分在 NDC 里是正的：y 轴符号搞反的话拾取会上下颠倒。
    expect(pointer.y).toBeCloseTo(0.5, 6);

    intersections = [];
    expect(instance.pickAt(300, 100)).toBeNull();

    instance.dispose();
  });

  it('容器还没布局时也给出有限的 NDC', async () => {
    const { canvas, instance } = await createRenderer();
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    instance.setScene(sceneWith([0, 0, 0]));

    instance.pickAt(0, 0);

    const pointer = setFromCamera.mock.calls[0][0] as { x: number; y: number };
    expect(Number.isFinite(pointer.x)).toBe(true);
    expect(Number.isFinite(pointer.y)).toBe(true);

    instance.dispose();
  });

  it('隐藏的对象不参与拾取', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([0, 0, 0], [3, 0, 0]);
    scene.objects[0].visible = false;
    instance.setScene(scene);

    instance.pickAt(1, 1);

    // three 的 Raycaster 只测 layers，不看 visible，不主动剔的话隐藏对象照样点得中。
    const candidates = intersectObjects.mock.calls[0][0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toBe(instance.nodeFor(scene.objects[1].id));

    instance.dispose();
  });

  it('出片画幅不改编辑视角的视场角', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    instance.setScene(scene);

    const before = instance.editorFovForTest();
    // 0 / 180 / 负数 / NaN 都会被 three 静默收下，只留一个空视口。
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(180);

    render.mockClear();
    instance.setScene({ ...scene, settings: { ...scene.settings, outputAspect: '9:16' } });
    step();

    // 编辑视角是自由飞行相机，画幅只影响取景与截图；跟着画幅改视场角的话，
    // 切一次画幅整个视图会突然拉近或推远。
    expect(instance.editorFovForTest()).toBe(before);
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });

  it('dispose 连带把场景图还掉，每份材质只 dispose 一次', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWith([0, 0, 0]);
    instance.setScene(scene);
    const id = scene.objects[0].id;
    expect(instance.nodeFor(id)).toBeDefined();
    expect(materials).toHaveLength(1);

    instance.dispose();

    expect(instance.nodeFor(id)).toBeUndefined();
    // 场景图先把节点从对象根上摘掉再还资源，之后 dispose() 里的 scene.traverse
    // 就遍历不到它们了；两步顺序反过来的话每份材质会被 dispose 两次。
    expect(materials[0].dispose).toHaveBeenCalledTimes(1);

    // 已经 dispose 的渲染器不该再被灌活，也不该再打射线。
    instance.setScene(scene);
    expect(instance.nodeFor(id)).toBeUndefined();
    expect(instance.pickAt(1, 1)).toBeNull();
    expect(setFromCamera).not.toHaveBeenCalled();
  });
});
