// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { clampToRange, DEG_TO_RAD } from '../domain/camera';
import { PREVIZ_HEIGHT_CM_RANGE } from '../domain/objects';
import {
  PREVIZ_SCALE_RANGE,
  type DisplayMode,
  type OutputAspect,
  type PrevizCamera,
  type PrevizCharacter,
  type PrevizObject,
  type PrevizProp,
  type PrevizScene,
  type Vec3,
} from '../domain/scene';
import { buildCameraModel, syncCameraFrustum } from './cameraModel';
import { disposeRigMaterials, type CharacterRigFactory } from './characterRig';
import type { PropLoader } from './propLoader';

/** three 命名空间本体。以构造参数传入，绝不在本文件里 import —— 见类注释。 */
export type ThreeModule = typeof THREE;

/**
 * 半透明模式的不透明度。设计文档「显示模式」一节定的 0.35。
 *
 * 导出是给 Task 8 / Task 9 那些自己往节点上挂材质的模块用的，让它们不必再猜一个数。
 * 单元测试**刻意不 import 它**而是写字面量 0.35：期望值从被测模块读回来，改一处两边
 * 一起变，等于什么都没锁住。
 */
export const PREVIZ_TRANSLUCENT_OPACITY = 0.35;

/**
 * 人物占位胶囊的半径，单位米。0.22 m 是成年人肩宽的一半上下，粗到一眼看得出是个人、
 * 细到不至于把相邻的两个人物粘在一起。
 *
 * 它同时是一条尺寸约束：胶囊中段长度是「身高 − (2 − `PLACEHOLDER_NECK_RATIO`) × 球头半径
 * − 2 × 胶囊半径」，必须为正
 * ——球头要露在胶囊之上，胶囊本身就得比身高矮一截，见 `PLACEHOLDER_NECK_RATIO`。身高先
 * 夹进 `PREVIZ_HEIGHT_CM_RANGE` 再相减，具体余量归 `domain/objects.ts` 的下界管，这里不复述。
 * 改大这个半径前先跑 scene-graph 测试里的「clamps heightCm so the capsule never degenerates」，
 * 那条用例锁的就是这条不变式。
 */
export const PREVIZ_PLACEHOLDER_RADIUS = 0.22;

/**
 * 占位体那颗球头的半径，占胶囊半径的几成。0.9 没有推导，是照 upstream 的观感取的：
 * 比肩宽窄一档，大到远看认得出是个头，小到不至于把胶囊顶成一个葫芦。
 *
 * 球露出胶囊多少米由两个比例合起来决定，这一个也是线性的一半：露出 =
 * (2 − `PLACEHOLDER_NECK_RATIO`) × 球头半径，而球头半径 = `PREVIZ_PLACEHOLDER_RADIUS` ×
 * 这个比例。0.9 是 0.297 m，减到 0.5 就只剩 0.165 m——头缩成一个疙瘩，不是「只是小一点」。
 *
 * 两条硬边界，都有 scene-graph 的头部用例兜着，别当成纯观感参数随手调：
 * ① 球头半径必须小于胶囊半径，否则顶上去的是一把伞不是一个头；
 * ② 胶囊中段长度「身高 − (2 − `PLACEHOLDER_NECK_RATIO`) × 球头半径 − 2 × 胶囊半径」必须为正。
 * ②在下界身高 1.2 m 上把这个比例开到 2 都还是正的（1.2 − 0.66 − 0.44 = 0.1），所以先把你
 * 拦下来的是①那条红测试。
 */
const PLACEHOLDER_HEAD_RADIUS_RATIO = 0.9;

/**
 * 球头往胶囊里埋多深，按球头半径计。0.5 就是埋进去半个球半径。
 *
 * 两头都不能碰：
 * 取 0，球底与胶囊顶只在一个点上相切。两件都是低分段多面体（胶囊 capSegments=4，
 * 球 heightSegments=12），面全部塌在理想曲面内侧，相切点两侧当场裂开一条缝——画面上是
 * 一颗浮在杆子上的球，不是一个人。
 * 取到 2，球被整个吞回胶囊里：球心的高度由「轮廓顶 = 身高」定死，能动的只有胶囊，
 * 埋深到了 2 倍球半径胶囊正好长到与球内切，露出 0 —— 这次整改之前那份代码等价的就是 2，
 * 而当时那两条尺寸断言一条都没红，因为它们锁的是轮廓顶，不是「看不看得见」。
 *
 * 露出的高度是「(2 − 这个比例) × 球半径」，与身高无关：取 0.5 就是 1.5 × 0.198 = 0.297 m。
 */
const PLACEHOLDER_NECK_RATIO = 0.5;

/** 球头半径，米。只由上面两个比例决定，与身高无关。 */
const PLACEHOLDER_HEAD_RADIUS = PREVIZ_PLACEHOLDER_RADIUS * PLACEHOLDER_HEAD_RADIUS_RATIO;

/** 球头埋进胶囊的深度，米。 */
const PLACEHOLDER_NECK = PLACEHOLDER_HEAD_RADIUS * PLACEHOLDER_NECK_RATIO;

/**
 * 胶囊本体的总高，米。比身高矮「球头直径 − 脖子」那么多：矮出来的这一截正好是球头
 * 露在胶囊之上的部分，两件加起来轮廓顶仍然落在身高线上。
 */
function placeholderBodyHeight(height: number): number {
  return height - PLACEHOLDER_HEAD_RADIUS * 2 + PLACEHOLDER_NECK;
}

/** 全灰模式的统一颜色。 */
const CLAY_COLOR = 0xb9bec8;

