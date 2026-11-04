// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PREVIZ_BUILTIN_MOTIONS,
  PREVIZ_MOTION_CATEGORIES,
  builtinMotionById,
  importMotionRef,
  importedIdOf,
  isKnownMotionId,
  motionInfo,
} from '@/features/previz/domain/motionLibrary';
import type { PrevizImportedMotion } from '@/features/previz/domain/scene';

interface GlbJson {
  animations?: Array<{
    name: string;
    channels: Array<{ sampler: number }>;
    samplers: Array<{ input: number }>;
  }>;
  accessors: Array<{ max?: number[] }>;
}

/** 同 `character-rig.test.ts` 的 `shippedClipNames`：不拉 three，直接读 GLB 的 JSON 块。 */
function glbJson(path: string): GlbJson {
  const file = readFileSync(resolve(process.cwd(), `public${path}`));
  const jsonLength = file.readUInt32LE(12);
  return JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8')) as GlbJson;
}

/** clip 时长 = 各通道时间轴 accessor 的 max 取最大，与 three 的 `AnimationClip.resetDuration` 同一口径。 */
function shippedDurations(): Map<string, number> {
  const durations = new Map<string, number>();
  for (const path of [
    '/viewer-kit/quaternius/ual1/UAL1_Standard.glb',
    '/viewer-kit/quaternius/ual2/UAL2_Standard.glb',
  ]) {
    const json = glbJson(path);
    for (const animation of json.animations ?? []) {
      let duration = 0;
      for (const channel of animation.channels) {
        const input = animation.samplers[channel.sampler]!.input;
        duration = Math.max(duration, json.accessors[input]!.max?.[0] ?? 0);
      }
      if (!durations.has(animation.name)) durations.set(animation.name, duration);
    }
  }
  return durations;
}

const imported: PrevizImportedMotion = {
  id: 'm1',
  name: '挥手',
  url: '/u/wave.glb',
  sourceFileName: 'wave.glb',
  format: 'glb',
  skeleton: 'mixamo',
  clipIndex: 0,
  durationSec: 3,
  loop: false,
};

describe('builtin motion catalogue', () => {
  const shipped = shippedDurations();

  it('lists 74 motions with unique ids', () => {
    expect(PREVIZ_BUILTIN_MOTIONS).toHaveLength(74);
    expect(new Set(PREVIZ_BUILTIN_MOTIONS.map((motion) => motion.id)).size).toBe(74);
  });

  it('points every entry at a clip that ships in UAL1 or UAL2 with the same duration', () => {
    for (const motion of PREVIZ_BUILTIN_MOTIONS) {
      const duration = shipped.get(motion.clipName);
      expect(duration, motion.clipName).toBeDefined();
      expect(Math.abs(duration! - motion.durationSec), motion.clipName).toBeLessThan(0.05);
    }
  });

  it('keeps root-motion variants, recovery clips and the T-pose out', () => {
    for (const motion of PREVIZ_BUILTIN_MOTIONS) {
      expect(motion.clipName).not.toMatch(/_RM$|_Rec$|^A_TPose$/);
    }
  });

  it('derives id, label key and loop flag from the clip name', () => {
    const phone = builtinMotionById('builtin:Idle_TalkingPhone_Loop');
    expect(phone).toMatchObject({
      clipName: 'Idle_TalkingPhone_Loop',
      category: 'daily',
      labelKey: 'previz.motion.builtin.Idle_TalkingPhone_Loop',
      loop: true,
    });
    expect(builtinMotionById('builtin:Sword_Idle')?.loop).toBe(true);
    expect(builtinMotionById('builtin:Death01')?.loop).toBe(false);
    expect(builtinMotionById('builtin:Nope')).toBeUndefined();
  });

  it('orders categories for the dialog', () => {
    expect(PREVIZ_MOTION_CATEGORIES).toEqual(['daily', 'locomotion', 'interact', 'combat', 'other']);
  });
});

describe('motion references', () => {
  it('round-trips an imported id', () => {
    expect(importMotionRef('m1')).toBe('import:m1');
    expect(importedIdOf('import:m1')).toBe('m1');
    expect(importedIdOf('builtin:Idle_Loop')).toBeNull();
  });

  it('knows builtin ids and imported ids that exist', () => {
    const ids = new Set(['m1']);
    expect(isKnownMotionId('builtin:Idle_Loop', ids)).toBe(true);
    expect(isKnownMotionId('import:m1', ids)).toBe(true);
    expect(isKnownMotionId('import:gone', ids)).toBe(false);
    expect(isKnownMotionId('Idle_Loop', ids)).toBe(false);
  });

  it('reads duration and loop for either kind', () => {
    expect(motionInfo([imported], 'import:m1')).toEqual({ durationSec: 3, loop: false });
    expect(motionInfo([imported], 'builtin:Walk_Loop')).toEqual({ durationSec: 1.333, loop: true });
    expect(motionInfo([imported], 'import:gone')).toBeNull();
  });
});
