// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { clampToRange, DEG_TO_RAD } from '../domain/camera';
import { PREVIZ_HEIGHT_CM_RANGE } from '../domain/objects';
import {
  PREVIZ_SCALE_RANGE,
  type DisplayMode,
  type PrevizCharacter,
  type PrevizObject,
  type PrevizProp,
  type PrevizScene,
  type Vec3,
} from '../domain/scene';
import type { CharacterRigFactory } from './characterRig';
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
 * 它同时是一条尺寸约束：胶囊中段长度是「身高 − 2 × 半径」，必须为正。身高先夹进
 * `PREVIZ_HEIGHT_CM_RANGE` 再相减，具体余量归 `domain/objects.ts` 的下界管，这里不复述。
 * 改大这个半径前先跑 scene-graph 测试里的「clamps heightCm so the capsule never degenerates」，
 * 那条用例锁的就是这条不变式。
 */
export const PREVIZ_PLACEHOLDER_RADIUS = 0.22;

/** 全灰模式的统一颜色。 */
const CLAY_COLOR = 0xb9bec8;

const KIND_COLOR: Record<PrevizObject['kind'], number> = {
  character: 0x6ea8fe,
  camera: 0xffd166,
  light: 0xfff3b0,
  prop: 0x9ad0a0,
};

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
  /** 由 `PrevizRenderer.create()` 注入；没注入时人物一直用占位胶囊。 */
  private characterRig: CharacterRigFactory | null = null;
  private onModelReady: (() => void) | null = null;
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

  /** 把当前场景同步进对象树。可以每帧调，代价是一次 Map 查表加几次赋值。 */
  sync(scene: PrevizScene): void {
    const mode = scene.settings.displayMode;
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
      if (object.kind === 'character' && rig) this.syncCharacterRig(rig, node, object);
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

  /** 新挂进来的模型（GLB）也要吃到当前显示模式，加载完调这个。 */
  refreshDisplayMode(): void {
    this.applyDisplayMode(this.root);
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
   *
   * 「已经请求过了」这个标记记在**节点**上，而不是记在一张按对象 id 的表里：撤销一次
   * 删除会让同一个 id 带着一个全新的节点回来，按 id 记的话那个人物就永远停在占位胶囊上。
   * 请求失败时标记会被清掉（见 `swapInCharacterModel`），下一次 sync 就是一次重试。
   *
   * 模型到位之后 `resizePlaceholder` 就再也帮不上忙了——占位体已经被删掉，它直接早退——
   * 身高与体型改由 rig 的缩放接手；少了这一条，属性面板的身高滑杆对已加载的人物完全失效。
   */
  private syncCharacterRig(
    rig: CharacterRigFactory,
    node: THREE.Object3D,
    character: PrevizCharacter,
  ): void {
    const model = node.children.find((child) => child.userData.previzRig);
    if (model) {
      // 姿势、身高体型、姿态微调一起刷。只刷缩放的话，属性面板的「基础姿势」下拉框与
      // 「姿态微调」三根滑杆对已加载的人物完全失效。
      rig.applyCharacter(model, character);
      return;
    }
    if (node.userData.previzRigRequested) return;
    node.userData.previzRigRequested = true;
    void this.swapInCharacterModel(rig, node, character);
  }

  private async swapInCharacterModel(
    rig: CharacterRigFactory,
    node: THREE.Object3D,
    character: PrevizCharacter,
  ): Promise<void> {
    const model = await rig.build(character);
    if (!model) {
      // 加载失败：占位胶囊留着，并且把标记清掉——用户改一次属性触发的下一次 sync
      // 就等于一次重试，否则一次网络抖动能把这个人物永久钉死在胶囊上。
      node.userData.previzRigRequested = false;
      return;
    }
    // 加载期间对象可能已经被删了，或者渲染器整个 dispose 了：那时节点已经从对象根上
    // 摘掉、资源也还过了，往它身上挂一个 GLB 就是一份谁都够不着、也不会再被 dispose 的副本。
    if (node.parent !== this.root) return;

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
    return group;
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

  /** 占位几何体。人物胶囊、机位锥体、灯球、物件方块——形状不同是为了一眼分得清。 */
  private createPlaceholder(object: PrevizObject): THREE.Mesh {
    const three = this.three;
    let geometry: THREE.BufferGeometry;
    let yOffset = 0;
    let heightCm: number | undefined;

    switch (object.kind) {
      case 'character': {
        heightCm = clampToRange(object.heightCm, PREVIZ_HEIGHT_CM_RANGE);
        const height = heightCm / 100;
        // CapsuleGeometry(radius, height, …)：第二参数是两个半球之间那段柱体的高度
        // （three 0.185 的形参名就叫 height），胶囊总高是它加上两个半径，所以先减掉。
        const radius = PREVIZ_PLACEHOLDER_RADIUS;
        geometry = new three.CapsuleGeometry(radius, height - radius * 2, 4, 12);
        // 胶囊自身以原点为中心，抬高半个身高才让脚底落在 y=0 的地面网格上。
        yOffset = height / 2;
        break;
      }
      case 'camera':
        geometry = new three.ConeGeometry(0.16, 0.42, 4);
        break;
      case 'light':
        geometry = new three.SphereGeometry(0.14, 16, 12);
        break;
      case 'prop':
        geometry = new three.BoxGeometry(0.6, 0.6, 0.6);
        break;
    }

    const material = new three.MeshStandardMaterial({
      color: KIND_COLOR[object.kind],
      roughness: 0.7,
      metalness: 0.05,
    });
    const mesh = new three.Mesh(geometry, material);
    mesh.position.set(0, yOffset, 0);
    mesh.userData.previzPlaceholder = true;
    // 占位体自己记住本色，`applyDisplayMode` 从全灰切回来时就地读它。反过来往父节点上
    // 找 kind 的写法会把「占位体永远是对象组的直接子节点」写死进显示模式逻辑，而
    // Task 8 / Task 9 把模型嵌进来时正要打破它；顺带那条写法还要一次 `any` 断言，
    // 因为 three 的 `userData` 是 `Record<string, any>`，拿它当 `KIND_COLOR` 的键会被
    // TS7053 挡下来。
    mesh.userData.previzPlaceholderColor = KIND_COLOR[object.kind];
    // 建这个胶囊时用的是哪个身高。`resizePlaceholder` 靠它判断要不要重建。
    if (heightCm !== undefined) mesh.userData.previzPlaceholderHeightCm = heightCm;
    return mesh;
  }

  /**
   * 把当前显示模式刷到 `target` 子树的每份材质上。
   *
   * 从全灰切回来时只有占位体能恢复本色——它建出来时就把本色记在了自己的 userData 上。
   * Task 8 / Task 9 挂进来的 GLB 材质各有各的贴图与颜色，被染灰之后无从还原，那时要么
   * 照这里的办法逐份材质记一份原色，要么换成整体覆盖材质（`Scene.overrideMaterial`）；
   * 在只有占位体的当下，这个分支覆盖了全部情况。
   */
  private applyDisplayMode(target: THREE.Object3D): void {
    const mode = this.displayMode;
    if (!mode) return;
    const transparent = mode === 'translucent';
    target.traverse((object) => {
      const mesh = object as THREE.Mesh;
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
        if (mode === 'clay') standard.color?.set(CLAY_COLOR);
        else if (mesh.userData.previzPlaceholder) {
          standard.color?.set(mesh.userData.previzPlaceholderColor);
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
 * 反过来占位体（胶囊 / 锥体 / 灯球 / 方块）是一节点一份、谁都不共享的，必须照旧 dispose，
 * 否则拖一次身高滑杆就按帧泄漏几何体。所以是「按标记跳过」而不是「一律不 dispose」。
 */
const SHARED_MODEL_KEY = 'previzSharedModel';

/**
 * 还掉一棵子树的 GPU 资源，共享模型的子树整棵跳过（见 `SHARED_MODEL_KEY`）。
 *
 * 手写递归而不是 `traverse`：`traverse` 无条件往下走，没法在某个节点上剪枝。
 */
function disposeSubtree(root: THREE.Object3D): void {
  if (root.userData[SHARED_MODEL_KEY]) return;
  const mesh = root as THREE.Mesh;
  mesh.geometry?.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
  else material?.dispose();
  for (const child of [...root.children]) disposeSubtree(child);
}