/**
 * 单件占位体的分类色。机位与人物都不在表里，理由是同一条：颜色由别处管，
 * 在这里留一个用不到的项只会让人以为改它能改出效果。机位是 `cameraModel.ts` 建的
 * 一台多色摄影机；人物用的是自己那个辨识色（`PrevizCharacter.color`）——一颗固定的
 * 分类蓝会让模型没到位的那几秒里四个人物长得一模一样。
 */
export const KIND_COLOR: Record<Exclude<PrevizObject['kind'], 'camera' | 'character'>, number> = {
  light: 0xfff3b0,
  prop: 0x9ad0a0,
};

/**
 * 占位体那份材质。三处占位体（人物胶囊、人物球头、灯球 / 方块）用的是同一组参数，
 * 抠出来是为了让「哪一处的粗糙度写得不一样」这种事没法发生——它渲染出来只是某一件
 * 占位体看着比别的亮一点，没人会去查。
 */
function placeholderMaterial(three: ThreeModule, color: number | string): THREE.Material {
  return new three.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 });
}

/**
 * 人物的占位体：一根胶囊加头顶那颗球，脚底落在自身原点（也就是对象节点的原点）上。
 *
 * 是「胶囊 + 球头」而不是一根光胶囊：胶囊上下对称，光看它认不出头在哪一头，而
 * 「简化圆柱体」这一档人物是要一直停在占位体上的（不加载 GLB），不是只撑那几秒。
 *
 * 做成模块级函数而不是留在 `PrevizSceneGraph` 里：创建人物对话框那块木偶预览要画的是
 * 同一件东西（`engine/characterPreview.ts`），而它手里没有场景图。尺寸只有这一份，
 * 两边就不会漂——身高、半径、球头比例任何一处对不上，都表现为「对话框里预览的人和
 * 建出来的人不一样高」。
 */
export function createCharacterPlaceholder(
  three: ThreeModule,
  character: Pick<PrevizCharacter, 'heightCm' | 'color'>,
): THREE.Object3D {
  const heightCm = clampToRange(character.heightCm, PREVIZ_HEIGHT_CM_RANGE);
  const height = heightCm / 100;
  const radius = PREVIZ_PLACEHOLDER_RADIUS;
  // 胶囊只占身高的一部分，剩下的归露在外面那截球头（见 `placeholderBodyHeight`）。
  const body = placeholderBodyHeight(height);
  // CapsuleGeometry(radius, height, …)：第二参数是两个半球之间那段柱体的高度
  // （three 0.185 的形参名就叫 height），胶囊总高是它加上两个半径，所以先减掉。
  const capsule = new three.Mesh(
    new three.CapsuleGeometry(radius, body - radius * 2, 4, 12),
    placeholderMaterial(three, character.color),
  );
  // 胶囊自身以原点为中心，抬高半个**胶囊**高才让脚底落在 y=0 的地面网格上。
  capsule.position.set(0, body / 2, 0);
  capsule.userData.previzPlaceholder = true;
  // 占位体自己记住本色，`applyDisplayMode` 从全灰切回来时就地读它。
  capsule.userData.previzPlaceholderColor = character.color;
  // 建这个胶囊时用的是哪个身高。`resizePlaceholder` 靠它判断要不要重建。
  capsule.userData.previzPlaceholderHeightCm = heightCm;
  capsule.add(createPlaceholderHead(three, height, character.color));
  return capsule;
}

/**
 * 占位胶囊头顶那颗球。挂在**胶囊这个 Mesh 底下**，而不是做它的兄弟：做成兄弟，凡是把
 * 「占位体」当成对象节点下**一个**直接子节点来找、来加的地方都得改成复数——
 * `resizePlaceholder` 的 `find` + 单次 `remove`、`revertToPlaceholder` 那道 `some` 守卫、
 * 以及 `createPlaceholder` 的单次 `add`。（`swapInCharacterModel` 是例外，它删的是**所有**
 * 带标记的直接子节点。）挂进胶囊里，这些地方一处都不用动。
 *
 * 于是这里的 y 是在**胶囊自己的局部坐标**里算的，不是对象节点的。要同时守住两条：
 * ① 整件占位体的轮廓顶正好落在身高线上——`PrevizRenderer` 聚焦时量的是节点的世界
 *   包围盒，球顶出去一截等于给这个人凭空加了身高，取景距离会跟着一起错；
 * ② 球心必须高过胶囊顶，也就是这颗球至少有半个露在外面。只守①是不够的：①对「球在
 *   哪」根本没有约束（球顶固定在身高线上，球心也就固定了，剩下能动的只有胶囊），
 *   把胶囊拉到与身高等高，球整个陷进去，①照样成立而画面上是一根光胶囊。
 */
function createPlaceholderHead(
  three: ThreeModule,
  height: number,
  color: number | string,
): THREE.Object3D {
  const head = new three.Mesh(
    new three.SphereGeometry(PLACEHOLDER_HEAD_RADIUS, 16, 12),
    placeholderMaterial(three, color),
  );
  // 球心的世界高度由不变式①定死：球心 = 身高 − 球半径。减掉胶囊自己那份抬升就换算
  // 成了胶囊的局部坐标。化简下来是 (身高 − 脖子) / 2，写成这样是为了看得出它从哪来。
  const centre = height - PLACEHOLDER_HEAD_RADIUS - placeholderBodyHeight(height) / 2;
  head.position.set(0, centre, 0);
  head.userData.previzPlaceholderHead = true;
  // 球头也算一份占位体。少了这个标记，`applyDisplayMode` 回色时走不到占位体那一支，
  // 这颗球就再也不会被回色，永远停在建出来时的那个颜色上——改过辨识色之后，场上站着
  // 一个换了身子没换头的两色人。
  head.userData.previzPlaceholder = true;
  head.userData.previzPlaceholderColor = color;
  return head;
}

