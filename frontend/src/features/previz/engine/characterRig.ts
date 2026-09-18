// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { clampToRange, DEG_TO_RAD } from '../domain/camera';
import type { EvaluatedMotion, EvaluatedMotionSample } from '../domain/evaluate';
import { BUILTIN_MOTION_PREFIX, builtinMotionById, importedIdOf } from '../domain/motionLibrary';
import { PREVIZ_HEIGHT_CM_RANGE } from '../domain/objects';
import { poseSampleTime, resolvePoseClipName } from '../domain/poses';
import { PREVIZ_POSE_ADJUST_RANGE, type BodyType, type PrevizCharacter } from '../domain/scene';
import type { ThreeModule } from './sceneGraph';

/**
 * 通用角色模型。仓库里已有（PlayCanvas 那套 viewer-kit 也在用同一份），
 * CC0，`License.txt` 在同目录。**不要换成别的模型**：`domain/poses.ts` 的
 * clip 名候选表是对着这一份加上下面的动画库调出来的。
 */
export const PREVIZ_ACTOR_MODEL_URL = '/viewer-kit/quaternius/ual2/UAL2_Standard.glb';

/**
 * 只当动画库用的 GLB：UAL2 自己没有蹲、坐、走、跑、瞄准这些 clip，全在 UAL1 里。
 * 两份是同一副骨架，clip 里的轨道按骨骼名绑定，所以能直接套到 UAL2 的克隆体上。
 * 少了这份，候选表就静默往后落——「蹲伏」没有 clip 保持上一姿势，「坐下」变靠栏杆，
 * 「奔跑」变持盾冲刺，「行走」和「持物」同一条——下拉框选什么和画面对不上。
 */
export const PREVIZ_ACTOR_ANIMATION_URLS = [
  '/viewer-kit/quaternius/ual1/UAL1_Standard.glb',
] as const;

/**
 * 体型只改水平方向的缩放：连 Y 一起放大等于又把身高改了。
 *
 * `capsule`（简化圆柱体）不是一档胖瘦，是「这个人物不要 GLB」。可那层语义归场景图管
 * （谁被换成占位体、谁被送到这里，是 `sceneGraph.syncCharacterRig` 的事），这张表只按
 * 体型查宽度，不认识它，也不该认识——所以这一档在这里必须查得出值：本模块的单测就
 * 直接 `build({ bodyType: 'capsule' })` 走过来。取 1 是「不加宽也不减窄」：它一旦走到
 * 这里，缩放和 `average` 逐位相同——上游那条路由怎么改，**这张表**都不会给它添一次
 * 宽度跳变。（选这一档时观感本来就该变，那是路由的事，不归这张表管。）
 * 列在表里还为了让 `Record<BodyType, …>` 保持穷尽：将来再多一档体型，编译器会在这里
 * 拦住，而不是让 `BODY_WIDTH_SCALE[bodyType]` 查出 undefined，在 `applyBodyScale` 里
 * 乘成 NaN 喂进 `scale.set`。别指望 y 分量没乘 width 就还剩个有限值救场：`Matrix4.compose`
 * 给 3×3 那块每一格都乘一次缩放分量，`0 * NaN` 还是 NaN，模型底下每个网格的 `matrixWorld`
 * 十六格全变 NaN，顶点三个分量都算不出来。整条路还一声不响——NaN 比较恒 false，
 * 视锥剔除不拒绝它，照样提交去画：人就这么整个不见，没有任何一条报错。
 *
 * `tall: 0.84` 没有推导，是照 upstream 的观感取的值：同样的身高下比「偏瘦」再窄一档，
 * 这套模型能表达「高挑」的手段只有横向变窄（身高是另一根滑杆，这一档不该去碰它）。
 */
const BODY_WIDTH_SCALE: Record<BodyType, number> = {
  capsule: 1,
  slim: 0.9,
  average: 1,
  heavy: 1.15,
  tall: 0.84,
};

/** 模型自身净高（米）量出来之后记在 rig 上的键。缩放为 1 时量一次，之后只读缓存。 */
const NATIVE_HEIGHT_KEY = 'previzRigNativeHeightM';

/**
 * 当前摆着的那份动作（`EvaluatedMotion`），记在 rig 上，给测试和调试看。
 */
