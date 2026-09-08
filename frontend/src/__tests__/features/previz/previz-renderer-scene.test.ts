// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OUTPUT_PIXEL_SIZE, aspectRatio } from '@/features/previz/domain/camera';
import { createCameraDraft } from '@/features/previz/domain/cameraDraft';
import { createPrevizObject } from '@/features/previz/domain/objects';
import { createDefaultScene, type PrevizScene, type Vec3 } from '@/features/previz/domain/scene';
import { dropRayOriginY } from '@/features/previz/domain/drop';
import { PREVIZ_DEFAULT_VIEW } from '@/features/previz/domain/view';
import {
  PREVIZ_CAMERA_COLOR,
  PREVIZ_LIVE_FRUSTUM_COLOR,
} from '@/features/previz/engine/cameraModel';
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
let intersections: Array<{ object: unknown; point?: { x: number; y: number; z: number } }> = [];
const intersectObjects = vi.fn((_objects: unknown[], _recursive?: boolean) => intersections);
/**
 * `Raycaster.set(origin, direction)`：拾取走的是 `setFromCamera`，落地走的是这一条。
 * 记下来才断言得了「射线是从盒顶往**下**打的」——方向翻个个儿在假实现里照样有命中，
 * 屏幕上则是对象被吸到头顶那个天花板上。
 */
const raySet = vi.fn();

/** 建出来的材质只在「dispose 了几次」这一件事上被断言，所以只记这一个方法。 */
interface FakeMaterial {
  dispose: ReturnType<typeof vi.fn>;
}
const materials: FakeMaterial[] = [];

/** 建出来的假 WebGLRenderer。监看 pass 借了视口 / 剪刀 / autoClear，断言它有没有还回去。 */
interface FakeWebGLRenderer {
  autoClear: boolean;
  setPixelRatio: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  setViewport: ReturnType<typeof vi.fn>;
  setScissor: ReturnType<typeof vi.fn>;
  setScissorTest: ReturnType<typeof vi.fn>;
  clearDepth: ReturnType<typeof vi.fn>;
  setRenderTarget: ReturnType<typeof vi.fn>;
  readRenderTargetPixels: ReturnType<typeof vi.fn>;
}
const webglRenderers: FakeWebGLRenderer[] = [];

/** 打开后所有 `setFromObject()` 都交出空盒，模拟「节点下面还没有任何几何体」。 */
let boxIsEmpty = false;

/**
 * 假包围盒的盒底相对对象原点的偏移，默认 0（脚底就在原点上）。
 *
 * 默认值下 `boxMinY === currentY` 恒成立，于是落地公式里的位移
 * `currentY + (surfaceY - boxMinY)` 与错误的 `y = surfaceY` **算出来一模一样**，
 * 这一层根本分不开这两件事（偏移方向本身在 `drop.test.ts` 里测）。要在渲染器这一层
 * 也压住它的用例，把这个偏移调成非 0：原点不在脚底的模型（导入的 obj 常在几何中心）
 * 就是这样的。
 */
let boxMinYOffset = 0;

/**
 * 地面取点时射线打在 y=0 平面上的位置。null 表示射线与地面平行（相机平视时的真实
 * 情况），`Ray.intersectPlane` 这时返回 null——被测代码必须扛得住。
 */
let groundHit: Vec3 | null = [0, 0, 0];

/**
 * 上一次射线求交拿到的那个平面。绘制平面的高度只体现在平面本身上——假实现无论平面在
 * 哪都交出同一个落点，不把平面记下来的话「按对象高度取平面」这件事在这里测不出来。
 */
let lastPlane: { normal: { x: number; y: number; z: number }; constant: number } | null = null;
function rayPlaneHit(
  plane: unknown,
  target: { set: (x: number, y: number, z: number) => unknown },
) {
  lastPlane = plane as typeof lastPlane;
  if (!groundHit) return null;
  target.set(groundHit[0], groundHit[1], groundHit[2]);
  return target;
}

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
    /** 监看相机从节点的世界矩阵取位置；本假实现不模拟矩阵，取到什么不影响断言。 */
    setFromMatrixPosition(_matrix: unknown) {
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
    quaternion = { setFromRotationMatrix: vi.fn() };
    matrixWorld = {};
    updateWorldMatrix(_updateParents?: boolean, _updateChildren?: boolean) {}
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
      this.min.set(origin.x - 1, origin.y + boxMinYOffset, origin.z - 1);
      this.max.set(origin.x + 1, origin.y + 2 + boxMinYOffset, origin.z + 1);
      return this;
    }
    isEmpty() {
      return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
    }
    /** 照抄 three 0.185 `math/Box3.js:224`：两端中点写进 target 再交回来。 */
    getCenter(target: Vector3) {
      return target.set(
        (this.min.x + this.max.x) / 2,
        (this.min.y + this.max.y) / 2,
        (this.min.z + this.max.z) / 2,
      );
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
    // 真材质身上一定有这两样，全灰模式的记账就走它们。缺一个，这边任何一条走到全灰的
    // 用例都会炸在一句和显示模式毫无关系的 TypeError 上。
    color = { set: vi.fn(), getHex: vi.fn(() => 0xffffff) };
    userData: Record<string, unknown> = {};
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
    PlaneGeometry: FakeGeometry,
    ShaderMaterial: FakeMaterialImpl,
    DoubleSide: 2,
    // create() 现在会把中键从默认的推拉改成环绕，读的就是这个常量。
    MOUSE: { LEFT: 0, MIDDLE: 1, RIGHT: 2, ROTATE: 0, DOLLY: 1, PAN: 2 },
    AmbientLight: class extends Object3D {},
    DirectionalLight: class extends Object3D {},
    CapsuleGeometry: FakeGeometry,
    ConeGeometry: FakeGeometry,
    RingGeometry: FakeGeometry,
    SphereGeometry: FakeGeometry,
    CylinderGeometry: FakeGeometry,
    // 手柄改造要新建它（`gizmoEmphasis.ts`）。今天走不到——这份替身的 `getHelper()`
    // 交出的 helper `traverse` 是空实现，改造找不到手柄就早退了。留着是因为下一个把
    // 那个 traverse 补忠实的人不该撞上一句 `new undefined()`：报错点在 gizmoEmphasis 里，
    // 和他改的那一行隔着两层，找起来费时间而收获为零。
    OctahedronGeometry: FakeGeometry,
    BufferGeometry: class extends FakeGeometry {
      drawRange = { start: 0, count: Infinity };
      setFromPoints = vi.fn(() => this);
      setAttribute = vi.fn(() => this);
      setDrawRange(start: number, count: number) {
        this.drawRange = { start, count };
      }
    },
    Float32BufferAttribute: class {
      constructor(
        public array: number[],
        public itemSize: number,
      ) {}
    },
    BufferAttribute: class {
      needsUpdate = false;
      constructor(
        public array: Float32Array,
        public itemSize: number,
      ) {}
    },
    LineBasicMaterial: FakeMaterialImpl,
    MeshBasicMaterial: FakeMaterialImpl,
    Line: class extends Object3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterialImpl,
      ) {
        super();
      }
    },
    LineSegments: class extends Object3D {
      constructor(
        public geometry: FakeGeometry,
        public material: FakeMaterialImpl,
      ) {
        super();
      }
    },
    Plane: class {
      constructor(
        public normal: Vector3 = new Vector3(),
        public constant = 0,
      ) {}
    },
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
    OrthographicCamera: class extends Object3D {
      left = -1;
      right = 1;
      top = 1;
      bottom = -1;
      near = 0.1;
      far = 100;
      up = new Vector3(0, 1, 0);
      lookAt = vi.fn();
      updateProjectionMatrix = vi.fn();
    },
    Raycaster: class {
      setFromCamera = setFromCamera;
      set = raySet;
      intersectObjects = intersectObjects;
      ray = { intersectPlane: (plane: unknown, target: Vector3) => rayPlaneHit(plane, target) };
    },
    WebGLRenderer: class {
      domElement = document.createElement('canvas');
      render = render;
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      dispose = vi.fn();
      forceContextLoss = vi.fn();
      autoClear = true;
      getSize = vi.fn((target: { x: number; y: number }) => {
        target.x = 800;
        target.y = 450;
        return target;
      });
      setViewport = vi.fn();
      setScissor = vi.fn();
      setScissorTest = vi.fn();
      clearDepth = vi.fn();
      // 出片走的是离屏 render target。读回来的像素全是 0，出片本身在
      // `render-capture.test.ts` 那边测；这里只要这条路能走通，好让出片那一次
      // `render()` 真的发生——藏没藏住辅助物就是在那一刻断言的。
      getRenderTarget = vi.fn(() => null);
      setRenderTarget = vi.fn();
      readRenderTargetPixels = vi.fn();
      constructor() {
        webglRenderers.push(this as unknown as FakeWebGLRenderer);
      }
    },
    WebGLRenderTarget: class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      dispose = vi.fn();
    },
    SRGBColorSpace: 'srgb',
  };
});

