// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { describe, expect, it } from 'vitest';

import { detectSkeleton } from '@/features/previz/domain/skeletonMaps';
import { applyClipAt, looksLooped, retargetClip } from '@/features/previz/engine/retarget';

/**
 * 程序构造的骨架，不读外部文件。坐标按「Y 朝上、面朝 +Z、人物左手在 +X」给出世界位置（米），
 * 各种变体（T/A-Pose、Z-up、厘米、骨骼自带静止旋转、UAL 那样被转过的 root）都在这之上换算，
 * 所以同一组断言能跨变体复用。
 */
const PARENT: Record<string, string> = {
  pelvis: 'root',
  spine_01: 'pelvis',
  spine_02: 'spine_01',
  spine_03: 'spine_02',
  neck_01: 'spine_03',
  Head: 'neck_01',
  clavicle_l: 'spine_03',
  upperarm_l: 'clavicle_l',
  lowerarm_l: 'upperarm_l',
  hand_l: 'lowerarm_l',
  index_01_l: 'hand_l',
  clavicle_r: 'spine_03',
  upperarm_r: 'clavicle_r',
  lowerarm_r: 'upperarm_r',
  hand_r: 'lowerarm_r',
  thigh_l: 'pelvis',
  calf_l: 'thigh_l',
  foot_l: 'calf_l',
  ball_l: 'foot_l',
  thigh_r: 'pelvis',
  calf_r: 'thigh_r',
  foot_r: 'calf_r',
  ball_r: 'foot_r',
};

/** GLTFLoader 会把节点名里的 `:` 去掉（`PropertyBinding.sanitizeNodeName`），真实导入进来就是这个样子。 */
const MIXAMO_NAME: Record<string, string> = {
  pelvis: 'mixamorigHips',
  spine_01: 'mixamorigSpine',
  spine_02: 'mixamorigSpine1',
  spine_03: 'mixamorigSpine2',
  neck_01: 'mixamorigNeck',
  Head: 'mixamorigHead',
  clavicle_l: 'mixamorigLeftShoulder',
  upperarm_l: 'mixamorigLeftArm',
  lowerarm_l: 'mixamorigLeftForeArm',
  hand_l: 'mixamorigLeftHand',
  clavicle_r: 'mixamorigRightShoulder',
  upperarm_r: 'mixamorigRightArm',
  lowerarm_r: 'mixamorigRightForeArm',
  hand_r: 'mixamorigRightHand',
  thigh_l: 'mixamorigLeftUpLeg',
  calf_l: 'mixamorigLeftLeg',
  foot_l: 'mixamorigLeftFoot',
  ball_l: 'mixamorigLeftToeBase',
  thigh_r: 'mixamorigRightUpLeg',
  calf_r: 'mixamorigRightLeg',
  foot_r: 'mixamorigRightFoot',
  ball_r: 'mixamorigRightToeBase',
};

/** 手臂下垂角（弧度）为 0 是 T-Pose，π/4 是 UAL 那样的 A-Pose。 */
function restPositions(armDrop: number): Record<string, THREE.Vector3> {
  const positions: Record<string, THREE.Vector3> = {
    pelvis: new THREE.Vector3(0, 1, 0),
    spine_01: new THREE.Vector3(0, 1.1, 0),
    spine_02: new THREE.Vector3(0, 1.2, 0),
    spine_03: new THREE.Vector3(0, 1.3, 0),
    neck_01: new THREE.Vector3(0, 1.5, 0),
    Head: new THREE.Vector3(0, 1.6, 0),
    thigh_l: new THREE.Vector3(0.1, 0.95, 0),
    calf_l: new THREE.Vector3(0.1, 0.5, 0),
    foot_l: new THREE.Vector3(0.1, 0.05, 0),
    ball_l: new THREE.Vector3(0.1, 0, 0.1),
  };
  const arm = new THREE.Vector3(Math.cos(armDrop), -Math.sin(armDrop), 0);
  positions.clavicle_l = new THREE.Vector3(0.05, 1.45, 0);
  positions.upperarm_l = new THREE.Vector3(0.15, 1.45, 0);
  positions.lowerarm_l = positions.upperarm_l.clone().addScaledVector(arm, 0.3);
  positions.hand_l = positions.lowerarm_l.clone().addScaledVector(arm, 0.25);
  positions.index_01_l = positions.hand_l.clone().addScaledVector(arm, 0.08);
  for (const bone of ['thigh', 'calf', 'foot', 'ball', 'clavicle', 'upperarm', 'lowerarm', 'hand']) {
    const left = positions[`${bone}_l`]!;
    positions[`${bone}_r`] = new THREE.Vector3(-left.x, left.y, left.z);
  }
  return positions;
}