/**
 * 视图叠加层（描边、名牌）的标记。它们的资源由 `viewOverlays.ts` 独家持有：染色要跳过
 * 它们（描边是纯色轮廓，染成水泥灰就没有轮廓可言），回收也要跳过（几何体是跟源网格
 * 借的，材质是全局共用的）。
 */
export const PREVIZ_OVERLAY_KEY = 'previzOverlay';

/**
 * 人物脚下那圈辨识环的内外半径，单位米。外径比占位胶囊的半径（0.22）大一圈，
 * 站位重叠时两个人的环仍然分得开；内径留空是为了别把脚整个盖住。
 */
const MARKER_INNER_RADIUS = 0.3;
const MARKER_OUTER_RADIUS = 0.36;

/**
 * 辨识环离地的高度，单位米。地面网格就画在 y=0 上，两个共面的东西在透视投影下会
 * 逐像素争谁在前（z-fighting），环会闪成一圈虚线。抬一毫米就够，抬多了在低机位下
 * 看得出它浮着。
 */
const MARKER_LIFT = 0.001;

/** 朝向箭头的落点：环外一点点的 -Z。对象在零旋转时脸朝 -Z，箭头指的就是这个方向。 */
const MARKER_ARROW_Z = -(MARKER_OUTER_RADIUS + 0.1);

/**
 * 位置与旋转没有值域，只有「必须有限」这一条。非有限分量落到 0：
 * NaN 会顺着 `updateMatrixWorld` 污染整棵子树的世界矩阵，物体从画面上凭空消失，
 * 而 three 一声不吭——症状离病因隔着整个引擎层。
 *
 * 这不是第二份 clamp：`clampToRange` 要一段区间，而这里没有区间可给。凡是有现成
 * 区间常量的字段（缩放、身高）走的都是 `clampToRange`。
 */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 场景图同步器：把 `PrevizScene.objects` 映成 three 的对象树，并按 id 做增量增删改。
 *
 * three 通过构造参数注入而不是本文件 import，理由有两条，都不是洁癖：
 * 一是 jsdom 里建不出 WebGL 上下文，注入之后可以喂假 three 单测结构行为；
 * 二是任何一处静态 `import 'three'` 都会把 three 从懒加载 chunk 里拽出来，
 * 预演台「不打开就不下载」的整个前提就没了。
 *
 * 本类只建占位几何体。真模型（人物 GLB、物件 GLB）由 `characterRig` /
 * `propLoader` 异步挂到同一个节点下面，占位在模型到位后移除。
 */
export class PrevizSceneGraph {
  private readonly nodes = new Map<string, THREE.Object3D>();
  private displayMode: DisplayMode | null = null;

  /** 上一次 `sync` 见到的出片画幅。机位视锥的宽高比取自它。 */
  private outputAspect: OutputAspect = '16:9';
  /** 由 `PrevizRenderer.create()` 注入；没注入时人物一直用占位胶囊。 */
  private characterRig: CharacterRigFactory | null = null;
  private onModelReady: (() => void) | null = null;
  /**
   * 人物模型请求的流水号发号器。每发一次请求就给那个节点记一个新号，模型回来时号对
   * 不上就整份丢掉（见 `swapInCharacterModel`）。
   *
   * 它替掉了原来那个「请求过没有」的布尔，而不是与之并存：作废一次在途请求和允许下一次
   * 重发本来就是同一件事，拆成两份状态迟早有一处忘了同步，而忘一处的代价是人物永久停在
   * 胶囊上，或者同一个节点上叠两副骨架。
   */
  private rigToken = 0;
  /** 由 `PrevizRenderer.create()` 注入；没注入时物件一直用占位方块。 */
  private propLoader: PropLoader | null = null;

  constructor(
    private readonly three: ThreeModule,
    private readonly root: THREE.Object3D,
  ) {}

  /**
   * 接上人物模型工厂。`onReady` 在每个模型换入之后调一次：模型是异步到的，
   * 按需重绘的循环这时早就静下来了，不主动请求一帧的话人物要等到用户下一次动鼠标才出现。
   */
  attachCharacterRig(factory: CharacterRigFactory, onReady: () => void): void {
    this.characterRig = factory;
    this.onModelReady = onReady;
  }

  /** 接上物件模型加载器。重绘回调与人物共用 `attachCharacterRig` 传进来的那个。 */
  attachPropLoader(loader: PropLoader): void {
    this.propLoader = loader;
  }

  nodeFor(objectId: string): THREE.Object3D | undefined {
    return this.nodes.get(objectId);
  }

  /**
   * 挂在对象节点下面的那批「画在场景里的界面」在镜头里的开关：人物脚下的辨识环与
   * 朝向箭头、机位的机身与视锥。
   *
   * 它们和 scene 上那批 `previzEditorOnly` 是同一件事，却够不着同一个循环——那个循环
   * 扫的是 scene 的**直接**子节点，而这两样都隔着一层对象节点。少了这一趟，用户拿到的
   * 成片里就有一圈蓝环和满屏的机位锥体线：录制那条路以为自己已经把辅助物藏干净了。
   *
   * 只走对象节点的直接子节点，不 traverse 整棵树：标记与机身建出来就挂在这一层
   * （见 `createNode` / `createPlaceholder`），再往下是人物 GLB 那具骨架的
   * 六十来个节点（`UAL1_Standard.glb`：`nodes` 67 个、蒙皮 65 根骨头），白走。
   */
  setFurnitureVisible(visible: boolean): void {
    for (const node of this.root.children) {
      for (const child of node.children) {
        if (child.userData.previzMarker || child.userData.previzCameraModel) {
          child.visible = visible;
        }
      }
    }
  }