/**
 * 人物模型的加载：本文件测的是渲染器与场景图 / 取景数学的接线，模型自身的行为归
 * `character-rig.test.ts` 与 `scene-graph.test.ts`。默认让加载永不落地——别的用例里的
 * 人物就一直停在占位胶囊上，不会有一次异步换模型插进它们的断言中间。要测这条接线的
 * 那条用例自己把 `pendingGltf` 填上。
 */
let pendingGltf: unknown = null;
/** 同上，OBJ 那一路。物件默认也停在占位方块上。 */
let pendingObj: unknown = null;
const loadedUrls: string[] = [];

/** 最近一次建出来的那个手柄 helper，见下面 mock 里的 `getHelper`。 */
let gizmoHelper: { traverse: () => void; visible: boolean; userData: Record<string, unknown> };

/**
 * 最近一次建出来的那个 TransformControls 替身。松手落地是「渲染器把算法接给手柄」，
 * 只有从这里把 `dragging-changed` 真的敲一遍，才验得到那根线接没接上。
 */
let transformControls: {
  object: unknown;
  axis: string | null;
  emit: (type: string, event?: { value?: boolean }) => void;
};

vi.mock('three/examples/jsm/controls/TransformControls.js', () => ({
  TransformControls: class {
    enabled = true;
    object: unknown = null;
    // attach/detach 照抄 three 0.185 的副作用：`_root.visible` 跟着开关（`TransformControlsRoot`
    // 构造里初值就是 false）。替身在这个属性上偏离真身的话，「手柄该不该在」这一类回归
    // 在集成层就永远观测不到——而单测那份替身已经是忠实的，两份互相打架更糟。
    attach = vi.fn((object: unknown) => {
      this.object = object;
      gizmoHelper.visible = true;
    });
    detach = vi.fn(() => {
      this.object = null;
      gizmoHelper.visible = false;
    });
    setMode = vi.fn();
    setSpace = vi.fn();
    dispose = vi.fn();
    // 真手柄是个 Object3D，挂在 scene 下面。谁扫一遍 scene 的子节点都会碰到它，
    // 少了 userData 就是一句和被测行为毫无关系的 TypeError。
    //
    // 每次都返回同一份，而不是新建一个字面量：`setHelperVisible` 改的就是它的 visible，
    // 每次换一份的话那次赋值写完就丢，「手柄藏没藏住」在这里根本观测不到；
    // gizmo dispose 里那次 `root.remove(getHelper())` 同理，删的得是当初加进去的那个。
    getHelper = vi.fn(() => gizmoHelper);
    /**
     * 正在被拖的那根手柄的名字。真身在 `pointerUp` 里先 `this.dragging = false`
     * （这一句才派发 `dragging-changed`），下一句才 `this.axis = null`
     * （three 0.185 `TransformControls.js:784-785`）——所以收尾事件跑的时候它还在。
     */
    axis: string | null = null;
    private readonly listeners: Record<string, Array<(event: { value?: boolean }) => void>> = {};
    addEventListener = vi.fn((type: string, handler: (event: { value?: boolean }) => void) => {
      (this.listeners[type] ??= []).push(handler);
    });
    constructor() {
      gizmoHelper = { traverse() {}, visible: false, userData: {} };
      transformControls = this as unknown as typeof transformControls;
    }
    emit(type: string, event: { value?: boolean } = {}) {
      for (const handler of this.listeners[type] ?? []) handler(event);
    }
  },
}));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    loadAsync = vi.fn((url: string) => {
      loadedUrls.push(url);
      return pendingGltf ? Promise.resolve(pendingGltf) : new Promise(() => {});
    });
  },
}));

vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => ({
  OBJLoader: class {
    loadAsync = vi.fn((url: string) => {
      loadedUrls.push(url);
      return pendingObj ? Promise.resolve(pendingObj) : new Promise(() => {});
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
  enabled = true;
  enableDamping = false;
  // create() 里会把 MIDDLE 从默认值改写成 MOUSE.ROTATE；这里得有这张表才接得住那次赋值。
  mouseButtons: Record<string, number | null> = { LEFT: 0, MIDDLE: 1, RIGHT: 2 };
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
  pendingObj = null;
  loadedUrls.length = 0;
  materials.length = 0;
  webglRenderers.length = 0;
  boxIsEmpty = false;
  boxMinYOffset = 0;
  groundHit = [0, 0, 0];
  lastPlane = null;
  render.mockClear();
  setFromCamera.mockClear();
  intersectObjects.mockClear();
  raySet.mockClear();
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

describe('PrevizRenderer 的当前导演视角', () => {
  it('把眼位与轨道中心一起交出来', async () => {
    const { instance } = await createRenderer();
    instance.applyViewDirection('front');

    const pose = instance.viewPose();

    // 摄影机创建对话框要的就是这两样：站位从眼位来，朝向从眼位指向轨道中心。
    expect(pose.position).toEqual(instance.cameraPositionForTest());
    expect(pose.target).toEqual(targetOf());
  });

  it('交出的是快照而不是 three 内部对象的引用', async () => {
    const { instance } = await createRenderer();

    const pose = instance.viewPose();
    pose.position[0] = 999;
    pose.target[0] = 999;

    // 对话框会把这两个数组存进 React state 再逐分量改；漏出引用的话用户拖一下滑杆
    // 就把视口相机搬走了。
    expect(instance.cameraPositionForTest()[0]).not.toBe(999);
    expect(targetOf()[0]).not.toBe(999);
  });

  it('销毁之后画预览不炸', async () => {
    const { instance } = await createRenderer();
    instance.dispose();

    // 对话框关闭与编辑器卸载谁先谁后不好保证，画到一台已销毁的渲染器上是会发生的。
    expect(() =>
      instance.renderCameraPreview(
        { width: 320, height: 180, getContext: () => null },
        createCameraDraft(instance.viewPose()),
      ),
    ).not.toThrow();
  });
});

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

  it('从轨迹点球上拾取轨迹点，点在曲线上不算', async () => {
    const { canvas, instance } = await createRenderer();
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    const scene = sceneWith([0, 0, 0]);
    scene.timeline.tracks.push({
      id: 'track',
      objectId: scene.objects[0].id,
      clips: [
        {
          id: 'clip',
          kind: 'path' as const,
          startFrame: 0,
          endFrame: 120,
          points: [
            { id: 'p0', u: 0, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
            { id: 'p1', u: 1, position: [4, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
          ],
        },
      ],
    });
    instance.setScene(scene);

    intersections = [{ object: { userData: { previzClipId: 'clip', previzPointId: 'p1' } } }];
    expect(instance.pickPathPointAt(10, 10)).toEqual({ clipId: 'clip', pointId: 'p1' });

    // 递给射线的必须是轨迹预览这一组：轨迹点球挂在预览根下，不在任何对象节点里，
    // 跟着 pickAt 那份候选走的话永远打不中。
    const candidates = intersectObjects.mock.calls[0][0] as Array<{
      userData: Record<string, unknown>;
    }>;
    const markers = candidates.filter((entry) => typeof entry.userData.previzPointId === 'string');
    expect(markers).toHaveLength(2);

    // 曲线身上也有 clipId，但它不是某一个点：点在两点之间的线上不该选中任何轨迹点。
    intersections = [{ object: { userData: { previzClipId: 'clip' } } }];
    expect(instance.pickPathPointAt(10, 10)).toBeNull();

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
    // 占位胶囊换成了真模型：工厂没接上的话这里还是那个胶囊。脚下那组辨识标记
    // 不带 `previzPlaceholder`，换模型时清不到它头上，所以是两个子节点。
    expect(node?.children).toHaveLength(2);
    expect(node?.children.some((child) => child.userData.previzRig)).toBe(true);
    // 加载的是仓库里那份共享角色模型，外加补齐蹲坐走跑等姿势的 UAL1 动画库。
    // 路径写字面量：从被测模块 import 回来的常量改一处两边一起变。
    expect(loadedUrls).toEqual([
      '/viewer-kit/quaternius/ual2/UAL2_Standard.glb',
      '/viewer-kit/quaternius/ual1/UAL1_Standard.glb',
    ]);

    // 模型到位时按需重绘的循环早就静下来了。不把 requestRender 接上，人物要等到
    // 用户下一次动鼠标才出现在画面上。
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });
  // 监看是同一个 WebGLRenderer 的第二次 pass。另开一个 renderer 才是真正的坑：
  // 浏览器并发 WebGL 上下文上限约 16 个，而预演台反复开关，迟早静默黑屏。
  it('renders a second monitor pass only when a camera is active', async () => {
    const instance = await PrevizRenderer.create(document.createElement('canvas'));
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject('camera', scene.objects));
    instance.setScene(scene);
    step();

    render.mockClear();
    instance.requestRender();
    step();
    expect(render).toHaveBeenCalledTimes(1);

    instance.setActiveCamera(scene.objects[0]!.id);
    render.mockClear();
    step();

    // 主视图一次 + 监看一次，共享同一个 WebGLRenderer。
    expect(render).toHaveBeenCalledTimes(2);

    instance.dispose();
  });

  it('does not render a monitor pass for a non-camera object', async () => {
    const instance = await PrevizRenderer.create(document.createElement('canvas'));
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject('light', scene.objects));
    instance.setScene(scene);
    step();

    // 灯不是机位：从它「看出去」没有意义，而 syncMonitorCamera 会照着一个没有
    // focalMm / sensor 的对象读出 NaN 视场角，监看框直接全黑。
    instance.setActiveCamera(scene.objects[0]!.id);
    render.mockClear();
    step();

    expect(render).toHaveBeenCalledTimes(1);

    instance.dispose();
  });

  it('restores the viewport and hides the camera model during the monitor pass', async () => {
    const instance = await PrevizRenderer.create(document.createElement('canvas'));
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject('camera', scene.objects));
    instance.setScene(scene);
    instance.setActiveCamera(scene.objects[0]!.id);
    step();

    const node = instance.nodeFor(scene.objects[0]!.id);
    // 机位模型就长在相机原点上，不藏起来会糊满整个监看画面；但 pass 结束必须还回去，
    // 否则主视图里那个机位从此消失。
    expect(node?.visible).toBe(true);
    // 剪刀测试留在打开状态的话，之后每一帧主视图都只画得出右下角那一小块。
    const gl = webglRenderers[webglRenderers.length - 1]!;
    expect(gl.setScissorTest).toHaveBeenLastCalledWith(false);
    expect(gl.setViewport).toHaveBeenLastCalledWith(0, 0, 800, 450);
    // autoClear 借出去必须还：留在 false 之后主视图不再清屏，画面会一层层糊上去。
    expect(gl.autoClear).toBe(true);

    instance.dispose();
  });

  it('keeps the editor-only helpers out of the monitor pass and out of the capture', async () => {
    const instance = await PrevizRenderer.create(document.createElement('canvas'));
    const scene = createDefaultScene();
    scene.objects.push(createPrevizObject('camera', scene.objects));
    instance.setScene(scene);
    instance.setActiveCamera(scene.objects[0]!.id);
    step();

    // 机位停在自己的轨迹上时，那颗轨迹点小球就贴在镜头前——不藏起来，监看框和出片
    // 的成片都会被一团糊满整幅画面的白挡住，而这恰恰是「机位走位」的常规用法。
    //
    // 必须在 `render()` 被调用的**那一刻**取样：藏起来是借的，pass 结束就还回去了，
    // 事后翻 mock.calls 里那个场景对象，读到的永远是还完之后的状态。
    type Traversable = {
      traverse(callback: (object: { userData: Record<string, unknown>; visible: boolean }) => void): void;
    };
    let seen: boolean[][] = [];
    render.mockImplementation((target: unknown) => {
      const pass: boolean[] = [];
      (target as Traversable).traverse((object) => {
        if (object.userData.previzEditorOnly) pass.push(object.visible);
      });
      seen.push(pass);
    });
    /**
     * 每趟 pass 收一格：这一趟里的辅助物是不是全都看得见。一个都没扫到记 `null`——
     * 空数组的 `every` 是 true，不区分的话「标记全丢了」会伪装成「全都看得见」。
     */
    const helperVisibility = () =>
      seen.map((pass) => (pass.length === 0 ? null : pass.every(Boolean)));

    seen = [];
    instance.requestRender();
    step();
    // 主视图一次 + 监看一次。主视图要看得见轨迹，监看不能。
    expect(helperVisibility()).toEqual([true, false]);

    // 出片同理，而且更要紧：监看糊了还能重摆机位，成片糊了是直接送进后面流程的。
    // jsdom 的 canvas 交不出 2D 上下文，而出片在拿不到它时会当场抛错、一帧都不渲染，
    // 于是这条断言就无从取样了——塞一个够用的假上下文进去，让整条出片路径真的跑完。
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((contextId: string) =>
        contextId === '2d'
          ? ({
              createImageData: (width: number, height: number) => ({
                data: new Uint8ClampedArray(width * height * 4),
                width,
                height,
              }),
              putImageData: () => {},
            } as unknown as CanvasRenderingContext2D)
          : null,
      );
    // jsdom 的 toBlob 同样没实现：它只打一行 "Not implemented" 就再也不回调，
    // 出片那个 Promise 会一直挂着，测试直接超时。
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, 'toBlob')
      .mockImplementation((callback: BlobCallback) => callback(new Blob()));
    seen = [];
    await instance.capture().catch(() => null);
    toBlob.mockRestore();
    getContext.mockRestore();
    expect(helperVisibility()).toEqual([false]);

    // 借出去要还：留在隐藏状态，主视图里整条轨迹从此消失。
    seen = [];
    instance.requestRender();
    step();
    expect(helperVisibility()[0]).toBe(true);

    render.mockReset();
    instance.dispose();
  });

  it('draws the stroke being dragged, and drops it on release', async () => {
    const { instance } = await createRenderer();

    instance.setStroke([
      [0, 0, 0],
      [1, 0, -1],
      [2, 0, -2],
    ]);

    // 这条线属于编辑视图，和轨迹曲线挂在同一个 previzEditorOnly 组下面——监看框和
    // 出片里不该出现一条正在画的笔画。
    const lines: { visible: boolean; geometry: { drawRange: { count: number } } }[] = [];
    (instance as unknown as { scene: { traverse(cb: (o: unknown) => void): void } }).scene.traverse(
      (object) => {
        const candidate = object as { geometry?: { drawRange?: { count: number } } };
        if (candidate.geometry?.drawRange) {
          lines.push(object as (typeof lines)[number]);
        }
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].visible).toBe(true);
    expect(lines[0].geometry.drawRange.count).toBe(3);

    instance.setStroke(null);

    // 松手后轨迹曲线接管；两条重叠着画会看成一条粗细不匀的线。
    expect(lines[0].visible).toBe(false);
    instance.dispose();
  });

  it('repaints while the stroke grows', async () => {
    const { instance } = await createRenderer();
    step();
    render.mockClear();

    instance.setStroke([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    step();

    // 不请求重绘的话，按需重绘的循环早就静下来了——线改了屏幕上一帧都不动。
    expect(render).toHaveBeenCalled();
    instance.dispose();
  });
});

describe('PrevizRenderer timeline', () => {
  function sceneWithWalk(): PrevizScene {
    const scene = createDefaultScene();
    const object = createPrevizObject('character', scene.objects);
    return {
      ...scene,
      objects: [object],
      timeline: {
        ...scene.timeline,
        tracks: [
          {
            id: 'track',
            objectId: object.id,
            clips: [
              {
                id: 'clip',
                kind: 'path' as const,
                startFrame: 0,
                endFrame: 120,
                points: [
                  { id: 'p0', u: 0, position: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
                  { id: 'p1', u: 1, position: [10, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 },
                ],
              },
            ],
          },
        ],
      },
    };
  }

  /** 节点下面那个模型根（`build()` 在它身上留了 `previzRig`）。 */
  function rigOf(instance: PrevizRenderer, objectId: string) {
    return instance.nodeFor(objectId)?.children.find((child) => child.userData.previzRig);
  }

  it('poses the actor for the playhead frame', async () => {
    const { instance } = await createRenderer();
    pendingGltf = { scene: new THREE.Object3D(), animations: [] };
    const scene = sceneWithWalk();
    instance.setScene(scene);
    await flush();

    instance.setFrame(60);

    // 走位中的人物换成走的循环，姿势内时间从片段首帧起算：60 帧就是 2 秒。
    // 位置在变而脚不动，看着是整个人被平移过去的。
    const rig = rigOf(instance, scene.objects[0]!.id);
    expect(rig?.userData.previzPoseId).toBe('walking');
    expect(rig?.userData.previzPoseTime).toBe(2);
  });

  it('poses a model that arrives after the playhead moved', async () => {
    const { instance } = await createRenderer();
    pendingGltf = { scene: new THREE.Object3D(), animations: [] };
    const scene = sceneWithWalk();
    instance.setScene(scene);
    instance.setFrame(60);

    await flush();

    // build() 摆的是静态姿势；模型到位时播放头已经在路径中间。不把当前帧重放一遍，
    // 后到的模型会一直站着滑，直到播放头下一次移动。
    expect(rigOf(instance, scene.objects[0]!.id)?.userData.previzPoseId).toBe('walking');
  });

  it('moves the object to where the playhead says it is', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWithWalk();
    instance.setScene(scene);

    instance.setFrame(60);

    const node = instance.nodeFor(scene.objects[0].id);
    // 半程：两点之间的中点。
    expect(node?.position.x).toBeCloseTo(5, 5);
  });

  it('re-applies the evaluated frame after a scene sync', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWithWalk();
    instance.setScene(scene);
    instance.setFrame(120);

    // 一次无关的编辑（比如改了名字）会走 setScene → graph.sync，而 sync 每次都把
    // 静态 transform 写回节点。求值结果不在 sync 之后重放一遍，播放中随便改点什么
    // 人就瞬移回起点了。
    instance.setScene({ ...scene, objects: [{ ...scene.objects[0], name: 'B' }] });

    const node = instance.nodeFor(scene.objects[0].id);
    expect(node?.position.x).toBeCloseTo(10, 5);
  });

  it('lets a hand-placed object stay put until the playhead moves', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWithWalk();
    instance.setScene(scene);
    const objectId = scene.objects[0]!.id;

    // 拖动手柄提交的是静态 transform。求值器每次 setScene 都无条件重放的话，
    // 提交的那一瞬间人又被路径拽回去了——画面上就是「有轨迹的对象拖不动」。
    instance.setScene({
      ...scene,
      objects: [
        {
          ...scene.objects[0]!,
          transform: { ...scene.objects[0]!.transform, position: [7, 0, 3] as Vec3 },
        },
      ],
    });

    const node = instance.nodeFor(objectId);
    expect([node?.position.x, node?.position.z]).toEqual([7, 3]);
    // 轨迹本身一动不动：手动摆的是这一刻的位置，不是把整条路径搬走。
    expect(scene.timeline.tracks[0]!.clips[0]).toMatchObject({ id: 'clip' });

    // 播放头一动，时间轴收回控制权，人自动回到轨迹上。
    instance.setFrame(60);
    expect(instance.nodeFor(objectId)?.position.x).toBeCloseTo(5, 5);
  });

  it('keeps a hand-placed object put across unrelated edits', async () => {
    const { instance } = await createRenderer();
    const scene = sceneWithWalk();
    instance.setScene(scene);

    const moved = {
      ...scene,
      objects: [
        {
          ...scene.objects[0]!,
          transform: { ...scene.objects[0]!.transform, position: [7, 0, 3] as Vec3 },
        },
      ],
    };
    instance.setScene(moved);
    // 摆好之后随便改点别的（这里是改名）。这一下不该把人弹回轨迹：中间没人碰过播放头。
    instance.setScene({ ...moved, objects: [{ ...moved.objects[0]!, name: 'B' }] });

    expect(instance.nodeFor(scene.objects[0]!.id)?.position.x).toBe(7);
  });

  it('leaves objects without a track on their static transform', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const object = createPrevizObject('prop', scene.objects, {
      transform: { position: [3, 0, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    instance.setScene({ ...scene, objects: [object] });

    instance.setFrame(60);

    const node = instance.nodeFor(object.id);
    expect([node?.position.x, node?.position.z]).toEqual([3, 4]);
  });

  it('asks for a repaint when the playhead moves', async () => {
    const { instance } = await createRenderer();
    instance.setScene(sceneWithWalk());
    step();
    render.mockClear();

    instance.setFrame(30);
    step();

    // 按需重绘的循环这时是静止的；不主动请求一帧，播放头动了画面不动。
    expect(render).toHaveBeenCalled();
  });

  it('projects a pointer onto the ground plane', async () => {
    const { instance } = await createRenderer();
    groundHit = [2, 0, -3];

    expect(instance.planePointAt(100, 100, 0)).toEqual([2, 0, -3]);
  });

  it('puts the drawing plane at the requested height', async () => {
    const { instance } = await createRenderer();
    groundHit = [2, 4, -3];

    expect(instance.planePointAt(100, 100, 4)).toEqual([2, 4, -3]);
    // three 的平面方程是 n·p + d = 0，法线朝 +Y 时 y = -d，所以 4 米高的平面常量是 -4。
    // 写成 +4 一样能画出轨迹，只是整条镜像到地面下方去了——而俯视角下这两种看着一模一样。
    expect(lastPlane?.constant).toBe(-4);
    expect([lastPlane?.normal.x, lastPlane?.normal.y, lastPlane?.normal.z]).toEqual([0, 1, 0]);
  });

  it('returns null when the ray never meets the ground', async () => {
    const { instance } = await createRenderer();
    groundHit = null;

    // 相机平视时射线与地面平行。返回一个瞎编的点，笔画上会多出一个乱跳的顶点。
    expect(instance.planePointAt(100, 100, 0)).toBeNull();
  });

  it('refuses to evaluate or pick after dispose', async () => {
    const { instance } = await createRenderer();
    instance.setScene(sceneWithWalk());
    instance.dispose();

    expect(() => instance.setFrame(60)).not.toThrow();
    expect(instance.planePointAt(100, 100, 0)).toBeNull();
  });
});

describe('live camera highlight', () => {
  /** 机位模型里那根视锥线框记的本色。直播色就落在这个字段上。 */
  function frustumColorOf(instance: PrevizRenderer, objectId: string): unknown {
    let color: unknown;
    instance.nodeFor(objectId)?.traverse((child) => {
      if (child.userData.previzCameraFrustum) color = child.userData.previzPlaceholderColor;
    });
    return color;
  }

  /** 机位某一件占位体的材质最后一次被涂成什么色：视锥线框，或随便一件机身。 */
  function lastColourOf(
    instance: PrevizRenderer,
    objectId: string,
    part: 'frustum' | 'body',
  ): unknown {
    let found = false;
    let colour: unknown;
    instance.nodeFor(objectId)?.traverse((child) => {
      const { material } = child as unknown as {
        material?: { color: { set: ReturnType<typeof vi.fn> } };
      };
      if (found || !material || !child.userData.previzPlaceholder) return;
      if (Boolean(child.userData.previzCameraFrustum) !== (part === 'frustum')) return;
      found = true;
      colour = material.color.set.mock.lastCall?.[0];
    });
    return colour;
  }

  it('recolours the live camera frustum and restores the previous one', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);
    const camB = createPrevizObject('camera', [camA]);
    instance.setScene({ ...scene, objects: [camA, camB] });

    instance.setLiveCamera(camA.id);
    expect(frustumColorOf(instance, camA.id)).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);

    // 切机位：上一台的 tally 灯要灭，否则视口里同时亮着两盏。
    instance.setLiveCamera(camB.id);
    expect(frustumColorOf(instance, camA.id)).toBe(PREVIZ_CAMERA_COLOR.frustum);
    expect(frustumColorOf(instance, camB.id)).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);

    instance.setLiveCamera(null);
    expect(frustumColorOf(instance, camB.id)).toBe(PREVIZ_CAMERA_COLOR.frustum);
  });

  it('relights the live camera when its node is rebuilt', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);
    instance.setScene({ ...scene, objects: [camA] });
    instance.setLiveCamera(camA.id);

    // 删掉再撤销：sync 把节点连模型一起重建，新模型是按本色建出来的，直播色得补回去。
    instance.setScene({ ...scene, objects: [] });
    instance.setScene({ ...scene, objects: [camA] });

    expect(frustumColorOf(instance, camA.id)).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
  });

  it('lights a camera that only arrives after setLiveCamera', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);

    // 编辑器里两路订阅谁先到并无保证：镜头轨可能先说 A 在直播，场景才灌进来。
    instance.setLiveCamera(camA.id);
    instance.setScene({ ...scene, objects: [camA] });

    expect(frustumColorOf(instance, camA.id)).toBe(PREVIZ_LIVE_FRUSTUM_COLOR);
  });

  it('lets clay mode repaint a camera that stops being live', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const camA = createPrevizObject('camera', scene.objects);
    const camB = createPrevizObject('camera', [camA]);
    instance.setScene({
      ...scene,
      settings: { ...scene.settings, displayMode: 'clay' },
      objects: [camA, camB],
    });
    // 机身没被直播色碰过，它此刻的颜色就是全灰模式那个灰——不用把常量抄过来。
    const clay = lastColourOf(instance, camA.id, 'body');
    expect(typeof clay).toBe('number');
    expect(clay).not.toBe(PREVIZ_CAMERA_COLOR.frustum);

    instance.setLiveCamera(camA.id);
    instance.setLiveCamera(camB.id);

    // 全灰只在切模式时整树刷一遍。熄灯若直接涂回橙色，一片灰里就多出一具橙视锥；
    // 而 tally 是逐帧切的，最后每台直播过的机位都是橙的。
    expect(lastColourOf(instance, camA.id, 'frustum')).toBe(clay);
    // 离开全灰时靠的是这个字段，它得记着本色而不是灰。
    expect(frustumColorOf(instance, camA.id)).toBe(PREVIZ_CAMERA_COLOR.frustum);
  });

  it('hides the live camera from its own frame and shows it in the director view', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    const cam = createPrevizObject('camera', scene.objects);
    instance.setScene({ ...scene, objects: [cam] });
    const node = instance.nodeFor(cam.id)!;
    const monitor = (instance as unknown as { monitorCamera: unknown }).monitorCamera;
    const gl = webglRenderers[webglRenderers.length - 1]!;

    // 机位模型藏没藏住只在 render() 发生的那一刻才看得出来，画完就还回去了。
    const seen: Array<{ camera: unknown; visible: boolean }> = [];
    const record = (_scene: unknown, camera: unknown) => {
      seen.push({ camera, visible: node.visible });
    };
    render.mockImplementationOnce(record).mockImplementationOnce(record);

    const pass = instance.startRecording('global', null)!;
    pass.drawFrame(0, cam.id);
    pass.drawFrame(1, null);
    pass.end();

    expect(seen).toHaveLength(2);
    // 直播机位那一帧从监看相机出片，而它自己的模型不能出现在自己拍的画面里。
    expect(seen[0]?.camera).toBe(monitor);
    expect(seen[0]?.visible).toBe(false);
    // 镜头轨没指定机位就回到导演视角，这时机位模型是场景的一部分，要露出来。
    expect(seen[1]?.camera).not.toBe(monitor);
    expect(seen[1]?.visible).toBe(true);
    expect(node.visible).toBe(true);
    // 录制直接画在视口画布上：没有离屏目标，也没有那次把每帧卡住 50 多毫秒的像素读回。
    for (const call of gl.setRenderTarget.mock.calls) expect(call[0]).toBeNull();
    expect(gl.readRenderTargetPixels).not.toHaveBeenCalled();
  });
});

