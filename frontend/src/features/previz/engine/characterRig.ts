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

/**
 * 摆姿势时用的是第几版 clip 列表，记在 rig 上。列表会变：动画库第一次没下下来、
 * 后来某次 build 补到了，早先按残缺列表落的候选就过时了，得按新列表重摆一遍。
 */
const APPLIED_SOURCE_KEY = 'previzPoseSourceSerial';

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
   * 姿势没变、clip 列表也没变就直接早退：这条路径每次 sync 都会走到，而重摆一次
   * 姿势要建一个 mixer 并把整副骨架重推一遍。
   */
  private applyPose(model: THREE.Object3D, poseId: PrevizPoseId): void {
    if (
      model.userData[APPLIED_POSE_KEY] === poseId &&
      model.userData[APPLIED_SOURCE_KEY] === this.sourceSerial
    ) {
      return;
    }
    // 模型还没解出来时无事可做。走不到这里——`resolveSource()` 先缓存 source 再摆姿势，
    // 而外部调用方手里的 rig 本来就是 `build()` 交出来的。
    const animations = this.source?.animations;
    if (!animations) return;

    const available = new Set(animations.map((clip) => clip.name));
    const clipName = resolvePoseClipName(poseId, available);
    // 对不上就保持现有姿势（新建的人物就是模型自带的绑定姿势），比整个人物消失强；
    // 也绝不拿别的 clip 顶上，那会摆出一个跟属性面板完全对不上的姿势。
    // 标记照样落下：同一版 clip 列表下一次 sync 重查一遍也是同一个结果；列表换了版
    // `sourceSerial` 就对不上，标记自然失效。
    const clip = clipName ? animations.find((entry) => entry.name === clipName) : undefined;
    model.userData[APPLIED_POSE_KEY] = poseId;
    model.userData[APPLIED_SOURCE_KEY] = this.sourceSerial;
    if (!clip) return;

    // mixer 挂在这个人物自己的 rig 上（骨骼按名字往子树里搜，隔一层 Group 照样搜得到）。
    // 挂在共享的源场景上，一个人物摆姿势会把所有人物一起摆过去。
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