  /**
   * 把某一帧的姿势推到人物的模型上。求值器每帧给出姿势与姿势内时间，沿路径走位的人物
   * 靠它真的迈腿。模型还没到（还是占位胶囊）或者没接工厂时无事可做：模型到位那一刻
   * 渲染器会把当前帧重放一遍。
   */
  applyPose(objectId: string, poseId: string, poseTime: number): void {
    const rig = this.characterRig;
    const model = this.nodes.get(objectId)?.children.find((child) => child.userData.previzRig);
    if (!rig || !model) return;
    rig.applyPose(model, poseId, poseTime);
  }

  /** 把当前场景同步进对象树。可以每帧调，代价是一次 Map 查表加几次赋值。 */
  sync(scene: PrevizScene): void {
    const mode = scene.settings.displayMode;
    // 出片画幅决定机位视锥张多宽，而 `createNode` 拿不到 scene——先记下来。
    this.outputAspect = scene.settings.outputAspect;
    // 显示模式只在变化时整树重刷：它要遍历整棵树改材质并让着色程序失效，每帧跑纯属浪费。
    const modeChanged = this.displayMode !== mode;
    this.displayMode = mode;

    const seen = new Set<string>();
    // 这一帧新建或重建了材质、因而还停在实心态的子树。模式没变时它们要单独补一次。
    const pending: THREE.Object3D[] = [];

    for (const object of scene.objects) {
      seen.add(object.id);
      let node = this.nodes.get(object.id);
      if (!node) {
        node = this.createNode(object);
        this.nodes.set(object.id, node);
        this.root.add(node);
        pending.push(node);
      }

      // 身高是唯一一个会改变占位几何的用户输入（`PrevizObjectPatch` 只排除了 id 与
      // kind，属性面板的身高滑杆直接接在它上面）。几何体建好就不会自己跟着变，
      // 这里显式重建，否则拖完滑杆得到的是一个尺寸与站位都错的胶囊。
      if (object.kind === 'character' && this.resizePlaceholder(node, object)) {
        pending.push(node);
      }
      // 辨识色也是能在属性面板上改的，而占位胶囊只在身高变了时才重建。
      if (object.kind === 'character' && this.recolorPlaceholder(node, object)) {
        pending.push(node);
      }
      if (object.kind === 'character') this.syncMarker(node, object);
      // 机位的视锥同理：焦距、传感器、出片画幅都是能在属性面板上改的，几何体建好
      // 不会自己跟着变。这里不进 `pending`——重画只换几何体，材质原封不动。
      if (object.kind === 'camera') this.syncCameraModel(node, object);

      node.name = object.name;
      node.visible = object.visible;
      node.userData.previzObjectId = object.id;
      node.userData.previzKind = object.kind;
      node.userData.previzLocked = object.locked;

      const { position, rotation, scale } = object.transform;
      const [px, py, pz] = finiteVec3(position);
      node.position.set(px, py, pz);
      // 场景里的角度是度（属性面板直接展示的就是它），three 的 Euler 收弧度。
      // 次序钉死 YXZ——不是 three 的默认 XYZ。预演台把这三个分量当作
      // 偏航 / 俯仰 / 横滚：先绕 Y 转朝向，再绕转过之后的 X 抬头，最后沿视线翻滚。
      // 用 XYZ 的话俯仰绕的是世界 X 轴，偏航 90° 之后它抬的是镜头侧向而不是朝向，
      // 而且横滚固定为 0 时表达不出任意朝向——摄影机创建对话框那三根滑杆就是这么用的。
      const [rx, ry, rz] = finiteVec3(rotation);
      node.rotation.set(rx * DEG_TO_RAD, ry * DEG_TO_RAD, rz * DEG_TO_RAD, 'YXZ');
      // 零与负的缩放压出退化几何（法线全零、包围盒没厚度），手柄抓不住，
      // `view.ts` 的取景距离也跟着算不出来。
      node.scale.set(
        clampToRange(scale[0], PREVIZ_SCALE_RANGE),
        clampToRange(scale[1], PREVIZ_SCALE_RANGE),
        clampToRange(scale[2], PREVIZ_SCALE_RANGE),
      );

      const rig = this.characterRig;
      // 拿名字接住这个返回值：`syncCharacterRig(...)` 直接写在 if 里，读起来像
      // 「sync 成功没有」，而它答的是「这个节点这一帧要不要补一次显示模式」。
      const needsDisplayPass =
        object.kind === 'character' && rig && this.syncCharacterRig(rig, node, object);
      if (needsDisplayPass) {
        // 两种情形共用这一条路：辨识色刚重染过——材质里是本色，而当前显示模式未必要
        // 本色（全灰要盖回水泥灰）；或者刚退回占位体——新材质是按「实心」建出来的，
        // 半透明场景里它会一直停在实心态。少了这一步，全灰模式下改一次颜色就跳出
        // 一个染了色的人。
        pending.push(node);
      }
      const loader = this.propLoader;
      if (object.kind === 'prop' && loader) this.syncPropModel(loader, node, object);
    }

    // 遍历 Map 的过程中删掉当前项在 JS 里是有定义的行为，不需要先复制一份。
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      this.root.remove(node);
      disposeSubtree(node);
      this.nodes.delete(id);
    }

