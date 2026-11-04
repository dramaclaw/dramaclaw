// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type * as THREE from 'three';

import { PREVIZ_FPS } from '../domain/scene';
import { PREVIZ_MOTION_LIMITS } from '../domain/limits';
import type { ThreeModule } from './sceneGraph';

/**
 * 导入动作的重定向：把 Mixamo / SMPL / UAL 骨架上的一条 clip 换算成 UAL 骨骼名的 clip。
 *
 * 不用 `SkeletonUtils.retargetClip`（设计文档决策 6）：它要求两副骨架绑定姿势大体一致，
 * 而 Mixamo / SMPL 是 T-Pose、UAL 是 A-Pose，SMPL 常见导出还是 Z-up + 厘米。
 *
 * 做法：
 * 1. 坐标统一 `C = yaw · upFix`：upFix 把源的「脚 → 头」转到 +Y，yaw 把左右髋连线转到和
 *    目标一致的水平方向。之后源的一切世界量都先左乘 C，和目标在同一个坐标系里比较。
 * 2. 静止姿势对齐：每根骨头求最小摆动 `S`，把目标静止方向（到首个映射子骨骼）转到源静止
 *    方向，`aligned = S · R_t`。没有子骨骼可比的（手、头、脚掌）沿用最近祖先的 `S`，否则
 *    前臂被摆过去之后手腕会折一下。
 * 3. 逐帧：`W_t = C · W_s · (C · R_s)⁻¹ · aligned`，再用父骨骼的世界旋转转回局部；未映射骨骼
 *    取静止局部旋转参与父链。
 * 4. 根位移：水平分量固定为首帧偏移（乘腿长比），逐帧水平位移剥掉；竖直起伏乘腿长比后叠到
 *    目标静止髋高上。基准分两种：
 *    - 静止姿势站在源世界地面上（UAL、Mixamo、常规 BVH）：以源静止髋位为基准，跟随源世界——
 *      游泳、悬挂这类脚一直离地的动作，以及首帧整体挪开的动作，才能和直接播放一致。
 *    - 静止姿势没站在地面上（CMU / AMASS 一类 BVH：ROOT OFFSET 0，髋高和世界起点全写在位置通道里）：
 *      竖直以源世界 y = 0 为地面、减去静止「髋离脚掌」高度；水平以首帧双脚中点为基准，
 *      否则世界起点会被当成姿态偏移、整个髋高会被当成抬起。
 * 退化骨架（零长度方向）直接抛错，由上层归为解析失败，而不是静默写出 NaN 轨道。
 */

/**
 * 摆动对齐的参照：每根骨头按顺序找第一个两边都映射到的子骨骼，取「骨头 → 子骨骼」为静止方向。
 * 不在表里的（骨盆、头、手、脚掌）沿用最近祖先的摆动；骨盆没有祖先，即不摆动——它到
 * spine_01 的方向在各家骨架里本来就近似竖直，硬补会让整条躯干带一个固定前倾。
 */
const SWING_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  spine_01: ['spine_02', 'spine_03', 'neck_01'],
  spine_02: ['spine_03', 'neck_01'],
  spine_03: ['neck_01'],
  neck_01: ['Head'],
  clavicle_l: ['upperarm_l'],
  upperarm_l: ['lowerarm_l'],
  lowerarm_l: ['hand_l'],
  clavicle_r: ['upperarm_r'],
  upperarm_r: ['lowerarm_r'],
  lowerarm_r: ['hand_r'],
  thigh_l: ['calf_l'],
  calf_l: ['foot_l'],
  foot_l: ['ball_l'],
  thigh_r: ['calf_r'],
  calf_r: ['foot_r'],
  foot_r: ['ball_r'],
};

type Sampler = (time: number) => void;

function boneByName(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((node) => {
    if (node.name && !byName.has(node.name)) byName.set(node.name, node);
  });
  return byName;
}

/**
 * 不经 AnimationMixer 的逐轨采样：mixer 的 `setTime` 对单次动作在末帧会停用 action，
 * 重采样到最后一帧时拿到的是静止姿势。这里只认四元数与位置轨道，缩放轨道忽略。
 *
 * 轨道名两种写法都认：GLTFLoader 的 `节点名.quaternion`，BVHLoader 的 `.bones[骨骼名].quaternion`。
 */