interface SkeletonOptions {
  armDrop?: number;
  /** 世界单位 / 米：厘米骨架传 100。 */
  scale?: number;
  /** 骨架外层整体旋转（模拟 Z-up、侧身导出）。 */
  outer?: THREE.Quaternion;
  /** 内层 `root` 节点的旋转（模拟 UAL 的 −90° X），世界位置保持不变。 */
  frame?: THREE.Quaternion;
  /** 每根骨头带一个不同的静止世界旋转（UAL 骨骼的局部轴各不相同）。 */
  twisted?: boolean;
  omit?: readonly string[];
  rename?: (bone: string) => string;
}

function buildSkeleton(options: SkeletonOptions = {}): { group: THREE.Group; bone: (name: string) => THREE.Object3D } {
  const scale = options.scale ?? 1;
  const positions = restPositions(options.armDrop ?? 0);
  const rename = options.rename ?? ((bone: string) => bone);
  const group = new THREE.Group();
  if (options.outer) group.quaternion.copy(options.outer);
  const root = new THREE.Object3D();
  root.name = 'root';
  root.quaternion.copy(options.frame ?? new THREE.Quaternion());
  group.add(root);

  const nodes = new Map<string, { node: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion }>();
  nodes.set('root', { node: root, position: new THREE.Vector3(), quaternion: root.quaternion.clone() });
  let index = 0;
  for (const bone of Object.keys(PARENT)) {
    index += 1;
    if (options.omit?.includes(bone) || !positions[bone]) continue;
    let parentName = PARENT[bone]!;
    while (!nodes.has(parentName)) parentName = PARENT[parentName]!;
    const parent = nodes.get(parentName)!;
    const position = positions[bone]!.clone().multiplyScalar(scale);
    const quaternion = options.twisted
      ? new THREE.Quaternion().setFromEuler(new THREE.Euler(index * 0.37, index * 0.53, index * 0.19))
      : new THREE.Quaternion();
    const parentInverse = parent.quaternion.clone().invert();
    const node = new THREE.Bone();
    node.name = rename(bone);
    node.position.copy(position.clone().sub(parent.position).applyQuaternion(parentInverse));
    node.quaternion.copy(parentInverse.clone().multiply(quaternion));
    parent.node.add(node);
    nodes.set(bone, { node, position, quaternion });
  }
  group.updateMatrixWorld(true);
  return { group, bone: (name) => nodes.get(name)!.node };
}

function worldOf(node: THREE.Object3D): THREE.Vector3 {
  return node.getWorldPosition(new THREE.Vector3());
}

function direction(from: THREE.Object3D, to: THREE.Object3D): THREE.Vector3 {
  return worldOf(to).sub(worldOf(from)).normalize();
}

function degrees(a: THREE.Vector3, b: THREE.Vector3): number {
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}

const ARM_DOWN = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
const SPINE_BEND = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 6);

/** 源骨头都是单位静止旋转，所以局部旋转就是「相对静止姿势转了多少」。 */
function sourceClip(names: (bone: string) => string, hips?: { from: THREE.Vector3; to: THREE.Vector3 }): THREE.AnimationClip {
  const identity = new THREE.Quaternion();
  const tracks: THREE.KeyframeTrack[] = [
    new THREE.QuaternionKeyframeTrack(`${names('upperarm_l')}.quaternion`, [0, 1], [...identity.toArray(), ...ARM_DOWN.toArray()]),
    new THREE.QuaternionKeyframeTrack(`${names('spine_01')}.quaternion`, [0, 1], [...identity.toArray(), ...SPINE_BEND.toArray()]),
  ];
  if (hips) {
    tracks.push(new THREE.VectorKeyframeTrack(`${names('pelvis')}.position`, [0, 1], [...hips.from.toArray(), ...hips.to.toArray()]));
  }
  return new THREE.AnimationClip('test', 1, tracks);
}

function mapFor(group: THREE.Object3D): ReadonlyMap<string, string> {
  const names: string[] = [];
  group.traverse((node) => names.push(node.name));
  const detected = detectSkeleton(names);
  if (!detected.ok) throw new Error(`skeleton not detected: ${detected.missing.join(',')}`);
  return detected.map;
}

