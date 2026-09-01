// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
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

/** 建出来的材质只在「dispose 了几次」这一件事上被断言，所以只记这一个方法。 */
interface FakeMaterial {
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

/**
 * 人物模型的加载：本文件测的是渲染器与场景图 / 取景数学的接线，模型自身的行为归
 * `character-rig.test.ts` 与 `scene-graph.test.ts`。默认让加载永不落地——别的用例里的
 * 人物就一直停在占位胶囊上，不会有一次异步换模型插进它们的断言中间。要测这条接线的
 * 那条用例自己把 `pendingGltf` 填上。
 */
let pendingGltf: unknown = null;
const loadedUrls: string[] = [];

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync = vi.fn((url: string) => {
      loadedUrls.push(url);
      return pendingGltf ? Promise.resolve(pendingGltf) : new Promise(() => {});
    });
  },
}));

vi.mock('three/examples/jsm/utils/SkeletonUtils.js', () => ({
  clone: (object: unknown) => object,
}));

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

/** 排空微任务队列：模型换入走的是一条纯 Promise 链，没有定时器。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  frames = [];
  intersections = [];
  pendingGltf = null;
  loadedUrls.length = 0;
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

/** jsdom 的 clientWidth/clientHeight 恒为 0，resize() 要拿到真尺寸只能自己盖上去。 */
function setClientSize(canvas: HTMLCanvasElement, width: number, height: number) {
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
}