describe('PrevizRenderer recording', () => {
  /** 带一台机位的场景。监看那趟 pass 录制期间必须停掉，得有机位才测得出来。 */
  function sceneWithCamera() {
    const scene = createDefaultScene();
    const cam = createPrevizObject('camera', scene.objects);
    return { scene: { ...scene, objects: [cam] }, cam };
  }

  function lastGl(): FakeWebGLRenderer {
    return webglRenderers[webglRenderers.length - 1]!;
  }

  it('pins the drawing buffer to the output size and hands over the viewport canvas', async () => {
    const { canvas, instance } = await createRenderer({ width: 800, height: 450 });
    const { scene } = sceneWithCamera();
    instance.setScene({ ...scene, settings: { ...scene.settings, outputAspect: '9:16' } });
    step();
    const gl = lastGl();
    gl.setPixelRatio.mockClear();
    gl.setSize.mockClear();
    // object-fit 必须赶在 setSize 之前落下：位图一改尺寸，下一次合成就按 CSS 盒子拉伸。
    let fitAtResize = '';
    gl.setSize.mockImplementationOnce(() => {
      fitAtResize = canvas.style.objectFit;
    });

    const pass = instance.startRecording('global', null)!;
    try {
      const { width, height } = OUTPUT_PIXEL_SIZE['9:16'];
      expect(pass.width).toBe(width);
      expect(pass.height).toBe(height);
      // 编码器接的就是视口那块 DOM 画布：没有第二块画布，也没有像素读回。
      expect(pass.canvas).toBe(canvas);
      // DPR 钉成 1：位图尺寸就是出片尺寸，不是出片尺寸再乘 DPR。
      expect(gl.setPixelRatio).toHaveBeenCalledWith(1);
      expect(gl.setSize).toHaveBeenCalledWith(width, height, false);
      expect(canvas.style.objectFit).toBe('contain');
      expect(fitAtResize).toBe('contain');
      // 轨道控制停掉：录制中拖一下视口会改导演视角，而那正是全局录制的出片相机。
      expect(controls.enabled).toBe(false);
    } finally {
      pass.end();
    }
  });

  it('renders each recorded frame once, straight into the default framebuffer', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene({ ...scene, settings: { ...scene.settings, outputAspect: '9:16' } });
    instance.setActiveCamera(cam.id);
    step();
    const gl = lastGl();
    const internals = instance as unknown as {
      monitorCamera: unknown;
      camera: { aspect: number };
    };
    // 相机的 aspect 画完就还回去了，只能在 render() 那一刻取样。
    const seen: Array<{ camera: unknown; aspect: number }> = [];
    render.mockImplementation((_scene: unknown, camera: unknown) => {
      seen.push({ camera, aspect: (camera as { aspect: number }).aspect });
    });

    const pass = instance.startRecording('global', null)!;
    render.mockClear();
    try {
      pass.drawFrame(0, cam.id);
      expect(render).toHaveBeenCalledTimes(1);
      expect(seen[0]?.camera).toBe(internals.monitorCamera);

      pass.drawFrame(1, null);
      expect(render).toHaveBeenCalledTimes(2);
      expect(seen[1]?.camera).toBe(internals.camera);
      // 导演视角借来出片要按出片画幅取景，不是视口的 16:9；画完立刻还回去。
      expect(seen[1]?.aspect).toBeCloseTo(aspectRatio('9:16'));
      expect(internals.camera.aspect).toBeCloseTo(800 / 450);

      for (const call of gl.setRenderTarget.mock.calls) expect(call[0]).toBeNull();
      expect(gl.readRenderTargetPixels).not.toHaveBeenCalled();
    } finally {
      render.mockReset();
      pass.end();
    }
  });

  it('keeps the editor view and the monitor inset off the canvas until the pass ends', async () => {
    const { canvas, instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene(scene);
    instance.setActiveCamera(cam.id);
    step();
    const gl = lastGl();

    const pass = instance.startRecording('global', null)!;
    pass.drawFrame(0, cam.id);
    render.mockClear();
    gl.setSize.mockClear();
    gl.setPixelRatio.mockClear();

    // setFrame 顺手标了 needsRender。录制期间那条 rAF 循环不许把编辑视图或监看框画到
    // 画布上盖掉刚出的那一帧：captureStream 采的就是画布此刻的内容。
    instance.setFrame(3);
    instance.requestRender();
    step();
    expect(render).not.toHaveBeenCalled();
    // 循环本身要活着，pass 结束后不必重新起。
    expect(frames).toHaveLength(1);

    // 视口尺寸变了也不动位图：它此刻钉在出片分辨率上，新尺寸留到 end() 再落。
    setClientSize(canvas, 640, 360);
    instance.resize();
    expect(gl.setSize).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();

    pass.end();
    expect(canvas.style.objectFit).toBe('');
    expect(controls.enabled).toBe(true);
    expect(gl.setPixelRatio).toHaveBeenLastCalledWith(Math.min(window.devicePixelRatio, 2));
    expect(gl.setSize).toHaveBeenLastCalledWith(640, 360, false);
    // 录制中攒下的那次尺寸变化在这里落地，并当场画一帧，别让画布空着等下一次 rAF。
    expect(render).toHaveBeenCalled();
  });

  it('refuses to move the director camera while recording', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene(scene);
    instance.setSelection(cam.id);
    step();

    const pass = instance.startRecording('global', null)!;
    const before = instance.cameraPositionForTest();
    const targetBefore = targetOf();

    // 停掉 OrbitControls 只挡住了鼠标。H 与 F、以及视口控件上那几个按钮走的是这三个
    // 方法：录制中跳一下机位，后面每一帧都换了取景，而成片上看不出发生过什么。
    instance.resetView();
    instance.applyViewDirection('top');
    instance.focusObject(cam.id);

    expect(instance.cameraPositionForTest()).toEqual(before);
    expect(targetOf()).toEqual(targetBefore);

    pass.end();
    // 录完就该还能用：这是录制期间的临时锁，不是把这几个功能拆了。
    instance.applyViewDirection('top');
    expect(instance.cameraPositionForTest()).not.toEqual(before);
  });

  it('stands the offscreen previews down while recording', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene(scene);
    // 得先选中点什么：手柄没挂在对象上的时候本来就该是隐藏的，不选的话末尾那条
    // 「录完要还回来」全程都是 false，守卫删了也绿。
    instance.setSelection(cam.id);
    step();
    const gl = lastGl();

    // 这块画布得能真交出 2D 上下文：`blitCameraToCanvas` 拿不到上下文就直接 return，
    // 一句 `getContext: () => null` 会让下面那条「一笔都没画」永远绿——守卫删了也绿。
    const previewCanvas = {
      width: 320,
      height: 180,
      getContext: () => ({
        fillStyle: '',
        fillRect: () => {},
        createImageData: (width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4),
          width,
          height,
        }),
        putImageData: () => {},
      }),
    } as unknown as Parameters<typeof instance.renderQuadPreview>[0];

    /** 轨迹与手柄这类编辑期辅助物此刻藏没藏住。 */
    type HelperChild = { userData: Record<string, unknown>; visible: boolean };
    const helpersHidden = () =>
      (instance as unknown as { scene: { children: HelperChild[] } }).scene.children
        .filter((child) => child.userData.previzEditorOnly)
        .every((child) => !child.visible);

    const pass = instance.startRecording('track', cam.id)!;
    pass.drawFrame(0, null);
    render.mockClear();

    // 四视图是跟着播放头重画的，而播放头正是录制在推——每三帧就来一次。
    instance.renderQuadPreview(previewCanvas, 'top');
    instance.renderCameraView(previewCanvas, cam.id);
    const draft = createCameraDraft(instance.viewPose());
    instance.renderCameraPreview(previewCanvas, draft);

    // 一笔都没画：这三条路各自都是几趟离屏 pass 加同步读回，正是这次改动要删掉的开销。
    expect(render).not.toHaveBeenCalled();
    expect(gl.readRenderTargetPixels).not.toHaveBeenCalled();
    // 更要紧的是它们的 finally 会把可见性「还」成可见：还回去之后，手柄与轨迹就被烤进
    // 后面每一帧成片里。三块预览都还手柄，只有 `renderCameraView` 连轨迹描边一起还，
    // 所以两样都要断言，少一样就有两块预览的守卫删掉也没人报。
    expect(gizmoHelper.visible).toBe(false);
    expect(helpersHidden()).toBe(true);

    pass.end();
    expect(helpersHidden()).toBe(false);
    expect(gizmoHelper.visible).toBe(true);
  });

  it('refuses to grab a still while recording', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene(scene);
    instance.setActiveCamera(cam.id);
    step();

    /** 轨迹与手柄这类编辑期辅助物此刻藏没藏住。 */
    type HelperChild = { userData: Record<string, unknown>; visible: boolean };
    const helpersHidden = () =>
      (instance as unknown as { scene: { children: HelperChild[] } }).scene.children
        .filter((child) => child.userData.previzEditorOnly)
        .every((child) => !child.visible);

    const pass = instance.startRecording('global', null)!;
    pass.drawFrame(0, null);
    render.mockClear();

    // 出图那条路和三块离屏预览是同一个毛病：它的 finally 把辅助物一律还成可见，还完
    // 手柄与轨迹就烤进后面每一帧成片里。编辑器那边按钮是禁着的，但守卫得在这一层。
    const still = await instance.capture().catch(() => 'threw' as const);
    expect(still).toBeNull();
    expect(render).not.toHaveBeenCalled();
    expect(gizmoHelper.visible).toBe(false);
    expect(helpersHidden()).toBe(true);

    pass.end();
    expect(helpersHidden()).toBe(false);
  });

  /** 出片画面里不该出现的三样东西各自的标记。 */
  const FURNITURE = ['previzGrid', 'previzMarker', 'previzCameraModel'] as const;
  type FurnitureNode = {
    userData: Record<string, unknown>;
    visible: boolean;
    children?: FurnitureNode[];
  };
  type Tally = Record<(typeof FURNITURE)[number], { found: number; drawn: number }>;

  /**
   * 数一遍这棵树上的辅助物：找到几个、其中几个真画得出来。
   *
   * 看的是**有效**可见性，自己走一趟而不是用 three 的 `traverse`：只要有一级祖先关了
   * three 就整棵不画，而辨识环是整组藏起来的，环与箭头自己那面开关一直没动过——只看
   * 节点自己的 `visible`，藏得好好的东西会报成露在画面里。
   */
  function tallyFurniture(root: FurnitureNode): Tally {
    const tally = Object.fromEntries(
      FURNITURE.map((key) => [key, { found: 0, drawn: 0 }]),
    ) as Tally;
    const walk = (node: FurnitureNode, inherited: boolean) => {
      const drawn = inherited && node.visible;
      for (const key of FURNITURE) {
        if (!node.userData[key]) continue;
        tally[key].found += 1;
        if (drawn) tally[key].drawn += 1;
      }
      for (const child of node.children ?? []) walk(child, drawn);
    };
    walk(root, true);
    return tally;
  }

  it('keeps the ground, the markers and the camera models out of recorded frames', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const scene = createDefaultScene();
    const hero = createPrevizObject('character', scene.objects);
    const cam = createPrevizObject('camera', [hero]);
    instance.setScene({ ...scene, objects: [hero, cam] });
    step();

    /*
      成片里只该有布景与演员。地面网格是编辑期的空间参照，人物脚下那圈辨识环是画在
      场景里的界面，机位的机身与视锥是器材——三样都不是镜头里的东西，用户拿到的 9:16
      成片里却三样俱全（环与锥体尤其扎眼，锥体的线糊满整幅画）。

      必须在 `render()` 被调用的**那一刻**取样：藏起来是借的，pass 结束就还回去了，
      事后翻 mock.calls 里那个场景对象，读到的永远是还完之后的状态。
    */
    let tally: Tally | null = null;
    render.mockImplementation((target: unknown) => {
      tally = tallyFurniture(target as FurnitureNode);
    });

    const pass = instance.startRecording('global', null)!;
    pass.drawFrame(0, null);

    for (const key of FURNITURE) {
      // 先确认真找着了：找不到的话「一个都没画」是空欢喜，标记改名就悄悄失效。
      expect(tally![key].found, key).toBeGreaterThan(0);
      expect(tally![key].drawn, key).toBe(0);
    }

    // 借出去要还：留在隐藏状态，录完一次编辑视图就永久少了地面、辨识环与机位。
    pass.end();
    const restored = tallyFurniture(
      (instance as unknown as { scene: FurnitureNode }).scene,
    );
    for (const key of FURNITURE) {
      expect(restored[key].drawn, key).toBe(restored[key].found);
    }
  });

  it('ends once, and hands the helpers and the live camera back', async () => {
    const { instance } = await createRenderer({ width: 800, height: 450 });
    const { scene, cam } = sceneWithCamera();
    instance.setScene(scene);
    step();
    const node = instance.nodeFor(cam.id)!;
    const gl = lastGl();

    type Traversable = {
      traverse(
        callback: (object: { userData: Record<string, unknown>; visible: boolean }) => void,
      ): void;
    };
    // 每趟 pass 收一格：这一趟里的辅助物是不是全都看得见。地面与轨迹预览都挂着这个
    // 标记，一趟里不止一个，逐个收进同一个平数组的话「几趟」和「几个」就分不开了。
    const helpersSeen: (boolean | null)[] = [];
    render.mockImplementation((target: unknown) => {
      const seen: boolean[] = [];
      (target as Traversable).traverse((object) => {
        if (object.userData.previzEditorOnly) seen.push(object.visible);
      });
      helpersSeen.push(seen.length === 0 ? null : seen.every(Boolean));
    });

    const pass = instance.startRecording('track', cam.id)!;
    // 单轨录制开录就把机位藏起来，整段都藏着。
    expect(node.visible).toBe(false);
    pass.drawFrame(0, null);
    expect(helpersSeen).toEqual([false]);

    gl.setSize.mockClear();
    pass.end();
    pass.end();
    render.mockReset();

    expect(node.visible).toBe(true);
    // end() 里那次 resize() 当场画的一帧：辅助物已经还回来了。
    expect(helpersSeen.slice(1)).toEqual([true]);
    // 第二次 end() 不再重设尺寸、也不再画。
    expect(gl.setSize).toHaveBeenCalledTimes(1);
  });
});

