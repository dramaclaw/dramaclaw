// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { PrevizRecordMode } from '../capture/recordTarget';
import { createDomCaptureCanvas, createFramePainter, renderCapture } from '../capture/renderCapture';
import { OUTPUT_PIXEL_SIZE, aspectRatio, coverFovDeg, DEG_TO_RAD } from '../domain/camera';
import type { PrevizCameraDraft } from '../domain/cameraDraft';
import { evaluateSceneAt } from '../domain/evaluate';
import { PREVIZ_DEFAULT_HEIGHT_CM } from '../domain/objects';
import type { PrevizScene, PrevizTransform, Vec3 } from '../domain/scene';
import {
  PREVIZ_DEFAULT_VIEW,
  boundsCenter,
  boundsRadius,
  framingDistance,
  orthoPlacement,
  unionBounds,
  viewPlacement,
  type PrevizBounds,
  type PrevizViewDirection,
  type PrevizViewPlacement,
} from '../domain/view';
import { setFrustumLive } from './cameraModel';
import { monitorViewportRect, syncMonitorCamera, type MonitorSize } from './cameraRig';
import {
  blitCameraToCanvas,
  renderCameraPreview,
  type CameraPreviewCanvas,
} from './cameraPreview';
import { renderOrthoPreview } from './orthoPreview';
import { CharacterRigFactory } from './characterRig';
import { PrevizPathPreview } from './pathPreview';
import { PrevizStrokePreview } from './strokePreview';
import { PrevizGizmo, type GizmoMode, type TransformControlsLike } from './gizmo';
import { createInfiniteGrid } from './grid';
import { PropLoader } from './propLoader';
import { PREVIZ_PLACEHOLDER_RADIUS, PrevizSceneGraph, type ThreeModule } from './sceneGraph';
import { PrevizViewOverlays, type PrevizViewOverlayOptions } from './viewOverlays';

// 上限 2：3x DPR 设备按原生比例渲染是 9 倍像素，收益远小于开销。
const MAX_PIXEL_RATIO = 2;

/** 编辑视角的视场角。刻意与机位的 focalMm 无关：这是自由飞行相机，不是取景器。 */
const EDITOR_FOV_DEG = 50;

/**
 * 一次录制的句柄。`canvas` 是接给编码器的那块离屏画布，尺寸恒等于出片分辨率。
 * 用完必须 `end()`：辅助物的可见性与渲染目标都攥在它手里。
 */
export interface PrevizRecordingPass {
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** 全局录制每帧传镜头轨当前机位（null 走导演视角）；单轨录制忽略这个参数。 */
  drawFrame(frame: number, cameraId: string | null): void;
  end(): void;
}

/** 视口里点中的那个轨迹点。带上 clipId 是因为点 id 只在自己那条轨迹里唯一。 */
export interface PrevizPathPointPick {
  clipId: string;
  pointId: string;
}

/**
 * 节点交不出包围盒时的占位尺寸，单位米。尺寸不是新编的，直接沿用场景图那两个常量：
 * 默认身高与占位胶囊半径。这样「没有几何体的对象在取景里占多大」和「占位体画多大」
 * 是同一份真相，日后调一处不会两边漂移。
 */
const PLACEHOLDER_HEIGHT_M = PREVIZ_DEFAULT_HEIGHT_CM / 100;
const PLACEHOLDER_HALF_WIDTH_M = PREVIZ_PLACEHOLDER_RADIUS;

/**
 * 求值器会写回的那两项变了没有。
 *
 * 缩放不算：它不参与求值，跟着算的话缩放一个带轨迹的对象会把它按在原地不动。
 */