    // 模式没变时，这一帧新建的节点仍然要单独吃一次：它们的材质是按「实心」建出来的，
    // 少了这一步，半透明场景里后加的对象会一直停在实心态。
    if (modeChanged) this.applyDisplayMode(this.root);
    else for (const node of pending) this.applyDisplayMode(node);
  }

  /**
   * 把当前显示模式刷到 `target` 子树上，默认整棵树。新挂进来的模型（GLB）加载完要吃一次；
   * 直播机位熄灯后也要吃一次——它的材质刚被涂回本色，而本色未必是当前模式该显示的色。
   */
  refreshDisplayMode(target: THREE.Object3D = this.root): void {
    this.applyDisplayMode(target);
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      this.root.remove(node);
      disposeSubtree(node);
    }
    this.nodes.clear();
    this.displayMode = null;
  }

  /**
   * 人物的真模型是异步来的：第一次见到这个节点时发一次请求，回来再把占位胶囊换掉。
   * 返回的是「这个节点这一帧要不要补一次显示模式」。
   *
   * 「当前有效的那一次请求」这个流水号记在**节点**上，而不是记在一张按对象 id 的表里：
   * 撤销一次删除会让同一个 id 带着一个全新的节点回来，按 id 记的话那个人物就永远停在
   * 占位胶囊上。请求失败时号会被销掉（见 `swapInCharacterModel`），下一次 sync 就是一次重试。
   *
   * 模型到位之后 `resizePlaceholder` 就再也帮不上忙了——占位体已经被删掉，它直接早退——
   * 身高与体型改由 rig 的缩放接手；少了这一条，属性面板的身高滑杆对已加载的人物完全失效。
   */
  private syncCharacterRig(
    rig: CharacterRigFactory,
    node: THREE.Object3D,
    character: PrevizCharacter,
  ): boolean {
    // 「简化圆柱体」不是一档胖瘦，是「这个人物不要 GLB」：场上人一多，几十副骨架每帧的
    // 姿势解算比几何体本身贵得多，这一档就是让人先把走位摆出来。所以分叉排在发请求
    // **之前**——排在后面的话，一场全是简化圆柱体的戏照样要把演员模型和那份动画库拉
    // 下来（工厂自带缓存，只拉一次，可一次也是白拉），而且每个人物还各付一次
    // `SkeletonUtils.clone` 加一批克隆材质，建完就扔。这一档存在的理由就没了。
    if (character.bodyType === 'capsule') return this.revertToPlaceholder(node, character);
    const model = node.children.find((child) => child.userData.previzRig);
    if (model) {
      // 姿势、身高体型、姿态微调、辨识色一起刷。只刷缩放的话，属性面板的「基础姿势」
      // 下拉框与「姿态微调」三根滑杆对已加载的人物完全失效。
      // 返回的是「辨识色这一次重染过没有」——重染过就要补一次显示模式。
      return rig.applyCharacter(model, character);
    }
    if (node.userData.previzRigToken !== undefined) return false;
    const token = ++this.rigToken;
    node.userData.previzRigToken = token;
    void this.swapInCharacterModel(rig, node, character, token);
    return false;
  }

  /**
   * 把人物退回占位形态：摘掉已经挂上的 rig，缺占位体就补一个。返回是否真的动过树
   * ——动过的话调用方要给这个节点补一次显示模式，新建的占位材质是按「实心」出厂的。
   *
   * 摘 rig 与补占位体缺一不可：只摘不补，这个人物直接从画面上消失，只剩脚下一圈辨识环；
   * 只补不摘，胶囊套在木偶身上两层叠着。
   */
  private revertToPlaceholder(node: THREE.Object3D, character: PrevizCharacter): boolean {
    let changed = false;
    // 与 `syncCharacterRig` 认 rig 的写法保持一致：一个节点上最多只会有一副。
    const model = node.children.find((child) => child.userData.previzRig);
    if (model) {
      node.remove(model);
      // 摘下来要还：rig 为了上辨识色克隆过一批自己的材质，`disposeSubtree` 会照
      // `previzSharedModel` 跳过共享的几何体与源材质，只还那一批（见 `disposeRigMaterials`）。
      disposeSubtree(model);
      changed = true;
    }
    // 销掉这个节点上当前有效的请求号。两件事都靠它：一是用户切回标准体型时
    // `syncCharacterRig` 要能重新发一次请求（不销的话那个人物永远停在胶囊上，而属性
    // 面板明明显示的是标准）；二是切成胶囊那一刻**正在飞**的那次请求回来之后会认出
    // 自己已经作废——见 `swapInCharacterModel` 里那道对号。
    node.userData.previzRigToken = undefined;
    if (!node.children.some((child) => child.userData.previzPlaceholder)) {
      node.add(this.createPlaceholder(character));
      changed = true;
    }
    return changed;
  }

  private async swapInCharacterModel(
    rig: CharacterRigFactory,
    node: THREE.Object3D,
    character: PrevizCharacter,
    token: number,
  ): Promise<void> {
    const model = await rig.build(character);
    // 号对不上说明这一次请求在途中作废了：用户把体型切成了简化圆柱体，或者切出去又
    // 切回来、已经另发了一次请求。前者照挂会把用户刚要的胶囊换成木偶，用户什么都没动
    // 画面自己跳一下；后者会让同一个节点上叠两副骨架，因为下面那段只删占位体、
    // 不删已经挂上的 rig——两副同时解算，而画面上只是稍微「厚」了一点，看不出来。
    if (node.userData.previzRigToken !== token) {
      // 这份模型没人接手了，得亲手还掉：`build` 已经给它克隆了一批上色用的材质，
      // 而它从没进过树，`dispose()` 与删除对象那两条回收路径都够不着它。直接 return
      // 就是用户每在加载途中切一次体型漏一批材质，画面上一点征兆都没有。
      if (model) disposeSubtree(model);
      return;
    }
    if (!model) {
      // 加载失败：占位胶囊留着，并且把号销掉——用户改一次属性触发的下一次 sync
      // 就等于一次重试，否则一次网络抖动能把这个人物永久钉死在胶囊上。
      node.userData.previzRigToken = undefined;
      return;
    }
    // 加载期间对象可能已经被删了，或者渲染器整个 dispose 了：那时节点已经从对象根上
    // 摘掉、资源也还过了，往它身上挂一个 GLB 就是一份谁都够不着、也不会再被 dispose 的副本。
    // 所以和上面那条一样，模型自己那批克隆材质要在这里还掉。
    if (node.parent !== this.root) {
      disposeSubtree(model);
      return;
    }

    // 只扫直接子节点，与 `resizePlaceholder` 一致。要把占位体或模型嵌进一层中间 Group，
    // 两处得一起改，否则换模型时占位体删不掉，会和 GLB 叠在一起。
    for (const child of [...node.children]) {
      if (child.userData.previzPlaceholder) {
        node.remove(child);
        disposeSubtree(child);
      }
    }
    node.add(model);
    // 模型是在任何一次 sync 之外落进树里的，显示模式得单独补一次。
    this.refreshDisplayMode();
    this.onModelReady?.();
  }

  /**
   * 物件的模型跟着 `assetUrl` 走：换一个 URL 就换一份模型。所以这里记的是「当前挂着
   * 哪份资产」而不是人物那种「请求过没有」的布尔。
   *
   * 标记同样记在**节点**上而不是一张按对象 id 的表里，理由与 `syncCharacterRig` 一样：
   * 撤销一次删除会让同一个 id 带着全新的节点回来，按 id 记的话那个物件永远停在占位方块上。
   */
  private syncPropModel(loader: PropLoader, node: THREE.Object3D, prop: PrevizProp): void {
    if (!prop.assetUrl) return;
    const assetKey = `${prop.assetFormat}:${prop.assetUrl}`;
    if (node.userData.previzPropAsset === assetKey) return;
    node.userData.previzPropAsset = assetKey;
    void this.swapInPropModel(loader, node, prop, assetKey);
  }

  private async swapInPropModel(
    loader: PropLoader,
    node: THREE.Object3D,
    prop: PrevizProp,
    assetKey: string,
  ): Promise<void> {
    const model = await loader.load(prop);
    if (!model) {
      // 加载失败：占位方块留着，标记清掉——下一次 sync 就是一次重试。清的时候先确认
      // 标记还是自己那一份：用户在加载途中又换了一个 URL 的话，覆盖它会把新那次请求
      // 的记账抹掉，于是同一份模型被重复加载。
      if (node.userData.previzPropAsset === assetKey) node.userData.previzPropAsset = undefined;
      return;
    }
    // 加载期间对象可能已经被删了，或者渲染器整个 dispose 了。理由同 `swapInCharacterModel`。
    if (node.parent !== this.root) return;
    // 中途又换了一次 URL：那一次的模型才是用户要的，这一份直接丢掉，别倒着覆盖回去。
    if (node.userData.previzPropAsset !== assetKey) return;

    // 换模型时旧的也要清掉，不只是占位方块——`disposeSubtree` 会跳过共享模型的子树。
    for (const child of [...node.children]) {
      node.remove(child);
      disposeSubtree(child);
    }
    node.add(model);
    this.refreshDisplayMode();
    this.onModelReady?.();
  }

  private createNode(object: PrevizObject): THREE.Object3D {
    const group = new this.three.Group();
    group.add(this.createPlaceholder(object));
    if (object.kind === 'character') group.add(this.createMarker(object));
    return group;
  }

  /**
   * 人物脚下的辨识标记：一圈本人颜色的环，加一个指着 -Z 的箭头。
   *
   * 它是**占位体的兄弟节点**，而不是挂在占位体或模型下面：真模型到位时
   * `swapInCharacterModel` 会把带 `previzPlaceholder` 的子节点整棵删掉，挂在里面的话
   * 人物一加载完标记就没了——而那正是最需要它的时候（所有人共用同一份角色模型，
   * 加载完之后大家长得一模一样）。
   *
   * 材质用 `MeshBasicMaterial` 而不是 standard：这组东西是画在场景里的界面，不该被
   * 布光影响——顶光偏暗的场景里，一圈受光的环会跟着变色，辨识色就不成其为辨识色了。
   */
  private createMarker(character: PrevizCharacter): THREE.Object3D {
    const three = this.three;
    const group = new three.Group();
    group.userData.previzMarker = true;
    group.userData.previzMarkerColor = character.color;

    const ring = new three.Mesh(
      new three.RingGeometry(MARKER_INNER_RADIUS, MARKER_OUTER_RADIUS, 32),
      this.markerMaterial(character.color),
    );
    // RingGeometry 默认立在 XY 面上，绕 X 转 -90° 把它放倒贴地。
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, MARKER_LIFT, 0);
    ring.userData.previzMarker = true;

    const arrow = new three.Mesh(
      new three.ConeGeometry(0.075, 0.16, 3),
      this.markerMaterial(character.color),
    );
    // 锥体默认尖朝 +Y，同一转法把尖指到 -Z——也就是对象的正面。
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, MARKER_LIFT, MARKER_ARROW_Z);
    arrow.userData.previzMarker = true;

    group.add(ring);
    group.add(arrow);
    return group;
  }

  private markerMaterial(color: string): THREE.Material {
    return new this.three.MeshBasicMaterial({ color, side: this.three.DoubleSide });
  }

  /**
   * 辨识色改了就把标记重新染一遍。颜色没变时直接早退：`sync` 每帧都会走到这里，
   * 而 `color.set` 每次都会把材质标脏。
   */
  private syncMarker(node: THREE.Object3D, character: PrevizCharacter): void {
    const marker = node.children.find((child) => child.userData.previzMarker);
    if (!marker) return;
    if (marker.userData.previzMarkerColor === character.color) return;
    marker.userData.previzMarkerColor = character.color;
    marker.traverse((child) => {
      const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      material?.color?.set(character.color);
    });
  }

  /**
   * 辨识色变了就把占位胶囊重新记一次色，返回是否真的变过——变过的话调用方要给它补一次
   * 显示模式，颜色由那条路径落到材质上。这里只改账不直接改材质：全灰模式下直接染的话，
   * 改一次颜色就跳出一个染了色的胶囊，而全灰恰恰是要把所有人抹平。
   *
   * 找不到占位体时什么都不做：模型已经到位了，颜色归 rig 的染色管。反过来，模型一直
   * 到不了的人物（加载失败）会永远停在胶囊上——那时这条路是辨识色唯一的出口。
   */
  private recolorPlaceholder(node: THREE.Object3D, character: PrevizCharacter): boolean {
    const placeholder = node.children.find((child) => child.userData.previzPlaceholder);
    if (!placeholder) return false;
    if (placeholder.userData.previzPlaceholderColor === character.color) return false;
    // 走整棵占位子树而不是只改根上那一份：球头是胶囊的子节点，自带一份材质，而
    // `applyDisplayMode` 是**逐网格**读各自那份 `previzPlaceholderColor` 回色的。
    // 只改胶囊的话，改完色场上站的是一个换了身子没换头的两色人。
    placeholder.traverse((child) => {
      if (child.userData.previzPlaceholder) {
        child.userData.previzPlaceholderColor = character.color;
      }
    });
    // 这里**不**照 `applyTint` 的手法把 `previzOriginalColor` 那笔账 delete 掉：那边改完
    // 材质里就是新本色，重记一份记到的还是本色；这边故意不碰材质（全灰下直接染会跳出
    // 一个染了色的胶囊），删掉之后 `applyDisplayMode` 立刻会把**水泥灰**当本色记进去，
    // 那才是真的坏账。占位体的回程读的是上面这个 `previzPlaceholderColor`，那笔账在
    // 占位体身上从头到尾没人读。
    return true;
  }

  /**
   * 身高变了就把人物占位胶囊换一个。返回是否真的换过，换过的话调用方要给它补一次显示模式
   * ——新材质是按「实心」建出来的。
   *
   * 只在高度真的变了时重建：胶囊的其余输入（半径、分段数）都是常量，白拆一次等于每帧
   * 扔掉一对 geometry / material。反过来，重建时那句 `disposeSubtree` 是承重的——少了它，
   * 拖一次身高滑杆就按帧泄漏几何体与材质。
   *
   * 找不到占位体时什么都不做：那说明 Task 8 的 GLB 已经把它顶掉了，身高归角色 rig 的缩放管。
   */
  private resizePlaceholder(node: THREE.Object3D, object: PrevizCharacter): boolean {
    const existing = node.children.find((child) => child.userData.previzPlaceholder);
    if (!existing) return false;
    const heightCm = clampToRange(object.heightCm, PREVIZ_HEIGHT_CM_RANGE);
    if (existing.userData.previzPlaceholderHeightCm === heightCm) return false;
    node.remove(existing);
    disposeSubtree(existing);
    node.add(this.createPlaceholder(object));
    return true;
  }

  /**
   * 机位的视锥跟着焦距 / 传感器 / 出片画幅重画。找不到模型时什么都不做——那说明
   * 这个节点还停在别的形态上。
   */
  private syncCameraModel(node: THREE.Object3D, object: PrevizCamera): boolean {
    const model = node.children.find((child) => child.userData.previzCameraModel);
    if (!model) return false;
    return syncCameraFrustum(this.three, model, object, this.outputAspect);
  }

  /**
   * 占位几何体。人物胶囊、灯球、物件方块——形状不同是为了一眼分得清。
   *
   * 机位与人物都不止一件几何体——机位是一台摄影机加一具取景视锥（`cameraModel.ts` 建），
   * 人物是胶囊加球头（`createCharacterPlaceholder` 建）——所以这里的返回类型是 `Object3D`
   * 而不是 `Mesh`，而这两支都在下面那条公共尾巴之前就 return 掉了。
   */
  private createPlaceholder(object: PrevizObject): THREE.Object3D {
    const three = this.three;
    if (object.kind === 'camera') return buildCameraModel(three, object, this.outputAspect);
    let geometry: THREE.BufferGeometry;
    // 分类色。人物不走这条尾巴，所以 `KIND_COLOR` 里没有 `character` 这一项。
    let color: number;

    switch (object.kind) {
      // 人物整件由 `createCharacterPlaceholder` 建：那一件是「胶囊 + 球头」两个 Mesh，
      // 而这里往下的公共尾巴只装得下一件几何体。创建人物对话框的木偶预览也要同一件，
      // 抽出去两边才共用同一套尺寸。
      case 'character':
        return createCharacterPlaceholder(three, object);
      case 'light':
        geometry = new three.SphereGeometry(0.14, 16, 12);
        color = KIND_COLOR.light;
        break;
      case 'prop':
        geometry = new three.BoxGeometry(0.6, 0.6, 0.6);
        color = KIND_COLOR.prop;
        break;
    }

    const material = placeholderMaterial(three, color);
    const mesh = new three.Mesh(geometry, material);
    mesh.position.set(0, 0, 0);
    mesh.userData.previzPlaceholder = true;
    // 占位体自己记住本色，`applyDisplayMode` 从全灰切回来时就地读它。反过来往父节点上
    // 找 kind 的写法会把「占位体永远是对象组的直接子节点」写死进显示模式逻辑，而
    // Task 8 / Task 9 把模型嵌进来时正要打破它；顺带那条写法还要一次 `any` 断言，
    // 因为 three 的 `userData` 是 `Record<string, any>`，拿它当 `KIND_COLOR` 的键会被
    // TS7053 挡下来。
    mesh.userData.previzPlaceholderColor = color;
    return mesh;
  }

  /**
   * 把当前显示模式刷到 `target` 子树的每份材质上。
   *
   * 回程有两条还原线：占位体建出来时就把分类色记在了自己的 userData 上；GLB 的材质
   * 各有各的贴图与颜色，没人替它们记，所以染灰之前当场记一份在材质上。少了后面这条，
   * 全灰切回实体之后每个模型都永久停在水泥灰上，用户唯一的补救办法是删掉重建。
   */
  private applyDisplayMode(target: THREE.Object3D): void {
    const mode = this.displayMode;
    if (!mode) return;
    const transparent = mode === 'translucent';
    target.traverse((object) => {
      const mesh = object as THREE.Mesh;
      // 辨识标记不吃显示模式：它不是场景里的东西，是画在场景里的界面。全灰会把它涂成
      // 和别人一样的灰（辨识色就白给了），半透明会把它化掉——而这两个模式恰恰是最难
      // 认人的时候。
      if (mesh.userData.previzMarker) return;
      // 描边与名牌同理：它们是看的辅助，不是镜头里的材质。
      if (mesh.userData[PREVIZ_OVERLAY_KEY]) return;
      const material = mesh.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const entry of list) {
        const standard = entry as THREE.MeshStandardMaterial;
        // 只有 `transparent` 参与 three 的着色程序缓存键（`WebGLPrograms` 的 opaque 项），
        // 所以只有它翻转时才需要让程序失效；`opacity` 与 `color` 是 uniform，改了直接生效。
        // 无条件置 needsUpdate 的代价在 Task 8 / Task 9 才现形：那时每个异步到位的模型都会
        // 调一次 `refreshDisplayMode()`，而它遍历整个 root——N 个模型就是 N 次全场景着色器
        // 重编译，那是 three 里最典型的掉帧来源。
        if (standard.transparent !== transparent) {
          standard.transparent = transparent;
          standard.needsUpdate = true;
        }
        standard.opacity = transparent ? PREVIZ_TRANSLUCENT_OPACITY : 1;
        if (mode === 'clay') {
          // 只在第一次染灰时记账。这里读到的一定是本色：改这批颜色的只有两处——这个
          // 函数，以及 `characterRig.ts` 的 `applyTint`，而后者改完会把这笔账 delete
          // 掉，逼这里重记一份。那个 delete 是这条不变量的另一半，不是多余防御：少了
          // 它，全灰模式下改一次辨识色，切回实体拿到的是改色之前的旧颜色。
          // 重复记账会把水泥灰当成本色记下来，那时回程就是个空操作。
          if (standard.userData.previzOriginalColor === undefined) {
            standard.userData.previzOriginalColor = standard.color?.getHex();
          }
          standard.color?.set(CLAY_COLOR);
        } else if (mesh.userData.previzPlaceholder) {
          standard.color?.set(mesh.userData.previzPlaceholderColor);
        } else if (typeof standard.userData.previzOriginalColor === 'number') {
          standard.color?.set(standard.userData.previzOriginalColor);
        }
      }
    });
  }
}

