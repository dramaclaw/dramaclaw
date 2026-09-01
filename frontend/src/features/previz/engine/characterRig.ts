// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { clampToRange, DEG_TO_RAD } from '../domain/camera';
import { PREVIZ_HEIGHT_CM_RANGE } from '../domain/objects';
import { PREVIZ_POSE_CLIPS, resolvePoseClipName, type PrevizPoseId } from '../domain/poses';
import { PREVIZ_POSE_ADJUST_RANGE, type BodyType, type PrevizCharacter } from '../domain/scene';
import type { ThreeModule } from './sceneGraph';

/**
 * 通用角色模型。仓库里已有（PlayCanvas 那套 viewer-kit 也在用同一份），
 * CC0，`License.txt` 在同目录。**不要换成别的模型**：`domain/poses.ts` 的
 * clip 名候选表是对着这一份调出来的。
 */
export const PREVIZ_ACTOR_MODEL_URL = '/viewer-kit/quaternius/ual2/UAL2_Standard.glb';

/** 体型只改水平方向的缩放：连 Y 一起放大等于又把身高改了。 */
const BODY_WIDTH_SCALE: Record<BodyType, number> = {
  slim: 0.9,
  average: 1,
  heavy: 1.15,
};

/** 一个姿势定格在动画的第几秒。从姿势表里投影出来，别再手抄一遍。 */
const PREVIZ_POSE_SAMPLE_TIME: Record<PrevizPoseId, number> = Object.fromEntries(
  Object.entries(PREVIZ_POSE_CLIPS).map(([pose, entry]) => [pose, entry.sampleTime]),
) as Record<PrevizPoseId, number>;

/** 模型自身净高（米）量出来之后记在 rig 上的键。缩放为 1 时量一次，之后只读缓存。 */
const NATIVE_HEIGHT_KEY = 'previzRigNativeHeightM';

/**
 * 当前摆着哪个姿势，记在 rig 上。`sync` 每次编辑都跑，没有这个标记就得每次重建一个
 * AnimationMixer 把整副骨架重推一遍——那是拖身高滑杆时每一帧都要付的钱。
 */
const APPLIED_POSE_KEY = 'previzPoseId';

/** GLTFLoader 结果里本模块真正用到的那两块。 */
export interface PrevizGltf {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

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
  /** 共享的加载 Promise：50 个人物各下一次 8 MB 就是 400 MB 流量。 */
  private loading: Promise<PrevizGltf> | null = null;
  /**
   * 已经解出来的源模型。姿势要在 rig 建好之后还能改（属性面板的「基础姿势」下拉框），
   * 而重新摆姿势要的是那份 clip 列表——只留 Promise 的话，改姿势这条同步路径就得
   * 再 await 一次，把一次纯属性编辑变成异步的。
   */
  private source: PrevizGltf | null = null;

  constructor(private readonly deps: CharacterRigDeps) {}

  /**
   * 建一个摆好姿势、缩放到指定身高体型的人物。任何一步失败都返回 null——
   * 调用方保留占位胶囊，编辑器其余部分照常可用。
   */
  async build(character: PrevizCharacter): Promise<THREE.Object3D | null> {
    let source: PrevizGltf;
    try {
      this.loading ??= this.deps.loadGltf(PREVIZ_ACTOR_MODEL_URL);
      source = await this.loading;
    } catch (error) {
      // 失败的 Promise 缓存住会让后续每个人物都拿到同一个错误，重试永远不发生。
      // 清掉之后，用户改一次属性触发的下一次 sync 就等于一次重试。
      this.loading = null;
      console.error('[previz] failed to load the actor model', error);
      return null;
    }

    this.source = source;
    const model = this.deps.clone(source.scene);
    this.applyCharacter(model, character);
    // 场景图靠这个标记在节点的子节点里认出「已经换过模型了」。
    model.userData.previzRig = true;
    // `SkeletonUtils.clone` 是浅克隆几何体与材质：克隆体和缓存里那份源模型共用同一批
    // GPU 资源。这个标记让 `disposeSubtree` 整棵跳过——照占位体那样 dispose 一个克隆，
    // 会把源模型一起还掉，之后新建的每一个人物都拿到已经 dispose 的几何体。
    model.userData.previzSharedModel = true;
    return model;
  }

  /**
   * 把身高与体型刷到一个已经建好的 rig 上。模型到位之后占位胶囊已经被删掉，
   * `PrevizSceneGraph.resizePlaceholder` 从此直接早退——身高体型改由这条路生效，
   * 少了它属性面板的身高滑杆对已加载的人物完全失效。
   *
   * 每次 sync 都无条件重算，而不是拿上一次的值比对：三次乘法比一份挂在 userData 上的
   * 影子状态便宜得多，也不会有「比的是原始值还是夹取后的值」这种对不上的隐患。
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
   * 把一个人物的全部外观属性刷到一个已经建好的 rig 上：姿势、身高体型、姿态微调。
   *
   * 场景图每次 sync 都调它。少了姿势与姿态微调这两步（早先只刷了缩放），属性面板的
   * 「基础姿势」下拉框和「姿态微调」三根滑杆对**已加载的人物**完全失效——改成抱臂、
   * 拖满俯仰，视口里人还站得笔直，而新建的人物又是对的，看起来像随机失灵。
   */
  applyCharacter(model: THREE.Object3D, character: PrevizCharacter): void {
    this.applyPose(model, character.basePoseId as PrevizPoseId);
    this.applyBodyScale(model, character);
    this.applyPoseAdjust(model, character);
  }

  /**
   * 用 AnimationMixer 把某条 clip 定格在某一时刻当静态姿势。定格在 0 常常是
   * 绑定姿势或者动作的起手，看起来像没摆；姿势表里的 sampleTime 是挑过的。
   *
   * 姿势没变就直接早退：这条路径每次 sync 都会走到，而重摆一次姿势要建一个 mixer
   * 并把整副骨架重推一遍。
   */
  private applyPose(model: THREE.Object3D, poseId: PrevizPoseId): void {
    if (model.userData[APPLIED_POSE_KEY] === poseId) return;
    // 模型还没解出来时无事可做。走不到这里——`build()` 里先缓存 source 再摆姿势，
    // 而外部调用方手里的 rig 本来就是 `build()` 交出来的。
    const animations = this.source?.animations;
    if (!animations) return;

    const available = new Set(animations.map((clip) => clip.name));
    const clipName = resolvePoseClipName(poseId, available);
    // 对不上就保持现有姿势（新建的人物就是模型自带的绑定姿势），比整个人物消失强；
    // 也绝不拿别的 clip 顶上，那会摆出一个跟属性面板完全对不上的姿势。
    // 标记照样落下：clip 列表不会再变，下一次 sync 重查一遍也是同一个结果。
    const clip = clipName ? animations.find((entry) => entry.name === clipName) : undefined;
    model.userData[APPLIED_POSE_KEY] = poseId;
    if (!clip) return;

    // mixer 挂在这个人物自己的克隆体上。挂在共享的源场景上，一个人物摆姿势会把
    // 所有人物一起摆过去。
    const mixer = new this.deps.three.AnimationMixer(model);
    mixer.clipAction(clip).play();
    // setTime 把骨架推进到该时刻并写进变换；之后 mixer 就可以扔了——
    // P1 是静态预演，没有播放，不需要每帧 update。
    mixer.setTime(PREVIZ_POSE_SAMPLE_TIME[poseId]);
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
