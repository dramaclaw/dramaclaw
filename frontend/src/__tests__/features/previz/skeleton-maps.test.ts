// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  detectSkeleton,
  normalizeBoneName,
  PREVIZ_CORE_BONES,
} from '@/features/previz/domain/skeletonMaps';

const UAL = [
  'root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'index_01_l',
  'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r',
];

const MIXAMO = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandIndex1',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

const SMPL = [
  'Pelvis', 'L_Hip', 'R_Hip', 'Spine1', 'L_Knee', 'R_Knee', 'Spine2', 'L_Ankle', 'R_Ankle',
  'Spine3', 'L_Foot', 'R_Foot', 'Neck', 'L_Collar', 'R_Collar', 'Head',
  'L_Shoulder', 'R_Shoulder', 'L_Elbow', 'R_Elbow', 'L_Wrist', 'R_Wrist',
];

const SMPL_SNAKE = [
  'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee', 'spine2',
  'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot', 'neck',
  'left_collar', 'right_collar', 'head', 'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
];

describe('normalizeBoneName', () => {
  it('drops case, separators and the common exporter prefixes', () => {
    expect(normalizeBoneName('mixamorig:LeftForeArm')).toBe('leftforearm');
    expect(normalizeBoneName('mixamorig12:Hips')).toBe('hips');
    expect(normalizeBoneName('f_avg_L_Hip')).toBe('lhip');
    expect(normalizeBoneName('upperarm_l')).toBe('upperarml');
  });
});

describe('detectSkeleton', () => {
  it('recognises UAL as itself', () => {
    const result = detectSkeleton(UAL);
    expect(result.ok && result.kind).toBe('ual');
    if (!result.ok) return;
    expect(result.map.get('pelvis')).toBe('pelvis');
    expect(result.map.has('index_01_l')).toBe(false);
  });

  it('recognises Mixamo with or without the mixamorig prefix', () => {
    for (const names of [MIXAMO, MIXAMO.map((name) => `mixamorig:${name}`), MIXAMO.map((name) => `mixamorig1:${name}`)]) {
      const result = detectSkeleton(names);
      expect(result.ok && result.kind).toBe('mixamo');
      if (!result.ok) continue;
      expect(result.map.get(names[0]!)).toBe('pelvis');
      expect(result.map.get(names[9]!)).toBe('lowerarm_l');
      expect(result.map.get(names[5]!)).toBe('Head');
    }
  });

  it('recognises both common SMPL spellings', () => {
    for (const names of [SMPL, SMPL_SNAKE, SMPL.map((name) => `m_avg_${name}`)]) {
      const result = detectSkeleton(names);
      expect(result.ok && result.kind).toBe('smpl');
      if (!result.ok) continue;
      const byTarget = new Map([...result.map].map(([source, target]) => [target, source]));
      expect(normalizeBoneName(byTarget.get('upperarm_l')!)).toMatch(/shoulder$/);
      expect(normalizeBoneName(byTarget.get('foot_r')!)).toMatch(/ankle$/);
      expect(normalizeBoneName(byTarget.get('ball_r')!)).toMatch(/foot$/);
    }
  });

  it('names the missing core bone of the closest table', () => {
    const result = detectSkeleton(MIXAMO.filter((name) => name !== 'LeftForeArm'));
    expect(result).toEqual({ ok: false, error: 'unsupported_skeleton', missing: ['lowerarm_l'] });
  });

  it('reports every core bone for a skeleton it cannot read at all', () => {
    const result = detectSkeleton(['Bip01', 'Bip01 Pelvis']);
    expect(result).toEqual({ ok: false, error: 'unsupported_skeleton', missing: [...PREVIZ_CORE_BONES] });
  });
});