describe('PrevizRenderer 松手落地', () => {
  /** 一个人物加若干道具，各自摆在给定位置上。 */
  function dropScene(characterY: number, ...propPositions: Vec3[]): PrevizScene {
    const scene = createDefaultScene();
    scene.objects.push(
      createPrevizObject('character', scene.objects, {
        transform: { position: [0, characterY, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      }),
    );
    for (const position of propPositions) {
      scene.objects.push(
        createPrevizObject('prop', scene.objects, {
          transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
        }),
      );
    }
    return scene;
  }

  // 原点不在脚底：假 Box3 默认盒底恰好等于对象原点，那种形状下「按位移挪」和
  // 「y = 命中高度」算出来一模一样，这一层压根分不开这两件事。把盒底挪到原点下方
  // 0.5 米（导入的 obj 原点常在几何中心），两者才有区别。
  const FOOT_BELOW_ORIGIN = -0.5;

  it('drops a character onto the surface it hit, moving by the offset not onto it', async () => {
    const { instance } = await createRenderer();
    boxMinYOffset = FOOT_BELOW_ORIGIN;
    const scene = dropScene(3, [0, 0, 0]);
    instance.setScene(scene);
    // 桌面在 0.75。人物原点在 3、盒底在 2.5，落完盒底该在 0.75，即原点在 1.25。
    // 直接把 y 赋成 0.75 的话人物半截埋进桌子里。
    intersections = [{ object: {}, point: { x: 0, y: 0.75, z: 0 } }];

    expect(instance.dropToSurface(scene.objects[0].id)).toBeCloseTo(1.25, 12);
  });

  // 场景里没有可命中的地面：`grid.ts` 把地面的 raycast 整个摘掉了（铺满视野的话每次
  // 空点都会命中它）。所以「没命中」不是异常，是绝大多数落地的正常情形，必须当成
  // y=0 那块地面——退回 null 的话在平地上拖东西永远不会落地。
  it('falls to the ground plane when the ray hits nothing', async () => {
    const { instance } = await createRenderer();
    boxMinYOffset = FOOT_BELOW_ORIGIN;
    const scene = dropScene(5);
    instance.setScene(scene);
    intersections = [];

    expect(instance.dropToSurface(scene.objects[0].id)).toBeCloseTo(0.5, 12);
  });

  // 反方向也得成立，而且这一条才证明射线是从盒**顶**往下打的：从盒底往下打的话，
  // 沉在地板以下的对象只会继续往下找，永远浮不回来。
  it('lifts a character that sank below the ground back onto it', async () => {
    const { instance } = await createRenderer();
    boxMinYOffset = FOOT_BELOW_ORIGIN;
    const scene = dropScene(-3);
    instance.setScene(scene);
    intersections = [];

    expect(instance.dropToSurface(scene.objects[0].id)).toBeCloseTo(0.5, 12);
  });

  it('aims the ray straight down from just above the top of the box', async () => {
    const { instance } = await createRenderer();
    const scene = dropScene(2, [4, 0, 0]);
    instance.setScene(scene);
    intersections = [];

    instance.dropToSurface(scene.objects[0].id);

    const [origin, direction] = raySet.mock.calls[0] as [
      { x: number; y: number; z: number },
      { x: number; y: number; z: number },
    ];
    // 盒子是 [-1,2,-1]..[1,4,1]：水平取中心，竖直取顶面再抬一个 epsilon。
    expect(origin.x).toBe(0);
    expect(origin.z).toBe(0);
    expect(origin.y).toBe(dropRayOriginY(4));
    // 朝上打的话对象会被吸到头顶那块天花板上，而画面上只是「它自己飞起来了」。
    expect([direction.x, direction.y, direction.z]).toEqual([0, -1, 0]);
  });

  // 不剔掉自己的话，从盒顶往下打第一个命中的永远是对象自身的顶面，落地变成
  // 「把盒底抬到盒顶」——每松一次手对象就往上跳一个身位。
  it('keeps the object itself out of the candidates it rays against', async () => {
    const { instance } = await createRenderer();
    const scene = dropScene(2, [4, 0, 0]);
    instance.setScene(scene);
    intersections = [];

    instance.dropToSurface(scene.objects[0].id);

    const candidates = intersectObjects.mock.calls[0][0] as unknown[];
    expect(candidates).not.toContain(instance.nodeFor(scene.objects[0].id));
    expect(candidates).toContain(instance.nodeFor(scene.objects[1].id));
    // 递归：对象节点自己是个空 Group，几何体全在它下面那层占位体 / 模型里。
    expect(intersectObjects.mock.calls[0][1]).toBe(true);
  });

  // 机位与灯本来就该浮在空中。把一台俯拍机吸到地板上，取景当场毁掉，而用户只是
  // 拖了一下位置。
  it('refuses to drop a camera or a light', async () => {
    const { instance } = await createRenderer();
    const scene = createDefaultScene();
    for (const kind of ['camera', 'light'] as const) {
      scene.objects.push(
        createPrevizObject(kind, scene.objects, {
          transform: { position: [0, 5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        }),
      );
    }
    instance.setScene(scene);
    intersections = [];

    expect(instance.dropToSurface(scene.objects[0].id)).toBeNull();
    expect(instance.dropToSurface(scene.objects[1].id)).toBeNull();
  });

  // 模型还在下载 / 下载失败时节点下面一个几何体都没有，包围盒是空的。这里必须自己
  // `new Box3().setFromObject()` 再判 `isEmpty()`，不能图省事复用 `boundsOf()`——那个
  // 函数会把空盒换成一个人体尺寸的**占位盒**（那是给聚焦用的产品行为），拿它落地
  // 等于按一个假盒子把对象瞬移走，而且完全看不出发生过什么。
  it('declines while the object still has no geometry', async () => {
    const { instance } = await createRenderer();
    const scene = dropScene(5);
    instance.setScene(scene);
    boxIsEmpty = true;
    intersections = [];

    expect(instance.dropToSurface(scene.objects[0].id)).toBeNull();
  });

  // 端到端：渲染器有没有真的把这套算法接到手柄上。上面那些用例全是直接调方法的，
  // 接线那一行删掉它们一条都不红——而少了那一行，松手就是彻底不落地。
  it('drops the object when a free-move drag ends in the viewport', async () => {
    const { instance } = await createRenderer();
    boxMinYOffset = FOOT_BELOW_ORIGIN;
    const scene = dropScene(5);
    instance.setScene(scene);
    instance.setGizmoMode('translate');
    instance.setSelection(scene.objects[0].id);
    intersections = [];

    transformControls.axis = 'XYZ';
    transformControls.emit('dragging-changed', { value: true });
    transformControls.emit('objectChange');
    transformControls.emit('dragging-changed', { value: false });

    expect(instance.nodeFor(scene.objects[0].id)?.position.y).toBeCloseTo(0.5, 12);
  });
});
