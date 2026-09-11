// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { PrevizRecordMode } from '../capture/recordTarget';
import { createDomCaptureCanvas, renderCapture } from '../capture/renderCapture';
import { OUTPUT_PIXEL_SIZE, aspectRatio, coverFovDeg, DEG_TO_RAD } from '../domain/camera';
import type { PrevizCameraDraft } from '../domain/cameraDraft';
import type { PrevizCharacterDraft } from '../domain/characterDraft';
import { dropPositionY, dropRayOriginY } from '../domain/drop';
import { evaluateSceneAt } from '../domain/evaluate';
import type { PrevizPropExtent } from '../domain/moveAssist';
import { PREVIZ_DEFAULT_HEIGHT_CM } from '../domain/objects';
import type { PrevizObject, PrevizScene, PrevizTransform, Vec3 } from '../domain/scene';
import {
  PREVIZ_TOP_DOWN_DEFAULT_BOUNDS,
  topDownView,
  type PrevizTopDownFootprint,
  type PrevizTopDownView,
} from '../domain/topDownMap';
import {
  PREVIZ_DEFAULT_VIEW,
  PREVIZ_VIEW_FAR_M,
  PREVIZ_VIEW_NEAR_M,
  boundsCenter,
  boundsRadius,
  framingDistance,
  orbitDepthRange,
  orthoPlacement,
  unionBounds,
  viewPlacement,
  type PrevizBounds,
  type PrevizDepthRange,
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
import {
  createCharacterPreviewStage,
  disposeCharacterPreviewStage,
  renderCharacterPreview,
  type CharacterPreviewStage,
} from './characterPreview';
import { renderOrthoPreview } from './orthoPreview';
import { CharacterRigFactory } from './characterRig';
import { PrevizPathPreview } from './pathPreview';
import { PrevizStrokePreview } from './strokePreview';
import { PrevizGizmo, type GizmoMode, type TransformControlsLike } from './gizmo';
import { createInfiniteGrid } from './grid';
import { prepareImportedMaterials } from './importedMaterials';
import { PropLoader } from './propLoader';
import { PREVIZ_PLACEHOLDER_RADIUS, PrevizSceneGraph, type ThreeModule } from './sceneGraph';
import { PrevizViewOverlays, type PrevizViewOverlayOptions } from './viewOverlays';

// 上限 2：3x DPR 设备按原生比例渲染是 9 倍像素，收益远小于开销。
const MAX_PIXEL_RATIO = 2;

/**
 * 空场景时俯视底图框的那块地，`domain/topDownMap.ts` 的默认地块（12 m 见方）换成三维
 * 写法，y 压成 0：这张图只回答 xz 上的站位，高度方向没有东西可框。
 *
 * 不能照搬 [sceneBounds] 那条兜底。它给的是一个人体尺寸的占位盒，`orthoPlacement`
 * 按包围球开窗之后画面只有两米出头——用户开局第一件事就是在空场景里点个站位，那时
 * 整张图上一格网格都放不下，也没有任何东西告诉他画面为什么这么近。
 */
const TOP_DOWN_EMPTY_BOUNDS: PrevizBounds = {
  min: [PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.minX, 0, PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.minZ],
  max: [PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.maxX, 0, PREVIZ_TOP_DOWN_DEFAULT_BOUNDS.maxZ],
};

/** 编辑视角的视场角。刻意与机位的 focalMm 无关：这是自由飞行相机，不是取景器。 */
const EDITOR_FOV_DEG = 50;

/**
 * 主光投影的正交框半径，单位米。整个框是以场景原点为中心的 40 m 见方。
 *
 * 这个数是一次取舍：框外的对象**一律不投影**（不是影子变糊，是完全没有），而框每放大
 * 一倍，同一张深度图上每米摊到的像素就少一半、接触处的影子边缘就糊一档。40 m 能整个
 * 装下一间屋子加周围的走位余地，2048 的深度图摊下来约 51 像素／米，接触阴影还是实的。
 *
 * 跟着场景包围盒动态收紧是更好的做法，代价是每次增删对象都要重算并重编译一次阴影相机，
 * 而现在还没有哪条用例被这个固定框挡住。真被挡住时，收紧的入口在这里。
 */
const SHADOW_EXTENT_M = 20;

/**
 * 半球填充光的天顶色与地面色。
 *
 * 天顶偏冷、地面压到接近背景（#101216）那一档：地面色不是在「给地面打光」，它是物体
 * 底面收到的回弹光，调亮了底面就浮起来，正好抵掉接触阴影想说的那件事。两个颜色拉开
 * 差距才有方向感——同色的半球光和 `AmbientLight` 没有区别。
 */
const SKY_FILL_COLOR = 0xdfe6f2;
const GROUND_FILL_COLOR = 0x1a1e26;

/**
 * 接住影子的那块地。
 *
 * 非要单独来一块，是因为地面网格是自定义 `ShaderMaterial`（见 grid.ts），而 three 的
 * 阴影是在**内置材质**的着色器里拼进去的——自定义着色器不写那段代码就收不到影子。
 * 于是站在空地上的对象会把影子投到虚无里：算了，画不出来。
 *
 * `ShadowMaterial` 正是为这件事存在的：除了阴影它什么都不画，所以这块平面在画面上
 * 只剩那团影子本身。
 */
/** 承影平面沉到地面以下多少米。够躲开共面，又小到影子看不出偏移。 */
const SHADOW_CATCHER_SINK_M = 0.001;

function createShadowCatcher(three: ThreeModule): THREE.Object3D {
  const material = new three.ShadowMaterial({
    // 影子的浓度。纯黑压得太死——这块地在画面上是没有的，影子太实会读成一个黑色物体。
    opacity: 0.28,
    // 不写深度：它和网格地面共面，写了就是两张共面的半透明面互相争，
    // 视角一动影子边缘整片闪。网格那边同理（grid.ts 里有同一条注释）。
    depthWrite: false,
  });
  const size = SHADOW_EXTENT_M * 2;
  const catcher = new three.Mesh(new three.PlaneGeometry(size, size), material);
  catcher.rotation.x = -Math.PI / 2;
  // 沉到 y=0 下面一毫米。导进来的屋子自带地板，它也接影——那时这块地和真地板共面，
  // 同一道影子会被画两遍，暗处比该有的更暗，而且两张共面的片在远处会互相穿插。
  // 沉下去之后有真地板的地方它被挡住（不透明的地板先画、深度更近），只在空地上露出来。
  catcher.position.y = -SHADOW_CATCHER_SINK_M;
  catcher.receiveShadow = true;
  // 排在网格之后画。两者都在半透明队列里、都不写深度，谁后画谁盖在上面——影子要盖住
  // 网格线，否则一条条亮线会从影子里穿出来。
  catcher.renderOrder = 0;
  // 铺满脚下的一块地，留着默认射线检测会让每一次空点都命中它。同 grid.ts。
  catcher.raycast = () => {};
  // 和地面网格同属编辑期的参照物：镜头里不该出现一块凭空的影子地（出片、录制、监看
  // 那几趟会连同轨迹曲线一起把带这个标记的直接子节点藏掉，见 `setEditorHelpersVisible`）。
  catcher.userData.previzEditorOnly = true;
  return catcher;
}

/**
 * 一次录制的句柄。`canvas` 就是视口那块 DOM 画布：录制期间它的位图被钉在出片分辨率上
 * （CSS 盒子不变，画面按 object-fit: contain 留白显示），编码器直接从它上面采样。
 * 用完必须 `end()`：位图尺寸、轨道控制与辅助物的可见性都攥在它手里。
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
  /** 录制进行中：位图钉在出片分辨率上，rAF 循环与 resize() 都让路，见 `startRecording`。 */
  private recording = false;
  /** 懒建：从不点画布的会话不需要它。Raycaster 没有 dispose()，纯数学对象，不用还。 */
  private raycaster: THREE.Raycaster | null = null;
  private currentScene: PrevizScene | null = null;
  private selectionId: string | null = null;
  /**
   * 等模型到位就取景的那个对象。见 `focusObjectWhenReady`。
   *
   * 只记一个：连着导入两份模型时，后一次覆盖前一次——两份都取景的话相机会在两个位置
   * 之间跳一下，而用户最后想看的本来就是后导入的那个。
   */
  private pendingFocusId: string | null = null;
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
  /**
   * 人物骨架工厂。场景图那边也拿着同一个（`create` 里 attach 进去的就是它）：预览与
   * 视口共用一份已下好的 GLB 与动画库，开对话框不会再拉一次几 MB。
   */
  private characterRig: CharacterRigFactory | null = null;
  /** 创建人物对话框那块木偶预览的专用场景与相机，第一次画预览时建，之后一直留着。 */
  private characterStage: CharacterPreviewStage | null = null;
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
    // 接触阴影：物体和地面之间那道暗，是「这东西站在这儿」唯一不靠透视也读得出来的
    // 线索。没有它，一把椅子摆在地上还是浮在半空，画面上一模一样。
    // PCFSoft 而不是默认的 PCF：预演台里几乎全是白模，硬边阴影在白模上格外像渲染错误。
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = three.PCFSoftShadowMap;
    // 白模在这套光下必然把高光段推到 1.0 以上。线性输出会把超出去的部分整片裁成纯白，
    // 而那正是用户报的「模型没渲染出来」——一堵白墙上没有任何明暗，只有轮廓。
    // ACES 把高光滚下来，墙面才留得住起伏。
    renderer.toneMapping = three.ACESFilmicToneMapping;

    const scene = new three.Scene();
    scene.background = new three.Color(0x101216);
    // 地面自己跟着当前那台相机走（见 grid.ts），所以这里只管加进场景，不必接线。
    scene.add(createInfiniteGrid(three));
    scene.add(createShadowCatcher(three));
    // 填充光用半球光，不用 `AmbientLight`：后者是给每个像素均匀加一层白，不带任何方向
    // 信息，加得越多模型越平——而「一整面墙上没有明暗、只剩轮廓」正是白模最怕的样子。
    // 半球光按法线朝上的程度在天顶色与地面色之间插值，顶面亮、底面暗、侧面居中，
    // 于是背光面也有过渡。
    //
    // 也试过用 three 的 `RoomEnvironment` 烘一张 IBL 挂到 `scene.environment`：形体是
    // 出来了，但那是一间白摄影棚，整个场景被它提亮一档，预演台原本的暗底调没了。
    // 半球光留住了调子，方向感该有的也有。
    scene.add(new three.HemisphereLight(SKY_FILL_COLOR, GROUND_FILL_COLOR, 0.9));

    const keyLight = new three.DirectionalLight(0xffffff, 1.8);
    keyLight.position.set(4, 8, 6);
    keyLight.castShadow = true;
    // 正交阴影相机的默认框是 ±5 米，而预演台的常见场景是一整间屋子（`Room.obj` 换算完
    // 是 5.7×8.9 米）。框小了的表现不是「没阴影」，是**框外的东西一律不投影**，
    // 于是半间屋子有影半间没有。往外放到 ±20，代价是同一张深度图铺的面积大了 16 倍，
    // 所以下面把分辨率也跟着提上去。
    const shadowCamera = keyLight.shadow.camera;
    shadowCamera.left = -SHADOW_EXTENT_M;
    shadowCamera.right = SHADOW_EXTENT_M;
    shadowCamera.top = SHADOW_EXTENT_M;
    shadowCamera.bottom = -SHADOW_EXTENT_M;
    shadowCamera.near = 0.5;
    shadowCamera.far = 80;
    shadowCamera.updateProjectionMatrix();
    keyLight.shadow.mapSize.set(2048, 2048);
    // `normalBias` 而不是只调 `bias`：导入的模型全被改成了双面（见 `importedMaterials.ts`），
    // 而双面材质的阴影两面都写，薄墙上会起一层自阴影的斑。normalBias 沿法线把采样点推开，
    // 正是为这种情况准备的；纯 bias 要推到很大才压得住，那时接触点的阴影会整个飘离物体。
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const camera = new three.PerspectiveCamera(
      EDITOR_FOV_DEG,
      1,
      PREVIZ_VIEW_NEAR_M,
      // 只是起点：`syncDepthRange()` 每帧按轨道距离往外推。
      PREVIZ_VIEW_FAR_M,
    );
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
    instance.characterRig = new CharacterRigFactory({
      three,
      loadGltf: (url) => gltfLoader.loadAsync(url),
      // 必须是 SkeletonUtils 的 clone，不是 Object3D.clone()：后者复制 SkinnedMesh 时
      // 仍指向原骨架，第二个人物一摆姿势第一个也跟着动。
      clone: skeletonUtils.clone,
    });
    instance.graph.attachCharacterRig(
      instance.characterRig,
      // 模型是异步到的，到了之后必须主动请求一帧：按需重绘的循环这时早就静下来了。
      // 顺手补一次描边 / 名牌：这条路径不经过 setScene，少了它后到的 GLB 一直没有描边。
      // 也把当前帧重放一遍：`build()` 摆的是静态姿势，播放头这时可能已经在路径中间，
      // 不重放的话后到的模型会一直站着滑，直到播放头下一次移动。
      (objectId) => {
        instance.applyEvaluatedFrame();
        instance.syncOverlays();
        // 排在 requestRender 之前：取景要动相机，动完再请求那一帧，省掉一次白画。
        instance.resolvePendingFocus(objectId);
        instance.requestRender();
      },
    );

    const objLoader = new objModule.OBJLoader();
    instance.graph.attachPropLoader(
      new PropLoader({
        loadGltf: (url) => gltfLoader.loadAsync(url),
        loadObj: (url) => objLoader.loadAsync(url),
        clone: skeletonUtils.clone,
        measure: (object) => {
          // 每次新建一个 Box3 而不是复用一个模块级实例：加载是并发的，同一帧里可能有
          // 两个模型先后量。`setFromObject` 会走遍整棵子树，但每个 URL 只量一次。
          const box = new three.Box3().setFromObject(object);
          // 空盒（没有任何几何体的模型）出来是 -Infinity..Infinity，减出来是 -Infinity。
          // `propUnitScale` 认这个数、原样放行，不用在这里兜。
          return Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
        },
        prepareMaterials: (object) => prepareImportedMaterials(three, object),
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
      three,
      dropToSurface: (objectId) => instance.dropToSurface(objectId),
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
    // 录制期间位图钉在出片分辨率上，容器尺寸变了也不能动它——编码器正从这块画布采样。
    // end() 会再调一次 resize()，这次被压下的尺寸到那时落地。
    if (this.recording) return;
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
    const evaluated = evaluateSceneAt(scene, this.currentFrame, this.propExtents());
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
    this.standGroundCharacters(scene);
  }

  /**
   * 高度策略 `ground`：把人物的脚底压到他正下方那个面上，每帧一次。
   *
   * 必须排在上面那趟写节点位置之后，而且是**整趟**之后，不能揉进那个循环里：
   *   * 揉进去的话人物自己的位置还没写，射线从上一帧的包围盒起射——而紧接着那句
   *     `node.position.set()` 又会把刚落好的 y 整个盖掉，等于没落；
   *   * 就算只挪到每个对象的写入之后，排在人物**后面**的道具这一帧还停在上一帧的位置。
   *     人站在挂了走位的移动平台上时，射线打的是平台的旧位置，人于是永远慢一帧、
   *     看着在平台上滑。
   *
   * 手摆过的人物（上面那句 `handPlaced` 的 `continue`）这里不放过：`ground` 的高度是
   * 算出来的，手柄和检查器改的是他站在哪（x/z），不是他浮多高。
   *
   * 复用 `dropToSurface`，不另写一条射线：两处落地各算各的高度是一类极难查的 bug，
   * 只在某个原点不在脚底的资产上看得出来（见 `domain/drop.ts` 的模块头）。
   *
   * 只认 `ground` 这一档。`plane` 是同一个枚举的另一档，在 `domain/evaluate.ts` 里纯算
   * 出来，一条射线都不用打；`follow` 就是「写多少是多少」。这个 `continue` 也是性能闸，
   * 而且这道闸挡的量比看上去大：开销**不是**由人数决定的，是由脚下那片可命中几何的
   * 三角面数决定的——three 没有 BVH，`Mesh.raycast` 会把包围球被射线穿过的整个网格逐
   * 三角遍历一遍。真 three 0.185 在 node 里实测（20 个贴地人物）：地板 2 面片 0.05 ms/帧，
   * 换成 2 万面片 13.5 ms/帧（60fps 预算的 81%），20 万面片 135 ms/帧；5 个人踩在 2 万
   * 面片的布景上就已经 3.3 ms。同一批 `Box3.setFromObject` 在这三组里没变过，可以忽略。
   * 缓解因素是这笔开销**是 opt-in 的**：`domain/objects.ts` 新建人物默认 `follow`，
   * 没人选贴地的场景一条射线都不打。真要优化，方向是给布景网格加 BVH 或缩小候选集，
   * 不是按人数设阈值。
   *
   * 不缓存。缓存要按「脚下那片几何体这一帧变了没有」失效，而那正是这条射线要回答的
   * 问题本身：道具会被走位推着走、模型异步换入、人物自己也在移动——能便宜地判出这些
   * 变化，就不必打射线了。
   *
   * 已知的缝有四条，一并列在这里——这段就是这个特性的缺陷清单，只写一条会让人以为
   * 清单是完的：
   *
   * 1. **特写机位与「看向」不会跟着重解。** 这两轮（`evaluate.ts` 的 `applyCloseups` /
   *    `applyPathAims`）在求值层内部就跑完了，拿的是落地**之前**的 y。机位**位置**的
   *    误差恰好等于这一帧落地挪动的距离（纯 y 平移），用例「solves a closeup from the
   *    height the character had before the drop」把它量了出来：人物本来就站在地上（走位
   *    画在 y=0 平面、脚下是空地）时位移是 0，机位分毫不差；他一脚踏上 0.8 米高的台子，
   *    脸部特写就低 0.8 米——那个景别的取景半径不到一米，等于整颗头出画。「看向」解出的
   *    是**角度**，误差是 atan 出来的量，不等于那个位移，别把上面那个数套过去。
   * 2. **射线会把人抬到压在他中轴上的桌沿 / 栏杆上，而且撤不掉。** 见 `dropToSurface`
   *    那段取舍的末尾：一次性吸附下这只是一次可撤销的误吸，每帧调用下它是持续的。
   * 3. **落地只改 three 节点，不回灌 store。** 于是 `ground` 人物的 store y 与屏幕上的 y
   *    会常态性不一致：用 Y 轴手柄（`PrevizGizmo` 只在贴地那几根手柄上吸附）或检查器的
   *    Y 输入框把他抬到 5，数字进了 store、下一次 `setScene` 落地又把节点拉回地面，
   *    没有任何提示；之后把策略切回 `follow`，人会瞬间跳到那个从没被确认过的 5。语义是
   *    有意的（`ground` 的高度不归手改，见上面），缺的是 UI 反馈——该在检查器里把 Y 置灰。
   * 4. **人踩人按 `scene.objects` 的顺序解，上层的人慢一帧**：A 站在 B 头上而 A 排在
   *    B 前面时，A 落的是 B 这一帧还没落地的头顶。更要留意的是 `domain/drop.ts` 里
   *    `PREVIZ_DROP_EPSILON` 记的那条退化——起点进到 DoubleSide 导入模型内部会贴到它的
   *    **底面**上。一次性吸附下那是一次误吸，每帧调用下两个人可以互相垫着变成一部没有
   *    上限的电梯。真出现了，别在这里加钳位，去修候选集。
   *
   * 明知有缝还留着，是因为另外两条路这一层都走不通：在渲染器里重解一遍要照抄
   * `applyCloseups` / `applyPathAims`（`evaluate.ts` 只导出 `evaluateSceneAt`，那两个
   * 函数是私有的），等于把整个机位解算做出第二份实现——`domain/drop.ts` 开头警告的那种
   * 漂移，一个数尚且难查，一整套公式更难；把射线结果回灌给求值层再解一次才是对的修法，
   * 但那要给 `evaluateSceneAt` 开一个高度覆盖入口、并把落地排进它现有的三段顺序里，
   * 是求值层的改动，不是这里能顺手做的。
   */
  private standGroundCharacters(scene: PrevizScene): void {
    for (const object of scene.objects) {
      if (object.kind !== 'character' || object.heightPolicy !== 'ground') continue;
      // 返回 null 表示这一次落不了地。最常见的是包围盒还空着（模型在下载，或者下载
      // 失败了）；渲染器已 dispose、节点取不到也走这条——`applyEvaluatedFrame` 会被
      // GLB 到达的异步回调触发，那两条在这个调用点是够得着的。保持求值给的高度，不要
      // 拿 0 兜底：那等于在模型到达之前先把人物瞬移到地面上。
      const dropped = this.dropToSurface(object.id);
      if (dropped === null) continue;
      const node = this.graph.nodeFor(object.id);
      // `if (node)` 只为类型存在：`dropped !== null` 已经蕴含 `dropToSurface` 内部那次
      // `nodeFor` 拿到了节点，两次查表在同一个同步 tick 里，不可能一次有一次没有。
      // 只改 y：x/z 与旋转是走位说了算的，落地只回答「多高」。
      if (node) node.position.y = dropped;
    }
  }

  /** 换手柄模式；`null` 表示当前工具不要手柄（见 [PrevizGizmo.setMode]）。 */
  setGizmoMode(mode: GizmoMode | null): void {
    this.gizmo?.setMode(mode);
    this.requestRender();
  }

  nodeFor(objectId: string): THREE.Object3D | undefined {
    return this.graph.nodeFor(objectId);
  }

  /**
   * 把对象落到它正下方的表面上，返回落地后的**局部** y；这一次不该落地时返回 null。
   *
   * 局部 y 直接可用是因为对象节点全是 `objectRoot` 的直接子节点（`PrevizSceneGraph.sync`
   * 里那句 `this.root.add(node)`；这里不写行号，那个文件在动），
   * 而 `objectRoot` 是 `create()` 里裸建的一个 Group、从头到尾没被摆过位置也没被缩放。
   * 留给哪天要给它加变换的那个人：这里加的是 `surfaceY - box.min.y`，一个**世界位移**，
   * 而平移保位移，所以纯 y 偏移**是无害的**——它在这个减法里整个约掉了。真正会打烂
   * 公式的是另外两样：非 1 的 y 缩放（世界位移是局部的 s 倍，得先除回去），以及任何让
   * 局部 y 轴不再竖直的旋转（那时根本没有「加到 y 上」这回事，对象会被推着往斜里走）。
   *
   * 射线策略是「从盒**顶**往下打，取最近命中」，这里有一个真实存在、且无法两全的取舍：
   * 起点在盒顶意味着射线会穿过对象自己占的整个高度区间，凡是与对象**中轴**相交的东西
   * （桌沿、栏杆、门框）都会赶在地板之前被命中，对象于是被顶到那上面去。想靠「只接受
   * 低于盒底的命中」把它挡掉的话，会连「已经沉进桌子里/地板下的对象重新浮上来」一起
   * 挡掉——而后者正是选顶面起射唯一要救的场景（见 `domain/drop.ts` 里 `dropRayOriginY`
   * 的说明）。两个需求要的是同一种输入：一个高于盒底的表面。这里显式选了后者：
   *   * 射线只在包围盒水平中心那一条线上，擦着对象边上过的桌沿命中不了，真被顶上去的
   *     前提是那个面确实压在对象正中央——这种情形下「站到桌面上」本来也是更像人话的
   *     结果；
   *   * 比对象**高**的东西够不着：起点在盒顶，顶面在起点之上的几何体整个在射线背后，
   *     所以钻到桌子底下的小道具不会被吸到桌面上；
   *   * 手柄那条路径上真吸错了，撤销一步就回来，而且这几根手柄之外（Y 轴、两个竖直面）
   *     全程不吸附。
   *
   * **但最后这条只对手柄成立。** `standGroundCharacters` 每帧调这个方法，那里没有「一次
   * 操作」可撤销：一个 `ground` 人物的走位穿过桌子的水平投影时，包围盒中心一进桌面
   * footprint，射线从盒顶向下第一个命中就是桌面，人被抬上桌；下一帧盒顶跟着抬高，仍然
   * 命中同一张桌面，于是他**站在桌面上走完全程**，并被原样烤进录制出片。用户撤不掉
   * （每帧由策略重算），也没有逐对象的排除开关，唯一的出路是把策略改回 `follow`。
   */
  dropToSurface(objectId: string): number | null {
    if (this.disposed) return null;
    const object = this.currentScene?.objects.find((entry) => entry.id === objectId);
    if (!object) return null;
    // 机位与灯本来就该浮在空中：把一台俯拍机吸到地板上，取景当场毁掉。
    if (object.kind !== 'character' && object.kind !== 'prop') return null;
    const node = this.graph.nodeFor(objectId);
    if (!node) return null;

    // 不能复用 `boundsOf()`：它会把空盒换成一个人体尺寸的**占位盒**（给聚焦用的产品
    // 行为，见那个函数的注释）。拿它落地，一个还在下载的模型会按一个假盒子被瞬移走。
    const box = new this.three.Box3().setFromObject(node);
    if (box.isEmpty()) return null;

    const centre = box.getCenter(new this.three.Vector3());
    if (!this.raycaster) this.raycaster = new this.three.Raycaster();
    this.raycaster.set(
      new this.three.Vector3(centre.x, dropRayOriginY(box.max.y), centre.z),
      new this.three.Vector3(0, -1, 0),
    );
    // 剔掉自己。`visibleNodes()` 给的是每个对象最上层那个节点，滤掉自己这一个，
    // 自己的子孙也就一起不在候选里了——不滤的话第一个命中的永远是自身的顶面。
    const targets = this.visibleNodes().filter((candidate) => candidate !== node);
    // 递归：对象节点本身是空 Group，几何体在它下面那层占位体 / 模型里。
    const hits = this.raycaster.intersectObjects(targets, true);
    // three 的 `intersectObjects` 出手前已经按距离升序排过（0.185 `Raycaster.js:222`；
    // `:198` 那句 sort 是单数版 `intersectObject` 的，别顺着它去核）。射线朝下，距离
    // 升序此时恰好等价于 y 降序，第 0 个就是最高的那个面，这里不必也不该再排一次。
    //
    // 没命中就用 0：地面网格是不可拾取的（`createInfiniteGrid` 给它的 `raycast` 赋了
    // 空函数，否则铺满视野的它会吃掉每一次空点），而它确实铺在 y=0。退回 null 的话在
    // 空地上拖东西永远不落地，正是最常见的那种拖法。
    const surfaceY = hits[0]?.point.y ?? 0;
    return dropPositionY(node.position.y, box.min.y, surfaceY);
  }

  /**
   * 每件看得见的道具在地面上占的那块地，世界 XZ、米。给创建人物对话框那张俯视选位图用。
   *
   * 这道测量只能由渲染器做：道具是用户自备的 GLB / OBJ，`PropLoader` 刻意不做归一化
   * 缩放，尺寸因此只活在 three 的场景图里，`domain/scene.ts` 的 `PrevizProp` 一个字段
   * 都说不出它多大。量完交出去的是四个纯数字，选位图那条链上再没有 three。
   *
   * 取的是世界**轴对齐**包围盒的 XZ 投影，不是真实剪影：一张转了 30° 的长桌会画成把它
   * 整个裹住的那个正矩形，比真形大一圈。这是有意的——求真剪影要对投影后的顶点求凸包，
   * 代价随三角面数走，而目标只是一张 320 px 的缩略图。
   *
   * **不复用 `boundsOf()`**：那个函数空盒时换成一个人体尺寸的占位盒，答的是「用户点了
   * 聚焦、可对象没有几何体，画面上该看到什么」。这里空盒的正确答案是「没有轮廓」——
   * 照搬会给一件模型还没下完的道具画出一块人体大小的假地面，比什么都不画更误导。
   *
   * 只量道具：人物的轮廓是个 0.4 m 的圆，在这张图上和一颗参照点几乎一样大；机位的
   * 包围盒含取景视锥，一台 35mm 机位的锥体能盖住半个场地，画上去会把整张图淹掉。
   */
  propFootprints(): PrevizTopDownFootprint[] {
    const footprints: PrevizTopDownFootprint[] = [];
    this.measureProps((object, box) => {
      footprints.push({
        id: object.id,
        minX: box.min.x,
        maxX: box.max.x,
        minZ: box.min.z,
        maxZ: box.max.z,
      });
    });
    return footprints;
  }

  /**
   * 每件看得见的道具在**本地**坐标下的 XZ 半尺寸，喂给 `evaluateSceneAt` 的移动辅助
   * 那一轮。
   *
   * 与 `propFootprints()` 的分工是「本地 vs 世界」：那一份是给选位图画地用的，一次
   * 快照就够；这一份要跟着**走位中的**道具走，所以世界盒得由求值层拿那一帧解算出的
   * transform 现算（`domain/moveAssist.ts` 的 `propWorldBox`），这里给的数里不能含位置。
   *
   * 量法与筛选口径与 `propFootprints()` 逐条对齐——图上画着地的那件道具，播放时就该
   * 推得动人；反过来，图上没有的东西不该在暗处把人挡开。两处走同一个 `measureProps`。
   */
  propExtents(): PrevizPropExtent[] {
    const extents: PrevizPropExtent[] = [];
    this.measureProps((object, box) => {
      const node = this.graph.nodeFor(object.id);
      if (!node) return;
      // 节点上已经套过一次 `transform.scale`，量出来的世界盒含它。不除掉，缩放就被乘
      // 两遍：一件放大到 3 倍的道具，人会离它九倍远。
      const scaleX = Math.abs(node.scale.x);
      const scaleZ = Math.abs(node.scale.z);
      // 缩放为 0 除下去是 Infinity，`propWorldBox` 会给出一个铺满整个平面的盒子，
      // 全场的人都被推到 NaN 上。缩放到 0 的道具在画面上本来也看不见。
      if (!(scaleX > 0) || !(scaleZ > 0)) return;
      extents.push({
        id: object.id,
        halfX: (box.max.x - box.min.x) / 2 / scaleX,
        halfZ: (box.max.z - box.min.z) / 2 / scaleZ,
      });
    });
    return extents;
  }

  /**
   * 遍历每件**看得见的**道具，量一次世界包围盒，把过得了体检的交给回调。
   *
   * 空盒（`Box3.makeEmpty()` 的初值 min=+∞ / max=-∞）跳过，不兜底：那是「模型还在下载
   * 或者下载失败了」。这里**不能**照搬 `boundsOf()` 那条兜底——那个函数空盒时换成一个
   * 人体尺寸的占位盒，答的是「用户点了聚焦、可对象没有几何体，画面上该看到什么」。
   *
   * `isEmpty()` 判的是 max < min，两端同时是 +∞ 或同时是 NaN 都过得去它，所以另外查一
   * 遍有限性。真放出去的话，下游的跨度会变成 Infinity / NaN——选位图缩成一个点、每次
   * 点击都映射成 NaN，或者移动辅助把全场的人推到 NaN 上，而画面上没有任何提示。
   *
   * 只量道具：人物的轮廓是个 0.4 m 的圆，在这张图上和一颗参照点几乎一样大；机位的
   * 包围盒含取景视锥，一台 35mm 机位的锥体能盖住半个场地，画上去会把整张图淹掉。
   */
  private measureProps(visit: (object: PrevizObject, box: THREE.Box3) => void): void {
    for (const object of this.currentScene?.objects ?? []) {
      if (object.kind !== 'prop' || !object.visible) continue;
      const node = this.graph.nodeFor(object.id);
      if (!node) continue;
      const box = new this.three.Box3().setFromObject(node);
      if (box.isEmpty()) continue;
      if (![box.min.x, box.max.x, box.min.z, box.max.z].every(Number.isFinite)) continue;
      visit(object, box);
    }
  }

  /**
   * 按场景画幅出一张 PNG。有活动机位就从机位出片，否则出当前编辑视角。
   * 场景还没灌进来时返回 null。
   */
  async capture(): Promise<Blob | null> {
    // 录制期间不出图：下面那段 finally 做的正是「把辅助物还成可见」，还回去之后手柄、
    // 轨迹与机位锥体就被烤进后面每一帧成片里，同 `renderCameraPreview`。
    if (this.disposed || this.recording) return null;
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
   * 开一次录制：把视口画布的位图钉到出片分辨率，交出这块画布和「把第 N 帧画上去」的手柄。
   *
   * 每帧直接画进屏幕上这块 WebGL 画布，编码器用 `captureStream` 从它上面采样，而不是像
   * `capture()` 那样走离屏目标再把像素读回来。读回是同步的，要等 GPU 把整条流水线排空，
   * 再加上 8 MB 的 CPU 翻行与 `putImageData`，每帧要卡 50 多毫秒——用户 1080p 的录制
   * 因此只剩 18fps 左右。画在屏幕上则一帧只渲染一次，没有任何读回。
   *
   * 代价是录制期间视口显示的就是出片画面本身（object-fit 留白），不再是编辑视图：位图
   * 尺寸与 CSS 盒子不再一致，rAF 循环与 resize() 也都停掉（见 `tick` / `resize`），免得
   * 把编辑视图或监看框画上去盖掉刚出的那一帧。`end()` 一次性把这些都还回去。
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

    // 手柄、轨迹辅助物、描边名牌、以及出片机位自己的锥体，都不该进画面。藏一次、end()
    // 时还一次就够——前提是录制期间没有别人把它们还回去：四视图那三个离屏预览的 finally
    // 恰恰会（它们跟着播放头重画，而播放头正是录制在推），所以那三个方法录制期间直接
    // 不画，见 `renderCameraPreview` / `renderQuadPreview` / `renderCameraView`。
    this.gizmo?.setHelperVisible(false);
    this.setEditorHelpersVisible(false);
    this.overlays?.setSuppressed(true);
    if (cameraNode) cameraNode.visible = false;

    const { width, height } = OUTPUT_PIXEL_SIZE[aspect];
    this.recording = true;
    // 先定 object-fit 再改尺寸：位图一改尺寸，下一次合成就按 CSS 盒子拉伸。先把 contain
    // 落下，屏幕上一帧拉伸的画面都不会出现——出片画幅与视口不同时留白，而不是变形。
    this.canvas.style.objectFit = 'contain';
    // DPR 钉成 1：位图就是出片尺寸，不是出片尺寸再乘 DPR。编码器采的是位图像素。
    this.renderer.setPixelRatio(1);
    // updateStyle=false：CSS 盒子不动，只改位图；上面那行 object-fit 负责把它摆进盒子。
    this.renderer.setSize(width, height, false);
    // 录制中拖一下视口会改导演视角，而那正是全局录制的出片相机。
    const controlsWereEnabled = this.controls.enabled;
    this.controls.enabled = false;

    let ended = false;
    return {
      canvas: this.canvas,
      width,
      height,
      drawFrame: (frame, liveId) => {
        if (ended || this.disposed) return;
        // 先解算再渲染：setFrame 把这一帧的走位写进节点。它顺手标的 needsRender 在录制
        // 期间被 tick 忽略，视口上看到的就是下面画出的出片画面本身。
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
            this.renderer.render(this.scene, monitor);
          } finally {
            shotNode.visible = wasVisible;
          }
          return;
        }
        // 导演视角的 aspect 跟着视口走，和出片画幅无关。借用它出片得先改，画完立刻还回去：
        // 录制中别的读编辑相机的路径（取景、拾取）不该拿到出片画幅。
        const editorAspect = this.camera.aspect;
        this.camera.aspect = aspectRatio(aspect);
        this.camera.updateProjectionMatrix();
        try {
          this.renderer.render(this.scene, this.camera);
        } finally {
          this.camera.aspect = editorAspect;
          this.camera.updateProjectionMatrix();
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.recording = false;
        this.controls.enabled = controlsWereEnabled;
        this.canvas.style.objectFit = '';
        if (cameraNode) cameraNode.visible = true;
        this.overlays?.setSuppressed(false);
        this.setEditorHelpersVisible(true);
        this.gizmo?.setHelperVisible(true);
        // resize() 而不是 requestRender()：位图要从出片分辨率回到容器尺寸乘 DPR，录制中
        // 被压下的那次视口尺寸变化也在这里落地；而且它当场画一帧，画布不会空着等 rAF。
        this.resize();
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

  /**
   * 等这个对象的模型到位之后再取景。导入模型走这条路，不走 `focusObject`。
   *
   * 因为**这一刻还量不出它有多大**：`addObject` 返回时节点上挂的是占位方块，资产还在
   * 网上。这时聚焦框住的是那个方块，等真模型换进来，相机早已停在按方块算出的距离上——
   * 一份几百米的建筑于是把相机整个包在里面，画面是一片白墙（更糟的是一片黑，因为看到的
   * 是背面）。用户看不出发生过什么，只知道「导入完什么都没有」。
   *
   * 对象在模型到达之前被删掉、或者加载失败，这个意向就一直挂着不生效——不设超时是有意的：
   * 加载失败后用户改一次属性就是一次重试（见 `syncPropModel`），那次成功时取景仍然是他要的。
   */
  focusObjectWhenReady(objectId: string): void {
    this.pendingFocusId = objectId;
  }

  /** 模型换入的回调里调。不是等的那个就放过——人物模型也走同一个回调。 */
  private resolvePendingFocus(objectId: string): void {
    if (this.pendingFocusId !== objectId) return;
    this.pendingFocusId = null;
    this.focusObject(objectId);
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
    // 录制期间不画：这些离屏预览的 finally 会把辅助物的可见性「还」成可见，而录制正
    // 靠它们一直藏着，见 `startRecording`。
    if (this.disposed || this.recording) return;
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
   * 把一份人物草稿的木偶画到创建对话框那块预览画布上。
   *
   * 与 [renderCameraPreview] 一样借视口那个场景：这个人建出来会站在戏里，用户在这块预览
   * 上要看的正是「他站在那儿是什么样」。木偶只在离屏那一趟里挂进场景，画完立刻摘掉，
   * 视口那边一帧都撞不见它（见 `renderCharacterPreview`）。
   *
   * 返回 Promise 是因为真模型要 await 骨架克隆。调用方可以不等——不等就是「这一帧先不
   * 管，画好了自然会出现」；连着调用也是安全的，但两种情形的收场不一样，见
   * `renderCharacterPreview`（`characterPreview.ts`）的函数头：换木偶的那种是后发赢、
   * 先发把手里那具丢掉；只改参数的那种是先发赢，它挂载前会按最后一份草稿补刷。
   */
  async renderCharacterPreview(
    canvas: CameraPreviewCanvas,
    draft: PrevizCharacterDraft,
  ): Promise<void> {
    // 录制期间不画，同 `renderCameraPreview`：下面 finally 里那次「还」成可见会把手柄
    // 的 helper 送进正在录的那一帧里。
    if (this.disposed || this.recording) return;
    // 骨架工厂是 `create()` 里建的，走 `new PrevizRenderer()` 之外的路进不来；没有它
    // 就没有木偶可建。
    if (!this.characterRig) return;
    if (!this.characterStage) this.characterStage = createCharacterPreviewStage(this.three);

    // 预览场景里没有手柄，但离屏 pass 结束时要 requestRender 视口那一帧，而 helper 的
    // 可见性是全局的：一并按 `renderCameraPreview` 那套来，两条路径不要各走各的。
    this.gizmo?.setHelperVisible(false);
    try {
      await renderCharacterPreview(
        {
          three: this.three,
          renderer: this.renderer,
          worldScene: this.scene,
          holder: this.characterStage.holder,
          camera: this.characterStage.camera,
          canvas,
          rig: this.characterRig,
          // 上面那个 `disposed` 只挡了进门那一刻；模型下载几秒钟，用户完全来得及在这
          // 期间关掉预演台。醒来还照画的话，渲染器已经 `forceContextLoss()` 过了。
          alive: () => !this.disposed,
        },
        draft,
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
    // 同 `renderCameraPreview`：录制期间不画。四视图是跟着播放头重画的，而播放头正是
    // 录制在推，不挡住的话手柄会被烤进后面每一帧，还要连带四趟离屏读回。
    if (this.disposed || this.recording) return;

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
   * 把整场戏从上往下画进一块画布，并回传它实际用的取景框；画不了就回 `null`。
   *
   * 创建人物对话框左栏那张选位图用的就是它。走的是四视图那条现成的路
   * （`orthoPlacement(…, 'top', …)` + `renderOrthoPreview`），所以左栏这张图与四视图的
   * 俯视图是同一台相机、同一套取景——用户在两处看到的是同一个场景的同一个样子。
   *
   * **回传取景框是这个方法存在的理由**：选位图的世界↔画布换算必须与真正画出来的那一帧
   * 一致。两边各算各的话（那边按 `sceneTopDownBounds` 框、这边按包围球开窗），用户点在
   * 画面上某处、人却落在别处，而这种错位在一张静态图上一点都看不出来。
   *
   * 取景框转成 [PrevizTopDownView] 走的是 `topDownView()` 而不是自己写公式：正交窗口的
   * 半宽半高就是「画布中心 ± 多少米」，与那个纯函数吃的地块是同一件东西，让它去算，
   * 退化输入（空场景、0 尺寸画布）的兜底也一并共用。窗口的宽高比与画布的宽高比在
   * `orthoPlacement` 把画幅比夹进 `FRAMING_ASPECT` 时会分家，那时两个方向的比例不再
   * 相等，`topDownView` 取小的那个——画面在另一个方向上会比换算以为的更宽。选位图是
   * 正方形的，够不着那条夹取。
   */
  renderTopDownMap(canvas: CameraPreviewCanvas): PrevizTopDownView | null {
    // 同 `renderQuadPreview`：dispose 之后与录制期间不画。回 `null` 而不是画一块黑，
    // 调用方那边有一张 2D 示意图可以回落，那比空白有用。
    if (this.disposed || this.recording) return null;

    // 与四视图共用那台常驻的临时相机：两处不会同时在画（都是同步的），而每次新建一台
    // 会在用户拖着改站位时一秒钟丢几十个对象。
    if (!this.orthoCamera) this.orthoCamera = new this.three.OrthographicCamera();

    const width = Math.max(1, Math.floor(canvas.width));
    const height = Math.max(1, Math.floor(canvas.height));
    // 不走 [sceneBounds]：它空场景时回落成一个人体尺寸的占位盒，见 TOP_DOWN_EMPTY_BOUNDS。
    const bounds =
      unionBounds(this.visibleNodes().map((node) => this.boundsOf(node))) ?? TOP_DOWN_EMPTY_BOUNDS;
    const placement = orthoPlacement('top', bounds, width / height);

    // 手柄的 helper 贴着屏幕大小画，在这张缩略图里会糊满整块画布。理由与四视图那条
    // 一模一样，两处的取舍不要分家。
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

    // 相机站在注视点正上方，所以取景框的中心就是注视点的 xz。
    return topDownView(
      {
        minX: placement.target[0] - placement.halfWidth,
        maxX: placement.target[0] + placement.halfWidth,
        minZ: placement.target[2] - placement.halfHeight,
        maxZ: placement.target[2] + placement.halfHeight,
      },
      width,
      height,
    );
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
    // 同 `renderCameraPreview`：录制期间不画。
    if (this.disposed || this.recording) return;
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
    // 录制期间谁都别动导演视角：全局录制没指定机位的那些帧就是从这台相机出的，中途
    // 跳一下，后面每一帧都换了机位，成片上却看不出发生过什么。停掉 OrbitControls 只
    // 挡住了鼠标，H / F 与视口控件那几个按钮走的是这条路——三条路都汇到这里。
    if (this.recording) return;
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
   * 编辑器自己的辅助物在镜头里的总开关：地面网格、轨迹曲线与轨迹点、人物脚下的辨识
   * 环与朝向箭头、机位的机身与视锥。
   *
   * 它们属于编辑视图，不属于镜头：机位停在自己的轨迹上是「机位走位」的常规用法，
   * 而那时轨迹点小球就贴在镜头原点上，监看框与成片都会被一团白糊满。
   *
   * 分两趟是因为它们挂在两个层级上。scene 的直接子节点按 `previzEditorOnly` 标记扫，
   * 而不是记一份句柄：之后再往 scene 上挂别的辅助物（标尺、安全框），打上标记就自动
   * 跟着一起藏。标记与机身则挂在对象节点下面，隔了一层，由场景图自己那趟负责。
   */
  private setEditorHelpersVisible(visible: boolean): void {
    for (const child of this.scene.children) {
      if (child.userData.previzEditorOnly) child.visible = visible;
    }
    this.graph.setFurnitureVisible(visible);
  }

  private start(): void {
    const tick = () => {
      if (this.disposed) return;
      // update() 返回 true 表示相机确实动了（阻尼余速也算）。静止时跳过 render，
      // 否则一个只有网格和两盏灯的静态场景会在全屏里 60fps 空烧 GPU。
      // 录制期间整个跳过：画布上此刻是 drawFrame 刚出的那一帧，captureStream 采的就是
      // 它，这里再画一遍编辑视图或监看框就把出片画面盖掉了，还白白多渲染两次。
      if (!this.recording && (this.controls.update() || this.needsRender)) this.renderFrame();
      this.rafHandle = window.requestAnimationFrame(tick);
    };
    this.rafHandle = window.requestAnimationFrame(tick);
  }

  /** 主视图加监看框画一遍，顺手把待绘标记清掉。tick 与 resize() 共用。 */
  private renderFrame(): void {
    this.needsRender = false;
    this.syncDepthRange();
    this.renderer.render(this.scene, this.camera);
    this.renderMonitor();
  }

  /**
   * 把视口相机的深度范围调到装得下当前轨道距离。
   *
   * 放在每帧开头而不是 `moveCamera` 里：OrbitControls 的滚轮推拉直接改 `camera.position`，
   * 根本不经过 `moveCamera`——挂在那里的话，用户滚出去看大场景时远平面纹丝不动，
   * 而那正是最需要它动的时候。
   *
   * 值没变就不碰投影矩阵：`updateProjectionMatrix()` 每帧调虽然便宜，但它会让相机的
   * 投影矩阵每帧都算一遍新对象，静止画面上白白产生垃圾。
   */
  private syncDepthRange(): void {
    // 手算而不是 `position.distanceTo(target)`：与 `focusObject` 里那段同一个理由——
    // 这一层只依赖注入进来的 three 模块的**数据**形状，不依赖 Vector3 的方法表。
    const range = orbitDepthRange(
      Math.hypot(
        this.camera.position.x - this.controls.target.x,
        this.camera.position.y - this.controls.target.y,
        this.camera.position.z - this.controls.target.z,
      ),
    );
    if (this.camera.near === range.near && this.camera.far === range.far) return;
    this.camera.near = range.near;
    this.camera.far = range.far;
    this.camera.updateProjectionMatrix();
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
    // 木偶待在一个游离的 `holder` 下面、不在 `this.scene` 底下，下面那次 traverse 扫不
    // 到它。清完把字段也放掉：`disposeCharacterPreviewStage` 摘的是 `holder` 的孩子，
    // 留下的是一个空容器加一台相机，「字段非空就是能用」在这之后是假的。今天走不到
    // ——`renderCharacterPreview` 进门就被 `disposed` 挡了——纯粹是不留一个已经作废的
    // 句柄在手上。
    if (this.characterStage) disposeCharacterPreviewStage(this.characterStage);
    this.characterStage = null;
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

  /** 测试用：深度范围是每帧跟着轨道距离重算的，断言它不必去戳 three 的相机。 */
  cameraDepthRangeForTest(): PrevizDepthRange {
    return { near: this.camera.near, far: this.camera.far };
  }
}

/** 站在 (x, y, z) 上、脚底贴 y 的一个人体尺寸盒子。 */
function placeholderBounds(x: number, y: number, z: number): PrevizBounds {
  return {
    min: [x - PLACEHOLDER_HALF_WIDTH_M, y, z - PLACEHOLDER_HALF_WIDTH_M],
    max: [x + PLACEHOLDER_HALF_WIDTH_M, y + PLACEHOLDER_HEIGHT_M, z + PLACEHOLDER_HALF_WIDTH_M],
  };
}