const APPLIED_MOTION_KEY = 'previzMotion';

/**
 * 上一次推骨架时的输入指纹：动作序列化 + clip 列表版本 + 导入动作版本。`sync` 每次编辑
 * 都跑、暂停时每次都是同一帧，没有这个标记就得每次把整副骨架重推一遍——那是拖身高滑杆
 * 时每一帧都要付的钱。两个版本号任一变了都要重摆：动画库后到、导入动作刚加载完，
 * 早先落下的回退姿势就过时了。
 */
const APPLIED_MOTION_STAMP_KEY = 'previzMotionStamp';

/**
 * 这个人物的基础姿势，记在 rig 上。动作还在加载或加载失败时，那一条样本回落成它——
 * `applyMotion` 只拿到一份求值结果，不知道人物是谁。
 */
const BASE_POSE_KEY = 'previzBasePoseId';

/**
 * 这个 rig 自己那批克隆材质与它们的明度，记在 rig 根上。见 `ownMaterials`。
 */
const TINT_TARGETS_KEY = 'previzRigTintTargets';

/** 当前染的是哪个辨识色，记在 rig 上。颜色没变就整条早退——sync 每帧都会走到这里。 */
const APPLIED_TINT_KEY = 'previzRigTintColor';

/**
 * 一份这个 rig 独有的材质，以及它在源模型里相对最亮那一槽的明度（0..1）。
 *
 * 断言成 `MeshStandardMaterial` 只是为了够到 `color`：真材质是哪一个子类由 GLB 说了算，
 * 这与 `sceneGraph.ts` 的 `applyDisplayMode` 做的是同一处断言。
 */
interface RigTint {
  material: THREE.MeshStandardMaterial;
  shade: number;
}

/**
 * 还掉一个 rig 自己克隆的那批材质。
 *
 * `build()` 在 rig 上留了 `previzSharedModel`，`sceneGraph.ts` 的 `disposeSubtree` 见到它
 * 整棵跳过——不跳的话，删掉一个人物就把所有人物共用的那份源模型的几何体一起还了。
 * 跳过的代价是这几份克隆材质谁都不管，每删一个人物漏一批，所以要有这条定向回收；
 * 子树里其余东西（几何体、骨架、贴图）仍然是共享的，一样都不能碰。
 */
export function disposeRigMaterials(rig: THREE.Object3D): void {
  const tints = rig.userData[TINT_TARGETS_KEY] as RigTint[] | undefined;
  if (!tints) return;
  for (const tint of tints) tint.material.dispose();
  // 还完就把这张表连同颜色账一起销掉。这是个导出函数，签名上没说「一棵子树只能调一次」，
  // 而重复 dispose 同一批材质在 three 里是会真的重复解绑 GPU 资源的。销掉之后再调是空操作，
  // 调用方那边就不必再论证「这条路一定只走一遍」。
  delete rig.userData[TINT_TARGETS_KEY];
  delete rig.userData[APPLIED_TINT_KEY];
}

/**
 * Rec.709 相对明度。three 的 `Color` 通道是线性的，直接加权就是这份材质有多亮。
 *
 * 用明度而不是某个通道：源模型的两槽一橙一紫，按红通道分级会把紫的关节判成暗、
 * 换一份绿模型又反过来——那是拿色相当亮度使。
 */