export function createClipSampler(
  three: ThreeModule,
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
): Sampler {
  const byName = boneByName(root);
  const writers: Array<(time: number) => void> = [];
  for (const track of clip.tracks) {
    const parsed = three.PropertyBinding.parseTrackName(track.name);
    const nodeName = parsed.objectName === 'bones' ? parsed.objectIndex : parsed.nodeName;
    const node = nodeName ? byName.get(String(nodeName)) : undefined;
    if (!node) continue;
    // `createInterpolant` 是运行时在构造 / `setInterpolation` 里挂上的，类型声明里没有。
    const interpolant = (track as THREE.KeyframeTrack & { createInterpolant(): THREE.Interpolant }).createInterpolant();
    if (parsed.propertyName === 'quaternion') {
      writers.push((time) => {
        const value = interpolant.evaluate(time);
        node.quaternion.set(value[0]!, value[1]!, value[2]!, value[3]!);
      });
    } else if (parsed.propertyName === 'position') {
      writers.push((time) => {
        const value = interpolant.evaluate(time);
        node.position.set(value[0]!, value[1]!, value[2]!);
      });
    }
  }
  return (time) => {
    for (const write of writers) write(time);
    root.updateMatrixWorld(true);
  };
}

/** 测试与预览用：把 clip 在 `time` 处的姿势直接写到骨架上。 */
export function applyClipAt(
  three: ThreeModule,
  root: THREE.Object3D,
  clip: THREE.AnimationClip,
  time: number,
): void {
  createClipSampler(three, root, clip)(time);
}

export interface RetargetInput {
  /** 源骨架根（含静止姿势）。会被采样改写，调用方不要拿它再做别的。 */
  source: THREE.Object3D;
  clip: THREE.AnimationClip;
  /** `detectSkeleton` 给出的 `源骨骼原名 → UAL 骨骼名`。 */
  map: ReadonlyMap<string, string>;
  /** UAL 骨架根，处于静止姿势。只读，不会被改写。 */
  target: THREE.Object3D;
  name?: string;
}

function worldPosition(three: ThreeModule, node: THREE.Object3D): THREE.Vector3 {
  return node.getWorldPosition(new three.Vector3());
}

function worldQuaternion(three: ThreeModule, node: THREE.Object3D): THREE.Quaternion {
  return node.getWorldQuaternion(new three.Quaternion());
}

/** 把一个方向吸附到最近的坐标轴上：上轴只可能是 ±X / ±Y / ±Z，别让 A-Pose 的微倾带进来。 */
function snapToAxis(three: ThreeModule, direction: THREE.Vector3): THREE.Vector3 {
  const abs = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
  const axis = abs.indexOf(Math.max(...abs));
  const snapped = new three.Vector3();
  snapped.setComponent(axis, Math.sign(direction.getComponent(axis)) || 1);
  return snapped;
}

/**
 * 静止姿势的最低脚掌离源世界 y = 0 在「源腿长 × 这个比例」以内，就当静止姿势站在地面上。
 * 常规骨架脚掌贴地或只差几厘米（鞋底、脚踝高度）；ROOT OFFSET 为 0 的 BVH 静止脚掌在地下约一条腿长。
 * 0.15 条腿（成人约 13 cm）足够宽容建模误差，又远小于两者之间的差距。
 */
const GROUNDED_TOLERANCE_LEG_RATIO = 0.15;

/** 方向长度平方低于这个值就当退化：再 normalize 只会得到 NaN 或随机方向。 */
const DEGENERATE_LENGTH_SQ = 1e-10;

function isDegenerate(vector: THREE.Vector3): boolean {
  return !(vector.lengthSq() >= DEGENERATE_LENGTH_SQ);
}

function legLength(three: ThreeModule, bones: ReadonlyMap<string, THREE.Object3D>): number {
  let total = 0;
  for (const [upper, lower] of [
    ['thigh_l', 'calf_l'],
    ['calf_l', 'foot_l'],
  ] as const) {
    total += worldPosition(three, bones.get(upper)!).distanceTo(worldPosition(three, bones.get(lower)!));
  }
  return total;
}