/** UAL 式目标：A-Pose、骨头带各自的静止旋转、root 转了 −90° X。 */
function ualTarget() {
  return buildSkeleton({
    armDrop: Math.PI / 4,
    twisted: true,
    frame: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2),
  });
}

describe('retargetClip', () => {
  it('carries a T-pose arm raise onto an A-pose target in world direction', () => {
    const source = buildSkeleton({ rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const target = ualTarget();
    const clip = retargetClip(THREE, {
      source: source.group,
      clip: sourceClip((bone) => MIXAMO_NAME[bone]!),
      map: mapFor(source.group),
      target: target.group,
    });
    expect(clip.duration).toBeCloseTo(1);
    expect(clip.tracks[0]!.times).toHaveLength(31);

    applyClipAt(THREE, target.group, clip, 0);
    expect(degrees(direction(target.bone('upperarm_l'), target.bone('lowerarm_l')), new THREE.Vector3(1, 0, 0))).toBeLessThan(1);
    expect(degrees(direction(target.bone('lowerarm_l'), target.bone('hand_l')), new THREE.Vector3(1, 0, 0))).toBeLessThan(1);

    applyClipAt(THREE, target.group, clip, 1);
    applyClipAt(THREE, source.group, sourceClip((bone) => MIXAMO_NAME[bone]!), 1);
    // 脊柱前弯 30° 会带着手臂一起转，所以和源骨架此刻的实际方向比，而不是和「正下方」比。
    for (const [from, to] of [
      ['upperarm_l', 'lowerarm_l'],
      ['lowerarm_l', 'hand_l'],
      ['upperarm_r', 'lowerarm_r'],
      ['spine_03', 'neck_01'],
      ['thigh_l', 'calf_l'],
    ] as const) {
      expect(
        degrees(direction(target.bone(from), target.bone(to)), direction(source.bone(from), source.bone(to))),
        `${from}→${to}`,
      ).toBeLessThan(1);
    }
    expect(direction(source.bone('upperarm_l'), source.bone('lowerarm_l')).y).toBeLessThan(-0.8);
  });

  it('gives the same result for a Z-up source that also faces sideways', () => {
    const upright = buildSkeleton({ rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const lying = buildSkeleton({
      rename: (bone) => MIXAMO_NAME[bone] ?? bone,
      outer: new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)),
    });
    const results = [upright, lying].map((source) => {
      const target = ualTarget();
      const clip = retargetClip(THREE, {
        source: source.group,
        clip: sourceClip((bone) => MIXAMO_NAME[bone]!),
        map: mapFor(source.group),
        target: target.group,
      });
      applyClipAt(THREE, target.group, clip, 1);
      return target;
    });
    for (const bone of ['Head', 'hand_l', 'hand_r', 'foot_l']) {
      expect(worldOf(results[1]!.bone(bone)).distanceTo(worldOf(results[0]!.bone(bone))), bone).toBeLessThan(1e-4);
    }
    expect(worldOf(results[1]!.bone('Head')).y).toBeGreaterThan(worldOf(results[1]!.bone('pelvis')).y);
  });

  it('keeps the first-frame hip offset, strips later horizontal motion and scales hip rise by leg length', () => {
    const source = buildSkeleton({ scale: 100, rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const target = ualTarget();
    // 坐姿式：髋后移 30 cm，两条直腿绕 X 前摆 θ（sinθ = 1/3，90 cm 腿前伸 30 cm），脚踩回原地。
    // 腿斜了髋就得落下 90·(1 − cosθ)，首帧脚踝才刚好在静止脚高 5 cm 上。
    const theta = Math.asin(1 / 3);
    const drop = 90 * (1 - Math.cos(theta));
    const legSwing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -theta).toArray();
    const motion = sourceClip((bone) => MIXAMO_NAME[bone]!, {
      from: new THREE.Vector3(0, 100 - drop, -30),
      to: new THREE.Vector3(200, 110 - drop, 50),
    });
    for (const thigh of ['thigh_l', 'thigh_r']) {
      motion.tracks.push(
        new THREE.QuaternionKeyframeTrack(`${MIXAMO_NAME[thigh]}.quaternion`, [0, 1], [...legSwing, ...legSwing]),
      );
    }
    applyClipAt(THREE, source.group, motion, 0);
    expect(worldOf(source.bone('foot_l')).z).toBeCloseTo(0, 3);
    expect(worldOf(source.bone('foot_l')).y).toBeCloseTo(5, 3);
    const clip = retargetClip(THREE, {
      source: buildSkeleton({ scale: 100, rename: (bone) => MIXAMO_NAME[bone] ?? bone }).group,
      clip: motion,
      map: mapFor(source.group),
      target: target.group,
    });
    // 腿长比 = 0.9 m / 90 cm：首帧髋部相对双脚后移 30 cm → 目标 −0.3 m，一直保持；
    // 髋离地比静止低 drop，之后又抬 10 cm。
    for (const [time, y] of [[0, 1 - drop / 100], [1, 1.1 - drop / 100]] as const) {
      applyClipAt(THREE, target.group, clip, time);
      const hips = worldOf(target.bone('pelvis'));
      expect(hips.x, `x@${time}`).toBeCloseTo(0, 4);
      expect(hips.z, `z@${time}`).toBeCloseTo(-0.3, 4);
      expect(hips.y, `y@${time}`).toBeCloseTo(y, 4);
    }
  });

  it('follows the source world height for a grounded skeleton whose feet never touch the ground', () => {
    // 游泳、悬挂式：静止姿势站在地面上，整段动画髋连同双脚抬高 50 cm。
    const source = buildSkeleton({ scale: 100, rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const target = ualTarget();
    const clip = retargetClip(THREE, {
      source: source.group,
      clip: sourceClip((bone) => MIXAMO_NAME[bone]!, {
        from: new THREE.Vector3(0, 150, 0),
        to: new THREE.Vector3(0, 150, 0),
      }),
      map: mapFor(source.group),
      target: target.group,
    });
    for (const time of [0, 1]) {
      applyClipAt(THREE, target.group, clip, time);
      expect(worldOf(target.bone('pelvis')).y, `y@${time}`).toBeCloseTo(1 + 50 * 0.01, 4);
    }
  });

  it('follows the source world origin horizontally for a grounded skeleton that starts shifted', () => {
    // UAL 式：静止姿势站在地面上，首帧髋连同双脚整体前移 20 cm；水平偏移跟随源世界，不按双脚中点抵消。
    const source = buildSkeleton({ scale: 100, rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const target = ualTarget();
    const clip = retargetClip(THREE, {
      source: source.group,
      clip: sourceClip((bone) => MIXAMO_NAME[bone]!, {
        from: new THREE.Vector3(0, 100, 20),
        to: new THREE.Vector3(0, 100, 20),
      }),
      map: mapFor(source.group),
      target: target.group,
    });
    applyClipAt(THREE, target.group, clip, 0);
    const hips = worldOf(target.bone('pelvis'));
    expect(hips.x).toBeCloseTo(0, 4);
    expect(hips.z).toBeCloseTo(20 * 0.01, 4);
    expect(hips.y).toBeCloseTo(1, 4);
  });

  it('writes no track for unmapped bones and leaves them at their rest rotation', () => {
    const source = buildSkeleton({ omit: ['spine_02'], rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const target = ualTarget();
    const spine02Rest = target.bone('spine_02').quaternion.clone();
    const fingerRest = target.bone('index_01_l').quaternion.clone();
    const clip = retargetClip(THREE, {
      source: source.group,
      clip: sourceClip((bone) => MIXAMO_NAME[bone]!),
      map: mapFor(source.group),
      target: target.group,
    });
    const names = clip.tracks.map((track) => track.name);
    expect(names).not.toContain('spine_02.quaternion');
    expect(names).not.toContain('index_01_l.quaternion');
    expect(names).toContain('pelvis.position');

    applyClipAt(THREE, target.group, clip, 1);
    applyClipAt(THREE, source.group, sourceClip((bone) => MIXAMO_NAME[bone]!), 1);
    expect(target.bone('spine_02').quaternion.angleTo(spine02Rest)).toBeLessThan(1e-6);
    expect(target.bone('index_01_l').quaternion.angleTo(fingerRest)).toBeLessThan(1e-6);
    expect(
      degrees(
        direction(target.bone('spine_03'), target.bone('neck_01')),
        direction(source.bone('spine_03'), source.bone('neck_01')),
      ),
    ).toBeLessThan(1);
  });

  it('throws instead of writing NaN when the thighs coincide horizontally', () => {
    const source = buildSkeleton({ rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    source.bone('thigh_r').position.copy(source.bone('thigh_l').position);
    expect(() =>
      retargetClip(THREE, {
        source: source.group,
        clip: sourceClip((bone) => MIXAMO_NAME[bone]!),
        map: mapFor(source.group),
        target: ualTarget().group,
      }),
    ).toThrow(/thighs coincide/);
  });

  it('falls back to the ancestor swing for a zero-length source bone instead of producing NaN', () => {
    const source = buildSkeleton({ rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    // 手腕和肘重合：前臂没有方向可比。
    source.bone('hand_l').position.set(0, 0, 0);
    const clip = retargetClip(THREE, {
      source: source.group,
      clip: sourceClip((bone) => MIXAMO_NAME[bone]!),
      map: mapFor(source.group),
      target: ualTarget().group,
    });
    for (const track of clip.tracks) {
      expect(Array.from(track.values).every(Number.isFinite), track.name).toBe(true);
    }
  });

  it('caps the resampled duration at 60 seconds', () => {
    const source = buildSkeleton({ rename: (bone) => MIXAMO_NAME[bone] ?? bone });
    const long = new THREE.AnimationClip('long', 90, [
      new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 90], [0, 0, 0, 1, 0, 0, 0, 1]),
    ]);
    const clip = retargetClip(THREE, { source: source.group, clip: long, map: mapFor(source.group), target: ualTarget().group });
    expect(clip.duration).toBe(60);
    expect(clip.tracks[0]!.times).toHaveLength(1801);
  });
});

interface BvhOptions {
  /** ROOT 的 OFFSET（厘米）。 */
  rootOffset?: [number, number, number];
  /** 两帧的根位置通道值（厘米）与左上臂绕 Z 的角度（度）。 */
  frames?: Array<{ position: [number, number, number]; armZ: number }>;
}

/**
 * SMPL 命名、厘米、Y-up 的小 BVH。默认两帧：静止髋高写在 OFFSET 里，第二帧髋部抬 10 cm、左上臂放下。
 * CMU / AMASS 一类导出则是 `OFFSET 0 0 0`、髋高和世界起点全在位置通道里，用 options 模拟。
 */
function smplBvh(options: BvhOptions = {}): string {
  type Joint = [name: string, offset: [number, number, number], children: Joint[], end?: [number, number, number]];
  const side = (prefix: 'L' | 'R', sign: 1 | -1): { leg: Joint; arm: Joint } => ({
    leg: [`${prefix}_Hip`, [10 * sign, -5, 0], [
      [`${prefix}_Knee`, [0, -45, 0], [
        [`${prefix}_Ankle`, [0, -45, 0], [
          [`${prefix}_Foot`, [0, -5, 10], [], [0, 0, 5]],
        ]],
      ]],
    ]],
    arm: [`${prefix}_Collar`, [5 * sign, 15, 0], [
      [`${prefix}_Shoulder`, [10 * sign, 0, 0], [
        [`${prefix}_Elbow`, [30 * sign, 0, 0], [
          [`${prefix}_Wrist`, [25 * sign, 0, 0], [], [10 * sign, 0, 0]],
        ]],
      ]],
    ]],
  });
  const left = side('L', 1);
  const right = side('R', -1);
  const tree: Joint = ['Pelvis', options.rootOffset ?? [0, 100, 0], [
    left.leg,
    right.leg,
    ['Spine1', [0, 10, 0], [
      ['Spine2', [0, 10, 0], [
        ['Spine3', [0, 10, 0], [
          ['Neck', [0, 20, 0], [['Head', [0, 10, 0], [], [0, 10, 0]]]],
          left.arm,
          right.arm,
        ]],
      ]],
    ]],
  ]];

  const lines: string[] = ['HIERARCHY'];
  const order: string[] = [];
  const write = ([name, offset, children, end]: Joint, depth: number) => {
    const pad = '  '.repeat(depth);
    lines.push(`${pad}${depth === 0 ? 'ROOT' : 'JOINT'} ${name}`, `${pad}{`, `${pad}  OFFSET ${offset.join(' ')}`);
    lines.push(`${pad}  CHANNELS ${depth === 0 ? '6 Xposition Yposition Zposition' : '3'} Zrotation Xrotation Yrotation`);
    order.push(name);
    for (const child of children) write(child, depth + 1);
    if (end) lines.push(`${pad}  End Site`, `${pad}  {`, `${pad}    OFFSET ${end.join(' ')}`, `${pad}  }`);
    lines.push(`${pad}}`);
  };
  write(tree, 0);
  const frames = options.frames ?? [
    { position: [0, 0, 0], armZ: 0 },
    { position: [0, 10, 0], armZ: -90 },
  ];
  const frame = ({ position, armZ }: { position: [number, number, number]; armZ: number }) =>
    order
      .flatMap((name) => {
        const rotation = name === 'L_Shoulder' ? [armZ, 0, 0] : [0, 0, 0];
        return name === 'Pelvis' ? [...position, ...rotation] : rotation;
      })
      .join(' ');
  lines.push('MOTION', `Frames: ${frames.length}`, 'Frame Time: 0.0333333', ...frames.map(frame));
  return lines.join('\n');
}

describe('BVH import chain', () => {
  it('parses, detects SMPL and retargets onto the UAL target', () => {
    const { skeleton, clip } = new BVHLoader().parse(smplBvh());
    const source = new THREE.Group();
    source.add(skeleton.bones[0]!);
    const detected = detectSkeleton(skeleton.bones.map((bone) => bone.name));
    expect(detected.ok && detected.kind).toBe('smpl');
    if (!detected.ok) return;

    const target = ualTarget();
    const result = retargetClip(THREE, { source, clip, map: detected.map, target: target.group });
    expect(result.duration).toBeCloseTo(1 / 30, 3);
    expect(result.tracks.map((track) => track.name)).toEqual(
      expect.arrayContaining(['pelvis.position', 'upperarm_l.quaternion', 'foot_r.quaternion', 'Head.quaternion']),
    );

    applyClipAt(THREE, target.group, result, result.duration);
    expect(worldOf(target.bone('pelvis')).y).toBeCloseTo(1.1, 3);
    expect(degrees(direction(target.bone('upperarm_l'), target.bone('lowerarm_l')), new THREE.Vector3(0, -1, 0))).toBeLessThan(1);
  });

  it('does not read hip height and world origin written into the position channels as pose offset', () => {
    // CMU / AMASS 式：OFFSET 0 0 0，髋高 100 cm、世界起点 (9 m, −17 m) 全在位置通道里；第二帧原地小晃。
    // 静止时脚掌在 y = −100，远离地面，走「没站在地面上」的基准。
    const bvh = smplBvh({
      rootOffset: [0, 0, 0],
      frames: [
        { position: [900, 100, -1700], armZ: 0 },
        { position: [903, 101, -1695], armZ: -30 },
      ],
    });
    const { skeleton, clip } = new BVHLoader().parse(bvh);
    const source = new THREE.Group();
    source.add(skeleton.bones[0]!);
    const detected = detectSkeleton(skeleton.bones.map((bone) => bone.name));
    if (!detected.ok) throw new Error('skeleton not detected');

    const target = ualTarget();
    const result = retargetClip(THREE, { source, clip, map: detected.map, target: target.group });

    // 腿长比 0.9 m / 90 cm；首帧脚掌正好在源世界 y = 0 上，所以髋就该在目标静止髋位上，
    // 脚踝也在静止脚高 0.05 m 上。
    applyClipAt(THREE, target.group, result, 0);
    const hips = worldOf(target.bone('pelvis'));
    expect(hips.y).toBeCloseTo(1, 2);
    expect(Math.hypot(hips.x, hips.z)).toBeLessThan(0.02);
    expect(worldOf(target.bone('foot_l')).y).toBeCloseTo(0.05, 2);

    // 第二帧只抬了 1 cm，水平挪动被剥掉。
    applyClipAt(THREE, target.group, result, result.duration);
    const later = worldOf(target.bone('pelvis'));
    expect(later.y).toBeCloseTo(1.01, 2);
    expect(Math.hypot(later.x, later.z)).toBeLessThan(0.02);
  });
});

describe('looksLooped', () => {
  const clipOf = (end: THREE.Quaternion) =>
    new THREE.AnimationClip('c', 1, [
      new THREE.QuaternionKeyframeTrack('spine_01.quaternion', [0, 0.5, 1], [0, 0, 0, 1, 0.3, 0, 0, 0.95, ...end.toArray()]),
      new THREE.VectorKeyframeTrack('pelvis.position', [0, 1], [0, 0, 0, 5, 0, 0]),
    ]);
  const turn = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));

  it('treats a clip that ends near its first pose as a loop', () => {
    expect(looksLooped(clipOf(turn(5)))).toBe(true);
  });

  it('treats a clip that ends somewhere else as one-shot', () => {
    expect(looksLooped(clipOf(turn(30)))).toBe(false);
  });
});