function finiteVec3(value: Vec3): Vec3 {
  return [finiteOr(value[0], 0), finiteOr(value[1], 0), finiteOr(value[2], 0)];
}

/** three 的 remove() 只解父子关系，几何体与材质要自己还。 */
/**
 * 挂在共享模型根上的标记：`disposeSubtree` 见到它就整棵跳过。
 *
 * 承重的原因：人物的 `SkeletonUtils.clone` 与物件的 `Object3D.clone()` 都是**浅**克隆
 * 几何体与材质——克隆体和缓存里那份源模型指向同一批 `BufferGeometry` / `Material`。
 * 照着占位体的路子 dispose 一个克隆，等于把源模型的 GPU 资源一起还了：删掉第一个人物
 * 之后，之后每一个新建的人物拿到的都是已经 dispose 的几何体，模型不显示且控制台刷
 * `GL_INVALID_OPERATION`，而症状离「删除」这个动作隔了好几步。
 *
 * 反过来占位体（胶囊 / 摄影机 / 灯球 / 方块）是一节点一份、谁都不共享的，必须照旧 dispose，
 * 否则拖一次身高滑杆就按帧泄漏几何体。所以是「按标记跳过」而不是「一律不 dispose」。
 */
const SHARED_MODEL_KEY = 'previzSharedModel';