export function retargetClip(three: ThreeModule, input: RetargetInput): THREE.AnimationClip {
  const { source, clip, map, target } = input;
  source.updateMatrixWorld(true);
  target.updateMatrixWorld(true);

  // UAL 骨骼名 → 源骨骼节点 / 目标骨骼节点。
  const sourceByName = boneByName(source);
  const sourceBones = new Map<string, THREE.Object3D>();
  for (const [sourceName, ualName] of map) {
    const node = sourceByName.get(sourceName);
    if (node) sourceBones.set(ualName, node);
  }
  const targetByName = boneByName(target);
  const targetBones = new Map<string, THREE.Object3D>();
  for (const ualName of sourceBones.keys()) {
    const node = targetByName.get(ualName);
    if (node) targetBones.set(ualName, node);
  }

  // 1. 坐标统一。
  const up = new three.Vector3(0, 1, 0);
  const feetMid = (bones: ReadonlyMap<string, THREE.Object3D>) =>
    worldPosition(three, bones.get('foot_l')!).add(worldPosition(three, bones.get('foot_r')!)).multiplyScalar(0.5);
  const headFromFeet = worldPosition(three, sourceBones.get('Head')!).sub(feetMid(sourceBones));
  if (isDegenerate(headFromFeet)) throw new Error('retarget: source head coincides with feet, cannot find up axis');
  const sourceUp = snapToAxis(three, headFromFeet);
  const upFix = new three.Quaternion().setFromUnitVectors(sourceUp, up);
  const horizontalRight = (bones: ReadonlyMap<string, THREE.Object3D>, fix: THREE.Quaternion) => {
    const right = worldPosition(three, bones.get('thigh_r')!)
      .sub(worldPosition(three, bones.get('thigh_l')!))
      .applyQuaternion(fix);
    right.y = 0;
    // 左右大腿在水平面上的投影重合时朝向无从谈起，setFromUnitVectors 会出 NaN。
    if (isDegenerate(right)) throw new Error('retarget: left and right thighs coincide horizontally, cannot find facing');
    return right.normalize();
  };
  const yaw = new three.Quaternion().setFromUnitVectors(
    horizontalRight(sourceBones, upFix),
    horizontalRight(targetBones, new three.Quaternion()),
  );
  const correction = yaw.clone().multiply(upFix);

  // 2. 静止姿势对齐。遍历顺序保证父先于子，「沿用祖先摆动」时祖先已经算好。
  const restSourceWorldInverse = new Map<string, THREE.Quaternion>();
  for (const [bone, node] of sourceBones) {
    restSourceWorldInverse.set(bone, correction.clone().multiply(worldQuaternion(three, node)).invert());
  }
  const swings = new Map<THREE.Object3D, THREE.Quaternion>();
  const aligned = new Map<THREE.Object3D, THREE.Quaternion>();
  const ualNameOf = new Map<THREE.Object3D, string>([...targetBones].map(([bone, node]) => [node, bone]));
  target.traverse((node) => {
    const bone = ualNameOf.get(node);
    if (!bone) return;
    const child = (SWING_CHILDREN[bone] ?? []).find((name) => targetBones.has(name));
    let swing: THREE.Quaternion | undefined;
    if (child) {
      const targetDir = worldPosition(three, targetBones.get(child)!).sub(worldPosition(three, node));
      const sourceDir = worldPosition(three, sourceBones.get(child)!)
        .sub(worldPosition(three, sourceBones.get(bone)!))
        .applyQuaternion(correction);
      // 子骨骼和骨头重合时只是这一根没有方向可比，不必整条动作判失败：退回沿用祖先摆动，
      // 和手、头这类本来就没有参照子骨骼的骨头同样处理。坐标统一那几步退化才是真的没法做。
      if (!isDegenerate(targetDir) && !isDegenerate(sourceDir)) {
        swing = new three.Quaternion().setFromUnitVectors(targetDir.normalize(), sourceDir.normalize());
      }
    }
    if (!swing) {
      let ancestor = node.parent;
      while (ancestor && !swings.has(ancestor)) ancestor = ancestor.parent;
      swing = ancestor ? swings.get(ancestor)!.clone() : new three.Quaternion();
    }
    swings.set(node, swing);
    aligned.set(node, swing.clone().multiply(worldQuaternion(three, node)));
  });

  // 4. 根位移用到的静止量。
  const sourceHips = sourceBones.get('pelvis')!;
  const targetHips = targetBones.get('pelvis')!;
  const correctedPosition = (node: THREE.Object3D) => worldPosition(three, node).applyQuaternion(correction);
  const sourceRestHip = correctedPosition(sourceHips);
  const sourceRestFeetMid = feetMid(sourceBones).applyQuaternion(correction);
  // 触地点用脚掌：脚踝离地本来就有几厘米，脚掌才贴地。没映射到脚掌时退回脚踝。
  const contactBones = sourceBones.has('ball_l') && sourceBones.has('ball_r') ? ['ball_l', 'ball_r'] : ['foot_l', 'foot_r'];
  const restContactY = Math.min(...contactBones.map((bone) => correctedPosition(sourceBones.get(bone)!).y));
  const targetRestHip = worldPosition(three, targetHips);
  const sourceLegLength = legLength(three, sourceBones);
  if (!(sourceLegLength > 1e-5)) throw new Error('retarget: source legs have zero length');
  const legRatio = legLength(three, targetBones) / sourceLegLength;
  const grounded = Math.abs(restContactY) <= GROUNDED_TOLERANCE_LEG_RATIO * sourceLegLength;

  // 目标骨架里「不随帧变化」的那部分：映射骨骼之外的节点在逐帧计算里取静止局部旋转。
  const restLocal = new Map<THREE.Object3D, THREE.Quaternion>();
  const restWorld = new Map<THREE.Object3D, THREE.Quaternion>();
  target.traverse((node) => {
    restLocal.set(node, node.quaternion.clone());
    restWorld.set(node, worldQuaternion(three, node));
  });

  const duration = Math.min(clip.duration, PREVIZ_MOTION_LIMITS.durationSec);
  const count = Math.max(2, Math.round(duration * PREVIZ_FPS) + 1);
  const times = new Float32Array(count);
  const rotations = new Map<THREE.Object3D, Float32Array>(
    [...targetBones.values()].map((node) => [node, new Float32Array(count * 4)]),
  );
  const hipPositions = new Float32Array(count * 3);
  const sample = createClipSampler(three, source, clip);
  const frameWorld = new Map<THREE.Object3D, THREE.Quaternion>();
  const local = new three.Quaternion();
  const hipLocal = new three.Vector3();

  // 水平方向只保留首帧相对静止姿势的偏移：坐下、推车这类动作髋部本来就不在脚正上方
  // （UAL 的坐姿髋部后移近 30 cm），钉回静止值人会整个前移；之后逐帧的水平位移才是要剥掉的根位移。
  sample(0);
  const hipOffset = correctedPosition(sourceHips).sub(sourceRestHip);
  if (!grounded) {
    // 位置通道里带着世界起点，和静止髋位比没有意义；改比「髋 − 双脚中点」，起点连同脚一起被减掉。
    hipOffset.sub(feetMid(sourceBones).applyQuaternion(correction).sub(sourceRestFeetMid));
  }
  hipOffset.multiplyScalar(legRatio);
  // 竖直基准：站在地面上的骨架直接和静止髋高比；没站在地面上的，静止髋高本身不可信，
  // 换成「源世界 y = 0 处的地面 + 静止时髋离脚掌的高度」。
  const hipBaseline = grounded ? sourceRestHip.y : sourceRestHip.y - restContactY;

  for (let frame = 0; frame < count; frame += 1) {
    const time = Math.min(frame / PREVIZ_FPS, duration);
    times[frame] = time;
    sample(time);
    frameWorld.clear();

    target.traverse((node) => {
      if (node === target) {
        frameWorld.set(node, restWorld.get(node)!);
        return;
      }
      // 从 target 往下遍历，父节点一定先算过。
      const parentWorld = frameWorld.get(node.parent!)!;
      const bone = ualNameOf.get(node);
      const values = rotations.get(node);
      if (!bone || !values) {
        frameWorld.set(node, parentWorld.clone().multiply(restLocal.get(node)!));
        return;
      }
      // W_t = C · W_s · (C · R_s)⁻¹ · aligned，(C · R_s)⁻¹ 即 restSourceWorldInverse。
      const world = correction
        .clone()
        .multiply(worldQuaternion(three, sourceBones.get(bone)!))
        .multiply(restSourceWorldInverse.get(bone)!)
        .multiply(aligned.get(node)!);
      frameWorld.set(node, world);
      local.copy(parentWorld).invert().multiply(world).normalize();
      local.toArray(values, frame * 4);
    });

    const rise = (correctedPosition(sourceHips).y - hipBaseline) * legRatio;
    hipLocal.set(targetRestHip.x + hipOffset.x, targetRestHip.y + rise, targetRestHip.z + hipOffset.z);
    targetHips.parent?.worldToLocal(hipLocal);
    hipLocal.toArray(hipPositions, frame * 3);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  for (const [node, values] of rotations) {
    tracks.push(new three.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, values));
  }
  tracks.push(new three.VectorKeyframeTrack(`${targetHips.name}.position`, times, hipPositions));
  return new three.AnimationClip(input.name ?? clip.name, duration, tracks);
}

/** 首尾两帧各骨骼旋转差的最大角度（度）低于这个值就当循环动作。 */
const LOOP_THRESHOLD_DEG = 10;

/**
 * 导入确认框里「循环」开关的默认值：按重定向后 clip 的首尾帧姿态比。
 * 只看四元数轨道——根位移已经剥掉了，位置轨道首尾本来就接近。
 */
export function looksLooped(clip: THREE.AnimationClip): boolean {
  let worst = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion') || track.values.length < 8) continue;
    const values = track.values;
    const last = values.length - 4;
    const dot = Math.abs(
      values[0]! * values[last]! +
        values[1]! * values[last + 1]! +
        values[2]! * values[last + 2]! +
        values[3]! * values[last + 3]!,
    );
    worst = Math.max(worst, (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
  return worst < LOOP_THRESHOLD_DEG;
}