async function createRenderer(size?: { width: number; height: number }) {
  const canvas = document.createElement('canvas');
  // 尺寸要赶在 create() 之前盖上：这里测的正是 create() 自己那次 resize()。
  if (size) setClientSize(canvas, size.width, size.height);
  const instance = await PrevizRenderer.create(canvas);
  // 这里只做搭台，不放断言：helper 里的断言一红，15 条用例会一起红，
  // 谁都看不出坏的是哪一处。create() 自己的行为归下面「重置回共享的默认机位」那条管。
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
    const node = instance.nodeFor(scene.objects[0].id);
    expect(node?.userData.previzObjectId).toBe(scene.objects[0].id);

    // 对象挂在一个独立的对象根上，对象根再挂进场景。两头都要锁：
    // 把 scene 本身交给场景图的话，显示模式会连地面网格与常驻灯光一起改材质，
    // dispose 也会顺手把它们清掉；而对象根忘了 add 进场景的话，nodeFor / 拾取 /
    // 取景全都照常工作，只有画面上一个对象都看不见——最难查的那种症状。
    const objectRoot = node?.parent;
    expect(objectRoot).toBeInstanceOf(THREE.Group);
    expect(objectRoot).not.toBeInstanceOf(THREE.Scene);
    expect(objectRoot?.parent).toBeInstanceOf(THREE.Scene);

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
    // 占位盒是 1.75 m 高、0.44 m 宽、脚底贴地的一个人，中心在 y=0.875。
    expect(targetOf()).toEqual([0, 0.875, 0]);
    // 正视图的注视点在 z=0，所以 position[2] 就是取景距离。这一个数把整条取景链路
    // 都钉住了：包围球半径 √(0.22² + 0.875² + 0.22²) ≈ 0.92867，除以 sin(50°/2)
    // 再乘 1.25 的留白 ≈ 2.7468。占位盒半宽归零会退化成一条竖线，这个数掉到 2.588。
    // 期望值刻意写字面量：从被测模块 import 常量来算期望，改一处两边一起变。
    expect(position[2]).toBeCloseTo(2.7468, 3);
    // 上面那个 2.7468 里已经含着「取景用 50°」，这里再把**相机自己**的视场角钉在同一
    // 个数上，两条合起来锁的是二者的耦合：分岔之后「切到正视图」框出来的画面就不是
    // 相机真正看到的画面（一边裁掉、一边留白），而取景数学和相机各自看起来都「对」，
    // 没有任何东西会报错。这两行合在一起也顺带把 50 这个取值本身变成了棘轮——改它
    // 要同时改这两个字面量，是有意的。
    // （下面「出片画幅不改编辑视角的视场角」那条用的是区间断言，测的是另一件事：
    //   同一个渲染器实例内，切画幅前后 fov 不变。）
    expect(instance.editorFovForTest()).toBe(50);

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
    // 这条不走 createRenderer()：它要数的正是 create() 自己留下的那次 update()，
    // 而 helper 会先跑掉一帧，tick 里那次 update() 会把计数顶到 2。
    const instance = await PrevizRenderer.create(document.createElement('canvas'));
    // create() 写完 position/target 之后必须自己 update() 一次。真 OrbitControls 的
    // 构造函数末尾也有一次 update()，但它跑在我们写 target 之前——不补这一次的话
    // 内部球坐标记的还是 target=(0,0,0)，用户第一次拖拽相机会跳一下。
    expect(controls.update).toHaveBeenCalledTimes(1);
    expect(instance.cameraPositionForTest()).toEqual([...PREVIZ_DEFAULT_VIEW.position]);
    // create() 里的初始轨道中心也走同一份真相，不是另抄一遍的 (0, 0, 0)——
    // 抄错的话用户第一次点「重置」之前轨道中心就是错的，聚焦的首次观察方向也跟着歪。
    expect(targetOf()).toEqual([...PREVIZ_DEFAULT_VIEW.target]);

    instance.applyViewDirection('top');
    expect(instance.cameraPositionForTest()).not.toEqual([...PREVIZ_DEFAULT_VIEW.position]);

    // 先把上一次的重绘请求消化掉，下面那次计数才是在测 resetView 自己。
    step();
    render.mockClear();
    controls.update.mockClear();
    instance.resetView();

    expect(instance.cameraPositionForTest()).toEqual([...PREVIZ_DEFAULT_VIEW.position]);
    expect(targetOf()).toEqual([...PREVIZ_DEFAULT_VIEW.target]);
    // 直接写 position/target 之后必须让 OrbitControls 重算一次：真 three 里这一步
    // 才会 lookAt(target) 把姿态摆正，少了它相机位置变了、朝向还停在原处。
    // 计数要赶在 step() 之前：tick 每帧自己也会调一次 update()。
    expect(controls.update).toHaveBeenCalledTimes(1);

    // 假 controls 的 update() 恒为 false，所以这一帧要重绘只可能是 moveCamera
    // 自己请求的。生产里还有 controls 的 'change' 事件兜底，但那是第二层。
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });

  it('取景用的是画布当前的宽高比', async () => {
    const { canvas, instance } = await createRenderer({ width: 400, height: 1600 });
    instance.setScene(sceneWith([0, 0, 0]));

    // 刻意不先调 resize()：create() 自己就该把画布尺寸接上。少了那一步，aspect 会
    // 停在 PerspectiveCamera 构造时的 1，竖幅容器里第一帧的取景就是错的（左右被裁），
    // 一直错到容器第一次改尺寸、ResizeObserver 补上为止。
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

    // 递归必须开着：交给射线的是 createNode() 建出来的 Group，几何体挂在它的子
    // Mesh 上，而 Object3D.raycast() 是空实现——关掉递归就永远命中不了任何东西。
    expect(intersectObjects.mock.calls[0][1]).toBe(true);

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
    // 只要求「确实建了材质」，不钉数量：一个节点建几份材质是场景图的事，
    // 由 scene-graph 的用例管；钉在这里的话那边多加一份材质就会把这条无关的用例带红。
    expect(materials.length).toBeGreaterThan(0);

    instance.dispose();

    expect(instance.nodeFor(id)).toBeUndefined();
    // 场景图先把节点从对象根上摘掉再还资源，之后 dispose() 里的 scene.traverse
    // 就遍历不到它们了；两步顺序反过来的话每份材质会被 dispose 两次。
    for (const material of materials) expect(material.dispose).toHaveBeenCalledTimes(1);

    // 已经 dispose 的渲染器不该再被灌活，也不该再打射线。
    instance.setScene(scene);
    expect(instance.nodeFor(id)).toBeUndefined();
    expect(instance.pickAt(1, 1)).toBeNull();
    expect(setFromCamera).not.toHaveBeenCalled();
  });
  it('把角色 rig 工厂接给场景图，模型到位后主动请求一帧', async () => {
    const { instance } = await createRenderer();
    pendingGltf = { scene: new THREE.Object3D(), animations: [] };
    const scene = sceneWith([0, 0, 0]);
    instance.setScene(scene);
    // 先把 setScene 自己那次重绘消化掉，下面数的才是模型到位换来的那一帧。
    step();
    render.mockClear();

    await flush();

    const node = instance.nodeFor(scene.objects[0].id);
    // 占位胶囊换成了真模型：工厂没接上的话这里还是那个胶囊。
    expect(node?.children).toHaveLength(1);
    expect(node?.children[0]?.userData.previzRig).toBe(true);
    // 加载的是仓库里那份共享角色模型。路径写字面量：从被测模块 import 回来的常量
    // 改一处两边一起变。
    expect(loadedUrls).toEqual(['/viewer-kit/quaternius/ual2/UAL2_Standard.glb']);

    // 模型到位时按需重绘的循环早就静下来了。不把 requestRender 接上，人物要等到
    // 用户下一次动鼠标才出现在画面上。
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });
});