/**
 * 还掉一棵子树的 GPU 资源，共享模型的子树整棵跳过（见 `SHARED_MODEL_KEY`）。
 *
 * 手写递归而不是 `traverse`：`traverse` 无条件往下走，没法在某个节点上剪枝。
 *
 * 导出是给 `characterPreview.ts` 用的：对话框那块木偶预览换下来的胶囊与骨架，
 * 该跳过谁、该还谁，判据与场景图这边逐字相同。两处各写一份的话，其中一份漏掉
 * `SHARED_MODEL_KEY` 那条剪枝，就会把所有人物共用的那份源模型一起还掉。
 */
export function disposeSubtree(root: THREE.Object3D): void {
  if (root.userData[SHARED_MODEL_KEY]) {
    // 共享的几何体与材质整棵跳过，但人物 rig 为了上辨识色给自己克隆的那批材质是独有的，
    // 谁都不会替它还——每删一个人物漏一批，而画面上什么都看不出来。
    disposeRigMaterials(root);
    return;
  }
  // 叠加层什么都不持有：几何体借自源网格，材质是全局共用的。照着还会把源模型一起还掉。
  if (root.userData[PREVIZ_OVERLAY_KEY]) return;
  const mesh = root as THREE.Mesh;
  mesh.geometry?.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
  else material?.dispose();
  for (const child of [...root.children]) disposeSubtree(child);
}