function luminance(color: THREE.Color | undefined): number {
  if (!color) return 0;
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

/** GLTFLoader 结果里本模块真正用到的那两块。 */
export interface PrevizGltf {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/**
 * 一个 rig 自己的 mixer、按 clip 缓存的 action，以及上一帧在播的那几条。
 * action 自己缓存而不是每帧 `clipAction`：three 那边虽然也有缓存，但每次查都要按 clip
 * 名和根对象走一遍表；更要紧的是「哪些在播」得自己记，才知道这一帧该停掉谁。
 */
interface RigMixer {
  mixer: THREE.AnimationMixer;
  actions: Map<THREE.AnimationClip, THREE.AnimationAction>;
  playing: Set<THREE.AnimationAction>;
}

/** 导入动作的 clip 从哪来。由渲染器接上 `PrevizMotionClips`；加载中与失败都给 null。 */
export type PrevizMotionResolver = (motionId: string) => THREE.AnimationClip | null;

export interface CharacterRigDeps {
  three: ThreeModule;
  loadGltf: (url: string) => Promise<PrevizGltf>;
  /**
   * 克隆函数。必须是 `three/examples/jsm/utils/SkeletonUtils.js` 的 `clone`，
   * **不能**是 `Object3D.clone()`：后者复制 SkinnedMesh 时仍指向原骨架，
   * 第二个人物一摆姿势，第一个也跟着动。
   */
  clone: (object: THREE.Object3D) => THREE.Object3D;
}

/**
 * 人物 rig 工厂：加载共享的角色 GLB、按姿势定格一帧、按身高体型缩放。
 *
 * three 通过构造参数注入而不是本文件 import，理由同 `sceneGraph.ts`：jsdom 里建不出
 * WebGL 上下文，且任何一处静态 `import 'three'` 都会把 three 从懒加载 chunk 里拽出来。
 */
export class CharacterRigFactory {
  /** 共享的模型加载 Promise：模型和动画库各 8 MB，50 个人物各下一次就是 800 MB 流量。 */
  private modelLoading: Promise<PrevizGltf> | null = null;
  /**
   * 每份动画库各自的加载 Promise，按 url 记。和模型分开记的原因是失败要分开重试：
   * 库 404 只掉姿势不掉人，下一次 build 该再试一次库，但已经到手的模型不该再下。
   */
  private readonly libraryLoading = new Map<string, Promise<PrevizGltf | null>>();
  /**
   * 已经合成的源模型。姿势要在 rig 建好之后还能改（属性面板的「基础姿势」下拉框），
   * 而重新摆姿势要的是那份 clip 列表——只留 Promise 的话，改姿势这条同步路径就得
   * 再 await 一次，把一次纯属性编辑变成异步的。
   */
  private source: PrevizGltf | null = null;
  /** `source` 是用哪几份动画库合成的。同一组库合出来的结果一样，不必重合。 */
  private sourceKey = '';
  /** `source` 重合过几次。rig 上记的是摆姿势时的值，对不上就重摆。 */
  private sourceSerial = 0;
  /**
   * 每个 rig 一个 mixer，第一次真的摆出姿势时才建。沿路径走位时每帧都要推一次骨架，
   * 每次新建一个 mixer 的话 `clipAction` 要把几十根骨骼的绑定重新解一遍——那是播放时
   * 每一帧都要付的钱。按 rig 弱引用，rig 被场景图丢掉之后 mixer 跟着走。
   */
  private readonly mixers = new WeakMap<THREE.Object3D, RigMixer>();
  private motionResolver: PrevizMotionResolver | null = null;
  /** 导入动作这一侧变过几次（接上新的解析器、某条动作加载完或失败）。见 `APPLIED_MOTION_STAMP_KEY`。 */
  private motionSerial = 0;

  constructor(private readonly deps: CharacterRigDeps) {}

  /**
   * 建一个摆好姿势、缩放到指定身高体型的人物。任何一步失败都返回 null——
   * 调用方保留占位胶囊，编辑器其余部分照常可用。
   */
  async build(character: PrevizCharacter): Promise<THREE.Object3D | null> {
    let source: PrevizGltf;
    try {
      source = await this.resolveSource();
    } catch (error) {
      console.error('[previz] failed to load the actor model', error);
      return null;
    }

    const model = this.deps.clone(source.scene);
    // Quaternius 模型的脸朝 +Z（脚尖顶点在 +Z 侧），而预演台约定 rotation 全零时朝 -Z：
    // 机位、路径切线（`tangentYawDeg`）、选中环上的箭头都按这条。不转这半圈，人物沿
    // 路径倒着走，箭头指着后脑勺。半圈转在克隆体上，姿态微调与身高缩放打在外层的
    // Group 上：`applyPoseAdjust` 每次 sync 都整体重写 rotation，叠在同一个对象上会被抹掉。
    model.rotation.y = Math.PI;
    const rig = new this.deps.three.Group();
    rig.add(model);
    // 辨识色要染在这个人物自己的材质上。`SkeletonUtils.clone` 是浅克隆，克隆体和缓存里
    // 那份源模型共用同一批材质：直接 `color.set` 等于把场上所有人物连同源模型一起染了
    // ——四个人瞬间同色，而且之后新建的每一个人物都从已经被染过的源上克隆下来。
    rig.userData[TINT_TARGETS_KEY] = this.ownMaterials(model);
    this.applyCharacter(rig, character);
    // 场景图靠这个标记在节点的子节点里认出「已经换过模型了」。
    rig.userData.previzRig = true;
    // `SkeletonUtils.clone` 是浅克隆几何体与材质：克隆体和缓存里那份源模型共用同一批
    // GPU 资源。这个标记让 `disposeSubtree` 整棵跳过——照占位体那样 dispose 一个克隆，
    // 会把源模型一起还掉，之后新建的每一个人物都拿到已经 dispose 的几何体。
    rig.userData.previzSharedModel = true;
    return rig;
  }

  /**
   * 合并好的角色模型与 clip 列表。导入动作的重定向要拿 UAL 骨架的静止姿势当目标，
   * 与建人物共用同一份下载。失败时 reject，由调用方把那条动作记成加载失败。
   */
  loadActorSource(): Promise<PrevizGltf> {
    return this.resolveSource();
  }

  /** 接上导入动作的解析器。 */
  setMotionResolver(resolver: PrevizMotionResolver | null): void {
    this.motionResolver = resolver;
    this.motionSerial += 1;
  }

  /**
   * 导入动作有一条加载完或失败了：已经摆好的 rig 上可能是它的回退姿势，下一次
   * `applyMotion` 要重新解析。
   */
  invalidateMotions(): void {
    this.motionSerial += 1;
  }

  /**
   * 模型和动画库并行下载，合成一份 clip 列表。同名 clip 以模型自己那条为准（两份都带
   * A_TPose 这类），库里的只补模型没有的。库下不下来只掉姿势不掉人：模型照常建，
   * 姿势按模型自带的候选落，控制台留一条 warn 说明原因；模型本身失败还是走 `build()`
   * 的 null 路径。
   *
   * 两边都命中缓存时直接复用上一次的合成结果——每次 build 都当成新的一份，会让每加
   * 一个人物就把场上所有人物重摆一遍姿势。
   */
  private async resolveSource(): Promise<PrevizGltf> {
    const [model, ...libraries] = await Promise.all([
      this.loadModel(),
      ...PREVIZ_ACTOR_ANIMATION_URLS.map((url) => this.loadLibrary(url)),
    ]);
    const key = PREVIZ_ACTOR_ANIMATION_URLS.filter((_url, index) => libraries[index]).join(' ');
    if (this.source && this.sourceKey === key) return this.source;

    const animations = [...model.animations];
    const known = new Set(animations.map((clip) => clip.name));
    for (const library of libraries) {
      for (const clip of library?.animations ?? []) {
        if (known.has(clip.name)) continue;
        known.add(clip.name);
        animations.push(clip);
      }
    }
    this.source = { scene: model.scene, animations };
    this.sourceKey = key;
    // 列表变了（通常是上次没到的动画库这次到了）：已经建好的 rig 摆的是按旧列表落的
    // 候选，下一次 sync 要重查一遍。
    this.sourceSerial += 1;
    return this.source;
  }

  private loadModel(): Promise<PrevizGltf> {
    const cached = this.modelLoading;
    if (cached) return cached;
    const attempt: Promise<PrevizGltf> = this.deps
      .loadGltf(PREVIZ_ACTOR_MODEL_URL)
      .catch((error: unknown) => {
        // 失败的 Promise 缓存住会让后续每个人物都拿到同一个错误，重试永远不发生。
        // 清掉之后，用户改一次属性触发的下一次 sync 就等于一次重试。只清自己这一条：
        // 并发的下一次尝试可能已经把新的 Promise 放进去了。
        if (this.modelLoading === attempt) this.modelLoading = null;
        throw error;
      });
    this.modelLoading = attempt;
    return attempt;
  }

  /** 失败解析成 null 而不是 reject：库缺了模型照常建。失败的条目同样不缓存。 */
  private loadLibrary(url: string): Promise<PrevizGltf | null> {
    const cached = this.libraryLoading.get(url);
    if (cached) return cached;
    const attempt: Promise<PrevizGltf | null> = this.deps
      .loadGltf(url)
      .catch((error: unknown) => {
        if (this.libraryLoading.get(url) === attempt) this.libraryLoading.delete(url);
        console.warn('[previz] failed to load the actor animation library', url, error);
        return null;
      });
    this.libraryLoading.set(url, attempt);
    return attempt;
  }

  /**
   * 把身高与体型刷到一个已经建好的 rig 上。模型到位之后占位胶囊已经被删掉，
   * `PrevizSceneGraph.resizePlaceholder` 从此直接早退——身高体型改由这条路生效，
   * 少了它属性面板的身高滑杆对已加载的人物完全失效。
   *
   * 每次 sync 都无条件重算，而不是拿上一次的值比对：两次除法加两次乘法比一份挂在
   * userData 上的影子状态便宜得多，也不会有「比的是原始值还是夹取后的值」这种
   * 对不上的隐患。
   */
  applyBodyScale(model: THREE.Object3D, character: PrevizCharacter): void {
    // 与占位胶囊夹的是同一个区间：两边不一致的话，模型一到位人物的身高就跳一下。
    const heightCm = clampToRange(character.heightCm, PREVIZ_HEIGHT_CM_RANGE);
    const nativeHeight = this.nativeHeight(model);
    // 量不出净高时按 1 处理：宁可尺寸不对，也不要除出 Infinity 把模型炸出视锥。
    const uniform = nativeHeight > 0 ? heightCm / 100 / nativeHeight : 1;
    const width = BODY_WIDTH_SCALE[character.bodyType];
    model.scale.set(uniform * width, uniform, uniform * width);
  }

  /**
   * 把一个人物的全部外观属性刷到一个已经建好的 rig 上：姿势、身高体型、姿态微调、辨识色。
   *
   * 场景图每次 sync 都调它。少了姿势与姿态微调这两步（早先只刷了缩放），属性面板的
   * 「基础姿势」下拉框和「姿态微调」三根滑杆对**已加载的人物**完全失效——改成抱臂、
   * 拖满俯仰，视口里人还站得笔直，而新建的人物又是对的，看起来像随机失灵。
   *
   * 返回辨识色这一次有没有真的重染过：见 `applyTint`。
   */
  applyCharacter(model: THREE.Object3D, character: PrevizCharacter): boolean {
    model.userData[BASE_POSE_KEY] = character.basePoseId;
    this.applyMotion(model, {
      primary: { ref: character.basePoseId, time: poseSampleTime(character.basePoseId) },
      weight: 1,
    });
    this.applyBodyScale(model, character);
    this.applyPoseAdjust(model, character);
    return this.applyTint(model, character);
  }

  /**
   * 把辨识色染到这个 rig 自己那批材质上。返回这一次有没有真的重染过——重染刚刚改写了
   * 材质的颜色，而当前显示模式未必是本色（全灰要盖回水泥灰），调用方得把模式补回去。
   *
   * 颜色没变就整条早退：`sync` 每帧都会走到这里，而重染一次就要让调用方跟着把整棵
   * 模型子树的显示模式重刷一遍。
   *
   * 染法是「按材质自己的明度分级」而不是整体刷成一颗纯色：源模型两个材质槽一亮一暗
   * （主体与关节），全刷成同一颗饱和色之后两槽的明暗关系就没了，人物看着是一个色块
   * 而不是一个人。最亮那一槽拿到纯正的辨识色，好让属性面板上的色块与视口里的人物
   * 是同一个颜色——「按颜色认人」这件事在两处对不上就白做了。
   */
  private applyTint(rig: THREE.Object3D, character: PrevizCharacter): boolean {
    if (rig.userData[APPLIED_TINT_KEY] === character.color) return false;
    rig.userData[APPLIED_TINT_KEY] = character.color;
    const tints = (rig.userData[TINT_TARGETS_KEY] as RigTint[] | undefined) ?? [];
    for (const { material, shade } of tints) {
      material.color?.set(character.color);
      // 压暗在线性空间里做（three 的 Color 通道就是线性的），与布光是同一个量纲。
      material.color?.multiplyScalar(shade);
      // `sceneGraph.ts` 的 `applyDisplayMode` 在染灰之前把本色记在这个键上，切回实体
      // 时照它还原。本色刚刚变了，这笔账就作废了——留着的话，在全灰模式下改一次
      // 辨识色，切回实体拿到的是**改色之前**的旧颜色。清掉之后下一次染灰会重记一份。
      delete material.userData.previzOriginalColor;
    }
    return true;
  }

  /**
   * 把 rig 子树里每份材质换成本 rig 独有的克隆，并量下它相对最亮那一槽的明度。
   *
   * 按源材质去重：同一份材质挂在多个网格上时克隆一份就够，一网格一份既多占显存，
   * 又会让同一槽被染两遍。
   */
  private ownMaterials(model: THREE.Object3D): RigTint[] {
    const clones = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const own = (source: THREE.Material): THREE.Material => {
      const existing = clones.get(source);
      if (existing) return existing;
      // `Material.clone()` 只复制参数，贴图仍是同一批引用——而 three 的 `dispose()`
      // 本来就不碰贴图，所以还掉克隆不会把源模型的贴图一起还了。
      const copy = source.clone() as THREE.MeshStandardMaterial;
      clones.set(source, copy);
      return copy;
    };
    model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material;
      if (!material) return;
      mesh.material = Array.isArray(material) ? material.map(own) : own(material);
    });

    const measured = [...clones.values()].map((material) => ({
      material,
      lit: luminance(material.color),
    }));
    const brightest = measured.reduce((max, entry) => Math.max(max, entry.lit), 0);
    // 一片全黑的模型除下去是 0/0：一律按 1 算，每一槽都拿纯正的辨识色。
    return measured.map(({ material, lit }) => ({
      material,
      shade: brightest > 0 ? lit / brightest : 1,
    }));
  }

  /**
   * 把求值器给的一份动作推到骨架上：`primary` 与可选的 `secondary` 各占一条 action，
   * 按 `weight` 分权重，交叉淡化就是这样做出来的。静止的人物是基础姿势定格在候选表挑好
   * 的那一秒；沿路径走位是走 / 跑循环；落在动作片段里换成片段的动作。
   *
   * 每条 action 的 `time` 直接赋值再 `mixer.update(0)`，而不是 `mixer.setTime`：后者把所有
   * action 拨到同一个时刻，两条样本各自的片段内时间没法分开给。delta 为 0 时 three 不做
   * 绕圈也不停用单次 action，赋的是几秒就采几秒——单次动作停在末帧靠的就是这一点。
   *
   * `time` 原样来自 `resolveSample`，这里不再额外处理：`builtin:` / `import:` 的时刻已经
   * 由求值器按 `loop` 夹过或取过模（`evaluate.ts` 的 `actionSample`），这里再取一次模只会
   * 帮倒忙——目录里的 `durationSec` 是三位小数，个别条目比真实 clip 时长略大（`Roll` 记的
   * 是 1.467，真实是 1.46666…7），求值器按目录值夹出的 1.467 一旦在这里被当成「超过时长」
   * 绕回去，会把播完定格的单次动作摔回首帧。唯一没被求值器处理过、真会超过时长的
   * 姿势 id 样本（沿路径走位的走 / 跑循环）在 `resolvePoseSample` 里已经绕好了圈，见那边。
   *
   * 输入没变就早退：这条路径每次 sync 与每一帧都会走到，而推一次骨架要把整副骨骼重写一遍。
   */
  applyMotion(model: THREE.Object3D, motion: EvaluatedMotion): void {
    const stamp = `${JSON.stringify(motion)}|${this.sourceSerial}|${this.motionSerial}`;
    if (model.userData[APPLIED_MOTION_STAMP_KEY] === stamp) return;
    // 模型还没解出来时无事可做。走不到这里——`resolveSource()` 先缓存 source 再摆姿势，
    // 而外部调用方手里的 rig 本来就是 `build()` 交出来的。
    const animations = this.source?.animations;
    if (!animations) return;
    // 标记照样落下：同样的输入在同一版 clip 列表下重查一遍也是同一个结果；任一版本号
    // 变了，指纹自然对不上。
    model.userData[APPLIED_MOTION_KEY] = motion;
    model.userData[APPLIED_MOTION_STAMP_KEY] = stamp;

    const primary = this.resolveSample(model, motion.primary, animations);
    let secondary = motion.secondary
      ? this.resolveSample(model, motion.secondary, animations)
      : null;
    // 同一条 clip 在 mixer 里只有一个 action、只能有一个时刻：两边撞上时（相接的两段是同一个
    // 动作，或者走路叠在走路上）只留主样本。交界处少一次淡化，比两个时刻互相覆盖强。
    if (secondary && secondary.clip === primary?.clip) secondary = null;
    const layers: Array<{ clip: THREE.AnimationClip; time: number; weight: number }> = [];
    if (primary) layers.push({ ...primary, weight: secondary ? motion.weight : 1 });
    if (secondary) layers.push({ ...secondary, weight: primary ? 1 - motion.weight : 1 });
    // 一条都解不出来就保持现有姿势（新建的人物就是模型自带的绑定姿势），比整个人物消失
    // 强；也绝不拿别的 clip 顶上，那会摆出一个跟属性面板完全对不上的姿势。
    if (layers.length === 0) return;

    // mixer 挂在这个人物自己的 rig 上（骨骼按名字往子树里搜，隔一层 Group 照样搜得到）。
    // 挂在共享的源场景上，一个人物摆姿势会把所有人物一起摆过去。
    let rig = this.mixers.get(model);
    if (!rig) {
      rig = {
        mixer: new this.deps.three.AnimationMixer(model),
        actions: new Map(),
        playing: new Set(),
      };
      this.mixers.set(model, rig);
    }
    const wanted = new Set<THREE.AnimationAction>();
    for (const layer of layers) {
      let action = rig.actions.get(layer.clip);
      if (!action) {
        action = rig.mixer.clipAction(layer.clip);
        rig.actions.set(layer.clip, action);
      }
      wanted.add(action);
      if (!rig.playing.has(action)) action.play();
      action.time = layer.time;
      action.setEffectiveWeight(layer.weight);
    }
    // 上一帧的 action 不停掉会和这一帧的叠着播：骨骼被拧到几条之和上。
    for (const action of rig.playing) {
      if (!wanted.has(action)) action.stop();
    }
    rig.playing = wanted;
    rig.mixer.update(0);
  }

  /**
   * 一条样本对应哪条 clip、推到第几秒。`ref` 三种写法：姿势 id（走 `resolvePoseClipName`
   * 的候选表）、`builtin:` 动作（按 clip 名在合并列表里取）、`import:` 动作（问解析器）。
   *
   * 动作解不出来（动画库没到、导入动作还在加载或失败）时回落为这个人物的基础姿势定格：
   * 片段里的人总得摆个样子，保持上一帧的动作会让「加载失败」看起来像动作卡住了。
   * 姿势 id 解不出来则不回落——那是候选表对不上，回落只会摆出另一个姿势。
   */
  private resolveSample(
    model: THREE.Object3D,
    sample: EvaluatedMotionSample,
    animations: readonly THREE.AnimationClip[],
  ): { clip: THREE.AnimationClip; time: number } | null {
    const byName = (name: string | undefined) =>
      name ? (animations.find((entry) => entry.name === name) ?? null) : null;
    const isBuiltin = sample.ref.startsWith(BUILTIN_MOTION_PREFIX);
    const importedId = importedIdOf(sample.ref);
    if (!isBuiltin && importedId === null) {
      return this.resolvePoseSample(sample.ref, sample.time, animations);
    }
    const clip = isBuiltin
      ? byName(builtinMotionById(sample.ref)?.clipName)
      : (this.motionResolver?.(sample.ref) ?? null);
    if (clip) return { clip, time: sample.time };
    // 回落到基础姿势：`basePoseId` 本身也可能是一个解不出的 `builtin:` / `import:` 引用
    // （动作被删掉后场景还没来得及改配置，或者干脆是脏存档）。不能再调 `resolveSample`
    // 自己——那会绕回这一支，同一个解不出的 `basePoseId` 每次都落回同一条回落路径，
    // 递归永远退不出去，栈溢出。直接走姿势 id 那一支的逻辑，解不出就是 null，不再继续回落。
    const basePoseId = model.userData[BASE_POSE_KEY];
    if (typeof basePoseId !== 'string') return null;
    return this.resolvePoseSample(basePoseId, poseSampleTime(basePoseId), animations);
  }

  /**
   * 按姿势 id 查候选表解一条样本，解不出就是 `null`，不做任何回落——供上面两处共用。
   *
   * 时刻在这里绕回 `[0, duration)`：姿势 id 是唯一没有经过求值器处理、真会超过 clip
   * 时长的来源——沿路径走位的走 / 跑循环，时刻是 `evaluate.ts` 里的
   * `(frame - clip.startFrame) / FPS`，没有取模，走的距离越长这个数就越大。`builtin:` /
   * `import:` 那两支不吃这套：它们的时刻已经由求值器的 `actionSample` 按 `loop` 处理过，
   * 原样交给 action 就好，见 `applyMotion` 顶部注释。
   *
   * `mixer.update(0)` 不会替我们绕圈：three 的 `AnimationAction._updateTime` 在
   * `deltaTime === 0` 时直接把 `this.time` 原样返回，不取模——那是 `mixer.setTime` 才有的
   * 行为，而这里为了让 primary / secondary 两条样本各自停在片段内不同的时刻，用不了
   * `setTime`。
   */
  private resolvePoseSample(
    poseId: string,
    time: number,
    animations: readonly THREE.AnimationClip[],
  ): { clip: THREE.AnimationClip; time: number } | null {
    const available = new Set(animations.map((entry) => entry.name));
    const clipName = resolvePoseClipName(poseId, available);
    const clip = clipName ? animations.find((entry) => entry.name === clipName) : undefined;
    return clip ? { clip, time: this.loopedTime(clip, time) } : null;
  }

  /**
   * 把一个可能超过片段时长的时刻绕回 `[0, duration)`。只给 `resolvePoseSample` 用——见那边
   * 的注释，为什么只有姿势 id 样本需要这一步。
   */
  private loopedTime(clip: THREE.AnimationClip, time: number): number {
    const duration = clip.duration;
    // 假 three（单测的 fake three）给的 clip 只有 `name`，没有 `duration`——`undefined`
    // 参与比较恒为 false，`!(duration > 0)` 才认得出「这条 clip 没有可用的时长」，
    // 原样把时刻放行，不去趟取模那条路（否则 `NaN % NaN` 还是 `NaN`）。
    if (!(duration > 0) || time <= duration) return time;
    return ((time % duration) + duration) % duration;
  }

  /**
   * 姿势微调三轴。场景里存的是度，three 的 Euler 收弧度。
   *
   * 三个角都先夹进各自的区间：超界的角木偶做不出来，只会把关节拧穿；`clampToRange`
   * 顺带把非有限值收在这里——NaN 会顺着 `updateMatrixWorld` 污染整棵子树的世界矩阵，
   * 人物从画面上凭空消失，而 three 一声不吭。
   */
  private applyPoseAdjust(model: THREE.Object3D, character: PrevizCharacter): void {
    const { pitch, turn, lean } = character.poseAdjust;
    model.rotation.set(
      clampToRange(pitch, PREVIZ_POSE_ADJUST_RANGE.pitch) * DEG_TO_RAD,
      clampToRange(turn, PREVIZ_POSE_ADJUST_RANGE.turn) * DEG_TO_RAD,
      clampToRange(lean, PREVIZ_POSE_ADJUST_RANGE.lean) * DEG_TO_RAD,
    );
  }

  /**
   * 模型自身的净高，单位米。只在缩放还是 1 的时候量一次，之后读缓存：
   * `Box3.setFromObject()` 量的是**世界**包围盒，根对象的 scale 就在它的 matrixWorld 里，
   * 重量一次量到的是已经缩过的身体，于是下一次改身高会把缩放叠两遍——拖两次滑杆，
   * 人就越长越高。
   */
  private nativeHeight(model: THREE.Object3D): number {
    const cached: unknown = model.userData[NATIVE_HEIGHT_KEY];
    if (typeof cached === 'number') return cached;
    const box = new this.deps.three.Box3().setFromObject(model);
    const height = box.isEmpty() ? 0 : box.max.y - box.min.y;
    model.userData[NATIVE_HEIGHT_KEY] = height;
    return height;
  }
}
