// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { PREVIZ_DEFAULT_HEIGHT_CM } from '../domain/objects';
import type { PrevizScene, Vec3 } from '../domain/scene';
import {
  PREVIZ_DEFAULT_VIEW,
  boundsCenter,
  boundsRadius,
  framingDistance,
  unionBounds,
  viewPlacement,
  type PrevizBounds,
  type PrevizViewDirection,
} from '../domain/view';
import { PREVIZ_PLACEHOLDER_RADIUS, PrevizSceneGraph, type ThreeModule } from './sceneGraph';

const GROUND_SIZE_METERS = 20;
const GROUND_DIVISIONS = 20;
// 上限 2：3x DPR 设备按原生比例渲染是 9 倍像素，收益远小于开销。
const MAX_PIXEL_RATIO = 2;

/** 编辑视角的视场角。刻意与机位的 focalMm 无关：这是自由飞行相机，不是取景器。 */
const EDITOR_FOV_DEG = 50;

/**
 * 节点交不出包围盒时的占位尺寸，单位米。尺寸不是新编的，直接沿用场景图那两个常量：
 * 默认身高与占位胶囊半径。这样「没有几何体的对象在取景里占多大」和「占位体画多大」
 * 是同一份真相，日后调一处不会两边漂移。
 */
const PLACEHOLDER_HEIGHT_M = PREVIZ_DEFAULT_HEIGHT_CM / 100;
const PLACEHOLDER_HALF_WIDTH_M = PREVIZ_PLACEHOLDER_RADIUS;

/**
 * three.js 渲染层。构造走静态 create() 而不是 new：three 与 OrbitControls 都在
 * 里面动态 import，只有真正打开预演台才下载那个 chunk。顶层只有 type import，
 * 编译后会被完全擦除，不会把 three 拉进首屏。
 */
export class PrevizRenderer {
  private rafHandle = 0;
  private disposed = false;
  private needsRender = true;
  /** 懒建：从不点画布的会话不需要它。Raycaster 没有 dispose()，纯数学对象，不用还。 */
  private raycaster: THREE.Raycaster | null = null;
  private currentScene: PrevizScene | null = null;
  private selectionId: string | null = null;