function samePlacement(a: PrevizTransform, b: PrevizTransform): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.rotation[0] === b.rotation[0] &&
    a.rotation[1] === b.rotation[1] &&
    a.rotation[2] === b.rotation[2]
  );
}

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
  private gizmo: PrevizGizmo | null = null;
  private monitorCamera: THREE.PerspectiveCamera | null = null;
  /** 监看画中画的大小档位。 */
  private monitorSize: MonitorSize = 'normal';
  /** 描边与名牌。 */
  private overlays: PrevizViewOverlays | null = null;
  /** 摄影机创建对话框的取景预览相机，第一次画预览时建，之后一直留着。 */
  private previewCamera: THREE.PerspectiveCamera | null = null;
  /** 四视图那两块正交预览共用的相机，第一次画时建。 */
  private orthoCamera: THREE.OrthographicCamera | null = null;
  /** 右下角监看当前看的是哪个机位。null 就是不画监看。 */
  private activeCameraId: string | null = null;
  /** 镜头轨当前直播的机位；视锥涂红。与 `activeCameraId`（监看/操作对象）无关。 */
  private liveCameraId: string | null = null;
  /** 播放头当前帧。场景灌进来时按它解算一次，之后每次移动播放头再解算。 */
  private currentFrame = 0;
  /**
   * 这些对象的位置是人手摆出来的，当前这一帧不许求值器盖回去。
   *
   * 拖手柄改的是静态 transform，而带轨迹的对象每次 setScene 都会被路径覆盖掉——包括
   * 拖动自己提交的那一次，于是画面上「有轨迹的相机拖不动」。upstream 的做法是让手摆
   * 的位置先赢：轨迹一点不改，人停在放下的地方，直到播放头再动才回到轨迹上。
   */
  private readonly handPlaced = new Set<string>();
  private pathPreview: PrevizPathPreview | null = null;
  /** 轨迹预览挂的那一组。拾取轨迹点要单独朝它打射线，见 [pickPathPointAt]。 */
  private pathRoot: THREE.Object3D | null = null;
  private strokePreview: PrevizStrokePreview | null = null;
  private selectedClipId: string | null = null;
  private selectedPointId: string | null = null;
  /** 手柄拖完把变换交回上层（编辑器接到 store 的 updateObject）。 */
  onTransformCommit: ((objectId: string, transform: PrevizTransform) => void) | null = null;
  /**
   * 手柄拖拽期间对象正在动。四视图那两块正交预览靠它跟手。
   *
   * 拖拽中的位置只存在于 three 的节点上——变换要到松手才提交回 store（见 [PrevizGizmo]，
   * 每帧都提交等于毁掉撤销）。只跟着 store 走的话，俯视与侧视会僵在原地、松手才瞬移
   * 过去，而拖动过程恰恰是最需要照着俯视图对位置的时候。
   *
   * 一次拖拽会来几百次，接的人别顺手把整棵编辑器重渲一遍（同 [onViewChange]）。
   */
  onTransformDrag: (() => void) | null = null;
  /**
   * 视口相机动了。拖轨道、滚滚轮、切视角、聚焦都会报，左上角那颗坐标轴球靠它跟手。
   *
   * 拖拽期间每帧都会来一次（含阻尼余速），所以接的人别顺手把整棵编辑器重渲一遍。
   */
  onViewChange: ((view: PrevizViewPlacement) => void) | null = null;

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
    const [three, controlsModule, transformModule, gltfModule, objModule, skeletonUtils] =
      await Promise.all([
        import('three'),
        import('three/examples/jsm/controls/OrbitControls.js'),
        import('three/examples/jsm/controls/TransformControls.js'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/loaders/OBJLoader.js'),
        import('three/examples/jsm/utils/SkeletonUtils.js'),
      ]);

    const renderer = new three.WebGLRenderer({ canvas, antialias: true });

    const scene = new three.Scene();
    scene.background = new three.Color(0x101216);
    // 地面自己跟着当前那台相机走（见 grid.ts），所以这里只管加进场景，不必接线。
    scene.add(createInfiniteGrid(three));
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
    // 中键拖环绕、右键拖平移，任何工具下都可用：滚轮已经负责推拉，中键再推拉是
    // 重复的；中键环绕是 Blender 等 DCC 的通用习惯。
    controls.mouseButtons.MIDDLE = three.MOUSE.ROTATE;
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
    controls.addEventListener('change', () => {
      instance.requestRender();
      // moveCamera 里那次 controls.update() 也走这里：写机位的路径不必各自再报一遍。
      instance.onViewChange?.(instance.viewPose());
    });

    const gltfLoader = new gltfModule.GLTFLoader();
    instance.graph.attachCharacterRig(
      new CharacterRigFactory({
        three,
        loadGltf: (url) => gltfLoader.loadAsync(url),
        // 必须是 SkeletonUtils 的 clone，不是 Object3D.clone()：后者复制 SkinnedMesh 时
        // 仍指向原骨架，第二个人物一摆姿势第一个也跟着动。
        clone: skeletonUtils.clone,
      }),
      // 模型是异步到的，到了之后必须主动请求一帧：按需重绘的循环这时早就静下来了。
      // 顺手补一次描边 / 名牌：这条路径不经过 setScene，少了它后到的 GLB 一直没有描边。
      // 也把当前帧重放一遍：`build()` 摆的是静态姿势，播放头这时可能已经在路径中间，
      // 不重放的话后到的模型会一直站着滑，直到播放头下一次移动。
      () => {
        instance.applyEvaluatedFrame();
        instance.syncOverlays();
        instance.requestRender();
      },
    );

    const objLoader = new objModule.OBJLoader();
    instance.graph.attachPropLoader(
      new PropLoader({
        loadGltf: (url) => gltfLoader.loadAsync(url),
        loadObj: (url) => objLoader.loadAsync(url),
      }),
    );

    // 监看用的是同一个 WebGLRenderer 的第二次 pass。浏览器并发 WebGL 上下文上限
    // 约 16 个，而预演台是反复开关的——再开一个 renderer 迟早静默黑屏。
    instance.monitorCamera = new three.PerspectiveCamera(40, 16 / 9, 0.1, 500);

    instance.overlays = new PrevizViewOverlays(three);

    const transformControls = new transformModule.TransformControls(camera, canvas);
    instance.gizmo = new PrevizGizmo({
      controls: transformControls as unknown as TransformControlsLike,
      orbit: controls,
      // helper 挂在 scene 而不是 objectRoot 下：objectRoot 是拾取与聚焦的取值范围，
      // 手柄挂进去会被射线命中，也会被算进「框全场景」的包围盒里。
      root: scene,
      onCommit: (objectId, transform) => instance.onTransformCommit?.(objectId, transform),
      onChange: () => {
        instance.requestRender();
        instance.onTransformDrag?.();
      },
    });
    // 轨迹预览挂在 scene 而不是 objectRoot 下：objectRoot 是拾取与「框全场景」的取值
    // 范围，曲线挂进去会被射线命中（点轨迹选中人物），也会把包围盒撑到整条路径那么大。
    const previewRoot = new three.Group();
    // 编辑器自己的东西，不是镜头里的东西：见 `setEditorHelpersVisible`。
    previewRoot.userData.previzEditorOnly = true;
    scene.add(previewRoot);
    // 成型轨迹与正在画的那一笔各占一个子组：轨迹预览是整组重建的，两者混在一起的话
    // 每次 store 变化都会把用户手上这一笔连同缓冲一起清掉。
    const pathRoot = new three.Group();
    previewRoot.add(pathRoot);
    const strokeRoot = new three.Group();
    previewRoot.add(strokeRoot);
    instance.pathRoot = pathRoot;
    instance.pathPreview = new PrevizPathPreview(three, pathRoot);
    instance.strokePreview = new PrevizStrokePreview(three, strokeRoot);
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
    // 当场画，不是标 needsRender 等下一帧：ResizeObserver 回调在同一帧里排在 rAF 之后、
    // 绘制之前，而 setSize 一改画布属性位图就被清空。只标记的话这一帧合成出去的是一块
    // 空画布，拖时间轴高度这种每次 pointermove 都改一次尺寸的操作就会一路闪。
    this.renderFrame();
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
    const previous = this.currentScene;
    this.currentScene = scene;
    this.trackHandPlacements(previous, scene);
    this.graph.sync(scene);
    // 节点可能是这次 sync 才建出来的（撤销删除、或 setLiveCamera 先于 setScene），也可能
    // 刚被切显示模式刷掉了颜色，直播色要重新涂上去。
    if (this.liveCameraId) {
      const node = this.graph.nodeFor(this.liveCameraId);
      if (node) setFrustumLive(node, true);
    }
    // 必须排在 sync 之后：sync 每次都把静态 transform 写回节点，先解算就会被它盖掉，
    // 表现是播放中随便改点什么（改个名字都算）人就瞬移回起点。
    this.applyEvaluatedFrame();
    this.pathPreview?.sync(scene, this.selectedClipId, this.selectedPointId);
    this.syncOverlays();
    this.requestRender();
  }

  /** 描边与名牌的开关。 */
  setViewOverlays(options: PrevizViewOverlayOptions): void {
    this.overlays?.setOptions(options);
    this.syncOverlays();
    this.requestRender();
  }

  /** 监看画中画的大小档位。 */
  setMonitorSize(size: MonitorSize): void {
    this.monitorSize = size;
    this.requestRender();
  }

  private syncOverlays(): void {
    const scene = this.currentScene;
    if (!scene) return;
    this.overlays?.sync(scene, (objectId) => this.graph.nodeFor(objectId));
  }

  /**
   * 记下当前选中的对象。眼下只有取景读它（切视图时框选中的那个）；选中高亮与手柄
   * 是 Task 10 的事。
   */
  setSelection(objectId: string | null): void {
    this.selectionId = objectId;
    this.gizmo?.attach(objectId ? (this.graph.nodeFor(objectId) ?? null) : null);
    this.requestRender();
  }

  /** 指定右下角监看看哪个机位。传 null 关掉监看。 */
  setActiveCamera(objectId: string | null): void {
    this.activeCameraId = objectId;
    this.requestRender();
  }

  /** 镜头轨当前直播的机位，视锥点亮 tally 红。传 null 全部熄灭。 */
  setLiveCamera(objectId: string | null): void {
    if (objectId === this.liveCameraId) return;
    if (this.liveCameraId) {
      const previous = this.graph.nodeFor(this.liveCameraId);
      if (previous) {
        setFrustumLive(previous, false);
        // 熄灯只把本色记回去；此刻该显示什么色由显示模式说了算——全灰里是灰，不是橙。
        this.graph.refreshDisplayMode(previous);
      }
    }
    this.liveCameraId = objectId;
    if (objectId) {
      const next = this.graph.nodeFor(objectId);
      if (next) setFrustumLive(next, true);
    }
    this.requestRender();
  }

  /** 把播放头挪到某一帧，并把这一帧的解算结果写进场景。 */
  setFrame(frame: number): void {
    if (this.disposed) return;
    this.currentFrame = frame;
    // 播放头一动，时间轴就把控制权收回去：手摆的那些位置到此为止，对象回到轨迹上。
    this.handPlaced.clear();
    this.applyEvaluatedFrame();
    this.requestRender();
  }

  /**
   * 高亮某条轨迹，以及其中某一个轨迹点。传 null 取消高亮。
   *
   * 两者一起进来而不是各给一个方法：轨迹预览是整组重建的，分两次调用就意味着点一下
   * 轨迹点要重建两遍预览，中间那一遍还画的是「换了轨迹但点还是旧的」这种不存在的状态。
   */
  setSelectedClip(clipId: string | null, pointId: string | null = null): void {
    if (this.disposed) return;
    this.selectedClipId = clipId;
    this.selectedPointId = pointId;
    if (this.currentScene) this.pathPreview?.sync(this.currentScene, clipId, pointId);
    this.requestRender();
  }

  /**
   * 画出正在拖的这一笔；传 null 收笔。
   *
   * 绘制途中没有这条线的话，按下到松手之间画面上什么都不发生——用户是在盲画，
   * 松手才第一次看见自己划过哪里。
   */
  setStroke(points: readonly Vec3[] | null): void {
    if (this.disposed) return;
    this.strokePreview?.set(points);
    this.requestRender();
  }

  /**
   * 进入 / 离开绘制态：把左键（与单指）从轨道旋转上摘下来，画完再挂回去。
   *
   * 画笔和 OrbitControls 听的是同一块 canvas 上同一串指针事件，都认「按住左键拖」。
   * 不摘的话用户每划一笔，整个空间跟着一起转；而落点是拿**当前**相机打射线求出来的，
   * 视角边转边画，画出来的轨迹和手划过的形状根本对不上。
   *
   * 只摘左键，不是 `controls.enabled = false`：滚轮缩放、中键环绕、右键平移在绘制途中
   * 照样要用——画一条长轨迹常常得一路转着看——全关掉等于逼用户在「看」和「画」之间
   * 反复切工具。
   */
  setDrawing(active: boolean): void {
    if (this.disposed) return;
    this.controls.mouseButtons.LEFT = active ? null : this.three.MOUSE.ROTATE;
    this.controls.touches.ONE = active ? null : this.three.TOUCH.ROTATE;
  }

  /**
   * 把画布上的一个点投到 `height` 米高的水平面上，交出世界坐标。绘制轨迹靠它把二维
   * 笔画变成三维路径。
   *
   * 高度是参数而不是写死的 0：一笔画下去所有点都落在同一个水平面上，那这个平面就该是
   * 被画的对象**当下所在**的那个高度。钉死在地面上的话，给 4 米高的机位画一条走位，
   * 画完机位就掉到地上了，用户得逐个轨迹点把它抬回去。
   *
   * 射线与该平面平行时（相机视线水平）返回 null：编个落点出来，笔画上会多一个乱跳的顶点。
   */
  planePointAt(clientX: number, clientY: number, height: number): Vec3 | null {
    if (this.disposed) return null;
    if (!this.raycaster) this.raycaster = new this.three.Raycaster();
    const rect = this.canvas.getBoundingClientRect();
    const canvasWidth = rect.width || 1;
    const canvasHeight = rect.height || 1;
    const pointer = new this.three.Vector2(
      ((clientX - rect.left) / canvasWidth) * 2 - 1,
      -((clientY - rect.top) / canvasHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);

    // three 的平面方程是 n·p + d = 0：法线朝 +Y 时 y = -d，所以常量取高度的相反数。
    const plane = new this.three.Plane(new this.three.Vector3(0, 1, 0), -height);
    const hit = this.raycaster.ray.intersectPlane(plane, new this.three.Vector3());
    return hit ? [hit.x, hit.y, hit.z] : null;
  }

  /**
   * 挑出这一次 setScene 里被人改过静态 transform 的对象。
   *
   * 按「变了没有」认，而不是让拖动手柄那条路径单独通知一声：检查器里改坐标、撤销一次
   * 拖动，走的都是同一个 store 动作，认提交点会漏掉后两种，表现依旧是改了没反应。
   */
  private trackHandPlacements(previous: PrevizScene | null, next: PrevizScene): void {
    // 头一次灌场景（或换了个场景）没有「上一份」可比，此时一切都算时间轴说了算。
    if (!previous) return;
    const before = new Map(previous.objects.map((object) => [object.id, object.transform]));
    const alive = new Set(next.objects.map((object) => object.id));
    // 删掉的对象顺手清掉：这个集合活到播放头下次移动，中间删了再撤销回来的对象
    // 不该带着上一世的「手摆过」标记复活。
    for (const objectId of this.handPlaced) {
      if (!alive.has(objectId)) this.handPlaced.delete(objectId);
    }
    for (const object of next.objects) {
      const placement = before.get(object.id);
      if (!placement) continue;
      if (samePlacement(placement, object.transform)) continue;
      this.handPlaced.add(object.id);
    }
  }

  /**
   * 把当前帧的解算结果写进各个节点：位置、旋转，以及人物这一帧的姿势与姿势内时间——
   * 沿路径走位的人物靠后者真的迈腿，而不是端着一副定格的姿势被平移过去。
   */
  private applyEvaluatedFrame(): void {
    const scene = this.currentScene;
    if (!scene) return;
    const evaluated = evaluateSceneAt(scene, this.currentFrame);
    for (const [objectId, state] of evaluated) {
      // 姿势不归手摆管：拖动一个正在走的人物改的是他站在哪，不是把他的腿定住。
      if (state.poseId !== null) this.graph.applyPose(objectId, state.poseId, state.poseTime);
      // 刚被手摆过的对象让位给那一次摆放，等播放头再动时才交还给时间轴。
      if (this.handPlaced.has(objectId)) continue;
      const node = this.graph.nodeFor(objectId);
      if (!node) continue;
      node.position.set(state.position[0], state.position[1], state.position[2]);
      node.rotation.set(
        state.rotation[0] * DEG_TO_RAD,
        state.rotation[1] * DEG_TO_RAD,
        state.rotation[2] * DEG_TO_RAD,
      );
    }
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmo?.setMode(mode);
    this.requestRender();
  }

  nodeFor(objectId: string): THREE.Object3D | undefined {
    return this.graph.nodeFor(objectId);
  }

  /**
   * 按场景画幅出一张 PNG。有活动机位就从机位出片，否则出当前编辑视角。
   * 场景还没灌进来时返回 null。
   */
  async capture(): Promise<Blob | null> {
    if (this.disposed) return null;
    const scene = this.currentScene;
    if (!scene) return null;
    const aspect = scene.settings.outputAspect;

    const active = this.activeCameraId
      ? scene.objects.find((entry) => entry.id === this.activeCameraId)
      : undefined;
    const activeNode = this.activeCameraId ? this.graph.nodeFor(this.activeCameraId) : undefined;
    const useMonitor = Boolean(
      active && active.kind === 'camera' && activeNode && this.monitorCamera,
    );

    // 手柄、轨迹辅助物、描边名牌、以及出片机位自己的锥体，都不该进画面。
    this.gizmo?.setHelperVisible(false);
    this.setEditorHelpersVisible(false);
    this.overlays?.setSuppressed(true);
    if (useMonitor && activeNode) activeNode.visible = false;

    // 编辑相机的 aspect 跟着视口走，和出片画幅无关；借用它出片前要先改，出完再还。
    const editorAspect = this.camera.aspect;

    try {
      let camera: THREE.Camera;
      if (useMonitor && active?.kind === 'camera' && activeNode && this.monitorCamera) {
        syncMonitorCamera(this.monitorCamera, activeNode, active, aspect);
        camera = this.monitorCamera;
      } else {
        this.camera.aspect = aspectRatio(aspect);
        this.camera.updateProjectionMatrix();
        camera = this.camera;
      }

      return await renderCapture(
        {
          three: this.three,
          renderer: this.renderer,
          scene: this.scene,
          camera,
          createCanvas: createDomCaptureCanvas,
        },
        aspect,
      );
    } finally {
      this.camera.aspect = editorAspect;
      this.camera.updateProjectionMatrix();
      if (useMonitor && activeNode) activeNode.visible = true;
      this.overlays?.setSuppressed(false);
      this.setEditorHelpersVisible(true);
      this.gizmo?.setHelperVisible(true);
      this.requestRender();
    }
  }

  /**
   * 开一次录制：交出一块与出片同分辨率的画布，以及「把第 N 帧画上去」的手柄。
   *
   * 和 `capture()` 走同一套离屏渲染，区别只在渲染目标与读回缓冲留着不还——录制要按
   * 30fps 反复画，每帧新建一个 8 MB 缓冲会把 GC 压成卡顿。
   *
   * `mode` 为 `track` 时必须给出机位；机位不在（被删了、或压根没选）时返回 null，
   * 由调用方提示，而不是在这里悄悄退回导演视角录出一段用户没要的画面。
   */
  startRecording(mode: PrevizRecordMode, cameraId: string | null): PrevizRecordingPass | null {
    if (this.disposed) return null;
    const scene = this.currentScene;
    if (!scene) return null;
    const aspect = scene.settings.outputAspect;

    const camera =
      mode === 'track' && cameraId
        ? scene.objects.find((entry) => entry.id === cameraId)
        : undefined;
    const cameraNode = mode === 'track' && cameraId ? this.graph.nodeFor(cameraId) : undefined;
    if (mode === 'track' && !(camera?.kind === 'camera' && cameraNode && this.monitorCamera)) {
      return null;
    }
    const monitor = this.monitorCamera;

    // 手柄、轨迹辅助物、描边名牌、以及出片机位自己的锥体，都不该进画面。录制期间一直
    // 藏着：逐帧开关的话，屏幕上那条 rAF 渲染循环会随机撞在「开」的那一半上。
    this.gizmo?.setHelperVisible(false);
    this.setEditorHelpersVisible(false);
    this.overlays?.setSuppressed(true);
    if (cameraNode) cameraNode.visible = false;
    this.requestRender();

    const { width, height } = OUTPUT_PIXEL_SIZE[aspect];
    const painter = createFramePainter(
      {
        three: this.three,
        renderer: this.renderer,
        scene: this.scene,
        createCanvas: createDomCaptureCanvas,
      },
      width,
      height,
    );

    let ended = false;
    return {
      canvas: painter.canvas as unknown as HTMLCanvasElement,
      width,
      height,
      drawFrame: (frame, liveId) => {
        if (ended || this.disposed) return;
        // 先解算再渲染：setFrame 把这一帧的走位写进节点，顺手也把屏幕上那份刷新了，
        // 于是录制期间视口就是进度条。
        this.setFrame(frame);
        // 单轨录制锁死在指定机位；全局录制每帧看镜头轨说该看谁。镜头轨指的机位已被
        // 删掉、或压根不是机位时，这一帧走导演视角，别让整段录制断在这里。
        const shot =
          mode === 'track'
            ? camera
            : liveId
              ? scene.objects.find((object) => object.id === liveId)
              : undefined;
        const shotNode =
          mode === 'track' ? cameraNode : liveId ? this.graph.nodeFor(liveId) : undefined;
        if (shot?.kind === 'camera' && shotNode && monitor) {
          // 直播机位自己的模型不能出现在自己拍的画面里。单轨模式开录时已经把它藏起来，
          // 这个开关是给全局模式的：它每帧换机位，只能画哪台藏哪台。
          const wasVisible = shotNode.visible;
          shotNode.visible = false;
          try {
            syncMonitorCamera(monitor, shotNode, shot, aspect);
            painter.paint(monitor);
          } finally {
            shotNode.visible = wasVisible;
          }
          return;
        }
        // 导演视角的 aspect 跟着视口走，和出片画幅无关。借用它出片得先改，画完立刻
        // 还回去——留着不还的话，接下来一整段录制里屏幕上的画面都是拉伸的。
        const editorAspect = this.camera.aspect;
        this.camera.aspect = aspectRatio(aspect);
        this.camera.updateProjectionMatrix();
        try {
          painter.paint(this.camera);
        } finally {
          this.camera.aspect = editorAspect;
          this.camera.updateProjectionMatrix();
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        painter.dispose();
        if (cameraNode) cameraNode.visible = true;
        this.overlays?.setSuppressed(false);
        this.setEditorHelpersVisible(true);
        this.gizmo?.setHelperVisible(true);
        this.requestRender();
      },
    };
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
    //
    // 当前这条分支到不了，两条写机位的路都够不着 0：
    // 一是渲染器自己写机位只经 moveCamera，而它拿到的距离都出自 view.ts 的
    // `framingDistance()`，那里有 MIN_FRAMING_DISTANCE = 1 的下界；
    // 二是 OrbitControls 会绕过渲染器直接改 camera.position——滚轮与拖拽——而这里
    // 没有设 minDistance。它默认是 0（three 0.185 `OrbitControls.js:125`，
    // maxDistance 默认 Infinity 在 `:133`），但缩放是**乘性**的：`:776` 的
    // `radius = _clampDistance(radius * _scale)`，`_clampDistance` 在 `:1074` 只是
    // `Math.max(min, Math.min(max, dist))`，正半径乘任意有限倍率都不会精确变成 0；
    // 平移则只动 target：`_panOffset` 只加在 `this.target` 上（`:753` / `:757`），
    // position 随后由 `:786` 的 `position.copy(this.target).add(_v)` 按**未变的**球半径
    // 重建，所以相机与注视点之差同样不会缩到 0。
    //
    // 所以留着它是为了将来：Task 10 的手柄拖拽会直接写相机机位，谁给这里配上
    // `minDistance = 0` 之外的推拉逻辑、或改成加性缩放，0 长度就会真的出现。
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
   * 当前导演视角：眼位与轨道中心。摄影机创建对话框拿它推新机位的站位与朝向。
   *
   * 返回的是快照而不是 three 内部对象的引用——对话框会把它存进 React state 再逐分量
   * 改，漏出引用的话用户拖一下滑杆就把视口相机一起搬走了。
   */
  viewPose(): PrevizViewPlacement {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  /**
   * 把一份机位草稿的取景画到对话框那块预览画布上。
   *
   * 借视口这套渲染器与场景，所以预览里所见与视口所见严格一致，也不必再开一个 WebGL
   * 上下文（浏览器对同时存活的上下文有个位数的上限）。场景还没灌进来时不画：画幅要从
   * 场景设置里读，没有场景就没有画幅。
   */
  renderCameraPreview(canvas: CameraPreviewCanvas, draft: PrevizCameraDraft): void {
    if (this.disposed) return;
    const scene = this.currentScene;
    if (!scene) return;

    // 临时相机只在这里用，建一次留着：每帧新建一台会在拖拽预览时一秒钟丢几十个对象。
    if (!this.previewCamera) this.previewCamera = new this.three.PerspectiveCamera();

    // 手柄的 helper 与轨迹预览属于编辑期的辅助显示，出片与取景预览里都不该出现。
    this.gizmo?.setHelperVisible(false);
    try {
      renderCameraPreview(
        {
          three: this.three,
          renderer: this.renderer,
          scene: this.scene,
          camera: this.previewCamera,
          canvas,
        },
        draft,
        scene.settings.outputAspect,
      );
    } finally {
      this.gizmo?.setHelperVisible(true);
      // 离屏 pass 把 render target 换过一轮，屏幕上那一帧要重画。
      this.requestRender();
    }
  }

  /**
   * 把整个场景的某个正交视角画到四视图那块画布上。
   *
   * 框的是全场景而不是 [currentBounds]：俯视和侧视是「这场戏摆成什么样」的参照图，
   * 跟着选中对象一起跳的话，每点一次人物两张图就换一次比例尺，反而读不出走位关系。
   *
   * 真正换成正交投影的只有这两块画布，视口相机始终是透视：视口换成正交会改掉
   * OrbitControls 的推拉手感，检视面板里那些按透视算出来的读数也会一起失真。
   */
  renderQuadPreview(canvas: CameraPreviewCanvas, direction: PrevizViewDirection): void {
    if (this.disposed) return;

    // 临时相机只在这里用，建一次留着：每帧新建一台会在拖拽时一秒钟丢几十个对象。
    if (!this.orthoCamera) this.orthoCamera = new this.three.OrthographicCamera();

    const width = Math.max(1, Math.floor(canvas.width));
    const height = Math.max(1, Math.floor(canvas.height));
    const placement = orthoPlacement(direction, this.sceneBounds(), width / height);

    // 手柄的 helper 是贴着屏幕大小画的，正交小图里会糊满整块画布。轨迹与描边留着：
    // 俯视图上那几条走位线正是要看的东西。
    this.gizmo?.setHelperVisible(false);
    try {
      renderOrthoPreview(
        {
          three: this.three,
          renderer: this.renderer,
          scene: this.scene,
          camera: this.orthoCamera,
          canvas,
        },
        placement,
      );
    } finally {
      this.gizmo?.setHelperVisible(true);
      this.requestRender();
    }
  }

  /**
   * 把某台机位眼里的一帧画到四视图那块画布上。机位由调用方点名——四视图那一格与右下角
   * 监看看的不一定是同一台（见 `PrevizEditor` 里的 `quadCamera`），谁也别替谁做主。
   * 传进来的 id 不是机位、或者场景里没有它时**什么都不画**：由调用方在那块地方摆一句
   * 提示，比留一块黑画布说得清楚。
   *
   * 与右下角监看用的是同一台相机、同一套参数（[syncMonitorCamera]），区别只在落点：
   * 监看是主画面上的一次 scissor pass，这里是画进一块独立画布。所以两处的取舍也一样——
   * 机位自己的锥体、手柄、轨迹辅助物都要先藏起来：锥体就长在相机原点上，不藏会糊满
   * 整块画布，而轨迹小球在机位走位时同样贴在镜头上。这一条是四视图里唯一一块「镜头里
   * 的画面」，其余三块都是编辑视图，看得见辅助物才好用。
   *
   * 画面**铺满**画布，多出来的那一边裁掉（[coverFovDeg]），而不是像取景预览那样留黑边：
   * 这是四格里最大的一格，画布长宽比又跟着布局走，留边等于把它最大的用处（看清楚镜头里
   * 是什么）先削掉一半。裁而不是拉伸——拉伸过的画面会让用户照着错误的构图去摆机位。
   */
  renderCameraView(canvas: CameraPreviewCanvas, cameraId: string): void {
    if (this.disposed) return;
    const scene = this.currentScene;
    const monitor = this.monitorCamera;
    if (!scene || !monitor) return;

    const object = scene.objects.find((entry) => entry.id === cameraId);
    const node = this.graph.nodeFor(cameraId);
    if (!object || object.kind !== 'camera' || !node) return;

    const aspect = scene.settings.outputAspect;
    syncMonitorCamera(monitor, node, object, aspect);

    // 至少 1 像素：画布还没进布局时宽高是 0，而 `WebGLRenderTarget(0, 0)` 会抛。
    const width = Math.max(1, Math.floor(canvas.width));
    const height = Math.max(1, Math.floor(canvas.height));
    // 铺满这块画布，而不是按出片画幅留黑边。`syncMonitorCamera` 刚按出片画幅摆好的
    // 那台相机在这里改一次取景，改的只是取景——机位的位置、朝向、焦距一个都没动。
    monitor.fov = coverFovDeg(monitor.fov, aspectRatio(aspect), width / height);
    monitor.aspect = width / height;
    monitor.updateProjectionMatrix();

    const wasVisible = node.visible;
    node.visible = false;
    this.gizmo?.setHelperVisible(false);
    this.setEditorHelpersVisible(false);
    try {
      blitCameraToCanvas(
        { three: this.three, renderer: this.renderer, scene: this.scene, canvas },
        monitor,
        { x: 0, y: 0, width, height },
      );
    } finally {
      this.setEditorHelpersVisible(true);
      this.gizmo?.setHelperVisible(true);
      node.visible = wasVisible;
      // 离屏 pass 把 render target 换过一轮，屏幕上那一帧要重画。
      this.requestRender();
    }
  }

  /**
   * 画布坐标下的拾取，返回对象 id，点空处返回 null。命中的一定是占位体或模型里的
   * 子网格，所以要沿 parent 往上走到挂着 previzObjectId 的那个组。
   */
  pickAt(clientX: number, clientY: number): string | null {
    if (this.disposed) return null;
    const hits = this.rayFrom(clientX, clientY).intersectObjects(this.visibleNodes(), true);
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
   * 画布坐标下的轨迹点拾取，点空处返回 null。
   *
   * 和 [pickAt] 分开而不是合成一次射线取最近命中：轨迹点球是画在被它牵着走的那个对象
   * 身上的（轨迹从对象当前位置开始画），最近的那个命中永远是对象本身，合起来算的话
   * 轨迹点恰恰在最该点它的地方点不中。调用方拿到点就别再问对象了。
   */
  pickPathPointAt(clientX: number, clientY: number): PrevizPathPointPick | null {
    if (this.disposed || !this.pathRoot) return null;
    // 不递归：球和曲线都是预览根的直接子节点，而递归会顺带把将来挂进来的任何装饰
    // 也算成命中。
    const hits = this.rayFrom(clientX, clientY).intersectObjects(this.pathRoot.children, false);
    for (const hit of hits) {
      const { previzClipId, previzPointId } = hit.object.userData;
      // 曲线身上也有 previzClipId，但它不是某一个点：点在两点之间的线上什么都不该选中。
      if (typeof previzClipId === 'string' && typeof previzPointId === 'string') {
        return { clipId: previzClipId, pointId: previzPointId };
      }
    }
    return null;
  }

  /** 从画布坐标打出一条射线。两处拾取共用，省得 NDC 那几步各写一遍还写岔。 */
  private rayFrom(clientX: number, clientY: number): THREE.Raycaster {
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
    return this.raycaster;
  }

  /**
   * 场景里可见对象的节点。拾取与「框全场景」共用它——两处都只该看得见的东西。
   *
   * 必须自己剔掉隐藏的对象。three 0.185 的 `Raycaster.intersect()` 只测 `layers`，
   * `Mesh.raycast()` 里也没有 visible 检查——隐藏的对象在屏幕上看不见，射线却照样
   * 打得中，表现是点空白处选中了一个「不存在」的东西。
   */
  private visibleNodes(): THREE.Object3D[] {
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

  /** 这次取景要框的东西：选中的那个，否则全场景。 */
  private currentBounds(): PrevizBounds {
    const selected = this.selectionId ? this.graph.nodeFor(this.selectionId) : undefined;
    if (selected) return this.boundsOf(selected);
    return this.sceneBounds();
  }

  /** 全部可见对象，场景空了退回原点上的占位盒——不然四视图会框到一个没有意义的地方。 */
  private sceneBounds(): PrevizBounds {
    const all = this.visibleNodes().map((node) => this.boundsOf(node));
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

  /** 右下角的机位监看。没有活动机位时什么都不做。 */
  private renderMonitor(): void {
    const scene = this.currentScene;
    const monitor = this.monitorCamera;
    if (!scene || !monitor || !this.activeCameraId) return;

    const object = scene.objects.find((entry) => entry.id === this.activeCameraId);
    const node = this.graph.nodeFor(this.activeCameraId);
    if (!object || object.kind !== 'camera' || !node) return;

    syncMonitorCamera(monitor, node, object, scene.settings.outputAspect);

    const size = this.renderer.getSize(new this.three.Vector2());
    const rect = monitorViewportRect(size.x, size.y, scene.settings.outputAspect, this.monitorSize);

    // 机位自己的锥体就长在相机原点上，不藏起来会糊满整个监看画面。
    const wasVisible = node.visible;
    node.visible = false;
    this.setEditorHelpersVisible(false);

    this.renderer.setScissorTest(true);
    this.renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
    this.renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
    // autoClear 默认为真，会连主画面一起清掉；这里只清深度，留住已经画好的主视图。
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.scene, monitor);
    this.renderer.autoClear = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);

    this.setEditorHelpersVisible(true);
    node.visible = wasVisible;
  }

  /**
   * 编辑器自己的辅助物（当下是轨迹曲线与轨迹点）在镜头里的开关。
   *
   * 它们属于编辑视图，不属于镜头：机位停在自己的轨迹上是「机位走位」的常规用法，
   * 而那时轨迹点小球就贴在镜头原点上，监看框与成片都会被一团白糊满。
   *
   * 按 `previzEditorOnly` 标记扫 scene 的直接子节点，而不是记一份句柄：之后再往
   * scene 上挂别的辅助物（标尺、安全框），打上标记就自动跟着一起藏。
   */
  private setEditorHelpersVisible(visible: boolean): void {
    for (const child of this.scene.children) {
      if (child.userData.previzEditorOnly) child.visible = visible;
    }
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      // update() 返回 true 表示相机确实动了（阻尼余速也算）。静止时跳过 render，
      // 否则一个只有网格和两盏灯的静态场景会在全屏里 60fps 空烧 GPU。
      if (this.controls.update() || this.needsRender) this.renderFrame();
      this.rafHandle = window.requestAnimationFrame(tick);
    };
    this.rafHandle = window.requestAnimationFrame(tick);
  }

  /** 主视图加监看框画一遍，顺手把待绘标记清掉。tick 与 resize() 共用。 */
  private renderFrame(): void {
    this.needsRender = false;
    this.renderer.render(this.scene, this.camera);
    this.renderMonitor();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.rafHandle);
    this.controls.dispose();
    // 必须排在下面那次 traverse 之前：场景图会把自己的节点从对象根上摘掉再还资源，
    // 顺序反过来的话同一批几何体与材质会被 dispose 两遍。
    this.gizmo?.dispose();
    // 必须排在 graph.dispose() 之前：叠加层挂在场景图的节点下面，反过来的话它要摘的
    // 那些子节点已经跟着节点一起没了，名牌的贴图就还不回去。
    this.overlays?.dispose();
    this.graph.dispose();
    this.pathPreview?.dispose();
    this.strokePreview?.dispose();
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