  private constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls,
    private readonly canvas: HTMLCanvasElement,
    private readonly three: ThreeModule,
    private readonly graph: PrevizSceneGraph,
  ) {}

  static async create(canvas: HTMLCanvasElement): Promise<PrevizRenderer> {
    const [three, controlsModule] = await Promise.all([
      import('three'),
      import('three/examples/jsm/controls/OrbitControls.js'),
    ]);

    const renderer = new three.WebGLRenderer({ canvas, antialias: true });

    const scene = new three.Scene();
    scene.background = new three.Color(0x101216);
    scene.add(new three.GridHelper(GROUND_SIZE_METERS, GROUND_DIVISIONS, 0x3a4150, 0x232833));
    scene.add(new three.AmbientLight(0xffffff, 1.2));

    const keyLight = new three.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(4, 8, 6);
    scene.add(keyLight);

    const camera = new three.PerspectiveCamera(EDITOR_FOV_DEG, 1, 0.1, 500);
    camera.position.set(...PREVIZ_DEFAULT_VIEW.position);

    // 场景对象全部挂在这个组下面，和地面网格 / 常驻灯光分开：拾取与聚焦只看它，
    // 不会误命中网格，场景图 dispose 时也不会顺手把常驻光源清掉。
    const objectRoot = new three.Group();
    scene.add(objectRoot);

    const controls = new controlsModule.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    // 轨道中心抬到地面之上 1 米，给后续落在网格上的主体留出视觉空间；
    // 代价是网格中心从画面正中下移到约 60% 高度处。
    controls.target.set(...PREVIZ_DEFAULT_VIEW.target);
    controls.update();

    const instance = new PrevizRenderer(
      renderer,
      scene,
      camera,
      controls,
      canvas,
      three,
      new PrevizSceneGraph(three, objectRoot),
    );
    // 滚轮缩放走的是 OrbitControls 的 wheel 处理器：它自己就把 update() 调了、
    // 把 _scale 消化干净，只留下这个 change 事件。tick 里那次 update() 只会拿到
    // false，不订阅 change 的话相机确实动了、屏幕上却一帧都不重绘——缩放看起来
    // 就是彻底失灵，直到下一次拖拽（阻尼余速能让 update() 连着返回 true）才补上。
    controls.addEventListener('change', () => instance.requestRender());
    instance.resize();
    instance.start();
    return instance;
  }

  /** 跟随容器尺寸重设画布与相机宽高比；ResizeObserver 回调直接调它。 */
  resize(): void {
    if (this.disposed) return;
    // `|| 1`：容器尚未布局时 clientWidth 为 0，0/0 会把 aspect 变成 NaN，
    // 进而毒掉整个投影矩阵。别顺手精简掉。
    const width = this.canvas.clientWidth || 1;
    const height = this.canvas.clientHeight || 1;
    // 每次 resize 都重设，而不是只在 create() 设一次：浏览器缩放会同时改变
    // devicePixelRatio 和视口 CSS 尺寸，全屏画布因此会走到这里。
    // 注意：拖到不同 DPR 的显示器只改 DPR、不改 CSS 尺寸，ResizeObserver 不会触发，
    // 这条路径当前覆盖不到。
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // updateStyle=false：尺寸由 CSS 决定，渲染器只跟随，别反过来写死 style。
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /**
   * 场景内容变化后调用，请求下一帧重绘。相机自身的移动不需要调它——
   * tick 里 `controls.update()` 的返回值已经覆盖了那条路径。
   */
  requestRender(): void {
    this.needsRender = true;
  }

  /** 灌入当前场景。编辑器每次 store 变化都调它，代价是一次 Map 查表加几次赋值。 */
  setScene(scene: PrevizScene): void {
    if (this.disposed) return;
    this.currentScene = scene;
    this.graph.sync(scene);
    this.requestRender();
  }

  /**
   * 记下当前选中的对象。眼下只有取景读它（切视图时框选中的那个）；选中高亮与手柄
   * 是 Task 10 的事。
   */
  setSelection(objectId: string | null): void {
    this.selectionId = objectId;
  }

  nodeFor(objectId: string): THREE.Object3D | undefined {
    return this.graph.nodeFor(objectId);
  }

  /**
   * 切到某个轴对齐方向的视角。有选中对象就框选中的，否则框全场景可见对象；场景空了
   * 回落到占位包围盒——否则空场景点「顶视图」会把注视点算到一个没有意义的地方。
   */
  applyViewDirection(direction: PrevizViewDirection): void {
    const placement = viewPlacement(
      direction,
      this.currentBounds(),
      EDITOR_FOV_DEG,
      this.camera.aspect,
    );
    this.moveCamera(placement.position, placement.target);
  }

  /** 聚焦某个对象（F 键）。对象不存在时什么都不做，别把相机甩到原点。 */
  focusObject(objectId: string): void {
    const node = this.graph.nodeFor(objectId);
    if (!node) return;
    const bounds = this.boundsOf(node);
    const target = boundsCenter(bounds);
    // 保持当前观察方向，只调距离和注视点：聚焦不该顺手把用户转过的角度也重置掉。
    const offset: Vec3 = [
      this.camera.position.x - this.controls.target.x,
      this.camera.position.y - this.controls.target.y,
      this.camera.position.z - this.controls.target.z,
    ];
    // `|| 1`：相机正好停在注视点上时长度是 0，除下去是 NaN。方向随便取一个都行，
    // 这里让它退化成沿 +X 退开，至少画面还在。
    const length = Math.hypot(offset[0], offset[1], offset[2]) || 1;
    const distance = framingDistance(boundsRadius(bounds), EDITOR_FOV_DEG, this.camera.aspect);
    this.moveCamera(
      [
        target[0] + (offset[0] / length) * distance,
        target[1] + (offset[1] / length) * distance,
        target[2] + (offset[2] / length) * distance,
      ],
      target,
    );
  }

  resetView(): void {
    this.moveCamera([...PREVIZ_DEFAULT_VIEW.position], [...PREVIZ_DEFAULT_VIEW.target]);
  }

  /**
   * 画布坐标下的拾取，返回对象 id，点空处返回 null。命中的一定是占位体或模型里的
   * 子网格，所以要沿 parent 往上走到挂着 previzObjectId 的那个组。
   */
  pickAt(clientX: number, clientY: number): string | null {
    if (this.disposed) return null;
    if (!this.raycaster) this.raycaster = new this.three.Raycaster();
    const rect = this.canvas.getBoundingClientRect();
    // `|| 1`：容器尚未布局时宽高为 0，除下去是 NaN，射线方向整个是 NaN。
    const width = rect.width || 1;
    const height = rect.height || 1;
    // NDC 的 y 轴朝上，而画布坐标朝下，所以这一路要取反。
    const pointer = new this.three.Vector2(
      ((clientX - rect.left) / width) * 2 - 1,
      -((clientY - rect.top) / height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);

    const hits = this.raycaster.intersectObjects(this.pickableNodes(), true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node) {
        const id: unknown = node.userData.previzObjectId;
        if (typeof id === 'string') return id;
        node = node.parent;
      }
    }
    return null;
  }

  /**
   * 参与拾取与「框全场景」的节点：场景里可见的那些对象。
   *
   * 必须自己剔掉隐藏的对象。three 0.185 的 `Raycaster.intersect()` 只测 `layers`，
   * `Mesh.raycast()` 里也没有 visible 检查——隐藏的对象在屏幕上看不见，射线却照样
   * 打得中，表现是点空白处选中了一个「不存在」的东西。
   */
  private pickableNodes(): THREE.Object3D[] {
    const nodes: THREE.Object3D[] = [];
    for (const object of this.currentScene?.objects ?? []) {
      if (!object.visible) continue;
      const node = this.graph.nodeFor(object.id);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  /**
   * 节点的世界包围盒。空盒（`Box3.makeEmpty()` 的初值 min=+∞ / max=-∞，即这个节点
   * 下面还没有任何几何体：模型正在加载，或者加载失败了）换成一个人体尺寸的占位盒。
   *
   * `domain/view.ts` 拿到空盒不会算出 NaN——它把非有限的轴收敛成一个点——但那答的是
   * 「数学上怎么兜底」，这里答的是「用户点了聚焦、可对象没有几何体，画面上该看到
   * 什么」。占位盒挂在对象自己的世界位置上：固定在原点的话，聚焦一个远处的空对象会
   * 把相机甩回场景中心。
   */
  private boundsOf(node: THREE.Object3D): PrevizBounds {
    const box = new this.three.Box3().setFromObject(node);
    if (!box.isEmpty()) {
      return {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
      };
    }
    const origin = node.getWorldPosition(new this.three.Vector3());
    return placeholderBounds(origin.x, origin.y, origin.z);
  }

  /** 这次取景要框的东西：选中的那个，否则全部可见对象，再否则原点上的占位盒。 */
  private currentBounds(): PrevizBounds {
    const selected = this.selectionId ? this.graph.nodeFor(this.selectionId) : undefined;
    if (selected) return this.boundsOf(selected);

    const all = this.pickableNodes().map((node) => this.boundsOf(node));
    return unionBounds(all) ?? placeholderBounds(0, 0, 0);
  }

  private moveCamera(position: Vec3, target: Vec3): void {
    this.camera.position.set(position[0], position[1], position[2]);
    this.controls.target.set(target[0], target[1], target[2]);
    // OrbitControls.update() 会按新的 position/target 重算球坐标、夹进各条限制，
    // 并调 object.lookAt(target) 把姿态摆正；不调的话相机位置变了、朝向还是旧的。
    this.controls.update();
    this.requestRender();
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      // update() 返回 true 表示相机确实动了（阻尼余速也算）。静止时跳过 render，
      // 否则一个只有网格和两盏灯的静态场景会在全屏里 60fps 空烧 GPU。
      if (this.controls.update() || this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.scene, this.camera);
      }
      this.rafHandle = window.requestAnimationFrame(tick);
    };
    this.rafHandle = window.requestAnimationFrame(tick);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.rafHandle);
    this.controls.dispose();
    // 必须排在下面那次 traverse 之前：场景图会把自己的节点从对象根上摘掉再还资源，
    // 顺序反过来的话同一批几何体与材质会被 dispose 两遍。
    this.graph.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material?.dispose();
    });
    this.renderer.dispose();
    // dispose() 只摘监听、清 three 自己的 cache，不还底层 WebGL context（three 0.185
    // 实测）。浏览器并发 context 上限约 16 个，而预演台是反复开关的，不显式归还的话
    // 开到后面会静默黑屏。必须在 dispose() 之后调：dispose() 已经摘掉了
    // 'webglcontextlost' 监听，此时 loseContext() 不会再触发 three 的 onContextLost
    // （那个 handler 会打一行 "WebGLRenderer: Context Lost." 噪音日志）。
    this.renderer.forceContextLoss();
  }

  /** 测试用：断言相机机位不必去戳 three 的内部对象。 */
  cameraPositionForTest(): Vec3 {
    return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  /** 测试用：确认编辑视角的视场角不随出片画幅变化。 */
  editorFovForTest(): number {
    return this.camera.fov;
  }
}

/** 站在 (x, y, z) 上、脚底贴 y 的一个人体尺寸盒子。 */
function placeholderBounds(x: number, y: number, z: number): PrevizBounds {
  return {
    min: [x - PLACEHOLDER_HALF_WIDTH_M, y, z - PLACEHOLDER_HALF_WIDTH_M],
    max: [x + PLACEHOLDER_HALF_WIDTH_M, y + PLACEHOLDER_HEIGHT_M, z + PLACEHOLDER_HALF_WIDTH_M],
  };
}
